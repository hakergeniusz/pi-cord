/** Small shared helpers. No external dependencies so jiti/bun/node all load these the same way. */

export type Platform = "discord" | "telegram";

export function expandTilde(p: string): string {
	if (p === "~") return process.env.HOME ?? p;
	if (p.startsWith("~/")) return `${process.env.HOME ?? ""}/${p.slice(2)}`;
	return p;
}

/** Ring-buffer of the last N lines, used for child stderr tails in error reports. */
export class RingBuffer {
	private lines: string[] = [];
	constructor(private readonly capacity: number = 50) {}
	push(line: string): void {
		this.lines.push(line);
		while (this.lines.length > this.capacity) this.lines.shift();
	}
	/** Last `n` non-empty lines joined, or "" when nothing was captured. */
	tail(n = 5): string {
		return this.lines
			.filter((l) => l.trim().length > 0)
			.slice(-n)
			.join("\n");
	}
}

export function createLogger(scope: string): (...args: unknown[]) => void {
	const tag = `[pi-cord:${scope}]`;
	return (...args: unknown[]) => {
		const ts = new Date().toISOString();
		const msg = args
			.map((a) => (a instanceof Error ? (a.stack ?? a.message) : typeof a === "string" ? a : JSON.stringify(a)))
			.join(" ");
		process.stderr.write(`${ts} ${tag} ${msg}\n`);
	};
}

/** Truncate a single-line summary for status messages. */
export function summarize(value: unknown, max = 60): string {
	let s: string;
	if (typeof value === "string") s = value;
	else if (value == null) s = "";
	else if (typeof value === "object") {
		const o = value as Record<string, unknown>;
		s = String(o.command ?? o.path ?? o.file_path ?? o.url ?? o.query ?? o.pattern ?? "");
	} else s = String(value);
	s = s.replace(/\s+/g, " ").trim();
	return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export function formatDuration(ms: number): string {
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m${s % 60 ? ` ${s % 60}s` : ""}`;
	const h = Math.floor(m / 60);
	return `${h}h${m % 60 ? ` ${m % 60}m` : ""}`;
}

export function formatTokens(n: number | null | undefined): string {
	if (n == null) return "?";
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(n);
}

/** Simple fuzzy score for model patterns; higher is better, -1 = no match. */
export function fuzzyModelScore(pattern: string, provider: string, modelId: string, name?: string): number {
	const p = pattern.toLowerCase().trim();
	if (!p) return 0;
	const full = `${provider}/${modelId}`.toLowerCase();
	const id = modelId.toLowerCase();
	const nm = (name ?? "").toLowerCase();
	if (full === p || id === p) return 1000;
	if (p.includes("*") || p.includes("?")) {
		const re = new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "i");
		if (re.test(full) || re.test(id)) return 500;
	}
	if (full.startsWith(p) || id.startsWith(p)) return 400;
	if (id.includes(p) || full.includes(p)) return 300;
	if (nm.includes(p)) return 200;
	return -1;
}

/** Read a JSON file, returning null for any failure (missing, malformed, unreadable). */
export function readJson<T>(path: string): T | null {
	try {
		const fs = require("node:fs") as typeof import("node:fs");
		return JSON.parse(fs.readFileSync(path, "utf8")) as T;
	} catch {
		return null;
	}
}

/** Atomic-ish JSON write (tmp + rename). Never throws; logs via onError when provided. */
export function writeJson(path: string, value: unknown, onError?: (err: unknown) => void): void {
	try {
		const fs = require("node:fs") as typeof import("node:fs");
		const pathMod = require("node:path") as typeof import("node:path");
		fs.mkdirSync(pathMod.dirname(path), { recursive: true });
		const tmp = `${path}.tmp-${process.pid}`;
		fs.writeFileSync(tmp, JSON.stringify(value, null, "\t") + "\n", { mode: 0o600 });
		fs.renameSync(tmp, path);
	} catch (err) {
		onError?.(err);
	}
}
