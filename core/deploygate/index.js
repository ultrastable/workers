// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Deploy gateway: lets a CI run deploy a Worker with no stored secret. The run presents its OIDC identity token (audience = the
// gateway origin); the gateway verifies the signature against the issuer's keys and deploys only what a configured rule allows.
// createGate({ fetch, now, config: { rules, token, accountId, issuer? } }) -> { handle(req) }.
// rules: [{ repo, refs: [..], script, compat?, compat_flags? }]. token is the account-scoped deploy credential, held only by the gateway's host.
const ISSUER = 'https://token.actions.githubusercontent.com';
const b64u = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
const KEEP = ['kv_namespace', 'plain_text', 'secret_text', 'service', 'd1', 'durable_object_namespace', 'send_email'];

export async function verifyToken(jwt, { audience, fetch, now, issuer = ISSUER }) {
  const [h, p, s] = String(jwt).split('.');
  if (!s) throw new Error('malformed token');
  const dec = x => JSON.parse(new TextDecoder().decode(b64u(x)));
  const head = dec(h), claims = dec(p);
  if (head.alg !== 'RS256') throw new Error('bad alg');
  const jwks = await (await fetch(issuer + '/.well-known/jwks')).json();
  const jwk = jwks.keys.find(k => k.kid === head.kid);
  if (!jwk) throw new Error('unknown key');
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  if (!(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64u(s), new TextEncoder().encode(h + '.' + p)))) throw new Error('bad signature');
  const t = now() / 1000;
  if (claims.iss !== issuer || claims.aud !== audience || !(claims.exp > t) || claims.nbf > t + 60) throw new Error('bad claims');
  return claims;
}

const hex = async t => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t)))].map(b => b.toString(16).padStart(2, '0')).join('');
// The stored script comes back as multipart: take the first part's body.
export function modulePart(body) { const i = body.indexOf('\r\n\r\n'), j = body.lastIndexOf('\r\n--'); return i < 0 ? body : body.slice(i + 4, j > i ? j : undefined); }

export function createGate({ fetch = globalThis.fetch, now = Date.now, config }) {
  const issuer = config.issuer || ISSUER;
  async function handle(req) {
    const url = new URL(req.url);
    if (url.pathname === '/health') return json({ ok: true });
    if (req.method !== 'POST' || url.pathname !== '/deploy') return json({ error: 'not found' }, 404);
    const m = /^Bearer (.+)$/.exec(req.headers.get('authorization') || '');
    if (!m) return json({ error: 'missing token' }, 401);
    let claims;
    try { claims = await verifyToken(m[1], { audience: url.origin, fetch, now, issuer }); } catch (e) { return json({ error: String(e.message) }, 401); }
    const form = await req.formData();
    const script = String(form.get('script') || '');
    const rule = (config.rules || []).find(r => r.repo === claims.repository && r.script === script && (r.refs || []).includes(claims.ref));
    if (!rule) return json({ error: 'not allowed', repository: claims.repository, ref: claims.ref, script }, 403);
    const text = await form.get('worker.js').text();
    const meta = { main_module: 'worker.js', compatibility_date: rule.compat || '2026-10-01', compatibility_flags: rule.compat_flags || [], keep_bindings: KEEP };
    const out = new FormData();
    out.append('metadata', new Blob([JSON.stringify(meta)], { type: 'application/json' }));
    out.append('worker.js', new Blob([text], { type: 'application/javascript+module' }), 'worker.js');
    const base = `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/workers/scripts/${script}`;
    const auth = { authorization: `Bearer ${config.token}` };
    const put = await fetch(base, { method: 'PUT', headers: auth, body: out });
    const j = await put.json();
    if (!put.ok || !j.success) return json({ error: 'deploy failed', status: put.status, errors: j.errors }, 502);
    const sha256 = await hex(text);
    // Read-back (DEPLOYGATE-READBACK-1): compare the stored module by hash. A read the token cannot make is reported, not called a mismatch:
    // the upload already succeeded, and the caller's own live check is the independent verification.
    const rb = await fetch(base + '/content/v2', { headers: auth });
    if (!rb.ok) return json({ deployed: true, verified: false, readback_status: rb.status, script, sha256, sha: claims.sha, run: claims.run_id });
    const back = await rb.text();
    if (!back.includes(text) && await hex(modulePart(back)) !== sha256) return json({ error: 'read-back mismatch', sha256 }, 502);
    return json({ deployed: true, verified: true, script, sha256, sha: claims.sha, run: claims.run_id });
  }
  return { handle };
}
