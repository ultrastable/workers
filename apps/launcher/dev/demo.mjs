// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Local demo of the launcher against a FAKE Cloudflare: nothing leaves this machine and no account is created.
// Run: node apps/launcher/dev/demo.mjs   then open http://localhost:8788
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import launcher from '../src/index.js';

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (!u.startsWith('https://api.cloudflare.com')) return realFetch(url, init);
  const ok = (result) => new Response(JSON.stringify({ success: true, result }), { status: 200 });
  await new Promise(r => setTimeout(r, 300));
  if (u.includes('/challenge')) return ok({ challengeToken: 'demo-challenge', seed: randomBytes(32).toString('base64url'), k: 600, g: 2000 });
  if (u.endsWith('/provisioning/previews')) return ok({ account: { id: 'demo-acct', apiToken: 'demo-token', expiresAt: new Date(Date.now() + 3600e3).toISOString() }, claim: { token: 'demo', url: 'https://dash.cloudflare.com/claim-preview?claimToken=DEMO-NOT-REAL', expiresAt: new Date(Date.now() + 3600e3).toISOString() } });
  if (u.endsWith('/d1/database')) return ok({ uuid: 'demo-db' });
  if (u.endsWith('/workers/subdomain')) return ok({ subdomain: 'demo-account' });
  return ok({});
};

const port = Number(process.env.PORT || 8788);
http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const r = new Request(`http://localhost:${port}${req.url}`, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) });
  const out = await launcher.fetch(r, {});
  res.writeHead(out.status, Object.fromEntries(out.headers)); res.end(Buffer.from(await out.arrayBuffer()));
}).listen(port, () => console.log(`launcher demo (fake Cloudflare): http://localhost:${port}`));
