// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { makeDb } from '../_shared/testdb.js';
import { blastRadius } from './index.js';
import * as wiring from './wiring.js';

const mig = fileURLToPath(new URL('./migrations/', import.meta.url));
const T = s => Date.parse(s.replace(' ', 'T') + 'Z');
const svc = target => ({ type: 'service', name: target.toUpperCase(), target });
const FLEET = {
  api: { version: '1.0.0', routes: ['/api/*'], bindings: [svc('store'), svc('mailer'), { type: 'secret', name: 'API_TOKEN', value: 'must-not-be-stored' }, { type: 'variable', name: 'MODE', value: 'prod' }, { type: 'bogus', name: 'x' }] },
  store: { version: '1.0.0', bindings: [{ type: 'database', name: 'DB', target: 'main' }], source: "await db.prepare('INSERT INTO improvements (id) VALUES (?)').run(); db.prepare('SELECT * FROM orders').all();" },
  cronjob: { version: '2.1.0', crons: ['*/10 * * * *'], bindings: [svc('store'), svc('vanished'), { type: 'queue', name: 'OUT', target: 'jobs' }], tables: { writes: ['orders'] } },
  lonely: { bindings: [], source: "import { x } from './lib.js';\nconst rows = db.prepare('SELECT id FROM improvements_archive JOIN tags ON 1').all();" },
  reader: { version: '0.3.0', bindings: [], queue_consumers: ['jobs'], tables: { reads: ['orders'] } },
  broken: new Error('connection closed'),
};
function mk(extra = {}) {
  const clock = { t: T('2026-03-02 12:00:00') };
  const metadata = { account: 'main-account', list: async () => Object.keys(FLEET), describe: async n => { if (FLEET[n] instanceof Error) throw FLEET[n]; return FLEET[n]; } };
  const registry = { list: async () => [{ name: 'api' }, { name: 'store' }, { name: 'cronjob' }, { name: 'reader' }, { name: 'mailer' }, { name: 'ghosted' }, { name: 'broken' }, { name: 'old', status: 'retired' }] };
  return { ctx: { db: makeDb([mig]), now: () => clock.t, config: {}, metadata, registry, ...extra }, clock };
}

test('US-12-R09 / R10: the sweep reads the metadata port; an errored worker is listed under errors and excluded from counts', async () => {
  const { ctx } = mk();
  const s = await wiring.sweep(ctx);
  assert.deepEqual([s.worker_count, s.account, s.generated], [5, 'main-account', '2026-03-02 12:00:00']);
  assert.deepEqual(s.errors, [{ worker: 'broken', error: 'connection closed' }]);
  assert.ok(!s.workers.some(w => w.name === 'broken'));
  const api = s.workers.find(w => w.name === 'api');
  assert.deepEqual(api.bindings.map(b => b.type), ['service', 'service', 'secret', 'variable']); // unknown binding types are dropped
  const stored = (await ctx.db.prepare(`SELECT workers FROM graph_wiring_sweeps`).first()).workers;
  assert.ok(!stored.includes('must-not-be-stored') && !stored.includes('prod'));               // secrets and variables by name only
  assert.deepEqual(s.workers.find(w => w.name === 'cronjob').crons, ['*/10 * * * *']);
  await assert.rejects(() => wiring.sweep({ ...ctx, metadata: undefined }), /metadata port/);
});

test('US-12-R11: the analyzer labels islands, sinks, sources, unresolved targets and the three drift counts', async () => {
  const { ctx } = mk();
  await wiring.sweep(ctx);
  const a = await wiring.analyze(ctx);
  assert.deepEqual([a.nodes, a.edges], [5, 3]);                          // api->store, api->mailer (registered, not swept), cronjob->store
  assert.deepEqual([a.islands, a.sinks, a.sources], [['lonely', 'reader'], ['store'], ['api', 'cronjob']]);
  assert.deepEqual(a.unresolved, ['vanished']);                          // absent from the graph and from the registry
  assert.deepEqual(a.ghosts, ['ghosted', 'mailer']);                     // registered, not deployed; the errored worker is unknown, not a ghost
  assert.deepEqual(a.unregistered, ['lonely']);
  assert.deepEqual(a.unversioned, ['lonely']);
  assert.equal(a.density, 3 / 20);
  const row = await ctx.db.prepare(`SELECT * FROM graph_wiring_analyses`).first();
  assert.deepEqual([row.islands, row.sinks, row.sources, row.unresolved, row.ghosts, row.unregistered, row.unversioned], [2, 1, 2, 1, 2, 1, 1]);
});

test('US-12-T05: a graph of 80 nodes and 49 edges has density 0.00775', () => {
  const nodes = Array.from({ length: 80 }, (_, i) => `w${i}`);
  const edges = Array.from({ length: 49 }, (_, i) => [`w${i + 1}`, 'w0']);
  const g = wiring.analyzeGraph(nodes, [...edges, ['w1', 'w0'], ['w5', 'w5']]); // a repeated edge and a self-loop do not count
  assert.equal(g.edges, 49);
  assert.equal(g.density, 49 / 6320);
  assert.equal(g.density.toFixed(5), '0.00775');
  assert.deepEqual([g.sinks, g.sources.length, g.islands.length], [['w0'], 49, 30]);
});

