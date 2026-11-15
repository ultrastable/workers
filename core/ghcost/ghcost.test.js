// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { makeDb } from '../_shared/testdb.js';
import { runTick } from '../src/tick.js';
import { createDeploy } from '../deploy/index.js';
import {
  minutesByRepo, decide, normalizeBudget, watchdog, enforce, setKillSwitch, killSwitchOn, drill, ledger, publishDue, evaluateSpendingLimit,
  spendingLimitProbe, deadman, ghcostSteps, handle, githubPort, staggerOffset, collisionCount, stagger, census, censusRun, canRetire,
  monitorHealth, monitorRun, publicChecklist, recordSecretScan, previousRelease, revertToPreviousRelease, CHECKLIST,
} from './index.js';

const dirs = ['./migrations/', '../deploy/migrations/'].map(d => fileURLToPath(new URL(d, import.meta.url)));
const BUDGET = Object.freeze({ linux_minute_rate_usd: 0.006, monthly_minutes_total: 500, default_per_repo: 100, per_repo: Object.freeze({ code: 500 }),
  thresholds: Object.freeze([0.5, 0.8]), non_essential_workflows: Object.freeze(['pages.yml', 'ci.yml:extra']), essential_workflows: Object.freeze(['ci.yml:test']) });
const T0 = Date.parse('2026-11-15T12:00:00Z');
const policy = JSON.parse(readFileSync(new URL('../../autonomy/policy.json', import.meta.url), 'utf8'));
const TICK = { org_slug: 't', claim_ttl_minutes: 120, max_wip_per_role: 3, plus_share: 0.2, policy };
const item = (repo, quantity, extra = {}) => ({ date: '2026-11-10T00:00:00Z', product: 'actions', sku: 'Actions Linux', quantity, unitType: 'Minutes', pricePerUnit: 0.006,
  grossAmount: quantity * 0.006, discountAmount: quantity * 0.006, netAmount: 0, organizationName: 'example-org', repositoryName: repo, ...extra });

/** A fake code host: workflow state lives in a map, every call is counted. */
function fakeHost({ usage = [], budgets = null, failUsage = false } = {}) {
  const state = new Map(), calls = [];
  const h = {
    state, calls, usageItems: usage, failUsage,
    async usage(month) { calls.push('usage:' + month); if (h.failUsage) throw new Error('http 503'); return { usageItems: h.usageItems }; },
    async budgets() { if (!budgets) throw new Error('http 403'); return budgets; },
    async workflowState({ repo, workflow }) { return state.get(repo + '/' + workflow) || 'enabled'; },
    async setWorkflow({ repo, workflow, enabled }) { calls.push(`${enabled ? 'enable' : 'disable'}:${repo}/${workflow}`); state.set(repo + '/' + workflow, enabled ? 'enabled' : 'disabled'); },
  };
  return h;
}
const mk = (host, cfgExtra = {}, at = T0) => { const t = { at }; return { db: makeDb(dirs), now: () => t.at, t, config: { ghcost: { enabled: true, org: 'example-org', budget: BUDGET, ...cfgExtra } }, github: host }; };
const openItems = async db => (await db.prepare("SELECT id FROM items WHERE status NOT IN ('done','superseded','cancelled') ORDER BY id").all()).results.map(r => r.id);

test('US-24-T05 a macOS row of 30 minutes at 0.062 counts as 310 Linux-equivalent minutes; storage rows are ignored', () => {
  const b = normalizeBudget(BUDGET);
  const per = minutesByRepo({ usageItems: [item('code', 30, { pricePerUnit: 0.062, sku: 'Actions macOS' }), { product: 'actions', unitType: 'GigabyteHours', quantity: 99, repositoryName: 'code', date: '2026-11-02' }, item('code', 5, { date: '2026-10-30' })] }, '2026-11', b);
  assert.equal(Math.round(per.code), 310);
});

