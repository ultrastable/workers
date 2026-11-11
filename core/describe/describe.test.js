// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Tests for core/describe (US-SPEC-22, T22-1 to T22-5). Fake fetch and readFile; no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { makeDb } from '../_shared/testdb.js';
import { runTick } from '../src/tick.js';
import {
  addClaims, runProbes, withdrawStale, buildSelfModel, render, checkVoice, describeOnce, describeExtraSteps, handle,
  assertReadOnlySql, extractClaimIds, publishableClaims, parseScopeMd, defaultCompose,
} from './index.js';
import { loadSeedClaims, loadVoiceRules } from './load.js';

const MIG = fileURLToPath(new URL('./migrations/', import.meta.url));
const T0 = Date.parse('2026-11-11T10:00:00Z');
const H = 3600e3;
const voice = loadVoiceRules();
const policy = JSON.parse(readFileSync(new URL('../../autonomy/policy.json', import.meta.url), 'utf8'));
const SPEC = { BUILT: 12, RUNNING_ONLY: 2, PLANNED: 3, 'NOT COVERED': 1, total: 18, planned_names: ['US-SPEC-22 describe loop', 'US-SPEC-21 packs'] };
const readFile = async p => { if (p === 'SCOPE.md') return '# Scope\n## What it does not do by default\n| Out of scope | Why |\n|---|---|\n| Run marketing | consent |\n'; throw new Error('ENOENT ' + p); };
const row = (db, sql, ...a) => db.raw.prepare(sql).get(...a);
const rows = (db, sql, ...a) => db.raw.prepare(sql).all(...a);

async function setup({ seed = true } = {}) {
  const db = makeDb([MIG]);
  db.raw.exec(`INSERT INTO tick_runs (started_at, finished_at, steps_completed, steps_total) VALUES ('2026-11-11 09:00:00','2026-11-11 09:00:05',7,7)`);
  db.raw.exec(`INSERT INTO predictions (id, metric, op, target, due_at, observed, verdict) VALUES ('p1','items_done','>=',1,'2026-11-10',2,'hit'),('p2','items_done','>=',9,'2026-11-10',2,'miss')`);
  db.raw.exec(`INSERT INTO org (key, value) VALUES ('pack:outreach','disabled'), ('purpose','I want a small shop site that takes orders.')`);
  if (seed) await addClaims(db, loadSeedClaims());
  return db;
}
const ports = (db, extra = {}) => ({ db, now: T0, readFile, specStatus: SPEC, fetch: async () => new Response('ok', { status: 200 }), ...extra });
const claimRow = (db, id) => row(db, `SELECT * FROM describe_claims WHERE id = ?`, id);

test('migration is idempotent and describe_ prefixed; seed claims load once', async () => {
  const db = await setup();
  const sql = readFileSync(new URL('./migrations/0001_describe.sql', import.meta.url), 'utf8');
  db.raw.exec(sql); db.raw.exec(sql);
  const names = rows(db, `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'describe_%'`).map(r => r.name).sort();
  assert.deepEqual(names, ['describe_claims', 'describe_outputs']);
  assert.equal(await addClaims(db, loadSeedClaims()), 0);
  assert.ok(rows(db, `SELECT id FROM describe_claims`).length >= 7);
});

test('sql probes accept one SELECT and reject everything else (R01)', async () => {
  for (const bad of ['DELETE FROM items', 'SELECT 1; DROP TABLE items', 'SELECT 1 -- x', 'UPDATE items SET status=1', 'WITH x AS (SELECT 1) SELECT * FROM x', 'SELECT 1 /* c */', 'PRAGMA table_info(items)', 'SELECT * FROM items WHERE 1; DELETE FROM items'])
    assert.throws(() => assertReadOnlySql(bad), undefined, bad);
  assert.equal(assertReadOnlySql('SELECT COUNT(*) FROM items;'), 'SELECT COUNT(*) FROM items');
  const db = await setup({ seed: false });
  await addClaims(db, [{ id: 'x.evil', text: 'x', probe: 'sql:DELETE FROM items', expect: '>=0' }]);
  await runProbes(ports(db));
  const c = claimRow(db, 'x.evil');
  assert.equal(c.last_result, 'unknown');
  assert.match(c.evidence, /single SELECT/);
});

