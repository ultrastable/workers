// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// The launcher's own spend cap (US-SPEC-19-R09): at most N provisioning attempts per UTC day, counted by one Durable Object.
// What is stored: one integer per day (the count). No address, no token, no answers, nothing about a visitor.
// `takeCap(env, { now })` is the port the Worker calls; the class below is the Durable Object that backs it.
export const DEFAULT_DAILY_CAP = 25;
const dayKey = ms => new Date(ms).toISOString().slice(0, 10);

export class ProvisionCap {
  constructor(state) { this.state = state; }
  async fetch(request) {
    let max = DEFAULT_DAILY_CAP, now = Date.now();
    try { const b = await request.json(); if (Number.isInteger(b.max) && b.max >= 0) max = b.max; if (Number.isFinite(b.now)) now = b.now; } catch { /* defaults */ }
    const key = dayKey(now);
    const used = (await this.state.storage.get(key)) || 0;
    if (used >= max) return Response.json({ ok: false, used, max });
    await this.state.storage.put(key, used + 1);
    // Keep only today's counter: older days are deleted so the object never accumulates history.
    for (const k of (await this.state.storage.list()).keys()) if (k !== key) await this.state.storage.delete(k);
    return Response.json({ ok: true, used: used + 1, max });
  }
}

/** True when the attempt fits under the daily cap. Fails closed: a missing binding or an error counts as over the cap. */
export async function takeCap(env, { now = Date.now() } = {}) {
  const ns = env.PROVISION_CAP;
  if (!ns) return { ok: false, reason: 'no_cap_binding' };
  const max = env.DAILY_PROVISION_CAP === undefined ? DEFAULT_DAILY_CAP : Number(env.DAILY_PROVISION_CAP);
  if (!Number.isInteger(max) || max < 0) return { ok: false, reason: 'bad_cap_setting' };
  try {
    const stub = ns.get(ns.idFromName('global'));
    const r = await stub.fetch('https://cap.internal/take', { method: 'POST', body: JSON.stringify({ max, now }) });
    const j = await r.json();
    return j.ok === true ? { ok: true, reason: 'under_cap', used: j.used, max } : { ok: false, reason: 'over_cap', used: j.used, max };
  } catch { return { ok: false, reason: 'cap_unreachable' }; }
}
