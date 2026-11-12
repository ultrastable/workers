// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Tests for bounce and complaint intake (US-21-R13): every channel ends in guard.suppress, immediately and idempotently.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { makeDb } from '../_shared/testdb.js';
import { KERNEL_DIR } from '../kernel/testkit.js';
import { createPacks, loadManifest, MIGRATIONS_DIR } from './index.js';

const EXAMPLE_DIR = fileURLToPath(new URL('./example/', import.meta.url));
const T0 = Date.parse('2026-11-11T10:00:00Z');

async function setup(config = {}) {
  const db = makeDb([KERNEL_DIR, MIGRATIONS_DIR]);
  const clock = { t: T0 };
  const channel = { sent: [], send: async m => { channel.sent.push(m); return { id: `p${channel.sent.length}` }; } };
  const packs = createPacks({ db, now: () => clock.t, config: { rungs: undefined, bounces: config, packs: { example: {} } }, channels: { fake: channel, email: channel, social: channel } });
  const m = loadManifest(EXAMPLE_DIR);
  m.outbound.channels = ['fake', 'email', 'social'];
  m.outbound.caps = { fake: { per_day: 9, per_week: 9 }, email: { per_day: 9, per_week: 9 }, social: { per_day: 9, per_week: 9 } };
  m.outbound.consent = 'single_opt_in'; m.outbound.approval = 'by_rung';
  assert.equal((await packs.register(m, { dir: EXAMPLE_DIR })).ok, true);
  assert.equal((await packs.enablePack('example', { by: 'owner', cardText: m.enable_gate })).ok, true);
  db.raw.prepare(`INSERT INTO trust_ledger (surface, action_class, rung, reliability, outcomes) VALUES ('pack:example','notice','delegated',1,50)`).run();
  return { db, packs, clock, channel, guard: packs.guard };
}
const msg = (channel, o = {}) => ({ pack: 'example', channel, kind: 'notice', recipient: 'p@example.com', content: 'hello there', idempotencyKey: `k-${channel}-${Math.random()}`, ...o });
const reasons = (db) => db.raw.prepare(`SELECT reason FROM guard_suppression ORDER BY channel`).all().map(r => r.reason);

test('a hard bounce suppresses that channel at once; other channels for the person are untouched', async () => {
  const { db, packs, guard } = await setup();
  for (const ch of ['fake', 'email']) await guard.consent.grant({ channel: ch, recipient: 'p@example.com' });
  assert.equal((await guard.send(msg('email'))).decision, 'sent');
  const r = await packs.bounces.ingest({ channel: 'email', recipient: 'p@example.com', kind: 'hard', eventId: 'e1' });
  assert.deepEqual(r.results.map(x => x.action), ['suppressed:email']);
  assert.equal((await guard.send(msg('email'))).reason, 'suppressed');
  assert.equal((await guard.send(msg('fake'))).decision, 'sent');
  assert.deepEqual(reasons(db), ['bounce']);
});

test('a complaint or an unsubscribe suppresses every channel and cancels queued sends', async () => {
  for (const kind of ['complaint', 'unsubscribe']) {
    const { db, packs, guard } = await setup();
    for (const ch of ['fake', 'email', 'social']) await guard.consent.grant({ channel: ch, recipient: 'p@example.com' });
    db.raw.prepare(`UPDATE trust_ledger SET rung = 'assisted'`).run();                       // below the act rung: sends queue
    const q = await guard.send(msg('social'));
    assert.equal(q.decision, 'queued_for_approval');
    await packs.bounces.ingest({ channel: 'fake', recipient: 'P@Example.com ', kind });
    for (const ch of ['fake', 'email', 'social']) assert.equal((await guard.send(msg(ch))).reason, 'suppressed', `${kind} ${ch}`);
    assert.equal(db.raw.prepare(`SELECT status FROM guard_queue WHERE id = ?`).get(q.queueId).status, 'rejected');
    assert.deepEqual(reasons(db), [kind]);
    assert.equal((await guard.consent.grant({ channel: 'email', recipient: 'p@example.com' })).reason, 'suppressed');
  }
});

