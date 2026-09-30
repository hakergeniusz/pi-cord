import { existsSync, mkdirSync, openSync, readFileSync, readSync, closeSync, statSync, readdirSync, type Stats } from "node:fs";
import { join } from "node:path";
import type { DialogAnswer, DialogRequest, ImageAttachment } from "./types";
import { RpcChild, type RpcEvent } from "./rpc";
import { expandTilde, formatDuration, formatTokens, fuzzyModelScore, summarize, createLogger } from "./util";
import { resolveCwd, resolvePiPath, type PiCordConfig } from "./config";
import type { StateStore } from "./state";
import { chunkText, DISCORD_LIMIT, TELEGRAM_LIMIT } from "./format";

const log = createLogger("chat");

export interface ChatTransport {
	send(chatId: string, text: string): Promise<string | undefined>;
	edit(chatId: string, messageId: string, text: string): Promise<boolean>;
	startTyping(chatId: string): () => void;
}

/** A finished chat exchange, handed to the gateway for UI-history pruning. */
export interface CompletedTurn {
	userMessageIds: string[];
	messageIds: string[];
}

export interface ChatAgentOptions {
	/** Platform-scoped chat key, e.g. "telegram:12345". */
	key: string;
	chatId: string;
	config: PiCordConfig;
	state: StateStore;
	/** Session directory for this chat (created lazily). */
	sessionDir: string;
	transport: ChatTransport;
	/** Forward extension dialogs to the chat user (buttons / reply prompts). */
	forwardDialog?: (req: DialogRequest) => Promise<DialogAnswer>;
	/** Forward fire-and-forget extension notifications into the chat. */
	forwardNotify?: (message: string, notifyType: string) => void;
	/** Called when a run finishes, so the gateway can prune the visible chat history. */
	onTurnComplete?: (turn: CompletedTurn) => void;
}

export interface SubmitResult {
	queued: boolean;
	position: number;
	/** True when the message steered a running agent instead of queueing. */
	steered?: boolean;
}

interface QueuedItem {
	text: string;
	images: ImageAttachment[];
	userMessageId?: string;
}

interface ModelInfo {
	provider: string;
	id: string;
	name?: string;
}

const RUN_REQUEST_TIMEOUT = 30_000;
const COMMAND_TIMEOUT = 60_000;
const COMPACT_TIMEOUT = 15 * 60_000;
const SETTLE_TIMEOUT = 45 * 60_000;
const HANDLED_FALLBACK_MS = 15_000;
const PROGRESS_EDIT_INTERVAL = 4_000;
const STREAM_EDIT_INTERVAL = 1_500;
const TYPING_INTERVAL = 8_000;

/**
 * One chat = one headless pi session (`pi --mode rpc` child process) with its
 * own --session-dir, so per-chat history is pi's own session storage. Prompts
 * serialize per chat; mid-run messages steer the running agent (appended to
 * its history at the next turn boundary, like pi's own steering); tool
 * activity and the streaming answer share one editable message.
 */
export class ChatAgent {
	private child: RpcChild | null = null;
	private busy = false;
	private queue: QueuedItem[] = [];
	private settledWaiters = new Set<() => void>();
	private runStartedAt = 0;
	private lastActivity = Date.now();
	private typingStop: (() => void) | null = null;
	private statusMessageId: string | undefined;
	private lastProgressEdit = 0;
	private currentToolSummary = "";
	private stopping = false;
	private retryError: string | null = null;
	/** Set when the child died mid-run; runNext turns it into a chat error. */
	private deathMessage: string | null = null;
	/** Streaming state: cumulative text of the current assistant message. */
	private streamText = "";
	private streamActive = false;
	private lastStreamEdit = 0;
	private streamTimer: ReturnType<typeof setTimeout> | null = null;
	/** Bot message ids posted during the current run (for UI-history pruning). */
	private turnMessageIds: string[] = [];
	private turnUserMessageIds: string[] = [];
	readonly log: (...args: unknown[]) => void;

	constructor(private readonly opts: ChatAgentOptions) {
		this.log = createLogger(`chat:${opts.key}`);
	}

	get key(): string {
		return this.opts.key;
	}

	get busyNow(): boolean {
		return this.busy || this.queue.length > 0;
	}

