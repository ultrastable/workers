// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// The plus loop (US-SPEC-04): a reserved share of capacity, a product registry, one plus at a time per product with a
// prediction and a guard, keep or revert on measured evidence, a simplify pass every Nth cycle, rest after repeated misses,
// a weekly digest. Ports: db, now (ms), config, and two optional functions: a usage reader and a plus proposer.
import { fileURLToPath } from 'node:url';

export const MIGRATIONS_DIR = (() => { try { return fileURLToPath(new URL('./migrations/', import.meta.url)); } catch { return null; } })();
export const DEFAULTS = {
  plus_share: 0.2, n_simplify: 5, window_h: 168, min_gain: 0.05, guard_tolerance: 0, max_misses: 3, rest_h: 336,
  daily_cap: 3, reading_max_age_h: 48, unmeasured_grace_h: 168, digest_max_age_h: 192,
};
const cfg = (c) => ({ ...DEFAULTS, ...(c || {}) });
const HOUR = 3600e3;
const iso = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const parseIso = (s) => Date.parse(String(s).replace(' ', 'T') + 'Z');
const all = async (db, sql, ...a) => (await db.prepare(sql).bind(...a).all()).results || [];
const first = async (db, sql, ...a) => (await db.prepare(sql).bind(...a).first()) || null;
const run = (db, sql, ...a) => db.prepare(sql).bind(...a).run();
const IN_FLIGHT = `('filed','shipped')`;

async function ensureItem(db, it) {
  if (await first(db, `SELECT 1 AS x FROM items WHERE id = ?`, it.id)) return false;
  await run(db, `INSERT INTO items (id, title, kind, project, owner_role, done_check, closing_probe, priority, status) VALUES (?,?,?,?,?,?,?,?, 'ready')`,
    it.id, String(it.title).slice(0, 300), it.kind || 'fix', it.project ?? null, it.owner_role, String(it.done_check).slice(0, 500), it.closing_probe ?? null, it.priority ?? 30);
  return true;
}
const getProduct = (db, product) => first(db, `SELECT * FROM plus_product_registry WHERE product = ?`, product);

export async function registerProduct(db, p) {
  for (const f of ['product', 'usage_metric', 'quality_measure']) if (!p[f] || !String(p[f]).trim()) throw new Error(`product requires ${f}`);
  if (p.usage_metric === p.quality_measure) throw new Error('the guard measure must differ from the outcome measure (US-04-R08)');
  await run(db, `INSERT INTO plus_product_registry (product, host, program, usage_metric, quality_measure, quality_direction, plus_cadence_h, state, created_at)
      VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(product) DO UPDATE SET host=excluded.host, program=excluded.program, usage_metric=excluded.usage_metric, quality_measure=excluded.quality_measure,
        quality_direction=excluded.quality_direction, plus_cadence_h=excluded.plus_cadence_h, state=excluded.state`,
    p.product, p.host ?? null, p.program ?? null, p.usage_metric, p.quality_measure, p.quality_direction || 'lower', p.plus_cadence_h ?? 24, p.state || 'active', iso(p.now ?? Date.now()));
}

// ---- Reserved share (US-04-R01, R05) ----
// The share is configuration. It is lowered only by an override row, and only until that row expires.
export async function reduceShare(db, { share, reason, expires_at, now = Date.now() }) {
  if (!(typeof share === 'number' && share >= 0 && share <= 1)) throw new Error('share must be a number from 0 to 1');
  if (!reason || !String(reason).trim()) throw new Error('a reduction records its reason');
  if (!expires_at || !(parseIso(expires_at) > now)) throw new Error('a reduction needs an expiry in the future (US-04-R05)');
  return (await run(db, `INSERT INTO plus_share_overrides (share, reason, expires_at, created_at) VALUES (?,?,?,?)`, share, reason, expires_at, iso(now))).meta.last_row_id;
}
export async function effectiveShare(db, { now = Date.now(), config } = {}) {
  const base = cfg(config).plus_share;
  const o = await first(db, `SELECT share, expires_at FROM plus_share_overrides WHERE expires_at > ? ORDER BY id DESC LIMIT 1`, iso(now));
  return o ? { share: Math.min(base, o.share), base, override_until: o.expires_at } : { share: base, base, override_until: null };
}
// Split T slots. Risk is not an input: nothing a repair allocation computes can reach the plus slots.
export async function capacity(db, { T = 25, now = Date.now(), config } = {}) {
  const s = await effectiveShare(db, { now, config });
  const plus_slots = s.share > 0 && T > 0 ? Math.max(1, Math.round(T * s.share)) : 0;
  return { ...s, total: T, plus_slots, repair_slots: T - plus_slots };
}

