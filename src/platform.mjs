// OS-specific bits: locating `claude`, the clipboard, and Claude Desktop's
// data dirs and process.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';

export const IS_WIN = process.platform === 'win32';
export const IS_MAC = process.platform === 'darwin';

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 20_000, ...opts });

const ps = (script) => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]).trim();

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The user's installed `claude` (kept current by its own updater) rather than
// the SDK's bundled copy, which lags behind and rejects newer models. On
// Windows only a real .exe can be spawned directly; an npm .cmd shim can't.
export function findClaude(override) {
  if (override) return override;
  try {
    if (IS_WIN) {
      const native = path.join(os.homedir(), '.local', 'bin', 'claude.exe');
      let hits = [];
      try { hits = run('where.exe', ['claude']).split(/\r?\n/).map((s) => s.trim()).filter(Boolean); } catch {}
      const exe = hits.find((h) => h.toLowerCase().endsWith('.exe'));
      if (exe) return exe;
      if (fs.existsSync(native)) return native;
      // npm install: resolve the .cmd shim to the package's binary or cli.js
      // (the SDK runs a .js path with node).
      for (const shim of hits) {
        const pkg = path.join(path.dirname(shim), 'node_modules', '@anthropic-ai', 'claude-code');
        for (const f of ['bin/claude.exe', 'claude.exe', 'cli.js']) {
          const p = path.join(pkg, f);
          if (fs.existsSync(p)) return p;
        }
      }
      return undefined;
    }
    return run('/bin/sh', ['-lc', 'command -v claude']).trim() || undefined;
  } catch {
    return undefined;
  }
}

export function claudeAuthStatus(claudePath) {
  try {
    const [cmd, args] = claudePath.endsWith('.js') ? [process.execPath, [claudePath]] : [claudePath, []];
    return JSON.parse(run(cmd, [...args, 'auth', 'status']));
  } catch {
    return null;
  }
}

export function copyToClipboard(text) {
  const tries = IS_MAC ? [['pbcopy', []]] : IS_WIN ? [['clip.exe', []]] : [['wl-copy', []], ['xclip', ['-selection', 'clipboard']], ['xsel', ['-bi']]];
  for (const [cmd, args] of tries) {
    try { execFileSync(cmd, args, { input: text, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true }); return true; } catch {}
  }
  return false;
}

// ---------------------------------------------------------------- Claude Desktop

// Desktop keeps its third-party ("3p") mode in a separate data dir from its
// claude.ai ("1p") mode. Paths match Desktop's own resolution.
// CCGW_DESKTOP_DIR points ccgw at a scratch copy (tests) and leaves the real
// Desktop process alone.
const FAKE_DESKTOP = !!process.env.CCGW_DESKTOP_DIR;

export function desktop3pDir() {
  if (FAKE_DESKTOP) return process.env.CCGW_DESKTOP_DIR;
  if (IS_WIN) return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Claude-3p');
  if (IS_MAC) return path.join(os.homedir(), 'Library', 'Application Support', 'Claude-3p');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'Claude-3p');
}

export const desktopSupported = IS_MAC || IS_WIN;

// Desktop and the Claude Code CLI are both `claude.exe` on Windows; only match
// Desktop's install locations (Squirrel under AnthropicClaude, or MSIX).
const WIN_DESKTOP_FILTER = `Get-Process claude -ErrorAction SilentlyContinue | Where-Object { $_.Path -match '\\\\AnthropicClaude\\\\|\\\\WindowsApps\\\\' }`;

function desktopPids() {
  if (FAKE_DESKTOP) return [];
  try {
    if (IS_MAC) return run('pgrep', ['-x', 'Claude']).split(/\s+/).filter(Boolean);
    if (IS_WIN) return ps(`${WIN_DESKTOP_FILTER} | ForEach-Object { $_.Id }`).split(/\s+/).filter(Boolean);
  } catch {}
  return [];
}

export const desktopRunning = () => desktopPids().length > 0;

// Desktop's quit runs cleanup (Cowork VM, MCP servers) that can take a while;
// wait for it to be fully gone, or a relaunch lands on the dying instance.
export async function quitDesktop() {
  if (!desktopRunning()) return false;
  try {
    if (IS_MAC) run('osascript', ['-e', 'quit app "Claude"']);
    // Closing the window only hides Desktop to the tray on Windows.
    if (IS_WIN) ps(`${WIN_DESKTOP_FILTER} | Stop-Process -Force`);
  } catch {}
  for (let i = 0; i < 150 && desktopRunning(); i++) await sleep(200);
  if (desktopRunning()) {
    try { IS_MAC ? run('pkill', ['-x', 'Claude']) : ps(`${WIN_DESKTOP_FILTER} | Stop-Process -Force`); } catch {}
    for (let i = 0; i < 25 && desktopRunning(); i++) await sleep(200);
  }
  return true;
}

function launchDesktop() {
  if (IS_MAC) return run('open', ['-a', 'Claude']);
  if (IS_WIN) {
    const squirrel = path.join(process.env.LOCALAPPDATA || '', 'AnthropicClaude', 'claude.exe');
    if (fs.existsSync(squirrel)) {
      spawn(squirrel, [], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
      return;
    }
    ps(`$a = Get-StartApps | Where-Object { $_.Name -eq 'Claude' } | Select-Object -First 1; if ($a) { Start-Process ("shell:AppsFolder\\" + $a.AppID) }`);
  }
}

// Succeeds only once a Desktop process that wasn't there before shows up.
export async function openDesktop() {
  if (FAKE_DESKTOP) return true;
  const before = new Set(desktopPids());
  if (before.size) { try { launchDesktop(); } catch {} return true; } // just bring it forward
  const started = () => desktopPids().some((p) => !before.has(p));
  for (let i = 0; i < 10; i++) {
    try { launchDesktop(); } catch {}
    for (let j = 0; j < 10; j++) {
      await sleep(300);
      if (started()) return true;
    }
  }
  return false;
}
