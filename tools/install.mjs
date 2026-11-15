// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// One-command install (US-SPEC-10 s7, US-10-R14): the real ports for core/install.
//   node tools/install.mjs --slug <slug> --idea IDEA.md --bundle-dir <dir> | --bundle-url <base>
//        [--runtime workers] [--root .] [--out <root>/org] [--public-key <base64> | --public-key-file <file>] [--require-signature]
//        [--apply --account-id <id> --health-url <https://...>] [--json]
// Default is a dry run: the bundle is verified, the bootstrapper writes the org record, provision and deploy are planned.
// --apply provisions and deploys through adapters/cloudflare/install-adapter.js. Exit 0 ok, 2 a step failed, 3 digest or
// signature mismatch. Run it again after a failure or for a new bundle: steps whose probes pass are skipped.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { install, report, EXIT } from '../core/install/index.js';
import { cloudflareInstallAdapter } from '../adapters/cloudflare/install-adapter.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FLAGS = ['--require-signature', '--apply', '--json'];
export function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`unexpected argument ${a}`);
    if (FLAGS.includes(a)) o[a.slice(2)] = true; else { if (argv[i + 1] === undefined) throw new Error(`${a} needs a value`); o[a.slice(2)] = argv[++i]; }
  }
  return o;
}
const dryAdapter = () => ({
  provisioned: async () => false, provision: async () => ({ status: 'degraded', detail: 'dry run: create database, apply migrations planned' }),
  boundSecrets: async () => [], bindSecret: async () => ({ status: 'degraded', detail: 'dry run: secrets are bound with --apply' }),
  liveVersion: async () => null, deploy: async () => ({ status: 'degraded', detail: 'dry run: upload of the verified bundle planned' }),
});

export async function main(argv, { env = process.env, fetch: fetchPort = globalThis.fetch, spawn = spawnSync, log = console.log, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  let o;
  try { o = parseArgs(argv); } catch (e) { console.error(`install: ${e.message}`); return EXIT.failed; }
  const root = path.resolve(o.root || ROOT), out = path.resolve(o.out || path.join(root, 'org')), idea = o.idea ? path.resolve(o.idea) : path.join(root, 'IDEA.md');
  const read = async name => {
    if (o['bundle-dir']) return readFileSync(path.join(o['bundle-dir'], name), 'utf8');
    const res = await fetchPort(String(o['bundle-url']).replace(/\/$/, '') + '/' + name);
    if (!res.ok) throw new Error(`${name}: http ${res.status}`);
    return res.text();
  };
  const optional = async name => { try { return (await read(name)).trim(); } catch { return undefined; } };
  let connectors = [];
  try { connectors = Object.values(JSON.parse(readFileSync(path.join(root, 'ultrastable.json'), 'utf8')).connectors || {}).filter(c => !c.optional).map(c => c.env); } catch { /* no org config: no connectors to bind */ }
  const tenantFile = path.join(out, 'tenant.json'), cardsFile = path.join(out, 'gate-cards.json');
  const ports = {
    env,
    async preconditions() {
      const m = [];
      if (!o['bundle-dir'] && !o['bundle-url']) m.push('one of --bundle-dir or --bundle-url');
      if (o['bundle-dir'] && !existsSync(o['bundle-dir'])) m.push(`bundle directory ${o['bundle-dir']} does not exist`);
      if (!existsSync(idea)) m.push(`idea file ${idea} does not exist`);
      if (!existsSync(path.join(root, 'bootstrap', 'bootstrap.py'))) m.push(`no bootstrapper under ${root}`);
      if (o.apply) {
        if (!o['account-id']) m.push('--account-id (with --apply)');
        if (!o['health-url']) m.push('--health-url (with --apply)');
        if (!env.CLOUDFLARE_API_TOKEN) m.push('CLOUDFLARE_API_TOKEN is not set (with --apply)');
      }
      return m;
    },
    fetchBundle: async () => ({ bundle: await read('bundle.js'), migrations: await read('migrations.sql'), manifestText: await read('manifest.json'), signature: await optional('manifest.sig') }),
    bootstrapped: async () => existsSync(path.join(out, 'boot-log.json')) && existsSync(path.join(out, 'charter.md')),
    async bootstrap() {
      const r = spawn(env.PYTHON || 'python3', [path.join(root, 'bootstrap', 'bootstrap.py'), '--dry-run', '--root', root, '--out', out, '--idea', idea], { encoding: 'utf8' });
      if (r.error) throw r.error;
      if (r.status !== 0) throw new Error(String(r.stderr || r.stdout || `bootstrapper exit ${r.status}`));
      return { detail: `org record in ${out}` };
    },
    async gateCard(card) {
      let cards = [];
      try { cards = JSON.parse(readFileSync(cardsFile, 'utf8')); } catch { /* first card */ }
      if (cards.some(c => c.id === card.id)) return;
      mkdirSync(out, { recursive: true });
      writeFileSync(cardsFile, JSON.stringify([...cards, card], null, 2) + '\n');
    },
    adapter: o.apply ? cloudflareInstallAdapter({ fetch: fetchPort, config: { accountId: o['account-id'] }, env }) : dryAdapter(),
    health: async () => { try { return (await fetchPort(String(o['health-url']).replace(/\/$/, '') + '/health')).status; } catch { return 0; } },
    sleep,
    registered: async () => { try { return JSON.parse(readFileSync(tenantFile, 'utf8')); } catch { return null; } },
    async register(t) { mkdirSync(out, { recursive: true }); writeFileSync(tenantFile, JSON.stringify(t, null, 2) + '\n'); },
  };
  const publicKey = o['public-key'] || (o['public-key-file'] ? readFileSync(o['public-key-file'], 'utf8').trim() : null);
  const result = await install({ slug: o.slug, runtime: o.runtime || 'workers', idea }, ports, { connectors, publicKey, requireSignature: !!o['require-signature'] });
  log(o.json ? JSON.stringify(result, null, 2) : report(result));
  return result.exit_code;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
