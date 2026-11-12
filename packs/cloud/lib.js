// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Settings and the request entry point for the cloud pack. Settings come from host configuration (config.packs.cloud).
import { first, run, iso, ensureItem } from '../../core/kernel/util.js';

export const ROLE = 'pack-manager-cloud';
export const PROJECT = 'pack-cloud';
export const CHANNEL = 'cloud';
export const fileItem = (db, id, title, done_check) => ensureItem(db, { id, title, owner_role: ROLE, done_check, priority: 0, project: PROJECT });

export function cfg(settings = {}) {
  return { providers: ['cloudflare', 'gcp'], units: [], max_backlog: 10, ...settings, deploys: settings.deploys || settings.ports?.deploys || {}, artifacts: settings.artifacts || settings.ports?.artifacts };
}

// units: [{ provider, unit }] allowed to be deployed; an unlisted unit is refused (scope: only the configured list).
export async function requestDeploy({ db, now = Date.now, settings = {}, provider, unit, version, expectedVersion, artifactSha256 = null, by }) {
  const s = cfg(settings);
  const refuse = reason => ({ queued: false, reason });
  if (!String(by ?? '').trim()) return refuse('requested_by_required');
  if (!s.providers.includes(provider)) return refuse('provider_not_configured');
  if (!/^[a-z0-9][a-z0-9._-]{0,62}$/i.test(String(unit ?? ''))) return refuse('unit_name_invalid');
  if (!s.units.some(u => u.provider === provider && u.unit === unit)) return refuse('unit_not_listed');
  if (!/^[A-Za-z0-9._+-]{1,64}$/.test(String(version ?? ''))) return refuse('version_invalid');
  if (!String(expectedVersion ?? '').trim()) return refuse('expected_version_required');   // core/deploy refuses a stale or missing live version
  const idem = `cloud:${provider}:${unit}:${version}`;
  if (await first(db, `SELECT 1 AS x FROM cloud_requests WHERE idem_key = ?`, idem)) return { queued: false, duplicate: true };
  if ((await first(db, `SELECT COUNT(*) AS n FROM cloud_requests WHERE status IN ('queued','awaiting_approval')`)).n >= s.max_backlog) return refuse('backlog_full');
  const r = await run(db, `INSERT INTO cloud_requests (idem_key, provider, unit, version, expected_version, artifact_sha256, requested_by, created_at) VALUES (?,?,?,?,?,?,?,?)`,
    idem, provider, unit, version, expectedVersion, artifactSha256, String(by), iso(now()));
  return { queued: true, id: r.meta.last_row_id };
}
