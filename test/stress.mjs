// Stability checks against a running gateway: concurrency, aborts, errors.
import Anthropic from '@anthropic-ai/sdk';
import { readConfig } from '../src/config.mjs';

const cfg = readConfig();
const base = `http://${cfg.host}:${process.env.CCGW_PORT || cfg.port}`;
const client = new Anthropic({ baseURL: base, authToken: cfg.apiKey, apiKey: null, maxRetries: 0 });
const model = process.env.MODEL || 'claude-haiku-4-5-20251001';
const tools = [{ name: 'lookup', description: 'Look up the secret code for a word', input_schema: { type: 'object', properties: { word: { type: 'string' } }, required: ['word'] } }];
let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${extra}`); if (!ok) failed++; };
const post = (path, body, key = cfg.apiKey) => fetch(base + path, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });

// 1. auth + validation
check('wrong key -> 401', (await post('/v1/messages', {}, 'nope')).status === 401);
check('assistant-last -> 400', (await post('/v1/messages', { model, messages: [{ role: 'assistant', content: 'x' }] })).status === 400);
check('unknown path -> 404 json', (await post('/v1/nope', {})).status === 404);
const ct = await (await post('/v1/messages/count_tokens', { model, messages: [{ role: 'user', content: 'hello world' }] })).json();
check('count_tokens', ct.input_tokens > 0, JSON.stringify(ct));

// 2. parallel conversations, each with a tool round trip
async function conversation(word) {
  const t = Date.now();
  const messages = [{ role: 'user', content: `Use the lookup tool for the word "${word}", then reply with only the code.` }];
  let m = await client.messages.create({ model, max_tokens: 512, tools, messages, stream: false });
  const use = m.content.find((b) => b.type === 'tool_use');
  if (!use) return { word, ok: false, why: 'no tool_use: ' + JSON.stringify(m.content).slice(0, 200) };
  messages.push({ role: 'assistant', content: m.content });
  messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: use.id, content: `CODE-${word.toUpperCase()}-42` }] });
  const s = client.messages.stream({ model, max_tokens: 512, tools, messages });
  m = await s.finalMessage();
  const text = m.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return { word, ok: text.includes(`CODE-${word.toUpperCase()}-42`), ms: Date.now() - t, text: text.slice(0, 60) };
}
const words = ['apple', 'river', 'stone', 'cloud'];
const results = await Promise.all(words.map((w) => conversation(w).catch((e) => ({ word: w, ok: false, why: e.message }))));
for (const r of results) check(`parallel conversation "${r.word}"`, r.ok, r.ok ? `${r.ms}ms` : r.why || r.text);

// 3. client aborts mid-stream, gateway keeps serving
{
  const ac = new AbortController();
  let got = 0;
  try {
    const s = client.messages.stream({ model, max_tokens: 2000, messages: [{ role: 'user', content: 'Count from 1 to 300, one number per line.' }] }, { signal: ac.signal });
    s.on('text', () => { if (++got === 3) ac.abort(); });
    await s.finalMessage();
  } catch {}
  check('abort mid-stream', got >= 3);
  const r = await client.messages.create({ model, max_tokens: 50, messages: [{ role: 'user', content: 'Reply with the word pong.' }] });
  check('serves after abort', /pong/i.test(r.content[0]?.text || ''), JSON.stringify(r.content[0]?.text));
}

const h = await (await fetch(base + '/health')).json();
console.log('health', JSON.stringify(h));
console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
process.exit(failed ? 1 : 0);
