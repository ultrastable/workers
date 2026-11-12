// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// US-SPEC-03/08/11/14/16: the merged modules steward, waste, ownerwatch, agents, containers, infra, elicit and console-l3 are
// started by core/org only when their config.<name>.enabled is true. The default step list is unchanged (opt-in, safe).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeDb } from '../_shared/testdb.js';
import { OUT_DIR } from '../../tools/build_migrations.mjs';
import { createOrg } from '../org/index.js';
import { createContainers } from '../containers/index.js';

const policy = JSON.parse(readFileSync(new URL('../../autonomy/policy.json', import.meta.url), 'utf8'));
const T0 = Date.parse('2026-11-01T00:00:00Z');
const BASE = { org_slug: 'wiring-org', claim_ttl_minutes: 120, max_wip_per_role: 3, plus_share: 0.2, policy: { trust: policy.trust, ladder: policy.ladder, surfaces: policy.surfaces } };
const one = (db, sql, ...a) => db.raw.prepare(sql).get(...a);
const ALL_ON = { steward: { enabled: true }, waste: { enabled: true }, ownerwatch: { enabled: true }, agents: { enabled: true }, containers: { enabled: true, secret_env: ['JOB_SECRET'] },
  infra: { enabled: true }, elicit: { enabled: true }, console_l3: { enabled: true } };

function boot(config, extra = {}, env = { CONSOLE_TOKEN: 'console-token-123' }) {
  const db = makeDb([OUT_DIR]);
  const clock = { t: T0 };
  const org = createOrg({ db, env, config: { ...BASE, ...config }, fetch: async () => new Response('', { status: 200 }), now: () => clock.t, ...extra });
  return { db, org, clock, tick: async () => { clock.t += 60e3; return org.tick(); } };
}
const req = (path, init = {}) => new Request('https://org.example' + path, init);
const authed = { authorization: 'Bearer console-token-123', 'content-type': 'application/json' };

test('default: nothing opt-in is started and the step list is unchanged', () => {
  const { org } = boot({});
  assert.deepEqual(org.extraSteps().map(s => s.name), ['l2', 'claims_reap', 'claims_release_terminal', 'describe', 'yield', 'packs']);
  assert.equal(org.agents, null);
  assert.equal(org.elicit, null);
});

test('enabled flags without their ports add only what can run; with ports every loop is added in order', () => {
  const noPorts = boot(ALL_ON).org.extraSteps().map(s => s.name);
  assert.ok(!noPorts.includes('steward') && !noPorts.includes('containers') && !noPorts.includes('console_l3'));
  const sink = { name: 'mem', upsert: async () => ({ ref: 'r' }) };
  const names = boot(ALL_ON, { sinks: [sink], executors: [{ name: 'x', run: async () => ({ exit_code: 0 }) }], stepRuns: async () => [] }).org.extraSteps().map(s => s.name);
  assert.deepEqual(names, ['l2', 'claims_reap', 'claims_release_terminal', 'describe', 'waste', 'packs', 'steward', 'ownerwatch', 'containers', 'agents', 'elicit', 'console_l3', 'infra']);
});

