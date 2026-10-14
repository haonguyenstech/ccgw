// refigma-mcp (github.com/haonguyenstech/refigma-mcp) reads Figma frames through a
// headless Edge signed in to figma.com — no REST quota, plugin or Edit seat — and
// turns them into a layout tree, HTML / React + Tailwind, SVG, tokens and PNG.
// It is a separate stdio server; ccgw only writes the Desktop entry that runs it,
// either a pinned release tarball through npx or a local checkout (--path).
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { IS_MAC } from './platform.mjs';

const REPO = 'haonguyenstech/refigma-mcp';
const FALLBACK_VERSION = '0.4.0';
const EDGE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
const MIN_NODE = [22, 15];

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
  if (!IS_MAC) return ['refigma-mcp runs on macOS only (it drives Microsoft Edge and reads its cookies from the Keychain)'];
  const out = [];
  const [maj, min] = process.versions.node.split('.').map(Number);
  if (maj < MIN_NODE[0] || (maj === MIN_NODE[0] && min < MIN_NODE[1])) out.push(`Node ${MIN_NODE.join('.')}+ needed (${node} is ${process.version})`);
  if (!fs.existsSync(EDGE)) out.push('Microsoft Edge not found — install it and sign in to figma.com');
  if (spawnSync('python3', ['-c', 'import cryptography'], { stdio: 'ignore' }).status !== 0) out.push('Python 3 with cryptography needed: python3 -m pip install cryptography');
  return out;
}

// Desktop starts stdio servers with a bare PATH; npx and refigma's python3/curl need these.
const pathFor = (node) => [path.dirname(node), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']
  .filter((d, i, a) => a.indexOf(d) === i).join(':');

// A local checkout (--path) runs its server.mjs directly, so edits apply on the next Desktop restart.
export function refigmaEntry(name, { node, version, dir }) {
  const entry = { name, transport: 'stdio', env: { PATH: pathFor(node) } };
  if (dir) return { ...entry, command: node, args: [path.join(dir, 'server.mjs')] };
  return { ...entry, command: path.join(path.dirname(node), 'npx'), args: ['-y', tarballUrl(version)] };
}

// Starts the entry once and completes the MCP handshake: npx downloads and caches the
// package here instead of inside Desktop's startup timeout, and a broken install shows now.
export function probe(entry, { timeoutMs = 180_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(entry.command, entry.args, { env: { ...process.env, ...entry.env }, stdio: ['pipe', 'pipe', 'pipe'] });
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
