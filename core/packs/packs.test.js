// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Tests for core/packs (US-SPEC-21: R01-R14, T21-1..T21-8). Fake channel port, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeDb } from '../_shared/testdb.js';
import { KERNEL_DIR } from '../kernel/testkit.js';
import { runTick } from '../src/tick.js';
import { createPacks, validateManifest, loadManifest, assertCoreImportsNoPacks, MIGRATIONS_DIR } from './index.js';

const EXAMPLE_DIR = fileURLToPath(new URL('./example/', import.meta.url));
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const policy = JSON.parse(readFileSync(new URL('../../autonomy/policy.json', import.meta.url), 'utf8'));
const tickConfig = { org_slug: 't', claim_ttl_minutes: 120, max_wip_per_role: 3, plus_share: 0.2, policy };
const T0 = Date.parse('2026-11-11T10:00:00Z');
const one = (db, sql, ...a) => db.raw.prepare(sql).get(...a);
const rows = (db, sql, ...a) => db.raw.prepare(sql).all(...a);
const exampleManifest = () => loadManifest(EXAMPLE_DIR);

function fakeChannel({ maxLength, senderId, fail } = {}) {
  const c = { sent: [], maxLength, senderId };
  c.send = async (m) => { if (fail) throw new Error('provider down'); c.sent.push(m); return { id: `prov-${c.sent.length}` }; };
  return c;
}

function setup({ kernel = true, config = {}, channel = fakeChannel(), rung = 'delegated', clock = { t: T0 } } = {}) {
  const db = makeDb(kernel ? [KERNEL_DIR, MIGRATIONS_DIR] : [MIGRATIONS_DIR]);
  const cfg = { step_timeout_ms: 200, packs: { example: { recipients: ['person@example.com'] } }, ...config };
  const packs = createPacks({ db, now: () => clock.t, config: cfg, channels: { fake: channel } });
  if (rung) db.raw.prepare(`INSERT INTO trust_ledger (surface, action_class, rung, reliability, outcomes) VALUES ('pack:example','notice',?,1,50)`).run(rung);
  return { db, packs, channel, clock, guard: packs.guard };
}
const enable = async (packs, by = 'owner') => {
  const m = exampleManifest();
  assert.deepEqual((await packs.register(m, { dir: EXAMPLE_DIR })).errors, undefined);
  return packs.enablePack('example', { by, cardText: m.enable_gate });
};
async function consented(guard, recipient = 'person@example.com') {
  const { token } = await guard.consent.request({ channel: 'fake', recipient });
  assert.equal((await guard.consent.confirm(token)).ok, true);
}
const msg = (o = {}) => ({ pack: 'example', channel: 'fake', kind: 'notice', recipient: 'person@example.com', content: 'hello there', idempotencyKey: 'k1', ...o });

test('migration is idempotent and every table is packs_ or guard_ prefixed', () => {
  const { db } = setup();
  const sql = readFileSync(new URL('./migrations/0001_packs.sql', import.meta.url), 'utf8');
  db.raw.exec(sql); db.raw.exec(sql);
  const names = rows(db, `SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE 'packs_%' OR name LIKE 'guard_%')`).map(r => r.name).sort();
  assert.deepEqual(names, ['guard_bounces', 'guard_consent', 'guard_ledger', 'guard_queue', 'guard_suppression', 'packs_migrations', 'packs_registry', 'packs_runs', 'packs_switches']);
});

