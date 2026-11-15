// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { makeDb } from '../_shared/testdb.js';
import { acquire, recordPull, metrics } from './index.js';
import * as gate from './gate.js';

const mig = fileURLToPath(new URL('./migrations/', import.meta.url));
function mk(extra = {}) {
  const clock = { t: Date.parse('2026-03-02T12:00:00Z') };
  return { ctx: { db: makeDb([mig]), now: () => clock.t, config: {}, ...extra }, clock };
}
const one = async (ctx, sql, ...a) => ctx.db.prepare(sql).bind(...a).first();
const all = async (ctx, sql, ...a) => (await ctx.db.prepare(sql).bind(...a).all()).results;
const item = (ctx, id, status = 'open', disposition = null) => ctx.db.prepare(`INSERT INTO items (id,title,owner_role,done_check,status,disposition) VALUES (?,?,?,?,?,?)`).bind(id, id, 'staff', 'x', status, disposition).run();
const status = async (ctx, id) => (await one(ctx, `SELECT status FROM items WHERE id = ?`, id)).status;

test('US-08-R11: an accounting gap blocks closure of the parents of the unaccounted items until they are accounted for', async () => {
  const { ctx } = mk();
  for (const id of ['epic', 'story', 'c1', 'c2', 'c3', 'other']) await item(ctx, id);
  await gate.setParent(ctx, 'story', 'epic');
  for (const c of ['c1', 'c2', 'c3']) await gate.setParent(ctx, c, 'story');
  const run = await gate.recordLoopRunGated(ctx, { loop: 'drain', scanned_ids: ['c1', 'c2', 'c3'], executed: ['c1'], failed: [], needs_human: [], no_action: [] });
  assert.equal(run.gap, 2);
  assert.deepEqual(run.reopened, ['c2', 'c3']);
  assert.deepEqual(run.blocked_parents, ['story', 'epic']);              // every ancestor, not only the direct parent
  assert.deepEqual(await gate.closureAllowed(ctx, 'story'), { allowed: false, reason: 'unaccounted_children', blocked_by: ['c2', 'c3'], incidents: [run.incident_id] });
  assert.deepEqual(await gate.closeItem(ctx, { item_id: 'story', disposition: 'all children shipped' }), { ok: false, reason: 'unaccounted_children', blocked_by: ['c2', 'c3'] });
  assert.equal((await gate.closeItem(ctx, { item_id: 'epic', disposition: 'shipped' })).ok, false);
  assert.equal((await gate.closeItem(ctx, { item_id: 'other', disposition: 'shipped' })).ok, true); // unrelated items are not held
  assert.equal((await gate.loopGate(ctx, 'drain')).pass, false);
  // the children are accounted for, with dispositions
  assert.equal((await gate.closeItem(ctx, { item_id: 'c2', disposition: 'fixed in change 12' })).ok, true);
  assert.equal((await gate.closeItem(ctx, { item_id: 'c3', status: 'superseded', disposition: 'replaced by c2' })).ok, true);
  let e = await gate.enforceGate(ctx);
  assert.deepEqual([e.cleared, e.incidents_closed], [4, 0]);             // blocks clear; the incident waits for a balanced run
  assert.equal((await gate.closeItem(ctx, { item_id: 'story', disposition: 'all children shipped' })).ok, true);
  await gate.recordLoopRunGated(ctx, { loop: 'drain', scanned: 2, executed: 1, no_action: 1 });
  e = await gate.enforceGate(ctx);
  assert.equal(e.incidents_closed, 1);
  assert.equal((await gate.loopGate(ctx, 'drain')).pass, true);
});

test('US-08-R11: a blocked parent closed around the gate is reopened automatically on the next tick', async () => {
  const { ctx } = mk();
  for (const id of ['parent', 'child']) await item(ctx, id);
  await gate.setParent(ctx, 'child', 'parent');
  await gate.recordLoopRunGated(ctx, { loop: 'exec', scanned_ids: ['child'], executed: [], failed: [], needs_human: [], no_action: [] });
  await ctx.db.prepare(`UPDATE items SET status = 'done', disposition = 'closed by hand' WHERE id = 'parent'`).run();
  const e = await gate.enforceGate(ctx);
  assert.deepEqual(e.reopened, ['parent']);
  assert.equal(await status(ctx, 'parent'), 'open');
  assert.equal((await one(ctx, `SELECT COUNT(*) AS n FROM outcomes WHERE item_id = 'parent' AND action_class = 'closure_gate'`)).n, 1);
  assert.deepEqual((await gate.enforceGate(ctx)).reopened, []);          // nothing left to reopen
});

