// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// The preview Worker that Door A deploys to a person's temporary account: the guided console over their own records.
// No scheduled work (a temporary account allows no cron triggers); /health says so honestly. Bundled by build.mjs.
import { handleConsole } from '../../../core/src/console.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return Response.json({ ok: true, preview: true, org: env.ORG_SLUG || null, last_tick: null,
        note: 'Preview: scheduled work starts after the account is claimed and the heartbeat is set up.' });
    }
    const res = await handleConsole(request, env, { org: env.ORG_NAME || env.ORG_SLUG || 'your organization' });
    if (res) return res;
    return Response.redirect(new URL('/console', url).toString(), 302);
  },
};
