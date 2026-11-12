// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Guided console (US-SPEC-17). Three screens, buttons first, a prompt box second.
// The front end is the back end: every action below writes a record the tick already understands.
import { CONSOLE_HTML } from './console-ui.js';
import { sha256Hex, verifyAccessJwt } from '../doors/index.js';
import { listConnections, saveSecret, removeSecret } from './secrets-ui.js';
import { firstRunDoor, doorStatus, page, SETUP } from './first-run.js';
import { HELP_SECTIONS } from './help-data.js';
import { readSession, canWrite } from '../auth/index.js';
import { SESSION_COOKIE } from '../githubapp/signin.js';
import { publicViewEnabled, renderPublicView, loadMeasures } from '../org/public-view.js';

// Request categories that SCOPE.md puts outside the default product (opt-in Capability Packs only).
export const OUT_OF_SCOPE = [
  [/business plan|financial model|pitch deck|fundrais|investor|funding (application|round)/i, 'a business plan or funding material'],
  [/patent|trademark|copyright (filing|registration)/i, 'a patent or trademark filing'],
  [/legal advice|tax advice|investment advice|medical advice/i, 'legal, tax, investment or medical advice'],
  [/marketing campaign|social media (post|account)|cold (email|outreach)|ad campaign/i, 'marketing or outreach'],
];

const all = async (db, sql, ...a) => (await db.prepare(sql).bind(...a).all()).results || [];
const one = (db, sql, ...a) => db.prepare(sql).bind(...a).first();
const run = (db, sql, ...a) => db.prepare(sql).bind(...a).run();

/** The three screens as plain data. Each screen is small on purpose (bite-sized). */
export async function buildConsole(db, { org = 'your organization' } = {}) {
  const tick = await one(db, `SELECT started_at, finished_at, steps_completed, steps_total, report FROM tick_runs ORDER BY id DESC LIMIT 1`);
  const cards = await all(db, `SELECT id, what, why_gated, default_in_effect, closing_probe FROM gate_cards WHERE status='open' ORDER BY id LIMIT 3`);
  const moreCards = (await one(db, `SELECT COUNT(*) AS n FROM gate_cards WHERE status='open'`)).n - cards.length;
  const counts = Object.fromEntries((await all(db, `SELECT status, COUNT(*) AS n FROM items GROUP BY status`)).map(r => [r.status, r.n]));
  const active = (await all(db, `SELECT id, title, owner_role, status FROM items WHERE status IN ('claimed','ready') ORDER BY priority, id LIMIT 3`));
  const blocked = (await all(db, `SELECT id, title, blocker FROM items WHERE status='blocked' ORDER BY priority, id LIMIT 3`));
  const done = await all(db, `SELECT title, updated_at FROM items WHERE status='done' ORDER BY updated_at DESC, id DESC LIMIT 5`);
  const pred = await one(db, `SELECT SUM(verdict='hit') AS hit, COUNT(*) AS scored FROM predictions WHERE verdict IS NOT NULL`);
  const trust = await all(db, `SELECT surface, action_class, rung FROM trust_ledger ORDER BY reliability DESC LIMIT 3`);

  const tickOk = Boolean(tick && tick.steps_completed === tick.steps_total);
  const needsYou = cards.length + Math.max(0, moreCards);
  const headline = !tick ? 'Starting up. The first check has not run yet.'
    : !tickOk ? 'Something needs attention: the last check did not finish.'
    : needsYou ? `Running well. ${needsYou} thing${needsYou === 1 ? '' : 's'} need${needsYou === 1 ? 's' : ''} you.`
    : 'Running well. Nothing needs you.';
  return {
    org, headline, ok: tickOk, last_check: tick ? tick.finished_at || tick.started_at : null,
    now: { open: (counts.open || 0) + (counts.ready || 0) + (counts.claimed || 0), done: counts.done || 0, blocked: counts.blocked || 0, working_on: active, stuck: blocked },
    needs_you: { cards: cards.map(c => ({ ...c, kind: c.closing_probe.startsWith('env:') ? 'secret' : 'manual' })), more: Math.max(0, moreCards) },
    progress: { done_lately: done, predictions: { hit: pred.hit || 0, scored: pred.scored || 0 }, autonomy: trust },
    suggestions: ['What do you need from me?', 'What is stuck?', 'What did you finish?'],
  };
}

