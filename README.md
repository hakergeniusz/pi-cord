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
- **Commands**: `/new`, `/sessions`, `/resume`, `/stop`, `/status`, `/model`, `/thinking`, `/compact`, `/cwd`, `/commands`, `/ping`, `/id`, `/help`. Unknown `/commands` that exist as skills or prompt templates inside pi are forwarded to the agent.
- **Native slash commands** (OpenClaw-style): the bot publishes every command — gateway built-ins *and* your extensions'/skills'/prompts' commands — as real Telegram command-menu entries and Discord slash commands. Pick them from the client UI; they run through the same pipeline.
- **Live progress + streaming**: a status message shows elapsed time and current tool activity ("⚙️ bash: git status"), then the answer **streams into it token-by-token** as the model generates, and settles into the final text.
- **Steering, not queueing**: messages sent while the agent runs are appended to the running conversation at the next turn boundary — exactly like typing a follow-up in pi — instead of being queued.
- **Clean chat UI**: only the last `uiHistoryTurns` (default 3) exchanges stay visible; older messages are deleted as new turns complete. Full history still lives in pi's session files (`/sessions`).
- **Chat-only instructions**: `~/.pi/agent/pi-cord/AGENTS.md` is appended to every chat session's system prompt — used to tell the model that markdown tables don't render in Telegram/Discord (use lists instead). Your interactive pi never reads it (override the path with `agentsMd`).
- **Images**: attach photos/screenshots; they're passed to the model.
- **Interruptible**: `/stop` aborts the current run and returns the partial answer.
- **Runs as a systemd user service** — no interactive pi required and no tmux: the daemon spawns per-chat `pi --mode rpc` children on demand, restarts on failure, and picks up config changes live. (Also usable manually, or as a Pi extension inside your interactive pi.)

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

**As a systemd user service (recommended).** No running pi instance, no tmux — the daemon starts on login (survives logout with lingering), restarts itself on crashes, and reloads the config when you edit it:

```bash
cp systemd/pi-cord.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now pi-cord
journalctl --user -u pi-cord -f          # watch it work
```

Service management: `systemctl --user start|stop|restart|status pi-cord`. Editing `~/.pi/agent/pi-cord/config.json` (e.g. adding an allowlisted user) is picked up automatically within ~10s — the gateway restarts, chat history persists. The daemon stays healthy even before the config exists; it idles and starts the bots once you add tokens. Enable lingering once so it runs without an active login: `loginctl enable-linger $USER`.

**Manually** (same daemon, foreground):

```bash
bun run ~/pi-cord/src/main.ts            # or: npx tsx src/main.ts on node >= 20
bun run ~/pi-cord/src/main.ts --diag     # config summary (no secrets), pi path check
```

**As a Pi extension** (optional): the bots then live inside your interactive `pi` session:

```bash
ln -s ~/pi-cord/src ~/.pi/agent/extensions/pi-cord   # already installed by default
pi
/pi-cord status
```

**One gateway at a time**: a pid-based lock (`~/.pi/agent/pi-cord/gateway.lock`) means the extension inside an interactive pi automatically defers when the service is running (and vice versa) — no double Telegram polling (409) or double Discord logins. `/pi-cord start` in the TUI will tell you which pid owns the bots.

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
| `/commands` | list every command incl. extensions, skills, prompts |
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
| `notify.info` | `"once"` | info-notify policy: `"all"`, `"once"` (first of each distinct text per chat — stops repeat banners like extension startup notices), or `"off"`. warning/error always come through |
| `notify.suppress` | `[]` | never forward a notification whose message contains one of these substrings, e.g. `["Multi-account loaded"]` |
| `progressUpdates` | `true` | edit the status message with tool activity |
| `streaming` | `true` | stream the answer into the status message as it is generated (throttled edits, ~1.5s) |
| `slashCommands` | `true` | publish gateway + session commands as native Telegram/Discord slash commands |
| `uiHistoryTurns` | `3` | keep only the last N turns visible in the chat (older messages are deleted); `0` keeps everything |
| `agentsMd` | `~/.pi/agent/pi-cord/AGENTS.md` | file appended to chat sessions' system prompt (chat-only rules, e.g. "no markdown tables"); missing file = no injection |
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

- **Bot silent**: `bun run src/main.ts --diag` — is the allowlist still empty (everything denied by design)?
- **Service logs**: `journalctl --user -u pi-cord -f` (this is where pi-cord logs and chat-session stderr tails go).
- **Discord: no messages seen**: you didn't enable the **MESSAGE CONTENT INTENT**, or the bot lacks View/Send permissions in that channel.
- **Telegram: `409 Conflict`**: another process is long-polling the same token. pi-cord's own lock prevents its duplicates (extension defers to the service); look for a second bot instance outside pi-cord.
- **Chat replies stop mid-way**: check the journal for the child's stderr tail; run `/pi-cord status` in the chat or TUI.
- **Model errors**: chat sessions use your `~/.pi` auth — run `pi auth` to check providers, or set `model` in the config.
- **Service not running after logout**: `loginctl enable-linger $USER` (needs to be set once).

## Limitations / notes

- One prompt runs at a time per chat; extra messages **steer the running agent** (appended to its history at the next turn boundary) — or queue as a fallback if steering fails. Different chats run concurrently in separate processes.
- Telegram albums arrive as separate messages (each image prompts separately).
- Discord answers go inline in the channel/DM (threads the bot creates are followed automatically).
- Discord slash commands need the `bot` + `applications.commands` scopes; pi-cord registers them globally and per guild (guild registration is instant, global can take a little while to propagate).
- Discord interaction replies and Telegram messages the bot may not delete (e.g. user messages in groups without admin rights) are skipped by the history pruning, best effort everywhere else.
- The gateway is a control plane only — it never handles your prompts itself; the pi children do all agent work with your existing pi auth and model config.
