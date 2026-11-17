// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// core/ui static audit: structural WCAG 2.2 checks and a performance budget on a rendered page, with no browser. It cannot judge
// colour or focus rendering (tokens.contrastReport and the live axe run do); it catches what a template can get wrong.
const tags = (h, re) => [...h.matchAll(re)];
export const BUDGET = { htmlBytes: 70000, externalRequests: 0, scripts: 0 };

export function auditHtml(html, { budget = BUDGET, expectH1 = true } = {}) {
  const v = [], add = (rule, detail) => v.push({ rule, detail });
  if (!/<html[^>]*\slang="[a-z]{2}/i.test(html)) add('lang', 'html needs a lang attribute');
  const title = (/<title>([^<]*)<\/title>/i.exec(html) || [])[1];
  if (!title || !title.trim()) add('title', 'missing or empty <title>');
  if (!/<meta name="viewport"/i.test(html)) add('viewport', 'missing viewport meta');
  if (!/<meta name="description" content="[^"]+/i.test(html)) add('description', 'missing meta description');
  if (!/<link rel="canonical"/i.test(html)) add('canonical', 'missing canonical link');
  const hs = tags(html, /<h([1-6])[\s>]/g).map(m => +m[1]);
  if (expectH1 && hs.filter(n => n === 1).length !== 1) add('h1', `expected exactly one h1, found ${hs.filter(n => n === 1).length}`);
  for (let i = 1; i < hs.length; i++) if (hs[i] > hs[i - 1] + 1) add('heading-order', `h${hs[i - 1]} is followed by h${hs[i]}`);
  if (tags(html, /<main[\s>]/g).length !== 1) add('main', 'expected exactly one <main>');
  if (!/<a class="skip" href="#main"/.test(html)) add('skip-link', 'first focusable element must be a skip link to #main');
  const navs = tags(html, /<nav([^>]*)>/g); for (const n of navs) if (!/aria-label=/.test(n[1])) add('nav-label', 'every <nav> needs an aria-label');
  for (const m of tags(html, /<a\s[^>]*>([\s\S]*?)<\/a>/g)) if (!m[1].replace(/<[^>]*>/g, '').trim() && !/aria-label=/.test(m[0])) add('link-name', 'link with no accessible name: ' + m[0].slice(0, 80));
  for (const m of tags(html, /<img\s[^>]*>/g)) if (!/\salt=/.test(m[0])) add('img-alt', 'image without alt');
  const ids = tags(html, /\sid="([^"]+)"/g).map(m => m[1]); const dup = ids.filter((x, i) => ids.indexOf(x) !== i); if (dup.length) add('duplicate-id', [...new Set(dup)].join(', '));
  for (const m of tags(html, /href="#([^"]+)"/g)) if (!ids.includes(m[1])) add('anchor', `#${m[1]} has no target`);
  for (const m of tags(html, /aria-labelledby="([^"]+)"/g)) if (!ids.includes(m[1])) add('aria-ref', `${m[1]} has no target`);
  for (const m of tags(html, /<(input|select|textarea)\s([^>]*)>/g)) {
    const wrapped = html.lastIndexOf('<label', m.index) > html.lastIndexOf('</label>', m.index);
    if (wrapped) continue;
    if (/type="(hidden|submit|checkbox)"/.test(m[2]) && !/type="checkbox"/.test(m[2])) continue;
    const id = (/\sid="([^"]+)"/.exec(' ' + m[2]) || [])[1];
    if (!(id && new RegExp(`<label[^>]*for="${id}"`).test(html)) && !/aria-label=/.test(m[2])) add('form-label', `${m[1]} without a label: ${m[2].slice(0, 60)}`);
  }
  for (const t of tags(html, /<table[\s>][\s\S]*?<\/table>/g)) { if (!/<caption>/.test(t[0])) add('table-caption', 'table without caption'); if (!/<th[\s>]/.test(t[0])) add('table-header', 'table without header cells'); }
  if (/\son[a-z]+="/i.test(html)) add('inline-handler', 'inline event handler');
  if (/tabindex="[1-9]/.test(html)) add('tabindex', 'positive tabindex');
  const scripts = tags(html, /<script[^>]*>/g).filter(m => !/type="application\/ld\+json"/.test(m[0])); if (scripts.length > budget.scripts) add('scripts', 'executable script on page');
  const ext = tags(html, /<(?:link|script|img|iframe|source)\s[^>]*(?:src|href)="(https?:\/\/[^"]+)"/g).filter(m => !/rel="(canonical|alternate)"/.test(m[0]));
  if (ext.length > budget.externalRequests) add('external-request', ext.map(m => m[1]).join(', '));
  const bytes = new TextEncoder().encode(html).length; if (bytes > budget.htmlBytes) add('size', `${bytes} bytes exceeds ${budget.htmlBytes}`);
  return v;
}
