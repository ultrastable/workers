// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Conformance tests T16-1 to T16-9 for US-SPEC-16 (issue #60).
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { makeDb } from '../_shared/testdb.js';
import { createElicit, validateCard } from './index.js';

const MIG = fileURLToPath(new URL('./migrations/', import.meta.url));
const T0 = Date.UTC(2026, 10, 12, 12, 0, 0);
const P = 'demo';
const mk = (config = {}, t = { v: T0 }) => { const db = makeDb([MIG]); return { db, t, e: createElicit({ db, now: () => t.v, config }) }; };
const need = (id, extra = {}) => ({
  id, label: `Thing ${id}`, artifact: 'charter', question: `Which ${id} do you want?`, why: `This changes the ${id} we build.`, cue: `Similar projects pick the first one.`,
  options: ['first', 'second', 'third'], default: 'first', default_consequence: 'We rebuild one page; change it any time.', ...extra,
});

test('T16-1 and US-16-R01: register covers the catalog and derives what the idea already answers, so it is not asked', async () => {
  const { e } = mk();
  const cat = [need('name', { derive_from: 'bakery', p_wrong: 0.1 }), need('colour'), need('hours')];
  const r = await e.registerNeeds(P, cat, { idea: 'I run a small bakery and want a booking page' });
  assert.equal(r.registered, 3); assert.deepEqual(r.rejected, []);
  const asks = await e.nextAsks(P);
  assert.deepEqual(asks.map(a => a.need_id).sort(), ['colour', 'hours']);
  const rb = await e.readBack(P);
  assert.equal(rb.statements.find(s => s.need_id === 'name').provenance, 'derived');
});

test('T16-2 and US-16-R02: every Ask card has all fields, the question is 25 words or fewer, jargon needs a definition', async () => {
  const { e } = mk();
  const bad = need('x', { question: 'Which database schema should the backend use for storing every customer record you will ever have in the system today, including the ones from many years ago and others?' });
  const r = await e.registerNeeds(P, [need('ok'), bad]);
  assert.equal(r.registered, 1);
  assert.ok(r.rejected[0].problems.some(p => /longer than 25/.test(p)) && r.rejected[0].problems.some(p => /jargon without definition: database/.test(p)));
  const [card] = await e.nextAsks(P);
  assert.deepEqual(validateCard(card), []);
  assert.deepEqual(card.options.slice(-2), ['Not sure', 'Tell me more']); assert.equal(card.default_marked, true);
  assert.ok(validateCard({ ...card, options: ['a', 'Not sure', 'Tell me more'] }).includes('options must be two to four'));
  assert.deepEqual(validateCard({ ...card, question: 'Which API do you want?', defines: ['api'] }), []);
});

test('T16-3 and US-16-R05: Not sure produces the default, an assumption log entry and a revisit trigger', async () => {
  const { db, e } = mk();
  await e.registerNeeds(P, [need('colour')]); await e.nextAsks(P);
  const r = await e.answer(P, 'colour', { choice: 'Not sure' });
  assert.deepEqual(r, { ok: true, state: 'defaulted', value: 'first' });
  const log = db.raw.prepare('SELECT * FROM elicit_assumptions').get();
  assert.equal(log.need_id, 'colour'); assert.equal(log.reason, 'not_sure'); assert.match(log.revisit_trigger, /revisit/);
  assert.equal(db.raw.prepare("SELECT provenance FROM elicit_needs WHERE id='colour'").get().provenance, 'default');
});

