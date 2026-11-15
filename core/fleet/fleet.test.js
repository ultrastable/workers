// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { makeDb } from '../_shared/testdb.js';
import * as claims from '../claims/index.js';
import * as fleet from './index.js';

const mig = fileURLToPath(new URL('./migrations/', import.meta.url));
const claimsMig = fileURLToPath(new URL('../claims/migrations/', import.meta.url));
const T = s => Date.parse(s.replace(' ', 'T') + 'Z');
const HASH = 'a'.repeat(64);
function mk(extra = {}) {
  const clock = { t: T('2026-03-02 12:03:00') };
  const ctx = { db: makeDb([claimsMig, mig]), now: () => clock.t, config: {}, ...extra };
  return { ctx, clock, at: s => { clock.t = T(s); } };
}
const all = async (ctx, sql, ...a) => (await ctx.db.prepare(sql).bind(...a).all()).results;
const one = async (ctx, sql, ...a) => ctx.db.prepare(sql).bind(...a).first();
const inline = ctx => { ctx.executor = m => fleet.execute(ctx, m); return ctx; };

test('US-11-T01: next_fire of */10 * * * * at 12:03 is 12:10', () => {
  assert.equal(fleet.iso(fleet.nextFire('*/10 * * * *', T('2026-03-02 12:03:00'))), '2026-03-02 12:10:00');
});

test('cron matcher: comma lists, */n, ranges, literals, day of week; malformed expressions return null', () => {
  assert.equal(fleet.iso(fleet.nextFire('15,45 9-17 * * 1-5', T('2026-03-06 17:45:00'))), '2026-03-09 09:15:00'); // Friday evening -> Monday
  assert.equal(fleet.iso(fleet.nextFire('0 0 1 */6 *', T('2026-03-02 00:00:00'))), '2026-06-01 00:00:00');
  assert.equal(fleet.iso(fleet.nextFire('30 4 * * 7', T('2026-03-02 00:00:00'))), '2026-03-08 04:30:00');           // 7 is Sunday too
  assert.equal(fleet.iso(fleet.nextFire('10 12 * * *', T('2026-03-02 12:10:00'))), '2026-03-03 12:10:00');          // strictly after
  assert.equal(fleet.nextFire('* * * *', 0), null);
  assert.equal(fleet.nextFire('a * * * *', 0), null);
  assert.equal(fleet.nextFire('0 0 31 2 *', T('2026-03-02 00:00:00')), null);                                        // never matches in 366 days
  assert.equal(fleet.expectedSlots('*/10 * * * *', T('2026-03-02 12:00:00'), T('2026-03-02 13:00:00')).length, 6);
});

test('US-11-R04: a schedule change is a row write; the dispatcher follows the new row without a redeploy', async () => {
  const { ctx, at } = mk(); inline(ctx);
  await fleet.setTask(ctx, { id: 'count-items', type: 'sql', definition: { statement: 'SELECT COUNT(*) AS n FROM items' } });
  await fleet.setCron(ctx, { name: 'count', expr: '0 * * * *', task_id: 'count-items' });
  assert.equal((await fleet.dispatch(ctx)).fired.length, 1);            // next_fire null: due now
  at('2026-03-02 12:05:00');
  assert.equal((await fleet.dispatch(ctx)).fired.length, 0);            // next is 13:00
  await ctx.db.prepare(`UPDATE fleet_crons SET expr = '*/5 * * * *', next_fire = NULL WHERE name = 'count'`).run();
  assert.equal((await fleet.dispatch(ctx)).fired.length, 1);
  assert.equal((await one(ctx, `SELECT next_fire FROM fleet_crons WHERE name = 'count'`)).next_fire, '2026-03-02 12:10:00');
});

