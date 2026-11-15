// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Document-database adapter (US-SPEC-14 section 4, "Document database"). Each L1 table is a collection keyed by its primary
// key. A document store has no SQL, so the store-handle steps cannot run on it: the three steps the specification names
// (reconcile, trust, dispatch) are rewritten here against a small document port, with the same results as core/src/tick.js.
//   - claim uniqueness: a create-only write keyed by item id (US-01-R02, US-01-T02);
//   - dispatch: an indexed query on (status, owner_role, priority), then a transactional claim (US-14-R11);
// The port (what a driver for a hosted document database has to offer):
//   create(coll, key, doc) -> true | false (false when the key exists; never overwrites)
//   get(coll, key) -> doc | null        set(coll, key, doc)        patch(coll, key, fields) -> true | false
//   remove(coll, key)                   add(coll, doc) -> key (store-assigned, increasing)
//   query(coll, { where: { field: value | [values] }, orderBy: [field, ...], limit }) -> [{ key, ...doc }], needs a declared index
//   scan(coll) -> every document        transaction(fn) -> runs fn(tx) alone, all-or-nothing
// memoryDocStore() is the reference implementation of the port, used by the tests. No hosted driver is bundled.
export const COLLECTIONS = ['org', 'roles', 'items', 'claims', 'gate_cards', 'predictions', 'outcomes', 'trust_ledger', 'dispatches', 'tick_runs', 'doctrine_lineage'];
export const INDEXES = { items: [['status', 'owner_role', 'priority'], ['status']], claims: [['agent']], outcomes: [['surface', 'action_class']] };
const TERMINAL = ['done', 'superseded', 'cancelled'];
const iso = ms => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const clone = o => (o == null ? o : JSON.parse(JSON.stringify(o)));

/** The reference document store. `yieldEvery` makes every operation give up the event loop first, so concurrent callers
 *  interleave the way they do against a networked store; a test that passes only without it proves nothing. */
export function memoryDocStore({ indexes = INDEXES, yieldEvery = true } = {}) {
  let data = new Map(); let seq = 0; let lock = Promise.resolve();
  const coll = c => { if (!data.has(c)) data.set(c, new Map()); return data.get(c); };
  const tick = () => (yieldEvery ? new Promise(r => setImmediate(r)) : null);
  const covered = (c, fields) => fields.length === 0 || (indexes[c] || []).some(ix => fields.every(f => ix.includes(f)) && ix.slice(0, fields.length).every(f => fields.includes(f)));
  const ops = {
    create(c, key, doc) { const m = coll(c); if (m.has(String(key))) return false; m.set(String(key), clone(doc)); return true; },
    get(c, key) { const d = coll(c).get(String(key)); return d ? { key: String(key), ...clone(d) } : null; },
    set(c, key, doc) { coll(c).set(String(key), clone(doc)); },
    patch(c, key, fields) { const m = coll(c); const d = m.get(String(key)); if (!d) return false; m.set(String(key), { ...d, ...clone(fields) }); return true; },
    remove(c, key) { return coll(c).delete(String(key)); },
    add(c, doc) { const key = String(++seq).padStart(12, '0'); coll(c).set(key, clone(doc)); return key; },
    query(c, { where = {}, orderBy = [], limit = Infinity } = {}) {
      const fields = Object.keys(where);
      if (!covered(c, fields)) throw new Error(`no index on ${c} for (${fields.join(', ')}): declare one`);
      const rows = [...coll(c)].filter(([, d]) => fields.every(f => (Array.isArray(where[f]) ? where[f].includes(d[f]) : d[f] === where[f]))).map(([key, d]) => ({ key, ...clone(d) }));
      rows.sort((a, b) => { for (const f of orderBy) { if (a[f] !== b[f]) return (a[f] ?? '') < (b[f] ?? '') ? -1 : 1; } return a.key < b.key ? -1 : a.key > b.key ? 1 : 0; });
      return rows.slice(0, limit);
    },
    scan(c) { return [...coll(c)].map(([key, d]) => ({ key, ...clone(d) })); },
  };
  const asyncOps = Object.fromEntries(Object.entries(ops).map(([n, f]) => [n, async (...a) => { await tick(); return f(...a); }]));
  return {
    ...asyncOps,
    /** Serialized and all-or-nothing: a throw inside fn restores the store as it was. */
    transaction(fn) {
      const runIt = async () => {
        const snapshot = new Map([...data].map(([c, m]) => [c, new Map([...m].map(([k, d]) => [k, clone(d)]))]));
        const seqBefore = seq;
        try { return await fn(ops); } catch (e) { data = snapshot; seq = seqBefore; throw e; }
      };
      const p = lock.then(runIt, runIt); lock = p.catch(() => {}); return p;
    },
    _size: c => coll(c).size,
  };
}

