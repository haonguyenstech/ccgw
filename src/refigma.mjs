// refigma-mcp (github.com/haonguyenstech/refigma-mcp) reads Figma frames through a
// headless Edge signed in to figma.com — no REST quota, plugin or Edit seat — and
// turns them into a layout tree, HTML / React + Tailwind, SVG, tokens and PNG.
// It is a separate stdio server; ccgw only writes the Desktop entry that runs it,
// either a pinned release tarball through npx or a local checkout (--path).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { IS_MAC, IS_WIN } from './platform.mjs';

const REPO = 'haonguyenstech/refigma-mcp';
const FALLBACK_VERSION = '0.5.0';   // the first release that runs on Windows
const MIN_NODE = [22, 15];

function edgeFound() {
  if (IS_MAC) return fs.existsSync('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
  const exe = path.join('Microsoft', 'Edge', 'Application', 'msedge.exe');
  return [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA]
    .some((d) => d && fs.existsSync(path.join(d, exe)));
}

// The same order refigma tries; Windows' "python" may be the Microsoft Store stub, which fails this check.
const pythonOk = (mod) => (IS_WIN ? [['python'], ['py', '-3']] : [['python3']]).some(([c, ...a]) =>
  spawnSync(c, [...a, '-c', `import sys; assert sys.version_info >= (3, 8)${mod ? `; import ${mod}` : ''}`], { stdio: 'ignore', windowsHide: true }).status === 0);

// Windows: the absolute python.exe to give refigma (REFIGMA_PYTHON), so neither this terminal's nor Desktop's
// PATH matters — a fresh install is only on the PATH of processes started after it. null when there is none.
export function findPython() {
  const exe = (c, a = []) => {
    const r = spawnSync(c, [...a, '-c', 'import sys; assert sys.version_info >= (3, 8); print(sys.executable)'], { encoding: 'utf8', windowsHide: true });
    const f = r.status === 0 && r.stdout.trim();
    return f && fs.existsSync(f) ? f : null;
  };
  for (const [c, ...a] of [['python'], ['py', '-3'], ['python3']]) { const f = exe(c, a); if (f) return f; }
  // installed but not on PATH ("Add python.exe to PATH" unticked): python.org's per-user and all-users folders
  const bases = [process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Python'), process.env.ProgramFiles, process.env['ProgramFiles(x86)'], 'C:\\'];
  for (const base of bases.filter(Boolean)) {
    let dirs = [];
    try { dirs = fs.readdirSync(base).filter((d) => /^Python3\d+/i.test(d)).sort((x, y) => y.localeCompare(x, 'en', { numeric: true })); } catch {}
    for (const d of dirs) { const f = exe(path.join(base, d, 'python.exe')); if (f) return f; }
  }
  return null;
}

const PYTHON_INSTALLER = '3.12.10';

// Windows: python.org's installer, per user (no admin, no UAC prompt), added to PATH. Returns python.exe or null.
export async function installPython(log = () => {}) {
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
  const url = `https://www.python.org/ftp/python/${PYTHON_INSTALLER}/python-${PYTHON_INSTALLER}-${arch}.exe`;
  const file = path.join(os.tmpdir(), `ccgw-python-${PYTHON_INSTALLER}-${arch}.exe`);
  log(`downloading Python ${PYTHON_INSTALLER} (${arch}) from python.org…`);
  const r = await fetch(url, { signal: AbortSignal.timeout(300_000) });
  if (!r.ok) throw new Error(`download failed (HTTP ${r.status}): ${url}`);
  fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
  log('installing for this user (no admin needed)…');
  const res = spawnSync(file, ['/quiet', 'InstallAllUsers=0', 'PrependPath=1', 'Include_test=0', 'Include_launcher=0'], { stdio: 'ignore', windowsHide: true });
  try { fs.rmSync(file); } catch {}
  if (res.status !== 0) throw new Error(`the Python installer exited with ${res.status ?? res.error?.message}`);
  return findPython();
}

export const tarballUrl = (v) => `https://github.com/${REPO}/releases/download/v${v}/refigma-mcp-${v}.tgz`;
export const entryVersion = (entry) => entry?.args?.join(' ').match(/refigma-mcp-(\d[\w.-]*)\.tgz/)?.[1];

// Each release has its own URL, so the entry stays on the version it was added with.
export async function latestVersion() {
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { 'User-Agent': 'ccgw' }, signal: AbortSignal.timeout(8000),
    });
    const tag = r.ok && (await r.json()).tag_name;
    if (tag) return tag.replace(/^v/, '');
  } catch {}
  return FALLBACK_VERSION;
}

