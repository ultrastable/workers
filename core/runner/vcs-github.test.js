// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Tests for the GitHub Vcs adapter and for the rule that the token never reaches stored rows, logs or errors.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as claims from '../claims/index.js';
import { createRunner } from './index.js';
import { createGithubVcs } from './vcs-github.js';
import { setup, fakeRouter, goodPatch, approve, until, runs } from './testkit.js';

const TOKEN = 'ghp_TESTTOKEN_do_not_leak_0123456789';
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });

// A tiny in-memory GitHub: just the endpoints the adapter uses.
function fakeGithub({ checkRuns = [{ name: 'ci', status: 'completed', conclusion: 'success' }], failNetwork = false } = {}) {
  const log = [];
  const st = { files: { 'core/example/widget.js': 'v1 é', 'core/example/widget.test.js': 't' }, refs: { main: 'sha-main' } };
  const f = async (url, init = {}) => {
    const u = new URL(url); const p = u.pathname.replace('/repos/o/r', '');
    log.push({ method: init.method, path: p, auth: init.headers?.authorization, body: init.body });
    if (failNetwork) throw new Error('socket hang up while sending ' + init.headers.authorization);
    let m;
    if ((m = p.match(/^\/contents\/(.+)$/))) {
      const name = decodeURIComponent(m[1]);
      if (!(name in st.files)) return json({ message: 'Not Found' }, 404);
      return json({ type: 'file', encoding: 'base64', content: Buffer.from(st.files[name], 'utf8').toString('base64') });
    }
    if ((m = p.match(/^\/git\/ref\/heads\/(.+)$/))) return st.refs[decodeURIComponent(m[1])] ? json({ object: { sha: st.refs[decodeURIComponent(m[1])] } }) : json({}, 404);
    if (p === '/git/refs' && init.method === 'POST') {
      const b = JSON.parse(init.body); const name = b.ref.replace('refs/heads/', '');
      if (st.refs[name]) return json({ message: 'Reference already exists' }, 422);
      st.refs[name] = b.sha; return json({ ref: b.ref }, 201);
    }
    if ((m = p.match(/^\/git\/commits\/(.+)$/)) && init.method === 'GET') return json({ tree: { sha: 'tree-' + m[1] } });
    if (p === '/git/trees') { st.lastTree = JSON.parse(init.body); return json({ sha: 'tree-new' }, 201); }
    if (p === '/git/commits') { st.lastCommit = JSON.parse(init.body); return json({ sha: 'commit-' + log.length }, 201); }
    if ((m = p.match(/^\/git\/refs\/heads\/(.+)$/)) && init.method === 'PATCH') { st.refs[decodeURIComponent(m[1])] = JSON.parse(init.body).sha; return json({}); }
    if (p === '/pulls') { st.pr = JSON.parse(init.body); return json({ number: 7, html_url: 'https://github.example/o/r/pull/7' }, 201); }
    if (/\/check-runs$/.test(p)) return json({ check_runs: checkRuns });
    if (/\/status$/.test(p)) return json({ statuses: [] });
    if (p.startsWith('/compare/')) return new Response('diff --git a/x b/x\n+new', { status: 200 });
    return json({ message: 'unexpected ' + p }, 500);
  };
  return { f, log, st };
}

test('the adapter implements the port and cannot merge', async () => {
  const gh = fakeGithub();
  const vcs = createGithubVcs({ fetch: gh.f, repo: 'o/r', env: { VCS_TOKEN: TOKEN } });
  assert.deepEqual(Object.keys(vcs).sort(), ['commitFiles', 'createBranch', 'getChecks', 'getDiff', 'getFile', 'openDraftPr']);
  assert.equal(await vcs.getFile('core/example/widget.js'), 'v1 é');
  assert.equal(await vcs.getFile('nope.txt'), null);
  assert.deepEqual(await vcs.createBranch('runner/x'), { name: 'runner/x', sha: 'sha-main', existed: false });
  assert.equal((await vcs.createBranch('runner/x')).existed, true); // idempotent for resumed runs
  const { sha } = await vcs.commitFiles({ branch: 'runner/x', message: 'm', files: [{ path: 'a/b.js', content: 'c' }] });
  assert.equal(gh.st.refs['runner/x'], sha);
  assert.equal(gh.st.lastTree.base_tree, 'tree-sha-main'); assert.equal(gh.st.lastTree.tree[0].path, 'a/b.js');
  const pr = await vcs.openDraftPr({ branch: 'runner/x', title: 't', body: 'b' });
  assert.equal(gh.st.pr.draft, true); assert.equal(gh.st.pr.base, 'main'); assert.equal(pr.number, 7);
  assert.match(await vcs.getDiff('main', 'runner/x'), /\+new/);
  assert.ok(gh.log.every(l => l.auth === 'Bearer ' + TOKEN));
});

