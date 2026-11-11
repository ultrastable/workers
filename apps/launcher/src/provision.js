// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Door A (US-SPEC-19): put a live preview of a person's organization online on a Cloudflare temporary account.
// Every outside call goes through the injected `fetch`. Nothing is logged. The temporary account token and the claim
// link are held in memory only; the claim link is returned to the caller and never written anywhere (US-19-R07).
import { buildSeedSql, cleanIdea, slugify } from './seed.js';

const API = 'https://api.cloudflare.com/client/v4';
const TOS = 'https://www.cloudflare.com/terms/';
const PRIVACY = 'https://www.cloudflare.com/privacypolicy/';

export class ProvisionError extends Error {
  constructor(step, message, status) { super(message); this.name = 'ProvisionError'; this.step = step; this.status = status; }
}

const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export function newConsoleKey(getRandomValues = (a) => crypto.getRandomValues(a)) { return b64url(getRandomValues(new Uint8Array(24))); }

async function call(fetchImpl, step, url, init, redact = []) {
  let res;
  try { res = await fetchImpl(url, init); } catch (e) { throw new ProvisionError(step, `Could not reach Cloudflare (${step}).`, 0); }
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON reply */ }
  if (!res.ok || (body && body.success === false)) {
    let msg = (body && body.errors && body.errors[0] && body.errors[0].message) || `HTTP ${res.status}`;
    for (const r of redact) if (r) msg = String(msg).split(r).join('[removed]');
    throw new ProvisionError(step, `Cloudflare refused the step "${step}": ${String(msg).slice(0, 200)}`, res.status);
  }
  return body;
}

export async function fetchChallenge(fetchImpl = fetch) {
  const b = await call(fetchImpl, 'challenge', `${API}/provisioning/previews/challenge`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const r = b.result || {};
  return { challengeToken: r.challengeToken, seed: r.seed, k: r.k, g: r.g };
}

/**
 * @param {object} p
 * @param {Function} p.fetch
 * @param {{challengeToken:string, solution:{checkpoints:string}}} p.proof  solved in the person's browser
 * @param {{idea:string, outcomes:string[], limit:number, orgName?:string}} p.answers
 * @param {boolean} p.acceptedCloudflareTerms  the person ticked the box (US-19-R06)
 * @param {{bundle:string, bundleSha256:string, migrationsSql:string, compatibilityDate:string}} p.release
 */
export async function provision({ fetch: f = fetch, proof, answers, acceptedCloudflareTerms, release, getRandomValues }) {
  if (acceptedCloudflareTerms !== true) throw new ProvisionError('terms', 'Cloudflare\'s terms must be accepted by you before anything is created.', 400);
  if (!proof || !proof.challengeToken || !proof.solution || !proof.solution.checkpoints) throw new ProvisionError('proof', 'The safety check was not completed.', 400);
  const a = cleanIdea(answers);
  const orgName = String(answers.orgName || '').trim().slice(0, 60) || a.outcomes[0].slice(0, 40);
  const slug = slugify(orgName);
  const consoleKey = newConsoleKey(getRandomValues);
  const json = { 'content-type': 'application/json' };

  // 1. the temporary account (the person accepted the terms; we pass their acceptance on, we never assume it)
  const acct = await call(f, 'account', `${API}/provisioning/previews`, {
    method: 'POST', headers: json,
    body: JSON.stringify({ termsOfService: TOS, privacyPolicy: PRIVACY, acceptTermsOfService: 'yes', challengeToken: proof.challengeToken, solution: proof.solution }),
  });
  const { account, claim } = acct.result || {};
  if (!account || !account.id || !account.apiToken) throw new ProvisionError('account', 'Cloudflare did not return a preview account.', 502);
  const auth = { authorization: `Bearer ${account.apiToken}` };
  const redact = [account.apiToken, claim && claim.token];
  const A = `${API}/accounts/${account.id}`;

  // 2. the database
  const db = await call(f, 'database', `${A}/d1/database`, { method: 'POST', headers: { ...auth, ...json }, body: JSON.stringify({ name: `${slug}-db` }) }, redact);
  const dbId = db.result && (db.result.uuid || db.result.id);
  if (!dbId) throw new ProvisionError('database', 'Cloudflare did not return a database id.', 502);

  // 3. schema and the person's own starting records
  const sql = release.migrationsSql + '\n' + buildSeedSql(a, { orgName, slug });
  await call(f, 'records', `${A}/d1/database/${dbId}/query`, { method: 'POST', headers: { ...auth, ...json }, body: JSON.stringify({ sql }) }, redact);

  // 4. the Worker, with its bindings (the console key is a secret binding, never a plain value)
  const metadata = {
    main_module: 'worker.mjs', compatibility_date: release.compatibilityDate,
    bindings: [
      { type: 'd1', name: 'DB', id: dbId },
      { type: 'plain_text', name: 'ORG_NAME', text: orgName },
      { type: 'plain_text', name: 'ORG_SLUG', text: slug },
      { type: 'secret_text', name: 'CONSOLE_TOKEN', text: consoleKey },
      { type: 'durable_object_namespace', name: 'HEARTBEAT', class_name: 'Heartbeat' },
    ],
    // a temporary account has no cron; the SQLite-backed Durable Object alarm is the heartbeat (BOOTSTRAP-LADDER rung 3)
    migrations: { new_tag: 'v1', new_sqlite_classes: ['Heartbeat'] },
  };
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }), 'metadata.json');
  form.append('worker.mjs', new Blob([release.bundle], { type: 'application/javascript+module' }), 'worker.mjs');
  await call(f, 'worker', `${A}/workers/scripts/${slug}`, { method: 'PUT', headers: auth, body: form }, redact);

  // 5. its public address
  await call(f, 'address', `${A}/workers/scripts/${slug}/subdomain`, { method: 'POST', headers: { ...auth, ...json }, body: JSON.stringify({ enabled: true }) }, redact);
  const sub = await call(f, 'address', `${A}/workers/subdomain`, { method: 'GET', headers: auth }, redact);
  const subdomain = sub.result && sub.result.subdomain;
  if (!subdomain) throw new ProvisionError('address', 'Cloudflare did not return an address for the preview.', 502);

  return {
    url: `https://${slug}.${subdomain}.workers.dev`, orgName, slug, consoleKey,
    claimUrl: claim && claim.url, claimExpiresAt: claim && claim.expiresAt, accountExpiresAt: account.expiresAt,
    bundleSha256: release.bundleSha256, mode: 'preview',
    notes: ['This is a preview: it runs for about an hour, ticks itself every 5 minutes with its own alarm, and Cloudflare shows a safety page to automated visitors until you claim it.'],
  };
}