test('US-11-R03 / T02: with the executor down the row stays queued, next_fire advances, no re-fire next minute', async () => {
  const { ctx, at } = mk({ executor: async () => { throw new Error('executor unreachable'); } });
  await fleet.setTask(ctx, { id: 't1', type: 'sql', definition: { statement: 'SELECT 1 AS x' } });
  await fleet.setCron(ctx, { name: 'j1', expr: '*/10 * * * *', task_id: 't1' });
  const d = await fleet.dispatch(ctx);
  assert.equal(d.errors.length, 1);
  assert.match(d.errors[0].error, /unreachable/);
  const c = await one(ctx, `SELECT * FROM fleet_crons WHERE name = 'j1'`);
  assert.equal(c.last_fired, '2026-03-02 12:03:00');
  assert.equal(c.next_fire, '2026-03-02 12:10:00');
  assert.deepEqual((await all(ctx, `SELECT status FROM fleet_runs`)).map(r => r.status), ['queued']);
  at('2026-03-02 12:04:00');
  const again = await fleet.dispatch(ctx);
  assert.deepEqual([again.fired.length, again.errors.length, again.skipped.length], [0, 0, 0]);
  assert.equal((await one(ctx, `SELECT COUNT(*) AS n FROM fleet_runs`)).n, 1);
});

test('US-11-R11: a live run of the task blocks a second dispatch; a stale queued row is reaped to failed with an item', async () => {
  const { ctx, at } = mk({ executor: async () => { throw new Error('down'); } });
  await fleet.setTask(ctx, { id: 't1', type: 'sql', definition: { statement: 'SELECT 1 AS x' } });
  await fleet.setCron(ctx, { name: 'j1', expr: '*/10 * * * *', task_id: 't1' });
  await fleet.dispatch(ctx);
  at('2026-03-02 12:10:00');
  const d = await fleet.dispatch(ctx);
  assert.equal(d.skipped[0].reason, 'overlap');
  assert.equal((await one(ctx, `SELECT next_fire FROM fleet_crons`)).next_fire, '2026-03-02 12:20:00'); // still advanced
  assert.deepEqual((await fleet.reapStale(ctx)).reaped, []);            // 7 minutes old, ttl 15
  at('2026-03-02 12:19:00');
  assert.equal((await fleet.reapStale(ctx)).reaped.length, 1);
  const r = await one(ctx, `SELECT status, error_class FROM fleet_runs`);
  assert.deepEqual([r.status, r.error_class], ['failed', 'stale_queued']);
  assert.ok(await one(ctx, `SELECT id FROM items WHERE id = 'FLEET-STALE-t1'`));
  at('2026-03-02 12:20:00');
  assert.equal((await fleet.dispatch(ctx)).errors.length, 1);           // dispatch is possible again
});

test('US-11-R05 / T03: an unknown task type is rejected and still leaves a run record', async () => {
  const { ctx } = mk();
  const r = await fleet.execute(ctx, { task: { type: 'shell', definition: { cmd: 'ls' } }, trigger: 'http' });
  assert.equal(r.ok, false);
  assert.equal(r.error_class, 'unknown_type');
  const row = await one(ctx, `SELECT * FROM fleet_runs WHERE run_id = ?`, r.run_id);
  assert.deepEqual([row.status, row.error_class, row.trigger], ['failed', 'unknown_type', 'http']);
  await fleet.setTask(ctx, { id: 'stored', type: 'python', definition: {} });
  assert.equal((await fleet.execute(ctx, { task_id: 'stored', trigger: 'manual' })).error_class, 'unknown_type');
  assert.equal((await fleet.execute(ctx, { task_id: 'absent', trigger: 'manual' })).error_class, 'no_task');
  assert.equal((await one(ctx, `SELECT COUNT(*) AS n FROM fleet_runs`)).n, 3);
  const res = await fleet.handle(new Request('https://w.example/fleet/execute', { method: 'POST', body: JSON.stringify({ task: { type: 'shell', definition: {} } }) }), { ...ctx, authorize: async () => true });
  assert.equal(res.status, 422);
});

