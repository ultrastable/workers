// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Failure-mode register, remediation contracts, loop breaker and remedies (US-SPEC-17, US-SPEC-05 s5).
import { all, first, run, iso, parseIso, compare, improvement, assertReadOnly, ensureItem } from './util.js';
import { readMetric } from './metrics.js';

// ---- Register and detectors -------------------------------------------------------------------

const FIRE_RE = /^\s*value\s*(>=|<=|>|<|=)\s*(-?\d+(?:\.\d+)?)\s*(\*\s*expected)?\s*$/;
export function parseFireWhen(s) {
  const m = FIRE_RE.exec(s || '');
  return m ? { op: m[1], n: Number(m[2]), times_expected: Boolean(m[3]) } : null;
}
const PASS_RE = /^\s*(>=|<=|>|<|=)\s*(-?\d+(?:\.\d+)?)\s*$/;

function checkContract(c) {
  for (const f of ['owner', 'doer', 'closing_probe', 'pass', 'max_attempts', 'backoff_h', 'deadline_h']) {
    if (c[f] === undefined || c[f] === null || c[f] === '') throw new Error(`remediation contract requires ${f}`);
  }
  assertReadOnly(c.closing_probe);
  if (!PASS_RE.test(c.pass)) throw new Error('contract pass must look like "= 0"');
  if (!Array.isArray(c.backoff_h) || !c.backoff_h.length) throw new Error('backoff_h must be a non-empty array');
}

// US-17-R03/R04: a detector, a severity and a full contract are required to register a failure mode.
export async function registerFailureMode(db, fm, now = Date.now()) {
  assertReadOnly(fm.detector_sql);
  if (!parseFireWhen(fm.fire_when)) throw new Error('fire_when must look like "value < 0.8*expected" or "value > 0"');
  if (!Number.isInteger(fm.severity) || fm.severity < 1 || fm.severity > 5) throw new Error('severity must be 1..5');
  checkContract(fm.contract);
  await run(db, `INSERT INTO kernel_failure_modes (id, name, surface, detector_sql, fire_when, severity, contract_json, interval_h, first_seen)
      VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, surface=excluded.surface, detector_sql=excluded.detector_sql, fire_when=excluded.fire_when,
        severity=excluded.severity, contract_json=excluded.contract_json, interval_h=excluded.interval_h`,
    fm.id, fm.name ?? null, fm.surface ?? null, fm.detector_sql, fm.fire_when, fm.severity, JSON.stringify(fm.contract), fm.interval_h ?? 1, iso(now));
}

