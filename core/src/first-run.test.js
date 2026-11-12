// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// First-run door (issue #87, epic #84, US-SPEC-18/19).
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { makeDb } from '../_shared/testdb.js';
import { handleConsole } from './console.js';
import { firstRunDoor, doorStatus, accessConfigured, KEY_PAGE, FIRST_RUN } from './first-run.js';

const dir = p => fileURLToPath(new URL(p, import.meta.url));
const MIGS = [dir('../vault/migrations/'), dir('../doors/migrations/')];
const U = 'https://x.example';
const T0 = Date.parse('2026-11-11T00:00:00Z');
const newDb = (tick = true) => {
  const db = makeDb(MIGS);
  if (tick) db.raw.exec(`INSERT INTO tick_runs (started_at,finished_at,steps_completed,steps_total,report) VALUES ('2026-11-11T00:00:00Z','2026-11-11T00:00:01Z',1,1,'ok')`);
  return db;
};
const post = (path, origin = U) => new Request(U + path, { method: 'POST', headers: origin ? { origin } : {} });

test('accessConfigured needs both a team domain and an audience', () => {
  assert.equal(accessConfigured({ access: { team_domain: 't.example', aud: 'a' } }), true);
  assert.equal(accessConfigured({ access: { team_domain: 't.example' } }), false);
  assert.equal(accessConfigured(undefined), false);
});

test('the key page escapes its value and says it is shown once', async () => {
  const html = await KEY_PAGE('a"><script>x</script>').text();
  assert.ok(!html.includes('<script>x'));
  assert.match(html, /shown once/);
  assert.match(await FIRST_RUN().text(), /Create my key/);
});

test('door: open window serves the button, claims once with same-origin POST, then reports the hash', async () => {
  const db = newDb(); const env = { DB: db }; const o = { doors: {}, now: T0 + 60e3 };
  assert.match(await (await firstRunDoor(new Request(U + '/console'), env, o)).response.text(), /Create my key/);
  assert.equal((await firstRunDoor(post('/console/first-run', 'https://evil.example'), env, o)).response.status, 403);
  const claim = await firstRunDoor(post('/console/first-run'), env, o);
  assert.equal(claim.response.status, 200);
  assert.match(claim.response.headers.get('set-cookie'), /HttpOnly; Secure; SameSite=Strict/);
  const again = await firstRunDoor(new Request(U + '/console'), env, o);
  assert.match(again.issuedHash, /^[0-9a-f]{64}$/);
  assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM doors_first_run WHERE key_hash IS NOT NULL').get().n, 1);
});

test('door: api calls before setup get json 503; no doors config means off; no tick means starting', async () => {
  const db = newDb(); const env = { DB: db };
  const r = (await firstRunDoor(new Request(U + '/api/console'), env, { doors: {}, now: T0 + 1e3 })).response;
  assert.equal(r.status, 503); assert.equal((await r.json()).error, 'console not set up');
  assert.equal((await firstRunDoor(new Request(U + '/console'), env, { now: T0 })).response.status, 503);
  const fresh = newDb(false);
  assert.match(await (await firstRunDoor(new Request(U + '/console'), { DB: fresh }, { doors: {}, now: T0 })).response.text(), /Starting up/);
});

test('door: an unused window expires, files one card, and stays off', async () => {
  const db = newDb(); const env = { DB: db };
  const res = (await firstRunDoor(new Request(U + '/console'), env, { doors: { first_run_minutes: 5 }, now: T0 + 6 * 60e3 })).response;
  assert.equal(res.status, 503);
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM gate_cards WHERE id='doors-first-run-expired'").get().n, 1);
});

test('doorStatus reports presence only, never values', async () => {
  const db = newDb();
  const s = await doorStatus({ DB: db, CONSOLE_TOKEN: 'secret-value' }, { doors: { access: { team_domain: 't.example', aud: 'aud-secret' } }, now: T0 + 1e3 });
  assert.deepEqual(s, { token: true, access: true, first_run: 'open' });
  assert.ok(!JSON.stringify(s).includes('secret'));
  assert.equal((await doorStatus({ DB: db }, {})).first_run, 'disabled');
});

test('console end to end: /api/console carries the doors block after sign-in with the issued key', async () => {
  const db = newDb(); const env = { DB: db }; const o = { doors: {}, now: () => T0 + 60e3 };
  const res = await handleConsole(post('/console/first-run'), env, o);
  const key = (await res.text()).match(/id=k readonly value="([^"]+)"/)[1];
  const api = await handleConsole(new Request(U + '/api/console', { headers: { cookie: 'us_console=' + encodeURIComponent(key) } }), env, o);
  assert.equal(api.status, 200);
  const body = await api.json();
  assert.deepEqual(body.doors, { token: false, access: false, first_run: 'issued' });
});
