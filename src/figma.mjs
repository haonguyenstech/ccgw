// Figma without the remote MCP server's plan limits (Starter: a handful of calls
// a month). Talk to Figma (grab/cursor-talk-to-figma-mcp) drives Figma Desktop
// through a plugin and the Plugin API, so nothing goes through Figma's REST API:
//
//   Desktop ⇄ stdio ⇄ talk-to-figma server ⇄ ws://localhost:3055 (relay) ⇄ plugin
//
// `ccgw figma mcp` is the stdio entry: it holds the relay and runs the server.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { HOME_DIR } from './config.mjs';
import { IS_WIN } from './platform.mjs';

const PACKAGE = 'cursor-talk-to-figma-mcp';
const VERSION = '0.3.5'; // the patch below targets this build
export const FIGMA_DIR = path.join(HOME_DIR, 'figma');
export const PLUGIN_MANIFEST = path.join(FIGMA_DIR, 'plugin', 'manifest.json');
export const RELAY_PORT = 3055; // the plugin's manifest only allows this port
const CHANNEL = 'ccgw';
const PLUGIN_SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'figma-plugin');
const SERVER = path.join(FIGMA_DIR, 'node_modules', PACKAGE, 'dist', 'server.js');
const PATCHED = path.join(FIGMA_DIR, 'server.mjs');

const installedVersion = () => {
  try {
    return JSON.parse(fs.readFileSync(path.join(FIGMA_DIR, 'node_modules', PACKAGE, 'package.json'), 'utf8')).version;
  } catch { return null; }
};
export const figmaInstalled = () => installedVersion() === VERSION;

// Figma caches imported plugins, so the files live at one path that never moves.
function copyPlugin() {
  const dir = path.dirname(PLUGIN_MANIFEST);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(PLUGIN_SRC)) fs.copyFileSync(path.join(PLUGIN_SRC, f), path.join(dir, f));
}

// The server forgets its channel on every (re)connect and refuses to send until
// the model calls join_channel with a name it has to ask the user for. The ccgw
// relay has a single room, so pin the channel instead.
function patchServer() {
  let src = fs.readFileSync(SERVER, 'utf8');
  const pins = [['var currentChannel = null;', `var currentChannel = "${CHANNEL}";`],
    ['    currentChannel = null;\n', `    currentChannel = "${CHANNEL}";\n`],
    // and stop the model from calling join_channel (or asking for a channel name)
    ['- Always join the appropriate channel first with \\`join_channel()\\`\n', ''],
    ['"Join a specific channel to communicate with Figma"',
      '"Not needed: ccgw is already connected to Figma. Never call this; if a tool says the plugin is not connected, ask the user to run the ccgw Figma Bridge plugin."']];
  for (const [from, to] of pins) {
    if (!src.includes(from)) throw new Error(`${PACKAGE}@${VERSION} no longer matches the ccgw patch`);
    src = src.replace(from, to);
  }
  // Same directory as node_modules, so its imports still resolve.
  fs.writeFileSync(PATCHED, src);
}

