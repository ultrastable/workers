// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Shared helpers for the L2 kernel. Time is 'YYYY-MM-DD HH:MM:SS' UTC (US-00-R05).
export const TERMINAL_SQL = `('done','superseded','cancelled')`;

export const iso = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
export const parseIso = (s) => Date.parse(String(s).replace(' ', 'T') + 'Z');

export async function all(db, sql, ...args) { return (await db.prepare(sql).bind(...args).all()).results || []; }
export async function first(db, sql, ...args) { return (await db.prepare(sql).bind(...args).first()) || null; }
export async function run(db, sql, ...args) { return db.prepare(sql).bind(...args).run(); }

// A read probe or detector is one SELECT. It is data, so it is checked before it runs.
export function assertReadOnly(sql) {
  const s = String(sql || '').trim().replace(/;\s*$/, '');
  if (!/^select\b/i.test(s)) throw new Error('probe must be a single SELECT');
  if (s.includes(';')) throw new Error('probe must be a single statement');
  if (/\b(insert|update|delete|drop|alter|create|replace|pragma|attach|detach|vacuum)\b/i.test(s)) throw new Error('probe must be read-only');
  return s;
}

export const OPS = {
  '>=': (a, b) => a >= b, '<=': (a, b) => a <= b, '>': (a, b) => a > b, '<': (a, b) => a < b, '=': (a, b) => a === b,
};
export function compare(op, a, b) {
  const f = OPS[op];
  if (!f || a === null || a === undefined || Number.isNaN(Number(a))) return false;
  return f(Number(a), Number(b));
}
// Signed progress of a metric from `from` to `to` toward its target: positive = better, null = unmeasured.
export function improvement(op, target, from, to) {
  if (from === null || to === null || from === undefined || to === undefined) return null;
  if (op === '<=' || op === '<') return from - to;
  if (op === '>=' || op === '>') return to - from;
  return Math.abs(from - target) - Math.abs(to - target);
}

// Insert a work item once; returns true when it was created.
export async function ensureItem(db, it) {
  if (await first(db, `SELECT 1 AS x FROM items WHERE id = ?`, it.id)) return false;
  await run(db, `INSERT INTO items (id, title, kind, project, owner_role, done_check, closing_probe, priority, status, surface, action_class)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?)`,
    it.id, String(it.title).slice(0, 300), it.kind || 'fix', it.project ?? null, it.owner_role, it.done_check,
    it.closing_probe ?? null, it.priority ?? 10, it.surface ?? null, it.action_class ?? null);
  if (it.metric_id || it.doer || it.critical) {
    await run(db, `INSERT OR REPLACE INTO kernel_item_meta (item_id, metric_id, doer, critical) VALUES (?, ?, ?, ?)`,
      it.id, it.metric_id ?? null, it.doer ?? null, it.critical ? 1 : 0);
  }
  return true;
}
