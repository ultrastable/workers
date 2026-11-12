// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// The pack host (US-SPEC-21): registry, enable gate, guarded tick steps, kill switches. Core never imports a pack (US-21-R03);
// this host loads pack code by directory at run time through an injected importer.
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { all, first, run, iso, ensureItem, assertReadOnly } from '../kernel/util.js';
import { registerProgram } from '../kernel/programs.js';
import { registerMetric } from '../kernel/metrics.js';
import { recordDecision } from '../kernel/decisions.js';
import { validateManifest, parseEntry } from './manifest.js';
import { sandboxDb, sandboxCtx, freezeGuard, scanPackSource } from './sandbox.js';
import { createGuard, sha256, setSwitch, engagedSwitches, rungCeilings, DEFAULT_RUNGS } from './guard.js';

export * from './manifest.js';
export * from './guard.js';
export { assertCoreImportsNoPacks } from './static-check.js';
export * from './sandbox.js';
export const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations/', import.meta.url));

export function loadManifest(dir) { return JSON.parse(readFileSync(path.join(dir, 'pack.json'), 'utf8')); }

const stable = v => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map(key => [key, x[key]])) : x));
const hasTable = async (db, name) => !!(await first(db, `SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?`, name));
const withTimeout = (p, ms) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(Object.assign(new Error(`pack step exceeded ${ms} ms`), { timeout: true })), ms);
  Promise.resolve(p).then(v => { clearTimeout(t); res(v); }, e => { clearTimeout(t); rej(e); });
});

