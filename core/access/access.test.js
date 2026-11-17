// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { makeDb } from '../_shared/testdb.js';
import { probe, askOwner, step, report, stateOf } from './index.js';

const dirs = ['./migrations/'].map(d => fileURLToPath(new URL(d, import.meta.url)));
const T0 = Date.parse('2026-11-17T12:00:00Z');
// A fake world: path -> { status, body }. Unlisted paths answer 403.
const world = routes => async (url, init) => {
  const p = String(url).replace(/^https:\/\/api\.(github\.com|cloudflare\.com\/client\/v4)/, '');
  assert.ok(init.headers.authorization.startsWith('Bearer '), 'every call is authenticated');
  const r = routes[p] || { status: 403, body: { message: 'forbidden' } };
  return { status: r.status, json: async () => r.body };
};
const mk = (routes = {}, env = { GITHUB_TOKEN: 'x', CLOUDFLARE_API_TOKEN: 'y' }, config = {}) =>
  ({ db: makeDb(dirs), now: () => T0, fetch: world(routes), env, config });
const card = (id, what, why = 'needed to continue') => ({ id, what, why_gated: why, default_in_effect: 'skipped', closing_probe: 'manual' });
const cards = ctx => ctx.db.raw.prepare('SELECT id, status FROM gate_cards ORDER BY id').all();

const CF_ACCOUNTS = { '/accounts?per_page=50': { status: 200, body: { result: [{ id: 'a1', name: 'ultrastable' }, { id: 'a2', name: 'second-acct' }] } } };
const GH_NO_APP = { '/orgs/ExampleOrg/installations?per_page=100': { status: 200, body: { installations: [{ id: 1, app_slug: 'other' }] } } };
const GH_APP = { '/orgs/ExampleOrg/installations?per_page=100': { status: 200, body: { installations: [{ id: 7, app_slug: 'cloudflare-workers-and-pages', repository_selection: 'all' }] } } };

test('an ask for access that already exists is refused and nothing reaches the owner', async () => {
  const ctx = mk(CF_ACCOUNTS);
  const r = await askOwner(ctx, { ...card('ask-cf', 'grant the Cloudflare credentials access to the ultrastable account'), capability: 'cloudflare.account_access', subject: 'ultrastable' });
  assert.equal(r.asked, false); assert.equal(r.reason, 'already_granted');
  assert.deepEqual(cards(ctx), []);
  assert.equal(ctx.db.raw.prepare('SELECT reason FROM access_blocked_asks').get().reason.split(':')[0], 'already_granted');
});

test('an unreadable answer is unknown, never missing, so it cannot license an ask', async () => {
  const ctx = mk({}); // every call 403
  const r = await askOwner(ctx, { ...card('ask-gh', 'install the Cloudflare app on ExampleOrg'), capability: 'github.app_installed', subject: 'ExampleOrg/cloudflare-workers-and-pages' });
  assert.equal(r.asked, false); assert.equal(r.reason, 'not_proven_missing');
  assert.equal((await stateOf(ctx, 'github.app_installed', 'ExampleOrg/cloudflare-workers-and-pages')).status, 'unknown');
  assert.deepEqual(cards(ctx), []);
});