/** Take the claim on an item for an agent. Exactly one caller wins, however many try at once (US-01-R02, US-14-R11). */
export async function claim(store, itemId, agent, nowIso) {
  return store.transaction(tx => {
    const item = tx.get('items', itemId);
    if (!item) return { ok: false, reason: 'no_such_item' };
    if (!tx.create('claims', itemId, { item_id: itemId, agent, claimed_at: nowIso, heartbeat_at: nowIso })) return { ok: false, reason: 'already_claimed' };
    tx.patch('items', itemId, { status: 'claimed', updated_at: nowIso });
    return { ok: true };
  });
}

export function reliability(successes, outcomes, trust) { return (successes + trust.baseline * trust.prior_weight) / (outcomes + trust.prior_weight); }

async function ensureItem(store, item, nowIso) {
  return store.create('items', item.id, { title: item.title, kind: item.kind || 'fix', project: null, owner_role: item.owner_role, trigger_on: null, done_check: item.done_check,
    closing_probe: item.closing_probe || null, priority: item.priority ?? 10, status: 'ready', disposition: null, blocker: null, surface: item.surface || null, action_class: item.action_class || null, created_at: nowIso, updated_at: nowIso });
}

export const STEPS = {
  /** Every item that left the active set has a disposition (US-01-R03, US-01-T03); items whose trigger is done become ready. */
  async reconcile(store, ctx) {
    const closed = await store.query('items', { where: { status: TERMINAL } });
    const drops = closed.filter(i => !i.disposition);
    for (const d of drops) {
      await store.patch('items', d.key, { status: 'open', updated_at: ctx.nowIso });
      await store.add('outcomes', { item_id: d.key, agent: null, surface: 'work_tracker', action_class: 'create_update_close', result: 'silent_drop', evidence: 'reopened by reconcile: no disposition', at: ctx.nowIso });
    }
    const done = new Set((await store.query('items', { where: { status: 'done' } })).map(i => i.key));
    let ready = 0;
    for (const i of await store.query('items', { where: { status: 'open' } })) {
      if (i.trigger_on == null || done.has(i.trigger_on)) { await store.patch('items', i.key, { status: 'ready', updated_at: ctx.nowIso }); ready++; }
    }
    ctx.notes.push(`reconciled: ${drops.length} reopened, ${ready} became ready`);
  },

  /** Trust per (surface, action_class) from recorded outcomes; a crossed threshold opens a ladder item, once. */
  async accrue_trust(store, ctx) {
    const { trust, ladder, surfaces } = ctx.config.policy;
    const groups = new Map();
    for (const o of await store.scan('outcomes')) {
      const k = `${o.surface}|${o.action_class}`;
      const g = groups.get(k) || { surface: o.surface, action_class: o.action_class, ok: 0, severe: 0, n: 0 };
      g.n++; if (o.result === 'verified') g.ok++; if (o.result === 'hidden_failure' || o.result === 'silent_drop') g.severe++;
      groups.set(k, g);
    }
    for (const [k, r] of [...groups].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
      const rel = reliability(r.ok, r.n, trust);
      const cur = await store.get('trust_ledger', k);
      const rung = cur ? cur.rung : surfaces[r.surface]?.start_rung || 'observed';
      await store.set('trust_ledger', k, { surface: r.surface, action_class: r.action_class, rung, reliability: rel, outcomes: r.n, updated_at: ctx.nowIso });
      const idx = ladder.rungs.indexOf(rung);
      const ceilingIdx = ladder.rungs.indexOf(ladder.ceiling_by_max_permission[surfaces[r.surface]?.max_permission || 'none'] || 'observed');
      const promote = idx >= 0 && idx < ceilingIdx && r.n >= ladder.promote_when.min_outcomes && rel >= ladder.promote_when.min_reliability && r.severe === 0;
      const demote = idx > 0 && (rel < ladder.demote_when.reliability_below || r.severe > 0);
      if (promote || demote) {
        const to = ladder.rungs[promote ? idx + 1 : idx - 1];
        const made = await ensureItem(store, { id: `LADDER-${r.surface}-${r.action_class}-${to}`,
          title: `${promote ? 'Promote' : 'Demote'} ${r.surface}/${r.action_class} from ${rung} to ${to} (reliability ${rel.toFixed(2)} over ${r.n})`,
          kind: 'ladder', owner_role: 'operations', done_check: 'PR to autonomy/policy.json merged after review by a different agent',
          closing_probe: `trust_ledger rung = ${to}`, priority: demote ? 0 : 20, surface: r.surface, action_class: r.action_class }, ctx.nowIso);
        if (made) ctx.notes.push(`ladder item opened: ${r.surface}/${r.action_class} -> ${to}`);
      }
    }
  },

  /** Roles whose tick is due pull the top ready item for their role: an indexed query, then a transactional claim. A candidate
   *  another instance claimed in between is skipped and the next one tried. */
  async dispatch(store, ctx) {
    let n = 0;
    for (const role of await store.scan('roles')) {
      if (ctx.tickId % Math.max(1, role.tick_every || 1) !== 0) continue;
      const wip = (await store.query('claims', { where: { agent: role.key } })).length;
      if (wip >= ctx.config.max_wip_per_role) continue;
      const candidates = (await store.query('items', { where: { status: 'ready', owner_role: [...new Set([role.role, role.key])] }, orderBy: ['priority', 'created_at'] }))
        .filter(i => i.project == null || role.project == null || i.project === role.project)
        .sort((a, b) => (b.owner_role === role.key) - (a.owner_role === role.key));
      await store.patch('roles', role.key, { last_tick_at: ctx.nowIso });
      for (const item of candidates) {
        const won = await store.transaction(tx => {
          const fresh = tx.get('items', item.key);
          if (!fresh || fresh.status !== 'ready') return false;
          if (!tx.create('claims', item.key, { item_id: item.key, agent: role.key, claimed_at: ctx.nowIso, heartbeat_at: ctx.nowIso })) return false;
          tx.patch('items', item.key, { status: 'claimed', updated_at: ctx.nowIso });
          tx.add('dispatches', { tick_id: ctx.tickId, role_id: role.key, item_id: item.key, model: role.model, status: 'queued', at: ctx.nowIso });
          return true;
        });
        if (won) { n++; break; }
      }
    }
    ctx.dispatched = (ctx.dispatched || 0) + n;
    ctx.notes.push(`dispatched ${n} item(s)`);
  },
};
export const STEP_ORDER = ['reconcile', 'accrue_trust', 'dispatch'];

