// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Container executor (US-SPEC-11): runs bounded jobs (image + command + files) in isolation and records the outcome.
// A job is validated before any executor sees it, queued durably (idempotent by key), claimed with a lease, run through an
// ORDERED LIST of executors (a platform binding first, an HTTP runner second; a throwing executor is skipped, no single route),
// and finished as done or failed. A crashed worker's lease expires and reap() re-queues the job, or fails it past max_attempts.
// Ports: db, now() ms, config, executors: [{ name, run(job) -> { exit_code, stdout, stderr } }], secrets: [values to scrub].
// The container image and platform binding are adapters and NOT COVERED here (need a live account: ops/extraction-unblocked.json).
const DEFAULTS = { max_command_chars: 2000, max_files: 50, max_file_bytes: 200000, timeout_ms: 60000, max_output: 20000, max_attempts: 3, lease_minutes: 10,
  images: null, allow: null, max_env: 20 };

/** Returns null when the job is acceptable, else the reason. */
export function validateJob(job, c = DEFAULTS) {
  if (!job || typeof job !== 'object') return 'job required';
  if (typeof job.command !== 'string' || !job.command.trim()) return 'command required';
  if (job.command.length > c.max_command_chars) return 'command too long';
  if (c.images) { if (!c.images.includes(job.image)) return 'image not allowed: ' + String(job.image).slice(0, 80); }
  if (c.allow && !c.allow.includes(job.command.trim().split(/\s+/)[0])) return 'command not allowed: ' + job.command.trim().split(/\s+/)[0];
  const files = job.files || {};
  if (Object.keys(files).length > c.max_files) return 'too many files';
  for (const [p, t] of Object.entries(files)) {
    if (!p || p.startsWith('/') || /^[a-zA-Z]:/.test(p) || p.includes('\\') || p.split('/').includes('..')) return 'unsafe path: ' + p.slice(0, 80);
    if (String(t).length > c.max_file_bytes) return 'file too large: ' + p;
  }
  const env = job.env || {};
  if (Object.keys(env).length > c.max_env || Object.keys(env).some(k => !/^[A-Z_][A-Z0-9_]*$/.test(k))) return 'invalid env';
  return null;
}

export function createContainers({ db, now = () => Date.now(), config = {}, executors = [], secrets = [] }) {
  const c = { ...DEFAULTS, ...(config.containers || config) };
  const all = async (sql, ...a) => (await db.prepare(sql).bind(...a).all()).results || [];
  const first = async (sql, ...a) => (await db.prepare(sql).bind(...a).first()) || null;
  const run = (sql, ...a) => db.prepare(sql).bind(...a).run();
  const scrub = s => { let x = String(s ?? ''); for (const v of secrets) if (v && v.length > 3) x = x.split(v).join('[redacted]'); return x.slice(0, c.max_output); };

  /** Queue a job. Same idem key returns the existing job id. */
  async function submit(job, { key = null } = {}) {
    const bad = validateJob(job, c); if (bad) return { ok: false, refusal: 'invalid_job', detail: bad };
    if (key) { const ex = await first('SELECT id FROM containers_jobs WHERE idem_key = ?', key); if (ex) return { ok: true, id: ex.id, duplicate: true }; }
    const t = now();
    const r = await run('INSERT INTO containers_jobs (idem_key, job_json, created_ms, updated_ms) VALUES (?,?,?,?)', key, JSON.stringify(job), t, t);
    return { ok: true, id: r.meta.last_row_id };
  }

  /** Claim the oldest queued job, run it, record the outcome. Returns null when the queue is empty. */
  async function runNext() {
    const row = await first("SELECT * FROM containers_jobs WHERE status='queued' ORDER BY id LIMIT 1");
    if (!row) return null;
    const t = now();
    const claim = await run("UPDATE containers_jobs SET status='running', attempts=attempts+1, lease_until_ms=?, updated_ms=? WHERE id=? AND status='queued'", t + c.lease_minutes * 60000, t, row.id);
    if (!claim.meta.changes) return { id: row.id, skipped: 'claimed_elsewhere' };
    const job = { ...JSON.parse(row.job_json), timeout_ms: c.timeout_ms };
    const attempts = []; let result = null;
    for (const e of executors) {
      let timer;
      try {
        const r = await Promise.race([e.run(job), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), c.timeout_ms); })]);
        attempts.push({ executor: e.name, ok: true }); result = { executor: e.name, ...r }; break;
      } catch (err) { attempts.push({ executor: e.name, ok: false, error: scrub(err?.message).slice(0, 200) }); }
      finally { clearTimeout(timer); }
    }
    const u = now();
    if (!result) {
      const last = attempts.length ? attempts.map(a => a.executor + ': ' + a.error).join('; ') : 'no_executor';
      const final = row.attempts + 1 >= c.max_attempts;
      await run('UPDATE containers_jobs SET status=?, error=?, lease_until_ms=NULL, updated_ms=? WHERE id=?', final ? 'failed' : 'queued', last.slice(0, 300), u, row.id);
      return { id: row.id, ok: false, refusal: executors.length ? 'all_executors_failed' : 'no_executor', status: final ? 'failed' : 'queued', attempts };
    }
    const ok = result.exit_code === 0;
    await run('UPDATE containers_jobs SET status=?, executor=?, exit_code=?, stdout=?, stderr=?, error=NULL, lease_until_ms=NULL, updated_ms=? WHERE id=?',
      ok ? 'done' : 'failed', result.executor, result.exit_code ?? null, scrub(result.stdout), scrub(result.stderr), u, row.id); // a nonzero exit is a result, not a retry
    return { id: row.id, ok, status: ok ? 'done' : 'failed', exit_code: result.exit_code, executor: result.executor, attempts };
  }

  /** Re-queue running jobs whose lease expired (a crashed worker); fail those out of attempts. */
  async function reap() {
    const t = now(), stale = await all("SELECT id, attempts FROM containers_jobs WHERE status='running' AND lease_until_ms <= ?", t);
    let requeued = 0, failed = 0;
    for (const j of stale) {
      if (j.attempts >= c.max_attempts) { await run("UPDATE containers_jobs SET status='failed', error='lease expired', lease_until_ms=NULL, updated_ms=? WHERE id=?", t, j.id); failed++; }
      else { await run("UPDATE containers_jobs SET status='queued', lease_until_ms=NULL, updated_ms=? WHERE id=?", t, j.id); requeued++; }
    }
    return { requeued, failed };
  }

  const get = id => first('SELECT id, status, attempts, executor, exit_code, stdout, stderr, error FROM containers_jobs WHERE id = ?', id);
  const stats = async () => Object.fromEntries((await all('SELECT status, COUNT(*) n FROM containers_jobs GROUP BY status')).map(r => [r.status, Number(r.n)]));
  return { submit, runNext, reap, get, stats };
}
