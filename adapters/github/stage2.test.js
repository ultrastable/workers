// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { makeDb } from '../../core/_shared/testdb.js';
import { mirror, githubSink } from './steward.js';
import { githubTracker, compareStore, adopt, mirrorClaims, mirrorDecisions, stage2Probe } from './stage2.js';

const dirs = ['./migrations/', '../../core/kernel/migrations/'].map(d => fileURLToPath(new URL(d, import.meta.url)));
const T0 = Date.parse('2026-11-15T12:00:00Z');

/** A fake issue tracker speaking the REST shapes the adapter uses. */
function tracker() {
  const t = { issues: [], comments: [], n: 0 };
  t.fetch = async (url, init) => {
    const u = new URL(url), p = u.pathname.replace('/repos/example-org/code', ''), json = (o, s = 200) => new Response(JSON.stringify(o), { status: s });
    if (init.headers.authorization !== 'Bearer tracker-token') return json({}, 401);
    let m;
    if (p === '/issues' && init.method === 'GET') { const page = Number(u.searchParams.get('page')); return json(t.issues.filter(i => i.state === 'open').slice((page - 1) * 100, page * 100)); }
    if (p === '/issues' && init.method === 'POST') { const b = JSON.parse(init.body); const i = { number: ++t.n, title: b.title, body: b.body, state: 'open' }; t.issues.push(i); return json(i, 201); }
    if ((m = /^\/issues\/(\d+)$/.exec(p)) && init.method === 'PATCH') { const i = t.issues.find(x => x.number === Number(m[1])); Object.assign(i, JSON.parse(init.body)); return json(i); }
    if ((m = /^\/issues\/(\d+)\/comments$/.exec(p))) { const c = { id: t.comments.length + 1, issue: Number(m[1]), body: JSON.parse(init.body).body }; t.comments.push(c); return json(c, 201); }
    return json({}, 404);
  };
  return t;
}
function mk(t = tracker()) {
  const env = { VCS_TOKEN: 'tracker-token' }, at = { v: T0 };
  const ctx = { db: makeDb(dirs), now: () => at.v, at, config: {}, t, tracker: githubTracker({ fetch: t.fetch, repo: 'example-org/code', env }), sinks: [githubSink({ fetch: t.fetch, repo: 'example-org/code', env })] };
  return ctx;
}
const add = (ctx, id, status = 'open') => ctx.db.prepare("INSERT INTO items (id,title,owner_role,done_check,closing_probe,status,disposition) VALUES (?,?,'operations','the check','the probe',?,?)").bind(id, 'title ' + id, status, status === 'done' ? 'shipped' : null).run();

test('US-SPEC-20 stage 2 evidence: after the mirror, items in the store match the open issues', async () => {
  const ctx = mk();
  await add(ctx, 'A-1'); await add(ctx, 'A-2'); await add(ctx, 'A-3', 'done');
  const before = await stage2Probe(ctx);
  assert.deepEqual([before.result, before.missing_on_tracker], ['fail', ['A-1', 'A-2']]);
  assert.equal((await ctx.db.prepare("SELECT status FROM items WHERE id='STAGE2-MISMATCH'").first()).status, 'open');
  await mirror(ctx);
  const settled = await stage2Probe(ctx);
  assert.deepEqual([settled.result, settled.match, settled.matched.sort()], ['pass', true, ['A-1', 'A-2']]);
  await mirror(ctx);
  assert.equal((await stage2Probe(ctx)).result, 'pass', 'the probe does not keep itself failing through its own item');
  assert.equal(ctx.t.issues.filter(i => i.state === 'open').length, 2, 'the closed item and the resolved mismatch have closed issues');
  assert.equal((await ctx.db.prepare("SELECT status FROM items WHERE id='STAGE2-MISMATCH'").first()).status, 'done');
});

test('US-SPEC-20 stage 2: an issue opened on the tracker is adopted into the store with its owner role, done check and probe', async () => {
  const ctx = mk();
  ctx.t.issues.push({ number: ++ctx.t.n, title: 'Console shows the wrong total', body: 'Owner role: product\nDone check: the total equals the ledger\nClosing probe: sql:SELECT 1', state: 'open' });
  ctx.t.issues.push({ number: ++ctx.t.n, title: 'A pull request', body: '', state: 'open', pull_request: {} });
  const r = await stage2Probe(ctx);
  assert.deepEqual([r.result, r.adopted], ['pass', ['GH-1']], 'the pull request is not an issue');
  const it = await ctx.db.prepare("SELECT title, owner_role, done_check, closing_probe, status FROM items WHERE id='GH-1'").first();
  assert.deepEqual(it, { title: 'Console shows the wrong total', owner_role: 'product', done_check: 'the total equals the ledger', closing_probe: 'sql:SELECT 1', status: 'open' });
  assert.deepEqual((await stage2Probe(ctx)).adopted, [], 'adoption happens once');
  await mirror(ctx);
  assert.equal(ctx.t.issues.length, 2, 'the adopted item is linked to its issue, no duplicate is opened');
  const off = mk(); off.config = { stage2: { adopt: false } };
  off.t.issues.push({ number: ++off.t.n, title: 'x', body: '', state: 'open' });
  const o = await stage2Probe(off);
  assert.deepEqual([o.result, o.only_on_tracker], ['fail', ['1']]);
});

