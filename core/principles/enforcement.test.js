// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from './index.js';
import { CHECKS, checkDirectives, checkScopeAndPacks, checkOutreachAsLoops, checkIgnoranceAssumed, unprovenEnforced, readPacks } from './enforcement.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
/** A copy of the real packs in a temporary root, so a test can break one. */
function copyPacks(ids = ['email', 'social', 'video', 'drafts']) {
  const d = mkdtempSync(path.join(tmpdir(), 'enf-'));
  for (const id of ids) cpSync(path.join(ROOT, 'packs', id), path.join(d, 'packs', id), { recursive: true });
  mkdirSync(path.join(d, 'core')); mkdirSync(path.join(d, 'adapters'));
  const edit = (id, fn) => { const f = path.join(d, 'packs', id, 'pack.json'); const m = JSON.parse(readFileSync(f, 'utf8')); fn(m); writeFileSync(f, JSON.stringify(m)); };
  return { d, edit };
}

test('US-23-R07 the directives for ignorance elicitation and outbound packs are enforced: their checks pass on this checkout', () => {
  const reg = load();
  assert.deepEqual(checkDirectives(reg, ROOT), {});
  for (const id of Object.keys(CHECKS)) {
    const d = reg.directives.find(x => x.id === id);
    assert.equal(d.status, 'enforced', id);
    assert.ok(d.enforced_by.some(e => e.path === 'core/principles/enforcement.js'), `${id} names its check`);
  }
  assert.deepEqual(unprovenEnforced(reg), []);
  assert.ok(readPacks(ROOT).length >= 6, 'the check reads the real packs');
});

test('US-23-R07 a directive called enforced without naming its check is reported', () => {
  const reg = { directives: [{ id: 'D-SCOPE-AND-PACKS', status: 'enforced', enforced_by: [{ kind: 'file', path: 'SCOPE.md' }] }, { id: 'D-OTHER', status: 'enforced', enforced_by: [] }] };
  assert.deepEqual(unprovenEnforced(reg), ['D-SCOPE-AND-PACKS']);
});

test('D-SCOPE-AND-PACKS fails when a class C pack gains an outbound loop, a manifest breaks or core imports a pack', () => {
  const a = copyPacks();
  assert.deepEqual(checkScopeAndPacks(a.d), []);
  a.edit('drafts', m => { m.loops.push({ id: 'file_it', every_ticks: 1, entry: './loops.js#x', outbound: true }); });
  assert.ok(checkScopeAndPacks(a.d).some(p => /packs\/drafts/.test(p) && /class C|outbound/.test(p)));
  const b = copyPacks();
  b.edit('email', m => { m.scope.does.push('Buys ads and enters payment details for the person'); delete m.enable_gate; });
  const probs = checkScopeAndPacks(b.d).join('\n');
  assert.match(probs, /packs\/email: scope\.does is out of bounds/);
  assert.match(probs, /packs\/email: .*enable.?gate/i);
  const c = copyPacks();
  writeFileSync(path.join(c.d, 'core', 'tick.js'), "import '../packs/email/service.js';\n");
  assert.ok(checkScopeAndPacks(c.d).some(p => /imports pack module/.test(p)));
  const empty = mkdtempSync(path.join(tmpdir(), 'enf-'));
  assert.match(checkScopeAndPacks(empty)[0], /no pack manifest found/);
});

test('D-OUTREACH-AS-LOOPS fails when an outreach pack is missing, loses its loops, its caps, its suppression or its charter metrics', () => {
  const a = copyPacks();
  assert.deepEqual(checkOutreachAsLoops(a.d), []);
  rmSync(path.join(a.d, 'packs', 'video'), { recursive: true });
  assert.deepEqual(checkOutreachAsLoops(a.d), ['pack video is missing']);
  const b = copyPacks();
  b.edit('social', m => { m.outbound.suppression = false; m.outbound.caps = {}; m.charter.guard_metrics = []; });
  b.edit('email', m => { m.loops = []; });
  const probs = checkOutreachAsLoops(b.d).join('\n');
  for (const want of [/packs\/social: suppression is not on/, /packs\/social: channel \w+ has no daily and weekly cap/, /packs\/social: no guard metric/, /packs\/email: no code loop/, /packs\/email: no outbound loop/]) assert.match(probs, want);
  const c = copyPacks();
  c.edit('video', m => { m.loops[0].entry = './gone.js#run'; });
  assert.ok(checkOutreachAsLoops(c.d).some(p => /names a module that does not exist/.test(p)));
});

test('D-IGNORANCE-ASSUMED holds: the ask-card rules refuse recall-only, default-less and jargon cards and accept a plain one', () => {
  assert.deepEqual(checkIgnoranceAssumed(), []);
});

test('T23-4 (US-SPEC-23) removing the code a directive names as its enforcer fails: the check module is itself a named enforcer that must exist', async () => {
  const { missingEnforcers } = await import('./index.js');
  const reg = load();
  assert.deepEqual(missingEnforcers(reg, ROOT), []);
  const gone = mkdtempSync(path.join(tmpdir(), 'enf-'));
  assert.ok(missingEnforcers(reg, gone).some(m => /D-OUTREACH-AS-LOOPS: file core\/principles\/enforcement\.js/.test(m)));
});