test('T16-4 and US-16-R06: a need that would spend above the cap, or is not reversible, becomes a gate card and is never defaulted', async () => {
  const { db, e } = mk({ spend_cap_usd: 10 });
  await e.registerNeeds(P, [need('budget', { cost_usd: 50 }), need('delete', { reversible: false }), need('who', { identity_bound: true }), need('colour')]);
  const cards = await e.nextAsks(P);
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM gate_cards WHERE id LIKE 'elicit-demo-%' AND status='open'").get().n, 3);
  assert.ok(cards.find(c => c.need_id === 'budget'));
  const r = await e.answer(P, 'budget', { choice: 'Not sure' });
  assert.equal(r.ok, false); assert.equal(r.refusal, 'cannot_default');
  assert.equal(db.raw.prepare("SELECT value FROM elicit_needs WHERE id='budget'").get().value, null);
  // time passing never defaults a gated need
  const t = { v: T0 + 10 * 86400e3 }; const late = createElicit({ db, now: () => t.v });
  await late.nextAsks(P);
  assert.equal(db.raw.prepare("SELECT state FROM elicit_needs WHERE id='budget'").get().state, 'gated');
  // answering closes the gate card
  assert.equal((await e.answer(P, 'budget', { choice: 'second', text: 'the second one please' })).ok, true);
  assert.equal(db.raw.prepare("SELECT status FROM gate_cards WHERE id='elicit-demo-budget'").get().status, 'closed');
});

test('T16-5, US-16-R04 and US-16-R16: at most N Asks are open at once, the rest wait; a daily cap and the quiet period also hold', async () => {
  const cat = ['a', 'b', 'c', 'd', 'e'].map((id, i) => need(id, { p_wrong: 0.9 - i * 0.1 }));
  const { e } = mk({ max_open: 3 }); await e.registerNeeds(P, cat);
  assert.deepEqual((await e.nextAsks(P)).map(c => c.need_id), ['a', 'b', 'c']);
  await e.answer(P, 'a', { choice: 'second' });
  assert.deepEqual((await e.nextAsks(P)).map(c => c.need_id), ['b', 'c', 'd']);
  const day = mk({ max_open: 9, daily_cap: 2 }); await day.e.registerNeeds(P, cat);
  assert.equal((await day.e.nextAsks(P)).length, 2);
  const night = mk({ quiet: { from: 22, to: 7 } }, { v: Date.UTC(2026, 10, 12, 23, 0, 0) }); await night.e.registerNeeds(P, cat);
  assert.equal((await night.e.nextAsks(P)).length, 0);
  night.t.v = Date.UTC(2026, 10, 13, 9, 0, 0);
  assert.equal((await night.e.nextAsks(P)).length, 3);
});

test('R10: an unanswered Ask expires to its default after 72 hours and is logged for revisit', async () => {
  const { db, t, e } = mk(); await e.registerNeeds(P, [need('colour')]); await e.nextAsks(P);
  t.v += 71 * 3600e3; assert.equal(await e.expire(P), 0);
  t.v += 2 * 3600e3; assert.equal(await e.expire(P), 1);
  assert.equal(db.raw.prepare('SELECT reason FROM elicit_assumptions').get().reason, 'timeout');
});

test('R07 and R09: the answer is stored verbatim with channel and time; Tell me more explains and keeps the same card, three times teaches the glossary', async () => {
  const { db, e } = mk(); await e.registerNeeds(P, [need('colour')]); await e.nextAsks(P);
  const more = await e.answer(P, 'colour', { choice: 'Tell me more' });
  assert.match(more.explain, /changes the colour/); assert.equal(more.card.need_id, 'colour');
  assert.equal(db.raw.prepare("SELECT state FROM elicit_needs WHERE id='colour'").get().state, 'asked');
  await e.answer(P, 'colour', { choice: 'Tell me more' });
  assert.equal((await e.answer(P, 'colour', { choice: 'Tell me more' })).taught, true);
  assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM elicit_glossary').get().n, 1);
  assert.equal((await e.answer(P, 'colour', { choice: 'purple' })).ok, false);
  await e.answer(P, 'colour', { choice: 'second', text: 'the second, my mum likes it', channel: 'sms' });
  const row = db.raw.prepare("SELECT value, answer_text, channel, answered_at, provenance FROM elicit_needs WHERE id='colour'").get();
  assert.equal(row.value, 'second'); assert.equal(row.answer_text, 'the second, my mum likes it'); assert.equal(row.channel, 'sms'); assert.equal(row.provenance, 'stated'); assert.ok(row.answered_at);
});

