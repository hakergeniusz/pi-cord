import type { ChatAdapter, DialogAnswer, DialogRequest, ImageAttachment, Incoming } from "./types";
import type { ActionRowBuilder, ButtonBuilder, StringSelectMenuBuilder } from "discord.js";
import { DISCORD_LIMIT, chunkText } from "./format";
import { createLogger } from "./util";

const log = createLogger("discord");

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_IMAGES = 4;
const TYPING_INTERVAL_MS = 8_000;
const DIALOG_PREFIX = "pc-";

interface PendingDialog {
	rpcId: string;
	chatId: string;
	kind: "select" | "confirm" | "input" | "editor";
	options?: string[];
	questionMessageId?: string;
	resolve: (answer: DialogAnswer) => void;
	originalText: string;
}

/** Discord adapter. Requires the MESSAGE CONTENT privileged intent. */
export class DiscordAdapter implements ChatAdapter {
	readonly platform = "discord" as const;
	botName = "discord-bot";
	private client: import("discord.js").Client | null = null;
	private handler: ((msg: Incoming) => Promise<void>) | null = null;
	private botUserId = "";
	private readonly typingTimers = new Map<string, ReturnType<typeof setInterval>>();
	private readonly pendingDialogs = new Map<string, PendingDialog>(); // localId -> pending
	private dialogSeq = 0;

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
		client.on(discord.Events.InteractionCreate, (interaction) => {
			void this.handleInteraction(interaction).catch((err) => log("interaction handling failed:", err));
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
		for (const pending of this.pendingDialogs.values()) pending.resolve({ cancelled: true });
		this.pendingDialogs.clear();
		await this.client?.destroy();
		this.client = null;
	}

	// ---- interactive dialogs -------------------------------------------------

	/** Present a dialog in the channel: select menus / buttons, or reply-to prompts for free text. */
	async ask(chatId: string, req: DialogRequest): Promise<DialogAnswer> {
		const localId = `${++this.dialogSeq}`;
		const body = this.dialogBody(req);
		return new Promise<DialogAnswer>((resolve) => {
			const pending: PendingDialog = {
				rpcId: req.id,
				chatId,
				kind: req.method,
				options: req.options,
				resolve,
				originalText: body,
			};
			this.pendingDialogs.set(localId, pending);
			void this.sendDialogMessage(chatId, localId, req, body)
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

	private async sendDialogMessage(chatId: string, localId: string, req: DialogRequest, body: string): Promise<string | undefined> {
		const discord = await import("discord.js");
		const channel = await this.fetchChannel(chatId);
		if (!channel?.isSendable()) return undefined;

		if (req.method === "select" && req.options?.length) {
			const menu = new discord.StringSelectMenuBuilder()
				.setCustomId(`${DIALOG_PREFIX}${localId}`)
				.setPlaceholder((req.title ?? "Choose").slice(0, 100))
				.addOptions(
					req.options.slice(0, 25).map((opt, i) => ({
						label: (opt.slice(0, 100) || `option ${i + 1}`) as string,
						value: String(i),
					})),
				);
			const row = new discord.ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
			const sent = await channel.send({ content: body.slice(0, 2000), components: [row] });
			return sent.id;
		}
		if (req.method === "confirm") {
			const row = new discord.ActionRowBuilder<ButtonBuilder>().addComponents(
				new discord.ButtonBuilder().setCustomId(`${DIALOG_PREFIX}${localId}-yes`).setLabel("Yes").setStyle(discord.ButtonStyle.Success),
				new discord.ButtonBuilder().setCustomId(`${DIALOG_PREFIX}${localId}-no`).setLabel("No").setStyle(discord.ButtonStyle.Danger),
			);
			const sent = await channel.send({ content: body.slice(0, 2000), components: [row] });
			return sent.id;
		}
		const sent = await channel.send(body.slice(0, 2000));
		return sent.id;
	}

	private isAllowedUser(userId: string): boolean {
		return this.opts.allowedUsers.map(String).includes(String(userId));
	}

	private async handleInteraction(interaction: import("discord.js").Interaction): Promise<void> {
		if (!interaction.isMessageComponent()) return;
		const customId = interaction.customId;
		if (!customId.startsWith(DIALOG_PREFIX)) return;
		if (!this.isAllowedUser(interaction.user.id)) {
			await interaction.reply({ content: "⛔ Not authorized", ephemeral: true }).catch(() => {});
			return;
		}

		let localId = customId.slice(DIALOG_PREFIX.length);
		let answer: DialogAnswer;
		let note: string;
		if (interaction.isStringSelectMenu()) {
			localId = customId.slice(DIALOG_PREFIX.length);
			const idx = Number.parseInt(interaction.values[0] ?? "", 10);
			const pending = this.pendingDialogs.get(localId);
			const value = pending?.options?.[idx];
			if (value === undefined) {
				await interaction.reply({ content: "Invalid option", ephemeral: true }).catch(() => {});
				return;
			}
			answer = { value };
			note = `👉 ${value}`;
		} else if (interaction.isButton()) {
			const yes = customId.endsWith("-yes");
			localId = customId.slice(DIALOG_PREFIX.length, yes ? -4 : -3);
			answer = { confirmed: yes };
			note = yes ? "👉 Yes" : "👉 No";
		} else {
			return;
		}

		const pending = this.pendingDialogs.get(localId);
		if (!pending) {
			await interaction.reply({ content: "This question is no longer active.", ephemeral: true }).catch(() => {});
			return;
		}
		this.pendingDialogs.delete(localId);
		await interaction
			.update({ content: `${pending.originalText.slice(0, 1900)}\n\n${note}`.slice(0, 2000), components: [] })
			.catch(() => {});
		pending.resolve(answer);
	}

	/** Resolve pending input/editor dialogs when a user replies to the question message. Returns true when consumed. */
	private tryResolveInputReply(message: import("discord.js").Message): boolean {
		const referenceId = message.reference?.messageId;
		if (!referenceId) return false;
		for (const [localId, pending] of this.pendingDialogs) {
			if (
				(pending.kind === "input" || pending.kind === "editor") &&
				pending.questionMessageId === referenceId &&
				pending.chatId === message.channelId
			) {
				this.pendingDialogs.delete(localId);
				const text = (message.content ?? "").trim();
				void this.edit(pending.chatId, referenceId, `${pending.originalText}\n\n👉 ${text.slice(0, 200)}`).catch(() => {});
				pending.resolve(text ? { value: text } : { cancelled: true });
				return true;
			}
		}
		return false;
	}

	private async handleMessage(message: import("discord.js").Message): Promise<void> {
		const client = this.client;
		if (!client?.user) return;
		if (message.author.bot) return;
		if (message.author.id === this.botUserId) return;

		// A reply that answers a pending dialog question is consumed here and
		// never reaches the gateway as a new prompt.
		if (this.tryResolveInputReply(message)) return;

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

		if (!this.isAllowedUser(String(message.author.id))) {
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

