// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Doer/reviewer runner (US-SPEC-11). A run is a state machine in runner_runs, advanced a little each tick (I/O only:
// verification is the repository's CI, an independent system). The runner opens DRAFT pull requests and never merges.
// Ports: db, now (ms), config, env (presence only), router (route/call), claims (acquire/heartbeat/release),
// vcs (getFile, createBranch, commitFiles, openDraftPr, getChecks, getDiff). `fetch` is accepted for symmetry; the
// network lives in the router and the vcs adapter.

export const DEFAULT_PROTECTED = ['SCOPE.md', 'LICENSE', 'COMMERCIAL-TERMS.md', 'autonomy/', 'self/', '.github/', 'core/test/no-qnfo.test.js'];
export const TERMINAL_STATES = ['refused', 'pr_opened'];
const DEFAULTS = {
  enabled: false, holder: 'runner', base_branch: 'main', branch_prefix: 'runner/', max_wip: 1, max_rework: 2,
  max_doer_retries: 2, max_calls_per_item: 8, max_usd_per_item: 1, max_files: 5, max_file_bytes: 200000, max_diff_chars: 30000,
  checks_timeout_minutes: 90, max_errors: 5, max_advances_per_step: 3, claim_ttl_minutes: 120, spec_text_chars: 4000,
};
const DOER_RUNG = { rung: 'medium', max_tokens: 4096 };
const REVIEWER_RUNG = { rung: 'medium', max_tokens: 1024 };

const iso = ms => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const parseIso = s => Date.parse(String(s).replace(' ', 'T') + 'Z');

export function normalizePath(p) {
  if (typeof p !== 'string' || !p || p.length > 300 || /[\0\\]/.test(p) || p.startsWith('/') || /^[a-zA-Z]:/.test(p)) return null;
  const parts = p.split('/');
  if (parts.some(x => x === '..' || x === '.' || x === '')) return null;
  return parts.join('/');
}
export function isProtected(path, list) {
  const p = path.toLowerCase();
  return list.some(e => { const x = e.toLowerCase(); return x.endsWith('/') ? p.startsWith(x) : p === x || p.startsWith(x + '/'); });
}

function parseJson(text) {
  let s = String(text ?? '').trim();
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) s = fence[1];
  try { return JSON.parse(s); } catch { return null; }
}

// Strict schema for the doer: { summary: string, files: [{ path, content }] } (whole-file replacements).
export function parseDoerOutput(text, { max_files, max_file_bytes }) {
  const obj = parseJson(text);
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { error: 'not a JSON object' };
  const extra = Object.keys(obj).filter(k => !['summary', 'files'].includes(k));
  if (extra.length) return { error: 'unexpected keys: ' + extra.join(',') };
  if (typeof obj.summary !== 'string' || !obj.summary.trim()) return { error: 'summary must be a non-empty string' };
  if (!Array.isArray(obj.files) || obj.files.length < 1 || obj.files.length > max_files) return { error: `files must be an array of 1..${max_files}` };
  const seen = new Set(), files = [];
  for (const f of obj.files) {
    if (!f || typeof f !== 'object' || typeof f.content !== 'string') return { error: 'each file needs path and string content' };
    const path = normalizePath(f.path);
    if (!path) return { error: 'invalid path: ' + String(f.path).slice(0, 80) };
    if (seen.has(path)) return { error: 'duplicate path: ' + path };
    if (f.content.length > max_file_bytes) return { error: 'file too large: ' + path };
    seen.add(path); files.push({ path, content: f.content });
  }
  return { summary: obj.summary.trim().slice(0, 500), files };
}
export function parseReviewOutput(text) {
  const obj = parseJson(text);
  if (!obj || typeof obj !== 'object' || !['approve', 'reject'].includes(obj.verdict)) return { error: 'verdict must be approve or reject' };
  const reasons = Array.isArray(obj.reasons) ? obj.reasons.map(String).filter(Boolean).slice(0, 10) : [];
  if (!reasons.length) return { error: 'reasons are required' };
  return { verdict: obj.verdict, reasons };
}

