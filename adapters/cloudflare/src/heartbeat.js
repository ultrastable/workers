// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Rung 3 of docs/BOOTSTRAP-LADDER.md for the real Worker: a SQLite-backed Durable Object whose alarm runs one tick of the
// organization and re-arms itself, so the system needs neither a cron trigger nor any outside credential. Used when the
// account refuses cron triggers (a temporary account, error 10072) or TICK_MODE is "alarm". Plain class (no
// 'cloudflare:workers' import) so it runs in node tests; Cloudflare accepts any exported class as a Durable Object.
export const TICK_EVERY_MS = 10 * 60 * 1000;

/** @param {(env: object) => Promise<unknown>} tick runs one tick of the org for this env */
export function createHeartbeat(tick, everyMs = TICK_EVERY_MS) {
  return class Heartbeat {
    constructor(state, env) { this.state = state; this.env = env; }

    async arm(now = Date.now()) {
      if ((await this.state.storage.getAlarm()) == null) await this.state.storage.setAlarm(now + everyMs);
    }

    async alarm() {
      try {
        await tick(this.env);
        await this.state.storage.put('last_tick', { at: new Date().toISOString() });
      } catch (e) {
        await this.state.storage.put('last_error', { at: new Date().toISOString(), message: String(e && e.message).slice(0, 200) });
      } finally {
        await this.state.storage.setAlarm(Date.now() + everyMs); // always re-arm: PID 1 must never die
      }
    }

    async fetch() {
      await this.arm();
      return Response.json({
        last_tick: (await this.state.storage.get('last_tick')) || null,
        last_error: (await this.state.storage.get('last_error')) || null,
      });
    }
  };
}

/** Make sure the alarm is armed. Does nothing unless TICK_MODE is "alarm" and the binding exists; never throws. */
export async function ensureArmed(env) {
  if (!env || env.TICK_MODE !== 'alarm' || !env.HEARTBEAT) return false;
  try {
    await env.HEARTBEAT.get(env.HEARTBEAT.idFromName('heartbeat')).fetch('https://heartbeat/');
    return true;
  } catch { return false; }
}