// Problems that stop refigma-mcp from working at all; empty when it can run.
export function requirements(node) {
  if (!IS_MAC && !IS_WIN) return ['refigma-mcp runs on macOS and Windows only (it drives Microsoft Edge)'];
  const out = [];
  const [maj, min] = process.versions.node.split('.').map(Number);
  if (maj < MIN_NODE[0] || (maj === MIN_NODE[0] && min < MIN_NODE[1])) out.push(`Node ${MIN_NODE.join('.')}+ needed (${node} is ${process.version})`);
  if (!edgeFound()) out.push(`Microsoft Edge not found — install it${IS_MAC ? ' and sign in to figma.com' : ''}`);
  // macOS reads Edge's figma.com session with cryptography; Windows signs in once in an Edge window instead
  if (IS_MAC && !pythonOk('cryptography')) out.push('Python 3 with cryptography needed: python3 -m pip install cryptography');
  // Windows' Python is found or installed by the caller (findPython / installPython)
  return out;
}

// refigma 0.4.x does not run on Windows.
export const supportsPlatform = (version) => !IS_WIN || !version || !/^0\.[0-4]\./.test(version);

// macOS: Desktop starts stdio servers with a bare PATH; npx and refigma's python3/curl need these.
// Windows: Desktop passes the user's PATH, so the entry leaves it alone.
const pathFor = (node) => [path.dirname(node), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']
  .filter((d, i, a) => a.indexOf(d) === i).join(':');

// npx on Windows is npx.cmd, which Desktop cannot start without a shell: run npm's npx-cli.js with node instead.
function npx(node) {
  if (!IS_WIN) return { command: path.join(path.dirname(node), 'npx'), pre: [] };
  const cli = path.join(path.dirname(node), 'node_modules', 'npm', 'bin', 'npx-cli.js');
  return { command: node, pre: [cli] };
}

// A local checkout (--path) runs its server.mjs directly, so edits apply on the next Desktop restart.
export function refigmaEntry(name, { node, version, dir, python }) {
  const env = IS_WIN ? (python && { REFIGMA_PYTHON: python }) : { PATH: pathFor(node) };
  const entry = { name, transport: 'stdio', ...(env && { env }) };
  if (dir) return { ...entry, command: node, args: [path.join(dir, 'server.mjs')] };
  const { command, pre } = npx(node);
  return { ...entry, command, args: [...pre, '-y', tarballUrl(version)] };
}

// Starts the entry once and completes the MCP handshake: npx downloads and caches the
// package here instead of inside Desktop's startup timeout, and a broken install shows now.
export function probe(entry, { timeoutMs = 180_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(entry.command, entry.args, { env: { ...process.env, ...entry.env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let out = '', err = '';
    const done = (r) => { clearTimeout(timer); child.kill(); resolve(r); };
    const timer = setTimeout(() => done({ ok: false, error: `no answer after ${timeoutMs / 1000}s` }), timeoutMs);
    child.on('error', (e) => done({ ok: false, error: e.message }));
    child.on('exit', (code) => done({ ok: false, error: `exited (${code}) ${err.trim().split('\n').slice(-3).join(' ')}`.trim() }));
    child.stderr.on('data', (d) => { err += d; });
    child.stdout.on('data', (d) => {
      out += d;
      for (const line of out.split('\n')) {
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1) return done(msg.result ? { ok: true, server: msg.result.serverInfo } : { ok: false, error: msg.error?.message });
      }
    });
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'ccgw', version: '0' } },
    }) + '\n');
  });
}