// ---- Readings (US-04-R09, R14) ----
export async function recordReading(db, { product, measure, value, window = null, label = null, evidence = null, now = Date.now() }) {
  const p = await getProduct(db, product);
  if (!p) throw new Error(`unknown product ${product}`);
  const v = value === null || value === undefined || Number.isNaN(Number(value)) ? null : Number(value); // a failed read is null, never 0
  await run(db, `INSERT INTO plus_readings (product, measure, value, window_label, label, evidence, read_at) VALUES (?,?,?,?,?,?,?)`, product, measure, v, window, label, evidence, iso(now));
  if (measure === p.usage_metric) await run(db, `UPDATE plus_product_registry SET usage_value = ?, usage_window = ?, usage_read_at = ?, usage_label = ? WHERE product = ?`, v, window, iso(now), label, product);
  return v;
}
// The latest reading, or null when it is missing, failed or older than maxAgeH.
export async function latestReading(db, product, measure, { now = Date.now(), maxAgeH = DEFAULTS.reading_max_age_h } = {}) {
  const r = await first(db, `SELECT value, read_at, label FROM plus_readings WHERE product = ? AND measure = ? ORDER BY id DESC LIMIT 1`, product, measure);
  if (!r) return { value: null, why: 'no reading' };
  if ((now - parseIso(r.read_at)) / HOUR > maxAgeH) return { value: null, why: `stale: read ${r.read_at}`, read_at: r.read_at };
  return { value: r.value, why: r.value === null ? 'the read failed' : null, read_at: r.read_at, label: r.label };
}
// Usage from platform analytics through a port: reader({ product, host, usage_metric }) -> { value, window_h, includes_machine }.
// A reader that cannot separate machine requests, or does not say, gets a label that says so (US-04-R14).
export async function measureUsage(db, { reader, now = Date.now() }) {
  const out = [];
  for (const p of await all(db, `SELECT * FROM plus_product_registry WHERE state = 'active' ORDER BY product`)) {
    let value = null, window = null, label = null, evidence = null;
    try {
      const r = await reader({ product: p.product, host: p.host, usage_metric: p.usage_metric });
      value = r?.value ?? null; window = r?.window_h ? `${r.window_h} h` : null;
      label = r?.includes_machine === false ? `${p.usage_metric} (human requests)` : r?.includes_machine === true
        ? `${p.usage_metric} (machine and human requests counted together)` : `${p.usage_metric} (machine share unknown)`;
    } catch (e) { evidence = `usage reader failed: ${e.message}`; }
    out.push({ product: p.product, value: await recordReading(db, { product: p.product, measure: p.usage_metric, value, window, label, evidence, now }), label });
  }
  return out;
}

