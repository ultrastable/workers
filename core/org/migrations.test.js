// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// The Worker's one ordered migrations directory is generated from the module list; drift fails the build.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { buildMigrations, OUT_DIR } from '../../tools/build_migrations.mjs';
import { MODULES, moduleList } from './modules.js';

test('the committed migrations directory equals the build output (no drift)', () => {
  const built = buildMigrations();
  const have = readdirSync(OUT_DIR).filter(f => f.endsWith('.sql')).sort();
  assert.deepEqual(have, built.map(b => b.file), 'file list drifted: run node tools/build_migrations.mjs');
  for (const b of built) assert.equal(readFileSync(path.join(OUT_DIR, b.file), 'utf8'), b.sql, `${b.file} drifted`);
});

test('files are numbered in module order and named NNNN_<module>_<name>.sql', () => {
  const files = buildMigrations().map(b => b.file);
  files.forEach((f, i) => assert.match(f, new RegExp(`^${String(i + 1).padStart(4, '0')}_[a-z_]+_[A-Za-z0-9_]+\.sql$`)));
  const order = MODULES.map(m => m.id);
  const seen = files.map(f => order.find(id => f.slice(5).startsWith(id + '_')));
  assert.deepEqual([...new Set(seen)], order);
});

test('pack migrations are added only when listed in config', () => {
  assert.equal(moduleList({}).length, MODULES.length);
  assert.deepEqual(moduleList({ pack_migrations: ['email'] }).at(-1), { id: 'pack_email', dir: 'packs/email/migrations' });
});

test('applying every migration in order to a fresh database succeeds, twice (idempotent)', () => {
  const raw = new DatabaseSync(':memory:');
  const files = readdirSync(OUT_DIR).filter(f => f.endsWith('.sql')).sort();
  for (let pass = 0; pass < 2; pass++) for (const f of files) raw.exec(readFileSync(path.join(OUT_DIR, f), 'utf8'));
  const tables = raw.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map(r => r.name);
  for (const t of ['items', 'tick_runs', 'claims_lock', 'router_calls', 'kernel_step_evidence', 'runner_runs', 'describe_claims', 'packs_registry', 'yield_calls', 'docgate_docs']) assert.ok(tables.includes(t), t);
});
