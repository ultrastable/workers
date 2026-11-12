// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Closing probe for setup: checks a deployed Ultrastable organization from the outside, with no credentials.
// Usage: node agent-setup/verify.mjs <base-url> [--wait <seconds>]
// Exit code 0 only if every check passes. Output is JSON so an agent can quote it.

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export async function verify(base, { waitSeconds = 0, fetchImpl = fetch } = {}) {
  const url = (p) => new URL(p, base).toString();
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail: String(detail).slice(0, 300) });
  const get = async (p, opts = {}) => { try { return await fetchImpl(url(p), { redirect: 'manual', ...opts }); } catch (e) { return { status: 0, error: e.message, headers: new Headers() }; } };

  // 1. the heartbeat: /health says a complete tick has run (give the first cron a chance to fire)
  const deadline = Date.now() + waitSeconds * 1000;
  let health, body = null;
  for (;;) {
    health = await get('/health');
    body = health.status ? await health.json().catch(() => null) : null;
    if ((health.status === 200 && body?.ok) || Date.now() >= deadline) break;
    await sleep(5000);
  }
  // A Cloudflare challenge page ("Just a moment") is not an answer from the Worker. Never read it as a refusal.
  const challenged = health.headers?.get?.('cf-mitigated') === 'challenge';
  if (challenged) {
    add('reachable by automated clients', false, 'Cloudflare served a bot challenge, not the Worker (a temporary account is challenged until it is claimed). Open the address in a browser, or claim the account, then run this again. Nothing else was checked.');
    return { base, ok: false, inconclusive: true, checks };
  }
  const isWorker = body && typeof body === 'object' && 'ok' in body;
  add('health answers with the Worker JSON', isWorker, `status ${health.status}${health.error ? ' ' + health.error : ''}`);
  if (!isWorker) return { base, ok: false, inconclusive: true, checks }; // refusals mean nothing if the address is not our Worker
  add('a complete tick has run', health.status === 200 && body?.ok === true, body ? JSON.stringify({ ok: body.ok, last_tick: body.last_tick && { id: body.last_tick.id, steps: `${body.last_tick.steps_completed}/${body.last_tick.steps_total}` } }) : 'no JSON from /health');

  // 2. the console is closed to strangers
  const page = await get('/console');
  add('console page refuses anonymous visitors', page.status === 401 || page.status === 503, `status ${page.status}`);
  const api = await get('/api/console');
  add('console data refuses anonymous visitors', api.status === 401 || api.status === 503, `status ${api.status}`);
  const apiBody = api.status ? await api.text().catch(() => '') : '';
  add('console refusal leaks no data', !/"needs_you"|"headline"/.test(apiBody), apiBody.slice(0, 80));
  const post = await get('/api/console/ask', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: '{"text":"x"}' });
  add('anonymous cross-origin write refused', [401, 403, 503].includes(post.status), `status ${post.status}`);

  // 3. the security headers that matter on the page people see
  if (page.status === 401) {
    add('page sends a content security policy', Boolean(page.headers.get('content-security-policy')), page.headers.get('content-security-policy') || 'missing');
    add('page is not cacheable', /no-store/.test(page.headers.get('cache-control') || ''), page.headers.get('cache-control') || 'missing');
  }

  // 4. the scheduler endpoint is not open (only meaningful where it exists)
  const tick = await get('/tick', { method: 'POST' });
  add('tick endpoint is not open to anonymous callers', [401, 403, 404, 405].includes(tick.status), `status ${tick.status}`);

  return { base, ok: checks.every(c => c.ok), checks };
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || process.argv[1]?.endsWith('verify.mjs')) {
  const args = process.argv.slice(2);
  const base = args.find(a => !a.startsWith('--'));
  const w = args.indexOf('--wait');
  if (!base) { console.error('usage: node agent-setup/verify.mjs <base-url> [--wait <seconds>]'); process.exit(2); }
  const result = await verify(base, { waitSeconds: w >= 0 ? Number(args[w + 1]) || 0 : 0 });
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.ok ? 0 : 1; // not process.exit(): it aborts with a libuv assertion on Windows while sockets close
}
