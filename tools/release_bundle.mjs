// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Release bundle (US-19-R16): build the preview Worker via apps/launcher/build.mjs, write bundle.js, migrations.sql,
// and manifest.json (sha256 of each, Cloudflare products and permissions needed) into --outdir.
// Usage: node tools/release_bundle.mjs --outdir <dir> [--version X.Y.Z] [--sign-key-env NAME]
// --sign-key-env names an environment variable holding an Ed25519 private key (PKCS8, base64). When set, manifest.sig
// (base64 signature over the bytes of manifest.json) is written beside the manifest; core/install verifies it (US-10-R14).
import { spawnSync } from 'node:child_process';
import { createHash, createPrivateKey, sign as edSign } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const PRODUCTS = ['Workers', 'D1'];
export const PERMISSIONS = ['Workers Scripts: Edit', 'D1: Edit'];
const sha = s => createHash('sha256').update(s).digest('hex');

export function manifest(bundle, migrations, version) {
  return { version: version || 'unreleased', bundle_sha256: sha(bundle), migrations_sha256: sha(migrations), products: PRODUCTS, permissions: PERMISSIONS };
}

/** Ed25519 signature (base64) over the manifest text; the key is PKCS8 DER in base64. */
export function signManifest(manifestText, pkcs8B64) {
  const key = createPrivateKey({ key: Buffer.from(pkcs8B64, 'base64'), format: 'der', type: 'pkcs8' });
  return edSign(null, Buffer.from(manifestText, 'utf8'), key).toString('base64');
}

export async function main(argv) {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const get = k => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : undefined);
  const outdir = get('--outdir'); if (!outdir) { console.error('--outdir required'); return 2; }
  mkdirSync(outdir, { recursive: true });
  const gen = path.join(outdir, 'bundle.generated.js');
  const r = spawnSync(process.execPath, [path.join(root, 'apps/launcher/build.mjs'), '--out', gen], { encoding: 'utf8' });
  if (r.status !== 0) { console.error(r.stdout + r.stderr); return 1; }
  const m = await import(pathToFileURL(gen).href);
  writeFileSync(path.join(outdir, 'bundle.js'), m.BUNDLE);
  writeFileSync(path.join(outdir, 'migrations.sql'), m.MIGRATIONS_SQL);
  const man = manifest(m.BUNDLE, m.MIGRATIONS_SQL, get('--version'));
  if (man.bundle_sha256 !== m.BUNDLE_SHA256) { console.error('hash mismatch'); return 1; }
  const manifestText = JSON.stringify(man, null, 2) + '\n';
  writeFileSync(path.join(outdir, 'manifest.json'), manifestText);
  const keyEnv = get('--sign-key-env');
  if (keyEnv) {
    if (!process.env[keyEnv]) { console.error(`signing key variable ${keyEnv} is not set`); return 1; }
    writeFileSync(path.join(outdir, 'manifest.sig'), signManifest(manifestText, process.env[keyEnv]) + '\n');
  }
  console.log(JSON.stringify(man));
  return 0;
}
if (import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(await main(process.argv.slice(2)));
