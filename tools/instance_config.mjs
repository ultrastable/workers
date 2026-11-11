// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Instance config loader for the cutover: every tenant-specific value (names, account id, routes, model ladder, owner contact,
// secret BINDING NAMES) lives in one instance file outside the shared code. Two routes to the same file: --file path, or the
// ULTRASTABLE_INSTANCE_JSON env var (inline JSON). Secret values are never read: only binding names, and a value-looking
// string in a secret slot is rejected. Usage: node tools/instance_config.mjs [--file instance.json] [--strict]
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REQUIRED = ['slug', 'account_id', 'worker_name', 'd1_database', 'routes', 'owner_contact', 'repository', 'secrets'];
const BINDING = /^[A-Z][A-Z0-9_]{2,63}$/;

const PLACEHOLDER = /REPLACE|\.invalid\b|^owner\/repo$/;

// strict: also reject placeholder values, so a template fails the closing probe until the real values are filled in.
export function validateInstance(cfg, { strict = false } = {}) {
  const errors = [];
  if (!cfg || typeof cfg !== 'object') return ['instance config is not an object'];
  for (const k of REQUIRED) if (cfg[k] === undefined || cfg[k] === '') errors.push('missing ' + k);
  if (cfg.slug && !/^[a-z][a-z0-9-]{1,30}$/.test(cfg.slug)) errors.push('slug must be lowercase letters, digits, hyphens');
  if (cfg.routes && !(Array.isArray(cfg.routes) && cfg.routes.length >= 1)) errors.push('routes must list at least one route');
  if (cfg.routes && Array.isArray(cfg.routes) && cfg.routes.length < 2) errors.push('no single route: routes needs a second entry (stage fallback)');
  for (const [name, binding] of Object.entries(cfg.secrets || {})) if (!BINDING.test(String(binding))) errors.push('secret ' + name + ' must be a binding name (UPPER_SNAKE), never a value');
  if (strict) for (const [k, v] of Object.entries(cfg)) if (PLACEHOLDER.test(typeof v === "string" ? v : JSON.stringify(v))) errors.push('placeholder value in ' + k);
  return errors;
}

export function loadInstance({ file, env = process.env, read = readFileSync, strict = false } = {}) {
  const tried = [];
  for (const [label, get] of [['file', () => file && read(file, 'utf8')], ['env', () => env.ULTRASTABLE_INSTANCE_JSON]]) {
    try {
      const raw = get();
      if (!raw) { tried.push(label + ': not provided'); continue; }
      const cfg = JSON.parse(raw);
      const errors = validateInstance(cfg, { strict });
      if (errors.length) { tried.push(label + ': ' + errors.join('; ')); continue; }
      return { ok: true, via: label, config: cfg, tried };
    } catch (e) { tried.push(label + ': ' + String(e.message).slice(0, 120)); }
  }
  return { ok: false, tried };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--file');
  const r = loadInstance({ file: i > 0 ? process.argv[i + 1] : null, strict: process.argv.includes('--strict') });
  console.log(JSON.stringify({ ok: r.ok, via: r.via, tried: r.tried }));
  process.exit(r.ok ? 0 : 1);
}
