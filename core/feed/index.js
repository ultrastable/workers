// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// render a changelog as RSS 2.0 and JSON Feed 1.1. Tenant-agnostic: the tenant supplies items already described.
// item: { id, title, link, at (ISO), summary }
const esc = s => String(s ?? '').replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));

export function toRss({ title, link, description, items }) {
  const rows = items.map(i => `<item><title>${esc(i.title)}</title><link>${esc(i.link)}</link><guid isPermaLink="false">${esc(i.id)}</guid><pubDate>${new Date(i.at).toUTCString()}</pubDate><description>${esc(i.summary)}</description></item>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>${esc(title)}</title><link>${esc(link)}</link><description>${esc(description)}</description>${rows}</channel></rss>`;
}

export function toJsonFeed({ title, link, description, feedUrl, items }) {
  return { version: 'https://jsonfeed.org/version/1.1', title, home_page_url: link, feed_url: feedUrl, description,
    items: items.map(i => ({ id: i.id, url: i.link, title: i.title, content_text: i.summary, date_published: new Date(i.at).toISOString() })) };
}

// Turn raw change records into feed items. `describe(change)` is the tenant's: returns { title, link, summary } or null to skip.
export function itemsFrom(changes, describe) {
  return changes.map((c, n) => {
    const d = describe(c);
    return d ? { id: `${c.at}#${c.kind}:${c.id ?? c.problem ?? n}`, at: c.at, ...d } : null;
  }).filter(Boolean);
}
