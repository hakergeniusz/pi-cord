# pi-cord

Chat with your [Pi coding agent](https://github.com/earendil-works/pi) from **Discord** or **Telegram** — an OpenClaw-style personal agent gateway, built as a Pi extension. No OpenClaw involved: the actual agent is Pi itself, running in headless RPC sessions with full tool access (read, bash, edit, write), your models, and your `~/.pi` configuration.

```
Discord / Telegram
        │  (bot adapters)
        ▼
  pi-cord gateway  ── one `pi --mode rpc` child per chat,
  (pi extension)      each with its own --session-dir
        │             → per-chat history is pi's own session storage
        ▼
  your machine: files, shell, repos
```

## What you get

- **Chat with your agent** from your phone: prompts run as full agent sessions with tools in a working directory you control.
- **All your extensions load in chat sessions.** Chat sessions are real pi sessions: your extensions, skills, prompt templates, custom providers, guards — everything from `~/.pi/agent` works (opt out with `"childExtensions": false`).
- **Interactive features, forwarded to chat**: when an extension (or `ask_question`) opens a dialog — confirm, select, input, editor — it appears in Telegram as **inline buttons** (or a ForceReply for free text) and in Discord as a **select menu / buttons** (or a reply-to prompt). Your tap becomes the dialog answer; unanswered dialogs time out (`dialogTimeoutSeconds`, default 180s) and cancel safely. `/stop` also cancels pending dialogs.
- **Extension notifications** (`ctx.ui.notify`) are mirrored into the chat (ℹ️/⚠️/❌).
- **Per-chat sessions and history**: every Discord channel / Telegram chat maps to its own pi session directory. `/sessions` and `/resume` browse previous conversations; history survives restarts.
- **Commands**: `/new`, `/sessions`, `/resume`, `/stop`, `/status`, `/model`, `/thinking`, `/compact`, `/cwd`, `/ping`, `/id`, `/help`. Unknown `/commands` that exist as skills or prompt templates inside pi are forwarded to the agent.
- **Live progress**: a status message shows elapsed time and current tool activity ("⚙️ bash: git status") and is edited in place into the final answer.
- **Queued messages**: messages sent while the agent runs are queued, not lost.
- **Images**: attach photos/screenshots; they're passed to the model.
- **Interruptible**: `/stop` aborts the current run and returns the partial answer.
- **Two run modes**: as a Pi extension (bots live inside your interactive `pi`), or standalone (`bun run src/main.ts`) with no TUI at all.

## Security model (read this)

The bot can run shell commands on your machine. pi-cord is **fail-closed**:

- Each platform has an `allowedUsers` list of platform user ids. **Empty list = everyone is denied.**
- Unauthorized users get no agent access; in DMs they get a notice with their id (so you can allowlist them), in groups they're ignored. Buttons and interactive replies are also allowlist-checked.
- Group chats only trigger on commands, @mentions, and replies to the bot.
- Chat sessions load your extensions by default — they run with your real pi config. Set `"childExtensions": false` for a bare-agent session.
- The token lives in a config file you create — keep it `chmod 600`, it's in `.gitignore` if you keep the config in the repo dir.

**Everyone in `allowedUsers` has full shell access to the machine (scoped to the chat's cwd).** Only allowlist yourself (and people you'd give a terminal to).

## Setup

### 1. Telegram bot

1. In Telegram, talk to [@BotFather](https://t.me/BotFather): `/newbot`, pick a name and username.
2. Copy the token (`123456789:AA...`).
3. (Optional, for groups) Bot privacy mode: with default settings the bot receives commands and replies/mentions in groups — that's what pi-cord uses; no change needed.

### 2. Discord bot

1. <https://discord.com/developers/applications> → **New Application** → **Bot**.
2. Copy the bot token.
3. **Enable the `MESSAGE CONTENT INTENT`** (Bot settings → Privileged Gateway Intents) — pi-cord reads message text, so this is required.
4. Invite the bot: OAuth2 → URL Generator → scopes `bot` → permissions *Send Messages*, *Read Message History*, *Read Messages/View Channels* → open the URL, add it to your server. DMs work without a server invite.

### 3. pi-cord config

```bash
mkdir -p ~/.pi/agent/pi-cord
cp config.example.json ~/.pi/agent/pi-cord/config.json
chmod 600 ~/.pi/agent/pi-cord/config.json
$EDITOR ~/.pi/agent/pi-cord/config.json
```

```jsonc
{
	"autostart": true,
	"cwd": "~/projects/my-agent-sandbox",      // default working dir for chats
	"model": null,                             // e.g. "anthropic/claude-sonnet-4-5"; null = pi default
	"thinking": null,                          // off..max; null = pi default
	"discord":   { "token": "…", "allowedUsers": [] },
	"telegram":  { "token": "…", "allowedUsers": [] }
}
```

Bootstrapping the allowlist: start the bot, message it `/id` from your account, copy the printed **user id** into `allowedUsers`, restart. (Only `/id`, `/help` work before you're allowlisted.)

Config lookup order: `$PI_CORD_CONFIG` → `~/.pi/agent/pi-cord/config.json` → `~/pi-cord/config.json`. Tokens can alternatively come from `PI_CORD_TELEGRAM_TOKEN` / `PI_CORD_DISCORD_TOKEN`.

### 4. Run it

**As a Pi extension** (bots start with your pi session):

```bash
ln -s ~/pi-cord/src ~/.pi/agent/extensions/pi-cord
pi            # in any terminal; keep it open (tmux is fine)
/pi-cord status
```

- `/pi-cord start|stop|status|diag` controls the gateway from the TUI.
- `session_shutdown` stops the bots cleanly when pi exits. Crash of the TUI kills the bots (restart pi).
- Config with `autostart: true` + tokens starts the bots on every session start. `PI_CORD_DISABLE=1` disables the extension entirely.

**Standalone** (no TUI needed):

```bash
bun run ~/pi-cord/src/main.ts            # or: npm/global node >= 20: npx tsx src/main.ts
bun run ~/pi-cord/src/main.ts --diag     # print config summary (no secrets), check pi path
```

Run it under tmux/systemd/supervisor for a permanent OpenClaw-style setup.

## Using it

DM the bot (or @mention it in a server / reply to it in a group) and just type. Attach screenshots for vision-enabled models.

| Command | Effect |
|---|---|
| `/new [name]` | fresh session for this chat (old ones stay in `/sessions`) |
| `/sessions` | list recent sessions of this chat |
| `/resume <n>` | continue session n |
| `/stop` | abort the current run |
| `/status` | model, session file, context usage, queue state |
| `/model [pattern]` | show / switch model (fuzzy: `/model sonnet`) |
| `/thinking [level]` | show / set thinking level |
| `/compact [instructions]` | compact the context |
| `/cwd [path]` | show / set this chat's working directory (per chat, persisted) |
| `/ping`, `/id`, `/help` | diagnostics |

Typical flow from your phone:

```
you:  check why tests fail in ~/projects/api and fix them
bot:  🧠 Working… 12s
      ⚙️ bash: npm test -- --run
bot:  ─ Allow dangerous command?        (extension dialog)
      [✅ Yes] [❌ No]                   (tap to answer)
bot:  Two tests failed because … <fixed, all green now>
you:  /stop          (anytime — also cancels open dialogs)
```

## Configuration reference

| Key | Default | Meaning |
|---|---|---|
| `autostart` | `true` | start bots when a pi session starts |
| `piPath` | `"pi"` | pi CLI used for chat sessions |
| `cwd` | `~/.pi/agent/pi-cord/workspace` | default working dir for chats (per-chat override via `/cwd`) |
| `model` | pi default | model pattern for chat sessions |
| `thinking` | pi default | thinking level for chat sessions |
| `childExtensions` | `true` | load your extensions, skills, and templates in chat sessions |
| `trustProject` | `true` | pass `--approve` to chat sessions (trust project skills/prompts) |
| `interactiveDialogs` | `true` | forward extension dialogs into the chat as buttons/replies |
| `dialogTimeoutSeconds` | `180` | cancel a chat dialog after this long (never longer than the extension's own timeout) |
| `forwardNotifications` | `true` | mirror `ctx.ui.notify` messages from extensions into the chat |
| `progressUpdates` | `true` | edit the status message with tool activity |
| `childIdleMinutes` | `30` | shut down an idle chat session after N minutes |
| `childArgs` | `[]` | extra CLI args for every chat session |

State (current session per chat, per-chat cwd, Telegram update offset) lives in `~/.pi/agent/pi-cord/state.json`; per-chat session files in `~/.pi/agent/pi-cord/sessions/<platform>_<chat>/`.

## Development

```bash
bun install
bun run typecheck   # tsc --noEmit
bun test            # unit tests + gateway E2E against test/fake-pi.mjs (a fake pi --mode rpc)
```

`test/fake-pi.mjs` implements enough of pi's RPC protocol (JSONL, LF framing, id-correlated responses, `agent_settled` event flow) to test the whole gateway without a model or network.

Architecture: `src/gateway.ts` (adapters + chat map, per-chat serialization, dialog/notify routing) · `src/chat.ts` (ChatAgent: pi child lifecycle, queue, progress, delivery) · `src/rpc.ts` (RPC client: LF framing, id correlation, extension-UI dialog sub-protocol) · `src/telegram.ts` (zero-dep Bot API: long polling, inline keyboards, callback queries, ForceReply) · `src/discord.ts` (discord.js: select menus, buttons, interactions, reply-to) · `src/commands.ts` (auth + command table) · `src/index.ts` (pi extension entry) · `src/main.ts` (standalone entry).

## Troubleshooting

- **Bot silent**: check `/pi-cord status` in the TUI or `main.ts --diag`; is the allowlist still empty (everything denied by design)?
- **Discord: no messages seen**: you didn't enable the **MESSAGE CONTENT INTENT**, or the bot lacks View/Send permissions in that channel.
- **Telegram: `409 Conflict`**: another process is long-polling the same token (e.g. a second pi-cord instance or a devtools session). Stop one.
- **Chat replies stop mid-way**: run `/pi-cord status` and check the pi child's stderr tail in the pi-cord logs (stderr of your pi process / runner).
- **Model errors**: chat sessions use your `~/.pi` auth — run `pi auth` to check providers, or set `model` in the config.

## Limitations / notes

- One prompt runs at a time per chat (extra messages are queued); different chats run concurrently in separate processes.
- Telegram albums arrive as separate messages (each image prompts separately).
- Discord answers go inline in the channel/DM (threads the bot creates are followed automatically).
- The gateway is a control plane only — it never handles your prompts itself; the pi children do all agent work with your existing pi auth and model config.
