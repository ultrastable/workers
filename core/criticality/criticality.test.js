// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// The criticality drill (CRIT-1..7, US-SPEC-10 kit, US-SPEC-20 stage 3 path, US-SPEC-17 stall as a failure mode).
// A brand-new deployment is made by the real bootstrapper from the stock idea file, then ticked with nobody prompting it.
// It must turn its own outcomes into specifications, the specifications into code items, and the items into merged
// changes. On 2026-11-15 the same drill finished 0 items and started 0 runs in 36 ticks; each cause is named below.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeDb } from '../_shared/testdb.js';
import { OUT_DIR } from '../../tools/build_migrations.mjs';
import { createOrg } from '../org/index.js';
import { create } from './index.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const T0 = Date.parse('2026-11-15T10:00:00Z');
const approve = JSON.stringify({ verdict: 'approve', reasons: ['the change matches the done check'] });

// Run the real bootstrapper (dry run) on a copy of this repository, so the drill uses exactly what a new deployment gets.
let BOOT = null;
async function bootstrap() {
  if (BOOT) return BOOT;
  const dir = mkdtempSync(path.join(tmpdir(), 'crit-'));
  cpSync(ROOT, dir, { recursive: true, filter: src => !/(^|[\\/])(\.git|node_modules)([\\/]|$)/.test(path.relative(ROOT, src)) });
  try { execFileSync('python3', ['bootstrap/bootstrap.py', '--dry-run'], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH } }); } catch (e) { if (e.status !== 2) throw e; } // 2 = degraded stages, expected with no credentials
  const config = (await import(pathToFileURL(path.join(dir, 'adapters/cloudflare/src/config.js')).href)).default;
  BOOT = { config, seed: readFileSync(path.join(dir, 'org/seed.sql'), 'utf8') };
  rmSync(dir, { recursive: true, force: true });
  return BOOT;
}

// One repository shared by the version-control port, the merge host and the code host the specification loop reads.
function world() {
  const w = { files: {}, branches: {}, prs: {}, merged: [], doer: 0 };
  w.vcs = {
    getFile: async p => (p in w.files ? w.files[p] : null),
    createBranch: async name => { w.branches[name] = w.branches[name] || []; return { name, sha: 'base' }; },
    commitFiles: async ({ branch, files }) => { (w.branches[branch] = w.branches[branch] || []).push(...files); return { sha: 'sha' + Object.keys(w.branches).length }; },
    openDraftPr: async a => { const number = 100 + Object.keys(w.prs).length + 1; w.prs[number] = a.branch || a.head; return { number, url: `https://vcs.example/pr/${number}` }; },
    getChecks: async () => ({ state: 'success', checks: [{ name: 'unit-tests', state: 'success', detail: 'success' }] }),
    getDiff: async () => '+ change\n',
  };
  w.mergeHosts = [{ name: 'test-host', merge: async ({ pr }) => { for (const f of w.branches[w.prs[pr]] || []) w.files[f.path] = f.content; w.merged.push(pr); return { merged: true }; } }];
  w.fetch = async url => {
    const u = String(url), ok = b => new Response(typeof b === 'string' ? b : JSON.stringify(b), { status: 200 });
    let m;
    if (u.includes('/contents/specs?')) { const l = Object.keys(w.files).filter(p => p.startsWith('specs/')).map(p => ({ name: p.slice(6) })); return l.length ? ok(l) : new Response('{}', { status: 404 }); }
    if ((m = /\/contents\/(specs\/[^?]+)/.exec(u))) return m[1] in w.files ? ok(w.files[m[1]]) : new Response('{}', { status: 404 });
    if (u.includes('/git/trees/')) return ok({ tree: Object.keys(w.files).map(p => ({ path: p })) });
    return new Response('{}', { status: 404 });
  };
  // A doer that does what the item says: writes the specification when the target is one, else the code, its test and the label.
  w.router = {
    route: async () => ({ ok: true }),
    call: async req => {
      if (req.kind !== 'doer') return { ok: true, text: approve, provider: 'b', model: 'b-small', cost_usd: 0.001, attempts: [] };
      w.doer++;
      const user = JSON.parse(req.messages[1].content), out = [], testPath = user.test && (user.test.path || user.test);
      const targets = user.files.map(f => f.path), specPath = targets.find(p => /^specs\/US-SPEC-\d+.*\.md$/.test(p)), code = targets.find(p => p !== specPath);
      if (specPath && !code) {
        const id = /US-SPEC-\d+/.exec(specPath)[0], n = id.slice(-2);
        out.push({ path: specPath, content: `# ${id} ${user.task.title}\n\n- ${id}-R01 The system MUST do the first part.\n- ${id}-R02 The system MUST do the second part.\n\n## Reference implementation status\n\n| Capability | Status |\n|---|---|\n| First part | PLANNED (\`app/s${n}/first.js\`) |\n| Second part | PLANNED (\`app/s${n}/second.js\`) |\n` });
      } else {
        out.push({ path: code, content: '// built\nexport const built = true;\n' });
        if (testPath) out.push({ path: testPath, content: '// test\n' });
        if (specPath) out.push({ path: specPath, content: user.files.find(f => f.path === specPath).content.replace(`PLANNED (\`${code}\`)`, `BUILT (\`${code}\`, \`${testPath}\`)`) });
      }
      return { ok: true, text: JSON.stringify({ summary: 'done as specified', files: out }), provider: 'a', model: 'a-medium', cost_usd: 0.01, attempts: [] };
    },
  };
  return w;
}

