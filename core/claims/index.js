// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Claims (US-SPEC-08): exclusive time-limited claims, fences, secret lease, deploy lock, reaper, reconciliation hooks.
// Ports only: ctx = { db, now(), config, killSwitch?(), authorize?(request) }. No platform imports.

const KINDS = ['work', 'deploy', 'secret'];
const TERMINAL = ['done', 'superseded', 'cancelled'];
const SECRET_FIELDS = ['value', 'secret', 'secret_value', 'password', 'plaintext'];

const DEFAULTS = {
  claim_ttl_minutes: 120, lease_ttl_minutes: 2, deploy_ttl_minutes: 15,
  max_ttl_minutes: 240, rework_threshold: 3, escalation_role: 'project-manager',
};

export const cfg = ctx => ({ ...DEFAULTS, ...(ctx.config || {}) });

export function nowMs(ctx) {
  const v = ctx.now();
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'string') return Date.parse(v.includes('T') ? v : v.replace(' ', 'T') + 'Z');
  return v;
}
export const iso = ms => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

const all = async (db, sql, ...a) => (await db.prepare(sql).bind(...a).all()).results || [];
const first = async (db, sql, ...a) => (await db.prepare(sql).bind(...a).first()) || null;
const run = (db, sql, ...a) => db.prepare(sql).bind(...a).run();

export function newToken() {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return [...b].map(x => x.toString(16).padStart(2, '0')).join('');
}
export async function hashToken(t) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(t)));
  return [...new Uint8Array(d)].map(x => x.toString(16).padStart(2, '0')).join('');
}
const normIntent = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const fail = (status, reason, extra = {}) => ({ ok: false, status, reason, ...extra });
const refuse = (status, reason, extra = {}) => fail(status, reason, { acquired: false, ...extra });

async function event(ctx, kind, key, holder, ev, detail) {
  await run(ctx.db, `INSERT INTO claims_events (at, kind, key, holder, event, detail) VALUES (?,?,?,?,?,?)`,
    iso(nowMs(ctx)), kind || null, key || null, holder || null, ev, detail ? String(detail).slice(0, 500) : null);
}
async function killed(ctx) {
  if (cfg(ctx).kill_switch === true) return true;
  return typeof ctx.killSwitch === 'function' ? !!(await ctx.killSwitch()) : false;
}
const view = (r, now) => ({
  kind: r.kind, key: r.key, holder: r.holder, intent: r.intent, item_id: r.item_id, fence: r.fence,
  claimed_at: r.claimed_at, heartbeat_at: r.heartbeat_at, expires_at: r.expires_at,
  live: r.released_at == null && r.expires_at > iso(now),
});

// ---- idempotency (US-08-R15) ----
async function idem(ctx, op, req, fn) {
  const k = req.idempotency_key;
  if (!k) return fn();
  const prior = await first(ctx.db, `SELECT response FROM claims_idem WHERE op=? AND idem_key=?`, op, String(k));
  if (prior) return { ...JSON.parse(prior.response), replayed: true };
  const res = await fn();
  const { token, ...safe } = res; // a replay never re-discloses a token
  await run(ctx.db, `INSERT OR IGNORE INTO claims_idem (op, idem_key, response, at) VALUES (?,?,?,?)`, op, String(k), JSON.stringify(safe), iso(nowMs(ctx)));
  return res;
}