test('T16-6 and US-16-R11: the read-back tags every statement, lists defaults first and links them to assumption log entries', async () => {
  const { e } = mk(); await e.registerNeeds(P, [need('a'), need('b'), need('c', { derive_from: 'bakery' })], { idea: 'a bakery' });
  await e.nextAsks(P);
  await e.answer(P, 'a', { choice: 'third' }); await e.answer(P, 'b', { choice: 'Not sure' });
  const rb = await e.readBack(P);
  assert.equal(rb.statements.length, 3);
  assert.ok(rb.statements.every(s => ['stated', 'derived', 'researched', 'default'].includes(s.provenance)));
  assert.equal(rb.statements[0].provenance, 'default'); assert.ok(rb.statements[0].assumption_id > 0);
  assert.match(rb.statements[0].text, /We assumed .* If that is wrong/); assert.equal(rb.defaults, 1);
  assert.match(rb.text, /\[default\]/);
});

test('T16-7 and R15: readiness is computed; the planning gate refuses while a non-reversible need is unanswered', async () => {
  const { e } = mk();
  await e.registerNeeds(P, [need('a'), need('b'), need('risky', { reversible: false }), need('d', { must: false })]);
  let r = await e.readiness(P);
  assert.equal(r.score, 0); assert.equal(r.g1, false); assert.equal(r.g2, false);
  await e.nextAsks(P);
  await e.answer(P, 'a', { choice: 'first' }); await e.answer(P, 'b', { choice: 'Not sure' });
  r = await e.readiness(P);
  assert.ok(Math.abs(r.score - 2 / 3) < 1e-9); assert.equal(r.g1, false); assert.deepEqual(r.blocking, ['risky']);
  await e.answer(P, 'risky', { choice: 'Not sure' }); // refused: still unanswered
  assert.equal((await e.readiness(P)).g2, false);
  await e.answer(P, 'risky', { choice: 'second' });
  r = await e.readiness(P);
  assert.equal(r.score, 1); assert.equal(r.g1, true); assert.equal(r.g2, true);
  const low = mk({ g1_threshold: 0.5 }); await low.e.registerNeeds(P, [need('a'), need('b')]); await low.e.nextAsks(P); await low.e.answer(P, 'a', { choice: 'first' });
  assert.equal((await low.e.readiness(P)).g1, true);
});

test('T16-8 and US-16-R13: a correction in the read-back changes the register and queues a re-run of the affected artifact', async () => {
  const { db, e } = mk(); await e.registerNeeds(P, [need('a')]); await e.nextAsks(P); await e.answer(P, 'a', { choice: 'Not sure' });
  const r = await e.correct(P, 'a', 'third', { text: 'actually the third' });
  assert.deepEqual(r.rerun, ['ELICIT-RERUN-DEMO-CHARTER']);
  assert.equal(db.raw.prepare("SELECT value, provenance FROM elicit_needs WHERE id='a'").get().provenance, 'stated');
  assert.ok(db.raw.prepare('SELECT superseded_at FROM elicit_assumptions').get().superseded_at);
  const item = db.raw.prepare("SELECT status, project FROM items WHERE id='ELICIT-RERUN-DEMO-CHARTER'").get();
  assert.equal(item.status, 'open'); assert.equal(item.project, P);
  assert.equal((await e.correct(P, 'a', 'first')).rerun.length, 1); // idempotent: still one item
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM items WHERE id LIKE 'ELICIT-RERUN%'").get().n, 1);
  assert.equal((await e.correct(P, 'nope', 'x')).ok, false);
});

