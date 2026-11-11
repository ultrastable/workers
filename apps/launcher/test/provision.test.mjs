// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { provision, fetchChallenge, ProvisionError, newConsoleKey } from '../src/provision.js';
import { buildSeedSql, cleanIdea, slugify } from '../src/seed.js';
import { makeDb } from '../../../core/_shared/testdb.js';
import { buildConsole } from '../../../core/src/console.js';

const MIG_DIR = fileURLToPath(new URL('../../../core/migrations/', import.meta.url));
const MIGRATIONS = readdirSync(MIG_DIR).filter(n => n.endsWith('.sql')).sort().map(n => readFileSync(MIG_DIR + n, 'utf8')).join('\n');
const SECRET_TOKEN = 'tmp-account-api-token-SECRET';
const CLAIM_TOKEN = 'claim-token-SECRET';

/** A fake Cloudflare: records every call, can fail a chosen step. */
function fakeCloudflare({ failAt } = {}) {
  const calls = [];
  const f = async (url, init = {}) => {
    const u = String(url), method = init.method || 'GET';
    calls.push({ url: u, method, auth: init.headers?.authorization, body: init.body });
    const ok = (result) => new Response(JSON.stringify({ success: true, result }), { status: 200 });
    const fail = (msg) => new Response(JSON.stringify({ success: false, errors: [{ message: msg }] }), { status: 403 });
    const step = u.includes('/challenge') ? 'challenge' : u.endsWith('/provisioning/previews') ? 'account' : u.endsWith('/d1/database') ? 'database'
      : u.includes('/query') ? 'records' : u.endsWith('/subdomain') && method === 'POST' ? 'address' : u.endsWith('/workers/subdomain') ? 'address2' : u.includes('/workers/scripts/') ? 'worker' : 'other';
    if (failAt === step) return fail(`denied for token ${SECRET_TOKEN} and ${CLAIM_TOKEN}`);
    if (step === 'challenge') return ok({ challengeToken: 'ct', seed: 'AAAA', k: 10, g: 10 });
    if (step === 'account') return ok({ account: { id: 'acc1', apiToken: SECRET_TOKEN, expiresAt: 'soon' }, claim: { token: CLAIM_TOKEN, url: `https://dash.example/claim?claimToken=${CLAIM_TOKEN}`, expiresAt: 'soon' } });
    if (step === 'database') return ok({ uuid: 'db-uuid-1' });
    if (step === 'records' || step === 'worker' || step === 'address') return ok({});
    if (step === 'address2') return ok({ subdomain: 'pretty-name' });
    return ok({});
  };
  return { f, calls };
}

const RELEASE = { bundle: 'export default { fetch() { return new Response("ok"); } }', bundleSha256: 'abc123', migrationsSql: MIGRATIONS, compatibilityDate: '2026-10-01' };
const PROOF = { challengeToken: 'ct', solution: { checkpoints: 'AAAA' } };
const ANSWERS = { idea: 'A neighbourhood tool library where people borrow tools instead of buying them', outcomes: ['A page where neighbours can book a drill', 'A list of the tools we have'], limit: 0, orgName: "Neighbours' Tool Library" };

test('refuses to create anything unless the person accepted the terms, and needs the safety check', async () => {
  const { f, calls } = fakeCloudflare();
  await assert.rejects(() => provision({ fetch: f, proof: PROOF, answers: ANSWERS, acceptedCloudflareTerms: false, release: RELEASE }), /terms/i);
  await assert.rejects(() => provision({ fetch: f, proof: null, answers: ANSWERS, acceptedCloudflareTerms: true, release: RELEASE }), /safety check/);
  assert.equal(calls.length, 0, 'no call was made');
});

test('the happy path calls Cloudflare in order, binds the console key as a secret, and returns the address and claim link', async () => {
  const { f, calls } = fakeCloudflare();
  const r = await provision({ fetch: f, proof: PROOF, answers: ANSWERS, acceptedCloudflareTerms: true, release: RELEASE });
  assert.deepEqual(calls.map(c => `${c.method} ${c.url.replace('https://api.cloudflare.com/client/v4', '').replace(/acc1|db-uuid-1|neighbours-tool-library/g, '_')}`), [
    'POST /provisioning/previews', 'POST /accounts/_/d1/database', 'POST /accounts/_/d1/database/_/query',
    'PUT /accounts/_/workers/scripts/_', 'POST /accounts/_/workers/scripts/_/subdomain', 'GET /accounts/_/workers/subdomain',
  ]);
  const acct = JSON.parse(calls[0].body);
  assert.equal(acct.acceptTermsOfService, 'yes'); assert.equal(acct.challengeToken, 'ct');
  assert.equal(calls[0].auth, undefined, 'account creation is unauthenticated');
  assert.ok(calls.slice(1).every(c => c.auth === `Bearer ${SECRET_TOKEN}`));
  const meta = JSON.parse(await calls[3].body.get('metadata').text());
  assert.equal(meta.bindings.find(b => b.name === 'CONSOLE_TOKEN').type, 'secret_text');
  assert.equal(meta.bindings.find(b => b.name === 'CONSOLE_TOKEN').text, r.consoleKey);
  assert.equal(meta.bindings.find(b => b.name === 'DB').id, 'db-uuid-1');
  assert.equal(r.url, 'https://neighbours-tool-library.pretty-name.workers.dev');
  assert.match(r.claimUrl, /claimToken=/); assert.equal(r.mode, 'preview'); assert.equal(r.bundleSha256, 'abc123');
  assert.ok(r.consoleKey.length >= 30);
  assert.ok(!JSON.stringify(r).includes(SECRET_TOKEN), 'the temporary account token never leaves the launcher');
});

