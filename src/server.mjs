// ccgw gateway: exposes the Anthropic Messages API on localhost and serves it
// through the locally logged-in Claude Code CLI (via the Claude Agent SDK).
//
// Design:
//  - One CLI session per Desktop conversation, kept alive between turns so a
//    follow-up message costs one prompt write, not a fresh process + replay.
//  - Desktop's client tools are exposed to the CLI as an in-process MCP server
//    ("desktop"). When the model calls one, the CLI blocks inside our MCP
//    handler; we end the HTTP response with a tool_use stop, and the next
//    request's tool_result unblocks the CLI, whose output streams into it.
//  - A pre-warmed CLI process is kept per recent system prompt, so a new
//    conversation skips the ~1-3s spawn/handshake.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { startup } from '@anthropic-ai/claude-agent-sdk';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { HOME_DIR, readConfig } from './config.mjs';
import { findClaude } from './platform.mjs';

const cfg = readConfig();
const PORT = Number(process.env.CCGW_PORT || cfg.port);
const HOST = process.env.CCGW_HOST || cfg.host;
const API_KEY = cfg.apiKey;
const WORK_DIR = path.join(HOME_DIR, 'work');
const MAX_SESSIONS = cfg.maxSessions;
const SESSION_TTL_MS = cfg.sessionTtlMinutes * 60_000;
const TOOL_TIMEOUT_MS = 30 * 60_000;
const TOOL_PREFIX = 'mcp__desktop__';
const DEBUG = !!process.env.CCGW_DEBUG;
fs.mkdirSync(WORK_DIR, { recursive: true });

const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
// Resolved through the stable launcher path, so CLI self-updates are picked
// up on the next spawn.
const CLAUDE_PATH = findClaude(cfg.claudePath);

// Desktop lists a second "1M context window" entry for every model reported
// with supports_1m, so it's opt-in (config expose1m) to keep the picker clean.
const MODELS = [
  { id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', anthropic_family_tier: 'opus', is_family_default: true, can1m: true },
  { id: 'claude-sonnet-5', display_name: 'Claude Sonnet 5', anthropic_family_tier: 'sonnet', is_family_default: true, can1m: true },
  { id: 'claude-haiku-4-5-20251001', display_name: 'Claude Haiku 4.5', anthropic_family_tier: 'haiku', is_family_default: true },
  { id: 'claude-fable-5-1', display_name: 'Claude Fable 5.1' },
].map(({ can1m, ...m }) => ({ ...m, supports_1m: !!(can1m && cfg.expose1m), max_input_tokens: can1m && cfg.expose1m ? 1_000_000 : 200_000 }));

// The 1M variant arrives as a context-1m beta header or a "[1m]" model suffix;
// the CLI takes it as the "[1m]" suffix.
function cliModel(req, headers) {
  const base = String(req.model || '').replace(/\[1m\]$/i, '');
  if (!base) return base;
  const wants1m = /\[1m\]$/i.test(req.model) || /context-1m/i.test(String(headers['anthropic-beta'] || ''));
  return wants1m && cfg.expose1m ? `${base}[1m]` : base;
}

const log = (...a) => console.log(new Date().toISOString(), ...a);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);

// ---------------------------------------------------------------- helpers

// Push-based async iterable used as the CLI's streaming prompt input.
function inputChannel() {
  const buf = [];
  let wake = null;
  let closed = false;
  return {
    push(msg) { buf.push(msg); wake?.(); },
    close() { closed = true; wake?.(); },
    async *[Symbol.asyncIterator]() {
      while (true) {
        while (buf.length) yield buf.shift();
        if (closed) return;
        await new Promise((r) => (wake = r));
        wake = null;
      }
    },
  };
}

// Claude Code clients put a per-client billing/version header in the first
// system block. Our CLI adds its own; forwarding theirs makes the API judge
// the request by the client's (possibly older) version.
const BILLING_HEADER = /^x-anthropic-billing-header:.*$/gm;
const systemText = (system) =>
  (!system ? '' : typeof system === 'string' ? system : system.map((b) => b.text || '').join('\n\n'))
    .replace(BILLING_HEADER, '').trim();

const blocks = (content) => (typeof content === 'string' ? [{ type: 'text', text: content }] : content || []);

