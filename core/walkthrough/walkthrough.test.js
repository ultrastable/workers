// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// US-SPEC-18 sections 4 to 6: the walkthrough generated from the needs register (US-18-R11, R12), Elicitation Ask cards,
// the read-back screen (US-16-R12 to R14) and the per-person profile.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { makeDb } from '../_shared/testdb.js';
import { createElicit, validateCard, EXTRA_OPTIONS } from '../elicit/index.js';
import { buildConsole } from '../src/console.js';
import { createWalkthrough, validateProfile, compose, renderReadBack, IDEA_QUESTION, LIST_MAX } from './index.js';

const dir = p => fileURLToPath(new URL(p, import.meta.url));
const CATALOG = JSON.parse(readFileSync(dir('./catalog.json'), 'utf8'));
const T0 = Date.UTC(2026, 10, 15, 12, 0, 0);
const H = 3600e3;
const mk = (config = {}, elicitConfig = {}) => {
  const db = makeDb([dir('../elicit/migrations/'), dir('./migrations/')]); const t = { v: T0 }; const now = () => t.v;
  const make = () => createWalkthrough({ db, elicit: createElicit({ db, now, config: { daily_cap: 20, ...elicitConfig } }), now, config: { catalog: CATALOG, ...config } });
  return { db, t, wt: make(), make };
};
const IDEA = 'I want a weekly pairings page for my chess club members, called "Knight Moves". We can pay $20 a month.';
const get = (db, sql, ...a) => db.raw.prepare(sql).get(...a);

test('US-00-R10: the shipped catalog asks a person for no architecture, schema or stack choice; every need makes a complete Ask card in plain words (T16-2) and names the artifact it feeds', () => {
  assert.ok(CATALOG.needs.length >= 8);
  for (const c of CATALOG.needs) {
    const problems = validateCard({ need_id: c.id, question: c.question, why: c.why, cue: c.cue, options: [...(c.options || []), ...EXTRA_OPTIONS], free_text: c.free_text, default: c.default ?? 'none', default_consequence: c.default_consequence, reversibility: 'reversible', priority: 1 });
    assert.deepEqual(problems, [], c.id);
    assert.match(c.artifact, /^A-(INI|PLN)-\d+$/);
    assert.ok(!/architecture|schema|stack|database|framework|hosting|language/i.test([c.question, c.why, c.cue, ...(c.options || [])].join(' ')), c.id);
  }
});

test('US-SPEC-18 step 1: the first screen is one question with an example; the answer is stored verbatim as the idea record', async () => {
  const { db, wt } = mk();
  const s = await wt.current('ana');
  assert.equal(s.step, 1); assert.equal(s.question, IDEA_QUESTION); assert.ok(s.example); assert.ok(s.suggestions.length <= LIST_MAX);
  assert.equal((await wt.submitIdea('ana', '   ')).ok, false);
  assert.equal((await wt.submitIdea('ana', IDEA)).ok, true);
  assert.equal(get(db, `SELECT idea_text FROM walkthrough_state WHERE person='ana'`).idea_text, IDEA);
  assert.equal(get(db, `SELECT text FROM console_actions WHERE kind='idea'`).text, IDEA);
  assert.equal((await wt.submitIdea('ana', 'again')).ok, false);
});

test('the walkthrough is generated from the needs register: what the idea answers is derived and not asked, so two people get different walkthroughs', async () => {
  const a = mk(); await a.wt.submitIdea('ana', IDEA);
  const derived = a.db.raw.prepare(`SELECT id, value FROM elicit_needs WHERE state='derived' ORDER BY id`).all().map(r => r.id);
  assert.deepEqual(derived, ['audience', 'monthly_cost', 'name']);
  const b = mk(); await b.wt.submitIdea('ben', 'Something to keep track of my garden.');
  const seq = async ({ wt }, person) => { const ids = []; for (let i = 0; i < 12; i++) { const s = await wt.current(person); if (s.kind !== 'ask') break; ids.push(s.card.need_id); await wt.answer(person, s.card.need_id, { choice: 'Not sure' }); } return ids; };
  const forAna = await seq(a, 'ana'); const forBen = await seq(b, 'ben');
  assert.ok(!forAna.includes('audience') && !forAna.includes('name') && !forAna.includes('monthly_cost'));
  assert.ok(forBen.includes('audience') && forBen.includes('name') && forBen.includes('monthly_cost'));
  assert.ok(forBen.length > forAna.length);
});