// ---- seed interop: item claims are mirrored into the seed `claims` table so the tick's dispatch honors them ----
async function hasTable(db, name) {
  return !!(await first(db, `SELECT name FROM sqlite_master WHERE type='table' AND name=?`, name).catch(() => null));
}
async function mirrorIn(ctx, itemId, holder, at) {
  if (!itemId || !(await hasTable(ctx.db, 'claims')) || !(await first(ctx.db, `SELECT id FROM items WHERE id=?`, itemId))) return;
  await run(ctx.db, `INSERT OR REPLACE INTO claims (item_id, agent, claimed_at, heartbeat_at) VALUES (?,?,?,?)`, itemId, holder, at, at);
  await run(ctx.db, `UPDATE items SET status='claimed', updated_at=? WHERE id=? AND status IN ('open','ready')`, at, itemId);
}
async function mirrorBeat(ctx, itemId, at) {
  if (itemId && await hasTable(ctx.db, 'claims')) await run(ctx.db, `UPDATE claims SET heartbeat_at=? WHERE item_id=?`, at, itemId);
}
async function mirrorOut(ctx, itemId, at, outcome) {
  if (!itemId || !(await hasTable(ctx.db, 'claims'))) return;
  await run(ctx.db, `DELETE FROM claims WHERE item_id=?`, itemId);
  if (outcome !== 'done' && outcome !== 'gate') await run(ctx.db, `UPDATE items SET status='ready', updated_at=? WHERE id=? AND status='claimed'`, at, itemId);
}

async function endClaim(ctx, row, outcome, releasedAt) {
  const r = await run(ctx.db, `UPDATE claims_lock SET released_at=?, outcome=? WHERE id=? AND released_at IS NULL`, releasedAt, outcome, row.id);
  if (!r.meta.changes) return false;
  if (row.kind === 'work') await mirrorOut(ctx, row.item_id, iso(nowMs(ctx)), outcome);
  return true;
}

function target(req) {
  let key = req.key, item_id = req.item_id || null;
  if (!key && item_id) key = `item:${item_id}`;
  if (!key && req.path) key = `path:${req.path}`;
  if (key && !item_id && String(key).startsWith('item:')) item_id = String(key).slice(5);
  return { key: key == null ? '' : String(key), item_id };
}

