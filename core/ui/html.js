// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// core/ui: escaping and attribute helpers shared by every component. Tenant-agnostic: no product names, hosts or data.
export const esc = s => String(s ?? '').replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]));
// attrs({class:'x', hidden:true, href:'/a'}) -> ' class="x" hidden href="/a"'. Falsy values are dropped; every value is escaped.
export const attrs = o => Object.entries(o || {}).filter(([, v]) => v !== false && v != null && v !== '').map(([k, v]) => v === true ? ` ${k}` : ` ${k}="${esc(v)}"`).join('');
// Only same-site paths and http(s) URLs may become a link target; anything else (javascript:, data:) becomes "#".
export const safeHref = u => /^(\/(?!\/)|https?:\/\/|#|mailto:)/i.test(String(u)) ? String(u) : '#';
// Machine-readable data embedded in a page: never executed, and "<" is escaped so it cannot close the tag.
export const jsonScript = o => `<script type="application/ld+json">${JSON.stringify(o).replace(/</g, '\\u003c')}</script>`;
export const slugify = s => String(s).toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
