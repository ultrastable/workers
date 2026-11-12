// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Ultrastable Worker: the server-side runtime for one org. Cron (or, when the account refuses cron, the Heartbeat
// Durable Object alarm) runs one tick of every loop (core/org); fetch serves /health, /console, /describe,
// /describe.json and /llms.txt.
import config from './config.js';
import { createOrg } from '../../../core/org/index.js';
import { createHeartbeat, ensureArmed } from './heartbeat.js';

const orgFor = env => createOrg({ db: env.DB, env, config });

export const Heartbeat = createHeartbeat(env => orgFor(env).tick());

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(orgFor(env).tick());
  },

  async fetch(request, env) {
    await ensureArmed(env); // alarm mode: any visit makes sure the heartbeat is armed
    return (await orgFor(env).handle(request))
      ?? new Response('ultrastable worker\n', { headers: { 'content-type': 'text/plain' } });
  },
};
