// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// First-run walkthrough, per-person profile, Elicitation Ask cards and the read-back screen (US-SPEC-18 sections 4, 5, 6;
// US-SPEC-16 R12 to R14). The walkthrough is generated from the needs register (core/elicit), not a fixed wizard: its step is
// computed from the records every time, so it resumes anywhere (US-18-R11), never waits on one card, and ends by saying exactly
// what runs and what does not yet (US-18-R12). Every press writes a record (US-18-R01): the answer in the register and a row
// in console_actions. Ports: db, elicit (createElicit), now, config { project, catalog, readback_hours, working_url }.
export const IDEA_QUESTION = 'What do you want to exist, and for whom?';
export const IDEA_EXAMPLE = 'For example: a page for my chess club that shows who plays whom each week.';
export const METRICS = ['open', 'done', 'stuck', 'predictions_right', 'waiting_on_you'];
export const LIST_MAX = 3;
const DETAIL = ['brief', 'more'];
const FORBIDDEN = ['hide_needs_you', 'hide_cards', 'hidden_cards', 'screens', 'list_max', 'third_party', 'allow_markup', 'access', 'token'];
const stamp = ms => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const parse = s => Date.parse(String(s).replace(' ', 'T') + 'Z');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

/** Problems with a profile, or []. A profile may change what is shown; it may not remove the Needs-you screen, hide an open
 *  decision card, lengthen a list past three or loosen access (section 6). */
export function validateProfile(p = {}) {
  const out = [];
  for (const k of Object.keys(p)) if (FORBIDDEN.includes(k)) out.push(`a profile may not set ${k}`);
  if (p.detail !== undefined && !DETAIL.includes(p.detail)) out.push('detail must be brief or more');
  if (p.language !== undefined && !/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(String(p.language))) out.push('language must be a language tag such as en or pt-BR');
  if (p.cadence_minutes !== undefined && !(Number.isInteger(p.cadence_minutes) && p.cadence_minutes >= 1 && p.cadence_minutes <= 10080)) out.push('cadence_minutes must be a whole number from 1 to 10080');
  if (p.metrics !== undefined) {
    if (!Array.isArray(p.metrics) || p.metrics.length < 1 || p.metrics.length > LIST_MAX) out.push(`metrics must list one to ${LIST_MAX} numbers`);
    else for (const m of p.metrics) if (!METRICS.includes(m)) out.push(`unknown metric: ${m}`);
  }
  if (p.extra_cards !== undefined) {
    if (!Array.isArray(p.extra_cards)) out.push('extra_cards must be a list');
    else for (const c of p.extra_cards) if (!c || !c.id || !c.what || !c.default_in_effect) out.push('an extra card needs id, what and default_in_effect (what happens if the person does nothing)');
  }
  return out;
}

/** Apply a profile to the three screens (the data of buildConsole in core/src/console.js) and fold in the open Ask cards.
 *  Every open decision card that was in the input is still in the output; lists never exceed three, extras become a count. */
export function compose(consoleData, profile = {}, askCards = []) {
  const d = JSON.parse(JSON.stringify(consoleData));
  const numbers = { open: d.now.open, done: d.now.done, stuck: d.now.blocked, predictions_right: d.progress.predictions.hit, waiting_on_you: d.needs_you.cards.length + d.needs_you.more };
  const askShape = c => ({ id: `ask:${c.need_id}`, kind: 'ask', need_id: c.need_id, what: c.question, why: c.why, cue: c.cue,
    default_in_effect: c.default == null ? 'work that depends on this waits; other work continues' : `we use "${c.default}"; ${c.default_consequence}`,
    buttons: c.default == null ? c.options.filter(o => o !== 'Not sure') : c.options, free_text: !!c.free_text, definitions: c.definitions || {}, reversibility: c.reversibility });
  const needOf = card => /^elicit_answered:[^:]*:(.+)$/.exec(card.closing_probe || '')?.[1];
  const used = new Set();
  const base = d.needs_you.cards.map(card => { const a = askCards.find(x => x.need_id === needOf(card)); if (!a) return card; used.add(a.need_id); return { ...askShape(a), id: card.id }; });
  const asks = askCards.filter(c => !used.has(c.need_id) && c.default != null).map(askShape);
  const extra = (profile.extra_cards || []).map(c => ({ ...c, kind: 'program' }));
  const allCards = [...base, ...asks, ...extra];
  d.needs_you = { cards: allCards.slice(0, LIST_MAX), more: d.needs_you.more + Math.max(0, allCards.length - LIST_MAX) };
  d.now.numbers = (profile.metrics || ['open', 'done', 'stuck']).slice(0, LIST_MAX).map(m => ({ metric: m, value: numbers[m] ?? 0 }));
  if ((profile.detail || 'brief') === 'brief') {
    d.now.working_on = d.now.working_on.slice(0, 1); d.now.stuck = d.now.stuck.slice(0, LIST_MAX);
    d.progress.done_lately = d.progress.done_lately.slice(0, 1); d.progress.autonomy = d.progress.autonomy.slice(0, 1);
  } else {
    d.now.working_on = d.now.working_on.slice(0, LIST_MAX); d.now.stuck = d.now.stuck.slice(0, LIST_MAX); d.progress.autonomy = d.progress.autonomy.slice(0, LIST_MAX);
  }
  const waiting = d.needs_you.cards.length + d.needs_you.more;
  if (d.ok && waiting) d.headline = `Running well. ${waiting} thing${waiting === 1 ? '' : 's'} need${waiting === 1 ? 's' : ''} you.`;
  d.profile = { detail: profile.detail || 'brief', language: profile.language || 'en', cadence_minutes: profile.cadence_minutes || 60 };
  return d;
}

