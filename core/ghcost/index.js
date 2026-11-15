// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// core/ghcost (US-SPEC-24): the Actions minutes watchdog as a tick step, the monthly ledger, the workflow kill switch with
// read-back, the spending-limit probe and the dead-man check. Ports: ctx = { db, now, config, github } where `github` is
// the code-host port (./github.js or a fake). config.ghcost = { enabled, org, budget (the content of ops/actions-budget.json),
// repos?, every_ticks?, month?, tick_interval_minutes?, unread_limit? }. Nothing here raises a budget (US-24-R24).
import { iso, nowMs, all, first, run, cfg, fileItem, closeItem, openCard, recordProbe } from './util.js';
import { githubPort } from './github.js';

export const MIGRATIONS_DIR = new URL('./migrations/', import.meta.url);
const LEVELS = ['ok', 'warn50', 'warn80', 'over'];

export function normalizeBudget(b) {
  if (!b || !(Number(b.monthly_minutes_total) > 0)) throw new Error('ghcost: config.ghcost.budget.monthly_minutes_total is required');
  return { linux_minute_rate_usd: 0.006, thresholds: [0.5, 0.8], per_repo: {}, default_per_repo: 0, non_essential_workflows: [], essential_workflows: [], ...b };
}

/** Linux-equivalent Actions minutes per repository for `month` (YYYY-MM). Rows that are not Actions minutes are ignored (US-24-R22). */
export function minutesByRepo(report, month, budget) {
  const rate = budget.linux_minute_rate_usd, out = {};
  for (const it of report?.usageItems || []) {
    if (String(it.product || '').toLowerCase() !== 'actions' || String(it.unitType || '').toLowerCase() !== 'minutes') continue;
    if (month && !String(it.date || '').startsWith(month)) continue;
    const price = Number(it.pricePerUnit) || 0;
    const repo = it.repositoryName || '(org)';
    out[repo] = (out[repo] || 0) + Number(it.quantity || 0) * (price ? price / rate : 1);
  }
  return out;
}

/** The decision: ok | warn50 | warn80 | over, per repository and in total. Exit status 0, 1, 1, 2 (US-24-R26). */
export function decide(perRepo, budget) {
  const [lo, hi] = [...budget.thresholds].sort((a, b) => a - b);
  const level = ratio => (ratio >= 1 ? 3 : ratio >= hi ? 2 : ratio >= lo ? 1 : 0);
  const round = (n, d) => Math.round(n * 10 ** d) / 10 ** d;
  const repos = [...new Set([...Object.keys(perRepo), ...Object.keys(budget.per_repo)])].sort().map(repo => {
    const cap = Number(budget.per_repo[repo] ?? budget.default_per_repo ?? 0), used = perRepo[repo] || 0;
    const ratio = cap ? used / cap : used ? 1 : 0;
    return { repo, used: round(used, 1), budget: cap, ratio: round(ratio, 3), decision: LEVELS[level(ratio)] };
  });
  const total = Object.values(perRepo).reduce((a, b) => a + b, 0), totalBudget = Number(budget.monthly_minutes_total);
  const totalRatio = total / totalBudget;
  const top = Math.max(level(totalRatio), ...repos.map(r => LEVELS.indexOf(r.decision)));
  const decision = LEVELS[top];
  const essential = new Set(budget.essential_workflows);
  return {
    decision, exit_code: [0, 1, 1, 2][top], total_used: round(total, 1), total_budget: totalBudget, total_ratio: round(totalRatio, 3),
    total_over: totalRatio >= 1, repos, over_repos: repos.filter(r => r.decision === 'over').map(r => r.repo),
    disable_workflows: decision === 'over' ? budget.non_essential_workflows.filter(w => !essential.has(w)) : [],
  };
}

const targetRepos = (c, budget) => c.repos || Object.keys(budget.per_repo);
const nonEssential = budget => { const keep = new Set(budget.essential_workflows); return budget.non_essential_workflows.filter(w => !keep.has(w)); };

/**
 * Bring every non-essential workflow to its desired state and read the result back from the platform (US-24-R24, R25, R55).
 * Desired is `disabled` while the kill switch is on or the month's ledger says over; otherwise `enabled`, and only for
 * workflows this module disabled. A workflow found enabled after it was read back disabled was overwritten from outside:
 * that drift files an item and the state is asserted again.
 */