test('soft bounces are counted and suppress only at the limit inside the window', async () => {
  const { db, packs, clock, guard } = await setup({ soft_limit: 3, soft_window_days: 7 });
  await guard.consent.grant({ channel: 'email', recipient: 'p@example.com' });
  const soft = id => packs.bounces.ingest({ channel: 'email', recipient: 'p@example.com', kind: 'soft', eventId: id });
  assert.equal((await soft('s1')).results[0].action, 'counted');
  clock.t += 8 * 86400e3;                                                                  // first one ages out
  assert.equal((await soft('s2')).results[0].action, 'counted');
  assert.equal((await soft('s3')).results[0].action, 'counted');
  assert.equal(db.raw.prepare(`SELECT COUNT(*) n FROM guard_suppression`).get().n, 0);
  assert.equal((await soft('s4')).results[0].action, 'suppressed:email');
  assert.equal((await guard.send(msg('email'))).reason, 'suppressed');
});

test('a retried event id changes nothing', async () => {
  const { db, packs } = await setup({ soft_limit: 2 });
  const ev = { channel: 'email', recipient: 'p@example.com', kind: 'soft', eventId: 'same' };
  assert.equal((await packs.bounces.ingest(ev)).results[0].action, 'counted');
  assert.equal((await packs.bounces.ingest(ev)).results[0].action, 'duplicate');
  assert.equal(db.raw.prepare(`SELECT COUNT(*) n FROM guard_bounces`).get().n, 1);
  assert.equal(db.raw.prepare(`SELECT COUNT(*) n FROM guard_suppression`).get().n, 0);
});

test('provider email payloads: permanent, transient and complaint notifications, several recipients each', async () => {
  const { db, packs } = await setup();
  const r = await packs.bounces.ingest([
    { type: 'Bounce', bounceType: 'Permanent', id: 'n1', recipients: ['a@example.com', { emailAddress: 'b@example.com' }] },
    { type: 'Bounce', bounceType: 'Transient', id: 'n2', recipients: ['c@example.com'] },
    { notificationType: 'Complaint', id: 'n3', recipients: ['d@example.com'] },
  ], { format: 'email' });
  assert.deepEqual(r.results.map(x => x.action), ['suppressed:email', 'suppressed:email', 'counted', 'suppressed:*']);
  assert.equal(db.raw.prepare(`SELECT COUNT(*) n FROM guard_suppression`).get().n, 3);
  assert.equal((await packs.bounces.ingest({ type: 'Bounce', bounceType: 'Permanent', id: 'n1', recipients: ['a@example.com'] }, { format: 'email' })).results[0].action, 'duplicate');
});

test('bad input is reported without stopping the batch or storing an address', async () => {
  const { db, packs } = await setup();
  assert.equal((await packs.bounces.ingest({}, { format: 'nope' })).reason, 'unknown_format');
  assert.equal((await packs.bounces.ingest([], { format: 'generic' })).reason, 'no_events');
  const r = await packs.bounces.ingest([{ channel: 'email', recipient: '', kind: 'hard' }, { channel: 'email', recipient: 'ok@example.com', kind: 'weird' }, { channel: 'email', recipient: 'ok@example.com', kind: 'hard' }]);
  assert.deepEqual(r.results.map(x => x.ok), [false, false, true]);
  const dump = JSON.stringify(db.raw.prepare(`SELECT * FROM guard_bounces`).all());
  assert.ok(!dump.includes('ok@example.com'));
});

test('HTTP intake needs the shared secret and maps the query to channel and format', async () => {
  const { db, packs, guard } = await setup();
  await guard.consent.grant({ channel: 'email', recipient: 'a@example.com' });
  const post = (headers, body, q = '?channel=email&format=email') => packs.bounces.handle(new Request(`https://h.example/bounces${q}`, { method: 'POST', headers, body: JSON.stringify(body) }), { secret: 's3cret-value' });
  const payload = { type: 'Bounce', bounceType: 'Permanent', id: 'h1', recipients: ['a@example.com'] };
  assert.equal((await post({}, payload)).status, 401);
  assert.equal((await post({ 'x-bounce-token': 'wrong' }, payload)).status, 401);
  assert.equal((await packs.bounces.handle(new Request('https://h.example/bounces', { method: 'POST', body: '{}' }), {})).status, 401);
  const ok = await post({ 'x-bounce-token': 's3cret-value' }, payload);
  assert.equal(ok.status, 200);
  assert.equal(db.raw.prepare(`SELECT COUNT(*) n FROM guard_suppression`).get().n, 1);
  assert.equal((await post({ 'x-bounce-token': 's3cret-value' }, {}, '?format=nope')).status, 422);
});

test('the intake migration is idempotent', async () => {
  const { db } = await setup();
  const sql = readFileSync(new URL('./migrations/0003_guard_bounces.sql', import.meta.url), 'utf8');
  db.raw.exec(sql); db.raw.exec(sql);
});
