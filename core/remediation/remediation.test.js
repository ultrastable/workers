// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { makeDb } from '../_shared/testdb.js';
import { registerFailureMode, runDetectors, consumeRemediations, recordLoopRun } from '../kernel/failure.js';
import { recordLoopRun as claimsLoopRun } from '../claims/index.js';
import * as rem from './index.js';

const dir = p => fileURLToPath(new URL(p, import.meta.url));
const MIGS = [dir('../kernel/migrations/'), dir('../claims/migrations/'), dir('../fleet/migrations/'), dir('../observe/migrations/'), dir('./migrations/')];
const T = s => Date.parse(s.replace(' ', 'T') + 'Z');
const HOUR = 3600e3;
// Detector statements read the store's own clock ('now'), so fixtures use timestamps far on either side of any real date.
const LONG_AGO = '2020-01-01 00:00:00', FAR_AHEAD = '2999-01-01 00:00:00';
function mk(extra = {}) {
  const clock = { t: T('2026-03-02 12:00:00') };
  const db = makeDb(MIGS);
  db.raw.exec(`CREATE TABLE probe_log (name TEXT, ts TEXT); CREATE TABLE drain_log (status TEXT, payload TEXT);`);
  return { ctx: { db, now: () => clock.t, config: { host: 'watcher' }, ...extra }, clock };
}
const one = async (ctx, sql, ...a) => ctx.db.prepare(sql).bind(...a).first();
const all = async (ctx, sql, ...a) => (await ctx.db.prepare(sql).bind(...a).all()).results;
const item = (ctx, id, status = 'open', disposition = null) => ctx.db.prepare(`INSERT INTO items (id,title,owner_role,done_check,status,disposition) VALUES (?,?,?,?,?,?)`).bind(id, id, 'staff', 'x', status, disposition).run();

test('US-17-R01 / R03 / R04: the standard detectors register with severity and a full contract, and each run writes one hit row', async () => {
  const { ctx, clock } = mk();
  const ids = await rem.installStandard(ctx, { frozen: [{ table: 'probe_log', interval_min: 15 }], masked: [{ table: 'drain_log' }] });
  assert.deepEqual(ids, ['FM-UNACCOUNTED', 'FM-UNBOUNDED-RETRY', 'FM-FROZEN-probe-log', 'FM-MASKED-drain-log']);
  for (const fm of await all(ctx, `SELECT severity, contract_json FROM kernel_failure_modes`)) {
    const c = JSON.parse(fm.contract_json);
    assert.ok(fm.severity >= 1);
    for (const f of ['owner', 'doer', 'trigger', 'closing_probe', 'max_attempts', 'backoff_h', 'deadline_h']) assert.ok(c[f] !== undefined, f); // retry bound and deadline included
  }
  await ctx.db.prepare(`INSERT INTO probe_log VALUES ('w1', ?)`).bind(FAR_AHEAD).run();
  await ctx.db.prepare(`INSERT INTO drain_log VALUES ('ok', '{"queued":0,"failed":2,"published":19}')`).run(); // a count named failed is not a failure
  assert.deepEqual(await runDetectors(ctx.db, { now: clock.t }), []);
  assert.deepEqual((await all(ctx, `SELECT fm_id, fired FROM kernel_failure_mode_hits ORDER BY fm_id`)).map(h => [h.fm_id, h.fired]),
    [['FM-FROZEN-probe-log', 0], ['FM-MASKED-drain-log', 0], ['FM-UNACCOUNTED', 0], ['FM-UNBOUNDED-RETRY', 0]]);
});

