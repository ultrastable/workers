// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Tests for the pack loader: directory scan and migrations applied on enable (US-SPEC-21, US-21-R08).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeDb } from '../_shared/testdb.js';
import { KERNEL_DIR } from '../kernel/testkit.js';
import { createPacks, MIGRATIONS_DIR, splitStatements, checkMigrationStatement, scanPackDirs } from './index.js';

const PACKS_ROOT = fileURLToPath(new URL('../../packs/', import.meta.url));
const SHIPPED = readdirSync(PACKS_ROOT).filter(d => existsSync(path.join(PACKS_ROOT, d, 'pack.json'))).sort();   // every shipped pack, so adding one needs no edit here
const EXAMPLE_DIR = fileURLToPath(new URL('./example/', import.meta.url));
const T0 = Date.parse('2026-11-11T10:00:00Z');
const tables = (db, like) => db.raw.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE ?`).all(like).map(r => r.name).sort();

function host() {
  const db = makeDb([KERNEL_DIR, MIGRATIONS_DIR]);
  let t = T0;                                                   // each call advances 1 s so repeated enables get distinct decision ids
  return { db, packs: createPacks({ db, now: () => (t += 1000), config: {}, channels: {} }) };
}
// A scratch packs/ root holding a copy of the example pack renamed to `id`, with the given migration files.
function makeRoot(packs) {
  const root = mkdtempSync(path.join(tmpdir(), 'packs-'));
  for (const [id, migs] of Object.entries(packs)) {
    const dir = path.join(root, id);
    cpSync(EXAMPLE_DIR, dir, { recursive: true });
    const m = JSON.parse(readFileSync(path.join(dir, 'pack.json'), 'utf8'));
    m.id = id; m.class = 'A'; delete m.outbound; delete m.defaults;
    m.charter.primary_metric.id = `${id}_a`; m.charter.guard_metrics[0].id = `${id}_b`;
    m.loops = [{ id: 'noop', every_ticks: 1, entry: './noop.js#run', outbound: false }];
    m.migrations = Object.keys(migs).map(f => `./migrations/${f}`);
    mkdirSync(path.join(dir, 'migrations'));
    for (const [f, sql] of Object.entries(migs)) writeFileSync(path.join(dir, 'migrations', f), sql);
    writeFileSync(path.join(dir, 'pack.json'), JSON.stringify(m));
  }
  return root;
}
const enable = (packs, id) => packs.enablePack(id, { by: 'owner', cardText: JSON.parse(readFileSync(path.join(packs._root, id, 'pack.json'), 'utf8')).enable_gate });

test('splitStatements respects strings and comments', () => {
  assert.deepEqual(splitStatements(`-- c; x\nCREATE TABLE a_t (x TEXT DEFAULT 'a;b'); /* ; */ INSERT INTO a_t VALUES ('it''s;');\n`),
    ["CREATE TABLE a_t (x TEXT DEFAULT 'a;b')", "INSERT INTO a_t VALUES ('it''s;')"]);
});

test('checkMigrationStatement allows only the pack own objects', () => {
  const ok = ['CREATE TABLE IF NOT EXISTS x_a (id INTEGER, guard_reason TEXT)', 'CREATE INDEX IF NOT EXISTS idx_x ON x_a(id)', 'ALTER TABLE x_a ADD COLUMN b TEXT', 'INSERT OR IGNORE INTO x_a VALUES (1)'];
  for (const s of ok) assert.deepEqual(checkMigrationStatement(s, 'x'), [], s);
  const bad = ['CREATE TABLE y_a (id)', 'CREATE TABLE guard_ledger2 (id)', 'DROP TABLE x_a', 'DELETE FROM x_a', 'UPDATE guard_ledger SET decision = 1',
    'ALTER TABLE items ADD COLUMN z TEXT', 'CREATE INDEX i ON items(id)', 'CREATE TRIGGER x_t AFTER INSERT ON x_a BEGIN SELECT 1; END',
    'CREATE TABLE x_a (id INTEGER REFERENCES packs_registry(id))', 'INSERT INTO packs_registry (id) VALUES (1)', 'PRAGMA foreign_keys = off', 'CREATE VIEW v_x AS SELECT 1'];
  for (const s of bad) assert.notDeepEqual(checkMigrationStatement(s, 'x'), [], s);
});

test('loadFromDir finds every pack by scanning, including the shipped email and social packs', async () => {
  const { db, packs } = host();
  const r = await packs.loadFromDir(PACKS_ROOT);
  assert.deepEqual(r.failed, []);
  assert.deepEqual(r.registered, SHIPPED);
  assert.deepEqual(db.raw.prepare(`SELECT id, enabled FROM packs_registry ORDER BY id`).all().map(x => ({ ...x })), SHIPPED.map(id => ({ id, enabled: 0 })));
  assert.deepEqual(tables(db, 'email_%'), []);                  // scanning registers, it never migrates or enables
});

test('loadFromDir reports a bad manifest and a broken pack.json and still loads the good ones', async () => {
  const { packs } = host();
  const root = makeRoot({ good: {}, bad: {} });
  writeFileSync(path.join(root, 'bad', 'pack.json'), JSON.stringify({ id: 'bad' }));
  mkdirSync(path.join(root, 'broken')); writeFileSync(path.join(root, 'broken', 'pack.json'), '{ not json');
  mkdirSync(path.join(root, 'notapack'));
  const r = await packs.loadFromDir(root);
  assert.deepEqual(r.registered, ['good']);
  assert.deepEqual(r.failed.map(f => path.basename(f.dir)).sort(), ['bad', 'broken']);
  assert.equal(scanPackDirs(path.join(root, 'nope')).failed.length, 1);
});

test('enabling applies the pack own migrations once; the other packs tables stay absent', async () => {
  const { db, packs } = host();
  const root = makeRoot({ alpha: { '0001.sql': 'CREATE TABLE IF NOT EXISTS alpha_things (id INTEGER PRIMARY KEY, v TEXT);\nCREATE INDEX IF NOT EXISTS alpha_v ON alpha_things (v);' },
    beta: { '0001.sql': 'CREATE TABLE IF NOT EXISTS beta_things (id INTEGER PRIMARY KEY);' } });
  packs._root = root;
  await packs.loadFromDir(root);
  assert.deepEqual(tables(db, '%_things'), []);                 // registered, not migrated
  const r = await enable(packs, 'alpha');
  assert.equal(r.ok, true); assert.deepEqual(r.migrations, ['migrations/0001.sql']);
  assert.deepEqual(tables(db, '%_things'), ['alpha_things']);   // beta is untouched
  db.raw.prepare(`INSERT INTO alpha_things (v) VALUES ('kept')`).run();
  await packs.disablePack('alpha');
  const again = await enable(packs, 'alpha');
  assert.equal(again.ok, true); assert.deepEqual(again.migrations, []);   // not re-applied
  assert.equal(db.raw.prepare(`SELECT COUNT(*) n FROM alpha_things`).get().n, 1);
  const led = db.raw.prepare(`SELECT pack_id, file, statements FROM packs_migrations`).all().map(x => ({ ...x }));
  assert.deepEqual(led, [{ pack_id: 'alpha', file: 'migrations/0001.sql', statements: 2 }]);
});

test('a migration that touches anything outside the pack, or fails, leaves the pack disabled and the database unchanged', async () => {
  const { db, packs } = host();
  const root = makeRoot({
    sneaky: { '0001.sql': 'CREATE TABLE IF NOT EXISTS sneaky_ok (id INTEGER);\nDELETE FROM guard_ledger;' },
    clumsy: { '0001.sql': 'CREATE TABLE IF NOT EXISTS clumsy_ok (id INTEGER);\nCREATE TABLE clumsy_bad (id INTEGER REFERENCES;' },
    escape: {},
  });
  const m = JSON.parse(readFileSync(path.join(root, 'escape', 'pack.json'), 'utf8')); m.migrations = ['../sneaky/migrations/0001.sql'];
  writeFileSync(path.join(root, 'escape', 'pack.json'), JSON.stringify(m));
  packs._root = root;
  await packs.loadFromDir(root);
  const s = await enable(packs, 'sneaky');
  assert.equal(s.reason, 'migration_refused'); assert.match(s.errors.join(' '), /host tables/);
  assert.deepEqual(tables(db, 'sneaky_%'), []);                 // refused before any statement ran
  const c = await enable(packs, 'clumsy');
  assert.equal(c.reason, 'migration_failed');
  assert.equal(db.raw.prepare(`SELECT enabled FROM packs_registry WHERE id='clumsy'`).get().enabled, 0);
  assert.equal(db.raw.prepare(`SELECT COUNT(*) n FROM packs_migrations WHERE pack_id='clumsy'`).get().n, 0);
  const e = await enable(packs, 'escape');
  assert.equal(e.reason, 'migration_refused'); assert.match(e.errors.join(' '), /inside the pack directory/);
});

test('editing an applied migration is refused; a pack with migrations but no directory cannot be enabled', async () => {
  const { db, packs } = host();
  const root = makeRoot({ gamma: { '0001.sql': 'CREATE TABLE IF NOT EXISTS gamma_t (id INTEGER);' } });
  packs._root = root;
  await packs.loadFromDir(root);
  assert.equal((await enable(packs, 'gamma')).ok, true);
  await packs.disablePack('gamma');
  writeFileSync(path.join(root, 'gamma', 'migrations', '0001.sql'), 'CREATE TABLE IF NOT EXISTS gamma_t (id INTEGER, extra TEXT);');
  assert.equal((await enable(packs, 'gamma')).reason, 'migration_changed');
  const m = JSON.parse(readFileSync(path.join(root, 'gamma', 'pack.json'), 'utf8')); m.id = 'delta'; m.charter.primary_metric.id = 'delta_a'; m.charter.guard_metrics[0].id = 'delta_b';
  assert.equal((await packs.register(m)).ok, true);             // no dir given
  assert.equal((await packs.enablePack('delta', { by: 'owner', cardText: m.enable_gate })).reason, 'source_dir_required_for_migrations');
  assert.equal(db.raw.prepare(`SELECT enabled FROM packs_registry WHERE id='delta'`).get().enabled, 0);
});

test('every shipped pack enables through the loader and creates its tables', async () => {
  const { db, packs } = host();
  await packs.loadFromDir(PACKS_ROOT);
  for (const id of SHIPPED) {
    const m = JSON.parse(readFileSync(path.join(PACKS_ROOT, id, 'pack.json'), 'utf8'));
    const r = await packs.enablePack(id, { by: 'owner', cardText: m.enable_gate });
    assert.equal(r.ok, true, JSON.stringify(r));
  }
  assert.ok(tables(db, 'email_%').includes('email_subscribers'));
  assert.ok(tables(db, 'social_%').includes('social_queue'));
  for (const [id, t] of [['video', 'video_queue'], ['analytics', 'analytics_events'], ['drafts', 'drafts_items'], ['cloud', 'cloud_requests']]) if (SHIPPED.includes(id)) assert.ok(tables(db, `${id}_%`).includes(t), t);
});