async function deploy({ env }) {
  const { config, seed } = await bootstrap();
  const db = makeDb([OUT_DIR]); db.raw.exec(seed);
  const w = world(), clock = { t: T0 };
  const mk = e => createOrg({ db, env: e, config, fetch: w.fetch, now: () => clock.t, vcs: w.vcs, router: w.router, mergeHosts: w.mergeHosts });
  const state = { env };
  const ticks = async n => { let last; for (let i = 0; i < n; i++) { clock.t += 600e3; last = await mk(state.env).tick(); } return last; };
  const q = (sql, ...a) => db.raw.prepare(sql).all(...a);
  return { db, w, ticks, q, state, config };
}
const CREDS = { GITHUB_TOKEN: 'test-token-000001', ANTHROPIC_API_KEY: 'test-key-0000002', CONSOLE_TOKEN: 'test-console-003' };

test('CRIT-1: the bootstrapper writes a configuration that carries the whole build loop', async () => {
  const { config } = await bootstrap();
  assert.match(config.vcs.repo, /^[\w.-]+\/[\w.-]+$/);
  assert.ok(Object.keys(config.router.providers).length >= 2, 'two model routes, one of them keyless');
  assert.ok(Object.values(config.router.providers).some(p => p.kind === 'workers_ai'));
  for (const k of ['runner', 'codeloop', 'specloop', 'criticality']) assert.equal(config[k].enabled, true, `${k} is on in a new deployment`);
});

test('the drill: a new deployment with its credentials builds its outcomes into merged code with nobody prompting it', async () => {
  const d = await deploy({ env: CREDS });
  const last = await d.ticks(160);
  assert.equal(last.completed, last.total, 'every step of the last tick completed: ' + JSON.stringify(last.errors));
  const outs = d.q(`SELECT id, status FROM items WHERE id LIKE 'OUT-%' ORDER BY id`);
  assert.ok(outs.length >= 3 && outs.every(o => o.status === 'done'), 'every first outcome was specified: ' + JSON.stringify(outs));
  const specs = Object.keys(d.w.files).filter(p => p.startsWith('specs/'));
  assert.ok(specs.length >= outs.length, 'a specification file was written and merged for each outcome');
  const built = d.q(`SELECT id, status FROM items WHERE project='spec-to-code'`);
  assert.ok(built.length >= 2 * outs.length, 'the specifications became code items by themselves');
  assert.ok(built.every(b => b.status === 'done'), 'every specified capability was built and merged: ' + JSON.stringify(built.filter(b => b.status !== 'done')));
  // Two runs on one specification each replace the whole file from the base they read, so one label flip can be lost; the
  // loop does not depend on the label: a verified merge plus the code and test existing closes the line (label_stale).
  assert.ok(specs.some(p => /BUILT/.test(d.w.files[p])), 'status labels are flipped by the doer in the same change');
  assert.ok(Object.keys(d.w.files).some(p => /^app\/s\d+\/first\.js$/.test(p)), 'the code the specification names exists in the repository');
  const sr = JSON.parse(d.q(`SELECT value FROM org WHERE key='spec_remaining'`)[0].value);
  assert.equal(sr.remaining, 0); assert.ok(sr.BUILT >= 2 * outs.length);
  // the kit items the tick can prove closed by their probes
  for (const id of ['KIT-0', 'KIT-1', 'KIT-2', 'KIT-3', 'KIT-4']) assert.equal(d.q(`SELECT status FROM items WHERE id=?`, id)[0].status, 'done', id);
  // nothing waits for a person to name a file, pick a target or start a run
  assert.equal(d.q(`SELECT COUNT(*) n FROM items WHERE disposition LIKE 'awaiting target%' OR blocker LIKE 'runner no_target%'`)[0].n, 0);
  assert.equal(d.q(`SELECT COUNT(*) n FROM gate_cards WHERE id LIKE 'runner-%' AND status='open'`)[0].n, 0);
  assert.equal(d.q(`SELECT COUNT(*) n FROM items WHERE id='CRIT-STALL' AND status NOT IN ('done')`)[0].n, 0, 'no stall is open');
  assert.ok(d.q(`SELECT COUNT(*) n FROM criticality_log WHERE regime='self-sustaining'`)[0].n > 0, 'the loop measured itself as self-sustaining');
  assert.ok(d.w.merged.length >= 3 * outs.length);
  // every merge was scored on the trust ledger's own surface
  assert.ok(d.q(`SELECT COUNT(*) n FROM outcomes WHERE surface='repo' AND action_class='merge' AND result='verified'`)[0].n >= d.w.merged.length);
});