test('a capability missing on every route is asked once, with every route and its result on the card', async () => {
  const ctx = mk({ ...GH_NO_APP, ...CF_ACCOUNTS }, undefined, { github_sample_repos: ['ExampleOrg/x'] });
  // the check-run route cannot see the repo: with it unknown the state is unknown, so give the world a repo with no app runs
  ctx.fetch = world({ ...GH_NO_APP, '/repos/ExampleOrg/x/commits?per_page=5': { status: 200, body: [{ sha: 'abcdef012345' }] },
    '/repos/ExampleOrg/x/commits/abcdef012345/check-runs?per_page=100': { status: 200, body: { check_runs: [] } } });
  const first = await askOwner(ctx, { ...card('ask-app', 'install the Cloudflare app on ExampleOrg'), capability: 'github.app_installed', subject: 'ExampleOrg/cloudflare-workers-and-pages' });
  assert.equal(first.asked, false, 'a silent check-run route leaves the state unknown');
  // the check-run route is only a presence proof; a tenant that has no such route lists only the authoritative one
  const reg = { 'github.app_installed': { routes: [{ id: 'org_installations', run: (c, s) => ({ outcome: 'absent', detail: 'org lists no such app' }) }] } };
  const ctx2 = { ...mk({}), registry: reg };
  const r = await askOwner(ctx2, { ...card('ask-app', 'install the Cloudflare app on ExampleOrg'), capability: 'github.app_installed', subject: 'ExampleOrg/x' });
  assert.equal(r.asked, true);
  const row = ctx2.db.raw.prepare('SELECT * FROM gate_cards').get();
  assert.equal(row.status, 'open'); assert.match(row.why_gated, /org_installations: absent/);
  assert.equal(ctx2.db.raw.prepare('SELECT COUNT(*) AS n FROM access_permits').get().n, 1);
});

test('the database itself closes an access request filed without a permit and hands the step to the staff', async () => {
  const ctx = mk();
  for (const [id, what] of [
    ['runner-needs-VCS_TOKEN', 'runner needs: VCS_TOKEN'],
    ['c2', 'Please add the Cloudflare secret to the repository'],
    ['c3', 'Install the Cloudflare Workers & Pages GitHub app on ExampleOrg'],
    ['c4', 'Grant permission to deploy'],
  ]) await ctx.db.prepare('INSERT OR IGNORE INTO gate_cards (id, what, why_gated, default_in_effect, closing_probe) VALUES (?,?,?,?,?)').bind(id, what, 'blocked', 'idle', id.startsWith('runner-needs-') ? 'env:VCS_TOKEN' : 'manual').run();
  assert.deepEqual(cards(ctx).map(c => c.status), ['closed', 'closed', 'closed', 'closed']);
  assert.equal(ctx.db.raw.prepare('SELECT COUNT(*) AS n FROM access_blocked_asks').get().n, 4);
  const it = ctx.db.raw.prepare("SELECT owner_role, status FROM items WHERE id = 'ACCESS-runner-needs-VCS_TOKEN'").get();
  assert.deepEqual({ ...it }, { owner_role: 'staff', status: 'blocked' });
  assert.equal((await report(ctx)).open_cards_without_permit.length, 0);
});

test('requests that are identity-bound and not about access are untouched', async () => {
  const ctx = mk();
  await ctx.db.prepare('INSERT INTO gate_cards (id, what, why_gated, default_in_effect, closing_probe) VALUES (?,?,?,?,?)').bind('pay', 'Send money for the domain renewal', 'payment is identity-bound', 'lapse', 'manual').run();
  await ctx.db.prepare('INSERT INTO gate_cards (id, what, why_gated, default_in_effect, closing_probe) VALUES (?,?,?,?,?)').bind('legal', 'Sign a legal agreement', 'legal act', 'wait', 'manual').run();
  await ctx.db.prepare('INSERT INTO gate_cards (id, what, why_gated, default_in_effect, closing_probe) VALUES (?,?,?,?,?)').bind('misc', 'Choose a brand name', 'taste', 'default name', 'manual').run();
  assert.deepEqual(cards(ctx).map(c => c.status), ['open', 'open', 'open']);
});

test('a permit cannot be written without a fresh missing probe: the database raises', async () => {
  const ctx = mk();
  const ins = () => ctx.db.prepare('INSERT INTO access_permits (card_id, capability, subject, at) VALUES (?,?,?,?)').bind('x', 'secret.available', 'FOO', new Date(T0).toISOString()).run();
  await assert.rejects(ins(), /access_permit_refused/);
  await probe({ ...ctx, config: { ttl_minutes: 1 } }, 'secret.available', 'FOO'); // no vault reader: unknown
  await assert.rejects(ins(), /access_permit_refused/);
  const reg = { 'secret.available': { routes: [{ id: 'environment', run: () => ({ outcome: 'absent', detail: 'no' }) }] } };
  await probe({ ...ctx, registry: undefined, config: { ttl_minutes: 1 } }, 'secret.available', 'FOO', { registry: reg });
  await assert.rejects(ctx.db.prepare('INSERT INTO access_permits (card_id, capability, subject, at) VALUES (?,?,?,?)').bind('x', 'secret.available', 'FOO', new Date(T0 + 3600e3).toISOString()).run(), /access_permit_refused/, 'a stale probe is refused');
  await ins(); // fresh and missing: allowed
});

