// refigma-mcp (github.com/haonguyenstech/refigma-mcp) reads Figma frames through a
// headless Edge signed in to figma.com — no REST quota, plugin or Edit seat — and
// turns them into a layout tree, HTML / React + Tailwind, SVG, tokens and PNG.
// It is a separate stdio server; ccgw only writes the Desktop entry that runs it,
// either a pinned release tarball through npx or a local checkout (--path).
import fs from 'node:fs';
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
  if (IS_WIN && !pythonOk()) out.push('Python 3 needed: install it from python.org (tick "Add python.exe to PATH") or the Microsoft Store, then open a new terminal');
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
export function refigmaEntry(name, { node, version, dir }) {
  const entry = { name, transport: 'stdio', ...(!IS_WIN && { env: { PATH: pathFor(node) } }) };
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
