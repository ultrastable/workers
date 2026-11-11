// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Test kit for core/runner: a fake Vcs port, a fake router, and a seeded database. No network.
import { fileURLToPath } from 'node:url';
import { makeDb } from '../_shared/testdb.js';
import * as claims from '../claims/index.js';
import { createRunner } from './index.js';

const dir = rel => fileURLToPath(new URL(rel, import.meta.url));
export const MIGS = [dir('../claims/migrations/'), dir('../router/migrations/'), dir('./migrations/')];
export const T0 = Date.parse('2026-11-11T10:00:00Z');

export const goodPatch = (path = 'core/example/widget.js', content = '// widget v2\n') =>
  JSON.stringify({ summary: 'implement the widget', files: [{ path, content }] });
export const approve = JSON.stringify({ verdict: 'approve', reasons: ['diff matches the done check'] });
export const reject = JSON.stringify({ verdict: 'reject', reasons: ['edge case is not handled'] });

// checksScript: array of 'success' | 'failure' | 'pending', one consumed per getChecks call (the last repeats).
export function fakeVcs({ files = {}, checksScript = ['success'] } = {}) {
  const v = { files: { ...files }, branches: [], commits: [], prs: [], getChecksCalls: 0, diffs: 0 };
  v.getFile = async (p) => (p in v.files ? v.files[p] : null);
  v.createBranch = async (name) => { if (!v.branches.includes(name)) v.branches.push(name); return { name, sha: 'base' }; };
  v.commitFiles = async ({ branch, message, files: fs }) => { const sha = 'sha' + (v.commits.length + 1); v.commits.push({ branch, message, files: fs, sha }); return { sha }; };
  v.openDraftPr = async (a) => { v.prs.push(a); return { number: 100 + v.prs.length, url: `https://vcs.example/pr/${100 + v.prs.length}` }; };
  v.getChecks = async () => {
    const s = checksScript[Math.min(v.getChecksCalls++, checksScript.length - 1)];
    return { state: s, checks: [{ name: 'unit-tests', state: s, detail: s === 'failure' ? 'assertion failed in widget.test' : s }] };
  };
  v.getDiff = async () => { v.diffs++; return '--- a/core/example/widget.js\n+++ b/core/example/widget.js\n@@\n+// widget v2\n'; };
  return v;
}

// script: { doer: [text|{refusal}|{text,cost}], reviewer: [...] }; one entry consumed per call of that kind (last repeats).
export function fakeRouter(script = {}, { db, costPerCall = 0.01 } = {}) {
  const r = { requests: [], idx: { doer: 0, reviewer: 0 }, killed: false, predictionSeenBeforeDoer: [] };
  r.route = async () => (r.killed ? { ok: false, refusal: 'kill_switch_all' } : { ok: true });
  r.call = async (req) => {
    r.requests.push(req);
    if (req.kind === 'doer' && db) r.predictionSeenBeforeDoer.push(!!(await db.prepare(`SELECT 1 AS x FROM predictions WHERE item_id = ?`).bind(req.item_id).first()));
    const list = script[req.kind] || [];
    const e = list[Math.min(r.idx[req.kind]++, list.length - 1)];
    if (r.killed) return { ok: false, refusal: 'kill_switch_all', attempts: [] };
    if (e && typeof e === 'object' && e.refusal) return { ok: false, refusal: e.refusal, attempts: [] };
    const cost = e && typeof e === 'object' && e.cost != null ? e.cost : costPerCall;
    const text = e && typeof e === 'object' ? e.text : e;
    return { ok: true, text, provider: req.kind === 'doer' ? 'provider-a' : 'provider-b', model: req.kind === 'doer' ? 'a-medium' : 'b-medium', cost_usd: cost, attempts: [] };
  };
  return r;
}

export function seedItem(db, id = 'US-SPEC-11-1', extra = {}) {
  const doneCheck = extra.done_check ?? 'spec: US-SPEC-11 R03; target: core/example/widget.js; test: core/example/widget.test.js; failing test: widget renders';
  db.raw.prepare(`INSERT INTO items (id, title, owner_role, done_check, priority, status) VALUES (?,?,?,?,?, 'ready')`)
    .run(id, extra.title ?? 'Build: widget (US-SPEC-11)', extra.owner_role ?? 'staff', doneCheck, extra.priority ?? 10);
}

export function setup({ script, checksScript, config = {}, files, costPerCall, extraItems = [] } = {}) {
  const db = makeDb(MIGS);
  const clock = { t: T0 };
  const now = () => clock.t;
  seedItem(db);
  for (const id of extraItems) seedItem(db, id);
  const vcs = fakeVcs({ files: files ?? { 'core/example/widget.js': '// widget v1\n', 'core/example/widget.test.js': '// test\n' }, checksScript });
  const router = fakeRouter(script ?? { doer: [goodPatch()], reviewer: [approve] }, { db, costPerCall });
  const cfg = { runner: { enabled: true, ...config } };
  const mk = (over = {}) => createRunner({ db, now, config: cfg, env: {}, router, claims, vcs, ...over });
  return { db, clock, vcs, router, runner: mk(), mk, now };
}

export async function until(runner, db, pred, max = 40) {
  for (let i = 0; i < max; i++) { await runner.step(); if (pred()) return i + 1; }
  throw new Error('condition not reached; runs: ' + JSON.stringify(db.raw.prepare('SELECT id,state,reason,last_error FROM runner_runs').all()));
}
export const runs = db => db.raw.prepare('SELECT * FROM runner_runs ORDER BY id').all();
export const states = db => db.raw.prepare('SELECT to_state FROM runner_events ORDER BY id').all().map(r => r.to_state);
