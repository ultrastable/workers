// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Failure modes and remediation, the parts beside the kernel register (US-SPEC-17): a status view over the register, the
// standard detectors, registration on the second sighting, an external liveness detector, silent-drop reconciliation across
// loops and across the item set, the roster detector with the emitter set, a breaker for ledgers whose writer has none,
// and closure of a fix on production evidence only. The register, contracts and breaker themselves are core/kernel/failure.js.
// Ports only: ctx = { db, now(), config, probeDb?, rosters?: { registry(), live(), scanner?(), probes?(), emitters?() },
//                     ledgers?: [{ name, read(cursor) -> [{id, target, error, ok, at}] }], stores? }.
import { registerFailureMode, recordAttempt, canAttempt } from '../kernel/failure.js';
export { visibilityRatio } from '../claims/gate.js'; // US-17-R11: one implementation, in core/claims

const DEFAULTS = {
  host: 'remediation', owner_role: 'operations', doer: 'operations', stale_intervals: 2, breaker_k: 3, breaker_window_h: 24, half_open_h: 24,
  sighting_contract: { max_attempts: 3, backoff_h: [1, 4, 24], deadline_h: 72 }, expected_loops: [], production_evidence: ['deployment', 'production_probe'],
};
export const cfg = ctx => ({ ...DEFAULTS, ...(ctx.config || {}) });
const nowMs = ctx => { const v = ctx.now(); return v instanceof Date ? v.getTime() : v; };
const iso = ms => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const parseIso = s => Date.parse(String(s).replace(' ', 'T') + 'Z');
const all = async (db, sql, ...a) => (await db.prepare(sql).bind(...a).all()).results || [];
const first = async (db, sql, ...a) => (await db.prepare(sql).bind(...a).first()) || null;
const run = (db, sql, ...a) => db.prepare(sql).bind(...a).run();
const slug = s => String(s).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
const ident = s => { if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(s))) throw new Error(`not an identifier: ${s}`); return String(s); };
const hasTable = async (db, name) => !!(await first(db, `SELECT name FROM sqlite_master WHERE type='table' AND name=?`, name));
async function openItem(ctx, id, title, doneCheck, probe, priority) {
  const r = await run(ctx.db, `INSERT OR IGNORE INTO items (id,title,kind,owner_role,done_check,closing_probe,priority,status) VALUES (?,?,'fix',?,?,?,?,'open')`,
    id, String(title).slice(0, 300), cfg(ctx).owner_role, doneCheck, probe, priority);
  return r.meta.changes > 0;
}
const hit = (ctx, detector, value, expected, fired, evidence) => run(ctx.db, `INSERT INTO remediation_hits (detector, host, ts, value, expected, fired, evidence) VALUES (?,?,?,?,?,?,?)`,
  detector, cfg(ctx).host, iso(nowMs(ctx)), value, expected, fired ? 1 : 0, evidence ? String(evidence).slice(0, 500) : null);

// ---- status view over the register -------------------------------------------------------------

