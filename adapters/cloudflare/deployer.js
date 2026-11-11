// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Deployer port over the public Cloudflare Workers HTTP API, through an injected fetch. No network at import time.
// config: { accountId, scripts?: {unit: scriptName}, apiBase?, tokenEnv? }. The token is read from env at call time and never stored or logged.
export function cloudflareDeployer({ fetch, config, env }) {
  const base = config.apiBase || 'https://api.cloudflare.com/client/v4';
  const name = (unit) => (config.scripts && config.scripts[unit]) || unit;
  const url = (unit, tail = '') => `${base}/accounts/${config.accountId}/workers/scripts/${encodeURIComponent(name(unit))}${tail}`;
  async function call(u, init) {
    const t = env[config.tokenEnv || 'CLOUDFLARE_API_TOKEN'];
    if (!t) throw new Error('deployer token not present in env');
    const res = await fetch(u, { ...init, headers: { authorization: 'Bearer ' + t, ...(init.headers || {}) } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.success === false) throw new Error(`workers api ${init.method} failed: status ${res.status}`);
    return body;
  }
  async function liveVersion(unit) {
    const body = await call(url(unit, '/deployments'), { method: 'GET' });
    const d = ((body.result && body.result.deployments) || [])[0];
    const v = d && d.versions && d.versions[0];
    return v ? v.version_id : null;
  }
  return {
    liveVersion,
    async publish(unit, artifact) {
      const form = new FormData();
      form.append('metadata', new Blob([JSON.stringify({ main_module: 'worker.js', compatibility_date: artifact.compatibilityDate || '2026-01-01' })], { type: 'application/json' }));
      form.append('worker.js', new Blob([artifact.body], { type: 'application/javascript+module' }), 'worker.js');
      await call(url(unit), { method: 'PUT', body: form });
      return { version: await liveVersion(unit) };
    },
    async rollback(unit, toVersion) {
      await call(url(unit, '/deployments'), { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ strategy: 'percentage', versions: [{ version_id: toVersion, percentage: 100 }] }) });
    },
  };
}
