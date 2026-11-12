// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// The console's Connect screen back end (issue #88, epic #84): paste a provider key or token once, it is stored through the
// vault (a Worker-side secret store), and the screen only ever shows presence. A value is never returned, echoed or logged.

/** Connections always offered. Names must also be on the vault allowlist. */
export const CONNECTIONS = [
  { name: 'ANTHROPIC_API_KEY', label: 'Add a model key', help: 'This lets the system ask a language model to write and review work. You get the key from the account page of your model provider, under API keys. Paste it here once; it is kept private and never shown again.' },
  { name: 'VCS_TOKEN', label: 'Add GitHub access', help: 'This lets the system open draft pull requests on your code host. Create a fine-grained access token limited to your repositories, with permission to read and write contents and pull requests, then paste it here once. It is never shown again.' },
];

/** Extra connections implied by the router configuration: every paid provider names the secret it needs (key_env). */
export function routerConnections(config = {}) {
  const out = [];
  for (const [id, p] of Object.entries(config?.providers || {})) {
    if (!p?.key_env || p.kind === 'workers_ai') continue;
    out.push({ name: p.key_env, label: `Add the key for ${id}`, help: 'A key from your model provider account. Paste it here once; it is kept private and never shown again.' });
  }
  return out;
}

/** The list the Connect screen draws. Presence, source and time only; never a value. */
export async function listConnections(vault, envNames = {}, { router } = {}) {
  if (!vault) return [];
  const rows = Object.fromEntries((await vault.names()).map(r => [r.name, r]));
  const allowed = vault.allowed();
  const seen = new Set();
  const out = [];
  for (const c of [...CONNECTIONS, ...routerConnections(router)]) {
    if (seen.has(c.name) || !allowed.includes(c.name)) continue;
    seen.add(c.name);
    const row = rows[c.name];
    out.push({ name: c.name, label: c.label, help: c.help, present: Boolean(row || envNames[c.name]), source: row ? 'console' : envNames[c.name] ? 'environment' : null, set_at: row?.set_at || null });
  }
  return out;
}

/** Save a pasted value. The reply never contains it, and an error never echoes it. */
export async function saveSecret(vault, body = {}) {
  if (!vault) return { status: 503, body: { error: 'secrets cannot be stored here' } };
  const name = String(body.name || '');
  const out = await vault.put(name, body.value, { by: 'console' });
  return out.error ? { status: 400, body: { error: out.error } } : { status: 200, body: { name: out.name, stored: true } };
}

/** Disconnect: forget a value that was pasted in the console. An environment secret cannot be removed from here. */
export async function removeSecret(vault, body = {}) {
  if (!vault) return { status: 503, body: { error: 'secrets cannot be stored here' } };
  const name = String(body.name || '');
  if (!vault.allowed().includes(name)) return { status: 400, body: { error: 'name not allowed' } };
  if (!(await vault.has(name))) return { status: 404, body: { error: 'nothing stored under that name' } };
  await vault.remove(name);
  return { status: 200, body: { name, removed: true } };
}