/** The read-back screen: the specification in the person's words, defaults first, each statement correctable with a button
 *  (options) or a short text box. Static HTML, every value escaped, nothing loaded from another host (US-18-R10). */
export function renderReadBack(rb, { action = '/api/console/readback' } = {}) {
  const row = s => {
    const fix = s.options.length
      ? s.options.filter(o => o !== s.value).map(o => `<button class="fix" data-need="${esc(s.need_id)}" data-value="${esc(o)}">${esc(o)}</button>`).join('')
      : `<input aria-label="Correct this" data-for="${esc(s.need_id)}" maxlength="200"><button class="fix" data-need="${esc(s.need_id)}" data-input="1">Change</button>`;
    return `<li${s.assumption ? ' class="assumed"' : ''}><p>${esc(s.text)}</p><p class="mut">${s.assumption ? 'We assumed this. ' : ''}Not right? ${fix}</p></li>`;
  };
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Here is what we understood</title>
<style>body{font:17px/1.45 system-ui,sans-serif;max-width:34rem;margin:1.5rem auto;padding:0 1rem}li{margin:.8rem 0;list-style:none;padding:.7rem;border:1px solid #8885;border-radius:10px}.assumed{border-left:4px solid #b45309}.mut{opacity:.8;font-size:.9rem}button{font:inherit;min-height:2.75rem;padding:.5rem .8rem;margin:.2rem;border-radius:10px}ul{padding:0}input{font:inherit;padding:.5rem}</style></head><body>
<h1>Here is what we understood</h1>
<p>${rb.defaults ? `${esc(rb.defaults)} of these we assumed for you. They come first.` : 'Nothing here was assumed for you.'} If you do nothing, work carries on with what is shown.</p>
<ul>${rb.statements.map(row).join('')}</ul>
<p><button id="ok" data-action="confirm">This is right</button></p><p id="say" role="status"></p>
<script>
(function(){var A=${JSON.stringify(String(action))};function send(b){return fetch(A,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)}).then(function(r){return r.json()}).then(function(j){document.getElementById('say').textContent=j.message||j.error||'Saved.';if(j.reload)location.reload()})}
document.addEventListener('click',function(e){var t=e.target;if(t.id==='ok'){send({confirm_readback:true});return}if(!t.classList||!t.classList.contains('fix'))return;var v=t.getAttribute('data-value');if(t.getAttribute('data-input')){var i=document.querySelector('input[data-for="'+t.getAttribute('data-need')+'"]');v=i?i.value:''}if(v)send({need_id:t.getAttribute('data-need'),value:v})})})();
</script></body></html>`;
}

export function createWalkthrough({ db, elicit, now = () => Date.now(), config = {} } = {}) {
  if (!elicit) throw new Error('the walkthrough is generated from the needs register: pass elicit');
  const clock = typeof now === 'function' ? now : () => now;
  const cfg = { project: 'main', catalog: { needs: [] }, readback_hours: 72, working_url: null, ...config };
  const needsCatalog = Array.isArray(cfg.catalog) ? cfg.catalog : cfg.catalog.needs || [];
  const all = async (sql, ...a) => (await db.prepare(sql).bind(...a).all()).results || [];
  const one = (sql, ...a) => db.prepare(sql).bind(...a).first();
  const run = (sql, ...a) => db.prepare(sql).bind(...a).run();
  const state = person => one(`SELECT * FROM walkthrough_state WHERE person=?`, person);
  const act = (kind, ref, text) => run(`INSERT INTO console_actions (kind, ref, text, at) VALUES (?,?,?,?)`, kind, ref, text ?? null, stamp(clock()));

  /** Step 1: the one question. The text is stored verbatim as the idea record, then the register is built from the catalog and
   *  whatever the idea already answers is derived instead of asked (US-16-R01). */
  async function submitIdea(person, text) {
    const t = String(text ?? '');
    if (!t.trim()) return { ok: false, error: 'Say what you want in a sentence or two. ' + IDEA_EXAMPLE };
    if (await state(person)) return { ok: false, error: 'The idea is already recorded. Use the box on any screen to add to it.' };
    await run(`INSERT INTO walkthrough_state (person, project, idea_text, idea_at) VALUES (?,?,?,?)`, person, cfg.project, t, stamp(clock()));
    await act('idea', person, t);
    const reg = await elicit.registerNeeds(cfg.project, needsCatalog, { idea: t });
    return { ok: true, registered: reg.registered, rejected: reg.rejected };
  }

  /** Step 3: steps only the person can do (an account, a key, a question with no safe guess): the open decision cards, at most
   *  three, the rest as a count. They are attached to every step and never block the walkthrough. A card that stands for a
   *  question carries that question's buttons, without "Not sure": it has no default to fall back on. */
  async function setupCards(askCards = []) {
    const cards = await all(`SELECT id, what, default_in_effect, closing_probe FROM gate_cards WHERE status='open' ORDER BY id`);
    const shape = c => {
      const need = /^elicit_answered:[^:]*:(.+)$/.exec(c.closing_probe)?.[1];
      const ask = need ? askCards.find(a => a.need_id === need) : null;
      if (ask) return { id: c.id, kind: 'ask', need_id: need, what: ask.question, why: ask.why, cue: ask.cue, default_in_effect: c.default_in_effect, buttons: ask.options.filter(o => o !== 'Not sure') };
      return { id: c.id, what: c.what, default_in_effect: c.default_in_effect, kind: c.closing_probe.startsWith('env:') ? 'secret' : 'manual' };
    };
    return { cards: cards.slice(0, LIST_MAX).map(shape), more: Math.max(0, cards.length - LIST_MAX) };
  }

  /** Exactly what runs and what does not yet (US-18-R12), read from the records. */
  async function whatWorks() {
    const tick = await one(`SELECT finished_at, steps_completed, steps_total FROM tick_runs ORDER BY id DESC LIMIT 1`);
    const counts = Object.fromEntries((await all(`SELECT status, COUNT(*) AS n FROM items GROUP BY status`)).map(r => [r.status, r.n]));
    const cards = (await one(`SELECT COUNT(*) AS n FROM gate_cards WHERE status='open'`)).n;
    const r = await elicit.readiness(cfg.project);
    const runs = []; const notYet = [];
    if (tick && tick.finished_at && tick.steps_completed === tick.steps_total) runs.push(`The regular check runs: the last one finished at ${tick.finished_at}.`);
    else notYet.push(tick ? 'The last regular check did not finish.' : 'The first regular check has not run yet.');
    runs.push(`Your answers are recorded: ${r.satisfied} of ${r.musts} things we needed to know are settled.`);
    const active = (counts.open || 0) + (counts.ready || 0) + (counts.claimed || 0);
    if (active || counts.done) runs.push(`Work is on the list: ${active} in hand, ${counts.done || 0} finished.`); else notYet.push('No work has been started yet.');
    if (cfg.working_url) runs.push(`Your page is at ${cfg.working_url}.`); else notYet.push('There is no live page yet.');
    if (cards) notYet.push(`${cards} step${cards === 1 ? '' : 's'} only you can do ${cards === 1 ? 'is' : 'are'} waiting under Needs you.`);
    if (r.blocking.length) notYet.push(`${r.blocking.length} question${r.blocking.length === 1 ? '' : 's'} with no safe guess still need${r.blocking.length === 1 ? 's' : ''} your answer.`);
    return { runs, not_yet: notYet, live_url: cfg.working_url };
  }

  /** Where this person is. Computed from the records each time, so closing the page and coming back, or a second device,
   *  continues at the same place. Step 2 shows one card at a time; an unanswered card falls to its default after its time. */
  async function current(person) {
    const st = await state(person);
    if (!st) return { step: 1, of: 5, kind: 'idea', question: IDEA_QUESTION, example: IDEA_EXAMPLE, free_text: true, suggestions: ['A page for my club', 'A tracker I check every day', 'A small shop site that keeps improving'] };
    const cards = await elicit.nextAsks(st.project);
    const asked = new Set((await all(`SELECT id FROM elicit_needs WHERE project=? AND state='asked'`, st.project)).map(r => r.id));
    const later = (await one(`SELECT COUNT(*) AS n FROM elicit_needs WHERE project=? AND state='open'`, st.project)).n;
    const setup = await setupCards(cards);
    const askCard = cards.find(c => asked.has(c.need_id));
    if (askCard) return { step: 2, of: 5, kind: 'ask', card: { ...askCard, buttons: askCard.options }, remaining: asked.size + later, setup };
    const rb = await readBack(st.project);
    if (!st.readback_confirmed_at) {
      if (!st.readback_shown_at) { await run(`UPDATE walkthrough_state SET readback_shown_at=? WHERE person=?`, stamp(clock()), person); return { step: 4, of: 5, kind: 'readback', readback: rb, later, setup }; }
      if (clock() - parse(st.readback_shown_at) < cfg.readback_hours * 3600e3) return { step: 4, of: 5, kind: 'readback', readback: rb, later, setup };
    }
    if (!st.finished_at) await run(`UPDATE walkthrough_state SET finished_at=? WHERE person=?`, stamp(clock()), person);
    return { step: 5, of: 5, kind: 'done', works: await whatWorks(), readback_unconfirmed: !st.readback_confirmed_at, later, setup, next: '/console' };
  }

  /** An Ask card button. The press is stored verbatim and mapped to the register by core/elicit (US-16-R07); a row in
   *  console_actions records it as it would any other console action (US-18-R01). `Tell me more` returns the same card. */
  async function answer(person, needId, { choice, text } = {}) {
    const st = await state(person);
    if (!st) return { ok: false, error: 'Tell us what you want first.' };
    const r = await elicit.answer(st.project, needId, { choice, text, channel: 'console' });
    if (r.ok && !r.explain) {
      await act('elicit_answer', needId, text ?? String(choice));
      await syncProfile(person);
    }
    return r;
  }

  async function readBack(project) {
    const rb = await elicit.readBack(project);
    const opts = Object.fromEntries((await all(`SELECT id, options, free_text FROM elicit_needs WHERE project=?`, project)).map(n => [n.id, n.free_text ? [] : JSON.parse(n.options)]));
    return { ...rb, statements: rb.statements.map(s => ({ ...s, options: opts[s.need_id] || [] })) };
  }
  /** A correction from the read-back screen: the register changes and the affected artifact is queued to be redone (US-16-R13). */
  async function correct(person, needId, value) {
    const st = await state(person);
    if (!st) return { ok: false, error: 'Tell us what you want first.' };
    const v = String(value ?? '').trim();
    if (!v) return { ok: false, error: 'Say what it should be.' };
    const r = await elicit.correct(st.project, needId, v, { channel: 'console', text: String(value) });
    if (r.ok) { await act('readback_correction', needId, String(value)); await syncProfile(person); }
    return r;
  }
  async function confirmReadBack(person) {
    const r = await run(`UPDATE walkthrough_state SET readback_confirmed_at=? WHERE person=? AND readback_confirmed_at IS NULL`, stamp(clock()), person);
    if (r.meta?.changes) await act('readback_confirmed', person, null);
    return { ok: true };
  }

  const rowToProfile = r => ({ person: r.person, detail: r.detail, language: r.language, cadence_minutes: r.cadence_minutes, metrics: JSON.parse(r.metrics), extra_cards: JSON.parse(r.extra_cards), source: r.source });
  /** The person's profile; the default composition when none is stored. */
  async function profile(person) {
    const r = await one(`SELECT * FROM walkthrough_profiles WHERE person=?`, person);
    return r ? rowToProfile(r) : { person, detail: 'brief', language: 'en', cadence_minutes: 60, metrics: ['open', 'done', 'stuck'], extra_cards: [], source: 'default' };
  }
  async function setProfile(person, patch = {}, source = 'person') {
    const problems = validateProfile(patch);
    if (problems.length) return { ok: false, errors: problems };
    const p = { ...(await profile(person)), ...patch };
    await run(`INSERT INTO walkthrough_profiles (person, detail, language, cadence_minutes, metrics, extra_cards, source, updated_at) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(person) DO UPDATE SET detail=excluded.detail, language=excluded.language, cadence_minutes=excluded.cadence_minutes, metrics=excluded.metrics, extra_cards=excluded.extra_cards, source=excluded.source, updated_at=excluded.updated_at`,
    person, p.detail, p.language, p.cadence_minutes, JSON.stringify(p.metrics), JSON.stringify(p.extra_cards), source, stamp(clock()));
    return { ok: true, profile: await profile(person) };
  }
  /** Set the profile from the walkthrough answers: a catalog need with profile_key maps its value through profile_values. */
  async function syncProfile(person) {
    const st = await state(person);
    if (!st) return null;
    const patch = {};
    for (const n of needsCatalog.filter(c => c.profile_key)) {
      const row = await one(`SELECT value FROM elicit_needs WHERE project=? AND id=? AND state IN ('answered','defaulted','derived')`, st.project, n.id);
      if (row && n.profile_values && Object.prototype.hasOwnProperty.call(n.profile_values, row.value)) patch[n.profile_key] = n.profile_values[row.value];
    }
    return Object.keys(patch).length ? setProfile(person, patch, 'walkthrough') : null;
  }

  /** The Ask cards open now, as decision cards for the Needs-you screen. */
  async function askCards(person) {
    const st = await state(person);
    return st ? elicit.nextAsks(st.project) : [];
  }
  /** The person's three screens: the console data with their profile applied and their Ask cards folded in. */
  async function screens(person, consoleData) { return compose(consoleData, await profile(person), await askCards(person)); }

  /** Routes under /api/console (the console signs the person in first and passes who they are):
   *    GET  /api/console/walkthrough            where the person is
   *    POST /api/console/walkthrough/idea       { text }
   *    POST /api/console/walkthrough/answer     { need_id, choice, text }
   *    GET  /api/console/readback, GET /console/readback (the screen)
   *    POST /api/console/readback               { need_id, value } or { confirm_readback: true }
   *    GET  /api/console/profile, POST /api/console/profile { ...patch }
   *  A write must come from the same origin (US-18-R09). Returns null for a path that is not ours. */
  async function handle(request, { person = 'owner' } = {}) {
    const url = new URL(request.url); const p = url.pathname.replace(/\/+$/, '');
    const mine = ['/api/console/walkthrough', '/api/console/walkthrough/idea', '/api/console/walkthrough/answer', '/api/console/readback', '/console/readback', '/api/console/profile'];
    if (!mine.includes(p)) return null;
    if (request.method === 'GET') {
      if (p === '/api/console/walkthrough') return json(await current(person));
      if (p === '/api/console/profile') return json(await profile(person));
      const st = await state(person);
      if (!st) return p === '/console/readback' ? new Response(null, { status: 303, headers: { location: '/console' } }) : json({ error: 'nothing to read back yet' }, 404);
      const rb = await readBack(st.project);
      if (p === '/api/console/readback') return json(rb);
      return new Response(renderReadBack(rb), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'", 'x-content-type-options': 'nosniff' } });
    }
    if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);
    const origin = request.headers.get('origin');
    if (!origin || origin !== url.origin) return json({ error: 'cross-origin request refused' }, 403);
    const body = await request.json().catch(() => ({}));
    if (p === '/api/console/walkthrough/idea') { const r = await submitIdea(person, body.text); return json(r.ok ? { ...r, next: await current(person) } : r, r.ok ? 200 : 400); }
    if (p === '/api/console/walkthrough/answer') { const r = await answer(person, String(body.need_id || ''), { choice: body.choice, text: body.text }); return json(r.ok ? { ...r, next: await current(person) } : r, r.ok ? 200 : 400); }
    if (p === '/api/console/readback') {
      if (body.confirm_readback === true) { await confirmReadBack(person); return json({ ok: true, message: 'Thank you. That is what we will build.' }); }
      const r = await correct(person, String(body.need_id || ''), body.value);
      return json(r.ok ? { ...r, message: 'Changed. The affected parts will be redone.', reload: true } : r, r.ok ? 200 : 400);
    }
    if (p === '/api/console/profile') { const r = await setProfile(person, body); return json(r, r.ok ? 200 : 400); }
    return json({ error: 'not found' }, 404);
  }

  return { submitIdea, current, answer, readBack, correct, confirmReadBack, profile, setProfile, syncProfile, askCards, screens, setupCards, whatWorks, handle, config: cfg };
}
