import { describe, expect, test } from "bun:test";
import { chunkText, mdToTelegramHtml, DISCORD_LIMIT, TELEGRAM_LIMIT } from "../src/format";

function fenceBalanced(chunk: string): boolean {
	const count = (chunk.match(/```/g) ?? []).length;
	return count % 2 === 0;
}

describe("chunkText", () => {
	test("short text passes through", () => {
		expect(chunkText("hello", 100)).toEqual(["hello"]);
	});

	test("splits long prose under the limit", () => {
		const text = ("word ".repeat(600)).trim();
		const chunks = chunkText(text, DISCORD_LIMIT);
		expect(chunks.length).toBeGreaterThan(1);
		for (const c of chunks) expect(c.length).toBeLessThanOrEqual(DISCORD_LIMIT);
		expect(chunks.join(" ").split(/\s+/).filter(Boolean).length).toBe(600);
	});

	test("keeps a single fenced block intact", () => {
		const text = `intro\n\n\`\`\`ts\n${"const a = 1;\n".repeat(20)}\`\`\`\n\noutro`;
		const chunks = chunkText(text, DISCORD_LIMIT);
		expect(chunks).toHaveLength(1);
		expect(fenceBalanced(chunks[0])).toBe(true);
		expect(chunks[0]).toContain("```ts");
	});

	test("re-opens fences across chunk boundaries", () => {
		const fenceBody = Array.from({ length: 200 }, (_, i) => `line ${i} with some code ${i * 7}`).join("\n");
		const text = `before\n\`\`\`python\n${fenceBody}\n\`\`\`\nafter`;
		const chunks = chunkText(text, 400);
		expect(chunks.length).toBeGreaterThan(2);
		for (const c of chunks) expect(fenceBalanced(c)).toBe(true);
		// code survives: all lines present across chunks
		const joined = chunks.join("\n");
		expect(joined).toContain("line 0");
		expect(joined).toContain("line 199");
	});

	test("respects telegram limit", () => {
		const text = "x".repeat(TELEGRAM_LIMIT + 500);
		const chunks = chunkText(text, TELEGRAM_LIMIT);
		for (const c of chunks) expect(c.length).toBeLessThanOrEqual(TELEGRAM_LIMIT);
	});
});

describe("mdToTelegramHtml", () => {
	test("escapes html specials", () => {
		expect(mdToTelegramHtml("a < b & c > d")).toBe("a &lt; b &amp; c &gt; d");
	});

	test("wraps fenced code in <pre>", () => {
		const out = mdToTelegramHtml("look:\n```js\nconst x = 1 < 2;\n```");
		expect(out).toContain("<pre><code");
		expect(out).toContain("const x = 1 &lt; 2;");
	});

	test("inline code and bold and links", () => {
		const out = mdToTelegramHtml("run `npm test` and **read [docs](https://example.com)** now");
		expect(out).toContain("<code>npm test</code>");
		expect(out).toContain("<b>read <a href=\"https://example.com\">docs</a></b>");
	});
});
