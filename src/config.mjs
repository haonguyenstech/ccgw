import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const HOME_DIR = process.env.CCGW_HOME || path.join(os.homedir(), '.ccgw');
export const CONFIG_FILE = path.join(HOME_DIR, 'config.json');
export const PID_FILE = path.join(HOME_DIR, 'gateway.pid');
export const LOG_FILE = path.join(HOME_DIR, 'gateway.log');

const DEFAULTS = {
  host: '127.0.0.1',
  port: 8787,
  maxSessions: 12,
  sessionTtlMinutes: 60,
  warmPool: 2,
  expose1m: false,
};

export const newKey = () => 'sk-ccgw-' + crypto.randomBytes(24).toString('base64url');

export function readConfig() {
  fs.mkdirSync(HOME_DIR, { recursive: true, mode: 0o700 });
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch {}
  const merged = { ...DEFAULTS, ...cfg };
  if (!merged.apiKey) {
    merged.apiKey = newKey();
    writeConfig(merged);
  }
  return merged;
}

export function writeConfig(cfg) {
  fs.mkdirSync(HOME_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
}