test('US-SPEC-18 step 2: one Ask card at a time, highest value first, with the options, Not sure and Tell me more as buttons', async () => {
  const { db, wt } = mk(); await wt.submitIdea('ana', IDEA);
  const s = await wt.current('ana');
  assert.equal(s.step, 2); assert.equal(s.kind, 'ask');
  const top = db.raw.prepare(`SELECT id FROM elicit_needs WHERE state='asked' ORDER BY priority DESC, id LIMIT 1`).get().id;
  assert.equal(s.card.need_id, top);
  assert.deepEqual(s.card.buttons.slice(-2), ['Not sure', 'Tell me more']);
  const more = await wt.answer('ana', s.card.need_id, { choice: 'Tell me more' });
  assert.ok(more.explain); assert.equal(more.card.need_id, s.card.need_id);
  assert.equal((await wt.current('ana')).card.need_id, s.card.need_id, 'Tell me more keeps the same card');
  assert.equal(get(db, `SELECT COUNT(*) AS n FROM console_actions WHERE kind='elicit_answer'`).n, 0);
});

test('US-18-R01 and US-16-R07: an Ask button writes the register and an action record, with the words stored verbatim', async () => {
  const { db, wt } = mk(); await wt.submitIdea('ana', IDEA);
  await wt.answer('ana', 'success', { choice: 'It saves me time' });
  await wt.answer('ana', 'first_outcome', { text: '  Show who plays whom, every Monday  ' });
  const n = get(db, `SELECT state, value, provenance, channel, answer_text FROM elicit_needs WHERE id='success'`);
  assert.deepEqual({ ...n }, { state: 'answered', value: 'It saves me time', provenance: 'stated', channel: 'console', answer_text: 'It saves me time' });
  assert.equal(get(db, `SELECT answer_text FROM elicit_needs WHERE id='first_outcome'`).answer_text, '  Show who plays whom, every Monday  ');
  assert.deepEqual(db.raw.prepare(`SELECT ref, text FROM console_actions WHERE kind='elicit_answer' ORDER BY id`).all().map(r => [r.ref, r.text]), [['success', 'It saves me time'], ['first_outcome', '  Show who plays whom, every Monday  ']]);
  assert.equal((await wt.answer('ana', 'success', { choice: 'Something else' })).ok, false);
  assert.equal((await wt.answer('nobody', 'success', { choice: 'It saves me time' })).ok, false);
});

test('US-SPEC-18 step 3: a step only the person can do is a card beside every step and never blocks; a question with no safe guess has no Not sure button', async () => {
  const { db, wt } = mk(); await wt.submitIdea('ana', IDEA);
  db.raw.exec(`INSERT INTO gate_cards (id,what,why_gated,default_in_effect,closing_probe) VALUES ('a-key','Add the mail key','secret','mail stays off','env:MAIL_KEY')`);
  const s = await wt.current('ana');
  assert.equal(s.kind, 'ask', 'the walkthrough goes on while setup cards are open');
  const ask = s.setup.cards.find(c => c.kind === 'ask');
  assert.equal(ask.need_id, 'private_details'); assert.ok(!ask.buttons.includes('Not sure')); assert.ok(ask.buttons.includes('Tell me more'));
  assert.equal(s.setup.cards.find(c => c.id === 'a-key').kind, 'secret');
  assert.equal((await wt.answer('ana', 'private_details', { choice: 'Not sure' })).refusal, 'cannot_default');
  assert.equal((await wt.answer('ana', 'private_details', { choice: 'No' })).ok, true);
  assert.equal(get(db, `SELECT status FROM gate_cards WHERE id LIKE 'elicit-%private_details'`).status, 'closed');
});

test('US-18-R11: the walkthrough is resumable from the records and does not block on any card; unanswered cards fall to their defaults after their time', async () => {
  const { db, t, wt, make } = mk(); await wt.submitIdea('ana', IDEA);
  const first = await wt.current('ana');
  await wt.answer('ana', first.card.need_id, { choice: 'Not sure' });
  const second = await wt.current('ana');
  const resumed = await make().current('ana');
  assert.equal(resumed.step, 2); assert.equal(resumed.card.need_id, second.card.need_id, 'a fresh handle over the same store continues at the same card');
  t.v += 73 * H;
  let s = await make().current('ana');
  for (let i = 0; i < 5 && s.kind === 'ask'; i++) { t.v += 73 * H; s = await make().current('ana'); }
  assert.equal(s.step, 4); assert.equal(s.kind, 'readback');
  assert.ok(get(db, `SELECT COUNT(*) AS n FROM elicit_assumptions WHERE reason='timeout'`).n >= 3);
  assert.equal(get(db, `SELECT state FROM elicit_needs WHERE id='private_details'`).state, 'gated', 'the one with no safe guess is still waiting, and nothing waited for it');
});

