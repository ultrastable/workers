// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// core/criticality: a deployment must reach the point where it builds itself with nobody prompting it. Two tick steps.
//  specify (before the runner): every active item that names no target file and whose closing probe the tick cannot read
//    has no doer: the tick's own doer cannot settle it and the runner refuses it. It is given a specification to write
//    (specs/US-SPEC-NN-<slug>.md) as its target and a probe the tick can read. Once that file merges, core/specloop turns
//    its PLANNED lines into targeted items. So any work, however it was phrased, becomes buildable: spec first, then code.
//    Items the runner already parked for lack of a target are released the same way.
//    A run the runner refused for a fault of the attempt (invalid output, repeated errors, rework limit, context error)
//    parks its item behind a card. That is a retry, not a decision: the item is put back, at most max_retries times and
//    retry_after_minutes apart, and its card is closed. Past the bound it stays parked and the stall names it.
//  measure (last): one row per tick of what moved. No movement for stall_ticks ticks while work is active is a stall; its
//    root cause is named from the state (no doer credential, nothing takeable, spend cap, runs failing) and filed once as
//    CRIT-STALL, which closes itself when the loop moves again.
// Ports: db, now() ms, config { spec_dir, stall_ticks, first_spec }, evalProbe(item) -> {ok}|null, needs() -> [names].
const iso = ms => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const ACTIVE = `('open','ready','claimed','blocked')`;
const slug = s => String(s).toLowerCase().replace(/^outcome:\s*/, '').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(w => w.length > 2 && !['the', 'and', 'for', 'with', 'that', 'from'].includes(w)).slice(0, 4).join('-') || 'work';
export const SPEC_FORMAT = 'write the specification for this item as a markdown file: a title line "# US-SPEC-NN <name>", numbered requirements with MUST/SHOULD and stable ids, and a final section "## Reference implementation status" holding one table row per capability, each labelled PLANNED and naming in backticks the code file that will implement it';