test('with no credentials the deployment does not idle silently: the stall names its root cause, and it resumes by itself when they arrive', async () => {
  const d = await deploy({ env: {} });
  await d.ticks(24);
  assert.equal(d.w.doer, 0);
  const stall = d.q(`SELECT title, status FROM items WHERE id='CRIT-STALL'`)[0];
  assert.ok(stall, 'the stall is an item, not a silence');
  assert.match(stall.title, /no doer: missing GITHUB_TOKEN, .*ANTHROPIC_API_KEY/);
  const cards = d.q(`SELECT id, default_in_effect, closing_probe FROM gate_cards WHERE id LIKE 'runner-needs-%'`);
  assert.deepEqual(cards.map(c => c.closing_probe).sort(), ['env:GITHUB_TOKEN']);
  assert.ok(cards.every(c => c.default_in_effect));
  // the work was still prepared: the outcomes already carry the specification they need, so nothing is lost while waiting
  assert.ok(d.q(`SELECT COUNT(*) n FROM criticality_specs`)[0].n >= 3);
  d.state.env = CREDS; // the credentials arrive through the connect screen; nobody restarts or re-prompts anything
  await d.ticks(160);
  assert.ok(d.w.merged.length >= 9);
  assert.equal(d.q(`SELECT status FROM items WHERE id='CRIT-STALL'`)[0].status, 'done');
  assert.equal(d.q(`SELECT COUNT(*) n FROM gate_cards WHERE id LIKE 'runner-needs-%' AND status='open'`)[0].n, 0);
});

test('specify: an item with no target and no readable probe is given a specification once; a probe-closed item is left alone', async () => {
  const db = makeDb([OUT_DIR]);
  db.raw.exec(`INSERT INTO items (id,title,owner_role,done_check,closing_probe,status) VALUES
    ('A','Outcome: A booking prototype that ten neighbours try','product-manager','roadmap exists','items exist','ready'),
    ('B','Probe closed','operations','x','env:SOME_NAME','ready'),
    ('C','Has a target','staff','x; target: app/c.js','manual','ready')`);
  const k = create({ db, now: () => T0, evalProbe: async it => (/^env:/.test(it.closing_probe) ? { ok: false } : null) });
  assert.deepEqual(await k.specify(), { specified: 1, released: 0, retried: 0 });
  assert.deepEqual(await k.specify(), { specified: 0, released: 0, retried: 0 });
  const a = db.raw.prepare(`SELECT done_check, closing_probe FROM items WHERE id='A'`).get();
  assert.match(a.done_check, /target: specs\/US-SPEC-01-booking-prototype-ten-neighbours\.md/);
  assert.equal(a.closing_probe, `SELECT COUNT(*) FROM specloop_lines WHERE spec = 'US-SPEC-01'`);
  assert.equal(db.raw.prepare(`SELECT done_check FROM items WHERE id='B'`).get().done_check, 'x');
});
