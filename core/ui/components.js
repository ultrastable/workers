// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// core/ui components. Each is a pure function from plain data to an HTML string, escaped and accessible by construction:
// landmarks and labels are required arguments, colour is never the only signal, targets are 44px, and nothing needs script.
// Tenant-agnostic: a product supplies words, links and data; it never edits these.
import { esc, safeHref } from './html.js';

export const skipLink = (target = 'main', text = 'Skip to main content') => `<a class="skip" href="#${esc(target)}">${esc(text)}</a>`;

export function siteHeader({ brand, nav = [], current = '', search = null }) {
  const cur = n => n.match ? n.match.test(current) : n.href === current;
  return `<header class="site-h"><div class="wrap"><a class="brand" href="${esc(safeHref(brand.href || '/'))}">${esc(brand.name)}${brand.tag ? `<small>${esc(brand.tag)}</small>` : ''}</a>
<nav aria-label="Main"><ul class="nav">${nav.map(n => `<li><a href="${esc(safeHref(n.href))}"${cur(n) ? ' aria-current="page"' : ''}>${esc(n.label)}</a></li>`).join('')}</ul></nav>
${search ? `<form class="srch" role="search" action="${esc(search.action)}" method="get"><label class="vh" for="q-h">${esc(search.label || 'Search')}</label><input id="q-h" type="search" name="${esc(search.name || 'q')}" placeholder="${esc(search.placeholder || 'Search')}" autocomplete="off"><button type="submit">${esc(search.button || 'Search')}</button></form>` : ''}</div></header>`;
}

export const breadcrumbs = items => `<nav class="crumbs" aria-label="Breadcrumb"><ol>${items.map((x, i) => i === items.length - 1 ? `<li><span aria-current="page">${esc(x.label)}</span></li>` : `<li><a href="${esc(safeHref(x.href))}">${esc(x.label)}</a></li>`).join('')}</ol></nav>`;

const GLYPH = { ok: '✓', warn: '!', info: 'i', neutral: '' };
export const badge = (text, tone = 'neutral') => `<span class="badge ${esc(tone)}">${GLYPH[tone] ? `<span aria-hidden="true">${GLYPH[tone]}</span>` : ''}${esc(text)}</span>`;

// card: a linked title, one summary line, optional facts and badges. `hue` tints the top rule (decorative; never carries meaning).
export const card = ({ title, href, body = '', meta = '', badges = [], hue, level = 3, foot = '' }) =>
  `<li class="card"${hue != null ? ` style="--h:${Number(hue) | 0}"` : ''}><h${level}><a href="${esc(safeHref(href))}">${esc(title)}</a></h${level}>${meta ? `<p class="m s">${esc(meta)}</p>` : ''}${body ? `<p>${esc(body)}</p>` : ''}${badges.length ? `<div class="badges">${badges.join('')}</div>` : ''}${foot}</li>`;
// Cards are written at h3 (inside an h2 section). Pass level 2 when the grid sits directly under the page's h1.
export const cardGrid = (cards, level = 3) => `<ul class="grid">${(level === 3 ? cards : cards.map(c => c.replace(/<h3>/, `<h${level}>`).replace(/<\/h3>/, `</h${level}>`))).join('')}</ul>`;

// rows: [[term, htmlValue]]. Values are trusted HTML built by other components; terms are escaped.
export const summaryList = rows => `<dl class="sl">${rows.filter(r => r && r[1] != null && r[1] !== '').map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>`;
export const callout = ({ tone = 'info', title, body }) => `<div class="callout ${esc(tone === 'info' ? '' : tone)}" role="note">${title ? `<h2>${esc(title)}</h2>` : ''}${body}</div>`;
export const keyMessages = (items, title = 'Key messages') => callout({ tone: 'info', title, body: `<ul>${items.map(i => `<li>${i}</li>`).join('')}</ul>` });
export const stats = items => `<ul class="stats">${items.map(i => `<li><b>${esc(i.value)}</b><span>${esc(i.label)}</span></li>`).join('')}</ul>`;
export const meter = (value, max, label) => `<span class="meter" role="img" aria-label="${esc(label || `${value} of ${max}`)}">${Array.from({ length: max }, (_, i) => `<i${i < value ? ' class="on"' : ''}></i>`).join('')}</span>`;
export const bar = (pct, label) => `<div class="bar" role="img" aria-label="${esc(label)}"><i style="width:${Math.max(0, Math.min(100, Math.round(pct)))}%"></i></div>`;
export const box = (title, body) => `<section class="box" aria-label="${esc(title)}"><h2>${esc(title)}</h2>${body}</section>`;
export const details = (summary, body) => `<details><summary>${esc(summary)}</summary><div>${body}</div></details>`;
export const cite = text => `<p class="cite">${esc(text)}</p>`;

