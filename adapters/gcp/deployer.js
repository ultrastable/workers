// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Deployer port skeleton over the Cloud Run Admin API v2, through an injected fetch. Not yet run against a real project.
// config: { project, region, services?: {unit: serviceName}, apiBase?, tokenEnv? }. artifact: { image }.
export function cloudRunDeployer({ fetch, config, env }) {
  const base = config.apiBase || 'https://run.googleapis.com/v2';
  const svc = (unit) => (config.services && config.services[unit]) || unit;
  const url = (unit) => `${base}/projects/${config.project}/locations/${config.region}/services/${encodeURIComponent(svc(unit))}`;
  async function call(u, init) {
    const t = env[config.tokenEnv || 'GCP_ACCESS_TOKEN'];
    if (!t) throw new Error('deployer token not present in env');
    const res = await fetch(u, { ...init, headers: { authorization: 'Bearer ' + t, 'content-type': 'application/json' } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`cloud run api ${init.method} failed: status ${res.status}`);
    return body;
  }
  const liveVersion = async (unit) => (await call(url(unit), { method: 'GET' })).latestReadyRevision ?? null;
  return {
    liveVersion,
    async publish(unit, artifact) {
      await call(url(unit), { method: 'PATCH', body: JSON.stringify({ template: { containers: [{ image: artifact.image }] } }) });
      return { version: await liveVersion(unit) };
    },
    async rollback(unit, toVersion) {
      await call(url(unit), { method: 'PATCH', body: JSON.stringify({ traffic: [{ type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION', revision: toVersion, percent: 100 }] }) });
    },
  };
}
