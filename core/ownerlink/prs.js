// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Protected-path pull requests waiting on a human reviewer, one action each, linking straight to the review page (OWNERLINK-1).
import { putAction, complete } from './actions.js';

const token = ctx => ['GITHUB_TOKEN', 'GH_TOKEN', 'VCS_TOKEN'].map(n => ctx.env?.[n]).find(Boolean);
const api = async (ctx, path) => {
  const t = token(ctx); if (!t) return null;
  const r = await ctx.fetch('https://api.github.com' + path, { headers: { authorization: 'Bearer ' + t, accept: 'application/vnd.github+json', 'user-agent': 'ultrastable-ownerlink' } });
  return r.ok ? r.json() : null;
};

/** config.ownerlink.prs = { repos: ['org/repo'], labels?: [...], owner_login? }. Opens an action for each waiting PR, completes the rest. */
export async function syncPullRequests(ctx) {
  const c = ctx.config?.ownerlink?.prs; if (!c?.repos?.length) return { open: 0, done: 0, skipped: 'no repositories configured' };
  const labels = new Set((c.labels || ['protected-change', 'needs-human-review']).map(x => x.toLowerCase()));
  const seen = new Set(); let unreadable = 0;
  for (const repo of c.repos) {
    const list = await api(ctx, `/repos/${repo}/pulls?state=open&per_page=50`);
    if (!Array.isArray(list)) { unreadable++; continue; }
    for (const pr of list) {
      if (pr.draft) continue;
      const wants = (pr.labels || []).some(l => labels.has(String(l.name).toLowerCase())) || (c.owner_login && (pr.requested_reviewers || []).some(u => u.login === c.owner_login));
      if (!wants) continue;
      const reviews = await api(ctx, `/repos/${repo}/pulls/${pr.number}/reviews?per_page=100`);
      if (!Array.isArray(reviews)) { unreadable++; continue; }
      const last = new Map(); for (const v of reviews) if (v.user?.login && v.user.login !== pr.user?.login && /APPROVED|CHANGES_REQUESTED/.test(v.state)) last.set(v.user.login, v.state);
      if ([...last.values()].includes('APPROVED') && ![...last.values()].includes('CHANGES_REQUESTED')) continue;
      const id = `pr:${repo}#${pr.number}`; seen.add(id);
      await putAction(ctx, { id, flow: 'pr_review', title: `Approve ${repo} #${pr.number}: ${String(pr.title).slice(0, 120)}`, why: 'A protected path needs a human reviewer.', subject: repo, link: pr.html_url + '/files', detail: { number: pr.number } });
    }
  }
  // Only complete what was fully read: an unreadable list says nothing about the PRs on it.
  let done = 0;
  if (!unreadable) for (const a of (await ctx.db.prepare(`SELECT id FROM ownerlink_actions WHERE flow = 'pr_review' AND status = 'open'`).all()).results || []) if (!seen.has(a.id)) { await complete(ctx, a.id); done++; }
  return { open: seen.size, done, unreadable };
}