export async function enforce(ctx) {
  const c = cfg(ctx), budget = normalizeBudget(c.budget), ts = iso(nowMs(ctx)), month = c.month || ts.slice(0, 7), db = ctx.db;
  const sw = await first(db, `SELECT is_on FROM ghcost_switches WHERE id='workflows'`);
  const over = await all(db, `SELECT repo FROM ghcost_ledger WHERE month=? AND decision='over'`, month);
  const overAll = over.some(r => r.repo === '(total)'), overRepos = new Set(over.map(r => r.repo));
  const out = { desired_disabled: 0, changed: 0, drift: 0, unverified: 0, rows: [] };
  for (const repo of targetRepos(c, budget)) {
    for (const workflow of nonEssential(budget)) {
      const reason = sw?.is_on ? 'kill_switch' : (overAll || overRepos.has(repo)) ? 'over' : null;
      const prev = await first(db, `SELECT desired, observed FROM ghcost_workflows WHERE repo=? AND workflow=?`, repo, workflow);
      if (!reason && !prev) continue; // never touched and nothing asks for it: leave the platform as it is
      const desired = reason ? 'disabled' : 'enabled';
      if (desired === 'disabled') out.desired_disabled++;
      let observed = 'unknown', error = null, drifted = false;
      try {
        observed = await ctx.github.workflowState({ repo, workflow });
        if (observed !== 'absent' && observed !== desired) {
          if (prev && prev.desired === desired && prev.observed === desired) {
            out.drift++; drifted = true;
            await fileItem(db, { id: `GHCOST-DRIFT-${repo}-${workflow}`.replace(/[^\w.-]/g, '-'), title: `Workflow ${workflow} in ${repo} was ${desired} and is ${observed} again: a change outside the watchdog overwrote it`,
              done_check: `the workflow reads back ${desired} on two consecutive watchdog runs`, closing_probe: 'ghcost_workflows.observed = desired', priority: 5 }, ts);
          }
          await ctx.github.setWorkflow({ repo, workflow, enabled: desired === 'enabled' });
          out.changed++;
          observed = await ctx.github.workflowState({ repo, workflow });
        }
      } catch (e) { error = String(e?.message || e).slice(0, 200); observed = 'unknown'; }
      if (observed !== desired && observed !== 'absent') out.unverified++;
      if (!prev || prev.desired !== desired) {
        await run(db, `INSERT INTO ghcost_workflows (repo, workflow, desired, observed, reason, changed_at, checked_at) VALUES (?,?,?,?,?,?,?)
          ON CONFLICT(repo, workflow) DO UPDATE SET desired=excluded.desired, observed=excluded.observed, reason=excluded.reason, changed_at=excluded.changed_at, checked_at=excluded.checked_at`,
          repo, workflow, desired, observed, reason, ts, ts);
      } else {
        await run(db, `UPDATE ghcost_workflows SET observed=?, reason=?, checked_at=? WHERE repo=? AND workflow=?`, observed, reason, ts, repo, workflow);
      }
      out.rows.push({ repo, workflow, desired, observed, reason, error, drifted });
    }
  }
  if (out.unverified && out.desired_disabled) {
    await fileItem(db, { id: 'GHCOST-DISABLE-UNVERIFIED', title: `${out.unverified} non-essential workflow(s) did not read back in the desired state`,
      done_check: 'every row of ghcost_workflows has observed = desired', closing_probe: 'ghcost_workflows.observed = desired', priority: 0 }, ts);
  } else if (!out.unverified) {
    await closeItem(db, 'GHCOST-DISABLE-UNVERIFIED', 'every workflow reads back in its desired state', ts);
    for (const r of out.rows.filter(x => x.observed === x.desired && !x.drifted)) {
      await closeItem(db, `GHCOST-DRIFT-${r.repo}-${r.workflow}`.replace(/[^\w.-]/g, '-'), `reads back ${r.desired} on a later run`, ts);
    }
  }
  return out;
}

/** The kill switch row (US-24-R25): on disables every non-essential workflow now; off restores the ones this module disabled. */
export async function setKillSwitch(ctx, on, { by = 'system', reason = '' } = {}) {
  const ts = iso(nowMs(ctx));
  await run(ctx.db, `INSERT INTO ghcost_switches (id, is_on, reason, set_by, set_at) VALUES ('workflows',?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET is_on=excluded.is_on, reason=excluded.reason, set_by=excluded.set_by, set_at=excluded.set_at`, on ? 1 : 0, reason, by, ts);
  return enforce(ctx);
}
export const killSwitchOn = async db => !!(await first(db, `SELECT is_on FROM ghcost_switches WHERE id='workflows'`))?.is_on;

