// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// The unified command-line tool (US-SPEC-10): one entry point for the commands of this repository. Each command runs the
// script that owns it with the remaining arguments and returns that script's exit status unchanged.
//   node tools/us.mjs <command> [arguments]      node tools/us.mjs help
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const COMMANDS = {
  bootstrap: { run: 'python', script: 'bootstrap/bootstrap.py', about: 'Plan and write an organization from an idea file (dry run by default; --apply provisions)' },
  install: { run: 'node', script: 'tools/install.mjs', about: 'One-command install: verify the released bundle, bootstrap, provision, deploy, register; re-run to upgrade' },
  verify: { run: 'node', script: 'agent-setup/verify.mjs', about: 'The closing probe every door ends at: is the organization at this address verified' },
  release: { run: 'node', script: 'tools/release_bundle.mjs', about: 'Build the deployable bundle with its SHA-256 manifest (and a signature with --sign-key-env)' },
  boundary: { run: 'node', script: 'tools/boundary_check.mjs', about: 'Fail when a component is unclassified or a classified component is not live' },
  test: { run: 'node', script: 'tools/run-suites.mjs', about: 'Run every test suite from one list' },
  'spec-truth': { run: 'python', script: 'tools/spec_truth.py', about: 'Report specification status lines that claim code which is not there' },
  'spec-backlog': { run: 'python', script: 'tools/spec_backlog.py', about: 'Count BUILT, RUNNING and PLANNED across the specifications' },
  selfhost: { run: 'python', script: 'tools/selfhost_check.py', about: 'Check a pull request record against the self-hosting contract' },
  'lint-workflows': { run: 'python', script: 'tools/workflow_lint.py', about: 'Lint CI workflows for the cost and safety rules (add --require-sha for public repositories)' },
  budget: { run: 'python', script: 'tools/actions_budget.py', about: 'CI minutes watchdog: usage against the budget file, decision and exit status' },
  settings: { run: 'python', script: 'tools/github_settings.py', about: 'Print (or with --apply, run) the safe code-host settings' },
  docs: { run: 'python', script: 'tools/docs_audit.py', about: 'Fail on a document no code consumes' },
};

export function usage() {
  const w = Math.max(...Object.keys(COMMANDS).map(k => k.length));
  return ['Usage: node tools/us.mjs <command> [arguments]', '', ...Object.entries(COMMANDS).map(([k, v]) => `  ${k.padEnd(w)}  ${v.about}`), `  ${'help'.padEnd(w)}  This list`].join('\n');
}

/** The process to start for a command line, or null when the command is unknown. */
export function resolve(argv, env = process.env) {
  const c = COMMANDS[argv[0]];
  if (!c) return null;
  const bin = c.run === 'node' ? process.execPath : env.PYTHON || 'python3';
  return { bin, args: [path.join(ROOT, c.script), ...argv.slice(1)] };
}

export function main(argv, { spawn = spawnSync, log = console.log, env = process.env } = {}) {
  if (!argv.length || ['help', '--help', '-h'].includes(argv[0])) { log(usage()); return 0; }
  const p = resolve(argv, env);
  if (!p) { log(`Unknown command: ${argv[0]}\n\n${usage()}`); return 2; }
  const r = spawn(p.bin, p.args, { stdio: 'inherit', env });
  if (r.error) { log(`Could not start ${argv[0]}: ${r.error.message}`); return 127; }
  return r.status ?? 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
