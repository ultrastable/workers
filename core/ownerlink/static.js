// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Owner actions that are a single settings or dispatch page, declared as data: config.ownerlink.static_actions =
// [{ id, title, why, link, probe?: { url, auth?: 'github', ok_status?: 200 } }]. The action is open until its probe passes; with no
// probe it stays open until the page is used and an owner marks it done through the card. A probe that cannot be read leaves the action as it was.
import { putAction, complete } from './actions.js';

const token = ctx => ['GITHUB_TOKEN', 'GH_TOKEN', 'VCS_TOKEN'].map(n => ctx.env?.[n]).find(Boolean);

async function probeOk(ctx, probe) {
  const headers = { 'user-agent': 'ultrastable-ownerlink' };
  if (probe.auth === 'github') { const t = token(ctx); if (!t) return null; headers.authorization = 'Bearer ' + t; }
  try { const r = await ctx.fetch(probe.url, { headers }); return r.status === (probe.ok_status || 200) ? true : (r.status >= 500 ? null : false); } catch { return null; }
}

export async function syncStatic(ctx) {
  const list = ctx.config?.ownerlink?.static_actions || []; let open = 0, done = 0, unknown = 0;
  for (const a of list) {
    if (!a.id || !a.title || !/^https:\/\//.test(a.link || '')) continue;
    const ok = a.probe ? await probeOk(ctx, a.probe) : false;
    if (ok === true) { const row = await ctx.db.prepare('SELECT status FROM ownerlink_actions WHERE id = ?').bind('s:' + a.id).first(); if (row?.status === 'open') { await complete(ctx, 's:' + a.id); done++; } continue; }
    if (ok === null) { unknown++; }
    await putAction(ctx, { id: 's:' + a.id, flow: 'static', title: a.title, why: a.why || '', link: a.link }); open++;
  }
  return { open, done, unknown };
}
