// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Tests for packs/social (US-SPEC-21 class B, US-SPEC-22 claims). Fake channel ports and fake fetch; no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { makeDb } from '../../core/_shared/testdb.js';
import { KERNEL_DIR } from '../../core/kernel/testkit.js';
import { createPacks, validateManifest, loadManifest, assertCoreImportsNoPacks, MIGRATIONS_DIR } from '../../core/packs/index.js';
import { checkPost, createModelPorts, findUrls, linkFacets, truncate, addUtm, guardPort, createBlueskyChannel, createSchedulerChannel } from './index.js';
import { enqueue } from './queue.js';

const DIR = fileURLToPath(new URL('./', import.meta.url));
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DESCRIBE_MIG = fileURLToPath(new URL('../../core/describe/migrations/', import.meta.url));
const SOCIAL_MIG = fileURLToPath(new URL('./migrations/', import.meta.url));
const T0 = Date.parse('2026-11-11T10:00:00Z');
const H = 3600e3;
const iso = ms => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const one = (db, sql, ...a) => db.raw.prepare(sql).get(...a);
const rows = (db, sql, ...a) => db.raw.prepare(sql).all(...a);
const manifest = () => loadManifest(DIR);

function fakeChannel() {
  const c = { posts: new Map(), calls: [], removedIds: [], missing: new Set(), metrics: {} };
  c.post = async ({ text, links, replyTo }) => {
    const id = `at://did:plc:fake/app.bsky.feed.post/${c.posts.size + 1}`;
    c.posts.set(id, { text, links, replyTo }); c.calls.push({ text, links, replyTo });
    return { id, url: `https://social.example.com/p/${c.posts.size}` };
  };
  c.fetchPost = async id => {
    if (c.missing.has(id) || !c.posts.has(id)) return null;
    return { id, url: `https://social.example.com/${id.split('/').pop()}`, text: c.posts.get(id).text, state: 'published', metrics: c.metrics[id] };
  };
  c.remove = async id => { c.removedIds.push(id); c.posts.delete(id); return { ok: true }; };
  return c;
}