test('US-11-R05: sql, http, ai and workflow tasks run by type and fill the eleven ledger columns', async () => {
  const calls = [];
  const { ctx } = mk({
    fetch: async (url, init) => { calls.push([url, init.method]); return new Response('x'.repeat(900), { status: 200 }); },
    ai: async req => { calls.push(req); return { text: 'summary', cost: 0.002 }; },
    config: { worker: 'fleet-exec', allowed_models: [{ id: 'large', cost: 5 }, { id: 'small', cost: 1 }] },
  });
  await ctx.db.prepare(`INSERT INTO items (id,title,owner_role,done_check) VALUES ('a','A','staff','x'),('b','B','staff','x'),('c','C','staff','x'),('d','D','staff','x')`).run();
  const sql = await fleet.execute(ctx, { task: { type: 'sql', definition: { statement: 'SELECT id FROM items ORDER BY id' } }, trigger: 'manual' });
  assert.equal(sql.result.row_count, 4);
  assert.equal(sql.result.rows.length, 3);                               // first three rows only
  const http = await fleet.execute(ctx, { task: { type: 'http', definition: { url: 'https://svc.example/ping' } }, trigger: 'http' });
  assert.deepEqual([http.result.status, http.result.body.length], [200, 500]);
  const ai = await fleet.execute(ctx, { task: { type: 'ai', definition: { prompt: 'summarize', max_tokens: 9999 } }, trigger: 'manual' });
  assert.deepEqual([ai.result.model, ai.result.max_tokens], ['small', 1024]); // cheapest allowed model, bounded tokens
  assert.equal((await fleet.execute(ctx, { task: { type: 'ai', definition: { prompt: 'x', model: 'huge' } }, trigger: 'manual' })).error_class, 'model_not_allowed');
  const wf = await fleet.execute(ctx, { trigger: 'manual', parent_run: sql.run_id, task: { type: 'workflow', definition: { steps: [
    { type: 'sql', definition: { statement: "UPDATE items SET priority = 1 WHERE id = 'a'" } }, { type: 'ai', definition: { prompt: 'p' } }] } } });
  assert.equal(wf.ok, true);
  assert.equal(wf.result.steps[0].row_count, 1);
  const bad = await fleet.execute(ctx, { trigger: 'manual', task: { type: 'workflow', definition: { steps: [{ type: 'sql', definition: { statement: 'SELECT 1; SELECT 2' } }, { type: 'http', definition: { url: 'https://svc.example/never' } }] } } });
  assert.equal(bad.error_class, 'bad_definition');
  assert.equal(calls.filter(c => Array.isArray(c) && c[0].endsWith('/never')).length, 0); // the workflow stopped at the failing step
  const row = await one(ctx, `SELECT * FROM fleet_runs WHERE run_id = ?`, wf.run_id);
  for (const col of ['run_id', 'worker', 'trigger', 'ts_start', 'ts_end', 'status', 'error_class', 'summary', 'evidence_refs', 'parent_run', 'cost']) assert.ok(col in row, col);
  assert.deepEqual([row.worker, row.trigger, row.status, row.error_class, row.parent_run, row.cost], ['fleet-exec', 'manual', 'ok', null, sql.run_id, 0.002]);
  assert.match(row.evidence_refs, /fleet_events:run-\d+:accepted/);
  assert.equal((await fleet.execute(ctx, { task: { type: 'sql', definition: { statement: 'SELECT 1 AS x' } }, trigger: 'timer' })).rejected_before_start, true);
});

test('US-11-R05: results are truncated to 4000 characters and errors to 1000', async () => {
  const { ctx } = mk({ fetch: async () => { throw new Error('e'.repeat(3000)); } });
  await ctx.db.prepare(`INSERT INTO items (id,title,owner_role,done_check) VALUES ('a',?, 'staff','x'),('b',?, 'staff','x'),('c',?, 'staff','x')`).bind('t'.repeat(3000), 'u'.repeat(3000), 'v'.repeat(3000)).run();
  const ok = await fleet.execute(ctx, { task: { type: 'sql', definition: { statement: 'SELECT title FROM items' } }, trigger: 'manual' });
  assert.equal((await one(ctx, `SELECT result FROM fleet_runs WHERE run_id = ?`, ok.run_id)).result.length, 4000);
  const bad = await fleet.execute(ctx, { task: { type: 'http', definition: { url: 'https://svc.example/x' } }, trigger: 'manual' });
  assert.equal((await one(ctx, `SELECT error FROM fleet_runs WHERE run_id = ?`, bad.run_id)).error.length, 1000);
});

