// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Issue-ledger steward: mirrors work items to every configured sink and flags items that break the item format.
// Ports: ctx = { db, now(), config, sinks }. sinks is an ORDERED LIST of { name, upsert(item, prevRef) -> { ref } }: each item goes to
// EVERY sink independently (no single route), a failing sink is recorded per item and retried next sweep, and never blocks the others.
const iso = ms => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const nowMs = ctx => { const v = ctx.now(); return v instanceof Date ? v.getTime() : v; };
async function sha(text) { const b = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))); return [...b].map(x => x.toString(16).padStart(2, '0')).join(''); }

/** Hygiene: an item must carry an owner role, a done check and a closing probe (docs item format). */
export const hygiene = item => ['owner_role', 'done_check', 'closing_probe'].filter(k => !String(item[k] ?? '').trim());

export async function mirror(ctx, { limit = 50 } = {}) {
  const ts = iso(nowMs(ctx)), out = { synced: 0, failed: 0, skipped: 0, flagged: [] };
  const items = (await ctx.db.prepare('SELECT * FROM items ORDER BY updated_at DESC LIMIT ?').bind(limit).all()).results;
  for (const it of items) {
    const missing = hygiene(it); if (missing.length) out.flagged.push({ id: it.id, missing });
    const hash = await sha(JSON.stringify([it.title, it.status, it.disposition, it.owner_role, it.closing_probe, it.done_check, it.priority]));
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

/** Sink 1: GitHub issues over REST. Token read from env at request time, never stored or logged. */
export function githubSink({ fetch, repo, env = {}, tokenEnv = 'VCS_TOKEN', apiBase = 'https://api.github.com' }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(String(repo || ''))) throw new Error('steward: repo must be "owner/name"');
  const call = async (method, path, body) => {
    const t = env[tokenEnv]; if (!t) throw new Error('steward: token variable ' + tokenEnv + ' is not set');
    const res = await fetch(apiBase + '/repos/' + repo + path, { method, headers: { accept: 'application/vnd.github+json', authorization: 'Bearer ' + t, 'content-type': 'application/json', 'user-agent': 'ultrastable-steward' }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error('steward: ' + method + ' ' + path + ' -> http ' + res.status);
    return res.json();
  };
  const text = it => '**' + it.id + '**\n\nOwner role: ' + it.owner_role + '\nDone check: ' + it.done_check + '\nClosing probe: ' + (it.closing_probe || '(missing)') + '\nDisposition: ' + (it.disposition || '-');
  return {
    name: 'github',
    async upsert(it, prev) {
      const state = ['done', 'superseded', 'cancelled'].includes(it.status) ? 'closed' : 'open';
      if (prev) { await call('PATCH', '/issues/' + prev, { title: it.title, body: text(it), state }); return { ref: prev }; }
      const r = await call('POST', '/issues', { title: it.title, body: text(it) });
      if (state === 'closed') await call('PATCH', '/issues/' + r.number, { state });
      return { ref: String(r.number) };
    },
  };
}
/** Sink 2: plain files (portable, no network): the port writes one JSON record per item. */
export const fileSink = ({ writeFile, dir = 'items' }) => ({ name: 'file', async upsert(it) { const p = dir + '/' + it.id + '.json'; await writeFile(p, JSON.stringify(it, null, 2)); return { ref: p }; } });

/** Merge host for core/codeloop over the same REST API. */
export function githubMergeHost({ fetch, repo, env = {}, tokenEnv = 'VCS_TOKEN', apiBase = 'https://api.github.com' }) {
  return { name: 'github', async merge({ pr, method = 'squash' }) {
    const t = env[tokenEnv]; if (!t) throw new Error('merge: token variable ' + tokenEnv + ' is not set');
    const res = await fetch(apiBase + '/repos/' + repo + '/pulls/' + pr + '/merge', { method: 'PUT', headers: { accept: 'application/vnd.github+json', authorization: 'Bearer ' + t, 'content-type': 'application/json', 'user-agent': 'ultrastable-codeloop' }, body: JSON.stringify({ merge_method: method }) });
    if (res.ok) return { merged: true };
    return { merged: false, reason: 'http ' + res.status };
  } };
}
