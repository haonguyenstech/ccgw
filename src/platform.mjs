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

// Each main Desktop process (no --type=) with the data dir its children were
// started with: the main process's own command line does not carry it.
const WIN_DESKTOP_PROCS = `$all = @(Get-CimInstance Win32_Process -Filter "Name='claude.exe'" | Where-Object { $_.ExecutablePath -match '\\\\AnthropicClaude\\\\|\\\\WindowsApps\\\\' }); foreach ($m in $all | Where-Object { $_.CommandLine -notmatch '--type=' }) { $d = ''; foreach ($k in $all | Where-Object { $_.ParentProcessId -eq $m.ProcessId -and $_.CommandLine -notmatch 'crashpad' }) { $x = [regex]::Match($k.CommandLine, '--user-data-dir=("[^"]+"|\\S+)'); if ($x.Success) { $d = $x.Groups[1].Value.Trim('"'); break } }; "$($m.ProcessId)\`t$d" }`;

// A second, claude.ai-signed-in Desktop can run next to the gateway one.
// macOS: started with its own --user-data-dir, it reads deploymentMode from
// "<dir>-3p". Windows: the mode always comes from %LOCALAPPDATA%\Claude-3p and
// is read only at startup, so the official instance is Desktop's own
// claude.ai-mode one, started while the mode says "1p" (the caller flips it).
// A claude:// link (sign-in) starts a new Desktop process there, which picks
// its data dir from the mode and hands the link to the instance holding it.
export const officialSupported = IS_MAC || IS_WIN;

export function officialDir() {
  if (FAKE_DESKTOP) return path.join(process.env.CCGW_DESKTOP_DIR, 'official', 'Claude-Official');
  if (IS_WIN) {
    // MSIX keeps the app's %APPDATA% in the package's LocalCache.
    const pkgs = path.join(process.env.LOCALAPPDATA || '', 'Packages');
    try {
      const fam = fs.readdirSync(pkgs).find((d) => /^Claude_[a-z0-9]+$/i.test(d));
      const virt = fam && path.join(pkgs, fam, 'LocalCache', 'Roaming', 'Claude');
      if (virt && fs.existsSync(virt)) return virt;
    } catch {}
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Claude');
  }
  return path.join(os.homedir(), 'Library', 'Application Support', 'Claude-Official');
}

// Main Desktop processes, tagged with whether they are the official instance.
// On Windows each listing is a PowerShell run (1-3 s) and a menu redraw or a
// wait loop asks several times in a row, so a listing is reused for a second;
// anything that starts or stops Desktop drops it.
let procCache = null;
const fresh = () => { procCache = null; };

function desktopProcs() {
  if (FAKE_DESKTOP) return [];
  if (IS_WIN && procCache && Date.now() - procCache.at < 1000) return procCache.list;
  const list = listProcs();
  if (IS_WIN) procCache = { at: Date.now(), list };
  return list;
}

function listProcs() {
  try {
    if (IS_MAC) {
      const pids = run('pgrep', ['-x', 'Claude']).split(/\s+/).filter(Boolean);
      if (!pids.length) return [];
      const flag = `--user-data-dir=${officialDir()}`;
      return run('ps', ['-o', 'pid=,command=', '-p', pids.join(',')]).split('\n').filter(Boolean).map((line) => {
        const [, pid, cmd] = line.match(/^\s*(\d+)\s+(.*)$/) || [];
        return { pid, official: !!cmd && cmd.includes(flag) };
      }).filter((p) => p.pid);
    }
    if (IS_WIN) {
      // Anything not on the gateway's Claude-3p dir is the claude.ai-mode one.
      const gw = path.basename(desktop3pDir()).toLowerCase();
      return ps(WIN_DESKTOP_PROCS).split(/\r?\n/).filter(Boolean).map((line) => {
        const [pid, dir = ''] = line.split('\t');
        return { pid: pid.trim(), dir, official: !!dir && path.basename(dir.trim()).toLowerCase() !== gw };
      }).filter((p) => p.pid);
    }
  } catch {}
  return [];
}