test('US-24-R22 the watchdog reads the field set of the billing usage endpoint (figures observed 2026-11-11: 567 minutes, 508 in one repository)', () => {
  const report = { usageItems: [item('other', 508), item('code', 59)] };
  for (const k of ['date', 'product', 'sku', 'quantity', 'unitType', 'pricePerUnit', 'grossAmount', 'discountAmount', 'netAmount', 'organizationName', 'repositoryName']) assert.ok(k in report.usageItems[0], k);
  const d = decide(minutesByRepo(report, '2026-11', normalizeBudget(BUDGET)), normalizeBudget({ ...BUDGET, monthly_minutes_total: 1500 }));
  assert.equal(d.total_used, 567);
  assert.deepEqual(d.over_repos, ['other']); // 508 of the default 100 per repository
});

test('US-24-T04 US-24-R23 US-24-R24 US-24-R26: 250, 400 then 500 of 500 give warn50 exit 1, warn80 exit 1, over exit 2 with cards and disabled workflows', async () => {
  const host = fakeHost({ usage: [item('code', 250)] }), ctx = mk(host);
  let d = await watchdog(ctx);
  assert.deepEqual([d.decision, d.exit_code], ['warn50', 1]);
  assert.equal(host.calls.filter(c => c.startsWith('disable')).length, 0);
  host.usageItems = [item('code', 400)]; d = await watchdog(ctx);
  assert.deepEqual([d.decision, d.exit_code], ['warn80', 1]);
  host.usageItems = [item('code', 500)]; d = await watchdog(ctx);
  assert.deepEqual([d.decision, d.exit_code], ['over', 2]);
  assert.deepEqual(d.disable_workflows, ['pages.yml', 'ci.yml:extra']);
  assert.equal(host.state.get('code/pages.yml'), 'disabled');
  assert.equal(host.state.get('code/ci.yml:extra'), 'disabled');
  assert.equal(host.state.has('code/ci.yml:test'), false, 'the test job is never touched');
  const cards = (await ctx.db.prepare("SELECT id, default_in_effect, closing_probe FROM gate_cards ORDER BY id").all()).results;
  assert.deepEqual(cards.map(c => c.id), ['GATE-ACTIONS-BUDGET-202611-OVER', 'GATE-ACTIONS-BUDGET-202611-WARN50', 'GATE-ACTIONS-BUDGET-202611-WARN80']);
  for (const c of cards) assert.ok(c.default_in_effect.length > 10 && c.closing_probe, 'every card has a default in effect and a probe');
  assert.match(cards[0].default_in_effect, /No budget is raised/);
  assert.deepEqual(ctx.config.ghcost.budget, BUDGET, 'the budget is never changed by the watchdog');
});

test('US-24-R24 an essential workflow listed as non-essential by mistake is still kept', () => {
  const d = decide({ code: 600 }, normalizeBudget({ ...BUDGET, non_essential_workflows: ['pages.yml', 'ci.yml:test'] }));
  assert.deepEqual(d.disable_workflows, ['pages.yml']);
});

test('US-24-R54 every repository scanned lands in exactly one outcome bucket', async () => {
  const ctx = mk(fakeHost({ usage: [item('code', 10), item('a', 60), item('b', 85), item('c', 150)] }));
  const d = await watchdog(ctx);
  assert.deepEqual(d.buckets, { ok: 1, warn50: 1, warn80: 1, over: 1 });
  assert.equal(Object.values(d.buckets).reduce((x, y) => x + y, 0), d.scanned);
});

test('US-24-R22 an unreadable usage endpoint is unmeasured, never ok, and files an item after three runs', async () => {
  const host = fakeHost({ failUsage: true }), ctx = mk(host);
  for (let i = 0; i < 2; i++) assert.equal((await watchdog(ctx)).decision, 'unmeasured');
  assert.deepEqual(await openItems(ctx.db), []);
  const d = await watchdog(ctx);
  assert.equal(d.exit_code, 1);
  assert.deepEqual(await openItems(ctx.db), ['GHCOST-USAGE-UNREADABLE']);
  assert.equal((await ctx.db.prepare('SELECT COUNT(*) AS n FROM ghcost_ledger').first()).n, 0, 'no ledger row is invented');
  host.failUsage = false; await watchdog(ctx);
  assert.deepEqual(await openItems(ctx.db), []);
});

