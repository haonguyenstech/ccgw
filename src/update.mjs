// Update check against GitHub releases. `releases/latest` redirects to
// `releases/tag/vX.Y.Z`, so reading the redirect needs no API call or token.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { HOME_DIR } from './config.mjs';
import { IS_WIN } from './platform.mjs';

// CCGW_UPDATE_URL points tests at a local stand-in for the releases page.
const RELEASES = process.env.CCGW_UPDATE_URL || 'https://github.com/haonguyenstech/ccgw/releases';
const CACHE_FILE = path.join(HOME_DIR, 'update-check.json');
const DAY = 24 * 60 * 60 * 1000;

export const downloadUrl = (version) => `${RELEASES}/download/v${version}/ccgw.tgz`;

const parse = (v) => String(v).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
export function isNewer(a, b) {
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
}

export async function fetchLatest(timeoutMs = 5000) {
  const r = await fetch(`${RELEASES}/latest`, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
  const m = /\/tag\/v?(\d+\.\d+\.\d+)/.exec(r.headers.get('location') || '');
  if (!m) throw new Error(`no release found (HTTP ${r.status})`);
  return m[1];
}

const readCache = () => { try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch { return {}; } };

// Latest version, hitting the network at most once a day. Unless forced it never
// throws: an offline machine just sees no notice.
export async function checkForUpdate({ force = false, timeoutMs = 2000 } = {}) {
  if (process.env.CCGW_NO_UPDATE_CHECK && !force) return null;
  const cache = readCache();
  if (!force && cache.checkedAt && Date.now() - (cache.checkedAt || 0) < DAY) return cache.latest;
  let latest = cache.latest || null;
  try {
    latest = await fetchLatest(timeoutMs);
  } catch {
    if (force) throw new Error('could not reach GitHub to check for updates');
  }
  // Recorded on failure too, so an offline machine is not retried on every command.
  try {
    fs.mkdirSync(HOME_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ checkedAt: Date.now(), latest }) + '\n');
  } catch {}
  return latest;
}

export const cachedLatest = () => readCache().latest || null;

// npm prefix the running copy was installed under: <prefix>/lib/node_modules/ccgw
// (macOS/Linux) or <prefix>\node_modules\ccgw (Windows). Reinstalling there
// replaces this copy even when the installer fell back to ~/.local.
function installPrefix(root) {
  const nm = path.dirname(root);
  if (path.basename(nm) !== 'node_modules') return null;
  const up = path.dirname(nm);
  return !IS_WIN && path.basename(up) === 'lib' ? path.dirname(up) : up;
}

// Same npm command as install.sh / install.ps1. Returns the exit status.
export function installVersion(root, version) {
  const args = ['install', '-g', '--omit=optional', '--no-fund', '--no-audit'];
  const prefix = installPrefix(root);
  if (prefix) args.push('--prefix', prefix);
  args.push(downloadUrl(version));
  // npm is npm.cmd on Windows, which spawn only runs through a shell.
  const r = spawnSync(IS_WIN ? 'npm.cmd' : 'npm', args.map((a) => (IS_WIN && /\s/.test(a) ? `"${a}"` : a)), { stdio: 'inherit', shell: IS_WIN });
  return r.status ?? 1;
}
