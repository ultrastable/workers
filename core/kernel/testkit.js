// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Test helpers for the kernel tests: a database with seed + kernel migrations and a scratch table that probes read.
import { fileURLToPath } from 'node:url';
import { makeDb } from '../_shared/testdb.js';

export const KERNEL_DIR = fileURLToPath(new URL('./migrations/', import.meta.url));

export function kdb() {
  const db = makeDb([KERNEL_DIR]);
  db.raw.exec(`CREATE TABLE t_vals (k TEXT PRIMARY KEY, v REAL)`);
  return db;
}
export const setv = (db, k, v) => db.raw.prepare(`INSERT INTO t_vals (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`).run(k, v);
export const probe = (k) => `SELECT v AS value FROM t_vals WHERE k = '${k}'`;
export const HOUR = 3600e3;
export const item = (db, id, o = {}) => db.raw.prepare(
  `INSERT INTO items (id, title, owner_role, done_check, priority, status, project, closing_probe, disposition) VALUES (?,?,?,?,?,?,?,?,?)`)
  .run(id, o.title || id, o.owner_role || 'staff', 'x', o.priority ?? 50, o.status || 'open', o.project ?? null, o.closing_probe ?? 'probe', o.disposition ?? null);
export const one = (db, sql, ...a) => db.raw.prepare(sql).get(...a);
export const rows = (db, sql, ...a) => db.raw.prepare(sql).all(...a);
