// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// core/ui page shell: the one place that writes <html>, so every page gets the same landmarks, metadata and security headers.
import { esc, jsonScript } from './html.js';
import { css } from './tokens.js';
import { skipLink, siteHeader, siteFooter } from './components.js';

export const SECURITY_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff', 'referrer-policy': 'strict-origin-when-cross-origin', 'permissions-policy': 'camera=(), microphone=(), geolocation=()',
};

// shell: { brand, nav, search, footer, theme, lang, feeds:[{type,href,title}] }; page: { title, description, path, body, current, jsonld, noindex, type, wide }
export function renderPage(shell, page, origin) {
  const url = origin + page.path, ttl = page.title;
  return `<!doctype html><html lang="${esc(shell.lang || 'en')}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(ttl)}</title>
<meta name="description" content="${esc(page.description)}"><link rel="canonical" href="${esc(url)}"><meta name="color-scheme" content="light dark"><link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%230a4f9e'/%3E%3Cpath d='M8 17l6 6 10-13' stroke='white' stroke-width='4' fill='none'/%3E%3C/svg%3E">${page.noindex ? '<meta name="robots" content="noindex">' : ''}
<meta property="og:title" content="${esc(ttl)}"><meta property="og:description" content="${esc(page.description)}"><meta property="og:type" content="${esc(page.type || 'website')}"><meta property="og:url" content="${esc(url)}"><meta property="og:site_name" content="${esc(shell.brand.name)}"><meta name="twitter:card" content="summary">
${(shell.feeds || []).map(f => `<link rel="alternate" type="${esc(f.type)}" href="${esc(f.href)}" title="${esc(f.title)}">`).join('')}${page.alternate ? `<link rel="alternate" type="application/json" href="${esc(page.alternate)}">` : ''}
<style>${css(shell.theme)}</style>${page.jsonld ? jsonScript(page.jsonld) : ''}</head><body>${skipLink('main')}${siteHeader({ brand: shell.brand, nav: shell.nav, search: page.hideSearch ? null : shell.search, current: page.current || page.path })}
<main id="main" tabindex="-1"><div class="wrap">${page.body}</div></main>${siteFooter(shell.footer)}</body></html>`;
}
