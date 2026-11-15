// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// The default deployment: a configuration that names only its repository. No `enabled` flag, no backlog file, no target map.
// The first tick must file the specified-but-unbuilt capabilities as ready items and start the runner path by itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDb } from '../_shared/testdb.js';
import { OUT_DIR } from '../../tools/build_migrations.mjs';
import { createOrg } from '../org/index.js';

const T0 = Date.parse('2026-11-15T10:00:00Z');
const SPEC = '# US-SPEC-03 tick\n\n## 9. Reference implementation status\n\n- Tick: BUILT (`core/src/tick.js`).\n- Managerial tick: PLANNED.\n- Step list: BUILT (`worker/src/gone.js`).\n';
const host = async url => {
  const u = String(url), ok = b => new Response(typeof b === 'string' ? b : JSON.stringify(b), { status: 200 });
  if (u.includes('/contents/specs?')) return ok([{ name: 'US-SPEC-03-tick.md' }]);
  if (u.includes('/contents/specs/US-SPEC-03-tick.md')) return ok(SPEC);
  if (u.includes('/git/trees/')) return ok({ tree: [{ path: 'core/src/tick.js' }] });
  return new Response('{}', { status: 404 });
};

test('with only a repository configured, one tick files the unbuilt capabilities and asks for nothing', async () => {
  const db = makeDb([OUT_DIR]);
  const org = createOrg({ db, env: {}, config: { org_slug: 'any-org', vcs: { repo: 'owner/name' } }, fetch: host, now: () => T0 });
  const names = org.extraSteps().map(s => s.name);
  assert.ok(names.includes('specloop'), 'the specification loop is on without being switched on');
  assert.ok(names.some(n => n.startsWith('runner')), 'the runner path is on without being switched on');
  await org.tick();
  const items = db.raw.prepare(`SELECT id, status, done_check FROM items WHERE project='spec-to-code' ORDER BY id`).all();
  assert.deepEqual(items.map(i => [i.id, i.status]), [['US-SPEC-03-2', 'ready'], ['US-SPEC-03-3', 'ready']]);
  assert.ok(items.every(i => /target: \S+/.test(i.done_check)));
  assert.equal(db.raw.prepare(`SELECT COUNT(*) n FROM items WHERE disposition LIKE 'awaiting target%'`).get().n, 0, 'no item waits for a person to name a file');
  // What the runner lacks is recorded once as machine-readable cards with a default in effect; the loop itself does not stop.
  const cards = db.raw.prepare(`SELECT id, default_in_effect, closing_probe FROM gate_cards WHERE id LIKE 'runner-needs-%'`).all();
  assert.ok(cards.length >= 1 && cards.every(c => c.default_in_effect && c.closing_probe));
  assert.equal(JSON.parse(db.raw.prepare(`SELECT value FROM org WHERE key='spec_remaining'`).get().value).remaining, 2);
});

test('config.specloop.enabled === false and config.runner.enabled === false are the only off switches', () => {
  const db = makeDb([OUT_DIR]);
  const org = createOrg({ db, env: {}, config: { vcs: { repo: 'owner/name' }, specloop: { enabled: false }, runner: { enabled: false } }, fetch: host, now: () => T0 });
  const names = org.extraSteps().map(s => s.name);
  assert.ok(!names.includes('specloop') && !names.some(n => n.startsWith('runner')));
});
