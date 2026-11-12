// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Workers AI provider (issue #86, epic #84): the first model rung through the Worker binding, no key and no payment.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { makeDb } from '../../_shared/testdb.js';
import { createRouter } from '../router.js';
import { ADAPTERS } from './index.js';
import * as wai from './workers-ai.js';

const MIG = fileURLToPath(new URL('../migrations/', import.meta.url));
const NOW = Date.UTC(2026, 5, 15, 12, 0, 0);
const model = { id: '@cf/example/small', capabilities: ['json'] };
const provider = { kind: 'workers_ai', key_env: null, family: 'open', models: { small: model } };

test('registered as a keyless adapter named workers_ai', () => {
  assert.equal(ADAPTERS.workers_ai, wai);
  assert.equal(wai.kind, 'workers_ai');
  assert.equal(wai.keyless, true);
});

test('invoke calls binding.run(model id, messages) and maps response, usage and tool calls', async () => {
  const seen = [];
  const ai = { run: async (m, i) => { seen.push([m, i]); return { response: 'hi', usage: { prompt_tokens: 7, completion_tokens: 3 }, tool_calls: [{ name: 'f' }] }; } };
  const out = await wai.invoke(ai, provider, model, { messages: [{ role: 'user', content: 'x' }], max_tokens: 64, temperature: 0.2, tools: [{ name: 'f' }] });
  assert.equal(seen[0][0], '@cf/example/small');
  assert.deepEqual(seen[0][1], { messages: [{ role: 'user', content: 'x' }], max_tokens: 64, temperature: 0.2, tools: [{ name: 'f' }] });
  assert.deepEqual(out, { text: 'hi', tool_calls: [{ name: 'f' }], tokens_in: 7, tokens_out: 3 });
});

test('a bare function works as the binding; run keeps its this', async () => {
  assert.equal((await wai.invoke(async () => ({ response: 'fn' }), provider, model, { messages: [] })).text, 'fn');
  const obj = { tag: 'T', async run() { return { response: this.tag }; } };
  assert.equal((await wai.invoke(obj, provider, model, { messages: [] })).text, 'T');
});

test('json mode asks for json_object and stringifies a parsed object answer', async () => {
  let input;
  const ai = { run: async (_m, i) => { input = i; return { response: { a: 1 } }; } };
  const out = await wai.invoke(ai, provider, model, { messages: [], json: true });
  assert.deepEqual(input.response_format, { type: 'json_object' });
  assert.equal(out.text, '{"a":1}');
});

test('openai-shaped output parses; missing usage is estimated at 4 characters per token', async () => {
  const ai = { run: async () => ({ choices: [{ message: { content: 'abcdefgh', tool_calls: [{ id: 1 }] } }] }) };
  const out = await wai.invoke(ai, provider, model, { messages: [{ content: 'abcdefghijkl' }] });
  assert.equal(out.text, 'abcdefgh'); assert.equal(out.tokens_in, 3); assert.equal(out.tokens_out, 2);
  assert.deepEqual(out.tool_calls, [{ id: 1 }]);
});

test('no binding, empty answer and binding errors all throw (never a silent empty reply)', async () => {
  await assert.rejects(() => wai.invoke(null, provider, model, { messages: [] }), /binding missing/);
  await assert.rejects(() => wai.invoke({ run: async () => ({ response: '' }) }, provider, model, { messages: [] }), /no text/);
  await assert.rejects(() => wai.invoke({ run: async () => ({}) }, provider, model, { messages: [] }), /no text/);
  await assert.rejects(() => wai.invoke({ run: async () => { throw new Error('neurons exhausted'); } }, provider, model, { messages: [] }), /neurons exhausted/);
});

test('router: first rung with no key in env succeeds, costs 0, and the call is recorded', async () => {
  const db = makeDb([MIG]);
  const ai = { run: async () => ({ response: 'free', usage: { prompt_tokens: 10, completion_tokens: 4 } }) };
  const router = createRouter({ db, fetch: async () => { throw new Error('network must not be used'); }, now: () => NOW, env: {}, ai,
    config: { rungs: ['small', 'medium', 'large'], fallbacks: ['edge'], providers: { edge: provider } } });
  const r = await router.call({ role: 'triage', rung: 'small', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(r.ok, true); assert.equal(r.provider, 'edge'); assert.equal(r.cost_usd, 0); assert.equal(r.text, 'free');
  const row = db.raw.prepare('SELECT provider, cost_usd, tokens_in, tokens_out, outcome FROM router_calls').get();
  assert.deepEqual({ ...row }, { provider: 'edge', cost_usd: 0, tokens_in: 10, tokens_out: 4, outcome: 'ok' });
});

test('router: an empty Workers AI answer is an error row and falls back to the next provider', async () => {
  const db = makeDb([MIG]);
  const paid = { kind: 'openai', base_url: 'https://p.example/v1', key_env: 'P_KEY', family: 'other', models: { small: { id: 'p', capabilities: ['json'], usd_per_1k_in: 0.001, usd_per_1k_out: 0.002 } } };
  const fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: 'paid' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 });
  const router = createRouter({ db, fetch, now: () => NOW, env: { P_KEY: 'sk-test-0000' }, ai: { run: async () => ({ response: '' }) },
    config: { rungs: ['small'], fallbacks: ['edge', 'paid'], providers: { edge: provider, paid } } });
  const r = await router.call({ role: 'reviewer', rung: 'small', messages: [] });
  assert.equal(r.ok, true); assert.equal(r.provider, 'paid');
  assert.deepEqual(db.raw.prepare('SELECT outcome FROM router_calls ORDER BY id').all().map(x => x.outcome), ['error', 'ok']);
});

test('router: without the binding the provider is unusable', async () => {
  const router = createRouter({ db: makeDb([MIG]), fetch: async () => { throw new Error('x'); }, now: () => NOW, env: {}, ai: null,
    config: { rungs: ['small'], fallbacks: ['edge'], providers: { edge: provider } } });
  assert.equal((await router.route({ role: 'triage', rung: 'small' })).refusal, 'no_capable_provider');
});