// ---- T21-1: inert until enabled; decision recorded; disable stops loops (R01, R04) ----
test('T21-1 a pack is inert until enabled; enabling records who, when and the card text; disabling stops the loops', async () => {
  const { db, packs, channel, guard } = setup();
  await packs.register(exampleManifest(), { dir: EXAMPLE_DIR });
  assert.equal((await packs.packSteps()).length, 0);                                  // registered is not enabled
  assert.equal((await guard.send(msg())).reason, 'pack_disabled');
  assert.equal(await one(db, `SELECT COUNT(*) n FROM roles`).n, 0);

  assert.equal((await packs.enablePack('example', { by: 'owner', cardText: 'something else' })).reason, 'card_text_mismatch');
  assert.equal((await packs.enablePack('example', { cardText: exampleManifest().enable_gate })).reason, 'enabled_by_required');
  const r = await enable(packs, 'owner');
  assert.equal(r.ok, true);
  const reg = one(db, `SELECT * FROM packs_registry WHERE id='example'`);
  assert.equal(reg.enabled, 1); assert.equal(reg.enabled_by, 'owner'); assert.equal(reg.enabled_at, '2026-11-11 10:00:00');
  assert.equal(reg.card_text_shown, exampleManifest().enable_gate);
  assert.equal(reg.decision_id, r.decisionId);
  const dec = one(db, `SELECT * FROM kernel_decisions WHERE id = ?`, r.decisionId);
  assert.equal(dec.authority, 'person:owner'); assert.match(dec.revert_path, /disablePack/);

  const steps = await packs.packSteps();
  assert.deepEqual(steps.map(s => s.name), ['pack:example:noop-notify']);
  await consented(guard);
  await runTick(db, { config: tickConfig, now: T0, extraSteps: steps });
  assert.equal(channel.sent.length, 1);

  assert.equal((await packs.disablePack('example')).ok, true);
  assert.equal((await packs.packSteps()).length, 0);
  await steps[0].run(db, { tickId: 2, errors: [], notes: [], now: T0 });                // a stale step list still does nothing
  assert.equal(channel.sent.length, 1);
  assert.equal((await guard.send(msg({ idempotencyKey: 'k2' }))).reason, 'pack_disabled');
  assert.equal(one(db, `SELECT COUNT(*) n FROM roles`).n, 0);
});

test('R04 enabling seeds the manager role, charter, primary and guard metrics and a plus item into the kernel records', async () => {
  const { db, packs } = setup();
  await enable(packs);
  assert.equal(one(db, `SELECT id FROM roles WHERE id='pack-manager-example'`).id, 'pack-manager-example');
  const prog = one(db, `SELECT * FROM kernel_programs WHERE id='pack-example'`);
  assert.equal(prog.primary_metric_id, 'example_notices_7d'); assert.equal(prog.owner_role, 'pack-manager-example');
  const metrics = rows(db, `SELECT id, kind FROM kernel_metrics WHERE program_id='pack-example' ORDER BY id`);
  assert.deepEqual(metrics.map(m => m.id), ['example_notices_7d', 'example_refusals_7d', 'example_sends_24h']);
  assert.ok(metrics.some(m => m.kind === 'guard'));
  const plus = one(db, `SELECT kind, owner_role, project FROM items WHERE id='PACKPLUS-example-1'`);
  assert.deepEqual({ ...plus }, { kind: 'plus', owner_role: 'pack-manager-example', project: 'pack-example' });
  assert.equal((await packs.status())[0].enabled, 1);
});

test('enabling works, with its own decision record, when the kernel tables are not installed', async () => {
  const { db, packs } = setup({ kernel: false });
  // roles and items come from the seed schema; only kernel_* tables are absent
  const r = await enable(packs);
  assert.equal(r.ok, true); assert.equal(r.kernelRecords, false);
  assert.match(one(db, `SELECT decision_id FROM packs_registry`).decision_id, /^pack-enable-example-/);
});

test('re-registering an enabled pack with a changed manifest is refused', async () => {
  const { packs } = setup();
  await enable(packs);
  const m = exampleManifest(); m.version = '0.2.0';
  const r = await packs.register(m, { dir: EXAMPLE_DIR });
  assert.equal(r.ok, false); assert.match(r.errors[0], /disable it first/);
});

