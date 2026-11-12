// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Tests for packs/drafts (US-SPEC-21 class C). In-memory database; no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { makeDb } from '../../core/_shared/testdb.js';
import { KERNEL_DIR } from '../../core/kernel/testkit.js';
import { createPacks, validateManifest, loadManifest, MIGRATIONS_DIR } from '../../core/packs/index.js';
import { createDraft, reviseDraft, markTaken, closeDraft, getDraft, listDrafts, checkDraft, BANNER } from './index.js';

const DIR = fileURLToPath(new URL('./', import.meta.url));
const MIG = fileURLToPath(new URL('./migrations/', import.meta.url));
const D = 86400e3;
const T0 = Date.parse('2026-11-11T10:00:00Z');
const rows = (db, sql, ...a) => db.raw.prepare(sql).all(...a).map(r => ({ ...r }));
const one = (db, sql, ...a) => db.raw.prepare(sql).get(...a);
const PLAN = '# Goal\nShip a pilot.\n# Steps\n1. Pick a customer.\n# Risks\nScope creep.';
const LEGAL = 'Parties: A and B.\nTerms: to be agreed.\nOpen questions: governing law.';

async function setup(clock = { t: T0 }) {
  const db = makeDb([KERNEL_DIR, MIGRATIONS_DIR, MIG]);
  const packs = createPacks({ db, now: () => clock.t, config: { packs: { drafts: {} } }, channels: {} });
  const m = loadManifest(DIR);
  assert.deepEqual((await packs.register(m, { dir: DIR })).errors, undefined);
  assert.equal((await packs.enablePack('drafts', { by: 'owner', cardText: m.enable_gate })).ok, true);
  const loop = async name => {
    const step = (await packs.packSteps()).find(x => x.name === `pack:drafts:${name}`);
    const ctx = { tickId: 12, errors: [], notes: [], now: clock.t };
    await step.run(db, ctx);
    assert.deepEqual(ctx.errors, []);
    return ctx;
  };
  return { db, packs, loop, clock, now: () => clock.t };
}

test('manifest is valid, class C with no outbound, drafts_ prefixed tables, probes run', () => {
  const m = loadManifest(DIR);
  assert.deepEqual(validateManifest(m, { tenantNames: ['acme'] }), []);
  assert.equal(m.class, 'C');
  assert.equal(m.outbound, undefined);
  assert.ok(m.loops.every(l => l.outbound === false));
  const db = makeDb([KERNEL_DIR, MIGRATIONS_DIR, MIG]);
  const sql = readFileSync(new URL('./migrations/0001_drafts.sql', import.meta.url), 'utf8');
  db.raw.exec(sql); db.raw.exec(sql);
  assert.deepEqual(rows(db, `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'drafts_%'`).map(r => r.name).sort(), ['drafts_items', 'drafts_metrics', 'drafts_rejections', 'drafts_versions']);
  for (const g of [...m.charter.guard_metrics, m.charter.primary_metric]) db.raw.prepare(g.read_probe).get();
});

test('a draft is stored with the banner and its hash; every version is kept', async () => {
  const { db, now } = await setup();
  const c = await createDraft({ db, now, kind: 'plan', title: 'Pilot plan', body: PLAN });
  assert.deepEqual(c, { created: true, id: 1, version: 1 });
  assert.ok((await getDraft({ db, id: 1 })).body.startsWith(BANNER));
  assert.deepEqual(await reviseDraft({ db, now, id: 1, body: PLAN }), { revised: false, reason: 'unchanged', version: 1 });
  assert.deepEqual(await reviseDraft({ db, now, id: 1, body: PLAN + '\nMore.' }), { revised: true, version: 2 });
  assert.equal(rows(db, `SELECT * FROM drafts_versions`).length, 2);
  assert.equal((await getDraft({ db, id: 1 })).body.split(BANNER).length, 2);              // banner not duplicated
  assert.equal(one(db, `SELECT COUNT(*) AS n FROM drafts_versions WHERE body NOT LIKE 'DRAFT, NOT FINAL.%'`).n, 0);
  const idem = await createDraft({ db, now, kind: 'legal', title: 'Terms', body: LEGAL, idempotencyKey: 'k1' });
  assert.equal((await createDraft({ db, now, kind: 'legal', title: 'Terms', body: LEGAL, idempotencyKey: 'k1' })).duplicate, true);
  assert.equal(idem.created, true);
});