/** One row per failure mode: its detector's last run, firings, staleness, and the open remediation with its retry bound and deadline. */
export async function statusView(ctx) {
  const c = cfg(ctx), now = nowMs(ctx), modes = [];
  for (const fm of await all(ctx.db, `SELECT * FROM kernel_failure_modes ORDER BY severity DESC, id`)) {
    const agg = await first(ctx.db, `SELECT COUNT(*) AS hits, COALESCE(SUM(fired), 0) AS fires, MAX(ts) AS last_hit FROM kernel_failure_mode_hits WHERE fm_id = ?`, fm.id);
    const last = await first(ctx.db, `SELECT value, expected, fired, evidence FROM kernel_failure_mode_hits WHERE fm_id = ? ORDER BY id DESC LIMIT 1`, fm.id);
    const rem = await first(ctx.db, `SELECT item_id, status, doer, attempts, max_attempts, deadline_h, opened_at, next_attempt_at FROM kernel_remediations WHERE fm_id = ? ORDER BY opened_at DESC LIMIT 1`, fm.id);
    const intervals = (now - parseIso(agg.last_hit || fm.first_seen)) / 3600e3 / fm.interval_h;
    let contract = {}; try { contract = JSON.parse(fm.contract_json); } catch { /* reported as incomplete below */ }
    modes.push({
      id: fm.id, name: fm.name, surface: fm.surface, severity: fm.severity, status: fm.status, interval_h: fm.interval_h,
      hits: agg.hits, fires: agg.fires, last_hit: agg.last_hit, last_fired: fm.last_fired, last_value: last ? last.value : null, last_expected: last ? last.expected : null,
      firing: !!(last && last.fired), stale: fm.status === 'armed' && intervals > c.stale_intervals, intervals_since_hit: Math.round(intervals * 100) / 100,
      contract_complete: ['owner', 'doer', 'closing_probe', 'max_attempts', 'backoff_h', 'deadline_h'].every(f => contract[f] !== undefined && contract[f] !== null && contract[f] !== ''),
      remediation: rem && { item_id: rem.item_id, status: rem.status, doer: rem.doer, attempts: rem.attempts, max_attempts: rem.max_attempts,
        deadline_at: iso(parseIso(rem.opened_at) + rem.deadline_h * 3600e3), past_deadline: now > parseIso(rem.opened_at) + rem.deadline_h * 3600e3, next_attempt_at: rem.next_attempt_at },
    });
  }
  const breakers = await all(ctx.db, `SELECT target, signature, state, opened_at, half_open_at, root_item_id FROM kernel_breakers WHERE state = 'open' ORDER BY target, signature`);
  const count = f => modes.filter(f).length;
  return {
    at: iso(now), modes, open_breakers: breakers,
    totals: { modes: modes.length, armed: count(m => m.status === 'armed'), probation: count(m => m.status === 'probation'), firing: count(m => m.firing), stale: count(m => m.stale),
      open_remediations: count(m => m.remediation && m.remediation.status === 'open'), needs_human: count(m => m.remediation && m.remediation.status === 'needs_human'), open_breakers: breakers.length },
  };
}

// ---- standard detectors ------------------------------------------------------------------------

/** FM-FROZEN: the clock is read in the same statement as the data (US-17-R02). Fires when value > 2. */
export function frozenSql({ table, ts_column = 'ts', interval_min }) {
  if (!(Number(interval_min) > 0)) throw new Error('interval_min must be positive');
  // julianday reads 'YYYY-MM-DD HH:MM:SS' and the T form alike, so the statement needs no string rewriting of the timestamp
  return `SELECT (julianday('now') - julianday(MAX(${ident(ts_column)}))) * 1440.0 / ${Number(interval_min)} AS value, 2.0 AS expected FROM ${ident(table)}`;
}
/** FM-MASKED: rows whose status says ok while the payload says ok false or names an error or exception. Structured match, not substring. */
export function maskedSql({ table, status_column = 'status', payload_column = 'payload', ok_value = 'ok' }) {
  const p = ident(payload_column);
  return `SELECT COUNT(*) AS value FROM ${ident(table)} WHERE ${ident(status_column)} = '${ident(ok_value)}' AND json_valid(${p}) AND (json_extract(${p}, '$.ok') = 0
    OR json_extract(${p}, '$.success') = 0 OR json_type(${p}, '$.error') IN ('text','object') OR json_type(${p}, '$.exception') = 'text')`;
}
const UNACCOUNTED_SQL = `SELECT COALESCE(SUM(scanned - executed - failed - needs_human - no_action), 0) AS value FROM kernel_loop_runs WHERE id IN (SELECT MAX(id) FROM kernel_loop_runs GROUP BY loop)`;
const retrySql = (k, hours) => `SELECT COUNT(*) AS value FROM (SELECT target, signature FROM kernel_attempts WHERE ok = 0 AND at >= datetime('now', '-${Number(hours)} hours') GROUP BY target, signature HAVING COUNT(*) > ${Number(k)})`;

/**
 * Register the standard failure modes in the kernel register, each with a detector, a severity and a full contract
 * (owner, doer, trigger, closing probe, retry bound, deadline). `frozen` and `masked` name the tables to watch.
 */