export function create({ db, now = () => Date.now(), config = {}, evalProbe = async () => null, needs = async () => [] }) {
  const c = { spec_dir: 'specs', stall_ticks: 6, first_spec: 1, max_per_tick: 10, max_retries: 2, retry_after_minutes: 60, ...config };
  const all = async (sql, ...a) => (await db.prepare(sql).bind(...a).all()).results || [];
  const first = (sql, ...a) => db.prepare(sql).bind(...a).first();
  const run = (sql, ...a) => db.prepare(sql).bind(...a).run();

  async function nextSpec() {
    const used = new Set();
    for (const r of await all(`SELECT spec FROM criticality_specs`)) used.add(Number(r.spec.replace(/\D/g, '')));
    for (const r of await all(`SELECT DISTINCT spec FROM specloop_lines`).catch(() => [])) used.add(Number(r.spec.replace(/\D/g, '')));
    let n = c.first_spec; while (used.has(n)) n++;
    return n;
  }

  /** Give every doer-less item a specification to write. Idempotent: an item is specified once. */
  async function specify() {
    const at = iso(now()), out = { specified: 0, released: 0, retried: 0 };
    // Items the runner parked for lack of a target go back into the pool this step feeds.
    const parked = await all(`SELECT id FROM items WHERE status='blocked' AND blocker LIKE 'runner no_target:%'`);
    for (const p of parked) { await run(`UPDATE items SET status='ready', blocker=NULL, updated_at=? WHERE id=?`, at, p.id); out.released++; }
    const refused = await all(`SELECT i.id, i.blocker, r.n, r.last_at FROM items i LEFT JOIN criticality_retries r ON r.item_id = i.id
      WHERE i.status='blocked' AND (i.blocker LIKE 'runner invalid_output:%' OR i.blocker LIKE 'runner repeated_errors:%' OR i.blocker LIKE 'runner rework_limit:%' OR i.blocker LIKE 'runner context_error:%')`);
    for (const it of refused) {
      const reason = /^runner (\w+):/.exec(it.blocker)[1], cardId = (/decision card (\S+)/.exec(it.blocker) || [])[1];
      // first sight starts the clock; the retry happens once the wait has passed
      if (it.n == null) { await run(`INSERT INTO criticality_retries (item_id, n, last_at, last_reason) VALUES (?, 0, ?, ?)`, it.id, at, reason); continue; }
      if (it.n >= c.max_retries || Date.parse(it.last_at.replace(' ', 'T') + 'Z') + c.retry_after_minutes * 60e3 > now()) continue;
      await run(`UPDATE items SET status='ready', blocker=NULL, updated_at=? WHERE id=?`, at, it.id);
      await run(`UPDATE criticality_retries SET n=n+1, last_at=?, last_reason=? WHERE item_id=?`, at, reason, it.id);
      if (cardId) await run(`UPDATE gate_cards SET status='closed' WHERE id=? AND status='open'`, cardId);
      out.retried++;
    }
    const cands = await all(`SELECT * FROM items WHERE status IN ('open','ready') AND done_check NOT LIKE '%target:%'
      AND kind IN ('work','plus','fix') AND id NOT IN (SELECT item_id FROM criticality_specs) AND id NOT IN (SELECT item_id FROM claims)
      ORDER BY priority, created_at LIMIT ?`, c.max_per_tick * 5);
    for (const it of cands) {
      if (out.specified >= c.max_per_tick) break;
      if (await evalProbe(it)) continue; // the tick's own doer settles this one by its probe
      const n = await nextSpec(), spec = `US-SPEC-${String(n).padStart(2, '0')}`, path = `${c.spec_dir}/${spec}-${slug(it.title)}.md`;
      await run(`INSERT INTO criticality_specs (item_id, spec, path, at) VALUES (?,?,?,?)`, it.id, spec, path, at);
      await run(`UPDATE items SET done_check=?, closing_probe=?, updated_at=? WHERE id=?`,
        `${it.done_check}; first step: ${SPEC_FORMAT.replace('US-SPEC-NN', spec)}; spec: ${spec}; target: ${path}`,
        `SELECT COUNT(*) FROM specloop_lines WHERE spec = '${spec}'`, at, it.id);
      out.specified++;
    }
    return out;
  }

  async function rootCause(s) {
    const missing = await needs();
    if (missing.length) return `no doer: missing ${missing.join(', ')}`;
    const spent = await first(`SELECT COUNT(*) AS n FROM criticality_retries r JOIN items i ON i.id = r.item_id WHERE i.status='blocked' AND r.n >= ?`, c.max_retries);
    if (spent && spent.n) return `${spent.n} item(s) still refused after ${c.max_retries} retries: the doer's output is not accepted (see runner_runs.last_error)`;
    if (!s.takeable) return 'nothing takeable: every active item is blocked or waits on a probe';
    const refused = await first(`SELECT reason, COUNT(*) AS n FROM runner_runs WHERE state='refused' GROUP BY reason ORDER BY n DESC LIMIT 1`).catch(() => null);
    if (refused && refused.n) return `runs are refused: ${refused.reason} (${refused.n})`;
    return 'takeable work exists and nothing started it';
  }

  /** One row per tick; files CRIT-STALL with the root cause when nothing has moved for stall_ticks ticks. */
  async function measure() {
    const at = iso(now());
    const n = async (sql, ...a) => Number((await first(sql, ...a).catch(() => null))?.n || 0);
    const s = {
      // work the build loop owes: an item parked on a probe the tick re-reads every tick (a kit milestone, a credential)
      // is waiting on the world, not on the loop, so it does not make a quiet loop a stalled one.
      active: await n(`SELECT COUNT(*) AS n FROM items WHERE status IN ${ACTIVE} AND id <> 'CRIT-STALL' AND kind <> 'ladder'
        AND NOT (status='blocked' AND blocker LIKE 'waiting on probe:%')`),
      takeable: await n(`SELECT COUNT(*) AS n FROM items WHERE status='ready' AND done_check LIKE '%target:%'`)
        + await n(`SELECT COUNT(*) AS n FROM runner_runs WHERE state NOT IN ('refused','pr_opened')`),
      done_total: await n(`SELECT COUNT(*) AS n FROM items WHERE status='done'`),
      runs_total: await n(`SELECT COUNT(*) AS n FROM runner_runs`),
      merged_total: await n(`SELECT COUNT(*) AS n FROM outcomes WHERE action_class='merge' AND result='verified'`),
    };
    const prev = await first(`SELECT * FROM criticality_log ORDER BY id DESC LIMIT 1`);
    const moved = !prev || s.done_total > prev.done_total || s.runs_total > prev.runs_total || s.merged_total > prev.merged_total ? 1 : 0;
    const recent = await all(`SELECT moved, merged_total FROM criticality_log ORDER BY id DESC LIMIT ?`, c.stall_ticks - 1);
    const still = !moved && recent.length >= c.stall_ticks - 1 && recent.every(r => !r.moved);
    let regime = 'building', cause = null;
    if (!s.active) regime = 'idle';
    else if (still) { regime = 'stalled'; cause = await rootCause(s); }
    else if (s.merged_total > 0 && recent.length && s.merged_total > recent[recent.length - 1].merged_total) regime = 'self-sustaining';
    await run(`INSERT INTO criticality_log (at, active, takeable, done_total, runs_total, merged_total, moved, regime, cause) VALUES (?,?,?,?,?,?,?,?,?)`,
      at, s.active, s.takeable, s.done_total, s.runs_total, s.merged_total, moved, regime, cause);
    if (regime !== 'stalled') await run(`UPDATE items SET status='done', disposition=?, updated_at=? WHERE id='CRIT-STALL' AND status IN ${ACTIVE}`, `loop ${regime} again (criticality_log)`, at);
    if (regime === 'stalled') {
      const title = `The build loop has not moved for ${c.stall_ticks} ticks: ${cause}`.slice(0, 300);
      const r = await run(`INSERT OR IGNORE INTO items (id, title, kind, owner_role, done_check, closing_probe, priority, status) VALUES ('CRIT-STALL', ?, 'fix', 'operations', 'criticality_log shows movement again', 'SELECT moved FROM criticality_log ORDER BY id DESC LIMIT 1', 0, 'ready')`, title);
      if (!r.meta.changes) await run(`UPDATE items SET title=?, status=CASE WHEN status IN ('done','superseded','cancelled') THEN 'ready' ELSE status END, disposition=CASE WHEN status IN ('done','superseded','cancelled') THEN NULL ELSE disposition END, updated_at=? WHERE id='CRIT-STALL'`, title, at);
    }
    await run(`INSERT INTO org (key, value) VALUES ('criticality', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, JSON.stringify({ ...s, regime, cause, at }));
    return { ...s, moved, regime, cause };
  }

  return { specify, measure };
}

/** The two tick steps. On unless config.enabled === false. */
export function steps(ports) {
  if (ports.config?.enabled === false) return { before: [], after: [] };
  const k = create(ports);
  return {
    before: [{ name: 'criticality_specify', run: async (_db, ctx) => { const r = await k.specify(); ctx.notes.push(`criticality_specify: ${r.specified} item(s) given a specification to write, ${r.released} released from the runner's no-target park, ${r.retried} refused run(s) retried`); } }],
    after: [{ name: 'criticality', run: async (_db, ctx) => { const r = await k.measure(); ctx.notes.push(`criticality: ${r.regime}${r.cause ? ' (' + r.cause + ')' : ''}; ${r.active} active, ${r.takeable} takeable, ${r.done_total} done, ${r.merged_total} merged`); } }],
  };
}