// config: { step_timeout_ms, tenant_names, rungs, act_rung, ceilings, manager_model, packs: { <id>: settings } }
export function createPacks({ db, now = Date.now, config = {}, channels = {}, importer = d => import(pathToFileURL(d).href) } = {}) {
  const guard = createGuard({ db, now, config, channels });
  const rungs = config.rungs || DEFAULT_RUNGS;
  const ceilings = rungCeilings(config);
  const timeoutMs = config.step_timeout_ms ?? 5000;
  const managerRole = id => `pack-manager-${id}`;
  const programId = id => `pack-${id}`;

  async function row(id) { return first(db, `SELECT * FROM packs_registry WHERE id = ?`, id); }

  // US-21-R02: validate at load. A pack that fails is not stored at all.
  async function register(manifest, { dir = null } = {}) {
    const errors = validateManifest(manifest, { tenantNames: config.tenant_names || [], readProbeCheck: assertReadOnly });
    if (dir) errors.push(...scanPackSource(dir));
    if (errors.length) return { ok: false, errors };
    const hash = await sha256(stable(manifest));
    const cur = await row(manifest.id);
    if (cur && cur.enabled && cur.manifest_hash !== hash) return { ok: false, errors: ['pack is enabled with a different manifest; disable it first so the person sees the new card'] };
    await run(db, `INSERT INTO packs_registry (id, class, manifest_hash, manifest_json, source_dir, rung_ceiling, registered_at) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET class=excluded.class, manifest_hash=excluded.manifest_hash, manifest_json=excluded.manifest_json, source_dir=excluded.source_dir, rung_ceiling=excluded.rung_ceiling`,
      manifest.id, manifest.class, hash, JSON.stringify(manifest), dir, ceilings[manifest.class], iso(now()));
    return { ok: true, hash };
  }

  // US-21-R01, R04: a recorded decision, then the manager role, charter, guard metrics and a plus item in the kernel records.
  async function enablePack(id, { by, cardText } = {}) {
    const r = await row(id);
    if (!r) return { ok: false, reason: 'unknown_pack' };
    const m = JSON.parse(r.manifest_json);
    if (!by || !String(by).trim()) return { ok: false, reason: 'enabled_by_required' };
    if (!cardText || String(cardText).trim() !== m.enable_gate.trim()) return { ok: false, reason: 'card_text_mismatch' };
    const t = now();
    const decisionId = `pack-enable-${id}-${t}`;
    const kernel = await hasTable(db, 'kernel_programs');
    if (kernel) {
      const pid = programId(id);
      const c = m.charter;
      await registerProgram(db, { id: pid, name: m.name, objective: c.objective, primary_metric_id: c.primary_metric.id, owner_role: managerRole(id), status: 'active' });
      await registerMetric(db, { ...c.primary_metric, kind: 'target', program_id: pid });
      for (const g of c.guard_metrics) await registerMetric(db, { ...g, kind: 'guard', program_id: pid });
      if (m.outbound) {
        await registerMetric(db, { id: `${id}_sends_24h`, program_id: pid, kind: 'guard', op: '<=',
          target: Math.max(...m.outbound.channels.map(ch => m.outbound.caps[ch].per_day)),
          read_probe: `SELECT COUNT(*) AS value FROM guard_ledger WHERE pack = '${id}' AND decision = 'sent' AND at >= datetime('now', '-1 day')`,
          description: 'sends in the last day never exceed the largest per-day cap' });
      }
      await recordDecision(db, { id: decisionId, program_id: pid, decision: `Enable pack ${id} (${m.name}) after the person saw its enable card`,
        authority: `person:${by}`, prediction: `${c.primary_metric.id} ${c.primary_metric.op} ${c.primary_metric.target} within 168 h`,
        revert_path: `disablePack('${id}')`, now: t });
      await ensureItem(db, { id: `PACKPLUS-${id}-1`, title: `Improve pack ${id}: find the largest gap against ${c.primary_metric.id} and file the change`, kind: 'plus',
        project: pid, owner_role: managerRole(id), done_check: `an improvement for ${id} merged and its primary metric re-read`, priority: 30 });
    }
    // The manager role: its items are dispatched by the seed tick like any other role's.
    await run(db, `INSERT OR REPLACE INTO roles (id, role, project, tick_every, model) VALUES (?,?,?,?,?)`,
      managerRole(id), managerRole(id), null, 1, config.manager_model || 'default');
    await run(db, `UPDATE packs_registry SET enabled = 1, enabled_by = ?, enabled_at = ?, card_text_shown = ?, decision_id = ?, disabled_at = NULL WHERE id = ?`,
      String(by), iso(t), String(cardText), decisionId, id);
    return { ok: true, decisionId, kernelRecords: kernel };
  }

  // One action, fully reversible; the pack's loops stop on the next tick and the guard refuses its sends at once.
  async function disablePack(id) {
    const r = await row(id);
    if (!r) return { ok: false, reason: 'unknown_pack' };
    await run(db, `UPDATE packs_registry SET enabled = 0, disabled_at = ? WHERE id = ?`, iso(now()), id);
    await run(db, `DELETE FROM roles WHERE id = ?`, managerRole(id));
    if (await hasTable(db, 'kernel_programs')) await run(db, `UPDATE kernel_programs SET status = 'paused' WHERE id = ?`, programId(id));
    return { ok: true };
  }

  const isEnabled = async id => !!(await first(db, `SELECT 1 AS x FROM packs_registry WHERE id = ? AND enabled = 1`, id));
  const record = (id, loop, tickId, outcome, error, ms) => run(db, `INSERT INTO packs_runs (pack_id, loop_id, tick_id, outcome, error, ms, at) VALUES (?,?,?,?,?,?,?)`,
    id, loop, tickId ?? null, outcome, error ? String(error).slice(0, 300) : null, ms, iso(now()));

  // US-21-R05, R07: guarded tick steps for ENABLED packs only. Pass as runTick's extraSteps.
  async function packSteps() {
    const steps = [];
    for (const r of await all(db, `SELECT * FROM packs_registry WHERE enabled = 1 ORDER BY id`)) {
      const m = JSON.parse(r.manifest_json);
      for (const loop of m.loops) {
        steps.push({
          name: `pack:${m.id}:${loop.id}`,
          async run(_db, ctx) {
            if (ctx.tickId % loop.every_ticks !== 0) return;
            if (!(await isEnabled(m.id))) return;                       // disabled since the step list was built
            const sw = await engagedSwitches(db);
            if (sw.has('global') || sw.has(`pack:${m.id}`)) { await record(m.id, loop.id, ctx.tickId, 'skipped_killed', null, 0); return; }
            const started = now();
            try {
              const en = parseEntry(loop.entry);
              const mod = await importer(path.resolve(r.source_dir, en.module));
              const fn = mod[en.export];
              if (typeof fn !== 'function') throw new Error(`entry ${loop.entry} is not a function`);
              await withTimeout(fn({ db: sandboxDb(db, m.id), ctx: sandboxCtx(ctx), now, pack: m, settings: config.packs?.[m.id] || {}, guard: boundGuard(m.id) }), timeoutMs);
              await record(m.id, loop.id, ctx.tickId, 'ok', null, now() - started);
            } catch (e) {
              await record(m.id, loop.id, ctx.tickId, e.timeout ? 'timeout' : 'error', e.message, now() - started);
              ctx.errors.push(`pack:${m.id}:${loop.id}: ${e.message}`);
              await ensureItem(db, { id: `PACKFAIL-${m.id}-${loop.id}-${iso(now()).slice(0, 13).replace(' ', 'T')}`,
                title: `Pack ${m.id} loop ${loop.id} failed: ${e.message}`, owner_role: managerRole(m.id),
                done_check: `the next run of ${m.id}:${loop.id} completes`, priority: 0, project: programId(m.id) });
            }
          },
        });
      }
    }
    return steps;
  }

  // A pack only ever gets a guard bound to its own id: it cannot send as another pack (US-21-R08).
  function boundGuard(packId) {
    return freezeGuard({
      send: req => guard.send({ ...req, pack: packId }),
      consent: {
        request: a => guard.consent.request({ ...a, pack: packId }), grant: a => guard.consent.grant({ ...a, pack: packId }),
        confirm: t => guard.consent.confirm(t), revoke: a => guard.consent.revoke(a),
      },
      unsubscribe: a => guard.unsubscribe(a), suppress: a => guard.suppress(a),
      stats: () => guard.stats(packId),
    });
  }

  return {
    guard, register, enablePack, disablePack, packSteps, boundGuard,
    setSwitch: (scope, on, reason) => setSwitch(db, scope, on, reason, now()),
    status: async () => all(db, `SELECT id, class, enabled, enabled_by, enabled_at, decision_id, rung_ceiling FROM packs_registry ORDER BY id`),
  };
}