test('US-24-R21 one ledger row per repository and month, published once when the month is over', async () => {
  const host = fakeHost({ usage: [item('code', 120)] }), ctx = mk(host), published = [];
  ctx.publish = async l => { published.push(l); };
  await watchdog(ctx);
  const l = await ledger(ctx.db, '2026-11');
  assert.deepEqual(l.rows.map(r => [r.repo, r.minutes_used, r.budget, r.ratio]), [['code', 120, 500, 0.24], ['(total)', 120, 500, 0.24]]);
  assert.match(l.text, /\| 2026-11 \| code \| 120 \| 500 \| 0.24 \|/);
  assert.deepEqual(await publishDue(ctx), [], 'the running month is not published');
  ctx.t.at = Date.parse('2026-12-01T00:10:00Z');
  assert.deepEqual(await publishDue(ctx), ['2026-11']);
  assert.deepEqual(await publishDue(ctx), [], 'published once');
  assert.equal(published.length, 1);
  assert.equal(published[0].rows.length, 2);
  const res = await handle(new Request('https://org.example/ghcost/ledger?month=2026-11'), { db: ctx.db });
  assert.equal((await res.json()).rows.length, 2);
  assert.equal(await handle(new Request('https://org.example/other'), { db: ctx.db }), null);
  assert.equal((await handle(new Request('https://org.example/ghcost/ledger?month=x'), { db: ctx.db })).status, 400);
});

test('US-24-R23 a card of an earlier month closes when the new month reads ok; workflows this module disabled are enabled again', async () => {
  const host = fakeHost({ usage: [item('code', 500)] }), ctx = mk(host);
  await watchdog(ctx);
  assert.equal(host.state.get('code/pages.yml'), 'disabled');
  ctx.t.at = Date.parse('2026-12-02T00:00:00Z'); host.usageItems = [item('code', 3, { date: '2026-12-01' })];
  const d = await watchdog(ctx);
  assert.equal(d.decision, 'ok');
  assert.equal(host.state.get('code/pages.yml'), 'enabled');
  assert.equal((await ctx.db.prepare("SELECT status FROM gate_cards WHERE id='GATE-ACTIONS-BUDGET-202611-OVER'").first()).status, 'closed');
});

test('US-24-R25 the kill switch row disables every non-essential workflow on demand and off restores them', async () => {
  const host = fakeHost(), ctx = mk(host, { repos: ['code', 'docs'] });
  const on = await setKillSwitch(ctx, true, { by: 'owner', reason: 'cost' });
  assert.equal(await killSwitchOn(ctx.db), true);
  assert.equal(on.rows.length, 4);
  assert.ok(on.rows.every(r => r.observed === 'disabled' && r.reason === 'kill_switch'));
  assert.equal((await ctx.db.prepare("SELECT set_by FROM ghcost_switches WHERE id='workflows'").first()).set_by, 'owner');
  await setKillSwitch(ctx, false);
  assert.ok([...host.state.values()].every(v => v === 'enabled'));
});

test('US-24-R25 US-09-R03 a drill records the test and turns the switch off in every case, also when the platform fails', async () => {
  const host = fakeHost(), ctx = mk(host);
  assert.deepEqual(await drill(ctx), { disabled_all: true, switch_off_after: true, error: null });
  assert.ok([...host.state.values()].every(v => v === 'enabled'));
  host.workflowState = async () => { throw new Error('http 502'); };
  const r = await drill(ctx);
  assert.equal(r.switch_off_after, true);
  assert.equal(r.disabled_all, false);
  assert.equal(await killSwitchOn(ctx.db), false);
  const rows = (await ctx.db.prepare('SELECT disabled_all, switch_off_after FROM ghcost_drills ORDER BY id').all()).results;
  assert.deepEqual(rows, [{ disabled_all: 1, switch_off_after: 1 }, { disabled_all: 0, switch_off_after: 1 }]);
});