export async function installStandard(ctx, { frozen = [], masked = [], contract = {} } = {}) {
  const c = cfg(ctx), base = { owner: c.owner_role, doer: c.doer, trigger: 'on_fire', max_attempts: 3, backoff_h: [1, 4, 24], deadline_h: 72, ...contract };
  const defs = [
    { id: 'FM-UNACCOUNTED', name: 'scanned minus the sum of outcome buckets', surface: 'loops', severity: 5, detector_sql: UNACCOUNTED_SQL, fire_when: 'value > 0', contract: { ...base, closing_probe: UNACCOUNTED_SQL, pass: '= 0' } },
    { id: 'FM-UNBOUNDED-RETRY', name: 'same target and error retried past the breaker bound', surface: 'retries', severity: 4, detector_sql: retrySql(c.breaker_k, c.breaker_window_h), fire_when: 'value > 0',
      contract: { ...base, closing_probe: retrySql(c.breaker_k, c.breaker_window_h), pass: '= 0' } },
    ...frozen.map(f => ({ id: `FM-FROZEN-${slug(f.table)}`, name: `${f.table} stopped being written`, surface: f.table, severity: f.severity ?? 4, interval_h: f.interval_min / 60,
      detector_sql: frozenSql(f), fire_when: 'value > 2', contract: { ...base, closing_probe: frozenSql(f), pass: '<= 2' } })),
    ...masked.map(m => ({ id: `FM-MASKED-${slug(m.table)}`, name: `${m.table} rows report ok over a failing payload`, surface: m.table, severity: m.severity ?? 4,
      detector_sql: maskedSql(m), fire_when: 'value > 0', contract: { ...base, closing_probe: maskedSql(m), pass: '= 0' } })),
  ];
  for (const d of defs) await registerFailureMode(ctx.db, d, nowMs(ctx));
  return defs.map(d => d.id);
}

// ---- a failure found twice without a detector is registered (US-17-R03) ------------------------

/**
 * Report a failure that no detector caught. The second sighting of a signature registers a failure mode whose detector
 * counts sightings in the last interval, with a severity and a full contract, unless one is already registered for it.
 */
export async function reportFailure(ctx, { signature, surface = null, severity = 3, detail = null } = {}) {
  if (!signature) throw new Error('a sighting needs a signature');
  const c = cfg(ctx), now = nowMs(ctx), at = iso(now), sig = slug(signature);
  await run(ctx.db, `INSERT INTO remediation_sighting_log (signature, at, detail) VALUES (?,?,?)`, sig, at, detail ? String(detail).slice(0, 500) : null);
  await run(ctx.db, `INSERT INTO remediation_sightings (signature, surface, count, first_seen, last_seen) VALUES (?,?,1,?,?)
    ON CONFLICT(signature) DO UPDATE SET count = count + 1, last_seen = excluded.last_seen`, sig, surface, at, at);
  const s = await first(ctx.db, `SELECT * FROM remediation_sightings WHERE signature = ?`, sig);
  if (s.count < 2 || s.fm_id) return { signature: sig, count: s.count, registered: false, fm_id: s.fm_id };
  const fmId = `FM-SEEN-${sig}`;
  if (!(await first(ctx.db, `SELECT id FROM kernel_failure_modes WHERE id = ?`, fmId))) {
    // the signature is referenced by row number, so no word inside it can be mistaken for SQL by the register's read-only check
    const { rowid } = await first(ctx.db, `SELECT rowid FROM remediation_sightings WHERE signature = ?`, sig);
    const sql = `SELECT COUNT(*) AS value FROM remediation_sighting_log WHERE signature = (SELECT signature FROM remediation_sightings WHERE rowid = ${Number(rowid)}) AND at >= datetime('now', '-1 hours')`;
    await registerFailureMode(ctx.db, { id: fmId, name: `seen twice without a detector: ${signature}`.slice(0, 200), surface, severity, detector_sql: sql, fire_when: 'value > 0',
      contract: { owner: c.owner_role, doer: c.doer, trigger: 'on_fire', closing_probe: sql, pass: '= 0', ...c.sighting_contract } }, now);
  }
  await run(ctx.db, `UPDATE remediation_sightings SET fm_id = ? WHERE signature = ?`, fmId, sig);
  return { signature: sig, count: s.count, registered: true, fm_id: fmId };
}

// ---- external liveness detector (US-17-R10) ----------------------------------------------------

