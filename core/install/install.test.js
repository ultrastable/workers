// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { install, verifyBundle, verifySignature, sha256, report, connectorCard, EXIT } from './index.js';

const b64 = buf => Buffer.from(buf).toString('base64');
async function keypair() {
  const k = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  return { priv: k.privateKey, pub: b64(await crypto.subtle.exportKey('raw', k.publicKey)) };
}
async function release(version, bundle, migrations, priv) {
  const manifestText = JSON.stringify({ version, bundle_sha256: await sha256(bundle), migrations_sha256: await sha256(migrations) });
  const signature = priv ? b64(await crypto.subtle.sign({ name: 'Ed25519' }, priv, new TextEncoder().encode(manifestText))) : undefined;
  return { bundle, migrations, manifestText, signature };
}

/** A fake world: every port mutates this state and counts its calls, so a re-run shows exactly which steps acted. */
function world(rel, { env = {}, tickAfterHealthChecks = 3 } = {}) {
  const w = { rel, calls: [], bootstrapped: false, provisioned: false, bound: [], live: null, healthChecks: 0, tenant: null, cards: [], slept: 0 };
  const did = n => { w.calls.push(n); };
  w.ports = {
    preconditions: async () => [],
    fetchBundle: async () => w.rel,
    bootstrapped: async () => w.bootstrapped,
    bootstrap: async () => { did('bootstrap'); w.bootstrapped = true; },
    env,
    gateCard: async c => { w.cards.push(c); },
    health: async () => { if (!w.live) return 404; w.healthChecks++; return w.healthChecks > tickAfterHealthChecks ? 200 : 503; },
    sleep: async () => { w.slept++; },
    registered: async () => w.tenant,
    register: async t => { did('register'); w.tenant = t; },
    adapter: {
      provisioned: async () => w.provisioned,
      provision: async () => { did('provision'); w.provisioned = true; },
      boundSecrets: async () => w.bound,
      bindSecret: async (slug, name) => { did('bind:' + name); w.bound.push(name); },
      liveVersion: async () => w.live,
      deploy: async (slug, { bundle, manifest }) => { did('deploy'); w.live = { version: manifest.version, sha256: await sha256(bundle) }; w.healthChecks = 0; },
    },
  };
  return w;
}
const ARGS = { slug: 'tool-share', runtime: 'workers', idea: 'IDEA.md' };
const statuses = r => Object.fromEntries(r.steps.map(s => [s.name, s.status]));

test('US-10-R14 a bundle whose digest does not match its manifest stops the install with exit 3 before anything is applied', async () => {
  const rel = await release('1.0.0', 'worker code', 'CREATE TABLE t (a);');
  const w = world({ ...rel, bundle: 'worker code with one byte changed' });
  const r = await install(ARGS, w.ports);
  assert.equal(r.exit_code, 3);
  assert.equal(EXIT.digest, 3);
  assert.deepEqual(statuses(r), { preconditions: 'ok', bundle: 'failed' });
  assert.match(r.steps[1].detail, /digest_mismatch in bundle: expected [0-9a-f]{64}, got [0-9a-f]{64}/);
  assert.deepEqual(w.calls, [], 'no bootstrap, provision or deploy ran');
  const m = world({ ...rel, migrations: 'DROP TABLE t;' });
  assert.equal((await install(ARGS, m.ports)).exit_code, 3);
  assert.deepEqual(m.calls, []);
});

