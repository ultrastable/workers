// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Fetch-style HTTP surface: POST /subscribe, GET /confirm?t=, GET and POST /unsubscribe (one-click header compatible).
// ctx: { email } where email is createEmail(...). Rate limiting is the service's hourly subscribe limit plus the guard's caps.
const page = (status, title, body) => new Response(
  `<!doctype html><meta charset="utf-8"><title>${title}</title><p>${body}</p>`,
  { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

function sameOrigin(request, baseUrl) {
  const origin = request.headers.get('origin');
  if (!origin) return request.headers.get('sec-fetch-site') === 'same-origin';
  try { return new URL(origin).origin === new URL(baseUrl).origin; } catch { return false; }
}
async function fields(request) {
  const type = request.headers.get('content-type') || '';
  try {
    if (type.includes('application/json')) return await request.json();
    const f = await request.formData();
    return Object.fromEntries([...f.entries()].map(([k, v]) => [k, String(v)]));
  } catch { return {}; }
}

export async function handle(request, ctx) {
  const email = ctx.email;
  const url = new URL(request.url);
  const { pathname } = url;
  try {
    if (pathname === '/subscribe' && request.method === 'POST') {
      if (!sameOrigin(request, ctx.baseUrl)) return json(403, { ok: false, error: 'cross_origin' });
      const body = await fields(request);
      const r = await email.subscribe({ email: body.email, source: body.source });
      if (r.reason === 'invalid_address') return json(400, { ok: false, error: 'invalid_address' });
      if (r.reason === 'rate_limited') return new Response(JSON.stringify({ ok: false, error: 'rate_limited' }), { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '3600' } });
      return json(202, { ok: true });                    // same answer whether or not the address was known
    }
    if (pathname === '/confirm' && request.method === 'GET') {
      const r = await email.confirm(url.searchParams.get('t') || url.searchParams.get('token'));
      return r.ok ? page(200, 'Subscribed', 'Your subscription is confirmed.') : page(400, 'Link not valid', 'This confirmation link is not valid or was already used.');
    }
    if (pathname === '/unsubscribe' && (request.method === 'GET' || request.method === 'POST')) {
      const r = await email.unsubscribe({ token: url.searchParams.get('u') });
      if (request.method === 'POST') return json(r.ok ? 200 : 400, { ok: r.ok });
      return r.ok ? page(200, 'Unsubscribed', 'You are unsubscribed and will receive no more mail.') : page(400, 'Link not valid', 'This unsubscribe link is not valid.');
    }
    return json(404, { ok: false, error: 'not_found' });
  } catch {
    return json(500, { ok: false, error: 'server_error' });   // no detail: errors must not carry addresses
  }
}