// ---- acquire (US-08-R01, R07, R09; secret lease; deploy lock) ----
export async function acquire(ctx, req = {}) {
  const kind = req.kind || 'work';
  if (!KINDS.includes(kind)) return refuse(400, 'bad_kind');
  const { key, item_id } = target(req);
  const holder = String(req.holder || req.owner || '').trim();
  if (!key || key.length > 300 || !holder) return refuse(400, 'key_and_holder_required');
  if (kind === 'secret' && SECRET_FIELDS.some(f => f in req)) return refuse(400, 'secret_values_never_accepted');
  if (await killed(ctx)) { await event(ctx, kind, key, holder, 'kill-switch', 'acquire refused'); return refuse(503, 'kill-switch'); }
  return idem(ctx, 'acquire', req, async () => {
    const c = cfg(ctx), now = nowMs(ctx), nowS = iso(now);
    const def = kind === 'secret' ? c.lease_ttl_minutes : kind === 'deploy' ? c.deploy_ttl_minutes : c.claim_ttl_minutes;
    const ttl = kind === 'work' ? Math.min(Number(req.ttl_minutes) > 0 ? Number(req.ttl_minutes) : def, c.max_ttl_minutes) : def;
    const intent = String(req.intent || '').slice(0, 300), norm = normIntent(intent);

    await expireKey(ctx, kind, key, nowS);

    if (kind === 'work' && item_id) {
      const item = await first(ctx.db, `SELECT status, trigger_on FROM items WHERE id=?`, item_id);
      if (item) {
        if (TERMINAL.includes(item.status)) return refuse(409, 'item_terminal');
        if (item.trigger_on) {
          const t = await first(ctx.db, `SELECT status FROM items WHERE id=?`, item.trigger_on);
          if (!t || t.status !== 'done') return refuse(409, 'trigger_not_done', { trigger: item.trigger_on });
        }
        if (await hasTable(ctx.db, 'claims')) {
          const seed = await first(ctx.db, `SELECT agent FROM claims WHERE item_id=?`, item_id);
          if (seed && !(await liveRow(ctx, kind, key))) return refuse(409, 'held', { holder: seed.agent, same_intent: false, advice: 'review the claimed work or take the next item' });
        }
      }
    }
    if (kind === 'work' && norm && !req.allow_duplicate) {
      const dup = await first(ctx.db, `SELECT * FROM claims_lock WHERE kind='work' AND released_at IS NULL AND intent_norm=? AND key<>? AND holder<>? AND expires_at>?`, norm, key, holder, nowS);
      if (dup) return shepherd(dup, 'same_intent', norm);
    }
    const token = newToken(), hash = await hashToken(token);
    try {
      await run(ctx.db, `INSERT INTO claims_lock (kind,key,holder,intent,intent_norm,item_id,token_hash,fence,ttl_minutes,claimed_at,heartbeat_at,expires_at)
        VALUES (?,?,?,?,?,?,?, (SELECT COALESCE(MAX(fence),0)+1 FROM claims_lock WHERE kind=? AND key=?), ?,?,?,?)`,
        kind, key, holder, intent, norm, item_id, hash, kind, key, ttl, nowS, nowS, iso(now + ttl * 60000));
    } catch (e) {
      if (!/UNIQUE|constraint/i.test(String(e && e.message))) throw e;
      const live = await first(ctx.db, `SELECT * FROM claims_lock WHERE kind=? AND key=? AND released_at IS NULL`, kind, key);
      await event(ctx, kind, key, holder, 'refused', `held by ${live ? live.holder : 'another'}`);
      if (!live) return refuse(409, 'contention', { retry: true });
      return shepherd(live, live.holder === holder ? 'held_by_you' : 'held', norm);
    }
    const row = await first(ctx.db, `SELECT fence, expires_at FROM claims_lock WHERE kind=? AND key=? AND released_at IS NULL`, kind, key);
    if (kind === 'work') await mirrorIn(ctx, item_id, holder, nowS);
    await event(ctx, kind, key, holder, 'acquired', `fence ${row.fence}`);
    return { ok: true, status: 200, acquired: true, kind, key, holder, token, fence: row.fence, expires_at: row.expires_at, ttl_minutes: ttl };
  });
}
function shepherd(live, reason, norm) {
  const same = !!norm && live.intent_norm === norm;
  return refuse(409, reason, {
    acquired: false, holder: live.holder, key: live.key, expires_at: live.expires_at, same_intent: same,
    advice: same ? 'shepherd the existing claim: review and help it land instead of duplicating' : 'review the claimed change or take the next item',
  });
}
async function expireKey(ctx, kind, key, nowS) {
  const rows = await all(ctx.db, `SELECT * FROM claims_lock WHERE kind=? AND key=? AND released_at IS NULL AND expires_at<=?`, kind, key, nowS);
  for (const r of rows) if (await endClaim(ctx, r, 'expired', r.expires_at)) await event(ctx, r.kind, r.key, r.holder, 'expired', 'expired before re-acquire');
}

async function liveRow(ctx, kind, key) {
  return first(ctx.db, `SELECT * FROM claims_lock WHERE kind=? AND key=? AND released_at IS NULL`, kind, key);
}
async function authed(ctx, row, token) {
  return !!row && !!token && row.token_hash === await hashToken(token);
}

// ---- heartbeat (US-08-R06) ----
export async function heartbeat(ctx, req = {}) {
  const kind = req.kind || 'work', { key } = target(req);
  if (await killed(ctx)) { await event(ctx, kind, key, null, 'kill-switch', 'renewal refused'); return fail(503, 'kill-switch'); }
  const row = await liveRow(ctx, kind, key);
  if (!row) return fail(409, 'no_live_claim');
  if (!(await authed(ctx, row, req.token))) return fail(409, 'token_mismatch');
  const now = nowMs(ctx);
  if (row.expires_at <= iso(now)) return fail(409, 'expired');
  const exp = iso(now + row.ttl_minutes * 60000);
  await run(ctx.db, `UPDATE claims_lock SET heartbeat_at=?, expires_at=? WHERE id=? AND released_at IS NULL`, iso(now), exp, row.id);
  if (kind === 'work') await mirrorBeat(ctx, row.item_id, iso(now));
  await event(ctx, kind, key, row.holder, 'renewed', `expires ${exp}`);
  return { ok: true, status: 200, renewed: true, kind, key, fence: row.fence, expires_at: exp };
}

