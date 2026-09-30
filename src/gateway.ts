import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import type { ChatAdapter, DialogAnswer, DialogRequest, Incoming, SlashCommandInfo } from "./types";
import { fetchChildCommands, ChatAgent, type CompletedTurn } from "./chat";
import { GATEWAY_COMMANDS, handleMessage, isAllowed, type CommandOutcome } from "./commands";
import { hasAnyToken, loadConfig, resolvePiPath, type PiCordConfig } from "./config";
import { acquireGatewayLock, readGatewayLock } from "./lock";
import { StateStore, type UiTurn } from "./state";
import { createLogger, expandTilde } from "./util";

const log = createLogger("gateway");

const REAP_INTERVAL_MS = 60_000;
const NOTIFY_ICON: Record<string, string> = { info: "ℹ️", warning: "⚠️", error: "❌" };

interface PendingDialog {
	key: string;
	cancel: (answer: DialogAnswer) => void;
}

export interface GatewayStatus {
	running: boolean;
	adapters: Array<{ platform: string; name: string }>;
	chats: Array<{ key: string; busy: boolean; queued: number }>;
}

/**
 * Owns the platform adapters and the per-chat agents. Used identically by the
 * pi extension entry (index.ts) and the standalone runner (main.ts).
 */
export class GatewayHost {
	private adapters: ChatAdapter[] = [];
	private chats = new Map<string, ChatAgent>();
	private chains = new Map<string, Promise<unknown>>();
	private readonly pendingDialogs = new Map<string, PendingDialog>();
	private reaper: ReturnType<typeof setInterval> | null = null;
	private running = false;
	private releaseLock: (() => void) | null = null;
	readonly state: StateStore;
	readonly config: PiCordConfig;
	readonly configPath: string;
	private readonly sessionsBase: string;

	constructor(config: PiCordConfig, configPath: string, statePath?: string) {
		this.config = config;
		this.configPath = configPath;
		const resolvedStatePath = statePath ?? expandTilde("~/.pi/agent/pi-cord/state.json");
		this.sessionsBase = join(dirname(resolvedStatePath), "sessions");
		this.state = new StateStore(resolvedStatePath, (msg) => log(msg));
	}

	static fromEnv(statePath?: string): GatewayHost | null {
		const loaded = loadConfig();
		if (!loaded) return null;
		return new GatewayHost(loaded.config, loaded.path, statePath);
	}

	get isRunning(): boolean {
		return this.running;
	}

	status(): GatewayStatus {
		return {
			running: this.running,
			adapters: this.adapters.map((a) => ({ platform: a.platform, name: a.botName })),
			chats: [...this.chats.values()].map((c) => ({
				key: c.key,
				busy: c.busyNow,
				queued: 0,
			})),
		};
	}

	async start(): Promise<void> {
		if (this.running) return;
		if (!hasAnyToken(this.config)) {
			throw new Error(
				`No bot tokens configured. Edit ${this.configPath} (see config.example.json) or set PI_CORD_TELEGRAM_TOKEN / PI_CORD_DISCORD_TOKEN.`,
			);
		}
		const release = acquireGatewayLock();
		if (!release) {
			const held = readGatewayLock();
			throw new Error(`Another pi-cord gateway is already running (pid ${held?.pid}). Stop it first: systemctl --user stop pi-cord`);
		}
		this.releaseLock = release;

		if (this.config.telegram?.token) {
			const { TelegramAdapter } = await import("./telegram");
			await this.addAdapter(
				new TelegramAdapter(this.config.telegram.token, {
					allowedUsers: this.config.telegram.allowedUsers ?? [],
					initialOffset: this.state.telegramOffset,
					onOffset: (o) => this.state.setTelegramOffset(o),
				}),
			);
		}

		if (this.config.discord?.token) {
			const { DiscordAdapter } = await import("./discord");
			await this.addAdapter(
				new DiscordAdapter(this.config.discord.token, {
					allowedUsers: this.config.discord.allowedUsers ?? [],
				}),
			);
		}

		this.running = true;
		this.reaper = setInterval(() => {
			const idleMs = (this.config.childIdleMinutes ?? 30) * 60_000;
			for (const chat of this.chats.values()) chat.reapIdle(idleMs);
		}, REAP_INTERVAL_MS);
		this.reaper.unref?.();

		this.syncCommandMenus();

		log(
			`started (${this.adapters.map((a) => `${a.platform}:${a.botName}`).join(", ")}); pi: ${resolvePiPath(this.config)}`,
		);
	}

	/** Register and start an adapter (config-driven ones use this too; also the test/future-platform hook). */
	async addAdapter(adapter: ChatAdapter): Promise<void> {
		adapter.onMessage((msg, opts) => this.handleMessage(msg, opts));
		await adapter.start();
		this.adapters.push(adapter);
		this.running = true;
	}

	async stop(): Promise<void> {
		if (!this.running && this.adapters.length === 0) return;
		this.running = false;
		if (this.reaper) {
			clearInterval(this.reaper);
			this.reaper = null;
		}
		for (const adapter of this.adapters) {
			await adapter.stop().catch((err) => log(`${adapter.platform} stop failed:`, err));
		}
		this.adapters = [];
		for (const chat of this.chats.values()) await chat.shutdown().catch(() => {});
		this.chats.clear();
		this.state.flush();
		this.releaseLock?.();
		this.releaseLock = null;
		log("stopped");
	}

