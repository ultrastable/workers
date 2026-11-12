// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Phase P4 (issue #47): a fresh organization described only by org/second-installation.json runs the tick, the
// console and two core modules end to end on the portable adapter, with nothing from the first installation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDb } from '../../adapters/sqlite/d1-sqlite.js';
import { createServer, loadConfig } from '../../adapters/gcp/server.js';
import { acquire } from '../claims/index.js';
import { verify } from '../../agent-setup/verify.mjs';

const root = (p) => fileURLToPath(new URL(`../../${p}`, import.meta.url));
const spec = JSON.parse(readFileSync(root('org/second-installation.json'), 'utf8'));
const MIG = root('adapters/cloudflare/migrations');

test('the descriptor names a fresh org and states what is and is not proven', () => {
  assert.equal(spec.schema, 'second-installation/1');
  assert.match(spec.org.org_slug, /^[a-z][a-z0-9-]+$/);
  assert.match(spec.status, /^OFFLINE-PROVEN/);
  assert.ok(spec.live_proof.closing_probe && spec.live_proof.command);
  assert.ok(!/ghp_|sk-[A-Za-z0-9]{16}|cfut_/.test(JSON.stringify(spec)), 'no secret values');
});

test('fresh org runs tick, console, claims and describe end to end', async () => {
  const env = { TICK_TOKEN: 'tick-' + Math.random().toString(36).slice(2), CONSOLE_TOKEN: 'cons-' + Math.random().toString(36).slice(2) };
  const db = openDb(':memory:', MIG);
  for (const r of spec.seed.roles) db.raw.prepare('INSERT INTO roles (id, role, tick_every, model) VALUES (?,?,?,?)').run(r.id, r.role, r.tick_every, r.model);
  for (const i of spec.seed.items) db.raw.prepare('INSERT INTO items (id,title,owner_role,done_check,priority,status) VALUES (?,?,?,?,?,?)').run(i.id, i.title, i.owner_role, i.done_check, i.priority, i.status);
  const config = { ...loadConfig({}), ...spec.org };
  const srv = createServer({ db, config, env });
  await new Promise(r => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    assert.equal((await fetch(`${base}/health`)).status, 503); // nothing ticked yet
    const tick = await (await fetch(`${base}/tick`, { method: 'POST', headers: { 'x-tick-token': env.TICK_TOKEN } })).json();
    assert.equal(tick.completed, tick.total);
    assert.equal((await fetch(`${base}/health`)).status, 200);
    // console: locked without the key, open with it, and it sees this org's item
    assert.equal((await fetch(`${base}/api/console`)).status, 401);
    const login = await fetch(`${base}/console/login`, { method: 'POST', body: new URLSearchParams({ key: env.CONSOLE_TOKEN }), redirect: 'manual' });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const api = await fetch(`${base}/api/console`, { headers: { cookie } });
    assert.equal(api.status, 200);
    assert.ok((await api.json()).headline);
    // core module: describe rendered this org's outputs into its own store and serves them
    assert.ok(db.raw.prepare('SELECT COUNT(*) AS n FROM describe_outputs').get().n > 0, 'describe wrote outputs on the tick');
    assert.equal((await fetch(`${base}/describe.json`)).status, 200);
    // core module: claims. The tick already dispatched the seeded item to its role, so another holder is refused...
    const ctx = { db, now: () => Date.now(), config };
    const held = await acquire(ctx, { item_id: 'S2-1', holder: 'agent-b', intent: 'something else entirely' });
    assert.equal(held.status, 409);
    assert.equal(held.reason, 'held');
    assert.equal(held.holder, 'staff-1');
    // ...while an unclaimed path is granted, then refused to a second holder
    const ok = await acquire(ctx, { path: 'docs/page.md', holder: 'agent-a', intent: 'edit the page' });
    assert.equal(ok.ok, true, JSON.stringify(ok));
    assert.equal((await acquire(ctx, { path: 'docs/page.md', holder: 'agent-b', intent: 'rewrite the footer' })).status, 409);
    // closing probe of the setup skill passes against this installation
    const v = await verify(base);
    assert.equal(v.checks.find(c => c.name === 'a complete tick has run').ok, true);
  } finally { srv.close(); db.close(); }
});

test('separation: the descriptor carries no first-installation identifier', () => {
  const s = readFileSync(root('org/second-installation.json'), 'utf8');
  const banned = new RegExp(['q', 'nfo|quniverse|rwnq8|edb167b7'].join(''), 'i');
  assert.ok(!banned.test(s));
});