// ---- release ----
export async function release(ctx, req = {}) {
  const kind = req.kind || 'work', { key } = target(req);
  return idem(ctx, 'release', req, async () => {
    const row = await liveRow(ctx, kind, key);
    if (!row) return fail(409, 'no_live_claim', { released: false });
    if (!(await authed(ctx, row, req.token))) return fail(409, 'token_mismatch', { released: false });
    const outcome = String(req.outcome || 'released').slice(0, 40);
    await endClaim(ctx, row, outcome, iso(nowMs(ctx)));
    await event(ctx, kind, key, row.holder, 'released', outcome);
    return { ok: true, status: 200, released: true, kind, key, outcome };
  });
}

// ---- protected-resource check (US-08-R08): accept a write only for the live token and the current fence ----
export async function check(ctx, req = {}) {
  const kind = req.kind || 'work', { key } = target(req);
  const row = await liveRow(ctx, kind, key);
  if (!row) return { ok: true, status: 200, valid: false, reason: 'no_live_claim' };
  if (row.expires_at <= iso(nowMs(ctx))) return { ok: true, status: 200, valid: false, reason: 'expired' };
  if (!(await authed(ctx, row, req.token))) return { ok: true, status: 200, valid: false, reason: 'token_mismatch' };
  if (Number(req.fence) !== row.fence) return { ok: true, status: 200, valid: false, reason: 'stale_fence', current_fence: row.fence };
  return { ok: true, status: 200, valid: true, fence: row.fence };
}

// ---- status: never exposes tokens or hashes ----
export async function status(ctx, req = {}) {
  const now = nowMs(ctx), kind = req.kind || 'work';
  const { key } = target(req);
  const rows = key
    ? await all(ctx.db, `SELECT * FROM claims_lock WHERE kind=? AND key=? AND released_at IS NULL`, kind, key)
    : await all(ctx.db, `SELECT * FROM claims_lock WHERE kind=? AND released_at IS NULL ORDER BY claimed_at`, kind);
  const claims = rows.map(r => view(r, now));
  const out = { ok: true, status: 200, kind, claims, count: claims.length };
  if (key) { const m = await first(ctx.db, `SELECT MAX(fence) AS f FROM claims_lock WHERE kind=? AND key=?`, kind, key); out.fence = m ? m.f : null; }
  return out;
}

// ---- reaper (US-08-R02, R13) ----
export async function reapExpired(ctx) {
  const nowS = iso(nowMs(ctx));
  let reaped = 0;
  for (const r of await all(ctx.db, `SELECT * FROM claims_lock WHERE released_at IS NULL AND expires_at<=?`, nowS))
    if (await endClaim(ctx, r, 'expired', r.expires_at)) { reaped++; await event(ctx, r.kind, r.key, r.holder, 'expired', 'reaped'); }
  // an item claim whose seed mirror vanished (the seed reaper already freed the item) is no longer live
  if (await hasTable(ctx.db, 'claims'))
    for (const r of await all(ctx.db, `SELECT * FROM claims_lock WHERE kind='work' AND released_at IS NULL AND item_id IS NOT NULL
        AND item_id IN (SELECT id FROM items) AND item_id NOT IN (SELECT item_id FROM claims)`))
      if (await endClaim(ctx, r, 'expired', nowS)) { reaped++; await event(ctx, r.kind, r.key, r.holder, 'expired', 'mirror reaped'); }
  return { reaped };
}

// ---- terminal release: a claim on an item that is done or closed is released ----
export async function releaseTerminal(ctx) {
  const ph = TERMINAL.map(() => '?').join(',');
  const rows = await all(ctx.db, `SELECT l.* FROM claims_lock l JOIN items i ON i.id = l.item_id WHERE l.released_at IS NULL AND i.status IN (${ph})`, ...TERMINAL);
  let released = 0;
  for (const r of rows) if (await endClaim(ctx, r, 'terminal', iso(nowMs(ctx)))) { released++; await event(ctx, r.kind, r.key, r.holder, 'terminal', 'linked item is terminal'); }
  return { released };
}