// Claude Code (e.g. Cowork's agent) sends role:"system" messages in the middle
// of `messages`. Fold each into the adjacent user message as a reminder block,
// flagged so it doesn't affect the fingerprint (its text changes every call).
function normalizeMessages(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'system') {
      const text = typeof m.content === 'string' ? m.content : blocks(m.content).map((b) => b.text || '').join('\n');
      const block = { type: 'text', text: `<system-reminder>\n${text}\n</system-reminder>`, _sys: true };
      const prev = out[out.length - 1];
      if (prev?.role === 'user') prev.content = [...blocks(prev.content), block];
      else out.push({ role: 'user', content: [block] });
    } else out.push({ ...m, content: blocks(m.content) });
  }
  return out;
}

// A stable fingerprint of a conversation that survives the cosmetic changes a
// client makes when echoing history back (thinking stripped, whitespace, etc).
function fingerprint(messages) {
  const norm = messages.map((m) => {
    const parts = blocks(m.content).map((b) => {
      if (b._sys) return '';
      if (b.type === 'text') return 't:' + b.text.trim();
      if (b.type === 'tool_use') return 'u:' + b.id;
      if (b.type === 'tool_result') return 'r:' + b.tool_use_id;
      if (b.type === 'image' || b.type === 'document') return b.type;
      return '';
    }).filter(Boolean);
    return m.role + '|' + parts.join('\u0001');
  });
  return sha(norm.join('\u0002'));
}

// Flatten earlier turns into text, for starting a CLI session mid-conversation.
function transcript(messages) {
  const out = [];
  for (const m of messages) {
    const lines = [];
    for (const b of blocks(m.content)) {
      if (b.type === 'text') lines.push(b.text);
      else if (b.type === 'tool_use') lines.push(`[called tool ${b.name} with ${JSON.stringify(b.input)}]`);
      else if (b.type === 'tool_result') lines.push(`[tool result: ${toolResultText(b.content).slice(0, 20_000)}]`);
      else if (b.type === 'image') lines.push('[image]');
      else if (b.type === 'document') lines.push('[document]');
    }
    if (lines.length) out.push(`<${m.role}>\n${lines.join('\n')}\n</${m.role}>`);
  }
  return out.join('\n\n');
}

function toolResultText(content) {
  if (typeof content === 'string') return content;
  return (content || []).map((b) => (b.type === 'text' ? b.text : `[${b.type}]`)).join('\n');
}

// Messages-API tool_result content -> MCP CallToolResult.
function toMcpResult(block) {
  const content = [];
  for (const b of typeof block.content === 'string' ? [{ type: 'text', text: block.content }] : block.content || []) {
    if (b.type === 'text') content.push({ type: 'text', text: b.text });
    else if (b.type === 'image' && b.source?.type === 'base64')
      content.push({ type: 'image', data: b.source.data, mimeType: b.source.media_type });
    else content.push({ type: 'text', text: JSON.stringify(b) });
  }
  if (!content.length) content.push({ type: 'text', text: '' });
  return { content, isError: !!block.is_error };
}

// Only client-defined tools can be bridged; server tools (web_search, etc) are
// provided by the CLI itself.
function splitTools(tools = []) {
  const client = [];
  const server = [];
  for (const t of tools) {
    if (t.input_schema && (!t.type || t.type === 'custom')) client.push(t);
    else server.push(t.type || t.name);
  }
  return { client, server };
}

function builtinToolsFor(serverTools) {
  const out = [];
  if (serverTools.some((t) => /web_search/.test(t))) out.push('WebSearch');
  if (serverTools.some((t) => /web_fetch/.test(t))) out.push('WebFetch');
  return out;
}

function thinkingBudget(req) {
  const t = req.thinking;
  if (!t || t.type === 'disabled') return 0;
  if (t.type === 'enabled') return t.budget_tokens || 8000;
  return null; // adaptive -> CLI default
}

// ---------------------------------------------------------------- sessions

let seq = 0;