	/** Serialize handling per chat so message order is preserved. */
	private enqueue<T>(key: string, fn: () => Promise<T>): Promise<T> {
		const prev = this.chains.get(key) ?? Promise.resolve();
		const next = prev.then(fn, fn);
		this.chains.set(
			key,
			next.catch(() => {}),
		);
		return next;
	}

	async handleMessage(
		msg: Incoming,
		opts?: { replySink?: (text: string) => Promise<string | undefined> },
	): Promise<CommandOutcome | undefined> {
		const key = `${msg.platform}:${msg.chatId}`;
		const deliver = async (text: string): Promise<string | undefined> => {
			if (opts?.replySink) return opts.replySink(text);
			return this.adapterFor(msg.platform).send(msg.chatId, text);
		};
		return this.enqueue(key, async (): Promise<CommandOutcome | undefined> => {
			const chat = this.chatFor(key, msg.chatId);
			try {
				const outcome = await handleMessage(msg, {
					config: this.config,
					chat,
					chatKey: key,
					cancelDialogs: () => this.cancelDialogsFor(key),
				});
				switch (outcome.kind) {
					case "reply": {
						const id = await deliver(outcome.text);
						void this.appendTurn(key, { userMessageIds: msg.messageId ? [msg.messageId] : [], messageIds: id ? [id] : [] });
						break;
					}
					case "prompt": {
						const res = await chat.submit(outcome.text, outcome.images, msg.messageId);
						if (res.queued) {
							const id = await deliver(`📨 Queued (position ${res.position}) — I'll answer when the current run finishes.`);
							void this.appendTurn(key, { userMessageIds: [], messageIds: id ? [id] : [] });
						} else if (res.steered) {
							const id = await deliver("↪️ Appended to the running conversation — the agent picks it up this turn.");
							void this.appendTurn(key, { userMessageIds: [], messageIds: id ? [id] : [] });
						}
						break;
					}
					case "ignored":
						break;
				}
				return outcome;
			} catch (err) {
				log("handleMessage failed:", err);
				const text = `⚠️ pi-cord error: ${err instanceof Error ? err.message : String(err)}`;
				await deliver(text).catch(() => {});
				return undefined;
			}
		});
	}

	// ---- visible-history window ---------------------------------------------

	/**
	 * Record a finished turn and delete messages that fell out of the visible
	 * window (config.uiHistoryTurns, default 3). Best effort throughout.
	 */
	private async appendTurn(key: string, turn: UiTurn): Promise<void> {
		const limit = this.config.uiHistoryTurns ?? 3;
		if (limit <= 0) return; // pruning disabled
		const empty = turn.userMessageIds.length === 0 && turn.messageIds.length === 0;
		if (empty) return;
		const turns = [...this.state.getUiTurns(key), turn];
		const evicted = turns.length > limit ? turns.splice(0, turns.length - limit) : [];
		this.state.setUiTurns(key, turns);
		if (!evicted.length) return;
		const adapter = this.adapterForChat(key);
		if (!adapter?.delete) return;
		const chatId = key.slice(key.indexOf(":") + 1);
		for (const old of evicted) {
			for (const id of [...old.messageIds, ...old.userMessageIds]) {
				await adapter.delete(chatId, id).catch(() => {});
			}
		}
	}

	// ---- interactive dialog & notification forwarding -----------------------

	/** Adapter for a chat key, or undefined when that platform isn't running (e.g. mid-shutdown). */
	private adapterForChat(key: string): ChatAdapter | undefined {
		const platform = key.startsWith("discord:") ? "discord" : "telegram";
		return this.adapters.find((a) => a.platform === platform);
	}

	/** Present a child's extension dialog in the chat; resolves with the answer or cancellation on timeout. */
	private async forwardDialog(key: string, chatId: string, req: DialogRequest): Promise<DialogAnswer> {
		const cfg = this.config;
		if (cfg.interactiveDialogs === false) return { cancelled: true };
		const adapter = this.adapterForChat(key);
		if (!adapter) return { cancelled: true };
		const timeoutMs = (cfg.dialogTimeoutSeconds ?? 180) * 1000;
		const effective = req.timeoutMs ? Math.min(req.timeoutMs, timeoutMs) : timeoutMs;

		return new Promise<DialogAnswer>((resolve) => {
			const timer = setTimeout(() => {
				this.pendingDialogs.delete(req.id);
				resolve({ cancelled: true });
			}, effective + 1000); // outlive the agent-side timeout if one was declared
			timer.unref?.();
			this.pendingDialogs.set(req.id, {
				key,
				cancel: (answer) => {
					clearTimeout(timer);
					this.pendingDialogs.delete(req.id);
					resolve(answer);
				},
			});
			adapter
				.ask(chatId, req)
				.then((answer) => {
					const pending = this.pendingDialogs.get(req.id);
					if (pending) {
						clearTimeout(timer);
						this.pendingDialogs.delete(req.id);
						resolve(answer);
					}
				})
				.catch((err) => {
					log("adapter ask failed:", err);
					const pending = this.pendingDialogs.get(req.id);
					if (pending) pending.cancel({ cancelled: true });
				});
		});
	}