// ---- T21-2: manifest refusals (R02, R11) ----
test('T21-2 manifest validation refuses missing fields, class C outbound, out-of-bounds scope, outbound without a block, tenant names', () => {
  assert.deepEqual(validateManifest(exampleManifest()), []);
  const bad = (mut, re, opts) => {
    const m = exampleManifest(); mut(m);
    const errs = validateManifest(m, opts);
    assert.ok(errs.some(e => re.test(e)), `expected ${re} in ${JSON.stringify(errs)}`);
  };
  for (const f of ['id', 'name', 'version', 'class', 'scope', 'charter', 'requires', 'loops', 'enable_gate']) bad(m => { delete m[f]; }, new RegExp(`missing required field: ${f}`));
  bad(m => { m.class = 'C'; }, /class C/);
  bad(m => { m.class = 'C'; m.loops[0].outbound = false; delete m.outbound; m.outbound = { channels: ['fake'] }; }, /class C/);
  bad(m => { delete m.outbound; }, /no outbound block/);
  bad(m => { m.charter.guard_metrics = []; }, /guard_metrics needs at least one/);
  bad(m => { m.charter.primary_metric.id = 'other_metric'; }, /must start with "example_"/);
  bad(m => { m.requires.secrets = ['sk-live-abcdef0123456789']; }, /names only/);
  bad(m => { m.outbound.suppression = false; }, /suppression must be true/);
  bad(m => { m.loops[0].entry = '../escape.js#run'; }, /inside the pack directory/);
  const oob = {
    money_movement: 'Buys ads and transfers funds to vendors',
    signing_or_filing: 'Files patent applications with the patent office',
    impersonation: 'Posts as a person on their behalf',
    disinformation: 'Runs fake accounts to amplify posts',
    surveillance: 'Tracks individuals across sites',
    bypass_controls: 'Bypasses rate limits and solves captchas',
    other_credentials: "Stores another person's passwords",
  };
  for (const [name, line] of Object.entries(oob)) bad(m => { m.scope.does.push(line); }, new RegExp(`out of bounds \\(${name}\\)`));
  bad(m => { m.defaults = { sender: 'news@acme-corp.io' }; }, /real host/);
  bad(m => { m.defaults = { owner: 'Acme Corp' }; }, /names a tenant/, { tenantNames: ['acme corp'] });
  bad(m => { m.defaults = { account: '0123456789abcdef0123456789abcdef' }; }, /account id/);
  assert.deepEqual(validateManifest({ ...exampleManifest(), defaults: { host: 'mail.example.com', local: 'dev.localhost' } }), []);
});

test('register stores nothing for an invalid manifest', async () => {
  const { db, packs } = setup();
  const m = exampleManifest(); m.class = 'C';
  const r = await packs.register(m, { dir: EXAMPLE_DIR });
  assert.equal(r.ok, false);
  assert.equal(one(db, `SELECT COUNT(*) n FROM packs_registry`).n, 0);
});

// ---- T21-3: refusals recorded in the ledger (R06, R13) ----
test('T21-3 no consent, suppressed, over cap and duplicate sends are not delivered and the ledger says why', async () => {
  const { db, packs, guard, channel } = setup();
  await enable(packs);
  assert.equal((await guard.send(msg())).reason, 'no_consent');
  const { token } = await guard.consent.request({ channel: 'fake', recipient: 'person@example.com' });
  assert.equal((await guard.send(msg())).reason, 'consent_not_confirmed');            // double opt-in: pending is not enough
  await guard.consent.confirm(token);
  assert.equal((await guard.send(msg({ idempotencyKey: 'a' }))).decision, 'sent');
  const dup = await guard.send(msg({ idempotencyKey: 'a' }));
  assert.deepEqual([dup.decision, dup.reason], ['refused', 'duplicate_idempotency_key']);
  assert.equal((await guard.send(msg({ idempotencyKey: 'b' }))).decision, 'sent');
  assert.equal((await guard.send(msg({ idempotencyKey: 'c' }))).reason, 'cap_per_day');   // per_day is 2
  assert.equal(channel.sent.length, 2);
  await guard.suppress({ channel: 'fake', recipient: 'Person@Example.com', reason: 'bounce' });
  assert.equal((await guard.send(msg({ idempotencyKey: 'd' }))).reason, 'suppressed');
  const reasons = rows(db, `SELECT decision, reason FROM guard_ledger ORDER BY id`).map(r => `${r.decision}:${r.reason}`);
  assert.deepEqual(reasons, ['refused:no_consent', 'refused:consent_not_confirmed', 'sent:null', 'refused:duplicate_idempotency_key', 'sent:null', 'refused:cap_per_day', 'refused:suppressed']
    .map(s => s.replace(':null', ':null')));
});

test('per-week cap applies across days; the day cap resets', async () => {
  const clock = { t: T0 };
  const { packs, guard, channel } = setup({ clock });
  await enable(packs); await consented(guard);
  let n = 0;
  for (let d = 0; d < 3; d++) { for (let i = 0; i < 2; i++) await guard.send(msg({ idempotencyKey: `k${n++}` })); clock.t += 86400e3; }
  assert.equal(channel.sent.length, 5);                                                // 2+2 then 1 of the third day: week cap 5
  assert.equal((await guard.send(msg({ idempotencyKey: 'late' }))).reason, 'cap_per_week');
});

