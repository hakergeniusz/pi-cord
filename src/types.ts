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
	/** Begin periodic typing indicators; returned fn stops them. */
	startTyping(chatId: string): () => void;
	/**
	 * Present an interactive dialog in the chat and wait for the user's answer.
	 * Implementations must resolve (never hang): with the user's answer, or
	 * {cancelled: true} on timeout/teardown.
	 */
	ask(chatId: string, req: DialogRequest): Promise<DialogAnswer>;
	onMessage(handler: (msg: Incoming) => Promise<void>): void;
}