test('US-08-R11: a count-only gap (scanned 25, booked 0) closes the loop gate; closing needs a disposition; cycles are refused', async () => {
  const { ctx } = mk();
  await item(ctx, 'a'); await item(ctx, 'b');
  const run = await gate.recordLoopRunGated(ctx, { loop: 'executor', scanned: 25 });
  assert.deepEqual([run.gap, run.blocked_parents], [25, []]);
  const g = await gate.loopGate(ctx, 'executor');
  assert.deepEqual([g.pass, g.reason], [false, 'accounting_gap']);
  assert.match(g.detail, /scanned 25, accounted 0, gap 25/);
  assert.equal((await gate.loopGate(ctx, 'another-loop')).pass, true);
  assert.deepEqual(await gate.closeItem(ctx, { item_id: 'a', disposition: ' ' }), { ok: false, reason: 'disposition_required' });
  assert.equal(await status(ctx, 'a'), 'open');
  await gate.setParent(ctx, 'a', 'b');
  await assert.rejects(() => gate.setParent(ctx, 'b', 'a'), /cycle/);
});

test('US-08 s5: visibility ratio is open in all stores over open visible to operations tools; it fires above 2', async () => {
  const hidden = Array.from({ length: 303 }, (_, i) => ({ key: `h${i}`, status: 'open' }));
  const seen = [...Array.from({ length: 12 }, (_, i) => ({ key: `v${i}`, status: 'open' })), { key: 'v-done', status: 'done' }, { key: 'v-closed', status: 'closed' }];
  const { ctx } = mk();
  const stores = [{ name: 'tracker-a', visible: true, list: async () => seen }, { name: 'tracker-b', visible: false, list: async () => hidden }];
  const v = await gate.visibilityRatio(ctx, { stores });
  assert.deepEqual([v.open_all, v.open_visible, v.fired], [315, 12, true]);
  assert.equal(v.ratio, 315 / 12);
  assert.ok(await one(ctx, `SELECT id FROM items WHERE id = 'VISIBILITY-RATIO'`));
  assert.equal((await metrics(ctx)).open_incidents, 1);
  assert.equal((await gate.visibilityRatio(ctx, { stores })).incident_id, null);   // one open incident, not one per reading
  // the tools now read both stores: the ratio is 1 and the incident closes
  const fixed = await gate.visibilityRatio(ctx, { stores: stores.map(s => ({ ...s, visible: true })) });
  assert.deepEqual([fixed.ratio, fixed.fired], [1, false]);
  assert.equal((await metrics(ctx)).open_incidents, 0);
  assert.equal((await one(ctx, `SELECT COUNT(*) AS n FROM claims_visibility`)).n, 3);
});

test('US-08 s5: the same key in two stores counts once; exactly 2 does not fire; an unreadable store is unmeasured, not empty', async () => {
  const { ctx } = mk();
  await item(ctx, 'i1'); await item(ctx, 'i2'); await item(ctx, 'i3', 'done', 'shipped');
  const mirror = { name: 'mirror', visible: false, list: async () => [{ key: 'i1', status: 'open' }, { key: 'i2', status: 'open' }, { key: 'x1', status: 'open' }, { key: 'x2', status: 'open' }] };
  const v = await gate.visibilityRatio(ctx, { stores: [gate.itemsStore(ctx), mirror] });
  assert.deepEqual([v.open_all, v.open_visible, v.ratio, v.fired], [4, 2, 2, false]);
  const down = await gate.visibilityRatio(ctx, { stores: [gate.itemsStore(ctx), { name: 'remote', visible: false, list: async () => { throw new Error('timeout'); } }] });
  assert.deepEqual([down.unread, down.fired], [['remote'], false]);
  const blind = await gate.visibilityRatio(ctx, { stores: [{ name: 'only-hidden', visible: false, list: async () => [{ key: 'k', status: 'open' }] }] });
  assert.deepEqual([blind.ratio, blind.fired], [null, true]);            // work exists and the tools see none of it
  assert.equal((await gate.visibilityRatio(ctx, { stores: [] })).reason, 'no_stores');
});