test('getChecks: pending until something reports; failure wins; success needs all done', async () => {
  const mk = checkRuns => createGithubVcs({ fetch: fakeGithub({ checkRuns }).f, repo: 'o/r', env: { VCS_TOKEN: TOKEN } });
  assert.equal((await mk([]).getChecks('s')).state, 'pending');
  assert.equal((await mk([{ name: 'a', status: 'in_progress' }, { name: 'b', status: 'completed', conclusion: 'success' }]).getChecks('s')).state, 'pending');
  assert.equal((await mk([{ name: 'a', status: 'completed', conclusion: 'failure' }, { name: 'b', status: 'in_progress' }]).getChecks('s')).state, 'failure');
  assert.equal((await mk([{ name: 'a', status: 'completed', conclusion: 'success' }, { name: 'b', status: 'completed', conclusion: 'skipped' }]).getChecks('s')).state, 'success');
});

test('a missing token or bad repo fails closed without a request', async () => {
  const gh = fakeGithub();
  const vcs = createGithubVcs({ fetch: gh.f, repo: 'o/r', env: {} });
  await assert.rejects(() => vcs.getFile('x'), /not set/);
  assert.equal(gh.log.length, 0);
  assert.throws(() => createGithubVcs({ fetch: gh.f, repo: 'bad', env: {} }), /owner\/name/);
});

test('the token never appears in stored rows, errors or logs across a full run', async () => {
  const logs = [];
  const orig = { log: console.log, error: console.error, warn: console.warn };
  console.log = console.error = console.warn = (...a) => logs.push(a.join(' '));
  try {
    const env = { VCS_TOKEN: TOKEN };
    const vcs = createGithubVcs({ fetch: fakeGithub().f, repo: 'o/r', env });
    const base = setup();
    const router = fakeRouter({ doer: [goodPatch()], reviewer: [approve] }, { db: base.db });
    const runner = createRunner({ db: base.db, now: base.now, config: { runner: { enabled: true } }, env, router, claims, vcs });
    await until(runner, base.db, () => runs(base.db).some(r => r.state === 'pr_opened'));
    // a second run whose network fails with the token in the message
    const bad = setup();
    const badVcs = createGithubVcs({ fetch: fakeGithub({ failNetwork: true }).f, repo: 'o/r', env });
    const badRunner = createRunner({ db: bad.db, now: bad.now, config: { runner: { enabled: true, max_errors: 2 } }, env, router: bad.router, claims, vcs: badVcs });
    await until(badRunner, bad.db, () => runs(bad.db).some(r => r.state === 'refused'));
    for (const db of [base.db, bad.db]) {
      const names = db.raw.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map(r => r.name);
      for (const n of names) assert.ok(!JSON.stringify(db.raw.prepare(`SELECT * FROM ${n}`).all()).includes(TOKEN), `token leaked into ${n}`);
    }
    const why = bad.db.raw.prepare('SELECT why_gated FROM gate_cards').get().why_gated;
    assert.match(why, /socket hang up/); assert.match(why, /redacted/);
    const direct = await badVcs.getFile('x').catch(e => e.message);
    assert.ok(!direct.includes(TOKEN));
    assert.ok(!logs.join('\n').includes(TOKEN));
  } finally { Object.assign(console, orig); }
});