test('US-11-R06: envelopes are validated before writing; rejects are stored with their error', async () => {
  const { ctx } = mk();
  const payload = { n: 1 };
  const env = await fleet.buildEnvelope({ kind: 'probe.result', id: 'e-1', ts: '2026-03-02 12:03:00', emitter: 'prober', session: 's-1', payload });
  assert.deepEqual(await fleet.recordEvent(ctx, env, payload), { accepted: true, id: 'e-1' });
  assert.equal((await fleet.recordEvent(ctx, env, payload)).error, 'duplicate event id');
  assert.match((await fleet.recordEvent(ctx, env, { n: 2 })).error, /does not match the payload/);
  assert.match((await fleet.recordEvent(ctx, { ...env, id: 'e-2', provenance: { ...env.provenance, session: '' } }, payload)).error, /session/);
  assert.match((await fleet.recordEvent(ctx, { ...env, id: 'e-3', schema_version: '9' }, payload)).error, /schema_version/);
  assert.match((await fleet.recordEvent(ctx, null, payload)).error, /envelope missing/);
  const rows = await all(ctx, `SELECT state, error FROM fleet_events ORDER BY id`);
  assert.deepEqual(rows.map(r => r.state), ['accepted', 'rejected', 'rejected', 'rejected', 'rejected', 'rejected']);
  assert.ok(rows.slice(1).every(r => r.error));
  const r = await fleet.execute(ctx, { task: { type: 'sql', definition: { statement: 'SELECT 1 AS x' } }, trigger: 'manual' });
  assert.equal(r.event.accepted, true);                                  // the executor stores its own completion envelope
  assert.equal((await one(ctx, `SELECT kind, emitter FROM fleet_events WHERE run_id = ?`, r.run_id)).kind, 'fleet.run');
});

test('US-11-R07: a batch that scans 25 and books 0 is itself a failure; the gate stays closed until a batch balances', async () => {
  const { ctx } = mk();
  const run = await fleet.execute(ctx, { task: { type: 'sql', definition: { statement: 'SELECT 1 AS x' } }, trigger: 'manual' });
  const ids = Array.from({ length: 25 }, (_, i) => `i${i}`);
  const bad = await fleet.recordBatch(ctx, { executor: 'backlog-exec', run_id: run.run_id, scanned_ids: ids, executed: [], failed: [], needs_human: [], no_action: [] });
  assert.deepEqual([bad.ok, bad.gap, bad.status, bad.unaccounted.length], [false, 25, 'failed', 25]);
  const row = await one(ctx, `SELECT status, error_class FROM fleet_runs WHERE run_id = ?`, run.run_id);
  assert.deepEqual([row.status, row.error_class], ['failed', 'accounting_gap']);
  assert.ok(await one(ctx, `SELECT id FROM items WHERE id = 'FLEET-UNACCOUNTED-backlog-exec'`));
  const gate = await fleet.batchGate(ctx, 'backlog-exec');
  assert.deepEqual([gate.pass, gate.reason, gate.gap], [false, 'accounting_gap', 25]);
  assert.equal((await fleet.batchGate(ctx, 'other-exec')).pass, true);
  const good = await fleet.drain(ctx, { executor: 'backlog-exec', items: ids.map(id => ({ id })), handle: async it => (it.id === 'i3' ? Promise.reject(new Error('x')) : it.id === 'i4' ? 'needs_human' : it.id === 'i5' ? 'no_action' : 'executed') });
  assert.deepEqual([good.ok, good.gap], [true, 0]);
  const b = await one(ctx, `SELECT * FROM fleet_batches WHERE id = ?`, good.batch_id);
  assert.deepEqual([b.scanned, b.executed, b.failed, b.needs_human, b.no_action], [25, 22, 1, 1, 1]);
  assert.equal((await fleet.batchGate(ctx, 'backlog-exec')).pass, true);
  const lost = await fleet.drain(ctx, { executor: 'backlog-exec', items: [{ id: 'x' }, { id: 'y' }], handle: async it => (it.id === 'x' ? 'executed' : undefined) });
  assert.deepEqual([lost.gap, lost.unaccounted], [1, ['y']]);            // a handler that books nothing leaves the item unaccounted
});