/** Drill (US-24-R25 with US-09-R03): switch on, read every workflow back disabled, and switch off in every case. Recorded. */
export async function drill(ctx) {
  const started = iso(nowMs(ctx)); let disabledAll = 0, error = null;
  try {
    const r = await setKillSwitch(ctx, true, { by: 'drill', reason: 'drill' });
    disabledAll = r.rows.length > 0 && r.rows.every(x => x.observed === 'disabled' || x.observed === 'absent') ? 1 : 0;
  } catch (e) { error = String(e?.message || e).slice(0, 200); }
  finally {
    try { await setKillSwitch(ctx, false, { by: 'drill', reason: 'drill finished' }); }
    catch (e) { // the platform may be unreachable; the row itself must still be off
      error = error || String(e?.message || e).slice(0, 200);
      await run(ctx.db, `UPDATE ghcost_switches SET is_on=0, set_by='drill', reason='drill finished' WHERE id='workflows'`);
    }
  }
  const off = !(await killSwitchOn(ctx.db));
  await run(ctx.db, `INSERT INTO ghcost_drills (started_at, finished_at, disabled_all, switch_off_after, error) VALUES (?,?,?,?,?)`, started, iso(nowMs(ctx)), disabledAll, off ? 1 : 0, error);
  return { disabled_all: !!disabledAll, switch_off_after: off, error };
}

const CARD_WHY = 'Spend on Actions is a cost the owner caps. At 100 percent non-essential workflows are disabled; raising the budget or the spending limit spends the owner\'s money and is the owner\'s decision.';

/** One watchdog run (US-24-R21 to R24, R26, R54): read usage, decide, write the ledger rows, open the card, enforce. */
export async function watchdog(ctx) {
  const c = cfg(ctx), budget = normalizeBudget(c.budget), ts = iso(nowMs(ctx)), month = c.month || ts.slice(0, 7), db = ctx.db;
  let report;
  try {
    report = await ctx.github.usage(month);
    if (!report || !Array.isArray(report.usageItems)) throw new Error('billing usage response has no usageItems list');
  } catch (e) {
    await recordProbe(db, 'watchdog', 'unknown', String(e?.message || e), ts);
    const limit = c.unread_limit || 3;
    const last = await all(db, `SELECT result FROM ghcost_probes WHERE probe='watchdog' ORDER BY id DESC LIMIT ?`, limit);
    if (last.length >= limit && last.every(r => r.result === 'unknown')) {
      await fileItem(db, { id: 'GHCOST-USAGE-UNREADABLE', title: `Actions usage has been unreadable for ${limit} watchdog runs; minutes are unmeasured, not zero`,
        done_check: 'a watchdog run reads the billing usage endpoint', closing_probe: "ghcost_probes: latest probe='watchdog' is pass", priority: 5 }, ts);
    }
    return { decision: 'unmeasured', exit_code: 1, error: String(e?.message || e) };
  }
  const d = decide(minutesByRepo(report, month, budget), budget);
  const buckets = Object.fromEntries(LEVELS.map(l => [l, d.repos.filter(r => r.decision === l).length]));
  if (Object.values(buckets).reduce((a, b) => a + b, 0) !== d.repos.length) throw new Error('ghcost: outcome buckets do not sum to the repositories scanned');
  const up = `INSERT INTO ghcost_ledger (month, repo, minutes_used, budget, ratio, decision, updated_at) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(month, repo) DO UPDATE SET minutes_used=excluded.minutes_used, budget=excluded.budget, ratio=excluded.ratio, decision=excluded.decision, updated_at=excluded.updated_at`;
  for (const r of d.repos) await run(db, up, month, r.repo, r.used, r.budget, r.ratio, r.decision, ts);
  const totalDecision = d.total_ratio >= 1 ? 'over' : d.total_ratio >= Math.max(...budget.thresholds) ? 'warn80' : d.total_ratio >= Math.min(...budget.thresholds) ? 'warn50' : 'ok';
  await run(db, up, month, '(total)', d.total_used, d.total_budget, d.total_ratio, totalDecision, ts);
  const applied = await enforce(ctx);
  if (d.decision !== 'ok') {
    const pct = Math.round(d.total_ratio * 100);
    await openCard(db, {
      id: `GATE-ACTIONS-BUDGET-${month.replace('-', '')}-${d.decision.toUpperCase()}`,
      what: `Actions minutes for ${c.org || 'the organization'} in ${month}: ${d.total_used} of ${d.total_budget} (${pct}%), decision ${d.decision}` + (d.over_repos.length ? `; over budget: ${d.over_repos.join(', ')}` : ''),
      why_gated: CARD_WHY,
      default_in_effect: d.decision === 'over' ? `Non-essential workflows disabled: ${d.disable_workflows.join(', ') || '(none listed)'}. The test job keeps running. No budget is raised.` : 'No change. The watchdog keeps reading usage and the spending limit stays at USD 0.',
      prepared_by_fleet: JSON.stringify({ month, repos: d.repos }),
      closing_probe: 'manual',
    });
  }
  // A card of an earlier month closes itself once the new month reads ok: its probe is this watchdog.
  if (d.decision === 'ok') await run(db, `UPDATE gate_cards SET status='closed', closed_at=? WHERE status='open' AND id LIKE 'GATE-ACTIONS-BUDGET-%' AND id NOT LIKE ?`, ts, `GATE-ACTIONS-BUDGET-${month.replace('-', '')}-%`);
  await recordProbe(db, 'watchdog', 'pass', { month, decision: d.decision, total_used: d.total_used }, ts);
  await closeItem(db, 'GHCOST-USAGE-UNREADABLE', 'the watchdog read billing usage', ts);
  return { ...d, month, scanned: d.repos.length, buckets, enforced: applied };
}