class Session {
  constructor(sysHash, warm, mcp, state) {
    this.id = `s${++seq}`;
    this.sysHash = sysHash;
    this.warm = warm;
    this.mcp = mcp;
    this.state = state; // shared with MCP handlers: { tools, onCall }
    this.input = inputChannel();
    this.q = null;
    this.fp = null; // fingerprint of the history this session has seen
    this.pending = new Map(); // toolUseId -> resolve, CLI blocked in our MCP handler
    this.handed = new Set(); // tool_use ids handed to Desktop, not yet answered
    this.results = new Map(); // toolUseId -> MCP result that arrived before the CLI asked
    this.sink = null; // current Desktop response
    this.busy = false;
    this.dead = false;
    this.lastUsed = Date.now();
    this.model = null;
    this.thinking = undefined;
    // The CLI runs MCP tools one at a time, so for parallel tool calls the
    // later results usually arrive from Desktop before the CLI asks for them.
    state.onCall = (id) => new Promise((resolve) => {
      if (this.results.has(id)) {
        resolve(this.results.get(id));
        this.results.delete(id);
      } else this.pending.set(id, resolve);
    });
  }

  start() {
    this.q = this.warm.query(this.input);
    this.pump();
  }

  async pump() {
    try {
      for await (const m of this.q) {
        this.lastUsed = Date.now();
        if (DEBUG) log(this.id, 'cli>', m.type, m.subtype || m.event?.type || '', m.event?.delta?.stop_reason || '', m.type === 'user' ? JSON.stringify(m.message.content).slice(0, 300) : '');
        if (m.type === 'stream_event') this.sink?.onEvent(m.event);
        else if (m.type === 'result') {
          if (m.is_error || m.subtype !== 'success') this.sink?.onError(m.errors?.join('; ') || m.result || m.subtype);
          this.sink?.onResult();
        } else if (m.type === 'assistant' && m.error) {
          const text = (m.message?.content || []).map((b) => b.text || '').join(' ').trim();
          this.sink?.onError(text ? `${m.error}: ${text}` : `${m.error}`);
        }
      }
    } catch (e) {
      log(this.id, 'pump error', e.message);
      this.sink?.onError(e.message);
    }
    this.dead = true;
    this.sink?.onError('Claude Code session ended');
    sessions.delete(this.id);
  }

  async configure(req) {
    // Control requests are written to the CLI's stdin ahead of the prompt and
    // applied in order, but a fresh CLI only acknowledges them after its first
    // prompt arrives — so fire them without awaiting.
    const warn = (what) => (e) => log(this.id, what, 'failed:', e.message);
    const model = req._cliModel;
    if (model && model !== this.model) {
      this.q.setModel(model).catch(warn('setModel'));
      this.model = model;
    }
    const budget = thinkingBudget(req);
    if (budget !== this.thinking) {
      this.q.setMaxThinkingTokens(budget, budget ? 'summarized' : null).catch(warn('setMaxThinkingTokens'));
      this.thinking = budget;
    }
    const { client } = splitTools(req.tools);
    const toolsJson = JSON.stringify(client);
    if (toolsJson !== this.state.toolsJson) {
      this.state.toolsJson = toolsJson;
      // MCP-exposed names get a 14-char prefix; keep them within the API's 64.
      this.state.alias = new Map();
      this.state.tools = client.map((t) => {
        const name = t.name.length + TOOL_PREFIX.length <= 64 ? t.name : t.name.slice(0, 40) + '_' + sha(t.name).slice(0, 8);
        this.state.alias.set(name, t.name);
        return { name, description: t.description || '', inputSchema: t.input_schema };
      });
      await this.mcp.sendToolListChanged();
      await new Promise((r) => setTimeout(r, 50)); // let the CLI re-list
    }
  }

  deliver(toolUseId, result) {
    this.handed.delete(toolUseId);
    const resolve = this.pending.get(toolUseId);
    if (resolve) {
      this.pending.delete(toolUseId);
      resolve(result);
    } else this.results.set(toolUseId, result);
  }

  close() {
    this.dead = true;
    for (const resolve of this.pending.values()) resolve({ content: [{ type: 'text', text: 'cancelled' }], isError: true });
    this.pending.clear();
    this.input.close();
    try { this.q ? this.q.close() : this.warm.close(); } catch {}
    sessions.delete(this.id);
  }
}

const sessions = new Map();
const spares = new Map(); // sysHash -> Promise<{ warm, mcp, state }>

