#!/usr/bin/env node
// ccgw — start/stop a local Anthropic-compatible gateway backed by Claude Code.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readConfig, writeConfig, newKey, PID_FILE, LOG_FILE, CONFIG_FILE, HOME_DIR } from '../src/config.mjs';
import { gmailLogin, gmailLogout, readGmail, serveGmail, GMAIL_FILE } from '../src/gmail.mjs';
import { installFigma, serveFigma, figmaStatus, PLUGIN_MANIFEST, RELAY_PORT } from '../src/figma.mjs';
import { interactive, select, prompt, panel, accent } from '../src/menu.mjs';
import { logo } from '../src/logo.mjs';
import { checkForUpdate, cachedLatest, isNewer, installVersion } from '../src/update.mjs';
import {
  IS_WIN, sleep, findClaude, claudeAuthStatus, copyToClipboard,
  desktop3pDir, desktopSupported, quitDesktop, openDesktop,
} from '../src/platform.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'src', 'server.mjs');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = (s) => c(1, s), dim = (s) => c(2, s), green = (s) => c(32, s), red = (s) => c(31, s), cyan = (s) => c(36, s);

const baseUrl = (cfg) => `http://${cfg.host}:${cfg.port}`;

function readPid() {
  try {
    const pid = Number(fs.readFileSync(PID_FILE, 'utf8'));
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

async function health(cfg, timeoutMs = 1500) {
  try {
    const r = await fetch(`${baseUrl(cfg)}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    const body = r.ok ? await r.json() : null;
    return body?.name === 'ccgw' ? body : null;
  } catch {
    return null;
  }
}

function printInfo(cfg, { copied } = {}) {
  const rows = [
    ['Connection', 'Gateway'],
    ['Credential kind', 'Static API key'],
    ['Gateway base URL', baseUrl(cfg)],
    ['Gateway API key', cfg.apiKey],
    ['Gateway auth scheme', 'bearer'],
  ];
  const w = Math.max(...rows.map(([k]) => k.length));
  console.log('');
  console.log(bold('  Claude Desktop → Settings → Configure third-party inference'));
  console.log('');
  for (const [k, v] of rows) console.log(`  ${dim(k.padEnd(w))}  ${cyan(v)}`);
  console.log('');
  if (copied) console.log(dim('  API key copied to clipboard.'));
  console.log(dim(`  ccgw copy url | ccgw copy key   ·   ccgw desktop gateway   ·   ccgw logs -f`));
  console.log('');
}

// Keep the log from growing without bound across restarts.
function rotateLog() {
  try {
    if (fs.statSync(LOG_FILE).size > 5 * 1024 * 1024) fs.renameSync(LOG_FILE, LOG_FILE + '.1');
  } catch {}
}

async function start(args = []) {
  const cfg = readConfig();
  const portArg = args.indexOf('--port');
  if (portArg >= 0) {
    const port = Number(args[portArg + 1]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) fail('--port needs a number between 1 and 65535');
    cfg.port = port;
    writeConfig(cfg);
  }

  if (await health(cfg)) {
    console.log(green('● ccgw is already running'));
    printInfo(cfg);
    return true;
  }

  const claudePath = findClaude(cfg.claudePath);
  let auth = null;
  if (!process.env.CCGW_SKIP_AUTH_CHECK) {
    if (!claudePath) fail('Claude Code CLI not found. Install it (https://claude.com/claude-code), run `claude` and log in, then retry.');
    auth = claudeAuthStatus(claudePath);
    if (!auth?.loggedIn) fail('Claude Code CLI is not logged in. Run `claude` and /login first.');
  }

  if (args.includes('--foreground') || args.includes('-f')) {
    printInfo(cfg);
    const child = spawn(process.execPath, [SERVER], { stdio: 'inherit' });
    child.on('exit', (code) => process.exit(code ?? 0));
    process.on('SIGINT', () => child.kill('SIGINT'));
    return new Promise(() => {});
  }

  rotateLog();
  const out = fs.openSync(LOG_FILE, 'a');
  const child = spawn(process.execPath, [SERVER], { detached: true, stdio: ['ignore', out, out], windowsHide: true });
  fs.writeFileSync(PID_FILE, String(child.pid));
  child.unref();
  fs.closeSync(out);

  for (let i = 0; i < 60; i++) {
    await sleep(250);
    if (await health(cfg, 500)) {
      const who = auth ? `Claude Code: ${auth.email || auth.authMethod}` : 'auth check skipped';
      console.log(green('● ccgw started') + dim(`  (pid ${child.pid}, ${who})`));
      printInfo(cfg, { copied: !process.env.CCGW_NO_CLIPBOARD && copyToClipboard(cfg.apiKey) });
      return true;
    }
    if (!readPid()) break;
  }
  fail(`ccgw failed to start. Last log lines:\n${tail(20)}`);
}

async function stop({ quiet = false } = {}) {
  const cfg = readConfig();
  const pid = readPid();
  const running = await health(cfg);
  if (!pid && !running) {
    if (!quiet) console.log(dim('ccgw is not running'));
    try { fs.unlinkSync(PID_FILE); } catch {}
    return;
  }
  // Ask the server to shut down itself so it can close its Claude Code child
  // processes (Windows has no SIGTERM: a kill would orphan them).
  try {
    await fetch(`${baseUrl(cfg)}/admin/shutdown`, { method: 'POST', headers: { authorization: `Bearer ${cfg.apiKey}` }, signal: AbortSignal.timeout(3000) });
  } catch {}
  for (let i = 0; i < 30 && (readPid() || (await health(cfg, 300))); i++) await sleep(200);
  if (pid && readPid()) {
    try { process.kill(pid, IS_WIN ? undefined : 'SIGKILL'); } catch {}
  }
  try { fs.unlinkSync(PID_FILE); } catch {}
  console.log(red('■ ccgw stopped'));
}

async function status() {
  const cfg = readConfig();
  const h = await health(cfg);
  if (h) {
    console.log(green('● running') + dim(`  v${h.version || '?'} · pid ${readPid() ?? '?'} · ${h.sessions} active conversation(s) · ${h.warm} warm process(es)`));
    printInfo(cfg);
  } else {
    console.log(red('○ stopped') + dim('  — run `ccgw start`'));
  }
}

function tail(n) {
  try { return fs.readFileSync(LOG_FILE, 'utf8').trimEnd().split('\n').slice(-n).join('\n'); } catch { return ''; }
}

function logs(args) {
  console.log(tail(args.includes('-f') ? 50 : 200));
  if (!args.includes('-f')) return;
  let pos = fs.existsSync(LOG_FILE) ? fs.statSync(LOG_FILE).size : 0;
  setInterval(() => {
    let size;
    try { size = fs.statSync(LOG_FILE).size; } catch { return; }
    if (size < pos) pos = 0; // rotated
    if (size === pos) return;
    const fd = fs.openSync(LOG_FILE, 'r');
    const buf = Buffer.alloc(size - pos);
    fs.readSync(fd, buf, 0, buf.length, pos);
    fs.closeSync(fd);
    pos = size;
    process.stdout.write(buf);
  }, 500);
}

// Thrown instead of exiting so the interactive menu can report and carry on.
class CliError extends Error {}
function fail(msg) {
  throw new CliError(msg);
}

// ---------------------------------------------------------------- Claude Desktop

// Claude Desktop runs in one of two modes, each with its own data dir, so each
// keeps its own sign-in: "1p" (claude.ai account) and "3p" (third-party
// inference, the Claude-3p dir). The mode comes from `deploymentMode` in
// Claude-3p/claude_desktop_config.json. Switching from Desktop's UI goes
// through sign-out and wipes credentials; flipping the key while Desktop is
// closed switches without logging out.
const DESKTOP_DIR = desktop3pDir();
const DESKTOP_3P_CONFIG = path.join(DESKTOP_DIR, 'claude_desktop_config.json');
// Third-party profiles live in a "config library": _meta.json lists them and
// names the applied one. We add our own and leave the user's untouched.
const LIB_DIR = path.join(DESKTOP_DIR, 'configLibrary');
const META_FILE = path.join(LIB_DIR, '_meta.json');
const PROFILE_NAME = 'Claude Code (ccgw)';

const readJson = (f, fallback) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; } };

// Write via a temp file so a crash never leaves Desktop a truncated config.
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.ccgw-${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

const getMode = () => (readJson(DESKTOP_3P_CONFIG, {}).deploymentMode === '3p' ? '3p' : '1p');

function setMode(mode) {
  const conf = readJson(DESKTOP_3P_CONFIG, {});
  conf.deploymentMode = mode;
  writeJson(DESKTOP_3P_CONFIG, conf);
}

// Returns the path of our profile file, creating the library entry if needed.
function profilePath() {
  const meta = readJson(META_FILE, null) || { appliedId: '', entries: [] };
  if (!Array.isArray(meta.entries)) meta.entries = [];
  let entry = meta.entries.find((e) => e.name === PROFILE_NAME);
  if (!entry) {
    entry = { id: crypto.randomUUID(), name: PROFILE_NAME };
    meta.entries.push(entry);
    writeJson(META_FILE, meta);
  }
  return path.join(LIB_DIR, `${entry.id}.json`);
}

// Merges the gateway settings into our profile and selects it. Other keys
// (connectors, anything set in Desktop's settings UI) are kept.
function writeProfile(extra = {}) {
  const cfg = readConfig();
  const file = profilePath();
  writeJson(file, {
    ...readJson(file, {}),
    inferenceProvider: 'gateway',
    inferenceCredentialKind: 'static',
    inferenceGatewayBaseUrl: baseUrl(cfg),
    inferenceGatewayApiKey: cfg.apiKey,
    inferenceGatewayAuthScheme: 'bearer',
    ...extra,
  });
  const meta = readJson(META_FILE, { entries: [] });
  meta.appliedId = meta.entries.find((e) => e.name === PROFILE_NAME).id;
  writeJson(META_FILE, meta);
}

// ---------------------------------------------------------------- connectors

// Remote MCP servers that authenticate with OAuth dynamic client registration:
// Desktop registers itself and opens the provider's sign-in page on Connect.
const CONNECTOR_PRESETS = {
  clickup: { url: 'https://mcp.clickup.com/mcp', label: 'ClickUp' },
  linear: { url: 'https://mcp.linear.app/mcp', label: 'Linear' },
  notion: { url: 'https://mcp.notion.com/mcp', label: 'Notion' },
  atlassian: { url: 'https://mcp.atlassian.com/v1/mcp', label: 'Atlassian (Jira, Confluence)' },
  sentry: { url: 'https://mcp.sentry.dev/mcp', label: 'Sentry' },
  // Figma only lets allowlisted client names register ("Claude Desktop" is not,
  // "Claude Code" is), so ccgw registers the client and hands Desktop its id.
  figma: {
    url: 'https://mcp.figma.com/mcp',
    label: 'Figma',
    register: {
      endpoint: 'https://api.figma.com/v1/oauth/mcp/register', issuer: 'https://api.figma.com',
      clientName: 'Claude Code', scope: 'mcp:connect', port: 53282,
    },
  },
  // Google's own Gmail MCP server only serves projects enrolled in its Workspace
  // Developer Preview, so Gmail runs locally (src/gmail.mjs) over the Gmail API.
  gmail: { label: 'Gmail', example: 'summarize my unread Gmail from today', local: 'gmail' },
  // Starter-plan Figma allows only a few remote MCP calls a month; this drives
  // Figma Desktop through a plugin instead (src/figma.mjs), with no such limit.
  'figma-local': { label: 'Figma (local, no limits)', example: 'what is selected in Figma?', local: 'figma' },
};

const GMAIL_HELP = `Gmail needs your own Google OAuth client (Google has no automatic registration):
    1. console.cloud.google.com → pick or create a project
    2. Enable the Gmail API: gcloud services enable gmail.googleapis.com
       (or APIs & Services → Library → Gmail API)
    3. OAuth consent screen → External → add yourself under Test users
       (or Publish the app so sign-in does not expire after 7 days)
    4. Credentials → Create credentials → OAuth client ID → type "Desktop app" → download JSON
    5. ccgw connector add gmail --client-json ~/Downloads/client_secret_….json
       or: ccgw connector add gmail --client-id <id> --client-secret <secret>`;

// Reads --client-id/--client-secret or Google's downloaded client JSON.
function clientCredentials(args) {
  const file = flag(args, '--client-json');
  if (file) {
    const j = readJson(file.replace(/^~(?=[\\/]|$)/, os.homedir()), null);
    const c = j?.installed || j?.web || j;
    if (!c?.client_id) fail(`${file}: no client_id found (expected the JSON downloaded from Google Cloud → Credentials)`);
    return { clientId: c.client_id, clientSecret: c.client_secret };
  }
  const clientId = flag(args, '--client-id');
  return clientId ? { clientId, clientSecret: flag(args, '--client-secret') } : null;
}

// Signs in when given a client (or when nothing is signed in yet) and returns the account.
async function ensureGmail(args, { force = false } = {}) {
  const creds = clientCredentials(args);
  const saved = readGmail();
  if (!force && !creds && saved?.refreshToken) return saved.email;
  const client = creds || (saved?.clientId && saved);
  if (!client) fail(GMAIL_HELP);
  try {
    return await gmailLogin(client);
  } catch (e) {
    fail(e.message);
  }
}

// A PATH entry for this same node (/opt/homebrew/bin/node) survives upgrades that
// move the versioned binary (…/Cellar/node/26.8.1/bin/node).
function stableNode() {
  const real = (f) => { try { return fs.realpathSync(f); } catch { return null; } };
  const self = real(process.execPath);
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    const f = path.join(dir, path.basename(process.execPath));
    if (path.isAbsolute(f) && f !== process.execPath && real(f) === self) return f;
  }
  return process.execPath;
}

// Desktop launches the stdio server itself: node + this script, absolute paths.
const localEntry = (name, command) => ({
  name,
  transport: 'stdio',
  command: stableNode(),
  args: [path.join(ROOT, 'bin', 'ccgw.mjs'), command, 'mcp'],
  ...(process.env.CCGW_HOME && { env: { CCGW_HOME: HOME_DIR } }),
});

async function gmail(args) {
  const [sub = 'status'] = args;
  if (sub === 'mcp') return serveGmail();
  if (sub === 'login') return console.log(green(`✓ Gmail signed in as ${await ensureGmail(args, { force: true })}`));
  if (sub === 'logout') { gmailLogout(); return console.log(green('✓ Gmail signed out') + dim(`  (removed ${GMAIL_FILE})`)); }
  if (sub === 'status') {
    const g = readGmail();
    return console.log(g?.refreshToken ? `Gmail: ${cyan(g.email)} ${dim(`(${GMAIL_FILE})`)}` : dim('Gmail: not signed in — ccgw connector add gmail'));
  }
  fail(`unknown command: ccgw gmail ${sub}`);
}

const FIGMA_PLUGIN_HELP = () => `${bold('Load the plugin in Figma Desktop')} ${dim('(once)')}
    1. Open any design file → menu Plugins → Development → Import plugin from manifest…
    2. Pick ${cyan(PLUGIN_MANIFEST)}
    3. Run Plugins → Development → ${cyan('ccgw Figma Bridge')} in the file you want Claude to see
       (it connects by itself and reconnects when Desktop restarts)`;

function setupFigma() {
  try {
    installFigma({ log: (m) => console.log(dim(`  ${m}`)) });
  } catch (e) {
    fail(e.message);
  }
}

async function figma(args) {
  const [sub = 'status'] = args;
  if (sub === 'mcp') return serveFigma();
  if (sub === 'install' || sub === 'plugin') {
    setupFigma();
    return console.log(`${green('✓ Figma bridge installed')}\n\n  ${FIGMA_PLUGIN_HELP()}`);
  }
  if (sub === 'status') {
    const s = await figmaStatus();
    if (!s.relay) return console.log(dim(`Figma: relay not running on :${RELAY_PORT} — it starts with Claude Desktop once \`ccgw connector add figma-local\` is set`));
    if (!s.plugin) return console.log(`Figma: relay ${green('up')} on :${RELAY_PORT}, plugin ${red('not connected')} ${dim('— run ccgw Figma Bridge in Figma Desktop')}`);
    return console.log(`Figma: relay ${green('up')}, plugin ${green('connected')} ${dim(`(page "${s.page}")`)}`);
  }
  fail(`unknown command: ccgw figma ${sub}`);
}

// Registers a client with the provider and returns Desktop's pre-registered oauth block.
async function registerClient({ endpoint, issuer, clientName, scope, port }) {
  const r = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: clientName,
      redirect_uris: [`http://127.0.0.1:${port}/callback`],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'client_secret_post',
      scope,
    }),
    signal: AbortSignal.timeout(15000),
  }).catch((e) => fail(`client registration failed: ${e.message}`));
  const body = await r.json().catch(() => null);
  if (!r.ok || !body?.client_id) fail(`client registration failed (HTTP ${r.status})`);
  // Desktop drops an entry with a client secret unless it names the issuer.
  return { clientId: body.client_id, clientSecret: body.client_secret, authorizationServer: [issuer], callbackPort: port, scope };
}

