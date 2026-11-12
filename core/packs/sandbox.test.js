// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Tests for the pack sandbox (US-21-R06, R08): no raw db, no unbound guard, no escaping imports.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeDb } from '../_shared/testdb.js';
import { KERNEL_DIR } from '../kernel/testkit.js';
import { createPacks, loadManifest, MIGRATIONS_DIR, checkSql, sandboxDb, scanPackSource } from './index.js';

const EXAMPLE_DIR = fileURLToPath(new URL('./example/', import.meta.url));
const T0 = Date.parse('2026-11-11T10:00:00Z');

test('checkSql allows own-table writes and shared reads, refuses everything else', () => {
  const ok = [
    `SELECT * FROM guard_ledger WHERE pack = 'x'`, `INSERT INTO x_things (a) VALUES (?)`, `UPDATE x_things SET a = 1`,
    `DELETE FROM x_things WHERE a = ?`, `INSERT OR IGNORE INTO predictions (id) VALUES (?)`, `INSERT INTO items (id) VALUES (?)`,
    `SELECT 1 FROM sqlite_master WHERE name = 'guard_suppression; DROP TABLE x'`,
  ];
  for (const s of ok) assert.equal(checkSql(s, 'x'), null, s);
  const bad = {
    'INSERT INTO guard_suppression (recipient_hash) VALUES (1)': 'write_outside_pack:guard_suppression',
    'DELETE FROM guard_ledger': 'write_outside_pack:guard_ledger',
    "UPDATE trust_ledger SET rung = 'autonomous'": 'write_outside_pack:trust_ledger',
    'UPDATE y_things SET a = 1': 'write_outside_pack:y_things',
    'WITH t AS (SELECT 1) DELETE FROM packs_runs': 'write_outside_pack:packs_runs',
    'SELECT manifest_json FROM packs_registry': 'forbidden_table',
    'SELECT token_hash FROM guard_consent': 'forbidden_table',
    'SELECT 1; DELETE FROM guard_ledger': 'multiple_statements',
    'DROP TABLE x_things': 'ddl_or_pragma', 'PRAGMA writable_schema = 1': 'ddl_or_pragma', "ATTACH DATABASE 'a' AS b": 'ddl_or_pragma',
    'DELETE FROM "guard_ledger"': 'quoted_identifier', 'DELETE FROM [guard_ledger]': 'quoted_identifier',
    'DELETE /* x */ FROM guard_ledger': 'write_outside_pack:guard_ledger',
  };
  for (const [s, why] of Object.entries(bad)) assert.equal(checkSql(s, 'x'), why, s);
});

function host() {
  const db = makeDb([KERNEL_DIR, MIGRATIONS_DIR]);
  const sent = [];
  const packs = createPacks({ db, now: () => T0, config: { step_timeout_ms: 500, packs: { example: { recipients: ['a@example.com'] } } },
    channels: { fake: { send: async m => { sent.push(m); return { id: 'p1' }; } } } });
  return { db, packs, sent };
}
async function enableWith(packs, dir) {
  const m = loadManifest(EXAMPLE_DIR);
  const r = await packs.register(m, { dir });
  if (!r.ok) return r;
  return packs.enablePack('example', { by: 'owner', cardText: m.enable_gate });
}
function evilPack(body) {
  const dir = mkdtempSync(path.join(tmpdir(), 'evil-'));
  writeFileSync(path.join(dir, 'noop.js'), body);
  return dir;
}
async function runLoop(db, packs) {
  const [step] = await packs.packSteps();
  const ctx = { tickId: 1, notes: [], errors: [], env: { SECRET_TOKEN: 'super-secret-value' }, config: { x: 1 }, now: T0, nowIso: '2026-11-11 10:00:00' };
  await step.run(db, ctx);
  return ctx;
}

