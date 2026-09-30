#!/usr/bin/env bun
/**
 * Fake `pi --mode rpc` implementation for pi-cord's tests.
 *
 * Speaks enough of the RPC protocol (JSONL, LF framing, id-correlated
 * responses, standard event flow) to exercise ChatAgent end-to-end without a
 * real model: prompts echo back as "Echo: <text>", and tool-activity events
 * fire so progress edits get exercised too.
 */
import { mkdirSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
function argValue(name) {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
}
const sessionDir = argValue("--session-dir") ?? process.cwd();
let sessionFile = argValue("--session");
let sessionSeq = 0;

function newSessionFile() {
	mkdirSync(sessionDir, { recursive: true });
	const file = join(sessionDir, `fake-${Date.now()}-${sessionSeq++}.jsonl`);
	if (!existsSync(file)) writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: `fake-${Date.now()}` }) + "\n");
	return file;
}
if (!sessionFile || !existsSync(sessionFile)) sessionFile = newSessionFile();

const stdin = process.stdin;
let buffer = "";
let lastPrompt = "";
let lastFinal = "";
let aborted = false;
let steeredMessages = [];

function send(obj) {
	process.stdout.write(JSON.stringify(obj) + "\n");
}

/** Emit a message_update with a cumulative assistant snapshot (like real pi). */
function emitUpdate(text, delta) {
	send({
		type: "message_update",
		message: { role: "assistant", content: [{ type: "text", text }], stopReason: "pending" },
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: delta ?? text },
	});
}

function respond(id, command, success, data) {
	send({ id: String(id), type: "response", command, success, ...(success ? { data } : { error: data }) });
}

/** Emit an extension dialog and wait for the extension_ui_response. */
function askDialog(req) {
	return new Promise((resolve) => {
		dialogWaiters.set(req.id, resolve);
		send({ type: "extension_ui_request", ...req });
	});
}

const dialogWaiters = new Map();

async function runDialogSequence(prompt) {
	const select = await askDialog({
		id: "dlg-select",
		method: "select",
		title: "Pick one",
		options: ["Allow", "Block"],
		timeout: 30000,
	});
	const confirm = await askDialog({
		id: "dlg-confirm",
		method: "confirm",
		title: "Proceed?",
		message: "This cannot be undone.",
	});
	const input = await askDialog({
		id: "dlg-input",
		method: "input",
		title: "Type a number",
		placeholder: "42",
	});
	return `Echo: ${prompt} [select=${select?.value ?? "cancelled"}] [confirm=${confirm?.confirmed ?? "cancelled"}] [input=${input?.value ?? "cancelled"}]`;
}

function state() {
	return {
		model: { provider: "fake", id: "echo-1", name: "Fake Echo" },
		thinkingLevel: "low",
		isStreaming: false,
		sessionFile,
		sessionId: "fake-session",
		messageCount: 2,
		pendingMessageCount: 0,
	};
}

function runAgent() {
	aborted = false;
	steeredMessages = [];
	send({ type: "agent_start" });
	send({ type: "turn_start" });
	send({ type: "message_start", message: { role: "user", content: lastPrompt, timestamp: Date.now() } });
	send({ type: "message_end", message: { role: "user", content: lastPrompt, timestamp: Date.now() } });

	const withDialogs = lastPrompt.includes("test dialogs");
	if (lastPrompt.startsWith("notify me")) {
		send({ type: "extension_ui_request", id: `n-${Date.now()}`, method: "notify", message: "Background job finished", notifyType: "info" });
	}
	if (withDialogs) {
		send({ type: "message_start", message: { role: "assistant", content: [], stopReason: "pending" } });
		runDialogSequence(lastPrompt)
			.then((finalText) => finishRun(finalText))
			.catch(() => finishRun(`Echo: ${lastPrompt}`));
		return;
	}

	send({ type: "message_start", message: { role: "assistant", content: [], stopReason: "pending" } });
	send({
		type: "tool_execution_start",
		toolCallId: "call_1",
		toolName: "bash",
		args: { command: "echo hi" },
	});
	send({ type: "tool_execution_end", toolCallId: "call_1", toolName: "bash", result: { content: [{ type: "text", text: "hi" }], details: {} }, isError: false });
	const delay = lastPrompt.includes("steer-slow") ? 600 : parseInt(process.env.FAKE_PI_DELAY ?? "150", 10);
	setTimeout(() => emitUpdate("Echo:"), 40);
	setTimeout(() => emitUpdate(`Echo: ${lastPrompt}`), 80);
	setTimeout(() => finishRun(`Echo: ${lastPrompt}${steeredMessages.length ? " + " + steeredMessages.join(" + ") : ""}`), delay);
}

