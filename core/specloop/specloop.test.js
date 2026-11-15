// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Tests for core/specloop (US-SPEC-20 self-hosting, US-SPEC-22 R03 honest PLANNED list, US-SPEC-00 R03 no overstated label):
// the specification backlog builds itself. No person files, targets or closes these items.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { makeDb } from '../_shared/testdb.js';
import * as S from './index.js';

const MIG = fileURLToPath(new URL('./migrations/', import.meta.url));
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const T0 = Date.parse('2026-11-15T10:00:00Z');
const SPEC = (rows) => `# US-SPEC-07 thing\n\n## 9. Reference implementation status\n\n| Capability | Status |\n|---|---|\n${rows.join('\n')}\n\n## 10. Next\n- ignored: PLANNED\n`;
const setup = () => { const db = makeDb([MIG]); const clock = { t: T0 }; return { db, clock, now: () => clock.t }; };
const items = db => db.raw.prepare(`SELECT id, status, kind, done_check, disposition, title FROM items WHERE project='spec-to-code' ORDER BY id`).all();

test('parseSpec reads table rows and bullets, RUNNING without BUILT is not built here', () => {
  const rows = S.parseSpec('US-SPEC-07-x.md', SPEC(['| Claims | BUILT (`core/claims/index.js`, `core/claims/claims.test.js`) |', '| Review | RUNNING in the reference fleet. PLANNED for the seed. |', '| Filter | PLANNED (`core/governance`) |']));
  assert.deepEqual(rows.map(r => [r.id, r.label]), [['US-SPEC-07-1', 'BUILT'], ['US-SPEC-07-2', 'RUNNING_ONLY'], ['US-SPEC-07-3', 'PLANNED']]);
  assert.deepEqual(rows[0].paths, ['core/claims/index.js', 'core/claims/claims.test.js']);
});

test('deriveTarget never returns nothing: named file, named directory, or a derived module', () => {
  const r = (capability, paths) => S.deriveTarget({ num: 7, capability, paths });
  assert.deepEqual(r('x', ['core/a/b.js', 'core/a/b.test.js']), { target: 'core/a/b.js', test: 'core/a/b.test.js' });
  assert.deepEqual(r('x', ['core/governance']), { target: 'core/governance/index.js', test: 'core/governance/governance.test.js' });
  assert.deepEqual(r('Pre-emission filter and classifier-based matching', []), { target: 'core/spec07-pre-emission-filter/index.js', test: 'core/spec07-pre-emission-filter/spec07-pre-emission-filter.test.js' });
});

test('one sweep files a ready item with a target for every line not truthfully BUILT, and none for a true BUILT', async () => {
  const { db, now } = setup();
  const text = SPEC(['| Claims | BUILT (`core/claims/index.js`) |', '| Ghost | BUILT (`worker/src/gone.js`) |', '| Filter | PLANNED (`core/governance`) |', '| Review | RUNNING elsewhere |']);
  const r = await S.sync({ db, now, loadSpecs: async () => [{ name: 'US-SPEC-07-x.md', text }], exists: async p => p === 'core/claims/index.js' });
  assert.deepEqual({ lines: r.lines, built: r.built, remaining: r.remaining, false_built: r.false_built, filed: r.filed }, { lines: 4, built: 1, remaining: 3, false_built: 1, filed: 3 });
  const its = items(db);
  assert.deepEqual(its.map(i => [i.id, i.status, i.kind]), [['US-SPEC-07-2', 'ready', 'fix'], ['US-SPEC-07-3', 'ready', 'work'], ['US-SPEC-07-4', 'ready', 'work']]);
  assert.ok(its.every(i => /target: \S+; test: \S+/.test(i.done_check)), 'every item names its target and test, so no run is refused for lack of one');
  assert.match(its[1].done_check, /target: core\/governance\/index\.js/);
  const pm = JSON.parse(db.raw.prepare(`SELECT value FROM org WHERE key='spec_remaining'`).get().value);
  assert.equal(pm.remaining, 3); assert.equal(pm.BUILT, 1);
});

test('idempotent; closes itself when the line turns BUILT and the code exists; reopens when the claim regresses', async () => {
  const { db, now, clock } = setup();
  let text = SPEC(['| Filter | PLANNED (`core/governance`) |']);
  const have = new Set();
  const go = () => S.sync({ db, now, loadSpecs: async () => [{ name: 'US-SPEC-07-x.md', text }], exists: async p => have.has(p) });
  await go(); const again = await go();
  assert.equal(again.filed, 0); assert.equal(items(db).length, 1);
  text = SPEC(['| Filter | BUILT (`core/governance/index.js`) |']);
  clock.t += 600000;
  let r = await go();
  assert.equal(r.closed, 0, 'a BUILT label without the code closes nothing'); assert.equal(r.false_built, 1); assert.equal(items(db)[0].status, 'ready');
  have.add('core/governance/index.js'); clock.t += 600000;
  r = await go();
  assert.equal(r.closed, 1); assert.equal(items(db)[0].status, 'done'); assert.match(items(db)[0].disposition, /reads BUILT/);
  assert.ok(db.raw.prepare(`SELECT built_at FROM specloop_lines WHERE id='US-SPEC-07-1'`).get().built_at);
  have.clear(); clock.t += 600000;
  r = await go();
  assert.equal(r.reopened, 1); assert.equal(items(db)[0].status, 'ready'); assert.equal(items(db)[0].disposition, null);
});

