// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { defineStatements, statement, live, region, verifyAll, auditHtml, proof, describe } from './index.js';

const ctx = { draws: 3000 };
const reg = defineStatements([
  { id: 'draws', text: c => `The engine runs ${c.draws} draws.`, verify: async c => { assert.equal(c.draws, 3000); } },
  { id: 'honest', text: 'It names its sources.', verify: async () => {} },
]);
const page = (inner) => `<h1>T</h1>${region(inner)}`;

test('a statement without a probe, a duplicate id, or a typed number is refused', () => {
  assert.throws(() => defineStatements([{ id: 'a', text: 'x' }]), /no verify/);
  assert.throws(() => defineStatements([{ id: 'a', text: 'x', verify() {} }, { id: 'a', text: 'y', verify() {} }]), /duplicate/);
  assert.throws(() => defineStatements([{ id: 'a', text: 'It runs 3000 draws.', verify() {} }]), /static text contains a number/);
  assert.throws(() => defineStatements([{ id: 'A b', text: 'x', verify() {} }]), /kebab/);
});
test('text is rendered from the config', () => assert.match(statement(reg, 'draws', { draws: 5 }), /runs 5 draws/));
test('a page built from the registry passes the audit', async () => {
  const html = page(`<h2>S</h2><p>${statement(reg, 'draws', ctx)} ${statement(reg, 'honest', ctx)}</p>${live('<table><tr><td>live number 7</td></tr></table>')}`);
  const p = await proof(reg, html, ctx);
  assert.equal(p.ok, true); assert.equal(p.total, 2); assert.equal(p.passed, 2);
});
test('prose that is not bound to a statement fails', () => {
  const a = auditHtml(reg, page(`<p>${statement(reg, 'draws', ctx)} ${statement(reg, 'honest', ctx)}</p><p>This sentence is a promise with no test.</p>`));
  assert.equal(a.ok, false); assert.match(a.unbound[0], /promise with no test/);
});
test('an unknown data-claim and an unrendered statement fail', () => {
  const a = auditHtml(reg, page(`<p><span data-claim="ghost">x</span>${statement(reg, 'draws', ctx)}</p>`));
  assert.deepEqual(a.unknown, ['ghost']); assert.deepEqual(a.unrendered, ['honest']);
});
test('a probe that throws fails the proof, and the failure names the statement', async () => {
  const r = defineStatements([{ id: 'false-claim', text: 'It is fast.', verify: async () => { throw new Error('took 9 s'); } }]);
  const p = await proof(r, page(`<p>${statement(r, 'false-claim', {})}</p>`), {});
  assert.equal(p.ok, false); assert.equal(p.failed[0].id, 'false-claim'); assert.match(p.failed[0].error, /9 s/);
});
test('verifyAll and describe give a machine-readable list', async () => {
  assert.equal((await verifyAll(reg, ctx)).passed, 2);
  assert.equal(describe(reg, ctx)[0].text, 'The engine runs 3000 draws.');
});