test('US-17-T02 / R02: FM-FROZEN reads the clock in the same statement as the data and fires when writes stop', async () => {
  const { ctx, clock } = mk();
  const sql = rem.frozenSql({ table: 'probe_log', interval_min: 15 });
  assert.match(sql, /julianday\('now'\) - julianday\(MAX\(ts\)\)/);       // one statement holds both the clock and the newest write
  assert.throws(() => rem.frozenSql({ table: 'probe_log; DROP TABLE items', interval_min: 15 }), /identifier/);
  await rem.installStandard(ctx, { frozen: [{ table: 'probe_log', interval_min: 15 }] });
  await ctx.db.prepare(`INSERT INTO probe_log VALUES ('w1', ?)`).bind(LONG_AGO).run();   // the writer stopped long ago: far more than 3 intervals
  const fired = await runDetectors(ctx.db, { now: clock.t });
  assert.deepEqual(fired.map(f => f.fm), ['FM-FROZEN-probe-log']);
  const h = await one(ctx, `SELECT value, expected, fired FROM kernel_failure_mode_hits WHERE fm_id = 'FM-FROZEN-probe-log'`);
  assert.ok(h.value > 2 && h.fired === 1);
  const r = await one(ctx, `SELECT max_attempts, deadline_h, pass_op, pass_value FROM kernel_remediations WHERE fm_id = 'FM-FROZEN-probe-log'`);
  assert.deepEqual(r, { max_attempts: 3, deadline_h: 72, pass_op: '<=', pass_value: 2 });
  await ctx.db.prepare(`INSERT INTO probe_log VALUES ('w1', ?)`).bind(FAR_AHEAD).run();  // writes resume: the closing probe passes
  const c = await consumeRemediations(ctx.db, { now: clock.t });
  assert.deepEqual([c.executed, c.balanced], [1, true]);
});

test('FM-MASKED, FM-UNACCOUNTED and FM-UNBOUNDED-RETRY fire on their audit cases', async () => {
  const { ctx, clock } = mk();
  await rem.installStandard(ctx, { masked: [{ table: 'drain_log' }] });
  await ctx.db.prepare(`INSERT INTO drain_log VALUES ('ok', '{"ok":false}'), ('ok', '{"error":"TypeError: x"}'), ('ok', '{"exception":"boom"}'), ('ok', '{"ok":true,"failed":0}'), ('ok', 'not json'), ('failed', '{"ok":false}')`).run();
  await recordLoopRun(ctx.db, { loop: 'executor', scanned: 25, now: clock.t });
  for (let i = 0; i < 4; i++) await ctx.db.prepare(`INSERT INTO kernel_attempts (target, signature, ok, at) VALUES ('deployer', 'E10021', 0, ?)`).bind(FAR_AHEAD).run();
  for (let i = 0; i < 3; i++) await ctx.db.prepare(`INSERT INTO kernel_attempts (target, signature, ok, at) VALUES ('other', 'E1', 0, ?)`).bind(FAR_AHEAD).run();
  await runDetectors(ctx.db, { now: clock.t });
  const v = Object.fromEntries((await all(ctx, `SELECT fm_id, value, fired FROM kernel_failure_mode_hits`)).map(h => [h.fm_id, [h.value, h.fired]]));
  assert.deepEqual(v, { 'FM-MASKED-drain-log': [3, 1], 'FM-UNACCOUNTED': [25, 1], 'FM-UNBOUNDED-RETRY': [1, 1] }); // 3 attempts is the bound; the 4th is past it
});