/**
 * Watch a probe table from outside its writer. The check refuses to run in the worker that writes the table (a monitor
 * cannot detect its own stop). It reads the table through `ctx.probeDb`, takes the clock in the same statement as the
 * data, and writes one hit row in this module's own store, fired or not. An unreadable table fires: silence is not a pass.
 */
export async function externalLiveness(ctx, { table, ts_column = 'ts', interval_min, writer } = {}) {
  const c = cfg(ctx), name = `LIVENESS-${slug(table)}`;
  if (!writer) throw new Error('name the worker that writes the probe table');
  if (writer === c.host) {
    await hit(ctx, name, null, null, false, `refused: hosted in ${c.host}, the writer of ${table}`);
    await openItem(ctx, `${name}-SAME-HOST`, `The liveness detector for ${table} is hosted in its writer ${writer}`, `the detector runs in a worker other than ${writer}`, `remediation_hits: a ${name} row with host other than ${writer}`, 5);
    return { ok: false, reason: 'same_host', host: c.host, writer };
  }
  const src = ctx.probeDb || ctx.db;
  let value = null, evidence = null, fired = false;
  try {
    const row = await first(src, frozenSql({ table, ts_column, interval_min }));
    value = row && row.value !== null && row.value !== undefined ? Number(row.value) : null;
    if (value === null) { fired = true; evidence = `${table} has no rows: the writer has never written or the table was emptied`; }
    else fired = value > c.stale_intervals;
  } catch (e) { fired = true; evidence = `probe table unreadable: ${String((e && e.message) || e).slice(0, 200)}`; }
  await hit(ctx, name, value, c.stale_intervals, fired, evidence);
  let item_id = null;
  if (fired) {
    item_id = `${name}-STOPPED`;
    await openItem(ctx, item_id, `${writer} stopped writing ${table}: ${evidence || `${value.toFixed(2)} intervals since the newest row`}`,
      `${table} has a row newer than ${c.stale_intervals} intervals of ${interval_min} minutes`, frozenSql({ table, ts_column, interval_min }), 0);
  }
  return { ok: true, detector: name, host: c.host, writer, value, fired, evidence, item_id };
}

// ---- silent-drop reconciliation across loops ---------------------------------------------------

const LEDGERS = [
  { table: 'kernel_loop_runs', sql: `SELECT loop, scanned, executed, failed, needs_human, no_action, at FROM kernel_loop_runs WHERE id IN (SELECT MAX(id) FROM kernel_loop_runs GROUP BY loop)` },
  { table: 'claims_loop_runs', sql: `SELECT loop, scanned, executed, failed, needs_human, no_action, at FROM claims_loop_runs WHERE id IN (SELECT MAX(id) FROM claims_loop_runs GROUP BY loop)` },
  { table: 'fleet_batches', sql: `SELECT executor AS loop, scanned, executed, failed, needs_human, no_action, at FROM fleet_batches WHERE id IN (SELECT MAX(id) FROM fleet_batches GROUP BY executor)` },
];
/**
 * Read the newest run of every consuming loop from every run ledger present and test
 * `scanned == executed + failed + needs_human + no_action`. A gap opens one incident item per loop. A loop named in
 * `expected_loops` that has reported nothing for two of its intervals is a silent loop: also an incident.
 */