// The gateway Desktop only: the official instance is never quit or relaunched
// by anything that restarts the gateway one.
const desktopPids = () => desktopProcs().filter((p) => !p.official).map((p) => p.pid);
const officialPids = () => desktopProcs().filter((p) => p.official).map((p) => p.pid);

export const desktopRunning = () => desktopPids().length > 0;
export const officialRunning = () => officialPids().length > 0;

// Brings a running instance forward by pid. Starting Desktop again is no way
// to do that: it does not hold a single-instance lock per data dir, so a
// second process would run on the same profile.
function activate(pid) {
  try {
    if (IS_WIN) return ps(`[void](New-Object -ComObject WScript.Shell).AppActivate(${Number(pid)})`);
    run('osascript', ['-l', 'JavaScript', '-e',
      `ObjC.import('AppKit'); var a = $.NSRunningApplication.runningApplicationWithProcessIdentifier(${Number(pid)}); a.isNil() ? false : a.activateWithOptions($.NSApplicationActivateAllWindows)`]);
  } catch {}
}

const signal = (pids, sig) => { for (const pid of pids) { try { process.kill(Number(pid), sig); } catch {} } fresh(); };
// Windows has no graceful signal for a GUI app; /T takes the instance's own
// renderers and helpers with it and nothing else.
const killTree = (pids) => { for (const pid of pids) { try { run('taskkill.exe', ['/PID', String(pid), '/T', '/F']); } catch {} } fresh(); };

// Polls by the clock, not by count: a check can itself take seconds.
async function until(cond, ms, step = 300) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(step);
  }
  return cond();
}

// Desktop's quit runs cleanup (Cowork VM, MCP servers) that can take a while;
// wait for it to be fully gone, or a relaunch lands on the dying instance.
// With the official instance up, "quit app" could hit either one, so the
// gateway one is quit by pid (SIGTERM is a normal quit for Electron).
export async function quitDesktop() {
  if (!desktopRunning()) return false;
  const byPid = officialRunning();
  try {
    if (byPid) IS_WIN ? killTree(desktopPids()) : signal(desktopPids(), 'SIGTERM');
    else if (IS_MAC) run('osascript', ['-e', 'quit app "Claude"']);
    // Closing the window only hides Desktop to the tray on Windows.
    else if (IS_WIN) ps(`${WIN_DESKTOP_FILTER} | Stop-Process -Force`);
  } catch {}
  fresh();
  await until(() => !desktopRunning(), 30_000, 200);
  if (desktopRunning()) {
    try {
      if (byPid) IS_WIN ? killTree(desktopPids()) : signal(desktopPids(), 'SIGKILL');
      else IS_MAC ? run('pkill', ['-x', 'Claude']) : ps(`${WIN_DESKTOP_FILTER} | Stop-Process -Force`);
    } catch {}
    fresh();
    await until(() => !desktopRunning(), 5000, 200);
  }
  return true;
}