test('status view: one row per failure mode with last run, firing, staleness and the open remediation with retry bound and deadline', async () => {
  const { ctx, clock } = mk();
  await rem.installStandard(ctx, { frozen: [{ table: 'probe_log', interval_min: 60 }] });
  await registerFailureMode(ctx.db, { id: 'FM-IDLE', severity: 1, detector_sql: 'SELECT 0 AS value', fire_when: 'value > 0', interval_h: 1,
    contract: { owner: 'ops', doer: 'fixer', closing_probe: 'SELECT 0 AS value', pass: '= 0', max_attempts: 2, backoff_h: [1], deadline_h: 10 } }, clock.t);
  await recordLoopRun(ctx.db, { loop: 'executor', scanned: 25, now: clock.t });
  await runDetectors(ctx.db, { now: clock.t });
  await ctx.db.prepare(`UPDATE kernel_failure_modes SET status = 'probation' WHERE id = 'FM-UNBOUNDED-RETRY'`).run();
  clock.t += 12 * HOUR;
  const v = await rem.statusView(ctx);
  const by = Object.fromEntries(v.modes.map(m => [m.id, m]));
  assert.deepEqual(v.modes.map(m => m.id).slice(0, 1), ['FM-UNACCOUNTED']);              // worst severity first
  assert.deepEqual([by['FM-UNACCOUNTED'].firing, by['FM-UNACCOUNTED'].last_value, by['FM-UNACCOUNTED'].hits, by['FM-UNACCOUNTED'].fires], [true, 25, 1, 1]);
  assert.deepEqual([by['FM-IDLE'].firing, by['FM-IDLE'].stale, by['FM-IDLE'].intervals_since_hit], [false, true, 12]); // armed and silent for 12 intervals
  assert.equal(by['FM-UNBOUNDED-RETRY'].stale, false);                                  // probation is not reported as a stopped detector
  const r = by['FM-UNACCOUNTED'].remediation;
  assert.deepEqual([r.status, r.attempts, r.max_attempts, r.deadline_at, r.past_deadline], ['open', 0, 3, '2026-03-05 12:00:00', false]);
  assert.ok(v.modes.every(m => m.contract_complete));
  assert.deepEqual([v.totals.modes, v.totals.firing, v.totals.probation, v.totals.open_remediations], [4, 1, 1, 1]);
  const res = await rem.handle(new Request('https://w.example/failure-modes/status'), ctx);
  assert.equal((await res.json()).totals.modes, 4);
  assert.equal((await rem.handle(new Request('https://w.example/other'), ctx)).status, 404);
});

test('US-17-R03: a failure found twice without a detector is registered with a detector, a severity and a contract', async () => {
  const { ctx, clock } = mk();
  const a = await rem.reportFailure(ctx, { signature: 'deploy delete: stale mirror shadowed the fix', surface: 'deploy', severity: 4 });
  assert.deepEqual([a.count, a.registered], [1, false]);
  assert.equal((await one(ctx, `SELECT COUNT(*) AS n FROM kernel_failure_modes`)).n, 0);
  clock.t = T(FAR_AHEAD);
  const b = await rem.reportFailure(ctx, { signature: 'deploy delete: stale mirror shadowed the fix', surface: 'deploy', severity: 4 });
  assert.deepEqual([b.count, b.registered], [2, true]);
  const fm = await one(ctx, `SELECT id, severity, surface, contract_json FROM kernel_failure_modes`);
  assert.deepEqual([fm.id, fm.severity, fm.surface], [b.fm_id, 4, 'deploy']);
  assert.deepEqual(JSON.parse(fm.contract_json).backoff_h, [1, 4, 24]);
  const fired = await runDetectors(ctx.db, { now: clock.t });             // the new detector sees the sighting it was registered for
  assert.deepEqual(fired.map(f => f.fm), [b.fm_id]);
  const c = await rem.reportFailure(ctx, { signature: 'deploy delete: stale mirror shadowed the fix' });
  assert.deepEqual([c.count, c.registered, c.fm_id], [3, false, b.fm_id]); // registered once
});