export async function reconcileLoops(ctx) {
  const c = cfg(ctx), now = nowMs(ctx), loops = [], seen = new Map();
  for (const l of LEDGERS) {
    if (!(await hasTable(ctx.db, l.table))) continue;
    for (const r of await all(ctx.db, l.sql)) {
      const gap = r.scanned - r.executed - r.failed - r.needs_human - r.no_action;
      const row = { loop: r.loop, ledger: l.table, scanned: r.scanned, gap, at: r.at };
      loops.push(row);
      const prior = seen.get(r.loop); if (!prior || prior.at < r.at) seen.set(r.loop, row);
    }
  }
  const gaps = loops.filter(l => l.gap !== 0), silent = [];
  for (const g of gaps) await openItem(ctx, `SILENTDROP-${slug(g.loop)}`, `Loop ${g.loop} scanned ${g.scanned} and left ${g.gap} unaccounted (${g.ledger})`,
    `the newest run of ${g.loop} balances`, `scanned = executed + failed + needs_human + no_action in the newest ${g.ledger} row for ${g.loop}`, 0);
  for (const e of c.expected_loops) {
    const last = seen.get(e.loop);
    const intervals = last ? (now - parseIso(last.at)) / 3600e3 / e.interval_h : null;
    if (last && intervals <= c.stale_intervals) continue;
    silent.push({ loop: e.loop, last_run: last ? last.at : null, intervals_since: intervals });
    await openItem(ctx, `SILENTLOOP-${slug(e.loop)}`, `Loop ${e.loop} ${last ? `has reported no run for ${intervals.toFixed(1)} intervals` : 'has never reported a run'}`,
      `${e.loop} reports a balanced run`, `a run row for ${e.loop} newer than ${c.stale_intervals} intervals of ${e.interval_h} h`, 1);
  }
  const balanced = gaps.length === 0 && silent.length === 0;
  await hit(ctx, 'RECONCILE-LOOPS', gaps.reduce((s, g) => s + Math.abs(g.gap), 0) + silent.length, 0, !balanced, balanced ? null : `${gaps.length} gap(s), ${silent.length} silent loop(s)`);
  await run(ctx.db, `INSERT INTO remediation_reconciliations (at, kind, balanced, detail) VALUES (?, 'loops', ?, ?)`, iso(now), balanced ? 1 : 0, JSON.stringify({ gaps, silent, loops: loops.length }));
  return { balanced, loops, gaps, silent };
}

/**
 * The item-set invariant `entered = open + closed + superseded`. Every item seen is entered in an append-only ledger. An
 * item that vanished from the store, or left the active set without a disposition, is unaccounted: it is restored or
 * reopened in the same run and the imbalance is recorded.
 */
export async function reconcileItems(ctx) {
  const at = iso(nowMs(ctx));
  await run(ctx.db, `INSERT OR IGNORE INTO remediation_item_ledger (item_id, entered_at, title, kind, owner_role, done_check, closing_probe, priority)
    SELECT id, ?, title, kind, owner_role, done_check, closing_probe, priority FROM items`, at);
  const n = async sql => (await first(ctx.db, sql)).n;
  const entered = await n(`SELECT COUNT(*) AS n FROM remediation_item_ledger`);
  const open = await n(`SELECT COUNT(*) AS n FROM items WHERE status NOT IN ('done','superseded','cancelled')`);
  const closed = await n(`SELECT COUNT(*) AS n FROM items WHERE status IN ('done','cancelled') AND disposition IS NOT NULL AND disposition <> ''`);
  const superseded = await n(`SELECT COUNT(*) AS n FROM items WHERE status = 'superseded' AND disposition IS NOT NULL AND disposition <> ''`);
  const vanished = await all(ctx.db, `SELECT * FROM remediation_item_ledger WHERE item_id NOT IN (SELECT id FROM items) ORDER BY item_id`);
  const undisposed = (await all(ctx.db, `SELECT id FROM items WHERE status IN ('done','superseded','cancelled') AND (disposition IS NULL OR disposition = '') ORDER BY id`)).map(r => r.id);
  const gap = entered - (open + closed + superseded);
  for (const v of vanished) {
    await run(ctx.db, `INSERT INTO items (id, title, kind, owner_role, done_check, closing_probe, priority, status, blocker) VALUES (?,?,?,?,?,?,?, 'open', 'restored: the row vanished without a disposition')`,
      v.item_id, v.title, v.kind, v.owner_role, v.done_check, v.closing_probe, v.priority);
    await run(ctx.db, `UPDATE remediation_item_ledger SET restored = restored + 1 WHERE item_id = ?`, v.item_id);
  }
  for (const id of undisposed) await run(ctx.db, `UPDATE items SET status = 'open', updated_at = ? WHERE id = ?`, at, id);
  for (const id of [...vanished.map(v => v.item_id), ...undisposed])
    await run(ctx.db, `INSERT INTO outcomes (item_id, surface, action_class, result, evidence) VALUES (?, 'work_tracker', 'item_accounting', 'silent_drop', ?)`, id, vanished.some(v => v.item_id === id) ? 'row vanished; restored from the ledger' : 'left the active set without a disposition; reopened');
  await hit(ctx, 'RECONCILE-ITEMS', gap, 0, gap !== 0, gap ? `entered ${entered}, open ${open}, closed ${closed}, superseded ${superseded}` : null);
  await run(ctx.db, `INSERT INTO remediation_reconciliations (at, kind, balanced, detail) VALUES (?, 'items', ?, ?)`, at, gap === 0 ? 1 : 0,
    JSON.stringify({ entered, open, closed, superseded, gap, restored: vanished.map(v => v.item_id), reopened: undisposed }));
  if (gap !== 0) await openItem(ctx, `SILENTDROP-ITEMS-${at.slice(0, 10)}`, `${gap} item(s) left the active set without a disposition (entered ${entered}, accounted ${entered - gap})`,
    'entered = open + closed + superseded on the next reconciliation', 'remediation_reconciliations: newest items row has balanced = 1', 0);
  return { balanced: gap === 0, entered, open, closed, superseded, gap, restored: vanished.map(v => v.item_id), reopened: undisposed };
}

