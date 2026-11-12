// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// OWNER-AUTH-1 piece (c): the read-only dashboard that viewers and anonymous visitors see at /console once GitHub sign-in is on.
// The five measures of docs/SELF-HOSTING.md section 1 (remaining capabilities, agent pull requests, predictions, money, autonomy)
// and nothing else: aggregates only, no item titles, no names, no tokens. Static, escaped, script-free HTML.
// Off unless config.public_metrics.enabled === true, so a new installation exposes nothing until its owner turns the view on;
// a signed-in owner always gets the full console instead of this page.
import { computeMetrics } from './public-metrics.js';

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** The public view is opt-in: nothing is shown to a visitor unless the configuration says so. */
export const publicViewEnabled = config => config?.public_metrics?.enabled === true;

/** The five measures as display rows: { name, value, detail }. A measure that is not measured says why instead of showing a number. */
export function measureRows(m) {
  const nm = m.not_measured || {};
  const rc = m.remaining_capabilities, a = m.agent_prs || {}, p = m.predictions, mo = m.money || {}, au = m.autonomy;
  return [
    { name: 'Remaining capabilities', value: rc ? String(rc.remaining) : 'not measured', detail: rc ? 'the specifications describe more than is built; this number falls as pull requests merge' : nm.remaining_capabilities || '' },
    { name: 'Agent pull requests', value: `${a.merged ?? '?'} merged`, detail: `${a.opened ?? 0} opened, ${a.rejected ?? 0} refused by the reviewer, ${a.open ?? 0} in progress${a.merged == null ? '; merged is not measured yet' : ''}` },
    { name: 'Predictions right', value: p ? `${p.right} of ${p.made}` : 'not measured', detail: p ? `hit rate ${p.hit_rate}` : nm.predictions || '' },
    { name: 'Money', value: `$${mo.spend_usd ?? 0} this month`, detail: `cap ${mo.cap_usd ?? 'not set'}; cost per merged pull request ${mo.cost_per_merged_pr_usd == null ? 'not measured' : '$' + mo.cost_per_merged_pr_usd}` },
    { name: 'Autonomy', value: au ? `${au.surfaces} surfaces` : 'not measured', detail: au ? 'by rung ' + JSON.stringify(au.by_rung) : nm.autonomy || '' },
  ];
}

const CSS = ':root{--bg:#f7f7f5;--fg:#1c1c1a;--mut:#66665f;--card:#fff;--line:#e2e2dc}@media(prefers-color-scheme:dark){:root{--bg:#161614;--fg:#eeeee9;--mut:#9a9a92;--card:#1f1f1c;--line:#34342f}}'
  + '*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:17px/1.45 system-ui,sans-serif}main{max-width:34rem;margin:0 auto;padding:1rem}'
  + 'h1{font-size:1.25rem;margin:.4rem 0}.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:.9rem;margin:.6rem 0}.card h2{font-size:.85rem;margin:0;color:var(--mut);text-transform:uppercase;letter-spacing:.04em}'
  + '.card b{display:block;font-size:1.6rem}.mut{color:var(--mut);font-size:.9rem}a{color:inherit}';

/** The page. `viewer` is the signed-in login (a viewer session) or null (anonymous); it only changes the footer link. */
export function renderPublicView(m, { viewer = null, signInPath = '/console/github/signin' } = {}) {
  const cards = measureRows(m).map(r => `<div class=card><h2>${esc(r.name)}</h2><b>${esc(r.value)}</b><span class=mut>${esc(r.detail)}</span></div>`).join('');
  const foot = viewer ? `Signed in as ${esc(viewer)} (read-only).` : `<a href="${esc(signInPath)}">Sign in with GitHub</a>`;
  return '<!doctype html><html lang=en><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Ultrastable</title>'
    + `<style>${CSS}</style><main><h1>Ultrastable improving Ultrastable</h1>${cards}<p class=mut>Generated ${esc(m.generated_at)}. ${foot}</p></main>`;
}

/** The measures as JSON for the read-only view; same shape as /public/metrics.json. */
export const loadMeasures = ({ db, now, config }) => computeMetrics({ db, now, config, routerCaps: config?.router?.caps || [] });
