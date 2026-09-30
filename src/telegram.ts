import type { ChatAdapter, DialogAnswer, DialogRequest, DispatchOpts, DispatchResult, ImageAttachment, Incoming } from "./types";
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
	reply_to_message?: { from?: TgUser; message_id?: number };
	entities?: Array<{ type: string; offset: number; length: number }>;
}
interface TgUpdate {
	update_id: number;
	message?: TgMessage;
	callback_query?: {
		id: string;
		from: TgUser;
		message?: TgMessage;
		data?: string;
	};
}

interface PendingDialog {
	rpcId: string;
	chatId: string;
	kind: "select" | "confirm" | "input" | "editor";
	options?: string[];
	/** Message that asked the question; edited on resolution, matched for input replies. */
	questionMessageId?: number;
	resolve: (answer: DialogAnswer) => void;
	originalText: string;
}

/** Telegram bot adapter: plain Bot API over fetch, no dependencies. */
export class TelegramAdapter implements ChatAdapter {
	readonly platform = "telegram" as const;
	botName = "telegram-bot";
	private readonly apiBase: string;
	private handler: ((msg: Incoming, opts?: DispatchOpts) => Promise<DispatchResult | undefined>) | null = null;
	private running = false;
	private offset = 0;
	private aborts = new Set<AbortController>();
	private readonly typingTimers = new Map<string, ReturnType<typeof setInterval>>();
	private readonly lastUnauthorizedNotice = new Map<string, number>();
	private readonly pendingDialogs = new Map<string, PendingDialog>(); // localId -> pending
	private dialogSeq = 0;
	private botUserId: number | undefined;

	constructor(
		private readonly token: string,
		private readonly opts: {
			allowedUsers: string[];
			/** Resume offset from persistent state so restarts don't replay old updates. */
			initialOffset?: number;
			onOffset?: (offset: number) => void;
		},
	) {
		this.apiBase = `https://api.telegram.org/bot${token}`;
		if (opts.initialOffset) this.offset = opts.initialOffset;
	}

