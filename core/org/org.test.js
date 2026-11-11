// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// End to end: createOrg over a database with every migration, a fake router fetch and a fake VCS. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { makeDb } from '../_shared/testdb.js';
import { OUT_DIR } from '../../tools/build_migrations.mjs';
import { createOrg, presence, runnerNeeds } from './index.js';
import { fakeVcs, goodPatch, approve, seedItem, T0 } from '../runner/testkit.js';
import { addClaims } from '../describe/index.js';
import { loadManifest } from '../packs/index.js';

const EXAMPLE_DIR = fileURLToPath(new URL('../packs/example/', import.meta.url));
const policy = JSON.parse(readFileSync(new URL('../../autonomy/policy.json', import.meta.url), 'utf8'));
const routerConfig = JSON.parse(readFileSync(new URL('../router/example-config.json', import.meta.url), 'utf8'));
const SECRETS = { VCS_TOKEN: 'tok-AAAA1111zz', PROVIDER_A_API_KEY: 'key-BBBB2222yy', PROVIDER_B_API_KEY: 'key-CCCC3333xx', CONSOLE_TOKEN: 'console-DDDD4444ww' };
const rows = (db, sql, ...a) => db.raw.prepare(sql).all(...a);
const one = (db, sql, ...a) => db.raw.prepare(sql).get(...a);

const baseConfig = (over = {}) => ({
  org_slug: 'test-org', claim_ttl_minutes: 120, max_wip_per_role: 3, plus_share: 0.2,
  policy: { trust: policy.trust, ladder: policy.ladder, surfaces: policy.surfaces },
  runner: { enabled: true }, router: routerConfig, vcs: { repo: 'owner/name', base: 'main' },
  packs: { step_timeout_ms: 500, packs: { example: { recipients: ['person@example.com'] } } },
  ...over,
});

