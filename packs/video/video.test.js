// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Tests for packs/video (US-SPEC-21 class B). Fake channel port; no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { makeDb } from '../../core/_shared/testdb.js';
import { KERNEL_DIR } from '../../core/kernel/testkit.js';
import { createPacks, validateManifest, loadManifest, MIGRATIONS_DIR } from '../../core/packs/index.js';
import { submitVideo, checkVideo, guardPort, provenanceHash, sha256 } from './index.js';

const DIR = fileURLToPath(new URL('./', import.meta.url));
const DESCRIBE_MIG = fileURLToPath(new URL('../../core/describe/migrations/', import.meta.url));
const VIDEO_MIG = fileURLToPath(new URL('./migrations/', import.meta.url));
const T0 = Date.parse('2026-11-11T10:00:00Z');
const H = 3600e3;
const iso = ms => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const rows = (db, sql, ...a) => db.raw.prepare(sql).all(...a);
const one = (db, sql, ...a) => db.raw.prepare(sql).get(...a);
const HASH = 'a'.repeat(64);

function fakeChannel() {
  const c = { videos: new Map(), missing: new Set(), tamper: false };
  c.publish = async v => {
    const id = `vid-${c.videos.size + 1}`;
    c.videos.set(id, v);
    return { id, url: `https://video.example.com/${id}` };
  };
  c.fetchVideo = async id => {
    if (c.missing.has(id) || !c.videos.has(id)) return null;
    const v = c.videos.get(id);
    return { id, state: 'published', url: `https://video.example.com/${id}`, provenanceHash: c.tamper ? 'x' : v.provenanceHash, views: 7 };
  };
  return c;
}
function addClaim(db, id, checkedAt, { pub = 1, result = 'pass' } = {}) {
  db.raw.prepare(`INSERT INTO describe_claims (id, text, probe_kind, probe_arg, expect, max_age_hours, public, last_result, last_checked_at, evidence) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(id, 'Ran {value} ticks', 'sql', 'SELECT 1', '>=1', 24, pub, result, iso(checkedAt), '{"value":1}');
}
const video = (over = {}) => ({
  title: 'Ticks this week', description: 'A short look at the week. AI-generated. https://example.org/about', duration_s: 30,
  asset_ref: 'videos/a.mp4', asset_sha256: HASH,
  provenance: { generator: 'render-tool 1', synthetic: true, sources: ['operation.ticks'], created_at: '2026-11-11' }, ...over,
});

async function setup({ rung = 'autonomous', caps, channel = fakeChannel(), clock = { t: T0 } } = {}) {
  const db = makeDb([KERNEL_DIR, MIGRATIONS_DIR, DESCRIBE_MIG, VIDEO_MIG]);
  const settings = { handle: 'org.example.com', allowlist: ['example.org'], ports: { channel } };
  const packs = createPacks({ db, now: () => clock.t, config: { packs: { video: settings } }, channels: { video: guardPort({ db, channel }) } });
  const m = loadManifest(DIR);
  if (caps) m.outbound.caps.video = caps;
  assert.deepEqual((await packs.register(m, { dir: DIR })).errors, undefined);
  assert.equal((await packs.enablePack('video', { by: 'owner', cardText: m.enable_gate })).ok, true);
  if (rung) db.raw.prepare(`INSERT INTO trust_ledger (surface, action_class, rung, reliability, outcomes) VALUES ('pack:video','video',?,1,50)`).run(rung);
  addClaim(db, 'operation.ticks', T0 - H);
  const loop = async name => {
    const step = (await packs.packSteps()).find(x => x.name === `pack:video:${name}`);
    const ctx = { tickId: 6, errors: [], notes: [], now: clock.t };
    await step.run(db, ctx);
    assert.deepEqual(ctx.errors, []);
    return ctx;
  };
  return { db, channel, packs, loop, settings, clock };
}

test('manifest is valid, class B, video_ prefixed tables, probes run', () => {
  const m = loadManifest(DIR);
  assert.deepEqual(validateManifest(m, { tenantNames: ['acme'] }), []);
  assert.equal(m.class, 'B');
  const db = makeDb([KERNEL_DIR, MIGRATIONS_DIR, DESCRIBE_MIG, VIDEO_MIG]);
  const sql = readFileSync(new URL('./migrations/0001_video.sql', import.meta.url), 'utf8');
  db.raw.exec(sql); db.raw.exec(sql);
  assert.deepEqual(rows(db, `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'video_%'`).map(r => r.name).sort(), ['video_metrics', 'video_queue', 'video_rejections']);
  for (const g of [...m.charter.guard_metrics, m.charter.primary_metric]) db.raw.prepare(g.read_probe).get();
});

test('checker rejects missing provenance, missing disclosure, long video, stale claim, off-list link', () => {
  const claims = [{ id: 'operation.ticks', public: 1, last_result: 'pass', last_checked_at: iso(T0 - H), max_age_hours: 24 },
    { id: 'old', public: 1, last_result: 'pass', last_checked_at: iso(T0 - 3 * 24 * H), max_age_hours: 24 }];
  const o = { claims, allowlist: ['example.org'], now: T0 };
  const rule = v => checkVideo(v, o).violations.map(x => x.rule);
  assert.equal(checkVideo(video(), o).ok, true);
  assert.ok(rule(video({ provenance: undefined })).includes('provenance_missing'));
  assert.ok(rule(video({ description: 'no label here' })).includes('disclosure_missing'));
  assert.ok(rule(video({ duration_s: 95 })).includes('too_long'));
  assert.ok(rule(video({ asset_sha256: 'zz' })).includes('asset_hash_missing'));
  assert.ok(rule(video({ provenance: { ...video().provenance, sources: ['old'] } })).includes('claim_stale'));
  assert.ok(rule(video({ provenance: { ...video().provenance, sources: ['nope'] } })).includes('unknown_claim'));
  assert.ok(rule(video({ description: 'AI-generated see https://evil.example.net/x' })).includes('url_not_allowed'));
  assert.equal(checkVideo(video({ provenance: { ...video().provenance, synthetic: false }, description: 'plain' }), o).ok, true);
});

test('provenance hash is stable under key and source order', async () => {
  const p1 = { generator: 'g', synthetic: false, sources: ['b', 'a'], created_at: '2026-11-11' };
  const p2 = { created_at: '2026-11-11', sources: ['a', 'b'], synthetic: false, generator: 'g' };
  assert.equal(await provenanceHash(HASH, p1), await provenanceHash(HASH, p2));
  assert.equal((await sha256('x')).length, 64);
});

test('submit queues once, rejects bad video with a recorded reason, then publish, verify, metrics', async () => {
  const { db, channel, settings, loop } = await setup();
  const bad = await submitVideo({ db, now: () => T0, settings, video: video({ description: 'unlabelled' }) });
  assert.equal(bad.queued, false);
  assert.match(one(db, `SELECT violations FROM video_rejections`).violations, /disclosure_missing/);
  const ok = await submitVideo({ db, now: () => T0, settings, video: video() });
  assert.equal(ok.queued, true);
  assert.equal((await submitVideo({ db, now: () => T0, settings, video: video() })).duplicate, true);
  await loop('publish');
  assert.equal(channel.videos.size, 1);
  assert.equal(one(db, `SELECT status FROM video_queue`).status, 'published');
  assert.equal([...channel.videos.values()][0].provenanceHash, ok.provenanceHash);
  await loop('publish');                                                   // idempotent: not posted twice
  assert.equal(channel.videos.size, 1);
  await loop('verify');
  assert.equal(one(db, `SELECT verify_status FROM video_queue`).verify_status, 'verified');
  await loop('metrics');
  assert.equal(one(db, `SELECT views FROM video_queue`).views, 7);
  assert.equal(one(db, `SELECT verified FROM video_metrics`).verified, 1);
});

test('below the act rung a video waits as a card; approval publishes it', async () => {
  const { db, channel, settings, loop, packs } = await setup({ rung: null });
  await submitVideo({ db, now: () => T0, settings, video: video() });
  const ctx = await loop('publish');
  assert.equal(channel.videos.size, 0);
  const q = one(db, `SELECT * FROM video_queue`);
  assert.equal(q.status, 'awaiting_approval');
  assert.match(ctx.notes.join(' '), /waits on decision card/);
  const r = await packs.guard.approve(q.guard_queue_id, { by: 'owner' });
  assert.equal(r.decision, 'sent');
  await loop('publish');
  assert.equal(one(db, `SELECT status FROM video_queue`).status, 'published');
});

test('kill switch stops publishing and keeps the video queued; caps hold', async () => {
  const { db, channel, settings, loop, packs } = await setup();
  await packs.setSwitch('pack:video', true, 'test');
  await submitVideo({ db, now: () => T0, settings, video: video() });
  await loop('publish');
  assert.equal(channel.videos.size, 0);
  assert.equal(one(db, `SELECT status FROM video_queue`).status, 'queued');
  const capped = await setup({ caps: { per_day: 1, per_week: 1 } });
  await submitVideo({ db: capped.db, now: () => T0, settings: capped.settings, video: video() });
  await submitVideo({ db: capped.db, now: () => T0, settings: capped.settings, video: video({ asset_sha256: 'b'.repeat(64) }) });
  await capped.loop('publish');
  assert.equal(capped.channel.videos.size, 1);
  assert.equal(rows(capped.db, `SELECT * FROM video_queue WHERE status = 'queued'`).length, 1);
});

test('verify fails and files an item when provenance differs; metrics marks a vanished video removed', async () => {
  const a = await setup();
  await submitVideo({ db: a.db, now: () => T0, settings: a.settings, video: video() });
  await a.loop('publish');
  a.channel.tamper = true;
  await a.loop('verify');
  assert.equal(one(a.db, `SELECT verify_status FROM video_queue`).verify_status, 'failed');
  assert.equal(rows(a.db, `SELECT id FROM items WHERE id LIKE 'VIDEOVERIFY-%'`).length, 1);
  const b = await setup();
  await submitVideo({ db: b.db, now: () => T0, settings: b.settings, video: video() });
  await b.loop('publish'); await b.loop('verify');
  b.channel.missing.add('vid-1');
  await b.loop('metrics');
  assert.equal(one(b.db, `SELECT status FROM video_queue`).status, 'removed');
  assert.equal(rows(b.db, `SELECT id FROM items WHERE id LIKE 'VIDEOREMOVED-%'`).length, 1);
});
