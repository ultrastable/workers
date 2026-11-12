// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Turnstile verification (US-SPEC-19-R09). Server side only: the token comes from the page, the secret from env.
// Fails closed: a missing token, a network error, a non-JSON answer, a failed check, a wrong hostname or action, or a
// slow answer all mean "not verified". Stores nothing; the visitor's address goes to siteverify as remoteip and nowhere else.
// The siteverify call is a port (`fetchImpl`) so tests use a fake and never touch the network.
export const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
export const TURNSTILE_ACTION = 'provision';
const MAX_TOKEN = 2048; // Cloudflare documents tokens up to 2048 characters.

/** @returns {Promise<{ok: boolean, reason: string}>} reason is a short code, never the token or the secret. */
export async function verifyTurnstile({ secret, token, ip = '', hostname = null, fetchImpl = (...a) => fetch(...a), timeoutMs = 4000 } = {}) {
  if (!secret) return { ok: false, reason: 'no_secret' };
  if (typeof token !== 'string' || !token) return { ok: false, reason: 'no_token' };
  if (token.length > MAX_TOKEN) return { ok: false, reason: 'token_too_long' };
  const body = new URLSearchParams({ secret, response: token });
  if (ip) body.set('remoteip', ip);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetchImpl(SITEVERIFY_URL, { method: 'POST', body, signal: ctl.signal });
    if (!r || r.status !== 200) return { ok: false, reason: 'siteverify_status' };
    let j; try { j = await r.json(); } catch { return { ok: false, reason: 'siteverify_unreadable' }; }
    if (!j || j.success !== true) return { ok: false, reason: 'rejected' };
    if (hostname && j.hostname !== hostname) return { ok: false, reason: 'wrong_hostname' };
    if (j.action !== undefined && j.action !== '' && j.action !== TURNSTILE_ACTION) return { ok: false, reason: 'wrong_action' };
    return { ok: true, reason: 'verified' };
  } catch { return { ok: false, reason: 'siteverify_unreachable' }; } finally { clearTimeout(timer); }
}

/** A site key is public but still validated before it is placed in the page. */
export const validSiteKey = k => typeof k === 'string' && /^[0-9A-Za-z_-]{1,64}$/.test(k);
