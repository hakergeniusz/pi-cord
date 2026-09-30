import { readJson, writeJson } from "./util";

export interface ChatState {
	/** Absolute path of the pi session file this chat is currently on. */
	sessionFile?: string;
	/** Per-chat working directory override. */
	cwd?: string;
	/** Hashes of info-level notifications already delivered to this chat (dedupe). */
	seenNotifies?: string[];
	/** Bot messages shown for the most recent turns (newest last) for UI pruning. */
	uiTurns?: UiTurn[];
}

/** One visible exchange: the user's message(s) plus the bot's messages. */
export interface UiTurn {
	/** Incoming message ids of this turn (empty when the platform entry isn't deletable). */
	userMessageIds: string[];
	/** Message ids the bot posted for this turn (status/final/chunks/acks). */
	messageIds: string[];
}

export interface PiCordState {
	version: 1;
	/** Telegram getUpdates offset, so restarts don't replay old messages. */
	telegramOffset?: number;
	chats: Record<string, ChatState>;
}

export const EMPTY_STATE: PiCordState = { version: 1, chats: {} };

export class StateStore {
	private state: PiCordState = structuredClone(EMPTY_STATE);
	private saveTimer: ReturnType<typeof setTimeout> | null = null;
	private readonly log: (msg: string) => void;

	constructor(readonly path: string, log: (msg: string) => void = () => {}) {
		this.log = log;
		const loaded = readJson<PiCordState>(path);
		if (loaded && loaded.version === 1 && typeof loaded.chats === "object") {
			this.state = { ...structuredClone(EMPTY_STATE), ...loaded, chats: loaded.chats };
		}
	}

	get telegramOffset(): number | undefined {
		return this.state.telegramOffset;
	}

	setTelegramOffset(offset: number): void {
		this.state.telegramOffset = offset;
		this.scheduleSave();
	}

	chat(key: string): ChatState {
		let c = this.state.chats[key];
		if (!c) {
			c = {};
			this.state.chats[key] = c;
		}
		return c;
	}

	setSessionFile(key: string, sessionFile: string): void {
		this.chat(key).sessionFile = sessionFile;
		this.scheduleSave();
	}

	setChatCwd(key: string, cwd: string): void {
		this.chat(key).cwd = cwd;
		this.scheduleSave();
	}

	/** Record an info notify as delivered; returns true when that text was already sent to this chat. */
	hasSeenNotify(key: string, hash: string): boolean {
		const c = this.chat(key);
		const seen = c.seenNotifies ?? (c.seenNotifies = []);
		if (seen.includes(hash)) return true;
		seen.push(hash);
		if (seen.length > 100) seen.splice(0, seen.length - 100);
		this.scheduleSave();
		return false;
	}

	/** Replace the visible-turn window of a chat. */
	setUiTurns(key: string, turns: UiTurn[]): void {
		this.chat(key).uiTurns = turns;
		this.scheduleSave();
	}

	/** Visible-turn window of a chat (empty when none recorded yet). */
	getUiTurns(key: string): UiTurn[] {
		return this.chat(key).uiTurns ?? [];
	}

	flush(): void {
		if (this.saveTimer) {
			clearTimeout(this.saveTimer);
			this.saveTimer = null;
		}
		writeJson(this.path, this.state, (err) => this.log(`failed to save state: ${err}`));
	}

	scheduleSave(): void {
		if (this.saveTimer) return;
		this.saveTimer = setTimeout(() => {
			this.saveTimer = null;
			this.flush();
		}, 500);
		this.saveTimer.unref?.();
	}
}
