#!/usr/bin/env bun
/**
 * pi-cord daemon — the bots without any interactive pi (and without tmux).
 *
 *   systemctl --user enable --now pi-cord        # the normal way (see systemd/pi-cord.service)
 *   bun run ~/pi-cord/src/main.ts                # manual run
 *   bun run ~/pi-cord/src/main.ts --diag         # config summary (no secrets)
 *
 * Behavior:
 * - Starts the gateway when the config exists and has tokens.
 * - No config yet? Stays alive and retries every 10s, so the service is
 *   healthy from first boot and picks up configuration when it appears.
 * - Config file edited? The gateway restarts with the new settings (chat
 *   sessions and their history are persistent, so this is safe).
 * - Refuses to run twice (gateway lock): a second instance exits 0, so
 *   systemd restarts and manual runs can't fight each other.
 *
 * Agent work always happens in per-chat `pi --mode rpc` child processes,
 * spawned on demand — no running interactive pi is involved anywhere.
 */
import { statSync } from "node:fs";
import { GatewayHost } from "./gateway";
import { loadConfig, resolvePiPath } from "./config";
import { readGatewayLock } from "./lock";
import { execFileSync } from "node:child_process";
import { createLogger } from "./util";

const log = createLogger("main");
const WATCH_INTERVAL_MS = 10_000;

function diag(): number {
	const loaded = loadConfig();
	if (!loaded) {
		console.error("no config found (looked at $PI_CORD_CONFIG, ~/.pi/agent/pi-cord/config.json, ~/pi-cord/config.json)");
		return 1;
	}
	const { config, path } = loaded;
	const piPath = resolvePiPath(config);
	let piVersion = "not found";
	try {
		piVersion = execFileSync(piPath, ["--version"], { encoding: "utf8" }).trim();
	} catch {
		/* leave as not found */
	}
	const lock = readGatewayLock();
	console.log(`config:       ${path}`);
	console.log(`autostart:    ${config.autostart === false ? "false" : "true"} (extension mode only)`);
	console.log(`pi path:      ${piPath} (version ${piVersion})`);
	console.log(`model:        ${config.model ?? "(pi default)"}`);
	console.log(`thinking:     ${config.thinking ?? "(pi default)"}`);
	console.log(`child exts:   ${config.childExtensions === false ? "disabled" : "enabled (your full extension set)"}`);
	console.log(`dialogs:      ${config.interactiveDialogs === false ? "off" : `on (timeout ${config.dialogTimeoutSeconds ?? 180}s)`}`);
	console.log(`discord:      ${config.discord?.token ? "token set" : "no token"}, allowedUsers: ${config.discord?.allowedUsers?.length ?? 0}`);
	console.log(`telegram:     ${config.telegram?.token ? "token set" : "no token"}, allowedUsers: ${config.telegram?.allowedUsers?.length ?? 0}`);
	if (lock) console.log(`gateway lock: HELD by pid ${lock.pid} (started ${lock.startedAt})`);
	else console.log("gateway lock: free");
	if (!config.discord?.allowedUsers?.length && !config.telegram?.allowedUsers?.length) {
		console.log("\nWARNING: allowlists are empty - every user is denied (fail closed).");
		console.log("Message your bot /id, then add the printed user id to allowedUsers.");
	}
	return 0;
}

function configMtime(path: string): number {
	try {
		return statSync(path).mtimeMs;
	} catch {
		return 0;
	}
}

class Daemon {
	private host: GatewayHost | null = null;
	private configPath: string | null = null;
	private configMtimeSeen = 0;
	private stopping = false;
	private announcedWaiting = false;

	/**
	 * Ensure the gateway matches the on-disk config: start it when missing,
	 * restart it when the config changed, do nothing when in sync.
	 * Returns false while there is nothing usable to run yet.
	 */
	private async reconcile(): Promise<boolean> {
		const loaded = loadConfig();
		if (!loaded) {
			if (!this.announcedWaiting) {
				log("no config yet — idling; watching ~/.pi/agent/pi-cord/config.json (and $PI_CORD_CONFIG)");
				this.announcedWaiting = true;
			}
			return false;
		}
		const mtime = configMtime(loaded.path);
		if (this.host && loaded.path === this.configPath && mtime === this.configMtimeSeen) return true;

		if (this.host) log(`config changed (${loaded.path}) — restarting gateway`);
		this.announcedWaiting = false;
		const old = this.host;
		this.host = null;
		await old?.stop().catch((err) => log("old gateway stop failed:", err));

		const next = new GatewayHost(loaded.config, loaded.path);
		try {
			await next.start();
		} catch (err) {
			await next.stop().catch(() => {});
			const message = err instanceof Error ? err.message : String(err);
			if (message.includes("already running")) {
				const held = readGatewayLock();
				log(`another gateway holds the lock (pid ${held?.pid}) — exiting so it can serve`);
				process.exit(0);
			}
			log(`start failed (${message}) — retrying in ${WATCH_INTERVAL_MS / 1000}s`);
			return false;
		}
		this.host = next;
		this.configPath = loaded.path;
		this.configMtimeSeen = mtime;
		log(`gateway running (config: ${loaded.path})`);
		return true;
	}

	async run(): Promise<void> {
		if (process.argv.includes("--diag")) process.exit(diag());

		const held = readGatewayLock();
		if (held) {
			log(`another pi-cord gateway is already running (pid ${held.pid}) — exiting`);
			process.exit(0);
		}

		let sawGatewayOnce = false;
		for (;;) {
			if (this.stopping) return;
			try {
				const ok = await this.reconcile();
				if (ok && !sawGatewayOnce) {
					sawGatewayOnce = true;
					log("daemon ready — press Ctrl+C to stop (or: systemctl --user stop pi-cord)");
				}
			} catch (err) {
				log("watch tick failed:", err);
			}
			await sleep(WATCH_INTERVAL_MS);
		}
	}

	async stopDaemon(): Promise<void> {
		if (this.stopping) return;
		this.stopping = true;
		log("stopping…");
		await this.host?.stop().catch(() => {});
		process.exit(0);
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

const daemon = new Daemon();

process.on("SIGINT", () => void daemon.stopDaemon());
process.on("SIGTERM", () => void daemon.stopDaemon());

daemon.run().catch((err) => {
	log("fatal:", err);
	process.exit(1);
});