/** Resolve a decision card from a button. Secrets cannot be set from a button, so those cards only explain. */
export async function resolveCard(db, id, choice) {
  const card = await one(db, `SELECT id, what, default_in_effect, closing_probe, status FROM gate_cards WHERE id=?`, id);
  if (!card) return { status: 404, body: { error: 'no such card' } };
  if (card.status !== 'open') return { status: 409, body: { error: 'already closed' } };
  if (choice === 'explain') return { status: 200, body: { explain: explainCard(card) } };
  if (card.closing_probe.startsWith('env:')) return { status: 409, body: { error: 'This step happens in your cloud account; the card closes by itself when it is done.', explain: explainCard(card) } };
  if (choice !== 'done' && choice !== 'default') return { status: 400, body: { error: 'choice must be done, default or explain' } };
  await run(db, `UPDATE gate_cards SET status='closed', closed_at=datetime('now') WHERE id=? AND status='open'`, id);
  await run(db, `INSERT INTO console_actions (kind, ref) VALUES (?, ?)`, choice === 'done' ? 'card_done' : 'card_default', id);
  return { status: 200, body: { ok: true } };
}

function explainCard(c) {
  const probe = c.closing_probe.startsWith('env:')
    ? `This needs a value only you can add in your cloud account (${c.closing_probe.slice(4)}). The card closes by itself once it is there. You can paste it on the Connect screen.`
    : 'Press "I did it" when it is done, or "Use the default" to let the work carry on as described.';
  return `${c.what}. If you do nothing: ${c.default_in_effect}. ${probe}`;
}

/** A typed request becomes a work item the managers pick up, or a held scope-gate entry (SCOPE.md). */
export async function recordAsk(db, text) {
  const t = String(text || '').trim().slice(0, 1000);
  if (!t) return { status: 400, body: { error: 'empty request' } };
  const hit = OUT_OF_SCOPE.find(([re]) => re.test(t));
  const id = `ASK-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`.toUpperCase();
  if (hit) {
    await run(db, `INSERT INTO items (id, title, kind, project, owner_role, done_check, closing_probe, priority, status, blocker)
      VALUES (?, ?, 'work', 'scope-gate', 'portfolio-manager', 'decision recorded on whether to enable a Capability Pack', 'manual', 30, 'blocked', ?)`,
      id, `Out of scope by default: ${t.slice(0, 120)}`, `Out of scope by default (SCOPE.md): ${hit[1]}. Held until a pack is enabled.`);
    await run(db, `INSERT INTO console_actions (kind, ref, text) VALUES ('ask', ?, ?)`, id, t);
    return { status: 200, body: { id, held: true, message: `That is ${hit[1]}, which Ultrastable does not do by default. I have noted it. It stays on hold until you choose to enable an add-on for it.` } };
  }
  await run(db, `INSERT INTO items (id, title, kind, project, owner_role, done_check, closing_probe, priority, status)
    VALUES (?, ?, 'work', 'requests', 'portfolio-manager', 'request understood, scoped, and answered or broken into items', 'manual', 20, 'open')`, id, `Request: ${t.slice(0, 160)}`);
  await run(db, `INSERT INTO console_actions (kind, ref, text) VALUES ('ask', ?, ?)`, id, t);
  return { status: 200, body: { id, held: false, message: 'Got it. It is on the list, and a manager will turn it into steps. You will see it under Now.' } };
}

// ---- access: default-deny. No CONSOLE_TOKEN configured means no console. Put Cloudflare Access in front in production. ----
const enc = new TextEncoder();
async function digest(s) { return new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s))); }
async function tokenOk(given, expected) {
  const [a, b] = await Promise.all([digest(String(given || '')), digest(String(expected))]);
  let d = 0; for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}
function cookie(req, name) { return (req.headers.get('cookie') || '').split(/;\s*/).map(p => p.split('=')).find(([k]) => k === name)?.[1]; }
const COOKIE = 'us_console';

