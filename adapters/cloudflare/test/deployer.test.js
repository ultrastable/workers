// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cloudflareDeployer } from '../deployer.js';

function fake() {
  const calls = [];
  const state = { version: 'ver-1' };
  const fetch = async (url, init) => {
    calls.push({ url, method: init.method, auth: init.headers.authorization, body: init.body });
    if (init.method === 'PUT') { state.version = 'ver-2'; return Response.json({ success: true, result: {} }); }
    if (init.method === 'POST') { state.version = JSON.parse(init.body).versions[0].version_id; return Response.json({ success: true, result: {} }); }
    return Response.json({ success: true, result: { deployments: [{ versions: [{ version_id: state.version, percentage: 100 }] }] } });
  };
  return { calls, fetch, state };
}
const config = { accountId: 'acct-123', scripts: { api: 'api-script' } };

test('cloudflare deployer: liveVersion, publish, rollback hit the Workers API with the right shapes', async () => {
  const f = fake();
  const dep = cloudflareDeployer({ fetch: f.fetch, config, env: { CLOUDFLARE_API_TOKEN: 'tkn-value' } });
  assert.equal(await dep.liveVersion('api'), 'ver-1');
  assert.equal(f.calls[0].url, 'https://api.cloudflare.com/client/v4/accounts/acct-123/workers/scripts/api-script/deployments');
  assert.equal(f.calls[0].auth, 'Bearer tkn-value');
  assert.deepEqual(await dep.publish('api', { body: 'export default {}' }), { version: 'ver-2' });
  const put = f.calls.find(c => c.method === 'PUT');
  assert.ok(put.url.endsWith('/workers/scripts/api-script'));
  assert.ok(put.body instanceof FormData && put.body.get('metadata') && put.body.get('worker.js'));
  await dep.rollback('api', 'ver-1');
  assert.equal(await dep.liveVersion('api'), 'ver-1');
});

test('cloudflare deployer: missing token and API errors throw without leaking the token', async () => {
  const f = fake();
  await assert.rejects(cloudflareDeployer({ fetch: f.fetch, config, env: {} }).liveVersion('api'), /token not present/);
  assert.equal(f.calls.length, 0);
  const bad = cloudflareDeployer({ fetch: async () => Response.json({ success: false }, { status: 403 }), config, env: { CLOUDFLARE_API_TOKEN: 'tkn-value' } });
  await assert.rejects(bad.liveVersion('api'), (e) => /403/.test(e.message) && !e.message.includes('tkn-value'));
});

test('cloudflare deployer plugs into the canonical path (probe failure reverts)', async () => {
  const { makeDb } = await import('../../../core/_shared/testdb.js');
  const { createDeploy } = await import('../../../core/deploy/index.js');
  const { fileURLToPath } = await import('node:url');
  const MIG = fileURLToPath(new URL('../../../core/deploy/migrations/', import.meta.url));
  const f = fake();
  const dep = cloudflareDeployer({ fetch: f.fetch, config, env: { CLOUDFLARE_API_TOKEN: 'tkn-value' } });
  const d = createDeploy({ db: makeDb([MIG]), deployer: dep, fetch: async () => new Response('down', { status: 500 }), sleep: async () => {},
    config: { windowMs: 0 }, probes: { api: [{ kind: 'http', url: 'https://svc.example/h' }] } });
  const r = await d.deploy({ unit: 'api', artifact: { body: 'x' }, expectedVersion: 'ver-1' });
  assert.equal(r.status, 'reverted');
  assert.equal(f.state.version, 'ver-1');
});