test('content rules: empty, over the channel limit, secret patterns, missing sender identification', async () => {
  const channel = fakeChannel({ maxLength: 20, senderId: 'Sent by Example' });
  const { packs, guard } = setup({ channel });
  await enable(packs); await consented(guard);
  assert.equal((await guard.send(msg({ content: '   ', idempotencyKey: '1' }))).reason, 'content_empty');
  assert.equal((await guard.send(msg({ content: 'x'.repeat(30), idempotencyKey: '2' }))).reason, 'content_too_long');
  assert.equal((await guard.send(msg({ content: 'hi', idempotencyKey: '3' }))).reason, 'sender_identification_missing');
  const ok = await guard.send(msg({ content: 'hi Sent by Example', idempotencyKey: '4' }));
  assert.equal(ok.decision, 'sent');
  for (const [i, s] of ['ghp_' + 'a'.repeat(30), 'AKIA' + 'B'.repeat(16), 'password=hunter2hunter2', '-----BEGIN PRIVATE KEY-----', 'Bearer ' + 'z'.repeat(30)].entries()) {
    const channel2 = fakeChannel();
    const r = await guard.send(msg({ content: `see ${s}`, idempotencyKey: `s${i}` }));
    assert.equal(r.reason === 'content_secret_pattern' || r.reason === 'content_too_long', true, s);
    assert.equal(channel2.sent.length, 0);
  }
});

// ---- T21-4: approval by rung (s6) ----
test('T21-4 below the act rung an action is queued as a decision card and not sent; approving delivers it', async () => {
  const { db, packs, guard, channel } = setup({ rung: 'assisted' });
  await enable(packs); await consented(guard);
  const r = await guard.send(msg());
  assert.equal(r.decision, 'queued_for_approval');
  assert.equal(channel.sent.length, 0);
  const card = one(db, `SELECT * FROM gate_cards WHERE id = ?`, r.cardId);
  assert.equal(card.status, 'open'); assert.match(card.what, /hello there/);
  assert.equal((await guard.pending()).length, 1);
  assert.equal((await guard.send(msg())).reason, 'duplicate_idempotency_key');       // the queued one holds the key
  const a = await guard.approve(r.queueId, { by: 'owner' });
  assert.deepEqual([a.decision, a.providerId], ['sent', 'prov-1']);
  assert.equal(channel.sent.length, 1); assert.equal(channel.sent[0].content, 'hello there');
  const q = one(db, `SELECT * FROM guard_queue WHERE id = ?`, r.queueId);
  assert.deepEqual([q.status, q.decided_by, q.recipient, q.content], ['sent', 'owner', null, null]);
  assert.equal(one(db, `SELECT status FROM gate_cards WHERE id = ?`, r.cardId).status, 'closed');
  assert.deepEqual(rows(db, `SELECT decision FROM guard_ledger ORDER BY id`).map(x => x.decision), ['queued_for_approval', 'refused', 'sent']);
  assert.equal((await guard.approve(r.queueId)).reason, 'not_pending');
});

test('rejecting a queued item sends nothing; approval re-checks suppression, caps and switches at delivery time', async () => {
  const { packs, guard, channel } = setup({ rung: 'observed' });
  await enable(packs); await consented(guard);
  const a = await guard.send(msg({ idempotencyKey: 'a' }));
  const b = await guard.send(msg({ idempotencyKey: 'b', content: 'second' }));
  assert.equal((await guard.reject(a.queueId, { by: 'owner' })).reason, 'approval_rejected');
  await packs.setSwitch('pack:example', true, 'pause');
  assert.equal((await guard.approve(b.queueId, { by: 'owner' })).reason, 'kill_switch_pack');
  assert.equal(channel.sent.length, 0);
  const c = await guard.send(msg({ idempotencyKey: 'c' }));                           // refused by the switch, never queued
  assert.equal(c.reason, 'kill_switch_pack');
});

test('R12 earned trust above the class ceiling does not remove approval: a class B pack is capped', async () => {
  const { packs, guard, channel } = setup({ rung: 'self-extending', config: { act_rung: 'self-directed' } });
  await enable(packs); await consented(guard);
  assert.equal((await guard.send(msg())).decision, 'queued_for_approval');            // ceiling for B is autonomous < self-directed
  assert.equal(channel.sent.length, 0);
});

