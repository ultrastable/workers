// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { makeDb } from '../_shared/testdb.js';
import { watchOwnerSteps, runCadence, probeCard } from './ownerwatch.js';

const mig = fileURLToPath(new URL('./migrations/', import.meta.url));
const H = 3600000;
const mk = (extra = {}) => { const s = { t: Date.parse('2026-06-10T00:00:00Z') }; const ctx = { db: makeDb([mig]), now: () => s.t, config: {}, env: {}, ...extra }; ctx.clock = s; return ctx; };
const card = (ctx, id, probe) => ctx.db.prepare("INSERT INTO gate_cards (id, what, why_gated, default_in_effect, closing_probe) VALUES (?,?,?,?,?)").bind(id, 'do ' + id, 'identity', 'staged', probe).run();
const status = async (ctx, id) => (await ctx.db.prepare('SELECT status FROM gate_cards WHERE id=?').bind(id).first()).status;

test('probe kinds: env, item_done, http, manual; a throwing probe fails closed', async () => {
  const ctx = mk({ env: { TOKEN: 'x' }, fetch: async u => ({ status: u.endsWith('ok') ? 204 : 500 }) });
  await ctx.db.prepare("INSERT INTO items (id,title,kind,owner_role,done_check,closing_probe,priority,status) VALUES ('I','t','work','o','d','p',1,'done')").run();
  const r = [];
  for (const p of ['env:TOKEN', 'env:NOPE', 'item_done:I', 'item_done:ZZ', 'http:https://h/ok', 'http:https://h/bad', 'manual']) r.push(await probeCard(ctx, { closing_probe: p }));
  assert.deepEqual(r, [true, false, true, false, true, false, false]);
  ctx.probe = () => { throw new Error('x'); };
  assert.equal(await probeCard(ctx, { closing_probe: 'env:TOKEN' }), false);
});

test('a passing probe closes the card and its escalation item; probes run on cadence, not every tick', async () => {
  const ctx = mk({ config: { probe_every_minutes: 60 } }); await card(ctx, 'C1', 'env:KEY');
  assert.equal((await watchOwnerSteps(ctx)).probed, 1);
  assert.equal((await watchOwnerSteps(ctx)).probed, 0);
  ctx.clock.t += 61 * 60000; ctx.env.KEY = 'v';
  const r = await watchOwnerSteps(ctx);
  assert.deepEqual([r.closed, await status(ctx, 'C1')], [1, 'closed']);
});

test('escalation: item after owner_step_hours (once), priority raised after twice that (once)', async () => {
  const ctx = mk({ config: { probe_every_minutes: 1 } }); await card(ctx, 'C2', 'manual');
  await watchOwnerSteps(ctx);
  ctx.clock.t += 25 * H; const a = await watchOwnerSteps(ctx);
  ctx.clock.t += 60000; const b = await watchOwnerSteps(ctx);
  assert.deepEqual([a.escalated, b.escalated], [1, 0]);
  ctx.clock.t += 25 * H; const c = await watchOwnerSteps(ctx); const d = await watchOwnerSteps(ctx);
  assert.deepEqual([c.raised, d.raised], [1, 0]);
  const it = await ctx.db.prepare("SELECT priority, owner_role FROM items WHERE id='OWNER-C2'").first();
  assert.deepEqual([it.priority, it.owner_role], [95, 'project-manager']);
});

test('cadence: skips probes not due; a fail streak files one item; recovery closes it', async () => {
  const ctx = mk(); let ok = false;
  const probes = [{ name: 'api', every_minutes: 10, run: async () => ok }];
  for (let i = 0; i < 3; i++) { await runCadence(ctx, probes); ctx.clock.t += 11 * 60000; }
  assert.equal((await ctx.db.prepare("SELECT status FROM items WHERE id='OPS-PROBE-api'").first()).status, 'open');
  assert.equal((await runCadence(ctx, probes)).filed, 0);
  ok = true; ctx.clock.t += 11 * 60000;
  assert.equal((await runCadence(ctx, probes)).recovered, 1);
  assert.equal((await runCadence(ctx, probes)).ran, 0);
  assert.equal((await ctx.db.prepare("SELECT status FROM items WHERE id='OPS-PROBE-api'").first()).status, 'done');
});
