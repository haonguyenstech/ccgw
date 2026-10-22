// Cross-platform smoke test that needs no Claude login: CLI lifecycle, HTTP
// surface, and survival when the Claude Code CLI can't be spawned.
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import path from 'node:path';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccgw-smoke-'));
const port = 18000 + Math.floor(Math.random() * 1000);
const desktopDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccgw-desktop-'));
// Stand-in for github.com/…/releases: /latest redirects to the newest tag.
let releaseHits = 0;
const releases = http.createServer((req, res) => {
  if (req.url === '/latest') releaseHits++;
  res.writeHead(req.url === '/latest' ? 302 : 404, { location: `http://127.0.0.1:${releases.address().port}/tag/v99.0.0` }).end();
});
await new Promise((r) => releases.listen(0, '127.0.0.1', r));
const releasesUrl = `http://127.0.0.1:${releases.address().port}`;
// A stand-in Claude Code login (valid for now) and a log of sign-in windows ccgw would open.
const credFile = path.join(home, 'claude-credentials.json');
const loginLog = path.join(home, 'logins.log');
const writeToken = (expiresAt) => fs.writeFileSync(credFile, JSON.stringify({ claudeAiOauth: { expiresAt } }));
writeToken(Date.now() + 5 * 3_600_000);
const env = { ...process.env, CCGW_CLAUDE_CREDENTIALS: credFile, CCGW_LOGIN_LOG: loginLog, CCGW_UPDATE_URL: releasesUrl, CCGW_HOME: home, CCGW_DESKTOP_DIR: desktopDir, CCGW_SKIP_AUTH_CHECK: '1', CCGW_NO_CLIPBOARD: '1', NO_COLOR: '1' };
fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ port, apiKey: 'sk-ccgw-smoke' }));

