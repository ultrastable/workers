// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMMANDS, resolve, usage, main } from './us.mjs';
import { checkBoundary, liveComponents, createdTables, main as boundaryMain } from './boundary_check.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('US-SPEC-10 unified command-line tool: every command names a script that exists, and help lists them all', () => {
  for (const [name, c] of Object.entries(COMMANDS)) {
    assert.ok(existsSync(path.join(ROOT, c.script)), `${name} -> ${c.script}`);
    assert.ok(c.about.length > 10);
    assert.match(usage(), new RegExp(`\\n  ${name} `));
  }
  for (const must of ['bootstrap', 'install', 'verify', 'release', 'boundary', 'test']) assert.ok(COMMANDS[must], must);
  const lines = [];
  assert.equal(main([], { log: t => lines.push(t) }), 0);
  assert.equal(main(['help'], { log: t => lines.push(t) }), 0);
  assert.equal(lines[0], usage());
});

test('US-SPEC-10 unified command-line tool: arguments pass through, the exit status comes back unchanged, an unknown command is 2', () => {
  const seen = [];
  const spawn = (bin, args) => { seen.push([bin, args]); return { status: 3 }; };
  assert.equal(main(['install', '--slug', 'x'], { spawn, log: () => {}, env: {} }), 3);
  assert.equal(seen[0][0], process.execPath);
  assert.deepEqual(seen[0][1].slice(1), ['--slug', 'x']);
  assert.ok(seen[0][1][0].endsWith(path.join('tools', 'install.mjs')));
  assert.equal(resolve(['bootstrap', '--dry-run'], { PYTHON: 'py' }).bin, 'py');
  const out = [];
  assert.equal(main(['frobnicate'], { spawn, log: t => out.push(t) }), 2);
  assert.match(out[0], /Unknown command: frobnicate/);
  assert.equal(seen.length, 1, 'nothing is started for an unknown command');
  assert.equal(main(['test'], { spawn: () => ({ error: new Error('ENOENT') }), log: () => {} }), 127);
});

test('US-SPEC-10 unified command-line tool: a real run returns the real exit status of the script it starts', () => {
  const d = mkdtempSync(path.join(tmpdir(), 'us-'));
  writeFileSync(path.join(d, 'bad.yml'), 'name: x\non:\n  push:\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n');
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools/us.mjs'), 'lint-workflows', path.join(d, 'bad.yml')], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /W01/);
  assert.equal(spawnSync(process.execPath, [path.join(ROOT, 'tools/us.mjs'), 'nope'], { encoding: 'utf8' }).status, 2);
});

/** A small repository: two components, a script, a workflow, a migration. */
function repo() {
  const d = mkdtempSync(path.join(tmpdir(), 'bd-'));
  for (const p of ['core/tick/migrations', 'packs/mail', 'tools', '.github/workflows', 'core/empty']) mkdirSync(path.join(d, p), { recursive: true });
  writeFileSync(path.join(d, 'core/tick/index.js'), ''); writeFileSync(path.join(d, 'packs/mail/index.js'), '');
  writeFileSync(path.join(d, 'core/tick/migrations/0001.sql'), 'CREATE TABLE IF NOT EXISTS tick_runs (id INTEGER);\ncreate table items (id TEXT);');
  writeFileSync(path.join(d, 'tools/check.py'), ''); writeFileSync(path.join(d, '.github/workflows/ci.yml'), '');
  const manifest = { roots: ['core', 'packs'], components: { 'core/tick': { class: 'core', role: 'the heartbeat' }, 'packs/mail': { class: 'app', role: 'sends mail through the guard' } },
    core_scripts: ['tools/check.py'], core_workflows: ['.github/workflows/ci.yml'], core_tables: ['tick_runs', 'items'] };
  return { d, manifest };
}

test('US-10-R11 the boundary check passes a fully classified tree and counts by class', () => {
  const { d, manifest } = repo();
  assert.deepEqual(liveComponents(d, manifest.roots), ['core/tick', 'packs/mail'], 'a directory with no file is not a live component');
  assert.deepEqual([...createdTables(d, manifest.roots)].sort(), ['items', 'tick_runs']);
  const r = checkBoundary(d, manifest);
  assert.deepEqual([r.ok, r.live, r.classified, r.counts], [true, 2, 2, { core: 1, app: 1, private: 0 }]);
});

test('US-10-R11 an unclassified live component fails the build, and so does a classified component that is not live', () => {
  const { d, manifest } = repo();
  mkdirSync(path.join(d, 'core/newthing')); writeFileSync(path.join(d, 'core/newthing/index.js'), '');
  let r = checkBoundary(d, manifest);
  assert.equal(r.ok, false);
  assert.match(r.violations[0], /unclassified live component: core\/newthing/);
  writeFileSync(path.join(d, 'boundary.json'), JSON.stringify(manifest));
  const lines = [];
  assert.equal(boundaryMain(['--root', d, '--manifest', path.join(d, 'boundary.json')], t => lines.push(t)), 1, 'exit 1 on a violation');
  manifest.components['core/newthing'] = { class: 'core', role: 'new' };
  manifest.components['core/gone'] = { class: 'core', role: 'retired worker' };
  r = checkBoundary(d, manifest);
  assert.deepEqual(r.violations, ['classified component is not live: core/gone (remove it from the manifest, or restore it)']);
});

test('US-10-R11 an unknown class, a missing role, a missing listed path and a table no migration creates are each reported', () => {
  const { d, manifest } = repo();
  manifest.components['core/tick'] = { class: 'personal', role: ' ' };
  manifest.core_scripts.push('tools/absent.py'); manifest.core_workflows.push('.github/workflows/none.yml'); manifest.core_tables.push('ghost_table');
  const v = checkBoundary(d, manifest).violations.join('\n');
  for (const want of [/unknown class for core\/tick: personal/, /core\/tick has no role text/, /listed path is missing: tools\/absent\.py/, /listed path is missing: \.github\/workflows\/none\.yml/, /created by no migration: ghost_table/]) assert.match(v, want);
  assert.equal(boundaryMain(['--root', d, '--manifest', path.join(d, 'nope.json')], () => {}), 1, 'an unreadable manifest is a failure, not a pass');
});

test('US-10-R11 this repository: every component is classified, every listed script, workflow and table exists', () => {
  const manifest = JSON.parse(readFileSync(path.join(ROOT, 'tools/boundary.json'), 'utf8'));
  const r = checkBoundary(ROOT, manifest);
  assert.deepEqual(r.violations, []);
  assert.ok(r.counts.core > 10 && r.counts.app >= 6);
  assert.equal(r.counts.private, 0, 'no private plane ships in this repository');
});
