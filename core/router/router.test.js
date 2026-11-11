// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { makeDb } from '../_shared/testdb.js';
import { createRouter, selectTier, handle } from './router.js';

const MIG = fileURLToPath(new URL('./migrations/', import.meta.url));
const EXAMPLE = JSON.parse(readFileSync(new URL('./example-config.json', import.meta.url), 'utf8'));
const KEYS = { PROVIDER_A_API_KEY: 'sk-test-secret-aaaa', PROVIDER_B_API_KEY: 'sk-test-secret-bbbb' };
const NOW = Date.UTC(2026, 5, 15, 12, 0, 0);

function fakeFetch(handlers = {}) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, init });
    const isA = url.includes('provider-a');
    const h = isA ? handlers.a : handlers.b;
    const echo = init.headers.authorization || init.headers['x-api-key'] || '';
    if (h === 'fail') return new Response('boom ' + echo, { status: 500 });
    if (h === 'throw') throw new Error('network down ' + echo);
    const body = isA
      ? { choices: [{ message: { content: 'hi-a' } }], usage: { prompt_tokens: 1000, completion_tokens: 500 } }
      : { content: [{ type: 'text', text: 'hi-b' }], usage: { input_tokens: 1000, output_tokens: 500 } };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  f.calls = calls;
  return f;
}
function mk({ config = EXAMPLE, handlers, env = KEYS } = {}) {
  const db = makeDb([MIG]);
  const fetch = fakeFetch(handlers);
  const router = createRouter({ db, fetch, now: () => NOW, config, env });
  return { db, fetch, router };
}
const seedSpend = (db, usd, role = 'doer', at = '2026-06-15 10:00:00') =>
  db.raw.prepare(`INSERT INTO router_calls (at, role, cost_usd, outcome) VALUES (?,?,?,'ok')`).run(at, role, usd);

test('migration is idempotent', () => {
  const { db } = mk();
  const sql = readFileSync(MIG + '0001_router.sql', 'utf8');
  db.raw.exec(sql); db.raw.exec(sql);
});

test('route maps rung to providers in fallback order (US-09-R07/R08)', async () => {
  const { router } = mk();
  const p = await router.route({ rung: 'medium', role: 'manager' });
  assert.equal(p.ok, true);
  assert.deepEqual(p.candidates.map(c => c.provider), ['provider-a', 'provider-b']);
  assert.equal(p.rung, 'medium');
});

test('capability gate: models without the capability are never routed (US-09-R08, T04)', async () => {
  const { router } = mk();
  const p = await router.route({ rung: 'small', capabilities: ['tools'] });
  assert.deepEqual(p.candidates.map(c => c.provider), ['provider-b']);
  const none = await router.route({ rung: 'small', capabilities: ['vision'] });
  assert.equal(none.ok, false);
  assert.equal(none.refusal, 'no_capable_provider');
});

test('provider without key presence is skipped', async () => {
  const { router } = mk({ env: { PROVIDER_B_API_KEY: 'x-value' } });
  const p = await router.route({ rung: 'small' });
  assert.deepEqual(p.candidates.map(c => c.provider), ['provider-b']);
});

