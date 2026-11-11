// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cloudRunDeployer } from '../deployer.js';

const config = { project: 'proj-1', region: 'region-1', services: { api: 'api-svc' } };

test('cloud run deployer: liveVersion, publish and rollback use the v2 Admin API', async () => {
  const calls = [];
  let rev = 'rev-1';
  const fetch = async (url, init) => {
    calls.push({ url, method: init.method, auth: init.headers.authorization, body: init.body && JSON.parse(init.body) });
    if (init.method === 'PATCH') {
      const b = JSON.parse(init.body);
      rev = b.traffic ? b.traffic[0].revision : 'rev-2';
      return Response.json({ name: 'operations/x' });
    }
    return Response.json({ latestReadyRevision: rev });
  };
  const dep = cloudRunDeployer({ fetch, config, env: { GCP_ACCESS_TOKEN: 'tkn-value' } });
  assert.equal(await dep.liveVersion('api'), 'rev-1');
  assert.equal(calls[0].url, 'https://run.googleapis.com/v2/projects/proj-1/locations/region-1/services/api-svc');
  assert.equal(calls[0].auth, 'Bearer tkn-value');
  assert.deepEqual(await dep.publish('api', { image: 'registry.example/app:2' }), { version: 'rev-2' });
  assert.equal(calls.find(c => c.method === 'PATCH').body.template.containers[0].image, 'registry.example/app:2');
  await dep.rollback('api', 'rev-1');
  assert.equal(await dep.liveVersion('api'), 'rev-1');
});

test('cloud run deployer: missing token and API errors throw without leaking the token', async () => {
  await assert.rejects(cloudRunDeployer({ fetch: async () => { throw new Error('unreachable'); }, config, env: {} }).liveVersion('api'), /token not present/);
  const bad = cloudRunDeployer({ fetch: async () => Response.json({}, { status: 500 }), config, env: { GCP_ACCESS_TOKEN: 'tkn-value' } });
  await assert.rejects(bad.liveVersion('api'), (e) => /500/.test(e.message) && !e.message.includes('tkn-value'));
});
