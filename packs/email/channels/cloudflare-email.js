// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// emailChannel over the Cloudflare email-sending HTTP API. fetch is injected; the account id, sender address and token come from config/env.
// config: { accountId, from, apiBase? }; env: { EMAIL_PROVIDER_TOKEN } (used only as a bearer header, never logged or stored).
export function cloudflareEmail({ fetch: doFetch, config = {}, env = {} }) {
  if (typeof doFetch !== 'function') throw new Error('fetch must be injected');
  if (!config.accountId) throw new Error('config.accountId is required');
  if (!config.from) throw new Error('config.from (sender address) is required');
  const apiBase = String(config.apiBase || 'https://api.cloudflare.com/client/v4').replace(/\/+$/, '');
  return {
    async deliver({ to, subject, text, html, headers }) {
      const token = env.EMAIL_PROVIDER_TOKEN;
      if (!token) throw new Error('EMAIL_PROVIDER_TOKEN is not set');
      const res = await doFetch(`${apiBase}/accounts/${encodeURIComponent(config.accountId)}/email/sending/send`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from: config.from, to, subject, text, ...(html ? { html } : {}), ...(headers && Object.keys(headers).length ? { headers } : {}) }),
      });
      let body = null;
      try { body = await res.json(); } catch { /* non-JSON error page */ }
      if (!res.ok || (body && body.success === false)) {
        const msg = body && Array.isArray(body.errors) && body.errors[0] ? body.errors[0].message : '';
        throw new Error(`provider status ${res.status}${msg ? `: ${String(msg).slice(0, 100)}` : ''}`);   // never echo the request
      }
      const r = (body && body.result) || {};
      return { providerId: String(r.message_id ?? r.id ?? (r.delivered && r.delivered[0]) ?? '') || null };
    },
  };
}
