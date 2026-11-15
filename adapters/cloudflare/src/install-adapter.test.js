// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cloudflareInstallAdapter } from '../install-adapter.js';
import { install, sha256 } from '../../../core/install/index.js';

/** A fake of the platform API: databases, scripts with bindings, and a log of every request body. */
function platform() {
  const p = { dbs: [], scripts: new Map(), sql: [], log: [], bodies: [] };
  p.fetch = async (url, init = {}) => {
    const u = new URL(url), path = u.pathname.replace('/client/v4/accounts/acct', ''), method = init.method || 'GET';
    p.log.push(method + ' ' + path);
    if (typeof init.body === 'string') p.bodies.push(init.body);
    const ok = (result, status = 200) => new Response(JSON.stringify({ success: true, result }), { status });
    if (init.headers.authorization !== 'Bearer platform-token-value') return new Response('{}', { status: 403 });
    let m;
    if (path === '/d1/database' && method === 'GET') return ok(p.dbs.filter(d => d.name === u.searchParams.get('name')));
    if (path === '/d1/database' && method === 'POST') { const d = { name: JSON.parse(init.body).name, uuid: 'db-' + (p.dbs.length + 1) }; p.dbs.push(d); return ok(d); }
    if ((m = /^\/d1\/database\/([\w-]+)\/query$/.exec(path))) { p.sql.push(JSON.parse(init.body).sql); return ok([]); }
    if ((m = /^\/workers\/scripts\/([\w-]+)\/settings$/.exec(path))) return p.scripts.has(m[1]) ? ok({ bindings: p.scripts.get(m[1]).bindings }) : new Response('{}', { status: 404 });
    if ((m = /^\/workers\/scripts\/([\w-]+)\/secrets$/.exec(path))) { const b = JSON.parse(init.body); p.scripts.get(m[1]).bindings.push({ type: 'secret_text', name: b.name }); p.scripts.get(m[1]).secretValues.push(b.text); return ok({}); }
    if ((m = /^\/workers\/scripts\/([\w-]+)$/.exec(path)) && method === 'PUT') {
      const meta = JSON.parse(await init.body.get('metadata').text()), code = await init.body.get('worker.mjs').text(), prev = p.scripts.get(m[1]);
      const kept = prev ? prev.bindings.filter(b => b.type === 'secret_text' && !meta.bindings.some(x => x.name === b.name)) : [];
      p.scripts.set(m[1], { code, meta, bindings: [...meta.bindings.map(b => (b.type === 'secret_text' ? { type: b.type, name: b.name } : b)), ...kept],
        secretValues: [...(prev?.secretValues || []), ...meta.bindings.filter(b => b.type === 'secret_text').map(b => b.text)] });
      return ok({});
    }
    return new Response('{}', { status: 404 });
  };
  return p;
}
const ENV = { CLOUDFLARE_API_TOKEN: 'platform-token-value', CODE_HOST_TOKEN: 'connector-secret-value' };
const mk = (p, env = ENV) => cloudflareInstallAdapter({ fetch: p.fetch, config: { accountId: 'acct' }, env });

test('US-SPEC-10 s7 provision creates one database per slug, reuses a same-named one and applies the bundle migrations', async () => {
  const p = platform(), a = mk(p);
  assert.equal(await a.provisioned('tool-share'), false);
  await a.provision('tool-share', { migrations: 'CREATE TABLE IF NOT EXISTS t (a);' });
  assert.equal(await a.provisioned('tool-share'), true);
  await a.provision('tool-share', { migrations: 'CREATE TABLE IF NOT EXISTS t (a);' });
  assert.deepEqual(p.dbs.map(d => d.name), ['ultrastable-tool-share'], 'the second run reuses the database');
  assert.equal(p.sql.length, 2);
  assert.equal(await a.provisioned('other'), false, 'another slug has its own database');
});