// ---- roster reconciliation with the emitter set (US-17-R12) ------------------------------------

/** Names seen emitting events or alerts since `since`, from the event tables present in this store. */
export async function observedEmitters(ctx, { since } = {}) {
  const from = iso(since ?? nowMs(ctx) - 24 * 3600e3), out = new Set();
  if (await hasTable(ctx.db, 'observe_events')) for (const r of await all(ctx.db, `SELECT DISTINCT source AS n FROM observe_events WHERE at >= ?`, from)) out.add(r.n);
  if (await hasTable(ctx.db, 'fleet_events')) for (const r of await all(ctx.db, `SELECT DISTINCT emitter AS n FROM fleet_events WHERE state = 'accepted' AND ts >= ?`, from)) out.add(r.n);
  if (await hasTable(ctx.db, 'fleet_runs')) for (const r of await all(ctx.db, `SELECT DISTINCT worker AS n FROM fleet_runs WHERE queued_at >= ?`, from)) out.add(r.n);
  return [...out].filter(Boolean).sort();
}

/**
 * Compare the registry, the live list, the scanner's set and the probe set, and add the third independent source: the
 * names observed emitting. `emitters - (registry union live)` fires: such a worker is invisible to a registry-versus-live check.
 */
export async function rosterReconcile(ctx, sets = null) {
  const r = ctx.rosters || {}, given = sets || {};
  const get = async k => new Set(given[k] || (typeof r[k] === 'function' ? await r[k]() : []));
  const has = k => !!given[k] || typeof r[k] === 'function';
  const registry = await get('registry'), live = await get('live'), scanner = await get('scanner'), probes = await get('probes');
  const emitters = has('emitters') ? await get('emitters') : new Set(await observedEmitters(ctx));
  const minus = (a, b) => [...a].filter(x => !b.has(x)).sort();
  const known = new Set([...registry, ...live]);
  const diff = {
    registered_not_live: minus(registry, live), live_not_registered: minus(live, registry),
    not_scanned: has('scanner') ? minus(known, scanner) : [], scanned_unknown: minus(scanner, known),
    not_probed: has('probes') ? minus(new Set([...registry].filter(x => live.has(x))), probes) : [], probed_ghosts: minus(probes, known),
    unknown_emitters: minus(emitters, known),
  };
  const total = Object.values(diff).reduce((s, v) => s + v.length, 0);
  for (const e of diff.unknown_emitters) await openItem(ctx, `ROSTER-EMITTER-${slug(e)}`, `${e} emits events but is in neither the registry nor the live list`,
    `${e} is registered, or its emissions stop`, 'roster reconciliation lists no unknown emitter of that name', 5);
  await hit(ctx, 'FM-ROSTER', total, 0, total > 0, total ? Object.entries(diff).filter(([, v]) => v.length).map(([k, v]) => `${k}: ${v.join(', ')}`).join('; ') : null);
  await run(ctx.db, `INSERT INTO remediation_reconciliations (at, kind, balanced, detail) VALUES (?, 'roster', ?, ?)`, iso(nowMs(ctx)), total === 0 ? 1 : 0, JSON.stringify(diff));
  return { fired: total > 0, differences: total, ...diff };
}

// ---- a breaker for a ledger whose writer has none (US-17-R08) ----------------------------------