	get sessionDirAbs(): string {
		return expandTilde(this.opts.sessionDir);
	}

	private chatCwd(): string {
		return resolveCwd(this.opts.config, this.opts.state.chat(this.opts.key).cwd);
	}

	// ---- child lifecycle -------------------------------------------------

	private childArgs(): string[] {
		const cfg = this.opts.config;
		const args = ["--mode", "rpc", "--session-dir", this.sessionDirAbs];
		const saved = this.opts.state.chat(this.opts.key).sessionFile;
		if (saved && existsSync(saved)) args.push("--session", saved);
		if (cfg.model) args.push("--model", cfg.model);
		if (cfg.thinking) args.push("--thinking", cfg.thinking);
		// Chat-only instructions (e.g. "no markdown tables"): a separate AGENTS.md
		// the interactive pi never reads, appended to the child's system prompt.
		const agentsMd = cfg.agentsMd ?? "~/.pi/agent/pi-cord/AGENTS.md";
		try {
			if (existsSync(expandTilde(agentsMd))) args.push("--append-system-prompt", readFileSync(expandTilde(agentsMd), "utf8"));
		} catch (err) {
			this.log("agentsMd read failed:", err);
		}
		// Extensions are on by default: chat sessions behave like the user's real
		// pi (tools, guards, custom providers). Opt out with childExtensions:false.
		if (cfg.childExtensions === false) args.push("--no-extensions");
		if (cfg.trustProject !== false) args.push("--approve");
		args.push(...(cfg.childArgs ?? []));
		return args;
	}

	private async ensureChild(): Promise<RpcChild> {
		if (this.child?.running) return this.child;
		const cwd = this.chatCwd();
		mkdirSync(cwd, { recursive: true });
		mkdirSync(this.sessionDirAbs, { recursive: true });

		const piPath = resolvePiPath(this.opts.config);
		const child = RpcChild.spawn({
			piPath,
			args: this.childArgs(),
			cwd,
			onEvent: (e) => this.onEvent(e),
			onDialog: (req) => (this.opts.forwardDialog ? this.opts.forwardDialog(req) : Promise.resolve({ cancelled: true })),
			onNotify: (message, notifyType) => this.opts.forwardNotify?.(message, notifyType),
			onExit: () => {
				if (this.child === child) this.child = null;
				if (this.busy) {
					this.deathMessage = `⚠️ pi session process died mid-run. stderr tail:\n\`\`\`\n${child.stderrTail.tail(6) || "(empty)"}\n\`\`\``;
					this.resolveSettled();
				}
			},
		});
		this.child = child;

		// Wait until the child answers its first command (startup: config load,
		// auth resolution, resource discovery).
		const deadline = Date.now() + 60_000;
		for (;;) {
			if (!child.running) {
				throw new Error(`pi failed to start (exited during startup). stderr:\n${child.stderrTail.tail(6)}`);
			}
			try {
				await child.request({ type: "get_state" }, 10_000);
				break;
			} catch (err) {
				if (Date.now() > deadline) throw new Error(`pi did not become ready: ${String(err)}`);
				await sleep(300);
			}
		}
		this.log(`spawned pi child pid=${child.pid} cwd=${cwd}`);
		return child;
	}

	private onEvent(e: RpcEvent): void {
		switch (e.type) {
			case "agent_settled":
				this.resolveSettled();
				break;
			case "message_start":
				if (roleOf(e.message) === "assistant") {
					this.streamText = "";
					this.streamActive = true;
				}
				break;
			case "message_update": {
				if (roleOf(e.message) !== "assistant") break;
				const snapshot = messageText(e.message);
				const delta = typeof (e.assistantMessageEvent as { delta?: unknown } | undefined)?.delta === "string"
					? (e.assistantMessageEvent as { delta: string }).delta
					: "";
				// Prefer the cumulative snapshot; fall back to delta accumulation.
				this.streamText = snapshot || this.streamText + delta;
				this.scheduleStreamEdit();
				break;
			}
			case "message_end":
				if (roleOf(e.message) === "assistant") {
					const text = messageText(e.message);
					if (text) this.streamText = text;
					// Freeze: no more cursor edits; the final delivery edits the real
					// answer over this message.
					this.streamActive = false;
				}
				break;
			case "tool_execution_start":
				this.currentToolSummary = `${String(e.toolName ?? "tool")} ${summarize(e.args)}`.trim();
				this.scheduleProgressEdit(true);
				break;
			case "turn_start":
				this.scheduleProgressEdit(false);
				break;
			case "auto_retry_end":
				if (e.success === false) this.retryError = String(e.finalError ?? "model request failed");
				break;
			default:
				break;
		}
	}