test('a loop gets the sandboxed db: it cannot rewrite the guard ledger, suppression list or its own registry row', async () => {
  const { db, packs } = host();
  const dir = evilPack(`export async function run({ db }) {
    const tries = [
      "DELETE FROM guard_ledger", "UPDATE packs_registry SET enabled = 1", "INSERT INTO guard_suppression (recipient_hash, channel, reason, at) VALUES ('h','*','x','t')",
      "UPDATE trust_ledger SET rung = 'self-extending'", "DROP TABLE guard_ledger" ];
    const out = [];
    for (const t of tries) { try { db.prepare(t); out.push('allowed'); } catch (e) { out.push(e.message); } }
    if (db.raw || db.exec || db.batch) out.push('raw surface exposed');
    throw new Error(out.join(' | '));
  }`);
  assert.equal((await enableWith(packs, dir)).ok, true);
  const ctx = await runLoop(db, packs);
  const msg = ctx.errors[0];
  assert.equal((msg.match(/pack sandbox refused statement/g) || []).length, 5, msg);
  assert.ok(!/allowed|raw surface/.test(msg), msg);
});

test('a loop cannot see env or config through ctx, cannot mutate the bound guard, and cannot send as another pack', async () => {
  const { db, packs, sent } = host();
  const dir = evilPack(`export async function run({ ctx, guard }) {
    const seen = [ctx.env, ctx.config, ctx.db].some(x => x !== undefined);
    if (seen) throw new Error('ctx leaked');
    if (!Object.isFrozen(guard) || !Object.isFrozen(guard.consent)) throw new Error('guard mutable');
    const r = await guard.send({ pack: 'someone_else', channel: 'fake', kind: 'notice', recipient: 'a@example.com', content: 'hi there', idempotencyKey: 'k' });
    ctx.notes.push('pack-field:' + r.reason);
  }`);
  assert.equal((await enableWith(packs, dir)).ok, true);
  const ctx = await runLoop(db, packs);
  assert.deepEqual(ctx.errors, []);
  assert.deepEqual(ctx.notes, ['pack-field:no_consent']);       // evaluated as pack 'example', not 'someone_else'
  assert.equal(sent.length, 0);
  assert.deepEqual(db.raw.prepare(`SELECT pack FROM guard_ledger`).all().map(r => r.pack), ['example']);
});

test('the bound guard keeps its own methods working when detached (unsubscribe suppresses)', async () => {
  const { db, packs } = host();
  const { unsubscribe } = packs.boundGuard('example');
  assert.equal((await unsubscribe({ recipient: 'gone@example.com' })).ok, true);
  assert.equal(db.raw.prepare(`SELECT reason FROM guard_suppression`).get().reason, 'unsubscribe');
});

test('registration scans pack source: escaping imports, fs access and eval are refused and nothing is stored', async () => {
  const cases = {
    "import { createGuard } from '../../../core/packs/guard.js';": /outside the pack/,
    "import { sha256, createGuard } from '../../../core/packs/guard.js';": /outside the pack/,
    "import fs from 'node:fs';": /imports node:fs/,
    "export const x = eval('1');": /eval/,
    "export const y = process.env.TOKEN;": /process/,
    "const n = './a'; export const z = await import(n + '.js');": /dynamic import/,
    "import('../../../core/kernel/programs.js');": /outside the pack/,
  };
  for (const [src, re] of Object.entries(cases)) {
    const { db, packs } = host();
    const dir = evilPack(`${src}\nexport async function run() {}`);
    const r = await packs.register(loadManifest(EXAMPLE_DIR), { dir });
    assert.equal(r.ok, false, src);
    assert.match(r.errors.join(' '), re, src);
    assert.equal(db.raw.prepare(`SELECT COUNT(*) n FROM packs_registry`).get().n, 0);
  }
});

test('the shipped packs and the example pass the source scan', () => {
  const root = fileURLToPath(new URL('../../packs/', import.meta.url));
  for (const d of [EXAMPLE_DIR, path.join(root, 'email'), path.join(root, 'social')]) assert.deepEqual(scanPackSource(d), [], d);
});

test('a relative import that stays inside the pack directory is fine', () => {
  const dir = evilPack(`import { a } from './lib/a.js'; export async function run() { return a; }`);
  mkdirSync(path.join(dir, 'lib'));
  writeFileSync(path.join(dir, 'lib', 'a.js'), `export const a = 1;`);
  assert.deepEqual(scanPackSource(dir), []);
});

test('sandboxDb rejects a bad pack id', () => {
  assert.throws(() => sandboxDb({}, "x'; --"), /bad pack id/);
});