test('US-SPEC-20 stage 2: an item closed in the store whose issue is still open is a mismatch', () => {
  const c = compareStore([{ id: 'A', status: 'done' }, { id: 'B', status: 'open' }], [{ item_id: 'A', sink: 'github', ref: '1' }, { item_id: 'B', sink: 'github', ref: '2' }, { item_id: 'D-1', sink: 'github:decision', ref: '3' }],
    [{ number: '1' }, { number: '2' }, { number: '3' }]);
  assert.deepEqual(c, { matched: ['B'], missing_on_tracker: [], closed_in_store_open_on_tracker: ['A'], only_on_tracker: [], match: false });
});

test('US-SPEC-20 stage 2: claims in the store are mirrored as `claim:` comments, once per claim', async () => {
  const ctx = mk();
  await add(ctx, 'A-1'); await add(ctx, 'A-2');
  await ctx.db.prepare("INSERT INTO claims (item_id, agent, claimed_at, heartbeat_at) VALUES ('A-1','doer-1','2026-11-15 11:00:00','2026-11-15 11:00:00'), ('A-2','doer-2','2026-11-15 11:30:00','2026-11-15 11:30:00')").run();
  assert.deepEqual(await mirrorClaims(ctx), { posted: 0, skipped: 0, unplaced: 2, failed: 0 }, 'no issue yet, nothing to comment on');
  await mirror(ctx);
  assert.deepEqual(await mirrorClaims(ctx), { posted: 2, skipped: 0, unplaced: 0, failed: 0 });
  assert.deepEqual(ctx.t.comments.map(c => c.body), ['claim: doer-1 2026-11-15T11:00:00Z', 'claim: doer-2 2026-11-15T11:30:00Z']);
  assert.equal((await mirrorClaims(ctx)).skipped, 2);
  await ctx.db.prepare("UPDATE claims SET agent='doer-9', claimed_at='2026-11-15 12:00:00' WHERE item_id='A-1'").run();
  assert.equal((await mirrorClaims(ctx)).posted, 1, 'a new claim on the same item is a new comment');
  assert.equal(ctx.t.comments.length, 3);
});

test('US-SPEC-20 stage 2: decisions in the store are mirrored as their own issues and closed when settled; they are not orphans', async () => {
  const ctx = mk();
  await ctx.db.prepare("INSERT INTO kernel_decisions (id, decision, authority, prediction, revert_path, decided_at) VALUES ('D-1','route drafts to the cheap model','router policy','cost_per_merge <= 2 within 48 h','restore the ladder row','2026-11-15 12:00:00')").run();
  assert.deepEqual(await mirrorDecisions(ctx), { synced: 1, skipped: 0, failed: 0 });
  assert.match(ctx.t.issues[0].body, /Authority: router policy\nPrediction: cost_per_merge <= 2 within 48 h\nRevert path: restore the ladder row/);
  assert.equal((await mirrorDecisions(ctx)).skipped, 1);
  const p = await stage2Probe(ctx);
  assert.deepEqual([p.result, p.adopted], ['pass', []], 'the decision issue is known to the store');
  await ctx.db.prepare("UPDATE kernel_decisions SET status='kept' WHERE id='D-1'").run();
  await mirrorDecisions(ctx);
  assert.equal(ctx.t.issues[0].state, 'closed');
  const bare = { db: makeDb([dirs[0]]), now: () => T0, tracker: ctx.tracker };
  assert.equal((await mirrorDecisions(bare)).absent, true, 'without the kernel tables there are no decisions to mirror');
});

test('US-20-R11 an unreadable or partly read tracker is unknown, never a match; the token is read by name', async () => {
  const ctx = mk();
  ctx.tracker = githubTracker({ fetch: ctx.t.fetch, repo: 'example-org/code', env: {} });
  assert.deepEqual(await stage2Probe(ctx), { result: 'unknown', reason: 'stage2: token variable VCS_TOKEN is not set' });
  ctx.tracker = githubTracker({ fetch: ctx.t.fetch, repo: 'example-org/code', env: { VCS_TOKEN: 'wrong' } });
  assert.match((await stage2Probe(ctx)).reason, /http 401/);
  for (let i = 0; i < 150; i++) ctx.t.issues.push({ number: ++ctx.t.n, title: 'i' + i, body: '', state: 'open' });
  ctx.tracker = githubTracker({ fetch: ctx.t.fetch, repo: 'example-org/code', env: { VCS_TOKEN: 'tracker-token' }, maxPages: 1 });
  assert.equal((await stage2Probe(ctx)).result, 'unknown');
  assert.equal((await ctx.db.prepare('SELECT COUNT(*) AS n FROM items').first()).n, 0, 'nothing is adopted from a partial read');
  ctx.tracker = githubTracker({ fetch: ctx.t.fetch, repo: 'example-org/code', env: { VCS_TOKEN: 'tracker-token' } });
  assert.equal((await stage2Probe(ctx)).adopted.length, 150, 'paged reads see every issue');
  assert.throws(() => githubTracker({ fetch: ctx.t.fetch, repo: 'not a repo' }), /owner\/name/);
});
