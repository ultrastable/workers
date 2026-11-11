// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Text helpers: URL detection, Bluesky link facets with UTF-8 byte offsets, URL-safe truncation, UTM tagging.
const URL_RE = /https?:\/\/[^\s<>()[\]"']+/g;
const TRAIL = /[.,;:!?…]+$/;
const enc = new TextEncoder();

// URLs as { url, start, end } in UTF-16 indices; trailing punctuation is not part of the URL.
export function findUrls(text) {
  const out = [];
  for (const m of String(text).matchAll(URL_RE)) {
    const url = m[0].replace(TRAIL, '');
    out.push({ url, start: m.index, end: m.index + url.length });
  }
  return out;
}

// AT Protocol facets index text by UTF-8 byte offsets, not by characters.
export function linkFacets(text) {
  return findUrls(text).map(({ url, start, end }) => ({
    index: { byteStart: enc.encode(text.slice(0, start)).length, byteEnd: enc.encode(text.slice(0, end)).length },
    features: [{ $type: 'app.bsky.richtext.facet#link', uri: url }],
  }));
}

export const hostAllowed = (host, allowlist) => allowlist.some(a => host === a || host.endsWith(`.${a}`));

// Adds utm_* parameters to links on the given hosts, never overwriting ones already present.
export function addUtm(text, { hosts = [], params = {} } = {}) {
  let out = String(text);
  for (const { url, start, end } of findUrls(text).reverse()) {
    let u; try { u = new URL(url); } catch { continue; }
    if (!hostAllowed(u.hostname, hosts)) continue;
    for (const [k, v] of Object.entries(params)) if (v && !u.searchParams.has(`utm_${k}`)) u.searchParams.set(`utm_${k}`, String(v));
    out = out.slice(0, start) + u.toString() + out.slice(end);
  }
  return out;
}

// Cuts to at most max UTF-16 units at a sentence or word boundary and adds an ellipsis. A URL is kept whole or dropped, never split.
export function truncate(text, max) {
  text = String(text);
  if (text.length <= max) return text;
  const urls = findUrls(text);
  let cut = max - 1;                                            // room for the ellipsis
  for (const u of urls) if (cut > u.start && cut < u.end) cut = u.start;
  if (cut > 0 && /[\uD800-\uDBFF]/.test(text[cut - 1])) cut -= 1; // never split a surrogate pair
  const head = text.slice(0, cut);
  const sentence = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '), head.lastIndexOf('\n'));
  const space = head.search(/\s\S*$/);
  const endsOnUrl = urls.some(u => u.end === cut);
  let keep = head;
  if (!endsOnUrl) keep = sentence >= cut * 0.5 ? head.slice(0, sentence + 1) : (space > 0 ? head.slice(0, space) : head);
  keep = keep.trimEnd();
  return keep ? `${keep}…` : '';
}
