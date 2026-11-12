// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Issue #13 (docs/SELF-HOSTING.md): the self-hosting doer driver (backlog seeding, outer spend caps around the runner) and the
// public metrics view served from the Worker. All opt-in, all offline: fake router, fake VCS, in-memory database, no spend.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeDb } from '../_shared/testdb.js';
import { OUT_DIR } from '../../tools/build_migrations.mjs';
import { createOrg } from '../org/index.js';
import { seedBacklog, capGuard } from '../runner/selfdoer.js';
import { computeMetrics, renderHtml } from '../org/public-metrics.js';
import { fakeVcs, fakeRouter, goodPatch, approve, T0 } from '../runner/testkit.js';

const policy = JSON.parse(readFileSync(new URL('../../autonomy/policy.json', import.meta.url), 'utf8'));
const routerConfig = JSON.parse(readFileSync(new URL('../router/example-config.json', import.meta.url), 'utf8'));
const ENV = { VCS_TOKEN: 'tok-AAAA1111zz', PROVIDER_A_API_KEY: 'key-BBBB2222yy', PROVIDER_B_API_KEY: 'key-CCCC3333xx', CONSOLE_TOKEN: 'c-DDDD4444ww' };
const one = (db, sql, ...a) => db.raw.prepare(sql).get(...a);
const BACKLOG = [
  { id: 'US-SPEC-90-1', title: 'Build: widget (US-SPEC-90)', kind: 'work', project: 'spec-to-code', owner_role: 'staff', priority: 30, done_check: 'status row reads BUILT', closing_probe: 'manual' },
  { id: 'US-SPEC-90-2', title: 'Build: gadget (US-SPEC-90)', kind: 'work', project: 'spec-to-code', owner_role: 'staff', priority: 31, done_check: 'status row reads BUILT', closing_probe: 'manual' },
];
const TARGETS = { 'US-SPEC-90-1': { target: 'core/example/widget.js', test: 'core/example/widget.test.js' } };
const files = { 'backlog.json': JSON.stringify(BACKLOG), 'targets.json': JSON.stringify(TARGETS) };

test('seedBacklog: ready only with a named target, idempotent, runner lines in the done check', async () => {
  const db = makeDb([OUT_DIR]);
  assert.deepEqual(await seedBacklog(db, BACKLOG, TARGETS), { seeded: 2, ready: 1, open: 1, existing: 0, promoted: 0 });
  assert.deepEqual(await seedBacklog(db, BACKLOG, TARGETS), { seeded: 0, ready: 0, open: 0, existing: 2, promoted: 0 });
  const a = one(db, `SELECT status, done_check FROM items WHERE id='US-SPEC-90-1'`);
  assert.equal(a.status, 'ready');
  assert.match(a.done_check, /target: core\/example\/widget\.js; test: core\/example\/widget\.test\.js/);
  assert.equal(one(db, `SELECT status FROM items WHERE id='US-SPEC-90-2'`).status, 'blocked');
  const later = await seedBacklog(db, BACKLOG, { ...TARGETS, 'US-SPEC-90-2': { target: 'core/example/gadget.js' } });
  assert.equal(later.promoted, 1, 'a target added later releases the item');
  assert.equal(one(db, `SELECT status FROM items WHERE id='US-SPEC-90-2'`).status, 'ready');
  assert.equal((await seedBacklog(db, [{ nope: 1 }, null], {})).seeded, 0);
});

