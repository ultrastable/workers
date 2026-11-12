// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// The class D route (US-SPEC-21 class D, US-SPEC-07 section 4): the port the pack guard calls for a class D pack instead of a channel.
// Pass it to createPacks({ deployRoute }). The pack never holds it and cannot name it in a request; the guard picks it from the pack's class.
//   deploys: { <provider>: createDeploy(...) }       the canonical change path: lock, version check, ledger, probes, revert
//   plan(req) -> { provider, unit, artifact, expectedVersion }   host-owned: turns an approved guard request into a deploy call
//   allow(pack, unit) -> boolean                      optional: units this pack may touch (default: any unit plan() returns)
// send() resolves only when core/deploy KEPT the change; any other outcome throws, so the guard records a refusal, not a send.
export function createPacksRoute({ deploys, plan, allow = null, maxLength = 2000 }) {
  if (!deploys || typeof plan !== 'function') throw new Error('createPacksRoute needs deploys and plan');
  return {
    maxLength,
    async send(req) {
      const p = await plan(req);
      if (!p || !p.unit || !p.artifact) throw new Error('deploy_plan_missing');
      if (allow && !(await allow(req.pack, p.unit))) throw new Error(`unit_not_allowed: ${p.unit}`);
      const deploy = deploys[p.provider];
      if (!deploy || typeof deploy.deploy !== 'function') throw new Error(`no deploy path for provider ${p.provider}`);
      const res = await deploy.deploy({ unit: p.unit, artifact: p.artifact, expectedVersion: p.expectedVersion, actor: `pack:${req.pack}` });
      if (res.status !== 'kept') throw new Error(`deploy_${res.status}: ${String(res.reason ?? '').slice(0, 80)}`);
      return { id: String(res.id) };
    },
  };
}