test('an outbound.approval of always queues even at a high rung', async () => {
  const { db, packs, guard } = setup({ rung: 'autonomous' });
  const m = exampleManifest(); m.outbound.approval = 'always';
  await packs.register(m, { dir: EXAMPLE_DIR }); await packs.enablePack('example', { by: 'owner', cardText: m.enable_gate });
  await consented(guard);
  assert.equal((await guard.send(msg())).decision, 'queued_for_approval');
  assert.equal(one(db, `SELECT COUNT(*) n FROM gate_cards`).n, 1);
});

// ---- T21-5: kill switches (R07) ----
test('T21-5 tripping one pack\'s switch stops that pack and no other; global and channel switches also hold', async () => {
  const { db, packs, guard, channel } = setup();
  await enable(packs); await consented(guard);
  // a second pack, same shape, to prove isolation
  const m2 = exampleManifest(); m2.id = 'second';
  m2.charter.primary_metric.id = 'second_notices_7d'; m2.charter.guard_metrics[0].id = 'second_refusals_7d';
  m2.loops[0].entry = './noop.js#run';
  await packs.register(m2, { dir: EXAMPLE_DIR });
  await packs.enablePack('second', { by: 'owner', cardText: m2.enable_gate });
  db.raw.prepare(`INSERT INTO trust_ledger (surface, action_class, rung, reliability, outcomes) VALUES ('pack:second','notice','delegated',1,50)`).run();

  await packs.setSwitch('pack:example', true, 'test');
  const steps = await packs.packSteps();
  assert.equal(steps.length, 2);
  const ctx = () => ({ tickId: 4, errors: [], notes: [], now: T0 });
  for (const s of steps) await s.run(db, ctx());
  const runs = rows(db, `SELECT pack_id, outcome FROM packs_runs ORDER BY id`).map(r => ({ ...r }));
  assert.deepEqual(runs, [{ pack_id: 'example', outcome: 'skipped_killed' }, { pack_id: 'second', outcome: 'ok' }]);
  assert.equal((await guard.send(msg({ idempotencyKey: 'x' }))).reason, 'kill_switch_pack');
  // consent given to one pack is not consent for another; a pack bound to 'second' cannot send as 'example'
  await guard.consent.revoke({ channel: 'fake', recipient: 'person@example.com' });
  const { token } = await packs.boundGuard('example').consent.request({ channel: 'fake', recipient: 'person@example.com' });
  await guard.consent.confirm(token);
  const y = await packs.boundGuard('second').send({ ...msg({ idempotencyKey: 'y' }), pack: 'example' });
  assert.match(y.reason, /^consent_revoked$|^no_consent$/);
  await packs.setSwitch('pack:example', false);
  assert.equal((await guard.send(msg({ idempotencyKey: 'z' }))).decision, 'sent');
  await packs.setSwitch('channel:fake', true);
  assert.equal((await guard.send(msg({ idempotencyKey: 'w' }))).reason, 'kill_switch_channel');
  await packs.setSwitch('channel:fake', false); await packs.setSwitch('global', true);
  assert.equal((await guard.send(msg({ idempotencyKey: 'v' }))).reason, 'kill_switch_global');
  assert.equal(channel.sent.length, 1);
});

// ---- T21-6: a throwing step files an item, the tick completes (R05) ----
test('T21-6 a pack step that throws or hangs files an item and the tick completes', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pack-throw-'));
  mkdirSync(path.join(dir, 'p'));
  writeFileSync(path.join(dir, 'p', 'boom.mjs'), `export async function run() { throw new Error('kaboom'); }\nexport async function slow() { await new Promise(r => setTimeout(r, 2000)); }\n`);
  const m = exampleManifest(); m.id = 'boomer'; m.class = 'A'; delete m.outbound; delete m.defaults;
  m.charter.primary_metric.id = 'boomer_x'; m.charter.guard_metrics[0].id = 'boomer_y';
  m.loops = [{ id: 'boom', every_ticks: 1, entry: './boom.mjs#run', outbound: false }, { id: 'slow', every_ticks: 1, entry: './boom.mjs#slow', outbound: false }];
  const { db, packs } = setup({ rung: null });
  assert.deepEqual((await packs.register(m, { dir: path.join(dir, 'p') })).errors, undefined);
  await packs.enablePack('boomer', { by: 'owner', cardText: m.enable_gate });
  const r = await runTick(db, { config: tickConfig, now: T0, extraSteps: await packs.packSteps() });
  assert.equal(r.total, 9);
  assert.equal(r.completed, 9);                                                       // every step ran to its end
  assert.ok(r.errors.some(e => /kaboom/.test(e)) && r.errors.some(e => /exceeded 200 ms/.test(e)));
  const items = rows(db, `SELECT id, owner_role, priority FROM items WHERE id LIKE 'PACKFAIL-boomer-%'`);
  assert.equal(items.length, 2); assert.ok(items.every(i => i.owner_role === 'pack-manager-boomer' && i.priority === 0));
  assert.deepEqual(rows(db, `SELECT loop_id, outcome FROM packs_runs ORDER BY id`).map(x => `${x.loop_id}:${x.outcome}`), ['boom:error', 'slow:timeout']);
});

