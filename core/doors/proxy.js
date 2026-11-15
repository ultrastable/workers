// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Identity-aware proxy in front of the console (US-SPEC-18 section 8, US-18-R09). The deployment guide is data
// (proxy-guide.json, passed in as `guide`); this module runs it: it verifies the proxy's signed header, observes which guide
// steps are done, and keeps one decision card per step a person must do, closed when the step is observed done.
// Ports: db, fetch, now, config (the organization's config: doors.access, doors.iap, doors.proxy), env (presence map).
import { verifyAccessJwt } from './index.js';

export const IAP_KEYS_URL = 'https://www.gstatic.com/iap/verify/public_key-jwk';
export const IAP_ISSUER = 'https://cloud.google.com/iap';
export const HEADERS = { 'cloudflare-access': 'cf-access-jwt-assertion', 'google-iap': 'x-goog-iap-jwt-assertion' };
const b64u = s => Uint8Array.from(atob(String(s).replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
const dec = b => JSON.parse(new TextDecoder().decode(b));
const iapKeys = { at: 0, keys: [] };
export const _clearIapKeys = () => { iapKeys.at = 0; iapKeys.keys = []; };

async function getIapKeys(fetchFn, now, force) {
  if (iapKeys.keys.length && !force && now - iapKeys.at < 3600e3) return iapKeys.keys;
  if (iapKeys.keys.length && force && now - iapKeys.at < 60e3) return iapKeys.keys;
  const res = await fetchFn(IAP_KEYS_URL);
  if (!res.ok) return iapKeys.keys;
  iapKeys.keys = (await res.json()).keys || []; iapKeys.at = now;
  return iapKeys.keys;
}

/** Verify the header Google Identity-Aware Proxy adds. Returns { ok, email, sub } or { ok: false }. ES256, issuer and audience
 *  checked, 60 s clock skew. The audience is the backend's `/projects/<number>/global/backendServices/<id>` string. */
export async function verifyIapJwt(token, { audience, fetch: fetchFn = (...a) => globalThis.fetch(...a), now = Date.now() } = {}) {
  try {
    if (!token || !audience) return { ok: false };
    const parts = String(token).split('.');
    if (parts.length !== 3) return { ok: false };
    const header = dec(b64u(parts[0]));
    if (header.alg !== 'ES256' || !header.kid) return { ok: false };
    let jwk = (await getIapKeys(fetchFn, now, false)).find(k => k.kid === header.kid);
    if (!jwk) jwk = (await getIapKeys(fetchFn, now, true)).find(k => k.kid === header.kid);
    if (!jwk || jwk.kty !== 'EC' || jwk.crv !== 'P-256') return { ok: false };
    const key = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, ext: true }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    if (!await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, b64u(parts[2]), new TextEncoder().encode(parts[0] + '.' + parts[1]))) return { ok: false };
    const c = dec(b64u(parts[1])); const sec = Math.floor(now / 1000); const skew = 60;
    if (c.iss !== IAP_ISSUER || c.aud !== audience) return { ok: false };
    if (typeof c.exp !== 'number' || sec > c.exp + skew) return { ok: false };
    if (typeof c.iat !== 'number' || sec < c.iat - skew) return { ok: false };
    return { ok: true, email: c.email ?? null, sub: c.sub ?? null };
  } catch { return { ok: false }; }
}

const at = (obj, path) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
/** Which proxy the configuration names: doors.proxy.kind, else whichever of doors.access / doors.iap is filled in. */
export function proxyKind(config = {}) {
  const d = config.doors || {};
  if (d.proxy?.kind) return d.proxy.kind;
  if (d.access?.team_domain && d.access?.aud) return 'cloudflare-access';
  if (d.iap?.audience) return 'google-iap';
  return null;
}

/** Did this request come through the configured proxy? { ok, kind, email }. No proxy configured is { ok: false, kind: null }. */
export async function verifyProxy(request, config = {}, { fetch: fetchFn, now = Date.now() } = {}) {
  const kind = proxyKind(config); const d = config.doors || {};
  if (kind === 'cloudflare-access') return { ok: await verifyAccessJwt(request.headers.get(HEADERS[kind]), { ...d.access, fetch: fetchFn, now }), kind, email: null };
  if (kind === 'google-iap') return { ...(await verifyIapJwt(request.headers.get(HEADERS[kind]), { audience: d.iap?.audience, fetch: fetchFn, now })), kind };
  return { ok: false, kind };
}