// ---- Selection (step 402) ----
async function frictionCount(db, p) {
  return (await first(db, `SELECT COUNT(*) AS n FROM items WHERE kind = 'fix' AND status NOT IN ('done','superseded','cancelled') AND project IN (?, ?)`, p.product, p.program ?? p.product)).n;
}
// Active products not at rest, with no plus in flight and their cadence elapsed, ordered by
// (now - last_plus_at) * (1 + usage_weight) * (1 + friction_count). usage_weight is the product's share of the largest usage.
export async function selectDue(db, { now = Date.now() } = {}) {
  const ps = await all(db, `SELECT * FROM plus_product_registry WHERE state = 'active'
      AND product NOT IN (SELECT product FROM plus_ledger WHERE status IN ${IN_FLIGHT} AND kind <> 'revert')`);
  const maxUsage = Math.max(0, ...ps.map(p => p.usage_value ?? 0));
  const out = [];
  for (const p of ps) {
    if (p.rest_until && parseIso(p.rest_until) > now) continue;
    const since = (now - parseIso(p.last_plus_at || p.created_at)) / HOUR;
    if (p.last_plus_at && since < p.plus_cadence_h) continue;
    const friction = await frictionCount(db, p), weight = maxUsage > 0 && p.usage_value ? p.usage_value / maxUsage : 0;
    out.push({ ...p, friction_count: friction, usage_weight: weight, due_score: Math.max(since, 0) * (1 + weight) * (1 + friction) });
  }
  return out.sort((a, b) => b.due_score - a.due_score || a.product.localeCompare(b.product));
}
// measurement when the product has no usable usage reading, simplify on every Nth cycle (US-04-R11), otherwise plus.
export async function cycleKind(db, p, { now = Date.now(), config } = {}) {
  const c = cfg(config);
  if ((await latestReading(db, p.product, p.usage_metric, { now, maxAgeH: c.reading_max_age_h })).value === null) return 'measurement';
  return p.pluses_since_simplify >= c.n_simplify - 1 ? 'simplify' : 'plus';
}

// Step 404: evidence from the store only. Nothing here asks the principal.
export async function gatherEvidence(db, product, { now = Date.now(), config } = {}) {
  const p = await getProduct(db, product), c = cfg(config);
  const usage = await latestReading(db, product, p.usage_metric, { now, maxAgeH: c.reading_max_age_h });
  const guard = await latestReading(db, product, p.quality_measure, { now, maxAgeH: c.reading_max_age_h });
  const friction = await all(db, `SELECT id, title FROM items WHERE kind = 'fix' AND status NOT IN ('done','superseded','cancelled') AND project IN (?, ?) ORDER BY priority, id LIMIT 10`, product, p.program ?? product);
  const kept = await first(db, `SELECT id, title FROM plus_ledger WHERE product = ? AND status = 'kept' AND kind IN ('plus','simplify') ORDER BY id DESC LIMIT 1`, product);
  const missed = await all(db, `SELECT id, title, angle, verdict FROM plus_ledger WHERE product = ? AND status = 'reverted' ORDER BY id DESC LIMIT 3`, product);
  const seed = await first(db, `SELECT id, title, evidence FROM plus_ledger WHERE product = ? AND status = 'proposed' ORDER BY id DESC LIMIT 1`, product);
  return { product, usage: { measure: p.usage_metric, value: usage.value, label: usage.label ?? p.usage_label, note: usage.why }, guard: { measure: p.quality_measure, value: guard.value, note: guard.why },
    friction, last_kept: kept, recent_misses: missed, avoid_angle: p.misses_in_row > 0 ? (missed[0]?.angle ?? null) : null, seed };
}