test('capGuard: daily and monthly caps stop the runner; unset caps refuse; a new day resets the daily cap', async () => {
  const db = makeDb([OUT_DIR]);
  const clock = { t: Date.parse('2026-11-12T12:00:00Z') };
  const add = (at, usd) => db.raw.prepare(`INSERT INTO router_calls (at, kind, cost_usd, outcome) VALUES (?,?,?,'ok')`).run(at, 'doer', usd);
  const g = caps => capGuard({ db, now: () => clock.t, caps });
  assert.equal((await g({})).reason, 'caps_not_configured');
  assert.equal((await g({ daily_usd: 1 })).reason, 'caps_not_configured');
  assert.equal((await g({ daily_usd: 1, monthly_usd: 5 })).reason, 'under_caps');
  add('2026-11-12 08:00:00', 0.6); add('2026-11-12 09:00:00', 0.5);
  const day = await g({ daily_usd: 1, monthly_usd: 5 });
  assert.deepEqual([day.ok, day.reason], [false, 'daily_cap_reached']);
  clock.t = Date.parse('2026-11-13T00:30:00Z');
  assert.equal((await g({ daily_usd: 1, monthly_usd: 5 })).ok, true, 'new UTC day');
  add('2026-11-05 08:00:00', 4);
  assert.equal((await g({ daily_usd: 1, monthly_usd: 5 })).reason, 'monthly_cap_reached');
  clock.t = Date.parse('2026-12-01T00:30:00Z');
  assert.equal((await g({ daily_usd: 1, monthly_usd: 5 })).ok, true, 'new month');
  assert.equal((await g({ daily_usd: 0, monthly_usd: 5 })).reason, 'daily_cap_reached', 'a zero cap allows no paid call');
});

function boot(caps) {
  const db = makeDb([OUT_DIR]);
  const clock = { t: T0 };
  const vcs = fakeVcs({ files: { 'core/example/widget.js': '// widget v1\n', 'core/example/widget.test.js': '// test\n' } });
  const base = fakeRouter({ doer: [goodPatch()], reviewer: [approve] }, { db });
  // The real router records each call in router_calls; mirror that so the outer guard sees the spend.
  const router = { ...base, call: async req => { const r = await base.call(req); db.raw.prepare(`INSERT INTO router_calls (at, kind, cost_usd, outcome) VALUES (?,?,?,'ok')`).run(new Date(clock.t).toISOString().replace('T', ' ').slice(0, 19), req.kind, r.cost_usd || 0); return r; } };
  const config = {
    org_slug: 'self-org', claim_ttl_minutes: 120, max_wip_per_role: 3, plus_share: 0.2, policy: { trust: policy.trust, ladder: policy.ladder, surfaces: policy.surfaces },
    runner: { enabled: true }, router: routerConfig, vcs: { repo: 'owner/name', base: 'main' },
    selfdoer: { enabled: true, backlog_path: 'backlog.json', targets_path: 'targets.json', caps },
  };
  const org = createOrg({ db, env: ENV, config, now: () => clock.t, vcs, router, readFile: async p => files[p], fetch: async () => new Response('') });
  return { db, org, vcs, clock, tick: async () => { clock.t += 60e3; return org.tick(); } };
}

test('self-doer end to end: backlog seeded, a ready item becomes a draft PR, spend stays under the caps, open items wait', async () => {
  const { db, org, vcs, tick } = boot({ daily_usd: 1.5, monthly_usd: 30 });
  assert.ok(org.extraSteps().map(s => s.name).includes('selfdoer_seed'));
  for (let i = 0; i < 14 && !vcs.prs.length; i++) await tick();
  assert.equal(vcs.prs.length, 1, JSON.stringify(db.raw.prepare('SELECT item_id,state,reason FROM runner_runs').all()));
  assert.equal(one(db, `SELECT state FROM runner_runs WHERE item_id='US-SPEC-90-1'`).state, 'pr_opened');
  assert.equal(one(db, `SELECT COUNT(*) n FROM runner_runs WHERE item_id='US-SPEC-90-2'`).n, 0, 'an item with no target is never started');
  assert.ok(one(db, 'SELECT SUM(cost_usd) usd FROM router_calls').usd <= 1.5);
});

