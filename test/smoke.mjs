// Cross-platform smoke test that needs no Claude login: CLI lifecycle, HTTP
// surface, and survival when the Claude Code CLI can't be spawned.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccgw-smoke-'));
const port = 18000 + Math.floor(Math.random() * 1000);
const desktopDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccgw-desktop-'));
const env = { ...process.env, CCGW_HOME: home, CCGW_DESKTOP_DIR: desktopDir, CCGW_SKIP_AUTH_CHECK: '1', CCGW_NO_CLIPBOARD: '1', NO_COLOR: '1' };
fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ port, apiKey: 'sk-ccgw-smoke' }));

const ccgw = (...args) => execFileSync(process.execPath, [path.join(root, 'bin/ccgw.mjs'), ...args], { env, encoding: 'utf8', timeout: 60_000 });
const base = `http://127.0.0.1:${port}`;
const auth = { authorization: 'Bearer sk-ccgw-smoke' };
let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${extra}`); if (!ok) failed++; };

try {
  check('--version', /^\d+\.\d+\.\d+/.test(ccgw('--version').trim()));
  check('no args without a TTY prints help', ccgw().includes('ccgw start'));
  const out = ccgw('start');
  check('start prints base URL', out.includes(base), out.split('\n')[0]);
  check('start prints key', out.includes('sk-ccgw-smoke'));

  const h = await (await fetch(base + '/health')).json();
  check('/health', h.name === 'ccgw', JSON.stringify(h));
  check('/v1/models no key -> 401', (await fetch(base + '/v1/models')).status === 401);
  const models = await (await fetch(base + '/v1/models', { headers: auth })).json();
  check('/v1/models', models.data?.length >= 3, models.data?.map((m) => m.id).join(','));
  const xkey = await fetch(base + '/v1/models', { headers: { 'x-api-key': 'sk-ccgw-smoke' } });
  check('x-api-key auth', xkey.status === 200);
  const bad = await fetch(base + '/v1/messages', { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: '{"messages":[]}' });
  check('empty messages -> 400', bad.status === 400);

  check('status running', ccgw('status').includes('running'));
  check('info', ccgw('info').includes(base));
  const again = ccgw('start');
  check('second start is idempotent', again.includes('already running'));

  if (process.platform === 'darwin' || process.platform === 'win32') {
    check('desktop status', ccgw('desktop', 'status').includes('Claude Desktop:'));
    // CCGW_DESKTOP_DIR keeps these off the real Desktop config and process.
    {
      check('connector add', ccgw('connector', 'add', 'clickup', '--no-restart').includes('added'));
      check('connector add custom', ccgw('connector', 'add', 'acme', '--url', 'https://mcp.example.com/mcp', '--no-restart').includes('added'));
      ccgw('desktop', 'profile'); // rewriting the gateway profile must keep connectors
      const list = ccgw('connector', 'list');
      check('connectors survive profile rewrite', list.includes('clickup') && list.includes('acme'), list.trim().split('\n')[0]);
      ccgw('connector', 'remove', 'acme', '--no-restart');
      check('connector remove', !ccgw('connector', 'list').includes('acme'));
    }
  }

  ccgw('stop');
  let down = false;
  try { await fetch(base + '/health', { signal: AbortSignal.timeout(1000) }); } catch { down = true; }
  check('stop', down);
  check('status stopped', ccgw('status').includes('stopped'));
} catch (e) {
  check('unexpected error', false, e.stack || e.message);
  try { console.log(fs.readFileSync(path.join(home, 'gateway.log'), 'utf8')); } catch {}
  try { ccgw('stop'); } catch {}
}

console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
process.exit(failed ? 1 : 0);