async function runAt(ctx, clock, procedure, scheduler, when) {
  clock.t = T(when);
  await ctx.db.prepare(`INSERT INTO fleet_runs (worker, trigger, ts_start, ts_end, status, cron_name, scheduler, queued_at) VALUES ('w','cron',?,?,'ok',?,?,?)`).bind(when, when, procedure, scheduler, when).run();
}

test('US-11-R08 / T04: a slot of a declared procedure with no record opens an alert naming procedure and slot', async () => {
  const { ctx, clock, at } = mk();
  await fleet.declareProcedure(ctx, { name: 'manager-tick', expr: '*/10 * * * *', schedulers: ['platform-cron'] });
  for (const m of ['00', '10', '30', '40', '50']) await runAt(ctx, clock, 'manager-tick', 'platform-cron', `2026-03-02 12:${m}:30`);
  at('2026-03-02 13:00:00');
  const d = await fleet.deadman(ctx);
  assert.equal(d.procedures[0].slots, 6);
  assert.equal(d.alerts.length, 1);
  assert.deepEqual([d.alerts[0].procedure, d.alerts[0].slot, d.alerts[0].kind], ['manager-tick', '2026-03-02 12:20:00', 'stop']);
  const item = await one(ctx, `SELECT title, priority FROM items WHERE id = ?`, d.alerts[0].item_id);
  assert.match(item.title, /manager-tick.*2026-03-02 12:20:00.*platform-cron/);
  assert.equal((await fleet.deadman(ctx)).alerts.length, 0);             // idempotent: one alert per slot
});

test('US-11-R09: one silent scheduler of two is a single-path failure; both silent is a stop (worked example, 5 of 6)', async () => {
  const { ctx, clock, at } = mk();
  await fleet.declareProcedure(ctx, { name: 'manager-tick', expr: '*/10 * * * *', schedulers: ['A', 'B'] });
  const slots = ['00', '10', '20', '30', '40', '50'];
  for (const m of slots) await runAt(ctx, clock, 'manager-tick', 'A', `2026-03-02 12:${m}:05`);
  for (const m of slots.filter(x => x !== '20')) await runAt(ctx, clock, 'manager-tick', 'B', `2026-03-02 12:${m}:20`);
  at('2026-03-02 13:00:00');
  const d = await fleet.deadman(ctx);
  assert.deepEqual(d.alerts.map(a => [a.kind, a.slot, a.missing]), [['single_path', '2026-03-02 12:20:00', ['B']]]);
  assert.equal(d.procedures[0].reliability.A, 1);
  assert.ok(Math.abs(d.procedures[0].reliability.B - 5 / 6) < 1e-9);
  assert.equal(d.procedures[0].stops, 0);
  // the next hour: both silent in slot 4 (13:30)
  for (const m of slots.filter(x => x !== '30')) { await runAt(ctx, clock, 'manager-tick', 'A', `2026-03-02 13:${m}:05`); await runAt(ctx, clock, 'manager-tick', 'B', `2026-03-02 13:${m}:20`); }
  at('2026-03-02 14:00:00');
  const d2 = await fleet.deadman(ctx);
  assert.deepEqual(d2.alerts.map(a => [a.kind, a.slot]), [['stop', '2026-03-02 13:30:00']]);
  const stop = await one(ctx, `SELECT priority FROM fleet_alerts WHERE kind = 'stop'`), single = await one(ctx, `SELECT priority FROM fleet_alerts WHERE kind = 'single_path'`);
  assert.ok(stop.priority < single.priority);                            // 0 is highest: a stop outranks degraded redundancy
});

