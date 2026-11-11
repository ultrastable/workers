// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// The preview Worker that Door A deploys to a person's temporary account: the guided console over their own records.
// A temporary account allows no cron triggers, so the heartbeat is a Durable Object alarm (below). Bundled by build.mjs.
import { handleConsole } from '../../../core/src/console.js';
import { runTick } from '../../../core/src/tick.js';
import policy from '../../../autonomy/policy.json' with { type: 'json' };

// Rung 3 of docs/BOOTSTRAP-LADDER.md: a temporary account allows no cron triggers, so the Worker ticks itself with a
// SQLite-backed Durable Object alarm that re-arms itself. No outside credential is involved.
export const TICK_EVERY_MS = 5 * 60 * 1000;

export class Heartbeat {
  constructor(state, env) { this.state = state; this.env = env; }

  async arm(now = Date.now()) {
    if ((await this.state.storage.getAlarm()) == null) await this.state.storage.setAlarm(now + TICK_EVERY_MS);
  }

  async alarm() {
    const env = this.env;
    try {
      const config = { org_slug: env.ORG_SLUG || 'preview', claim_ttl_minutes: 120, max_wip_per_role: 3, plus_share: 0.2, policy };
      const r = await runTick(env.DB, { config, env });
      await this.state.storage.put('last_tick', { at: new Date().toISOString(), tick_id: r.tickId, steps: `${r.completed}/${r.total}`, errors: r.errors.length });
    } catch (e) {
      await this.state.storage.put('last_error', { at: new Date().toISOString(), message: String(e && e.message).slice(0, 200) });
    } finally {
      await this.state.storage.setAlarm(Date.now() + TICK_EVERY_MS); // always re-arm: PID 1 must never die
    }
  }

  async fetch() {
    await this.arm();
    return Response.json({ last_tick: (await this.state.storage.get('last_tick')) || null, last_error: (await this.state.storage.get('last_error')) || null });
  }
}

async function heartbeat(env) {
  if (!env.HEARTBEAT) return { last_tick: null };
  const stub = env.HEARTBEAT.get(env.HEARTBEAT.idFromName('heartbeat'));
  try { return await (await stub.fetch('https://heartbeat/')).json(); } catch { return { last_tick: null }; }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health') {
      const hb = await heartbeat(env);
      return Response.json({ ok: true, preview: true, org: env.ORG_SLUG || null, last_tick: hb.last_tick || null,
        note: 'Preview: the heartbeat ticks itself every 5 minutes with a Durable Object alarm; no scheduled trigger is used.' });
    }
    await heartbeat(env); // any visit also makes sure the alarm is armed
    const res = await handleConsole(request, env, { org: env.ORG_NAME || env.ORG_SLUG || 'your organization' });
    if (res) return res;
    return Response.redirect(new URL('/console', url).toString(), 302);
  },
};