test('one tick runs every wired loop and each leaves evidence', async () => {
  const mirrored = [];
  const sink = { name: 'mem', upsert: async it => { mirrored.push(it.id); return { ref: 'ref-' + it.id }; } };
  const ran = [];
  const executor = { name: 'fake', run: async job => { ran.push(job.command); return { exit_code: 0, stdout: 'ok JOBSECRET-9999', stderr: '' }; } };
  const { db, org, clock, tick } = boot({ ...ALL_ON, infra: { enabled: true, tick_every_minutes: 5 } }, {
    sinks: [sink], executors: [executor], gauges: { queue: { kind: 'backlog', limit: 5, read: async () => 9 } },
    stepRuns: async () => [{ process: 'build', step: 'review', started_at: T0 - 10 * 3600e3, budget_hours: 2 }],
  }, { CONSOLE_TOKEN: 'console-token-123', JOB_SECRET: 'JOBSECRET-9999' });
  db.raw.exec(`INSERT INTO items (id,title,owner_role,done_check,closing_probe,priority,status) VALUES ('W-1','mirror me','operations','x','manual',10,'open');
    INSERT INTO gate_cards (id, what, why_gated, default_in_effect, prepared_by_fleet, closing_probe) VALUES ('c1','a step','why','default','org','env:SOME_NAME')`);
  const submitted = await createContainers({ db, now: () => clock.t, config: {}, executors: [executor] }).submit({ command: 'echo hi' });
  assert.equal(submitted.ok, true, JSON.stringify(submitted));
  const rep = await tick();
  assert.deepEqual(org.extraSteps().map(s => s.name).slice(-7), ['steward', 'ownerwatch', 'containers', 'agents', 'elicit', 'console_l3', 'infra']);
  const run = one(db, 'SELECT steps_completed, steps_total, errors FROM tick_runs ORDER BY id DESC LIMIT 1');
  assert.equal(run.steps_completed, run.steps_total, 'every step completed: ' + run.errors + JSON.stringify(rep));
  assert.ok(mirrored.includes('W-1'));
  assert.ok(one(db, 'SELECT COUNT(*) n FROM steward_runs').n >= 1);
  assert.ok(one(db, `SELECT COUNT(*) n FROM items WHERE id LIKE 'WST-%'`).n >= 1, 'waste gauge filed an item');
  assert.equal(one(db, 'SELECT COUNT(*) n FROM runner_ownerwatch WHERE card_id=?', 'c1').n, 1);
  const job = one(db, 'SELECT status, stdout FROM containers_jobs WHERE id=?', submitted.id);
  assert.equal(job.status, 'done');
  assert.deepEqual(ran, ['echo hi']);
  assert.ok(!job.stdout.includes('JOBSECRET-9999'), 'configured secret scrubbed from job output');
  assert.ok(one(db, `SELECT COUNT(*) n FROM items WHERE id LIKE 'STEPBUDGET-%'`).n >= 1);
  assert.equal(one(db, `SELECT beats FROM infra_heartbeats WHERE name='tick'`).beats, 1);
});

test('host routes: /health/deep is open, agent and elicit routes need the console token, all closed when disabled', async () => {
  const router = { call: async ({ messages }) => ({ ok: true, text: 'echo:' + messages.at(-1).content }) };
  const { org } = boot(ALL_ON, { router, agentDefs: { helper: { system: 'You help.', tools: {} } } });
  assert.equal((await org.handle(req('/health/deep'))).status, 200);
  assert.equal((await org.handle(req('/api/agents/helper/turn', { method: 'POST', body: '{}' }))).status, 401);
  const ok = await org.handle(req('/api/agents/helper/turn', { method: 'POST', headers: authed, body: JSON.stringify({ session: 's1', text: 'hi' }) }));
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true, text: 'echo:hi', steps: 1 });
  assert.equal((await org.handle(req('/api/agents/helper/turn', { method: 'POST', headers: authed, body: '{"x":1}' }))).status, 400);
  assert.equal((await org.handle(req('/api/elicit/readiness'))).status, 401);
  assert.equal((await org.handle(req('/api/elicit/readiness?project=p', { headers: authed }))).status, 200);
  const off = boot({}).org;
  assert.equal(await off.handle(req('/api/agents/helper/turn', { method: 'POST', headers: authed, body: '{}' })), null);
  assert.equal(await off.handle(req('/health/deep')), null);
});

test('a failing sink does not stop the tick or the loops after it', async () => {
  const sink = { name: 'bad', upsert: async () => { throw new Error('sink down'); } };
  const { db, tick } = boot({ steward: { enabled: true }, infra: { enabled: true } }, { sinks: [sink] });
  db.raw.exec(`INSERT INTO items (id,title,owner_role,done_check,closing_probe,priority,status) VALUES ('W-2','t','operations','x','manual',10,'open')`);
  await tick();
  assert.equal(one(db, `SELECT beats FROM infra_heartbeats WHERE name='tick'`).beats, 1);
  assert.ok(one(db, `SELECT COUNT(*) n FROM items WHERE id='STW-W-2-bad'`).n >= 1, 'stuck mirror became an item');
});
