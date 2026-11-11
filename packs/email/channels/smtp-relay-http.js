// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// A generic emailChannel for any provider that accepts one JSON POST per message over HTTPS (relay style).
// config: { endpoint, from, authHeader? ('authorization'), authScheme? ('Bearer'), idField? ('id') }; env: { EMAIL_PROVIDER_TOKEN }.
export function smtpRelayHttp({ fetch: doFetch, config = {}, env = {} }) {
  if (typeof doFetch !== 'function') throw new Error('fetch must be injected');
  if (!/^https:\/\//.test(String(config.endpoint || ''))) throw new Error('config.endpoint must be an https URL');
  if (!config.from) throw new Error('config.from (sender address) is required');
  const authHeader = config.authHeader || 'authorization';
  const scheme = config.authScheme === undefined ? 'Bearer' : config.authScheme;
  const idField = config.idField || 'id';
  return {
    async deliver({ to, subject, text, html, headers }) {
      const token = env.EMAIL_PROVIDER_TOKEN;
      if (!token) throw new Error('EMAIL_PROVIDER_TOKEN is not set');
      const res = await doFetch(config.endpoint, {
        method: 'POST',
        headers: { [authHeader]: scheme ? `${scheme} ${token}` : token, 'content-type': 'application/json' },
        body: JSON.stringify({ from: config.from, to: [to], subject, text, ...(html ? { html } : {}), headers: headers || {} }),
      });
      if (!res.ok) throw new Error(`relay status ${res.status}`);
      let body = null;
      try { body = await res.json(); } catch { /* some relays return an empty body */ }
      return { providerId: body && body[idField] != null ? String(body[idField]) : null };
    },
  };
}
