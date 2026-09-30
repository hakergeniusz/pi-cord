import type { Platform } from "./util";

/** An image attached to an incoming chat message, ready to base64 into a pi prompt. */
export interface ImageAttachment {
	data: Buffer;
	mimeType: string;
}

/** A pi extension dialog (ctx.ui.select/confirm/input/editor) forwarded from a chat session. */
export interface DialogRequest {
	/** Unique request id from the RPC extension-UI protocol. */
	id: string;
	method: "select" | "confirm" | "input" | "editor";
	title?: string;
	message?: string;
	/** select only. */
	options?: string[];
	placeholder?: string;
	/** editor only. */
	prefill?: string;
	/** Agent-side timeout in ms, if the extension declared one. */
	timeoutMs?: number;
}

/** What the chat user answered. Exactly one style applies per method. */
export interface DialogAnswer {
	/** select / input / editor */
	value?: string;
	/** confirm */
	confirmed?: boolean;
	cancelled?: boolean;
}

/** Normalized message from either platform. */
export interface Incoming {
	platform: Platform;
	/** Platform chat id as string (Discord channel id / Telegram chat id). */
	chatId: string;
	userId: string;
	userName: string;
	text: string;
	images: ImageAttachment[];
	/** True when the text is a slash command for the gateway. */
	isCommand: boolean;
	/** Command name without "/" and without the Telegram "@BotName" suffix. */
	command?: string;
	/** Everything after the command word. */
	args?: string;
	isDM: boolean;
	/** Platform message id of the incoming text (used for UI history pruning). */
	messageId?: string;
}

/** A command offered in the platform's native command menu (Telegram menu / Discord slash). */
export interface SlashCommandInfo {
	/** Command name without the leading slash (lowercase). */
	name: string;
	/** One-line human description. */
	description?: string;
	/** Where the command lives: gateway built-in or child session resource. */
	source: "gateway" | "extension" | "prompt" | "skill";
}

/** Reply override for one dispatch: used by Discord interactions to answer in place. */
export interface DispatchOpts {
	/**
	 * Deliver a command reply through this sink (e.g. an interaction editReply)
	 * instead of a plain channel message. Returns the delivered message id when
	 * the platform exposes one.
	 */
	replySink?: (text: string) => Promise<string | undefined>;
}

/** Minimal shape the adapters see back from a dispatch (for interaction acks). */
export interface DispatchResult {
	kind: "reply" | "prompt" | "ignored";
}

/** Delivery surface the gateway uses; implemented by Telegram, Discord and test adapters. */
export interface ChatAdapter {
	readonly platform: Platform;
	/** Bot display name, available after start(). */
	readonly botName: string;
	start(): Promise<void>;
	stop(): Promise<void>;
	/** Send text; returns the platform message id so it can be edited later. */
	send(chatId: string, text: string): Promise<string | undefined>;
	edit(chatId: string, messageId: string, text: string): Promise<boolean>;
	/** Delete a message (UI history pruning). Best effort; false when not possible. */
	delete?(chatId: string, messageId: string): Promise<boolean>;
	/** Publish the native command menu (Telegram command list / Discord slash commands). */
	registerCommands?(commands: SlashCommandInfo[]): Promise<void>;
	/** Begin periodic typing indicators; returned fn stops them. */
	startTyping(chatId: string): () => void;
	/**
	 * Present an interactive dialog in the chat and wait for the user's answer.
	 * Implementations must resolve (never hang): with the user's answer, or
	 * {cancelled: true} on timeout/teardown.
	 */
	ask(chatId: string, req: DialogRequest): Promise<DialogAnswer>;
	onMessage(handler: (msg: Incoming, opts?: DispatchOpts) => Promise<DispatchResult | undefined>): void;
}