const finish = async ({ wt }, person) => { for (let i = 0; i < 20; i++) { const s = await wt.current(person); if (s.kind !== 'ask') return s; await wt.answer(person, s.card.need_id, { choice: s.card.free_text ? undefined : s.card.buttons[1], text: s.card.free_text ? 'typed answer' : undefined }); } throw new Error('walkthrough did not end'); };

test('US-SPEC-18 step 4 and US-16-R12: the read-back restates everything with defaults first, each tagged, each correctable', async () => {
  const w = mk(); await w.wt.submitIdea('ana', IDEA);
  await w.wt.answer('ana', 'success', { choice: 'Not sure' });
  const s = await finish(w, 'ana');
  assert.equal(s.step, 4);
  const st = s.readback.statements;
  assert.equal(st[0].provenance, 'default'); assert.match(st[0].text, /^We assumed/);
  assert.ok(st.findIndex(x => x.provenance !== 'default') >= s.readback.defaults);
  for (const x of st) assert.ok(['stated', 'derived', 'default', 'researched'].includes(x.provenance));
  assert.deepEqual(st.find(x => x.need_id === 'success').options, ['More people use it', 'It saves me time', 'It makes fewer mistakes']);
  assert.deepEqual(st.find(x => x.need_id === 'name').options, []);
});

test('T16-8 through the screen: a correction changes the register, records the action and queues the affected artifact to be redone', async () => {
  const w = mk(); await w.wt.submitIdea('ana', IDEA);
  await w.wt.answer('ana', 'success', { choice: 'Not sure' }); await finish(w, 'ana');
  const r = await w.wt.correct('ana', 'success', 'It makes fewer mistakes');
  assert.deepEqual(r.rerun, ['ELICIT-RERUN-MAIN-A-INI-2']);
  assert.equal(get(w.db, `SELECT value, provenance FROM elicit_needs WHERE id='success'`).provenance, 'stated');
  assert.ok(get(w.db, `SELECT id FROM items WHERE id='ELICIT-RERUN-MAIN-A-INI-2' AND status='open'`));
  assert.equal(get(w.db, `SELECT text FROM console_actions WHERE kind='readback_correction'`).text, 'It makes fewer mistakes');
  assert.equal((await w.wt.correct('ana', 'success', '  ')).ok, false);
  assert.equal((await w.wt.current('ana')).readback.defaults, 0);
});

test('US-16-R14: an unconfirmed read-back does not hold work; after its time the walkthrough ends and the read-back is flagged', async () => {
  const w = mk(); await w.wt.submitIdea('ana', IDEA); await finish(w, 'ana');
  assert.equal((await w.wt.current('ana')).step, 4);
  w.t.v += 73 * H;
  const end = await w.wt.current('ana');
  assert.equal(end.step, 5); assert.equal(end.readback_unconfirmed, true);
  const c = mk(); await c.wt.submitIdea('ben', IDEA); await finish(c, 'ben'); await c.wt.confirmReadBack('ben');
  const done = await c.wt.current('ben');
  assert.equal(done.step, 5); assert.equal(done.readback_unconfirmed, false); assert.equal(done.next, '/console');
  assert.equal(get(c.db, `SELECT COUNT(*) AS n FROM console_actions WHERE kind='readback_confirmed'`).n, 1);
});

