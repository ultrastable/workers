// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Shared settings and helpers for the video pack. Settings come from host configuration (config.packs.video).
import { ensureItem } from '../../core/kernel/util.js';

export const ROLE = 'pack-manager-video';
export const PROJECT = 'pack-video';

export function cfg(settings = {}) {
  return {
    handle: 'public', allowlist: [], max_seconds: 60, max_length: 4000, disclosure: 'AI-generated',
    verify_attempts: 3, verify_pending_hours: 48, max_backlog: 5, ...settings, ports: settings.ports || {},
  };
}

export async function sha256(s) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(s)));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
}

// Canonical provenance: the same fields always hash the same way, whatever the key order the caller used.
export function canonicalProvenance(assetSha256, p) {
  return JSON.stringify({
    asset_sha256: assetSha256, generator: p.generator, synthetic: p.synthetic === true,
    sources: [...(p.sources || [])].sort(), created_at: p.created_at,
  });
}
export const provenanceHash = (assetSha256, p) => sha256(canonicalProvenance(assetSha256, p));

export const fileItem = (db, id, title, done_check) => ensureItem(db, { id, title, owner_role: ROLE, done_check, priority: 0, project: PROJECT });
