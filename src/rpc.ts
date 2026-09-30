import { spawn, type ChildProcess } from "node:child_process";
import type { DialogAnswer, DialogRequest } from "./types";
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
	/**
	 * Forward a blocking extension dialog (ctx.ui.select/confirm/input/editor).
	 * The resolved answer is written back as extension_ui_response. Implementations
	 * must resolve; on rejection the dialog is answered as cancelled.
	 */
	onDialog?: (req: DialogRequest) => Promise<DialogAnswer>;
	/** Fire-and-forget extension notifications (ctx.ui.notify). */
	onNotify?: (message: string, notifyType: string) => void;
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
		private readonly onDialogCb: ((req: DialogRequest) => Promise<DialogAnswer>) | undefined,
		private readonly onNotifyCb: ((message: string, notifyType: string) => void) | undefined,
	) {}

	private readonly listeners = new Set<(event: RpcEvent) => void>();
	/** Locally generated ids for pending dialogs we forwarded to the chat. */
	private dialogIds = new Set<string>();

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

		const rpc = new RpcChild(child.pid ?? -1, child, opts.onExit, opts.onDialog, opts.onNotify);
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
			rpc.resolveAllDialogs({ cancelled: true });
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
			this.handleUiRequest(record);
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

	/** Route extension UI records: dialogs get forwarded, notify is fire-and-forget, rest ignored. */
	private handleUiRequest(record: RpcEvent): void {
		const method = String(record.method ?? "");
		if (method === "notify") {
			this.onNotifyCb?.(String(record.message ?? ""), String(record.notifyType ?? "info"));
			return;
		}
		const isDialog = method === "select" || method === "confirm" || method === "input" || method === "editor";
		if (!isDialog) return; // setStatus/setWidget/setTitle/set_editor_text are TUI-only concerns
		if (!this.onDialogCb) {
			this.writeRaw({ type: "extension_ui_response", id: record.id, cancelled: true });
			return;
		}
		const req: DialogRequest = {
			id: String(record.id ?? ""),
			method,
			title: typeof record.title === "string" ? record.title : undefined,
			message: typeof record.message === "string" ? record.message : undefined,
			options: Array.isArray(record.options) ? record.options.map(String) : undefined,
			placeholder: typeof record.placeholder === "string" ? record.placeholder : undefined,
			prefill: typeof record.prefill === "string" ? record.prefill : undefined,
			timeoutMs: typeof record.timeout === "number" ? record.timeout : undefined,
		};
		this.dialogIds.add(req.id);
		this.onDialogCb(req)
			.then((answer) => {
				if (!this.dialogIds.delete(req.id)) return; // already resolved via resolveAllDialogs
				this.writeRaw({ type: "extension_ui_response", id: req.id, ...answer });
			})
			.catch((err) => {
				this.dialogIds.delete(req.id);
				log("dialog forwarder failed:", String(err));
				this.writeRaw({ type: "extension_ui_response", id: req.id, cancelled: true });
			});
	}

	/** Force-outstanding dialogs (used on stop/shutdown): resolves forwarders but keeps pi waiting for our reply. */
	cancelDialogs(): void {
		const ids = [...this.dialogIds];
		this.dialogIds.clear();
		for (const id of ids) this.writeRaw({ type: "extension_ui_response", id, cancelled: true });
	}

	private resolveAllDialogs(answer: DialogAnswer): void {
		this.dialogIds.clear(); // forwarder results are dropped; process is gone anyway
		void answer;
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
