// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { makeDb } from '../_shared/testdb.js';
import { createContainers, validateJob } from './index.js';

const mig = fileURLToPath(new URL('./migrations/', import.meta.url));
const mk = (executors, config = {}, secrets = []) => { const s = { t: 1e12 }; return { s, cx: createContainers({ db: makeDb([mig]), now: () => s.t, executors, config, secrets }) }; };
const ex = (name, fn) => ({ name, run: fn });
const job = { image: 'img', command: 'echo hi' };

test('validateJob: command, size, path, image allowlist and env names', () => {
  assert.equal(validateJob(job), null);
  assert.match(validateJob({ command: ' ' }), /command required/);
  assert.match(validateJob({ command: 'rm -rf /', image: 'img' }, { ...{}, allow: ['echo'], max_command_chars: 99, max_files: 9, max_file_bytes: 9, images: null, max_env: 1 }), /not allowed: rm/);
  assert.match(validateJob({ ...job, files: { '../x': 'a' } }), /unsafe path/);
  assert.match(validateJob({ ...job, files: { 'C:/x': 'a' } }), /unsafe path/);
  assert.match(validateJob({ ...job, files: { a: 'x'.repeat(10) } }, { max_command_chars: 99, max_files: 9, max_file_bytes: 5, images: null, allow: null, max_env: 1 }), /too large/);
  assert.match(validateJob(job, { max_command_chars: 99, images: ['other'], max_files: 1, max_file_bytes: 1, max_env: 1 }), /image not allowed/);
  assert.equal(validateJob({ ...job, env: { 'bad-name': '1' } }), 'invalid env');
});

test('submit is idempotent by key; an invalid job is refused before queueing', async () => {
  const { cx } = mk([ex('a', async () => ({ exit_code: 0 }))]);
  const a = await cx.submit(job, { key: 'k' }), b = await cx.submit(job, { key: 'k' });
  assert.deepEqual([a.id, b.id, b.duplicate], [1, 1, true]);
  assert.equal((await cx.submit({ command: '' })).refusal, 'invalid_job');
  assert.deepEqual(await cx.stats(), { queued: 1 });
});

test('runs through the first working executor, falling back past a throwing one; output scrubbed', async () => {
  const { cx } = mk([ex('platform', async () => { throw new Error('binding gone'); }), ex('http', async () => ({ exit_code: 0, stdout: 'token=SECRET123 ok', stderr: '' }))], {}, ['SECRET123']);
  await cx.submit(job);
  const r = await cx.runNext();
  assert.deepEqual([r.ok, r.executor, r.attempts.map(a => a.ok)], [true, 'http', [false, true]]);
  const g = await cx.get(1);
  assert.deepEqual([g.status, g.stdout], ['done', 'token=[redacted] ok']);
  assert.equal(await cx.runNext(), null);
});

test('a nonzero exit is a failed result and is not retried', async () => {
  const { cx } = mk([ex('a', async () => ({ exit_code: 2, stderr: 'bad' }))]); await cx.submit(job);
  const r = await cx.runNext();
  assert.deepEqual([r.status, r.exit_code, (await cx.get(1)).attempts], ['failed', 2, 1]);
});

test('all executors failing re-queues until max_attempts, then fails; no executor is reported', async () => {
  const { cx } = mk([ex('a', async () => { throw new Error('down'); })], { max_attempts: 2 }); await cx.submit(job);
  assert.equal((await cx.runNext()).status, 'queued');
  const r = await cx.runNext();
  assert.deepEqual([r.status, r.refusal, (await cx.get(1)).error], ['failed', 'all_executors_failed', 'a: down']);
  const n = mk([]); await n.cx.submit(job); assert.equal((await n.cx.runNext()).refusal, 'no_executor');
});

test('a slow executor times out', async () => {
  const { cx } = mk([ex('slow', () => new Promise(() => {}))], { timeout_ms: 20 }); await cx.submit(job);
  assert.equal((await cx.runNext()).attempts[0].error, 'timeout');
});

test('reap re-queues a running job whose lease expired, and fails it once attempts are spent', async () => {
  const db = makeDb([mig]), s = { t: 1e12 };
  const cx = createContainers({ db, now: () => s.t, executors: [], config: { lease_minutes: 5, max_attempts: 2 } });
  await cx.submit(job); await cx.submit(job);
  await db.prepare("UPDATE containers_jobs SET status='running', attempts=1, lease_until_ms=? WHERE id=1").bind(s.t + 5 * 60000).run();
  await db.prepare("UPDATE containers_jobs SET status='running', attempts=2, lease_until_ms=? WHERE id=2").bind(s.t + 5 * 60000).run();
  assert.deepEqual(await cx.reap(), { requeued: 0, failed: 0 });
  s.t += 6 * 60000;
  assert.deepEqual(await cx.reap(), { requeued: 1, failed: 1 });
  assert.deepEqual(await cx.stats(), { queued: 1, failed: 1 });
});