export async function metrics(ctx) {
  const nowS = iso(nowMs(ctx));
  const n = async (sql, ...a) => (await first(ctx.db, sql, ...a)).n;
  return {
    live_claims: await n(`SELECT COUNT(*) AS n FROM claims_lock WHERE released_at IS NULL AND expires_at>?`, nowS),
    orphaned_claims: await n(`SELECT COUNT(*) AS n FROM claims_lock WHERE released_at IS NULL AND expires_at<=?`, nowS),
    expired_total: await n(`SELECT COUNT(*) AS n FROM claims_lock WHERE outcome='expired'`),
    open_incidents: await n(`SELECT COUNT(*) AS n FROM claims_incidents WHERE status='open'`),
  };
}

// ---- reconciliation hooks (US-08-R04, R10, R11, R12, R14) ----
export async function reopenSilentDrops(ctx) {
  const rows = await all(ctx.db, `SELECT id FROM items WHERE status IN ('done','superseded','cancelled') AND (disposition IS NULL OR disposition='')`);
  for (const r of rows) {
    await run(ctx.db, `UPDATE items SET status='open', updated_at=? WHERE id=?`, iso(nowMs(ctx)), r.id);
    await run(ctx.db, `INSERT INTO outcomes (item_id, surface, action_class, result, evidence) VALUES (?, 'work_tracker','create_update_close','silent_drop','reopened by claims reconcile: no disposition')`, r.id);
  }
  return { reopened: rows.map(r => r.id) };
}

const cnt = v => Array.isArray(v) ? v.length : Number(v) || 0;
const BUCKETS = ['executed', 'failed', 'needs_human', 'no_action'];
export async function recordLoopRun(ctx, lr = {}) {
  return idem(ctx, 'loop', lr, async () => {
    const ids = Array.isArray(lr.scanned_ids) ? lr.scanned_ids : null;
    const scanned = ids ? ids.length : cnt(lr.scanned);
    const gap = scanned - BUCKETS.reduce((s, k) => s + cnt(lr[k]), 0);
    const at = iso(nowMs(ctx)), name = String(lr.loop || 'loop');
    await run(ctx.db, `INSERT INTO claims_loop_runs (at,loop,scanned,executed,failed,needs_human,no_action,gap) VALUES (?,?,?,?,?,?,?,?)`,
      at, name, scanned, cnt(lr.executed), cnt(lr.failed), cnt(lr.needs_human), cnt(lr.no_action), gap);
    const out = { ok: true, status: 200, scanned, gap, incident_id: null, reopened: [] };
    if (gap === 0) return out;
    const inc = await run(ctx.db, `INSERT INTO claims_incidents (at,kind,ref,detail) VALUES (?, 'accounting_gap', ?, ?)`, at, name, `scanned ${scanned}, accounted ${scanned - gap}, gap ${gap}`);
    out.incident_id = inc.meta.last_row_id;
    if (ids && BUCKETS.every(k => Array.isArray(lr[k]))) {
      const seen = new Set(BUCKETS.flatMap(k => lr[k]));
      for (const id of ids.filter(i => !seen.has(i))) {
        await run(ctx.db, `UPDATE items SET status='open', updated_at=? WHERE id=?`, at, id);
        await run(ctx.db, `INSERT INTO outcomes (item_id, surface, action_class, result, evidence) VALUES (?, 'work_tracker','loop_accounting','silent_drop',?)`, id, `unaccounted by loop ${name}`);
        out.reopened.push(id);
      }
    }
    return out;
  });
}