test('fallback order: first provider errors, second serves (US-09-R07)', async () => {
  const { router, fetch } = mk({ handlers: { a: 'fail' } });
  const r = await router.call({ rung: 'small', role: 'doer', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(r.ok, true);
  assert.equal(r.provider, 'provider-b');
  assert.equal(r.attempts.length, 1);
  assert.match(fetch.calls[0].url, /provider-a/);
  assert.match(fetch.calls[1].url, /provider-b/);
});

test('all providers failing returns an explicit refusal and records each error', async () => {
  const { router, db } = mk({ handlers: { a: 'throw', b: 'fail' } });
  const r = await router.call({ rung: 'small' });
  assert.equal(r.ok, false);
  assert.equal(r.refusal, 'all_providers_failed');
  const rows = (await db.prepare(`SELECT outcome FROM router_calls`).all()).results;
  assert.deepEqual(rows.map(x => x.outcome), ['error', 'error']);
});

test('cost, tokens, latency and outcome are recorded per call (US-09-R10)', async () => {
  const { router, db } = mk();
  const r = await router.call({ rung: 'medium', role: 'doer', item_id: 'i1', kind: 'doer' });
  assert.equal(r.ok, true);
  assert.ok(Math.abs(r.cost_usd - 0.006) < 1e-9);
  const row = await db.prepare(`SELECT * FROM router_calls`).first();
  assert.equal(row.model, 'a-medium');
  assert.equal(row.tokens_in, 1000);
  assert.equal(row.tokens_out, 500);
  assert.equal(row.outcome, 'ok');
  assert.ok(Math.abs(row.cost_usd - 0.006) < 1e-9);
  assert.equal(row.family, 'family-a');
  assert.equal(typeof row.latency_ms, 'number');
});

test('soft cap steers down one rung (US-09-R07, T03)', async () => {
  const { router, db } = mk();
  seedSpend(db, 2.5); // role cap soft 2, hard 3
  const p = await router.route({ rung: 'large', role: 'doer' });
  assert.equal(p.ok, true);
  assert.equal(p.rung, 'medium');
  assert.equal(p.steered, true);
  assert.equal(p.cap_state, 'soft');
  const other = await router.route({ rung: 'large', role: 'reviewer' }); // role cap does not bind other roles
  assert.equal(other.rung, 'large');
});

test('hard cap refuses paid calls and files a gate-style record once (US-09-R05/R06)', async () => {
  const { router, db, fetch } = mk();
  seedSpend(db, 3.5);
  const r = await router.call({ rung: 'small', role: 'doer' });
  assert.equal(r.ok, false);
  assert.equal(r.refusal, 'hard_cap');
  assert.equal(fetch.calls.length, 0);
  await router.route({ rung: 'small', role: 'doer' });
  const recs = (await db.prepare(`SELECT * FROM router_gate_records`).all()).results;
  assert.equal(recs.length, 1);
  assert.equal(recs[0].status, 'open');
  assert.ok(recs[0].closing_probe && recs[0].default_in_effect && recs[0].why_gated);
});

test('hard cap still serves a free rung: a cap never ends a task while a free path exists (US-09-R07)', async () => {
  const a = EXAMPLE.providers['provider-a'];
  const free = { id: 'a-free', capabilities: ['json'], usd_per_1k_in: 0, usd_per_1k_out: 0 };
  const config = { ...EXAMPLE, providers: { ...EXAMPLE.providers, 'provider-a': { ...a, models: { ...a.models, small: free } } } };
  const { router, db } = mk({ config });
  seedSpend(db, 99, 'doer');
  const p = await router.route({ rung: 'large', role: 'doer' });
  assert.equal(p.ok, true);
  assert.equal(p.candidates[0].model, 'a-free');
});

test('per-period caps: spend from a previous period does not count', async () => {
  const { router, db } = mk({ config: { ...EXAMPLE, caps: [EXAMPLE.caps[1]] } });
  seedSpend(db, 99, 'doer', '2026-06-14 10:00:00'); // yesterday; role cap is per day
  const p = await router.route({ rung: 'large', role: 'doer' });
  assert.equal(p.steered, false);
  assert.equal((await router.spend('month')).usd, 99);
  assert.equal((await router.spend('day')).usd, 0);
});

test('total cap applies to every role', async () => {
  const { router, db } = mk();
  seedSpend(db, 41, 'x'); // month soft 40
  const p = await router.route({ rung: 'medium', role: 'reviewer' });
  assert.equal(p.rung, 'small');
});

test('kill switch for a provider and for all paid calls (US-09-R01/R05)', async () => {
  const { router, fetch } = mk();
  await router.setSwitch('provider:provider-a', true, 'drill');
  let p = await router.route({ rung: 'small' });
  assert.deepEqual(p.candidates.map(c => c.provider), ['provider-b']);
  await router.setSwitch('all', true, 'drill');
  const r = await router.call({ rung: 'small' });
  assert.equal(r.refusal, 'kill_switch_all');
  assert.equal(fetch.calls.length, 0);
  await router.setSwitch('all', false);
  await router.setSwitch('provider:provider-a', false);
  p = await router.route({ rung: 'small' });
  assert.equal(p.candidates[0].provider, 'provider-a');
});

test('family separation: reviewer excludes the doer family for the same item (US-09-R13)', async () => {
  const { router } = mk();
  const d = await router.call({ rung: 'small', item_id: 'item-1', kind: 'doer' });
  assert.equal(d.provider, 'provider-a');
  const p = await router.route({ rung: 'small', item_id: 'item-1', kind: 'reviewer' });
  assert.deepEqual(p.candidates.map(c => c.family), ['family-b']);
  const otherItem = await router.route({ rung: 'small', item_id: 'item-2', kind: 'reviewer' });
  assert.equal(otherItem.candidates[0].family, 'family-a');
});

test('family separation refuses when only the doer family is available', async () => {
  const { router } = mk({ env: { PROVIDER_A_API_KEY: 'k-aaaa' } });
  await router.call({ rung: 'small', item_id: 'i', kind: 'doer' });
  const p = await router.route({ rung: 'small', item_id: 'i', kind: 'reviewer' });
  assert.equal(p.ok, false);
  assert.equal(p.refusal, 'no_distinct_family');
});

test('no API key is ever stored or returned, even when an upstream error echoes it', async () => {
  const { router, db } = mk({ handlers: { a: 'throw', b: 'fail' } });
  const r = await router.call({ rung: 'small' });
  const dump = JSON.stringify(r) + JSON.stringify(db.raw.prepare(`SELECT * FROM router_calls`).all())
    + JSON.stringify(db.raw.prepare(`SELECT * FROM router_gate_records`).all());
  for (const v of Object.values(KEYS)) assert.equal(dump.includes(v), false);
  assert.match(dump, /redacted/);
});

test('adapters send the key only in a request header, never the body', async () => {
  const msgs = [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }];
  const { router, fetch } = mk();
  await router.call({ rung: 'small', messages: msgs });
  const a = fetch.calls[0];
  assert.equal(a.init.headers.authorization, 'Bearer ' + KEYS.PROVIDER_A_API_KEY);
  assert.equal(a.init.body.includes(KEYS.PROVIDER_A_API_KEY), false);
  const { router: r2, fetch: f2 } = mk({ env: { PROVIDER_B_API_KEY: KEYS.PROVIDER_B_API_KEY } });
  await r2.call({ rung: 'small', messages: msgs });
  const b = JSON.parse(f2.calls[0].init.body);
  assert.equal(f2.calls[0].init.headers['x-api-key'], KEYS.PROVIDER_B_API_KEY);
  assert.equal(b.system, 's');
  assert.equal(b.messages.length, 1);
});

test('handle: GET /spend and POST /route', async () => {
  const { router, db } = mk();
  seedSpend(db, 1.25);
  const ctx = { router };
  const s = await handle(new Request('http://x.test/spend?period=day'), ctx);
  assert.equal((await s.json()).usd, 1.25);
  const r = await handle(new Request('http://x.test/route', { method: 'POST', body: JSON.stringify({ rung: 'small' }) }), ctx);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).candidates[0].provider, 'provider-a');
  assert.equal((await handle(new Request('http://x.test/spend?period=bogus'), ctx)).status, 400);
  assert.equal((await handle(new Request('http://x.test/nope'), ctx)).status, 404);
});

test('tier selection from budget (US-09-R14, T05)', () => {
  const tiers = [
    { budget_usd_per_month_min: 0, doer: 'small' },
    { budget_usd_per_month_min: 50, doer: 'medium' },
    { budget_usd_per_month_min: 500, doer: 'large' },
  ];
  assert.deepEqual([0, 49.99, 50, 500].map(b => selectTier(b, tiers).doer), ['small', 'small', 'medium', 'large']);
});