test('US-24-R55 a disabled workflow re-enabled from outside is detected from the platform state, filed and asserted again', async () => {
  const host = fakeHost({ usage: [item('code', 500)] }), ctx = mk(host);
  await watchdog(ctx);
  host.state.set('code/pages.yml', 'enabled'); // a concurrent deploy overwrote it
  const r = await enforce(ctx);
  assert.equal(r.drift, 1);
  assert.equal(host.state.get('code/pages.yml'), 'disabled');
  assert.deepEqual(await openItems(ctx.db), ['GHCOST-DRIFT-code-pages.yml']);
  await enforce(ctx);
  assert.deepEqual(await openItems(ctx.db), [], 'the item closes when a later run reads the state back');
});

test('US-24-R24 a disable that does not read back is a priority-0 item, not an assumed success', async () => {
  const host = fakeHost({ usage: [item('code', 500)] }), ctx = mk(host);
  host.setWorkflow = async () => {}; // accepted by the platform and without effect
  await watchdog(ctx);
  const it = await ctx.db.prepare("SELECT priority, status FROM items WHERE id='GHCOST-DISABLE-UNVERIFIED'").first();
  assert.deepEqual(it, { priority: 0, status: 'open' });
});

test('US-24-R20 US-24-T08 the spending-limit probe passes only on an Actions budget of 0 with stop-usage on', async () => {
  const b = (amount, stop, sku = 'actions') => ({ id: 'x', budget_type: 'ProductPricing', budget_product_sku: sku, budget_amount: amount, prevent_further_usage: stop });
  assert.equal(evaluateSpendingLimit({ budgets: [b(0, true), b(0, true, 'packages')] }).result, 'pass');
  assert.equal(evaluateSpendingLimit({ budgets: [b(25, true)] }).result, 'fail');
  assert.equal(evaluateSpendingLimit({ budgets: [b(0, false)] }).result, 'fail');
  assert.equal(evaluateSpendingLimit({ budgets: [b(0, true, 'packages')] }).result, 'fail');
  assert.equal(evaluateSpendingLimit({ message: 'Not Found' }).result, 'unknown');
  const ctx = mk(fakeHost({ budgets: { budgets: [b(10, true)] } }));
  assert.equal((await spendingLimitProbe(ctx)).result, 'fail');
  assert.equal((await ctx.db.prepare("SELECT priority FROM items WHERE id='GHCOST-SPENDING-LIMIT'").first()).priority, 0);
  ctx.github = fakeHost({ budgets: { budgets: [b(0, true)] } });
  assert.equal((await spendingLimitProbe(ctx)).result, 'pass');
  assert.deepEqual(await openItems(ctx.db), []);
  ctx.github = fakeHost();
  assert.equal((await spendingLimitProbe(ctx)).result, 'unknown');
  assert.deepEqual(await openItems(ctx.db), [], 'unreadable is recorded as unknown and files nothing');
  assert.deepEqual((await ctx.db.prepare("SELECT result FROM ghcost_probes WHERE probe='spending_limit' ORDER BY id").all()).results.map(r => r.result), ['fail', 'pass', 'unknown']);
});