test('US-10-R14 a signed bundle: the manifest signature must verify with the configured public key, else exit 3', async () => {
  const k = await keypair(), other = await keypair();
  const rel = await release('1.0.0', 'code', 'sql', k.priv);
  assert.equal(await verifySignature(rel.manifestText, rel.signature, k.pub), true);
  assert.equal((await verifyBundle(rel, { publicKey: k.pub })).signed, true);
  assert.equal((await verifyBundle(rel, { publicKey: other.pub })).reason, 'signature_mismatch');
  assert.equal((await verifyBundle({ ...rel, signature: undefined }, { publicKey: k.pub })).reason, 'signature_missing');
  assert.equal((await verifyBundle(rel, { requireSignature: true })).reason, 'no_public_key');
  // An attacker who rewrites bundle and manifest together is caught by the signature, not by the digest.
  const forged = await release('1.0.0', 'evil code', 'sql');
  assert.equal((await verifyBundle({ ...forged, signature: rel.signature }, { publicKey: k.pub })).reason, 'signature_mismatch');
  const w = world({ ...forged, signature: rel.signature });
  const r = await install(ARGS, w.ports, { publicKey: k.pub });
  assert.equal(r.exit_code, 3);
  assert.deepEqual(w.calls, []);
  assert.equal((await verifyBundle({ ...rel, manifestText: '{not json' })).reason, 'manifest_unreadable');
  assert.equal((await verifyBundle({ ...rel, manifestText: '{"version":"1"}' })).reason, 'manifest_has_no_digest');
});

test('US-SPEC-10 s7 a first install runs every step in order, waits for the first tick and registers the tenant', async () => {
  const k = await keypair(), w = world(await release('1.0.0', 'code', 'sql', k.priv), { env: { CODE_HOST_TOKEN: 'a-secret-value' } });
  const r = await install(ARGS, w.ports, { publicKey: k.pub, connectors: ['CODE_HOST_TOKEN'] });
  assert.equal(r.exit_code, 0);
  assert.deepEqual(statuses(r), { preconditions: 'ok', bundle: 'ok', bootstrap: 'ran', provision: 'ran', connectors: 'ran', deploy: 'ran', first_tick: 'ran', register: 'ran' });
  assert.deepEqual(w.calls, ['bootstrap', 'provision', 'bind:CODE_HOST_TOKEN', 'deploy', 'register']);
  assert.match(r.steps.find(s => s.name === 'deploy').detail, /health 503/, 'health answers 503 until the first tick completes');
  assert.ok(w.slept >= 1);
  assert.deepEqual(w.tenant, { slug: 'tool-share', runtime: 'workers', bundle_sha256: await sha256('code'), version: '1.0.0' });
  assert.doesNotMatch(JSON.stringify(r) + report(r), /a-secret-value/, 'a credential value never reaches the result');
  assert.equal(report(r).split('\n').length, 4);
});

test('US-SPEC-10 s7 re-running performs only the steps whose probes fail, so the same command upgrades a tenant', async () => {
  const w = world(await release('1.0.0', 'code', 'sql'));
  await install(ARGS, w.ports);
  w.calls.length = 0;
  const again = await install(ARGS, w.ports);
  assert.equal(again.exit_code, 0);
  assert.deepEqual(w.calls, [], 'nothing runs when every probe passes');
  assert.deepEqual(statuses(again), { preconditions: 'ok', bundle: 'ok', bootstrap: 'skipped', provision: 'skipped', connectors: 'skipped', deploy: 'skipped', first_tick: 'skipped', register: 'skipped' });
  w.rel = await release('1.1.0', 'code v2', 'sql');
  const up = await install(ARGS, w.ports);
  assert.deepEqual(w.calls, ['deploy', 'register'], 'an upgrade deploys the new bundle and re-registers; nothing else');
  assert.equal(w.live.version, '1.1.0');
  assert.equal(w.tenant.version, '1.1.0');
  assert.equal(up.exit_code, 0);
  w.calls.length = 0; w.provisioned = false; // half-built: the database is gone
  await install(ARGS, w.ports);
  assert.deepEqual(w.calls, ['provision']);
});

test('US-SPEC-10 s7 a missing connector value becomes a gate card with a default in effect and an env probe; the install still completes', async () => {
  const w = world(await release('1.0.0', 'code', 'sql'), { env: { PRESENT: 'x' } });
  const r = await install(ARGS, w.ports, { connectors: ['PRESENT', 'ABSENT_TOKEN'] });
  assert.equal(r.exit_code, 0);
  assert.equal(statuses(r).connectors, 'degraded');
  assert.deepEqual(w.bound, ['PRESENT']);
  assert.deepEqual(r.gate_cards, [connectorCard('ABSENT_TOKEN')]);
  assert.deepEqual(w.cards.map(c => [c.id, c.default_in_effect, c.closing_probe]), [['GATE-ABSENT_TOKEN', 'those capabilities stay in dry-run', 'env:ABSENT_TOKEN']]);
  assert.match(report(r), /1 gate card\(s\) \(GATE-ABSENT_TOKEN\)/);
});

