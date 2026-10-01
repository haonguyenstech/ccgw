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

Pin a version with `CCGW_VERSION=0.3.5` (sh) or `$env:CCGW_VERSION = "0.3.5"` (PowerShell).
Uninstall: `ccgw stop; npm uninstall -g ccgw`.

## Use

Run `ccgw` with no arguments for an interactive menu: a status panel (gateway,
Claude Desktop mode, connectors, permission prompts, version) above numbered
actions. **↑/↓** move, **Enter** runs, a **number** runs that item, **Esc** goes
back, **q** quits. Everything in it is also a plain command:

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
| `ccgw connector add <preset>` | add a connector to Desktop — see [Connectors](#connectors-clickup-linear-notion-figma-gmail-) |
| `ccgw connector list` / `remove <name>` | |
| `ccgw permissions [bypass\|ask] [name]` | skip or restore Desktop's per-tool permission prompts |
| `ccgw figma status` / `plugin` | check the `figma-local` bridge / print the plugin setup steps |
| `ccgw gmail status\|login\|logout` | manage the `gmail` sign-in |
| `ccgw rotate-key` | new API key |
| `ccgw logs [-f]` | log at `~/.ccgw/gateway.log` |
| `ccgw update [--check]` | install the latest release (see below) |

Config: `~/.ccgw/config.json` (`port`, `host`, `maxSessions`, `sessionTtlMinutes`,
`warmPool`, `expose1m`, `bypassPermissions`, optional `claudePath`). Listens on `127.0.0.1` only.

## Connectors (ClickUp, Linear, Notion, Figma, Gmail, …)

In gateway mode Claude Desktop has no claude.ai connector directory, so add
connectors with ccgw (or **Connectors…** in the menu). Each one restarts Claude
Desktop to load it; `--no-restart` skips that. They live in the "Claude Code
(ccgw)" profile, so they work the same on macOS and Windows.

| Preset | What | Sign-in |
| --- | --- | --- |
| `clickup`, `linear`, `notion`, `atlassian` (Jira/Confluence), `sentry`, `figma` | the provider's remote MCP server | OAuth in the browser, from Desktop |
| `gmail` | local MCP server over the Gmail API | your own Google OAuth client, once |
| `figma-local` | Figma Desktop through a plugin, **no plan limits** | none; run the plugin in Figma |

### Remote connectors (OAuth)

Desktop registers itself with the provider and opens its sign-in page — no API
keys, nothing to install.

```bash
ccgw connector add clickup
```

Then sign in once:

1. Claude Desktop → **Settings → Connectors**
2. Click **clickup → Connect**
3. The browser opens ClickUp's sign-in page → log in → **Allow**
4. Back in Desktop it shows as connected. Try: *"list my ClickUp tasks"*

Providers that issue refresh tokens stay signed in; ClickUp does not (its token
lasts 24h), so Desktop asks you to **Connect** again about once a day.
*Settings → Connectors → clickup → Disconnect* signs out.

Figma only accepts allowlisted OAuth clients, so for `figma` ccgw registers the
client itself and writes its id into the profile (callback `127.0.0.1:53282`).
On Figma's free Starter plan that server allows only a few calls a month — use
`figma-local` instead.

Any other remote MCP server: `ccgw connector add <name> --url https://…/mcp`
(OAuth by default; `--header "Authorization: Bearer …"` for token-based servers).

### Gmail (`gmail`)

Gmail runs locally: ccgw ships a small stdio MCP server over the Gmail API
(search, read messages and threads, send, draft, labels, trash). Google's own
Gmail MCP server only serves Cloud projects enrolled in its Workspace Developer
Preview, so ccgw does not use it. Google has no automatic client registration,
so bring your own OAuth client:

1. [Google Cloud console](https://console.cloud.google.com) → pick or create a project
2. Enable the Gmail API: `gcloud services enable gmail.googleapis.com`
   (or APIs & Services → Library → Gmail API)
3. OAuth consent screen → External → add yourself under **Test users**
4. Credentials → Create credentials → OAuth client ID → **Desktop app** → download the JSON
5. `ccgw connector add gmail --client-json ~/Downloads/client_secret_….json`
   (or `--client-id <id> --client-secret <secret>`)

Step 5 opens Google's sign-in in the browser, stores the refresh token in
`~/.ccgw/gmail.json` (mode 600) and restarts Desktop — there is no Connect step.
`ccgw gmail status | login | logout` manages the sign-in. While the consent
screen is in *Testing*, Google expires the refresh token after 7 days; publish
the app (it stays unverified, which is fine for your own account) to avoid that.

### Figma without plan limits (`figma-local`)

Figma's remote MCP server allows only a few calls a month on the free Starter
plan, and its REST API is capped the same way. `figma-local` goes through Figma
Desktop instead: a plugin uses the Plugin API, so nothing is counted. It reads
files, selections, styles and components, exports images, and can edit designs.

```bash
ccgw connector add figma-local   # installs the bridge into ~/.ccgw/figma
```

Then, once, in Figma Desktop: open a file → **Plugins → Development → Import
plugin from manifest…** → `~/.ccgw/figma/plugin/manifest.json`.

From then on, run **Plugins → Development → ccgw Figma Bridge** in the file
Claude should see. It connects by itself and reconnects when Desktop restarts.
If it is not running, Figma tools fail at once and Claude asks you to start it.
`ccgw figma status` shows whether the relay is up and the plugin connected.

How it works: it is [Talk to Figma](https://github.com/grab/cursor-talk-to-figma-mcp)
(MIT). ccgw installs its MCP server (pinned to 0.3.5) into `~/.ccgw/figma`, pins
it to one channel so there is nothing to join, and runs the WebSocket relay
itself on `localhost:3055` (IPv4 and IPv6 loopback, never the LAN; no Bun). The
plugin copy in [`figma-plugin/`](figma-plugin/) has its usage analytics removed.
With the plugin open in several files, commands go to the one where it was
started last. Figma Desktop must be running; the first `connector add` needs
npm and network access.

### Permission prompts

Desktop asks *"Claude wants to use …"* before each connector tool. To skip that:

```bash
ccgw permissions                       # show the setting per connector
ccgw permissions bypass                # every connector, including ones added later
ccgw permissions bypass figma-local    # just one
ccgw permissions ask                   # prompt again
```

Or use **Permission prompts** in the menu, or `connector add <preset> --allow`
for a single new connector. Re-adding a connector keeps its setting. Tools then
act without confirmation — including sending email or editing designs. It
restarts Desktop to apply (`--no-restart` skips that).

## Updating

```bash
ccgw update           # install the latest release, restart the gateway if it was running
ccgw update --check   # only report whether a newer release exists
```

ccgw checks GitHub for a new release at most once a day and prints a one-line
notice after a command when there is one. In the menu, **Check for updates**
checks right away and turns into **Update to vX.Y.Z** when one exists. It never installs by itself. If Claude Desktop has
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
- `figma-local` is tested on macOS; on Windows it is untested with a real Figma
  Desktop.

## Development

```bash
npm install && npm link
node test/smoke.mjs     # no Claude login needed
node test/stress.mjs    # needs a running gateway + logged-in CLI
CCGW_DEBUG=1 node src/server.mjs   # logs CLI events, dumps requests to ~/.ccgw/debug/
```