	onMessage(handler: (msg: Incoming, opts?: DispatchOpts) => Promise<DispatchResult | undefined>): void {
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
		for (const pending of this.pendingDialogs.values()) pending.resolve({ cancelled: true });
		this.pendingDialogs.clear();
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
					{ offset: this.offset, timeout: 25, allowed_updates: ["message", "callback_query"] },
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
				await sleep(retryAfter ? retryAfter * 1000 : 3_000);
				continue;
			}
			for (const update of updates) {
				this.offset = update.update_id + 1;
				this.opts.onOffset?.(this.offset);
				try {
					if (update.callback_query) await this.handleCallback(update.callback_query);
					else if (update.message) await this.handleUpdate(update.message);
				} catch (err) {
					log("update handling failed:", err);
				}
			}
		}
	}

	// ---- interactive dialogs -------------------------------------------------

	/** Present a dialog in the chat; resolves via inline-keyboard taps or replies to the question message. */
	async ask(chatId: string, req: DialogRequest): Promise<DialogAnswer> {
		const localId = `d${++this.dialogSeq}`;
		return new Promise<DialogAnswer>((resolve) => {
			const pending: PendingDialog = {
				rpcId: req.id,
				chatId,
				kind: req.method,
				options: req.options,
				resolve,
				originalText: "",
			};
			this.pendingDialogs.set(localId, pending);
			void this.renderDialog(chatId, localId, req)
				.then((messageId) => {
					pending.questionMessageId = messageId;
				})
				.catch((err) => {
					log("dialog render failed:", err);
					if (this.pendingDialogs.delete(localId)) resolve({ cancelled: true });
				});
		});
	}

	private dialogBody(req: DialogRequest): string {
		const lines = [req.title ?? "Agent needs your input"];
		if (req.message) lines.push(req.message);
		if (req.method === "input" || req.method === "editor") {
			if (req.placeholder) lines.push(`(${req.placeholder})`);
			if (req.prefill) lines.push(`(prefill: ${req.prefill.slice(0, 200)})`);
			lines.push("↩️ Reply to this message with your answer.");
		}
		return lines.join("\n");
	}

	private async renderDialog(chatId: string, localId: string, req: DialogRequest): Promise<number | undefined> {
		const pending = this.pendingDialogs.get(localId);
		const body = this.dialogBody(req);
		if (pending) pending.originalText = body;

		if (req.method === "select" && req.options?.length) {
			const keyboard = req.options.slice(0, 25).map((opt, i) => [
				{ text: opt.slice(0, 60), callback_data: `pc|${localId}|o${i}` },
			]);
			const res = await this.api<{ message_id: number }>("sendMessage", {
				chat_id: chatId,
				text: body,
				reply_markup: { inline_keyboard: keyboard },
			});
			return res.message_id;
		}
		if (req.method === "confirm") {
			const keyboard = [
				[
					{ text: "✅ Yes", callback_data: `pc|${localId}|yes` },
					{ text: "❌ No", callback_data: `pc|${localId}|no` },
				],
			];
			const res = await this.api<{ message_id: number }>("sendMessage", {
				chat_id: chatId,
				text: body,
				reply_markup: { inline_keyboard: keyboard },
			});
			return res.message_id;
		}
		// input / editor: ForceReply so the answer quotes the question
		const res = await this.api<{ message_id: number }>("sendMessage", {
			chat_id: chatId,
			text: body,
			reply_markup: { force_reply: true, input_field_placeholder: (req.placeholder ?? "your answer").slice(0, 64) },
		});
		return res.message_id;
	}

	private isAllowedUser(userId: string): boolean {
		return this.opts.allowedUsers.map(String).includes(String(userId));
	}

	private async handleCallback(query: NonNullable<TgUpdate["callback_query"]>): Promise<void> {
		const data = query.data ?? "";
		const [tag, localId, payload] = data.split("|");
		if (tag !== "pc" || !localId) {
			await this.api("answerCallbackQuery", { callback_query_id: query.id }).catch(() => {});
			return;
		}
		const pending = this.pendingDialogs.get(localId);
		if (!pending || !query.message) {
			await this.api("answerCallbackQuery", { callback_query_id: query.id, text: "This question is no longer active." }).catch(() => {});
			return;
		}
		if (!this.isAllowedUser(String(query.from.id))) {
			await this.api("answerCallbackQuery", { callback_query_id: query.id, text: "⛔ Not authorized" }).catch(() => {});
			return;
		}

		let answer: DialogAnswer;
		let note: string;
		if (pending.kind === "select") {
			const idx = Number.parseInt((payload ?? "").replace(/^o/, ""), 10);
			const value = pending.options?.[idx];
			if (value === undefined) {
				await this.api("answerCallbackQuery", { callback_query_id: query.id, text: "Invalid option" }).catch(() => {});
				return;
			}
			answer = { value };
			note = `👉 ${value}`;
		} else {
			answer = { confirmed: payload === "yes" };
			note = payload === "yes" ? "👉 Yes" : "👉 No";
		}

		this.pendingDialogs.delete(localId);
		await this.api("answerCallbackQuery", { callback_query_id: query.id }).catch(() => {});
		await this.api("editMessageText", {
			chat_id: pending.chatId,
			message_id: pending.questionMessageId,
			text: `${pending.originalText}\n\n${note}`,
		}).catch(() => {});
		pending.resolve(answer);
	}

	/** Resolve a pending input/editor dialog when the user replies to the question message. Returns true when consumed. */
	private tryResolveInputReply(message: TgMessage): boolean {
		const repliedTo = message.reply_to_message?.message_id;
		if (!repliedTo) return false;
		for (const [localId, pending] of this.pendingDialogs) {
			if ((pending.kind === "input" || pending.kind === "editor") && pending.questionMessageId === repliedTo && pending.chatId === String(message.chat.id)) {
				this.pendingDialogs.delete(localId);
				const text = (message.text ?? "").trim();
				void this.api("editMessageText", {
					chat_id: pending.chatId,
					message_id: repliedTo,
					text: `${pending.originalText}\n\n👉 ${text.slice(0, 200)}`,
				}).catch(() => {});
				pending.resolve(text ? { value: text } : { cancelled: true });
				return true;
			}
		}
		return false;
	}

	// ---- inbound messages ------------------------------------------------

	private async handleUpdate(message: TgMessage): Promise<void> {
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

		// A reply that answers a pending dialog question is consumed here and
		// never reaches the gateway as a new prompt.
		if (this.tryResolveInputReply(message)) return;

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
			messageId: String(message.message_id),
		};

		if (!this.isAllowedUser(String(from.id))) {
			if (isDM && text) this.maybeNoticeUnauthorized(message.chat.id, msg);
			return;
		}
		if (!this.handler) return;
		await this.handler(msg);
	}

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
				// photos come smallest-first; the largest under the cap wins
				const candidates = [...message.photo].reverse();
				for (const p of candidates) {
					if (p.file_size && p.file_size > MAX_IMAGE_BYTES) continue;
					const att = await this.downloadFile(p.file_id);
					if (att) out.push(att);
					break;
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

	/** Best-effort delete; works for the bot's own messages and (in private chats) the user's. */
	async delete(chatId: string, messageId: string): Promise<boolean> {
		try {
			await this.api("deleteMessage", { chat_id: chatId, message_id: Number(messageId) });
			return true;
		} catch {
			return false;
		}
	}

	/** Publish the native command menu (the client's "/" command list). */
	async registerCommands(commands: import("./types").SlashCommandInfo[]): Promise<void> {
		const seen = new Set<string>();
		const menu = commands
			.filter((c) => /^[a-z0-9_]{1,32}$/.test(c.name) && !seen.has(c.name) && seen.add(c.name))
			.map((c) => ({ command: c.name, description: (c.description ?? "Pi command").slice(0, 256) }));
		if (!menu.length) return;
		try {
			await this.api("setMyCommands", { commands: menu });
			log(`command menu published (${menu.length} commands)`);
		} catch (err) {
			log("setMyCommands failed:", err instanceof Error ? err.message : err);
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
