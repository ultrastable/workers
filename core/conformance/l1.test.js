// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// The L1 conformance tests of US-SPEC-01 (data model) and US-SPEC-14 (portability seams), run against the seed schema and
// over the SQLite adapter's store handle, with each requirement cited so the manifest can point here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { runTick, STEP_ORDER } from '../src/tick.js';
import { openDb } from '../../adapters/sqlite/d1-sqlite.js';
import { presence } from '../org/index.js';
import { createConsoleL3 } from '../console-l3/index.js';
import { MODULES } from '../org/modules.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SEED = path.join(ROOT, 'core/migrations');
const policy = JSON.parse(readFileSync(path.join(ROOT, 'autonomy/policy.json'), 'utf8'));
const config = { claim_ttl_minutes: 120, max_wip_per_role: 3, plus_share: 0.2, policy };
const T0 = Date.UTC(2026, 10, 15, 12, 0, 0);
const STAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
// US-SPEC-01 section 4.1, as written in the specification.
const L1 = {
  org: ['key', 'value'], roles: ['id', 'role', 'project', 'tick_every', 'model', 'last_tick_at'],
  items: ['id', 'title', 'kind', 'project', 'owner_role', 'trigger_on', 'done_check', 'closing_probe', 'priority', 'status', 'disposition', 'blocker', 'surface', 'action_class', 'created_at', 'updated_at'],
  claims: ['item_id', 'agent', 'claimed_at', 'heartbeat_at'], gate_cards: ['id', 'what', 'why_gated', 'default_in_effect', 'prepared_by_fleet', 'closing_probe', 'status', 'closed_at'],
  predictions: ['id', 'item_id', 'metric', 'op', 'target', 'due_at', 'observed', 'verdict'], outcomes: ['id', 'item_id', 'agent', 'surface', 'action_class', 'result', 'evidence', 'at'],
  trust_ledger: ['surface', 'action_class', 'rung', 'reliability', 'outcomes', 'updated_at'], dispatches: ['id', 'tick_id', 'role_id', 'item_id', 'model', 'status', 'at'],
  tick_runs: ['id', 'started_at', 'finished_at', 'steps_completed', 'steps_total', 'report', 'errors'], doctrine_lineage: ['version', 'source', 'adopted_at'],
};
const seedSql = () => readdirSync(SEED).filter(f => f.endsWith('.sql')).sort().map(f => readFileSync(path.join(SEED, f), 'utf8'));
const fresh = () => openDb(':memory:', SEED);