test('a failed step stops the install with exit 2 and the same command resumes from it', async () => {
  const w = world(await release('1.0.0', 'code', 'sql'));
  let broken = true; const provision = w.ports.adapter.provision;
  w.ports.adapter.provision = async (...a) => { if (broken) throw new Error('x'.repeat(600) + ' quota exceeded'); return provision(...a); };
  const r = await install(ARGS, w.ports);
  assert.equal(r.exit_code, 2);
  assert.deepEqual(statuses(r), { preconditions: 'ok', bundle: 'ok', bootstrap: 'ran', provision: 'failed' });
  assert.ok(r.steps[3].detail.endsWith('quota exceeded') && r.steps[3].detail.length <= 400, 'the last 400 characters of the error are kept');
  assert.match(report(r), /stopped at provision/);
  broken = false; w.calls.length = 0;
  const again = await install(ARGS, w.ports);
  assert.equal(again.exit_code, 0);
  assert.deepEqual(w.calls, ['provision', 'deploy', 'register'], 'bootstrap is not repeated');
});

test('a deploy that does not answer as this Worker, a step whose probe still fails, and a tick that never comes are failures', async () => {
  const rel = await release('1.0.0', 'code', 'sql');
  const foreign = world(rel); foreign.ports.health = async () => 404;
  assert.match((await install(ARGS, foreign.ports)).steps.at(-1).detail, /health returned 404/);
  const noop = world(rel); noop.ports.bootstrap = async () => {};
  const r = await install(ARGS, noop.ports);
  assert.deepEqual([r.exit_code, r.steps.at(-1).name, r.steps.at(-1).detail], [2, 'bootstrap', 'ran, and its probe still fails']);
  const stuck = world(rel, { tickAfterHealthChecks: Infinity });
  const s = await install(ARGS, stuck.ports, { waitAttempts: 3 });
  assert.deepEqual([s.exit_code, s.steps.at(-1).name], [2, 'first_tick']);
  assert.equal(stuck.slept, 3, 'the wait is bounded');
  assert.equal(stuck.tenant, null, 'a tenant with no tick is not registered');
});

test('preconditions are verified before the bundle is fetched: bad slug, unsupported runtime, a missing tool', async () => {
  const w = world(await release('1.0.0', 'code', 'sql')); let fetched = 0; const f = w.ports.fetchBundle;
  w.ports.fetchBundle = async () => { fetched++; return f(); };
  for (const args of [{ ...ARGS, slug: 'Tool Share' }, { ...ARGS, runtime: 'mainframe' }]) assert.equal((await install(args, w.ports)).exit_code, 2);
  w.ports.preconditions = async () => ['idea file IDEA.md does not exist'];
  const r = await install(ARGS, w.ports);
  assert.deepEqual([r.exit_code, r.steps[0].status, r.steps[0].detail], [2, 'failed', 'idea file IDEA.md does not exist']);
  assert.equal(fetched, 0);
});

test('a dry run plans provision and deploy, registers nothing and exits 0', async () => {
  const w = world(await release('1.0.0', 'code', 'sql'));
  w.ports.adapter.provision = async () => ({ status: 'degraded', detail: 'dry run: 3 commands planned' });
  w.ports.adapter.deploy = async () => ({ status: 'degraded', detail: 'dry run: deploy planned' });
  const r = await install(ARGS, w.ports);
  assert.equal(r.exit_code, 0);
  assert.deepEqual(statuses(r), { preconditions: 'ok', bundle: 'ok', bootstrap: 'ran', provision: 'degraded', connectors: 'skipped', deploy: 'degraded', first_tick: 'degraded', register: 'degraded' });
  assert.equal(w.tenant, null);
});
