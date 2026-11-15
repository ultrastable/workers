// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// core/install (US-SPEC-10 s7 one-command install, US-10-R14): take a slug, a runtime and an idea; verify preconditions;
// fetch the released bundle and stop on any SHA-256 digest or signature mismatch (exit 3); run the bootstrapper; provision
// through the adapter; bind connectors by presence (a missing value becomes a gate card); deploy and probe; wait for the
// first tick; register the tenant. Every step has a probe and runs only when its probe fails, so the same command upgrades
// a tenant. Everything that touches the world is a port: this file holds the order, the checks and the exit codes.
export const EXIT = { ok: 0, failed: 2, digest: 3 };
export const RUNTIMES = ['workers'];
const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const bytes = text => (typeof text === 'string' ? new TextEncoder().encode(text) : text);
export const sha256 = async text => hex(await crypto.subtle.digest('SHA-256', bytes(text)));
const unb64 = s => Uint8Array.from(atob(String(s).trim()), c => c.charCodeAt(0));

/** Verify an Ed25519 signature (base64) over the manifest text with a raw public key (base64, 32 bytes). */
export async function verifySignature(manifestText, signatureB64, publicKeyB64) {
  try {
    const key = await crypto.subtle.importKey('raw', unb64(publicKeyB64), { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, unb64(signatureB64), bytes(manifestText));
  } catch { return false; }
}

/**
 * Check a fetched bundle { bundle, migrations, manifestText, signature? } against its manifest. Returns { ok, manifest }
 * or { ok: false, reason, expected, actual }. With `publicKey` the manifest signature must verify; `requireSignature`
 * refuses a bundle when no key is configured, so an unsigned install is a stated choice and never a silent one.
 */
export async function verifyBundle(fetched, { publicKey = null, requireSignature = false } = {}) {
  let manifest;
  try { manifest = JSON.parse(fetched.manifestText); } catch { return { ok: false, reason: 'manifest_unreadable' }; }
  if (publicKey) {
    if (!fetched.signature) return { ok: false, reason: 'signature_missing' };
    if (!(await verifySignature(fetched.manifestText, fetched.signature, publicKey))) return { ok: false, reason: 'signature_mismatch' };
  } else if (requireSignature) return { ok: false, reason: 'no_public_key' };
  for (const [part, field] of [['bundle', 'bundle_sha256'], ['migrations', 'migrations_sha256']]) {
    if (!/^[0-9a-f]{64}$/.test(String(manifest[field]))) return { ok: false, reason: 'manifest_has_no_digest', part };
    const actual = await sha256(fetched[part] ?? '');
    if (actual !== manifest[field]) return { ok: false, reason: 'digest_mismatch', part, expected: manifest[field], actual };
  }
  return { ok: true, manifest, signed: !!publicKey };
}

/** The gate card for a connector whose value is absent: the default is in effect and the probe is its presence. */
export const connectorCard = name => ({ id: `GATE-${name}`, what: `Connect ${name}`, why_gated: 'A credential is the owner\'s to grant; the installer never reads or stores its value.',
  default_in_effect: 'those capabilities stay in dry-run', closing_probe: `env:${name}` });

/**
 * Run the install. args: { slug, runtime, idea }. ports:
 *   preconditions() -> [missing things]            fetchBundle() -> { bundle, migrations, manifestText, signature? }
 *   bootstrapped(slug) / bootstrap({slug, idea})   adapter.provisioned(slug) / adapter.provision(slug, {migrations})
 *   env (presence only)                            adapter.boundSecrets(slug) -> [names] / adapter.bindSecret(slug, name)
 *   gateCard(card)                                 adapter.liveVersion(slug) -> { version, sha256 } | null / adapter.deploy(slug, {bundle, manifest})
 *   health(slug) -> http status                    sleep(ms), registered(slug) -> { bundle_sha256 } | null / register({...})
 * A port's run may return { status: 'degraded', detail } (a dry run that planned and did not act). Steps after a failure do not run.
 */
export async function install(args, ports, opts = {}) {
  const { slug, runtime = 'workers', idea = null } = args || {};
  const connectors = opts.connectors || [], waitAttempts = opts.waitAttempts ?? 12, waitMs = opts.waitMs ?? 10000;
  const out = { slug, runtime, exit_code: EXIT.ok, steps: [], gate_cards: [], bundle: null };
  const note = (name, status, detail = '') => { out.steps.push({ name, status, detail: String(detail).slice(0, 400) }); return status; };
  const fail = (name, detail, code = EXIT.failed) => { note(name, 'failed', detail); out.exit_code = code; return out; };
  const text = e => String(e?.message || e).slice(-400);

  // 1. preconditions: nothing is changed before they hold.
  const missing = [];
  if (!SLUG.test(String(slug))) missing.push('slug: lower-case letters, digits and hyphens, at most 40 characters');
  if (!RUNTIMES.includes(runtime)) missing.push(`runtime: one of ${RUNTIMES.join(', ')}`);
  if (!missing.length) { try { missing.push(...((await ports.preconditions?.({ slug, runtime, idea })) || [])); } catch (e) { missing.push(text(e)); } }
  if (missing.length) return fail('preconditions', missing.join('; '));
  note('preconditions', 'ok');

  // 2. the bundle is verified on every run, before anything is applied (US-10-R14). A mismatch stops with exit 3.
  let fetched, verdict;
  try { fetched = await ports.fetchBundle(); } catch (e) { return fail('bundle', `fetch failed: ${text(e)}`); }
  verdict = await verifyBundle(fetched, opts);
  if (!verdict.ok) return fail('bundle', `${verdict.reason}${verdict.part ? ' in ' + verdict.part : ''}${verdict.expected ? `: expected ${verdict.expected}, got ${verdict.actual}` : ''}`, EXIT.digest);
  const manifest = verdict.manifest;
  out.bundle = { version: manifest.version, sha256: manifest.bundle_sha256, signed: verdict.signed };
  note('bundle', 'ok', `version ${manifest.version}, sha256 ${manifest.bundle_sha256}${verdict.signed ? ', signature verified' : ', unsigned'}`);

  // 3 to 8: probe, then run only when the probe fails; probe again after a run that claims to have acted.
  const step = async (name, probe, act) => {
    try {
      if (await probe()) return note(name, 'skipped', 'probe passes');
      const r = (await act()) || {};
      if (r.status === 'degraded') return note(name, 'degraded', r.detail || '');
      if (r.status === 'failed') { fail(name, r.detail || 'failed'); return 'failed'; }
      if (!(await probe())) { fail(name, r.detail || 'ran, and its probe still fails'); return 'failed'; }
      return note(name, 'ran', r.detail || '');
    } catch (e) { fail(name, text(e)); return 'failed'; }
  };
  const a = ports.adapter;

  if (await step('bootstrap', () => ports.bootstrapped(slug), () => ports.bootstrap({ slug, idea, runtime })) === 'failed') return out;
  if (await step('provision', () => a.provisioned(slug), () => a.provision(slug, { migrations: fetched.migrations, manifest })) === 'failed') return out;

  // Connectors: presence only. The value is never read here; the adapter binds by name.
  const present = connectors.filter(n => !!ports.env?.[n]), absent = connectors.filter(n => !ports.env?.[n]);
  for (const n of absent) { const card = connectorCard(n); out.gate_cards.push(card); try { await ports.gateCard?.(card); } catch (e) { return fail('connectors', text(e)); } }
  const bound = async () => { const have = new Set((await a.boundSecrets(slug)) || []); return present.every(n => have.has(n)); };
  const cs = await step('connectors', bound, async () => { const have = new Set((await a.boundSecrets(slug)) || []); for (const n of present) if (!have.has(n)) { const r = await a.bindSecret(slug, n); if (r?.status === 'degraded') return r; } });
  if (cs === 'failed') return out;
  if (absent.length) { const s = out.steps[out.steps.length - 1]; if (s.status !== 'degraded') s.status = 'degraded'; s.detail = `gate card(s) for ${absent.join(', ')}; ${s.detail}`.replace(/; $/, ''); }

  const live = async () => { const v = await a.liveVersion(slug); return !!v && v.sha256 === manifest.bundle_sha256; };
  const ds = await step('deploy', live, async () => {
    const r = await a.deploy(slug, { bundle: fetched.bundle, manifest });
    if (r?.status === 'degraded') return r;
    const status = await ports.health(slug); // 503 until the first tick completes, 200 after; anything else is not this Worker
    if (status !== 200 && status !== 503) return { status: 'failed', detail: `health returned ${status} after the deploy` };
    return { detail: `health ${status}` };
  });
  if (ds === 'failed') return out;

  const dry = out.steps.some(s => ['provision', 'deploy'].includes(s.name) && s.status === 'degraded');
  if (dry) {
    note('first_tick', 'degraded', 'nothing was deployed, so there is no tick to wait for');
    note('register', 'degraded', 'a tenant is registered only after its first tick');
    return out;
  }
  const ticked = async () => (await ports.health(slug)) === 200;
  const ts = await step('first_tick', ticked, async () => {
    for (let i = 0; i < waitAttempts; i++) { if (await ticked()) return { detail: `first tick seen after ${i} wait(s)` }; await ports.sleep?.(waitMs); }
    return { status: 'failed', detail: `no completed tick after ${waitAttempts} check(s); health still answers 503` };
  });
  if (ts === 'failed') return out;

  await step('register', async () => (await ports.registered(slug))?.bundle_sha256 === manifest.bundle_sha256,
    () => ports.register({ slug, runtime, bundle_sha256: manifest.bundle_sha256, version: manifest.version }));
  return out;
}

/** Four plain lines for the person who ran the command. */
export function report(result) {
  const ran = result.steps.filter(s => s.status === 'ran').map(s => s.name), bad = result.steps.find(s => s.status === 'failed');
  return [
    `Happened: ${result.steps.map(s => `${s.name} ${s.status}`).join(', ')}.`,
    `Decided: ${bad ? `stopped at ${bad.name}: ${bad.detail}` : ran.length ? `ran ${ran.join(', ')}; every other step already passed its probe` : 'nothing needed to run'}.`,
    `Next: ${bad ? 'fix the cause and run the same command again; finished steps are skipped' : 'run the same command to upgrade when a new bundle is released'}.`,
    `Open: ${result.gate_cards.length} gate card(s)${result.gate_cards.length ? ' (' + result.gate_cards.map(c => c.id).join(', ') + ')' : ''}; exit ${result.exit_code}.`,
  ].join('\n');
}