export async function recordRework(ctx, { item_id } = {}) {
  const c = cfg(ctx), at = iso(nowMs(ctx));
  await run(ctx.db, `INSERT INTO claims_rework (item_id, count) VALUES (?, 1) ON CONFLICT(item_id) DO UPDATE SET count = count + 1`, item_id);
  const { count } = await first(ctx.db, `SELECT count FROM claims_rework WHERE item_id=?`, item_id);
  if (count < c.rework_threshold) return { count, escalated: false };
  const id = `root-cause-${item_id}`;
  const r = await run(ctx.db, `INSERT OR IGNORE INTO items (id,title,kind,owner_role,done_check,priority,status)
    VALUES (?,?, 'fix', ?, ?, 5, 'ready')`, id, `Root cause: ${item_id} failed review ${count} times`, c.escalation_role, `the cause of repeated rework on ${item_id} is named and fixed at its root`);
  if (r.meta.changes) {
    await run(ctx.db, `UPDATE claims_rework SET escalated_at=? WHERE item_id=?`, at, item_id);
    await run(ctx.db, `INSERT INTO claims_incidents (at,kind,ref,detail) VALUES (?, 'rework_escalation', ?, ?)`, at, item_id, `rework count ${count}`);
  }
  return { count, escalated: true, escalation_id: id };
}

export async function recordPull(ctx, { puller, item_id = null, route } = {}) {
  await run(ctx.db, `INSERT INTO claims_pulls (at,puller,item_id,route) VALUES (?,?,?,?)`, iso(nowMs(ctx)), String(puller), item_id, String(route));
  return { ok: true };
}

// An interrupt-eligible step leaves the doer path and becomes one gate card. A card without an identity-bound line is rerouted.
export async function escalateToGate(ctx, g = {}) {
  if (!g.identity_bound) return { rerouted: true, card: null };
  const id = `gate-${g.item_id}`, at = iso(nowMs(ctx));
  await run(ctx.db, `INSERT OR IGNORE INTO gate_cards (id, what, why_gated, default_in_effect, closing_probe) VALUES (?,?,?,?,?)`,
    id, g.what, g.why_gated, g.default_in_effect, g.closing_probe || 'manual');
  const row = await liveRow(ctx, 'work', `item:${g.item_id}`);
  if (row) { await endClaim(ctx, row, 'gate', at); await event(ctx, 'work', row.key, row.holder, 'gate', id); }
  await run(ctx.db, `UPDATE items SET status='blocked', blocker=?, updated_at=? WHERE id=?`, `gate card ${id}`, at, g.item_id);
  return { rerouted: false, card: id };
}

export async function reconcile(ctx) {
  const reaped = await reapExpired(ctx);
  const terminal = await releaseTerminal(ctx);
  const drops = await reopenSilentDrops(ctx);
  return { ...reaped, terminal_released: terminal.released, reopened: drops.reopened, metrics: await metrics(ctx) };
}

// ---- fetch-style router: /work-lock, /deploy-lock, /secret-lock + acquire|heartbeat|release|check|status ----
const json = (body, status = 200, extra = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra } });
const OPS = { acquire, heartbeat, release, check };

export async function handle(request, ctx) {
  const url = new URL(request.url);
  const m = url.pathname.match(/^\/(work|deploy|secret)-lock\/(acquire|heartbeat|release|check|status)$/);
  if (!m) return json({ error: 'not_found' }, 404);
  const kind = m[1], op = m[2];
  const mutating = request.method === 'POST';
  if (!mutating && !(request.method === 'GET' && op === 'status')) return json({ error: 'method_not_allowed' }, 405);
  if (mutating) {
    if (typeof ctx.authorize === 'function') { if (!(await ctx.authorize(request))) return json({ error: 'unauthorized' }, 401); }
    else if (!cfg(ctx).allow_unauthenticated) return json({ error: 'unauthorized', note: 'provide ctx.authorize' }, 401);
  }
  let body = {};
  if (mutating) { try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400); } }
  else body = { key: url.searchParams.get('key') || undefined };
  const fn = op === 'status' ? status : OPS[op];
  const res = await fn(ctx, { ...body, kind });
  const { status: code, ...rest } = res;
  return json(rest, code || 200, res.retry ? { 'retry-after': '1' } : {});
}
