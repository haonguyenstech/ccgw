# ccgw

Use your logged-in **Claude Code CLI** as the inference gateway for **Claude
Desktop** (Settings → Configure third-party inference → Gateway). Chat, Cowork,
tool calls and artifacts in Desktop all run through your local `claude`.

## Install

Requires **Node.js 18.17+** and the **Claude Code CLI**, logged in (`claude` → `/login`).

macOS / Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/haonguyenstech/ccgw/main/install.sh | sh
```

Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/haonguyenstech/ccgw/main/install.ps1 | iex
```

Pin a version with `CCGW_VERSION=0.1.0` (sh) or `$env:CCGW_VERSION = "0.1.0"` (PowerShell).
Uninstall: `ccgw stop; npm uninstall -g ccgw`.

## Use

Run `ccgw` with no arguments for an interactive menu — **↑/↓** to move,
**Enter** to run, **Esc** to go back, **q** to quit (number keys jump straight to
an item). Everything in it is also a plain command:

```bash
ccgw start             # start the gateway; prints the values for Claude Desktop
ccgw desktop gateway   # or: let ccgw write the profile and switch Desktop for you
```

Paste into Claude Desktop → *Configure third-party inference*:

| Field | Value |
| --- | --- |
| Connection | Gateway |
| Credential kind | Static API key |
| Gateway base URL | `http://127.0.0.1:8787` |
| Gateway API key | printed by `ccgw start` / `ccgw info` |
| Gateway auth scheme | bearer |

| Command | |
| --- | --- |
| `ccgw start [--port N] [-f]` | start in background (`-f` foreground) |
| `ccgw stop` / `restart` / `status` | |
| `ccgw info` | print Base URL / API key / auth scheme |
| `ccgw copy url\|key` | copy to clipboard |
| `ccgw desktop gateway` | switch Desktop to gateway mode (starts ccgw, writes + selects the "Claude Code (ccgw)" profile) |
| `ccgw desktop login` | switch Desktop back to claude.ai login mode |
| `ccgw desktop toggle` / `status` | flip modes / show current mode |
| `ccgw connector add clickup` | add a connector to Desktop (sign in via browser) — see below |
| `ccgw connector list` / `remove <name>` | |
| `ccgw rotate-key` | new API key |
| `ccgw logs [-f]` | log at `~/.ccgw/gateway.log` |
| `ccgw update [--check]` | install the latest release (see below) |

Config: `~/.ccgw/config.json` (`port`, `host`, `maxSessions`, `sessionTtlMinutes`,
`warmPool`, `expose1m`, optional `claudePath`). Listens on `127.0.0.1` only.

## Connectors (ClickUp, Linear, Notion, Figma, …)

In gateway mode Claude Desktop has no claude.ai connector directory, so add
connectors with ccgw. They are remote MCP servers that use OAuth: Desktop
registers itself with the provider and opens its sign-in page — no API keys,
nothing to install.

```bash
ccgw connector add clickup      # restarts Claude Desktop to load it
```

Then sign in once:

1. Claude Desktop → **Settings → Connectors**
2. Click **clickup → Connect**
3. The browser opens ClickUp's sign-in page → log in → **Allow**
4. Back in Desktop it shows as connected. Try: *"list my ClickUp tasks"*

Providers that issue refresh tokens stay signed in; ClickUp does not (its token lasts 24h), so Desktop asks you to **Connect** again about once a day. *Settings → Connectors → clickup → Disconnect* signs out.

Presets: `clickup`, `linear`, `notion`, `atlassian` (Jira/Confluence), `sentry`, `figma`.
Figma only accepts allowlisted OAuth clients, so for `figma` ccgw registers the
client itself and writes its id into the profile (callback `127.0.0.1:53282`).
Any other remote MCP server: `ccgw connector add <name> --url https://…/mcp`
(OAuth by default; `--header "Authorization: Bearer …"` for token-based servers).
`--no-restart` skips the Desktop restart. Connectors live in the
"Claude Code (ccgw)" profile, so they work the same on macOS and Windows.

## Updating

```bash
ccgw update           # install the latest release, restart the gateway if it was running
ccgw update --check   # only report whether a newer release exists
```

ccgw checks GitHub for a new release at most once a day and prints a one-line
notice after a command when there is one (the interactive menu shows an
**Update** item). It never installs by itself. If Claude Desktop has
conversations open, `ccgw update` asks before restarting the gateway (`--yes`
skips the question). Set `CCGW_NO_UPDATE_CHECK=1` to turn the check off.

## Switching Desktop modes without logging out

Desktop keeps each mode in its own data dir — claude.ai login in
`~/Library/Application Support/Claude` (`%APPDATA%\Claude` on Windows), gateway in
`…/Claude-3p` (`%LOCALAPPDATA%\Claude-3p`) — and picks one from `deploymentMode`
in `Claude-3p/claude_desktop_config.json`. Switching from Desktop's own UI goes
through sign-out and clears credentials; `ccgw desktop login|gateway` quits
Desktop, flips the key and reopens it, so both sessions survive.

## How it works

- Serves `GET /v1/models`, `POST /v1/messages` (stream + non-stream),
  `POST /v1/messages/count_tokens` (estimate).
- Each request runs through your installed `claude` via the Claude Agent SDK, so
  it uses your Claude Code login and the newest CLI version.
- **Tool calling is bridged**: Desktop's tools are exposed to the CLI as an
  in-process MCP server. When the model calls one, the CLI blocks in that
  handler, the HTTP response ends with `stop_reason: tool_use`, and the next
  request's `tool_result` unblocks the same CLI process.
- **Speed**: one CLI process per conversation stays alive, so a follow-up is a
  single prompt write (no history replay), and a pre-warmed process per recent
  system prompt removes spawn latency for new conversations.
- Desktop/Cowork quirks handled: mid-conversation `role: "system"` messages,
  the client's `x-anthropic-billing-header` system block (stripped), tool names
  longer than 64 chars after the MCP prefix (aliased).
- Errors map to Messages-API types (`rate_limit_error` 429, `overloaded_error`
  529, …) so clients back off and retry.

## Limits

- Usage counts against the Claude Code account's plan limits. Cowork sends a
  ~100K-token system prompt at the start of each conversation.
- `temperature`, `max_tokens`, `stop_sequences` are not forwarded (the CLI owns
  sampling). Model and thinking budget are.
- If Desktop edits history (retry/branch from an earlier message), the
  conversation restarts in a fresh CLI process with prior turns flattened to
  text, so images from earlier turns are dropped.
- The gateway does not start at login; run `ccgw start` after a reboot.

## Development

```bash
npm install && npm link
node test/smoke.mjs     # no Claude login needed
node test/stress.mjs    # needs a running gateway + logged-in CLI
CCGW_DEBUG=1 node src/server.mjs   # logs CLI events, dumps requests to ~/.ccgw/debug/
```
