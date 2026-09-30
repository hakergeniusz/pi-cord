import type { ChatAdapter, ImageAttachment, Incoming } from "./types";
import { DISCORD_LIMIT, chunkText } from "./format";
import { createLogger } from "./util";

const log = createLogger("discord");

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_IMAGES = 4;
const TYPING_INTERVAL_MS = 8_000;

/** Discord adapter. Requires the MESSAGE CONTENT privileged intent. */
export class DiscordAdapter implements ChatAdapter {
	readonly platform = "discord" as const;
	botName = "discord-bot";
	private client: import("discord.js").Client | null = null;
	private handler: ((msg: Incoming) => Promise<void>) | null = null;
	private botUserId = "";
	private readonly typingTimers = new Map<string, ReturnType<typeof setInterval>>();

	constructor(
		private readonly token: string,
		private readonly opts: { allowedUsers: string[] },
	) {}

	onMessage(handler: (msg: Incoming) => Promise<void>): void {
		this.handler = handler;
	}

	async start(): Promise<void> {
		const discord = await import("discord.js");
		const client = new discord.Client({
			intents: [
				discord.GatewayIntentBits.Guilds,
				discord.GatewayIntentBits.GuildMessages,
				discord.GatewayIntentBits.DirectMessages,
				discord.GatewayIntentBits.MessageContent,
			],
			partials: [discord.Partials.Channel],
		});
		this.client = client;

		client.on(discord.Events.MessageCreate, (message) => {
			void this.handleMessage(message).catch((err) => log("message handling failed:", err));
		});

		await new Promise<void>((resolve, reject) => {
			const onReady = () => {
				this.botUserId = client.user?.id ?? "";
				this.botName = client.user?.tag ?? "discord-bot";
				log(`connected as ${this.botName}`);
				resolve();
			};
			client.once(discord.Events.ClientReady, onReady);
			client.login(this.token).catch(reject);
		});
	}

	async stop(): Promise<void> {
		for (const timer of this.typingTimers.values()) clearInterval(timer);
		this.typingTimers.clear();
		await this.client?.destroy();
		this.client = null;
	}

	private async handleMessage(message: import("discord.js").Message): Promise<void> {
		const client = this.client;
		if (!client?.user) return;
		if (message.author.bot) return;
		if (message.author.id === this.botUserId) return;

		const isDM = !message.guild;
		const mentioned = message.mentions.users.has(this.botUserId);
		// Threads the bot created (its own "workspace" threads) are always followed.
		let ownThread = false;
		if (message.channel.isThread()) {
			const ownerId = (message.channel as { ownerId?: string | null }).ownerId;
			ownThread = ownerId === this.botUserId;
		}
		if (!isDM && !mentioned && !ownThread) return;

		let text = message.content ?? "";
		text = text.replaceAll(`<@${this.botUserId}>`, "").replaceAll(`<@!${this.botUserId}>`, "").trim();
		const images = await collectAttachments(message);

		let command: string | undefined;
		let args: string | undefined;
		const parsed = parseCommand(text);
		if (parsed) {
			command = parsed.command.toLowerCase();
			args = parsed.args;
		}

		if (!isDM && !command && !text) return;
		if (!text && images.length === 0) return;

		const msg: Incoming = {
			platform: "discord",
			chatId: message.channelId,
			userId: message.author.id,
			userName: message.author.displayName ?? message.author.username,
			text,
			images,
			isCommand: command !== undefined,
			command,
			args,
			isDM,
		};

		if (!this.opts.allowedUsers.map(String).includes(String(message.author.id))) {
			if (isDM && text && command) {
				await this.send(
					message.channelId,
					`⛔ Not authorized.\n\nplatform: discord\nchat id: \`${msg.chatId}\`\nuser id: \`${msg.userId}\` (${msg.userName})\n\nThe bot owner must add this id to the allowlist in pi-cord's config.`,
				).catch(() => {});
			}
			return;
		}
		if (!this.handler) return;
		await this.handler(msg);
	}

	// ---- outgoing ----------------------------------------------------------

	async send(chatId: string, text: string): Promise<string | undefined> {
		const channel = await this.fetchChannel(chatId);
		if (!channel?.isSendable()) return undefined;
		const chunks = chunkText(text, DISCORD_LIMIT);
		let lastId: string | undefined;
		for (const chunk of chunks) {
			const sent = await channel.send(chunk);
			lastId = sent.id;
		}
		return lastId;
	}

	async edit(chatId: string, messageId: string, text: string): Promise<boolean> {
		try {
			const channel = await this.fetchChannel(chatId);
			if (!channel || !("messages" in channel)) return false;
			const msg = await channel.messages.fetch(messageId);
			const chunks = chunkText(text, DISCORD_LIMIT);
			await msg.edit(chunks[0] ?? "");
			// extra chunks (rare on edit) go out as follow-up messages
			for (const chunk of chunks.slice(1)) {
				await channel.send(chunk);
			}
			return true;
		} catch (err) {
			log("edit failed:", err instanceof Error ? err.message : err);
			return false;
		}
	}

	startTyping(chatId: string): () => void {
		void this.triggerTyping(chatId);
		const timer = setInterval(() => void this.triggerTyping(chatId), TYPING_INTERVAL_MS);
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

	private async triggerTyping(chatId: string): Promise<void> {
		try {
			const channel = await this.fetchChannel(chatId);
			if (channel && channel.isSendable() && "sendTyping" in channel) await channel.sendTyping();
		} catch {
			/* ignore */
		}
	}

	private async fetchChannel(
		chatId: string,
	): Promise<import("discord.js").TextChannel | import("discord.js").DMChannel | import("discord.js").ThreadChannel | null> {
		if (!this.client) return null;
		try {
			const ch = await this.client.channels.fetch(chatId);
			if (!ch) return null;
			if (ch.isTextBased() && "send" in ch) return ch as import("discord.js").TextChannel;
			return null;
		} catch (err) {
			log("channel fetch failed:", err instanceof Error ? err.message : err);
			return null;
		}
	}
}

function parseCommand(text: string): { command: string; args: string } | null {
	const trimmed = text.trim();
	if (!trimmed.startsWith("/")) return null;
	const m = /^\/([A-Za-z0-9_:-]+)(?:\s+([\s\S]*))?$/.exec(trimmed);
	if (!m) return null;
	return { command: m[1] ?? "", args: (m[2] ?? "").trim() };
}

async function collectAttachments(message: import("discord.js").Message): Promise<ImageAttachment[]> {
	const out: ImageAttachment[] = [];
	for (const att of message.attachments.values()) {
		if (out.length >= MAX_IMAGES) break;
		if (!att.contentType?.startsWith("image/")) continue;
		if (att.size > MAX_IMAGE_BYTES) continue;
		try {
			const res = await fetch(att.url);
			if (!res.ok) continue;
			const data = Buffer.from(await res.arrayBuffer());
			out.push({ data, mimeType: att.contentType });
		} catch (err) {
			log("attachment download failed:", err instanceof Error ? err.message : err);
		}
	}
	return out;
}
