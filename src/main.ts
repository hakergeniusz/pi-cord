#!/usr/bin/env bun
/**
 * Standalone gateway runner — run pi-cord's bots without an interactive pi.
 *
 *   bun run ~/pi-cord/src/main.ts            # start with config from ~/.pi/agent/pi-cord/config.json
 *   PI_CORD_CONFIG=... bun run src/main.ts   # custom config
 *   bun run src/main.ts --diag               # print config summary and exit (no secrets)
 *
 * The agent work itself still happens in per-chat `pi --mode rpc` child
 * processes; this runner is only the bot + routing layer.
 */
import { GatewayHost } from "./gateway";
import { loadConfig, resolvePiPath } from "./config";
import { execFileSync } from "node:child_process";
import { createLogger } from "./util";

const log = createLogger("main");

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
	console.log(`config:       ${path}`);
	console.log(`autostart:    ${config.autostart === false ? "false" : "true"}`);
	console.log(`pi path:      ${piPath} (version ${piVersion})`);
	console.log(`model:        ${config.model ?? "(pi default)"}`);
	console.log(`thinking:     ${config.thinking ?? "(pi default)"}`);
	console.log(`child exts:   ${config.childExtensions ? "loaded" : "disabled (--no-extensions)"}`);
	console.log(`discord:      ${config.discord?.token ? "token set" : "no token"}, allowedUsers: ${config.discord?.allowedUsers?.length ?? 0}`);
	console.log(`telegram:     ${config.telegram?.token ? "token set" : "no token"}, allowedUsers: ${config.telegram?.allowedUsers?.length ?? 0}`);
	if (!config.discord?.allowedUsers?.length && !config.telegram?.allowedUsers?.length) {
		console.log("\nWARNING: allowlists are empty - every user is denied (fail closed).");
		console.log("Message your bot /id, then add the printed user id to allowedUsers.");
	}
	return 0;
}

async function main(): Promise<void> {
	if (process.argv.includes("--diag")) {
		process.exit(diag());
	}
	const host = GatewayHost.fromEnv();
	if (!host) {
		console.error("pi-cord: no config found. Copy config.example.json to ~/.pi/agent/pi-cord/config.json and add a bot token.");
		process.exit(1);
	}
	log(`config: ${host.configPath}`);
	await host.start();
	log("gateway running - press Ctrl+C to stop");

	let stopping = false;
	const shutdown = async (signal: string) => {
		if (stopping) return;
		stopping = true;
		log(`received ${signal}, stopping…`);
		await host.stop().catch(() => {});
		process.exit(0);
	};
	process.on("SIGINT", () => void shutdown("SIGINT"));
	process.on("SIGTERM", () => void shutdown("SIGTERM"));
	// keep the event loop alive; the reaper interval is unref'd
	const heartbeat = setInterval(() => {}, 1 << 30);
	heartbeat.unref?.();
	setInterval(() => {}, 60_000); // actively holds the loop open
}

main().catch((err) => {
	log("fatal:", err);
	process.exit(1);
});