test('US-01-R01: the seed migration creates the eleven L1 tables with at least the listed columns', () => {
  const db = fresh();
  for (const [table, cols] of Object.entries(L1)) {
    const have = db.raw.prepare(`SELECT name FROM pragma_table_info(?)`).all(table).map(r => r.name);
    for (const c of cols) assert.ok(have.includes(c), `${table}.${c}`);
  }
  assert.ok(db.raw.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='items' AND sql LIKE '%status%priority%'`).get(), 'index on (status, priority)');
});

test('US-01-T01 and US-01-R04: applying the L1 migration a second time changes nothing', () => {
  const db = fresh();
  db.raw.exec(`INSERT INTO org (key, value) VALUES ('name', 'Example'); INSERT INTO items (id,title,owner_role,done_check) VALUES ('A','a','staff','x')`);
  const snap = () => JSON.stringify([db.raw.prepare(`SELECT type, name, sql FROM sqlite_master ORDER BY name`).all(), db.raw.prepare(`SELECT * FROM org`).all(), db.raw.prepare(`SELECT id, status FROM items`).all()]);
  const before = snap();
  for (const sql of seedSql()) db.raw.exec(sql);
  assert.equal(snap(), before);
});

test('US-01-T02 and US-01-R02: a second claim for one item is rejected', () => {
  const db = fresh();
  db.raw.exec(`INSERT INTO items (id,title,owner_role,done_check) VALUES ('A','a','staff','x'); INSERT INTO claims (item_id, agent, claimed_at, heartbeat_at) VALUES ('A','one','t','t')`);
  assert.throws(() => db.raw.exec(`INSERT INTO claims (item_id, agent, claimed_at, heartbeat_at) VALUES ('A','two','t','t')`), /UNIQUE|PRIMARY/i);
  assert.equal(db.raw.prepare(`SELECT agent FROM claims`).get().agent, 'one');
});

test('US-01-T03 and US-01-R03: an item set done with an empty disposition is reopened by the tick and a silent_drop outcome exists', async () => {
  const db = fresh();
  db.raw.exec(`INSERT INTO items (id,title,owner_role,done_check,status,disposition) VALUES ('A','a','staff','x','done',''),('B','b','staff','x','done','shipped, probe passed')`);
  await runTick(db, { config, now: T0 });
  assert.notEqual(db.raw.prepare(`SELECT status FROM items WHERE id='A'`).get().status, 'done');
  assert.equal(db.raw.prepare(`SELECT status FROM items WHERE id='B'`).get().status, 'done');
  assert.equal(db.raw.prepare(`SELECT COUNT(*) AS n FROM outcomes WHERE item_id='A' AND result='silent_drop'`).get().n, 1);
});

test('US-01-R11, US-00-R05 and US-14-R06: every time the tick stores is YYYY-MM-DD HH:MM:SS in UTC and orders correctly as a string', async () => {
  const db = fresh();
  db.raw.exec(`INSERT INTO roles (id, role, tick_every, model) VALUES ('staff-1','staff',1,'m'); INSERT INTO items (id,title,owner_role,done_check) VALUES ('A','a','staff','x')`);
  await runTick(db, { config, now: T0 }); await runTick(db, { config, now: T0 + 9 * 3600e3 }); await runTick(db, { config, now: T0 + 26 * 3600e3 });
  const ticks = db.raw.prepare(`SELECT started_at, finished_at FROM tick_runs ORDER BY id`).all();
  for (const t of ticks) { assert.match(t.started_at, STAMP); assert.match(t.finished_at, STAMP); }
  assert.deepEqual(ticks.map(t => t.started_at), ['2026-11-15 12:00:00', '2026-11-15 21:00:00', '2026-11-16 14:00:00']);
  assert.deepEqual(db.raw.prepare(`SELECT started_at FROM tick_runs ORDER BY started_at`).all().map(t => t.started_at), ticks.map(t => t.started_at));
  assert.equal(db.raw.prepare(`SELECT COUNT(*) AS n FROM tick_runs WHERE started_at < '2026-11-16 00:00:00'`).get().n, 2);
  const claim = db.raw.prepare(`SELECT claimed_at FROM claims`).get(); const item = db.raw.prepare(`SELECT created_at, updated_at FROM items WHERE id='A'`).get();
  for (const v of [claim.claimed_at, item.created_at, item.updated_at, db.raw.prepare(`SELECT last_tick_at FROM roles`).get().last_tick_at]) assert.match(v, STAMP);
});

test('US-14-R01: the portable core imports nothing and names no platform API', () => {
  const src = readFileSync(path.join(ROOT, 'core/src/tick.js'), 'utf8');
  assert.equal([...src.matchAll(/^\s*import\s/gm)].length, 0);
  for (const re of [/\bfetch\(/, /\bprocess\./, /\bcaches\./, /\bnode:/, /\.DB\b/, /cloudflare|wrangler|googleapis/i]) assert.ok(!re.test(src.replace(/\/\/.*$/gm, '')), String(re));
});

test('US-14-R02: the SQLite adapter store handle supports prepare().bind().all()/first()/run() with meta.changes and meta.last_row_id', async () => {
  const db = fresh();
  const ins = await db.prepare(`INSERT INTO tick_runs (started_at, steps_total) VALUES (?, ?)`).bind('2026-11-15 12:00:00', 8).run();
  assert.deepEqual(ins.meta, { changes: 1, last_row_id: 1 });
  assert.equal((await db.prepare(`INSERT INTO tick_runs (started_at, steps_total) VALUES (?, ?)`).bind('2026-11-15 12:10:00', 8).run()).meta.last_row_id, 2);
  assert.equal((await db.prepare(`UPDATE tick_runs SET steps_completed = ?`).bind(8).run()).meta.changes, 2);
  assert.equal((await db.prepare(`SELECT id FROM tick_runs ORDER BY id`).bind().all()).results.length, 2);
  assert.deepEqual(await db.prepare(`SELECT id FROM tick_runs WHERE id = ?`).bind(2).first(), { id: 2 });
  assert.equal(await db.prepare(`SELECT id FROM tick_runs WHERE id = ?`).bind(99).first(), null);
});

test('US-14-T01 and US-14-R07: the L1 tick runs every step over the adapter store handle and dispatches in priority order', async () => {
  const db = fresh();
  db.raw.exec(`INSERT INTO roles (id, role, tick_every, model) VALUES ('staff-1','staff',1,'m');
    INSERT INTO items (id,title,owner_role,done_check,priority,status) VALUES ('A','a','staff','x',10,'open'),('B','b','staff','x',20,'open');
    INSERT INTO gate_cards (id,what,why_gated,default_in_effect,closing_probe) VALUES ('G','Add key','secret','off','env:SOME_KEY');
    INSERT INTO predictions (id,item_id,metric,op,target,due_at) VALUES ('P','A','items_done','>=',0,'2026-11-15 00:00:00')`);
  const r = await runTick(db, { config, env: { SOME_KEY: true }, now: T0 });
  assert.equal(r.completed, STEP_ORDER.length); assert.deepEqual(r.errors, []);
  assert.deepEqual(db.raw.prepare(`SELECT item_id FROM claims`).all().map(x => x.item_id), ['A']);
  assert.equal(db.raw.prepare(`SELECT status FROM gate_cards WHERE id='G'`).get().status, 'closed');
  assert.equal(db.raw.prepare(`SELECT verdict FROM predictions WHERE id='P'`).get().verdict, 'hit');
});

test('US-14-T04, US-14-R04 and US-01-R06: the core is given a presence map; a secret value is in no row the tick wrote', async () => {
  const SECRET = 'planted-value-4f9a2c7e1b';
  const map = presence({ SOME_KEY: SECRET, EMPTY: '', DB: { prepare() {} } });
  assert.equal(map.SOME_KEY, true); assert.ok(!map.EMPTY); assert.ok(!JSON.stringify(map).includes(SECRET));
  const db = fresh();
  db.raw.exec(`INSERT INTO gate_cards (id,what,why_gated,default_in_effect,closing_probe) VALUES ('G','Add key','secret','off','env:SOME_KEY')`);
  const r = await runTick(db, { config, env: map, now: T0 });
  assert.equal(db.raw.prepare(`SELECT status FROM gate_cards WHERE id='G'`).get().status, 'closed');
  const dump = JSON.stringify(Object.keys(L1).map(t => db.raw.prepare(`SELECT * FROM ${t}`).all())) + r.report;
  assert.ok(!dump.includes(SECRET), 'US-01-T04: no table holds the secret value');
});

test('US-14-R05: health reports the latest tick and fails when it did not complete all steps', async () => {
  const db = fresh();
  const l3 = createConsoleL3({ db, now: () => T0, config: { version: '1.0.0' } });
  assert.equal((await l3.health()).ok, false, 'no tick yet');
  await runTick(db, { config, now: T0 });
  assert.equal((await l3.health()).ok, true);
  db.raw.exec(`INSERT INTO tick_runs (started_at, finished_at, steps_completed, steps_total) VALUES ('2026-11-15 12:10:00', '2026-11-15 12:10:01', 5, 8)`);
  assert.equal((await l3.health()).ok, false);
  assert.equal((await l3.state()).last_tick.steps_completed, 5);
});

test('US-SPEC-01 section 4.2 and US-00-R06: the published mapping of renamed tables holds: every L2 record it names exists in the seed once every module migration is applied', () => {
  const map = JSON.parse(readFileSync(path.join(ROOT, 'core/conformance/l2-records.json'), 'utf8'));
  const listed = MODULES.map(m => path.join(ROOT, m.dir));
  const found = readdirSync(path.join(ROOT, 'core')).map(m => path.join(ROOT, 'core', m, 'migrations')).filter(existsSync);
  const raw = new DatabaseSync(':memory:');
  for (const dir of [...new Set([...listed, ...found])].filter(existsSync)) {
    for (const f of readdirSync(dir).filter(n => n.endsWith('.sql')).sort()) { try { raw.exec(readFileSync(path.join(dir, f), 'utf8')); } catch { /* a module mid-change must not hide the others */ } }
  }
  const names = new Set(raw.prepare(`SELECT name FROM sqlite_master WHERE type IN ('table','view')`).all().map(r => r.name));
  assert.ok(Object.keys(map.records).length >= 25);
  for (const [record, tables] of Object.entries(map.records)) for (const t of tables) assert.ok(names.has(t), `${record} -> ${t}`);
  for (const [record, reason] of Object.entries(map.missing)) { assert.ok(reason.length > 20, record); assert.ok(!names.has(record)); }
  const spec = ['management_personas', 'program_charters', 'program_risk_now', 'portfolio_allocations', 'program_focus', 'program_focus_log', 'issue_priority_scores', 'queue_pulls', 'persona_actions', 'persona_briefs', 'decision_log', 'decision_predictions', 'decision_outcomes', 'trust_transitions', 'product_registry', 'plus_ledger', 'work_claims', 'human_actions', 'failure_modes', 'failure_mode_hits', 'false_stop_register', 'false_stop_phrases', 'false_stop_hits', 'doctrine_proposals', 'ops_config', 'metric_registry', 'metric_triggers', 'model_task_matrix', 'model_admission'];
  for (const r of spec) assert.ok(map.records[r] || map.missing[r], `${r} is mapped or listed as missing`);
});
