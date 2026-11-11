// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Document gate: "if it is not in code, it does not exist". Every document is either traced to a work item or gets a recorded
// disposition; unchecked boxes and open-item sections inside documents become work items.
// Ports: ctx = { db, now(), config, store: { name, list(): [{key,size,uploaded}], text(key): string } }. No storage vendor is named.

const DEFAULTS = { extensions: ['md', 'txt'], max_listed: 50, scan_per_run: 6, max_lines_per_doc: 40, owner_role: 'project-manager', grandfather_before: null };
const WANT = /(open|remaining|deferred|todo|to-do|next step|blocker|blocked|follow[- ]?up|not done|pending|unresolved|failure|failed|incomplete)/i;
export const cfg = ctx => ({ ...DEFAULTS, ...(ctx.config || {}) });
const nowIso = ctx => { const v = ctx.now(); return (v instanceof Date ? v : new Date(v)).toISOString(); };
const all = async (db, sql, ...a) => (await db.prepare(sql).bind(...a).all()).results || [];
const first = async (db, sql, ...a) => (await db.prepare(sql).bind(...a).first()) || null;
const run = (db, sql, ...a) => db.prepare(sql).bind(...a).run();
const slug = s => s.replace(/[^A-Za-z0-9]/g, '').slice(-40);

/** Pure: open items in a document's text (unchecked boxes, and list lines under headings that name open work). */
export function extractItems(text, max = 40) {
  const items = []; let sec = '';
  for (const ln of String(text || '').split('\n')) {
    const h = ln.match(/^\s*#{1,6}\s*(.*)$/);
    if (h) { sec = WANT.test(h[1]) ? h[1].trim().slice(0, 60) : ''; continue; }
    if (/^\s*[-*]\s*\[ \]\s+\S/.test(ln)) items.push(['unchecked', ln.trim().slice(0, 200)]);
    else if (sec && /^\s*([-*]|\d+[.)])\s+\S/.test(ln)) items.push([sec, ln.trim().slice(0, 200)]);
    if (items.length >= max) break;
  }
  return items;
}

async function fileItem(ctx, id, title, body, priority) {
  const ex = await first(ctx.db, 'SELECT id FROM items WHERE id = ?', id);
  if (ex) return false;
  await run(ctx.db, `INSERT INTO items (id, title, kind, owner_role, done_check, closing_probe, priority, status) VALUES (?,?,'work',?,?,?,?,'open')`,
    id, title, cfg(ctx).owner_role, body, 'every listed document is implemented as code, filed as its own item, or retired with a reason', priority);
  return true;
}

/** One pass: list the store, trace new documents against work items, file one item for the untraced ones, extract open items. */
export async function sweep(ctx) {
  const c = cfg(ctx), now = nowIso(ctx), store = ctx.store.name;
  const ext = new RegExp('\\.(' + c.extensions.join('|') + ')$', 'i');
  const known = new Set((await all(ctx.db, 'SELECT key FROM docgate_docs WHERE store = ?', store)).map(r => r.key));
  let newDocs = 0;
  for (const d of (await ctx.store.list()).filter(d => ext.test(d.key))) {
    if (known.has(d.key)) { await run(ctx.db, 'UPDATE docgate_docs SET last_seen=?, size=? WHERE store=? AND key=?', now, d.size, store, d.key); continue; }
    newDocs++;
    const name = d.key.split('/').pop().replace(ext, '').slice(0, 40), like = '%' + name + '%';
    const hit = await first(ctx.db, 'SELECT COUNT(*) n FROM items WHERE title LIKE ?1 OR done_check LIKE ?1 OR IFNULL(closing_probe,\'\') LIKE ?1', like);
    const traced = +hit.n > 0 ? 1 : 0;
    const old = c.grandfather_before && String(d.uploaded || '') < c.grandfather_before;
    await run(ctx.db, 'INSERT OR IGNORE INTO docgate_docs (store,key,size,uploaded,first_seen,last_seen,traced,disposition) VALUES (?,?,?,?,?,?,?,?)',
      store, d.key, d.size, d.uploaded || null, now, now, traced, !traced && old ? 'grandfathered' : null);
  }
  const unc = await all(ctx.db, 'SELECT key FROM docgate_docs WHERE store=? AND traced=0 AND disposition IS NULL ORDER BY first_seen LIMIT ' + c.max_listed, store);
  let filed = 0;
  if (unc.length) {
    const id = 'DOC-ORPHAN-' + now.slice(0, 13).replace(/[-T]/g, '') + '-' + slug(store);
    if (await fileItem(ctx, id, `${id}: ${unc.length} untraced documents in ${store}`, 'Untraced documents:\n' + unc.map(u => u.key).join('\n'), 40)) filed++;
    for (const u of unc) await run(ctx.db, 'UPDATE docgate_docs SET disposition=? WHERE store=? AND key=?', 'item:' + id, store, u.key);
  }
  for (const d of await all(ctx.db, "SELECT key, size FROM docgate_docs WHERE store=? AND items_scanned IS NULL AND lower(key) LIKE '%.md' ORDER BY size DESC LIMIT " + c.scan_per_run, store)) {
    const items = extractItems(await ctx.store.text(d.key), c.max_lines_per_doc);
    for (const it of items) await run(ctx.db, 'INSERT INTO docgate_action_items (store,key,section,line) VALUES (?,?,?,?)', store, d.key, it[0], it[1]);
    await run(ctx.db, 'UPDATE docgate_docs SET items_scanned=? WHERE store=? AND key=?', now, store, d.key);
    if (items.length && await fileItem(ctx, 'DOC-ITEMS-' + slug(d.key), `DOC-ITEMS: ${d.key.split('/').pop()} lists ${items.length} open item(s)`,
      items.slice(0, 15).map(x => `[${x[0]}] ${x[1]}`).join('\n'), 70)) filed++;
  }
  const total = +(await first(ctx.db, 'SELECT COUNT(*) n FROM docgate_docs WHERE store=?', store)).n;
  const traced = +(await first(ctx.db, 'SELECT COUNT(*) n FROM docgate_docs WHERE store=? AND traced=1', store)).n;
  const orphans = +(await first(ctx.db, 'SELECT COUNT(*) n FROM docgate_docs WHERE store=? AND traced=0 AND disposition IS NULL', store)).n;
  await run(ctx.db, 'INSERT INTO docgate_runs (ts,total,traced,orphans,new_docs,items_filed) VALUES (?,?,?,?,?,?)', now, total, traced, orphans, newDocs, filed);
  return { total, traced, orphans, newDocs, filed };
}
