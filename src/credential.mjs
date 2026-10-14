// Credential provider: an outside command that keeps Claude Code's login fresh
// (e.g. a team tool that hands out a shared login on a live countdown). ccgw
// only reads the token's expiry, opens the provider's sign-in in a terminal
// window when it runs out, and tells Desktop why instead of failing obscurely.
//
// config.json:
//   "credential": {
//     "name": "my-login-tool",          // shown in the menu and errors
//     "login": "my-login-tool login",   // run in a terminal window (needs a TTY)
//     "status": "<shell command>",      // optional, first line of output is shown
//     "renewMinutes": 10,               // open the sign-in this long before expiry
//     "autoLogin": true                 // let the gateway open it by itself
//   }
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { HOME_DIR, readConfig } from './config.mjs';

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

export const provider = (cfg = readConfig()) => (cfg.credential?.login ? { renewMinutes: 10, autoLogin: false, name: cfg.credential.login.split(/\s+/)[0], ...cfg.credential } : null);

// Claude Code keeps its login in the macOS Keychain, elsewhere in ~/.claude.
// CCGW_CLAUDE_CREDENTIALS points tests at a JSON file instead.
export function claudeToken() {
  let raw = null;
  try {
    const file = process.env.CCGW_CLAUDE_CREDENTIALS;
    if (file) raw = fs.readFileSync(file, 'utf8');
    else if (IS_MAC) raw = execFileSync('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
    else raw = fs.readFileSync(path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), '.credentials.json'), 'utf8');
  } catch {
    return null;
  }
  try {
    const o = JSON.parse(raw).claudeAiOauth;
    return o?.expiresAt ? { expiresAt: Number(o.expiresAt) } : null;
  } catch {
    return null;
  }
}

// "3h 12m" / "8m" / "expired".
export function timeLeft(expiresAt, now = Date.now()) {
  const m = Math.floor((expiresAt - now) / 60_000);
  if (m < 0) return 'expired';
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
}

export function statusLine(p) {
  if (!p?.status) return '';
  try {
    const sh = IS_WIN ? ['cmd.exe', ['/d', '/s', '/c', p.status]] : [process.env.SHELL || '/bin/sh', ['-lc', p.status]];
    return execFileSync(sh[0], sh[1], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, windowsHide: true }).split('\n')[0].trim();
  } catch {
    return '';
  }
}

// Is the provider's sign-in already running (e.g. its countdown in a terminal)?
export function loginRunning(p) {
  if (!p) return false;
  const needle = p.login.trim();
  try {
    if (IS_WIN) {
      const q = needle.replace(/'/g, "''");
      return !!execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${q}*' -and $_.ProcessId -ne $PID } | Select-Object -First 1 -ExpandProperty ProcessId`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000, windowsHide: true }).trim();
    }
    const pattern = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return execFileSync('pgrep', ['-f', pattern], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split(/\s+/).filter(Boolean).some((pid) => Number(pid) !== process.pid);
  } catch {
    return false;
  }
}

// Opens a new terminal window running the sign-in: it needs a real TTY to keep
// the login current. CCGW_LOGIN_LOG records the call instead (tests).
export function openLogin(p) {
  if (process.env.CCGW_LOGIN_LOG) {
    fs.appendFileSync(process.env.CCGW_LOGIN_LOG, p.login + '\n');
    return true;
  }
  try {
    if (IS_MAC) {
      // A .command file opens in Terminal without needing Automation permission.
      const file = path.join(HOME_DIR, 'credential-login.command');
      const shell = process.env.SHELL || '/bin/zsh';
      fs.writeFileSync(file, `#!/bin/sh\nprintf '\\033]0;%s\\007' ${JSON.stringify(`${p.name} (ccgw)`)}\nexec ${shell} -lc ${shQuote(p.login)}\n`, { mode: 0o755 });
      execFileSync('open', ['-a', 'Terminal', file], { stdio: 'ignore' });
    } else if (IS_WIN) {
      spawn('cmd.exe', ['/d', '/c', 'start', `"${p.name} (ccgw)"`, 'cmd.exe', '/k', p.login], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
    } else {
      spawn('x-terminal-emulator', ['-e', 'sh', '-c', p.login], { detached: true, stdio: 'ignore' }).unref();
    }
    return true;
  } catch {
    return false;
  }
}

const shQuote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
