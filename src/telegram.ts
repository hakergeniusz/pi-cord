import type { ChatAdapter, ImageAttachment, Incoming } from "./types";
import { chunkText, mdToTelegramHtml, TELEGRAM_LIMIT } from "./format";
import { createLogger } from "./util";

const log = createLogger("telegram");

const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const MAX_IMAGES = 4;
const TYPING_INTERVAL_MS = 4_500;
const UNAUTHORIZED_NOTICE_COOLDOWN_MS = 10 * 60_000;

interface TgUser {
	id: number;
	is_bot: boolean;
	first_name?: string;
	last_name?: string;
	username?: string;
}
interface TgChat {
	id: number;
	type: "private" | "group" | "supergroup" | "channel";
	title?: string;
}
interface TgPhotoSize {
	file_id: string;
	width: number;
	height: number;
	file_size?: number;
}
interface TgMessage {
	message_id: number;
	from?: TgUser;
	chat: TgChat;
	date: number;
	text?: string;
	caption?: string;
	photo?: TgPhotoSize[];
	document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
	reply_to_message?: { from?: TgUser };
	entities?: Array<{ type: string; offset: number; length: number }>;
}
interface TgUpdate {
	update_id: number;
	message?: TgMessage;
}

/** Telegram bot adapter: plain Bot API over fetch, no dependencies. */
export class TelegramAdapter implements ChatAdapter {
	readonly platform = "telegram" as const;
	botName = "telegram-bot";
	private readonly apiBase: string;
	private handler: ((msg: Incoming) => Promise<void>) | null = null;
	private running = false;
	private offset = 0;
	private aborts = new Set<AbortController>();
	private readonly typingTimers = new Map<string, ReturnType<typeof setInterval>>();
	private readonly lastUnauthorizedNotice = new Map<string, number>();

	constructor(
		private readonly token: string,
		private readonly opts: {
			allowedUsers: string[];
			/** Resume offset from persistent state so restarts don't replay old updates. */
			initialOffset?: number;
			onOffset?: (offset: number) => void;
			/** Called for unauthorized DMs (after the built-in cooldown) if the gateway wants extra logging. */
		},
	) {
		this.apiBase = `https://api.telegram.org/bot${token}`;
		if (opts.initialOffset) this.offset = opts.initialOffset;
	}

	onMessage(handler: (msg: Incoming) => Promise<void>): void {
		this.handler = handler;
	}

	async start(): Promise<void> {
		const me = await this.api<{ id: number; username?: string; first_name?: string }>("getMe");
		this.botUserId = me.id;
		this.botName = me.username ? `@${me.username}` : (me.first_name ?? "telegram-bot");
		this.running = true;
		log(`polling as ${this.botName}`);
		void this.pollLoop();
	}

	async stop(): Promise<void> {
		this.running = false;
		for (const a of this.aborts) a.abort();
		this.aborts.clear();
		for (const timer of this.typingTimers.values()) clearInterval(timer);
		this.typingTimers.clear();
	}

