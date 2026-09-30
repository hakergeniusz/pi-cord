import { expandTilde, readJson } from "./util";

/**
 * Gateway singleton lock. The bots must run in exactly one process: a second
 * gateway would fight over the Telegram long-poll (409 Conflict) and log in
 * Discord twice. The lock is a small JSON file with the holder's pid; liveness
 * is checked with kill(pid, 0), so crashed holders leave no stale locks.
 */

export interface GatewayLockInfo {
	pid: number;
	startedAt: string;
}

export function gatewayLockPath(): string {
	return expandTilde("~/.pi/agent/pi-cord/gateway.lock");
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		return code !== "ESRCH"; // EPERM (other user's process) still means alive
	}
}

/** The live gateway holding the lock, if any. */
export function readGatewayLock(): GatewayLockInfo | null {
	const lock = readJson<GatewayLockInfo>(gatewayLockPath());
	if (!lock || typeof lock.pid !== "number" || !alive(lock.pid)) return null;
	return lock;
}

/** Take the lock; returns a release function, or null when a live gateway already holds it. */
export function acquireGatewayLock(): (() => void) | null {
	const fs = require("node:fs") as typeof import("node:fs");
	const path = gatewayLockPath();
	const existing = readGatewayLock();
	if (existing) return null;

	fs.mkdirSync(expandTilde("~/.pi/agent/pi-cord"), { recursive: true });
	// Remove a stale file (dead pid) from a previous crash, then create exclusively.
	try {
		fs.unlinkSync(path);
	} catch {
		/* not there */
	}
	let fd: number;
	try {
		fd = fs.openSync(path, "wx", 0o600);
	} catch {
		return null; // lost a race with another acquirer
	}
	fs.writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() } satisfies GatewayLockInfo));
	fs.closeSync(fd);
	return () => {
		try {
			const current = readJson<GatewayLockInfo>(path);
			if (current?.pid === process.pid) fs.unlinkSync(path);
		} catch {
			/* best effort */
		}
	};
}
