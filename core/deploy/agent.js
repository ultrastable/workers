// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Ops agent: drives the canonical change path from work items. An open item whose done_check contains
// "deploy-unit: <unit>" (optionally "; version: <v>") is a deploy request. Ports: ctx = { db, now(), deploy, liveVersion(unit), sources, actor?, limit? } (the stale-version guard needs the live version).
// deploy is createDeploy(...). sources is an ORDERED LIST of artifact sources ({ name, fetch(unit, version) -> artifact|null }):
// no single route (a throwing or empty source falls to the next). Outcomes: kept -> item done; reverted/failed/refused -> the item
// stays open with the reason as its blocker (a loop breaker or kill switch shows as refused), never silently dropped.
const REQ = /deploy-unit:\s*([\w.-]+)(?:\s*;\s*version:\s*([\w.+-]+))?/i;
export const parseRequest = text => { const m = REQ.exec(String(text || '')); return m ? { unit: m[1], version: m[2] || null } : null; };

export async function step(ctx) {
  const rows = (await ctx.db.prepare("SELECT id, done_check FROM items WHERE status IN ('open','ready') AND done_check LIKE '%deploy-unit:%' ORDER BY priority, id LIMIT ?").bind(ctx.limit || 2).all()).results;
  const out = [];
  for (const it of rows) {
    const req = parseRequest(it.done_check);
    if (!req) continue;
    let artifact = null; const tried = [];
    for (const s of ctx.sources || []) {
      try { artifact = await s.fetch(req.unit, req.version); tried.push({ source: s.name, ok: !!artifact }); if (artifact) break; }
      catch (e) { tried.push({ source: s.name, ok: false, error: String(e?.message || e).slice(0, 120) }); }
    }
    if (!artifact) {
      await ctx.db.prepare("UPDATE items SET blocker=?, updated_at=datetime('now') WHERE id=?").bind('no artifact from any source: ' + JSON.stringify(tried), it.id).run();
      out.push({ item: it.id, status: 'no_artifact', tried }); continue;
    }
    const r = await ctx.deploy.deploy({ unit: req.unit, artifact, expectedVersion: await ctx.liveVersion(req.unit), actor: ctx.actor || 'ops-agent' });
    if (r.status === 'kept') await ctx.db.prepare("UPDATE items SET status='done', disposition=?, blocker=NULL, updated_at=datetime('now') WHERE id=?").bind('deployed ' + req.unit + ' to ' + (r.toVersion ?? 'new version') + ' (ledger ' + r.id + ')', it.id).run();
    else await ctx.db.prepare("UPDATE items SET blocker=?, updated_at=datetime('now') WHERE id=?").bind(r.status + ': ' + (r.reason || ''), it.id).run();
    out.push({ item: it.id, status: r.status, ledger: r.id });
  }
  return out;
}