test('US-24-R26 the watchdog runs as a tick step, only when enabled and on its interval', async () => {
  const host = fakeHost({ usage: [item('code', 500)], budgets: { budgets: [] } }), db = makeDb(dirs);
  const config = { ...TICK, ghcost: { enabled: true, org: 'example-org', budget: BUDGET, every_ticks: 2 } };
  const steps = ghcostSteps({ github: host });
  const t1 = await runTick(db, { config, now: T0, extraSteps: steps });
  assert.equal(t1.errors.length, 0);
  assert.equal(host.calls.length, 0, 'tick 1 is off the interval');
  const t2 = await runTick(db, { config, now: T0 + 600000, extraSteps: steps });
  assert.match(t2.report, /ghcost: over, spending limit fail/);
  assert.equal(host.state.get('code/pages.yml'), 'disabled');
  const off = fakeHost({ usage: [item('code', 500)] });
  await runTick(db, { config: { ...TICK, ghcost: { enabled: false } }, now: T0 + 1200000, extraSteps: ghcostSteps({ github: off }) });
  await runTick(db, { config: TICK, now: T0 + 1800000, extraSteps: ghcostSteps({ github: off }) });
  assert.equal(off.calls.length, 0);
});

test('US-24-R51 the dead-man check opens one item for a missing tick slot and closes it when a tick is recorded', async () => {
  const ctx = mk(fakeHost());
  assert.equal((await deadman(ctx)).item, 'DEADMAN-NO-TICK');
  await runTick(ctx.db, { config: TICK, now: T0 });
  ctx.t.at = T0 + 5 * 60000;
  const ok = await deadman(ctx);
  assert.deepEqual([ok.result, ok.closed], ['pass', 1]);
  ctx.t.at = T0 + 35 * 60000;
  const miss = await deadman(ctx);
  assert.deepEqual([miss.result, miss.missed_slots, miss.item, miss.filed], ['fail', 3, 'DEADMAN-202611151200', true]);
  assert.equal((await deadman(ctx)).filed, false, 'one item per gap');
  assert.equal((await ctx.db.prepare("SELECT priority FROM items WHERE id='DEADMAN-202611151200'").first()).priority, 0);
  await runTick(ctx.db, { config: TICK, now: T0 + 40 * 60000 });
  ctx.t.at = T0 + 41 * 60000;
  assert.equal((await deadman(ctx)).result, 'pass');
  assert.deepEqual(await openItems(ctx.db), []);
  assert.equal((await ctx.db.prepare("SELECT COUNT(*) AS n FROM ghcost_probes WHERE probe='deadman'").first()).n, 5, 'every run is recorded, also the clean ones');
});

test('US-24-R51 the dead-man check does not import or call the scheduler it checks', () => {
  const src = readFileSync(fileURLToPath(new URL('./index.js', import.meta.url)), 'utf8');
  assert.doesNotMatch(src, /from '\.\.\/src\/tick\.js'|runTick/);
  assert.ok(!ghcostSteps().some(s => /deadman/.test(s.name)), 'it is not a step of the tick');
});

test('US-24-R50 offsets are deterministic and the collision count is measured before and after', () => {
  assert.equal(staggerOffset('watchdog', 60), staggerOffset('watchdog', 60));
  assert.ok(staggerOffset('watchdog', 60) >= 0 && staggerOffset('watchdog', 60) < 60);
  const jobs = Array.from({ length: 15 }, (_, i) => ({ name: 'job-' + i, every: i % 2 ? 60 : 30 }));
  const naive = collisionCount(jobs.map(j => ({ ...j, offset: 0 })));
  assert.equal(naive.worst, 15, 'all fifteen fire at one instant when nothing is staggered');
  const plan = stagger(jobs);
  assert.equal(plan.collisions_before, naive.collisions);
  assert.equal(plan.collisions, 0);
  assert.equal(plan.worst, 1);
  assert.deepEqual(stagger([...jobs].reverse()).jobs, plan.jobs, 'the plan does not depend on input order');
  const crowded = stagger(Array.from({ length: 12 }, (_, i) => ({ name: 'c' + i, every: 10 })));
  assert.deepEqual([crowded.collisions, crowded.worst], [288, 2], 'twelve jobs in ten slots: the unavoidable collisions are counted');
});

