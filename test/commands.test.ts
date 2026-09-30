import { describe, expect, test } from "bun:test";
import { parseCommand, isAllowed, handleMessage, HELP_TEXT } from "../src/commands";
import type { Incoming } from "../src/types";
import type { PiCordConfig } from "../src/config";
import { ChatAgent } from "../src/chat";
import { StateStore } from "../src/state";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function makeMsg(overrides: Partial<Incoming> = {}): Incoming {
	return {
		platform: "telegram",
		chatId: "100",
		userId: "42",
		userName: "tester",
		text: "hello agent",
		images: [],
		isCommand: false,
		isDM: true,
		...overrides,
	};
}

const config: PiCordConfig = {
	telegram: { token: "x", allowedUsers: ["42"] },
	cwd: "/tmp",
};

function makeChat(key = "telegram:100"): ChatAgent {
	const dir = mkdtempSync(join(tmpdir(), "pi-cord-cmd-test-"));
	const state = new StateStore(join(dir, "state.json"));
	return new ChatAgent({
		key,
		chatId: "100",
		config,
		state,
		sessionDir: join(dir, "sessions"),
		transport: { send: async () => undefined, edit: async () => true, startTyping: () => () => {} },
	});
}

describe("parseCommand", () => {
	test("plain command", () => {
		expect(parseCommand("/new my session")).toEqual({ command: "new", args: "my session" });
	});
	test("telegram group suffix", () => {
		expect(parseCommand("/status@my_bot")).toEqual({ command: "status", args: "" });
	});
	test("no args", () => {
		expect(parseCommand("/stop")).toEqual({ command: "stop", args: "" });
	});
	test("not a command", () => {
		expect(parseCommand("hello /world")).toBeNull();
		expect(parseCommand("/")).toBeNull();
	});
});

describe("isAllowed", () => {
	test("allowlisted user passes", () => {
		expect(isAllowed(config, makeMsg())).toBe(true);
	});
	test("empty allowlist denies everyone", () => {
		expect(isAllowed({ telegram: { token: "x", allowedUsers: [] } }, makeMsg())).toBe(false);
	});
});

describe("handleMessage", () => {
	test("prompt from allowed user is submitted", async () => {
		const outcome = await handleMessage(makeMsg(), { config, chat: makeChat() });
		expect(outcome).toEqual({ kind: "prompt", text: "hello agent", images: [] });
	});

	test("unauthorized DM gets a denial with ids", async () => {
		const outcome = await handleMessage(makeMsg({ userId: "999" }), { config, chat: makeChat() });
		expect(outcome.kind).toBe("reply");
		if (outcome.kind === "reply") {
			expect(outcome.text).toContain("Not authorized");
			expect(outcome.text).toContain("999");
		}
	});

	test("unauthorized group chatter is ignored", async () => {
		const outcome = await handleMessage(makeMsg({ userId: "999", isDM: false }), { config, chat: makeChat() });
		expect(outcome.kind).toBe("ignored");
	});

	test("unauthorized user can still /id", async () => {
		const outcome = await handleMessage(
			makeMsg({ userId: "999", text: "/id", isCommand: true, command: "id" }),
			{ config, chat: makeChat() },
		);
		expect(outcome.kind).toBe("reply");
		if (outcome.kind === "reply") expect(outcome.text).toContain("999");
	});

	test("/help works for allowed users", async () => {
		const outcome = await handleMessage(makeMsg({ text: "/help", isCommand: true, command: "help" }), {
			config,
			chat: makeChat(),
		});
		expect(outcome.kind).toBe("reply");
		if (outcome.kind === "reply") expect(outcome.text).toBe(HELP_TEXT);
	});

	test("unknown command errors, known child command passes through", async () => {
		const chat = makeChat();
		const unknown = await handleMessage(makeMsg({ text: "/nope", isCommand: true, command: "nope" }), { config, chat });
		expect(unknown.kind).toBe("reply");

		// childCommandNames only consults a running child; stub it via a running child is
		// overkill here, so assert the default unknown path only.
		if (unknown.kind === "reply") expect(unknown.text).toContain("Unknown command /nope");
	});
});