/**
 * Feed new rows of an attempt ledger (for example a deploy ledger) to the kernel loop breaker, once each. The writer
 * needs no change: at k identical (target, error) failures in the window the breaker opens, the root-cause item is filed
 * and the half-open probe is scheduled. `retryAllowed` is what the writer, or its dispatcher, asks before the next attempt.
 */
export async function breakerFromLedger(ctx, ledger) {
  const c = cfg(ctx);
  const cur = await first(ctx.db, `SELECT cursor FROM remediation_cursors WHERE ledger = ?`, ledger.name);
  const rows = (await ledger.read(cur ? cur.cursor : null)) || [];
  const opened = [];
  for (const r of rows) {
    const res = await recordAttempt(ctx.db, { target: String(r.target), signature: String(r.error || 'ok').slice(0, 200), ok: !!r.ok, now: r.at ? parseIso(r.at) : nowMs(ctx),
      k: c.breaker_k, window_h: c.breaker_window_h, half_open_h: c.half_open_h });
    if (res.state === 'open' && res.root_item_id) opened.push({ target: r.target, signature: r.error, root_item_id: res.root_item_id, half_open_at: res.half_open_at });
    await run(ctx.db, `INSERT INTO remediation_cursors (ledger, cursor) VALUES (?,?) ON CONFLICT(ledger) DO UPDATE SET cursor = excluded.cursor`, ledger.name, String(r.id));
  }
  return { ledger: ledger.name, read: rows.length, opened };
}
export const retryAllowed = (ctx, target, error) => canAttempt(ctx.db, String(target), String(error).slice(0, 200), nowMs(ctx));

// ---- a repository fix closes on production evidence (US-17-R13) --------------------------------

/**
 * Close a fix item. Repository evidence alone (a commit, a merged change, a passing repository check) is refused: the
 * evidence must include an observation of the deployed system. The disposition records every reference.
 */
export async function closeFix(ctx, { item_id, evidence = [] } = {}) {
  const c = cfg(ctx);
  const ev = evidence.filter(e => e && e.kind && e.ref);
  if (!ev.length) return { ok: false, reason: 'no_evidence' };
  if (!ev.some(e => c.production_evidence.includes(e.kind))) return { ok: false, reason: 'repository_evidence_alone', have: [...new Set(ev.map(e => e.kind))], need: c.production_evidence };
  const disposition = `fixed; evidence: ${ev.map(e => `${e.kind} ${e.ref}`).join('; ')}`.slice(0, 1000);
  const r = await run(ctx.db, `UPDATE items SET status = 'done', disposition = ?, updated_at = ? WHERE id = ? AND status NOT IN ('done','superseded','cancelled')`, disposition, iso(nowMs(ctx)), item_id);
  return r.meta.changes ? { ok: true, item_id, disposition } : { ok: false, reason: 'no_open_item' };
}

// ---- surface for the composition root ----------------------------------------------------------

/** One tick: reconcile loops and items, the roster when its ports exist, configured liveness checks, and ledger breakers. */
export async function step(ctx) {
  const c = cfg(ctx);
  if (c.enabled === false) return { enabled: false };
  const loops = await reconcileLoops(ctx), items = await reconcileItems(ctx);
  const out = { loops_balanced: loops.balanced, items_balanced: items.balanced, restored: items.restored.length, reopened: items.reopened.length };
  if (ctx.rosters) out.roster_differences = (await rosterReconcile(ctx)).differences;
  out.liveness = [];
  for (const l of c.liveness || []) { const r = await externalLiveness(ctx, l); out.liveness.push({ table: l.table, fired: !!r.fired, reason: r.reason || null }); }
  out.breakers_opened = 0;
  for (const l of ctx.ledgers || []) out.breakers_opened += (await breakerFromLedger(ctx, l)).opened.length;
  return out;
}
const json = (body, code = 200) => new Response(JSON.stringify(body), { status: code, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
/** Route: GET /failure-modes/status (read-only). */
export async function handle(request, ctx) {
  const url = new URL(request.url);
  if (request.method === 'GET' && url.pathname === '/failure-modes/status') return json(await statusView(ctx));
  return json({ error: 'not_found' }, 404);
}