async function setup({ settings = {}, caps, rung = 'autonomous', claims = true, clock = { t: T0 }, channel = fakeChannel() } = {}) {
  const db = makeDb([KERNEL_DIR, MIGRATIONS_DIR, DESCRIBE_MIG, SOCIAL_MIG]);
  const s = { handle: 'org.example.com', allowlist: ['example.org'], link_url: 'https://example.org/about', ports: { channel }, ...settings };
  const packs = createPacks({ db, now: () => clock.t, config: { packs: { social: s } }, channels: { social: guardPort({ db, channel }) } });
  const m = manifest();
  if (caps) m.outbound.caps.social = caps;
  assert.deepEqual((await packs.register(m, { dir: DIR })).errors, undefined);
  assert.equal((await packs.enablePack('social', { by: 'owner', cardText: m.enable_gate })).ok, true);
  if (rung) db.raw.prepare(`INSERT INTO trust_ledger (surface, action_class, rung, reliability, outcomes) VALUES ('pack:social','post',?,1,50)`).run(rung);
  if (claims) {
    addClaim(db, 'operation.ticks', 'Ran {value} ticks', 42, T0 - H);
  }
  const loop = async name => {
    const step = (await packs.packSteps()).find(x => x.name === `pack:social:${name}`);
    const ctx = { tickId: 12, errors: [], notes: [], now: clock.t };
    await step.run(db, ctx);
    assert.deepEqual(ctx.errors, []);
    return ctx;
  };
  return { db, channel, packs, guard: packs.guard, loop, clock, settings: s };
}
function addClaim(db, id, text, value, checkedAt, { max_age = 24, pub = 1, result = 'pass' } = {}) {
  db.raw.prepare(`INSERT INTO describe_claims (id, text, probe_kind, probe_arg, expect, max_age_hours, public, last_result, last_checked_at, evidence) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(id, text, 'sql', 'SELECT 1', '>=1', max_age, pub, result, iso(checkedAt), JSON.stringify({ value }));
}

test('manifest is valid under validateManifest; scope names the refusals; migration is idempotent and social_ prefixed', () => {
  const m = manifest();
  assert.deepEqual(validateManifest(m, { tenantNames: ['acme'] }), []);
  assert.equal(m.class, 'B');
  assert.equal(m.charter.primary_metric.id, 'social_posts_published_verified');
  assert.deepEqual(m.charter.guard_metrics.map(g => g.id).sort(), ['social_refused_by_guard', 'social_removed_posts']);
  const text = m.scope.does_not.join(' ').toLowerCase();
  for (const w of ['impersonate', 'buy engagement', 'mass-follow']) assert.ok(text.includes(w), w);
  const db = makeDb([KERNEL_DIR, MIGRATIONS_DIR, DESCRIBE_MIG, SOCIAL_MIG]);
  const sql = readFileSync(new URL('./migrations/0001_social.sql', import.meta.url), 'utf8');
  db.raw.exec(sql); db.raw.exec(sql);
  const names = rows(db, `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'social_%'`).map(r => r.name).sort();
  assert.deepEqual(names, ['social_metrics', 'social_queue', 'social_rejections']);
  for (const g of [...m.charter.guard_metrics, m.charter.primary_metric]) db.raw.prepare(g.read_probe).get();   // probes run
});

test('a claim-backed draft passes the checker, is tagged with UTM and enters the queue with an idempotency key', async () => {
  const { db, loop } = await setup();
  const ctx = await loop('compose');
  const q = rows(db, `SELECT * FROM social_queue`);
  assert.equal(q.length, 1);
  assert.match(q[0].text, /^Ran 42 ticks \(as of 2026-11-11\)\./);
  assert.ok(!q[0].text.includes('[claim:'));
  assert.match(q[0].text, /https:\/\/example\.org\/about\?utm_source=social&utm_medium=post&utm_campaign=claims/);
  assert.deepEqual(JSON.parse(q[0].claim_ids), ['operation.ticks']);
  assert.match(q[0].idem_key, /^social:[0-9a-f]{24}$/);
  assert.match(ctx.notes.join(' '), /1 queued, 0 rejected/);
  await loop('compose');                                                // the same claim is not reposted inside the repeat window
  assert.equal(rows(db, `SELECT * FROM social_queue`).length, 1);
});

test('unbacked sentences, undated or invented numbers, off-list links and a vetoing checker are rejected', async () => {
  const claims = [{ id: 'operation.ticks', text: 'Ran {value} ticks', evidence: JSON.stringify({ value: 42 }), last_checked_at: iso(T0) }];
  const opts = { allowlist: ['example.org'] };
  assert.equal(checkPost('Ran 42 ticks (as of 2026-11-11) [claim:operation.ticks].\nhttps://example.org/a', claims, opts).ok, true);
  const rule = (t) => checkPost(t, claims, opts).violations.map(v => v.rule);
  assert.ok(rule('We are the best around.').includes('no_claim'));
  assert.ok(rule('Ran 42 ticks [claim:operation.ticks].').includes('number_without_date'));
  assert.ok(rule('Ran 99 ticks (as of 2026-11-11) [claim:operation.ticks].').includes('number_not_in_claim'));
  assert.ok(rule('Ran 42 ticks (as of 2026-11-11) [claim:operation.ticks].\nhttps://evil.example.net/x').includes('url_not_allowed'));
  assert.ok(rule('Ran 42 ticks (as of 2026-11-11) [claim:operation.ticks]. See evil.example.net/x').includes('url_not_allowed'));
  assert.ok(rule('Ran 42 ticks (as of 2026-11-11) [claim:operation.ticks].\nhttp://example.org/a').includes('url_not_https'));
  assert.ok(rule('Ran 42 ticks (as of 2026-11-11) [claim:other.id].').includes('unknown_claim'));

  // Through the loop: a writer that invents a number, and a second checker that vetoes.
  const bad = await setup({ settings: { ports: { channel: fakeChannel(), compose: async () => 'Ran 99 ticks (as of 2026-11-11) [claim:operation.ticks].' } } });
  await bad.loop('compose');
  assert.equal(rows(bad.db, `SELECT * FROM social_queue`).length, 0);
  assert.match(one(bad.db, `SELECT violations FROM social_rejections`).violations, /number_not_in_claim/);
  const veto = await setup({ settings: { ports: { channel: fakeChannel(), checker: async () => ({ ok: false, violations: [{ rule: 'model_check', detail: 'unsupported' }] }) } } });
  await veto.loop('compose');
  assert.equal(rows(veto.db, `SELECT * FROM social_queue`).length, 0);
  assert.equal(rows(veto.db, `SELECT * FROM social_rejections`).length, 1);
});

test('model ports: writer and checker must be different families, and an unusable checker fails closed', async () => {
  assert.throws(() => createModelPorts({ complete: async () => '', composeModel: 'alpha/large', checkerModel: 'alpha/small' }), /different families/);
  const p = createModelPorts({ complete: async () => 'not json', composeModel: 'alpha/large', checkerModel: 'beta/small' });
  assert.equal((await p.checker('x', [])).ok, false);
  const yes = createModelPorts({ complete: async ({ model }) => (model === 'beta/small' ? '{"ok":true,"violations":[]}' : 'text'), composeModel: 'alpha/large', checkerModel: 'beta/small' });
  assert.equal((await yes.checker('x', [])).ok, true);
});

test('a stale, withdrawn or non-public claim is never used', async () => {
  const { db, loop } = await setup({ claims: false });
  addClaim(db, 'operation.old', 'Ran {value} ticks', 7, T0 - 3 * 24 * H);                  // stale (max age 24 h)
  addClaim(db, 'operation.private', 'Ran {value} ticks', 8, T0 - H, { pub: 0 });
  addClaim(db, 'operation.failing', 'Ran {value} ticks', 9, T0 - H, { result: 'fail' });
  await loop('compose');
  assert.equal(rows(db, `SELECT * FROM social_queue`).length, 0);
  // A writer that cites the stale claim anyway is rejected as an unknown claim.
  const cheat = await setup({ claims: false, settings: { ports: { channel: fakeChannel(), compose: async () => 'Ran 7 ticks (as of 2026-11-08) [claim:operation.old].' } } });
  addClaim(cheat.db, 'operation.old', 'Ran {value} ticks', 7, T0 - 3 * 24 * H);
  addClaim(cheat.db, 'operation.fresh', 'Ran {value} ticks', 1, T0 - H);
  await cheat.loop('compose');
  assert.equal(rows(cheat.db, `SELECT * FROM social_queue`).length, 0);
  assert.match(one(cheat.db, `SELECT violations FROM social_rejections`).violations, /unknown_claim/);
});

test('the per-day cap is respected: only the capped number is posted, the rest wait', async () => {
  const { db, channel, loop, clock, packs } = await setup({ caps: { per_day: 2, per_week: 8 } });
  const s = { baseline_engagement: 1, score_after_hours: 24 };
  for (const t of ['one', 'two', 'three']) await enqueue({ db, now: () => clock.t, s, text: `Post ${t}`, claimIds: [] });
  await loop('publish'); await loop('publish');
  assert.equal(channel.calls.length, 2);
  assert.deepEqual(rows(db, `SELECT status FROM social_queue ORDER BY id`).map(r => r.status), ['published', 'published', 'queued']);
  clock.t += 25 * H;                                                                         // next day
  await loop('publish');
  assert.equal(channel.calls.length, 3);
  const w = await setup({ caps: { per_day: 5, per_week: 2 } });                              // the weekly cap binds too
  for (const t of ['a', 'b', 'c']) await enqueue({ db: w.db, now: () => w.clock.t, s, text: `Post ${t}`, claimIds: [] });
  await w.loop('publish'); w.clock.t += 2 * 86400e3; await w.loop('publish'); await w.loop('publish');
  assert.equal(w.channel.calls.length, 2);
  assert.ok(packs);
});

test('the kill switch stops publishing at once and the post is kept for later', async () => {
  const { db, channel, loop, packs, clock } = await setup();
  await enqueue({ db, now: () => clock.t, s: { baseline_engagement: 1, score_after_hours: 24 }, text: 'Hold this', claimIds: [] });
  await packs.setSwitch('pack:social', true, 'test');
  await loop('publish');                                                                     // the host skips the step: nothing sent
  await packs.setSwitch('pack:social', false); await packs.setSwitch('channel:social', true, 'test');
  const ctx = await loop('publish');
  assert.equal(channel.calls.length, 0);
  assert.equal(one(db, `SELECT status, guard_reason FROM social_queue`).guard_reason, 'kill_switch_channel');
  assert.match(ctx.notes.join(' '), /held: kill_switch_channel/);
  await packs.setSwitch('channel:social', false);
  await loop('publish');
  assert.equal(channel.calls.length, 1);
});

test('below the act rung a post is queued as a decision card showing its text; approval publishes it once', async () => {
  const { db, channel, loop, guard } = await setup({ rung: null });
  await loop('compose'); await loop('publish');
  assert.equal(channel.calls.length, 0);
  const r = one(db, `SELECT * FROM social_queue`);
  assert.equal(r.status, 'awaiting_approval');
  const card = one(db, `SELECT * FROM gate_cards WHERE id = ?`, r.card_id);
  assert.ok(card.what.includes('Ran 42 ticks (as of 2026-11-11)'));
  await loop('publish');                                                                     // no second card for the same post
  assert.equal(rows(db, `SELECT * FROM gate_cards`).length, 1);
  const out = await guard.approve(r.guard_queue_id, { by: 'owner' });
  assert.equal(out.decision, 'sent');
  await loop('publish');                                                                     // reconcile records it
  const done = one(db, `SELECT * FROM social_queue`);
  assert.equal(done.status, 'published');
  assert.equal(done.provider_id, out.providerId);
  assert.equal(channel.calls.length, 1);
  // A rejected card ends the post.
  const rej = await setup({ rung: null });
  await rej.loop('compose'); await rej.loop('publish');
  await rej.guard.reject(one(rej.db, `SELECT guard_queue_id g FROM social_queue`).g, { by: 'owner' });
  await rej.loop('publish');
  assert.equal(one(rej.db, `SELECT status FROM social_queue`).status, 'refused');
  assert.equal(rej.channel.calls.length, 0);
});

test('a retry posts once: the same text queues once and a crashed run is reconciled from the guard ledger', async () => {
  const { db, channel, loop, clock } = await setup();
  const s = { baseline_engagement: 1, score_after_hours: 24 };
  const a = await enqueue({ db, now: () => clock.t, s, text: 'Same text', claimIds: [] });
  const b = await enqueue({ db, now: () => clock.t, s, text: 'Same text', claimIds: [] });
  assert.equal(a.id, b.id); assert.equal(b.created, false);
  await loop('publish');
  db.raw.prepare(`UPDATE social_queue SET status = 'queued', provider_id = NULL, published_at = NULL`).run();   // simulate a crash before the row was saved
  await loop('publish');
  assert.equal(channel.calls.length, 1);
  const r = one(db, `SELECT * FROM social_queue`);
  assert.equal(r.status, 'published'); assert.ok(r.provider_id);
});

test('verify: a posted and read-back post is verified with its url; one that cannot be read back files an incident item', async () => {
  const { db, channel, loop } = await setup();
  await loop('compose'); await loop('publish'); await loop('verify');
  const r = one(db, `SELECT * FROM social_queue`);
  assert.equal(r.verify_status, 'verified'); assert.match(r.url, /^https:\/\/social\.example\.com\//);
  const f = await setup({ settings: { verify_attempts: 1 } });
  await f.loop('compose'); await f.loop('publish');
  f.channel.missing.add([...f.channel.posts.keys()][0]);
  await f.loop('verify');
  assert.equal(one(f.db, `SELECT verify_status FROM social_queue`).verify_status, 'failed');
  const item = one(f.db, `SELECT * FROM items WHERE id = 'SOCIALVERIFY-1'`);
  assert.ok(item); assert.equal(item.owner_role, 'pack-manager-social');
  assert.ok(channel);
});

test('metrics: counts, engagement read-back, prediction scoring and removal detection', async () => {
  const { db, channel, loop, clock } = await setup();
  await loop('compose'); await loop('publish'); await loop('verify');
  const id = [...channel.posts.keys()][0];
  assert.equal(one(db, `SELECT predicted_engagement p FROM social_queue`).p, 1);
  channel.metrics[id] = { likes: 3, reposts: 1, replies: 0 };
  await loop('metrics');                                                                      // read, but too early to score
  assert.equal(one(db, `SELECT engagement e, engagement_verdict v FROM social_queue`).e, 4);
  assert.equal(one(db, `SELECT engagement_verdict v FROM social_queue`).v, null);
  clock.t += 25 * H;
  await loop('metrics');
  assert.equal(one(db, `SELECT engagement_verdict v FROM social_queue`).v, 'hit');
  assert.equal(one(db, `SELECT verdict, observed FROM predictions WHERE id = 'social-engagement-1'`).verdict, 'hit');
  const m = one(db, `SELECT * FROM social_metrics ORDER BY id DESC`);
  assert.deepEqual([m.published, m.verified, m.removed, m.engagement], [1, 1, 0, 4]);
  channel.missing.add(id);
  await loop('metrics');
  assert.equal(one(db, `SELECT status FROM social_queue`).status, 'removed');
  assert.ok(one(db, `SELECT 1 x FROM items WHERE id = 'SOCIALREMOVED-1'`));
  assert.equal(one(db, `SELECT removed FROM social_metrics ORDER BY id DESC`).removed, 1);
});

test('facets use UTF-8 byte offsets for multibyte text and URLs', () => {
  const text = 'Café ✓ 日本語 😀 see https://example.org/a?b=é&c=1 and https://example.org/z.';
  const f = linkFacets(text);
  assert.equal(f.length, 2);
  const bytes = new TextEncoder().encode(text), dec = new TextDecoder();
  assert.equal(dec.decode(bytes.slice(f[0].index.byteStart, f[0].index.byteEnd)), 'https://example.org/a?b=é&c=1');
  assert.equal(dec.decode(bytes.slice(f[1].index.byteStart, f[1].index.byteEnd)), 'https://example.org/z');   // trailing full stop excluded
  assert.ok(f[0].index.byteStart > text.indexOf('https'));                                                      // bytes differ from characters
  assert.equal(f[0].features[0].$type, 'app.bsky.richtext.facet#link');
});

test('truncation never splits a URL and never exceeds the limit', () => {
  const url = 'https://example.org/a/very/long/path/that/must/stay/whole';
  const text = `Some words that fill the line before the link ${url} and more words after it`;
  for (let max = 20; max < text.length; max++) {
    const t = truncate(text, max);
    assert.ok(t.length <= max, `max ${max}: ${t.length}`);
    for (const { url: u } of findUrls(t)) assert.equal(u, url, `max ${max} split the url: ${t}`);
  }
  assert.equal(truncate('short', 300), 'short');
  const emoji = '😀'.repeat(20);
  assert.doesNotMatch(truncate(emoji, 11), /[\uD800-\uDBFF]…?$/);
  assert.equal(addUtm(`x ${url} https://other.example.net/q`, { hosts: ['example.org'], params: { source: 's' } }), `x ${url}?utm_source=s https://other.example.net/q`);
});