// One openai-shaped and one anthropic-shaped reply: provider-a does, provider-b reviews.
function fakeModelFetch() {
  const f = async (url) => {
    f.calls.push(String(url));
    const a = String(url).includes('provider-a');
    const text = a ? goodPatch() : approve;
    const body = a ? { choices: [{ message: { content: text } }], usage: { prompt_tokens: 100, completion_tokens: 50 } }
      : { content: [{ type: 'text', text }], usage: { input_tokens: 100, output_tokens: 50 } };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  f.calls = [];
  return f;
}

function boot({ env = SECRETS, config = baseConfig(), extra = {} } = {}) {
  const db = makeDb([OUT_DIR]);
  const clock = { t: T0 };
  const fetch = fakeModelFetch();
  const org = createOrg({ db, env, config, fetch, now: () => clock.t, ...extra });
  const tick = async () => { clock.t += 60e3; return org.tick(); };
  return { db, org, clock, fetch, tick };
}

test('presence reports names only; runnerNeeds names what is missing', () => {
  assert.deepEqual(presence({ A: 'x', B: '', C: 5 }), { A: true });
  assert.deepEqual(runnerNeeds(baseConfig(), SECRETS), []);
  assert.deepEqual(runnerNeeds(baseConfig(), {}), ['VCS_TOKEN', 'PROVIDER_A_API_KEY', 'PROVIDER_B_API_KEY']);
  assert.deepEqual(runnerNeeds(baseConfig(), { VCS_TOKEN: 'x', PROVIDER_B_API_KEY: 'y' }), []);
  assert.deepEqual(runnerNeeds({ runner: { enabled: true } }, { VCS_TOKEN: 'x' }), ['config.vcs.repo', 'config.router.providers']);
});

test('end to end: every loop runs on one tick, a run reaches a draft PR, nothing leaks', async () => {
  const vcs = fakeVcs({ files: { 'core/example/widget.js': '// widget v1\n', 'core/example/widget.test.js': '// test\n' } });
  const channel = { sent: [], async send(m) { this.sent.push(m); return { id: 'p1' }; } };
  const boom = { calls: 0 };
  const { db, org, tick, fetch } = boot({
    extra: { vcs, channels: { fake: channel }, outputs: async () => { boom.calls++; throw new Error('outputs source is down'); } },
  });
  // seed: a staff item for the runner, an operations role and item for the seed dispatch, describe claims, packs
  seedItem(db);
  db.raw.exec(`INSERT INTO roles (id, role, tick_every, model) VALUES ('ops-1','operations',1,'m');
    INSERT INTO items (id,title,owner_role,done_check,priority,status) VALUES ('OPS-1','check backups','operations','x',10,'ready');
    INSERT INTO org (key, value) VALUES ('purpose','a small shop that takes orders')`);
  await addClaims(db, [
    { id: 'operation.items', text: 'As of {date}, {value} work items exist.', probe: 'sql:SELECT COUNT(*) AS value FROM items', expect: '>=1', max_age_hours: 24 },
    { id: 'operation.failing', text: 'The impossible holds.', probe: 'sql:SELECT 0 AS value', expect: '>=1', max_age_hours: 24 },
  ]);
  const manifest = loadManifest(EXAMPLE_DIR);
  assert.equal((await org.packs.register(manifest, { dir: EXAMPLE_DIR })).ok, true);
  const dormant = await org.packs.register(JSON.parse(JSON.stringify(manifest).replaceAll('example_', 'dormant_').replace('"id":"example"', '"id":"dormant"')), { dir: EXAMPLE_DIR });
  assert.equal(dormant.ok, true, JSON.stringify(dormant));
  db.raw.prepare(`INSERT INTO trust_ledger (surface, action_class, rung, reliability, outcomes) VALUES ('pack:example','notice','delegated',1,50)`).run();
  assert.equal((await org.packs.enablePack('example', { by: 'owner', cardText: manifest.enable_gate })).ok, true);

  let last;
  for (let i = 0; i < 14 && !vcs.prs.length; i++) last = await tick();
  assert.equal(vcs.prs.length, 1, 'a draft PR was opened: ' + JSON.stringify(rows(db, 'SELECT id,state,reason,last_error FROM runner_runs')));
  last = await tick();

  const names = org.extraSteps().map(s => s.name);
  assert.deepEqual(names, ['l2', 'claims_reap', 'claims_release_terminal', 'describe', 'yield', 'packs', 'runner']);

  // L2 kernel step recorded its snapshot, every tick
  assert.ok(one(db, `SELECT COUNT(*) n FROM kernel_step_evidence WHERE step='risk_snapshot' AND ok=1`).n >= 3);
  // seed dispatch still works next to the extra steps
  assert.ok(one(db, `SELECT COUNT(*) n FROM dispatches WHERE item_id='OPS-1'`).n >= 1);
  // the staff item was claimed through the claims module and the run reached pr_opened
  assert.ok(one(db, `SELECT COUNT(*) n FROM claims_lock WHERE item_id='US-SPEC-11-1'`).n >= 1);
  assert.equal(one(db, `SELECT state FROM runner_runs WHERE item_id='US-SPEC-11-1'`).state, 'pr_opened');
  assert.ok(fetch.calls.some(u => u.includes('provider-a')) && fetch.calls.some(u => u.includes('provider-b')), 'doer and reviewer used different providers');
  // describe loop: three outputs, the failing claim withdrawn with a repair item
  for (const form of ['page', 'json', 'llms']) assert.ok(one(db, `SELECT COUNT(*) n FROM describe_outputs WHERE form=?`, form).n >= 1, form);
  assert.equal(one(db, `SELECT withdrawn FROM describe_claims WHERE id='operation.failing'`).withdrawn, 1);
  assert.equal(one(db, `SELECT withdrawn FROM describe_claims WHERE id='operation.items'`).withdrawn, 0);
  assert.ok(one(db, `SELECT id FROM items WHERE id='DESCRIBE-operation.failing'`));
  // packs: the enabled example pack's loop ran, the disabled one did not
  assert.ok(one(db, `SELECT COUNT(*) n FROM packs_runs WHERE pack_id='example' AND outcome='ok'`).n >= 1);
  assert.equal(one(db, `SELECT COUNT(*) n FROM packs_runs WHERE pack_id='dormant'`).n, 0);
  // a throwing step did not stop the tick: yield failed, everything after it ran, and an item says so
  assert.ok(boom.calls >= 1);
  assert.ok(last.errors.some(e => e.startsWith('yield:')), JSON.stringify(last.errors));
  assert.equal(last.completed, last.total - 1);
  assert.ok(rows(db, `SELECT id FROM items WHERE id LIKE 'TICKFAIL-yield-%'`).length >= 1);
  assert.match(one(db, `SELECT report FROM tick_runs ORDER BY id DESC LIMIT 1`).report, /runner advanced/);

  // no secret value in any table
  const tables = rows(db, `SELECT name FROM sqlite_master WHERE type='table'`).map(r => r.name);
  for (const t of tables) {
    const dump = JSON.stringify(rows(db, `SELECT * FROM "${t}"`));
    for (const v of Object.values(SECRETS)) assert.ok(!dump.includes(v), `secret value found in ${t}`);
  }
});

test('the console API reports the open decision card for a missing secret when the runner lacks its key', async () => {
  const { org, tick } = boot({ env: { VCS_TOKEN: SECRETS.VCS_TOKEN, CONSOLE_TOKEN: SECRETS.CONSOLE_TOKEN } });
  await tick(); await tick();
  const login = await org.handle(new Request('https://x.test/console/login', { method: 'POST', body: new URLSearchParams({ key: SECRETS.CONSOLE_TOKEN }) }));
  assert.equal(login.status, 303);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const api = await (await org.handle(new Request('https://x.test/api/console', { headers: { cookie } }))).json();
  const cards = api.needs_you.cards;
  assert.ok(cards.some(c => c.what === 'runner needs: PROVIDER_A_API_KEY' && c.kind === 'secret' && c.closing_probe === 'env:PROVIDER_A_API_KEY'), JSON.stringify(cards));
  assert.match(api.headline, /need/);
});

test('with NO secrets the org ticks cleanly and files exactly one card per missing secret, not one per tick', async () => {
  const { db, org, tick } = boot({ env: {} });
  for (let i = 0; i < 4; i++) {
    const r = await tick();
    assert.equal(r.completed, r.total, JSON.stringify(r.errors));
    assert.deepEqual(r.errors, []);
  }
  const cards = rows(db, `SELECT what, closing_probe FROM gate_cards WHERE id LIKE 'runner-needs-%' ORDER BY what`);
  assert.deepEqual(cards.map(c => c.what), ['runner needs: PROVIDER_A_API_KEY', 'runner needs: PROVIDER_B_API_KEY', 'runner needs: VCS_TOKEN']);
  assert.deepEqual(cards.map(c => c.closing_probe), ['env:PROVIDER_A_API_KEY', 'env:PROVIDER_B_API_KEY', 'env:VCS_TOKEN']);
  assert.equal(rows(db, `SELECT 1 FROM runner_runs`).length, 0);
  assert.ok(!org.extraSteps().some(s => s.name === 'runner'));
  // a secret that arrives closes its card by the seed probe
  const later = createOrg({ db, env: { VCS_TOKEN: 'x-late-value-1' }, config: baseConfig(), now: () => T0 + 99 * 60e3 });
  await later.tick();
  assert.equal(one(db, `SELECT status FROM gate_cards WHERE id='runner-needs-VCS-TOKEN'`).status, 'closed');
});

test('the runner is not started when disabled, and nothing is filed', async () => {
  const { db, org, tick } = boot({ env: {}, config: baseConfig({ runner: { enabled: false } }) });
  const r = await tick();
  assert.equal(r.completed, r.total);
  assert.equal(rows(db, `SELECT 1 FROM gate_cards WHERE id LIKE 'runner-needs-%'`).length, 0);
  assert.ok(!org.extraSteps().some(s => s.name.startsWith('runner')));
});

test('handle routes /health, /describe and the console, and returns null for anything else', async () => {
  const { org, tick } = boot();
  assert.equal((await org.handle(new Request('https://x.test/health'))).status, 503);
  assert.equal((await org.handle(new Request('https://x.test/describe'))).status, 404); // nothing stored before the first tick
  await tick();
  const h = await org.handle(new Request('https://x.test/health'));
  assert.equal(h.status, 200);
  const body = await h.json();
  assert.equal(body.ok, true); assert.equal(body.org, 'test-org'); assert.ok(body.last_tick.report);
  assert.equal(await org.handle(new Request('https://x.test/nothing')), null);
  assert.equal((await org.handle(new Request('https://x.test/console'))).status, 401);
  for (const p of ['/describe', '/describe.json', '/llms.txt']) assert.equal((await org.handle(new Request('https://x.test' + p))).status, 200, p); // stored by the describe loop on the first tick
});
