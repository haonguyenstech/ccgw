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
import { installFigma, serveFigma, figmaStatus, registerPlugin, pluginRegistered, PLUGIN_MANIFEST, RELAY_PORT } from '../src/figma.mjs';
import { latestVersion, requirements, supportsPlatform, refigmaEntry, entryVersion, probe, findPython, installPython } from '../src/refigma.mjs';
import { interactive, select, checklist, prompt, panel, accent, banner, callout, NEWS, ago, screen, lastLines } from '../src/menu.mjs';
import { syncSupported, officialCookies, cachedSession, cacheSession, claudeAi, gatewayStore, writeSession, removeSession, sessionUntouched, sessionExists, writeSpace, officialSkills, installSkills, installedSkills,
  gatewaySessions, gatewaySpaces, gatewayUserSkills, zipSkill, unzipSkill,
  readTurns, continuedTurns, unansweredQuestion, handoffFacts, briefPrompt, handoffDoc, handoffDocName, looksVietnamese } from '../src/sync.mjs';
import { logo } from '../src/logo.mjs';
import { provider, claudeToken, timeLeft, statusLine, loginRunning, openLogin } from '../src/credential.mjs';
import { checkForUpdate, cachedLatest, isNewer, installVersion } from '../src/update.mjs';
import {
  IS_WIN, sleep, findClaude, claudeAuthStatus, copyToClipboard,
  desktop3pDir, desktopSupported, quitDesktop, openDesktop, desktopRunning,
  officialSupported, officialDir, officialDirCandidates, officialProcDirs, officialRunning, openOfficial, quitOfficial,
} from '../src/platform.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'src', 'server.mjs');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = (s) => c(1, s), dim = (s) => c(2, s), green = (s) => c(32, s), red = (s) => c(31, s), cyan = (s) => c(36, s);

const RELEASES_URL = 'https://github.com/haonguyenstech/ccgw/releases';
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

