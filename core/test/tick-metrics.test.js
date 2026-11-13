// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// US-SPEC-05: a prediction is scored against a metric. A caller can register domain metrics; an unknown metric is still scored a miss.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeDb } from '../_shared/testdb.js';
import { runTick } from '../src/tick.js';

const policy = JSON.parse(readFileSync(new URL('../../autonomy/policy.json', import.meta.url), 'utf8'));
const config = { org_slug: 'metrics-org', claim_ttl_minutes: 120, max_wip_per_role: 3, plus_share: 0.2, policy: { trust: policy.trust, ladder: policy.ladder, surfaces: {} } };
const T0 = Date.parse('2026-11-01T00:00:00Z');

async function seed(db) {
  for (const [id, metric, op, target] of [['p-known', 'items_done', '>=', 0], ['p-domain', 'domain_score', '>=', 5], ['p-unknown', 'no_such_metric', '>=', 0]]) {
    await db.prepare(`INSERT INTO predictions (id, metric, op, target, due_at) VALUES (?,?,?,?, '2026-10-31 00:00:00')`).bind(id, metric, op, target).run();
  }
}
const verdicts = db => Object.fromEntries(db.raw.prepare(`SELECT id, verdict, observed FROM predictions`).all().map(r => [r.id, r]));

test('a registered domain metric scores its prediction, receives the prediction row, and built-ins still work', async () => {
  const db = makeDb(); await seed(db);
  let seen = null;
  await runTick(db, { config, now: T0, metrics: { domain_score: async (_db, _now, row) => { seen = row.id; return 7; } } });
  const v = verdicts(db);
  assert.equal(v['p-domain'].verdict, 'hit');
  assert.equal(v['p-domain'].observed, 7);
  assert.equal(seen, 'p-domain');
  assert.equal(v['p-known'].verdict, 'hit');
});

test('without registration, an unknown metric is still scored a miss (unchanged behaviour)', async () => {
  const db = makeDb(); await seed(db);
  await runTick(db, { config, now: T0 });
  const v = verdicts(db);
  assert.equal(v['p-domain'].verdict, 'miss');
  assert.equal(v['p-unknown'].verdict, 'miss');
});
