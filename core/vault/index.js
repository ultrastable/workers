// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// The vault: where a secret a person pastes into the console lives, so no one has to open a terminal to set a Worker
// secret. It is a door (self/doors.json), not the strongest store: anyone who can read the database can read it, exactly
// as anyone with account access can read Worker secrets. It therefore (1) never returns a value through any API,
// (2) lets modules read a value only through `withVault`/`read` at call time, (3) accepts only names on an allowlist,
// and (4) offers `redact` so a value cannot reach a log or a stored row. Migrate to the platform secret store when the
// adapter offers one (the port is the same).

const NAME = /^[A-Z][A-Z0-9_]{2,63}$/;
export const DEFAULT_ALLOWED = ['ANTHROPIC_API_KEY', 'VCS_TOKEN', 'CONSOLE_TOKEN', 'GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY', 'GITHUB_APP_WEBHOOK_SECRET', 'GITHUB_APP_INSTALLATION_ID', 'OPENAI_API_KEY', 'EMAIL_API_TOKEN', 'SOCIAL_API_TOKEN'];

export function createVault({ db, allowed = DEFAULT_ALLOWED } = {}) {
  const ok = n => NAME.test(String(n)) && allowed.includes(String(n));
  return {
    allowed: () => [...allowed],
    /** Store or replace a secret. Returns { name, stored: true } and never the value. */
    async put(name, value, { by = 'console' } = {}) {
      if (!ok(name)) return { error: 'name not allowed' };
      const v = String(value ?? '').trim();
      if (v.length < 8 || v.length > 8192) return { error: 'value length not accepted' };
      await db.prepare(`INSERT INTO vault_secrets (name, value, set_by, set_at) VALUES (?, ?, ?, datetime('now'))
        ON CONFLICT(name) DO UPDATE SET value=excluded.value, set_by=excluded.set_by, set_at=datetime('now')`).bind(String(name), v, String(by)).run();
      return { name: String(name), stored: true };
    },
    async has(name) { return Boolean(await db.prepare(`SELECT 1 AS x FROM vault_secrets WHERE name=?`).bind(String(name)).first()); },
    /** Names and when they were set. Never values. */
    async names() { return (await db.prepare(`SELECT name, set_by, set_at, last_used_at FROM vault_secrets ORDER BY name`).all()).results || []; },
    async remove(name) { await db.prepare(`DELETE FROM vault_secrets WHERE name=?`).bind(String(name)).run(); return { removed: true }; },
    /** Internal read for a module that must call a provider. Records last use. Do not log the result. */
    async read(name) {
      const r = await db.prepare(`SELECT value FROM vault_secrets WHERE name=?`).bind(String(name)).first();
      if (r) await db.prepare(`UPDATE vault_secrets SET last_used_at=datetime('now') WHERE name=?`).bind(String(name)).run();
      return r ? r.value : null;
    },
    /** env with vault values filled in for names the env lacks. Real env values win. The result must not be logged or stored. */
    async withVault(env = {}) {
      const out = { ...env };
      for (const row of (await db.prepare(`SELECT name, value FROM vault_secrets`).all()).results || []) if (!out[row.name]) out[row.name] = row.value;
      return out;
    },
    /** Replace every stored value in a string with [redacted]. */
    async redact(text) {
      let t = String(text);
      for (const row of (await db.prepare(`SELECT value FROM vault_secrets`).all()).results || []) if (row.value) t = t.split(row.value).join('[redacted]');
      return t;
    },
  };
}