test('T16-9: the ignorance audit leaves evidence for all four sweeps; a same-family red team is refused; professional topics become gate cards', async () => {
  const { db, e } = mk();
  await e.registerNeeds(P, [need('a', { label: 'Opening hours' })]);
  const redteam = async () => ({ family: 'other-family', question: 'what would harm someone?', points: [{ point: 'customer emails stored without consent', disposition: 'risk' }] });
  const analogies = [{ topic: 'data', item: 'back up the booking list', source: 'https://example.org/guide', disposition: 'need' }, { topic: 'legal', item: 'cookie notice for visitors' }];
  const r = await e.audit(P, { required_fields: [{ artifact: 'charter', field: 'Opening hours' }, { artifact: 'charter', field: 'Refund policy' }], analogies, redteam, author_family: 'author-family', surprises: [{ what: 'tick skipped twice', kind: 'lesson' }] });
  assert.equal(r.complete, true); assert.deepEqual(r.missing_sweeps, []); assert.equal(r.new_needs, 1);
  const bySweep = Object.fromEntries(db.raw.prepare('SELECT sweep, COUNT(*) AS n FROM elicit_audit GROUP BY sweep').all().map(x => [x.sweep, x.n]));
  assert.ok(['catalog', 'analogy', 'redteam', 'surprise'].every(s => bySweep[s] > 0));
  assert.equal(db.raw.prepare("SELECT evidence FROM elicit_audit WHERE finding LIKE '%back up%'").get().evidence, 'source: https://example.org/guide');
  assert.equal(db.raw.prepare("SELECT evidence FROM elicit_audit WHERE finding LIKE '%cookie%'").get().evidence, 'no source');
  assert.equal(db.raw.prepare("SELECT disposition FROM elicit_audit WHERE finding LIKE '%cookie%'").get().disposition, 'needs_professional');
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM gate_cards WHERE what LIKE 'needs a qualified professional%'").get().n, 1);
  await assert.rejects(() => e.audit(P, { redteam, author_family: 'other-family' }), /different model family/);
  const partial = await e.audit(P, { analogies });
  assert.equal(partial.complete, false); assert.deepEqual(partial.missing_sweeps, ['redteam']);
});

test('failed predictions feed the surprise sweep', async () => {
  const { db, e } = mk();
  db.raw.exec(`INSERT INTO predictions (id, item_id, metric, op, target, due_at, verdict) VALUES ('P1','A','tests_passing','>=',10,'2026-11-12','miss')`);
  await e.audit(P, {});
  assert.match(db.raw.prepare("SELECT finding FROM elicit_audit WHERE sweep='surprise' AND disposition='lesson'").get().finding, /failed prediction P1/);
});

test('US-16-R03: the glossary maps system terms to the person\'s own words in every card; a term with only an explanation is defined in the card', async () => {
  const { e } = mk({ jargon: ['backend', 'latency'] });
  const r = await e.registerNeeds(P, [
    need('host', { question: 'Where should the backend run?', why: 'The backend decides what it costs each month.', defines: ['backend'] }),
    need('speed', { question: 'How much latency is acceptable?', cue: 'Most shops accept low latency only at checkout.', defines: ['latency'] }),
  ]);
  assert.deepEqual(r.rejected, []);
  assert.equal((await e.learnTerm('', {})).ok, false);
  await e.learnTerm('Backend', { person_term: 'engine room' });
  await e.learnTerm('latency', { plain: 'how long a page takes to answer' });
  const cards = Object.fromEntries((await e.nextAsks(P)).map(c => [c.need_id, c]));
  assert.equal(cards.host.question, 'Where should the engine room run?');
  assert.equal(cards.host.why, 'The engine room decides what it costs each month.');
  assert.ok(!/backend/i.test(JSON.stringify(cards.host)));
  assert.match(cards.speed.question, /latency/); assert.equal(cards.speed.definitions.latency, 'how long a page takes to answer'); assert.ok(cards.speed.defines.includes('latency'));
  assert.deepEqual(await e.reviewCards(P), [], 'no card leaks an undefined term after the mapping');
  assert.deepEqual((await e.glossary()).map(g => [g.term, g.person_term]), [['backend', 'engine room'], ['latency', null]]);
});

test('US-16-R03: reviewCards reports a stored card whose jargon is neither mapped nor defined', async () => {
  const { db, e } = mk({ jargon: ['webhook'] });
  await e.registerNeeds(P, [need('notify')]);
  db.raw.exec(`UPDATE elicit_needs SET question='Which webhook should fire?' WHERE id='notify'`);
  assert.deepEqual(await e.reviewCards(P), [{ need_id: 'notify', problems: ['jargon without definition: webhook'] }]);
  await e.learnTerm('webhook', { person_term: 'automatic message' });
  assert.deepEqual(await e.reviewCards(P), []);
});