const connectors = () => readJson(profilePath(), {}).managedMcpServers || [];

// Re-adding a connector keeps its permission setting; --allow skips prompts for it.
function keepPolicy(entry, list, args) {
  const prev = list.find((c) => c.name === entry.name)?.toolPolicy;
  const toolPolicy = args.includes('--allow') ? ALLOW_ALL : prev;
  return toolPolicy ? { ...entry, toolPolicy } : entry;
}

function flag(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

// toolPolicy {"*": "allow"} on an entry makes Desktop run its tools without the
// "Claude wants to use …" prompt. bypassPermissions in our config applies it to
// every connector, including ones added later.
const ALLOW_ALL = { '*': 'allow' };
const bypassAll = () => !!readConfig().bypassPermissions;
const bypassed = (c) => c.toolPolicy?.['*'] === 'allow';

async function applyConnectors(list, args) {
  if (bypassAll()) list = list.map((c) => ({ ...c, toolPolicy: ALLOW_ALL }));
  const restart = !args.includes('--no-restart');
  const write = () => writeProfile({ managedMcpServers: list });
  if (restart) await withDesktopClosed(write);
  else write();
  return restart;
}

async function connector(args) {
  if (!desktopSupported) fail('Claude Desktop is only available on macOS and Windows.');
  const [sub = 'list', name] = args;
  const list = connectors();

  if (sub === 'list') {
    if (!list.length) console.log(dim('No connectors. Add one with: ccgw connector add clickup'));
    for (const c of list) console.log(`  ${cyan(c.name.padEnd(12))} ${c.url || [c.command, ...(c.args || [])].join(' ')} ${dim(c.oauth ? '(OAuth)' : c.transport === 'stdio' ? '(local)' : '')}${bypassed(c) ? ' ' + green('no prompts') : ''}`);
    console.log(dim(`\n  presets: ${Object.keys(CONNECTOR_PRESETS).join(', ')}`));
    return;
  }

  if (sub === 'add') {
    if (!name) fail('usage: ccgw connector add <preset> | ccgw connector add <name> --url <https://…/mcp> [--header "K: V"] [--no-oauth]');
    const preset = CONNECTOR_PRESETS[name.toLowerCase()];
    if (preset?.local && !flag(args, '--url')) {
      const id = name.toLowerCase();
      const detail = preset.local === 'gmail' ? await ensureGmail(args) : (setupFigma(), 'Figma Desktop plugin');
      const restarted = await applyConnectors([...list.filter((c) => c.name !== id), keepPolicy(localEntry(id, preset.local), list, args)], args);
      console.log(green(`✓ connector "${id}" added`) + dim(`  (${detail}, runs locally via ccgw)`));
      console.log(dim(restarted ? '  Claude Desktop restarted' : '  Restart Claude Desktop to load it') + dim(` — no Connect step needed; ask e.g. "${preset.example}"`));
      if (preset.local === 'figma') console.log(`\n  ${FIGMA_PLUGIN_HELP()}\n`);
      if (getMode() !== '3p') console.log(dim('  Note: Desktop is in login mode; connectors apply in gateway mode (ccgw desktop gateway).'));
      return;
    }
    const url = flag(args, '--url') || preset?.url;
    if (!url) fail(`unknown preset "${name}". Presets: ${Object.keys(CONNECTOR_PRESETS).join(', ')} — or pass --url`);
    if (!/^https:\/\//.test(url)) fail('--url must be an https:// MCP endpoint');
    const entry = { name: name.toLowerCase(), transport: flag(args, '--transport') || 'http', url };
    const header = flag(args, '--header');
    if (header) {
      const [k, ...v] = header.split(':');
      entry.headers = { [k.trim()]: v.join(':').trim() };
    }
    if (!args.includes('--no-oauth') && !header) entry.oauth = true;
    if (entry.oauth && preset?.register && !flag(args, '--url')) {
      // Reuse the client from an earlier add so Desktop keeps its sign-in.
      const prev = list.find((c) => c.name === entry.name && c.url === url)?.oauth;
      entry.oauth = prev?.clientId
        ? { ...prev, authorizationServer: [preset.register.issuer] }
        : await registerClient(preset.register);
    }
    const next = [...list.filter((c) => c.name !== entry.name), keepPolicy(entry, list, args)];
    const restarted = await applyConnectors(next, args);
    console.log(green(`✓ connector "${entry.name}" added`) + dim(`  (${url})`));
    console.log(entry.oauth ? connectGuide(preset?.label || entry.name, restarted, preset?.example) : dim(restarted ? '  Claude Desktop restarted.' : '  Restart Claude Desktop to load it.'));
    if (getMode() !== '3p') console.log(dim('  Note: Desktop is in login mode; connectors apply in gateway mode (ccgw desktop gateway).'));
    return;
  }

  if (sub === 'remove' || sub === 'rm') {
    if (!list.some((c) => c.name === name)) fail(`no connector named "${name}"`);
    await applyConnectors(list.filter((c) => c.name !== name), args);
    console.log(green(`✓ connector "${name}" removed`));
    return;
  }
  fail(`unknown command: ccgw connector ${sub}`);
}

async function permissions(args) {
  if (!desktopSupported) fail('Claude Desktop is only available on macOS and Windows.');
  const [sub = 'status', name] = args;
  const list = connectors();
  if (sub === 'status') {
    console.log(bypassAll()
      ? `Permission prompts: ${green('bypassed')} for every connector ${dim('(ccgw permissions ask to turn back on)')}`
      : `Permission prompts: ${cyan('on')} ${dim('(ccgw permissions bypass to skip them)')}`);
    for (const c of list) console.log(`  ${c.name.padEnd(12)} ${bypassed(c) ? green('no prompts') : dim('asks before each tool')}`);
    return;
  }
  if (sub !== 'bypass' && sub !== 'ask') fail(`unknown command: ccgw permissions ${sub} (bypass | ask [connector])`);
  const allow = sub === 'bypass';
  if (name && !name.startsWith('--')) {
    if (!list.some((c) => c.name === name)) fail(`no connector named "${name}"`);
    if (!allow && bypassAll()) fail('prompts are bypassed for every connector — run `ccgw permissions ask` first');
  } else {
    const cfg = readConfig();
    cfg.bypassPermissions = allow;
    writeConfig(cfg);
  }
  const next = list.map((c) => {
    if (name && !name.startsWith('--') && c.name !== name) return c;
    const { toolPolicy, ...rest } = c;
    return allow ? { ...rest, toolPolicy: ALLOW_ALL } : rest;
  });
  const restarted = await applyConnectors(next, args);
  const what = name && !name.startsWith('--') ? `"${name}"` : 'every connector';
  console.log(allow
    ? green(`✓ ${what} now runs its tools without asking`) + dim('  (Desktop no longer shows "Claude wants to use …")')
    : green(`✓ ${what} asks before each tool again`));
  console.log(dim(restarted ? '  Claude Desktop restarted' : '  Restart Claude Desktop to apply it'));
  if (allow) console.log(dim('  Note: tools then act without confirmation — including sending email or editing Figma.'));
}

function connectGuide(label, restarted, example = `list my ${label.split(' ')[0]} tasks`) {
  return `
  ${bold(`Sign in to ${label}`)} ${dim(restarted ? '(Claude Desktop was restarted)' : '(restart Claude Desktop first)')}
    1. Claude Desktop → Settings → Connectors
    2. Click ${cyan(label.split(' ')[0].toLowerCase())} → ${cyan('Connect')}
    3. Your browser opens ${label}'s sign-in page → log in → ${cyan('Allow')}
    4. Back in Desktop the connector shows as connected; ask e.g. "${example}"
  ${dim('If the provider issues no refresh token (ClickUp: 24h), Desktop asks you to Connect again when it expires.')}
  ${dim('To sign out: Settings → Connectors → ' + label.split(' ')[0].toLowerCase() + ' → Disconnect.')}
`;
}

// Desktop rewrites its config on quit, so edits happen while it is closed.
async function withDesktopClosed(fn) {
  await quitDesktop();
  fn();
  if (!(await openDesktop())) console.log(dim('  (could not reopen Claude Desktop — start it manually)'));
}

async function desktop(args) {
  if (!desktopSupported) fail('Claude Desktop is only available on macOS and Windows.');
  const sub = args[0] || 'status';
  if (sub === 'status' || sub === 'mode') {
    const meta = readJson(META_FILE, { entries: [] });
    const profile = meta.entries?.find((e) => e.id === meta.appliedId)?.name;
    console.log(getMode() === '3p'
      ? `Claude Desktop: ${cyan('gateway')} mode${profile ? dim(`  (profile: ${profile})`) : ''}`
      : `Claude Desktop: ${cyan('login')} mode ${dim('(claude.ai account)')}`);
    return;
  }
  if (sub === 'login') {
    await withDesktopClosed(() => setMode('1p'));
    console.log(green('✓ Claude Desktop switched to login mode') + dim('  (your claude.ai session is kept)'));
    return;
  }
  if (sub === 'gateway') {
    await start([]);
    await withDesktopClosed(() => { writeProfile(); setMode('3p'); });
    console.log(green('✓ Claude Desktop switched to gateway mode') + dim(`  (profile: ${PROFILE_NAME})`));
    return;
  }
  if (sub === 'toggle') return desktop([getMode() === '3p' ? 'login' : 'gateway']);
  if (sub === 'profile') {
    writeProfile();
    console.log(green(`✓ profile "${PROFILE_NAME}" written and selected`) + dim('  — restart Claude Desktop to apply'));
    return;
  }
  fail(`unknown command: ccgw desktop ${sub}`);
}

function help() {
  const art = logo(VERSION);
  console.log(`${art || `\n${bold('ccgw')} ${dim('v' + VERSION)} — use your Claude Code login as a gateway for Claude Desktop\n`}
  ccgw                         interactive menu (arrow keys + enter)
  ccgw start [--port N] [-f]   start in background (-f: foreground)
  ccgw stop                    stop the gateway
  ccgw restart                 stop + start
  ccgw status                  running state + connection info
  ccgw info                    print the values to paste into Claude Desktop
  ccgw copy url|key            copy base URL or API key to the clipboard
  ccgw rotate-key              generate a new API key (restart required)
  ccgw logs [-f]               show / follow the log
  ccgw update [--check]        install the latest release (--check: only report)

  ccgw desktop gateway         switch Claude Desktop to gateway mode (starts ccgw if needed)
  ccgw desktop login           switch Claude Desktop to claude.ai login mode
  ccgw desktop toggle          switch to the other mode
  ccgw desktop [status]        show the current mode
  (switching never logs you out: each mode keeps its own session)

  ccgw connector add clickup   add a connector to Claude Desktop (sign in via browser)
  ccgw connector add <name> --url <https://…/mcp>   any remote MCP server (OAuth)
  ccgw connector list | remove <name>
  ccgw permissions bypass [name]   skip Desktop's "Claude wants to use …" prompts (all connectors, or one)
  ccgw permissions ask [name]      prompt again;  ccgw permissions  shows the current setting
  ccgw connector add gmail --client-json <file>   Gmail via your Google OAuth client (runs locally)
  ccgw gmail status | login | logout               manage the Gmail sign-in
  ccgw connector add figma-local   Figma via a Figma Desktop plugin (no plan limits)
  ccgw figma status | plugin       check the bridge / print the plugin setup steps
  (presets: clickup, linear, notion, atlassian, sentry, figma, figma-local, gmail; --no-restart to skip restart)

  config: ${CONFIG_FILE}
`);
}

// ---------------------------------------------------------------- updates

async function update(args) {
  const latest = await checkForUpdate({ force: true, timeoutMs: 10000 }).catch((e) => fail(e.message));
  if (!isNewer(latest, VERSION)) {
    console.log(green(`✓ ccgw v${VERSION} is up to date`));
    return;
  }
  console.log(`${bold(`ccgw v${latest}`)} is available ${dim(`(installed: v${VERSION})`)}`);
  if (args.includes('--check')) {
    console.log(dim('  run `ccgw update` to install it'));
    return;
  }
  // A source checkout updates with git, not npm.
  if (fs.existsSync(path.join(ROOT, '.git'))) fail(`this ccgw runs from a git checkout (${ROOT}) — update it with git pull`);

  const cfg = readConfig();
  const h = await health(cfg);
  let restart = !!h;
  if (h?.sessions && !args.includes('--yes') && !args.includes('-y')) {
    const ok = interactive()
      ? !/^n/i.test(await prompt(`${h.sessions} conversation(s) in Claude Desktop will be interrupted by the restart. Restart now?`, { placeholder: '(Y/n)' }))
      : false;
    restart = ok;
  }

  if (installVersion(ROOT, latest) !== 0) fail('npm install failed — re-run the installer from the README');
  console.log(green(`✓ ccgw updated to v${latest}`));
  if (!h) return;
  if (!restart) {
    console.log(dim('  the running gateway is still the old version — run `ccgw restart` when convenient'));
    return;
  }
  // The files on disk are the new version now, so restart through them.
  await stop({ quiet: true });
  spawnSync(process.execPath, [path.join(ROOT, 'bin', 'ccgw.mjs'), 'start'], { stdio: 'inherit' });
}

// A one-line notice after a command, from a check made at most once a day.
async function updateNotice(pending) {
  const latest = await Promise.race([pending, sleep(2000).then(() => null)]).catch(() => null);
  if (latest && isNewer(latest, VERSION)) {
    console.error(`\n${cyan(`ccgw v${latest} is available`)} ${dim(`(installed: v${VERSION}) — run: ccgw update`)}`);
  }
}

function copyValue(what) {
  const cfg = readConfig();
  const isUrl = what === 'url';
  const v = isUrl ? baseUrl(cfg) : cfg.apiKey;
  console.log(copyToClipboard(v) ? green(`✓ copied ${isUrl ? 'base URL' : 'API key'}`) : v);
}

function rotateKey() {
  const cfg = readConfig();
  cfg.apiKey = newKey();
  writeConfig(cfg);
  console.log('new key generated — run `ccgw restart`, then `ccgw desktop gateway` (or update Claude Desktop by hand)');
}

async function run(cmd, args) {
  switch (cmd) {
    case 'start': return start(args);
    case 'stop': return stop();
    case 'restart': await stop({ quiet: true }); return start(args);
    case 'status': return status();
    case 'info': return printInfo(readConfig());
    case 'copy': return copyValue(args[0]);
    case 'rotate-key': return rotateKey();
    case 'logs': return logs(args);
    case 'desktop': return desktop(args);
    case 'connector': case 'connectors': return connector(args);
    case 'gmail': return gmail(args);
    case 'figma': return figma(args);
    case 'permissions': case 'perms': return permissions(args);
    case 'update': case 'upgrade': return update(args);
    case '-v': case '--version': case 'version': return console.log(VERSION);
    case 'menu': return menu();
    default: return help();
  }
}

// ---------------------------------------------------------------- interactive menu

async function menu() {
  if (!interactive()) return help();
  console.log(logo(VERSION) || `${bold('ccgw')} ${dim('v' + VERSION)}`);
  let last = 0;
  while (true) {
    const cfg = readConfig();
    const h = await health(cfg, 800);
    const up = !!h;
    const mode = desktopSupported ? (getMode() === '3p' ? 'gateway' : 'login') : null;
    const names = connectors().map((c) => c.name);
    const latest = cachedLatest();
    const outdated = isNewer(latest, VERSION);
    const header = panel([
      ['Gateway', up
        ? `${green('● running')}  ${dim(baseUrl(cfg))}${h.sessions ? dim(` · ${h.sessions} chat${h.sessions > 1 ? 's' : ''}`) : ''}`
        : `${red('○ stopped')}  ${dim('Claude Desktop cannot answer until it starts')}`],
      ...(desktopSupported ? [
        ['Desktop', mode === 'gateway' ? `${accent('◆')} gateway mode ${dim('(uses Claude Code)')}` : `◇ login mode ${dim('(claude.ai account)')}`],
        ['Connectors', names.length ? names.slice(0, 4).join(dim(', ')) + (names.length > 4 ? dim(` +${names.length - 4}`) : '') : dim('none')],
        ['Permissions', bypassAll() ? `${accent('bypassed')} ${dim('· tools run without asking')}` : `prompts on ${dim('· Desktop asks before each tool')}`],
      ] : []),
      ['Version', `v${VERSION}  ${outdated ? accent(`v${latest} available`) : dim('up to date')}`],
    ]);
    const items = [
      { section: 'Gateway' },
      up ? { label: 'Stop', value: 'stop' } : { label: 'Start', value: 'start', hint: 'needed for gateway mode' },
      { label: 'Restart', value: 'restart', disabled: !up },
      { label: 'Connection info', value: 'info', hint: 'URL + key for Claude Desktop' },
      ...(desktopSupported ? [
        { section: 'Claude Desktop' },
        { label: 'Switch mode…', value: 'desktop', hint: mode === 'gateway' ? 'to claude.ai login' : 'to gateway' },
        { label: 'Connectors…', value: 'connectors', hint: `${names.length} added` },
        bypassAll()
          ? { label: 'Permission prompts: off', value: 'perms-ask', hint: 'turn back on (restarts Desktop)' }
          : { label: 'Permission prompts: on', value: 'perms-bypass', hint: 'bypass for all connectors (restarts Desktop)' },
      ] : []),
      { section: 'ccgw' },
      outdated
        ? { label: `Update to v${latest}`, value: 'update', hint: `installed v${VERSION}` }
        : { label: 'Check for updates', value: 'check' },
      { label: 'Quit', value: 'quit' },
    ];
    const choice = await select(header, items, { initial: last });
    if (choice === null || choice === 'quit') return;
    last = items.findIndex((it) => it.value === choice);
    try {
      switch (choice) {
        case 'start': await start([]); break;
        case 'stop': await stop(); break;
        case 'restart': await stop({ quiet: true }); await start([]); break;
        case 'info': printInfo(cfg); break;
        case 'desktop': await desktopMenu(mode); break;
        case 'connectors': await connectorMenu(); break;
        case 'perms-bypass': await permissions(['bypass']); break;
        case 'perms-ask': await permissions(['ask']); break;
        case 'update': await update([]); return;
        case 'check': {
          const latest = await checkForUpdate({ force: true, timeoutMs: 10000 }).catch((e) => fail(e.message));
          console.log(isNewer(latest, VERSION)
            ? `${bold(`ccgw v${latest}`)} is available ${dim(`(installed: v${VERSION}) — pick "Update to v${latest}" below`)}`
            : green(`✓ ccgw v${VERSION} is up to date`));
          break;
        }
      }
    } catch (e) {
      if (!(e instanceof CliError)) throw e;
      console.error(red('✗ ' + e.message));
    }
    console.log('');
  }
}

async function desktopMenu(mode) {
  const choice = await select('Claude Desktop', [
    { label: 'Use gateway (Claude Code)', value: 'gateway', hint: mode === 'gateway' ? 'current' : '' },
    { label: 'Use claude.ai login', value: 'login', hint: mode === 'login' ? 'current' : '' },
    { label: 'Back', value: null },
  ], { initial: mode === 'gateway' ? 1 : 0 });
  if (choice) await desktop([choice]);
}

async function connectorMenu() {
  const added = connectors();
  const preset = ([id, p]) => ({
    label: p.label,
    value: `add:${id}`,
    hint: added.some((c) => c.name === id) ? green('✓ added') : '',
  });
  const presets = Object.entries(CONNECTOR_PRESETS);
  const choice = await select(`${bold('Connectors')}  ${dim(`${added.length} added · pick one to add or re-add it`)}`, [
    { section: 'Sign in via browser' },
    ...presets.filter(([, p]) => !p.local).map(preset),
    { label: 'Other MCP server (URL)…', value: 'custom' },
    { section: 'Runs on this machine' },
    ...presets.filter(([, p]) => p.local).map(preset),
    { section: 'Manage' },
    { label: 'Remove a connector…', value: 'remove', disabled: !added.length },
    { label: 'List connectors', value: 'list' },
    { label: 'Back', value: null },
  ]);
  if (!choice) return;
  if (choice.startsWith('add:')) {
    const id = choice.slice(4);
    const preset = CONNECTOR_PRESETS[id];
    if (preset.local === 'gmail' && !readGmail()?.refreshToken) {
      console.log(dim(`\n  ${GMAIL_HELP}\n`));
      const file = await prompt('Client JSON file (or leave empty to type the ID):', { placeholder: '(~/Downloads/client_secret_….json)' });
      if (file) return connector(['add', id, '--client-json', file]);
      const clientId = await prompt('OAuth client ID:');
      if (!clientId) return;
      const clientSecret = await prompt('Client secret:');
      return connector(['add', id, '--client-id', clientId, ...(clientSecret ? ['--client-secret', clientSecret] : [])]);
    }
    return connector(['add', id]);
  }
  if (choice === 'list') return connector(['list']);
  if (choice === 'custom') {
    const url = await prompt('MCP server URL:', { placeholder: '(https://…/mcp)' });
    if (!url) return;
    const guess = (() => { try { return new URL(url).hostname.replace(/^(mcp|api)\./, '').split('.')[0]; } catch { return ''; } })();
    const name = (await prompt('Name:', { placeholder: guess ? `(${guess})` : '' })) || guess;
    if (!name) return;
    return connector(['add', name, '--url', url]);
  }
  if (choice === 'remove') {
    const name = await select('Remove which connector?', [
      ...added.map((c) => ({ label: c.name, value: c.name, hint: c.url || '' })),
      { label: 'Back', value: null },
    ]);
    if (name) await connector(['remove', name]);
  }
}

const [cmd, ...args] = process.argv.slice(2);
const command = cmd ?? (interactive() ? 'menu' : 'help');
// Only people at a terminal see the notice; scripts and pipes stay quiet.
const noticeFor = process.stderr.isTTY && !['update', 'upgrade', 'logs', '-v', '--version', 'version'].includes(command);
const pendingUpdate = noticeFor || command === 'menu' ? checkForUpdate() : null;
try {
  // The menu shows an "Update" item, so give a fresh check a moment to land.
  if (command === 'menu') await Promise.race([pendingUpdate, sleep(1500)]);
  await run(command, args);
  if (noticeFor && command !== 'menu') await updateNotice(pendingUpdate);
} catch (e) {
  if (!(e instanceof CliError)) throw e;
  console.error(red('✗ ' + e.message));
  process.exit(1);
}
