// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { roleFor, pickVerifiedEmail, maskEmail, issueSession, readSession, canWrite } from './index.js';

test('repository admin or org owner is the owner; everyone else only reads', () => {
  assert.equal(roleFor({ permission: 'admin' }), 'owner');
  assert.equal(roleFor({ orgRole: 'admin' }), 'owner');
  for (const p of ['write', 'read', 'none', undefined]) assert.equal(roleFor({ permission: p }), 'viewer');
  assert.equal(roleFor(), 'viewer');
});

test('the code goes to the primary verified email, never a noreply or unverified one', () => {
  const emails = [{ email: 'x@users.noreply.github.com', verified: true, primary: true }, { email: 'a@b.c', verified: false, primary: false }, { email: 'me@example.com', verified: true, primary: false }];
  assert.equal(pickVerifiedEmail(emails), 'me@example.com');
  assert.equal(pickVerifiedEmail([{ email: 'p@q.r', verified: true, primary: true }, { email: 's@t.u', verified: true }]), 'p@q.r');
  assert.equal(pickVerifiedEmail([]), null);
  assert.equal(pickVerifiedEmail(null), null);
});

test('the screen shows a masked address', () => {
  assert.equal(maskEmail('rowan@example.com'), 'r***@example.com');
  assert.equal(maskEmail('nope'), '');
});

test('a session verifies, expires, and cannot be forged or used without a key', async () => {
  const key = 'generated-by-the-worker';
  const t = await issueSession({ login: 'octocat', role: 'owner', key, now: 1000, ttlMs: 500 });
  const s = await readSession(t, { key, now: 1200 });
  assert.deepEqual([s.login, s.role, canWrite(s)], ['octocat', 'owner', true]);
  assert.equal(await readSession(t, { key, now: 1600 }), null, 'expired');
  assert.equal(await readSession(t, { key: 'other', now: 1200 }), null, 'wrong key');
  assert.equal(await readSession(t, { key: '', now: 1200 }), null, 'no key');
  const [body, sig] = t.split('.');
  const forged = Buffer.from(JSON.stringify({ login: 'x', role: 'owner', exp: 9e15 })).toString('base64url') + '.' + sig;
  assert.equal(await readSession(forged, { key, now: 1200 }), null, 'forged body');
  assert.equal(canWrite(await readSession(await issueSession({ login: 'v', role: 'anything', key, now: 1 }), { key, now: 2 })), false);
});