// A table must name itself (caption) and mark its headers; rowHeader makes the first cell of each row a header cell.
export function table({ caption, head, rows, rowHeader = true }) {
  return `<div class="tablewrap" tabindex="0" role="region" aria-label="${esc(caption)}"><table><caption>${esc(caption)}</caption><thead><tr>${head.map(h => h === '' ? '<td></td>' : `<th scope="col">${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map((c, i) => i === 0 && rowHeader ? `<th scope="row">${c}</th>` : `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

export function toc(items) {
  return items.length < 3 ? '' : `<nav class="box toc" aria-label="On this page"><h2>On this page</h2><ol>${items.map(i => `<li><a href="#${esc(i.id)}">${esc(i.title)}</a></li>`).join('')}</ol></nav>`;
}

// Filters are a plain GET form so every filtered view has a shareable URL. groups: [{name,label,options:[{value,label}],value}]
export function facets({ action, groups, q = null, button = 'Apply filters', reset = null }) {
  return `<form class="facets" action="${esc(action)}" method="get" aria-label="Filter">${q ? `<div><label for="f-q">${esc(q.label)}</label><input id="f-q" type="search" name="q" value="${esc(q.value || '')}"></div>` : ''}${groups.map(g => `<div><label for="f-${esc(g.name)}">${esc(g.label)}</label><select id="f-${esc(g.name)}" name="${esc(g.name)}">${g.options.map(o => `<option value="${esc(o.value)}"${String(o.value) === String(g.value || '') ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}</select></div>`).join('')}<button type="submit">${esc(button)}</button>${reset ? `<a class="btn alt" href="${esc(reset)}">Clear</a>` : ''}</form>`;
}

export function pagination({ page, pages, href }) {
  if (pages <= 1) return '';
  const nums = [...new Set([1, page - 1, page, page + 1, pages])].filter(n => n >= 1 && n <= pages).sort((a, b) => a - b);
  return `<nav aria-label="Pages"><ul class="pager">${page > 1 ? `<li><a href="${esc(href(page - 1))}" rel="prev">Previous</a></li>` : ''}${nums.map(n => n === page ? `<li><span aria-current="page">${n}</span></li>` : `<li><a href="${esc(href(n))}" aria-label="Page ${n}">${n}</a></li>`).join('')}${page < pages ? `<li><a href="${esc(href(page + 1))}" rel="next">Next</a></li>` : ''}</ul></nav>`;
}

export const hero = ({ title, lede, search = null, actions = [] }) => `<section class="hero" aria-labelledby="hero-t"><h1 id="hero-t">${esc(title)}</h1><p class="lede">${esc(lede)}</p>${search ? `<form role="search" action="${esc(search.action)}" method="get"><label class="vh" for="q-hero">${esc(search.label)}</label><input id="q-hero" type="search" name="${esc(search.name || 'q')}" placeholder="${esc(search.placeholder || '')}" autocomplete="off"><button type="submit">${esc(search.button || 'Search')}</button></form>` : ''}${actions.length ? `<div class="acts">${actions.map(a => `<a class="btn${a.alt ? ' alt' : ''}" href="${esc(safeHref(a.href))}">${esc(a.label)}</a>`).join('')}</div>` : ''}</section>`;

export const section = ({ id, title, body, level = 2 }) => `<section id="${esc(id)}" aria-labelledby="${esc(id)}-h"><h${level} id="${esc(id)}-h">${esc(title)}</h${level}>${body}</section>`;
export const list = items => `<ul class="list">${items.map(i => `<li>${i}</li>`).join('')}</ul>`;

export function siteFooter({ columns = [], note = '' }) {
  return `<footer class="site-f"><div class="wrap"><div class="cols2">${columns.map(c => `<nav aria-label="${esc(c.title)}"><h2>${esc(c.title)}</h2><ul>${c.links.map(l => `<li><a href="${esc(safeHref(l.href))}">${esc(l.label)}</a></li>`).join('')}</ul></nav>`).join('')}</div>${note ? `<p>${esc(note)}</p>` : ''}</div></footer>`;
}

// Every part a product can place on a page. Stories and tests refer to these ids; adding a component means adding it here.
export const COMPONENTS = { skipLink, siteHeader, breadcrumbs, badge, card, cardGrid, summaryList, callout, keyMessages, stats, meter, bar, box, details, cite, table, toc, facets, pagination, hero, section, list, siteFooter };