test('dead-man: seed tick rows count as records for the configured procedure; an unfinished slot is not judged', async () => {
  const { ctx, at } = mk({ config: { tick_procedure: 'tick', tick_scheduler: 'platform-cron' } });
  await fleet.declareProcedure(ctx, { name: 'tick', expr: '*/30 * * * *', schedulers: ['platform-cron'] });
  await ctx.db.prepare(`INSERT INTO tick_runs (started_at, steps_total) VALUES ('2026-03-02 12:00:10', 7)`).run();
  at('2026-03-02 12:45:00');
  assert.equal((await fleet.deadman(ctx)).alerts.length, 0);             // 12:30 slot is still open
  at('2026-03-02 13:00:00');
  assert.deepEqual((await fleet.deadman(ctx)).alerts.map(a => a.slot), ['2026-03-02 12:30:00']);
});

test('US-11-R10 / T05: the tick fired by both schedulers in one slot acts once; the other ends without acting', async () => {
  const { ctx, at } = mk({ claims, config: {} });
  let acted = 0;
  const a = await fleet.fireOnce(ctx, { procedure: 'manager-tick', scheduler: 'platform-cron', expr: '*/10 * * * *' }, async () => { acted++; return 'done'; });
  at('2026-03-02 12:04:00');
  const b = await fleet.fireOnce(ctx, { procedure: 'manager-tick', scheduler: 'dispatcher', expr: '*/10 * * * *' }, async () => { acted++; });
  assert.deepEqual([a.acted, b.acted, acted], [true, false, 1]);
  assert.equal(a.slot, '2026-03-02 12:00:00');
  const runs = await all(ctx, `SELECT scheduler, summary FROM fleet_runs ORDER BY run_id`);
  assert.equal(runs.length, 2);                                          // both firings leave a record
  assert.match(runs[1].summary, /ended without acting/);
  assert.equal((await one(ctx, `SELECT COUNT(*) AS n FROM claims_lock WHERE key = 'procedure:manager-tick'`)).n, 1); // a US-08 work claim was taken
  at('2026-03-02 12:10:00');
  assert.equal((await fleet.fireOnce(ctx, { procedure: 'manager-tick', scheduler: 'dispatcher', expr: '*/10 * * * *' }, async () => { acted++; })).acted, true);
  assert.equal(acted, 2);
});

test('US-11-R10: while a holder still works under the claim, a firing in a later slot does not act', async () => {
  const { ctx, at } = mk({ claims });
  const held = await claims.acquire(ctx, { key: 'procedure:manager-tick', holder: 'platform-cron', intent: 'long tick' });
  assert.equal(held.acquired, true);
  at('2026-03-02 12:10:00');
  const r = await fleet.fireOnce(ctx, { procedure: 'manager-tick', scheduler: 'dispatcher', expr: '*/10 * * * *' }, async () => assert.fail('must not act'));
  assert.deepEqual([r.acted, r.reason], [false, 'held']);
});

test('US-11-R12: collisions per minute are measured from the enabled schedules', async () => {
  const { ctx } = mk();
  await fleet.setCron(ctx, { name: 'a', expr: '*/10 * * * *', task_id: 't' });
  await fleet.setCron(ctx, { name: 'b', expr: '*/15 * * * *', task_id: 't' });
  await fleet.setCron(ctx, { name: 'off', expr: '* * * * *', task_id: 't', enabled: false });
  const c = await fleet.collisions(ctx, { from: T('2026-03-02 12:00:00'), to: T('2026-03-02 13:00:00') });
  assert.deepEqual(c.minutes.map(m => m.minute), ['2026-03-02 12:00:00', '2026-03-02 12:30:00']);
  assert.deepEqual([c.collisions, c.max_per_minute, c.fired_minutes], [2, 2, 8]);
  await fleet.setCron(ctx, { name: 'b', expr: '5-59 * * * *', task_id: 't' });
  await assert.rejects(() => fleet.setCron(ctx, { name: 'bad', expr: 'every minute', task_id: 't' }));
});

