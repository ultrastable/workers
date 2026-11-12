// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Steward (US-SPEC-08): keeps the item ledger and the issue tracker in step. Every item is mirrored to EVERY configured sink
// independently (no single route); a failing sink is recorded per item and retried, never blocking the others. The steward also
// answers three questions a tracker cannot: which open items have no mirror (unplaced), which mirrors keep failing (stuck),
// and which items break the item format (hygiene). Pull-direction sync (tracker edits back into items) is NOT COVERED here.
// Ports: ctx = { db, now(), config, sinks }. sinks: ordered list of { name, upsert(item, prevRef) -> { ref } }.
const DEFAULTS = { batch: 50, stuck_after_failures: 3, closed_statuses: ['done', 'superseded', 'cancelled'] };
export const cfg = ctx => ({ ...DEFAULTS, ...(ctx.config || {}) });
const iso = ms => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const nowMs = ctx => { const v = ctx.now(); return v instanceof Date ? v.getTime() : v; };
const all = async (db, sql, ...a) => (await db.prepare(sql).bind(...a).all()).results || [];
async function sha(text) { const b = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))); return [...b].map(x => x.toString(16).padStart(2, '0')).join(''); }

/** Item format: an owner role, a done check and a closing probe. Returns the names of the missing fields. */
export const hygiene = item => ['owner_role', 'done_check', 'closing_probe'].filter(k => !String(item[k] ?? '').trim());
/** Content hash of the fields a sink shows; a changed hash means the sink is stale. */
export const itemHash = it => sha(JSON.stringify([it.title, it.status, it.disposition, it.owner_role, it.closing_probe, it.done_check, it.priority]));

/** One sweep: push every changed item to every sink, count what each sink did. */
export async function mirror(ctx) {
  const c = cfg(ctx), ts = iso(nowMs(ctx)), out = { synced: 0, failed: 0, skipped: 0, flagged: [] };
  const items = await all(ctx.db, 'SELECT * FROM items ORDER BY updated_at DESC LIMIT ?', c.batch);
  for (const it of items) {
    const missing = hygiene(it); if (missing.length) out.flagged.push({ id: it.id, missing });
    const hash = await itemHash(it);
    for (const s of ctx.sinks || []) {
      const prev = await ctx.db.prepare('SELECT ref, hash FROM steward_mirror WHERE item_id = ? AND sink = ?').bind(it.id, s.name).first();
      if (prev && prev.hash === hash) { out.skipped++; continue; }
      try {
        const r = await s.upsert(it, prev?.ref ?? null);
        await ctx.db.prepare('INSERT INTO steward_mirror (item_id, sink, ref, hash, synced_at) VALUES (?,?,?,?,?) ON CONFLICT(item_id, sink) DO UPDATE SET ref=excluded.ref, hash=excluded.hash, synced_at=excluded.synced_at, last_error=NULL')
          .bind(it.id, s.name, r?.ref ?? null, hash, ts).run(); out.synced++;
      } catch (e) {
        await ctx.db.prepare('INSERT INTO steward_mirror (item_id, sink, hash, synced_at, last_error) VALUES (?,?,?,?,?) ON CONFLICT(item_id, sink) DO UPDATE SET last_error=excluded.last_error')
          .bind(it.id, s.name, 'unsynced', ts, String(e?.message || e).slice(0, 200)).run(); out.failed++;
      }
    }
  }
  return out;
}

/** Open items with no successful mirror on some sink: { item_id, sinks: [names missing] }. */
export async function unplaced(ctx) {
  const c = cfg(ctx), names = (ctx.sinks || []).map(s => s.name), res = [];
  const open = await all(ctx.db, `SELECT id FROM items WHERE status NOT IN (${c.closed_statuses.map(() => '?').join(',')})`, ...c.closed_statuses);
  for (const it of open) {
    const placed = new Set((await all(ctx.db, "SELECT sink FROM steward_mirror WHERE item_id = ? AND ref IS NOT NULL AND hash <> 'unsynced'", it.id)).map(r => r.sink));
    const missing = names.filter(n => !placed.has(n));
    if (missing.length) res.push({ item_id: it.id, sinks: missing });
  }
  return res;
}

/** Mirrors that never succeeded (hash still 'unsynced'): the sink is failing for that item and needs a human-free remedy item. */
export async function stuck(ctx) {
  return all(ctx.db, "SELECT item_id, sink, last_error FROM steward_mirror WHERE hash = 'unsynced' ORDER BY item_id, sink");
}

/** Counts for the console: items by status, by owner role, and how many break the format. */
export async function rollup(ctx) {
  const by = async col => Object.fromEntries((await all(ctx.db, `SELECT ${col} k, COUNT(*) n FROM items GROUP BY ${col}`)).map(r => [r.k ?? '-', Number(r.n)]));
  const items = await all(ctx.db, 'SELECT * FROM items');
  return { total: items.length, by_status: await by('status'), by_owner: await by('owner_role'), malformed: items.filter(i => hygiene(i).length).length };
}

/** Full cycle: mirror, then record one run row and file one item per stuck mirror (deduplicated by id). */
export async function steward(ctx) {
  const m = await mirror(ctx), up = await unplaced(ctx), st = await stuck(ctx), ts = iso(nowMs(ctx));
  let filed = 0;
  for (const s of st) {
    if (String(s.item_id).startsWith('STW-')) continue; // a remedy item that cannot be mirrored must not spawn another
    const r = await ctx.db.prepare("INSERT OR IGNORE INTO items (id,title,kind,owner_role,done_check,closing_probe,priority,status) VALUES (?,?,'fix','operations',?,?,45,'open')")
      .bind('STW-' + s.item_id + '-' + s.sink, 'Sink ' + s.sink + ' cannot mirror ' + s.item_id + ': ' + String(s.last_error || '').slice(0, 80), 'the sink accepts the item', 'steward_mirror row for ' + s.item_id + '/' + s.sink + ' has a ref').run();
    filed += r.meta.changes;
  }
  await ctx.db.prepare('INSERT INTO steward_runs (at, synced, failed, skipped, flagged, unplaced, stuck) VALUES (?,?,?,?,?,?,?)').bind(ts, m.synced, m.failed, m.skipped, m.flagged.length, up.length, st.length).run();
  return { ...m, unplaced: up, stuck: st, filed };
}