export function installFigma({ log = () => {} } = {}) {
  if (!figmaInstalled()) {
    fs.mkdirSync(FIGMA_DIR, { recursive: true });
    if (!fs.existsSync(path.join(FIGMA_DIR, 'package.json'))) {
      fs.writeFileSync(path.join(FIGMA_DIR, 'package.json'), '{ "private": true, "type": "module" }\n');
    }
    log(`installing ${PACKAGE}@${VERSION} into ${FIGMA_DIR} …`);
    // npm-cli.js through this node needs no shell, so "C:\Program Files" is fine.
    const bin = path.dirname(process.execPath);
    const cli = [path.join(bin, 'node_modules', 'npm', 'bin', 'npm-cli.js'), path.join(bin, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')]
      .find((f) => fs.existsSync(f));
    const npmArgs = ['install', `${PACKAGE}@${VERSION}`, '--no-audit', '--no-fund', '--omit=dev', '--loglevel=error'];
    const [cmd, argv] = cli ? [process.execPath, [cli, ...npmArgs]]
      : fs.existsSync(path.join(bin, 'npm')) && !IS_WIN ? [path.join(bin, 'npm'), npmArgs] : ['npm', npmArgs];
    const r = spawnSync(cmd, argv, { cwd: FIGMA_DIR, stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8', shell: IS_WIN && !cli });
    if (r.status !== 0) throw new Error(`npm install ${PACKAGE} failed: ${(r.stderr || r.error?.message || '').trim()}`);
  }
  patchServer(); // every start, so a ccgw update ships its patch too
  copyPlugin();
}

const NO_PLUGIN = 'The ccgw Figma Bridge plugin is not connected, so Figma cannot be reached. ' +
  'Tell the user: open the file in Figma Desktop and run Plugins → Development → ccgw Figma Bridge ' +
  '(it connects by itself; first time: Plugins → Development → Import plugin from manifest… → ' +
  PLUGIN_MANIFEST + '). Then try again.';
const PLUGIN_GONE = 'The ccgw Figma Bridge plugin disconnected before answering (plugin closed or Figma quit). ' +
  'Ask the user to run Plugins → Development → ccgw Figma Bridge again, then retry.';

// Plugins (they join without a request id) take commands; everyone else is an
// MCP server sending them. Commands go to the plugin that connected last, so a
// second open file never runs the same edit twice. With no plugin, a command
// fails at once with what the user has to do, instead of a 30 s timeout.
function startRelay(WebSocketServer, onListening) {
  const wss = new WebSocketServer({ noServer: true });
  const plugins = new Set();
  const pending = new Map(); // request id → { from: MCP server socket, to: plugin socket }
  const send = (ws, v) => { if (ws.readyState === 1) ws.send(JSON.stringify(v)); };
  const fail = (ws, id, error) => send(ws, { type: 'broadcast', channel: CHANNEL, message: { id, result: {}, error } });
  // The plugin dials ws://localhost, which is ::1 first on Windows and some
  // Macs, so listen on both loopbacks (never on the LAN).
  const listen = () => {
    const v4 = http.createServer();
    v4.on('upgrade', (req, sock, head) => wss.handleUpgrade(req, sock, head, (ws) => wss.emit('connection', ws)));
    v4.on('listening', () => {
      onListening();
      const v6 = http.createServer();
      v6.on('upgrade', (req, sock, head) => wss.handleUpgrade(req, sock, head, (ws) => wss.emit('connection', ws)));
      v6.on('error', () => {}); // no IPv6 loopback
      v6.listen(RELAY_PORT, '::1');
    });
    // Another ccgw figma process already relays; take over if it exits.
    v4.on('error', () => setTimeout(listen, 3000).unref());
    v4.listen(RELAY_PORT, '127.0.0.1');
  };
  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      let data;
      try { data = JSON.parse(raw); } catch { return; }
      const msg = data.message || {};
      if (data.type === 'join') {
        const channel = typeof data.channel === 'string' && data.channel ? data.channel : CHANNEL;
        if (!data.message) { plugins.delete(ws); plugins.add(ws); } // re-add: now the latest
        send(ws, { type: 'system', message: `Joined channel: ${channel}`, channel });
        send(ws, { type: 'system', message: { id: data.id, result: `Connected to channel: ${channel}` }, channel });
        return;
      }
      if (plugins.has(ws)) {
        // A result, or progress on one, goes back to whoever asked.
        const id = data.type === 'progress_update' ? data.id : msg.id;
        const to = pending.get(id)?.from;
        const out = data.type === 'progress_update' ? data : { type: 'broadcast', message: msg, sender: 'peer', channel: CHANNEL };
        if (data.type === 'message' && (msg.result !== undefined || msg.error)) pending.delete(id);
        if (to) send(to, out);
        else for (const peer of wss.clients) if (!plugins.has(peer) && peer !== ws) send(peer, out);
        return;
      }
      if (data.type !== 'message' || !msg.id) return;
      const target = [...plugins].filter((p) => p.readyState === 1).at(-1);
      if (!target) return fail(ws, msg.id, NO_PLUGIN);
      pending.set(msg.id, { from: ws, to: target });
      send(target, { type: 'broadcast', message: msg, sender: 'peer', channel: CHANNEL });
    });
    ws.on('close', () => {
      plugins.delete(ws);
      for (const [id, p] of pending) {
        if (p.to === ws) fail(p.from, id, PLUGIN_GONE);
        if (p.to === ws || p.from === ws) pending.delete(id);
      }
    });
  });
  listen();
}

export async function serveFigma() {
  installFigma({ log: (m) => process.stderr.write(`ccgw figma: ${m}\n`) });
  const { WebSocketServer } = createRequire(path.join(FIGMA_DIR, 'package.json'))('ws');
  // stdout belongs to the MCP server; the relay only logs to stderr.
  await new Promise((resolve) => {
    startRelay(WebSocketServer, resolve);
    setTimeout(resolve, 1500).unref(); // relay held elsewhere: start anyway
  });
  const child = spawn(process.execPath, [PATCHED], { stdio: 'inherit' });
  const stop = () => child.kill();
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  child.on('exit', (code) => process.exit(code ?? 0));
}

// Asks the relay who is connected: a probe client joins and sends get_document_info.
export async function figmaStatus({ timeoutMs = 4000 } = {}) {
  if (typeof WebSocket === 'undefined') return { relay: false, error: 'needs Node 22+' };
  return new Promise((resolve) => {
    let ws;
    const done = (v) => { clearTimeout(timer); try { ws.close(); } catch {} resolve(v); };
    const timer = setTimeout(() => done({ relay: true, plugin: false }), timeoutMs);
    try { ws = new WebSocket(`ws://127.0.0.1:${RELAY_PORT}`); } catch { return done({ relay: false }); }
    ws.onerror = () => done({ relay: false });
    ws.onopen = () => ws.send(JSON.stringify({
      type: 'message', channel: CHANNEL,
      message: { id: 'ccgw-status', command: 'get_document_info', params: { commandId: 'ccgw-status' } },
    }));
    ws.onmessage = (e) => {
      let data;
      try { data = JSON.parse(e.data); } catch { return; }
      if (data.message?.id === 'ccgw-status' && data.message.result) {
        const r = data.message.result;
        done({ relay: true, plugin: true, page: r.name, pages: r.pages?.length });
      }
    };
  });
}
