import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GatewayHost } from "../src/gateway";
import type { PiCordConfig } from "../src/config";
import type { ChatAdapter, DialogAnswer, DialogRequest, Incoming } from "../src/types";

const FAKE_PI = join(import.meta.dir, "fake-pi.mjs");

class MockAdapter {
	readonly platform = "discord" as const;
	botName = "mock-bot";
	sent: Array<{ chatId: string; text: string }> = [];
	edits: Array<{ chatId: string; messageId: string; text: string }> = [];
	asked: DialogRequest[] = [];
	/** Scripted answers for ask(); each entry is called once in order. */
	dialogScript: Array<(req: DialogRequest) => DialogAnswer> = [];
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
	async ask(chatId: string, req: DialogRequest): Promise<DialogAnswer> {
		this.asked.push(req);
		const scripted = this.dialogScript.shift();
		return scripted ? scripted(req) : { cancelled: true };
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

function makeHost(dir: string, extra?: Partial<PiCordConfig>): { host: GatewayHost; adapter: MockAdapter } {
	const config: PiCordConfig = {
		piPath: FAKE_PI,
		cwd: join(dir, "workspace"),
		progressUpdates: true,
		discord: { token: "unused-by-mock", allowedUsers: ["user-1"] },
		...extra,
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

	test("extension dialogs round-trip through the chat as scripted answers", async () => {
		const dir = freshDir();
		const { host, adapter } = makeHost(dir);
		await host.addAdapter(adapter);
		// fake-pi asks select -> confirm -> input for prompts containing "test dialogs"
		adapter.dialogScript = [
			(req) => {
				expect(req.method).toBe("select");
				expect(req.options).toEqual(["Allow", "Block"]);
				return { value: "Block" };
			},
			(req) => {
				expect(req.method).toBe("confirm");
				return { confirmed: true };
			},
			(req) => {
				expect(req.method).toBe("input");
				return { value: "42" };
			},
		];
		await adapter.inject({ text: "run test dialogs now" });
		const reply = await adapter.lastReply();
		expect(reply).toContain("[select=Block]");
		expect(reply).toContain("[confirm=true]");
		expect(reply).toContain("[input=42]");
		expect(adapter.asked.map((r) => r.method)).toEqual(["select", "confirm", "input"]);
		await host.stop();
	}, 30_000);

	test("dialogs without a scripted answer are cancelled so the run finishes", async () => {
		const dir = freshDir();
		const { host, adapter } = makeHost(dir);
		await host.addAdapter(adapter);
		await adapter.inject({ text: "run test dialogs now" });
		const reply = await adapter.lastReply();
		expect(reply).toContain("[select=cancelled]");
		expect(reply).toContain("[confirm=cancelled]");
		expect(reply).toContain("[input=cancelled]");
		await host.stop();
	}, 30_000);

	test("extension notifications are mirrored into the chat", async () => {
		const dir = freshDir();
		const { host, adapter } = makeHost(dir);
		await host.addAdapter(adapter);
		await adapter.inject({ text: "notify me when done" });
		await adapter.lastReply();
		expect(adapter.sentTo("chan-1")).toContain("ℹ️ Background job finished");
		await host.stop();
	}, 30_000);

	test("repeated info notifies are deduped per chat and survive a restart", async () => {
		const dir = freshDir();
		const runOnce = async (host: GatewayHost, adapter: MockAdapter) => {
			await host.addAdapter(adapter);
			await adapter.inject({ text: "notify me when done" });
			await adapter.lastReply();
			await host.stop();
		};
		const { host, adapter } = makeHost(dir);
		await runOnce(host, adapter);
		expect(adapter.sentTo("chan-1").filter((t) => t === "ℹ️ Background job finished").length).toBe(1);

		// a fresh gateway on the same state must not repeat the banner
		const again = makeHost(dir);
		await runOnce(again.host, again.adapter);
		expect(again.adapter.sentTo("chan-1").filter((t) => t === "ℹ️ Background job finished").length).toBe(0);
	}, 30_000);

	test("notify.suppress silences matching banners entirely", async () => {
		const dir = freshDir();
		const { host, adapter } = makeHost(dir, { notify: { suppress: ["Background job"] } });
		await host.addAdapter(adapter);
		await adapter.inject({ text: "notify me when done" });
		await adapter.lastReply();
		expect(adapter.sentTo("chan-1").some((t) => t.includes("Background job"))).toBe(false);
		await host.stop();
	}, 30_000);

	test("notify.info 'all' forwards every occurrence, 'off' none", async () => {
		const dir = freshDir();
		const runTwice = async (host: GatewayHost, adapter: MockAdapter) => {
			await host.addAdapter(adapter);
			for (let i = 0; i < 2; i++) {
				// wait for a NEW echo: delivered() accumulates across runs
				const echoesBefore = adapter.delivered("chan-1").filter((t) => t.startsWith("Echo:")).length;
				await adapter.inject({ text: "notify me when done" });
				for (let j = 0; j < 200; j++) {
					const echoesNow = adapter.delivered("chan-1").filter((t) => t.startsWith("Echo:")).length;
					if (echoesNow > echoesBefore) break;
					await new Promise((r) => setTimeout(r, 100));
				}
			}
			await host.stop();
		};
		const all = makeHost(dir, { notify: { info: "all" } });
		await runTwice(all.host, all.adapter);
		expect(all.adapter.sentTo("chan-1").filter((t) => t === "ℹ️ Background job finished").length).toBe(2);

		const off = makeHost(dir, { notify: { info: "off" } });
		await runTwice(off.host, off.adapter);
		expect(off.adapter.sentTo("chan-1").some((t) => t.includes("Background job"))).toBe(false);
	}, 30_000);
});
