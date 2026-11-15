// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// core/ghcost: the checklist shown before a repository goes public (US-24-R43) and the revert of a deploy to the previous
// Release (US-24-R04). Both read the platform through the port and change nothing on it themselves.
import { iso, nowMs, first, run, cfg, recordProbe } from './util.js';

export const CHECKLIST = [
  { id: 'secret_history', label: 'The full commit history was scanned for secrets and none was found' },
  { id: 'secret_scanning', label: 'Secret scanning and push protection are enabled' },
  { id: 'pages_source', label: 'The Pages source is the one the organization chose (or Pages is off)' },
  { id: 'default_branch_ruleset', label: 'An active ruleset protects the default branch' },
  { id: 'fork_approval', label: 'Workflows from outside contributors need approval before they run' },
];

/** Record the result of a secret history scan (run by the host's scanner). findings is a count; only the count is kept. */
export const recordSecretScan = (ctx, repo, { findings, tool = 'scanner' }) =>
  recordProbe(ctx.db, `secret_history:${repo}`, Number(findings) === 0 ? 'pass' : 'fail', { findings: Number(findings), tool }, iso(nowMs(ctx)));

const guard = async fn => { try { return await fn(); } catch (e) { return { status: 'unmeasured', evidence: String(e?.message || e).slice(0, 160) }; } };

/**
 * Build the checklist for one repository from live reads and open (or refresh) its gate card. The default in effect is
 * that the repository stays private; `ready` is true only when all five rows pass. An unreadable row is unmeasured, not passed.
 */
export async function publicChecklist(ctx, repo) {
  const c = cfg(ctx), now = nowMs(ctx), ts = iso(now), gh = ctx.github, maxAge = (c.secret_scan_max_age_days || 7) * 86400000;
  const results = {};
  const scan = await first(ctx.db, `SELECT result, evidence, checked_at FROM ghcost_probes WHERE probe=? ORDER BY id DESC LIMIT 1`, `secret_history:${repo}`);
  results.secret_history = !scan ? { status: 'unmeasured', evidence: 'no history scan is recorded' }
    : now - Date.parse(scan.checked_at.replace(' ', 'T') + 'Z') > maxAge ? { status: 'unmeasured', evidence: `last scan ${scan.checked_at} is older than the limit` }
    : { status: scan.result === 'pass' ? 'pass' : 'fail', evidence: `${scan.evidence} at ${scan.checked_at}` };
  results.secret_scanning = await guard(async () => {
    const sa = (await gh.repo(repo))?.security_and_analysis || {};
    const a = sa.secret_scanning?.status, b = sa.secret_scanning_push_protection?.status;
    return { status: a === 'enabled' && b === 'enabled' ? 'pass' : 'fail', evidence: `secret_scanning ${a || 'absent'}, push_protection ${b || 'absent'}` };
  });
  results.pages_source = await guard(async () => {
    const p = await gh.pages(repo), want = c.pages_source ?? null; // null: Pages off; or 'workflow'; or 'branch:path'
    const have = !p ? null : p.build_type === 'workflow' ? 'workflow' : `${p.source?.branch}:${p.source?.path}`;
    return { status: have === want ? 'pass' : 'fail', evidence: `Pages source is ${have ?? 'off'}, chosen ${want ?? 'off'}` };
  });
  results.default_branch_ruleset = await guard(async () => {
    const list = (await gh.rulesets(repo)) || [];
    const active = list.filter(r => r.enforcement === 'active' && (r.target || 'branch') === 'branch');
    return { status: active.length ? 'pass' : 'fail', evidence: `${active.length} active branch ruleset(s)` };
  });
  results.fork_approval = await guard(async () => {
    const policy = (await gh.forkApproval())?.approval_policy;
    return { status: policy === 'all_external_contributors' ? 'pass' : 'fail', evidence: `approval_policy ${policy || 'absent'}` };
  });
  const rows = CHECKLIST.map(x => ({ ...x, ...results[x.id] }));
  const ready = rows.every(r => r.status === 'pass');
  const text = rows.map(r => `[${r.status === 'pass' ? 'x' : ' '}] ${r.label} (${r.status}: ${r.evidence})`).join('\n');
  const id = `GATE-PUBLIC-${repo}`.replace(/[^\w.-]/g, '-');
  await run(ctx.db, `INSERT INTO gate_cards (id, what, why_gated, default_in_effect, prepared_by_fleet, closing_probe) VALUES (?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET what=excluded.what, prepared_by_fleet=excluded.prepared_by_fleet`,
    id, `Make the repository ${repo} public. Checklist:\n${text}`,
    'Publishing a repository cannot be undone: its history is copied the moment it is public. It is the owner\'s act.',
    'The repository stays private.', JSON.stringify({ repo, ready, rows }), 'manual');
  await recordProbe(ctx.db, `public_checklist:${repo}`, ready ? 'pass' : rows.some(r => r.status === 'fail') ? 'fail' : 'unknown', rows.map(r => `${r.id}=${r.status}`).join(' '), ts);
  return { repo, ready, rows, card: id, text };
}

const sem = tag => { const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(tag)); return m ? m.slice(1).map(Number) : null; };
const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
/** The published Release just below `current` by version. Drafts, prereleases and tags that are not versions are skipped. */
export function previousRelease(releases, current) {
  const cur = sem(current); if (!cur) throw new Error('ghcost: current release tag is not a version');
  return releases.filter(r => !r.draft && !r.prerelease && sem(r.tag_name) && cmp(sem(r.tag_name), cur) < 0)
    .sort((a, b) => cmp(sem(b.tag_name), sem(a.tag_name)))[0] || null;
}

/**
 * Revert a unit to the previous Release. ports: github.releases(repo), download(url) -> text, sha256(text) -> hex,
 * deploy({ unit, artifact, expectedVersion, actor }) (core/deploy's deploy, so lock, probes and its own revert apply).
 * The bundle is deployed only when its SHA-256 equals the hash in the Release's manifest.
 */
export async function revertToPreviousRelease(ctx, { repo, unit, current, actor = 'ghcost' }) {
  const prev = previousRelease(await ctx.github.releases(repo), current);
  if (!prev) return { status: 'refused', reason: 'no_previous_release' };
  const asset = name => (prev.assets || []).find(a => a.name === name);
  const m = asset('manifest.json'), b = asset('bundle.js');
  if (!m || !b) return { status: 'refused', reason: 'release_has_no_bundle', to: prev.tag_name };
  const manifest = JSON.parse(await ctx.download(m.browser_download_url)), bundle = await ctx.download(b.browser_download_url);
  const digest = await ctx.sha256(bundle);
  if (digest !== manifest.bundle_sha256) return { status: 'refused', reason: 'digest_mismatch', to: prev.tag_name, expected: manifest.bundle_sha256, actual: digest };
  const r = await ctx.deploy({ unit, artifact: { version: manifest.version || prev.tag_name, body: bundle, sha256: digest }, expectedVersion: String(current).replace(/^v/, ''), actor });
  return { status: r?.status || 'unknown', from: current, to: prev.tag_name, sha256: digest, deploy: r };
}
