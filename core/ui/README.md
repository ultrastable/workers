<!-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0 -->
<!-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas -->

# core/ui: a tenant-agnostic, script-free, WCAG 2.2 AA design system

Pure functions from plain data to escaped, accessible HTML: `tokens` (colour pairs with checked contrast, one small inline stylesheet, a `theme` hook), 23 `components` (header, breadcrumbs, cards, facets, pagination, tables, key messages, summary lists and more), `renderPage` (landmarks, skip link, canonical, Open Graph, JSON-LD, strict security headers) and `auditHtml` (structural accessibility and a performance budget, no browser needed).

A tenant supplies words, links and data and builds its own templates from these parts; it never edits them, and core never names a tenant. Colour is never the only signal, targets are 44px, nothing needs script, and every page prints.

Spec: none yet (filed as a spec gap). Owner role: operations. Trigger: a tenant renders pages. Closing probe: `ui.test.js` here, and the tenant's own crawl, story and axe runs against its live site. Status: BUILT. First tenant: Practical Solutions.