function fakeFetch(handler) {
  const calls = [];
  const f = async (url, init = {}) => {
    const body = init.body && init.headers?.['content-type'] === 'application/json' ? JSON.parse(init.body) : init.body;
    calls.push({ url: String(url), method: init.method, headers: init.headers || {}, body });
    const r = await handler({ url: String(url), body, init });
    return new Response(JSON.stringify(r.json ?? {}), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  };
  f.calls = calls;
  return f;
}

test('bluesky channel: session, createRecord with byte-offset facets, getPosts, deleteRecord, and a thread reply', async () => {
  const text = 'Café 😀 https://example.org/x ok';
  const fetch = fakeFetch(({ url, body }) => {
    if (url.endsWith('createSession')) return { json: { accessJwt: 'jwt-1', did: 'did:plc:abc', handle: 'h' } };
    if (url.endsWith('createRecord')) return { json: { uri: 'at://did:plc:abc/app.bsky.feed.post/3k', cid: 'c1' } };
    if (url.includes('getPosts')) return { json: { posts: [{ uri: 'at://did:plc:abc/app.bsky.feed.post/3k', cid: 'c1', record: { text, createdAt: 'x' }, likeCount: 2, repostCount: 1, replyCount: 0 }] } };
    if (url.endsWith('deleteRecord')) return { json: {} };
    return { status: 404 };
  });
  const ch = createBlueskyChannel({ fetch, env: { BLUESKY_IDENTIFIER: 'h', BLUESKY_APP_PASSWORD: 'pw-secret-1234' }, service: 'https://pds.example.com', webBase: 'https://web.example.com', now: () => T0 });
  const res = await ch.post({ text, links: ['https://example.org/x'] });
  assert.deepEqual(res, { id: 'at://did:plc:abc/app.bsky.feed.post/3k', url: 'https://web.example.com/profile/did:plc:abc/post/3k' });
  const create = fetch.calls.find(c => c.url.endsWith('createRecord'));
  assert.equal(create.headers.authorization, 'Bearer jwt-1');
  assert.equal(create.body.repo, 'did:plc:abc');
  const f = create.body.record.facets[0].index;
  assert.equal(new TextDecoder().decode(new TextEncoder().encode(text).slice(f.byteStart, f.byteEnd)), 'https://example.org/x');
  assert.ok(!fetch.calls.some(c => c.url.includes('pw-secret') || c.url.includes('jwt-1')));
  const got = await ch.fetchPost(res.id);
  assert.deepEqual(got.metrics, { likes: 2, reposts: 1, replies: 0, quotes: 0 });
  await ch.post({ text: 'reply', replyTo: res.id });
  assert.deepEqual(fetch.calls.filter(c => c.url.endsWith('createRecord')).pop().body.record.reply, { root: { uri: res.id, cid: 'c1' }, parent: { uri: res.id, cid: 'c1' } });
  await ch.remove(res.id);
  assert.equal(fetch.calls.pop().body.rkey, '3k');
});

test('bluesky channel: missing credentials and a failed login name the problem but never the secret', async () => {
  const none = createBlueskyChannel({ fetch: fakeFetch(() => ({})), env: {}, service: 'https://pds.example.com' });
  await assert.rejects(() => none.post({ text: 'x' }), /credentials missing: BLUESKY_IDENTIFIER, BLUESKY_APP_PASSWORD/);
  const fetch = fakeFetch(() => ({ status: 401, json: { error: 'AuthenticationRequired', message: 'bad password pw-secret-1234' } }));
  const ch = createBlueskyChannel({ fetch, env: { BLUESKY_IDENTIFIER: 'h', BLUESKY_APP_PASSWORD: 'pw-secret-1234' }, service: 'https://pds.example.com' });
  await assert.rejects(() => ch.post({ text: 'x' }), e => /createSession failed: HTTP 401 AuthenticationRequired/.test(e.message) && !e.message.includes('pw-secret'));
});

test('secrets never reach a table or a log across a full run through the bluesky channel', async () => {
  const logs = [];
  const orig = { log: console.log, error: console.error, warn: console.warn };
  console.log = console.error = console.warn = (...a) => logs.push(a.join(' '));
  let posted = '';
  try {
    const fetch = fakeFetch(({ url, body }) => {
      if (url.endsWith('createSession')) return { json: { accessJwt: 'jwt-SECRET-token', did: 'did:plc:abc' } };
      if (url.endsWith('createRecord')) { posted = body.record.text; return { json: { uri: 'at://did:plc:abc/app.bsky.feed.post/9', cid: 'c' } }; }
      if (url.includes('getPosts')) return { json: { posts: [{ uri: 'at://did:plc:abc/app.bsky.feed.post/9', cid: 'c', record: { text: posted } }] } };
      return {};
    });
    const env = { BLUESKY_IDENTIFIER: 'ident-xyz', BLUESKY_APP_PASSWORD: 'pw-SECRET-1234' };
    const channel = createBlueskyChannel({ fetch, env, service: 'https://pds.example.com' });
    const { db, loop } = await setup({ channel });
    await loop('compose'); await loop('publish'); await loop('verify'); await loop('metrics');
    assert.equal(one(db, `SELECT verify_status v FROM social_queue`).v, 'verified');
    assert.equal(posted.includes('Ran 42 ticks'), true);
    const tables = ['social_queue', 'social_rejections', 'social_metrics', 'guard_ledger', 'guard_queue', 'packs_registry', 'packs_runs', 'gate_cards', 'items', 'describe_claims'];
    const dump = JSON.stringify(tables.map(t => rows(db, `SELECT * FROM ${t}`)));
    for (const secret of ['pw-SECRET-1234', 'jwt-SECRET-token', 'ident-xyz']) assert.ok(!dump.includes(secret), secret);
    assert.ok(fetch.calls.every(c => !c.url.includes('SECRET')));
  } finally { Object.assign(console, orig); }
  assert.deepEqual(logs.filter(l => /SECRET|ident-xyz/.test(l)), []);
});

test('a guard-refused secret-shaped text is never sent', async () => {
  const { db, channel, loop, clock } = await setup();
  await enqueue({ db, now: () => clock.t, s: { baseline_engagement: 1, score_after_hours: 24 }, text: 'token: abcdef1234567890abcdef', claimIds: [] });
  await loop('publish');
  assert.equal(channel.calls.length, 0);
  assert.equal(one(db, `SELECT status, guard_reason FROM social_queue`).guard_reason, 'content_secret_pattern');
});

test('scheduler channel: Buffer-style create, read back, list pending and delete through an injected fetch', async () => {
  const fetch = fakeFetch(({ url }) => {
    if (url.endsWith('/updates/create.json')) return { json: { success: true, updates: [{ id: 'u1' }] } };
    if (url.endsWith('/updates/u1.json')) return { json: { id: 'u1', text: 'hi', status: 'sent', service_link: 'https://social.example.com/s/1', statistics: { favorites: 2, retweets: 1, mentions: 3 } } };
    if (url.endsWith('/updates/u2.json')) return { json: { id: 'u2', text: 'later', status: 'buffer' } };
    if (url.endsWith('/updates/gone.json')) return { status: 404, json: { message: 'nope' } };
    if (url.endsWith('/profiles/prof%201/updates/pending.json')) return { json: { updates: [{ id: 'u2', text: 'later', due_at: 5 }] } };
    if (url.endsWith('/updates/u1/destroy.json')) return { json: { success: true } };
    return { status: 500 };
  });
  const ch = createSchedulerChannel({ fetch, env: { SCHEDULER_ACCESS_TOKEN: 'tok-SECRET-99' }, baseUrl: 'https://api.example.com/1/', profileId: 'prof 1' });
  assert.deepEqual(await ch.post({ text: 'hi' }), { id: 'u1', url: null });
  const create = fetch.calls[0];
  assert.equal(create.method, 'POST');
  assert.equal(create.headers.authorization, 'Bearer tok-SECRET-99');
  assert.equal(new URLSearchParams(create.body).get('text'), 'hi');
  assert.equal(new URLSearchParams(create.body).get('profile_ids[]'), 'prof 1');
  assert.ok(fetch.calls.every(c => !c.url.includes('tok-SECRET')));
  assert.deepEqual(await ch.fetchPost('u1'), { id: 'u1', url: 'https://social.example.com/s/1', text: 'hi', state: 'published', metrics: { likes: 2, reposts: 1, replies: 3 } });
  assert.equal((await ch.fetchPost('u2')).state, 'pending');
  assert.equal(await ch.fetchPost('gone'), null);
  assert.deepEqual(await ch.pending(), [{ id: 'u2', text: 'later', due_at: 5 }]);
  assert.deepEqual(await ch.remove('u1'), { ok: true });
  await assert.rejects(() => ch.post({ text: 'x', replyTo: 'u1' }), /does not support replies/);
  await assert.rejects(() => createSchedulerChannel({ fetch, env: {}, baseUrl: 'https://api.example.com', profileId: 'p' }).post({ text: 'x' }), /credentials missing: SCHEDULER_ACCESS_TOKEN/);
});

test('a scheduled post stays pending until the scheduler publishes it, then verifies', async () => {
  const channel = fakeChannel();
  let state = 'pending';
  const wrapped = { ...channel, fetchPost: async id => { const p = await channel.fetchPost(id); return p && { ...p, state }; } };
  const { db, loop, clock } = await setup({ channel: wrapped });
  db.raw.prepare(`INSERT INTO social_queue (idem_key, text, claim_ids, status, provider_id, published_at, created_at) VALUES ('k','hello','[]','published','p1',?,?)`).run(iso(clock.t), iso(clock.t));
  channel.posts.set('p1', { text: 'hello' });
  await loop('verify');
  assert.equal(one(db, `SELECT verify_status v FROM social_queue`).v, null);
  state = 'published';
  await loop('verify');
  assert.equal(one(db, `SELECT verify_status v FROM social_queue`).v, 'verified');
});

test('a pack step that cannot reach its channel files an item and the tick completes (host guard)', async () => {
  const { db, packs } = await setup({ settings: { ports: {} } });
  const step = (await packs.packSteps()).find(x => x.name === 'pack:social:verify');
  const ctx = { tickId: 12, errors: [], notes: [] };
  await step.run(db, ctx);
  assert.match(ctx.errors.join(' '), /social channel port is not configured/);
  assert.ok(one(db, `SELECT 1 x FROM items WHERE id LIKE 'PACKFAIL-social-verify-%'`));
});

test('core imports no pack, and the pack carries no tenant names', () => {
  assert.deepEqual(assertCoreImportsNoPacks(ROOT), []);
  const bad = /qnfo|quniverse|\bq08\b|rwnq8|edb167b78c9fb901ea5bca3ce58ccc4b/i;
  for (const f of ['pack.json', 'text.js', 'check.js', 'lib.js', 'queue.js', 'compose.js', 'publish.js', 'verify.js', 'metrics.js', 'index.js', 'channels/bluesky.js', 'channels/scheduler.js', 'migrations/0001_social.sql', 'README.md']) {
    const src = readFileSync(new URL(`./${f}`, import.meta.url), 'utf8').split('\n').filter(l => !/SPDX|Copyright \(c\)/.test(l)).join('\n');
    assert.doesNotMatch(src, bad, f);
  }
});