// ---- Steps 406, 408: one plus, with a prediction, filed as an ordinary work item with a doer line ----
const normAngle = (a) => String(a || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
export async function proposePlus(db, x, { config } = {}) {
  const c = cfg(config), now = x.now ?? Date.now();
  const p = await getProduct(db, x.product);
  if (!p || p.state !== 'active') throw new Error(`no active product ${x.product}`);
  if (p.rest_until && parseIso(p.rest_until) > now) throw new Error(`product is at rest until ${p.rest_until}`);
  if (await first(db, `SELECT 1 AS x FROM plus_ledger WHERE product = ? AND status IN ${IN_FLIGHT} AND kind <> 'revert'`, x.product)) throw new Error('the product already has a plus in flight');
  const kind = x.kind || await cycleKind(db, p, { now, config });
  if (!['plus', 'simplify'].includes(kind)) throw new Error(`a ${kind} cycle takes no plus: the product's usage is unmeasured`);
  if (!x.title || !String(x.title).trim()) throw new Error('a plus has a title');
  const pr = x.prediction || {};
  if (!pr.metric || !['up', 'down'].includes(pr.direction) || !(typeof pr.size === 'number' && pr.size > 0)) throw new Error('a plus states its prediction first: metric, direction (up or down) and size (US-04-R06)');
  const guard = x.guard || p.quality_measure;
  if (guard === pr.metric) throw new Error('the guard measure must differ from the outcome measure (US-04-R08)');
  if (!x.revert_path || !String(x.revert_path).trim()) throw new Error('a plus is reversible: it names its revert path (US-04-R06)');
  if (kind === 'plus') {
    if (x.additive !== true) throw new Error('a plus is additive; removal belongs to a simplify cycle (US-04-R06)');
    if ((x.changes ?? 1) !== 1) throw new Error('a plus is a single change (US-04-R06)');
  }
  if (!x.doer || !String(x.doer).trim()) throw new Error('a plus is filed with a doer line (US-04-R07)');
  if (!x.angle || !normAngle(x.angle)) throw new Error('a plus names its angle');
  if (p.misses_in_row > 0) { // US-04-R10: after a miss the next plus takes a different angle
    const last = await first(db, `SELECT angle FROM plus_ledger WHERE product = ? AND status = 'reverted' AND kind IN ('plus','simplify') ORDER BY id DESC LIMIT 1`, x.product);
    if (last && normAngle(last.angle) === normAngle(x.angle)) throw new Error(`the last plus on the angle "${last.angle}" missed: take a different angle (US-04-R10)`);
  }
  const window_h = x.window_h ?? c.window_h, min_gain = x.min_gain ?? c.min_gain;
  const predicted = `${pr.metric} ${pr.direction} ${+(pr.size * 100).toFixed(2)}% within ${window_h} h`;
  const seed = await first(db, `SELECT id FROM plus_ledger WHERE product = ? AND status = 'proposed' ORDER BY id DESC LIMIT 1`, x.product);
  const cols = [kind, x.title, x.evidence ?? null, predicted, pr.metric, pr.direction, pr.size, min_gain, guard, x.angle, x.doer, x.revert_path, window_h];
  let id;
  if (seed) { id = seed.id; await run(db, `UPDATE plus_ledger SET kind=?, title=?, evidence=COALESCE(?, evidence), predicted_outcome=?, metric=?, direction=?, size=?, min_gain=?, guard=?, angle=?, doer=?, revert_path=?, window_h=?, status='filed' WHERE id=?`, ...cols, id); }
  else id = (await run(db, `INSERT INTO plus_ledger (product, kind, title, evidence, predicted_outcome, metric, direction, size, min_gain, guard, angle, doer, revert_path, window_h, status, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'filed',?)`, x.product, ...cols, iso(now))).meta.last_row_id;
  const issue = `PLUS-${x.product}-${id}`;
  await ensureItem(db, { id: issue, title: x.title, kind: 'plus', project: p.program, owner_role: x.owner_role || 'staff', priority: x.priority ?? 30,
    done_check: `doer: ${x.doer}. ${x.done_check || 'the change is deployed and verified through the change path'}. revert: ${x.revert_path}`,
    closing_probe: `plus ${id}: ${predicted}; guard ${guard} not worse` });
  await run(db, `UPDATE plus_ledger SET issue_id = ? WHERE id = ?`, issue, id);
  return { id, issue_id: issue, kind, predicted_outcome: predicted };
}

// At verified deployment: store the baselines of the outcome measure and the guard. An unmeasured baseline stays null.
export async function shipPlus(db, id, { evidence, now = Date.now(), config } = {}) {
  const c = cfg(config), l = await first(db, `SELECT * FROM plus_ledger WHERE id = ?`, id);
  if (!l || l.status !== 'filed' || !['plus', 'simplify'].includes(l.kind)) throw new Error('only a filed plus is shipped');
  if (!evidence || !String(evidence).trim()) throw new Error('shipping records the evidence of the verified deployment');
  const base = (await latestReading(db, l.product, l.metric, { now, maxAgeH: c.reading_max_age_h })).value;
  const gbase = (await latestReading(db, l.product, l.guard, { now, maxAgeH: c.reading_max_age_h })).value;
  await run(db, `UPDATE plus_ledger SET status='shipped', baseline=?, guard_baseline=?, shipped_at=?, due_at=?, evidence=COALESCE(evidence || ' | ', '') || ? WHERE id=?`,
    base, gbase, iso(now), iso(now + l.window_h * HOUR), `deployed: ${evidence}`, id);
  return { id, baseline: base, guard_baseline: gbase, due_at: iso(now + l.window_h * HOUR) };
}

// Step 410: after the window, keep or revert. An unmeasured reading is never a pass (US-04-R09).
export async function decidePlus(db, id, { now = Date.now(), config } = {}) {
  const c = cfg(config), l = await first(db, `SELECT * FROM plus_ledger WHERE id = ?`, id);
  if (!l || l.status !== 'shipped') throw new Error('only a shipped plus is decided');
  if (parseIso(l.due_at) > now) return { id, status: 'shipped', pending: true };
  const p = await getProduct(db, l.product), nowIso = iso(now);
  const after = (await latestReading(db, l.product, l.metric, { now, maxAgeH: c.reading_max_age_h })).value;
  const gafter = (await latestReading(db, l.product, l.guard, { now, maxAgeH: c.reading_max_age_h })).value;
  const unmeasured = [l.baseline, l.guard_baseline, after, gafter].some(v => v === null || v === undefined);
  if (unmeasured && now <= parseIso(l.due_at) + c.unmeasured_grace_h * HOUR) {
    // Recorded as unmeasured (null), not kept; the measurement gap is an item, and the next tick reads again.
    await run(db, `UPDATE plus_ledger SET outcome = NULL, guard_outcome = ?, verdict = 'unmeasured' WHERE id = ?`, gafter, id);
    await ensureItem(db, { id: `PLUSMEASURE-${id}`, title: `Plus ${id} of ${l.product} cannot be judged: ${l.metric} or ${l.guard} is unmeasured`, owner_role: 'operations', project: p.program, priority: 10,
      done_check: `fresh readings of ${l.metric} and ${l.guard} exist for ${l.product}`, closing_probe: `plus ${id} decided` });
    return { id, status: 'shipped', verdict: 'unmeasured', outcome: null };
  }
  const gained = !unmeasured && (l.direction === 'down' ? after <= l.baseline * (1 - l.min_gain) : after >= l.baseline * (1 + l.min_gain));
  const guardOk = !unmeasured && (p.quality_direction === 'higher' ? gafter >= l.guard_baseline - c.guard_tolerance : gafter <= l.guard_baseline + c.guard_tolerance);
  const hit = unmeasured ? null : (l.direction === 'down' ? after <= l.baseline * (1 - l.size) : after >= l.baseline * (1 + l.size)) ? 1 : 0;
  const cycles = l.kind === 'simplify' ? 0 : p.pluses_since_simplify + 1;
  if (gained && guardOk) { // step 412: kept, misses reset, the next plus is seeded from this one
    await run(db, `UPDATE plus_ledger SET status='kept', verdict='kept', outcome=?, guard_outcome=?, prediction_hit=?, decided_at=? WHERE id=?`, after, gafter, hit, nowIso, id);
    await run(db, `UPDATE plus_product_registry SET misses_in_row = 0, pluses_since_simplify = ?, last_plus_at = ? WHERE product = ?`, cycles, nowIso, l.product);
    const seed = (await run(db, `INSERT INTO plus_ledger (product, kind, title, evidence, status, seeded_from, created_at) VALUES (?, 'plus', ?, ?, 'proposed', ?, ?)`,
      l.product, `Build on: ${l.title}`.slice(0, 300), `seeded by kept plus ${id} (${l.metric} ${l.baseline} -> ${after})`, id, nowIso)).meta.last_row_id;
    return { id, status: 'kept', verdict: 'kept', outcome: after, guard_outcome: gafter, misses_in_row: 0, seeded: seed };
  }
  // step 414: revert item, one more miss, rest after max_misses in a row (US-04-R10)
  const verdict = unmeasured ? 'unmeasured' : !gained ? 'missed' : 'guard_worse';
  const misses = p.misses_in_row + 1, revert = `PLUSREVERT-${id}`;
  await run(db, `UPDATE plus_ledger SET status='reverted', verdict=?, outcome=?, guard_outcome=?, prediction_hit=?, decided_at=? WHERE id=?`, verdict, unmeasured ? null : after, gafter, hit, nowIso, id);
  await ensureItem(db, { id: revert, title: `Revert plus ${id} of ${l.product} (${verdict}): ${l.title}`, owner_role: 'operations', project: p.program, priority: verdict === 'guard_worse' ? 0 : 5,
    done_check: `reverted via: ${l.revert_path}`, closing_probe: `${l.metric} and ${l.guard} of ${l.product} back near their baselines` });
  await run(db, `INSERT INTO plus_ledger (product, kind, title, evidence, issue_id, status, seeded_from, created_at) VALUES (?, 'revert', ?, ?, ?, 'filed', ?, ?)`,
    l.product, `Revert: ${l.title}`.slice(0, 300), `${verdict}: ${l.metric} ${l.baseline} -> ${unmeasured ? 'unmeasured' : after}; ${l.guard} ${l.guard_baseline} -> ${gafter ?? 'unmeasured'}`, revert, id, nowIso);
  const rest = misses >= c.max_misses ? iso(now + c.rest_h * HOUR) : null;
  await run(db, `UPDATE plus_product_registry SET misses_in_row = ?, pluses_since_simplify = ?, last_plus_at = ?, rest_until = COALESCE(?, rest_until) WHERE product = ?`, misses, cycles, nowIso, rest, l.product);
  if (rest) await ensureItem(db, { id: `PLUSREST-${l.product}-${nowIso.slice(0, 10)}`, title: `${l.product}: ${misses} pluses missed in a row; review a different user or surface before ${rest}`,
    kind: 'work', owner_role: 'product-manager', project: p.program, priority: 20, done_check: 'a different user or surface is named in the next plus', closing_probe: `a plus for ${l.product} is filed after ${rest}` });
  return { id, status: 'reverted', verdict, outcome: unmeasured ? null : after, guard_outcome: gafter, misses_in_row: misses, revert_item: revert, rest_until: rest };
}

export async function decideDue(db, { now = Date.now(), config } = {}) {
  const out = [];
  for (const l of await all(db, `SELECT id FROM plus_ledger WHERE status = 'shipped' AND due_at <= ? ORDER BY id`, iso(now))) out.push(await decidePlus(db, l.id, { now, config }));
  // a measurement cycle ends when the product has a usable usage reading
  for (const l of await all(db, `SELECT l.id, l.product, p.usage_metric FROM plus_ledger l JOIN plus_product_registry p ON p.product = l.product WHERE l.kind = 'measurement' AND l.status = 'filed'`)) {
    const r = await latestReading(db, l.product, l.usage_metric, { now, maxAgeH: cfg(config).reading_max_age_h });
    if (r.value === null) continue;
    await run(db, `UPDATE plus_ledger SET status = 'kept', verdict = 'measured', outcome = ?, decided_at = ? WHERE id = ?`, r.value, iso(now), l.id);
    await run(db, `UPDATE plus_product_registry SET last_plus_at = ? WHERE product = ?`, iso(now), l.product);
    out.push({ id: l.id, status: 'kept', verdict: 'measured' });
  }
  return out;
}

// US-04-R12: a step only the principal can take is exactly one gate card with a default in effect. It is never a question.
export async function principalStep(db, plusId, g) {
  const id = `PLUSGATE-${plusId}`;
  for (const f of ['what', 'why_gated', 'default_in_effect', 'closing_probe']) if (!g[f] || !String(g[f]).trim()) throw new Error(`gate card requires ${f}`);
  if (/\?\s*$/.test(g.what) || /\?\s*$/.test(g.default_in_effect)) throw new Error('a gate card states a step and a default; it is not a question (US-04-R12)');
  if (await first(db, `SELECT 1 AS x FROM gate_cards WHERE id = ?`, id)) return { id, created: false };
  await run(db, `INSERT INTO gate_cards (id, what, why_gated, default_in_effect, prepared_by_fleet, closing_probe) VALUES (?,?,?,?,?,?)`, id, g.what, g.why_gated, g.default_in_effect, g.prepared_by_fleet ?? null, g.closing_probe);
  return { id, created: true };
}

// ---- One cycle (steps 402 to 408) ----
// propose({ product, kind, evidence }) -> the fields of proposePlus, or null. Without it (or when its plus is refused) the
// writing of the plus is itself filed as an ordinary item for the product manager. Bounded by the daily cap.
export async function runCycle(db, { now = Date.now(), config, propose = null } = {}) {
  const c = cfg(config), today = iso(now).slice(0, 10), out = [];
  let left = c.daily_cap - (await first(db, `SELECT COUNT(*) AS n FROM plus_ledger WHERE kind IN ('plus','simplify') AND status <> 'proposed' AND substr(created_at, 1, 10) = ?`, today)).n;
  for (const p of await selectDue(db, { now })) {
    const kind = await cycleKind(db, p, { now, config });
    if (kind === 'measurement') {
      if (!(await first(db, `SELECT 1 AS x FROM plus_ledger WHERE product = ? AND kind = 'measurement' AND status = 'filed'`, p.product))) {
        const issue = `PLUSUSAGE-${p.product}`;
        await run(db, `INSERT INTO plus_ledger (product, kind, title, evidence, metric, issue_id, status, created_at) VALUES (?, 'measurement', ?, ?, ?, ?, 'filed', ?)`,
          p.product, `Measure ${p.usage_metric} for ${p.product}`, 'no usable usage reading', p.usage_metric, issue, iso(now));
        await ensureItem(db, { id: issue, title: `Usage of ${p.product} is unmeasured: connect a reader for ${p.usage_metric}`, owner_role: 'operations', project: p.program, priority: 10,
          done_check: `a fresh ${p.usage_metric} reading exists for ${p.product}`, closing_probe: `plus_product_registry.usage_value is not null for ${p.product}` });
      }
      out.push({ product: p.product, kind, filed: `PLUSUSAGE-${p.product}` });
      continue;
    }
    if (left <= 0) { out.push({ product: p.product, kind, skipped: `daily cap of ${c.daily_cap} reached` }); continue; }
    const evidence = await gatherEvidence(db, p.product, { now, config });
    let refused = null;
    if (propose) {
      try {
        const x = await propose({ product: p.product, kind, evidence });
        if (x) { const r = await proposePlus(db, { ...x, product: p.product, kind, now }, { config }); left--; out.push({ product: p.product, kind, ...r }); continue; }
        refused = 'the proposer returned nothing';
      } catch (e) { refused = e.message; }
    }
    const ask = `PLUSWRITE-${p.product}-${today.replace(/-/g, '')}`;
    await ensureItem(db, { id: ask, title: `Write one ${kind} for ${p.product}${refused ? ` (last attempt refused: ${refused})` : ''}`, kind: 'work', owner_role: 'product-manager', project: p.program, priority: 30,
      done_check: `one ${kind} with prediction, guard, angle${evidence.avoid_angle ? ` other than "${evidence.avoid_angle}"` : ''}, doer and revert path is filed in plus_ledger`,
      closing_probe: `plus_ledger has a filed ${kind} for ${p.product}` });
    out.push({ product: p.product, kind, filed: ask, refused });
  }
  return out;
}

// ---- Digest (weekly) and detectors (US-04-R13) ----
const weekOf = (now) => { const d = new Date(now); const back = (d.getUTCDay() + 6) % 7; return iso(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - back)).slice(0, 10); };
export async function weeklyDigest(db, { now = Date.now() } = {}) {
  const week = weekOf(now), from = iso(now - 7 * 24 * HOUR), to = iso(now), rows = [];
  for (const p of await all(db, `SELECT product FROM plus_product_registry ORDER BY product`)) {
    const n = async (col, status) => (await first(db, `SELECT COUNT(*) AS n FROM plus_ledger WHERE product = ? AND kind IN ('plus','simplify') AND ${col} > ? AND ${col} <= ? ${status ? `AND status = '${status}'` : ''}`, p.product, from, to)).n;
    const row = { week, product: p.product, shipped: await n('shipped_at'), kept: await n('decided_at', 'kept'), reverted: await n('decided_at', 'reverted') };
    await run(db, `INSERT INTO plus_digest (week, product, shipped, kept, reverted, at) VALUES (?,?,?,?,?,?)
        ON CONFLICT(week, product) DO UPDATE SET shipped=excluded.shipped, kept=excluded.kept, reverted=excluded.reverted, at=excluded.at`, week, row.product, row.shipped, row.kept, row.reverted, to);
    rows.push(row);
  }
  return rows;
}
export async function detect(db, { now = Date.now(), config } = {}) {
  const c = cfg(config), filed = [];
  const ps = await all(db, `SELECT * FROM plus_product_registry WHERE state = 'active' ORDER BY product`);
  for (const p of ps) {
    if ((await latestReading(db, p.product, p.usage_metric, { now, maxAgeH: c.reading_max_age_h })).value !== null) continue;
    if (await ensureItem(db, { id: `PLUSUSAGE-${p.product}`, title: `Usage of ${p.product} is unmeasured: connect a reader for ${p.usage_metric}`, owner_role: 'operations', project: p.program, priority: 10,
      done_check: `a fresh ${p.usage_metric} reading exists for ${p.product}`, closing_probe: `plus_product_registry.usage_value is not null for ${p.product}` })) filed.push(`PLUSUSAGE-${p.product}`);
  }
  const last = (await first(db, `SELECT MAX(at) AS at FROM plus_digest`))?.at;
  const since = last ?? ps.map(p => p.created_at).sort()[0]; // before the first digest, the clock starts at the first product
  if (ps.length && (now - parseIso(since)) / HOUR > c.digest_max_age_h) {
    const id = `PLUSDIGEST-stale-${iso(now).slice(0, 10)}`;
    if (await ensureItem(db, { id, title: `The weekly plus digest is stale (last: ${last ?? 'never'})`, owner_role: 'operations', priority: 10,
      done_check: 'a plus_digest row exists for the current week', closing_probe: 'MAX(plus_digest.at) within 8 days' })) filed.push(id);
  }
  return filed;
}

// Tick step for the composition root: plusStep({ reader, propose }). Order: read usage, decide what is due, start cycles,
// write the digest when the last one is 7 days old, then run the detectors (a digest that still is stale is then a real fault).
export function plusStep(ports = {}) {
  return { name: 'plus', run: async (db, ctx) => {
    const config = ctx.config?.plus;
    if (config?.enabled === false) { ctx.notes?.push('plus: off'); return; }
    const now = typeof ctx.now === 'number' ? ctx.now : Date.now();
    if (ports.reader) await measureUsage(db, { reader: ports.reader, now });
    const decided = await decideDue(db, { now, config });
    const cycles = await runCycle(db, { now, config, propose: ports.propose });
    const last = (await first(db, `SELECT MAX(at) AS at FROM plus_digest`))?.at;
    if (!last || now - parseIso(last) >= 7 * 24 * HOUR) await weeklyDigest(db, { now });
    const found = await detect(db, { now, config });
    ctx.notes?.push(`plus: ${decided.length} decided, ${cycles.length} cycle(s), ${found.length} detector item(s)`);
  } };
}