const ccgw = (...args) => execFileSync(process.execPath, [path.join(root, 'bin/ccgw.mjs'), ...args], { env, encoding: 'utf8', timeout: 60_000 });
// Async variant for commands that talk to the in-process release stand-in.
const ccgwAsync = (...args) => promisify(execFile)(process.execPath, [path.join(root, 'bin/ccgw.mjs'), ...args], { env, encoding: 'utf8', timeout: 60_000 });
const base = `http://127.0.0.1:${port}`;
const auth = { authorization: 'Bearer sk-ccgw-smoke' };
// Node 20's fetch reuses a pooled keep-alive socket to the gateway that a restart
// just closed and fails once; a retry goes out on a fresh connection.
const fetchAfterRestart = (url, opts) => fetch(url, opts).catch(() => fetch(url, opts));
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
    check('desktop open switches to gateway when needed', ccgw('desktop', 'open').includes('switched to gateway mode'));
    check('desktop open without a restart once on the profile', ccgw('desktop', 'open').includes('gateway Claude Desktop open'));
    if (process.platform === 'darwin') {
      // The official instance keeps its session: only deploymentMode is set.
      const off = path.join(desktopDir, 'official', 'Claude-Official');
      fs.mkdirSync(off, { recursive: true });
      fs.mkdirSync(`${off}-3p`, { recursive: true });
      const session = JSON.stringify({ lastKnownAccountUuid: 'acct', 'oauth:tokenCacheV2': 'tok' });
      fs.writeFileSync(path.join(off, 'config.json'), session);
      fs.writeFileSync(path.join(`${off}-3p`, 'claude_desktop_config.json'), JSON.stringify({ deploymentMode: '3p', keep: 1 }));
      check('desktop official open', ccgw('desktop', 'official').includes('official Claude Desktop open'));
      const offConf = JSON.parse(fs.readFileSync(path.join(`${off}-3p`, 'claude_desktop_config.json'), 'utf8'));
      check('desktop official sets 1p, keeps the rest', offConf.deploymentMode === '1p' && offConf.keep === 1);
      check('desktop official leaves the session alone', fs.readFileSync(path.join(off, 'config.json'), 'utf8') === session);
      check('desktop official status', ccgw('desktop', 'official', 'status').includes('signed in'));
    }
    {
      // Already signed in: --sign-in does not wait for a new session (holding
      // Windows in claude.ai mode all along); without a TTY it only opens.
      const off = path.join(desktopDir, 'official', 'Claude-Official');
      fs.mkdirSync(off, { recursive: true });
      fs.writeFileSync(path.join(off, 'config.json'), JSON.stringify({ lastKnownAccountUuid: 'acct', 'oauth:tokenCacheV2': 'tok' }));
      const t0 = Date.now();
      const signIn = ccgw('desktop', 'official', '--sign-in');
      check('desktop official --sign-in when signed in only opens', signIn.includes('Already signed in') && signIn.includes('official Claude Desktop open') && Date.now() - t0 < 20_000);
      const both = ccgw('desktop', 'both');
      check('desktop both opens the gateway and the official Desktop', both.includes('gateway Claude Desktop open') && both.includes('official Claude Desktop open'), both.split('\n').filter(Boolean).join(' | '));
      check('sync --to-official points at handoff', (() => { try { ccgw('sync', '--to-official'); return false; } catch (e) { return String(e.stderr).includes('ccgw handoff'); } })());
    }
    if (process.platform === 'win32') {
      // A Windows sign-in cut off while it held the mode at "1p" (its process
      // gone) is put back to gateway mode by the next ccgw command; one whose
      // process is still alive is left alone.
      const conf = path.join(desktopDir, 'claude_desktop_config.json');
      const hold = path.join(home, 'mode-hold.json');
      const setMode = (m) => fs.writeFileSync(conf, JSON.stringify({ ...JSON.parse(fs.readFileSync(conf, 'utf8')), deploymentMode: m }));
      const mode = () => JSON.parse(fs.readFileSync(conf, 'utf8')).deploymentMode;
      setMode('1p');
      fs.writeFileSync(hold, JSON.stringify({ pid: process.pid, since: new Date().toISOString() }));
      ccgw('desktop', 'status');
      check('a live sign-in keeps the mode it holds', mode() === '1p' && fs.existsSync(hold));
      fs.writeFileSync(hold, JSON.stringify({ pid: 999999, since: new Date().toISOString() }));
      const st = ccgw('desktop', 'status');
      check('a cut-off sign-in gets gateway mode back', mode() === '3p' && !fs.existsSync(hold) && st.includes('gateway mode'), st.split('\n')[0]);
    }
    // CCGW_DESKTOP_DIR keeps these off the real Desktop config and process.
    {
      check('connector add', ccgw('connector', 'add', 'clickup', '--no-restart').includes('added'));
      check('connector add custom', ccgw('connector', 'add', 'acme', '--url', 'https://mcp.example.com/mcp', '--no-restart').includes('added'));
      check('connector add gmail needs a client', (() => { try { ccgw('connector', 'add', 'gmail', '--no-restart'); return false; } catch (e) { return String(e.stderr).includes('OAuth client'); } })());
      // A saved sign-in skips the browser; the entry then points Desktop at the stdio server.
      fs.writeFileSync(path.join(home, 'gmail.json'), JSON.stringify({ clientId: 'cid', clientSecret: 'sec', refreshToken: 'rt', email: 'me@example.com' }));
      check('connector add gmail', ccgw('connector', 'add', 'gmail', '--no-restart').includes('me@example.com'));
      const profiles = fs.readdirSync(desktopDir, { recursive: true }).filter((f) => String(f).includes('configLibrary') && String(f).endsWith('.json'));
      const gmail = profiles.map((f) => JSON.parse(fs.readFileSync(path.join(desktopDir, f), 'utf8')).managedMcpServers?.find((c) => c.name === 'gmail')).find(Boolean);
      check('gmail stdio entry', gmail?.transport === 'stdio' && path.isAbsolute(gmail.command) && gmail.args.at(-1) === 'mcp' && gmail.env?.CCGW_HOME === home, JSON.stringify(gmail));
      const rpc = execFileSync(gmail.command, gmail.args, {
        env: { ...env, ...gmail.env }, encoding: 'utf8', timeout: 20_000,
        input: ['{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}', '{"jsonrpc":"2.0","method":"notifications/initialized"}', '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'].join('\n') + '\n',
      }).trim().split('\n').map((l) => JSON.parse(l));
      check('gmail mcp over stdio', rpc.length === 2 && rpc[0].result.serverInfo.name === 'ccgw-gmail' && rpc[1].result.tools.some((t) => t.name === 'send_message'), `${rpc[1]?.result?.tools?.length} tools`);
      // refigma --path runs a checkout's server.mjs; a stand-in answers the handshake ccgw probes with.
      const checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'ccgw-refigma-'));
      fs.writeFileSync(path.join(checkout, 'server.mjs'), `process.stdin.once('data', (d) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(d).id, result: { serverInfo: { name: 'refigma-mcp' } } }) + '\\n'));`);
      let refigma;
      try { refigma = ccgw('connector', 'add', 'refigma', '--path', checkout, '--no-restart'); } catch (e) { refigma = String(e.stderr); }
      check('connector add refigma', refigma.includes('added') || refigma.includes('cannot run here'), refigma.trim().split('\n').at(-1));
      ccgw('desktop', 'profile'); // rewriting the gateway profile must keep connectors
      const list = ccgw('connector', 'list');
      check('connectors survive profile rewrite', list.includes('clickup') && list.includes('acme'), list.trim().split('\n')[0]);
      const policies = () => profiles.map((f) => JSON.parse(fs.readFileSync(path.join(desktopDir, f), 'utf8')).managedMcpServers).find(Boolean).map((c) => c.toolPolicy?.['*']);
      ccgw('permissions', 'bypass', '--no-restart');
      check('permissions bypass', policies().every((p) => p === 'allow'), policies().join(','));
      ccgw('connector', 'add', 'notion', '--no-restart');
      check('bypass covers new connectors', policies().every((p) => p === 'allow'), policies().join(','));
      ccgw('permissions', 'ask', '--no-restart');
      check('permissions ask', policies().every((p) => p === undefined), policies().join(','));
      ccgw('connector', 'remove', 'notion', '--no-restart');
      ccgw('connector', 'remove', 'acme', '--no-restart');
      check('connector remove', !ccgw('connector', 'list').includes('acme'));
      // --official writes the official Desktop's own mcpServers, never the gateway profile.
      const offCfg = path.join(desktopDir, 'official', 'Claude-Official', 'claude_desktop_config.json');
      fs.mkdirSync(path.dirname(offCfg), { recursive: true });
      fs.writeFileSync(offCfg, JSON.stringify({ preferences: { keep: 1 } }));
      const gatewayBefore = ccgw('connector', 'list');
      check('connector add --official', ccgw('connector', 'add', 'gmail', '--official', '--no-restart').includes('official Claude Desktop'));
      const offGmail = () => JSON.parse(fs.readFileSync(offCfg, 'utf8'));
      check('official entry is plain stdio', offGmail().preferences?.keep === 1 && offGmail().mcpServers?.gmail?.command === gmail.command && !('transport' in offGmail().mcpServers.gmail) && !('name' in offGmail().mcpServers.gmail), JSON.stringify(offGmail().mcpServers));
      check('official add leaves the gateway alone', ccgw('connector', 'list') === gatewayBefore);
      check('connector list --official', ccgw('connector', 'list', '--official').includes('gmail'));
      check('--official refuses remote connectors', (() => { try { ccgw('connector', 'add', 'clickup', '--official', '--no-restart'); return false; } catch (e) { return String(e.stderr).includes('Settings → Connectors'); } })());
      ccgw('connector', 'remove', 'gmail', '--official', '--no-restart');
      check('connector remove --official', !offGmail().mcpServers.gmail && offGmail().preferences?.keep === 1 && ccgw('connector', 'list') === gatewayBefore);
    }
  }

  {
    // The update notice: a box whose lines all line up, however long the
    // link, and a bar that still reads without colour; "last … ago" in the menu.
    const M = await import('../src/menu.mjs');
    const plain = (x) => x.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
    const box = plain(M.callout([`${M.NEWS}  ccgw v9.9.9 is available  (you have v1.0.0)`, '   Update:     ccgw update', `   What's new: https://example.com/${'x'.repeat(200)}`])).split('\n');
    check('update notice box lines up', box.length === 5 && new Set(box.map((l) => [...l].length)).size === 1 && box[1].includes('v9.9.9 is available') && box[3].includes('…'), `${[...box[0]].length} cols`);
    check('update banner names the version', plain(M.banner('ccgw v9.9.9 is available')).includes('ccgw v9.9.9 is available'));
    const now = Date.UTC(2026, 9, 22, 12);
    check('ago', M.ago(now - 20_000, now) === 'just now' && M.ago(now - 5 * 60_000, now) === '5m ago' && M.ago(now - 3 * 3_600_000, now) === '3h ago' && M.ago(now - 7 * 86_400_000, now) === '7d ago');
  }

  {
    // sync: a claude.ai chat becomes a gateway Cowork session whose audit log
    // verifies the way Desktop checks it, inside the project it came from.
    process.env.CCGW_SAFE_STORAGE_PASSWORD = 'test-password';
    const S = await import('../src/sync.mjs');
    const d3p = fs.mkdtempSync(path.join(os.tmpdir(), 'ccgw-sync-'));
    const acct = '4160577b-03c9-41b8-aa76-0b8381248e8a';
    fs.mkdirSync(path.join(d3p, 'local-agent-mode-sessions', 'skills-plugin', '00000000-0000-4000-8000-000000000001', acct, 'skills', 'docx'), { recursive: true });
    fs.mkdirSync(path.join(d3p, 'local-agent-mode-sessions', '4160577b', '00000000'), { recursive: true });
    const store = S.gatewayStore(d3p);
    store.filesDir = path.join(d3p, 'files');
    const space = S.writeSpace(store, { uuid: 'p1', name: 'Demo/Pro', prompt_template: 'Be brief.' }, [{ file_name: 'notes.md', content: 'hi' }]);
    const conv = { uuid: 'c1', name: 'What is today', created_at: '2026-10-15T07:06:00Z', updated_at: '2026-10-15T07:07:00Z', current_leaf_message_uuid: 'm4', chat_messages: [
      { uuid: 'm1', parent_message_uuid: '00000000-0000-4000-8000-000000000000', sender: 'human', index: 0, created_at: '2026-10-15T07:06:00Z', content: [{ type: 'text', text: 'hi' }] },
      { uuid: 'm2', parent_message_uuid: 'm1', sender: 'assistant', index: 1, created_at: '2026-10-15T07:06:01Z', content: [{ type: 'text', text: 'Hi there!' }] },
      { uuid: 'm3', parent_message_uuid: 'm2', sender: 'human', index: 2, created_at: '2026-10-15T07:06:02Z', content: [{ type: 'text', text: 'what is today' }] },
      { uuid: 'mx', parent_message_uuid: 'm3', sender: 'assistant', index: 3, created_at: '2026-10-15T07:06:03Z', content: [{ type: 'text', text: 'an edited-away branch' }] },
      { uuid: 'm4', parent_message_uuid: 'm3', sender: 'assistant', index: 4, created_at: '2026-10-15T07:06:04Z', content: [{ type: 'text', text: 'Thursday.' }] },
    ] };
    const rec = S.writeSession(store, conv, { space });
    const sdir = path.join(store.base, rec.session.slice(6, 14));
    const k = crypto.pbkdf2Sync('test-password', 'saltysalt', 1003, 16, 'sha1');
    const raw = fs.readFileSync(path.join(sdir, '.audit-key'));
    const dec = crypto.createDecipheriv('aes-128-cbc', k, Buffer.alloc(16, ' '));
    const hkey = Buffer.from(Buffer.concat([dec.update(raw.subarray(3)), dec.final()]).toString(), 'base64');
    let prev = 'audit-chain-genesis', chainOk = true;
    for (const line of fs.readFileSync(path.join(sdir, 'audit.jsonl'), 'utf8').trim().split('\n')) {
      const { _audit_hmac, ...o } = JSON.parse(line);
      if (crypto.createHmac('sha256', hkey).update(prev).update(JSON.stringify(o)).digest('hex') !== _audit_hmac) chainOk = false;
      prev = _audit_hmac;
    }
    check('sync audit log verifies', chainOk);
    const meta = JSON.parse(fs.readFileSync(path.join(store.base, `${rec.session}.json`), 'utf8'));
    const tr = fs.readFileSync(path.join(sdir, '.claude/projects/session', `${meta.cliSessionId}.jsonl`), 'utf8');
    check('sync keeps the shown branch', tr.includes('Thursday.') && !tr.includes('edited-away') && meta.title === 'What is today');
    check('sync puts the chat in its project', meta.spaceId === space.id && meta.userSelectedFolders[0] === space.folder
      && fs.readFileSync(path.join(space.folder, 'Project instructions.md'), 'utf8') === 'Be brief.' && fs.existsSync(path.join(space.folder, 'notes.md')));
    check('sync reuses the project on the next run', S.writeSpace(store, { uuid: 'p1', name: 'Demo/Pro' }, [], space.id).id === space.id
      && JSON.parse(fs.readFileSync(path.join(store.base, 'spaces.json'), 'utf8')).spaces.length === 1);
    check('sync sees an untouched copy', S.sessionUntouched(store, rec));
    fs.appendFileSync(path.join(sdir, 'audit.jsonl'), '{}\n');
    check('sync sees a continued copy', !S.sessionUntouched(store, rec));
    const skillSrc = path.join(d3p, 'src-skills', 'morning');
    fs.mkdirSync(skillSrc, { recursive: true });
    fs.writeFileSync(path.join(skillSrc, 'SKILL.md'), '---\nname: morning\n---\n');
    const plug = S.installSkills(store, [{ name: 'morning', dir: skillSrc }], '1.2.3');
    const inst = JSON.parse(fs.readFileSync(path.join(store.base, 'cowork_plugins', 'installed_plugins.json'), 'utf8'));
    const enabled = JSON.parse(fs.readFileSync(path.join(store.base, 'cowork_settings.json'), 'utf8')).enabledPlugins;
    check('sync installs skills as an uploaded plugin', fs.existsSync(path.join(plug, 'skills', 'morning', 'SKILL.md'))
      && inst.plugins['claude-ai-skills@local-desktop-app-uploads'][0].installPath === plug && enabled['claude-ai-skills@local-desktop-app-uploads'] === true
      && store.builtinSkills.has('docx'));
    S.removeSession(store, rec.session);
    check('sync removes a session', !fs.existsSync(sdir) && !fs.existsSync(path.join(store.base, `${rec.session}.json`)));
    // handoff: gateway tasks as it lists them.
    const back = S.writeSession(store, conv, { space });
    const listed = S.gatewaySessions(store).find((x) => x.session === back.session);
    check('handoff lists gateway tasks', listed?.title === 'What is today' && listed.spaceId === space.id && listed.size === back.auditSize);
    const up = path.join(store.base, 'cowork_plugins', 'marketplaces', 'local-desktop-app-uploads', 'my-plugin');
    fs.mkdirSync(path.join(up, 'skills', 'mine'), { recursive: true });
    fs.writeFileSync(path.join(up, 'skills', 'mine', 'SKILL.md'), '---\nname: mine\n---\n');
    const ifile = path.join(store.base, 'cowork_plugins', 'installed_plugins.json');
    const inst2 = JSON.parse(fs.readFileSync(ifile, 'utf8'));
    inst2.plugins['my-plugin@local-desktop-app-uploads'] = [{ scope: 'user', installPath: up }];
    fs.writeFileSync(ifile, JSON.stringify(inst2));
    check('handoff finds the user\'s skills, not the copied ones', JSON.stringify(S.gatewayUserSkills(store).map((x) => x.name)) === '["mine"]');

    // handoff: a claude.ai chat that ran out on an unanswered question, then
    // went on in the gateway with tool calls and an output file.
    const cut = { ...conv, uuid: 'c2', current_leaf_message_uuid: 'm5', chat_messages: [...conv.chat_messages,
      { uuid: 'm5', parent_message_uuid: 'm4', sender: 'human', index: 5, created_at: '2026-10-15T07:06:05Z', content: [{ type: 'text', text: 'làm tiếp phần login đi' }] }] };
    const hrec = S.writeSession(store, cut, { space });
    const hs = S.gatewaySessions(store).find((x) => x.session === hrec.session);
    const tfile = path.join(hs.dir, '.claude/projects/session', `${hs.cli}.jsonl`);
    const line = (o) => fs.appendFileSync(tfile, JSON.stringify(o) + '\n');
    line({ type: 'assistant', uuid: 'g1', timestamp: '2026-10-16T01:00:00Z', message: { id: 'msg_01', role: 'assistant', content: [
      { type: 'thinking', thinking: 'secret' }, { type: 'text', text: 'Dùng JWT.' },
      { type: 'tool_use', name: 'Write', input: { file_path: '/w/auth.ts', content: 'x' } },
      { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } });
    line({ type: 'user', uuid: 'g2', timestamp: '2026-10-16T01:00:01Z', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } });
    line({ type: 'user', uuid: 'g3', timestamp: '2026-10-16T01:01:00Z', message: { role: 'user', content: 'quên mật khẩu để sau' } });
    fs.mkdirSync(path.join(hs.dir, 'outputs', 'docs'), { recursive: true });
    fs.writeFileSync(path.join(hs.dir, 'outputs', 'docs', 'plan.md'), '# Plan\n```js\nx\n```\n');
    fs.writeFileSync(path.join(hs.dir, 'outputs', 'logo.png'), Buffer.from([0x89, 0x50, 0, 1]));
    const turns = S.readTurns(hs);
    const split = S.continuedTurns(turns, hrec);
    check('handoff splits at the copy\'s end, keeping the unanswered question on claude.ai', split.before.at(-1)?.text === 'làm tiếp phần login đi'
      && split.after[0]?.text === 'Dùng JWT.' && split.after.at(-1)?.text === 'quên mật khẩu để sau' && !JSON.stringify(split).includes('secret'));
    const legacy = S.continuedTurns(turns, { session: hrec.session }, S.unansweredQuestion(cut));
    check('handoff splits copies made before leaf was recorded', legacy.before.length === split.before.length && legacy.after.length === split.after.length
      && S.unansweredQuestion(conv) === null);
    const facts = S.handoffFacts(hs, split.after);
    check('handoff facts', JSON.stringify(facts.files) === '["/w/auth.ts"]' && facts.commands[0] === 'npm test'
      && facts.outputs.find((o) => o.path === 'docs/plan.md')?.content.startsWith('# Plan') && facts.outputs.find((o) => o.path === 'logo.png')?.content === null);
    const prompt = S.briefPrompt({ title: hs.title, before: split.before, after: split.after, facts });
    check('handoff prompt', prompt.system.includes('### Next step') && !prompt.system.includes('auth.ts')
      && prompt.user.includes('<end_of_claude_ai_chat') && prompt.user.includes('_[Write: /w/auth.ts]_') && prompt.user.includes('docs/plan.md'));
    const hdoc = S.handoffDoc({ s: hs, conv: cut, after: split.after, facts, brief: '### Goal\nLogin', model: 'sonnet' });
    check('handoff doc', hdoc.startsWith('# Handoff: What is today') && hdoc.includes('https://claude.ai/chat/c2') && hdoc.includes('### Goal\nLogin')
      && hdoc.includes('````\n# Plan\n```js') && hdoc.includes('`logo.png` (4 bytes') && hdoc.includes('## You\n\nquên mật khẩu để sau') && !hdoc.includes('what is today\n'));
    check('handoff doc name and language', S.handoffDocName(hs) === `Handoff - What is today (${hrec.session.slice(6, 14)}).md` && S.looksVietnamese(turns) && !S.looksVietnamese(S.readTurns(listed)));
    check('handoff clips long text at both ends', ((t) => t.startsWith('aa') && t.endsWith('zz') && t.includes('characters left out'))(S.clip('a'.repeat(5000) + 'z'.repeat(5000), 1000)));
  }

  {
    ccgw('credential', 'set', '--login', 'fake-login go', '--name', 'fake-login', '--status', 'echo client tester', '--auto-login');
    const st = ccgw('credential', 'status');
    check('credential status', st.includes('fake-login') && st.includes('client tester') && /4h \d+m left/.test(st), st.split('\n')[0]);
    writeToken(Date.now() - 60_000);
    ccgw('restart');
    const r = await fetchAfterRestart(base + '/v1/messages', { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }) });
    const body = await r.json();
    check('expired login -> clear error', r.status === 400 && /login expired/.test(body.error?.message), body.error?.message);
    const opened = fs.existsSync(loginLog) ? fs.readFileSync(loginLog, 'utf8').trim().split('\n') : [];
    check('expired login opens the sign-in once', opened.length === 1 && opened[0] === 'fake-login go', JSON.stringify(opened));
    await fetchAfterRestart(base + '/v1/messages', { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: '{"messages":[{"role":"user","content":"hi"}]}' });
    check('no second sign-in window', fs.readFileSync(loginLog, 'utf8').trim().split('\n').length === 1);
    writeToken(Date.now() + 5 * 3_600_000);
    ccgw('credential', 'unset');
    ccgw('restart');
    check('credential unset', ccgw('credential', 'status').includes("Claude Code's own login"));
  }

  check('update --check reports newer release', (await ccgwAsync('update', '--check')).stdout.includes('v99.0.0 is available'));
  let refused = '';
  try { await ccgwAsync('update'); } catch (e) { refused = String(e.stderr); }
  check('update refuses a git checkout', refused.includes('git pull'), refused.trim());
  {
    process.env.CCGW_HOME = home;
    process.env.CCGW_UPDATE_URL = releasesUrl;
    const u = await import('../src/update.mjs');
    check('isNewer', u.isNewer('0.4.0', '0.3.9') && u.isNewer('v1.0.0', '0.9.9') && !u.isNewer('0.3.3', '0.3.3') && !u.isNewer('0.3.2', '0.3.10') && !u.isNewer(null, '0.1.0'));
    fs.rmSync(path.join(home, 'update-check.json'), { force: true });
    const before = releaseHits;
    const a = await u.checkForUpdate(), b = await u.checkForUpdate();
    check('auto check hits the network once a day', a === '99.0.0' && b === '99.0.0' && releaseHits - before === 1, `hits=${releaseHits - before}`);
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

releases.close();
console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
process.exit(failed ? 1 : 0);
