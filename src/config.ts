import { expandTilde, readJson } from "./util";

export interface DiscordConfig {
	token: string;
	/** Discord user ids allowed to use the bot. Empty = deny everyone (fail closed). */
	allowedUsers: string[];
}

export interface TelegramConfig {
	token: string;
	/** Telegram user ids allowed to use the bot. Empty = deny everyone (fail closed). */
	allowedUsers: string[];
}

/** Policy for fire-and-forget extension notifications (ctx.ui.notify) mirrored into the chat. */
export interface NotifyConfig {
	/**
	 * How info-level notifies are delivered: "all" sends every one, "once"
	 * (default) sends only the first of each distinct text per chat, "off"
	 * never sends them. warning/error notifies always come through.
	 */
	info?: "all" | "once" | "off";
	/** Never forward a notification whose message contains any of these substrings. */
	suppress?: string[];
}

export interface PiCordConfig {
	/** Start the bots automatically when a pi session starts. Default true. */
	autostart?: boolean;
	/** Path to the pi CLI used for child sessions. Default "pi". */
	piPath?: string;
	/** Default working directory for chat sessions. Default ~/.pi/agent/pi-cord/workspace. */
	cwd?: string;
	/** Default model pattern passed to child sessions (e.g. "anthropic/claude-sonnet-4-5"). */
	model?: string;
	/** Default thinking level: off|minimal|low|medium|high|xhigh|max. */
	thinking?: string;
	/** Load the user's extensions in child sessions. Default true — chat sessions behave like your real pi. */
	childExtensions?: boolean;
	/** Trust project-local resources (skills, prompts) in child sessions. Default true. */
	trustProject?: boolean;
	/** Forward extension dialogs (confirm/select/input) into the chat as buttons/replies. Default true. */
	interactiveDialogs?: boolean;
	/** Seconds to wait for a chat answer before a dialog is cancelled. Default 180. */
	dialogTimeoutSeconds?: number;
	/** Mirror fire-and-forget extension notifications (ctx.ui.notify) into the chat. Default true. */
	forwardNotifications?: boolean;
	/** Delivery policy for those notifications (dedupe/suppress). See NotifyConfig. */
	notify?: NotifyConfig;
	/** Live tool-activity edits on the status message. Default true. */
	progressUpdates?: boolean;
	/** Stream assistant text into the chat message as it is generated. Default true. */
	streaming?: boolean;
	/** Publish gateway + child commands as native Telegram/Discord slash commands. Default true. */
	slashCommands?: boolean;
	/**
	 * How many recent turns stay visible in the chat; older bot (and where
	 * possible user) messages are deleted as new turns complete. Default 3.
	 * 0 keeps the full chat history.
	 */
	uiHistoryTurns?: number;
	/**
	 * AGENTS.md-style instructions appended to every child session's system
	 * prompt — used only by pi-cord chats (the interactive pi never reads it).
	 * Default ~/.pi/agent/pi-cord/AGENTS.md; missing file = no injection.
	 */
	agentsMd?: string;
	/** Shut down an idle child after this many minutes. Default 30. */
	childIdleMinutes?: number;
	/** Extra CLI args for every child session. */
	childArgs?: string[];
	discord?: DiscordConfig;
	telegram?: TelegramConfig;
}

export const DEFAULT_WORKSPACE = "~/.pi/agent/pi-cord/workspace";

export interface LoadedConfig {
	config: PiCordConfig;
	path: string;
}

/**
 * Config lookup order:
 *   1. $PI_CORD_CONFIG
 *   2. ~/.pi/agent/pi-cord/config.json   (recommended)
 *   3. ~/pi-cord/config.json             (convenient for dev clones)
 * Tokens can also come from PI_CORD_DISCORD_TOKEN / PI_CORD_TELEGRAM_TOKEN,
 * which override whatever the file says.
 */
export function findConfigPath(): string | null {
	const candidates: string[] = [];
	if (process.env.PI_CORD_CONFIG) candidates.push(expandTilde(process.env.PI_CORD_CONFIG));
	candidates.push("~/.pi/agent/pi-cord/config.json", "~/pi-cord/config.json");
	for (const c of candidates) {
		const p = expandTilde(c);
		if (readJson<unknown>(p) != null) return p;
	}
	return null;
}

export function loadConfig(): LoadedConfig | null {
	const path = findConfigPath();
	if (!path) return null;
	const raw = readJson<PiCordConfig>(path);
	if (!raw) return null;
	const config = { ...raw };

	if (process.env.PI_CORD_DISCORD_TOKEN) {
		config.discord = { ...(config.discord ?? { allowedUsers: [] }), token: process.env.PI_CORD_DISCORD_TOKEN };
	}
	if (process.env.PI_CORD_TELEGRAM_TOKEN) {
		config.telegram = { ...(config.telegram ?? { allowedUsers: [] }), token: process.env.PI_CORD_TELEGRAM_TOKEN };
	}
	return { config, path };
}

export function defaultCwd(): string {
	return expandTilde(DEFAULT_WORKSPACE);
}

export function resolveCwd(config: PiCordConfig, chatOverride?: string): string {
	return expandTilde(chatOverride ?? config.cwd ?? DEFAULT_WORKSPACE);
}

export function resolvePiPath(config: PiCordConfig): string {
	const p = config.piPath?.trim() || "pi";
	if (p.includes("/")) return expandTilde(p);
	const fs = require("node:fs") as typeof import("node:fs");
	for (const dir of (process.env.PATH ?? "").split(":")) {
		if (!dir) continue;
		const candidate = `${dir}/${p}`;
		try {
			fs.accessSync(candidate, fs.constants.X_OK);
			return candidate;
		} catch {
			/* keep looking */
		}
	}
	return p;
}

/** True when at least one platform has a usable token. */
export function hasAnyToken(config: PiCordConfig): boolean {
	return Boolean(config.telegram?.token || config.discord?.token);
}
