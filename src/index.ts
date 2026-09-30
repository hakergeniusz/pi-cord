/**
 * pi-cord — use your Pi coding agent from Discord or Telegram.
 *
 * Loaded as a Pi extension, this file is the control plane: it starts/stops
 * the chat bots and mirrors their state into the TUI. Actual agent work does
 * NOT happen in this process: each chat gets its own headless
 * `pi --mode rpc` child session (see chat.ts), so the user's interactive
 * session is never hijacked and per-chat history is pi's own session storage.
 *
 * In-pi command:  /pi-cord start|stop|status|diag
 * Config:         ~/.pi/agent/pi-cord/config.json (see config.example.json)
 *
 * The PI_CORD_CHILD guard is essential: chat sessions are spawned as full pi
 * processes and load this same extension from ~/.pi/agent/extensions, and a
 * child that started its own bots would fork-bomb the gateway.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { GatewayHost } from "./gateway";
import { findConfigPath, hasAnyToken } from "./config";
import { createLogger } from "./util";

const log = createLogger("ext");

/**
 * Routine, expected states (no config, autostart off, daemon already owns the
 * bots) are not worth a line in every session's scrollback. They only print
 * when PI_CORD_DEBUG=1; real errors always log.
 */
const debugLog = (...args: unknown[]): void => {
	if (process.env.PI_CORD_DEBUG === "1") log(...args);
};

export default function piCord(pi: ExtensionAPI): void {
	if (process.env.PI_CORD_CHILD) return;
	if (process.env.PI_CORD_DISABLE === "1") return;

	let host: GatewayHost | null = null;

	async function ensureHost(): Promise<GatewayHost> {
		if (host) return host;
		const configPath = findConfigPath();
		if (!configPath) {
			throw new Error("No pi-cord config found. Copy config.example.json to ~/.pi/agent/pi-cord/config.json and add a bot token.");
		}
		host = GatewayHost.fromEnv() ?? (() => { throw new Error(`Failed to load config at ${configPath}`); })();
		return host;
	}

	async function start(): Promise<string> {
		const h = await ensureHost();
		if (h.isRunning) return "pi-cord is already running.";
		await h.start();
		return "pi-cord started.";
	}

	async function stop(): Promise<string> {
		if (!host) return "pi-cord is not running.";
		await host.stop();
		return "pi-cord stopped.";
	}

	pi.registerCommand("pi-cord", {
		description: "pi-cord gateway: start | stop | status | diag",
		handler: async (args, ctx) => {
			const sub = args.trim().split(/\s+/)[0]?.toLowerCase() || "status";
			try {
				if (sub === "start") {
					const msg = await start();
					notify(ctx, msg);
				} else if (sub === "stop") {
					const msg = await stop();
					notify(ctx, msg);
				} else if (sub === "diag") {
					const lines: string[] = [];
					const configPath = findConfigPath();
					lines.push(`config: ${configPath ?? "NOT FOUND"}`);
					if (configPath) {
						const h = await ensureHost();
						lines.push(h.allowlistSummary());
					}
					lines.push(`guard: PI_CORD_CHILD=${process.env.PI_CORD_CHILD ?? "unset"}`);
					notify(ctx, lines.join("\n"));
				} else {
					if (!host) {
						notify(ctx, "pi-cord is not running. Use /pi-cord start (or set autostart in config).");
						return;
					}
					const st = host.status();
					const lines = [
						`running: ${st.running}`,
						`bots: ${st.adapters.length ? st.adapters.map((a) => `${a.platform} (${a.name})`).join(", ") : "none"}`,
						`active chats: ${st.chats.length ? st.chats.map((c) => `${c.key}${c.busy ? " (busy)" : ""}`).join(", ") : "none"}`,
						"",
						host.allowlistSummary(),
					];
					notify(ctx, lines.join("\n"));
				}
			} catch (err) {
				log("command failed:", err);
				notify(ctx, `pi-cord error: ${err instanceof Error ? err.message : String(err)}`);
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		try {
			const configPath = findConfigPath();
			if (!configPath) {
				debugLog("no config; staying dormant. See config.example.json in the pi-cord repo.");
				return;
			}
			const h = await ensureHost();
			if (h.config.autostart === false) {
				debugLog("autostart disabled in config; use /pi-cord start");
				return;
			}
			if (!hasAnyToken(h.config)) {
				debugLog("config has no bot tokens; staying dormant");
				return;
			}
			// A standalone gateway (systemd service or manual runner) owns the bots;
			// never fight it for the Telegram long-poll / Discord login.
			const { readGatewayLock } = await import("./lock");
			const held = readGatewayLock();
			if (held) {
				debugLog(`gateway already running (pid ${held.pid}, e.g. the systemd service) — this pi session will not start its own bots`);
				return;
			}
			await h.start();
			if (ctx.hasUI) {
				ctx.ui.setStatus("pi-cord", `🤖 ${h.status().adapters.map((a) => a.platform).join("+")}`);
			}
		} catch (err) {
			log("startup failed:", err);
			notify(ctx, `pi-cord failed to start: ${err instanceof Error ? err.message : String(err)}`);
		}
	});

	pi.on("session_shutdown", async () => {
		if (!host) return;
		await host.stop().catch((err) => log("shutdown stop failed:", err));
		host = null;
	});

	function notify(ctx: { hasUI: boolean; ui?: { notify(text: string, level?: string): void } }, text: string): void {
		log(text);
		if (ctx.hasUI && ctx.ui) ctx.ui.notify(text, "info");
	}
}