const LOGIN = (msg = '') => `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Sign in</title>
<body style="font:16px system-ui;max-width:22rem;margin:4rem auto;padding:0 1rem"><h1 style="font-size:1.3rem">Sign in</h1>${msg ? `<p>${msg}</p>` : ''}
<form method=post action=/console/login><label>Access key<br><input name=key type=password autocomplete=current-password style="width:100%;padding:.6rem;margin:.4rem 0"></label><button style="padding:.6rem 1rem">Open</button></form></body>`;

/** Route /console and /api/console/*. Returns null when the path is not ours.
 *  opts: { org, vault, doors (config.doors; omit = no first-run door), config (router providers name the keys to offer), l3 (console-l3 handle; serves /api/console/fleet/{state,digest,report-card}), fetch, now, envNames } */
export async function handleConsole(request, env, { org, vault, doors, config, l3, fetch: fetchFn, now = () => Date.now(), envNames = {} } = {}) {
  const url = new URL(request.url);
  const p = url.pathname;
  if (!(p === '/console' || p.startsWith('/console/') || p.startsWith('/api/console'))) return null;
  const api = p.startsWith('/api/');
  const isPost = request.method === 'POST';
  const clock = typeof now === 'function' ? now : () => now;
  const access = doors?.access?.team_domain && doors?.access?.aud ? doors.access : null;

  // OWNER-AUTH-1 (c): once GitHub sign-in is connected, the us_session cookie is the only sign-in path (CONSOLE_TOKEN and the first-run key stop working).
  if (await githubSigninActive(vault, config)) {
    const session = await readSession(decodeURIComponent(cookie(request, SESSION_COOKIE) || ''), { key: await vault.read('SESSION_KEY'), now: clock() });
    const accessOk = access ? await verifyAccessJwt(request.headers.get('cf-access-jwt-assertion'), { ...access, fetch: fetchFn, now: clock() }) : false;
    if (p === '/console/first-run') return Response.json({ error: 'not found' }, { status: 404 });
    if (p === '/console/login') return Response.json({ error: 'keys are no longer used; sign in with GitHub at /console/github/signin' }, { status: 410 });
    if (!canWrite(session) && !accessOk) return readOnlyView(request, { db: env.DB, config, session, clock });
    const actor = session?.login || 'access';
    return ownerRoutes(request, env, { org, vault, doors, config, l3, now: clock, envNames, confirm: true, actor });
  }

  // Which door is open? A configured token, else an Access team, else the one-time first-run key (src/first-run.js).
  let issuedHash = null;
  if (!env.CONSOLE_TOKEN && !access) {
    const door = await firstRunDoor(request, env, { doors, now: clock() });
    if (door.response) return door.response;
    issuedHash = door.issuedHash;
  }
  if (p === '/console/first-run') return Response.json({ error: 'not found' }, { status: 404 });

  const keyOk = async given => {
    if (!given) return false;
    if (env.CONSOLE_TOKEN && await tokenOk(given, env.CONSOLE_TOKEN)) return true;
    return issuedHash ? tokenOk(await sha256Hex(given), issuedHash) : false;
  };

  if (p === '/console/login' && isPost) {
    const form = await request.formData().catch(() => null);
    const given = form ? String(form.get('key') || '') : '';
    if (await keyOk(given)) {
      return new Response(null, { status: 303, headers: { location: '/console', 'set-cookie': `${COOKIE}=${encodeURIComponent(given)}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=2592000` } });
    }
    return page(LOGIN('That key did not work.'), 401);
  }
  let authed = await keyOk(decodeURIComponent(cookie(request, COOKIE) || ''));
  if (!authed && access) authed = await verifyAccessJwt(request.headers.get('cf-access-jwt-assertion'), { ...access, fetch: fetchFn, now: clock() });
  if (!authed) return api ? Response.json({ error: 'sign in' }, { status: 401 }) : page(LOGIN(), 401);

  return ownerRoutes(request, env, { org, vault, doors, config, l3, fetch: fetchFn, now: clock, envNames, confirm: false, actor: null });
}

