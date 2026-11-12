// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { makeDb } from '../_shared/testdb.js';
import { createAgents, parseCall } from './index.js';

const mig = fileURLToPath(new URL('./migrations/', import.meta.url));
const scripted = replies => { let i = 0; const seen = []; return { seen, call: async req => { seen.push(req); const t = replies[Math.min(i++, replies.length - 1)]; return t === null ? { ok: false, refusal: 'hard_cap' } : { ok: true, text: t }; } }; };
const mk = (replies, extra = {}) => { const s = { t: 1e12 }; const router = scripted(replies); const ag = createAgents({ db: makeDb([mig]), router, now: () => s.t, ...extra }); return { ag, router, s }; };

test('parseCall accepts fenced JSON tool calls only', () => {
  assert.deepEqual(parseCall('```json\n{"tool":"a","args":{"x":1}}\n```'), { tool: 'a', args: { x: 1 } });
  assert.equal(parseCall('plain text'), null);
  assert.equal(parseCall('{"tool":5}'), null);
});

test('a tool result goes back to the model before the final answer; inherited names are not tools', async () => {
  const { ag, router } = mk(['{"tool":"add","args":{"a":2,"b":3}}', '{"tool":"constructor"}', 'The sum is 5.']);
  ag.define('calc', { system: 'You add.', tools: { add: ({ a, b }) => a + b } });
  const r = await ag.turn('calc', 's1', 'add 2 and 3');
  assert.deepEqual([r.ok, r.text, r.steps], [true, 'The sum is 5.', 3]);
  assert.ok(router.seen[1].messages.some(m => m.content === 'tool result: 5'));
  assert.ok(router.seen[2].messages.some(m => /unknown tool constructor/.test(m.content)));
});

test('an approval-gated tool stops the turn; approving runs it once and resumes; deciding twice is refused', async () => {
  const ran = [];
  const { ag } = mk(['{"tool":"wipe","args":{"id":7}}', 'Done.']);
  ag.define('ops', { tools: { wipe: { approval: true, run: a => { ran.push(a.id); return 'ok'; } } } });
  const r = await ag.turn('ops', 's2', 'wipe 7');
  assert.deepEqual([r.pending_approval, ran.length], [1, 0]);
  const d = await ag.decide(1, true, 'policy');
  assert.deepEqual([d.ok, d.text, ran], [true, 'Done.', [7]]);
  assert.equal((await ag.decide(1, true)).refusal, 'already_approved');
});

test('denial is told to the model; an expired approval cannot run and tells the session', async () => {
  const ran = []; const { ag, router, s } = mk(['{"tool":"wipe"}', 'Ok, not doing it.', '{"tool":"wipe"}']);
  ag.define('ops', { tools: { wipe: { approval: true, run: () => ran.push(1) } } });
  await ag.turn('ops', 'a', 'x'); await ag.decide(1, false);
  assert.ok(router.seen[1].messages.some(m => m.content === 'tool result: error: approval denied'));
  await ag.turn('ops', 'b', 'y'); s.t += 61 * 60000;
  assert.equal((await ag.decide(2, true)).refusal, 'expired');
  assert.deepEqual(ran, []);
});

test('hooks: before can veto (and a throwing hook vetoes); after observes', async () => {
  const seen = [];
  const { ag, router } = mk(['{"tool":"t"}', '{"tool":"t"}', 'end'], { hooks: { before: ({ tool }) => { if (seen.length === 0) { seen.push('b'); return 'policy'; } throw new Error('boom'); }, after: () => { throw new Error('ignored'); } } });
  ag.define('h', { tools: { t: () => 1 } });
  const r = await ag.turn('h', 's', 'go');
  assert.equal(r.text, 'end');
  const msgs = router.seen[2].messages.map(m => m.content);
  assert.ok(msgs.includes('tool result: error: vetoed: policy') && msgs.includes('tool result: error: vetoed: hook failed'));
});

test('step cap and router refusal are surfaced; unknown agent refused', async () => {
  const a = mk(['{"tool":"t"}']); a.ag.define('x', { tools: { t: () => 1 }, });
  const b = createAgents({ db: makeDb([mig]), router: scripted(['{"tool":"t"}']), config: { max_steps: 2 } }); b.define('x', { tools: { t: () => 1 } });
  assert.equal((await b.turn('x', 's', 'q')).refusal, 'max_steps');
  const e = mk([null]); e.ag.define('y', {});
  assert.equal((await e.ag.turn('y', 's', 'q')).refusal, 'hard_cap');
  assert.equal((await e.ag.turn('nope', 's', 'q')).refusal, 'unknown_agent');
  assert.throws(() => e.ag.define('Bad Name', {}));
});

test('compact folds old messages into one summary and keeps the newest', async () => {
  const { ag, router } = mk(['a summary']); let n = 0;
  ag.define('x', {});
  const db = makeDb([mig]); const ag2 = createAgents({ db, router, config: { compact_over: 5, compact_keep: 2 } });
  for (let i = 0; i < 8; i++) await db.prepare("INSERT INTO agents_messages (session_id, role, content, at) VALUES ('s','user',?, 't')").bind('m' + i).run();
  const r = await ag2.compact('s');
  assert.deepEqual([r.compacted, r.messages], [true, 3]);
  const rows = (await db.prepare("SELECT content FROM agents_messages WHERE session_id='s' ORDER BY id").all()).results.map(x => x.content);
  assert.deepEqual(rows, ['summary of earlier conversation: a summary', 'm6', 'm7']);
  assert.equal((await ag2.compact('s')).compacted, false);
});