/** The month's ledger rows as data and as a plain table (US-24-R21). */
export async function ledger(db, month) {
  const rows = await all(db, `SELECT month, repo, minutes_used, budget, ratio, decision, published_at FROM ghcost_ledger WHERE month=? ORDER BY repo='(total)', repo`, month);
  const text = ['| Month | Repository | Minutes used | Budget | Ratio |', '|---|---|---|---|---|', ...rows.map(r => `| ${r.month} | ${r.repo} | ${r.minutes_used} | ${r.budget} | ${r.ratio} |`)].join('\n');
  return { month, rows, text };
}

/** Publish every finished month once: rows are stamped and handed to the optional `publish` port. Returns the months published. */
export async function publishDue(ctx) {
  const ts = iso(nowMs(ctx)), current = cfg(ctx).month || ts.slice(0, 7), done = [];
  const months = await all(ctx.db, `SELECT DISTINCT month FROM ghcost_ledger WHERE published_at IS NULL AND month < ? ORDER BY month`, current);
  for (const { month } of months) {
    const l = await ledger(ctx.db, month);
    if (ctx.publish) await ctx.publish(l); // a throw leaves the month unpublished and it is retried on the next run
    await run(ctx.db, `UPDATE ghcost_ledger SET published_at=? WHERE month=? AND published_at IS NULL`, ts, month);
    done.push(month);
  }
  return done;
}

const skuOf = b => [b.budget_product_sku, b.product, b.sku, ...(b.budget_product_skus || [])].filter(Boolean).map(s => String(s).toLowerCase());
/** Pure: does the budgets response hold an Actions budget of 0 with stop-usage on (US-24-R20, T08)? */
export function evaluateSpendingLimit(response) {
  const list = Array.isArray(response) ? response : response?.budgets;
  if (!Array.isArray(list)) return { result: 'unknown', evidence: 'budgets response has no list' };
  const actions = list.filter(b => skuOf(b).includes('actions'));
  if (!actions.length) return { result: 'fail', evidence: 'no Actions budget exists, so overage is not stopped by a budget' };
  const bad = actions.filter(b => Number(b.budget_amount ?? b.amount) !== 0 || b.prevent_further_usage !== true);
  return bad.length ? { result: 'fail', evidence: `Actions budget amount ${bad[0].budget_amount ?? bad[0].amount}, prevent_further_usage ${bad[0].prevent_further_usage}` }
    : { result: 'pass', evidence: `Actions budget 0 with prevent_further_usage true (${actions.length} budget row(s))` };
}

/** Probe the platform-side hard stop. A fail is a priority-0 item; unreadable is recorded as unknown, never as a pass. */
export async function spendingLimitProbe(ctx) {
  const ts = iso(nowMs(ctx)); let r;
  try { r = evaluateSpendingLimit(await ctx.github.budgets()); } catch (e) { r = { result: 'unknown', evidence: String(e?.message || e) }; }
  await recordProbe(ctx.db, 'spending_limit', r.result, r.evidence, ts);
  if (r.result === 'fail') {
    await fileItem(ctx.db, { id: 'GHCOST-SPENDING-LIMIT', title: `Actions spending limit is not a hard stop: ${r.evidence}`,
      done_check: 'the budgets endpoint shows an Actions budget of 0 with prevent_further_usage true', closing_probe: "ghcost_probes: latest probe='spending_limit' is pass", priority: 0 }, ts);
  } else if (r.result === 'pass') await closeItem(ctx.db, 'GHCOST-SPENDING-LIMIT', r.evidence, ts);
  return r;
}

