// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// The org-tick step: the system applies ignorance mapping to its own work items. Opt-in per deployment (config.ignorance.enabled).
// Subjects are the open items; the miner asks what an item lacks (a closing probe, an owner, a way to be wrong) and how long it has aged.
import { createRegistry, run, minersFor, UIA } from './index.js';
import { dbStore } from './store.js';
import { createModelPort } from '../modelport/index.js';
import { githubModelsEndpoint, workersAiEndpoint, redTeamModel } from './models.js';

const DAY = 864e5;
const parse = s => Date.parse(String(s).replace(' ', 'T') + 'Z');
const gap = (kind, subject, key, text, severity = 2, how) => ({ id: `${kind}:${subject}:${key}`, kind, region: kind === 'red_team' ? 'unknown_unknown' : 'known_unknown', subject, text, severity, auto: true, how });

export async function itemSubjects(db, limit = 200) {
  const rows = (await db.prepare(`SELECT id, title, kind, owner_role, done_check, closing_probe, status, blocker, created_at FROM items WHERE status IN ('open','ready','claimed','blocked') ORDER BY priority, created_at LIMIT ?`).bind(limit).all()).results || [];
  return rows.map(r => ({ id: 'item:' + r.id, type: 'item', title: r.title, claim: r.done_check, evidence: [], limits: r.blocker || '', who: r.owner_role, probe: r.closing_probe, created_at: r.created_at, status: r.status }));
}
// what an item does not say about how it could turn out wrong, and how long it has waited
export function itemMiner({ subjects, config = {} }) {
  const out = [], now = config.now || Date.now(), aged = config.aged_days ?? 7;
  for (const s of subjects.filter(x => x.type === 'item')) {
    if (!s.probe) out.push(gap('evidence_gap', s.id, 'no-probe', `"${s.title}" has no closing probe, so nothing could show that it failed.`, 3, 'Add a probe that can fail.'));
    const age = (now - parse(s.created_at)) / DAY;
    if (Number.isFinite(age) && age > aged) out.push(gap('evidence_gap', s.id, 'aged', `"${s.title}" has been open ${Math.floor(age)} days. What is the unstated reason it is not moving?`, 2, 'State the real blocker or close it with a disposition.'));
    if (s.status === 'blocked') out.push(gap('contradiction', s.id, 'blocked', `"${s.title}" is blocked: ${s.limits || 'no reason recorded'}. Has every other surface been tried?`, 2, 'Red-team the blocker across every surface.'));
  }
  return out;
}

// model route from configuration: aliases in config.ignorance.models, endpoints from what the environment offers (never a secret value in config)
export function modelFor({ config = {}, env = {}, fetch: f }) {
  const c = config.ignorance || {}, aliases = c.models;
  if (!aliases || !c.model_alias) return { model: null, author_family: c.author_family || null };
  const endpoints = {};
  const tok = env[c.token_env || 'GITHUB_TOKEN'];
  if (tok) endpoints.github_models = githubModelsEndpoint({ fetch: f, token: tok });
  if (env.AI) endpoints.workers_ai = workersAiEndpoint({ ai: env.AI });
  const port = createModelPort({ config: { aliases }, endpoints, env: {} });
  if (!port.resolve(c.model_alias).ok) return { model: null, author_family: c.author_family || null };
  return { model: redTeamModel(port, c.model_alias), author_family: c.author_family || null };
}

export function ignoranceStep({ db, now, config = {}, env = {}, fetch: f }) {
  return { name: 'ignorance', run: async (_db, ctx) => {
    const registry = createRegistry({ store: dbStore(db), now });
    const { model, author_family } = modelFor({ config, env, fetch: f });
    const subjects = await itemSubjects(db);
    const r = await run({ registry, subjects, miners: [...minersFor().slice(0, 0), itemMiner], model, author_family, budget: config.ignorance?.budget ?? 3, now, config: { now: now() } });
    ctx.notes.push(`ignorance: ${r.metrics.open} open, ${r.metrics.opened} new, ${r.metrics.closed} closed, ${Math.round(r.metrics.challenged_share * 100)}% challenged${model ? '' : ' (rule-based red team)'}${r.errors.length ? `, model errors ${r.errors.length}` : ''}`);
    await dbStore(db).put('ignorance:last', JSON.stringify({ at: r.at, metrics: r.metrics, frontier: r.frontier }));
  } };
}
export { UIA };