async function openRemediation(db, fm, nowIso) {
  const open = await first(db, `SELECT 1 AS x FROM kernel_remediations WHERE fm_id = ? AND status IN ('open','needs_human')`, fm.id);
  if (open) return null;
  const c = JSON.parse(fm.contract_json);
  const itemId = `FM-${fm.id}-${nowIso.slice(0, 13).replace(/[- :]/g, '')}`;
  await ensureItem(db, {
    id: itemId, title: `Failure mode ${fm.id} fired${fm.name ? `: ${fm.name}` : ''}`, owner_role: c.owner, doer: c.doer,
    priority: Math.max(0, 5 - fm.severity), done_check: `closing probe passes: ${c.closing_probe} ${c.pass}`, closing_probe: c.closing_probe,
    surface: fm.surface, critical: fm.severity >= 4,
  });
  const [, pop, pval] = PASS_RE.exec(c.pass);
  await run(db, `INSERT OR IGNORE INTO kernel_remediations (item_id, fm_id, severity, owner, doer, alt_doers, trigger_kind, closing_probe, pass_op, pass_value,
      max_attempts, backoff_h, deadline_h, interrupt_eligible, next_attempt_at, opened_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    itemId, fm.id, fm.severity, c.owner, c.doer, JSON.stringify(c.alt_doers || []), c.trigger || 'on_fire', c.closing_probe, pop, Number(pval),
    c.max_attempts, JSON.stringify(c.backoff_h), c.deadline_h, c.interrupt_eligible ? 1 : 0, nowIso, nowIso);
  return itemId;
}

// US-17-R01: one hit row per run, fired or not. A detector error is a row too (value null), never silence.
export async function runDetectors(db, { now = Date.now() } = {}) {
  const nowIso = iso(now);
  const fired = [];
  for (const fm of await all(db, `SELECT * FROM kernel_failure_modes WHERE status IN ('armed','probation') ORDER BY id`)) {
    let value = null, expected = null, evidence = null, fire = 0;
    try {
      const row = await first(db, assertReadOnly(fm.detector_sql));
      value = row && row.value !== null && row.value !== undefined ? Number(row.value) : null;
      expected = row && row.expected !== null && row.expected !== undefined ? Number(row.expected) : null;
      const w = parseFireWhen(fm.fire_when);
      const rhs = w.times_expected ? (expected === null ? null : w.n * expected) : w.n;
      fire = value !== null && rhs !== null && compare(w.op, value, rhs) ? 1 : 0;
      if (value === null) evidence = 'detector returned no value';
    } catch (e) { evidence = `detector error: ${e.message}`; }
    await run(db, `INSERT INTO kernel_failure_mode_hits (fm_id, ts, value, expected, fired, evidence) VALUES (?,?,?,?,?,?)`, fm.id, nowIso, value, expected, fire, evidence);
    if (fire) {
      await run(db, `UPDATE kernel_failure_modes SET last_fired = ? WHERE id = ?`, nowIso, fm.id);
      if (fm.status === 'armed') fired.push({ fm: fm.id, item: await openRemediation(db, fm, nowIso) });
    }
  }
  return fired;
}

// FM-FROZEN applied to the register itself: an armed detector with no hit row for 2 intervals is a failure.
// The age is computed from the clock passed in with the data it compares (US-17-R02 / US-05-R14).
export async function detectStaleDetectors(db, { now = Date.now() } = {}) {
  const filed = [];
  for (const fm of await all(db, `SELECT id, interval_h, first_seen FROM kernel_failure_modes WHERE status = 'armed'`)) {
    const last = await first(db, `SELECT MAX(ts) AS ts FROM kernel_failure_mode_hits WHERE fm_id = ?`, fm.id);
    const ref = parseIso(last.ts || fm.first_seen);
    const ratio = (now - ref) / 3600e3 / fm.interval_h;
    if (ratio > 2) {
      const id = `FM-STALE-${fm.id}-${iso(now).slice(0, 10)}`;
      if (await ensureItem(db, { id, title: `Detector ${fm.id} has written no hit row for ${ratio.toFixed(1)} intervals`, owner_role: 'operations', priority: 1,
        done_check: `a hit row for ${fm.id} is newer than 2 intervals` })) filed.push(id);
    }
  }
  return filed;
}

// US-17-R09: a detector whose last `window` confirmed firings were mostly false goes to probation.
export async function confirmFiring(db, hitId, real) {
  await run(db, `UPDATE kernel_failure_mode_hits SET confirmed = ? WHERE id = ?`, real ? 1 : 0, hitId);
}
export async function reviewProbation(db, { window = 10, min_share = 0.5 } = {}) {
  const demoted = [];
  for (const fm of await all(db, `SELECT id FROM kernel_failure_modes WHERE status = 'armed'`)) {
    const rows = await all(db, `SELECT confirmed FROM kernel_failure_mode_hits WHERE fm_id = ? AND fired = 1 AND confirmed IS NOT NULL ORDER BY id DESC LIMIT ?`, fm.id, window);
    if (rows.length < window) continue;
    if (rows.filter(r => r.confirmed === 1).length / rows.length < min_share) {
      await run(db, `UPDATE kernel_failure_modes SET status = 'probation' WHERE id = ?`, fm.id); demoted.push(fm.id);
    }
  }
  return demoted;
}

// US-17-T06: classify a payload by structure. A key named "failed" holding a count is not a failure.
export function payloadIsFailure(payload) {
  let o = payload;
  if (typeof payload === 'string') { try { o = JSON.parse(payload); } catch { return false; } }
  if (!o || typeof o !== 'object') return false;
  if (o.ok === false || o.success === false) return true;
  if (typeof o.error === 'string' && o.error) return true;
  if (o.error && typeof o.error === 'object') return true;
  if (typeof o.exception === 'string' && o.exception) return true;
  return false;
}

// ---- Remediation consumer and accounting invariant ---------------------------------------------

// US-17-R05: scanned == executed + failed + needs_human + no_action, else an incident and the unaccounted items reopen.
export async function recordLoopRun(db, { loop, scanned, executed = 0, failed = 0, needs_human = 0, no_action = 0, unaccounted_item_ids = [], now = Date.now() }) {
  const balanced = scanned === executed + failed + needs_human + no_action ? 1 : 0;
  await run(db, `INSERT INTO kernel_loop_runs (loop, scanned, executed, failed, needs_human, no_action, balanced, at) VALUES (?,?,?,?,?,?,?,?)`,
    loop, scanned, executed, failed, needs_human, no_action, balanced, iso(now));
  let incident = null; let reopened = 0;
  if (!balanced) {
    incident = `UNACCOUNTED-${loop}-${iso(now).slice(0, 13).replace(/[- :]/g, '')}`;
    await ensureItem(db, { id: incident, title: `Loop ${loop} scanned ${scanned} but booked ${executed + failed + needs_human + no_action}`, owner_role: 'operations', priority: 0,
      done_check: 'next run of the loop balances: scanned = executed + failed + needs_human + no_action' });
    for (const id of unaccounted_item_ids) {
      await run(db, `UPDATE items SET status = 'open', updated_at = ? WHERE id = ?`, iso(now), id); reopened++;
    }
  }
  return { balanced: Boolean(balanced), incident, reopened };
}

export async function consumeRemediations(db, { now = Date.now(), invokeDoer = null } = {}) {
  const nowIso = iso(now);
  const b = { scanned: 0, executed: 0, failed: 0, needs_human: 0, no_action: 0 };
  const rems = await all(db, `SELECT * FROM kernel_remediations WHERE status = 'open' ORDER BY severity DESC, opened_at, item_id`);
  for (const r of rems) {
    b.scanned++;
    if (r.next_attempt_at > nowIso) { b.no_action++; continue; }
    if (invokeDoer) { try { await invokeDoer(r); } catch { /* the doer failing is recorded by the probe below */ } }
    let value = null, err = null;
    try { const row = await first(db, assertReadOnly(r.closing_probe)); value = row ? Number(row.value ?? Object.values(row)[0]) : null; } catch (e) { err = e.message; }
    if (value !== null && !Number.isNaN(value) && compare(r.pass_op, value, r.pass_value)) {
      // US-17-R06: closes only when the closing probe passes.
      await run(db, `UPDATE items SET status='done', disposition=?, updated_at=? WHERE id=?`, `closed by probe: ${r.closing_probe} = ${value}`, nowIso, r.item_id);
      await run(db, `UPDATE kernel_remediations SET status='closed', evidence=? WHERE item_id=?`, `probe value ${value}`, r.item_id);
      b.executed++; continue;
    }
    const attempts = r.attempts + 1;
    const deadlinePassed = now > parseIso(r.opened_at) + r.deadline_h * 3600e3;
    if (attempts >= r.max_attempts || deadlinePassed) {
      b.needs_human++;
      await escalate(db, r, nowIso, err || `probe value ${value}`);
      continue;
    }
    const backoff = JSON.parse(r.backoff_h);
    const wait = backoff[Math.min(attempts - 1, backoff.length - 1)];
    await run(db, `UPDATE kernel_remediations SET attempts=?, next_attempt_at=?, evidence=? WHERE item_id=?`, attempts, iso(now + wait * 3600e3), err || `probe value ${value}`, r.item_id);
    b.failed++;
  }
  const acct = await recordLoopRun(db, { loop: 'remediation', ...b, now });
  return { ...b, balanced: acct.balanced };
}

// US-17-R07: after max_attempts, interrupt-eligible work goes through the gate; everything else is reassigned.
async function escalate(db, r, nowIso, evidence) {
  if (r.interrupt_eligible) {
    await run(db, `INSERT OR IGNORE INTO gate_cards (id, what, why_gated, default_in_effect, prepared_by_fleet, closing_probe) VALUES (?,?,?,?,?,?)`,
      `GATE-${r.item_id}`, `Remediation ${r.item_id} exhausted ${r.max_attempts} attempts`, 'irreversible and identity-bound step remains',
      'the item stays open; nothing further is attempted', `evidence: ${evidence}`, `item_done:${r.item_id}`);
    await run(db, `UPDATE kernel_remediations SET status='needs_human', evidence=? WHERE item_id=?`, evidence, r.item_id);
    return;
  }
  const alts = JSON.parse(r.alt_doers || '[]');
  const idx = alts.indexOf(r.doer);
  const next = alts[idx + 1];
  if (next) {
    await run(db, `UPDATE kernel_remediations SET doer=?, attempts=0, next_attempt_at=?, evidence=? WHERE item_id=?`, next, nowIso, `reassigned from ${r.doer}: ${evidence}`, r.item_id);
    await run(db, `INSERT INTO kernel_item_meta (item_id, doer) VALUES (?, ?) ON CONFLICT(item_id) DO UPDATE SET doer = excluded.doer`, r.item_id, next);
  } else {
    await run(db, `UPDATE kernel_remediations SET status='exhausted', evidence=? WHERE item_id=?`, evidence, r.item_id);
    await run(db, `UPDATE items SET status='blocked', blocker=?, updated_at=? WHERE id=?`, `all doers exhausted: ${evidence}`, nowIso, r.item_id);
  }
}

// ---- Loop breaker (US-17 s5) --------------------------------------------------------------------

export async function canAttempt(db, target, signature, now = Date.now()) {
  const b = await first(db, `SELECT * FROM kernel_breakers WHERE target = ? AND signature = ?`, target, signature);
  if (!b || b.state !== 'open') return { allowed: true };
  return parseIso(b.half_open_at) <= now ? { allowed: true, half_open: true } : { allowed: false, until: b.half_open_at };
}

export async function recordAttempt(db, { target, signature, ok, now = Date.now(), k = 3, window_h = 24, half_open_h = 24 }) {
  await run(db, `INSERT INTO kernel_attempts (target, signature, ok, at) VALUES (?,?,?,?)`, target, signature, ok ? 1 : 0, iso(now));
  const b = await first(db, `SELECT * FROM kernel_breakers WHERE target = ? AND signature = ?`, target, signature);
  if (ok) {
    if (b && b.state === 'open') await run(db, `UPDATE kernel_breakers SET state='closed' WHERE target=? AND signature=?`, target, signature);
    return { state: 'closed' };
  }
  if (b && b.state === 'open') { // a failed half-open probe extends the interval
    const interval = b.interval_h * 2;
    await run(db, `UPDATE kernel_breakers SET interval_h=?, half_open_at=? WHERE target=? AND signature=?`, interval, iso(now + interval * 3600e3), target, signature);
    return { state: 'open', half_open_at: iso(now + interval * 3600e3), extended: true };
  }
  const n = (await first(db, `SELECT COUNT(*) AS n FROM kernel_attempts WHERE target=? AND signature=? AND ok=0 AND at >= ?`, target, signature, iso(now - window_h * 3600e3))).n;
  if (n < k) return { state: 'closed', failures: n };
  const slug = `${target}-${signature}`.replace(/[^A-Za-z0-9]+/g, '-').slice(0, 60);
  const root = `ROOTCAUSE-${slug}`;
  await ensureItem(db, { id: root, title: `Retry loop on ${target} (${signature}) opened the breaker after ${n} failures`, owner_role: 'operations', priority: 1,
    done_check: `a half-open probe of ${target} passes, or the cause is changed`, closing_probe: `half-open probe of ${target}` });
  const halfOpen = iso(now + half_open_h * 3600e3);
  await run(db, `INSERT INTO kernel_breakers (target, signature, state, opened_at, half_open_at, interval_h, root_item_id) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(target, signature) DO UPDATE SET state='open', opened_at=excluded.opened_at, half_open_at=excluded.half_open_at, interval_h=excluded.interval_h, root_item_id=excluded.root_item_id`,
    target, signature, 'open', iso(now), halfOpen, half_open_h, root);
  return { state: 'open', failures: n, root_item_id: root, half_open_at: halfOpen };
}

// ---- Remedies: a remedy that did not move its metric is replaced, not repeated -----------------

const fingerprint = (s) => String(s).toLowerCase().replace(/\s+/g, ' ').trim();

export async function proposeRemedy(db, { id, metric_id, description, window_h = 168, min_delta = 0, now = Date.now() }) {
  if (!id || !metric_id || !description) throw new Error('remedy needs id, metric_id and description');
  const fp = fingerprint(description);
  if (await first(db, `SELECT 1 AS x FROM kernel_remedies WHERE metric_id = ? AND fingerprint = ? AND status = 'replaced'`, metric_id, fp)) {
    throw new Error('remedy repeats one that already failed to move this metric; propose a different approach');
  }
  if (await first(db, `SELECT 1 AS x FROM kernel_remedies WHERE metric_id = ? AND status = 'active'`, metric_id)) {
    throw new Error('one remedy at a time per metric (self-change protocol)');
  }
  const baseline = (await readMetric(db, metric_id, now)).value;
  await run(db, `INSERT INTO kernel_remedies (id, metric_id, description, fingerprint, applied_at, window_h, baseline, min_delta) VALUES (?,?,?,?,?,?,?,?)`,
    id, metric_id, description, fp, iso(now), window_h, baseline, min_delta);
  return { id, baseline };
}

export async function judgeRemedies(db, { now = Date.now() } = {}) {
  const out = [];
  for (const r of await all(db, `SELECT * FROM kernel_remedies WHERE status = 'active'`)) {
    if (parseIso(r.applied_at) + r.window_h * 3600e3 > now) continue;
    const m = await first(db, `SELECT op, target FROM kernel_metrics WHERE id = ?`, r.metric_id);
    const observed = (await readMetric(db, r.metric_id, now)).value;
    const gain = improvement(m.op, m.target, r.baseline, observed);
    const moved = gain !== null && gain > 0 && gain >= r.min_delta;
    if (moved) {
      await run(db, `UPDATE kernel_remedies SET status='effective', observed=?, outcome=? WHERE id=?`, observed, `moved ${gain}`, r.id);
      out.push({ id: r.id, status: 'effective' }); continue;
    }
    const item = `REMEDY-REPLACE-${r.id}`;
    await ensureItem(db, { id: item, title: `Remedy ${r.id} did not move ${r.metric_id} in ${r.window_h}h; replace it with a different approach, not a repeat of: ${r.description}`,
      owner_role: 'operations', priority: 2, metric_id: r.metric_id, done_check: `a different remedy for ${r.metric_id} is proposed with its own prediction` });
    await run(db, `UPDATE kernel_remedies SET status='replaced', observed=?, outcome=?, replacement_item_id=? WHERE id=?`, observed, gain === null ? 'unmeasured' : `no movement (${gain})`, item, r.id);
    out.push({ id: r.id, status: 'replaced', item });
  }
  return out;
}