test('probe kinds sql, file, http, spec return pass, fail or unknown with evidence', async () => {
  const db = await setup({ seed: false });
  await addClaims(db, [
    { id: 'a.sql', text: 'As of {date}, {value} scored.', probe: 'sql:SELECT COUNT(*) AS value FROM predictions WHERE verdict IS NOT NULL', expect: '=2' },
    { id: 'a.file', text: 'scope file ok', probe: 'file:SCOPE.md', expect: 'contains:What it does not do' },
    { id: 'a.nofile', text: 'missing file', probe: 'file:NOPE.md', expect: 'exists' },
    { id: 'a.http', text: 'site is up', probe: 'http:https://site.example/health', expect: 'status:200' },
    { id: 'a.http-down', text: 'site is up', probe: 'http:https://down.example/health', expect: 'status:200' },
    { id: 'a.spec', text: 'As of {date}, {value} built.', probe: 'spec:BUILT', expect: '>=10' },
    { id: 'a.spec-low', text: 'As of {date}, {value} built.', probe: 'spec:BUILT', expect: '>=50' },
    { id: 'a.badexpect', text: 'x', probe: 'sql:SELECT 1', expect: 'banana' },
  ]);
  const fetch = async u => { if (u.includes('down.example')) throw new Error('connect refused'); return new Response('ok', { status: 200 }); };
  const r = await runProbes(ports(db, { fetch }));
  const res = id => claimRow(db, id).last_result;
  assert.deepEqual(['a.sql', 'a.file', 'a.nofile', 'a.http', 'a.http-down', 'a.spec', 'a.spec-low', 'a.badexpect'].map(res),
    ['pass', 'pass', 'fail', 'pass', 'unknown', 'pass', 'fail', 'unknown']);
  assert.equal(JSON.parse(claimRow(db, 'a.sql').evidence).value, 2);
  assert.match(claimRow(db, 'a.http-down').evidence, /connect refused/);
  assert.equal(r.checked, 8);
  assert.equal(claimRow(db, 'a.spec').last_checked_at, '2026-11-11 10:00:00');
});

test('T22-1: a failing public claim is absent from the next output and an item is filed (R02)', async () => {
  const db = await setup();
  const opts = ports(db, { voiceRules: voice });
  let r = await describeOnce(opts);
  assert.equal(r.stored, true);
  assert.ok(extractClaimIds(row(db, `SELECT body FROM describe_outputs WHERE form='page' ORDER BY id DESC`).body).includes('scope.out-of-scope'));
  r = await describeOnce({ ...opts, now: T0 + H, readFile: async () => 'nothing relevant' });
  assert.ok(r.probes.withdrawn.includes('scope.out-of-scope'));
  const page = row(db, `SELECT body FROM describe_outputs WHERE form='page' ORDER BY id DESC`).body;
  assert.ok(!extractClaimIds(page).includes('scope.out-of-scope'));
  const item = row(db, `SELECT * FROM items WHERE id = 'DESCRIBE-scope.out-of-scope'`);
  assert.equal(item.status, 'ready');
  assert.equal(item.action_class, 'A');
  assert.equal(claimRow(db, 'scope.out-of-scope').withdrawn, 1);
  // a later pass reinstates it
  await describeOnce({ ...opts, now: T0 + 2 * H });
  assert.equal(claimRow(db, 'scope.out-of-scope').withdrawn, 0);
});

test('unknown result also withdraws a public claim and files an item', async () => {
  const db = await setup();
  await runProbes(ports(db, { specStatus: null }));
  assert.equal(claimRow(db, 'capabilities.built').last_result, 'unknown');
  assert.equal(claimRow(db, 'capabilities.built').withdrawn, 1);
  assert.ok(row(db, `SELECT id FROM items WHERE id = 'DESCRIBE-capabilities.built'`));
  assert.ok(!(await publishableClaims(db, T0)).some(c => c.id === 'capabilities.built'));
});

test('T22-4: a claim older than its freshness limit is withdrawn', async () => {
  const db = await setup();
  await runProbes(ports(db));
  assert.ok((await publishableClaims(db, T0)).some(c => c.id === 'operation.tick-running'));
  const later = T0 + 3 * H; // max_age_hours is 2
  assert.ok(!(await publishableClaims(db, later)).some(c => c.id === 'operation.tick-running'));
  const done = await withdrawStale({ db, now: later });
  assert.ok(done.includes('operation.tick-running'));
  assert.equal(claimRow(db, 'operation.tick-running').withdrawn, 1);
  assert.ok(row(db, `SELECT id FROM items WHERE id = 'DESCRIBE-operation.tick-running'`));
  assert.ok(!done.includes('scope.out-of-scope'), 'a claim with a longer limit stays');
});