const member = (name, over = {}) => ({
  name, purpose: 'p', kind: 'worker', status: 'active', crons: ['*/10 * * * *'], dependencies: [], health_url: '/health', autonomy_level: 'L1', owner: 'operations',
  version: '1.2.0', source_hash: HASH, header: { purpose: 'p', capabilities: ['x'], deploy_method: 'api', canonical_source: `workers/${name}` }, secret_names: ['API_TOKEN'], flags_source: 'kv:flags', ...over,
});
const live = (name, over = {}) => ({ name, version: '1.2.0', source_hash: HASH, health: { status: 'ok', worker: name, version: '1.2.0', enabled: true, bindings_ok: true }, ...over });

test('US-11-R01: the worker contract names each unmet part; secret values are refused', async () => {
  const { ctx } = mk();
  assert.deepEqual(fleet.contractGaps(member('ok'), live('ok')), []);
  const gaps = fleet.contractGaps(member('w', { version: 'v2', header: { purpose: 'p' }, source_hash: null, owner: null, flags_source: null, secret_names: ['sk live value'] }), { health: { status: 'ok' } });
  assert.deepEqual(gaps.map(g => g[0]), ['1', '2', '3', '4', '5', '6', '7']);
  await assert.rejects(() => fleet.register(ctx, member('w', { secret_names: ['not a name: abc123'] })), /names only/);
  const h = await fleet.health(ctx);
  assert.deepEqual(Object.keys(h).sort(), ['bindings_ok', 'enabled', 'status', 'version', 'worker']);
  assert.match(h.version, /^\d+\.\d+\.\d+$/);
});

test('US-11-R02: deployed state is reconciled against the registry; one state per worker and three drift counts', async () => {
  const deployedList = [
    live('alpha'), live('beta', { version: '1.1.0', health: { status: 'ok', worker: 'beta', version: '1.1.0', enabled: true, bindings_ok: true } }),
    live('gamma', { health: { status: 'ok', worker: 'gamma', version: '1.2.0', enabled: true, bindings_ok: false } }),
    live('delta', { health: { status: 'ok', worker: 'delta', version: '1.2.0', enabled: false, bindings_ok: true } }),
    live('zeta', { version: null, health: { status: 'ok', worker: 'zeta', enabled: true, bindings_ok: true } }),
    live('eta', { source_hash: 'b'.repeat(64) }), live('stray', { version: null, health: { status: 'ok' } }),
  ];
  const { ctx, at } = mk({ deployed: { list: async () => deployedList } });
  for (const n of ['alpha', 'beta', 'gamma', 'delta', 'zeta', 'eta', 'ghost']) await fleet.register(ctx, member(n));
  await fleet.register(ctx, member('old', { status: 'retired' }));
  const r = await fleet.reconcile(ctx);
  assert.deepEqual(r.states, { alpha: 'live', beta: 'drifted', gamma: 'degraded', delta: 'paused', zeta: 'drifted', eta: 'drifted', ghost: 'degraded', old: 'retired' });
  assert.deepEqual(r.counts, { live: 1, drifted: 3, degraded: 2, paused: 1, retired: 1 });
  assert.deepEqual([r.ghosts, r.unregistered, r.unversioned], [['ghost'], ['stray'], ['zeta', 'stray']]);
  const row = await one(ctx, `SELECT * FROM fleet_reconciliations`);
  assert.deepEqual([row.ghosts, row.unregistered, row.unversioned], [1, 1, 2]);
  assert.equal((await one(ctx, `SELECT state FROM fleet_registry WHERE name = 'beta'`)).state, 'drifted');
  assert.ok(await one(ctx, `SELECT id FROM items WHERE id = 'FLEET-UNREGISTERED-stray'`));
  assert.ok(await one(ctx, `SELECT id FROM items WHERE id = 'FLEET-DRIFTED-beta'`));
  // on a schedule: step reconciles again only when the interval has passed
  at('2026-03-02 12:30:00'); await fleet.step(ctx);
  assert.equal((await one(ctx, `SELECT COUNT(*) AS n FROM fleet_reconciliations`)).n, 1);
  at('2026-03-02 13:03:00'); await fleet.step(ctx);
  assert.equal((await one(ctx, `SELECT COUNT(*) AS n FROM fleet_reconciliations`)).n, 2);
  assert.equal((await fleet.reconcile({ ...ctx, deployed: undefined })).reason, 'no_deployed_port');
});

