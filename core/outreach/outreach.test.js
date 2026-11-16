// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { makeDb } from '../_shared/testdb.js';
import { submit, approve, suppress, dispatch, render, stats } from './index.js';

const dirs = ['./migrations/'].map(d => fileURLToPath(new URL(d, import.meta.url)));
const mk = () => ({ db: makeDb(dirs), now: () => Date.parse('2026-06-10T12:00:00Z'), config: { sender: { name: 'Example Service', postal: '1 Example St, Town', reply_to: 'hello@example.org' }, footer: 'Generated and checked automatically.' } });
const it = (id, to) => ({ tenant: 't', id, to, subject: 's', body: 'b', evidence_url: 'https://example.org/e' });

test('nothing sends unapproved; dry run without transport; footer and identity always present', async () => {
  const ctx = mk();
  await submit(ctx, it('1', 'A@Example.com'));
  assert.deepEqual(await dispatch(ctx), []);
  await assert.rejects(approve(ctx, '1', 'agent:loop'), /human/);
  assert.equal(await approve(ctx, '1', 'a person'), true);
  assert.deepEqual(await dispatch(ctx), [{ id: '1', result: 'dry_run' }]);
  const t = render(ctx, { body: 'b', evidence_url: 'https://example.org/e' });
  assert.match(t, /Generated and checked automatically/); assert.match(t, /1 Example St/); assert.match(t, /hello@example\.org/);
  assert.deepEqual(await dispatch(ctx), []);
});

test('suppression is immediate and absolute; caps hold; identity, footer and evidence required', async () => {
  const ctx = mk(); const sent = [];
  await submit(ctx, it('1', 'a@x.org')); await approve(ctx, '1', 'p');
  await suppress(ctx, 'A@x.org');
  assert.deepEqual(await dispatch(ctx, { transport: async m => sent.push(m) }), []);
  assert.equal((await submit(ctx, it('2', 'a@x.org'))).status, 'blocked_suppressed');
  await submit(ctx, it('3', 'b@x.org')); await submit(ctx, it('4', 'c@x.org')); await approve(ctx, '3', 'p'); await approve(ctx, '4', 'p');
  const r = await dispatch(ctx, { transport: async m => sent.push(m), limits: { perDay: 1, perRecipient: 2 } });
  assert.deepEqual(r.map(x => x.result).sort(), ['sent', 'skipped']);
  assert.equal(sent.length, 1);
  await assert.rejects(submit(ctx, { ...it('5', 'd@x.org'), evidence_url: 'http://no' }), /evidence/);
  await assert.rejects(submit({ ...ctx, config: { footer: 'f' } }, it('6', 'd@x.org')), /sender/);
  await assert.rejects(submit({ ...ctx, config: { sender: ctx.config.sender } }, it('7', 'd@x.org')), /footer/);
  assert.deepEqual((await stats(ctx, 't')).suppressed, 1);
});
