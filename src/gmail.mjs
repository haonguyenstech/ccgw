// Gmail for Claude Desktop without Google's preview-gated MCP server: a local
// stdio MCP server over the ordinary Gmail REST API, signed in with the user's
// own Google OAuth client. The refresh token stays in ~/.ccgw/gmail.json.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { HOME_DIR } from './config.mjs';
import { IS_MAC, IS_WIN } from './platform.mjs';

export const GMAIL_FILE = path.join(HOME_DIR, 'gmail.json');
const SCOPE = 'https://www.googleapis.com/auth/gmail.modify';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';

export const readGmail = () => { try { return JSON.parse(fs.readFileSync(GMAIL_FILE, 'utf8')); } catch { return null; } };
const writeGmail = (v) => {
  fs.mkdirSync(HOME_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(GMAIL_FILE, JSON.stringify(v, null, 2) + '\n', { mode: 0o600 });
};
export const gmailLogout = () => fs.rmSync(GMAIL_FILE, { force: true });

function openBrowser(url) {
  const [cmd, args] = IS_MAC ? ['open', [url]] : IS_WIN ? ['rundll32', ['url.dll,FileProtocolHandler', url]] : ['xdg-open', [url]];
  spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}

async function tokenRequest(params) {
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(20000),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Google token endpoint: ${body.error_description || body.error || `HTTP ${r.status}`}`);
  return body;
}

// Loopback sign-in with PKCE; resolves once Google redirects back.
export async function gmailLogin({ clientId, clientSecret }, log = console.log) {
  const verifier = crypto.randomBytes(48).toString('base64url');
  const state = crypto.randomBytes(16).toString('base64url');
  let done;
  const result = new Promise((resolve, reject) => { done = { resolve, reject }; });
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (u.pathname !== '/callback') return res.writeHead(404).end();
    const ok = u.searchParams.get('state') === state && u.searchParams.get('code');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      .end(ok ? '<h3>Gmail connected to ccgw. You can close this tab.</h3>' : `<h3>Sign-in failed: ${u.searchParams.get('error') || 'bad state'}</h3>`);
    ok ? done.resolve(u.searchParams.get('code')) : done.reject(new Error(`sign-in failed: ${u.searchParams.get('error') || 'state mismatch'}`));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const redirect = `http://127.0.0.1:${server.address().port}/callback`;
  const url = `${AUTH_URL}?${new URLSearchParams({
    client_id: clientId, redirect_uri: redirect, response_type: 'code', scope: SCOPE,
    code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256', access_type: 'offline', prompt: 'consent', state,
  })}`;
  log(`  Opening Google sign-in in your browser…\n  If it does not open: ${url}\n`);
  openBrowser(url);
  const timer = setTimeout(() => done.reject(new Error('sign-in timed out after 5 minutes')), 300_000);
  try {
    const code = await result;
    const tok = await tokenRequest({
      code, client_id: clientId, ...(clientSecret && { client_secret: clientSecret }),
      redirect_uri: redirect, grant_type: 'authorization_code', code_verifier: verifier,
    });
    if (!tok.refresh_token) throw new Error('Google returned no refresh token — remove ccgw under myaccount.google.com/permissions and try again');
    const r = await fetch(`${API}/profile`, { headers: { authorization: `Bearer ${tok.access_token}` } });
    const profile = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Gmail API ${r.status}: ${profile.error?.message || r.statusText}`);
    writeGmail({ clientId, clientSecret, refreshToken: tok.refresh_token, email: profile.emailAddress });
    return profile.emailAddress;
  } finally {
    clearTimeout(timer);
    server.close();
  }
}

// ---------------------------------------------------------------- API

let cached = { token: null, expires: 0 };
async function accessToken() {
  if (cached.token && Date.now() < cached.expires - 60_000) return cached.token;
  const g = readGmail();
  if (!g?.refreshToken) throw new Error('Gmail is not signed in. Run: ccgw gmail login');
  const tok = await tokenRequest({
    client_id: g.clientId, ...(g.clientSecret && { client_secret: g.clientSecret }),
    refresh_token: g.refreshToken, grant_type: 'refresh_token',
  });
  cached = { token: tok.access_token, expires: Date.now() + tok.expires_in * 1000 };
  return cached.token;
}

async function api(method, p, { query, body } = {}) {
  const url = `${API}${p}${query ? '?' + new URLSearchParams(query) : ''}`;
  const r = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${await accessToken()}`, ...(body && { 'content-type': 'application/json' }) },
    body: body && JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  if (r.status === 204) return {};
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Gmail API ${r.status}: ${j.error?.message || r.statusText}`);
  return j;
}

const header = (msg, name) => msg.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || '';
const b64 = (s) => Buffer.from(s, 'base64url').toString('utf8');
const stripHtml = (h) => h.replace(/<(style|script)[\s\S]*?<\/\1>/gi, '').replace(/<br\s*\/?>|<\/p>|<\/div>/gi, '\n')
  .replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();

function bodyText(part) {
  const parts = [];
  const walk = (p) => { parts.push(p); (p.parts || []).forEach(walk); };
  walk(part);
  const plain = parts.find((p) => p.mimeType === 'text/plain' && p.body?.data);
  if (plain) return b64(plain.body.data);
  const html = parts.find((p) => p.mimeType === 'text/html' && p.body?.data);
  return html ? stripHtml(b64(html.body.data)) : '';
}

const attachments = (msg) => {
  const out = [];
  const walk = (p) => { if (p.filename) out.push(`${p.filename} (${p.mimeType}, ${p.body?.size ?? 0} bytes)`); (p.parts || []).forEach(walk); };
  walk(msg.payload || {});
  return out;
};

const summary = (m) => ({
  id: m.id, threadId: m.threadId, date: header(m, 'Date'), from: header(m, 'From'), to: header(m, 'To'),
  subject: header(m, 'Subject'), snippet: m.snippet, labels: m.labelIds,
});

const full = (m, maxChars = 20000) => {
  const text = bodyText(m.payload || {});
  return {
    ...summary(m), cc: header(m, 'Cc') || undefined, attachments: attachments(m),
    body: text.length > maxChars ? text.slice(0, maxChars) + `\n…[truncated, ${text.length} chars]` : text,
  };
};

// RFC 2822 message; non-ASCII headers use RFC 2047 encoded-words.
function mime({ to, cc, bcc, subject = '', body = '', inReplyTo, references }) {
  const enc = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`);
  const lines = [
    to && `To: ${to}`, cc && `Cc: ${cc}`, bcc && `Bcc: ${bcc}`, `Subject: ${enc(subject)}`,
    inReplyTo && `In-Reply-To: ${inReplyTo}`, references && `References: ${references}`,
    'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64',
  ].filter(Boolean);
  return Buffer.from(`${lines.join('\r\n')}\r\n\r\n${Buffer.from(body).toString('base64')}`).toString('base64url');
}