test('US-18-R12: the walkthrough ends by stating exactly what runs and what does not yet, read from the records', async () => {
  const w = mk(); await w.wt.submitIdea('ana', IDEA); await finish(w, 'ana'); await w.wt.confirmReadBack('ana');
  const before = (await w.wt.current('ana')).works;
  assert.ok(before.not_yet.includes('The first regular check has not run yet.')); assert.ok(before.not_yet.includes('There is no live page yet.'));
  assert.ok(before.not_yet.some(x => /1 step only you can do is waiting/.test(x)));
  assert.ok(before.runs.some(x => /Your answers are recorded: \d+ of \d+/.test(x)));
  w.db.raw.exec(`INSERT INTO tick_runs (started_at,finished_at,steps_completed,steps_total) VALUES ('2026-11-15 12:00:00','2026-11-15 12:00:01',8,8);
    INSERT INTO items (id,title,owner_role,done_check,status) VALUES ('A','a','staff','x','ready')`);
  const live = createWalkthrough({ db: w.db, elicit: createElicit({ db: w.db, now: () => w.t.v }), now: () => w.t.v, config: { catalog: CATALOG, working_url: 'https://club.example/' } });
  const after = (await live.current('ana')).works;
  assert.ok(after.runs.includes('The regular check runs: the last one finished at 2026-11-15 12:00:01.'));
  assert.ok(after.runs.includes('Your page is at https://club.example/.')); assert.ok(after.runs.some(x => /1 in hand/.test(x)));
});

test('the profile is set from walkthrough answers, and may be changed by the person within the rules', async () => {
  const { wt } = mk(); await wt.submitIdea('ana', IDEA);
  assert.equal((await wt.profile('ana')).source, 'default');
  await wt.answer('ana', 'detail', { choice: 'More detail' }); await wt.answer('ana', 'check_cadence', { choice: 'Every ten minutes' });
  const p = await wt.profile('ana');
  assert.equal(p.detail, 'more'); assert.equal(p.cadence_minutes, 10); assert.equal(p.source, 'walkthrough');
  const r = await wt.setProfile('ana', { language: 'pt-BR', metrics: ['waiting_on_you', 'done'] });
  assert.equal(r.ok, true); assert.equal(r.profile.language, 'pt-BR'); assert.equal(r.profile.detail, 'more');
});

test('section 6: a profile cannot remove the Needs-you screen, hide a decision card, lengthen a list or loosen access', () => {
  assert.deepEqual(validateProfile({ detail: 'more', language: 'en', cadence_minutes: 30, metrics: ['open'] }), []);
  for (const bad of [{ hide_needs_you: true }, { hidden_cards: ['G1'] }, { list_max: 10 }, { screens: ['now'] }, { third_party: true }, { access: 'open' }]) assert.equal(validateProfile(bad).length, 1, JSON.stringify(bad));
  assert.ok(validateProfile({ metrics: ['open', 'done', 'stuck', 'waiting_on_you'] })[0].includes('one to 3'));
  assert.ok(validateProfile({ metrics: ['revenue'] })[0].includes('unknown metric'));
  assert.ok(validateProfile({ extra_cards: [{ id: 'x', what: 'Pick a colour' }] })[0].includes('what happens if the person does nothing'));
  assert.equal(validateProfile({ detail: 'everything' }).length, 1); assert.equal(validateProfile({ cadence_minutes: 0 }).length, 1); assert.equal(validateProfile({ language: 'English please' }).length, 1);
});

test('US-18-R05 and T18-3 with a profile: Ask cards join Needs you, no open decision card is hidden, lists hold at most three and extras become a count', async () => {
  const { db, wt } = mk(); await wt.submitIdea('ana', IDEA);
  db.raw.exec(`INSERT INTO tick_runs (started_at,finished_at,steps_completed,steps_total) VALUES ('2026-11-15 12:00:00','2026-11-15 12:00:01',8,8);
    INSERT INTO gate_cards (id,what,why_gated,default_in_effect,closing_probe) VALUES ('a-pay','Approve the plan','money','stays on the free plan','manual');
    INSERT INTO items (id,title,owner_role,done_check,status) VALUES ('A','a','staff','x','ready'),('B','b','staff','x','claimed'),('C','c','staff','x','ready'),('D','d','staff','x','done')`);
  await wt.current('ana');
  await wt.setProfile('ana', { extra_cards: [{ id: 'season', what: 'Pick the season dates', default_in_effect: 'last year\'s dates are used' }], metrics: ['waiting_on_you', 'done'] });
  const raw = await buildConsole(db, {});
  const out = await wt.screens('ana', raw);
  assert.equal(out.needs_you.cards.length, LIST_MAX);
  for (const c of raw.needs_you.cards) assert.ok(out.needs_you.cards.some(o => o.id === c.id), `${c.id} is still shown`);
  const gated = out.needs_you.cards.find(c => c.need_id === 'private_details');
  assert.equal(gated.kind, 'ask'); assert.ok(!gated.buttons.includes('Not sure'));
  const total = raw.needs_you.cards.length + raw.needs_you.more + 3 + 1; // three open Asks with defaults, one program card
  assert.equal(out.needs_you.cards.length + out.needs_you.more, total);
  assert.match(out.headline, new RegExp(`${total} things need you`));
  for (const c of out.needs_you.cards) assert.ok(c.default_in_effect, 'every decision card says what happens if the person does nothing (US-18-R07)');
  assert.deepEqual(out.now.numbers, [{ metric: 'waiting_on_you', value: raw.needs_you.cards.length + raw.needs_you.more }, { metric: 'done', value: 1 }]);
  assert.equal(out.now.working_on.length, 1, 'brief detail');
  assert.equal(compose(raw, { detail: 'more' }).now.working_on.length, 3);
  assert.deepEqual(compose(raw, {}).needs_you, raw.needs_you, 'no profile and no asks: the default composition');
});

