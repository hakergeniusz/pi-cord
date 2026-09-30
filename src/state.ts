import { readJson, writeJson } from "./util";

export interface ChatState {
	/** Absolute path of the pi session file this chat is currently on. */
	sessionFile?: string;
	/** Per-chat working directory override. */
	cwd?: string;
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
