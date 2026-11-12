// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Collection: recordPageview turns one request into at most one row with no identifying value in it.
import { run, iso } from '../../core/kernel/util.js';

export const BOT = /bot|crawl|spider|slurp|curl|wget|python-requests|headless|preview|monitor|uptime|lighthouse/i;
const sha256 = async s => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map(x => x.toString(16).padStart(2, '0')).join('');

export function cfg(settings = {}) {
  return { own_hosts: [], raw_retention_days: 7, max_path_length: 200, salt: '', ...settings };
}

// request: { url, referrer, userAgent, ip, dnt, gpc }. Returns { recorded } or { skipped: reason }.
export async function recordPageview({ db, now = Date.now, settings = {}, request = {} }) {
  const s = cfg(settings);
  if (!s.salt) throw new Error('analytics salt is not configured (ANALYTICS_SALT)');
  if (request.dnt === '1' || request.dnt === true || request.gpc === '1' || request.gpc === true) return { skipped: 'do_not_track' };
  const ua = String(request.userAgent || '');
  if (!ua || BOT.test(ua)) return { skipped: 'bot' };
  let u; try { u = new URL(request.url); } catch { return { skipped: 'bad_url' }; }
  const own = h => s.own_hosts.some(o => h === o || h.endsWith('.' + o));
  if (s.own_hosts.length && !own(u.hostname)) return { skipped: 'foreign_host' };
  const path = (u.pathname.replace(/\/+$/, '') || '/').slice(0, s.max_path_length);
  let referrer = null;
  try { const r = new URL(request.referrer); if (!own(r.hostname)) referrer = r.hostname; } catch { /* no referrer */ }
  const day = iso(now()).slice(0, 10);
  const visitor = await sha256(`${s.salt}|${day}|${request.ip || ''}|${ua}`);
  const tag = k => (u.searchParams.get(k) || '').slice(0, 60) || null;
  await run(db, `INSERT INTO analytics_events (at, day, path, referrer, utm_source, utm_medium, utm_campaign, visitor_hash) VALUES (?,?,?,?,?,?,?,?)`,
    iso(now()), day, path, referrer, tag('utm_source'), tag('utm_medium'), tag('utm_campaign'), visitor);
  return { recorded: true };
}
