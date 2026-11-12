// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Bounce and complaint intake (US-21-R13): delivery events from any channel become guard.suppress calls, effective at once.
//   hard bounce  -> suppress that channel for the recipient (reason 'bounce')
//   soft bounce  -> counted; suppressed on that channel after `soft_limit` within `soft_window_days`
//   complaint    -> suppress every channel ('*', reason 'complaint'): a person who marks a message as unwanted hears from no pack
//   unsubscribe  -> suppress every channel ('*', reason 'unsubscribe')
// An event with a (channel, event_id) already seen is ignored, so a provider that retries a webhook changes nothing.
import { first, run, iso } from '../kernel/util.js';
import { sha256 } from './guard.js';

export const KINDS = ['hard', 'soft', 'complaint', 'unsubscribe'];
const norm = s => String(s ?? '').trim().toLowerCase();

// Map a provider payload to normalized events { channel, recipient, kind, eventId }. Unknown shapes yield no events and an error.
export const PARSERS = {
  // Already normalized: one event or a list.
  generic(payload, channel) {
    const list = Array.isArray(payload) ? payload : [payload];
    return list.map(e => ({ channel: e.channel || channel, recipient: e.recipient, kind: e.kind, eventId: e.eventId ?? e.id ?? null }));
  },
  // Notification shape used by common email providers: { type: 'Bounce'|'Complaint', bounceType: 'Permanent'|'Transient', recipients: [...], id }.
  email(payload, channel = 'email') {
    const list = Array.isArray(payload) ? payload : [payload];
    const out = [];
    for (const e of list) {
      const t = norm(e && (e.type ?? e.notificationType));
      const kind = t === 'complaint' ? 'complaint' : t === 'bounce' ? (norm(e.bounceType) === 'transient' ? 'soft' : 'hard') : t === 'unsubscribe' ? 'unsubscribe' : null;
      const rcpts = e && (e.recipients ?? (e.recipient ? [e.recipient] : []));
      for (const r of rcpts || []) out.push({ channel, recipient: typeof r === 'string' ? r : r && r.emailAddress, kind, eventId: e.id ? `${e.id}:${norm(typeof r === 'string' ? r : r.emailAddress)}` : null });
    }
    return out;
  },
};

export function createBounceIntake({ db, guard, now = Date.now, config = {} }) {
  const softLimit = config.soft_limit ?? 3;
  const softWindowMs = (config.soft_window_days ?? 7) * 86400e3;
  const hashOf = r => sha256(`bounce|${norm(r)}`);

  async function log(ev, rh, action) {
    await run(db, `INSERT INTO guard_bounces (at, pack, channel, recipient_hash, kind, event_id, action) VALUES (?,?,?,?,?,?,?)`,
      iso(now()), ev.pack ?? null, ev.channel, rh, ev.kind, ev.eventId ?? null, action);
  }

  // One normalized event. Returns { ok, action } or { ok: false, reason }.
  async function ingestOne(ev) {
    if (!ev || !ev.channel || !String(ev.recipient ?? '').trim()) return { ok: false, reason: 'channel_and_recipient_required' };
    if (!KINDS.includes(ev.kind)) return { ok: false, reason: 'unknown_kind' };
    const rh = await hashOf(ev.recipient);
    if (ev.eventId != null && await first(db, `SELECT 1 AS x FROM guard_bounces WHERE channel = ? AND event_id = ?`, ev.channel, String(ev.eventId))) return { ok: true, action: 'duplicate' };
    const e = { ...ev, eventId: ev.eventId == null ? null : String(ev.eventId) };
    if (ev.kind === 'hard') {
      await guard.suppress({ channel: ev.channel, recipient: ev.recipient, reason: 'bounce' });
      await log(e, rh, `suppressed:${ev.channel}`); return { ok: true, action: `suppressed:${ev.channel}` };
    }
    if (ev.kind === 'complaint' || ev.kind === 'unsubscribe') {
      await guard.suppress({ channel: '*', recipient: ev.recipient, reason: ev.kind });
      await log(e, rh, 'suppressed:*'); return { ok: true, action: 'suppressed:*' };
    }
    // soft: count recent soft bounces including this one
    await log(e, rh, 'counted');
    const since = iso(now() - softWindowMs);
    const n = (await first(db, `SELECT COUNT(*) AS n FROM guard_bounces WHERE channel = ? AND recipient_hash = ? AND kind = 'soft' AND at >= ?`, ev.channel, rh, since)).n;
    if (n >= softLimit) {
      await guard.suppress({ channel: ev.channel, recipient: ev.recipient, reason: 'bounce' });
      await run(db, `UPDATE guard_bounces SET action = ? WHERE id = (SELECT MAX(id) FROM guard_bounces WHERE channel = ? AND recipient_hash = ?)`, `suppressed:${ev.channel}`, ev.channel, rh);
      return { ok: true, action: `suppressed:${ev.channel}` };
    }
    return { ok: true, action: 'counted' };
  }

  // A provider payload in a named format. One bad event never stops the rest.
  async function ingest(payload, { channel, format = 'generic', pack = null } = {}) {
    const parse = PARSERS[format];
    if (!parse) return { ok: false, reason: 'unknown_format', results: [] };
    let events;
    try { events = parse(payload, channel); } catch (e) { return { ok: false, reason: `unparseable: ${e.message}`, results: [] }; }
    if (!events.length) return { ok: false, reason: 'no_events', results: [] };
    const results = [];
    for (const ev of events) results.push(await ingestOne({ ...ev, pack }));
    return { ok: results.every(r => r.ok), results };
  }

  // HTTP intake behind a shared secret: POST /bounces?channel=email&format=email with the provider JSON. No secret configured: refused.
  async function handle(request, { secret, header = 'x-bounce-token' } = {}) {
    const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
    if (!secret || request.headers.get(header) !== secret) return json({ error: 'unauthorized' }, 401);
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    const url = new URL(request.url);
    let body; try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400); }
    const r = await ingest(body, { channel: url.searchParams.get('channel') || undefined, format: url.searchParams.get('format') || 'generic', pack: url.searchParams.get('pack') });
    return json(r, r.ok ? 200 : 422);
  }

  return { ingest, ingestOne, handle };
}
