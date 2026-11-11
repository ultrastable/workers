// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { load, validate, missingEnforcers, openDirectives, renderGlossary } from './index.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

test('the register is structurally valid', () => {
  assert.deepEqual(validate(load()), []);
});

test('the tagline defines autonomy as self-referential loops plus the privilege to close them', () => {
  const r = load();
  assert.match(r.tagline, /self-referential loops/);
  assert.match(r.tagline, /close them/);
  for (const t of ['Autonomy', 'Loop', 'Self-referential', 'Closure', 'Open loop', 'Closed system', 'Probe', 'Plussing', 'Manager', 'Directive'])
    assert.ok(r.glossary.some(g => g.term === t), `glossary defines ${t}`);
});

test('no directive is an open loop: every enforcer exists in the checkout, every unenforced directive is tracked', () => {
  const r = load();
  assert.deepEqual(missingEnforcers(r, ROOT), []);
  for (const d of openDirectives(r)) assert.ok(Number.isInteger(d.tracking_issue), `${d.id} has a tracking issue`);
});

test('validation catches an enforced directive with no enforcer and a planned one with no tracker', () => {
  const bad = { tagline: 't', glossary: [], directives: [
    { id: 'A', date: 'd', owner_words: 'w', meaning: 'm', status: 'enforced', enforced_by: [] },
    { id: 'B', date: 'd', owner_words: 'w', meaning: 'm', status: 'planned', enforced_by: [] }] };
  const errs = validate(bad);
  assert.ok(errs.some(e => /A: enforced but names no enforcer/.test(e)));
  assert.ok(errs.some(e => /B: planned directive needs a tracking_issue/.test(e)));
});

test('a vanished enforcer is reported', () => {
  const r = { directives: [{ id: 'X', enforced_by: [{ kind: 'file', path: 'does/not/exist.js' }] }] };
  assert.deepEqual(missingEnforcers(r, ROOT), ['X: file does/not/exist.js']);
});

test('docs/GLOSSARY.md is exactly what the register renders (the document cannot drift from the data)', () => {
  const onDisk = readFileSync(new URL('../../docs/GLOSSARY.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(onDisk, renderGlossary(load()));
});