test('event-triggered scheduling: an accepted event starts its tasks once; rejected and repeated events start nothing', async () => {
  const { ctx } = mk(); inline(ctx);
  await fleet.setTask(ctx, { id: 'recount', type: 'sql', definition: { statement: 'SELECT COUNT(*) AS n FROM items' } });
  await fleet.setTrigger(ctx, { id: 'on-merge', event_kind: 'repo.merged', task_id: 'recount' });
  await fleet.setTrigger(ctx, { id: 'unused', event_kind: 'deploy.done', task_id: 'recount' });
  const payload = { sha: 'abc' };
  const env = await fleet.buildEnvelope({ kind: 'repo.merged', id: 'merge-1', ts: '2026-03-02 12:03:00', emitter: 'vcs', session: 's-9', payload });
  const first = await fleet.emit(ctx, env, payload);
  assert.deepEqual([first.accepted, first.started.length], [true, 1]);
  const row = await one(ctx, `SELECT trigger, status, scheduler FROM fleet_runs WHERE run_id = ?`, first.started[0].run_id);
  assert.deepEqual([row.trigger, row.status, row.scheduler], ['event', 'ok', 'event:on-merge']);
  const again = await fleet.emit(ctx, env, payload);
  assert.deepEqual([again.accepted, again.error, again.started.length], [false, 'duplicate event id', 0]);
  const forged = await fleet.emit(ctx, { ...env, id: 'merge-2' }, { sha: 'tampered' });
  assert.deepEqual([forged.accepted, forged.started.length], [false, 0]);
  assert.equal((await one(ctx, `SELECT COUNT(*) AS n FROM fleet_runs WHERE trigger = 'event'`)).n, 1);
});

test('step and routes: one tick dispatches, reaps and checks; status and health are served; execute needs authorization', async () => {
  const { ctx } = mk(); inline(ctx);
  await fleet.setTask(ctx, { id: 't', type: 'sql', definition: { statement: 'SELECT 1 AS x' } });
  await fleet.setCron(ctx, { name: 'j', expr: '*/10 * * * *', task_id: 't' });
  const s = await fleet.step(ctx);
  assert.equal(s.dispatch.fired.length, 1);
  assert.deepEqual(await fleet.step({ ...ctx, config: { enabled: false } }), { enabled: false });
  const st = await (await fleet.handle(new Request('https://w.example/fleet/status'), ctx)).json();
  assert.deepEqual([st.runs.ok, st.crons_enabled, st.unbalanced_batches], [1, 1, 0]);
  assert.equal((await (await fleet.handle(new Request('https://w.example/health'), ctx)).json()).status, 'ok');
  const post = body => new Request('https://w.example/fleet/execute', { method: 'POST', body: JSON.stringify(body) });
  assert.equal((await fleet.handle(post({ task_id: 't' }), ctx)).status, 401);
  const ok = await fleet.handle(post({ task_id: 't' }), { ...ctx, authorize: async () => true });
  assert.equal((await ok.json()).status, 'ok');
});
