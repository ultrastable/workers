// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Email list service (US-SPEC-21 class B): double opt-in, confirm, unsubscribe, bounces, batch sends, metrics.
// Every message leaves through guard.send. Addresses are hashed for lookup and cleared when mailing must stop; they are never logged.
export const iso = ms => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const hex = bytes => [...bytes].map(x => x.toString(16).padStart(2, '0')).join('');
export async function sha256(s) { return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(s))))); }
export const normEmail = e => String(e ?? '').trim().toLowerCase();
export const validEmail = e => typeof e === 'string' && e.length <= 254 && /^[^\s@<>"',;\\]+@[^\s@<>"',;\\]+\.[^\s@<>"',;\\]+$/.test(e);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg))));
}
function safeEqual(a, b) { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; }

// Reasons that mean "stop this batch, try later" versus reasons that settle one recipient.
const STOP = r => /^(cap_per_day|cap_per_week|pack_disabled|kill_switch_|channel_port_missing|channel_not_declared|class_)/.test(r || '');
const SETTLED = r => /^(suppressed|no_consent|consent_not_confirmed|consent_revoked)$/.test(r || '');

// config: { baseUrl, senderLine, hashSalt, batchSize, confirmResendMinutes, subscribePerHour, linkSecret? }
// env: { EMAIL_LINK_SECRET } (the value only signs unsubscribe links; it is never stored or logged).
export function createEmail({ db, guard, now = Date.now, config = {}, env = {} }) {
  const baseUrl = String(config.baseUrl || '').replace(/\/+$/, '');
  const senderLine = String(config.senderLine || '');
  const linkSecret = config.linkSecret || env.EMAIL_LINK_SECRET || '';
  const salt = config.hashSalt || '';
  const batchSize = config.batchSize ?? 25;
  const resendMs = (config.confirmResendMinutes ?? 10) * 60e3;
  const perHour = config.subscribePerHour ?? 60;
  const q = {
    all: async (sql, ...a) => (await db.prepare(sql).bind(...a).all()).results || [],
    first: async (sql, ...a) => (await db.prepare(sql).bind(...a).first()) || null,
    run: (sql, ...a) => db.prepare(sql).bind(...a).run(),
  };
  const emailHash = e => sha256(`${salt}|${normEmail(e)}`);
  function requireConfig() {
    if (!/^https?:\/\//.test(baseUrl)) throw new Error('config.baseUrl is required (an absolute URL for confirm and unsubscribe links)');
    if (!senderLine.trim()) throw new Error('config.senderLine is required (honest sender identification)');
    if (!linkSecret) throw new Error('EMAIL_LINK_SECRET is not set (needed to sign unsubscribe links)');
  }

  const unsubToken = async id => `${id}.${(await hmac(linkSecret, `unsub|${id}`)).slice(0, 32)}`;
  async function subscriberFromUnsubToken(t) {
    const [id, sig] = String(t || '').split('.');
    if (!/^\d+$/.test(id || '') || !sig) return null;
    if (!safeEqual((await hmac(linkSecret, `unsub|${id}`)).slice(0, 32), sig)) return null;
    return q.first(`SELECT * FROM email_subscribers WHERE id = ?`, Number(id));
  }

  // The envelope is the guard's content string; port.js turns it back into subject, text, html and headers.
  async function envelope({ subscriberId, subject, text, html }) {
    const link = `${baseUrl}/unsubscribe?u=${await unsubToken(subscriberId)}`;
    return JSON.stringify({
      subject,
      text: `${text}\n\n--\n${senderLine}\nUnsubscribe: ${link}\n`,
      html: html ? `${html}<hr><p>${esc(senderLine)}<br><a href="${esc(link)}">Unsubscribe</a></p>` : undefined,
      headers: { 'List-Unsubscribe': `<${link}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
    });
  }

  async function subscribe({ email, source = null } = {}) {
    requireConfig();
    const address = normEmail(email);
    if (!validEmail(address)) return { ok: false, reason: 'invalid_address' };
    const recent = await q.first(`SELECT COUNT(*) AS n FROM email_subscribers WHERE created_at > ?`, iso(now() - 3600e3));
    if (recent.n >= perHour) return { ok: false, reason: 'rate_limited' };
    const eh = await emailHash(address);
    let sub = await q.first(`SELECT * FROM email_subscribers WHERE email_hash = ?`, eh);
    if (sub && sub.status === 'confirmed') return { ok: true, status: 'confirmed', sent: false };
    if (sub && sub.status === 'pending' && sub.confirm_sent_at && now() - Date.parse(sub.confirm_sent_at.replace(' ', 'T') + 'Z') < resendMs) return { ok: true, status: 'pending', sent: false };
    const c = await guard.consent.request({ channel: 'email', recipient: address });
    if (!c.ok) return { ok: true, status: sub ? sub.status : 'pending', sent: false };      // suppressed: nothing is sent, nothing is revealed
    if (!sub) {
      await q.run(`INSERT INTO email_subscribers (email_hash, address, status, source, created_at) VALUES (?,?, 'pending', ?, ?)`, eh, address, source ? String(source).slice(0, 80) : null, iso(now()));
      sub = await q.first(`SELECT * FROM email_subscribers WHERE email_hash = ?`, eh);
    } else if (sub.status !== 'pending') {
      await q.run(`UPDATE email_subscribers SET status = 'pending', address = ?, ended_at = NULL WHERE id = ?`, address, sub.id);
    }
    const token = c.token;                                                                  // the guard stores it hashed; so do we
    const th = await sha256(token);
    await q.run(`INSERT INTO email_tokens (token_hash, subscriber_id, kind, created_at) VALUES (?,?, 'confirm', ?)`, th, sub.id, iso(now()));
    // Asking to subscribe is the person's own opt-in for the one confirmation message, which travels on its own channel.
    const g = await guard.consent.grant({ channel: 'email_confirm', recipient: address });
    if (!g.ok) return { ok: true, status: 'pending', sent: false };
    const content = await envelope({
      subscriberId: sub.id, subject: 'Confirm your subscription',
      text: `Someone asked to subscribe this address to our list. To confirm, open this link:\n${baseUrl}/confirm?t=${token}\n\nIf this was not you, ignore this message and nothing more will be sent.`,
    });
    const r = await guard.send({ channel: 'email_confirm', kind: 'confirmation', recipient: address, content, idempotencyKey: `confirm:${sub.id}:${th.slice(0, 16)}` });
    await guard.consent.revoke({ channel: 'email_confirm', recipient: address });
    if (r.decision === 'sent') await q.run(`UPDATE email_subscribers SET confirm_sent_at = ? WHERE id = ?`, iso(now()), sub.id);
    return { ok: true, status: 'pending', sent: r.decision === 'sent', decision: r.decision, reason: r.reason ?? null };
  }

  // Single use: the token row is claimed with one conditional UPDATE before consent is recorded.
  async function confirm(token) {
    requireConfig();
    if (!/^[0-9a-f]{32}$/.test(String(token || ''))) return { ok: false, reason: 'invalid_token' };
    const th = await sha256(token);
    const used = await q.run(`UPDATE email_tokens SET used_at = ? WHERE token_hash = ? AND kind = 'confirm' AND used_at IS NULL`, iso(now()), th);
    if (!used.meta.changes) return { ok: false, reason: 'invalid_or_used_token' };
    const row = await q.first(`SELECT subscriber_id FROM email_tokens WHERE token_hash = ?`, th);
    const c = await guard.consent.confirm(token);
    if (!c.ok) return { ok: false, reason: 'consent_not_recorded' };
    await q.run(`UPDATE email_subscribers SET status = 'confirmed', confirmed_at = ? WHERE id = ? AND status = 'pending'`, iso(now()), row.subscriber_id);
    return { ok: true };
  }

  async function endSubscriber(sub, status, reason, address) {
    if (address) await guard.suppress({ channel: '*', recipient: address, reason });
    await q.run(`UPDATE email_subscribers SET status = ?, address = NULL, ended_at = ? WHERE id = ?`, status, iso(now()), sub.id);
    await q.run(`INSERT INTO email_events (email_hash, type, at) VALUES (?,?,?)`, sub.email_hash, reason, iso(now()));
  }

  // By link token or by address (operator use); effective at once, no approval. An address nobody subscribed is suppressed too.
  async function unsubscribe({ token = null, email = null } = {}) {
    requireConfig();
    if (token) {
      const sub = await subscriberFromUnsubToken(token);
      if (!sub) return { ok: false, reason: 'unknown_token' };
      if (sub.status !== 'unsubscribed') await endSubscriber(sub, 'unsubscribed', 'unsubscribe', sub.address);
      return { ok: true, known: true };
    }
    const address = normEmail(email);
    if (!validEmail(address)) return { ok: false, reason: 'invalid_address' };
    const sub = await q.first(`SELECT * FROM email_subscribers WHERE email_hash = ?`, await emailHash(address));
    if (!sub) { await guard.suppress({ channel: '*', recipient: address, reason: 'unsubscribe' }); return { ok: true, known: false }; }
    if (sub.status !== 'unsubscribed') await endSubscriber(sub, 'unsubscribed', 'unsubscribe', address);
    return { ok: true, known: true };
  }

  // type: 'hard' | 'soft' | 'complaint'. Hard bounces and complaints suppress at once; a soft bounce suppresses on the third in 30 days.
  async function recordBounce({ address, type = 'hard' } = {}) {
    const a = normEmail(address);
    if (!validEmail(a)) return { ok: false, reason: 'invalid_address' };
    const eh = await emailHash(a);
    const kind = type === 'complaint' ? 'complaint' : type === 'soft' ? 'soft_bounce' : 'hard_bounce';
    await q.run(`INSERT INTO email_events (email_hash, type, at) VALUES (?,?,?)`, eh, kind, iso(now()));
    if (type === 'soft') {
      const n = (await q.first(`SELECT COUNT(*) AS n FROM email_events WHERE email_hash = ? AND type = 'soft_bounce' AND at > ?`, eh, iso(now() - 30 * 86400e3))).n;
      if (n < 3) return { ok: true, suppressed: false };
    }
    await guard.suppress({ channel: '*', recipient: a, reason: type === 'complaint' ? 'complaint' : 'bounce' });
    await q.run(`UPDATE email_subscribers SET status = ?, address = NULL, ended_at = ? WHERE email_hash = ?`, type === 'complaint' ? 'unsubscribed' : 'bounced', iso(now()), eh);
    return { ok: true, suppressed: true };
  }

  async function queueMessage({ subject, text, html = null, kind = 'newsletter' } = {}) {
    if (!String(subject || '').trim() || !String(text || '').trim()) return { ok: false, reason: 'subject_and_text_required' };
    if (/[\r\n]/.test(subject)) return { ok: false, reason: 'subject_has_newline' };
    const r = await q.run(`INSERT INTO email_messages (kind, subject, body_text, body_html, created_at) VALUES (?,?,?,?,?)`, kind === 'notice' ? 'notice' : 'newsletter', subject, text, html, iso(now()));
    return { ok: true, messageId: r.meta.last_row_id };
  }

  const mark = (mid, sid, status, reason) => q.run(`INSERT INTO email_deliveries (message_id, subscriber_id, status, attempts, reason, at) VALUES (?,?,?,1,?,?)
    ON CONFLICT(message_id, subscriber_id) DO UPDATE SET status = excluded.status, attempts = attempts + 1, reason = excluded.reason, at = excluded.at`, mid, sid, status, reason, iso(now()));
  const REMAINING = `FROM email_subscribers s LEFT JOIN email_deliveries d ON d.message_id = ? AND d.subscriber_id = s.id
    WHERE s.status = 'confirmed' AND s.address IS NOT NULL AND (d.subscriber_id IS NULL OR (d.status = 'failed' AND d.attempts < 3))`;

  // One pass over up to `limit` recipients. Safe to call again after a crash: the idempotency key is per message and recipient.
  async function sendPending({ limit = batchSize } = {}) {
    requireConfig();
    const out = { sent: 0, skipped: 0, queued: 0, failed: 0, stopped: null };
    let budget = limit;
    for (const m of await q.all(`SELECT * FROM email_messages WHERE status = 'queued' ORDER BY id`)) {
      if (out.stopped) break;
      const batch = budget > 0 ? await q.all(`SELECT s.id, s.address ${REMAINING} ORDER BY s.id LIMIT ?`, m.id, budget) : [];
      for (const s of batch) {
        const content = await envelope({ subscriberId: s.id, subject: m.subject, text: m.body_text, html: m.body_html });
        const r = await guard.send({ channel: 'email', kind: m.kind, recipient: s.address, content, idempotencyKey: `msg:${m.id}:${s.id}` });
        if (r.decision === 'sent' || r.reason === 'duplicate_idempotency_key') { await mark(m.id, s.id, 'sent', null); out.sent++; }
        else if (r.decision === 'queued_for_approval') { await mark(m.id, s.id, 'queued', r.reason); out.queued++; }
        else if (STOP(r.reason)) { out.stopped = r.reason; break; }
        else if (SETTLED(r.reason)) { await mark(m.id, s.id, 'skipped', r.reason); out.skipped++; }
        else { await mark(m.id, s.id, 'failed', r.reason); out.failed++; }
        budget--;
      }
      if (!out.stopped && (await q.first(`SELECT COUNT(*) AS n ${REMAINING}`, m.id)).n === 0) await q.run(`UPDATE email_messages SET status = 'done', done_at = ? WHERE id = ?`, iso(now()), m.id);
    }
    return out;
  }

  async function writeMetrics() {
    const c = Object.fromEntries((await q.all(`SELECT status, COUNT(*) AS n FROM email_subscribers GROUP BY status`)).map(r => [r.status, r.n]));
    const row = { confirmed: c.confirmed || 0, pending: c.pending || 0, unsubscribed: c.unsubscribed || 0, bounced: c.bounced || 0 };
    await q.run(`INSERT OR REPLACE INTO email_metrics (at, confirmed, pending, unsubscribed, bounced) VALUES (?,?,?,?,?)`, iso(now()), row.confirmed, row.pending, row.unsubscribed, row.bounced);
    return row;
  }

  return { subscribe, confirm, unsubscribe, recordBounce, queueMessage, sendPending, writeMetrics, subscriberFromUnsubToken, subscribeLimit: perHour };
}