test('US-16-R17: related needs are asked as one card sequence, not interleaved with another topic', async () => {
  const { e } = mk({ max_open: 5 });
  await e.registerNeeds(P, [
    need('c1', { artifact: 'charter', p_wrong: 0.9 }), need('s1', { artifact: 'security', p_wrong: 0.8 }), need('c2', { artifact: 'charter', p_wrong: 0.7 }),
    need('s2', { artifact: 'security', p_wrong: 0.6 }), need('c3', { artifact: 'charter', p_wrong: 0.1 }),
  ]);
  const cards = await e.nextAsks(P);
  assert.deepEqual(cards.map(c => c.need_id), ['c1', 'c2', 'c3', 's1', 's2']);
  assert.deepEqual(cards.map(c => `${c.sequence.artifact} ${c.sequence.position}/${c.sequence.of}`), ['charter 1/3', 'charter 2/3', 'charter 3/3', 'security 1/2', 'security 2/2']);
  const few = mk({ max_open: 3 }); await few.e.registerNeeds(P, [need('c1', { artifact: 'charter', p_wrong: 0.9 }), need('s1', { artifact: 'security', p_wrong: 0.8 }), need('c2', { artifact: 'charter', p_wrong: 0.7 }), need('c3', { artifact: 'charter', p_wrong: 0.1 })]);
  assert.deepEqual((await few.e.nextAsks(P)).map(c => c.need_id), ['c1', 'c2', 'c3'], 'the open cap is filled from one sequence before the next topic starts');
});

test('US-16-R18: when the person stops answering the system does not ask more often: it keeps the priority list and defaults the rest', async () => {
  const cat = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'].map((id, i) => need(id, { p_wrong: 0.9 - i * 0.05 }));
  cat[8] = need('i', { p_wrong: 0.01, reversible: false });
  const { db, t, e } = mk({ max_open: 3, daily_cap: 9, fatigue_after: 3, priority_list: 2 }); await e.registerNeeds(P, cat);
  assert.equal((await e.nextAsks(P)).filter(c => c.need_id !== 'i').length, 3);
  assert.deepEqual(await e.fatigue(P), { stopped: false, consecutive_timeouts: 0 });
  t.v += 73 * 3600e3;
  const after = await e.nextAsks(P);
  assert.deepEqual(await e.fatigue(P), { stopped: true, consecutive_timeouts: 3 });
  const asked = after.filter(c => c.need_id !== 'i').map(c => c.need_id);
  assert.deepEqual(asked, ['d'], 'one Ask open, not three: frequency went down, not up');
  const states = Object.fromEntries(db.raw.prepare(`SELECT id, state FROM elicit_needs`).all().map(r => [r.id, r.state]));
  assert.equal(states.e, 'open', 'the priority list is kept'); assert.equal(states.f, 'defaulted'); assert.equal(states.h, 'defaulted');
  assert.equal(states.i, 'gated', 'a need that cannot be defaulted is never defaulted by fatigue');
  assert.equal(db.raw.prepare(`SELECT COUNT(*) AS n FROM elicit_assumptions WHERE reason='fatigue'`).get().n, 3);
  await e.answer(P, 'd', { choice: 'second' });
  assert.equal((await e.fatigue(P)).stopped, false, 'an answer ends the fatigue state');
  assert.equal((await e.nextAsks(P)).filter(c => c.need_id !== 'i').length, 1);
});

test('US-16-R08: options are neutral: they keep the catalog order, none is pre-selected, and the default is marked as a default', async () => {
  const { e } = mk();
  await e.registerNeeds(P, [need('plan', { options: ['slow and careful', 'quick', 'in between'], default: 'in between' })]);
  const [card] = await e.nextAsks(P);
  assert.deepEqual(card.options, ['slow and careful', 'quick', 'in between', 'Not sure', 'Tell me more'], 'the default is not moved to the front');
  assert.equal(card.default, 'in between'); assert.equal(card.default_marked, true);
  assert.ok(!('selected' in card) && !('preselected' in card) && !('recommended' in card));
});