test('when the capability turns up, the permitted card closes by itself', async () => {
  const reg = { 'secret.available': { routes: [{ id: 'environment', run: (c, s) => (c.env[s] ? { outcome: 'present', detail: 'set' } : { outcome: 'absent', detail: 'no' }) }] } };
  const ctx = { ...mk({}, {}), registry: reg };
  await askOwner(ctx, { ...card('need-foo', 'provide the credential FOO'), capability: 'secret.available', subject: 'FOO' });
  assert.equal(cards(ctx)[0].status, 'open');
  ctx.env.FOO = 'set';
  await probe(ctx, 'secret.available', 'FOO', { registry: reg });
  assert.equal(cards(ctx)[0].status, 'closed');
});

test('the tick step probes the configured needs and records the counts', async () => {
  const ctx = mk({ ...CF_ACCOUNTS }, undefined, { needs: [{ capability: 'cloudflare.account_access', subject: 'ultrastable' }, { capability: 'cloudflare.account_access', subject: 'nobody' }] });
  const out = await step(ctx);
  assert.deepEqual(out, { probed: 2, present: 1, missing: 1, unknown: 0, items_closed: 0 });
});

test('the Cloudflare Git connection route finds a Worker that builds from the repository', async () => {
  const ctx = mk({
    '/accounts/a1/workers/scripts': { status: 200, body: { result: [{ id: 'w1', tag: 't1' }, { id: 'w2', tag: 't2' }] } },
    '/accounts/a1/builds/workers/t1/triggers': { status: 200, body: { result: [] } },
    '/accounts/a1/builds/workers/t2/triggers': { status: 200, body: { result: [{ repo_connection: { repo_name: 'workers', provider_account_name: 'ultrastable' } }] } },
  });
  assert.equal((await probe(ctx, 'cloudflare.git_connection', 'a1/ultrastable/workers')).status, 'present');
  assert.equal((await probe(ctx, 'cloudflare.git_connection', 'a1/ultrastable/other')).status, 'missing');
});

test('a workflow that has succeeded proves its own deploy path; one that never has proves nothing', async () => {
  const ok = mk({ '/repos/o/r/actions/workflows/deploy.yml/runs?status=success&per_page=1': { status: 200, body: { workflow_runs: [{ id: 9, updated_at: '2026-11-17T13:30:33Z' }] } } });
  assert.equal((await probe(ok, 'github.workflow_ran_ok', 'o/r:deploy.yml')).status, 'present');
  const never = mk({ '/repos/o/r/actions/workflows/deploy.yml/runs?status=success&per_page=1': { status: 200, body: { workflow_runs: [] } } });
  assert.equal((await probe(never, 'github.workflow_ran_ok', 'o/r:deploy.yml')).status, 'unknown');
});

test('repository permission: a readable repository proves read; a token that reports no push flag is unknown, never missing', async () => {
  const w = { '/repos/o/r': { status: 200, body: { permissions: { admin: false, push: false, pull: false } } } };
  assert.equal((await probe(mk(w), 'github.repo_permission', 'o/r:read')).status, 'present');
  assert.equal((await probe(mk(w), 'github.repo_permission', 'o/r:push')).status, 'unknown');
  const pushOk = { '/repos/o/r': { status: 200, body: { permissions: { push: true } } } };
  assert.equal((await probe(mk(pushOk), 'github.repo_permission', 'o/r:push')).status, 'present');
});
