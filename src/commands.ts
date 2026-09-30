import type { ChatAgent } from "./chat";
import type { Incoming } from "./types";
import type { PiCordConfig } from "./config";

export const HELP_TEXT = [
	"*pi-cord* — chat with your Pi coding agent.",
	"",
	"Commands:",
	"/new [name] — start a fresh session",
	"/sessions — list recent sessions for this chat",
	"/resume <n> — switch to session n",
	"/stop — abort the current run",
	"/status — model, session, context usage",
	"/model [pattern] — show or switch model",
	"/thinking [level] — show or set thinking level",
	"/compact [instructions] — compact context",
	"/cwd [path] — show or set this chat's working dir",
	"/ping — check the agent is responsive",
	"/id — show platform/chat/user ids",
	"/help — this text",
	"",
	"Anything else is sent to the agent as a prompt. Unknown /commands that exist as skills or prompt templates are forwarded to the agent.",
].join("\n");

/** Commands that work even for non-allowlisted users (needed for bootstrapping). */
const OPEN_COMMANDS = new Set(["id", "help", "start", "ping"]);

export function isAllowed(config: PiCordConfig, msg: Incoming): boolean {
	const list = msg.platform === "discord" ? config.discord?.allowedUsers : config.telegram?.allowedUsers;
	if (!list || list.length === 0) return false;
	return list.map(String).includes(String(msg.userId));
}

export function parseCommand(text: string): { command: string; args: string } | null {
	const trimmed = text.trim();
	if (!trimmed.startsWith("/")) return null;
	const m = /^\/([A-Za-z0-9_:-]+)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/.exec(trimmed);
	if (!m) return null;
	return { command: (m[1] ?? "").toLowerCase(), args: (m[2] ?? "").trim() };
}

export interface CommandContext {
	config: PiCordConfig;
	chat: ChatAgent;
	/** Gateway key of this chat, so the gateway can cancel its pending dialogs. */
	chatKey: string;
	/** Cancel outstanding interactive dialogs of this chat (used by /stop). */
	cancelDialogs: () => void;
}

export type CommandOutcome =
	| { kind: "reply"; text: string }
	| { kind: "prompt"; text: string; images: Incoming["images"] }
	| { kind: "ignored" };

/**
 * Handle one incoming message. Returns a reply, a prompt to submit to the
 * agent, or "ignored" (unauthorized chatter in groups).
 */
export async function handleMessage(msg: Incoming, ctx: CommandContext): Promise<CommandOutcome> {
	const { config, chat } = ctx;
	const allowed = isAllowed(config, msg);
	const cmd = msg.isCommand ? msg.command : null;

	if (!allowed && cmd && OPEN_COMMANDS.has(cmd)) {
		if (cmd === "help" || cmd === "start") {
			const blurb =
				"⛔ This bot is private. Ask its owner to allowlist your id.\n\n" + idsLine(msg) + "\n\n" + HELP_TEXT;
			return { kind: "reply", text: blurb };
		}
		if (cmd === "id") return { kind: "reply", text: idsLine(msg) };
		if (cmd === "ping") return { kind: "reply", text: "pong (but you are not allowlisted to use this bot)" };
	}

	if (!allowed) {
		// Silent in groups; a polite notice in DMs, rate-limited by the adapter.
		return msg.isDM ? { kind: "reply", text: `⛔ Not authorized.\n\n${idsLine(msg)}\nThe bot owner must add this id to the allowlist in pi-cord's config.` } : { kind: "ignored" };
	}

	if (cmd) return handleCommand(cmd, msg.args ?? "", ctx, msg);

	return { kind: "prompt", text: msg.text, images: msg.images };
}

function idsLine(msg: Incoming): string {
	return `platform: \`${msg.platform}\`\nchat id: \`${msg.chatId}\`\nuser id: \`${msg.userId}\` (${msg.userName})`;
}

async function handleCommand(command: string, args: string, ctx: CommandContext, msg: Incoming): Promise<CommandOutcome> {
	const { chat } = ctx;
	switch (command) {
		case "new": {
			const reply = await chat.newSession(args || undefined);
			return { kind: "reply", text: reply };
		}
		case "sessions":
			return { kind: "reply", text: await chat.listSessions() };
		case "resume": {
			const n = Number.parseInt(args, 10);
			if (!Number.isFinite(n)) return { kind: "reply", text: "Usage: /resume <n>  (see /sessions)" };
			return { kind: "reply", text: await chat.resumeSession(n) };
		}
		case "stop": {
			const stopped = await chat.stop();
			ctx.cancelDialogs();
			return { kind: "reply", text: stopped ? "⏹ Stopping…" : "Nothing is running." };
		}
		case "status":
			return { kind: "reply", text: await chat.status() };
		case "model":
			return { kind: "reply", text: await chat.setModel(args) };
		case "thinking":
			return { kind: "reply", text: await chat.setThinking(args || undefined) };
		case "compact":
			return { kind: "reply", text: await chat.compact(args || undefined) };
		case "cwd":
			if (!args) {
				const st = await chat.status();
				const line = st.split("\n").find((l) => l.startsWith("cwd:"));
				return { kind: "reply", text: line ?? "(unknown)" };
			}
			return { kind: "reply", text: await chat.setChatCwd(args) };
		case "ping":
			return { kind: "reply", text: await chat.ping() };
		case "id":
			return { kind: "reply", text: idsLine(msg) };
		case "help":
		case "start":
			return { kind: "reply", text: HELP_TEXT };
		default: {
			// Pass through skills, prompt templates, and extension commands that
			// exist inside the child session.
			const known = await chat.childCommandNames();
			if (known.has(command)) {
				return { kind: "prompt", text: `/${command}${args ? ` ${args}` : ""}`, images: [] };
			}
			return { kind: "reply", text: `Unknown command /${command}. Try /help.` };
		}
	}
}
