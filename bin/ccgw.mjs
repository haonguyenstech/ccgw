#!/usr/bin/env node
// ccgw — start/stop a local Anthropic-compatible gateway backed by Claude Code.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readConfig, writeConfig, newKey, PID_FILE, LOG_FILE, CONFIG_FILE } from '../src/config.mjs';
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
  console.error(red('✗ ccgw failed to start. Last log lines:'));
  console.error(tail(20));
  process.exit(1);
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

function fail(msg) {
  console.error(red('✗ ' + msg));
  process.exit(1);
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
};

const connectors = () => readJson(profilePath(), {}).managedMcpServers || [];

function flag(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function applyConnectors(list, args) {
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
    for (const c of list) console.log(`  ${cyan(c.name.padEnd(12))} ${c.url || c.command || ''} ${dim(c.oauth ? '(OAuth)' : '')}`);
    console.log(dim(`\n  presets: ${Object.keys(CONNECTOR_PRESETS).join(', ')}`));
    return;
  }

  if (sub === 'add') {
    if (!name) fail('usage: ccgw connector add <preset> | ccgw connector add <name> --url <https://…/mcp> [--header "K: V"] [--no-oauth]');
    const preset = CONNECTOR_PRESETS[name.toLowerCase()];
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
    const next = [...list.filter((c) => c.name !== entry.name), entry];
    const restarted = await applyConnectors(next, args);
    console.log(green(`✓ connector "${entry.name}" added`) + dim(`  (${url})`));
    console.log(entry.oauth ? connectGuide(preset?.label || entry.name, restarted) : dim(restarted ? '  Claude Desktop restarted.' : '  Restart Claude Desktop to load it.'));
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

function connectGuide(label, restarted) {
  return `
  ${bold(`Sign in to ${label}`)} ${dim(restarted ? '(Claude Desktop was restarted)' : '(restart Claude Desktop first)')}
    1. Claude Desktop → Settings → Connectors
    2. Click ${cyan(label.split(' ')[0].toLowerCase())} → ${cyan('Connect')}
    3. Your browser opens ${label}'s sign-in page → log in → ${cyan('Allow')}
    4. Back in Desktop the connector shows as connected; ask e.g. "list my ${label.split(' ')[0]} tasks"
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
  console.log(`
${bold('ccgw')} ${dim('v' + VERSION)} — use your Claude Code login as a gateway for Claude Desktop

  ccgw start [--port N] [-f]   start in background (-f: foreground)
  ccgw stop                    stop the gateway
  ccgw restart                 stop + start
  ccgw status                  running state + connection info
  ccgw info                    print the values to paste into Claude Desktop
  ccgw copy url|key            copy base URL or API key to the clipboard
  ccgw rotate-key              generate a new API key (restart required)
  ccgw logs [-f]               show / follow the log

  ccgw desktop gateway         switch Claude Desktop to gateway mode (starts ccgw if needed)
  ccgw desktop login           switch Claude Desktop to claude.ai login mode
  ccgw desktop toggle          switch to the other mode
  ccgw desktop [status]        show the current mode
  (switching never logs you out: each mode keeps its own session)

  ccgw connector add clickup   add a connector to Claude Desktop (sign in via browser)
  ccgw connector add <name> --url <https://…/mcp>   any remote MCP server (OAuth)
  ccgw connector list | remove <name>
  (presets: clickup, linear, notion, atlassian, sentry; --no-restart to skip restart)

  config: ${CONFIG_FILE}
`);
}

const [cmd = 'help', ...args] = process.argv.slice(2);
switch (cmd) {
  case 'start': await start(args); break;
  case 'stop': await stop(); break;
  case 'restart': await stop({ quiet: true }); await start(args); break;
  case 'status': await status(); break;
  case 'info': printInfo(readConfig()); break;
  case 'copy': {
    const cfg = readConfig();
    const isUrl = args[0] === 'url';
    const v = isUrl ? baseUrl(cfg) : cfg.apiKey;
    console.log(copyToClipboard(v) ? `copied ${isUrl ? 'base URL' : 'API key'}` : v);
    break;
  }
  case 'rotate-key': {
    const cfg = readConfig();
    cfg.apiKey = newKey();
    writeConfig(cfg);
    console.log('new key generated — run `ccgw restart`, then `ccgw desktop gateway` (or update Claude Desktop by hand)');
    break;
  }
  case 'logs': logs(args); break;
  case 'desktop': await desktop(args); break;
  case 'connector': case 'connectors': await connector(args); break;
  case '-v': case '--version': case 'version': console.log(VERSION); break;
  default: help();
}
