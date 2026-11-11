// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDb } from './d1shim.js';
import { buildConsole, resolveCard, recordAsk, handleConsole } from '../src/console.js';

function seed(db) {
  db.raw.exec(`INSERT INTO items (id,title,owner_role,done_check,status) VALUES ('A','Build the booking page','staff','x','ready'),('B','Old thing','staff','x','done');
    INSERT INTO items (id,title,owner_role,done_check,status,blocker) VALUES ('C','Needs a thing','staff','x','blocked','waiting on D');
    INSERT INTO gate_cards (id,what,why_gated,default_in_effect,closing_probe) VALUES ('G1','Approve a monthly spend of 50 USD','money','spend stays at zero','manual'),('G2','Set the CLOUDFLARE_API_TOKEN secret','identity','dry run only','env:CLOUDFLARE_API_TOKEN');
    INSERT INTO tick_runs (started_at,finished_at,steps_completed,steps_total,report) VALUES ('2026-11-11T00:00:00Z','2026-11-11T00:00:01Z',11,11,'ok');`);
}

test('three screens are small and say what needs the person', async () => {
  const db = makeDb(); seed(db);
  const c = await buildConsole(db);
  assert.match(c.headline, /2 things need you/);
  assert.equal(c.needs_you.cards.length, 2);
  assert.ok(c.needs_you.cards.every(x => x.kind === 'manual' || x.kind === 'secret'));
  assert.equal(c.now.working_on.length, 1); assert.equal(c.now.stuck[0].id, 'C');
  assert.ok(c.suggestions.length <= 3);
});

test('a manual card closes by button and the press is recorded; a secret card cannot be closed by button', async () => {
  const db = makeDb(); seed(db);
  assert.equal((await resolveCard(db, 'G1', 'done')).status, 200);
  assert.equal(db.raw.prepare("SELECT status FROM gate_cards WHERE id='G1'").get().status, 'closed');
  assert.equal(db.raw.prepare("SELECT kind FROM console_actions").get().kind, 'card_done');
  const r = await resolveCard(db, 'G2', 'done');
  assert.equal(r.status, 409); assert.match(r.body.explain, /only you can add/);
  assert.equal(db.raw.prepare("SELECT status FROM gate_cards WHERE id='G2'").get().status, 'open');
  assert.equal((await resolveCard(db, 'NOPE', 'done')).status, 404);
});

test('a typed request becomes a work item with the words kept verbatim; out-of-scope requests are held', async () => {
  const db = makeDb(); seed(db);
  const ok = await recordAsk(db, 'I want a page where neighbours can book a drill');
  assert.equal(ok.body.held, false);
  assert.equal(db.raw.prepare("SELECT status FROM items WHERE id=?").get(ok.body.id).status, 'open');
  const held = await recordAsk(db, 'Please write my business plan and a pitch deck');
  assert.equal(held.body.held, true); assert.match(held.body.message, /does not do by default/);
  const it = db.raw.prepare("SELECT status, blocker FROM items WHERE id=?").get(held.body.id);
  assert.equal(it.status, 'blocked'); assert.match(it.blocker, /SCOPE\.md/);
  assert.equal(db.raw.prepare("SELECT text FROM console_actions WHERE ref=?").get(held.body.id).text, 'Please write my business plan and a pitch deck');
  assert.equal((await recordAsk(db, '   ')).status, 400);
});

test('console is off without a token, refuses a wrong key, and refuses cross-origin writes', async () => {
  const db = makeDb(); seed(db);
  const U = 'https://x.example';
  assert.equal((await handleConsole(new Request(U + '/console'), { DB: db })).status, 503);
  const env = { DB: db, CONSOLE_TOKEN: 'correct-horse' };
  assert.equal((await handleConsole(new Request(U + '/api/console'), env)).status, 401);
  const bad = new Request(U + '/console/login', { method: 'POST', body: new URLSearchParams({ key: 'nope' }) });
  assert.equal((await handleConsole(bad, env)).status, 401);
  const good = await handleConsole(new Request(U + '/console/login', { method: 'POST', body: new URLSearchParams({ key: 'correct-horse' }) }), env);
  assert.equal(good.status, 303);
  const ck = good.headers.get('set-cookie'); assert.match(ck, /HttpOnly/); assert.match(ck, /SameSite=Strict/);
  const cookie = ck.split(';')[0];
  const api = await handleConsole(new Request(U + '/api/console', { headers: { cookie } }), env);
  assert.equal(api.status, 200); assert.equal((await api.json()).needs_you.cards.length, 2);
  const page = await handleConsole(new Request(U + '/console', { headers: { cookie } }), env);
  assert.equal(page.status, 200); assert.match(await page.text(), /Say what you want/);
  const post = (origin) => handleConsole(new Request(U + '/api/console/ask', { method: 'POST', headers: { cookie, 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify({ text: 'hello' }) }), env);
  assert.equal((await post(null)).status, 403);
  assert.equal((await post('https://evil.example')).status, 403);
  assert.equal((await post(U)).status, 200);
  assert.equal(await handleConsole(new Request(U + '/health'), env), null);
});