test('releases items the older seed left blocked awaiting a hand-edited target map', async () => {
  const { db, now } = setup();
  db.raw.prepare(`INSERT INTO items (id,title,project,owner_role,done_check,status,disposition) VALUES ('US-SPEC-07-1','old','spec-to-code','staff','x','blocked',?)`).run(S.AWAITING);
  const r = await S.sync({ db, now, loadSpecs: async () => [{ name: 'US-SPEC-07-x.md', text: SPEC(['| Filter | PLANNED |']) }] });
  assert.equal(r.released, 1);
  const it = items(db)[0]; assert.equal(it.status, 'ready'); assert.equal(it.disposition, null); assert.match(it.done_check, /target: core\/spec07-filter\/index\.js/);
});

test('an unreadable source is unmeasured, not zero: nothing closes and the source itself becomes an item', async () => {
  const { db, now, clock } = setup();
  await S.sync({ db, now, loadSpecs: async () => [{ name: 'US-SPEC-07-x.md', text: SPEC(['| Filter | PLANNED |']) }] });
  clock.t += 600000;
  const r = await S.sync({ db, now, loadSpecs: async () => { throw new Error('503 /contents'); } });
  assert.match(r.error, /503/);
  assert.equal(db.raw.prepare(`SELECT status FROM items WHERE id='US-SPEC-07-1'`).get().status, 'ready');
  assert.equal(db.raw.prepare(`SELECT status FROM items WHERE id='SPECLOOP-SOURCE'`).get().status, 'ready');
  clock.t += 600000;
  await S.sync({ db, now, loadSpecs: async () => [{ name: 'US-SPEC-07-x.md', text: SPEC(['| Filter | PLANNED |']) }] });
  assert.equal(db.raw.prepare(`SELECT status FROM items WHERE id='SPECLOOP-SOURCE'`).get().status, 'done');
});

test('a status line removed from the specification supersedes its item with the reason (no silent drop)', async () => {
  const { db, now, clock } = setup();
  await S.sync({ db, now, loadSpecs: async () => [{ name: 'US-SPEC-07-x.md', text: SPEC(['| A | PLANNED |', '| B | PLANNED |']) }] });
  clock.t += 600000;
  await S.sync({ db, now, loadSpecs: async () => [{ name: 'US-SPEC-07-x.md', text: SPEC(['| A | PLANNED |']) }] });
  const b = db.raw.prepare(`SELECT status, disposition FROM items WHERE id='US-SPEC-07-2'`).get();
  assert.equal(b.status, 'superseded'); assert.match(b.disposition, /no longer in the specification/);
});

test('repoSource reads specifications and the code tree from a code host through fetch only', async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push(url);
    const ok = body => ({ ok: true, status: 200, json: async () => body, text: async () => body });
    if (url.endsWith('/repos/o/spec/contents/specs?ref=main')) return ok([{ name: 'US-SPEC-07-x.md' }, { name: 'README.md' }]);
    if (url.includes('/contents/specs/US-SPEC-07-x.md')) { assert.match(init.headers.accept, /raw/); return ok(SPEC(['| Claims | BUILT (`core/claims/index.js`) |', '| Shim | BUILT (`d1shim.js`) |'])); }
    if (url.includes('/repos/o/code/git/trees/main')) return ok({ tree: [{ path: 'core/claims/index.js' }, { path: 'core/test/d1shim.js' }] });
    if (url.includes('/repos/o/spec/git/trees/main')) return ok({ tree: [] });
    return { ok: false, status: 404 };
  };
  const { db, now } = setup();
  const st = S.step({ db, now, fetch, config: { spec_repo: 'o/spec', code_repo: 'o/code' } });
  const ctx = { notes: [] }; await st.run(db, ctx);
  assert.match(ctx.notes[0], /0 of 2 capabilities not built/);
  assert.equal(calls.filter(u => u.includes('/git/trees/')).length, 2, 'the tree is fetched once per repository, not once per path');
});

test('the step is on by default and off only when disabled or when nothing can be read', () => {
  const db = {}, fetch = async () => ({});
  assert.equal(S.step({ db, fetch, config: {} }), null);
  assert.equal(S.step({ db, fetch, config: { spec_repo: 'o/spec', enabled: false } }), null);
  assert.equal(S.step({ db, fetch, config: { spec_repo: 'o/spec' } }).name, 'specloop');
  assert.equal(S.step({ db, readFile: async () => '', config: { spec_paths: ['specs/US-SPEC-01-a.md'] } }).name, 'specloop');
});

test('parity with tools/spec_backlog.py on the real specifications, when a specification checkout sits beside this one', { skip: !existsSync(path.join(ROOT, '../spec/specs')) }, () => {
  const dir = path.join(ROOT, '../spec/specs');
  const py = JSON.parse(execFileSync('python3', [path.join(ROOT, 'tools/spec_backlog.py'), '--spec-dir', dir, '--json'], { encoding: 'utf8' })).map(i => i.id).sort();
  const js = readdirSync(dir).filter(n => /^US-SPEC-.*\.md$/.test(n)).flatMap(n => S.parseSpec(n, readFileSync(path.join(dir, n), 'utf8'))).filter(r => r.label !== 'BUILT').map(r => r.id).sort();
  assert.deepEqual(js, py);
});