async function spawnWarm(system, builtins) {
  const state = { tools: [], toolsJson: '[]', alias: new Map(), onCall: null };
  const mcp = new Server({ name: 'desktop', version: '1.0.0' }, { capabilities: { tools: { listChanged: true } } });
  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: state.tools }));
  mcp.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    if (DEBUG) log('mcp call', JSON.stringify(req.params).slice(0, 300));
    const id = req.params._meta?.['claudecode/toolUseId'] || extra?._meta?.['claudecode/toolUseId'] || crypto.randomUUID();
    return state.onCall(id, req.params.name, req.params.arguments);
  });
  const t0 = Date.now();
  const warm = await startup({
    options: {
      pathToClaudeCodeExecutable: CLAUDE_PATH,
      systemPrompt: system || 'You are Claude, a helpful AI assistant made by Anthropic.',
      tools: builtins,
      allowedTools: ['mcp__desktop', ...builtins],
      mcpServers: { desktop: { type: 'sdk', name: 'desktop', instance: mcp, timeout: TOOL_TIMEOUT_MS } },
      strictMcpConfig: true,
      settingSources: [],
      includePartialMessages: true,
      persistSession: false,
      permissionMode: 'bypassPermissions',
      cwd: WORK_DIR,
      env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: 'ccgw/1.0', MCP_TOOL_TIMEOUT: String(TOOL_TIMEOUT_MS) },
    },
  });
  log('warm process ready in', Date.now() - t0, 'ms');
  return { warm, mcp, state };
}

const spareKey = (sysHash, builtins) => sysHash + ':' + builtins.join(',');

function refillSpare(key, system, builtins) {
  if (spares.has(key)) return;
  const p = spawnWarm(system, builtins).catch((e) => { log('spare spawn failed', e.message); spares.delete(key); return null; });
  spares.set(key, p);
  // keep only the most recent few system prompts warm
  while (spares.size > cfg.warmPool) {
    const [oldKey, oldP] = spares.entries().next().value;
    spares.delete(oldKey);
    oldP.then((s) => s?.warm.close());
  }
}

async function newSession(system, builtins) {
  const sysHash = sha(system);
  const key = spareKey(sysHash, builtins);
  // Claim the spare before awaiting it: concurrent requests must never share
  // one warm process (each can only be queried once).
  const spare = spares.get(key);
  spares.delete(key);
  let w = spare ? await spare : null;
  if (!w) w = await spawnWarm(system, builtins);
  refillSpare(key, system, builtins); // replace the one we just took
  const s = new Session(key, w.warm, w.mcp, w.state);
  s.start();
  sessions.set(s.id, s);
  evict();
  return s;
}

function evict() {
  const now = Date.now();
  for (const s of sessions.values()) if (!s.busy && now - s.lastUsed > SESSION_TTL_MS) s.close();
  const idle = [...sessions.values()].filter((s) => !s.busy).sort((a, b) => a.lastUsed - b.lastUsed);
  while (sessions.size > MAX_SESSIONS && idle.length) idle.shift().close();
}
setInterval(evict, 60_000).unref();

// Map CLI failures onto Messages-API error types so clients back off and retry
// the ones that are transient.
function classifyError(msg) {
  if (/rate.?limit|usage limit|429/i.test(msg)) return [429, 'rate_limit_error'];
  if (/overloaded|529/i.test(msg)) return [529, 'overloaded_error'];
  if (/invalid_request|400/i.test(msg)) return [400, 'invalid_request_error'];
  return [502, 'api_error'];
}

// ---------------------------------------------------------------- response sink

// Turns the CLI's raw stream events into one Messages-API response for
// Desktop: several internal CLI API calls (e.g. around built-in web search) are
// merged into one message, internal tool blocks are hidden, and the response
// ends at end_turn or at the first bridged tool call.
class Sink {
  constructor(res, req, session) {
    this.res = res;
    this.stream = !!req.stream;
    this.model = req.model;
    this.session = session;
    this.started = false;
    this.done = false;
    this.indexMap = new Map(); // cli index -> out index, for the current CLI message
    this.outIndex = 0;
    this.content = []; // for non-stream responses
    this.usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
    this.bridged = new Set(); // tool_use ids in this CLI message that Desktop must run
    this.stopEvent = null;
    this.msgId = null;
    // SSE headers go out with the first event, so a failure before any output
    // can still be a real HTTP status (429/529) that clients know to retry.
    if (this.stream) this.ping = setInterval(() => this.res.headersSent && this.send('ping', { type: 'ping' }), 10_000);
    res.on('close', () => { if (!this.done) this.abort(); });
  }