test('US-12-R12: orphan-table join finds a producer without a consumer; data-flow edges connect a writer to its readers', async () => {
  const { ctx } = mk();
  await wiring.sweep(ctx);
  const a = await wiring.analyze(ctx);
  const m = Object.fromEntries(a.map.map(r => [r.resource, [r.writers, r.readers]]));
  assert.deepEqual(m['table:orders'], [['cronjob'], ['reader', 'store']]);
  assert.deepEqual(m['queue:jobs'], [['cronjob'], ['reader']]);
  assert.deepEqual(a.orphan_tables, [
    { resource: 'table:improvements', fault: 'producer_without_consumer', writers: ['store'] },
    { resource: 'table:improvements_archive', fault: 'consumer_without_producer', readers: ['lonely'] },
    { resource: 'table:tags', fault: 'consumer_without_producer', readers: ['lonely'] },
  ]);
  assert.ok(await ctx.db.prepare(`SELECT id FROM items WHERE id = 'WIRING-ORPHAN-table-improvements'`).first());
  assert.deepEqual(a.data_flow.map(f => [f.from, f.to, f.via]), [['cronjob', 'reader', 'queue:jobs'], ['cronjob', 'reader', 'table:orders'], ['cronjob', 'store', 'table:orders']]);
  assert.equal(a.data_flow_edges, 2);
  assert.deepEqual(a.islands, ['lonely', 'reader']);                     // by service edges alone `reader` is an island
  assert.deepEqual(a.islands_with_data_flow, ['lonely']);                // the shared table shows it is wired
  assert.equal(a.integration_score, 4 / 5);
  // the same edges feed blast radius: changing cronjob reaches what reads its data
  assert.deepEqual((await blastRadius(ctx, ['worker:cronjob'])).affected, ['worker:api', 'worker:reader', 'worker:store']); // api calls store, which reads cronjob's table
  assert.deepEqual((await blastRadius(ctx, ['worker:store'])).affected, ['worker:api', 'worker:cronjob', 'worker:reader']); // transitively: reader consumes what cronjob writes
});

test('table access is read from SQL in source text; module imports and DELETE FROM are not reads', () => {
  const src = "import { a } from './from_table.js';\nexport * from './x.js';\nINSERT OR IGNORE INTO runs (id) VALUES (1); UPDATE jobs SET s=1; DELETE FROM stale WHERE 1; SELECT * FROM runs r JOIN owners o ON 1; REPLACE INTO cache VALUES (1)";
  assert.deepEqual(wiring.extractTableAccess(src), { writes: ['cache', 'jobs', 'runs', 'stale'], reads: ['owners', 'runs'] });
});

test('US-12-R13: a worker missing from the monitor roster is unmeasured, never a retirement candidate', async () => {
  const activity = { read: async () => ({ api: { runs: 10, failures: 1, requests: { external: 40 } }, store: { runs: 0, failures: 0, requests: {} } }) };
  const { ctx, clock } = mk({ roster: { list: async () => ['api', 'store'] }, activity });
  const c1 = await wiring.census(ctx, { members: ['api', 'store', 'lonely'] });
  assert.deepEqual(c1.members.map(m => [m.name, m.class, m.action]), [['api', 'active', 'keep'], ['lonely', 'unmeasured', 'extend_roster'], ['store', 'idle', 'watch']]);
  assert.deepEqual(c1.counts, { active: 1, idle: 1, failing: 0, unmeasured: 1 });
  clock.t = T('2026-03-05 12:00:00');                                    // three days later, still nothing measured for `lonely`
  const c2 = await wiring.census(ctx, { members: ['api', 'store', 'lonely'] });
  assert.deepEqual(c2.retire_candidates, ['store']);                     // measured dead for more than 2 days
  assert.deepEqual(c2.extend_roster, ['lonely']);                        // absence from the roster is not proof of idleness
  // once the roster includes it, it is measured; it starts its own clock and is only watched
  const c3 = await wiring.census({ ...ctx, roster: { list: async () => ['api', 'store', 'lonely'] }, activity: { read: async () => ({ lonely: { runs: 0, failures: 0 } }) } }, { members: ['lonely'] });
  assert.deepEqual([c3.members[0].class, c3.members[0].action], ['idle', 'watch']);
});

test('US-12-R14: probe and calibration traffic is not external usage; a member that fires and always fails is a candidate', async () => {
  assert.deepEqual(wiring.externalUsage({ external: 3, probe: 500, calibration: 20, api: 2 }), { external: 5, excluded: 520 });
  const activity = { read: async () => ({ probed: { runs: 0, failures: 0, requests: { probe: 900, calibration: 12 } }, failing: { runs: 6, failures: 6, requests: { probe: 3 } }, used: { runs: 0, failures: 0, requests: { probe: 5, external: 1 } } }) };
  const { ctx } = mk({ roster: { list: async () => ['probed', 'failing', 'used'] }, activity });
  const c = await wiring.census(ctx, { members: ['probed', 'failing', 'used'] });
  const by = Object.fromEntries(c.members.map(m => [m.name, m]));
  assert.deepEqual([by.probed.class, by.probed.external_requests, by.probed.excluded_requests], ['idle', 0, 912]); // 912 probe hits are not usage
  assert.deepEqual([by.failing.class, by.failing.action], ['failing', 'retire_candidate']);
  assert.deepEqual([by.used.class, by.used.external_requests], ['active', 1]);
});

test('step: one tick sweeps, analyzes and takes the census; the reading is dated', async () => {
  const { ctx } = mk({ roster: { list: async () => [] } });
  const s = await wiring.step(ctx);
  assert.deepEqual([s.generated, s.worker_count, s.errors, s.islands, s.ghosts, s.orphan_tables], ['2026-03-02 12:00:00', 5, 1, 2, 2, 3]);
  assert.equal(s.census.unmeasured, 8);                                  // five swept plus three registered and not swept (two ghosts, one errored)
  assert.deepEqual(await wiring.step({ ...ctx, metadata: undefined }), { enabled: false });
});
