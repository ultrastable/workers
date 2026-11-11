// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execute, validateJob, httpExecutor } from './executor.js';

test('job validation: allowlist, path traversal, size', () => {
  assert.equal(validateJob({ command: 'rm -rf /' }, { max_command_chars: 99, allow: ['python', 'node'] }), 'command not allowed: rm');
  assert.match(validateJob({ command: 'node a', files: { '../x': '' } }), /unsafe path/);
  assert.match(validateJob({ command: 'node a', files: { '/etc/x': '' } }), /unsafe path/);
  assert.equal(validateJob({ command: 'node a.js', files: { 'a.js': '1' } }), null);
});
test('no single route: the container binding fails, the HTTP runner answers; secrets are scrubbed', async () => {
  const fetch = async () => new Response(JSON.stringify({ exit_code: 0, stdout: 'done tok-123456', stderr: '' }));
  const r = await execute({ executors: [{ name: 'binding', run: async () => { throw new Error('container unavailable'); } }, httpExecutor({ url: 'https://runner.example/run', fetch, env: { RUNNER_TOKEN: 'tok-123456' } })], secrets: ['tok-123456'] }, { command: 'node a.js' });
  assert.deepEqual([r.ok, r.executor, r.attempts.length], [true, 'http', 2]);
  assert.ok(!r.stdout.includes('tok-123456'));
});
test('failure shapes are explicit: invalid job, no executor, all failed, timeout, nonzero exit', async () => {
  assert.equal((await execute({ executors: [] }, {})).refusal, 'invalid_job');
  assert.equal((await execute({ executors: [] }, { command: 'x' })).refusal, 'no_executor');
  assert.equal((await execute({ executors: [{ name: 'a', run: async () => { throw new Error('x'); } }] }, { command: 'x' })).refusal, 'all_executors_failed');
  const slow = await execute({ executors: [{ name: 's', run: () => new Promise(() => {}) }], config: { timeout_ms: 20 } }, { command: 'x' });
  assert.equal(slow.attempts[0].error, 'timeout');
  assert.equal((await execute({ executors: [{ name: 'n', run: async () => ({ exit_code: 2, stdout: '', stderr: 'e' }) }] }, { command: 'x' })).ok, false);
});
