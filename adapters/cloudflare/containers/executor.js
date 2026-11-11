// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Container executor: runs a bounded job (command + files) somewhere isolated and returns { ok, exit_code, stdout, stderr }.
// executors is an ORDERED LIST of { name, run(job) }: a platform container binding first, an HTTP runner second (no single route);
// an executor that throws is skipped, and the attempts are returned. Jobs are validated before any executor sees them.
const DEFAULTS = { max_command_chars: 2000, max_files: 50, max_file_bytes: 200000, timeout_ms: 60000, max_output: 20000, allow: null };
export function validateJob(job, c = DEFAULTS) {
  if (!job || typeof job.command !== 'string' || !job.command.trim()) return 'command required';
  if (job.command.length > c.max_command_chars) return 'command too long';
  const bin = job.command.trim().split(/\s+/)[0];
  if (c.allow && !c.allow.includes(bin)) return 'command not allowed: ' + bin;
  const files = job.files || {};
  if (Object.keys(files).length > c.max_files) return 'too many files';
  for (const [p, t] of Object.entries(files)) {
    if (p.startsWith('/') || p.split('/').includes('..')) return 'unsafe path: ' + p;
    if (String(t).length > c.max_file_bytes) return 'file too large: ' + p;
  }
  return null;
}
export async function execute({ executors = [], config = {}, secrets = [] }, job) {
  const c = { ...DEFAULTS, ...config };
  const bad = validateJob(job, c);
  if (bad) return { ok: false, refusal: 'invalid_job', detail: bad, attempts: [] };
  const scrub = s => { let x = String(s ?? ''); for (const v of secrets) if (v && v.length > 3) x = x.split(v).join('[redacted]'); return x.slice(0, c.max_output); };
  const attempts = [];
  for (const e of executors) {
    try {
      let timer;
      const r = await Promise.race([e.run({ ...job, timeout_ms: c.timeout_ms }), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), c.timeout_ms); })]).finally(() => clearTimeout(timer));
      attempts.push({ executor: e.name, ok: true });
      return { ok: r.exit_code === 0, executor: e.name, exit_code: r.exit_code, stdout: scrub(r.stdout), stderr: scrub(r.stderr), attempts };
    } catch (err) { attempts.push({ executor: e.name, ok: false, error: scrub(err?.message).slice(0, 200) }); }
  }
  return { ok: false, refusal: executors.length ? 'all_executors_failed' : 'no_executor', attempts };
}
/** HTTP runner route: POST the job as JSON to a runner URL; the token is read from env at call time. */
export const httpExecutor = ({ name = 'http', url, fetch, env = {}, tokenEnv = 'RUNNER_TOKEN' }) => ({ name, async run(job) {
  const t = env[tokenEnv]; if (!t) throw new Error('runner token ' + tokenEnv + ' not set');
  const res = await fetch(url, { method: 'POST', headers: { authorization: 'Bearer ' + t, 'content-type': 'application/json' }, body: JSON.stringify(job) });
  if (!res.ok) throw new Error('runner http ' + res.status);
  return res.json();
} });