export function createRunner({ db, now = () => Date.now(), config = {}, env = {}, router, claims, vcs }) {
  const rc = config.runner || config;
  const c = { ...DEFAULTS, ...rc, doer: { ...DOER_RUNG, ...(rc.doer || {}) }, reviewer: { ...REVIEWER_RUNG, ...(rc.reviewer || {}) } };
  const protectedList = [...new Set([...DEFAULT_PROTECTED, ...(rc.protected_paths || [])])]; // config can add, never remove
  const cctx = () => ({ db, now, config: config.claims || {} });

  const all = async (sql, ...a) => (await db.prepare(sql).bind(...a).all()).results || [];
  const first = async (sql, ...a) => (await db.prepare(sql).bind(...a).first()) || null;
  const run = (sql, ...a) => db.prepare(sql).bind(...a).run();
  const scrub = t => { let s = String(t ?? ''); for (const v of Object.values(env || {})) if (typeof v === 'string' && v.length > 7) s = s.split(v).join('[redacted]'); return s.slice(0, 300); };
  const getRun = id => first(`SELECT * FROM runner_runs WHERE id = ?`, id);

  async function move(r, to, patch = {}, note = '') {
    const cols = { ...patch, state: to, error_count: 0, updated_at: iso(now()) };
    const keys = Object.keys(cols);
    const res = await run(`UPDATE runner_runs SET ${keys.map(k => k + ' = ?').join(', ')} WHERE id = ? AND state = ?`, ...keys.map(k => cols[k]), r.id, r.state);
    if (!res.meta.changes) return false; // another step moved it first
    await run(`INSERT INTO runner_events (run_id, at, from_state, to_state, note) VALUES (?,?,?,?,?)`, r.id, iso(now()), r.state, to, String(note).slice(0, 300));
    return true;
  }
  async function patchRun(r, patch) {
    const keys = Object.keys(patch);
    await run(`UPDATE runner_runs SET ${keys.map(k => k + ' = ?').join(', ')}, updated_at = ? WHERE id = ?`, ...keys.map(k => patch[k]), iso(now()), r.id);
  }
  async function card(id, what, why) {
    await run(`INSERT OR IGNORE INTO gate_cards (id, what, why_gated, default_in_effect, prepared_by_fleet, closing_probe) VALUES (?,?,?,?,?,?)`,
      id, String(what).slice(0, 300), String(why).slice(0, 600), 'the run is stopped and the item is blocked; nothing was merged or changed on the base branch', 'runner', 'manual');
  }
  async function outcome(r, result, evidence) {
    await run(`INSERT INTO outcomes (item_id, agent, surface, action_class, result, evidence) VALUES (?,?,?,?,?,?)`, r.item_id, c.holder, 'pull_request', 'doer_pr', result, String(evidence).slice(0, 500));
  }
  async function releaseClaim(r, why) {
    if (r.claim_token) { try { await claims.release(cctx(), { item_id: r.item_id, token: r.claim_token, outcome: why }); } catch { /* the reaper handles an expired claim */ } }
  }
  async function scorePrediction(r, passed) {
    if (!r.prediction_id) return;
    await run(`UPDATE predictions SET observed = ?, verdict = ? WHERE id = ? AND verdict IS NULL`, passed ? 1 : 0, passed ? 'hit' : 'miss', r.prediction_id);
  }

  // Stop a run for good: file a decision card, release the claim, block the item, void an unscored prediction.
  async function refuse(r, reason, what, why, result = null, evidence = '') {
    const cur = await getRun(r.id);
    if (!cur || TERMINAL_STATES.includes(cur.state)) return;
    await card(`runner-${r.id}-${reason}`, what, why);
    if (cur.prediction_id) await run(`UPDATE predictions SET verdict = 'void' WHERE id = ? AND verdict IS NULL`, cur.prediction_id);
    await releaseClaim(cur, 'refused:' + reason);
    await run(`UPDATE items SET status = 'blocked', blocker = ?, updated_at = ? WHERE id = ?`, `runner ${reason}: see decision card runner-${r.id}-${reason}`, iso(now()), r.item_id);
    if (result) await outcome(r, result, evidence || reason);
    await move(cur, 'refused', { reason }, `${reason}: ${why}`);
  }

  async function wip() { return (await first(`SELECT COUNT(*) AS n FROM runner_runs WHERE state NOT IN ('refused','pr_opened')`)).n; }

  async function buildContext(item) {
    const row = await first(`SELECT * FROM runner_item_context WHERE item_id = ?`, item.id) || {};
    const text = `${item.title}\n${item.done_check}`;
    const spec_ref = row.spec_ref || (text.match(/spec:\s*(\S+)/i) || [])[1] || null;
    let targets = [];
    try { targets = row.targets ? JSON.parse(row.targets) : []; } catch { targets = []; }
    if (!targets.length) targets = [...text.matchAll(/target:\s*([^\s,;]+)/gi)].map(m => m[1]);
    const test_path = row.test_path || (text.match(/\btest:\s*([^\s,;]+)/i) || [])[1] || null;
    const failing_test = row.failing_test || (text.match(/failing[ _]test:\s*(.+)/i) || [])[1] || null;
    const files = [];
    for (const t of targets) {
      const path = normalizePath(t);
      if (!path) throw new Error('invalid target path: ' + String(t).slice(0, 80));
      const content = await vcs.getFile(path, c.base_branch);
      files.push({ path, exists: content != null, content: (content ?? '').slice(0, c.max_file_bytes) });
    }
    let test = null;
    if (test_path && normalizePath(test_path)) test = { path: test_path, content: ((await vcs.getFile(test_path, c.base_branch)) ?? '').slice(0, c.max_file_bytes) };
    return {
      item: { id: item.id, title: item.title, done_check: item.done_check },
      spec_ref, spec_text: String(row.spec_text || '').slice(0, c.spec_text_chars), targets: files, test, failing_test,
    };
  }

  // Claim an item and create its run. Public so a person or a test can start one item directly.
  async function startRun(itemOrId) {
    const item = typeof itemOrId === 'string' ? await first(`SELECT * FROM items WHERE id = ?`, itemOrId) : itemOrId;
    if (!item) return { ok: false, reason: 'unknown_item' };
    if ((await wip()) >= c.max_wip) return { ok: false, reason: 'max_wip' };
    const cl = await claims.acquire(cctx(), { item_id: item.id, holder: c.holder, intent: `runner: ${item.title}`, ttl_minutes: c.claim_ttl_minutes });
    if (!cl.acquired) return { ok: false, reason: 'claim_' + (cl.reason || 'refused') };
    const t = iso(now());
    const ins = await run(`INSERT INTO runner_runs (item_id, state, claim_token, claim_fence, created_at, updated_at) VALUES (?, 'planned', ?, ?, ?, ?)`, item.id, cl.token, cl.fence, t, t);
    const r = await getRun(ins.meta.last_row_id);
    await run(`INSERT INTO runner_events (run_id, at, from_state, to_state, note) VALUES (?,?,?,?,?)`, r.id, t, null, 'planned', 'claimed');
    let ctx;
    try { ctx = await buildContext(item); } catch (e) {
      await refuse(r, 'context_error', `Runner could not build context for ${item.id}`, scrub(e.message));
      return { ok: false, reason: 'context_error', run_id: r.id };
    }
    if (!ctx.targets.length) {
      await refuse(r, 'no_target', `Item ${item.id} names no target file, so the runner cannot give a doer minimal context`,
        'add a runner_item_context row (spec_ref, spec_text, targets, test_path) or "target:" lines in the done check, then set the item ready');
      return { ok: false, reason: 'no_target', run_id: r.id };
    }
    const bad = ctx.targets.filter(f => isProtected(f.path, protectedList));
    if (bad.length) {
      await refuse(r, 'protected_path', `Item ${item.id} targets protected path(s): ${bad.map(f => f.path).join(', ')}`,
        'protected paths are owner-reviewed (docs/SELF-HOSTING.md section 4); a person must make this change', 'failed', 'targets a protected path');
      return { ok: false, reason: 'protected_path', run_id: r.id };
    }
    await patchRun(r, { context_json: JSON.stringify(ctx) });
    return { ok: true, run_id: r.id };
  }

  // One metered, capped model call. Returns { text, provider, model } or { stop, what } or { transient }.
  async function llm(r, kind, rungCfg, messages) {
    const cur = await getRun(r.id);
    if (cur.calls >= c.max_calls_per_item) return { stop: 'item_call_cap', what: `Item ${r.item_id} reached its model-call cap (${c.max_calls_per_item})` };
    if (cur.cost_usd >= c.max_usd_per_item) return { stop: 'item_cost_cap', what: `Item ${r.item_id} reached its spend cap (${c.max_usd_per_item} USD)` };
    const res = await router.call({ role: kind, kind, item_id: r.item_id, rung: rungCfg.rung, capabilities: ['json'], max_tokens: rungCfg.max_tokens, json: true, messages });
    if (!res.ok) {
      if (res.refusal === 'all_providers_failed') return { transient: true, error: scrub(JSON.stringify(res.attempts || [])) };
      const stop = res.refusal === 'hard_cap' ? 'budget' : res.refusal === 'kill_switch_all' ? 'kill_switch' : String(res.refusal || 'router_refused');
      return { stop, what: `Model call refused by the router: ${res.refusal}` };
    }
    await run(`UPDATE runner_runs SET calls = calls + 1, cost_usd = cost_usd + ? WHERE id = ?`, Number(res.cost_usd) || 0, r.id);
    return { text: res.text, provider: res.provider, model: res.model };
  }
  const stopped = (r, o) => refuse(r, o.stop, o.what, 'every model call respects the router caps and kill switch (US-SPEC-09); a person decides whether to raise a cap, wait for the period to reset, or take the item');

  const DOER_SYSTEM = 'You are a careful software engineer. Reply with ONLY a JSON object: {"summary": string, "files": [{"path": string, "content": string}]}. '
    + 'Each file is a COMPLETE replacement of that repository-relative path. Change only what the item requires, keep existing conventions, keep the license header used by the file. Do not touch workflow, license, scope or autonomy files.';

  async function doerRound(r) {
    const ctx = JSON.parse(r.context_json);
    if (!r.prediction_id) {
      // The prediction is written before the first doer call: will the repository checks pass? yes.
      const pid = `runner-${r.id}`;
      await run(`INSERT OR IGNORE INTO predictions (id, item_id, metric, op, target, due_at) VALUES (?, ?, 'runner_checks_pass', '=', 1, ?)`, pid, r.item_id, iso(now() + 7 * 86400e3));
      await patchRun(r, { prediction_id: pid }); r = { ...r, prediction_id: pid };
    }
    const user = { task: ctx.item, spec_reference: ctx.spec_ref, spec_text: ctx.spec_text, files: ctx.targets, test: ctx.test, failing_test: ctx.failing_test };
    if (r.feedback) {
      user.rework = { instruction: 'Your previous patch was not accepted. Fix every point below and return the full replacement files again.', feedback: r.feedback, previous_files: r.patch_json ? JSON.parse(r.patch_json) : [] };
    }
    const o = await llm(r, 'doer', c.doer, [{ role: 'system', content: DOER_SYSTEM }, { role: 'user', content: JSON.stringify(user) }]);
    if (o.transient) { await patchRun(r, { last_error: o.error }); return; }
    if (o.stop) return stopped(r, o);
    const parsed = parseDoerOutput(o.text, c);
    if (parsed.error) {
      const attempts = r.doer_attempts + 1;
      if (attempts >= c.max_doer_retries) return refuse(r, 'invalid_output', `Doer returned invalid output ${attempts} times for ${r.item_id}`, parsed.error, 'failed', 'invalid doer output');
      await patchRun(r, { doer_attempts: attempts, last_error: 'invalid doer output: ' + parsed.error });
      return;
    }
    const prot = parsed.files.filter(f => isProtected(f.path, protectedList));
    if (prot.length) {
      return refuse(r, 'protected_path', `Doer output for ${r.item_id} touches protected path(s): ${prot.map(f => f.path).join(', ')}`,
        'protected paths are owner-reviewed; nothing was pushed', 'failed', 'doer touched a protected path');
    }
    const slug = r.item_id.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
    const branch = r.branch || `${c.branch_prefix}${slug}-${r.id}`;
    await vcs.createBranch(branch, c.base_branch);
    const { sha } = await vcs.commitFiles({ branch, message: `${r.item_id}: ${parsed.summary}\n\nWritten by the runner; checks and review follow.`, files: parsed.files });
    await move(r, 'patched', { branch, head_sha: sha, patch_json: JSON.stringify(parsed.files), doer_attempts: 0, feedback: null, checks_since: iso(now()), last_error: null }, `pushed ${parsed.files.length} file(s)`);
  }

  async function pollChecks(r) {
    const res = await vcs.getChecks(r.head_sha || r.branch);
    const list = (res.checks || []).map(k => ({ name: k.name, state: k.state, detail: k.detail || '' }));
    if (res.state === 'pending') {
      const waited = (now() - parseIso(r.checks_since || r.updated_at)) / 60000;
      if (waited > c.checks_timeout_minutes) {
        return move(r, 'checks_failed', { checks_json: JSON.stringify(list), feedback: `checks did not finish within ${c.checks_timeout_minutes} minutes` }, 'checks timed out');
      }
      if (r.state === 'patched') await move(r, 'checks_pending', { checks_json: JSON.stringify(list) }, 'waiting for checks');
      return;
    }
    if (res.state === 'success') {
      await scorePrediction(r, true);
      return move(r, 'checks_passed', { checks_json: JSON.stringify(list) }, `${list.length} check(s) passed`);
    }
    await scorePrediction(r, false);
    const failed = list.filter(k => k.state === 'failure').map(k => `${k.name}: ${k.detail}`);
    return move(r, 'checks_failed', { checks_json: JSON.stringify(list), feedback: 'failing checks: ' + (failed.join('; ') || 'unspecified') }, 'checks failed');
  }

  async function toRework(r, feedback, hidden) {
    if (r.rework_count >= c.max_rework) {
      return refuse(r, 'rework_limit', `Item ${r.item_id} still fails after ${c.max_rework} rework rounds`, `last feedback: ${feedback}`.slice(0, 400), hidden ? 'hidden_failure' : 'failed', feedback);
    }
    await move(r, 'rework', { rework_count: r.rework_count + 1, feedback }, `rework ${r.rework_count + 1}: ${feedback}`.slice(0, 280));
  }

  const REVIEW_SYSTEM = 'You are an independent code reviewer. Reply with ONLY a JSON object: {"verdict": "approve" | "reject", "reasons": [string]}. '
    + 'Approve only if the diff satisfies the done check, the checks are real passes, and nothing outside the item changed. Give at least one reason either way.';

  async function review(r) {
    const ctx = JSON.parse(r.context_json);
    const diff = String(await vcs.getDiff(c.base_branch, r.head_sha || r.branch)).slice(0, c.max_diff_chars);
    const o = await llm(r, 'reviewer', c.reviewer, [{ role: 'system', content: REVIEW_SYSTEM },
      { role: 'user', content: JSON.stringify({ done_check: ctx.item.done_check, spec_reference: ctx.spec_ref, checks: JSON.parse(r.checks_json || '[]'), diff }) }]);
    if (o.transient) { await patchRun(r, { last_error: o.error }); return; }
    if (o.stop) return stopped(r, o);
    const v = parseReviewOutput(o.text);
    if (v.error) { await patchRun(r, { last_error: 'invalid reviewer output: ' + v.error }); return; }
    const review_json = JSON.stringify({ ...v, provider: o.provider, model: o.model });
    if (v.verdict === 'approve') return move(r, 'approved', { review_json }, 'reviewer approved');
    await patchRun(r, { review_json });
    return toRework(r, 'reviewer rejected: ' + v.reasons.join('; '), true); // checks were green: a defect the checks missed
  }

  async function openPr(r) {
    const ctx = JSON.parse(r.context_json), checks = JSON.parse(r.checks_json || '[]'), rv = JSON.parse(r.review_json || '{}');
    const body = [
      `Draft opened by the runner for item \`${r.item_id}\`: ${ctx.item.title}`,
      '',
      `**Serves:** ${ctx.spec_ref || 'the requirement named in the item'}${ctx.spec_text ? ' - ' + ctx.spec_text.split('\n')[0].slice(0, 200) : ''}`,
      `**Done check:** ${ctx.item.done_check}`,
      '',
      '## Check results (reported by the repository CI)',
      ...(checks.length ? checks.map(k => `- ${k.name}: ${k.state}${k.detail ? ' (' + k.detail + ')' : ''}`) : ['- no checks reported']),
      '',
      `## Independent review (${rv.provider || 'unknown provider'} / ${rv.model || 'unknown model'}): ${rv.verdict || 'n/a'}`,
      ...(rv.reasons || []).map(x => `- ${x}`),
      '',
      `Rework rounds: ${r.rework_count}. Model calls: ${r.calls}, cost: ${Number(r.cost_usd).toFixed(4)} USD.`,
      'The runner never merges. A person reviews and merges this draft.',
    ].join('\n');
    const pr = await vcs.openDraftPr({ branch: r.branch, title: `${r.item_id}: ${ctx.item.title}`.slice(0, 200), body, base: c.base_branch });
    await releaseClaim(r, 'pr_opened');
    await run(`UPDATE items SET status = 'blocked', blocker = ?, updated_at = ? WHERE id = ?`, `draft PR ${pr.url} awaiting a person to review and merge`, iso(now()), r.item_id);
    await outcome(r, 'verified', `draft PR ${pr.url}; checks passed; reviewer approved`);
    await move(r, 'pr_opened', { pr_number: pr.number, pr_url: pr.url }, 'draft pull request opened');
  }

  async function advance(r) {
    if (r.claim_token) { try { await claims.heartbeat(cctx(), { item_id: r.item_id, token: r.claim_token }); } catch { /* best effort */ } }
    switch (r.state) {
      case 'planned': case 'rework': return doerRound(r);
      case 'patched': case 'checks_pending': return pollChecks(r);
      case 'checks_passed': return move(r, 'reviewing', {}, 'checks green; sent to review');
      case 'checks_failed': return toRework(r, r.feedback || 'checks failed', false);
      case 'reviewing': return review(r);
      case 'approved': return openPr(r);
      default: return undefined;
    }
  }

  async function step() {
    const out = { advanced: 0, started: null, errors: [] };
    const active = await all(`SELECT * FROM runner_runs WHERE state NOT IN ('refused','pr_opened') ORDER BY id LIMIT ?`, c.max_advances_per_step);
    for (const r of active) {
      try { await advance(r); out.advanced++; } catch (e) {
        const msg = scrub(e?.message); out.errors.push(`run ${r.id}: ${msg}`);
        await patchRun(r, { last_error: msg, error_count: r.error_count + 1 });
        if (r.error_count + 1 >= c.max_errors) await refuse(r, 'repeated_errors', `Run ${r.id} for ${r.item_id} failed ${c.max_errors} times in a row`, msg);
      }
    }
    if (c.enabled === true && (await wip()) < c.max_wip) {
      const probe = await router.route({ role: 'doer', kind: 'doer', rung: c.doer.rung, capabilities: ['json'] });
      if (probe.ok) {
        const cands = await all(`SELECT * FROM items WHERE status = 'ready' AND owner_role = 'staff'
          AND id NOT IN (SELECT item_id FROM claims) AND id NOT IN (SELECT item_id FROM runner_runs WHERE state NOT IN ('refused','pr_opened'))
          ORDER BY priority, created_at LIMIT 3`);
        for (const item of cands) {
          const s = await startRun(item);
          if (s.ok) { out.started = s.run_id; break; }
          if (s.reason === 'max_wip') break;
        }
      } else if (probe.refusal === 'role_not_allowed') {
        // Only a model too weak for code changes is configured: ask for a stronger one instead of opening a bad PR.
        const next = await first(`SELECT id FROM items WHERE status = 'ready' AND owner_role = 'staff'
          AND id NOT IN (SELECT item_id FROM claims) AND id NOT IN (SELECT item_id FROM runner_runs WHERE state NOT IN ('refused','pr_opened'))
          ORDER BY priority, created_at LIMIT 1`);
        if (next) {
          await card(`runner-${next.id}-stronger-model`, `A stronger model is needed for code changes (${next.id})`,
            'only a small keyless model is configured and the router refuses it for the doer role; add a provider key for a stronger model in the console, or allow the role in router.rung_roles');
          await run(`UPDATE items SET status = 'blocked', blocker = ?, updated_at = ? WHERE id = ?`, `a stronger model is needed for code changes: see decision card runner-${next.id}-stronger-model`, iso(now()), next.id);
          out.errors.push('doer refused: stronger model needed for ' + next.id);
        } else out.errors.push('not selecting: router role_not_allowed');
      } else out.errors.push('not selecting: router ' + probe.refusal);
    }
    return out;
  }

  async function status() {
    const by_state = {};
    for (const r of await all(`SELECT state, COUNT(*) AS n FROM runner_runs GROUP BY state`)) by_state[r.state] = r.n;
    const active = await all(`SELECT id, item_id, state, rework_count, cost_usd, branch, last_error FROM runner_runs WHERE state NOT IN ('refused','pr_opened') ORDER BY id`);
    const tot = await first(`SELECT COALESCE(SUM(cost_usd),0) AS usd, COUNT(*) AS runs FROM runner_runs`);
    return { enabled: c.enabled === true, wip: active.length, max_wip: c.max_wip, by_state, active, total_cost_usd: tot.usd, runs: tot.runs, protected_paths: protectedList };
  }

  const extraSteps = () => [{
    name: 'runner',
    run: async (_db, ctx) => {
      const r = await step();
      ctx?.notes?.push(`runner advanced ${r.advanced}${r.started ? `, started run ${r.started}` : ''}`);
      if (r.errors.length) ctx?.errors?.push(...r.errors.map(e => `runner ${e}`));
    },
  }];

  return { step, startRun, status, extraSteps };
}

// Wiring helper: runTick(db, { config, extraSteps: [...L2_EXTRA_STEPS, ...runnerExtraSteps(runner)] }).
export const runnerExtraSteps = runner => runner.extraSteps();