export function createProxyGuide({ db, guide, config = {}, env = {}, fetch: fetchFn, now = () => Date.now() } = {}) {
  if (!guide?.proxies) throw new Error('the guide data (proxy-guide.json) is required');
  const clock = typeof now === 'function' ? now : () => now;
  const run = (sql, ...a) => db.prepare(sql).bind(...a).run();
  const one = (sql, ...a) => db.prepare(sql).bind(...a).first();
  const stamp = () => new Date(clock()).toISOString().replace('T', ' ').slice(0, 19);

  /** The checks a guide step may name. Each returns { done, detail } from something observed, never from a claim. */
  const CHECKS = {
    async config(arg) { const v = at(config, arg); return { done: typeof v === 'string' && v.trim() !== '', detail: `setting ${arg} is ${v ? 'filled in' : 'empty'}` }; },
    async probe(arg, { origin }) {
      if (arg !== 'unauthenticated_refused') return { done: false, detail: `unknown probe ${arg}` };
      if (!origin || typeof fetchFn !== 'function') return { done: false, detail: 'no public address to probe yet' };
      try {
        const res = await fetchFn(`${origin}/api/console`, { redirect: 'manual' });
        const refused = [301, 302, 303, 307, 401, 403].includes(res.status);
        return { done: refused, detail: `a request with no sign-in got ${res.status}` };
      } catch (e) { return { done: false, detail: `probe failed: ${String(e?.message || e).slice(0, 80)}` }; }
    },
    async inner(arg) {
      if (arg !== 'lock_present') return { done: false, detail: `unknown inner check ${arg}` };
      const names = config.doors?.inner_lock_env || ['CONSOLE_TOKEN', 'GITHUB_APP_CLIENT_ID'];
      const has = names.filter(n => env[n] === true);
      const firstRun = await one(`SELECT name FROM sqlite_master WHERE type='table' AND name='doors_first_run'`).then(t => (t ? one(`SELECT COUNT(*) AS n FROM doors_first_run`) : null)).catch(() => null);
      const done = has.length > 0 || (firstRun?.n ?? 0) > 0;
      return { done, detail: done ? `the console's own sign-in is on (${has[0] || 'first-run key'})` : 'the console has no sign-in of its own' };
    },
  };
  const checkNames = () => Object.keys(CHECKS);

  /** Every step of the guide for the configured proxy, each with whether it was observed done. */
  async function status({ origin = config.public_origin || null } = {}) {
    const kind = proxyKind(config) || config.doors?.proxy?.intended || null;
    const p = kind ? guide.proxies[kind] : null;
    if (!p) return { kind, configured: false, ready: false, steps: [], note: kind ? `no guide for ${kind}` : 'no identity-aware proxy is named in the settings; the console is behind its own sign-in only' };
    const steps = [];
    for (const s of p.steps) {
      const [name, ...rest] = s.check.split(':'); const fn = CHECKS[name];
      const r = fn ? await fn(rest.join(':'), { origin }) : { done: false, detail: `unknown check ${s.check}` };
      steps.push({ id: s.id, who: s.who, what: s.what, default_in_effect: s.default_in_effect, check: s.check, done: !!r.done, detail: r.detail });
    }
    return { kind, name: p.name, header: p.header, configured: true, ready: steps.every(s => s.done), steps };
  }

  /** One decision card per step a person must do and that is not yet observed done; a card closes when its step is observed
   *  done, and reopens if a person pressed "I did it" while the check still fails. Idempotent. */
  async function sweep(opts = {}) {
    const st = await status(opts);
    const out = { opened: 0, closed: 0, reopened: 0, ready: st.ready };
    for (const s of st.steps.filter(x => x.who === 'person')) {
      const id = `proxy-${st.kind}-${s.id}`;
      const card = await one(`SELECT status FROM gate_cards WHERE id=?`, id);
      if (!s.done && !card) {
        await run(`INSERT OR IGNORE INTO gate_cards (id, what, why_gated, default_in_effect, prepared_by_fleet, closing_probe) VALUES (?,?,?,?,?,?)`, id, s.what,
          'This happens in your own cloud account, under your sign-in; the system cannot do it for you.', s.default_in_effect, 'doors', `proxy:${st.kind}:${s.id}`);
        out.opened++;
      } else if (!s.done && card.status === 'closed') { await run(`UPDATE gate_cards SET status='open', closed_at=NULL WHERE id=?`, id); out.reopened++; }
      else if (s.done && card?.status === 'open') { await run(`UPDATE gate_cards SET status='closed', closed_at=? WHERE id=?`, stamp(), id); out.closed++; }
    }
    return out;
  }

  return { status, sweep, checkNames, verify: (request, o = {}) => verifyProxy(request, config, { fetch: fetchFn, now: clock(), ...o }) };
}