async function composed(args) {
  let { to, cc, bcc, subject, body, replyToMessageId } = args;
  let threadId, inReplyTo, references;
  if (replyToMessageId) {
    const orig = await api('GET', `/messages/${replyToMessageId}`, { query: { format: 'metadata' } });
    threadId = orig.threadId;
    inReplyTo = header(orig, 'Message-ID');
    references = [header(orig, 'References'), inReplyTo].filter(Boolean).join(' ');
    to ||= header(orig, 'Reply-To') || header(orig, 'From');
    const s = header(orig, 'Subject');
    subject ||= /^re:/i.test(s) ? s : `Re: ${s}`;
  }
  if (!to) throw new Error('"to" is required (or pass replyToMessageId)');
  return { raw: mime({ to, cc, bcc, subject, body, inReplyTo, references }), ...(threadId && { threadId }) };
}

const str = (description) => ({ type: 'string', description });
const TOOLS = [
  {
    name: 'search_messages',
    description: 'Search Gmail with Gmail search syntax (e.g. "is:unread newer_than:1d", "from:alice subject:invoice"). Returns id, thread, date, from, subject and snippet for each message.',
    inputSchema: { type: 'object', properties: { query: str('Gmail search query; empty lists the newest mail'), maxResults: { type: 'integer', description: '1-50, default 10' } } },
    annotations: { title: 'Search messages', readOnlyHint: true },
    run: async ({ query = '', maxResults = 10 }) => {
      const list = await api('GET', '/messages', { query: { q: query, maxResults: Math.min(Math.max(maxResults, 1), 50) } });
      const msgs = await Promise.all((list.messages || []).map((m) => api('GET', `/messages/${m.id}`, {
        query: new URLSearchParams([['format', 'metadata'], ...['From', 'To', 'Subject', 'Date'].map((h) => ['metadataHeaders', h])]),
      })));
      return { resultSizeEstimate: list.resultSizeEstimate, messages: msgs.map(summary) };
    },
  },
  {
    name: 'read_message',
    description: 'Read one message: headers, plain-text body (HTML converted to text) and attachment names.',
    inputSchema: { type: 'object', properties: { id: str('message id') }, required: ['id'] },
    annotations: { title: 'Read message', readOnlyHint: true },
    run: async ({ id }) => full(await api('GET', `/messages/${id}`, { query: { format: 'full' } })),
  },
  {
    name: 'read_thread',
    description: 'Read a whole conversation (all messages in a thread), oldest first.',
    inputSchema: { type: 'object', properties: { threadId: str('thread id') }, required: ['threadId'] },
    annotations: { title: 'Read thread', readOnlyHint: true },
    run: async ({ threadId }) => {
      const t = await api('GET', `/threads/${threadId}`, { query: { format: 'full' } });
      return { id: t.id, messages: (t.messages || []).map((m) => full(m, 8000)) };
    },
  },
  {
    name: 'send_message',
    description: 'Send an email now. Plain-text body. To reply in an existing thread pass replyToMessageId (to and subject then default to the original sender and "Re: …").',
    inputSchema: {
      type: 'object',
      properties: { to: str('comma-separated recipients'), cc: str('cc'), bcc: str('bcc'), subject: str('subject'), body: str('plain-text body'), replyToMessageId: str('message id to reply to') },
      required: ['body'],
    },
    annotations: { title: 'Send email', destructiveHint: true, openWorldHint: true },
    run: async (a) => {
      const m = await api('POST', '/messages/send', { body: await composed(a) });
      return { sent: true, id: m.id, threadId: m.threadId };
    },
  },
  {
    name: 'create_draft',
    description: 'Save an email as a draft without sending it. Same fields as send_message.',
    inputSchema: {
      type: 'object',
      properties: { to: str('comma-separated recipients'), cc: str('cc'), bcc: str('bcc'), subject: str('subject'), body: str('plain-text body'), replyToMessageId: str('message id to reply to') },
      required: ['body'],
    },
    annotations: { title: 'Create draft' },
    run: async (a) => {
      const d = await api('POST', '/drafts', { body: { message: await composed(a) } });
      return { draftId: d.id, messageId: d.message?.id, url: `https://mail.google.com/mail/u/0/#drafts?compose=${d.message?.id}` };
    },
  },
  {
    name: 'list_labels',
    description: 'List Gmail labels (system and user labels) with their ids.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { title: 'List labels', readOnlyHint: true },
    run: async () => (await api('GET', '/labels')).labels?.map(({ id, name, type }) => ({ id, name, type })),
  },
  {
    name: 'modify_labels',
    description: 'Add or remove labels on a message, by label id (see list_labels). Mark read: remove UNREAD. Archive: remove INBOX. Star: add STARRED.',
    inputSchema: {
      type: 'object',
      properties: { id: str('message id'), add: { type: 'array', items: { type: 'string' } }, remove: { type: 'array', items: { type: 'string' } } },
      required: ['id'],
    },
    annotations: { title: 'Modify labels', idempotentHint: true },
    run: async ({ id, add = [], remove = [] }) => {
      const m = await api('POST', `/messages/${id}/modify`, { body: { addLabelIds: add, removeLabelIds: remove } });
      return { id: m.id, labels: m.labelIds };
    },
  },
  {
    name: 'trash_message',
    description: 'Move a message to Trash (recoverable for 30 days).',
    inputSchema: { type: 'object', properties: { id: str('message id') }, required: ['id'] },
    annotations: { title: 'Trash message', destructiveHint: true },
    run: async ({ id }) => { await api('POST', `/messages/${id}/trash`); return { trashed: true, id }; },
  },
];