test('US-17-R10: the liveness detector refuses to run inside the writer of the probe table, and fires from outside when writes stop', async () => {
  const { ctx } = mk();
  const probeDb = makeDb([]);                                             // the probe table lives in another worker's store
  probeDb.raw.exec(`CREATE TABLE fleet_probe_log (name TEXT, ts TEXT)`);
  const spec = { table: 'fleet_probe_log', interval_min: 15, writer: 'prober' };
  const same = await rem.externalLiveness({ ...ctx, probeDb, config: { host: 'prober' } }, spec);
  assert.deepEqual([same.ok, same.reason], [false, 'same_host']);
  assert.ok(await one(ctx, `SELECT id FROM items WHERE id = 'LIVENESS-fleet-probe-log-SAME-HOST'`));
  const out = { ...ctx, probeDb };
  const empty = await rem.externalLiveness(out, spec);
  assert.deepEqual([empty.fired, empty.host, empty.writer], [true, 'watcher', 'prober']); // a table never written is not a pass
  await ctx.db.prepare(`DELETE FROM items`).run();
  probeDb.raw.prepare(`INSERT INTO fleet_probe_log VALUES ('w', ?)`).run(FAR_AHEAD);
  const fresh = await rem.externalLiveness(out, spec);
  assert.deepEqual([fresh.fired, fresh.item_id], [false, null]);
  probeDb.raw.exec(`DELETE FROM fleet_probe_log`); probeDb.raw.prepare(`INSERT INTO fleet_probe_log VALUES ('w', ?)`).run(LONG_AGO);
  const stopped = await rem.externalLiveness(out, spec);
  assert.equal(stopped.fired, true);
  assert.match((await one(ctx, `SELECT title FROM items WHERE id = ?`, stopped.item_id)).title, /prober stopped writing fleet_probe_log/);
  const gone = await rem.externalLiveness({ ...ctx, probeDb: makeDb([]) }, spec);
  assert.match(gone.evidence, /unreadable/);                               // the monitor cannot see: that is an alarm, not silence
  // one hit row per run, fired or not, kept in the watcher's own store
  assert.deepEqual((await all(ctx, `SELECT host, fired FROM remediation_hits WHERE detector = 'LIVENESS-fleet-probe-log' ORDER BY id`)).map(h => [h.host, h.fired]),
    [['prober', 0], ['watcher', 1], ['watcher', 0], ['watcher', 1], ['watcher', 1]]);
  assert.equal(probeDb.raw.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'remediation_hits'`).get().n, 0);
});

test('US-17-T04 / R05: silent-drop reconciliation reads every loop ledger; a loop that scanned 25 and booked 0 is an incident', async () => {
  const { ctx, clock } = mk({ config: { host: 'watcher', expected_loops: [{ loop: 'drain', interval_h: 1 }, { loop: 'never-ran', interval_h: 1 }] } });
  await recordLoopRun(ctx.db, { loop: 'remediation', scanned: 4, executed: 3, failed: 1, now: clock.t });
  await claimsLoopRun(ctx, { loop: 'drain', scanned: 21, executed: 0, no_action: 21 });
  await ctx.db.prepare(`INSERT INTO fleet_batches (at, executor, scanned, executed, failed, needs_human, no_action, gap, status) VALUES (?, 'backlog-exec', 25, 0, 0, 0, 0, 25, 'failed')`).bind('2026-03-02 12:00:00').run();
  const r = await rem.reconcileLoops(ctx);
  assert.equal(r.balanced, false);
  assert.deepEqual(r.loops.map(l => [l.loop, l.ledger, l.gap]), [['remediation', 'kernel_loop_runs', 0], ['drain', 'claims_loop_runs', 0], ['backlog-exec', 'fleet_batches', 25]]);
  assert.deepEqual(r.gaps.map(g => g.loop), ['backlog-exec']);
  assert.deepEqual(r.silent.map(s => s.loop), ['never-ran']);
  assert.ok(await one(ctx, `SELECT id FROM items WHERE id = 'SILENTDROP-backlog-exec'`));
  assert.ok(await one(ctx, `SELECT id FROM items WHERE id = 'SILENTLOOP-never-ran'`));
  // the executor balances; three hours later the drain loop has gone quiet
  await ctx.db.prepare(`INSERT INTO fleet_batches (at, executor, scanned, executed, failed, needs_human, no_action, gap, status) VALUES (?, 'backlog-exec', 25, 20, 2, 1, 2, 0, 'ok')`).bind('2026-03-02 12:30:00').run();
  clock.t += 3 * HOUR;
  const later = await rem.reconcileLoops(ctx);
  assert.deepEqual([later.gaps.length, later.silent.map(s => s.loop)], [0, ['drain', 'never-ran']]);
  assert.deepEqual((await all(ctx, `SELECT fired FROM remediation_hits WHERE detector = 'RECONCILE-LOOPS'`)).map(h => h.fired), [1, 1]);
});

test('accounting invariant entered = open + closed + superseded: a vanished item is restored and an undisposed one reopened', async () => {
  const { ctx } = mk();
  await item(ctx, 'a'); await item(ctx, 'b'); await item(ctx, 'c', 'done', 'shipped in change 4'); await item(ctx, 'd', 'superseded', 'replaced by a'); await item(ctx, 'e');
  const first = await rem.reconcileItems(ctx);
  assert.deepEqual([first.balanced, first.entered, first.open, first.closed, first.superseded], [true, 5, 3, 1, 1]);
  await ctx.db.prepare(`DELETE FROM items WHERE id = 'b'`).run();                       // silently deleted
  await ctx.db.prepare(`UPDATE items SET status = 'cancelled' WHERE id = 'e'`).run();   // left the active set, no disposition
  await item(ctx, 'f');
  const second = await rem.reconcileItems(ctx);
  assert.deepEqual([second.balanced, second.entered, second.gap], [false, 6, 2]);
  assert.deepEqual([second.restored, second.reopened], [['b'], ['e']]);
  assert.deepEqual(await one(ctx, `SELECT status, title FROM items WHERE id = 'b'`), { status: 'open', title: 'b' });
  assert.equal((await one(ctx, `SELECT status FROM items WHERE id = 'e'`)).status, 'open');
  assert.equal((await one(ctx, `SELECT COUNT(*) AS n FROM outcomes WHERE result = 'silent_drop' AND action_class = 'item_accounting'`)).n, 2);
  assert.ok(await one(ctx, `SELECT id FROM items WHERE id LIKE 'SILENTDROP-ITEMS-%'`));
  const third = await rem.reconcileItems(ctx);                                          // the incident item itself has entered
  assert.deepEqual([third.balanced, third.entered, third.gap], [true, 7, 0]);
});

test('US-17-R12: roster reconciliation includes the emitter set; an emitter outside registry and live list fires', async () => {
  const { ctx, clock } = mk();
  const sets = { registry: ['api', 'store', 'ghost'], live: ['api', 'store', 'stray'], scanner: ['api', 'store', 'stray', 'ancient'], probes: ['api', 'retired-name'], emitters: ['api', 'shadow-worker'] };
  const r = await rem.rosterReconcile(ctx, sets);
  assert.deepEqual(r.unknown_emitters, ['shadow-worker']);               // invisible to a check that compares registry and live list only
  assert.deepEqual([r.registered_not_live, r.live_not_registered, r.not_scanned, r.scanned_unknown, r.not_probed, r.probed_ghosts],
    [['ghost'], ['stray'], ['ghost'], ['ancient'], ['store'], ['retired-name']]);
  assert.deepEqual([r.fired, r.differences], [true, 7]);
  assert.ok(await one(ctx, `SELECT id FROM items WHERE id = 'ROSTER-EMITTER-shadow-worker'`));
  // without a given emitter set, the names are read from what was observed emitting in the period
  await ctx.db.prepare(`INSERT INTO observe_events (at, source, outcome) VALUES ('2026-03-02 11:00:00', 'api', 'ok'), ('2026-03-02 11:30:00', 'unlisted', 'error'), ('2026-02-01 00:00:00', 'long-gone', 'ok')`).run();
  await ctx.db.prepare(`INSERT INTO fleet_events (event_id, kind, ts, emitter, state) VALUES ('e1', 'k', '2026-03-02 11:59:00', 'side-channel', 'accepted'), ('e2', 'k', '2026-03-02 11:59:00', 'forged', 'rejected')`).run();
  assert.deepEqual(await rem.observedEmitters(ctx, { since: clock.t - 24 * HOUR }), ['api', 'side-channel', 'unlisted']);
  const viaPorts = await rem.rosterReconcile({ ...ctx, rosters: { registry: async () => ['api'], live: async () => ['api'] } });
  assert.deepEqual(viaPorts.unknown_emitters, ['side-channel', 'unlisted']);
  const clean = await rem.rosterReconcile(ctx, { registry: ['api'], live: ['api'], emitters: ['api'] });
  assert.deepEqual([clean.fired, clean.differences], [false, 0]);
  assert.deepEqual((await all(ctx, `SELECT fired FROM remediation_hits WHERE detector = 'FM-ROSTER' ORDER BY id`)).map(h => h.fired), [1, 1, 0]);
});

test('US-17-T03 / R08: a ledger whose writer has no breaker gets one; 26 hourly identical failures become 3 attempts', async () => {
  const { ctx, clock } = mk();
  const ledger = [], port = { name: 'deploy', read: async cur => ledger.filter(r => r.id > Number(cur || 0)) };
  const t0 = clock.t;
  let opened = null;
  for (let h = 0; h < 26; h++) {
    clock.t = t0 + h * HOUR;
    if (!(await rem.retryAllowed(ctx, 'worker-x', 'E10021 downgrade')).allowed) continue; // the dispatcher asks before each retry
    ledger.push({ id: ledger.length + 1, target: 'worker-x', error: 'E10021 downgrade', ok: false, at: new Date(clock.t).toISOString().slice(0, 19).replace('T', ' ') });
    const r = await rem.breakerFromLedger(ctx, port);
    if (r.opened.length) opened = r.opened[0];
  }
  assert.equal(ledger.length, 3);                                        // 23 of the 26 attempts were not made
  assert.equal(opened.half_open_at, '2026-03-03 14:00:00');               // half-open probe 24 hours after the third failure
  assert.ok(await one(ctx, `SELECT id FROM items WHERE id = ?`, opened.root_item_id));
  assert.equal((await rem.breakerFromLedger(ctx, port)).read, 0);         // the cursor: no row is counted twice
  clock.t = T('2026-03-03 14:00:00');
  assert.deepEqual(await rem.retryAllowed(ctx, 'worker-x', 'E10021 downgrade'), { allowed: true, half_open: true });
  assert.equal((await rem.retryAllowed(ctx, 'worker-y', 'E10021 downgrade')).allowed, true); // another target is not suspended
  assert.equal((await rem.statusView(ctx)).totals.open_breakers, 1);
});

test('US-17-R13: a fix asserted in a repository is not closed on repository evidence alone', async () => {
  const { ctx } = mk();
  await item(ctx, 'fix-1');
  const repoOnly = await rem.closeFix(ctx, { item_id: 'fix-1', evidence: [{ kind: 'repository', ref: 'commit abc123' }, { kind: 'repository_check', ref: 'tests green' }] });
  assert.deepEqual([repoOnly.ok, repoOnly.reason], [false, 'repository_evidence_alone']);
  assert.equal((await one(ctx, `SELECT status FROM items WHERE id = 'fix-1'`)).status, 'open');
  assert.equal((await rem.closeFix(ctx, { item_id: 'fix-1', evidence: [] })).reason, 'no_evidence');
  const ok = await rem.closeFix(ctx, { item_id: 'fix-1', evidence: [{ kind: 'repository', ref: 'commit abc123' }, { kind: 'production_probe', ref: 'GET /health returned version 1.2.1' }] });
  assert.equal(ok.ok, true);
  assert.deepEqual(await one(ctx, `SELECT status, disposition FROM items WHERE id = 'fix-1'`), { status: 'done', disposition: 'fixed; evidence: repository commit abc123; production_probe GET /health returned version 1.2.1' });
});

test('US-17-R11: the visibility ratio across issue stores fires above its threshold (303 hidden against 12 visible)', async () => {
  const { ctx } = mk();
  const stores = [{ name: 'visible', visible: true, list: async () => Array.from({ length: 12 }, (_, i) => ({ key: `v${i}`, status: 'open' })) },
    { name: 'unread', visible: false, list: async () => Array.from({ length: 303 }, (_, i) => ({ key: `h${i}`, status: 'open' })) }];
  const v = await rem.visibilityRatio(ctx, { stores });
  assert.deepEqual([v.fired, Math.round(v.ratio * 100) / 100], [true, 26.25]);
});

test('step: one tick reconciles loops and items, runs configured liveness checks and ledger breakers', async () => {
  const { ctx } = mk({ config: { host: 'watcher', liveness: [{ table: 'probe_log', interval_min: 15, writer: 'prober' }] }, ledgers: [{ name: 'deploy', read: async () => [] }] });
  await item(ctx, 'a');
  const s = await rem.step(ctx);
  assert.deepEqual(s, { loops_balanced: true, items_balanced: true, restored: 0, reopened: 0, liveness: [{ table: 'probe_log', fired: true, reason: null }], breakers_opened: 0 });
  assert.deepEqual(await rem.step({ ...ctx, config: { enabled: false } }), { enabled: false });
});
