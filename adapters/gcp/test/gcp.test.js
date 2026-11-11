// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../sqlite/d1-sqlite.js';
import { createServer, loadConfig } from '../server.js';

import { fileURLToPath } from 'node:url';
const MIG = fileURLToPath(new URL('../../../worker/migrations', import.meta.url));

async function boot(env) {
  const db = openDb(':memory:', MIG);
  db.raw.exec(`INSERT INTO roles (id, role, tick_every, model) VALUES ('staff-1','staff',1,'m');
    INSERT INTO items (id,title,owner_role,done_check,priority,status) VALUES ('A','a','staff','x',10,'open');`);
  const srv = createServer({ db, config: loadConfig({}), env });
  await new Promise(r => srv.listen(0, r));
  return { db, srv, base: `http://127.0.0.1:${srv.address().port}` };
}

test('Cloud Run adapter: unauthenticated /tick is refused, authenticated /tick runs every step', async () => {
  const { srv, base, db } = await boot({ TICK_TOKEN: 's3cret' });
  assert.equal((await fetch(`${base}/tick`, { method: 'POST' })).status, 401);
  assert.equal((await fetch(`${base}/health`)).status, 503); // no tick yet
  const r = await fetch(`${base}/tick`, { method: 'POST', headers: { 'x-tick-token': 's3cret' } });
  const body = await r.json();
  assert.equal(r.status, 200);
  assert.equal(body.completed, body.total);
  assert.equal((await fetch(`${base}/health`)).status, 200);
  srv.close(); db.close();
});

test('no TICK_TOKEN configured: /tick refuses everyone', async () => {
  const { srv, base, db } = await boot({});
  assert.equal((await fetch(`${base}/tick`, { method: 'POST', headers: { 'x-tick-token': '' } })).status, 401);
  srv.close(); db.close();
});
