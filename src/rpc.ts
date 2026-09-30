import { spawn, type ChildProcess } from "node:child_process";
import { RingBuffer, createLogger } from "./util";

/**
 * Minimal client for `pi --mode rpc`: JSONL over stdio, strict LF framing
 * (never readline - it also splits on U+2028/U+2029 which are valid inside
 * JSON strings), id-correlated responses, event fan-out.
 *
 * Dialog-style extension_ui_requests are auto-cancelled: chat users are not
 * present at the child's terminal, so blocking prompts must not hang runs.
 */

const log = createLogger("rpc");

export interface RpcEvent {
	type: string;
	[k: string]: unknown;
}

interface Pending {
	resolve: (data: unknown) => void;
	reject: (err: Error) => void;
	timer: ReturnType<typeof setTimeout>;
	command: string;
}

export interface SpawnOptions {
	piPath: string;
	args: string[];
	cwd: string;
	/** Called when the process exits for any reason. */
	onExit?: (code: number | null, signal: string | null) => void;
	/** Per-event hook (agent events, tool executions, ...). */
	onEvent?: (event: RpcEvent) => void;
}

export class RpcChild {
	private proc: ChildProcess | null = null;
	private decoder = new TextDecoder();
	private buffer = "";
	private pending = new Map<string, Pending>();
	private nextId = 0;
	readonly stderrTail = new RingBuffer(80);
	private exited = false;
	private exitWaiters: Array<(info: { code: number | null; signal: string | null }) => void> = [];

	private constructor(
		readonly pid: number,
		private readonly procRef: ChildProcess,
		private readonly onExitCb: ((code: number | null, signal: string | null) => void) | undefined,
	) {}

	private readonly listeners = new Set<(event: RpcEvent) => void>();

	/** Subscribe to session events; returns an unsubscribe function. */
	onEvent(fn: (event: RpcEvent) => void): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	static spawn(opts: SpawnOptions): RpcChild {
		const child = spawn(opts.piPath, opts.args, {
			cwd: opts.cwd,
			env: { ...process.env, PI_CORD_CHILD: "1" },
			stdio: ["pipe", "pipe", "pipe"],
		});

		const rpc = new RpcChild(child.pid ?? -1, child, opts.onExit);
		if (opts.onEvent) rpc.onEvent(opts.onEvent);
		child.stdout?.on("data", (chunk: Buffer) => rpc.handleStdout(chunk));
		child.stderr?.on("data", (chunk: Buffer) => {
			for (const line of chunk.toString("utf8").split("\n")) if (line.trim()) rpc.stderrTail.push(line);
		});
		child.on("error", (err) => {
			log("spawn error:", err.message);
			rpc.failAll(new Error(`pi process error: ${err.message}`));
			rpc.finishExit(null, null);
		});
		child.on("exit", (code, signal) => {
			log(`pi child (pid ${child.pid}) exited code=${code} signal=${signal}`);
			rpc.failAll(new Error(`pi process exited unexpectedly (code ${code}, signal ${signal}). stderr:\n${rpc.stderrTail.tail(6)}`));
			rpc.finishExit(code, signal);
			opts.onExit?.(code, signal);
		});
		return rpc;
	}

	get running(): boolean {
		return this.procRef.exitCode === null && this.procRef.signalCode === null && !this.exited;
	}

	/** Resolves when the process exits; used by tests and graceful shutdown. */
	waitForExit(): Promise<{ code: number | null; signal: string | null }> {
		if (this.exited) return Promise.resolve({ code: this.procRef.exitCode, signal: this.procRef.signalCode });
		return new Promise((resolve) => this.exitWaiters.push(resolve));
	}

	private finishExit(code: number | null, signal: string | null): void {
		if (this.exited) return;
		this.exited = true;
		const waiters = this.exitWaiters;
		this.exitWaiters = [];
		for (const w of waiters) w({ code, signal });
		this.onExitCb?.(code, signal);
	}

	private handleStdout(chunk: Buffer): void {
		this.buffer += this.decoder.decode(chunk, { stream: true });
		let idx: number;
		while ((idx = this.buffer.indexOf("\n")) >= 0) {
			const line = this.buffer.slice(0, idx).replace(/\r$/, "");
			this.buffer = this.buffer.slice(idx + 1);
			if (!line.trim()) continue;
			let record: RpcEvent;
			try {
				record = JSON.parse(line) as RpcEvent;
			} catch (err) {
				log("unparseable stdout line:", String(err).slice(0, 200));
				continue;
			}
			this.dispatch(record);
		}
		if (this.buffer.length > 8 * 1024 * 1024) {
			// corrupt framing guard: drop absurd unconsumed data rather than growing forever
			this.buffer = "";
		}
	}

	private dispatch(record: RpcEvent): void {
		if (record.type === "response") {
			const id = String(record.id ?? "");
			const p = this.pending.get(id);
			if (!p) return;
			this.pending.delete(id);
			clearTimeout(p.timer);
			if (record.success === true) p.resolve(record.data);
			else p.reject(new Error(String(record.error ?? `${p.command} failed`)));
			return;
		}
		if (record.type === "extension_ui_request") {
			this.autoAnswerUi(record);
			return;
		}
		for (const listener of this.listeners) {
			try {
				listener(record);
			} catch (err) {
				log("event listener error:", String(err));
			}
		}
	}

	/** Cancel dialog requests so nothing blocks; notify/setStatus are ignored. */
	private autoAnswerUi(record: RpcEvent): void {
		const method = String(record.method ?? "");
		const needsAnswer = method === "select" || method === "confirm" || method === "input" || method === "editor";
		if (!needsAnswer) return;
		this.writeRaw({ type: "extension_ui_response", id: record.id, cancelled: true });
		log(`auto-cancelled extension dialog (${method}) in child`);
	}

	private writeRaw(obj: unknown): void {
		if (!this.running) return;
		try {
			this.procRef.stdin?.write(`${JSON.stringify(obj)}\n`);
		} catch (err) {
			log("stdin write failed:", String(err));
		}
	}

	/** Send a command and wait for its response. */
	request<T = unknown>(command: Record<string, unknown>, timeoutMs = 30_000): Promise<T> {
		if (!this.running) return Promise.reject(new Error("pi child is not running"));
		const id = `pc-${++this.nextId}`;
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`${String(command.type)} timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			this.pending.set(id, {
				resolve: (data) => resolve(data as T),
				reject,
				timer,
				command: String(command.type ?? "?"),
			});
			this.writeRaw({ ...command, id });
		});
	}

	/** Graceful: close stdin (pi exits after current work). Then SIGTERM/SIGKILL fallback. */
	async kill(graceMs = 5000): Promise<void> {
		if (!this.running) return;
		const done = this.waitForExit();
		try {
			this.procRef.stdin?.end();
		} catch {
			/* already gone */
		}
		const timer = setTimeout(() => {
			if (this.running) this.procRef.kill("SIGTERM");
		}, graceMs);
		timer.unref?.();
		const second = setTimeout(() => {
			if (this.running) this.procRef.kill("SIGKILL");
		}, graceMs * 2);
		second.unref?.();
		await done;
		clearTimeout(timer);
		clearTimeout(second);
	}

	private failAll(err: Error): void {
		for (const [, p] of this.pending) {
			clearTimeout(p.timer);
			p.reject(err);
		}
		this.pending.clear();
	}
}