test('the full install through the adapter: the digest that runs is read back from the Worker, and a re-run changes nothing', async () => {
  const p = platform(), a = mk(p); let ticked = false;
  const bundle = 'export default {}', migrations = 'CREATE TABLE IF NOT EXISTS t (a);';
  const manifestText = JSON.stringify({ version: '1.0.0', bundle_sha256: await sha256(bundle), migrations_sha256: await sha256(migrations) });
  const state = { boot: false, tenant: null };
  const ports = { fetchBundle: async () => ({ bundle, migrations, manifestText }), bootstrapped: async () => state.boot, bootstrap: async () => { state.boot = true; }, env: ENV, adapter: a,
    health: async () => (p.scripts.has('ultrastable-tool-share') ? (ticked ? 200 : 503) : 404), sleep: async () => { ticked = true; }, registered: async () => state.tenant, register: async t => { state.tenant = t; } };
  const r = await install({ slug: 'tool-share', runtime: 'workers' }, ports, { connectors: ['CODE_HOST_TOKEN'] });
  assert.equal(r.exit_code, 0, JSON.stringify(r.steps));
  const s = p.scripts.get('ultrastable-tool-share');
  assert.equal(s.code, bundle);
  assert.deepEqual(await a.liveVersion('tool-share'), { version: '1.0.0', sha256: await sha256(bundle) });
  assert.deepEqual(await a.boundSecrets('tool-share'), ['CODE_HOST_TOKEN']);
  assert.deepEqual(s.meta.migrations, { new_tag: 'v1', new_sqlite_classes: ['Heartbeat'] });
  const before = p.log.filter(l => !l.startsWith('GET')).length;
  const again = await install({ slug: 'tool-share', runtime: 'workers' }, ports, { connectors: ['CODE_HOST_TOKEN'] });
  assert.ok(again.steps.slice(2).every(x => x.status === 'skipped'), JSON.stringify(again.steps));
  assert.equal(p.log.filter(l => !l.startsWith('GET')).length, before, 'the re-run only reads');
  const out = JSON.stringify([r, again]) + p.log.join('\n');
  assert.doesNotMatch(out, /platform-token-value|connector-secret-value/, 'no credential value in results or request paths');
});

test('an upgrade keeps the secret bindings and declares no second Durable Object migration; a secret binds directly once the Worker exists', async () => {
  const p = platform(), a = mk(p), m = v => ({ version: v, bundle_sha256: 'a'.repeat(64) });
  await a.provision('ts', { migrations: '' });
  await a.bindSecret('ts', 'CODE_HOST_TOKEN');
  await a.deploy('ts', { bundle: 'v1', manifest: m('1.0.0') });
  await a.deploy('ts', { bundle: 'v2', manifest: m('1.1.0') });
  const s = p.scripts.get('ultrastable-ts');
  assert.equal(s.meta.migrations, undefined);
  assert.deepEqual(s.meta.keep_bindings, ['secret_text']);
  assert.deepEqual(await a.boundSecrets('ts'), ['CODE_HOST_TOKEN']);
  await a.bindSecret('ts', 'CLOUDFLARE_API_TOKEN');
  assert.deepEqual((await a.boundSecrets('ts')).sort(), ['CLOUDFLARE_API_TOKEN', 'CODE_HOST_TOKEN']);
  await assert.rejects(a.bindSecret('ts', 'NOT_SET'), /NOT_SET is not present/);
});

test('errors name the step and the status, never the token; a missing token and a deploy without a database are refused', async () => {
  const p = platform();
  await assert.rejects(mk(p, { CLOUDFLARE_API_TOKEN: 'wrong-token-value' }).provisioned('ts'), e => /list databases failed with status 403/.test(e.message) && !e.message.includes('wrong-token-value'));
  await assert.rejects(mk(p, {}).provisioned('ts'), /token is not present/);
  await assert.rejects(mk(p).deploy('ts', { bundle: 'x', manifest: { version: '1', bundle_sha256: 'b'.repeat(64) } }), /provision first/);
});
