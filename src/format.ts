/**
 * Message formatting: code-fence-aware chunking for Discord (2000) and
 * Telegram (4096) limits, plus conservative markdown -> Telegram HTML.
 */

export const DISCORD_LIMIT = 1900;
export const TELEGRAM_LIMIT = 3800;

interface Segment {
	text: string;
	/** Segment came from inside a fenced code block. */
	code: boolean;
	/** Fence info string (language) when code. */
	fence: string;
}

function splitSegments(text: string): Segment[] {
	const segments: Segment[] = [];
	const lines = text.split("\n");
	let buf: string[] = [];
	let inCode = false;
	let fence = "";
	let codeBuf: string[] = [];

	const flush = () => {
		if (buf.length) {
			segments.push({ text: buf.join("\n"), code: false, fence: "" });
			buf = [];
		}
	};
	const flushCode = () => {
		if (codeBuf.length) {
			segments.push({ text: codeBuf.join("\n"), code: true, fence });
			codeBuf = [];
		}
	};

	for (const line of lines) {
		const m = /^\s*(```+)\s*(\S*)\s*$/.exec(line);
		if (m) {
			if (!inCode) {
				flush();
				inCode = true;
				fence = m[2] ?? "";
			} else {
				inCode = false;
				flushCode();
				fence = "";
			}
			continue;
		}
		if (inCode) codeBuf.push(line);
		else buf.push(line);
	}
	flush();
	if (inCode) flushCode();
	return segments;
}

/**
 * Split text into chunks under `limit`, keeping fenced code blocks intact and
 * re-opening/closing fences across chunk boundaries.
 */
export function chunkText(text: string, limit: number): string[] {
	if (text.length <= limit) return [text];
	const chunks: string[] = [];
	let current = "";
	let openFence: string | null = null; // fence language currently open in `current`

	const closeOpen = (): string => (openFence !== null ? "\n```" : "");
	const reopen = (): string => (openFence !== null ? `\n\`\`\`${openFence}\n` : "");

	for (const seg of splitSegments(text)) {
		let piece = seg.code ? `\n\`\`\`${seg.fence}\n${seg.text}\n\`\`\`\n` : seg.text;
		if (seg.code) {
			// Code segments are emitted as complete fenced blocks; a split inside one
			// re-opens the fence so the chunk stays valid markdown.
			if (current.length + piece.length + closeOpen().length > limit) {
				chunks.push(current + closeOpen());
				current = "";
				openFence = null;
			}
			// If even a single fenced block exceeds the limit, split it by lines
			// while keeping fences on every chunk.
			if (piece.length + 8 > limit) {
				const body = seg.text.split("\n");
				let inner = "";
				const flushInner = () => {
					if (!inner) return;
					chunks.push((current ? current + closeOpen() + "\n" : "") + `\`\`\`${seg.fence}\n${inner}\n\`\`\``);
					current = "";
					openFence = null;
					inner = "";
				};
				for (const l of body) {
					if (inner.length + l.length + 8 > limit) flushInner();
					inner += (inner ? "\n" : "") + l;
				}
				flushInner();
				piece = "";
			}
			current += piece;
			continue;
		}

		// Prose segment: append word/line-wise with a hard fallback.
		const parts = seg.text.split(/(\n)/);
		for (const part of parts) {
			if (current.length + part.length + closeOpen().length <= limit) {
				current += part;
				continue;
			}
			// try splitting on spaces within `part`
			let rest = part;
			while (rest.length) {
				const room = limit - current.length - closeOpen().length - reopen().length - 1;
				if (room <= 0) {
					chunks.push(current + closeOpen());
					current = reopen().replace(/^\n/, "");
					continue;
				}
				const take = rest.slice(0, Math.max(room, 1));
				const cut = take.lastIndexOf(" ");
				const head = cut > room / 3 ? take.slice(0, cut) : take;
				current += head;
				rest = rest.slice(head.length);
				if (current.length + closeOpen().length >= limit - 1 || rest.length) {
					chunks.push(current + closeOpen());
					current = reopen().replace(/^\n/, "");
				}
				if (rest.length === 0) break;
			}
		}
	}
	if (current.trim()) chunks.push(current + closeOpen());
	return chunks.length ? chunks : [text.slice(0, limit)];
}

function escapeHtml(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function inlineHtml(s: string): string {
	let out = escapeHtml(s);
	// links [text](url) — text already escaped; url must be escaped for quotes
	out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, t, u) => `<a href="${escapeHtml(u)}">${t}</a>`);
	out = out.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
	out = out.replace(/__([^_\n]+)__/g, "<i>$1</i>");
	out = out.replace(/~~([^~\n]+)~~/g, "<s>$1</s>");
	out = out.replace(/(^|\n)#{1,6}\s+(.+)/g, (_m, nl, t) => `${nl}<b>${t}</b>`);
	return out;
}

/** Convert assistant markdown to Telegram HTML. Fenced blocks become <pre>, inline code <code>. */
export function mdToTelegramHtml(text: string): string {
	const parts: string[] = [];
	const segments = splitSegments(text);
	for (const seg of segments) {
		if (seg.code) {
			const lang = seg.fence ? ` class="language-${escapeHtml(seg.fence)}"` : "";
			parts.push(`<pre><code${lang}>${escapeHtml(seg.text)}</code></pre>`);
		} else {
			// inline code runs inside prose
			const pieces = seg.text.split(/(`[^`\n]+`)/);
			let s = "";
			for (const p of pieces) {
				if (p.startsWith("`") && p.endsWith("`") && p.length > 2) s += `<code>${escapeHtml(p.slice(1, -1))}</code>`;
				else s += inlineHtml(p);
			}
			parts.push(s);
		}
	}
	return parts.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** First line of a string, clamped. */
export function firstLine(s: string, max = 80): string {
	const line = s.split("\n").find((l) => l.trim()) ?? "";
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
