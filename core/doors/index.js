// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Doors for the console (US-SPEC-18/19): a first-run key shown once, and Cloudflare Access sign-in by verified JWT.
// WebCrypto only. A header is never trusted without verifying signature, aud, iss, exp and nbf.

const enc = new TextEncoder();
const b64uToBytes = s => { const t = String(s).replace(/-/g, '+').replace(/_/g, '/'); const bin = atob(t + '='.repeat((4 - t.length % 4) % 4)); return Uint8Array.from(bin, c => c.charCodeAt(0)); };
const bytesToB64u = b => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function generateKey() { return bytesToB64u(crypto.getRandomValues(new Uint8Array(32))); }
export async function sha256Hex(s) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(String(s))))].map(b => b.toString(16).padStart(2, '0')).join('');
}
const parseTs = s => { const x = String(s || ''); const ms = Date.parse(/[TZ]/.test(x) ? x : x.replace(' ', 'T') + 'Z'); return Number.isNaN(ms) ? null : ms; };

export const FIRST_RUN_CARD = 'doors-first-run-expired';

/** { state: 'issued'|'expired'|'open'|'starting', hash? }. Marks the window expired (and files one card) when it passes unused. */
export async function firstRunState(db, { now = Date.now(), minutes = 60 } = {}) {
  const row = await db.prepare(`SELECT key_hash, expired_at FROM doors_first_run WHERE id=1`).first();
  if (row?.key_hash) return { state: 'issued', hash: row.key_hash };
  if (row?.expired_at) return { state: 'expired' };
  const t0 = parseTs((await db.prepare(`SELECT MIN(started_at) AS t FROM tick_runs`).first())?.t);
  if (t0 === null) return { state: 'starting' };
  if (now >= t0 + minutes * 60000) {
    await db.prepare(`INSERT OR IGNORE INTO doors_first_run (id, expired_at) VALUES (1, datetime('now'))`).run();
    await db.prepare(`INSERT OR IGNORE INTO gate_cards (id, what, why_gated, default_in_effect, prepared_by_fleet, closing_probe) VALUES (?,?,?,?,?,?)`)
      .bind(FIRST_RUN_CARD, 'first-run window expired: reset from the host',
        'The one-time sign-in key was never claimed, so the console stays off (default-deny). A manual reset route is not provided in v1.',
        'the console stays off; every other loop keeps running', 'doors', 'manual').run();
    return { state: 'expired' };
  }
  return { state: 'open' };
}

/** Claim the single first-run key. Returns the key once, or null if it was already issued or expired. Stores only the hash. */
export async function claimFirstRun(db) {
  const key = generateKey();
  const r = await db.prepare(`INSERT OR IGNORE INTO doors_first_run (id, key_hash, issued_at) VALUES (1, ?, datetime('now'))`).bind(await sha256Hex(key)).run();
  return r.meta.changes === 1 ? key : null;
}

/** Tick step helper: lets the window expire (and the card be filed) even if nobody visits. */
export async function sweepFirstRun(db, { now, config = {}, hasKey = false } = {}) {
  if (hasKey || !config) return { state: 'skipped' };
  return firstRunState(db, { now, minutes: config.first_run_minutes ?? 60 });
}

// ---- Cloudflare Access JWT ----
const jwksCache = new Map(); // team_domain -> { at, keys }
const HOUR = 3600e3;

async function getKeys(team, fetchFn, now, force) {
  const hit = jwksCache.get(team);
  if (hit && !force && now - hit.at < HOUR) return hit.keys;
  if (hit && force && now - hit.at < 60e3) return hit.keys; // do not refetch more than once a minute
  const res = await fetchFn(`https://${team}/cdn-cgi/access/certs`);
  if (!res.ok) return hit?.keys || [];
  const keys = (await res.json()).keys || [];
  jwksCache.set(team, { at: now, keys });
  return keys;
}

/** True only for a token that verifies against the team's keys with matching aud and iss and a valid time window. */
export async function verifyAccessJwt(token, { team_domain, aud, fetch: fetchFn = (...a) => globalThis.fetch(...a), now = Date.now() } = {}) {
  try {
    if (!token || !team_domain || !aud) return false;
    const parts = String(token).split('.');
    if (parts.length !== 3) return false;
    const header = JSON.parse(new TextDecoder().decode(b64uToBytes(parts[0])));
    if (header.alg !== 'RS256' || !header.kid) return false;
    let jwk = (await getKeys(team_domain, fetchFn, now, false)).find(k => k.kid === header.kid);
    if (!jwk) jwk = (await getKeys(team_domain, fetchFn, now, true)).find(k => k.kid === header.kid);
    if (!jwk || jwk.kty !== 'RSA') return false;
    const key = await crypto.subtle.importKey('jwk', { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    if (!await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64uToBytes(parts[2]), enc.encode(parts[0] + '.' + parts[1]))) return false;
    const c = JSON.parse(new TextDecoder().decode(b64uToBytes(parts[1])));
    const sec = Math.floor(now / 1000), skew = 60;
    if (c.iss !== `https://${team_domain}`) return false;
    if (!(Array.isArray(c.aud) ? c.aud.includes(aud) : c.aud === aud)) return false;
    if (typeof c.exp !== 'number' || sec > c.exp + skew) return false;
    if (c.nbf !== undefined && (typeof c.nbf !== 'number' || sec < c.nbf - skew)) return false;
    return true;
  } catch { return false; }
}
export const _clearJwksCache = () => jwksCache.clear();
