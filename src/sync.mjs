// Copies what lives in the official (claude.ai) Desktop into the gateway one:
// chats, chosen projects and skills. claude.ai keeps chats on its servers and
// the gateway Desktop keeps Cowork sessions on disk, so each chat is written
// as a local session (index file, Claude Code transcript and the signed audit
// log the Desktop shows), each project as a gateway project with its knowledge
// files in a folder, and the skills as one locally uploaded plugin.
//
// Reading claude.ai uses the official Desktop's own sign-in cookie, decrypted
// with the "Claude Safe Storage" Keychain key (macOS asks once). Nothing is
// written to the official Desktop or the claude.ai account.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const syncSupported = process.platform === 'darwin';

const GATEWAY_ORG = '00000000-0000-4000-8000-000000000001';
const UPLOADS = 'local-desktop-app-uploads';
const PLUGIN = 'claude-ai-skills';

// ---------------------------------------------------------------- Electron safeStorage (macOS)

let aesKey = null;
function safeStorageKey() {
  if (aesKey) return aesKey;
  let pw = process.env.CCGW_SAFE_STORAGE_PASSWORD; // tests
  if (!pw) try {
    pw = execFileSync('security', ['find-generic-password', '-ws', 'Claude Safe Storage'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    throw new Error('could not read the "Claude Safe Storage" Keychain item (click Allow when macOS asks)');
  }
  aesKey = crypto.pbkdf2Sync(pw, 'saltysalt', 1003, 16, 'sha1');
  return aesKey;
}

function decrypt(buf) {
  if (!['v10', 'v11'].includes(buf.subarray(0, 3).toString())) return buf.toString('utf8');
  const d = crypto.createDecipheriv('aes-128-cbc', safeStorageKey(), Buffer.alloc(16, ' '));
  return Buffer.concat([d.update(buf.subarray(3)), d.final()]);
}

function encrypt(text) {
  const c = crypto.createCipheriv('aes-128-cbc', safeStorageKey(), Buffer.alloc(16, ' '));
  return Buffer.concat([Buffer.from('v10'), c.update(text, 'utf8'), c.final()]);
}

// ---------------------------------------------------------------- claude.ai, as the official Desktop

// Chromium 130+ prefixes a cookie's plaintext with a 32-byte hash of its domain.
const cookieText = (plain) => {
  const s = plain.toString('utf8');
  return /^[\x20-\x7e]+$/.test(s) ? s : plain.subarray(32).toString('utf8');
};

export function officialCookies(officialDir) {
  const db = path.join(officialDir, 'Cookies');
  if (!fs.existsSync(db)) throw new Error('the official Desktop has no sign-in yet (ccgw desktop official)');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccgw-cookies-'));
  try {
    for (const f of ['Cookies', 'Cookies-journal', 'Cookies-wal']) {
      if (fs.existsSync(path.join(officialDir, f))) fs.copyFileSync(path.join(officialDir, f), path.join(tmp, f));
    }
    const out = execFileSync('sqlite3', ['-readonly', path.join(tmp, 'Cookies'),
      "select name, hex(encrypted_value) from cookies where host_key in ('.claude.ai','claude.ai') and name in ('sessionKey','lastActiveOrg')"], { encoding: 'utf8' });
    const jar = {};
    for (const line of out.split('\n').filter(Boolean)) {
      const [name, hex] = line.split('|');
      jar[name] = cookieText(decrypt(Buffer.from(hex, 'hex')));
    }
    if (!jar.sessionKey) throw new Error('the official Desktop is not signed in (ccgw desktop official --sign-in)');
    return jar;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export function claudeAi({ sessionKey, lastActiveOrg }) {
  // Cloudflare lets the Desktop app's user agent through; a plain browser one gets a challenge.
  const headers = {
    cookie: `sessionKey=${sessionKey}`, 'anthropic-client-platform': 'web_claude_ai', accept: 'application/json',
    'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Claude/1.0 Chrome/140.0.0.0 Electron/38.0.0 Safari/537.36',
  };
  // Resolves to the parsed body (null when empty), or throws with claude.ai's error code.
  const call = async (method, p, body, { raw = false } = {}) => {
    for (let attempt = 0; ; attempt++) {
      const json = body !== undefined && !(body instanceof FormData);
      const r = await fetch(`https://claude.ai/api/${p}`, {
        method, body: json ? JSON.stringify(body) : body,
        headers: json ? { ...headers, 'content-type': 'application/json' } : headers,
      });
      if (r.ok) {
        if (raw) return Buffer.from(await r.arrayBuffer());
        const text = await r.text();
        return text ? JSON.parse(text) : null;
      }
      const err = await r.json().catch(() => null);
      if (r.status === 401 || (r.status === 403 && !err?.error)) throw new Error(`claude.ai refused the official Desktop's sign-in (HTTP ${r.status}); open it once (ccgw desktop official) and try again`);
      if (attempt >= 2 || (r.status < 429 && r.status !== 409)) {
        throw Object.assign(new Error(`claude.ai ${method} ${p.split('?')[0]}: ${err?.error?.message || `HTTP ${r.status}`}`), { code: err?.error?.details?.error_code, status: r.status });
      }
      await new Promise((res) => setTimeout(res, 1500 * (attempt + 1)));
    }
  };
  const get = (p) => call('GET', p);
  let org = lastActiveOrg;
  const orgId = async () => org || (org = (await get('organizations')).find((o) => o.capabilities?.includes('chat'))?.uuid);
  const o = async (p) => `organizations/${await orgId()}/${p}`;
  return {
    async conversations() {
      const all = [];
      for (let offset = 0; ; offset += 100) {
        const page = await get(await o(`chat_conversations?limit=100&offset=${offset}`));
        all.push(...page);
        if (page.length < 100) return all;
      }
    },
    conversation: async (id) => get(await o(`chat_conversations/${id}?tree=True&rendering_mode=messages&render_all_tools=true`)),
    projects: async () => (await get(await o('projects?limit=200'))).filter((p) => !p.archived_at),
    project: async (id) => get(await o(`projects/${id}`)),
    docs: async (id) => get(await o(`projects/${id}/docs`)),
    createProject: async (name, description = '') => call('POST', await o('projects'), { name, description, is_private: true }),
    setInstructions: async (id, prompt) => call('PUT', await o(`projects/${id}`), { prompt_template: prompt }),
    addDoc: async (id, fileName, content) => call('POST', await o(`projects/${id}/docs`), { file_name: fileName, content }),
    deleteDoc: async (id, doc) => call('DELETE', await o(`projects/${id}/docs/${doc}`)).catch((e) => { if (e.status !== 404) throw e; }),
    skills: async () => (await get(await o('skills/list-skills?include_wiggle_skills=true&entrypoint=local-agent'))).skills || [],
    downloadSkill: async (id) => call('GET', await o(`skills/download-dot-skill-file?skill_id=${encodeURIComponent(id)}&entrypoint=local-agent`), undefined, { raw: true }),
    // "added", or "exists" when the account already has a skill of that name.
    async uploadSkill(name, zip) {
      const form = new FormData();
      form.append('file', new Blob([zip], { type: 'application/zip' }), `${name}.skill`);
      try {
        await call('POST', await o(`skills/upload-skill?overwrite=false&check_skill_name=${encodeURIComponent(name)}`), form);
        return 'added';
      } catch (e) {
        if (/already_exists|name_taken|name_reserved/.test(e.code || '')) return 'exists';
        throw e;
      }
    },
  };
}

// A skill folder <name>/… as the .skill zip claude.ai takes, and back.
export function zipSkill(dir, name) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccgw-skill-'));
  try {
    fs.cpSync(dir, path.join(tmp, name), { recursive: true });
    execFileSync('zip', ['-qr', 'skill.zip', name], { cwd: tmp });
    return fs.readFileSync(path.join(tmp, 'skill.zip'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export function unzipSkill(zip, into) {
  const file = path.join(into, `.${crypto.randomUUID()}.zip`);
  fs.writeFileSync(file, zip);
  try { execFileSync('unzip', ['-qo', file, '-d', into]); } finally { fs.rmSync(file, { force: true }); }
}

// ---------------------------------------------------------------- the gateway Desktop's Cowork store

// Sessions live under local-agent-mode-sessions/<account>/<org>, or the
// 8-character short form of both that newer Desktops use.
export function gatewayStore(desktop3pDir) {
  const root = path.join(desktop3pDir, 'local-agent-mode-sessions');
  const skillsOrg = path.join(root, 'skills-plugin', GATEWAY_ORG);
  const account = fs.existsSync(skillsOrg) ? fs.readdirSync(skillsOrg).find((d) => /^[0-9a-f-]{36}$/.test(d)) : null;
  const candidates = account ? [path.join(root, account.slice(0, 8), GATEWAY_ORG.slice(0, 8)), path.join(root, account, GATEWAY_ORG)] : [];
  const base = candidates.find((d) => fs.existsSync(d));
  if (!base) throw new Error('the gateway Desktop has no Cowork data yet: open it (ccgw desktop open), start one task, then sync again');
  const builtinSkills = new Set();
  const skillsDir = path.join(skillsOrg, account, 'skills');
  if (fs.existsSync(skillsDir)) for (const d of fs.readdirSync(skillsDir)) builtinSkills.add(d);
  const conf = (() => { try { return JSON.parse(fs.readFileSync(path.join(desktop3pDir, 'claude_desktop_config.json'), 'utf8')); } catch { return {}; } })();
  return { base, account, builtinSkills, filesDir: conf.coworkUserFilesPath || path.join(os.homedir(), 'Claude') };
}

const readJson = (f, fallback) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; } };
const writeJson = (f, data) => {
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  const tmp = `${f}.ccgw-${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, f);
};
const ms = (iso) => new Date(iso).getTime();
const safeName = (s) => (s || 'Untitled').replace(/[\\/:*?"<>|\x00-\x1f]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Untitled';

// The branch claude.ai shows: from the current leaf back to the root.
function visibleBranch(conv) {
  const byId = new Map(conv.chat_messages.map((m) => [m.uuid, m]));
  const chain = [];
  for (let id = conv.current_leaf_message_uuid; byId.has(id); id = byId.get(id).parent_message_uuid) chain.unshift(byId.get(id));
  return chain.length ? chain : [...conv.chat_messages].sort((a, b) => a.index - b.index);
}

// Text, artifacts and attachments' extracted text; images and PDFs stay on claude.ai.
function messageText(m) {
  const out = [];
  for (const b of m.content || []) {
    if (b.type === 'text' && b.text) out.push(b.text);
    else if (b.type === 'tool_use') {
      const inp = b.input || {};
      const body = inp.content ?? inp.file_text;
      out.push(body
        ? `[${b.name}: ${inp.title || inp.path || inp.id || ''}]\n\`\`\`\n${body}\n\`\`\``
        : `[used ${b.name}${inp.query ? `: ${inp.query}` : ''}]`);
    }
  }
  for (const a of m.attachments || []) out.push(`[attached ${a.file_name}]\n${a.extracted_content || ''}`.trim());
  for (const f of [...(m.files_v2 || m.files || [])]) out.push(`[attached ${f.file_name} — not copied, open the chat on claude.ai]`);
  return out.join('\n\n').trim() || '(empty)';
}

// A session index like the ones Desktop writes, borrowing an existing one's
// settings (model, tools, system prompt) so it behaves like the user's own.
function sessionTemplate(base) {
  const files = fs.readdirSync(base).filter((f) => /^local_[0-9a-f-]{36}\.json$/.test(f))
    .map((f) => path.join(base, f)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  for (const f of files) {
    const t = readJson(f, null);
    if (t?.systemPrompt) return t;
  }
  return { model: 'claude-opus-5-5', memoryEnabled: true, skillsEnabled: true, pluginsEnabled: true, enabledMcpTools: {}, remoteMcpServersConfig: [], hostLoopMode: true, emailAddress: 'cowork-3p@localhost' };
}

const WORDS = ['calm', 'brave', 'quiet', 'swift', 'bright', 'gentle', 'merry', 'noble', 'keen', 'warm'];
const NAMES = ['turing', 'lovelace', 'hopper', 'knuth', 'ritchie', 'shannon', 'curie', 'noether', 'euler', 'gauss'];
const pick = (a) => a[crypto.randomInt(a.length)];

// Writes one claude.ai chat as a gateway Cowork session; returns its record.
export function writeSession(store, conv, { sid = crypto.randomUUID(), space = null, template = sessionTemplate(store.base) } = {}) {
  const short = sid.slice(0, 8);
  const dir = path.join(store.base, short);
  const outputs = path.join(dir, 'outputs');
  const cli = crypto.randomUUID();
  for (const d of ['outputs', 'uploads', 'uploads-tmp', '.claude/projects/session', '.claude/sessions']) fs.mkdirSync(path.join(dir, d), { recursive: true, mode: 0o700 });

  // Desktop signs its audit log: HMAC-SHA256 chained from a fixed genesis,
  // keyed by 32 random bytes kept base64 in safeStorage.
  const key = crypto.randomBytes(32);
  fs.writeFileSync(path.join(dir, '.audit-key'), encrypt(key.toString('base64')), { mode: 0o600 });
  let prev = 'audit-chain-genesis';
  const audit = [];
  const sign = (rec) => {
    const body = JSON.stringify(rec);
    prev = crypto.createHmac('sha256', key).update(prev).update(body).digest('hex');
    audit.push(JSON.stringify({ ...rec, _audit_hmac: prev }));
  };

  const model = template.model || 'claude-opus-5-5';
  const common = { userType: 'external', entrypoint: 'local-agent', cwd: outputs, sessionId: cli, version: '2.1.260', gitBranch: 'HEAD' };
  const transcript = [];
  let parent = null, lastPrompt = '';
  const chain = visibleBranch(conv);
  for (const m of chain) {
    const t = new Date(m.created_at).toISOString();
    const uuid = crypto.randomUUID();
    const text = messageText(m);
    if (m.sender === 'human') {
      const message = { role: 'user', content: text };
      lastPrompt = text;
      transcript.push({ parentUuid: parent, isSidechain: false, promptId: crypto.randomUUID(), type: 'user', message, uuid, timestamp: t, permissionMode: 'default', origin: { kind: 'human' }, promptSource: 'sdk', ...common });
      sign({ type: 'user', uuid, session_id: sid, parent_tool_use_id: null, client_platform: 'desktop_app', timestamp: t, message, _audit_timestamp: t });
    } else {
      const message = { model, id: `msg_claudeai_${m.uuid.replace(/-/g, '')}`, type: 'message', role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } };
      transcript.push({ parentUuid: parent, isSidechain: false, message, type: 'assistant', uuid, timestamp: t, ...common });
      sign({ type: 'assistant', message, parent_tool_use_id: null, session_id: cli, uuid, timestamp: t, _audit_timestamp: t });
      sign({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, stop_reason: 'end_turn', session_id: cli, total_cost_usd: 0, duration_api_ms: 0, usage: { input_tokens: 0, output_tokens: 0 }, permission_denials: [], terminal_reason: 'completed', uuid: crypto.randomUUID(), _audit_timestamp: t });
    }
    parent = uuid;
  }
  transcript.push({ type: 'last-prompt', lastPrompt: lastPrompt.slice(0, 200), leafUuid: parent, sessionId: cli });
  fs.writeFileSync(path.join(dir, '.claude/projects/session', `${cli}.jsonl`), transcript.map((x) => JSON.stringify(x)).join('\n') + '\n', { mode: 0o600 });
  fs.writeFileSync(path.join(dir, 'audit.jsonl'), audit.join('\n') + '\n', { mode: 0o600 });

  const name = `${pick(WORDS)}-${pick(WORDS)}-${pick(NAMES)}`;
  const { titleSource, spaceId, spaceIdSetBy, ...rest } = template;
  const meta = {
    ...rest,
    sessionId: `local_${sid}`, processName: name, vmProcessName: name, cliSessionId: cli,
    cwd: `${store.base}/`, createdAt: ms(conv.created_at), lastActivityAt: ms(conv.updated_at),
    title: conv.name || 'Chat from claude.ai', initialMessage: chain.length ? messageText(chain[0]).slice(0, 2000) : '',
    isArchived: false, userSelectedFolders: space ? [space.folder] : [], resolvedFolderKinds: space ? [{ display: space.folder, kind: 'local' }] : [],
    ...(space && { spaceId: space.id, spaceIdSetBy: 'user' }),
  };
  writeJson(path.join(store.base, `local_${sid}.json`), meta);
  return { session: `local_${sid}`, updatedAt: conv.updated_at, auditSize: fs.statSync(path.join(dir, 'audit.jsonl')).size };
}

export function removeSession(store, session) {
  const sid = session.replace(/^local_/, '');
  fs.rmSync(path.join(store.base, `local_${sid}.json`), { force: true });
  fs.rmSync(path.join(store.base, sid.slice(0, 8)), { recursive: true, force: true });
}

// Untouched since the import: nobody chatted on in the gateway copy.
export function sessionUntouched(store, rec) {
  const sid = rec.session.replace(/^local_/, '');
  try { return fs.statSync(path.join(store.base, sid.slice(0, 8), 'audit.jsonl')).size === rec.auditSize; } catch { return false; }
}

export function sessionExists(store, rec) {
  return fs.existsSync(path.join(store.base, `${rec.session}.json`));
}

// A gateway project for a claude.ai one: its instructions and knowledge go in
// <Cowork files>/Projects/<name>, the project's folder.
export function writeSpace(store, project, docs, spaceId) {
  const file = path.join(store.base, 'spaces.json');
  const data = readJson(file, { spaces: [] });
  const existing = data.spaces.find((s) => s.id === spaceId);
  const folder = existing?.folders?.[0]?.path || path.join(store.filesDir, 'Projects', safeName(project.name));
  fs.mkdirSync(folder, { recursive: true });
  if (project.prompt_template) fs.writeFileSync(path.join(folder, 'Project instructions.md'), project.prompt_template);
  for (const d of docs) fs.writeFileSync(path.join(folder, safeName(d.file_name)), d.content ?? '');
  const now = Date.now();
  const space = existing || { id: spaceId || crypto.randomUUID(), name: project.name, folders: [{ path: folder }], projects: [], links: [], origin: 'user', createdAt: now };
  Object.assign(space, { name: project.name, updatedAt: now });
  if (!existing) data.spaces.push(space);
  writeJson(file, data);
  fs.mkdirSync(path.join(store.base, 'spaces', space.id, 'memory'), { recursive: true });
  return { id: space.id, folder };
}

// The official Desktop keeps the account's skills on disk in its skills-plugin
// dir; the ones the gateway Desktop lacks become one uploaded plugin there.
export function officialSkills(officialDir) {
  const root = path.join(officialDir, 'local-agent-mode-sessions', 'skills-plugin');
  if (!fs.existsSync(root)) return [];
  for (const org of fs.readdirSync(root)) {
    for (const acct of fs.readdirSync(path.join(root, org)).filter((d) => !d.startsWith('.'))) {
      const dir = path.join(root, org, acct, 'skills');
      if (fs.existsSync(dir)) return fs.readdirSync(dir).filter((s) => fs.existsSync(path.join(dir, s, 'SKILL.md'))).map((s) => ({ name: s, dir: path.join(dir, s) }));
    }
  }
  return [];
}

export function installedSkills(store) {
  const dir = path.join(store.base, 'cowork_plugins', 'marketplaces', UPLOADS, PLUGIN, 'skills');
  return new Set(fs.existsSync(dir) ? fs.readdirSync(dir) : []);
}

export function installSkills(store, skills, version) {
  const cowork = path.join(store.base, 'cowork_plugins');
  const market = path.join(cowork, 'marketplaces', UPLOADS);
  const plugin = path.join(market, PLUGIN);
  fs.rmSync(plugin, { recursive: true, force: true });
  for (const s of skills) fs.cpSync(s.dir, path.join(plugin, 'skills', s.name), { recursive: true });
  writeJson(path.join(plugin, '.claude-plugin', 'plugin.json'), { name: PLUGIN, version, description: 'Skills copied from your claude.ai account by ccgw sync' });

  const mfile = path.join(market, '.claude-plugin', 'marketplace.json');
  const m = readJson(mfile, { name: UPLOADS, version: '1.0.0', description: 'Locally uploaded plugins via Claude Desktop app', owner: { name: 'Local User' }, plugins: [] });
  m.plugins = [...m.plugins.filter((p) => p.name !== PLUGIN), { name: PLUGIN, version, source: `./${PLUGIN}` }];
  writeJson(mfile, m);

  const kfile = path.join(cowork, 'known_marketplaces.json');
  const known = readJson(kfile, {});
  if (known[UPLOADS]?.installLocation !== market) known[UPLOADS] = { source: { source: 'directory', path: market }, installLocation: market, lastUpdated: new Date().toISOString() };
  writeJson(kfile, known);

  const ifile = path.join(cowork, 'installed_plugins.json');
  const inst = readJson(ifile, { version: 2, plugins: {} });
  inst.version = 2;
  const id = `${PLUGIN}@${UPLOADS}`;
  const now = new Date().toISOString();
  const prevEntry = (inst.plugins[id] || []).find((e) => e.scope === 'user');
  inst.plugins[id] = [{ scope: 'user', installPath: plugin, version, installedAt: prevEntry?.installedAt || now, lastUpdated: now }];
  writeJson(ifile, inst);

  const sfile = path.join(store.base, 'cowork_settings.json');
  const settings = readJson(sfile, {});
  settings.enabledPlugins = { ...settings.enabledPlugins, [id]: true };
  writeJson(sfile, settings);
  return plugin;
}

// ---------------------------------------------------------------- gateway → claude.ai

// The gateway's Cowork tasks, newest first; `size` (its audit log's) tells a
// task that moved on since the last sync.
export function gatewaySessions(store) {
  const out = [];
  for (const f of fs.readdirSync(store.base)) {
    if (!/^local_[0-9a-f-]{36}\.json$/.test(f)) continue;
    const meta = readJson(path.join(store.base, f), null);
    if (!meta || meta.isArchived) continue;
    const dir = path.join(store.base, f.slice(6, 14));
    let size = 0;
    try { size = fs.statSync(path.join(dir, 'audit.jsonl')).size; } catch {}
    out.push({ session: meta.sessionId, title: meta.title || 'Untitled task', spaceId: meta.spaceId || null, cli: meta.cliSessionId, dir, size, createdAt: meta.createdAt, lastActivityAt: meta.lastActivityAt || meta.createdAt });
  }
  return out.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
}

export const gatewaySpaces = (store) => readJson(path.join(store.base, 'spaces.json'), { spaces: [] }).spaces;

// A task as Markdown: what was said, with tool calls named but their output
// and the model's thinking left out.
export function transcriptMarkdown(s) {
  const root = path.join(s.dir, '.claude', 'projects');
  let file = null;
  if (fs.existsSync(root)) {
    for (const d of fs.readdirSync(root)) {
      const f = path.join(root, d, `${s.cli}.jsonl`);
      if (fs.existsSync(f)) { file = f; break; }
    }
  }
  const turns = [];
  const add = (who, text) => {
    const last = turns.at(-1);
    if (last?.who === who) last.parts.push(text);
    else turns.push({ who, parts: [text] });
  };
  for (const line of file ? fs.readFileSync(file, 'utf8').split('\n') : []) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.isMeta || e.isSidechain || e.isCompactSummary || !e.message) continue;
    const c = e.message.content;
    if (e.type === 'user') {
      const text = typeof c === 'string' ? c : (c || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      if (text.trim()) add('You', text.trim());
    } else if (e.type === 'assistant') {
      for (const b of Array.isArray(c) ? c : []) {
        if (b.type === 'text' && b.text.trim()) add('Claude', b.text.trim());
        else if (b.type === 'tool_use') add('Claude', `_[used ${b.name.replace(/^mcp__[^_]+__/, '')}]_`);
      }
    }
  }
  const when = (t) => new Date(t).toISOString().slice(0, 16).replace('T', ' ');
  return [
    `# ${s.title}`, '',
    `_Chat from the gateway Claude Desktop (Claude Code), ${when(s.createdAt)} – ${when(s.lastActivityAt)} UTC, copied by ccgw sync. Tool output and thinking are left out._`, '',
    ...turns.flatMap((t) => [`## ${t.who}`, '', t.parts.join('\n\n'), '']),
  ].join('\n');
}

export const chatDocName = (s) => `Chat - ${safeName(s.title).slice(0, 60)} (${s.session.slice(6, 14)}).md`;

// Skills the user added to the gateway Desktop (uploaded plugins), not the
// ones ccgw copied from claude.ai.
export function gatewayUserSkills(store) {
  const inst = readJson(path.join(store.base, 'cowork_plugins', 'installed_plugins.json'), { plugins: {} });
  const out = [];
  for (const [id, entries] of Object.entries(inst.plugins || {})) {
    if (!id.endsWith(`@${UPLOADS}`) || id === `${PLUGIN}@${UPLOADS}`) continue;
    const dir = path.join(entries.find((e) => e.scope === 'user')?.installPath || '', 'skills');
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (fs.existsSync(path.join(dir, name, 'SKILL.md'))) out.push({ name, dir: path.join(dir, name) });
    }
  }
  return out;
}