	/** Cancel every pending dialog of a chat (used by /stop). */
	cancelDialogsFor(key: string): void {
		for (const [id, pending] of this.pendingDialogs) {
			if (pending.key === key) pending.cancel({ cancelled: true });
			void id;
		}
	}

	private forwardNotify(key: string, chatId: string, message: string, notifyType: string): void {
		if (this.config.forwardNotifications === false) return;
		const policy = this.config.notify;
		if (policy?.suppress?.some((pattern) => message.includes(pattern))) return;
		// Unknown levels display as info; both follow the info policy so repeat
		// banners (e.g. extension startup notices) don't spam every run.
		if (!notifyType || notifyType === "info" || !NOTIFY_ICON[notifyType]) {
			const mode = policy?.info ?? "once";
			if (mode === "off") return;
			if (mode === "once") {
				const hash = createHash("sha1").update(message).digest("hex").slice(0, 16);
				if (this.state.hasSeenNotify(key, hash)) return;
			}
		}
		const icon = NOTIFY_ICON[notifyType] ?? "ℹ️";
		const text = `${icon} ${message}`;
		const adapter = this.adapterForChat(key);
		if (!adapter) return;
		adapter.send(chatId, text.length > 500 ? `${text.slice(0, 499)}…` : text).catch(() => {});
	}

	adapterFor(platform: Incoming["platform"]): ChatAdapter {
		const adapter = this.adapters.find((a) => a.platform === platform);
		if (!adapter) throw new Error(`no ${platform} adapter running`);
		return adapter;
	}

	private chatFor(key: string, chatId: string): ChatAgent {
		let chat = this.chats.get(key);
		if (!chat) {
			const dirSafe = key.replace(/[^A-Za-z0-9_-]/g, "_");
			chat = new ChatAgent({
				key,
				chatId,
				config: this.config,
				state: this.state,
				sessionDir: join(this.sessionsBase, dirSafe),
				forwardDialog: (req) => this.forwardDialog(key, chatId, req),
				forwardNotify: (message, notifyType) => this.forwardNotify(key, chatId, message, notifyType),
				onTurnComplete: (turn: CompletedTurn) => void this.appendTurn(key, turn),
				transport: {
					send: (cid, text) => this.adapterFor(key.startsWith("discord:") ? "discord" : "telegram").send(cid, text),
					edit: (cid, msgId, text) =>
						this.adapterFor(key.startsWith("discord:") ? "discord" : "telegram").edit(cid, msgId, text),
					startTyping: (cid) => this.adapterFor(key.startsWith("discord:") ? "discord" : "telegram").startTyping(cid),
				},
			});
			this.chats.set(key, chat);
		}
		return chat;
	}

	// ---- native command menus ------------------------------------------------

	/**
	 * Publish the platform command menus: gateway built-ins now, merged with the
	 * child session's commands (extensions, skills, prompts) once a probe child
	 * has answered. Runs in the background; failures are logged, never fatal.
	 */
	syncCommandMenus(): Promise<void> {
		if (this.config.slashCommands === false) return Promise.resolve();
		const publish = async () => {
			await this.publishCommands(GATEWAY_COMMANDS);
			const childCommands = await fetchChildCommands(this.config);
			const merged = new Map<string, SlashCommandInfo>();
			for (const cmd of GATEWAY_COMMANDS) merged.set(cmd.name, cmd);
			for (const cmd of childCommands) {
				if (!merged.has(cmd.name)) {
					merged.set(cmd.name, {
						name: cmd.name,
						description: cmd.description || "Pi session command",
						source: (cmd.source as SlashCommandInfo["source"]) ?? "extension",
					});
				}
			}
			await this.publishCommands([...merged.values()]);
			log(`command menus published (${merged.size} commands)`);
		};
		return publish().catch((err) => log("command menu sync failed:", err));
	}

	private async publishCommands(commands: SlashCommandInfo[]): Promise<void> {
		for (const adapter of this.adapters) {
			await adapter.registerCommands?.(commands).catch((err) => log(`${adapter.platform} registerCommands failed:`, err));
		}
	}

	/** One-line allowlist diagnostics for /pi-cord status in the TUI. */
	allowlistSummary(): string {
		const d = this.config.discord;
		const t = this.config.telegram;
		return [
			`discord: ${d?.token ? "token set" : "no token"}, allowed: ${d?.allowedUsers?.length ?? 0}`,
			`telegram: ${t?.token ? "token set" : "no token"}, allowed: ${t?.allowedUsers?.length ?? 0}`,
		].join("\n");
	}

	isUserAllowed(platform: Incoming["platform"], userId: string): boolean {
		return isAllowed(this.config, {
			platform,
			userId,
			chatId: "",
			userName: "",
			text: "",
			images: [],
			isCommand: false,
			isDM: true,
		});
	}
}