test('failures are explained in plain words and never leak the token or the claim link', async () => {
  for (const failAt of ['database', 'records', 'worker', 'address']) {
    const { f } = fakeCloudflare({ failAt });
    const err = await provision({ fetch: f, proof: PROOF, answers: ANSWERS, acceptedCloudflareTerms: true, release: RELEASE }).catch(e => e);
    assert.ok(err instanceof ProvisionError, failAt);
    assert.ok(!err.message.includes(SECRET_TOKEN) && !err.message.includes(CLAIM_TOKEN), `${failAt}: no secret in "${err.message}"`);
    assert.match(err.message, /Cloudflare refused/);
  }
});

test('nothing is written to the console or logs during provisioning (US-19-R07)', async () => {
  const seen = [];
  const orig = { log: console.log, error: console.error, warn: console.warn, info: console.info };
  for (const k of Object.keys(orig)) console[k] = (...a) => seen.push(a.join(' '));
  try {
    const { f } = fakeCloudflare();
    await provision({ fetch: f, proof: PROOF, answers: ANSWERS, acceptedCloudflareTerms: true, release: RELEASE });
    const bad = fakeCloudflare({ failAt: 'worker' });
    await provision({ fetch: bad.f, proof: PROOF, answers: ANSWERS, acceptedCloudflareTerms: true, release: RELEASE }).catch(() => {});
  } finally { Object.assign(console, orig); }
  assert.deepEqual(seen, []);
});

test('the seed SQL gives the console real records: the persons own words, one item per outcome, and the preview cards', async () => {
  const a = cleanIdea(ANSWERS);
  const sql = buildSeedSql(a, { orgName: 'Neighbours Tool Library', slug: 'neighbours-tool-library', now: '2026-11-11T00:00:00Z' });
  const db = makeDb();
  db.raw.exec(sql);
  db.raw.exec(sql); // idempotent
  assert.equal(db.raw.prepare("SELECT value FROM org WHERE key='idea'").get().value, ANSWERS.idea, 'verbatim');
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM items").get().n, 2);
  const c = await buildConsole(db, {});
  assert.equal(c.needs_you.cards.length, 2); // CLAIM and HEARTBEAT (no spending limit asked)
  assert.ok(c.needs_you.cards.every(x => x.kind === 'manual'));
  assert.equal(c.now.open, 2);
  const withLimit = buildSeedSql(cleanIdea({ ...ANSWERS, limit: 25 }), { orgName: 'x', slug: 'x' });
  assert.match(withLimit, /Approve spending up to 25 USD/);
});

test('apostrophes and hostile text are stored as text, not run as SQL', () => {
  const db = makeDb();
  const evil = "x'); DROP TABLE items; -- it's";
  db.raw.exec(buildSeedSql(cleanIdea({ idea: 'I want ' + evil + ' to exist please', outcomes: [evil] }), { orgName: evil, slug: 'x' }));
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM items").get().n, 1);
  assert.equal(db.raw.prepare("SELECT title FROM items").get().title, evil);
});

test('input is validated in plain words', () => {
  assert.throws(() => cleanIdea({ idea: 'short' }), /a little more/);
  assert.throws(() => cleanIdea({ idea: 'x'.repeat(2001) }), /2000/);
  assert.throws(() => cleanIdea({ idea: 'a long enough idea here', limit: -1 }), /limit/);
  assert.equal(slugify("  Neighbours' Tool Library!! "), 'neighbours-tool-library');
  assert.equal(slugify('!!!'), 'my-org');
});

test('the console key is random, long, url-safe', () => {
  const a = newConsoleKey(), b = newConsoleKey();
  assert.notEqual(a, b); assert.match(a, /^[A-Za-z0-9_-]{32}$/);
});

test('the challenge is fetched without credentials and returned as published', async () => {
  const { f, calls } = fakeCloudflare();
  assert.deepEqual(await fetchChallenge(f), { challengeToken: 'ct', seed: 'AAAA', k: 10, g: 10 });
  assert.equal(calls[0].auth, undefined);
});

test('the Worker upload binds the Heartbeat Durable Object and declares it SQLite-backed (rung 3: no cron on a temporary account)', async () => {
  const { f, calls } = fakeCloudflare();
  await provision({ fetch: f, proof: PROOF, answers: ANSWERS, acceptedCloudflareTerms: true, release: RELEASE });
  const meta = JSON.parse(await calls[3].body.get('metadata').text());
  assert.deepEqual(meta.bindings.find(b => b.name === 'HEARTBEAT'), { type: 'durable_object_namespace', name: 'HEARTBEAT', class_name: 'Heartbeat' });
  assert.deepEqual(meta.migrations, { new_tag: 'v1', new_sqlite_classes: ['Heartbeat'] });
  assert.equal(JSON.stringify(meta).includes('cron'), false);
});
