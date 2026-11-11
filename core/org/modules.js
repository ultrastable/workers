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
  { id: 'yield', dir: 'core/yield/migrations' },
  { id: 'docgate', dir: 'core/docgate/migrations' },
  { id: 'codeloop', dir: 'core/codeloop/migrations' },
  { id: 'graph', dir: 'core/graph/migrations' },
  { id: 'tasks', dir: 'core/tasks/migrations' },
];

// config.pack_migrations: ['<pack id>', ...] adds packs/<id>/migrations after the core modules, in the order given.
export function moduleList(config = {}) {
  const extra = (config.pack_migrations || []).map(id => ({ id: `pack_${String(id).replace(/[^A-Za-z0-9]/g, '')}`, dir: `packs/${id}/migrations` }));
  return [...MODULES, ...extra];
}
