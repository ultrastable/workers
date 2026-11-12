// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Tests for secret redaction in the pack host wrapper (US-21-R09): no secret value in any pack log, row, item or tick note.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeDb } from '../_shared/testdb.js';
import { KERNEL_DIR } from '../kernel/testkit.js';
import { createPacks, loadManifest, MIGRATIONS_DIR, createRedactor, secretValuesFor, redactingSink, REDACTED } from './index.js';

const EXAMPLE_DIR = fileURLToPath(new URL('./example/', import.meta.url));
const T0 = Date.parse('2026-11-11T10:00:00Z');
const SECRET = 'Zq7-very-private-value-42';
const SETTING_SECRET = 'hunter2-setting-value';

test('redactor removes raw, URL-encoded and base64 forms, longest first, plus secret shapes', () => {
  const r = createRedactor({ values: [SECRET, 'short'] });
  const b64 = Buffer.from(SECRET).toString('base64').replace(/=+$/, '');
  const out = r.redact(`a ${SECRET} b ${encodeURIComponent(SECRET + ' x')} c ${b64} d short e ghp_${'a'.repeat(30)} f Bearer ${'x'.repeat(30)}`);
  assert.ok(!out.includes(SECRET) && !out.includes(b64) && !out.includes('ghp_'), out);
  assert.ok(out.includes('short'), 'values under 6 characters are left alone');
  assert.equal((out.match(/\[redacted\]/g) || []).length >= 5, true, out);
  assert.equal(r.redact(null), '');
  const live = []; const lazy = createRedactor({ values: () => live });
  assert.equal(lazy.redact('late-learned-secret'), 'late-learned-secret');
  live.push('late-learned-secret'); assert.equal(lazy.redact('late-learned-secret'), REDACTED);
  assert.deepEqual(r.deep({ a: [SECRET, 1], b: { c: `x${SECRET}` } }), { a: [REDACTED, 1], b: { c: `x${REDACTED}` } });
});

test('secretValuesFor reads declared names from env and secret-looking settings', () => {
  const m = { requires: { secrets: ['API_TOKEN', 'MISSING'] } };
  const v = secretValuesFor(m, { env: { API_TOKEN: SECRET, OTHER: 'nope-nope-nope' }, settings: { host: 'plain-host-value', creds: { password: SETTING_SECRET }, list: [{ token: 'tok-in-a-list-1' }] } });
  assert.deepEqual(v.sort(), [SECRET, SETTING_SECRET, 'tok-in-a-list-1'].sort());
});

test('redactingSink redacts what a loop pushes and exposes nothing else', () => {
  const target = [];
  const sink = redactingSink(target, createRedactor({ values: [SECRET] }).redact);
  sink.push(`note ${SECRET}`, 'fine');
  assert.deepEqual(target, [`note ${REDACTED}`, 'fine']); assert.equal(sink.length, 2); assert.equal(Object.isFrozen(sink), true);
});

function evilPack(body) {
  const dir = mkdtempSync(path.join(tmpdir(), 'redact-'));
  writeFileSync(path.join(dir, 'noop.js'), body);
  return dir;
}
function host({ env = {}, settings = {}, channel } = {}) {
  const db = makeDb([KERNEL_DIR, MIGRATIONS_DIR]);
  const packs = createPacks({ db, now: () => T0, config: { step_timeout_ms: 500, packs: { example: settings } }, env, channels: { fake: channel || { send: async () => ({ id: 'p' }) } } });
  return { db, packs };
}
async function enable(packs, dir, mutate = m => m) {
  const m = mutate(loadManifest(EXAMPLE_DIR));
  assert.equal((await packs.register(m, { dir })).ok, true);
  assert.equal((await packs.enablePack('example', { by: 'owner', cardText: m.enable_gate })).ok, true);
}
const runStep = async (db, packs, env) => {
  const [step] = await packs.packSteps();
  const ctx = { tickId: 1, notes: [], errors: [], env, now: T0, nowIso: '2026-11-11 10:00:00' };
  await step.run(db, ctx);
  return ctx;
};
const everything = db => JSON.stringify(['packs_runs', 'items', 'guard_ledger', 'gate_cards'].map(t => db.raw.prepare(`SELECT * FROM ${t}`).all()));

test('a loop that throws or notes a secret value leaves it out of the run row, the tick errors, the notes and the backlog item', async () => {
  const dir = evilPack(`export async function run({ ctx, settings }) {
    ctx.notes.push('connecting with ' + settings.api_key);
    throw new Error('401 for token ' + settings.api_key + ' and env value ${SECRET}');
  }`);
  const { db, packs } = host({ settings: { api_key: SETTING_SECRET } });
  await enable(packs, dir, m => { m.requires.secrets = ['EXAMPLE_TOKEN']; return m; });
  const ctx = await runStep(db, packs, { EXAMPLE_TOKEN: SECRET });
  const all = JSON.stringify([ctx.notes, ctx.errors]) + everything(db);
  assert.ok(!all.includes(SECRET) && !all.includes(SETTING_SECRET), all);
  assert.match(ctx.errors[0], /401 for token \[redacted\] and env value \[redacted\]/);
  assert.deepEqual(ctx.notes, ['connecting with [redacted]']);
  assert.match(db.raw.prepare(`SELECT error FROM packs_runs`).get().error, /\[redacted\]/);
  assert.match(db.raw.prepare(`SELECT title FROM items WHERE id LIKE 'PACKFAIL-%'`).get().title, /\[redacted\]/);
});

test('secret shapes are redacted even when the value is not a declared secret', async () => {
  const dir = evilPack(`export async function run() { throw new Error('boom ghp_${'b'.repeat(32)} done'); }`);
  const { db, packs } = host();
  await enable(packs, dir);
  const ctx = await runStep(db, packs, {});
  assert.ok(!everything(db).includes('ghp_') && !ctx.errors.join('').includes('ghp_'));
});

test('a channel error that carries a secret is redacted in the guard ledger and the refusal reason', async () => {
  const channel = { send: async () => { throw new Error(`provider said bad key ${SECRET}`); } };
  const { db, packs } = host({ env: { EXAMPLE_TOKEN: SECRET }, channel });
  const dir = evilPack(`export async function run({ ctx, guard }) {
    const r = await guard.send({ channel: 'fake', kind: 'notice', recipient: 'a@example.com', content: 'hi there', idempotencyKey: 'k1' });
    ctx.notes.push(r.reason);
  }`);
  await enable(packs, dir, m => { m.requires.secrets = ['EXAMPLE_TOKEN']; m.outbound.consent = 'none'; return m; });
  db.raw.prepare(`INSERT INTO trust_ledger (surface, action_class, rung, reliability, outcomes) VALUES ('pack:example','notice','delegated',1,50)`).run();
  const ctx = await runStep(db, packs, {});
  assert.match(ctx.notes[0], /^delivery_failed: provider said bad key \[redacted\]/);
  assert.ok(!everything(db).includes(SECRET));
});