test('every_ticks gates a loop and runs are counted', async () => {
  const { db, packs, guard } = setup();
  const m = exampleManifest(); m.loops[0].every_ticks = 3;
  await packs.register(m, { dir: EXAMPLE_DIR }); await packs.enablePack('example', { by: 'owner', cardText: m.enable_gate });
  await consented(guard);
  const [step] = await packs.packSteps();
  for (const tickId of [1, 2, 3, 4, 5, 6]) await step.run(db, { tickId, errors: [], notes: [], now: T0 });
  assert.deepEqual(rows(db, `SELECT tick_id FROM packs_runs`).map(r => r.tick_id), [3, 6]);
});

// ---- class rules (R12) ----
test('T21 class C can never send, even if a manifest is forced into the registry; class D must route through deploy', async () => {
  const { db, guard } = setup({ rung: 'autonomous' });
  const base = exampleManifest();
  for (const cls of ['C', 'D']) {
    const m = { ...base, id: `cls${cls.toLowerCase()}`, class: cls };
    db.raw.prepare(`INSERT INTO packs_registry (id, class, manifest_hash, manifest_json, rung_ceiling, enabled, registered_at) VALUES (?,?,?,?,?,1,'2026-11-11 10:00:00')`)
      .run(m.id, cls, 'h', JSON.stringify(m), 'autonomous');
    db.raw.prepare(`INSERT INTO trust_ledger (surface, action_class, rung, reliability, outcomes) VALUES (?, 'notice', 'self-extending', 1, 99)`).run(`pack:${m.id}`);
    await guard.consent.grant({ channel: 'fake', recipient: 'person@example.com' });
  }
  assert.equal((await guard.send(msg({ pack: 'clsc' }))).reason, 'class_c_never_sends');
  assert.equal((await guard.send(msg({ pack: 'clsd' }))).reason, 'class_d_requires_deploy');
  assert.equal((await guard.send(msg({ pack: 'clsd', viaDeploy: true }))).decision, 'sent');
  assert.equal((await guard.send({ ...msg({ pack: 'nonexistent' }) })).reason, 'pack_disabled');
});

test('a channel the manifest does not declare is refused', async () => {
  const { packs, guard } = setup();
  await enable(packs);
  assert.equal((await guard.send(msg({ channel: 'sms' }))).reason, 'channel_not_declared');
});

test('a delivery failure is a refusal with the provider error, and does not burn the idempotency key', async () => {
  const bad = fakeChannel({ fail: true });
  const { db, packs, guard } = setup({ channel: bad });
  await enable(packs); await consented(guard);
  const r = await guard.send(msg());
  assert.equal(r.decision, 'refused'); assert.match(r.reason, /delivery_failed: provider down/);
  bad.send = async () => ({ id: 'ok-1' });
  assert.equal((await guard.send(msg())).decision, 'sent');
  assert.equal(one(db, `SELECT COUNT(*) n FROM guard_ledger WHERE decision='sent'`).n, 1);
});

// ---- T21-8: secrets (R09) ----
test('T21-8 a secret value never appears in any table; the ledger holds hashes, not recipients or content', async () => {
  const { db, packs, guard } = setup();
  await enable(packs); await consented(guard);
  const secret = 'ghp_' + 'Q'.repeat(36);
  const r = await guard.send(msg({ content: `token is ${secret}`, idempotencyKey: 'sec' }));
  assert.equal(r.reason, 'content_secret_pattern');
  await guard.send(msg({ content: 'ordinary notice text', idempotencyKey: 'ok' }));
  const dump = JSON.stringify(rows(db, `SELECT name FROM sqlite_master WHERE type='table'`).map(t => [t.name, rows(db, `SELECT * FROM ${t.name}`)]));
  assert.ok(!dump.includes(secret));
  const led = rows(db, `SELECT * FROM guard_ledger`);
  assert.ok(led.every(l => /^[0-9a-f]{64}$/.test(l.recipient_hash) && /^[0-9a-f]{64}$/.test(l.content_hash)));
  assert.ok(!JSON.stringify(led).includes('person@example.com') && !JSON.stringify(led).includes('ordinary notice'));
  assert.ok(!JSON.stringify(rows(db, `SELECT * FROM guard_consent`)).includes('person@example.com'));
  assert.ok(!JSON.stringify(rows(db, `SELECT * FROM guard_suppression`)).includes('person@example.com'));
});