test('self-doer over its cap: the runner step is skipped and the tick says why; no model call is made', async () => {
  const { db, vcs, tick } = boot({ daily_usd: 0, monthly_usd: 30 });
  const rep = await tick(); const rep2 = await tick();
  assert.equal(vcs.prs.length, 0);
  assert.equal(one(db, 'SELECT COUNT(*) n FROM runner_runs').n, 0);
  assert.equal(one(db, 'SELECT COUNT(*) n FROM router_calls').n, 0);
  assert.match(JSON.stringify([rep, rep2]), /skipped: daily_cap_reached/);
  const none = boot(undefined);
  assert.match(JSON.stringify(await none.tick()), /skipped: caps_not_configured/, 'no caps configured means no paid work');
});

test('self-doer is opt-in: without config.selfdoer the step list and the runner are unchanged', () => {
  const db = makeDb([OUT_DIR]);
  const org = createOrg({ db, env: ENV, config: { org_slug: 'x' }, now: () => T0 });
  assert.ok(!org.extraSteps().map(s => s.name).includes('selfdoer_seed'));
});

test('public metrics: five measures, null with a reason when unmeasured, aggregates only, GET only, opt-in', async () => {
  const { db, org, vcs, tick, clock } = boot({ daily_usd: 1.5, monthly_usd: 30 });
  for (let i = 0; i < 14 && !vcs.prs.length; i++) await tick();
  const empty = await computeMetrics({ db: makeDb([OUT_DIR]), now: T0, config: {} });
  assert.deepEqual(Object.keys(empty).sort(), ['agent_prs', 'autonomy', 'generated_at', 'money', 'not_measured', 'predictions', 'remaining_capabilities']);
  assert.equal(empty.remaining_capabilities, null);
  assert.match(empty.not_measured.remaining_capabilities, /not measured/);
  db.raw.prepare(`INSERT INTO org (key, value) VALUES ('spec_remaining', ?), ('agent_prs_merged', '1')`).run(JSON.stringify({ remaining: 49, BUILT: 27 }));
  const m = await computeMetrics({ db, now: clock.t, config: {}, routerCaps: [{ scope: 'total', period: 'month', soft_usd: 40, hard_usd: 50 }] });
  assert.equal(m.remaining_capabilities.remaining, 49);
  assert.equal(m.agent_prs.opened, 1); assert.equal(m.agent_prs.merged, 1);
  assert.equal(m.money.cap_usd, 50); assert.equal(m.money.within_cap, true);
  assert.equal(m.money.cost_per_merged_pr_usd, m.money.spend_usd);

  // off by default: the org does not answer these paths
  assert.equal(await org.handle(new Request('https://x.example/public/metrics.json')), null);
  const on = createOrg({ db, env: {}, config: { org_slug: 'x', public_metrics: { enabled: true }, router: { caps: [{ scope: 'total', period: 'month', hard_usd: 50 }] } }, now: () => clock.t });
  const j = await on.handle(new Request('https://x.example/public/metrics.json'));
  assert.equal(j.status, 200);
  const body = await j.json();
  assert.equal(body.agent_prs.opened, 1);
  assert.doesNotMatch(JSON.stringify(body), /widget|gadget|Build:|tok-|key-/, 'aggregates only: no titles, no secrets');
  const h = await on.handle(new Request('https://x.example/public/metrics'));
  const html = await h.text();
  assert.match(h.headers.get('content-security-policy'), /default-src 'none'/);
  assert.doesNotMatch(html, /<script/i);
  assert.match(html, /Remaining capabilities<\/th><td>49/);
  assert.equal((await on.handle(new Request('https://x.example/public/metrics', { method: 'POST' }))).status, 405);
  assert.equal(await on.handle(new Request('https://x.example/public/other')), null);
});

test('renderHtml escapes everything it prints', () => {
  const html = renderHtml({ generated_at: '<b>x</b>', remaining_capabilities: null, agent_prs: { opened: 0, merged: null, rejected: 0, open: 0 }, predictions: null,
    money: { spend_usd: 0, cap_usd: null, cost_per_merged_pr_usd: null }, autonomy: null, not_measured: { remaining_capabilities: '<script>alert(1)</script>', predictions: 'p', autonomy: 'a' } });
  assert.doesNotMatch(html, /<script>alert|<b>x/);
  assert.match(html, /&lt;script&gt;/);
});