test('US-24-R52 the census measures every workflow and runner user; a member missing from the roster that ran is active', async () => {
  const day = 86400000, now = T0;
  const c = census({ now, roster: ['ci.yml:test', 'pages.yml'],
    workflows: [{ repo: 'code', file: 'ci.yml', state: 'active' }, { repo: 'code', file: 'pages.yml', state: 'active' }, { repo: 'code', file: 'old.yml', state: 'active' }],
    runs: [{ repo: 'code', workflow: 'ci.yml', at: new Date(now - day).toISOString(), runner: 'ubuntu-latest' }, { repo: 'code', workflow: 'old.yml', at: new Date(now - 2 * day).toISOString(), runner: 'self-hosted' },
      { repo: 'code', workflow: 'pages.yml', at: new Date(now - 90 * day).toISOString() }, { repo: 'code', workflow: 'ghost.yml', at: new Date(now - day).toISOString() }] });
  assert.deepEqual(c.unrostered_active, ['code/ghost.yml', 'code/old.yml']);
  assert.deepEqual(c.retirable, ['code/pages.yml']);
  assert.deepEqual(c.rows.find(r => r.workflow === 'old.yml').runners, ['self-hosted']);
  const host = { listWorkflows: async () => [{ file: 'ci.yml', state: 'active' }, { file: 'idle.yml', state: 'active' }, { file: 'busy.yml', state: 'active' }],
    listRuns: async () => [{ workflow: 'busy.yml', at: new Date(now - day).toISOString(), runner: 'hosted' }, { workflow: 'ci.yml', at: new Date(now - day).toISOString(), runner: 'hosted' }] };
  const ctx = mk(host, { roster: ['ci.yml'], repos: ['code'] });
  const r = await censusRun(ctx);
  assert.deepEqual(r.unrostered_active, ['code/busy.yml']);
  assert.deepEqual(await openItems(ctx.db), ['GHCOST-CENSUS-UNROSTERED']);
  assert.deepEqual(await canRetire(ctx, { repo: 'code', workflow: 'idle.yml' }), { ok: true, reason: 'measured_idle' });
  assert.deepEqual(await canRetire(ctx, { repo: 'code', workflow: 'busy.yml' }), { ok: false, reason: 'measured_active' });
  assert.deepEqual(await canRetire(ctx, { repo: 'code', workflow: 'never-seen.yml' }), { ok: false, reason: 'not_measured' });
  ctx.t.at = now + 30 * day;
  assert.deepEqual(await canRetire(ctx, { repo: 'code', workflow: 'idle.yml' }), { ok: false, reason: 'census_stale' });
});

test('US-24-R52 a monitor with frozen or dead targets files an item', async () => {
  const now = T0, old = new Date(now - 48 * 3600000).toISOString(), fresh = i => new Date(now - i * 60000).toISOString();
  const rows = [...Array.from({ length: 73 }, (_, i) => ({ target: 't' + i, checked_at: old, status: 200 })), ...Array.from({ length: 10 }, (_, i) => ({ target: 'f' + i, checked_at: fresh(i), status: i < 2 ? 404 : 200 }))];
  const h = monitorHealth(rows, { now });
  assert.deepEqual([h.frozen, h.frozen_count, h.targets, h.dead], [true, 73, 83, ['f0', 'f1']]);
  const ctx = mk(fakeHost());
  await monitorRun(ctx, rows);
  assert.deepEqual(await openItems(ctx.db), ['GHCOST-MONITOR-DEAD', 'GHCOST-MONITOR-FROZEN']);
  await monitorRun(ctx, rows.slice(75).map(r => ({ ...r, status: 200 })));
  assert.deepEqual(await openItems(ctx.db), []);
  assert.equal(monitorHealth([{ target: 'a', checked_at: fresh(1), status: 200 }, { target: 'b', checked_at: fresh(1), status: 200 }], { now }).frozen, false, 'one shared fresh timestamp is not frozen');
});