/**
 * Dead-man check (US-24-R51). Reads tick_runs and opens an item for a gap longer than the tolerance. It is a plain function
 * so the host can call it from a trigger other than the scheduler it checks (a request, a second alarm); it is not a tick step.
 */
export async function deadman(ctx) {
  const c = cfg(ctx), now = nowMs(ctx), ts = iso(now), db = ctx.db;
  const every = (c.tick_interval_minutes || 10) * 60000, tolerance = every * (c.deadman_tolerance || 1.5);
  const lastRow = await first(db, `SELECT started_at FROM tick_runs WHERE finished_at IS NOT NULL ORDER BY started_at DESC LIMIT 1`);
  const lastMs = lastRow ? Date.parse(lastRow.started_at.replace(' ', 'T') + 'Z') : null;
  const open = await all(db, `SELECT id FROM items WHERE id LIKE 'DEADMAN-%' AND status NOT IN ('done','superseded','cancelled')`);
  if (lastMs != null && now - lastMs <= tolerance) {
    for (const o of open) await closeItem(db, o.id, `a tick finished at ${lastRow.started_at}`, ts);
    await recordProbe(db, 'deadman', 'pass', { last_tick: lastRow.started_at }, ts);
    return { result: 'pass', last_tick: lastRow.started_at, missed_slots: 0, closed: open.length };
  }
  const missed = lastMs == null ? null : Math.floor((now - lastMs) / every);
  const id = `DEADMAN-${lastRow ? lastRow.started_at.replace(/[^0-9]/g, '').slice(0, 12) : 'NO-TICK'}`;
  const filed = await fileItem(db, { id, title: lastRow ? `No tick record since ${lastRow.started_at}: ${missed} expected slot(s) have no record` : 'No finished tick has ever been recorded',
    done_check: 'a tick finishes and is recorded in tick_runs', closing_probe: 'tick_runs: latest finished tick within the tolerance', priority: 0 }, ts);
  await recordProbe(db, 'deadman', 'fail', { last_tick: lastRow?.started_at || null, missed_slots: missed }, ts);
  return { result: 'fail', last_tick: lastRow?.started_at || null, missed_slots: missed, item: id, filed };
}

/**
 * Tick steps for core/org (US-24-R26: the watchdog runs from the tick, never from a workflow). Opt-in: config.ghcost.enabled.
 * ports = { fetch, github?, publish? }. The step runs every `every_ticks` ticks (default 6, hourly at a 10-minute tick).
 */
export function ghcostSteps(ports = {}) {
  return [{ name: 'ghcost_watchdog', async run(db, tick) {
    const c = tick.config?.ghcost;
    if (!c?.enabled) return;
    if (tick.tickId % (c.every_ticks || 6) !== 0) return;
    const github = ports.github || githubPort({ fetch: ports.fetch, env: tick.env, org: c.org, tokenEnv: c.token_env, apiBase: c.api_base });
    const ctx = { db, now: tick.now, config: tick.config, github, publish: ports.publish };
    const w = await watchdog(ctx), s = await spendingLimitProbe(ctx), p = await publishDue(ctx);
    tick.notes?.push(`ghcost: ${w.decision}, spending limit ${s.result}${p.length ? `, ledger published for ${p.join(', ')}` : ''}`);
  } }];
}

/** Read-only routes: GET /ghcost/ledger?month=YYYY-MM (JSON) and /ghcost/ledger.md. Returns null for any other path. */
export async function handle(request, { db, now = Date.now() }) {
  const url = new URL(request.url);
  if (request.method !== 'GET' || !url.pathname.startsWith('/ghcost/ledger')) return null;
  const month = url.searchParams.get('month') || iso(typeof now === 'function' ? now() : now).slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(month)) return new Response(JSON.stringify({ error: 'bad_month' }), { status: 400, headers: { 'content-type': 'application/json' } });
  const l = await ledger(db, month);
  return url.pathname.endsWith('.md') ? new Response(l.text + '\n', { headers: { 'content-type': 'text/markdown; charset=utf-8' } })
    : new Response(JSON.stringify({ month: l.month, rows: l.rows }), { headers: { 'content-type': 'application/json' } });
}

export { githubPort };
export * from './census.js';
export * from './public.js';
