// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Stage 2 of the self-hosting ladder (US-SPEC-20 s4): the organization's own database holds the items, claims and
// decisions, mirrored with the issue tracker. steward.js pushes items; this file adds the rest: claims as `claim:` comments,
// decisions as their own issues, adoption of issues that exist only on the tracker, and the stage's evidence as a probe:
// "items in the store match open issues". Ports: ctx = { db, now(), config, tracker }. Token by env name only.
const iso = ms => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const nowMs = ctx => { const v = typeof ctx.now === 'function' ? ctx.now() : ctx.now; return v instanceof Date ? v.getTime() : Number(v); };
const all = async (db, sql, ...a) => (await db.prepare(sql).bind(...a).all()).results || [];
const first = async (db, sql, ...a) => (await db.prepare(sql).bind(...a).first()) || null;
const run = (db, sql, ...a) => db.prepare(sql).bind(...a).run();
const TERMINAL = ['done', 'superseded', 'cancelled'];
const UPSERT = `INSERT INTO steward_mirror (item_id, sink, ref, hash, synced_at) VALUES (?,?,?,?,?)
  ON CONFLICT(item_id, sink) DO UPDATE SET ref=excluded.ref, hash=excluded.hash, synced_at=excluded.synced_at, last_error=NULL`;

/** The tracker port over REST issues. Pull requests are not issues here. Reads are paged and bounded. */
export function githubTracker({ fetch, repo, env = {}, tokenEnv = 'VCS_TOKEN', apiBase = 'https://api.github.com', maxPages = 10 }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(String(repo || ''))) throw new Error('stage2: repo must be "owner/name"');
  const call = async (method, path, body) => {
    const t = env[tokenEnv]; if (!t) throw new Error('stage2: token variable ' + tokenEnv + ' is not set');
    const res = await fetch(apiBase + '/repos/' + repo + path, { method, headers: { accept: 'application/vnd.github+json', authorization: 'Bearer ' + t, 'content-type': 'application/json', 'user-agent': 'ultrastable-steward' }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (!res.ok) throw new Error('stage2: ' + method + ' ' + path.split('?')[0] + ' -> http ' + res.status);
    return res.json();
  };
  return {
    name: 'github',
    async openIssues() {
      const out = [];
      for (let page = 1; page <= maxPages; page++) {
        const batch = await call('GET', `/issues?state=open&per_page=100&page=${page}`);
        out.push(...batch.filter(i => !i.pull_request).map(i => ({ number: String(i.number), title: i.title, body: i.body || '' })));
        if (batch.length < 100) return { issues: out, complete: true };
      }
      return { issues: out, complete: false }; // more pages than the bound: the caller must not call the comparison complete
    },
    comment: async (number, body) => ({ ref: String((await call('POST', `/issues/${number}/comments`, { body })).id) }),
    async upsertIssue({ title, body, closed }, prev) {
      if (prev) { await call('PATCH', '/issues/' + prev, { title, body, state: closed ? 'closed' : 'open' }); return { ref: prev }; }
      const r = await call('POST', '/issues', { title, body });
      if (closed) await call('PATCH', '/issues/' + r.number, { state: 'closed' });
      return { ref: String(r.number) };
    },
  };
}

/**
 * Pure comparison of the store with the tracker. items: rows of `items`; mirrors: steward_mirror rows of every tracker
 * sink ({ item_id, sink, ref }); issues: the open issues. An issue the store placed there (an item or a decision) is known.
 */
export function compareStore(items, mirrors, issues, sink = 'github') {
  const refOf = new Map(mirrors.filter(m => m.sink === sink && m.ref).map(m => [m.item_id, String(m.ref)]));
  const known = new Set(mirrors.filter(m => (m.sink === sink || m.sink === sink + ':decision') && m.ref).map(m => String(m.ref)));
  const open = new Set(issues.map(i => String(i.number)));
  const active = items.filter(i => !TERMINAL.includes(i.status)), closed = items.filter(i => TERMINAL.includes(i.status));
  const r = {
    matched: active.filter(i => refOf.has(i.id) && open.has(refOf.get(i.id))).map(i => i.id),
    missing_on_tracker: active.filter(i => !refOf.has(i.id) || !open.has(refOf.get(i.id))).map(i => i.id),
    closed_in_store_open_on_tracker: closed.filter(i => refOf.has(i.id) && open.has(refOf.get(i.id))).map(i => i.id),
    only_on_tracker: issues.filter(i => !known.has(String(i.number))).map(i => String(i.number)),
  };
  return { ...r, match: !r.missing_on_tracker.length && !r.closed_in_store_open_on_tracker.length && !r.only_on_tracker.length };
}

const line = (body, name) => new RegExp(`^\\**${name}\\**:\\s*(.+?)\\s*$`, 'im').exec(body || '')?.[1] || '';
/** An issue that exists only on the tracker becomes an item in the store (the store is the source of truth), linked to its issue. */
export async function adopt(ctx, issue) {
  const ts = iso(nowMs(ctx)), id = `GH-${issue.number}`;
  const owner = line(issue.body, 'Owner role') || 'operations', done = line(issue.body, 'Done check') || `issue ${issue.number} is closed with its evidence`, probe = line(issue.body, 'Closing probe') || null;
  await run(ctx.db, `INSERT OR IGNORE INTO items (id, title, owner_role, done_check, closing_probe, created_at, updated_at) VALUES (?,?,?,?,?,?,?)`, id, String(issue.title).slice(0, 300), owner, done, probe === '(missing)' ? null : probe, ts, ts);
  await run(ctx.db, UPSERT, id, ctx.tracker.name, String(issue.number), 'adopted', ts);
  return id;
}

/** Every live claim in the store appears on its item's issue as `claim: <agent> <UTC time>`, once per claim. */
export async function mirrorClaims(ctx) {
  const ts = iso(nowMs(ctx)), sink = ctx.tracker.name, out = { posted: 0, skipped: 0, unplaced: 0, failed: 0 };
  for (const c of await all(ctx.db, `SELECT c.item_id, c.agent, c.claimed_at, m.ref FROM claims c LEFT JOIN steward_mirror m ON m.item_id = c.item_id AND m.sink = ?`, sink)) {
    if (!c.ref) { out.unplaced++; continue; } // the item has no issue yet; the item mirror places it first
    const hash = `${c.agent}|${c.claimed_at}`, key = `claim:${c.item_id}`;
    const prev = await first(ctx.db, `SELECT hash FROM steward_mirror WHERE item_id=? AND sink=?`, key, sink + ':claim');
    if (prev?.hash === hash) { out.skipped++; continue; }
    try {
      const r = await ctx.tracker.comment(c.ref, `claim: ${c.agent} ${String(c.claimed_at).replace(' ', 'T')}Z`);
      await run(ctx.db, UPSERT, key, sink + ':claim', r.ref, hash, ts); out.posted++;
    } catch { out.failed++; }
  }
  return out;
}

/** Every decision record in the store has its own issue: authority, prediction and revert path; closed once the decision is settled. */
export async function mirrorDecisions(ctx) {
  const ts = iso(nowMs(ctx)), sink = ctx.tracker.name + ':decision', out = { synced: 0, skipped: 0, failed: 0 };
  const has = await first(ctx.db, `SELECT name FROM sqlite_master WHERE type='table' AND name='kernel_decisions'`);
  if (!has) return { ...out, absent: true };
  for (const d of await all(ctx.db, `SELECT id, decision, authority, prediction, revert_path, status FROM kernel_decisions ORDER BY id`)) {
    const hash = [d.decision, d.authority, d.prediction, d.revert_path, d.status].join('|');
    const prev = await first(ctx.db, `SELECT ref, hash FROM steward_mirror WHERE item_id=? AND sink=?`, d.id, sink);
    if (prev?.hash === hash) { out.skipped++; continue; }
    try {
      const body = `**${d.id}**\n\nDecision: ${d.decision}\nAuthority: ${d.authority}\nPrediction: ${d.prediction}\nRevert path: ${d.revert_path}\nStatus: ${d.status}`;
      const r = await ctx.tracker.upsertIssue({ title: `Decision ${d.id}: ${String(d.decision).slice(0, 120)}`, body, closed: d.status !== 'open' }, prev?.ref || null);
      await run(ctx.db, UPSERT, d.id, sink, r.ref, hash, ts); out.synced++;
    } catch { out.failed++; }
  }
  return out;
}

/**
 * The stage's evidence as a probe. Reads the open issues, adopts the ones the store does not hold (config.stage2.adopt,
 * default true), compares, and files STAGE2-MISMATCH while the store and the tracker disagree. An unreadable or
 * incompletely read tracker is `unknown`: it is never reported as a match. The probe's own item is left out of the
 * comparison, so the probe cannot keep itself failing.
 */
export async function stage2Probe(ctx) {
  const ts = iso(nowMs(ctx)), sink = ctx.tracker.name, adoptOn = ctx.config?.stage2?.adopt !== false;
  let read;
  try { read = await ctx.tracker.openIssues(); } catch (e) { return { result: 'unknown', reason: String(e?.message || e).slice(0, 200) }; }
  if (!read.complete) return { result: 'unknown', reason: 'the tracker holds more open issues than the read bound' };
  const load = async () => compareStore(await all(ctx.db, `SELECT id, status FROM items WHERE id != 'STAGE2-MISMATCH'`), await all(ctx.db, `SELECT item_id, sink, ref FROM steward_mirror WHERE sink IN (?, ?)`, sink, sink + ':decision'), read.issues, sink);
  let cmp = await load(); const adopted = [];
  if (adoptOn && cmp.only_on_tracker.length) {
    for (const n of cmp.only_on_tracker) adopted.push(await adopt(ctx, read.issues.find(i => i.number === n)));
    cmp = await load();
  }
  if (cmp.match) {
    await run(ctx.db, `UPDATE items SET status='done', disposition=?, updated_at=? WHERE id='STAGE2-MISMATCH' AND status NOT IN ('done','superseded','cancelled')`, `store and tracker match: ${cmp.matched.length} item(s)`, ts);
  } else {
    const what = `${cmp.missing_on_tracker.length} open item(s) without an open issue, ${cmp.closed_in_store_open_on_tracker.length} closed item(s) with an open issue, ${cmp.only_on_tracker.length} issue(s) not in the store`;
    await run(ctx.db, `INSERT INTO items (id, title, kind, owner_role, done_check, closing_probe, priority, created_at, updated_at) VALUES ('STAGE2-MISMATCH',?,?,?,?,?,10,?,?)
      ON CONFLICT(id) DO UPDATE SET title=excluded.title, updated_at=excluded.updated_at, status=CASE WHEN items.status='done' THEN 'open' ELSE items.status END, disposition=CASE WHEN items.status='done' THEN NULL ELSE items.disposition END`,
      `Store and tracker disagree: ${what}`, 'fix', 'operations', 'items in the store match open issues', 'stage2Probe returns match', ts, ts);
  }
  return { result: cmp.match ? 'pass' : 'fail', ...cmp, adopted, checked_at: ts };
}