test('US-24-R43 the public-repository checklist has the five rows, opens a card whose default keeps the repository private, and is ready only when all pass', async () => {
  assert.deepEqual(CHECKLIST.map(c => c.id), ['secret_history', 'secret_scanning', 'pages_source', 'default_branch_ruleset', 'fork_approval']);
  const good = { repo: async () => ({ security_and_analysis: { secret_scanning: { status: 'enabled' }, secret_scanning_push_protection: { status: 'enabled' } } }), pages: async () => null,
    rulesets: async () => [{ enforcement: 'active', target: 'branch' }], forkApproval: async () => ({ approval_policy: 'all_external_contributors' }) };
  const ctx = mk(good);
  let r = await publicChecklist(ctx, 'code');
  assert.equal(r.ready, false);
  assert.equal(r.rows[0].status, 'unmeasured', 'no recorded history scan is unmeasured, not passed');
  await recordSecretScan(ctx, 'code', { findings: 0 });
  r = await publicChecklist(ctx, 'code');
  assert.equal(r.ready, true);
  const card = await ctx.db.prepare("SELECT what, default_in_effect, closing_probe, status FROM gate_cards WHERE id='GATE-PUBLIC-code'").first();
  assert.equal(card.default_in_effect, 'The repository stays private.');
  assert.equal(card.status, 'open');
  assert.equal(card.what.split('\n').filter(l => l.startsWith('[x]')).length, 5);
  ctx.github = { ...good, repo: async () => ({ security_and_analysis: { secret_scanning: { status: 'enabled' }, secret_scanning_push_protection: { status: 'disabled' } } }), rulesets: async () => { throw new Error('http 403'); },
    forkApproval: async () => ({ approval_policy: 'first_time_contributors' }), pages: async () => ({ build_type: 'legacy', source: { branch: 'main', path: '/docs' } }) };
  r = await publicChecklist(ctx, 'code');
  assert.deepEqual(r.rows.map(x => x.status), ['pass', 'fail', 'fail', 'unmeasured', 'fail']);
  assert.equal(r.ready, false);
  await recordSecretScan(ctx, 'code', { findings: 2 });
  assert.equal((await publicChecklist(ctx, 'code')).rows[0].status, 'fail');
});

test('US-24-R04 a deploy reverts to the previous Release through the deploy path, and only when the bundle digest matches its manifest', async () => {
  const sha = s => createHash('sha256').update(s).digest('hex');
  const rel = (tag, bundle, extra = {}) => ({ tag_name: tag, draft: false, prerelease: false, assets: [{ name: 'bundle.js', browser_download_url: `dl:${tag}/bundle.js` }, { name: 'manifest.json', browser_download_url: `dl:${tag}/manifest.json` }], bundle, ...extra });
  const releases = [rel('v1.3.0', 'three'), rel('v1.10.0', 'ten'), rel('v1.9.0', 'nine'), rel('v1.9.5', 'rc', { prerelease: true }), rel('nightly', 'x')];
  assert.equal(previousRelease(releases, 'v1.10.0').tag_name, 'v1.9.0', 'versions compare by number, prereleases are skipped');
  assert.equal(previousRelease(releases, 'v1.3.0'), null);
  const files = Object.fromEntries(releases.flatMap(r => [[`dl:${r.tag_name}/bundle.js`, r.bundle], [`dl:${r.tag_name}/manifest.json`, JSON.stringify({ version: r.tag_name.replace(/^v/, ''), bundle_sha256: sha(r.bundle) })]]));
  const db = makeDb(dirs); let live = '1.10.0';
  const deployer = { liveVersion: async () => live, publish: async (unit, artifact) => { live = artifact.version; return { version: live }; }, rollback: async (unit, to) => { live = to; } };
  const deploys = createDeploy({ db, deployer, fetch: async () => new Response('ok'), now: () => T0, sleep: async () => {}, config: { probeWindowMs: 0 } });
  const ctx = { github: { releases: async () => releases }, download: async u => files[u], sha256: async t => sha(t), deploy: deploys.deploy };
  const r = await revertToPreviousRelease(ctx, { repo: 'code', unit: 'org-worker', current: 'v1.10.0' });
  assert.deepEqual([r.from, r.to, r.sha256], ['v1.10.0', 'v1.9.0', sha('nine')]);
  assert.equal(live, '1.9.0');
  assert.equal(r.status, 'kept');
  files['dl:v1.3.0/bundle.js'] = 'tampered';
  const bad = await revertToPreviousRelease(ctx, { repo: 'code', unit: 'org-worker', current: 'v1.9.0' });
  assert.deepEqual([bad.status, bad.reason], ['refused', 'digest_mismatch']);
  assert.equal(live, '1.9.0', 'nothing is deployed on a mismatch');
  assert.equal((await revertToPreviousRelease(ctx, { repo: 'code', unit: 'org-worker', current: 'v1.3.0' })).reason, 'no_previous_release');
});

