import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GatewayHost } from "../src/gateway";
import type { PiCordConfig } from "../src/config";
import type { ChatAdapter, Incoming } from "../src/types";

const FAKE_PI = join(import.meta.dir, "fake-pi.mjs");

class MockAdapter {
	readonly platform = "discord" as const;
	botName = "mock-bot";
	sent: Array<{ chatId: string; text: string }> = [];
	edits: Array<{ chatId: string; messageId: string; text: string }> = [];
	private nextId = 0;
	private handler: ((msg: Incoming) => Promise<void>) | null = null;

	async start(): Promise<void> {}
	async stop(): Promise<void> {}
	onMessage(handler: (msg: Incoming) => Promise<void>): void {
		this.handler = handler;
	}
	async send(chatId: string, text: string): Promise<string> {
		this.sent.push({ chatId, text });
		return String(++this.nextId);
	}
	async edit(chatId: string, messageId: string, text: string): Promise<boolean> {
		this.edits.push({ chatId, messageId, text });
		return true;
	}
	startTyping(): () => void {
		return () => {};
	}
	async inject(msg: Partial<Incoming>): Promise<void> {
		if (!this.handler) throw new Error("no handler wired");
		const base: Incoming = {
			platform: "discord",
			chatId: "chan-1",
			userId: "user-1",
			userName: "Tester",
			text: "",
			images: [],
			isCommand: false,
			isDM: true,
			...msg,
		} as Incoming;
		// parse commands from text the way the real adapters do
		if (base.text.startsWith("/")) {
			const m = /^\/([A-Za-z0-9_:-]+)(?:\s+([\s\S]*))?$/.exec(base.text.trim());
			if (m) {
				base.isCommand = true;
				base.command = m[1];
				base.args = (m[2] ?? "").trim();
			}
		}
		await this.handler(base);
	}
	sentTo(chatId: string): string[] {
		return this.sent.filter((s) => s.chatId === chatId).map((s) => s.text);
	}
	/** All delivered texts: new messages plus edits (final answers replace the status message). */
	delivered(chatId: string): string[] {
		return [...this.sentTo(chatId), ...this.edits.filter((e) => e.chatId === chatId).map((e) => e.text)];
	}
	async lastReply(): Promise<string> {
		// wait for the run to deliver its final answer (poll the sent log)
		for (let i = 0; i < 200; i++) {
			const final = this.delivered("chan-1").find((t) => t.startsWith("Echo:"));
			if (final) return final;
			await new Promise((r) => setTimeout(r, 100));
		}
		throw new Error(`no Echo reply arrived; sent so far: ${JSON.stringify(this.delivered("chan-1"))}`);
	}
}

function makeHost(dir: string): { host: GatewayHost; adapter: MockAdapter } {
	const config: PiCordConfig = {
		piPath: FAKE_PI,
		cwd: join(dir, "workspace"),
		progressUpdates: true,
		discord: { token: "unused-by-mock", allowedUsers: ["user-1"] },
	};
	const host = new GatewayHost(config, join(dir, "config.json"), join(dir, "state.json"));
	const adapter = new MockAdapter();
	return { host, adapter };
}

function freshDir(): string {
	return mkdtempSync(join(tmpdir(), "pi-cord-e2e-"));
}

describe("gateway end-to-end with fake pi", () => {
	test("prompt produces a status message and the final echo", async () => {
		const dir = freshDir();
		const { host, adapter } = makeHost(dir);
		await host.addAdapter(adapter);
		await adapter.inject({ text: "hello world" });
		const reply = await adapter.lastReply();
		expect(reply).toBe("Echo: hello world");
		// a status message was sent and edited with progress, then the final
		// answer replaced it
		expect(adapter.sentTo("chan-1")[0]).toBe("🧠 Working…");
		expect(adapter.edits.length).toBeGreaterThan(0);
		await host.stop();
	}, 30_000);

	test("commands: help, status, id, new session", async () => {
		const dir = freshDir();
		const { host, adapter } = makeHost(dir);
		await host.addAdapter(adapter);

		await adapter.inject({ text: "/help", isCommand: true, command: "help" });
		expect(adapter.sentTo("chan-1").at(-1)).toContain("pi-cord");

		await adapter.inject({ text: "/id", isCommand: true, command: "id" });
		expect(adapter.sentTo("chan-1").at(-1)).toContain("user-1");

		await adapter.inject({ text: "/status", isCommand: true, command: "status" });
		const status = adapter.sentTo("chan-1").at(-1) ?? "";
		expect(status).toContain("fake/echo-1");

		await adapter.inject({ text: "/new test-session", isCommand: true, command: "new" });
		expect(adapter.sentTo("chan-1").at(-1)).toContain("test-session");

		await host.stop();
	}, 30_000);

	test("model command fuzzy-matches and sets", async () => {
		const dir = freshDir();
		const { host, adapter } = makeHost(dir);
		await host.addAdapter(adapter);
		await adapter.inject({ text: "/model echo-2", isCommand: true, command: "model" });
		expect(adapter.sentTo("chan-1").at(-1)).toContain("fake/echo-2");
		await host.stop();
	}, 30_000);

	test("unauthorized users are denied, unknown commands rejected", async () => {
		const dir = freshDir();
		const { host, adapter } = makeHost(dir);
		await host.addAdapter(adapter);
		await adapter.inject({ userId: "intruder", text: "sneak" });
		const texts = adapter.sentTo("chan-1");
		expect(texts.at(-1)).toContain("Not authorized");
		await adapter.inject({ userId: "user-1", text: "/definitely-not-a-command", isCommand: true, command: "definitely-not-a-command" });
		expect(adapter.sentTo("chan-1").at(-1)).toContain("Unknown command");
		await host.stop();
	}, 30_000);

	test("stop aborts a running prompt", async () => {
		const dir = freshDir();
		const { host, adapter } = makeHost(dir);
		await host.addAdapter(adapter);
		process.env.FAKE_PI_DELAY = "1500";
		await adapter.inject({ text: "slow task" });
		await new Promise((r) => setTimeout(r, 400));
		await adapter.inject({ text: "/stop" });
		// wait for the stopped delivery
		for (let i = 0; i < 100; i++) {
			const texts = adapter.delivered("chan-1").join("\n");
			if (texts.includes("Echo: slow task")) break;
			await new Promise((r) => setTimeout(r, 100));
		}
		delete process.env.FAKE_PI_DELAY;
		// edits include the final text with the stopped marker
		const finalEdit = adapter.edits.map((e) => e.text).find((t) => t.includes("Echo: slow task"));
		expect(finalEdit).toContain("(stopped after");
		await host.stop();
	}, 40_000);

	test("images are forwarded into the prompt", async () => {
		const dir = freshDir();
		const { host, adapter } = makeHost(dir);
		await host.addAdapter(adapter);
		const png = Buffer.from("89504e47", "hex");
		await adapter.inject({ text: "what is this", images: [{ data: png, mimeType: "image/png" }] });
		const reply = await adapter.lastReply();
		expect(reply).toContain("Echo: what is this");
		await host.stop();
	}, 30_000);
});
