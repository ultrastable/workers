// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// PLACEHOLDER committed so the launcher can be tested. `node apps/launcher/build.mjs` overwrites it with the real
// preview bundle, its SHA-256 and the database migrations. Release builds publish the same bytes (US-19-R10, R16).
export const BUNDLE = 'export default { fetch() { return new Response("placeholder bundle: run apps/launcher/build.mjs"); } }';
export const BUNDLE_SHA256 = 'unreleased';
export const MIGRATIONS_SQL = '';
export const COMPATIBILITY_DATE = '2026-10-01';