// soft: a missing Claude Code login is a warning, not an error. Desktop can
// open on the gateway before anyone signs in; replies need the login.
async function start(args = [], { soft = false, quiet = false } = {}) {
  const cfg = readConfig();
  const portArg = args.indexOf('--port');
  if (portArg >= 0) {
    const port = Number(args[portArg + 1]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) fail('--port needs a number between 1 and 65535');
    cfg.port = port;
    writeConfig(cfg);
  }

  if (await health(cfg)) {
    console.log(green('● ccgw is already running') + (quiet ? dim(`  ${baseUrl(cfg)}`) : ''));
    if (!quiet) printInfo(cfg);
    return true;
  }

  const claudePath = findClaude(cfg.claudePath);
  let auth = null;
  if (!process.env.CCGW_SKIP_AUTH_CHECK) {
    const warn = (msg) => {
      if (!soft) fail(msg);
      console.log(`${accent('!')} ${msg.replace(/ first\.$|, then retry\.$/, '.')} ${dim('Desktop opens anyway; replies need it (then `ccgw restart`).')}`);
    };
    if (!claudePath) warn('Claude Code CLI not found. Install it (https://claude.com/claude-code), run `claude` and log in, then retry.');
    else {
      auth = claudeAuthStatus(claudePath);
      const cred = provider(cfg);
      if (!auth?.loggedIn) warn(cred
        ? `Claude Code CLI is not logged in. Sign in with ${cred.name}: ccgw credential login`
        : 'Claude Code CLI is not logged in. Run `claude` and /login first.');
      if (!auth?.loggedIn) auth = null;
    }
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
      const who = auth ? `Claude Code: ${auth.email || auth.authMethod}` : process.env.CCGW_SKIP_AUTH_CHECK ? 'auth check skipped' : 'not logged in';
      console.log(green('● ccgw started') + dim(`  (pid ${child.pid}, ${who})`));
      if (!quiet) printInfo(cfg, { copied: !process.env.CCGW_NO_CLIPBOARD && copyToClipboard(cfg.apiKey) });
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
  if (provider(cfg)) credential(['status']);
}

// ---------------------------------------------------------------- credential provider

// "3h 12m left" in green, under an hour in the accent color, red once expired.
function loginLeft() {
  const t = claudeToken();
  if (!t) return red('no Claude Code login');
  const left = timeLeft(t.expiresAt);
  if (left === 'expired') return red('login expired');
  return t.expiresAt - Date.now() < 3_600_000 ? accent(`${left} left`) : green(`${left} left`);
}

// Runs the provider's login in this terminal and comes back when it exits. Ctrl+C
// goes to the login (it shares the terminal), not to ccgw, so the menu carries on.
async function runLoginHere(p) {
  console.log(dim(`  running ${p.login} — it keeps the login current while it runs; quit it to return\n`));
  const ignore = () => {};
  process.on('SIGINT', ignore);
  try {
    const [cmd, cmdArgs] = IS_WIN ? ['cmd.exe', ['/d', '/s', '/c', p.login]] : [process.env.SHELL || '/bin/sh', ['-lc', p.login]];
    const code = await new Promise((resolve) => {
      const child = spawn(cmd, cmdArgs, { stdio: 'inherit' });
      child.on('error', () => resolve(-1));
      child.on('exit', (c, sig) => resolve(sig ? 0 : c));
    });
    if (code === -1) fail(`could not run ${p.login}`);
    console.log('');
    console.log(code ? red(`✗ ${p.name} exited with code ${code}`) : `${p.name} ended · ${loginLeft()}`);
  } finally {
    process.off('SIGINT', ignore);
  }
}

const CREDENTIAL_HELP = `usage: ccgw credential set --login "<command>" [--name <label>] [--status "<command>"] [--auto-login] [--renew-minutes N]
       ccgw credential status | login [--window] | auto on|off | unset`;

async function credential(args) {
  const [sub = 'status'] = args;
  const cfg = readConfig();
  const p = provider(cfg);
  if (sub === 'set') {
    const login = flag(args, '--login');
    if (!login) fail(CREDENTIAL_HELP);
    const renew = flag(args, '--renew-minutes');
    cfg.credential = {
      ...cfg.credential,
      login,
      ...(flag(args, '--name') && { name: flag(args, '--name') }),
      ...(flag(args, '--status') && { status: flag(args, '--status') }),
      ...(renew && { renewMinutes: Number(renew) }),
      ...(args.includes('--auto-login') && { autoLogin: true }),
    };
    writeConfig(cfg);
    console.log(green(`✓ credential provider set: ${provider(cfg).name}`) + dim('  — run `ccgw restart` so the gateway picks it up'));
    return;
  }
  if (sub === 'unset') {
    delete cfg.credential;
    writeConfig(cfg);
    return console.log(green('✓ credential provider removed') + dim('  — run `ccgw restart`'));
  }
  if (!p) {
    if (sub === 'status') return console.log(dim(`Credential: Claude Code's own login (${loginLeft()}). To have ccgw open another sign-in tool:\n  ${CREDENTIAL_HELP.split('\n')[0].replace('usage: ', '')}`));
    fail(`no credential provider set.
  ${CREDENTIAL_HELP}`);
  }
  if (sub === 'status') {
    const who = statusLine(p);
    const live = loginRunning(p);
    console.log(`Credential: ${cyan(p.name)}${who ? `  ${who}` : ''}  ·  ${loginLeft()}${live ? dim('  · sign-in window open') : ''}`);
    console.log(dim(`  auto sign-in ${p.autoLogin ? `on (${p.renewMinutes} min before expiry)` : 'off'} · login command: ${p.login}`));
    return;
  }
  if (sub === 'login') {
    if (loginRunning(p)) return console.log(dim(`${p.name} is already signing in — look for its terminal window.`));
    // At a terminal, run it right here; elsewhere (scripts, --window) open a new window.
    if (interactive() && !args.includes('--window')) return runLoginHere(p);
    if (!openLogin(p)) fail(`could not open a terminal window — run \`${p.login}\` yourself`);
    return console.log(green(`✓ opened ${p.name} sign-in in a new terminal window`) + dim('  — keep it open: it keeps the login current'));
  }
  if (sub === 'auto') {
    const on = args[1] === 'on' ? true : args[1] === 'off' ? false : fail('usage: ccgw credential auto on|off');
    cfg.credential.autoLogin = on;
    writeConfig(cfg);
    return console.log(green(`✓ auto sign-in ${on ? 'on' : 'off'}`) + dim('  — run `ccgw restart` to apply'));
  }
  fail(`unknown command: ccgw credential ${sub}\n  ${CREDENTIAL_HELP}`);
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
  // Reads any Figma link through a headless Edge signed in to figma.com (View seat
  // is enough) and returns HTML / React + Tailwind, SVG, tokens (src/refigma.mjs).
  refigma: { label: 'Figma links → code (refigma, any seat)', example: 'turn this Figma frame into React: <link>', local: 'refigma' },
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

const FIGMA_RUN = `Run ${cyan('Plugins → Development → ccgw Figma Bridge')} in the Figma file Claude should see
    ${dim('(Windows: Figma logo, top left → Plugins → Development; or Ctrl+/ and type "ccgw").')}
    ${dim('It connects by itself and reconnects when Desktop restarts; keep it open while you work.')}`;
const FIGMA_IMPORT = `Import it by hand: open a design file → Plugins → Development → Import plugin from manifest…
    → ${cyan(PLUGIN_MANIFEST)}`;

// Installs the bridge and puts the plugin into Figma Desktop, restarting Figma
// when it is open (asked first at a terminal; --restart-figma skips the question).
async function setupFigma(args = []) {
  try {
    installFigma({ log: (m) => console.log(dim(`  ${m}`)) });
  } catch (e) {
    fail(e.message);
  }
  let r = await registerPlugin();
  if (r === 'running') {
    const yes = args.includes('--restart-figma') || (interactive() &&
      !/^n/i.test(await prompt('Figma Desktop is open. Restart it to add the ccgw Figma Bridge plugin?', { placeholder: '(Y/n)' }) || ''));
    if (yes) r = await registerPlugin({ restart: true });
  }
  return r;
}

function figmaNextSteps(r) {
  const added = { added: 'added to Figma Desktop', restarted: 'added to Figma Desktop (Figma restarted)', already: 'already in Figma Desktop' }[r];
  if (added) return `${green('✓')} Plugin ${added}\n\n  ${FIGMA_RUN}`;
  if (r === 'running') return `${bold('Figma Desktop is open')}, so the plugin was not added (Figma rewrites its settings on quit).\n  Quit Figma and run ${cyan('ccgw figma plugin')} — or ${cyan('ccgw figma plugin --restart-figma')}.\n  ${dim(FIGMA_IMPORT)}`;
  return `${bold('Figma Desktop not found')} ${dim('(install it from figma.com/downloads)')}. Then run ${cyan('ccgw figma plugin')},\n  or ${FIGMA_IMPORT}`;
}

async function figma(args) {
  const [sub = 'status'] = args;
  if (sub === 'mcp') return serveFigma();
  if (sub === 'install' || sub === 'plugin') {
    const r = await setupFigma(args);
    return console.log(`${green('✓ Figma bridge installed')}\n  ${figmaNextSteps(r)}`);
  }
  if (sub === 'status') {
    const s = await figmaStatus();
    if (!s.relay) return console.log(dim(`Figma: relay not running on :${RELAY_PORT} — it starts with Claude Desktop once \`ccgw connector add figma-local\` is set`));
    if (!s.plugin) return console.log(`Figma: relay ${green('up')} on :${RELAY_PORT}, plugin ${red('not connected')} ${dim(pluginRegistered() ? '— run ccgw Figma Bridge in Figma Desktop' : '— not in Figma yet: ccgw figma plugin')}`);
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
  if (args.includes('--official')) return applyOfficialConnectors(list, args);
  if (bypassAll()) list = list.map((c) => ({ ...c, toolPolicy: ALLOW_ALL }));
  const restart = !args.includes('--no-restart');
  const write = () => writeProfile({ managedMcpServers: list });
  if (restart) await withDesktopClosed(write);
  else write();
  return restart;
}

// --official targets the claude.ai Desktop instead: local servers go in the
// mcpServers of its own config, so they never reach the gateway profile.
// Remote ones belong to the claude.ai account (its Settings → Connectors).
const OFFICIAL_CONFIG = path.join(officialDir(), 'claude_desktop_config.json');
const officialConnectors = () => Object.entries(readJson(OFFICIAL_CONFIG, {}).mcpServers || {}).map(([name, s]) => ({ name, ...s }));

// Desktop rewrites its config on quit, so a running official Desktop is closed
// for the write and opened again; quitting it keeps it signed in.
async function applyOfficialConnectors(list, args) {
  const mcpServers = Object.fromEntries(list.map(({ name, transport, toolPolicy, ...rest }) => [name, rest]));
  const write = () => writeJson(OFFICIAL_CONFIG, { ...readJson(OFFICIAL_CONFIG, {}), mcpServers });
  if (args.includes('--no-restart') || !officialRunning()) { write(); return false; }
  await quitOfficial();
  write();
  if (!(await startOfficial())) console.log(dim('  (could not reopen the official Claude Desktop — start it with `ccgw desktop official`)'));
  return true;
}

const desktopName = (args) => (args.includes('--official') ? 'the official Claude Desktop' : 'Claude Desktop');
const loaded = (restarted, args) => restarted
  ? `  ${desktopName(args).replace(/^the o/, 'O')} restarted`
  : `  ${args.includes('--official') && !officialRunning() ? `Loads next time you open ${desktopName(args)}` : `Restart ${desktopName(args)} to load it`}`;
const modeNote = (args) => {
  if (!args.includes('--official') && getMode() !== '3p') console.log(dim('  Note: Desktop is in login mode; connectors apply in gateway mode (ccgw desktop gateway).'));
};

async function connector(args) {
  if (!desktopSupported) fail('Claude Desktop is only available on macOS and Windows.');
  const off = args.includes('--official');
  if (off && !officialSupported) fail('The official Desktop next to the gateway one needs macOS or Windows.');
  args = args.filter((a) => a !== '--official');
  if (off) args.push('--official');
  const [sub = 'list', name] = args;
  const list = off ? officialConnectors() : connectors();

  if (sub === 'list') {
    if (off) console.log(dim(`Official Claude Desktop (${OFFICIAL_CONFIG}):`));
    if (!list.length) console.log(dim(off ? '  No local connectors. Add one with: ccgw connector add refigma --official' : 'No connectors. Add one with: ccgw connector add clickup'));
    for (const c of list) console.log(`  ${cyan(c.name.padEnd(12))} ${c.url || [c.command, ...(c.args || [])].join(' ')} ${dim(c.oauth ? '(OAuth)' : c.transport === 'stdio' ? '(local)' : '')}${bypassed(c) ? ' ' + green('no prompts') : ''}`);
    console.log(dim(`\n  presets: ${Object.keys(CONNECTOR_PRESETS).join(', ')}`));
    return;
  }

  if (sub === 'add') {
    if (!name) fail('usage: ccgw connector add <preset> | ccgw connector add <name> --url <https://…/mcp> [--header "K: V"] [--no-oauth]');
    const preset = CONNECTOR_PRESETS[name.toLowerCase()];
    if (off && (!preset?.local || flag(args, '--url'))) fail(`the official Desktop takes remote connectors from your claude.ai account: add "${name}" in its Settings → Connectors. --official works for the local ones: ${Object.keys(CONNECTOR_PRESETS).filter((k) => CONNECTOR_PRESETS[k].local).join(', ')}`);
    if (preset?.local === 'refigma' && !flag(args, '--url')) return addRefigma(name.toLowerCase(), preset, list, args);
    if (preset?.local && !flag(args, '--url')) {
      const id = name.toLowerCase();
      const figmaResult = preset.local === 'figma' ? await setupFigma(args) : null;
      const detail = preset.local === 'gmail' ? await ensureGmail(args) : 'Figma Desktop plugin';
      const restarted = await applyConnectors([...list.filter((c) => c.name !== id), keepPolicy(localEntry(id, preset.local), list, args)], args);
      console.log(green(`✓ connector "${id}" added`) + dim(`  (${detail}, runs locally via ccgw${args.includes('--official') ? ', official Claude Desktop' : ''})`));
      console.log(dim(loaded(restarted, args)) + dim(` — no Connect step needed; ask e.g. "${preset.example}"`));
      if (figmaResult) console.log(`\n  ${figmaNextSteps(figmaResult)}\n`);
      modeNote(args);
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
    modeNote(args);
    return;
  }

  if (sub === 'remove' || sub === 'rm') {
    if (!list.some((c) => c.name === name)) fail(`no connector named "${name}"${off ? ' in the official Desktop' : ''}`);
    await applyConnectors(list.filter((c) => c.name !== name), args);
    console.log(green(`✓ connector "${name}" removed`) + dim(off ? '  (official Claude Desktop)' : ''));
    return;
  }
  fail(`unknown command: ccgw connector ${sub}`);
}

// Adds refigma-mcp: the latest release through npx (re-add to update), --version <x.y.z>
// to pin one, or --path <checkout> to run a local clone.
async function addRefigma(id, preset, list, args) {
  const node = stableNode();
  const problems = requirements(node);
  if (problems.length) fail(`refigma-mcp cannot run here:\n    ${problems.join('\n    ')}`);
  const dirArg = flag(args, '--path');
  const dir = dirArg && path.resolve(dirArg.replace(/^~(?=[\\/]|$)/, os.homedir()));
  if (dir && !fs.existsSync(path.join(dir, 'server.mjs'))) fail(`${dir}: no server.mjs (expected a refigma-mcp checkout)`);
  const version = dir ? null : (flag(args, '--version') || await latestVersion()).replace(/^v/, '');
  if (!supportsPlatform(version)) fail(`refigma-mcp ${version} does not run on Windows — use 0.5.0 or later`);
  const python = IS_WIN ? await ensurePython(args) : null;
  const entry = refigmaEntry(id, { node, version, dir, python });
  const before = entryVersion(list.find((c) => c.name === id));

  console.log(dim(`  starting refigma-mcp ${dir ? `from ${dir}` : `v${version}`} once${dir ? '' : ' (npx downloads it the first time)'}…`));
  const r = await probe(entry);
  if (!r.ok) fail(`refigma-mcp did not start: ${r.error}`);

  const restarted = await applyConnectors([...list.filter((c) => c.name !== id), keepPolicy(entry, list, args)], args);
  const what = dir ? dir : before && before !== version ? `v${before} → v${version}` : `v${version}`;
  console.log(green(`✓ connector "${id}" added`) + dim(`  (refigma-mcp ${what}, runs locally${args.includes('--official') ? ', official Claude Desktop' : ''})`));
  console.log(dim(loaded(restarted, args)) + dim(` — no Connect step needed; ask e.g. "${preset.example}"`));
  console.log(dim(IS_WIN
    ? '  First use: Claude runs figma_relogin, which opens an Edge window at figma.com/login — sign in there once.'
    : '  It signs in with your Edge figma.com session: the first call asks for the Keychain once — click Allow.'));
  modeNote(args);
}

// Windows: refigma needs Python 3. Found even when it is not on PATH; otherwise installed
// per user after asking (--install-python skips the question).
async function ensurePython(args) {
  const found = findPython();
  if (found) return found;
  const how = 'Install Python 3 from python.org (tick "Add python.exe to PATH") or the Microsoft Store, or run again with --install-python.';
  const yes = args.includes('--install-python') || (interactive() &&
    !/^n/i.test(await prompt('refigma needs Python 3, which is not installed. Install Python 3.12 for this user now (no admin, ~27 MB)?', { placeholder: '(Y/n)' }) || ''));
  if (!yes) fail(`refigma-mcp needs Python 3. ${how}`);
  try {
    const py = await installPython((m) => console.log(dim(`  ${m}`)));
    if (!py) fail(`Python was installed but not found afterwards. ${how}`);
    console.log(green(`  ✓ Python installed`) + dim(`  (${py})`));
    return py;
  } catch (e) {
    fail(`could not install Python: ${e.message}\n  ${how}`);
  }
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

// Opens the gateway Desktop. One already on our profile with the current URL
// and key is just started or brought forward; otherwise it is switched over
// (which restarts it).
// The gateway Desktop, then the official one next to it.
async function openBoth() {
  if (!officialSupported) fail('Running the official Desktop next to the gateway one needs macOS or Windows.');
  await openGateway();
  await official([]);
}

async function openGateway() {
  console.log(dim('Opening the gateway Claude Desktop…'));
  await start([], { soft: true, quiet: true });
  const cfg = readConfig();
  const meta = readJson(META_FILE, { entries: [] });
  const applied = meta.entries?.find((e) => e.id === meta.appliedId);
  const prof = applied?.name === PROFILE_NAME ? readJson(path.join(LIB_DIR, `${applied.id}.json`), {}) : {};
  const ready = getMode() === '3p' && prof.inferenceGatewayBaseUrl === baseUrl(cfg) && prof.inferenceGatewayApiKey === cfg.apiKey;
  if (!ready) return desktop(['gateway']);
  if (!(await openDesktop())) fail('could not start Claude Desktop');
  console.log(green('✓ gateway Claude Desktop open') + dim(`  (profile: ${PROFILE_NAME})`));
}

// The official Desktop: a second instance, signed in to claude.ai, running
// next to the gateway one from its own data dir. ccgw only ever sets
// deploymentMode "1p" in its config; its session is never touched, and
// nothing that restarts the gateway Desktop quits it.
const OFFICIAL_DIR = officialDir();
const OFFICIAL_3P_CONFIG = path.join(`${OFFICIAL_DIR}-3p`, 'claude_desktop_config.json');

// Desktop records the account it last signed in to; the token cache changes
// on every sign-in, so a fresh one is told apart from the previous session.
function officialSession() {
  const conf = readJson(path.join(OFFICIAL_DIR, 'config.json'), {});
  return conf.lastKnownAccountUuid ? `${conf.lastKnownAccountUuid}:${JSON.stringify(conf['oauth:tokenCacheV2'] ?? conf['oauth:tokenCache'] ?? '')}` : null;
}

// While a Windows sign-in holds the mode at "1p", a marker names the process
// holding it. If that process dies without putting "3p" back (a closed
// terminal, a kill), the next ccgw command does, or the gateway Desktop would
// next open on claude.ai.
const MODE_HOLD = path.join(HOME_DIR, 'mode-hold.json');
function holdMode1p() {
  writeJson(MODE_HOLD, { pid: process.pid, since: new Date().toISOString() });
  setMode('1p');
  process.once('exit', () => { if (readJson(MODE_HOLD, null)?.pid === process.pid) releaseModeHold(); });
}
function releaseModeHold() {
  setMode('3p');
  fs.rmSync(MODE_HOLD, { force: true });
}
function releaseStaleModeHold() {
  const hold = readJson(MODE_HOLD, null);
  if (!hold) return;
  try { process.kill(hold.pid, 0); return; } catch {}
  if (getMode() === '1p') { releaseModeHold(); console.log(dim('(put Claude Desktop back in gateway mode: an official sign-in was cut off)')); }
  else fs.rmSync(MODE_HOLD, { force: true });
}

// On Windows both instances read the mode from the gateway's Claude-3p dir,
// and only at startup: it says "1p" just while the official one starts.
async function startOfficial() {
  if (!IS_WIN || officialRunning() || getMode() !== '3p') return openOfficial();
  setMode('1p');
  try { return await openOfficial(); } finally { setMode('3p'); }
}

async function official(args) {
  if (!officialSupported) fail('Running the official Desktop next to the gateway one needs macOS or Windows.');
  const sub = args.find((a) => !a.startsWith('-')) || 'open';
  if (sub === 'quit') {
    console.log(await quitOfficial() ? green('✓ official Claude Desktop quit') + dim('  (still signed in)') : 'official Claude Desktop is not running');
    return;
  }
  if (sub === 'status') {
    console.log(`Official Claude Desktop: ${officialRunning() ? green('● running') : '○ not running'}  ${officialSession() ? dim('(signed in)') : dim('(not signed in)')}`);
    return;
  }
  if (sub !== 'open') fail(`unknown command: ccgw desktop official ${sub}`);

  if (!IS_WIN) {
    const conf = readJson(OFFICIAL_3P_CONFIG, {});
    if (conf.deploymentMode !== '1p') writeJson(OFFICIAL_3P_CONFIG, { ...conf, deploymentMode: '1p' });
  }

  const before = officialSession();
  let signIn = args.includes('--sign-in') || !before;
  // Already signed in: waiting for a new session would wait out the full
  // timeout (holding Windows' mode at "1p" all along) unless the user really
  // means to switch accounts.
  if (before && args.includes('--sign-in')) {
    signIn = interactive() && await select(`The official Desktop is already signed in ${dim('(claude.ai)')}`, [
      { label: 'Just open it', value: false },
      { label: 'Sign in again (another account)', value: true, hint: 'sign out in its window first' },
    ]);
    if (!signIn) console.log(dim('Already signed in, so it only opens. To switch accounts: sign out in its window, then ccgw desktop official --sign-in.'));
  }
  console.log(dim(officialRunning() ? 'Bringing the official Claude Desktop forward…' : 'Opening the official Claude Desktop…'));
  if (!signIn || (officialRunning() && !args.includes('--sign-in'))) {
    if (!(await startOfficial())) fail('could not start the official Claude Desktop');
    console.log(green('✓ official Claude Desktop open') + dim('  (claude.ai account, next to the gateway one)'));
    return;
  }

  // Sign-in finishes through a claude:// link from the browser. macOS hands it
  // to the gateway Desktop, which drops it, so that one stays closed until
  // the official one has a new session. Windows starts a new Desktop process
  // for it, which picks its data dir from the mode: keeping that at "1p" sends
  // the link to the official instance, with the gateway one left running.
  const holdMode = IS_WIN && getMode() === '3p';
  const gatewayWasUp = !IS_WIN && desktopRunning();
  const reopen = async () => {
    if (holdMode) releaseModeHold();
    if (gatewayWasUp && !(await openDesktop())) console.log(dim('  (could not reopen the gateway Claude Desktop — start it with `ccgw desktop gateway`)'));
  };
  if (gatewayWasUp) {
    console.log(dim('The browser returns from sign-in to whichever Desktop macOS picks, so the gateway one is closed until you are signed in.'));
    await quitDesktop();
  }
  if (holdMode) holdMode1p();
  if (!(await (holdMode ? openOfficial() : startOfficial()))) { await reopen(); fail('could not start the official Claude Desktop'); }
  console.log(`${bold('Sign in')} in the Claude window that just opened ${dim('— waiting (Ctrl+C to stop waiting)')}`);

  let stop = false;
  const onInt = () => { stop = true; };
  process.once('SIGINT', onInt);
  const deadline = Date.now() + 15 * 60_000;
  while (!stop && Date.now() < deadline) {
    const now = officialSession();
    if (now && now !== before) break;
    await sleep(1000);
  }
  process.removeListener('SIGINT', onInt);
  const done = officialSession() && officialSession() !== before;
  await reopen();
  if (done) console.log(green('✓ official Claude Desktop signed in') + dim(gatewayWasUp ? '  — gateway Desktop reopened next to it' : ''));
  else console.log(dim(`Stopped waiting.${gatewayWasUp ? ' Gateway Desktop reopened.' : ''} Run \`ccgw desktop official --sign-in\` to try again.`));
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
    if (officialSupported && (officialRunning() || officialSession())) await official(['status']);
    return;
  }
  if (sub === 'official') return official(args.slice(1));
  if (sub === 'open') return openGateway();
  if (sub === 'both') return openBoth();
  if (sub === 'login') {
    await withDesktopClosed(() => setMode('1p'));
    console.log(green('✓ Claude Desktop switched to login mode') + dim('  (your claude.ai session is kept)'));
    return;
  }
  if (sub === 'gateway') {
    await start([], { soft: true });
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

  ccgw credential set --login "<cmd>" [--name X] [--status "<cmd>"] [--auto-login]
                               a tool that keeps Claude Code's login fresh: ccgw opens it in a
                               terminal when the login runs out and tells Desktop why
  ccgw credential status | login [--window] | auto on|off | unset

  ccgw desktop gateway         switch Claude Desktop to gateway mode (starts ccgw if needed)
  ccgw desktop login           switch Claude Desktop to claude.ai login mode
  ccgw desktop toggle          switch to the other mode
  ccgw desktop [status]        show the current mode
  (switching never logs you out: each mode keeps its own session)
  ccgw desktop open            open the gateway Desktop (starts ccgw; restarts Desktop only if it needs switching)
  ccgw desktop official        open a second, claude.ai-signed-in Desktop next to the gateway one
  ccgw desktop both            open the gateway Desktop and the official one side by side
  ccgw desktop official --sign-in | status | quit

  ccgw connector add clickup   add a connector to Claude Desktop (sign in via browser)
  ccgw connector add <name> --url <https://…/mcp>   any remote MCP server (OAuth)
  ccgw connector list | remove <name>
  ccgw connector add refigma --official   a local connector (refigma, gmail, figma-local) in the official claude.ai Desktop instead
  ccgw connector list --official | remove <name> --official
  ccgw sync [--project <name>]… [--all-projects] [--chats] [--skills] [--all] [--since <days>]   copy claude.ai chats, projects and skills from the official Desktop into the gateway one
  ccgw handoff [--chat <title|id>]… [--all] [--gateway-chats] [--skills] [--list] [--model <name>] [--no-brief]
                               chats synced from claude.ai and continued in the gateway → their claude.ai project: a note
                               Claude Code writes (done, decisions, next step) + the whole continuation
                               (--gateway-chats: also chats started in the gateway; --skills: skills you added there)
  ccgw permissions bypass [name]   skip Desktop's "Claude wants to use …" prompts (all connectors, or one)
  ccgw permissions ask [name]      prompt again;  ccgw permissions  shows the current setting
  ccgw connector add gmail --client-json <file>   Gmail via your Google OAuth client (runs locally)
  ccgw gmail status | login | logout               manage the Gmail sign-in
  ccgw connector add figma-local   Figma via a Figma Desktop plugin (no plan limits)
  ccgw figma status | plugin       check the bridge / add the plugin to Figma Desktop (--restart-figma)
  ccgw connector add refigma [--version x.y.z | --path <dir>] [--install-python]   Figma links → code via refigma-mcp (macOS, Windows)
  (presets: clickup, linear, notion, atlassian, sentry, figma, figma-local, gmail, refigma; --no-restart to skip restart)

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
    console.error(`\n${callout([`${NEWS}  ccgw v${latest} is available  (you have v${VERSION})`, `   Update:     ${bold('ccgw update')}`, `   What's new: ${RELEASES_URL}/tag/v${latest}`])}`);
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
  if (IS_WIN) releaseStaleModeHold();
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
    case 'sync': return sync(args);
    case 'handoff': return handoff(args);
    case 'gmail': return gmail(args);
    case 'figma': return figma(args);
    case 'permissions': case 'perms': return permissions(args);
    case 'credential': case 'cred': return credential(args);
    case 'update': case 'upgrade': return update(args);
    case '-v': case '--version': case 'version': return console.log(VERSION);
    case 'menu': return menu();
    default: return help();
  }
}

// ---------------------------------------------------------------- interactive menu

async function menu() {
  if (!interactive()) return help();
  const title = logo(VERSION) || `${bold('ccgw')} ${dim('v' + VERSION)}`;
  let last = null; // the item picked last; the first draw starts on "Update now" when there is one
  let output = ''; // what the last action printed
  screen.enter();
  try {
    while (true) {
      const cfg = readConfig();
      const h = await health(cfg, 800);
      const up = !!h;
      const mode = desktopSupported ? (getMode() === '3p' ? 'gateway' : 'login') : null;
      const names = connectors().map((c) => c.name);
      const latest = cachedLatest();
      const outdated = isNewer(latest, VERSION);
      const cred = provider(cfg);
      const news = outdated ? [
        banner(`${NEWS}  ccgw v${latest} is available  ·  you have v${VERSION}  ·  pick "Update now" (enter)`),
        dim(`   what's new: ${RELEASES_URL}/tag/v${latest}`),
        '',
      ] : [];
      const header = [...news, ...panel([
        ['Gateway', up
          ? `${green('● running')}  ${dim(baseUrl(cfg))}${h.sessions ? dim(` · ${h.sessions} chat${h.sessions > 1 ? 's' : ''}`) : ''}`
          : `${red('○ stopped')}  ${dim('Claude Desktop cannot answer until it starts')}`],
        ...(cred ? [['Login', `${cred.name}${(() => { const w = statusLine(cred); return w ? dim(` · ${w}`) : ''; })()}  ${loginLeft()}`]] : []),
        ...(desktopSupported ? [
          ['Desktop', mode === 'gateway' ? `${accent('◆')} gateway mode ${dim('(uses Claude Code)')}` : `◇ login mode ${dim('(claude.ai account)')}`],
          ...(officialSupported && (officialRunning() || officialSession())
            ? [['Official', `${officialRunning() ? green('● running') : '○ closed'} ${dim(officialSession() ? '· claude.ai, signed in' : '· not signed in')}`]] : []),
          ['Connectors', names.length ? names.slice(0, 4).join(dim(', ')) + (names.length > 4 ? dim(` +${names.length - 4}`) : '') : dim('none')],
          ['Permissions', bypassAll() ? `${accent('bypassed')} ${dim('· tools run without asking')}` : `prompts on ${dim('· Desktop asks before each tool')}`],
        ] : []),
        ['Version', `v${VERSION}  ${outdated ? accent(`v${latest} available`) : dim('up to date')}`],
      ])];
      const runs = officialSupported && syncSupported ? lastRuns() : {};
      const items = [
        ...(outdated ? [{ section: 'Update' }, { label: `${NEWS} Update now to v${latest}`, value: 'update', hint: `you have v${VERSION} · takes a few seconds, keeps your settings` }] : []),
        { section: 'Gateway' },
        up ? { label: 'Stop', value: 'stop' } : { label: 'Start', value: 'start', hint: 'needed for gateway mode' },
        { label: 'Restart', value: 'restart', disabled: !up },
        { label: 'Connection info', value: 'info', hint: 'URL + key for Claude Desktop' },
        ...(desktopSupported ? [
          { section: 'Claude Desktop' },
          { label: 'Open gateway Desktop', value: 'open-gateway', hint: up ? 'Claude Code' : 'starts the gateway too' },
          ...(officialSupported ? [
            { label: 'Open official Desktop', value: 'official', hint: officialSession() ? 'claude.ai, next to the gateway one' : 'sign in once with claude.ai' },
            { label: 'Open both', value: 'both', hint: 'gateway + claude.ai Desktop side by side' },
          ] : []),
          { label: 'Connectors…', value: 'connectors', hint: `${names.length} added` },
          ...(officialSupported && syncSupported ? [
            { label: 'Sync from official…', value: 'sync', hint: `claude.ai chats, projects, skills → gateway · ${runs.sync ? `last ${ago(runs.sync)}` : 'never run'}` },
            { label: 'Hand off to official…', value: 'handoff', hint: `chats continued here → claude.ai project, with a note · ${runs.handoff ? `last ${ago(runs.handoff)}` : 'never run'}` },
          ] : []),
          bypassAll()
            ? { label: 'Permission prompts: off', value: 'perms-ask', hint: 'turn back on (restarts Desktop)' }
            : { label: 'Permission prompts: on', value: 'perms-bypass', hint: 'bypass for all connectors (restarts Desktop)' },
        ] : []),
        { section: 'ccgw' },
        ...(outdated ? [] : [{ label: 'Check for updates', value: 'check' }]),
        { label: 'Quit', value: 'quit' },
      ];
      // Redraw from the top: logo, the last action's output (as much as fits
      // above the menu), then the panel and items.
      screen.clear();
      console.log(title);
      if (output) {
        const room = (process.stdout.rows || 40) - title.split('\n').length - header.length - items.length - 8;
        console.log(lastLines(output, Math.max(room, 8)) + '\n');
      }
      screen.record();
      const choice = await select(header, items, { initial: last ?? (outdated ? items.findIndex((it) => it.value === 'update') : 0) });
      if (choice === null || choice === 'quit') { screen.stop(); return; }
      last = items.findIndex((it) => it.value === choice);
      // The update replaces this process's files; it runs on the normal screen.
      if (choice === 'update') { screen.leave(); output = ''; await update([]); return; }
      try {
        switch (choice) {
          case 'start': await start([]); break;
          case 'stop': await stop(); break;
          case 'restart': await stop({ quiet: true }); await start([]); break;
          case 'info': printInfo(cfg); break;
          case 'open-gateway': await openGateway(); break;
          case 'official': await official([]); break;
          case 'both': await openBoth(); break;
          case 'connectors': await connectorMenu(); break;
          case 'sync': await sync([]); break;
          case 'handoff': await handoff([]); break;
          case 'perms-bypass': await permissions(['bypass']); break;
          case 'perms-ask': await permissions(['ask']); break;
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
      output = screen.stop();
    }
  } finally {
    // Back on the shell's screen, leave the last result where it can be read.
    screen.leave();
    if (output.trim()) console.log(output.replace(/\s+$/, ''));
  }
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
    ...(officialSupported ? [{ label: 'Official Desktop (claude.ai)…', value: 'official', hint: dim('local connectors for the signed-in app') }] : []),
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
  if (choice === 'official') return officialConnectorMenu();
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

// Local connectors for the official Desktop; remote ones are added in its own
// Settings → Connectors, since they belong to the claude.ai account.
async function officialConnectorMenu() {
  const added = officialConnectors();
  const local = Object.entries(CONNECTOR_PRESETS).filter(([, p]) => p.local);
  const choice = await select(`${bold('Official Desktop connectors')}  ${dim('runs on this machine · remote ones: its Settings → Connectors')}`, [
    ...local.map(([id, p]) => ({ label: p.label, value: `add:${id}`, hint: added.some((c) => c.name === id) ? green('✓ added') : '' })),
    { section: 'Manage' },
    { label: 'Remove a connector…', value: 'remove', disabled: !added.length },
    { label: 'List connectors', value: 'list' },
    { label: 'Back', value: null },
  ]);
  if (!choice) return;
  if (choice === 'list') return connector(['list', '--official']);
  if (choice === 'remove') {
    const name = await select('Remove which connector from the official Desktop?', [
      ...added.map((c) => ({ label: c.name, value: c.name, hint: c.command || c.url || '' })),
      { label: 'Back', value: null },
    ]);
    if (name) await connector(['remove', name, '--official']);
    return;
  }
  const id = choice.slice(4);
  if (CONNECTOR_PRESETS[id].local === 'gmail' && !readGmail()?.refreshToken) {
    console.log(dim(`\n  Sign in to Gmail first: add it to the gateway (Connectors → Gmail) or run ccgw connector add gmail --official --client-json <file>.\n`));
    return;
  }
  return connector(['add', id, '--official']);
}

// ---------------------------------------------------------------- sync from the official Desktop

// Chats, projects and skills from the claude.ai account the official Desktop
// is signed in to, copied into the gateway Desktop. Re-running only brings
// what changed: a chat updated on claude.ai replaces its gateway copy unless
// that copy was continued in the gateway, then it comes in as a new one.
const SYNC_FILE = path.join(HOME_DIR, 'sync.json');
const SESSION_CACHE = path.join(HOME_DIR, 'official-session.bin');

// claude.ai as the official Desktop. On Windows that Desktop locks its cookie
// file while open, so the first sync closes it for a moment (it stays signed
// in) and keeps the sign-in sealed for the next ones.
async function officialApi() {
  const cached = IS_WIN ? cachedSession(OFFICIAL_DIR, SESSION_CACHE) : null;
  if (cached) {
    const api = claudeAi(cached);
    if (await api.projects().then(() => true, () => false)) return api;
  }
  let jar;
  let dir = OFFICIAL_DIR;
  // Desktop's data dir on Windows depends on how it was installed; when the
  // guess holds no sign-in, try the other one and the running instance's own.
  const read = async () => {
    try { return await officialCookies(dir); } catch (e) {
      if (e.code !== 'NOCOOKIES' || !IS_WIN) throw e;
      const others = officialDirCandidates(officialProcDirs()).filter((d) => d !== path.resolve(dir));
      for (const d of others) {
        try { const j = await officialCookies(d); dir = d; return j; } catch (err) { if (err.code !== 'NOCOOKIES') { dir = d; throw err; } }
      }
      throw Object.assign(new Error(`the official Desktop has no sign-in yet: no Cookies file in ${[dir, ...others].join(' or ')} (ccgw desktop official)`), { code: 'NOCOOKIES' });
    }
  };
  try {
    jar = await read();
  } catch (e) {
    if (e.code !== 'EBUSY') throw e;
    console.log(dim('The official Desktop locks its sign-in file while open, so it closes for a moment (it stays signed in)…'));
    await quitOfficial();
    try {
      for (let i = 0; ; i++) {
        try { jar = await officialCookies(dir); break; } catch (err) { if (err.code !== 'EBUSY' || i >= 10) throw err; await sleep(500); }
      }
    } finally {
      if (!(await startOfficial())) console.log(dim('  (could not reopen the official Desktop — ccgw desktop official)'));
    }
  }
  if (IS_WIN) cacheSession(dir, SESSION_CACHE, jar);
  return claudeAi(jar);
}
const OUTSIDE = '__chats__';

// When sync and handoff last ran, for the menu. Sync state from before these
// were recorded falls back to when its newest copied chat was written: its
// .audit-key, which only sync writes (Desktop rewrites the index file).
function lastRuns() {
  const state = readJson(SYNC_FILE, null);
  if (!state) return {};
  let sync = state.lastSync ? Date.parse(state.lastSync) : 0;
  if (!sync && Object.keys(state.conversations || {}).length) {
    try {
      const store = gatewayStore(desktop3pDir());
      for (const rec of Object.values(state.conversations)) {
        try { sync = Math.max(sync, fs.statSync(path.join(store.base, rec.session.slice(6, 14), '.audit-key')).mtimeMs); } catch {}
      }
    } catch {}
  }
  const handoff = state.lastHandoff ? Date.parse(state.lastHandoff)
    : Math.max(0, ...Object.values(state.handoff || {}).map((h) => Date.parse(h.at) || 0));
  return { sync: sync || null, handoff: handoff || null };
}

const SKILLS = '__skills__';
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

async function sync(args) {
  if (!syncSupported || !officialSupported) fail('ccgw sync needs macOS or Windows.');
  if (args.includes('--to-official')) fail('sync --to-official is gone: ccgw handoff takes chats continued in the gateway (and --gateway-chats, --skills) to claude.ai.');
  const listOnly = args.includes('--list');
  const since = flag(args, '--since');
  const sinceMs = since ? Date.now() - Number(String(since).replace(/d$/, '')) * 86_400_000 : 0;
  if (since && !Number.isFinite(sinceMs)) fail('--since takes a number of days, e.g. --since 7');

  console.log(dim(`Reading claude.ai through the official Desktop’s sign-in${IS_WIN ? '' : ' (macOS may ask for the "Claude Safe Storage" Keychain item: click Allow)'}…`));
  let api, convs, projects;
  try {
    api = await officialApi();
    [convs, projects] = await Promise.all([api.conversations(), api.projects()]);
  } catch (e) {
    fail(e.message);
  }
  convs = convs.filter((c) => !sinceMs || new Date(c.updated_at).getTime() >= sinceMs);
  const inProject = (id) => convs.filter((c) => c.project_uuid === id);
  const outside = convs.filter((c) => !c.project_uuid || !projects.some((p) => p.uuid === c.project_uuid));
  const store = gatewayStore(desktop3pDir());
  // Every skill on the account, enabled or not; the official Desktop's local copy if that fails.
  const skills = (await api.skills().catch(() => null) ?? officialSkills(OFFICIAL_DIR)).filter((s) => !store.builtinSkills.has(s.name));
  const haveSkills = installedSkills(store);
  const newSkills = skills.filter((s) => !haveSkills.has(s.name)).length;
  const skillHint = skills.length ? `${skills.length}: ${skills.map((s) => s.name).join(', ')}${haveSkills.size ? ` · ${newSkills} new` : ''}` : 'none the gateway lacks';
  const state = readJson(SYNC_FILE, { conversations: {}, projects: {} });
  const fresh = (list) => list.filter((c) => state.conversations[c.uuid]?.updatedAt !== c.updated_at).length;

  if (listOnly) {
    for (const p of projects) console.log(`  ${cyan(p.name.padEnd(28))} ${plural(inProject(p.uuid).length, 'chat')} ${dim(`(${fresh(inProject(p.uuid))} new or changed)`)}`);
    console.log(`  ${cyan('Chats outside projects'.padEnd(28))} ${plural(outside.length, 'chat')} ${dim(`(${fresh(outside)} new or changed)`)}`);
    console.log(`  ${cyan('Skills'.padEnd(28))} ${skillHint}`);
    return;
  }

  let picked;
  const named = args.flatMap((a, i) => (a === '--project' ? [args[i + 1]] : []));
  if (args.includes('--all')) picked = [...projects.map((p) => p.uuid), OUTSIDE, SKILLS];
  else if (named.length || args.includes('--all-projects') || args.includes('--chats') || args.includes('--skills')) {
    const want = named.map((n) => n.toLowerCase());
    const unknown = want.filter((n) => !projects.some((p) => p.name.toLowerCase() === n));
    if (unknown.length) fail(`no claude.ai project named ${unknown.map((n) => `"${n}"`).join(', ')}. Projects: ${projects.map((p) => p.name).join(', ')}`);
    picked = [
      ...projects.filter((p) => args.includes('--all-projects') || want.includes(p.name.toLowerCase())).map((p) => p.uuid),
      ...(args.includes('--chats') ? [OUTSIDE] : []),
      ...(args.includes('--skills') ? [SKILLS] : []),
    ];
  } else if (interactive()) {
    picked = await checklist(`${bold('Sync from the official Desktop')}  ${dim('claude.ai → gateway · tick what to copy')}`, [
      { section: 'Projects' },
      ...projects.map((p) => ({ label: p.name, value: p.uuid, hint: `${plural(inProject(p.uuid).length, 'chat')} · ${fresh(inProject(p.uuid))} new or changed`})),
      { section: 'Other' },
      { label: 'Chats outside projects', value: OUTSIDE, hint: `${plural(outside.length, 'chat')} · ${fresh(outside)} new or changed` },
      { label: 'Skills', value: SKILLS, hint: skillHint },
    ]);
    if (!picked) return console.log(dim('Sync cancelled.'));
  } else {
    fail('usage: ccgw sync [--project <name>]… [--all-projects] [--chats] [--skills] [--all] [--since <days>] [--list] [--no-restart]');
  }

  // Everything is fetched first, so the gateway Desktop is closed only for the write.
  const todo = [];
  const spaces = [];
  for (const p of projects.filter((x) => picked.includes(x.uuid))) {
    spaces.push({ project: { ...p, ...(await api.project(p.uuid)) }, docs: await api.docs(p.uuid).catch(() => []) });
  }
  const chosen = [...projects.filter((p) => picked.includes(p.uuid)).flatMap((p) => inProject(p.uuid)), ...(picked.includes(OUTSIDE) ? outside : [])];
  const changed = chosen.filter((c) => !(state.conversations[c.uuid] && sessionExists(store, state.conversations[c.uuid]) && state.conversations[c.uuid].updatedAt === c.updated_at));
  for (const [i, c] of changed.entries()) {
    process.stdout.write(dim(`\r  fetching chats ${i + 1}/${changed.length}…`));
    todo.push(await api.conversation(c.uuid));
  }
  if (changed.length) process.stdout.write('\r\x1b[K');

  // Skills arrive as .skill zips, unpacked next to each other.
  let skillTmp = null;
  if (picked.includes(SKILLS) && skills.length) {
    skillTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccgw-skills-'));
    for (const [i, sk] of skills.entries()) {
      process.stdout.write(dim(`\r  fetching skills ${i + 1}/${skills.length}…`));
      if (sk.dir) fs.cpSync(sk.dir, path.join(skillTmp, sk.name), { recursive: true });
      else unzipSkill(await api.downloadSkill(sk.id), skillTmp);
    }
    process.stdout.write('\r\x1b[K');
  }
  const skillDirs = skillTmp ? fs.readdirSync(skillTmp).filter((d) => fs.existsSync(path.join(skillTmp, d, 'SKILL.md'))).map((d) => ({ name: d, dir: path.join(skillTmp, d) })) : [];

  const counts = { added: 0, updated: 0, kept: 0, spaces: 0, skills: 0 };
  const write = () => {
    for (const { project, docs } of spaces) {
      const s = writeSpace(store, project, docs, state.projects[project.uuid]);
      state.projects[project.uuid] = s.id;
      project.space = s;
      counts.spaces++;
    }
    const spaceOf = (c) => spaces.find((s) => s.project.uuid === c.project_uuid)?.project.space || null;
    for (const conv of todo) {
      const prev = state.conversations[conv.uuid];
      let sid;
      if (prev && sessionExists(store, prev)) {
        if (sessionUntouched(store, prev)) { removeSession(store, prev.session); sid = prev.session.replace(/^local_/, ''); counts.updated++; }
        else counts.kept++;
      }
      if (!sid && !(prev && sessionExists(store, prev))) counts.added++;
      state.conversations[conv.uuid] = writeSession(store, conv, { sid: sid || undefined, space: spaceOf(conv) });
    }
    if (skillDirs.length) { installSkills(store, skillDirs, VERSION); counts.skills = skillDirs.length; }
    state.lastSync = new Date().toISOString();
    writeJson(SYNC_FILE, state);
  };

  const nothing = !todo.length && !spaces.length && !(picked.includes(SKILLS) && skills.length);
  if (nothing) {
    state.lastSync = new Date().toISOString();
    writeJson(SYNC_FILE, state);
    return console.log(green('✓ already in sync') + dim('  (nothing new on claude.ai)'));
  }
  const restart = desktopRunning() && !args.includes('--no-restart');
  if (restart) {
    console.log(dim('The gateway Desktop restarts to load them (Desktop rewrites its project list while running).'));
    await withDesktopClosed(write);
  } else write();

  console.log(green('✓ synced from claude.ai') + dim(`  (${[
    counts.added && `${plural(counts.added, 'chat')} added`, counts.updated && `${counts.updated} updated`,
    counts.kept && `${counts.kept} continued in the gateway, copied again alongside`,
    counts.spaces && plural(counts.spaces, 'project'), counts.skills && plural(counts.skills, 'skill'),
  ].filter(Boolean).join(', ') || 'projects refreshed'})`));
  if (skillTmp) fs.rmSync(skillTmp, { recursive: true, force: true });
  if (!restart && desktopRunning()) console.log(dim('  Restart the gateway Desktop to see them (ccgw desktop open after quitting it).'));
  console.log(dim('  Chats come over as text: images and PDFs stay on claude.ai, and only the branch shown there is copied.'));
}

// Handoff's claude.ai project for chats outside any gateway project.
const GATEWAY_CHATS = 'Gateway chats';

// The claude.ai project for a gateway one (or OUTSIDE, for "Gateway chats"):
// the one it came from, the one made last time (unless deleted since), or a
// new one.
function remoteProjectFor(api, state, remoteProjects, onCreate = () => {}) {
  const out = state.toOfficial ??= { projects: {}, chats: {}, skills: [] };
  const origin = Object.fromEntries(Object.entries(state.projects).map(([remote, space]) => [space, remote]));
  const exists = async (id) => !!id && (remoteProjects.some((p) => p.uuid === id) || !!(await api.project(id).catch(() => null)));
  return async (key, name, instructions) => {
    if (await exists(origin[key])) return origin[key];
    if (await exists(out.projects[key])) return out.projects[key];
    const p = await api.createProject(name, 'From the gateway Claude Desktop (Claude Code), copied by ccgw sync.');
    if (instructions) await api.setInstructions(p.uuid, instructions);
    out.projects[key] = p.uuid;
    remoteProjects.push(p);
    onCreate(p);
    return p.uuid;
  };
}

const instructionsOf = (sp) => {
  for (const f of sp?.folders || []) {
    try { return fs.readFileSync(path.join(f.path, 'Project instructions.md'), 'utf8'); } catch {}
  }
  return '';
};

// ---------------------------------------------------------------- handoff back to the official Desktop

// A chat copied from claude.ai and continued in the gateway (claude.ai ran
// out of usage, say) cannot be put back: claude.ai takes in no chat history.
// So what happened after the copy goes to the chat's claude.ai project as one
// knowledge file: a note Claude Code writes from it (goal, done, decisions,
// state, still to do, next step), what it touched, the files it produced and
// the whole continuation. A new chat in that project picks up from there.
// Chats started in the gateway are handed off the same way.

// The note, by the same Claude Code login the gateway uses: no tools, no
// settings, its own system prompt, run from a fixed empty dir so neither a
// repo's git status or CLAUDE.md nor a new ~/.claude/projects entry per run
// comes into it.
function writeBrief({ system, user }, model) {
  const claude = process.env.CCGW_HANDOFF_CLAUDE || findClaude(readConfig().claudePath);
  if (!claude) throw new Error('Claude Code (claude) is not installed');
  const [cmd, pre] = claude.endsWith('.js') || claude.endsWith('.mjs') ? [process.execPath, [claude]] : [claude, []];
  const env = { ...process.env };
  delete env.CLAUDECODE; // run from inside Claude Code, it would refuse to nest
  const cwd = path.join(HOME_DIR, 'handoff');
  fs.mkdirSync(cwd, { recursive: true });
  const r = spawnSync(cmd, [...pre, '-p', '--model', model, '--output-format', 'text', '--system-prompt', system,
    '--tools=', '--setting-sources=', '--strict-mcp-config', '--no-session-persistence'], {
    input: user, encoding: 'utf8', env, cwd, timeout: 300_000, maxBuffer: 16 << 20, windowsHide: true,
  });
  if (r.error) throw new Error(r.error.code === 'ETIMEDOUT' ? 'Claude Code took more than 5 minutes' : r.error.message);
  const text = (r.stdout || '').trim();
  if (r.status !== 0 || !text) throw new Error((r.stderr || text || `claude exited with ${r.status}`).trim().split('\n').pop());
  return text;
}

async function handoff(args) {
  if (!syncSupported || !officialSupported) fail('ccgw handoff needs macOS or Windows.');
  const listOnly = args.includes('--list');
  const model = flag(args, '--model') || 'sonnet';
  const named = args.flatMap((a, i) => (a === '--chat' ? [String(args[i + 1] || '').toLowerCase()] : [])).filter(Boolean);
  let store;
  try { store = gatewayStore(desktop3pDir()); } catch (e) { fail(e.message); }

  console.log(dim(`Signing in to claude.ai as the official Desktop${IS_WIN ? '' : ' (macOS may ask for the "Claude Safe Storage" Keychain item: click Allow)'}…`));
  let api, remoteProjects, convs;
  try {
    api = await officialApi();
    [remoteProjects, convs] = await Promise.all([api.projects(), api.conversations()]);
  } catch (e) {
    fail(e.message);
  }
  convs = new Map(convs.map((c) => [c.uuid, c]));

  const state = readJson(SYNC_FILE, { conversations: {}, projects: {} });
  const done = state.handoff ??= {};
  const copied = new Map(Object.entries(state.conversations).map(([conv, rec]) => [rec.session, { conv, rec }]));
  const spaces = gatewaySpaces(store);
  const origin = Object.fromEntries(Object.entries(state.projects).map(([remote, space]) => [space, remote]));
  const remoteName = (id) => remoteProjects.find((p) => p.uuid === id)?.name;
  // Copies nobody chatted on in are left out: claude.ai already has all of them.
  const items = gatewaySessions(store).flatMap((s) => {
    const from = copied.get(s.session);
    if (from && sessionUntouched(store, from.rec)) return [];
    const conv = from && convs.get(from.conv);
    const sp = spaces.find((x) => x.id === s.spaceId);
    const target = conv?.project_uuid && remoteName(conv.project_uuid)
      ? { id: conv.project_uuid, name: remoteName(conv.project_uuid) }
      : sp ? { key: sp.id, name: remoteName(origin[sp.id]) || remoteName(state.toOfficial?.projects?.[sp.id]) || sp.name, instructions: instructionsOf(sp) }
        : { key: OUTSIDE, name: remoteName(state.toOfficial?.projects?.[OUTSIDE]) || GATEWAY_CHATS };
    return [{ s, from, conv, target, pending: done[s.session]?.size !== s.size }];
  });
  // Skills added to the gateway Desktop (not the ones sync copied from
  // claude.ai) go to the account's own skills.
  const out = state.toOfficial ??= { projects: {}, chats: {}, skills: [] };
  const newSkills = gatewayUserSkills(store).filter((sk) => !out.skills.includes(sk.name));
  const skillHint = `${newSkills.map((sk) => sk.name).join(', ')} → your claude.ai skills`;
  const nothingToHandOff = () => {
    const mineWaiting = items.filter((it) => it.pending && !it.from).length;
    console.log(green('✓ nothing to hand off') + dim('  — no chat synced from claude.ai has been continued in the gateway since its last handoff.'));
    console.log(dim('  Handoff is for this: sync a claude.ai chat to the gateway (Sync from official), chat on in it there, then hand it off.'));
    if (mineWaiting && !args.includes('--gateway-chats')) console.log(dim(`  ${plural(mineWaiting, 'chat')} started in the gateway can go too: ccgw handoff --gateway-chats`));
  };
  const hint = (it) => `${it.from ? 'continued from claude.ai' : 'started in the gateway'} → "${it.target.name}"${it.pending ? '' : ' · handed off, unchanged'}`;

  if (listOnly) {
    if (!items.length && !newSkills.length) return console.log(dim('Nothing to hand off: no chat was continued or started in the gateway, and no skill was added there.'));
    for (const it of items) console.log(`  ${dim(it.s.session.slice(6, 14))}  ${(it.pending ? cyan : dim)(short(it.s.title, 40).padEnd(40))} ${dim(hint(it))}`);
    if (newSkills.length) console.log(`  ${' '.repeat(8)}  ${cyan('Skills you added'.padEnd(40))} ${dim(skillHint)}`);
    return;
  }

  let picked, wantSkills = args.includes('--skills') && newSkills.length > 0;
  if (named.length) {
    // Each --chat names one chat: its title, the start of its title, or the
    // id `--list` shows; several chats can share a title.
    picked = [];
    for (const n of named) {
      const id = items.filter((it) => it.s.session.slice(6).startsWith(n));
      const exact = items.filter((it) => it.s.title.toLowerCase() === n);
      const part = items.filter((it) => it.s.title.toLowerCase().includes(n));
      const hits = n.length >= 4 && id.length ? id : exact.length ? exact : part;
      if (!hits.length) fail(`no gateway chat titled like "${n}" (ccgw handoff --list)`);
      if (hits.length > 1) fail(`"${n}" matches ${hits.length} chats; name one by its id:\n${hits.map((it) => `  ${it.s.session.slice(6, 14)}  ${it.s.title}  ${dim(hint(it))}`).join('\n')}`);
      if (!picked.includes(hits[0])) picked.push(hits[0]);
    }
  } else if (args.includes('--all')) {
    picked = items.filter((it) => it.pending && (it.from || args.includes('--gateway-chats')));
    wantSkills = newSkills.length > 0;
  } else if (args.includes('--skills')) picked = [];
  else if (interactive()) {
    // The point is chats that came from claude.ai and went on here; chats
    // that only ever lived in the gateway are offered with --gateway-chats.
    const withMine = args.includes('--gateway-chats');
    const pend = items.filter((it) => it.pending && (it.from || withMine));
    if (!pend.length && !newSkills.length) return nothingToHandOff();
    const cont = pend.filter((it) => it.from), mine = pend.filter((it) => !it.from);
    const ids = await checklist(`${bold('Hand off to the official Desktop')}  ${dim('gateway → claude.ai project · a note + the whole continuation')}`, [
      ...(cont.length ? [{ section: 'Continued from claude.ai' }, ...cont.map((it) => ({ label: short(it.s.title, 48), value: it.s.session, hint: `→ "${it.target.name}"` }))] : []),
      ...(mine.length ? [{ section: 'Started in the gateway' }, ...mine.map((it) => ({ label: short(it.s.title, 48), value: it.s.session, hint: `→ "${it.target.name}"` }))] : []),
      ...(newSkills.length ? [{ section: 'Other' }, { label: 'Skills you added', value: SKILLS, hint: skillHint }] : []),
    ], { verb: 'hand off' });
    if (!ids) return console.log(dim('Handoff cancelled.'));
    picked = pend.filter((it) => ids.includes(it.s.session));
    wantSkills = ids.includes(SKILLS);
  } else {
    fail('usage: ccgw handoff [--chat <title|id>]… [--all] [--gateway-chats] [--skills] [--list] [--model <name>] [--no-brief]');
  }
  if (!picked.length && !wantSkills) return named.length || interactive() ? console.log(dim('Nothing picked.')) : nothingToHandOff();

  const projectFor = remoteProjectFor(api, state, remoteProjects);
  const results = [];
  for (const it of picked) {
    const { s } = it;
    try {
      // Copies made before 0.3.21 do not record where they end; the chat's
      // unanswered last question, if any, still belongs to claude.ai.
      const lastHuman = it.from && !it.from.rec.leaf ? await api.conversation(it.from.conv).then(unansweredQuestion, () => null) : null;
      const turns = readTurns(s);
      // A copy sync later made again alongside (because this one was continued)
      // has lost its record, but its claude.ai part is still marked.
      const { before, after } = it.from || turns.some((x) => x.claudeAi) ? continuedTurns(turns, it.from?.rec, lastHuman) : { before: [], after: turns };
      if (!after.length) { console.log(dim(`  ${s.title}: nothing after the claude.ai part, skipped`)); continue; }
      const facts = handoffFacts(s, after);
      let brief = null;
      if (!args.includes('--no-brief')) {
        console.log(dim(`  ${s.title}: Claude Code (${model}) is writing the handoff note…`));
        try { brief = writeBrief(briefPrompt({ title: s.title, before, after, facts }), model); } catch (e) {
          console.log(`  ${red('!')} no note for "${s.title}": ${e.message} ${dim('(the transcript still goes; check `claude auth status`, or --no-brief)')}`);
        }
      }
      const project = it.target.id || await projectFor(it.target.key, it.target.name, it.target.instructions);
      const prev = done[s.session];
      if (prev?.doc) await api.deleteDoc(prev.project, prev.doc);
      const name = handoffDocName(s);
      const doc = await api.addDoc(project, name, handoffDoc({ s, conv: it.conv, after, facts, brief, model }));
      done[s.session] = { project, doc: doc.uuid, size: s.size, at: new Date().toISOString() };
      writeJson(SYNC_FILE, state);
      results.push({ it, project, name, brief: !!brief, vi: looksVietnamese(turns) });
      console.log(`  ${green('✓')} ${s.title} ${dim(`→ "${remoteName(project) || it.target.name}" · ${plural(after.filter((x) => x.who === 'You').length, 'message')} from you, ${plural(facts.files.length, 'file')} edited, ${plural(facts.outputs.length, 'output')}${brief ? ', note' : ''}`)}`);
    } catch (e) {
      console.log(`  ${red('✗')} ${s.title}: ${e.message}`);
    }
  }
  if (wantSkills) {
    let added = 0;
    for (const sk of newSkills) {
      try {
        const r = await api.uploadSkill(sk.name, zipSkill(sk.dir, sk.name));
        out.skills.push(sk.name);
        if (r === 'added') added++;
        else console.log(dim(`  skill "${sk.name}" is already on the account, left as it is`));
      } catch (e) {
        console.log(`  ${red('✗')} skill ${sk.name}: ${e.message}`);
      }
    }
    writeJson(SYNC_FILE, state);
    if (added) console.log(`  ${green('✓')} ${plural(added, 'skill')} uploaded to your claude.ai skills`);
  }
  if (results.length || wantSkills) { state.lastHandoff = new Date().toISOString(); writeJson(SYNC_FILE, state); }
  if (!results.length) return;

  // What to say in the new claude.ai chat, in the user's language.
  const starter = (r) => (r.vi
    ? `Đọc file "${r.name}" trong knowledge của project này (phần mình đã làm tiếp bên Claude Code), rồi làm tiếp từ bước tiếp theo ghi trong đó.`
    : `Read "${r.name}" in this project's knowledge (what I did in Claude Code after this project's chat), then carry on from the next step it names.`);
  console.log('');
  console.log(green(`✓ handed off ${plural(results.length, 'chat')} to claude.ai`));
  for (const p of [...new Set(results.map((r) => r.project))]) {
    console.log(`  ${bold(remoteName(p) || 'project')}  ${dim(`https://claude.ai/project/${p}`)}`);
    for (const r of results.filter((x) => x.project === p)) console.log(`    ${dim('start a new chat with:')} ${starter(r)}`);
  }
  if (results.length === 1 && !process.env.CCGW_NO_CLIPBOARD && copyToClipboard(starter(results[0]))) console.log(dim('  (that line is on the clipboard)'));
  console.log(dim('  Open the project in the official Desktop (ccgw desktop official) and paste it into a new chat there.'));
}

const short = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

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
