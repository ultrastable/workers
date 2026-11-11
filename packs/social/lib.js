// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Shared settings and small helpers for the social loops. Settings come from host configuration (config.packs.social).
import { ensureItem } from '../../core/kernel/util.js';

export const ROLE = 'pack-manager-social';
export const PROJECT = 'pack-social';
export const MARKER = /\s*\[claim:[A-Za-z0-9._-]+\]/g;
export const stripMarkers = s => String(s).replace(MARKER, '').replace(/[ \t]+\n/g, '\n').trim();

export function cfg(settings = {}) {
  const allowlist = settings.allowlist || [];
  return {
    handle: settings.handle || 'public', allowlist, link_url: settings.link_url || null,
    claim_prefixes: settings.claim_prefixes || null, repeat_days: 14, max_per_run: 1, max_sentences: 2, max_backlog: 5,
    max_length: 300, baseline_engagement: 1, verify_attempts: 3, verify_pending_hours: 48, score_after_hours: 24, voiceRules: {},
    ...settings,
    utm: { hosts: allowlist, params: { source: 'social', medium: 'post', campaign: 'claims' }, ...(settings.utm || {}) },
    ports: settings.ports || {},
  };
}

export const fileItem = (db, id, title, done_check) => ensureItem(db, { id, title, owner_role: ROLE, done_check, priority: 0, project: PROJECT });
