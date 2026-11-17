<!-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0 -->
<!-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas -->

# core/statements: claims are code

A statement that is published (a methodology sentence, a feature claim, a number) is an entry in a registry, not prose. The entry has a rendered `text`
(a function of the live configuration, so a number is read from the code that uses it), a `verify` probe that runs the real behaviour and throws when
the statement is false, and optional `evidence` naming the code. `defineStatements` refuses an entry with no probe, a duplicate id, or a typed number.

A page is built from the registry with `statement(reg, id, ctx)` inside `region(...)`; live data (tables, counts) goes in `live(...)`. `proof(reg, html, ctx)`
runs every probe and `auditHtml` fails on prose that is not bound to a statement, an id the registry does not know, and a registry entry the page never shows.
A test that asserts `proof().ok` makes CI fail when a claim and the code disagree. `describe()` is the machine-readable list (serve it as `/claims.json`).
Tenant-agnostic. Code: `index.js`; tests: `statements.test.js`.
