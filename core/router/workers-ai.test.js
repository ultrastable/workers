// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { makeDb } from '../_shared/testdb.js';
import { createRouter } from './router.js';
import { runnerNeeds } from '../org/index.js';

const MIG = fileURLToPath(new URL('./migrations/', import.meta.url));
const NOW = Date.UTC(2026, 5, 15, 12, 0, 0);
const edge = { kind: 'workers_ai', key_env: null, family: 'open', models: { small: { id: 'm-small', capabilities: ['json'] } } };
const paid = { kind: 'openai', base_url: 'https://p.example/v1', key_env: 'P_KEY', family: 'other',
  models: { small: { id: 'p-small', capabilities: ['json'], usd_per_1k_in: 0.001, usd_per_1k_out: 0.002 } } };
const cfg = (providers, extra = {}) => ({ rungs: ['small', 'medium', 'large'], fallbacks: Object.keys(providers), providers, ...extra });
const fakeAi = (impl) => { const calls = []; return { calls, run: async (m, i) => { calls.push({ m, i }); return impl(m, i); } }; };
const okFetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: 'paid' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200 });
const mk = (config, ai, env = {}, fetch = okFetch) => {
  const db = makeDb([MIG]);
  return { db, router: createRouter({ db, fetch, now: () => NOW, config, env, ai }) };
};

test('happy path: free, usage counted', async () => {
  const ai = fakeAi(() => ({ response: 'hello', usage: { prompt_tokens: 120, completion_tokens: 30 } }));
  const { db, router } = mk(cfg({ edge }), ai);
  const r = await router.call({ role: 'triage', rung: 'small', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(r.ok, true); assert.equal(r.text, 'hello'); assert.equal(r.cost_usd, 0);
  assert.equal(ai.calls[0].m, 'm-small'); assert.ok(ai.calls[0].i.max_tokens > 0);
  const row = db.raw.prepare('SELECT * FROM router_calls').get();
  assert.equal(row.cost_usd, 0); assert.equal(row.tokens_in, 120); assert.equal(row.tokens_out, 30); assert.equal(row.outcome, 'ok');
});

test('tokens are estimated when the binding reports none; openai-shaped output parses', async () => {
  const ai = fakeAi(() => ({ choices: [{ message: { content: 'abcdefgh' } }] }));
  const { db, router } = mk(cfg({ edge }), ai);
  const r = await router.call({ role: 'manager', rung: 'small', messages: [{ role: 'user', content: 'abcdefgh' }] });
  assert.equal(r.text, 'abcdefgh');
  const row = db.raw.prepare('SELECT * FROM router_calls').get();
  assert.equal(row.tokens_in, 2); assert.equal(row.tokens_out, 2);
});

test('error falls back to the next provider and is recorded', async () => {
  const ai = fakeAi(() => { throw new Error('neurons exhausted'); });
  const { db, router } = mk(cfg({ edge, paid }), ai, { P_KEY: 'sk-secret-zzzz' });
  const r = await router.call({ role: 'reviewer', rung: 'small', messages: [] });
  assert.equal(r.ok, true); assert.equal(r.provider, 'paid'); assert.equal(r.attempts[0].provider, 'edge');
  const rows = db.raw.prepare('SELECT outcome FROM router_calls ORDER BY id').all().map(x => x.outcome);
  assert.deepEqual(rows, ['error', 'ok']);
});

test('no key and no binding: provider unusable; no key ever needed with the binding', async () => {
  const { router } = mk(cfg({ edge }), null);
  assert.equal((await router.route({ role: 'triage', rung: 'small' })).refusal, 'no_capable_provider');
  const ok = mk(cfg({ edge }), fakeAi(() => ({ response: 'x' })), {}).router;
  assert.equal((await ok.route({ role: 'triage', rung: 'small' })).ok, true);
});

test('quality guard: workers_ai refused for doer by default, allowed when config says so', async () => {
  const ai = fakeAi(() => ({ response: 'x' }));
  const { router } = mk(cfg({ edge }), ai);
  const p = await router.route({ role: 'doer', kind: 'doer', rung: 'small' });
  assert.equal(p.ok, false); assert.equal(p.refusal, 'role_not_allowed');
  const allowed = mk(cfg({ edge }, { rung_roles: { workers_ai: ['doer'] } }), ai).router;
  assert.equal((await allowed.route({ role: 'doer', kind: 'doer', rung: 'small' })).ok, true);
});

test('doer skips workers_ai and uses the paid provider when one exists', async () => {
  const { router } = mk(cfg({ edge, paid }), fakeAi(() => ({ response: 'x' })), { P_KEY: 'sk-secret-zzzz' });
  const p = await router.route({ role: 'doer', kind: 'doer', rung: 'small' });
  assert.equal(p.candidates[0].provider, 'paid');
});

test('runnerNeeds: AI binding alone satisfies the provider check, no key named', () => {
  const config = { vcs: { repo: 'o/r' }, router: { providers: { edge } } };
  assert.deepEqual(runnerNeeds(config, { VCS_TOKEN: 't', AI: {} }), []);
  assert.deepEqual(runnerNeeds(config, { VCS_TOKEN: 't' }), ['AI']);
});