/** Run the rewritten steps as one tick and record it. A failing step is recorded and the rest still run, as in the core. */
export async function runDocTick(store, { config, now = Date.now(), tickId } = {}) {
  const nowIso = iso(now);
  const key = await store.add('tick_runs', { started_at: nowIso, finished_at: null, steps_completed: 0, steps_total: STEP_ORDER.length, report: null, errors: null });
  const ctx = { config, now, nowIso, tickId: tickId ?? Number(key), notes: [], errors: [], dispatched: 0 };
  let completed = 0;
  for (const name of STEP_ORDER) {
    try { await STEPS[name](store, ctx); completed++; } catch (e) { ctx.errors.push(`${name}: ${e.message}`); }
  }
  await store.patch('tick_runs', key, { finished_at: nowIso, steps_completed: completed, report: ctx.notes.join('; '), errors: ctx.errors.length ? JSON.stringify(ctx.errors) : null });
  return { tickId: ctx.tickId, completed, total: STEP_ORDER.length, dispatched: ctx.dispatched, errors: ctx.errors, notes: ctx.notes };
}

/** Copy the L1 tables of a store handle into a document store (items, roles, claims, outcomes, trust_ledger), keyed by primary key. */
export async function importFromStore(db, store) {
  const all = async sql => (await db.prepare(sql).bind().all()).results || [];
  for (const r of await all(`SELECT * FROM roles ORDER BY rowid`)) { const { id, ...d } = r; await store.set('roles', id, d); }
  for (const r of await all(`SELECT * FROM items ORDER BY rowid`)) { const { id, ...d } = r; await store.set('items', id, d); }
  for (const r of await all(`SELECT * FROM claims`)) await store.create('claims', r.item_id, r);
  for (const r of await all(`SELECT * FROM outcomes ORDER BY id`)) { const { id, ...d } = r; await store.add('outcomes', d); }
  for (const r of await all(`SELECT * FROM trust_ledger`)) await store.set('trust_ledger', `${r.surface}|${r.action_class}`, r);
}