	private async api<T>(method: string, params?: Record<string, unknown>, timeoutMs = 30_000): Promise<T> {
		const ac = new AbortController();
		this.aborts.add(ac);
		const timeout = setTimeout(() => ac.abort(), timeoutMs);
		timeout.unref?.();
		try {
			const res = await fetch(`${this.apiBase}/${method}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(params ?? {}),
				signal: ac.signal,
			}).catch((err) => {
				if (!this.running) throw new StopError();
				throw err;
			});
			if (!res.ok && res.status === 409) {
				throw new Error("Telegram API returned 409 Conflict - another getUpdates consumer is running for this token.");
			}
			const body = (await res.json()) as { ok: boolean; result?: T; description?: string; parameters?: { retry_after?: number } };
			if (!body.ok) {
				const err = new Error(`Telegram ${method} failed: ${body.description ?? res.status}`);
				(err as Error & { retryAfter?: number }).retryAfter = body.parameters?.retry_after;
				throw err;
			}
			return body.result as T;
		} finally {
			clearTimeout(timeout);
			this.aborts.delete(ac);
		}
	}

	private async pollLoop(): Promise<void> {
		while (this.running) {
			let updates: TgUpdate[];
			try {
				updates = await this.api<TgUpdate[]>(
					"getUpdates",
					{ offset: this.offset, timeout: 25, allowed_updates: ["message"] },
					35_000,
				);
			} catch (err) {
				if (!this.running || err instanceof StopError) break;
				if (err instanceof Error && err.message.includes("409")) {
					log("fatal:", err.message);
					this.running = false;
					break;
				}
				const retryAfter = (err as Error & { retryAfter?: number }).retryAfter;
				log("getUpdates error:", err instanceof Error ? err.message : err);
				await sleep((retryAfter ? retryAfter * 1000 : 3_000));
				continue;
			}
			for (const update of updates) {
				this.offset = update.update_id + 1;
				this.opts.onOffset?.(this.offset);
				try {
					await this.handleUpdate(update);
				} catch (err) {
					log("update handling failed:", err);
				}
			}
		}
	}

	private async handleUpdate(update: TgUpdate): Promise<void> {
		const message = update.message;
		if (!message) return;
		const from = message.from;
		if (!from || from.is_bot) return;

		const text = (message.text ?? message.caption ?? "").trim();
		const isDM = message.chat.type === "private";
		const mentioned = Boolean(this.botName !== "telegram-bot" && text.includes(this.botName));
		const replyToBot = message.reply_to_message?.from?.id === (this.botUserId ?? -1);
		const images = await this.collectImages(message);

		let command: string | undefined;
		let args: string | undefined;
		const firstEntity = message.entities?.[0];
		if (text.startsWith("/") && firstEntity?.type === "bot_command" && firstEntity.offset === 0) {
			const parsed = parseCommandWord(text);
			if (parsed) {
				command = parsed.command.toLowerCase();
				args = parsed.args;
			}
		}

		// Group chats: only react to commands, mentions, replies to the bot.
		if (!isDM && !command && !mentioned && !replyToBot) return;
		if (!text && images.length === 0) return;

		const stripped = stripMention(text, this.botName);
		const msg: Incoming = {
			platform: "telegram",
			chatId: String(message.chat.id),
			userId: String(from.id),
			userName: from.username ? `@${from.username}` : (from.first_name ?? String(from.id)),
			text: stripped,
			images,
			isCommand: command !== undefined,
			command,
			args,
			isDM,
		};

		if (!this.opts.allowedUsers.map(String).includes(String(from.id))) {
			if (isDM && text) this.maybeNoticeUnauthorized(message.chat.id, msg);
			return;
		}
		if (!this.handler) return;
		await this.handler(msg);
	}

	private botUserId: number | undefined;

	private maybeNoticeUnauthorized(chatId: number, msg: Incoming): void {
		const now = Date.now();
		const last = this.lastUnauthorizedNotice.get(String(chatId)) ?? 0;
		if (now - last < UNAUTHORIZED_NOTICE_COOLDOWN_MS) return;
		this.lastUnauthorizedNotice.set(String(chatId), now);
		void this.send(
			String(chatId),
			`⛔ Not authorized.\n\nplatform: telegram\nchat id: \`${msg.chatId}\`\nuser id: \`${msg.userId}\` (${msg.userName})\n\nThe bot owner must add this id to the allowlist in pi-cord's config.`,
		).catch(() => {});
	}

	private async collectImages(message: TgMessage): Promise<ImageAttachment[]> {
		const out: ImageAttachment[] = [];
		try {
			if (message.photo?.length) {
				// photos come smallest-first; take the largest under the cap
				const candidates = [...message.photo].reverse();
				for (const p of candidates) {
					if (out.length >= MAX_IMAGES) break;
					if (p.file_size && p.file_size > MAX_IMAGE_BYTES) continue;
					const att = await this.downloadFile(p.file_id);
					if (att) out.push(att);
					break; // one photo per message is enough; largest wins
				}
			}
			if (message.document && message.document.mime_type?.startsWith("image/") && out.length < MAX_IMAGES) {
				if (!message.document.file_size || message.document.file_size <= MAX_IMAGE_BYTES) {
					const att = await this.downloadFile(message.document.file_id);
					if (att) out.push(att);
				}
			}
		} catch (err) {
			log("image download failed:", err);
		}
		return out;
	}

	private async downloadFile(fileId: string): Promise<ImageAttachment | null> {
		const info = await this.api<{ file_path?: string }>("getFile", { file_id: fileId });
		if (!info.file_path) return null;
		const res = await fetch(`https://api.telegram.org/file/bot${this.token}/${info.file_path}`);
		if (!res.ok) return null;
		const buf = Buffer.from(await res.arrayBuffer());
		if (buf.length > MAX_IMAGE_BYTES) return null;
		const mimeType = guessImageMime(info.file_path);
		return mimeType ? { data: buf, mimeType } : null;
	}

	// ---- outgoing ----------------------------------------------------------

	async send(chatId: string, text: string): Promise<string | undefined> {
		const chunks = chunkText(text, TELEGRAM_LIMIT);
		let lastId: string | undefined;
		for (const chunk of chunks) {
			lastId = await this.sendOne(chatId, chunk);
		}
		return lastId;
	}

	private async sendOne(chatId: string, text: string): Promise<string | undefined> {
		const html = mdToTelegramHtml(text);
		try {
			const res = await this.api<{ message_id: number }>("sendMessage", {
				chat_id: chatId,
				text: html,
				parse_mode: "HTML",
				link_preview_options: { is_disabled: true },
			});
			return String(res.message_id);
		} catch (err) {
			// HTML parse failures fall back to plain text
			if (err instanceof Error && err.message.includes("can't parse entities")) {
				const res = await this.api<{ message_id: number }>("sendMessage", {
					chat_id: chatId,
					text: text.slice(0, TELEGRAM_LIMIT),
					link_preview_options: { is_disabled: true },
				});
				return String(res.message_id);
			}
			log("sendMessage failed:", err);
			return undefined;
		}
	}

	async edit(chatId: string, messageId: string, text: string): Promise<boolean> {
		const html = mdToTelegramHtml(text);
		try {
			await this.api("editMessageText", {
				chat_id: chatId,
				message_id: Number(messageId),
				text: html,
				parse_mode: "HTML",
				link_preview_options: { is_disabled: true },
			});
			return true;
		} catch (err) {
			const msgText = err instanceof Error ? err.message : "";
			if (msgText.includes("message is not modified")) return true;
			try {
				await this.api("editMessageText", {
					chat_id: chatId,
					message_id: Number(messageId),
					text: text.slice(0, TELEGRAM_LIMIT),
				});
				return true;
			} catch {
				log("edit failed:", msgText);
				return false;
			}
		}
	}

	startTyping(chatId: string): () => void {
		void this.api("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
		const timer = setInterval(() => {
			void this.api("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
		}, TYPING_INTERVAL_MS);
		timer.unref?.();
		this.typingTimers.set(chatId, timer);
		return () => {
			const t = this.typingTimers.get(chatId);
			if (t) {
				clearInterval(t);
				this.typingTimers.delete(chatId);
			}
		};
	}
}

class StopError extends Error {}

function parseCommandWord(text: string): { command: string; args: string } | null {
	const m = /^\/([A-Za-z0-9_:-]+)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/.exec(text.trim());
	if (!m) return null;
	return { command: m[1] ?? "", args: (m[2] ?? "").trim() };
}

function stripMention(text: string, botName: string): string {
	if (botName === "telegram-bot") return text.trim();
	return text.replaceAll(botName, "").trim();
}

function guessImageMime(path: string): string | null {
	const ext = path.split(".").pop()?.toLowerCase();
	if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
	if (ext === "png") return "image/png";
	if (ext === "webp") return "image/webp";
	if (ext === "gif") return "image/gif";
	return null;
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}