function launchDesktop() {
  if (IS_MAC) {
    const [pid] = desktopPids();
    if (pid) return activate(pid);
    // `open -a` would only bring the official instance forward.
    return run('open', officialRunning() ? ['-n', '-a', 'Claude'] : ['-a', 'Claude']);
  }
  if (IS_WIN) {
    const [pid] = desktopPids();
    if (pid) return activate(pid);
    const squirrel = path.join(process.env.LOCALAPPDATA || '', 'AnthropicClaude', 'claude.exe');
    if (fs.existsSync(squirrel)) {
      spawn(squirrel, [], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
      return;
    }
    ps(`$a = Get-StartApps | Where-Object { $_.Name -eq 'Claude' } | Select-Object -First 1; if ($a) { Start-Process ("shell:AppsFolder\\" + $a.AppID) }`);
  }
}

function launchOfficial() {
  if (IS_MAC) return run('open', ['-n', '-a', 'Claude', '--args', `--user-data-dir=${officialDir()}`]);
  const squirrel = path.join(process.env.LOCALAPPDATA || '', 'AnthropicClaude', 'claude.exe');
  if (fs.existsSync(squirrel)) {
    spawn(squirrel, [], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
    return;
  }
  ps(`$a = Get-StartApps | Where-Object { $_.Name -eq 'Claude' } | Select-Object -First 1; if ($a) { Start-Process ("shell:AppsFolder\\" + $a.AppID) }`);
}

// Succeeds only once a Desktop process that wasn't there before shows up.
export async function openDesktop() {
  if (FAKE_DESKTOP) return true;
  const before = new Set(desktopPids());
  if (before.size) { try { launchDesktop(); } catch {} return true; } // just bring it forward
  // On Windows a launch in login mode comes up as the claude.ai-mode instance.
  const pids = IS_WIN ? () => desktopProcs().map((p) => p.pid) : desktopPids;
  const old = new Set(pids());
  const started = () => pids().some((p) => !old.has(p));
  // Windows is slow to list processes, so it launches less often and waits longer.
  for (let i = 0; i < (IS_WIN ? 3 : 10); i++) {
    try { launchDesktop(); } catch {}
    fresh();
    if (await until(started, IS_WIN ? 10_000 : 3000)) return true;
  }
  return false;
}

// Resolves once the official instance is up. On Windows it is told apart by
// its children's data dir, which only exist once it is past the mode read; one
// that read "3p" hands off to the gateway instance and exits.
export async function openOfficial() {
  if (FAKE_DESKTOP) return true;
  const [running] = officialPids();
  if (running) { activate(running); return true; }
  try { launchOfficial(); } catch { return false; }
  fresh();
  return until(officialRunning, 30_000);
}

export async function quitOfficial() {
  if (!officialRunning()) return false;
  if (IS_WIN) killTree(officialPids());
  else signal(officialPids(), 'SIGTERM');
  await until(() => !officialRunning(), 30_000, 200);
  if (officialRunning()) IS_WIN ? killTree(officialPids()) : signal(officialPids(), 'SIGKILL');
  return true;
}

// ---------------------------------------------------------------- Figma Desktop

// CCGW_FIGMA_DIR points tests at a fake settings dir and leaves the real app alone.
const FAKE_FIGMA = !!process.env.CCGW_FIGMA_DIR;

export function figmaSettingsFile() {
  if (FAKE_FIGMA) return path.join(process.env.CCGW_FIGMA_DIR, 'settings.json');
  if (IS_MAC) return path.join(os.homedir(), 'Library', 'Application Support', 'Figma', 'settings.json');
  if (IS_WIN) return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Figma', 'settings.json');
  return null; // no Figma Desktop on Linux
}

export function figmaRunning() {
  if (FAKE_FIGMA) return false;
  try {
    if (IS_MAC) return !!run('pgrep', ['-x', 'Figma']).trim();
    if (IS_WIN) return !!ps('Get-Process Figma -ErrorAction SilentlyContinue | ForEach-Object { $_.Id }');
  } catch {}
  return false;
}

// A normal quit, so open files finish syncing; forced only if it hangs.
export async function quitFigma() {
  if (!figmaRunning()) return false;
  try {
    if (IS_MAC) run('osascript', ['-e', 'quit app "Figma"']);
    if (IS_WIN) ps('Get-Process Figma -ErrorAction SilentlyContinue | ForEach-Object { [void]$_.CloseMainWindow() }');
  } catch {}
  for (let i = 0; i < 100 && figmaRunning(); i++) await sleep(200);
  if (figmaRunning()) {
    try { IS_MAC ? run('pkill', ['-x', 'Figma']) : ps('Stop-Process -Name Figma -Force'); } catch {}
    for (let i = 0; i < 25 && figmaRunning(); i++) await sleep(200);
  }
  return true;
}

export function openFigma() {
  if (FAKE_FIGMA) return;
  try {
    if (IS_MAC) run('open', ['-a', 'Figma']);
    if (IS_WIN) {
      const exe = path.join(process.env.LOCALAPPDATA || '', 'Figma', 'Figma.exe');
      if (fs.existsSync(exe)) spawn(exe, [], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {}
}
