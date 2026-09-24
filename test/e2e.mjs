import Anthropic from '@anthropic-ai/sdk';
import { readConfig } from '../src/config.mjs';
const cfg = readConfig();
const client = new Anthropic({ baseURL: `http://${cfg.host}:${cfg.port}`, authToken: cfg.apiKey, apiKey: null });
const model = process.argv[2] || 'claude-haiku-4-5-20251001';
const system = 'You are a concise assistant.';
const tools = [{ name: 'get_weather', description: 'Get current weather for a city', input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } }];
const T = () => Date.now();

console.log((await client.models.list()).data.map(m => m.id).join(', '));

// 1. streaming + tool call
let t = T(), ttft;
const messages = [{ role: 'user', content: 'Weather in Hanoi and in Tokyo? Use the tool for both.' }];
let s = client.messages.stream({ model, max_tokens: 1024, system, tools, messages });
s.on('text', () => { ttft ??= T() - t; });
let msg = await s.finalMessage();
console.log('turn1', T() - t, 'ms', msg.stop_reason, msg.content.map(b => b.type + (b.name ? ':' + b.name + JSON.stringify(b.input) : '')).join(' '));
messages.push({ role: 'assistant', content: msg.content });
messages.push({ role: 'user', content: msg.content.filter(b => b.type === 'tool_use').map(b => ({ type: 'tool_result', tool_use_id: b.id, content: b.input.city === 'Hanoi' ? '31C sunny' : '18C rain' })) });
t = T(); ttft = undefined;
s = client.messages.stream({ model, max_tokens: 1024, system, tools, messages });
s.on('text', () => { ttft ??= T() - t; });
msg = await s.finalMessage();
console.log('turn2', T() - t, 'ms ttft', ttft, msg.stop_reason, JSON.stringify(msg.content.filter(b => b.type === 'text').map(b => b.text).join('')));
messages.push({ role: 'assistant', content: msg.content });

// 3. follow-up in same conversation (should reuse session)
messages.push({ role: 'user', content: 'Which city is warmer? One word.' });
t = T(); ttft = undefined;
s = client.messages.stream({ model, max_tokens: 1024, system, tools, messages });
s.on('text', () => { ttft ??= T() - t; });
msg = await s.finalMessage();
console.log('turn3', T() - t, 'ms ttft', ttft, msg.stop_reason, JSON.stringify(msg.content.filter(b => b.type === 'text').map(b => b.text).join('')));

// 4. non-stream, new conversation (title-gen style)
t = T();
const r = await client.messages.create({ model, max_tokens: 50, system: 'Generate a 3-word title.', messages: [{ role: 'user', content: 'how do I bake sourdough bread' }] });
console.log('nonstream', T() - t, 'ms', r.stop_reason, JSON.stringify(r.content[0]?.text), r.usage);