/** The signed-in surface: the console page, its data and its write actions. With `confirm` (session mode) every write needs a
 *  second step, body.confirm === true (the page asks "are you sure"), and each success is recorded with who did it. */
async function ownerRoutes(request, env, { org, vault, doors, config, l3, fetch: fetchFn, now: clock, envNames, confirm, actor }) {
  const url = new URL(request.url);
  const p = url.pathname;
  const isPost = request.method === 'POST';
  if (l3 && request.method === 'GET' && p.startsWith('/api/console/fleet/')) {
    const inner = new URL(request.url); inner.pathname = '/api/' + p.slice('/api/console/fleet/'.length);
    return (await l3.handle(new Request(inner, { method: 'GET' }))) || Response.json({ error: 'not found' }, { status: 404 });
  }
  if (request.method === 'GET' && (p === '/console' || p === '/console/')) return page(CONSOLE_HTML);
  if (request.method === 'GET' && p === '/api/console') {
    const body = await buildConsole(env.DB, { org });
    body.connections = await listConnections(vault, envNames, { router: config?.router });
    body.doors = await doorStatus(env, { doors, now: clock() });
    body.help = HELP_SECTIONS; // generated from docs/help.md
    return Response.json(body, { headers: { 'cache-control': 'no-store' } });
  }

  if (isPost) { // state-changing: same-origin only
    const origin = request.headers.get('origin');
    if (!origin || origin !== url.origin) return Response.json({ error: 'cross-origin request refused' }, { status: 403 });
    const body = await request.json().catch(() => ({}));
    if (confirm && body.confirm !== true) return Response.json({ error: 'confirm required: press the button, then confirm' }, { status: 428 });
    let r;
    if (p === '/api/console/card') r = await resolveCard(env.DB, String(body.id || ''), String(body.choice || ''));
    else if (p === '/api/console/ask') r = await recordAsk(env.DB, body.text);
    else if (p === '/api/console/secret') {
      r = await saveSecret(vault, body);
    } else if (p === '/api/console/secret/remove') r = await removeSecret(vault, body);
    else return Response.json({ error: 'not found' }, { status: 404 });
    if (confirm && r.status === 200) await run(env.DB, `INSERT INTO console_actions (kind, ref, text) VALUES ('signed_action', ?, ?)`, p.replace('/api/console/', ''), actor);
    return Response.json(r.body, { status: r.status });
  }
  return Response.json({ error: 'not found' }, { status: 404 });
}

/** GitHub sign-in is on when the vault holds the App's OAuth credentials and the repository the role is read from is known.
 *  config.console.github_signin === false switches it off. Until then the older doors keep a fresh installation reachable. */
export async function githubSigninActive(vault, config) {
  if (!vault || !config?.vcs?.repo || config?.console?.github_signin === false) return false;
  try { return Boolean(await vault.has('GITHUB_APP_CLIENT_ID') && await vault.has('GITHUB_APP_CLIENT_SECRET')); } catch { return false; }
}

/** What anyone who is not an owner sees: the read-only dashboard when the owner turned the public view on, otherwise a sign-in
 *  page (no session) or a refusal (a signed-in viewer). Every other path is refused. Reads only. */
async function readOnlyView(request, { db, config, session, clock }) {
  const url = new URL(request.url);
  const p = url.pathname.replace(/\/+$/, '');
  const api = p.startsWith('/api/');
  const open = publicViewEnabled(config);
  if (request.method === 'GET' && open && (p === '/console' || p === '/api/console/public')) {
    const m = await loadMeasures({ db, now: clock(), config });
    return p === '/api/console/public' ? Response.json(m, { headers: { 'cache-control': 'no-store' } }) : page(renderPublicView(m, { viewer: session?.login || null }));
  }
  if (api) return Response.json({ error: session ? 'owner only' : 'sign in' }, { status: session ? 403 : 401 });
  if (session) return SETUP(`<h1>Read-only</h1><p>${esc(session.login)} can view this organization, not change it.</p>`, 403);
  return SETUP('<h1>Sign in</h1><p><a href="/console/github/signin">Sign in with GitHub</a></p>', 401);
}
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
