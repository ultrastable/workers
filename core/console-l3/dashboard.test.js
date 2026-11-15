// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// US-SPEC-13 section 3: the product dashboard routes, one state for page, JSON and digest (R01, R02, T01), probe routing (R13).
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { makeDb } from '../_shared/testdb.js';
import { createConsoleL3 } from './index.js';
import { createDashboard, classifyProbes } from './dashboard.js';
import { createSla } from '../sla/index.js';

const dir = p => fileURLToPath(new URL(p, import.meta.url));
const T0 = Date.UTC(2026, 10, 15, 12, 0, 0);
const mk = ({ graph = true } = {}) => {
  const db = makeDb([dir('./migrations/'), dir('../sla/migrations/'), ...(graph ? [dir('../graph/migrations/')] : [])]);
  const now = () => T0;
  const l3 = createConsoleL3({ db, now, config: { version: '2.0.0' } }); const sla = createSla({ db, now });
  db.raw.exec(`
    INSERT INTO items (id,title,owner_role,done_check,status,created_at) VALUES ('A','a','staff','x','ready','2026-11-01 00:00:00'),('B','b','staff','x','done','2026-11-01 00:00:00'),('C','<script>alert(1)</script>','staff','x','claimed','2026-11-14 00:00:00');
    INSERT INTO gate_cards (id,what,why_gated,default_in_effect,closing_probe) VALUES ('G1','Approve <b>spend</b>','money','stays "zero"','manual');
    INSERT INTO tick_runs (started_at,finished_at,steps_completed,steps_total) VALUES ('2026-11-15 11:50:00','2026-11-15 11:50:01',8,8);
    INSERT INTO dispatches (tick_id, role_id, item_id, model, status) VALUES (1,'r','C','small','queued'),(1,'r','B','small','failed');`);
  return { db, l3, sla, dash: createDashboard({ db, l3, sla, now }) };
};
const get = (dash, path, init) => dash.handle(new Request(`https://status.example${path}`, init));

test('US-13-T01 and R01: /health and /api/state return JSON with version and counts; /health fails when the last check did not finish', async () => {
  const { db, dash } = mk();
  const h = await get(dash, '/health'); assert.equal(h.status, 200);
  assert.deepEqual((await h.json()).counts, { items: 3, open_gate_cards: 1, blocked: 0 });
  const s = await (await get(dash, '/api/state')).json();
  assert.equal(s.version, '2.0.0'); assert.equal(s.items.total, 3); assert.equal(s.gate_cards.open, 1);
  db.raw.exec(`INSERT INTO tick_runs (started_at,steps_completed,steps_total) VALUES ('2026-11-15 11:55:00',3,8)`);
  assert.equal((await get(dash, '/health')).status, 503);
  assert.equal(await get(dash, '/nope'), null);
  assert.equal(await get(dash, '/api/state', { method: 'DELETE' }), null);
});

test('/api/loop reports the last execute time and scanned, executed, failed, needs_human, no_action', async () => {
  const { dash } = mk();
  assert.deepEqual(await (await get(dash, '/api/loop')).json(), { last_execute_at: '2026-11-15 11:50:01', tick_id: 1, finished: true, scanned: 2, executed: 1, failed: 1, needs_human: 1, no_action: 0 });
  const empty = createDashboard({ db: makeDb([dir('./migrations/')]), l3: null });
  assert.equal((await empty.loop()).last_execute_at, null);
});

test('/api/integration reports registered, live, edges, islands, sinks, density and drift; without a graph it says so', async () => {
  const { db, dash } = mk();
  db.raw.exec(`INSERT INTO graph_nodes (id, updated_at) VALUES ('a','t'),('b','t'),('c','t'),('lonely','t');
    INSERT INTO graph_edges (src,dst,source) VALUES ('a','b','scan'),('b','c','scan'),('a','ghost','scan')`);
  assert.deepEqual(await (await get(dash, '/api/integration')).json(), { available: true, registered: 4, live: 3, edges: 3, islands: ['lonely'], sinks: ['c'], density: 0.25, drift: ['ghost'] });
  assert.equal((await mk({ graph: false }).dash.integration()).available, false);
});

test('US-13-R02: the status page, /api/state and the digest are computed from the same state', async () => {
  const { l3, sla, dash } = mk();
  await sla.recompute();
  const s = await dash.state(); const d = await l3.digest();
  for (const k of ['items', 'gate_cards', 'last_tick', 'predictions', 'waiting_on_a_person']) assert.deepEqual(s[k], d.state[k]);
  const html = await (await get(dash, '/')).text();
  assert.match(html, new RegExp(`${s.items.open} open`)); assert.match(html, new RegExp(`${s.items.done} done`));
  assert.match(html, /1 waiting on a person/); assert.match(html, /<td>SEV3<\/td><td>2<\/td><td>1<\/td>/);
  assert.deepEqual(dash.render(s), html.replace(/x^/, ''));
});

test('the page escapes every stored value and loads nothing from another host (US-18-R10)', async () => {
  const { dash } = mk();
  const res = await get(dash, '/'); const html = await res.text();
  assert.ok(!html.includes('<b>spend</b>')); assert.match(html, /Approve &lt;b&gt;spend&lt;\/b&gt;/); assert.match(html, /stays &quot;zero&quot;/);
  assert.ok(!/<script|src=|href=|url\(|@import/i.test(html));
  assert.match(res.headers.get('content-security-policy'), /default-src 'none'/);
});

test('POST /api/refresh recomputes the service levels and returns the fresh state; a prefix mounts the routes elsewhere', async () => {
  const { db, dash } = mk();
  const r = await (await get(dash, '/api/refresh', { method: 'POST' })).json();
  assert.equal(r.refreshed.rows, 2); assert.equal(r.refreshed.raised, 1);
  assert.equal(r.state.service_levels.past_due, 1);
  assert.equal(db.raw.prepare(`SELECT COUNT(*) AS n FROM sla_rows`).get().n, 2);
  assert.equal(await dash.handle(new Request('https://x.example/api/state'), { prefix: '/dashboard' }), null);
  assert.equal((await dash.handle(new Request('https://x.example/dashboard/api/state'), { prefix: '/dashboard' })).status, 200);
  assert.equal((await dash.handle(new Request('https://x.example/dashboard'), { prefix: '/dashboard' })).headers.get('content-type'), 'text/html; charset=utf-8');
});

test('US-13-R13: a probe whose target is not routed is reported unrouted, not down', () => {
  const probes = [{ id: 'api', url: 'https://api.example/health' }, { id: 'old', url: 'https://old.example/health' }, { id: 'sub', url: 'https://api.example/v2/ping' }, { id: 'bad', url: 'not a url' }, { id: 'quiet', url: 'https://api.example/x' }];
  const r = classifyProbes(probes, ['api.example', 'https://other.example/v2'], { api: { ok: true, status: 200 }, old: { ok: false, status: 404 }, sub: { ok: false, status: 500 }, bad: { ok: false } });
  assert.deepEqual(r.map(x => [x.id, x.state]), [['api', 'up'], ['old', 'unrouted'], ['sub', 'down'], ['bad', 'unrouted'], ['quiet', 'unknown']]);
});