	private resolveSettled(): void {
		const waiters = this.settledWaiters;
		this.settledWaiters = new Set();
		for (const w of waiters) w();
	}

	// ---- submission --------------------------------------------------------

	async submit(text: string, images: ImageAttachment[] = [], userMessageId?: string): Promise<SubmitResult> {
		this.lastActivity = Date.now();
		if (this.busy) {
			// Pi-style steering: append the message to the running conversation at
			// the next turn boundary instead of queueing a separate run. The final
			// answer of the ongoing run then covers it.
			if (this.child?.running && (await this.steer(text, images))) {
				if (userMessageId) this.turnUserMessageIds.push(userMessageId);
				return { queued: false, position: 0, steered: true };
			}
			this.queue.push({ text, images, userMessageId });
			return { queued: true, position: this.queue.length };
		}
		void this.runNext(text, images, userMessageId);
		return { queued: false, position: 0 };
	}

	/** Try to steer a running agent; false when the child is gone or refuses. */
	private async steer(text: string, images: ImageAttachment[]): Promise<boolean> {
		try {
			await this.child!.request(
				{
					type: "steer",
					message: text,
					...(images.length
						? { images: images.map((i) => ({ type: "image", data: i.data.toString("base64"), mimeType: i.mimeType })) }
						: {}),
				},
				RUN_REQUEST_TIMEOUT,
			);
			return true;
		} catch (err) {
			this.log("steer failed, falling back to queue:", err);
			return false;
		}
	}