  send(event, data) {
    if (!this.stream || this.res.writableEnded) return;
    if (!this.res.headersSent) this.res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    this.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  // Desktop sizes the context (and decides when to compact) from these
  // numbers, so they must describe one API call, not a sum. message_delta
  // usage is cumulative for its message, so it overwrites message_start's; when
  // the CLI loops over its own tools, the input side is the last call's and
  // only output accumulates.
  addUsage(u, fresh) {
    if (!u) return;
    if (fresh) this.priorOutput = (this.priorOutput || 0) + this.usage.output_tokens;
    for (const k of Object.keys(this.usage)) if (typeof u[k] === 'number') this.usage[k] = u[k];
    else if (fresh) this.usage[k] = 0;
  }

  get totalUsage() {
    return { ...this.usage, output_tokens: (this.priorOutput || 0) + this.usage.output_tokens };
  }

  onEvent(e) {
    if (this.done) return;
    switch (e.type) {
      case 'message_start': {
        this.indexMap.clear();
        this.bridged.clear();
        this.addUsage(e.message.usage, true);
        if (!this.started) {
          this.started = true;
          this.msgId = e.message.id;
          this.send('message_start', { type: 'message_start', message: { ...e.message, model: this.model || e.message.model, content: [], usage: { ...e.message.usage } } });
        }
        break;
      }
      case 'content_block_start': {
        const b = e.content_block;
        let out;
        if (b.type === 'text' || b.type === 'thinking' || b.type === 'redacted_thinking') out = { ...b };
        else if (b.type === 'tool_use' && b.name.startsWith(TOOL_PREFIX)) {
          const exposed = b.name.slice(TOOL_PREFIX.length);
          out = { type: 'tool_use', id: b.id, name: this.session.state.alias.get(exposed) || exposed, input: {} };
          this.bridged.add(b.id);
        }
        if (!out) return; // internal tool / server tool block: hidden
        const idx = this.outIndex++;
        this.indexMap.set(e.index, idx);
        this.content[idx] = { ...out, _json: '' };
        this.send('content_block_start', { type: 'content_block_start', index: idx, content_block: out });
        break;
      }
      case 'content_block_delta': {
        const idx = this.indexMap.get(e.index);
        if (idx === undefined) return;
        const c = this.content[idx];
        const d = e.delta;
        if (d.type === 'text_delta') c.text += d.text;
        else if (d.type === 'thinking_delta') c.thinking += d.thinking;
        else if (d.type === 'signature_delta') c.signature = d.signature;
        else if (d.type === 'input_json_delta') c._json += d.partial_json;
        else if (d.type === 'citations_delta') return;
        this.send('content_block_delta', { type: 'content_block_delta', index: idx, delta: d });
        break;
      }
      case 'content_block_stop': {
        const idx = this.indexMap.get(e.index);
        if (idx === undefined) return;
        this.send('content_block_stop', { type: 'content_block_stop', index: idx });
        break;
      }
      case 'message_delta': {
        this.addUsage(e.usage);
        const stop = e.delta?.stop_reason;
        if (stop === 'tool_use' && this.bridged.size === 0) return; // CLI runs its own tool and continues
        this.stopEvent = e;
        if (stop === 'tool_use') {
          for (const id of this.bridged) this.session.handed.add(id);
          this.finish();
        }
        break;
      }
      case 'message_stop': {
        if (this.stopEvent && this.stopEvent.delta.stop_reason !== 'tool_use') this.finish();
        break;
      }
    }
  }

  onResult() {
    if (!this.done && this.started) this.finish();
  }

  onError(msg) {
    if (this.done) return;
    log(this.session.id, 'error:', msg);
    this.done = true;
    clearInterval(this.ping);
    this.session.busy = false;
    this.session.sink = null;
    const [status, type] = classifyError(String(msg));
    const body = { type: 'error', error: { type, message: String(msg) } };
    if (this.res.headersSent) {
      this.send('error', body);
      this.res.end();
    } else json(this.res, status, body);
    this.onDone?.(false);
  }

  finish() {
    if (this.done) return;
    this.done = true;
    clearInterval(this.ping);
    const e = this.stopEvent || { delta: { stop_reason: 'end_turn', stop_sequence: null } };
    const usage = this.totalUsage;
    this.send('message_delta', { type: 'message_delta', delta: { stop_reason: e.delta.stop_reason, stop_sequence: e.delta.stop_sequence ?? null }, usage });
    this.send('message_stop', { type: 'message_stop' });
    const content = this.content.filter(Boolean).map(({ _json, ...c }) => {
      if (c.type === 'tool_use') { try { c.input = _json ? JSON.parse(_json) : {}; } catch { c.input = {}; } }
      return c;
    });
    if (this.stream) this.res.end();
    else json(this.res, 200, { id: this.msgId || 'msg_' + crypto.randomUUID(), type: 'message', role: 'assistant', model: this.model, content, stop_reason: e.delta.stop_reason, stop_sequence: e.delta.stop_sequence ?? null, usage });
    this.session.busy = false;
    this.session.sink = null;
    this.session.lastUsed = Date.now();
    this.onDone?.(true, content);
  }

  abort() {
    // Client went away mid-turn (user pressed stop). The CLI turn can't be
    // resumed cleanly, so interrupt it and drop the session.
    this.done = true;
    clearInterval(this.ping);
    log(this.session.id, 'client disconnected, interrupting');
    this.session.q?.interrupt().catch(() => {});
    this.session.close();
  }
}

// ---------------------------------------------------------------- /v1/messages

function toCliUserContent(content) {
  // Pass text/image/document blocks straight through; drop anything the CLI
  // prompt channel can't take.
  return blocks(content).filter((b) => ['text', 'image', 'document'].includes(b.type)).map((b) => {
    const { cache_control, citations, _sys, ...rest } = b;
    return rest;
  });
}

async function handleMessages(req, res) {
  if (DEBUG) {
    const dir = path.join(HOME_DIR, 'debug');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${Date.now()}.json`), JSON.stringify(req, null, 1));
  }
  const messages = normalizeMessages(req.messages || []);
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'user') return json(res, 400, errBody('invalid_request_error', 'last message must be a user message'));

  const system = systemText(req.system);
  const { server: serverTools } = splitTools(req.tools);
  const builtins = builtinToolsFor(serverTools);
  const key = spareKey(sha(system), builtins);
  const lastBlocks = blocks(last.content);
  const toolResults = lastBlocks.filter((b) => b.type === 'tool_result');

  let session = null;
  let resume = false;

  // 1) tool results for a session blocked in our MCP handler
  if (toolResults.length) {
    session = [...sessions.values()].find((s) => !s.dead && toolResults.some((b) => s.handed.has(b.tool_use_id)));
    if (session) resume = true;
  }
  // 2) a plain follow-up in a conversation we already hold
  if (!session) {
    const fp = fingerprint(messages.slice(0, -1));
    session = [...sessions.values()].find((s) => !s.dead && !s.busy && s.sysHash === key && s.fp === fp && s.handed.size === 0);
  }
  if (session?.busy) return json(res, 409, errBody('invalid_request_error', 'conversation is busy'));

  let fresh = false;
  if (!session) {
    session = await newSession(system, builtins);
    fresh = true;
  }
  session.busy = true;
  session.lastUsed = Date.now();

  try {
    await session.configure(req);
  } catch (e) {
    session.busy = false;
    session.close();
    return json(res, 502, errBody('api_error', 'failed to configure Claude Code session: ' + e.message));
  }

  const sink = new Sink(res, req, session);
  session.sink = sink;
  sink.onDone = (ok, content) => {
    if (!ok) return;
    session.fp = fingerprint([...messages, { role: 'assistant', content }]);
  };

  const kind = resume ? 'tool-result' : fresh ? (messages.length > 1 ? 'new+history' : 'new') : 'follow-up';
  log(session.id, kind, `model=${req._cliModel} msgs=${messages.length} tools=${(req.tools || []).length} stream=${!!req.stream}`);

  if (resume) {
    for (const b of toolResults) if (session.handed.has(b.tool_use_id)) session.deliver(b.tool_use_id, toMcpResult(b));
    // Any user text sent alongside tool results goes in as the next prompt.
    // (Folded system reminders are dropped here: pushing them would read as an
    // empty extra user turn.)
    const extra = toCliUserContent(lastBlocks.filter((b) => !b._sys && !(b.type === 'text' && !b.text.trim())));
    if (extra.length) session.input.push({ type: 'user', message: { role: 'user', content: extra }, parent_tool_use_id: null, priority: 'next' });
    return;
  }

  let content = toCliUserContent(last.content);
  if (fresh && messages.length > 1) {
    const hist = transcript(messages.slice(0, -1));
    content = [{ type: 'text', text: `<conversation_history>\n${hist}\n</conversation_history>\n\nContinue the conversation above. The user's new message follows.` }, ...content];
  }
  if (!content.length) content = [{ type: 'text', text: toolResults.length ? transcript([last]) : '(empty)' }];
  session.input.push({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null });
}

// ---------------------------------------------------------------- http

function json(res, status, body) {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}
const errBody = (type, message) => ({ type: 'error', error: { type, message } });

function authorized(req) {
  const h = req.headers;
  const bearer = (h.authorization || '').replace(/^Bearer\s+/i, '');
  const key = h['x-api-key'] || bearer;
  const a = Buffer.from(String(key));
  const b = Buffer.from(API_KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname.replace(/\/+$/, '') || '/';
  try {
    if (p === '/' || p === '/health') return json(res, 200, { ok: true, name: 'ccgw', version: VERSION, sessions: sessions.size, warm: spares.size });
    if (!authorized(req)) return json(res, 401, errBody('authentication_error', 'invalid api key'));

    if (req.method === 'POST' && p === '/admin/shutdown') {
      json(res, 200, { ok: true });
      return shutdown();
    }

    if (req.method === 'GET' && p === '/v1/models')
      return json(res, 200, { data: MODELS.map((m) => ({ type: 'model', created_at: '2026-01-01T00:00:00Z', ...m })), has_more: false, first_id: MODELS[0].id, last_id: MODELS.at(-1).id });
    if (req.method === 'GET' && p.startsWith('/v1/models/')) {
      const m = MODELS.find((x) => x.id === p.slice('/v1/models/'.length));
      return m ? json(res, 200, { type: 'model', ...m }) : json(res, 404, errBody('not_found_error', 'model not found'));
    }
    if (req.method === 'POST' && p === '/v1/messages/count_tokens') {
      const body = await readBody(req);
      const chars = JSON.stringify([body.system || '', body.messages || [], body.tools || []]).length;
      return json(res, 200, { input_tokens: Math.ceil(chars / 3.5) });
    }
    if (req.method === 'POST' && p === '/v1/messages') {
      const body = await readBody(req);
      body._cliModel = cliModel(body, req.headers);
      return await handleMessages(body, res);
    }

    log('unhandled', req.method, req.url);
    return json(res, 404, errBody('not_found_error', `${req.method} ${p} is not supported by ccgw`));
  } catch (e) {
    log('request error', e.stack || e.message);
    if (!res.headersSent) json(res, 500, errBody('api_error', e.message));
    else res.end();
  }
});
server.requestTimeout = 0;
server.headersTimeout = 60_000;

server.listen(PORT, HOST, () => {
  log(`ccgw v${VERSION} listening on http://${HOST}:${PORT} (claude: ${CLAUDE_PATH || 'bundled'})`);
  refillSpare(spareKey(sha(''), []), '', []); // warm one generic process up front
});

server.on('error', (e) => {
  log('server error:', e.code === 'EADDRINUSE' ? `port ${PORT} is already in use (set another with: ccgw start --port N)` : e.message);
  process.exit(1);
});

// One bad request or CLI hiccup must not take the whole gateway down.
process.on('uncaughtException', (e) => log('uncaught exception:', e.stack || e.message));
process.on('unhandledRejection', (e) => log('unhandled rejection:', e?.stack || e));

let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  log('shutting down');
  for (const s of sessions.values()) s.close();
  for (const p of spares.values()) p.then((s) => s?.warm.close());
  server.close();
  setTimeout(() => process.exit(0), 500).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
