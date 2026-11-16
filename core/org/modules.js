// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// The ordered module list: data, no file-system access, so a Worker can import it. Order is dependency order
// (each module may read tables of the ones before it). tools/build_migrations.mjs turns this list into the one
// ordered migrations directory the Worker applies. `deploy` is not listed: nothing here starts it.
export const MODULES = [
  { id: 'core', dir: 'core/migrations' },
  { id: 'claims', dir: 'core/claims/migrations' },
  { id: 'router', dir: 'core/router/migrations' },
  { id: 'kernel', dir: 'core/kernel/migrations' },
  { id: 'runner', dir: 'core/runner/migrations' },
  { id: 'describe', dir: 'core/describe/migrations' },
  { id: 'packs', dir: 'core/packs/migrations' },
  { id: 'vault', dir: 'core/vault/migrations' },
  { id: 'yield', dir: 'core/yield/migrations' },
  { id: 'docgate', dir: 'core/docgate/migrations' },
  { id: 'codeloop', dir: 'core/codeloop/migrations' },
  { id: 'graph', dir: 'core/graph/migrations' },
  { id: 'tasks', dir: 'core/tasks/migrations' },
  { id: 'steward', dir: 'adapters/github/migrations' },
  { id: 'agents', dir: 'adapters/cloudflare/agents/migrations' },
  { id: 'doors', dir: 'core/doors/migrations' }, // last, so earlier migration numbers never shift
  { id: 'elicit', dir: 'core/elicit/migrations' },
  { id: 'console_l3', dir: 'core/console-l3/migrations' },
  // The steward and agents tables the adapter directories above lack (steward_runs, agents_approvals), then the two modules
  // nothing started before. Appended last so earlier migration numbers never shift; every statement is IF NOT EXISTS.
  { id: 'stewardruns', dir: 'core/steward/migrations' },
  { id: 'agentsapprovals', dir: 'core/agents/migrations' },
  { id: 'containers', dir: 'core/containers/migrations' },
  { id: 'infra', dir: 'core/infra/migrations' },
  { id: 'waste', dir: 'core/waste/migrations' },
  { id: 'specloop', dir: 'core/specloop/migrations' },
  { id: 'criticality', dir: 'core/criticality/migrations' },
  { id: 'staff', dir: 'core/staff/migrations' },
  { id: 'plus', dir: 'core/plus/migrations' },
  { id: 'lifecyclegates', dir: 'core/lifecycle-gates/migrations' },
  { id: 'fleet', dir: 'core/fleet/migrations' },
  { id: 'signals', dir: 'core/signals/migrations' },
  { id: 'remediation', dir: 'core/remediation/migrations' },
  { id: 'ghcost', dir: 'core/ghcost/migrations' },
  { id: 'tenancy', dir: 'core/tenancy/migrations' },
  { id: 'predict', dir: 'core/predict/migrations' },
  { id: 'trust', dir: 'core/trust/migrations' },
  { id: 'governance', dir: 'core/governance/migrations' },
  { id: 'ladder', dir: 'core/ladder/migrations' },
  { id: 'export', dir: 'core/export/migrations' },
  { id: 'sla', dir: 'core/sla/migrations' },
  { id: 'modelport', dir: 'core/modelport/migrations' },
  { id: 'walkthrough', dir: 'core/walkthrough/migrations' },
  { id: 'sharedslots', dir: 'adapters/shared/migrations' },
  { id: 'outreach', dir: 'core/outreach/migrations' },
];

// config.pack_migrations: ['<pack id>', ...] adds packs/<id>/migrations after the core modules, in the order given.
export function moduleList(config = {}) {
  const extra = (config.pack_migrations || []).map(id => ({ id: `pack_${String(id).replace(/[^A-Za-z0-9]/g, '')}`, dir: `packs/${id}/migrations` }));
  return [...MODULES, ...extra];
}