	private async runNext(text: string, images: ImageAttachment[], userMessageId?: string): Promise<void> {
		this.busy = true;
		this.retryError = null;
		this.deathMessage = null;
		this.runStartedAt = Date.now();
		this.currentToolSummary = "";
		this.stopping = false;
		this.turnUserMessageIds = userMessageId ? [userMessageId] : [];
		this.turnMessageIds = [];
		this.streamText = "";
		this.streamActive = false;
		this.typingStop = this.opts.transport.startTyping(this.opts.chatId);

		try {
			const child = await this.ensureChild();
			this.statusMessageId = await this.sendStatus("🧠 Working…");
			this.lastProgressEdit = Date.now();

			let disposition = "started";
			try {
				const res = await child.request<{ disposition?: string }>(
					{
						type: "prompt",
						message: text,
						...(images.length
							? { images: images.map((i) => ({ type: "image", data: i.data.toString("base64"), mimeType: i.mimeType })) }
							: {}),
					},
					RUN_REQUEST_TIMEOUT,
				);
				disposition = res?.disposition ?? "started";
			} catch (err) {
				await this.deliver(`⚠️ Failed to submit prompt: ${err instanceof Error ? err.message : String(err)}`);
				return;
			}

			await this.waitForSettled(disposition);
			if (this.deathMessage) {
				await this.deliver(this.deathMessage);
				return;
			}

			const finalText = await this.fetchFinalText(child);
			const elapsed = formatDuration(Date.now() - this.runStartedAt);
			const suffix = this.stopping ? ` *(stopped after ${elapsed})*` : "";
			const errNote = this.retryError ? `\n\n⚠️ Last model request failed: ${this.retryError}` : "";
			await this.deliverFinal(finalText || (this.stopping ? "Stopped." : "(no text output)"), suffix + errNote);
		} catch (err) {
			this.log("run failed:", err);
			await this.deliver(`⚠️ ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			this.typingStop?.();
			this.typingStop = null;
			this.busy = false;
			this.currentToolSummary = "";
			this.statusMessageId = undefined;
			this.streamText = "";
			this.streamActive = false;
			if (this.streamTimer) {
				clearTimeout(this.streamTimer);
				this.streamTimer = null;
			}
			const turn: CompletedTurn = { userMessageIds: this.turnUserMessageIds, messageIds: this.turnMessageIds };
			this.turnUserMessageIds = [];
			this.turnMessageIds = [];
			try {
				this.opts.onTurnComplete?.(turn);
			} catch (err) {
				this.log("onTurnComplete failed:", err);
			}
			void this.recordSessionFile();
			const next = this.queue.shift();
			if (next) void this.runNext(next.text, next.images, next.userMessageId);
		}
	}

	private waitForSettled(disposition: string): Promise<void> {
		return new Promise<void>((resolve) => {
			let done = false;
			const finish = () => {
				if (done) return;
				done = true;
				clearTimeout(safety);
				this.settledWaiters.delete(finish);
				resolve();
			};
			this.settledWaiters.add(finish);
			// "handled" prompts (extension commands) may not run the agent at all.
			const fallback = setTimeout(finish, disposition === "handled" ? HANDLED_FALLBACK_MS : SETTLE_TIMEOUT);
			fallback.unref?.();
			const safety = fallback;
		});
	}

	private async fetchFinalText(child: RpcChild): Promise<string> {
		try {
			const res = await child.request<{ text: string | null }>({ type: "get_last_assistant_text" }, COMMAND_TIMEOUT);
			return (res?.text ?? "").trim();
		} catch {
			return "";
		}
	}

	private async recordSessionFile(): Promise<void> {
		try {
			const child = this.child;
			if (!child?.running) return;
			const state = await child.request<{ sessionFile?: string }>({ type: "get_state" }, 15_000);
			if (state?.sessionFile) this.opts.state.setSessionFile(this.opts.key, state.sessionFile);
		} catch {
			/* best effort */
		}
	}

	// ---- delivery ----------------------------------------------------------

	private async sendStatus(text: string): Promise<string | undefined> {
		try {
			const id = await this.opts.transport.send(this.opts.chatId, text);
			if (id) this.turnMessageIds.push(id);
			return id;
		} catch {
			return undefined;
		}
	}

	private scheduleProgressEdit(force: boolean): void {
		if (!this.opts.config.progressUpdates) return;
		if (!this.statusMessageId) return;
		// Streaming text owns the message while it flows; tool progress only
		// shows between assistant messages.
		if (this.streamActive) return;
		const now = Date.now();
		if (!force && now - this.lastProgressEdit < PROGRESS_EDIT_INTERVAL) return;
		this.lastProgressEdit = now;
		const elapsed = formatDuration(now - this.runStartedAt);
		const lines = [`🧠 Working… ${elapsed}`];
		if (this.currentToolSummary) lines.push(`⚙️ ${this.currentToolSummary}`);
		void this.opts.transport
			.edit(this.opts.chatId, this.statusMessageId, lines.join("\n"))
			.catch(() => {});
	}

	/** Throttled in-place edit of the status message with the streaming answer text. */
	private scheduleStreamEdit(): void {
		if (this.opts.config.streaming === false) return;
		if (!this.statusMessageId || !this.streamActive) return;
		const now = Date.now();
		if (now - this.lastStreamEdit < STREAM_EDIT_INTERVAL) {
			if (!this.streamTimer) {
				this.streamTimer = setTimeout(() => {
					this.streamTimer = null;
					this.flushStreamEdit();
				}, STREAM_EDIT_INTERVAL);
				this.streamTimer.unref?.();
			}
			return;
		}
		this.flushStreamEdit();
	}

	private flushStreamEdit(): void {
		if (!this.statusMessageId || !this.streamText) return;
		if (this.opts.config.streaming === false) return;
		if (!this.streamActive) return;
		this.lastStreamEdit = Date.now();
		const limit = (this.opts.key.startsWith("discord:") ? DISCORD_LIMIT : TELEGRAM_LIMIT) - 120;
		// Once the message would overflow, keep the freshest tail visible; the
		// final delivery re-chunks the whole answer properly.
		const body = this.streamText.length > limit ? `…${this.streamText.slice(-limit)}` : this.streamText;
		void this.opts.transport
			.edit(this.opts.chatId, this.statusMessageId, `${body} ▌`)
			.catch(() => {});
	}

	private async deliver(text: string): Promise<void> {
		try {
			const id = await this.opts.transport.send(this.opts.chatId, text);
			if (id) this.turnMessageIds.push(id);
		} catch (err) {
			this.log("deliver failed:", err);
		}
	}

	/** Edit the status message into the first chunk; send remaining chunks as new messages. */
	private async deliverFinal(text: string, suffix: string): Promise<void> {
		const limit = this.opts.key.startsWith("discord:") ? DISCORD_LIMIT : TELEGRAM_LIMIT;
		const chunks = chunkText(text, limit);
		const first = chunks[0] ?? "";
		const rest = chunks.slice(1);
		if (this.statusMessageId) {
			const ok = await this.opts.transport
				.edit(this.opts.chatId, this.statusMessageId, first + suffix)
				.catch(() => false);
			if (!ok) await this.deliver(first + suffix);
		} else {
			await this.deliver(first + suffix);
		}
		for (const chunk of rest) await this.deliver(chunk);
	}

	// ---- commands ----------------------------------------------------------

	/** Abort the current run (if any) and cancel any pending interactive dialogs. Returns false when nothing is running. */
	async stop(): Promise<boolean> {
		this.child?.cancelDialogs();
		if (!this.child?.running || !this.busy) return false;
		this.stopping = true;
		try {
			await this.child.request({ type: "abort_retry" }, 5_000).catch(() => {});
			await this.child.request({ type: "abort" }, 30_000);
		} catch {
			/* abort is best effort; the settled handler still resolves */
		}
		return true;
	}

	async newSession(name?: string): Promise<string> {
		if (this.busy) return "Agent is busy - use /stop first.";
		const child = await this.ensureChild();
		const res = await child.request<{ cancelled?: boolean }>({ type: "new_session" }, COMMAND_TIMEOUT);
		if (res?.cancelled) return "Session switch was cancelled by an extension.";
		if (name) await child.request({ type: "set_session_name", name }, COMMAND_TIMEOUT).catch(() => {});
		await this.recordSessionFile();
		return name ? `Started new session “${name}”.` : "Started new session.";
	}

	async listSessions(): Promise<string> {
		const dir = this.sessionDirAbs;
		let files: string[] = [];
		try {
			files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
		} catch {
			return "No sessions yet.";
		}
		if (!files.length) return "No sessions yet.";
		const current = this.opts.state.chat(this.opts.key).sessionFile;
		const rows = files
			.map((f) => {
				const p = join(dir, f);
				return { p, mtime: statSync(p).mtimeMs, label: peekSessionLabel(p) };
			})
			.sort((a, b) => b.mtime - a.mtime)
			.slice(0, 10)
			.map(
				(row, i) =>
					`${row.p === current ? "★" : " "} ${String(i + 1).padStart(2)}. ${new Date(row.mtime).toISOString().slice(0, 16).replace("T", " ")}  ${row.label}`,
			);
		return ["Recent sessions (★ = current, /resume <n>):", ...rows].join("\n");
	}

	async resumeSession(index: number): Promise<string> {
		if (this.busy) return "Agent is busy - use /stop first.";
		const dir = this.sessionDirAbs;
		let files: string[] = [];
		try {
			files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
		} catch {
			return "No sessions yet.";
		}
		const sorted = files
			.map((f) => ({ f, mtime: statSync(join(dir, f)).mtimeMs }))
			.sort((a, b) => b.mtime - a.mtime);
		const pick = sorted[index - 1];
		if (!pick) return `No session #${index}. Use /sessions to list.`;
		const path = join(dir, pick.f);
		const child = await this.ensureChild();
		const res = await child.request<{ cancelled?: boolean }>({ type: "switch_session", sessionPath: path }, COMMAND_TIMEOUT);
		if (res?.cancelled) return "Session switch was cancelled by an extension.";
		this.opts.state.setSessionFile(this.opts.key, path);
		return `Resumed ${pick.f.slice(0, 8)}… (${peekSessionLabel(path)})`;
	}

	async status(): Promise<string> {
		const lines: string[] = [`cwd: ${this.chatCwd()}`, `session dir: ${this.sessionDirAbs}`];
		try {
			await this.ensureChild();
		} catch (err) {
			lines.push(`child: failed to start (${err instanceof Error ? err.message.split("\n")[0] : String(err)})`);
			return lines.join("\n");
		}
		if (!this.child?.running) {
			lines.push("child: not running");
			return lines.join("\n");
		}
		try {
			const st = await this.child.request<{
				model?: ModelInfo;
				thinkingLevel?: string;
				sessionName?: string;
				sessionFile?: string;
				messageCount?: number;
			}>({ type: "get_state" }, COMMAND_TIMEOUT);
			if (st?.model) lines.push(`model: ${st.model.provider}/${st.model.id}`);
			if (st?.thinkingLevel) lines.push(`thinking: ${st.thinkingLevel}`);
			if (st?.sessionName) lines.push(`session: ${st.sessionName}`);
			if (st?.sessionFile) lines.push(`session file: ${st.sessionFile.split("/").pop()}`);
			lines.push(`messages: ${st?.messageCount ?? "?"}`);
			const stats = await this.child.request<{
				contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null };
			}>({ type: "get_session_stats" }, COMMAND_TIMEOUT);
			if (stats?.contextUsage) {
				lines.push(`context: ${stats.contextUsage.percent ?? "?"}% of ${Math.round(stats.contextUsage.contextWindow / 1000)}k`);
			}
		} catch (err) {
			lines.push(`(state unavailable: ${String(err).slice(0, 100)})`);
		}
		lines.push(
			`state: ${this.busy ? `running (${formatDuration(Date.now() - this.runStartedAt)})` : "idle"}${this.queue.length ? `, ${this.queue.length} queued` : ""}`,
		);
		return lines.join("\n");
	}

	async setModel(pattern: string): Promise<string> {
		const child = await this.ensureChild();
		if (!pattern.trim()) {
			const st = await child.request<{ model?: ModelInfo }>({ type: "get_state" }, COMMAND_TIMEOUT);
			return st?.model ? `Current model: ${st.model.provider}/${st.model.id}` : "No model selected.";
		}
		const res = await child.request<{ models: ModelInfo[] }>({ type: "get_available_models" }, COMMAND_TIMEOUT);
		const scored = res.models
			.map((m) => ({ m, score: fuzzyModelScore(pattern, m.provider, m.id, m.name) }))
			.filter((s) => s.score > 0)
			.sort((a, b) => b.score - a.score);
		if (!scored.length) {
			const top = res.models
				.slice(0, 8)
				.map((m) => `  ${m.provider}/${m.id}`)
				.join("\n");
			return `No model matches “${pattern}”. Some available:\n${top}`;
		}
		const best = scored[0].m;
		await child.request({ type: "set_model", provider: best.provider, modelId: best.id }, COMMAND_TIMEOUT);
		return `Model set to ${best.provider}/${best.id}${scored.length > 1 ? ` (${scored.length - 1} other match(es))` : ""}.`;
	}

	async setThinking(level?: string): Promise<string> {
		const child = await this.ensureChild();
		if (!level) {
			const st = await child.request<{ thinkingLevel?: string }>({ type: "get_state" }, COMMAND_TIMEOUT);
			return `Thinking level: ${st?.thinkingLevel ?? "default"}`;
		}
		const levels = await child.request<{ levels: string[] }>({ type: "get_available_thinking_levels" }, COMMAND_TIMEOUT);
		if (!levels.levels.includes(level)) return `Level “${level}” not available. Available: ${levels.levels.join(", ")}`;
		await child.request({ type: "set_thinking_level", level }, COMMAND_TIMEOUT);
		return `Thinking level set to ${level}.`;
	}

	async compact(instructions?: string): Promise<string> {
		if (this.busy) return "Agent is busy - use /stop first.";
		const child = await this.ensureChild();
		const res = await child.request<{ tokensBefore?: number; estimatedTokensAfter?: number }>(
			{ type: "compact", ...(instructions ? { customInstructions: instructions } : {}) },
			COMPACT_TIMEOUT,
		);
		return `Compacted: ${formatTokens(res?.tokensBefore)} → ${formatTokens(res?.estimatedTokensAfter)} tokens.`;
	}

	async setChatCwd(path: string): Promise<string> {
		const expanded = expandTilde(path.trim());
		let st: Stats;
		try {
			st = statSync(expanded);
		} catch {
			return `Path does not exist: ${expanded}`;
		}
		if (!st.isDirectory()) return `Not a directory: ${expanded}`;
		this.opts.state.setChatCwd(this.opts.key, expanded);
		if (this.child?.running) {
			await this.child.kill();
			this.child = null;
		}
		return `Chat cwd set to ${expanded}. (Child restarts on next message.)`;
	}

	async ping(): Promise<string> {
		const start = Date.now();
		const child = await this.ensureChild();
		await child.request({ type: "get_state" }, COMMAND_TIMEOUT);
		return `pong (${Date.now() - start}ms, ${this.busy ? "busy" : "idle"})`;
	}

	/** Names of extension/skill/prompt commands the child accepts via prompt passthrough. */
	async childCommandNames(): Promise<Set<string>> {
		const commands = await this.childCommands();
		return new Set(commands.map((c) => c.name));
	}

	/** Commands the child session accepts via prompt passthrough, with descriptions. */
	async childCommands(): Promise<Array<{ name: string; description?: string; source: string }>> {
		const child = this.child;
		if (!child?.running) return [];
		try {
			const res = await child.request<{ commands: Array<{ name: string; description?: string; source: string }> }>(
				{ type: "get_commands" },
				COMMAND_TIMEOUT,
			);
			return res.commands ?? [];
		} catch {
			return [];
		}
	}

	async shutdown(): Promise<void> {
		this.typingStop?.();
		this.queue = [];
		this.resolveSettled();
		this.child?.cancelDialogs();
		if (this.child) {
			await this.child.kill();
			this.child = null;
		}
	}

	/** Called periodically by the gateway to reap idle children. */
	reapIdle(idleMs: number): void {
		if (this.child?.running && !this.busy && Date.now() - this.lastActivity > idleMs) {
			this.log("reaping idle child");
			void this.child.kill();
			this.child = null;
		}
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

function roleOf(message: unknown): string | undefined {
	if (typeof message !== "object" || message === null) return undefined;
	return (message as { role?: unknown }).role as string | undefined;
}

/** Concatenated text parts of an AgentMessage content field (string, parts array, or absent). */
function messageText(message: unknown): string {
	if (typeof message !== "object" || message === null) return "";
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) =>
			typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text"
				? String((part as { text?: unknown }).text ?? "")
				: "",
		)
		.join("");
}

/**
 * Commands a fresh child session (default cwd, extensions enabled) accepts —
 * used to build the native command menus without touching any chat's session.
 */
export async function fetchChildCommands(
	config: PiCordConfig,
): Promise<Array<{ name: string; description?: string; source: string }>> {
	const cwd = resolveCwd(config);
	mkdirSync(cwd, { recursive: true });
	const child = RpcChild.spawn({
		piPath: resolvePiPath(config),
		args: [
			"--mode",
			"rpc",
			...(config.childExtensions === false ? ["--no-extensions"] : []),
			...(config.trustProject !== false ? ["--approve"] : []),
			...(config.childArgs ?? []),
		],
		cwd,
	});
	try {
		const deadline = Date.now() + 60_000;
		for (;;) {
			if (!child.running) throw new Error("probe exited during startup");
			try {
				await child.request({ type: "get_state" }, 10_000);
				break;
			} catch {
				if (Date.now() > deadline) throw new Error("probe not ready in time");
				await sleep(300);
			}
		}
		const res = await child.request<{ commands?: Array<{ name: string; description?: string; source: string }> }>(
			{ type: "get_commands" },
			COMMAND_TIMEOUT,
		);
		return res.commands ?? [];
	} catch (err) {
		log("command probe failed:", err);
		return [];
	} finally {
		void child.kill();
	}
}

/** Best-effort label for a session file: a session_info name or the first user message snippet. */
function peekSessionLabel(path: string): string {
	try {
		const fd = openSync(path, "r");
		const buf = Buffer.alloc(64 * 1024);
		const read = readSync(fd, buf, 0, buf.length, 0);
		closeSync(fd);
		const head = buf.toString("utf8", 0, read);
		const nameMatch = /"type":"session_info"[^\n]*?"name":"((?:[^"\\]|\\.)*)"/.exec(head);
		if (nameMatch) return nameMatch[1];
		const userMatch = /"role":"user"[\s\S]{0,2000}?"text":"((?:[^"\\]|\\.)*)"/.exec(head);
		if (userMatch) {
			const t = userMatch[1].replace(/\\n/g, " ").replace(/\\"/g, '"');
			return t.length > 48 ? `${t.slice(0, 47)}…` : t || "(unnamed)";
		}
	} catch {
		/* ignore */
	}
	return "(unnamed)";
}