// ---------------------------------------------------------------- stdio MCP

const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

export async function handle(msg) {
  const { id, method, params = {} } = msg;
  const ok = (result) => ({ jsonrpc: '2.0', id, result });
  switch (method) {
    case 'initialize':
      return ok({
        protocolVersion: PROTOCOLS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'ccgw-gmail', version: '1.0.0' },
        instructions: `Gmail account: ${readGmail()?.email || 'not signed in'}`,
      });
    case 'ping': return ok({});
    case 'tools/list': return ok({ tools: TOOLS.map(({ run, ...t }) => t) });
    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === params.name);
      if (!tool) return { jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool: ${params.name}` } };
      try {
        const out = await tool.run(params.arguments || {});
        return ok({ content: [{ type: 'text', text: JSON.stringify(out) }] });
      } catch (e) {
        return ok({ content: [{ type: 'text', text: e.message }], isError: true });
      }
    }
    default:
      if (id === undefined) return null; // notifications need no reply
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } };
  }
}

export function serveGmail() {
  const rl = readline.createInterface({ input: process.stdin });
  const send = (m) => m && process.stdout.write(JSON.stringify(m) + '\n');
  const pending = new Set();
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); }
    for (const m of Array.isArray(msg) ? msg : [msg]) {
      const p = handle(m).then(send).finally(() => pending.delete(p));
      pending.add(p);
    }
  });
  // Finish in-flight calls before exiting when the client closes stdin.
  rl.on('close', () => Promise.allSettled([...pending]).then(() => process.exit(0)));
}