function finishRun(finalText) {
	lastFinal = finalText;
	emitUpdate(finalText, finalText);
	send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: finalText }], stopReason: "stop" } });
	send({ type: "turn_end", message: { role: "assistant" }, toolResults: [] });
	send({ type: "agent_end", messages: [], willRetry: false });
	send({ type: "agent_settled" });
}

function handle(cmd) {
	const { id, type } = cmd;
	if (type === "extension_ui_response") {
		const waiter = dialogWaiters.get(String(id));
		if (waiter) {
			dialogWaiters.delete(String(id));
			waiter(cmd);
		}
		return;
	}
	switch (type) {
		case "get_state":
			respond(id, type, true, state());
			break;
		case "prompt": {
			lastPrompt = typeof cmd.message === "string" ? cmd.message : JSON.stringify(cmd.message);
			if (lastPrompt.startsWith("/echo-command")) {
				respond(id, type, true, { disposition: "handled" });
				setTimeout(() => send({ type: "agent_settled" }), 20);
				break;
			}
			respond(id, type, true, { disposition: "started" });
			runAgent();
			break;
		}
		case "abort":
			aborted = true;
			respond(id, type, true, {});
			break;
		case "steer":
			steeredMessages.push(typeof cmd.message === "string" ? cmd.message : JSON.stringify(cmd.message));
			respond(id, type, true, { disposition: "queued" });
			break;
		case "abort_retry":
			respond(id, type, true, {});
			break;
		case "get_last_assistant_text":
			respond(id, type, true, { text: lastFinal || (lastPrompt ? `Echo: ${lastPrompt}` : null) });
			break;
		case "get_session_stats":
			respond(id, type, true, {
				sessionFile,
				contextUsage: { tokens: 1234, contextWindow: 200000, percent: 1 },
			});
			break;
		case "compact":
			respond(id, type, true, { tokensBefore: 10000, estimatedTokensAfter: 2000 });
			break;
		case "get_available_models":
			respond(id, type, true, {
				models: [
					{ provider: "fake", id: "echo-1", name: "Fake Echo" },
					{ provider: "fake", id: "echo-2", name: "Fake Echo Two" },
				],
			});
			break;
		case "set_model":
			respond(id, type, true, { provider: cmd.provider, id: cmd.modelId });
			break;
		case "set_thinking_level":
			respond(id, type, true, {});
			break;
		case "get_available_thinking_levels":
			respond(id, type, true, { levels: ["off", "low", "medium", "high"] });
			break;
		case "get_commands":
			respond(id, type, true, { commands: [{ name: "echo-command", description: "fake skill", source: "skill" }] });
			break;
		case "new_session": {
			sessionFile = newSessionFile();
			respond(id, type, true, { cancelled: false });
			break;
		}
		case "switch_session": {
			if (existsSync(cmd.sessionPath)) {
				sessionFile = cmd.sessionPath;
				respond(id, type, true, { cancelled: false });
			} else {
				respond(id, type, false, "no such session");
			}
			break;
		}
		case "set_session_name":
			appendFileSync(sessionFile, JSON.stringify({ type: "session_info", name: cmd.name }) + "\n");
			respond(id, type, true, {});
			break;
		default:
			respond(id, type ?? "?", false, `fake-pi: unknown command ${type}`);
	}
}

stdin.setEncoding("utf8");
stdin.on("data", (chunk) => {
	buffer += chunk;
	let idx;
	while ((idx = buffer.indexOf("\n")) >= 0) {
		const line = buffer.slice(0, idx).trim();
		buffer = buffer.slice(idx + 1);
		if (!line) continue;
		try {
			handle(JSON.parse(line));
		} catch (err) {
			send({ type: "response", command: "parse", success: false, error: String(err) });
		}
	}
});
stdin.on("end", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