test('the read-back screen: defaults marked, options as buttons, every value escaped, nothing loaded from another host (US-18-R10)', () => {
  const html = renderReadBack({ defaults: 1, statements: [
    { need_id: 'look', text: 'We assumed the look is "<b>plain</b>".', assumption: true, value: 'plain', options: ['plain', 'polished "pro"'] },
    { need_id: 'name', text: 'What to call it: <script>alert(1)</script>', assumption: false, value: 'x', options: [] }] });
  assert.ok(!html.includes('<b>plain</b>')); assert.ok(!html.includes('<script>alert(1)')); assert.match(html, /&lt;script&gt;alert\(1\)/);
  assert.match(html, /class="assumed"/); assert.match(html, /data-value="polished &quot;pro&quot;"/); assert.ok(!html.includes('data-value="plain"'), 'the current value is not offered as a correction');
  assert.match(html, /input aria-label="Correct this" data-for="name"/);
  assert.ok(!/(src|href)=|https?:\/\/|@import|url\(/i.test(html));
  assert.ok(html.indexOf('assumed') < html.indexOf('What to call it'));
});

test('routes: same-origin writes only (US-18-R09), JSON for agents and people alike (section 7), the screen as HTML', async () => {
  const { db, wt } = mk();
  const O = 'https://org.example';
  const call = (path, body, headers = { origin: O }) => wt.handle(new Request(O + path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }), { person: 'ana' });
  assert.equal(await call('/api/console'), null);
  assert.equal((await (await call('/api/console/walkthrough')).json()).step, 1);
  assert.equal((await call('/console/readback')).status, 303);
  assert.equal((await call('/api/console/walkthrough/idea', { text: IDEA }, {})).status, 403);
  assert.equal((await call('/api/console/walkthrough/idea', { text: IDEA }, { origin: 'https://evil.example' })).status, 403);
  assert.equal(get(db, `SELECT COUNT(*) AS n FROM walkthrough_state`).n, 0);
  const idea = await (await call('/api/console/walkthrough/idea', { text: IDEA })).json();
  assert.equal(idea.next.step, 2);
  const ans = await (await call('/api/console/walkthrough/answer', { need_id: idea.next.card.need_id, choice: 'Not sure' })).json();
  assert.equal(ans.state, 'defaulted'); assert.notEqual(ans.next.card?.need_id, idea.next.card.need_id);
  assert.equal((await call('/api/console/walkthrough/answer', { need_id: 'nope', choice: 'x' })).status, 400);
  const page = await call('/console/readback');
  assert.equal(page.headers.get('content-type'), 'text/html; charset=utf-8'); assert.match(page.headers.get('content-security-policy'), /default-src 'none'/);
  assert.match(await page.text(), /Here is what we understood/);
  assert.ok((await (await call('/api/console/readback')).json()).statements.length >= 4);
  assert.equal((await (await call('/api/console/readback', { need_id: idea.next.card.need_id, value: 'my own words' })).json()).reload, true);
  assert.equal((await (await call('/api/console/readback', { confirm_readback: true })).json()).ok, true);
  assert.equal((await call('/api/console/profile', { hide_needs_you: true })).status, 400);
  assert.equal((await (await call('/api/console/profile', { detail: 'more' })).json()).profile.detail, 'more');
  assert.equal((await (await call('/api/console/profile')).json()).detail, 'more');
  assert.throws(() => createWalkthrough({ db }), /needs register/);
});