test('the checker rejects missing sections, advice, final or already-used claims and secrets', () => {
  const rule = d => checkDraft(d).violations.map(v => v.rule);
  assert.equal(checkDraft({ kind: 'plan', title: 't', body: PLAN }).ok, true);
  assert.ok(rule({ kind: 'plan', title: 't', body: '# Goal\nx' }).includes('section_missing'));
  assert.ok(rule({ kind: 'nope', title: 't', body: 'x' }).includes('kind_unknown'));
  assert.ok(rule({ kind: 'plan', title: '', body: PLAN }).includes('title_missing'));
  assert.ok(rule({ kind: 'legal', title: 't', body: LEGAL + '\nThis is legal advice.' }).includes('claims_advice'));
  assert.ok(rule({ kind: 'legal', title: 't', body: LEGAL + '\nThis agreement is binding.' }).includes('claims_final'));
  assert.ok(rule({ kind: 'legal', title: 't', body: LEGAL + '\nIt has been signed.' }).includes('claims_used'));
  assert.ok(rule({ kind: 'patent', title: 't', body: '# Title\n# Field\n# Description\n# Embodiments\nready to file' }).includes('claims_ready'));
  assert.ok(rule({ kind: 'plan', title: 't', body: PLAN + '\npassword: abcdef123456789' }).includes('secret_pattern'));
});

test('a rejected draft is recorded and not stored; a rejected revision keeps the old version', async () => {
  const { db, now } = await setup();
  const bad = await createDraft({ db, now, kind: 'legal', title: 'T', body: LEGAL + '\nThis is legal advice.' });
  assert.equal(bad.created, false);
  assert.equal(rows(db, `SELECT * FROM drafts_items`).length, 0);
  assert.match(one(db, `SELECT violations FROM drafts_rejections`).violations, /claims_advice/);
  await createDraft({ db, now, kind: 'plan', title: 'P', body: PLAN });
  assert.equal((await reviseDraft({ db, now, id: 1, body: 'nothing useful' })).revised, false);
  assert.equal(one(db, `SELECT version FROM drafts_items WHERE id = 1`).version, 1);
});

test('only a named person marks a draft taken; a taken or closed draft is not revised', async () => {
  const { db, now } = await setup();
  await createDraft({ db, now, kind: 'plan', title: 'P', body: PLAN });
  assert.deepEqual(await markTaken({ db, now, id: 1, by: '' }), { ok: false, reason: 'by_required' });
  assert.deepEqual(await markTaken({ db, now, id: 1, by: 'alex' }), { ok: true });
  assert.equal((await reviseDraft({ db, now, id: 1, body: PLAN + 'x' })).reason, 'status_taken');
  await createDraft({ db, now, kind: 'plan', title: 'Q', body: PLAN });
  assert.deepEqual(await closeDraft({ db, now, id: 2 }), { ok: true });
  assert.deepEqual((await listDrafts({ db })).length, 0);
});

test('the guard never lets a class C pack send, even if asked', async () => {
  const { packs } = await setup();
  const r = await packs.boundGuard('drafts').send({ channel: 'x', kind: 'k', recipient: 'r', content: 'c', idempotencyKey: 'i' });
  assert.equal(r.decision, 'refused');
  assert.equal(r.reason, 'class_c_never_sends');
});

test('stale loop files one item per stale draft, once; metrics count open, stale and versions', async () => {
  const { db, loop, clock, now } = await setup();
  await createDraft({ db, now, kind: 'plan', title: 'Old', body: PLAN });
  clock.t = T0 + 20 * D;
  await createDraft({ db, now, kind: 'plan', title: 'New', body: PLAN });
  await loop('stale'); await loop('stale');
  assert.deepEqual(rows(db, `SELECT id FROM items WHERE id LIKE 'DRAFTSTALE-%'`).map(r => r.id), ['DRAFTSTALE-1']);
  await loop('metrics');
  const m = one(db, `SELECT * FROM drafts_metrics`);
  assert.equal(m.open_drafts, 2); assert.equal(m.stale, 1); assert.equal(m.versions_7d, 1);
  assert.equal(one(db, loadManifest(DIR).charter.guard_metrics[1].read_probe).value, 0);
});