test('non-public claims are not probed or published', async () => {
  const db = await setup({ seed: false });
  await addClaims(db, [{ id: 'x.hidden', text: 'h', probe: 'file:SCOPE.md', expect: 'exists', public: 0 }]);
  const r = await runProbes(ports(db));
  assert.equal(r.checked, 0);
  assert.equal((await publishableClaims(db, T0)).length, 0);
});

test('T22-5 and R03: the model lists PLANNED and open risks with the same prominence as capabilities', async () => {
  const db = await setup();
  db.raw.exec(`INSERT INTO items (id,title,owner_role,done_check,status) VALUES ('RISK-1','provider limit unknown','ops','x','blocked')`);
  await runProbes(ports(db));
  const model = await buildSelfModel({ db, specStatus: SPEC, packs: [{ id: 'outreach', enabled: false }], scope: {}, now: T0 });
  assert.deepEqual(model.sections.map(s => s.key).slice(0, 2), ['purpose', 'capabilities']);
  assert.deepEqual(model.facts.limits.planned_names, SPEC.planned_names);
  assert.deepEqual(model.facts.limits.blocked_items, ['RISK-1']);
  assert.equal(model.facts.capabilities.planned, 3);
  assert.equal(model.facts.performance.predictions_scored, 2);
  assert.ok(model.sections.find(s => s.key === 'limits').claim_ids.includes('limits.planned'));
  const claims = await publishableClaims(db, T0);
  const out = await render(model, claims);
  assert.match(out.page, /^## Capabilities$/m);
  assert.match(out.page, /^## Limits and PLANNED$/m);
  assert.match(out.page, /US-SPEC-22 describe loop/);
  assert.match(out.statement, /PLANNED/);
  assert.match(out.statement, /BUILT/);
  assert.match(out.page, /> I want a small shop site/);
});

test('a section with no published claim says so instead of staying silent', async () => {
  const db = await setup();
  await runProbes(ports(db, { specStatus: null }));
  const model = await buildSelfModel({ db, specStatus: null, now: T0 });
  assert.ok(model.warnings.includes('section limits has no published claim') || model.sections.find(s => s.key === 'limits').claim_ids.length > 0);
  const out = await render(model, await publishableClaims(db, T0));
  assert.match(out.page, /## Capabilities\n\n_No published claim for this section\._/);
});

test('T22-3 and R04: the three forms contain the same set of claim ids', async () => {
  const db = await setup();
  await runProbes(ports(db));
  const claims = await publishableClaims(db, T0);
  const out = await render(await buildSelfModel({ db, specStatus: SPEC, now: T0 }), claims);
  const ids = extractClaimIds(out.page);
  assert.ok(ids.length >= 6);
  assert.deepEqual(extractClaimIds(out.statement), ids);
  assert.deepEqual(extractClaimIds(out.llms), ids);
  const json = JSON.parse(out.json);
  assert.deepEqual([...json.claim_ids].sort(), ids);
  assert.deepEqual(json.sections.flatMap(s => s.claims.map(c => c.id)).sort(), ids);
  assert.equal(out.statement.trim().split('\n').length, 1, 'the short statement is one paragraph');
  assert.match(out.llms, /^# /);
  assert.ok(!out.llms.includes('<'));
});

test('R06: numbers carry their date; every sentence carries a claim id', async () => {
  const db = await setup();
  await runProbes(ports(db));
  const claims = await publishableClaims(db, T0);
  const out = await render(await buildSelfModel({ db, specStatus: SPEC, now: T0 }), claims);
  for (const f of ['statement', 'page', 'llms']) assert.deepEqual(checkVoice(out[f], claims, voice).violations, [], f);
  assert.match(out.page, /As of 2026-11-11, 12 specified capabilities are marked BUILT \[claim:capabilities\.built\]\./);
  // a claim whose text has {value} but no {date} gets the date appended
  await addClaims(db, [{ id: 'performance.nodate', text: '{value} things happened.', probe: 'sql:SELECT 4 AS value', expect: '=4' }]);
  await runProbes(ports(db));
  const c2 = await publishableClaims(db, T0);
  const out2 = await render(await buildSelfModel({ db, specStatus: SPEC, now: T0 }), c2);
  assert.match(out2.page, /4 things happened \(as of 2026-11-11\) \[claim:performance\.nodate\]\./);
});

test('T22-2: a sentence with no registry claim is rejected by the checker', async () => {
  const db = await setup();
  await runProbes(ports(db));
  const claims = await publishableClaims(db, T0);
  const good = `As of 2026-11-11, 12 specified capabilities are marked BUILT [claim:capabilities.built].`;
  assert.equal(checkVoice(good, claims, voice).ok, true);
  for (const [text, rule] of [
    ['We are the most reliable system around.', 'no_claim'],
    ['We have shipped for ten customers [claim:made.up].', 'unknown_claim'],
    ['As of 2026-11-11, 99 specified capabilities are marked BUILT [claim:capabilities.built].', 'number_not_in_claim'],
  ]) {
    const r = checkVoice(text, claims, voice);
    assert.equal(r.ok, false, text);
    assert.equal(r.violations[0].rule, rule);
  }
  // a claim that exists in the registry but was withdrawn is not "a registry claim" for output purposes
  const without = claims.filter(c => c.id !== 'capabilities.built');
  assert.equal(checkVoice(good, without, voice).violations[0].rule, 'unknown_claim');
});

test('R06/R07: numbers without a date, estimates labeled, banned phrases from the rules data', async () => {
  const db = await setup();
  await runProbes(ports(db));
  const claims = [{ id: 'k.n', text: 'There are 5 things.', evidence: null, last_checked_at: '2026-11-11 10:00:00' }, { id: 'k.e', text: 'It is a revolutionary and world-class tool.', evidence: null }];
  assert.equal(checkVoice('There are 5 things [claim:k.n].', claims, voice).violations[0].rule, 'number_without_date');
  assert.equal(checkVoice('There are 5 things, an estimate [claim:k.n].', claims, voice).ok, true);
  const r = checkVoice('It is a revolutionary and world-class tool [claim:k.e].', claims, voice);
  assert.deepEqual(r.violations.map(v => v.detail), ['world-class', 'revolutionary'].sort((a, b) => voice.banned.indexOf(a) - voice.banned.indexOf(b)));
  assert.equal(r.version, voice.version);
  assert.equal(checkVoice('It is a revolutionary tool [claim:k.e].', claims, { banned: [] }).ok, true, 'rules are data: no rules, no ban');
});

test('R08: out-of-scope outputs mentioned as done are rejected unless the pack is enabled', () => {
  const claims = [{ id: 'k.m', text: 'The organization runs marketing campaigns.', evidence: null }, { id: 'k.n', text: 'The organization does not run marketing.', evidence: null }];
  const r = checkVoice('The organization runs marketing campaigns [claim:k.m].', claims, voice);
  assert.equal(r.violations[0].rule, 'out_of_scope');
  assert.equal(checkVoice('The organization runs marketing campaigns [claim:k.m].', claims, voice, { enabledPacks: ['outreach'] }).ok, true);
  assert.equal(checkVoice('The organization does not run marketing [claim:k.n].', claims, voice).ok, true, 'saying what it does not do is fine');
  assert.ok(parseScopeMd(readFileSync(new URL('../../SCOPE.md', import.meta.url), 'utf8')).length >= 4);
});

test('R05: a compose port may phrase text but cannot add a claim; the loop rejects and files an item', async () => {
  const db = await setup();
  const phrased = ({ claims }) => claims.map(c => `- Good news: ${c.sentence}`).join('\n');
  let r = await describeOnce(ports(db, { voiceRules: voice, compose: phrased }));
  assert.equal(r.stored, true, 'rewording that keeps the claim ids passes');
  const adds = ({ form, claims }) => defaultCompose({ form, claims }) + (form === 'statement' ? ' It also cures every known disease.' : '\n- It also cures every known disease.');
  const before = rows(db, `SELECT id FROM describe_outputs`).length;
  r = await describeOnce(ports(db, { now: T0 + 1000, voiceRules: voice, compose: adds }));
  assert.equal(r.stored, false);
  assert.equal(r.problems[0].violations[0].rule, 'no_claim');
  assert.equal(rows(db, `SELECT id FROM describe_outputs`).length, before, 'rejected output is not stored');
  assert.match(row(db, `SELECT title FROM items WHERE id LIKE 'DESCRIBE-voice-%'`).title, /Voice check rejected/);
  // a writer that smuggles a different number under a valid claim id is also caught
  const smuggle = ({ claims }) => claims.map(c => `- ${c.sentence.replace(/12/, '1200')}`).join('\n');
  r = await describeOnce(ports(db, { now: T0 + 2000, voiceRules: voice, compose: smuggle }));
  assert.equal(r.stored, false);
});

test('R07: the checker is injected, so a different agent from the writer can run it', async () => {
  const db = await setup();
  const calls = [];
  const checker = (text, claims, rules, opts) => { calls.push(opts); return { ok: false, version: 'x', violations: [{ sentence: 's', rule: 'external', detail: 'no' }] }; };
  const r = await describeOnce(ports(db, { voiceRules: voice, checker, packs: [{ id: 'outreach', enabled: true }] }));
  assert.equal(r.stored, false);
  assert.deepEqual(calls[0], { enabledPacks: ['outreach'] });
});

test('R09: the describe step plugs into runTick, writes only to the db and never calls fetch for publishing', async () => {
  const db = await setup();
  const fetched = [];
  const fetch = async (u, init) => { fetched.push([u, init?.method]); return new Response('ok', { status: 200 }); };
  await addClaims(db, [{ id: 'operation.site-up', text: 'The check page answers.', probe: 'http:https://site.example/ok', expect: 'status:200' }]);
  const res = await runTick(db, { config: { org_slug: 't', claim_ttl_minutes: 120, max_wip_per_role: 3, plus_share: 0.2, policy }, now: T0, extraSteps: describeExtraSteps({ fetch, readFile, specStatus: SPEC, voiceRules: voice }) });
  assert.equal(res.errors.length, 0, res.errors.join(';'));
  assert.equal(res.completed, res.total);
  assert.match(res.report, /describe: \d+\/\d+ claims pass/);
  assert.equal(rows(db, `SELECT form FROM describe_outputs`).length, 4);
  assert.deepEqual(fetched, [['https://site.example/ok', 'GET']], 'only the probe GET; nothing is published');
  assert.deepEqual(describeExtraSteps().map(s => s.name), ['describe']);
});

test('handle serves /describe, /describe.json and /llms.txt, and re-renders when a stored claim goes stale', async () => {
  const db = await setup();
  await describeOnce(ports(db, { voiceRules: voice }));
  const ctx = { db, now: T0 + 1000, specStatus: SPEC, voiceRules: voice };
  const get = async (p, c = ctx, method = 'GET') => handle(new Request('https://x.example' + p, { method }), c);
  let r = await get('/describe');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /markdown/);
  const page = await r.text();
  assert.match(page, /## Limits and PLANNED/);
  r = await get('/describe.json');
  assert.equal(r.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.deepEqual(JSON.parse(await r.text()).claim_ids, extractClaimIds(page));
  r = await get('/llms.txt');
  assert.match(r.headers.get('content-type'), /text\/plain/);
  assert.deepEqual(extractClaimIds(await r.text()), extractClaimIds(page));
  assert.equal((await get('/nothing')).status, 404);
  assert.equal((await get('/describe', ctx, 'POST')).status, 405);
  // three hours later the 2-hour tick claim is stale: the page no longer carries it
  r = await get('/describe', { ...ctx, now: T0 + 3 * H });
  const later = await r.text();
  assert.ok(extractClaimIds(page).includes('operation.tick-running'));
  assert.ok(!extractClaimIds(later).includes('operation.tick-running'));
  // an empty registry serves a 404, not an invented page
  const empty = await setup({ seed: false });
  assert.equal((await handle(new Request('https://x.example/describe'), { db: empty, now: T0 })).status, 404);
});

test('R01 completeness: every claim id in the registry has a probe kind and expect; seeds name no tenant', () => {
  for (const c of loadSeedClaims()) {
    assert.match(c.probe, /^(sql|file|http|spec):.+/, c.id);
    assert.ok(c.expect && c.max_age_hours > 0, c.id);
  }
  const ids = loadSeedClaims().map(c => c.id);
  for (const k of ['operation.tick-running', 'performance.predictions-scored', 'capabilities.built', 'packs.enabled']) assert.ok(ids.includes(k), k);
});
