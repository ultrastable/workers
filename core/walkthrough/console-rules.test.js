// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// US-SPEC-18 principles that span the console (core/src/console.js) and the walkthrough: buttons first (R02), prompt second
// (R03), suggestions (R04), open outputs (R08), and the scope hold of US-00-R09.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { makeDb } from '../_shared/testdb.js';
import { createElicit } from '../elicit/index.js';
import { buildConsole, recordAsk, handleConsole } from '../src/console.js';
import { CONSOLE_HTML } from '../src/console-ui.js';
import { createWalkthrough } from './index.js';

const dir = p => fileURLToPath(new URL(p, import.meta.url));
const CATALOG = JSON.parse(readFileSync(dir('./catalog.json'), 'utf8'));
const T0 = Date.UTC(2026, 10, 15, 12, 0, 0);
const mk = () => { const db = makeDb([dir('../elicit/migrations/'), dir('./migrations/')]); const now = () => T0; return { db, wt: createWalkthrough({ db, elicit: createElicit({ db, now, config: { daily_cap: 20, max_open: 9 } }), now, config: { catalog: CATALOG } }) }; };

test('US-18-R02: every walkthrough step can be completed with no typing: suggestions on the first question, buttons on every card, Not sure on free-text ones', async () => {
  const { wt } = mk();
  const first = await wt.current('ana');
  assert.ok(first.suggestions.length >= 1);
  await wt.submitIdea('ana', first.suggestions[0]);
  let seen = 0;
  for (let i = 0; i < 12; i++) {
    const s = await wt.current('ana');
    if (s.kind !== 'ask') { assert.equal(s.kind, 'readback'); break; }
    seen++;
    assert.ok(s.card.buttons.includes('Not sure') && s.card.buttons.includes('Tell me more'), s.card.need_id);
    if (!s.card.free_text) assert.ok(s.card.buttons.length >= 4, 'at least two options plus the two standing buttons');
    assert.equal((await wt.answer('ana', s.card.need_id, { choice: 'Not sure' })).ok, true);
  }
  assert.ok(seen >= 5);
  assert.match(CONSOLE_HTML, /<button/); assert.match(CONSOLE_HTML, /id="chips"/);
});

test('US-18-R03 and T18-5: typed text is stored verbatim and becomes a work item; an out-of-scope request is held and is not dispatchable (US-00-R09)', async () => {
  const { db } = mk();
  const said = 'Could the page  also list the club champions since 1990?';
  const ok = await recordAsk(db, said);
  assert.equal(ok.body.held, false);
  assert.equal(db.raw.prepare(`SELECT text FROM console_actions WHERE ref=?`).get(ok.body.id).text, said);
  assert.equal(db.raw.prepare(`SELECT status, owner_role FROM items WHERE id=?`).get(ok.body.id).status, 'open');
  const held = await recordAsk(db, 'Write me a business plan for investors');
  assert.equal(held.body.held, true); assert.match(held.body.message, /does not do by default/);
  const item = db.raw.prepare(`SELECT status, blocker FROM items WHERE id=?`).get(held.body.id);
  assert.equal(item.status, 'blocked'); assert.match(item.blocker, /Out of scope by default \(SCOPE\.md\): a business plan/);
  assert.equal(db.raw.prepare(`SELECT COUNT(*) AS n FROM items WHERE id=? AND status IN ('open','ready','claimed')`).get(held.body.id).n, 0);
  assert.match(CONSOLE_HTML, /id="asktext"/, 'the prompt box is part of the one page every screen shares');
});

test('US-18-R04: the prompt box comes with at most three suggested requests', async () => {
  const { db } = mk();
  const c = await buildConsole(db, {});
  assert.ok(c.suggestions.length >= 1 && c.suggestions.length <= 3);
});

test('US-18-R08 and T18-6: the same facts the screens show are served as records at GET /api/console, to a person or an agent alike', async () => {
  const { db } = mk();
  db.raw.exec(`INSERT INTO tick_runs (started_at,finished_at,steps_completed,steps_total) VALUES ('2026-11-15 12:00:00','2026-11-15 12:00:01',8,8);
    INSERT INTO items (id,title,owner_role,done_check,status) VALUES ('A','a','staff','x','ready'),('B','b','staff','x','done');
    INSERT INTO gate_cards (id,what,why_gated,default_in_effect,closing_probe) VALUES ('G','Approve','money','stays zero','manual')`);
  const res = await handleConsole(new Request('https://org.example/api/console', { headers: { cookie: 'us_console=k3y' } }), { DB: db, CONSOLE_TOKEN: 'k3y' }, { org: 'example', now: () => T0 });
  assert.equal(res.status, 200);
  const served = await res.json(); const shown = await buildConsole(db, { org: 'example' });
  for (const k of ['headline', 'now', 'needs_you', 'progress', 'suggestions']) assert.deepEqual(served[k], shown[k], k);
  assert.equal((await handleConsole(new Request('https://org.example/api/console'), { DB: db, CONSOLE_TOKEN: 'k3y' }, { now: () => T0 })).status, 401);
});