// ---- R13: unsubscribe and suppression are immediate and need no approval ----
test('R13 unsubscribe is immediate, needs no approval, revokes consent and cancels queued items', async () => {
  const { db, packs, guard, channel } = setup({ rung: 'observed' });
  await enable(packs); await consented(guard);
  const queued = await guard.send(msg());
  assert.equal(queued.decision, 'queued_for_approval');
  await guard.unsubscribe({ recipient: 'person@example.com' });                         // no card, no approval
  assert.equal(one(db, `SELECT COUNT(*) n FROM gate_cards WHERE what LIKE '%unsubscribe%'`).n, 0);
  assert.equal(one(db, `SELECT status FROM guard_consent`).status, 'revoked');
  assert.equal(one(db, `SELECT status FROM guard_queue WHERE id = ?`, queued.queueId).status, 'rejected');
  assert.equal((await guard.send(msg({ idempotencyKey: 'n' }))).reason, 'suppressed');
  assert.equal((await guard.approve(queued.queueId)).reason, 'not_pending');
  assert.deepEqual((await guard.consent.request({ channel: 'fake', recipient: 'person@example.com' })), { ok: false, reason: 'suppressed' });
  assert.equal(channel.sent.length, 0);
  assert.equal(one(db, `SELECT reason FROM guard_suppression`).reason, 'unsubscribe');
});

test('consent: single opt-in grant, revoke, and consent mode none needs no record', async () => {
  const { packs, guard, channel } = setup();
  const m = exampleManifest(); m.outbound.consent = 'single_opt_in';
  await packs.register(m, { dir: EXAMPLE_DIR }); await packs.enablePack('example', { by: 'owner', cardText: m.enable_gate });
  assert.equal((await guard.send(msg())).reason, 'no_consent');
  await guard.consent.grant({ channel: 'fake', recipient: 'person@example.com' });
  assert.equal((await guard.send(msg())).decision, 'sent');
  await guard.consent.revoke({ channel: 'fake', recipient: 'person@example.com' });
  assert.equal((await guard.send(msg({ idempotencyKey: 'r' }))).reason, 'consent_revoked');
  assert.equal((await guard.consent.confirm('not-a-token')).ok, false);
  assert.equal(channel.sent.length, 1);
});

// ---- R03 / T21-7: static check ----
test('T21-7 no core or adapter module imports a pack module (static check over core/ and adapters/)', () => {
  assert.deepEqual(assertCoreImportsNoPacks(ROOT), []);
});

test('T21-7 the static check catches a core file importing a pack, static or dynamic', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'core-'));
  mkdirSync(path.join(root, 'core', 'packs', 'foo'), { recursive: true });
  writeFileSync(path.join(root, 'core', 'packs', 'foo', 'pack.json'), '{}');
  writeFileSync(path.join(root, 'core', 'ok.js'), `import a from './packs/host.js';\n`);
  assert.deepEqual(assertCoreImportsNoPacks(root), []);
  writeFileSync(path.join(root, 'core', 'bad.js'), `import { x } from './packs/foo/loop.js';\n`);
  assert.throws(() => assertCoreImportsNoPacks(root), /bad\.js imports pack module/);
  writeFileSync(path.join(root, 'core', 'bad.js'), `const m = await import('./packs/foo/loop.js');\n`);
  assert.throws(() => assertCoreImportsNoPacks(root), /bad\.js imports pack module/);
});

test('R14 one guard implementation: packs get a bound view of it, with no way to name another pack', async () => {
  const { packs, guard } = setup();
  await enable(packs);
  const view = packs.boundGuard('example');
  assert.deepEqual(Object.keys(view).sort(), ['consent', 'send', 'stats', 'suppress', 'unsubscribe']);
  assert.equal(typeof guard.approve, 'function'); assert.equal(view.approve, undefined);  // a pack cannot approve its own queue
});
