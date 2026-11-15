// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// The adapter port of core/install over the public Cloudflare HTTP API, through an injected fetch (US-SPEC-10 s7).
// config: { accountId, prefix?, apiBase?, tokenEnv?, compatibilityDate?, tickMode? }. Tenant level 2: one database and
// one Worker per slug. The API token and every connector value are read from env by name at call time, sent only to the
// platform as a secret binding, and never stored, returned or put in an error.
export function cloudflareInstallAdapter({ fetch, config, env }) {
  const base = config.apiBase || 'https://api.cloudflare.com/client/v4', A = `${base}/accounts/${config.accountId}`;
  const name = slug => `${config.prefix || 'ultrastable'}-${slug}`;
  const pending = new Map(); // slug -> Set of secret names to bind with the first upload (a secret needs an existing script)
  async function call(step, url, init = {}, { allow404 = false } = {}) {
    const t = env[config.tokenEnv || 'CLOUDFLARE_API_TOKEN'];
    if (!t) throw new Error('install adapter: platform token is not present in env');
    const res = await fetch(url, { ...init, headers: { authorization: 'Bearer ' + t, ...(init.headers || {}) } });
    if (res.status === 404 && allow404) return null;
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.success === false) throw new Error(`install adapter: ${step} failed with status ${res.status}`);
    return body;
  }
  const json = { 'content-type': 'application/json' };
  const database = async slug => ((await call('list databases', `${A}/d1/database?name=${encodeURIComponent(name(slug))}`)).result || []).find(d => d.name === name(slug)) || null;
  const settings = slug => call('read worker', `${A}/workers/scripts/${name(slug)}/settings`, {}, { allow404: true });
  const plain = (s, key) => ((s?.result?.bindings) || []).find(b => b.type === 'plain_text' && b.name === key)?.text || null;
  return {
    resourceName: name,
    async provisioned(slug) { return !!(await database(slug)); },
    /** Reuse a same-named database or create one, then apply the bundle's migrations (every statement is IF NOT EXISTS). */
    async provision(slug, { migrations }) {
      let db = await database(slug);
      if (!db) db = (await call('create database', `${A}/d1/database`, { method: 'POST', headers: json, body: JSON.stringify({ name: name(slug) }) })).result;
      const id = db.uuid || db.id;
      if (!id) throw new Error('install adapter: the platform returned no database id');
      await call('apply migrations', `${A}/d1/database/${id}/query`, { method: 'POST', headers: json, body: JSON.stringify({ sql: migrations }) });
      return { detail: `database ${name(slug)}` };
    },
    async boundSecrets(slug) {
      const s = await settings(slug);
      const live = ((s?.result?.bindings) || []).filter(b => b.type === 'secret_text').map(b => b.name);
      return [...new Set([...live, ...(pending.get(slug) || [])])];
    },
    async bindSecret(slug, secretName) {
      if (!env[secretName]) throw new Error(`install adapter: ${secretName} is not present in env`);
      if (!(await settings(slug))) { if (!pending.has(slug)) pending.set(slug, new Set()); pending.get(slug).add(secretName); return { detail: 'bound with the first upload' }; }
      await call('bind secret', `${A}/workers/scripts/${name(slug)}/secrets`, { method: 'PUT', headers: json, body: JSON.stringify({ name: secretName, text: env[secretName], type: 'secret_text' }) });
      return {};
    },
    async liveVersion(slug) {
      const s = await settings(slug);
      return s ? { version: plain(s, 'BUNDLE_VERSION'), sha256: plain(s, 'BUNDLE_SHA256') } : null;
    },
    /** Upload the verified bundle. Its digest is a binding of the Worker, so `liveVersion` reads what actually runs. */
    async deploy(slug, { bundle, manifest }) {
      const db = await database(slug);
      if (!db) throw new Error('install adapter: no database to bind; provision first');
      const bindings = [
        { type: 'd1', name: 'DB', id: db.uuid || db.id },
        { type: 'plain_text', name: 'ORG_SLUG', text: slug },
        { type: 'plain_text', name: 'BUNDLE_VERSION', text: String(manifest.version) },
        { type: 'plain_text', name: 'BUNDLE_SHA256', text: manifest.bundle_sha256 },
        { type: 'durable_object_namespace', name: 'HEARTBEAT', class_name: 'Heartbeat' },
        ...[...(pending.get(slug) || [])].map(n => ({ type: 'secret_text', name: n, text: env[n] })),
      ];
      const first = !(await settings(slug));
      const metadata = { main_module: 'worker.mjs', compatibility_date: config.compatibilityDate || '2026-01-01', bindings, keep_bindings: ['secret_text'],
        ...(first ? { migrations: { new_tag: 'v1', new_sqlite_classes: ['Heartbeat'] } } : {}) };
      const form = new FormData();
      form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }), 'metadata.json');
      form.append('worker.mjs', new Blob([bundle], { type: 'application/javascript+module' }), 'worker.mjs');
      await call('upload worker', `${A}/workers/scripts/${name(slug)}`, { method: 'PUT', body: form });
      pending.delete(slug);
      return { detail: `worker ${name(slug)} at ${manifest.version}` };
    },
  };
}