test('US-24-R53 the code-host port bounds its retries, reads the token by name and never puts it in an error', async () => {
  let n = 0; const seen = [];
  const fetch = async (url, init) => { n++; seen.push(init.headers.authorization); return new Response('{}', { status: 503 }); };
  const port = githubPort({ fetch, env: { VCS_TOKEN: 'tok-secret-value' }, org: 'example-org', maxAttempts: 3 });
  await assert.rejects(port.usage('2026-11'), e => !String(e.message).includes('tok-secret-value') && /http 503/.test(e.message));
  assert.equal(n, 3, 'three attempts, not more');
  await assert.rejects(githubPort({ fetch, env: {}, org: 'example-org' }).budgets(), /VCS_TOKEN is not set/);
  n = 0;
  const denied = githubPort({ fetch: async () => { n++; return new Response('{}', { status: 403 }); }, env: { VCS_TOKEN: 't' }, org: 'example-org', maxAttempts: 3 });
  await assert.rejects(denied.budgets(), /http 403/);
  assert.equal(n, 1, 'a refusal is not retried');
});

test('the code-host port disables a whole workflow by its file and a job through the repository variable, and reads both back', async () => {
  const vars = new Map(), wf = new Map([['pages.yml', 'active']]), log = [];
  const fetch = async (url, init) => {
    const p = new URL(url).pathname; log.push(init.method + ' ' + p);
    const json = (o, status = 200) => new Response(JSON.stringify(o), { status });
    let m;
    if ((m = /\/actions\/workflows\/([\w.-]+)\/(enable|disable)$/.exec(p))) { wf.set(m[1], m[2] === 'enable' ? 'active' : 'disabled_manually'); return new Response(null, { status: 204 }); }
    if ((m = /\/actions\/workflows\/([\w.-]+)$/.exec(p))) return wf.has(m[1]) ? json({ state: wf.get(m[1]) }) : json({}, 404);
    if ((m = /\/actions\/variables\/(\w+)$/.exec(p))) { if (init.method === 'PATCH') { vars.set(m[1], JSON.parse(init.body).value); return new Response(null, { status: 204 }); } return vars.has(m[1]) ? json({ name: m[1], value: vars.get(m[1]) }) : json({}, 404); }
    if (p.endsWith('/actions/variables') && init.method === 'POST') { const b = JSON.parse(init.body); vars.set(b.name, b.value); return json({}, 201); }
    return json({}, 404);
  };
  const port = githubPort({ fetch, env: { VCS_TOKEN: 't' }, org: 'example-org' });
  const ctx = { db: makeDb(dirs), now: () => T0, config: { ghcost: { org: 'example-org', budget: BUDGET } }, github: port };
  const on = await setKillSwitch(ctx, true);
  assert.ok(on.rows.every(r => r.observed === 'disabled'));
  assert.equal(wf.get('pages.yml'), 'disabled_manually');
  assert.equal(vars.get('DISABLED_JOBS'), 'ci.yml:extra');
  await setKillSwitch(ctx, false);
  assert.equal(wf.get('pages.yml'), 'active');
  assert.equal(vars.get('DISABLED_JOBS'), '');
  assert.equal(await port.workflowState({ repo: 'code', workflow: 'missing.yml' }), 'absent');
});
