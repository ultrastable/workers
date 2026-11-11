// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { makeDb } from '../../../core/_shared/testdb.js';
import { createAgentRuntime } from './runtime.js';

const mig = fileURLToPath(new URL('./migrations/', import.meta.url));
const scripted = replies => { let i = 0; const seen = []; return { seen, call: async req => { seen.push(req); const t = replies[Math.min(i++, replies.length - 1)]; return t === null ? { ok: false, refusal: 'hard_cap' } : { ok: true, text: t }; } }; };

test('a tool call is executed and its result returned to the model before the final answer', async () => {
  const router = scripted(['{"tool":"add","args":{"a":2,"b":3}}', 'The sum is 5.']);
  const rt = createAgentRuntime({ db: makeDb([mig]), router, tools: { add: async ({ a, b }) => a + b } });
  const r = await rt.turn('s1', 'add 2 and 3');
  assert.deepEqual([r.ok, r.text, r.steps], [true, 'The sum is 5.', 2]);
  assert.ok(router.seen[1].messages.some(m => m.content === 'tool result: 5'));
});
test('unknown tools and tool errors are fed back; inherited names are not tools; step cap holds', async () => {
  const router = scripted(['{"tool":"constructor"}']);
  const rt = createAgentRuntime({ db: makeDb([mig]), router, tools: { bad: async () => { throw new Error('nope'); } }, config: { max_steps: 3 } });
  const r = await rt.turn('s2', 'x'); assert.equal(r.refusal, 'max_steps');
  assert.ok(router.seen[1].messages.some(m => /unknown tool constructor/.test(m.content)));
});
test('a router refusal is surfaced, not swallowed', async () => {
  const rt = createAgentRuntime({ db: makeDb([mig]), router: scripted([null]) });
  assert.equal((await rt.turn('s3', 'hi')).refusal, 'hard_cap');
});
