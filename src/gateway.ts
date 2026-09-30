import { join, dirname } from "node:path";
import type { ChatAdapter, Incoming } from "./types";
import { ChatAgent } from "./chat";
import { handleMessage, isAllowed } from "./commands";
import { hasAnyToken, loadConfig, resolvePiPath, type PiCordConfig } from "./config";
import { StateStore } from "./state";
import { createLogger, expandTilde } from "./util";

const log = createLogger("gateway");

const REAP_INTERVAL_MS = 60_000;

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
	private chains = new Map<string, Promise<void>>();
	private reaper: ReturnType<typeof setInterval> | null = null;
	private running = false;
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

		log(
			`started (${this.adapters.map((a) => `${a.platform}:${a.botName}`).join(", ")}); pi: ${resolvePiPath(this.config)}`,
		);
	}

	/** Register and start an adapter (config-driven ones use this too; also the test/future-platform hook). */
	async addAdapter(adapter: ChatAdapter): Promise<void> {
		adapter.onMessage((msg) => this.handleMessage(msg));
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
		this.state.flush();
		log("stopped");
	}

	/** Serialize handling per chat so message order is preserved. */
	private enqueue(key: string, fn: () => Promise<void>): Promise<void> {
		const prev = this.chains.get(key) ?? Promise.resolve();
		const next = prev.then(fn, fn);
		this.chains.set(
			key,
			next.catch(() => {}),
		);
		return next;
	}

	async handleMessage(msg: Incoming): Promise<void> {
		const key = `${msg.platform}:${msg.chatId}`;
		await this.enqueue(key, async () => {
			const chat = this.chatFor(key, msg.chatId);
			try {
				const outcome = await handleMessage(msg, { config: this.config, chat });
				switch (outcome.kind) {
					case "reply":
						await this.adapterFor(msg.platform).send(msg.chatId, outcome.text);
						break;
					case "prompt": {
						const res = await chat.submit(outcome.text, outcome.images);
						if (res.queued) {
							await this.adapterFor(msg.platform).send(msg.chatId, `📨 Queued (position ${res.position}) — I'll answer when the current run finishes.`);
						}
						break;
					}
					case "ignored":
						break;
				}
			} catch (err) {
				log("handleMessage failed:", err);
				const text = `⚠️ pi-cord error: ${err instanceof Error ? err.message : String(err)}`;
				await this.adapterFor(msg.platform).send(msg.chatId, text).catch(() => {});
			}
		});
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
