// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDownstreamGithub } from './downstream.js';

const TOKEN = 'ghs_INSTALLATION_TOKEN_secret';
const json = (o, status = 200) => new Response(JSON.stringify(o), { status });
function fakeGithub() {
  const log = []; const issues = [];
  const f = async (url, init = {}) => {
    const p = new URL(url).pathname;
    log.push({ method: init.method, path: p, auth: init.headers.authorization, body: init.body });
    if (p === '/search/issues') return json({ items: issues });
    if (p === '/repos/o/r/issues' && init.method === 'POST') { const b = JSON.parse(init.body); const i = { number: issues.length + 1, html_url: 'https://github.com/o/r/issues/' + (issues.length + 1), body: b.body }; issues.push(i); return json(i, 201); }
    if (p === '/repos/o/r/pulls' && init.method === 'POST') return json({ number: 7, html_url: 'u' }, 201);
    if (p === '/repos/o/r/pulls/7/merge') return json({ merged: true });
    if (p === '/repos/o/r/pulls/8/merge') return json({ message: 'Required status check is expected' }, 405);
    return json({}, 404);
  };
  return { f, log, issues };
}
const mk = g => createDownstreamGithub({ fetch: g.f, repo: 'o/r', tokenProvider: async () => TOKEN });

test('openIssue goes through the App token and is idempotent per key', async () => {
  const g = fakeGithub(); const d = mk(g);
  const a = await d.openIssue({ key: 'brief-1', title: 'Brief 1', body: 'do it' });
  const b = await d.openIssue({ key: 'brief-1', title: 'Brief 1', body: 'do it' });
  assert.equal(a.created, true); assert.equal(b.created, false); assert.equal(a.number, b.number);
  assert.equal(g.issues.length, 1);
  assert.ok(g.log.every(l => l.auth === 'Bearer ' + TOKEN));
});

test('PRs are drafts; the merge host merges and reports a refusal without throwing', async () => {
  const g = fakeGithub(); const d = mk(g);
  assert.equal((await d.openDraftPr({ branch: 'x', title: 't' })).number, 7);
  assert.equal(JSON.parse(g.log.at(-1).body).draft, true);
  const host = d.mergeHost();
  assert.equal(host.name, 'github-app');
  assert.deepEqual(await host.merge({ pr: 7 }), { merged: true });
  const bad = await host.merge({ pr: 8 });
  assert.equal(bad.merged, false); assert.match(bad.reason, /405|status check/);
});

test('refuses to exist without an App token provider; the token never appears in errors', async () => {
  assert.throws(() => createDownstreamGithub({ fetch, repo: 'o/r' }), /tokenProvider is required/);
  assert.throws(() => createDownstreamGithub({ fetch, repo: 'nope', tokenProvider: async () => 'x' }), /owner\/name/);
  const d = createDownstreamGithub({ fetch: async () => { throw new Error('boom ' + TOKEN); }, repo: 'o/r', tokenProvider: async () => TOKEN });
  await assert.rejects(d.openDraftPr({ branch: 'b', title: 't' }), e => !e.message.includes(TOKEN));
});

test('merge through codeloop is still gated: a rung below the minimum never reaches the host', async () => {
  const { mergeDecision } = await import('../codeloop/index.js');
  const d = mergeDecision({ run: { state: 'approved', pr_number: 7, checks: 'pass' }, files: [], rung: 'observed', killed: false }, { merge_min_rung: 'autonomous', max_files: 20, protected_paths: [] });
  assert.equal(d.ok, false);
});