test('US-08 s6: a step with an identity-bound line is held as one card; a step without one is rerouted to the staff', async () => {
  const { ctx } = mk();
  await item(ctx, 'pay'); await item(ctx, 'rename');
  const held = await gate.routeToPrincipal(ctx, { item_id: 'pay', what: 'Approve the invoice', why_gated: 'spends money', default_in_effect: 'the invoice stays unpaid',
    closing_probe: 'item_done:pay', identity_bound_line: 'Payment from the owner account: irreversible and identity-bound.' });
  assert.deepEqual(held, { held: true, rerouted: false, card: 'gate-pay' });
  assert.equal(await status(ctx, 'pay'), 'blocked');
  const moved = await gate.routeToPrincipal(ctx, { item_id: 'rename', what: 'Rename the branch', why_gated: 'unsure' });
  assert.deepEqual(moved, { held: false, rerouted: true, card: null, owner_role: 'staff' });
  assert.deepEqual(await one(ctx, `SELECT status, owner_role FROM items WHERE id = 'rename'`), { status: 'ready', owner_role: 'staff' });
  assert.equal((await one(ctx, `SELECT COUNT(*) AS n FROM gate_cards`)).n, 1);
  await assert.rejects(() => gate.routeToPrincipal(ctx, { item_id: 'pay', what: 'w', identity_bound_line: 'signing' }), /default in effect/);
});

test('US-08 s6: open cards without an identity-bound line are a metric with target zero and are rerouted to the staff', async () => {
  const { ctx } = mk();
  await item(ctx, 'held-item', 'blocked');
  const card = (id, why) => ctx.db.prepare(`INSERT INTO gate_cards (id, what, why_gated, default_in_effect, closing_probe) VALUES (?,?,?,?,?)`).bind(id, `do ${id}`, why, 'nothing changes', 'manual').run();
  await card('gate-held-item', 'the doer was not sure how to proceed');
  await card('loose', 'needs a decision on naming');
  await card('real', 'This transfers money. It cannot be undone.');
  await card('kernel-style', 'irreversible and identity-bound step remains');
  assert.deepEqual((await gate.cardsWithoutIdentityLine(ctx)).map(c => c.id), ['gate-held-item', 'loose']);
  const r = await gate.rerouteCards(ctx);
  assert.deepEqual([r.cards_without_identity_line_before, r.cards_without_identity_line], [2, 0]);
  assert.deepEqual(r.rerouted, [{ card: 'gate-held-item', item: 'held-item' }, { card: 'loose', item: 'REROUTE-loose' }]);
  assert.deepEqual(await one(ctx, `SELECT status, owner_role, blocker FROM items WHERE id = 'held-item'`), { status: 'ready', owner_role: 'staff', blocker: null });
  assert.deepEqual(await one(ctx, `SELECT status, owner_role FROM items WHERE id = 'REROUTE-loose'`), { status: 'ready', owner_role: 'staff' });
  assert.deepEqual((await all(ctx, `SELECT id, status FROM gate_cards ORDER BY id`)).map(c => [c.id, c.status]), [['gate-held-item', 'closed'], ['kernel-style', 'open'], ['loose', 'closed'], ['real', 'open']]);
  assert.equal((await gate.rerouteCards(ctx)).rerouted.length, 0);
});

test('US-08-R07 / R10: a path-level claim carries token, expiry and fence previous + 1; the queue pull is recorded with puller, item and route', async () => {
  const { ctx, clock } = mk();
  const a = await acquire(ctx, { path: 'src/app.js', holder: 'agent-1', intent: 'fix login' });
  assert.match(a.token, /^[0-9a-f]{64}$/);
  assert.deepEqual([a.key, a.fence, a.expires_at], ['path:src/app.js', 1, '2026-03-02 14:00:00']);
  clock.t += 3 * 3600e3;
  const b = await acquire(ctx, { path: 'src/app.js', holder: 'agent-2', intent: 'other work' });
  assert.equal(b.fence, 2);
  await recordPull(ctx, { puller: 'agent-2', item_id: 'i1', route: 'queue:ready' });
  assert.deepEqual(await one(ctx, `SELECT puller, item_id, route FROM claims_pulls`), { puller: 'agent-2', item_id: 'i1', route: 'queue:ready' });
});

test('step: one tick enforces the gate, reroutes cards and reads the visibility ratio when stores are given', async () => {
  const { ctx } = mk();
  await item(ctx, 'i1');
  ctx.stores = [gate.itemsStore(ctx)];
  const s = await gate.step(ctx);
  assert.deepEqual(s, { gate: { cleared: 0, reopened: [], incidents_closed: 0 }, rerouted: 0, cards_without_identity_line: 0, visibility: { ratio: 1, fired: false } });
  assert.equal((await gate.step({ ...ctx, stores: undefined })).visibility, null);
});
