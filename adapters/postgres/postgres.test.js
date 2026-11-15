// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// US-SPEC-14 section 4: the Postgres dialect shim. No Postgres server runs here: the translation is asserted as text, and the
// store handle is exercised against a client that records what it is sent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { translate, translateMigration, createPgStore } from './index.js';
import * as tick from '../../core/src/tick.js';

const SEED = readFileSync(fileURLToPath(new URL('../../core/migrations/0001_init.sql', import.meta.url)), 'utf8');
const TICK_SRC = readFileSync(fileURLToPath(new URL('../../core/src/tick.js', import.meta.url)), 'utf8');

test('US-14 dialect: ? becomes $n in order, and a question mark inside a string or a comment is left alone', () => {
  assert.equal(translate(`SELECT * FROM items WHERE id = ? AND title <> 'why?' AND status = ?`).text, `SELECT * FROM items WHERE id = $1 AND title <> 'why?' AND status = $2`);
  assert.equal(translate(`SELECT 1 -- really?\n WHERE x = ?`).text, `SELECT 1 -- really?\n WHERE x = $1`);
  assert.equal(translate(`SELECT 'it''s ?' , ?`).params, 1);
});

test('US-14 dialect: INSERT OR IGNORE becomes ON CONFLICT DO NOTHING; an existing ON CONFLICT clause is kept; OR REPLACE is refused', () => {
  assert.equal(translate(`INSERT OR IGNORE INTO org (key, value) VALUES (?, ?)`).text, `INSERT INTO org (key, value) VALUES ($1, $2) ON CONFLICT DO NOTHING`);
  const up = translate(`INSERT INTO trust_ledger (surface, rung) VALUES (?, ?) ON CONFLICT(surface) DO UPDATE SET rung=excluded.rung`).text;
  assert.equal((up.match(/ON CONFLICT/g) || []).length, 1);
  assert.throws(() => translate(`INSERT OR REPLACE INTO org (key, value) VALUES (?, ?)`), /no direct Postgres form/);
});

test('US-14-R06 dialect: datetime(now) becomes UTC text in YYYY-MM-DD HH:MM:SS so string comparison still orders time', () => {
  const t = translate(`UPDATE gate_cards SET closed_at=datetime('now') WHERE id=?`).text;
  assert.equal(t, `UPDATE gate_cards SET closed_at=to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') WHERE id=$1`);
  assert.match(translate(`SELECT datetime('now', '-7 days')`).text, /interval '-7 day'/);
  assert.throws(() => translate(`SELECT datetime('now', 'start of month')`), /not supported/);
});

test('US-14 dialect: AUTOINCREMENT becomes BIGSERIAL and last_row_id comes from RETURNING id, only for tables with a serial id', () => {
  const serialTables = new Set();
  const ddl = translate(`CREATE TABLE IF NOT EXISTS tick_runs (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  started_at TEXT NOT NULL DEFAULT (datetime('now')),\n  score REAL)`, { serialTables }).text;
  assert.match(ddl, /id BIGSERIAL PRIMARY KEY/); assert.match(ddl, /DEFAULT \(to_char\(now\(\) AT TIME ZONE 'UTC'/); assert.match(ddl, /score DOUBLE PRECISION/);
  assert.ok(serialTables.has('tick_runs'));
  assert.deepEqual(translate(`INSERT INTO tick_runs (started_at, steps_total) VALUES (?, ?)`, { serialTables }), { text: `INSERT INTO tick_runs (started_at, steps_total) VALUES ($1, $2) RETURNING id`, returning: true, params: 2 });
  assert.equal(translate(`INSERT INTO claims (item_id, agent) VALUES (?, ?)`, { serialTables }).returning, false);
});

test('US-14 dialect: a bare boolean inside SUM is wrapped in CASE; an existing CASE is untouched', () => {
  assert.equal(translate(`SELECT SUM(verdict='hit') AS hit, SUM(verdict IS NOT NULL) AS scored FROM predictions`).text,
    `SELECT SUM(CASE WHEN verdict='hit' THEN 1 ELSE 0 END) AS hit, SUM(CASE WHEN verdict IS NOT NULL THEN 1 ELSE 0 END) AS scored FROM predictions`);
  const keep = `SELECT SUM(CASE WHEN result='verified' THEN 1 ELSE 0 END) AS ok FROM outcomes`;
  assert.equal(translate(keep).text, keep);
});

test('the whole L1 seed migration translates: eleven tables, no SQLite-only construct left, serial tables recorded', () => {
  const serialTables = new Set();
  const stmts = translateMigration(SEED, { serialTables });
  assert.equal(stmts.filter(s => /^CREATE TABLE/i.test(s)).length, 11);
  for (const s of stmts) { assert.ok(!/AUTOINCREMENT|datetime\(|INSERT OR IGNORE/i.test(s), s); assert.ok(!s.includes(';')); }
  assert.deepEqual([...serialTables].sort(), ['dispatches', 'outcomes', 'tick_runs']);
});

test('every SQL statement the L1 tick sends translates without error and keeps its parameter count', () => {
  const sqls = [...TICK_SRC.matchAll(/`((?:SELECT|INSERT|UPDATE|DELETE)\b[^`]*)`/g)].map(m => m[1]).filter(s => !s.includes('${'));
  assert.ok(sqls.length >= 30, `found ${sqls.length}`);
  for (const s of sqls) {
    const t = translate(s);
    assert.equal(t.params, (s.replace(/'[^']*'/g, '').match(/\?/g) || []).length, s);
    assert.ok(!/\?/.test(t.text.replace(/'[^']*'/g, '')), s);
  }
  assert.equal(typeof tick.runTick, 'function');
});

test('US-14-R02: the store handle offers prepare().bind().all()/first()/run() with meta.changes and meta.last_row_id', async () => {
  const sent = [];
  const client = { async query(text, params) {
    sent.push({ text, params });
    if (/^INSERT INTO tick_runs/.test(text)) return { rows: [{ id: '41' }], rowCount: 1 };
    if (/^SELECT/.test(text)) return { rows: [{ id: 'A', n: 2 }, { id: 'B', n: 1 }], rowCount: 2 };
    if (/^UPDATE/.test(text)) return { rows: [], rowCount: 3 };
    return { rows: [], rowCount: 0 };
  } };
  const db = createPgStore(client);
  await db.migrate(`CREATE TABLE IF NOT EXISTS tick_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, started_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS org (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  assert.equal(sent.length, 2);
  const ins = await db.prepare(`INSERT INTO tick_runs (started_at) VALUES (?)`).bind('2026-11-15 12:00:00').run();
  assert.deepEqual(ins.meta, { changes: 1, last_row_id: 41 });
  assert.deepEqual(sent.at(-1), { text: `INSERT INTO tick_runs (started_at) VALUES ($1) RETURNING id`, params: ['2026-11-15 12:00:00'] });
  assert.deepEqual((await db.prepare(`UPDATE org SET value=? WHERE key=?`).bind(undefined, true).run()).meta, { changes: 3, last_row_id: null });
  assert.deepEqual(sent.at(-1).params, [null, 1]);
  assert.equal((await db.prepare(`SELECT id FROM items`).bind().all()).results.length, 2);
  assert.deepEqual(await db.prepare(`SELECT id FROM items WHERE id=?`).bind('A').first(), { id: 'A', n: 2 });
  const none = createPgStore({ async query() { return { rows: [], rowCount: 0 }; } });
  assert.equal(await none.prepare(`SELECT 1`).bind().first(), null);
  assert.throws(() => createPgStore({}), /query\(text, params\)/);
});
