// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Tests for packs/analytics (US-SPEC-21 class A). In-memory database; no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { makeDb } from '../../core/_shared/testdb.js';
import { KERNEL_DIR } from '../../core/kernel/testkit.js';
import { createPacks, validateManifest, loadManifest, MIGRATIONS_DIR } from '../../core/packs/index.js';
import { recordPageview, report } from './index.js';

const DIR = fileURLToPath(new URL('./', import.meta.url));
const MIG = fileURLToPath(new URL('./migrations/', import.meta.url));
const D = 86400e3;
const T0 = Date.parse('2026-11-11T10:00:00Z');
const rows = (db, sql, ...a) => db.raw.prepare(sql).all(...a).map(r => ({ ...r }));
const one = (db, sql, ...a) => db.raw.prepare(sql).get(...a);
const UA = 'Mozilla/5.0 (X11; Linux) Firefox/130';
const S = { salt: 'test-salt-value', own_hosts: ['example.org'] };
const req = (over = {}) => ({ url: 'https://example.org/about?utm_source=social&utm_medium=post&utm_campaign=claims&email=a@b.c', referrer: 'https://news.example.net/x', userAgent: UA, ip: '203.0.113.9', ...over });

async function setup(clock = { t: T0 }) {
  const db = makeDb([KERNEL_DIR, MIGRATIONS_DIR, MIG]);
  const packs = createPacks({ db, now: () => clock.t, config: { packs: { analytics: S } }, channels: {} });
  const m = loadManifest(DIR);
  assert.deepEqual((await packs.register(m, { dir: DIR })).errors, undefined);
  assert.equal((await packs.enablePack('analytics', { by: 'owner', cardText: m.enable_gate })).ok, true);
  const loop = async name => {
    const step = (await packs.packSteps()).find(x => x.name === `pack:analytics:${name}`);
    const ctx = { tickId: 12, errors: [], notes: [], now: clock.t };
    await step.run(db, ctx);
    assert.deepEqual(ctx.errors, []);
    return ctx;
  };
  const rec = (r, t = clock.t) => recordPageview({ db, now: () => t, settings: S, request: r });
  return { db, loop, rec, clock };
}

test('manifest is valid, class A with no outbound, analytics_ prefixed tables, probes run', () => {
  const m = loadManifest(DIR);
  assert.deepEqual(validateManifest(m, { tenantNames: ['acme'] }), []);
  assert.equal(m.class, 'A');
  assert.equal(m.outbound, undefined);
  assert.ok(m.loops.every(l => l.outbound === false));
  const db = makeDb([KERNEL_DIR, MIGRATIONS_DIR, MIG]);
  const sql = readFileSync(new URL('./migrations/0001_analytics.sql', import.meta.url), 'utf8');
  db.raw.exec(sql); db.raw.exec(sql);
  assert.deepEqual(rows(db, `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'analytics_%'`).map(r => r.name).sort(), ['analytics_daily', 'analytics_events', 'analytics_metrics', 'analytics_sources']);
  for (const g of [...m.charter.guard_metrics, m.charter.primary_metric]) db.raw.prepare(g.read_probe).get();
});

test('a page view stores path, referrer host and tags only: no query, no IP, no raw UA', async () => {
  const { db, rec } = await setup();
  assert.deepEqual(await rec(req()), { recorded: true });
  const e = one(db, `SELECT * FROM analytics_events`);
  assert.equal(e.path, '/about');
  assert.equal(e.referrer, 'news.example.net');
  assert.equal(e.utm_source, 'social');
  assert.match(e.visitor_hash, /^[0-9a-f]{64}$/);
  const dump = JSON.stringify(rows(db, `SELECT * FROM analytics_events`));
  for (const leak of ['203.0.113.9', 'Firefox', 'a@b.c', 'email']) assert.ok(!dump.includes(leak), leak);
});

test('bots, Do Not Track, Global Privacy Control, foreign hosts are skipped; a missing salt is refused', async () => {
  const { db, rec } = await setup();
  assert.deepEqual(await rec(req({ userAgent: 'Googlebot/2.1' })), { skipped: 'bot' });
  assert.deepEqual(await rec(req({ userAgent: '' })), { skipped: 'bot' });
  assert.deepEqual(await rec(req({ dnt: '1' })), { skipped: 'do_not_track' });
  assert.deepEqual(await rec(req({ gpc: '1' })), { skipped: 'do_not_track' });
  assert.deepEqual(await rec(req({ url: 'https://other.example.net/' })), { skipped: 'foreign_host' });
  assert.deepEqual(await rec(req({ url: 'not a url' })), { skipped: 'bad_url' });
  assert.equal(one(db, `SELECT COUNT(*) AS n FROM analytics_events`).n, 0);
  await assert.rejects(recordPageview({ db, settings: { own_hosts: ['example.org'] }, request: req() }), /salt/);
});

test('the visitor hash is stable within a day and cannot link the same visitor across days', async () => {
  const { db, rec } = await setup();
  await rec(req()); await rec(req({ url: 'https://example.org/b' }));
  await rec(req(), T0 + D);
  const h = rows(db, `SELECT day, visitor_hash FROM analytics_events ORDER BY id`);
  assert.equal(h[0].visitor_hash, h[1].visitor_hash);
  assert.notEqual(h[0].visitor_hash, h[2].visitor_hash);
});

test('rollup counts views and unique visitors per page and source; rerunning changes nothing', async () => {
  const { db, rec, loop } = await setup();
  await rec(req()); await rec(req());
  await rec(req({ ip: '203.0.113.10' }));
  await rec(req({ url: 'https://example.org/', referrer: '' }));
  await loop('rollup'); await loop('rollup');
  assert.deepEqual(rows(db, `SELECT path, pageviews, visitors FROM analytics_daily ORDER BY path`), [{ path: '/', pageviews: 1, visitors: 1 }, { path: '/about', pageviews: 3, visitors: 2 }]);
  assert.deepEqual(rows(db, `SELECT source, pageviews FROM analytics_sources ORDER BY source`), [{ source: '(direct)', pageviews: 1 }, { source: 'social', pageviews: 3 }]);
  const r = await report({ db, now: () => T0 });
  assert.equal(r.pageviews, 4);
  assert.equal(r.top_pages[0].path, '/about');
});

test('retention deletes raw events past the window after rolling them up, keeping the totals', async () => {
  const { db, rec, loop } = await setup();
  await rec(req(), T0 - 10 * D); await rec(req(), T0 - 1 * D);
  const ctx = await loop('retention');
  assert.match(ctx.notes.join(' '), /purged 1 raw event/);
  assert.equal(one(db, `SELECT COUNT(*) AS n FROM analytics_events`).n, 1);
  assert.equal(one(db, `SELECT SUM(pageviews) AS n FROM analytics_daily`).n, 2);
  for (const g of loadManifest(DIR).charter.guard_metrics) assert.equal(one(db, g.read_probe).value, 0, g.id);
});

test('metrics loop records the counts; the primary probe reads the rollup', async () => {
  const { db, rec, loop } = await setup();
  await rec(req());
  await loop('rollup'); await loop('metrics');
  const m = one(db, `SELECT * FROM analytics_metrics`);
  assert.equal(m.pageviews_7d, 1); assert.equal(m.visitors_today, 1); assert.equal(m.raw_events, 1);
  assert.equal(typeof one(db, loadManifest(DIR).charter.primary_metric.read_probe).value, 'number');
});
