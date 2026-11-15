// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// core/specloop: the specification-to-code loop. Nobody asks for a specified capability to be built: every tick this module
// reads the specifications' implementation-status sections, checks each BUILT label against the code, and keeps one work item
// per capability that is not truthfully BUILT. Each item carries a derived target file and test, so the runner can start on
// it with no person naming anything; when the line turns BUILT and the code is there, the item closes; when a BUILT line
// stops being true, it reopens. The remaining count is written where the public metrics read it (org.spec_remaining).
//   parseSpec(name, text)              -> status rows (same ids and labels as tools/spec_backlog.py)
//   deriveTarget(row)                  -> { target, test }  from the paths the line names, else from the capability name
//   sync({ db, now, loadSpecs, exists }) -> one sweep; idempotent
//   fileSource / repoSource            -> the two ways to supply loadSpecs and exists (a file port, or a code host over fetch)
// Ports: db, now() ms, loadSpecs() -> [{ name, text }], exists(path) -> boolean. No ambient state, no secrets.
const iso = ms => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const LABEL = /\b(BUILT|RUNNING|PLANNED|NOT COVERED)\b/g;
const HEADING = /^#{2,3}\s+.*implementation status/i;
const TICKS = /`([^`\n]+)`/g;
const PATHLIKE = /^[\w.\-/]+$/;
const FILELIKE = /^[\w-]+\.(js|mjs|py|sql|json|jsonc|md|yml|toml|sh|html)$/;
const ACTIVE = `('open','ready','claimed','blocked')`;
export const PROJECT = 'spec-to-code';
export const AWAITING = 'awaiting target: name a file in the target map'; // the wait state this loop removes (core/runner/selfdoer.js)

export function pathsIn(text) {
  const out = [];
  for (const m of String(text).matchAll(TICKS)) {
    const t = m[1].trim().replace(/\/+$/, '');
    if (t.includes('/') && PATHLIKE.test(t) && !/^(http|\/|~)/.test(t)) out.push(t);
    else if (FILELIKE.test(t)) out.push(t);
  }
  return out;
}

function* rowsOf(section) {
  for (const line of section) {
    const t = line.trim();
    if (t.startsWith('|')) {
      const cells = t.replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
      if (cells.length >= 2 && !/^[-: ]*$/.test(cells[0]) && !['capability', 'area', 'item'].includes(cells[0].toLowerCase())) yield [cells[0], cells.slice(1).join(' ')];
    } else if (t.startsWith('- ') || t.startsWith('* ')) {
      const body = t.slice(2), i = body.indexOf(':');
      yield i >= 0 && body.slice(i + 1) ? [body.slice(0, i), body.slice(i + 1)] : [body.slice(0, 100), body];
    }
  }
}

export function parseSpec(name, text) {
  const num = Number((String(name).match(/US-SPEC-(\d+)/) || [])[1] || 0);
  let inside = false, section = null;
  for (const line of String(text).split(/\r?\n/)) {
    if (HEADING.test(line)) { inside = true; section = []; continue; } // the last status section wins, as in the Python tool
    if (inside && /^##\s/.test(line)) inside = false;
    if (inside) section.push(line);
  }
  if (!section) return [];
  const spec = `US-SPEC-${String(num).padStart(2, '0')}`, out = [];
  let k = 0;
  for (const [cap, status] of rowsOf(section)) {
    k++;
    const labels = status.match(LABEL);
    if (!labels) continue;
    let label = labels[0];
    if (label === 'RUNNING') label = labels.includes('BUILT') ? 'BUILT' : 'RUNNING_ONLY';
    const capability = cap.replace(/[`*]/g, '').trim().slice(0, 140);
    out.push({ id: `${spec}-${k}`, spec, n: k, num, capability, label, paths: pathsIn(`${cap} ${status}`) });
  }
  return out;
}

const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(w => w.length > 2 && !['the', 'and', 'for', 'with', 'from'].includes(w)).slice(0, 3).join('-');

/** Where the doer writes. Named paths win; otherwise a module directory is derived from the capability. Never empty. */
export function deriveTarget(row) {
  const named = row.paths.filter(p => !/\.test\.(js|mjs)$|(^|\/)test_[\w]+\.py$/.test(p) && !p.endsWith('.md'));
  const namedTest = row.paths.find(p => /\.test\.(js|mjs)$|(^|\/)test_[\w]+\.py$/.test(p)) || null;
  let target = named.find(p => /\.[a-z]+$/.test(p) && p.includes('/')) || null;
  const dir = named.find(p => !/\.[a-z]+$/.test(p));
  if (!target && dir) target = `${dir}/index.js`;
  if (!target) target = `core/spec${String(row.num).padStart(2, '0')}-${slug(row.capability) || 'capability'}/index.js`;
  const base = target.replace(/\/[^/]+$/, '');
  const test = namedTest || (target.endsWith('.py') ? `tests/test_${base.split('/').pop().replace(/-/g, '_')}.py` : `${base}/${base.split('/').pop()}.test.js`);
  return { target, test };
}

const doneCheck = (row, t) => `${row.spec} status row "${row.capability}" reads BUILT, names the file, and the tests it names pass; spec: ${row.id}; target: ${t.target}; test: ${t.test}`;

export async function sync({ db, now = () => Date.now(), loadSpecs, exists = async () => true, config = {} }) {
  const at = iso(now());
  const out = { specs: 0, lines: 0, built: 0, remaining: 0, false_built: 0, filed: 0, closed: 0, reopened: 0, released: 0, error: null };
  const run = (sql, ...a) => db.prepare(sql).bind(...a).run();
  const first = (sql, ...a) => db.prepare(sql).bind(...a).first();
  let specs;
  try { specs = await loadSpecs(); } catch (e) { out.error = String(e && e.message || e).slice(0, 300); specs = null; }
  if (!specs || !specs.length) {
    out.error = out.error || 'no specifications found';
    // An unreadable source is unmeasured, never zero: file one item about the source itself instead of closing anything.
    await run(`INSERT OR IGNORE INTO items (id, title, kind, project, owner_role, done_check, closing_probe, priority, status) VALUES ('SPECLOOP-SOURCE', 'Specification source cannot be read', 'fix', ?, 'operations', 'specloop_runs has a row with error NULL', 'SELECT error FROM specloop_runs ORDER BY id DESC LIMIT 1', 10, 'ready')`, PROJECT);
    await run(`INSERT INTO specloop_runs (at, specs, lines, built, remaining, false_built, filed, closed, reopened, released, error) VALUES (?,0,0,0,0,0,0,0,0,0,?)`, at, out.error);
    return out;
  }
  await run(`UPDATE items SET status='done', disposition='specification source readable again', updated_at=? WHERE id='SPECLOOP-SOURCE' AND status IN ${ACTIVE}`, at);
  out.specs = specs.length;
  const counts = { BUILT: 0, RUNNING_ONLY: 0, PLANNED: 0, 'NOT COVERED': 0 };
  for (const s of specs) for (const row of parseSpec(s.name, s.text)) {
    out.lines++;
    let truthful = true;
    if (row.label === 'BUILT') {
      truthful = false;
      for (const p of row.paths) if (await exists(p)) { truthful = true; break; }
    }
    const isBuilt = row.label === 'BUILT' && truthful;
    counts[isBuilt ? 'BUILT' : row.label === 'BUILT' ? 'PLANNED' : row.label]++;
    if (row.label === 'BUILT' && !truthful) out.false_built++;
    const t = deriveTarget(row);
    await run(`INSERT INTO specloop_lines (id, spec, capability, label, truthful, target, test, item_id, first_seen, last_seen, built_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET capability=excluded.capability, label=excluded.label, truthful=excluded.truthful, target=excluded.target, test=excluded.test, item_id=excluded.item_id, last_seen=excluded.last_seen, built_at=COALESCE(specloop_lines.built_at, excluded.built_at)`,
      row.id, row.spec, row.capability, row.label, truthful ? 1 : 0, t.target, t.test, row.id, at, at, isBuilt ? at : null);
    if (!isBuilt) await run(`UPDATE specloop_lines SET built_at=NULL WHERE id=?`, row.id);
    const item = await first(`SELECT status, disposition FROM items WHERE id=?`, row.id);
    if (isBuilt) {
      if (item && ['open', 'ready', 'blocked'].includes(item.status)) { await run(`UPDATE items SET status='done', disposition='specification line reads BUILT and the code it names exists', blocker=NULL, updated_at=? WHERE id=?`, at, row.id); out.closed++; }
      continue;
    }
    const verb = row.label === 'BUILT' ? 'Make true (labelled BUILT, code missing)' : row.label === 'PLANNED' ? 'Build' : row.label === 'RUNNING_ONLY' ? 'Generalize (runs elsewhere, no code here)' : 'Cover';
    const title = `${verb}: ${row.capability} (${row.spec})`, check = doneCheck(row, t);
    const priority = (row.label === 'BUILT' ? 20 : 30) + row.num;
    if (!item) {
      await run(`INSERT INTO items (id, title, kind, project, owner_role, done_check, closing_probe, priority, status) VALUES (?,?,?,?,?,?,?,?, 'ready')`,
        row.id, title, row.label === 'BUILT' ? 'fix' : 'work', PROJECT, config.owner_role || 'staff', check, `specloop_lines.built_at IS NOT NULL for ${row.id}`, priority);
      out.filed++;
    } else if (item.status === 'blocked' && item.disposition === AWAITING) {
      await run(`UPDATE items SET status='ready', disposition=NULL, done_check=?, updated_at=? WHERE id=?`, check, at, row.id); out.released++;
    } else if (['done', 'superseded', 'cancelled'].includes(item.status)) {
      // closed while the line is not BUILT: the claim regressed or the close was wrong. Nothing leaves the set that way.
      await run(`UPDATE items SET status='ready', disposition=NULL, title=?, done_check=?, updated_at=? WHERE id=?`, title, check, at, row.id); out.reopened++;
    }
  }
  out.built = counts.BUILT;
  out.remaining = counts.PLANNED + counts.RUNNING_ONLY + counts['NOT COVERED'];
  // A line that disappeared from the specifications: its item is superseded with the evidence, never dropped.
  const gone = (await db.prepare(`SELECT id FROM specloop_lines WHERE last_seen < ?`).bind(at).all()).results || [];
  for (const g of gone) {
    await run(`UPDATE items SET status='superseded', disposition='status line no longer in the specification', updated_at=? WHERE id=? AND status IN ('open','ready','blocked')`, at, g.id);
    await run(`DELETE FROM specloop_lines WHERE id=?`, g.id);
  }
  const summary = { ...counts, total: out.lines, remaining: out.remaining, built_share: Math.round(1000 * counts.BUILT / (out.lines || 1)) / 1000, false_built: out.false_built, at };
  await run(`INSERT INTO org (key, value) VALUES ('spec_remaining', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, JSON.stringify(summary));
  await run(`INSERT INTO specloop_runs (at, specs, lines, built, remaining, false_built, filed, closed, reopened, released, error) VALUES (?,?,?,?,?,?,?,?,?,?,NULL)`,
    at, out.specs, out.lines, out.built, out.remaining, out.false_built, out.filed, out.closed, out.reopened, out.released);
  return out;
}

/** Specifications and code as files behind one readFile port (Cloud Run, tests, a checkout). */
export function fileSource({ readFile, spec_paths = [] }) {
  return {
    loadSpecs: async () => Promise.all(spec_paths.map(async p => ({ name: p.split('/').pop(), text: await readFile(p) }))),
    exists: async p => { for (const c of [p, `${p}/index.js`, `${p}/README.md`]) { try { if ((await readFile(c)) != null) return true; } catch { /* next candidate */ } } return false; },
  };
}

/** Specifications and code on a code host with the contents and trees API shape (a Worker has no file system).
 *  cfg: { api, spec_repo, spec_dir, code_repo, ref }. token is optional: public repositories need none. */
export function repoSource({ fetch, token = null, api = 'https://api.github.com', spec_repo, spec_dir = 'specs', code_repo, ref = 'main' }) {
  const headers = { accept: 'application/vnd.github+json', 'user-agent': 'ultrastable-specloop', ...(token ? { authorization: `Bearer ${token}` } : {}) };
  const get = async (url, h = headers) => { const r = await fetch(url, { headers: h }); if (!r.ok) throw new Error(`${r.status} ${url.replace(api, '')}`); return r; };
  let tree = null;
  const paths = async () => {
    if (tree) return tree;
    tree = new Set();
    for (const repo of [code_repo, spec_repo].filter(Boolean)) {
      const j = await (await get(`${api}/repos/${repo}/git/trees/${ref}?recursive=1`)).json();
      for (const e of j.tree || []) tree.add(e.path);
    }
    return tree;
  };
  return {
    loadSpecs: async () => {
      const list = await (await get(`${api}/repos/${spec_repo}/contents/${spec_dir}?ref=${ref}`)).json();
      const files = (Array.isArray(list) ? list : []).filter(f => /^US-SPEC-\d+.*\.md$/.test(f.name)).sort((a, b) => a.name.localeCompare(b.name));
      return Promise.all(files.map(async f => ({ name: f.name, text: await (await get(`${api}/repos/${spec_repo}/contents/${spec_dir}/${f.name}?ref=${ref}`, { ...headers, accept: 'application/vnd.github.raw+json' })).text() })));
    },
    exists: async p => { const t = await paths(); if (t.has(p)) return true; if (!p.includes('/')) for (const q of t) if (q.endsWith('/' + p)) return true; return false; },
  };
}

/** The source a deployment gets with no configuration beyond where its repositories are. Null when nothing can be read. */
export function sourceFor({ config = {}, readFile, fetch, token }) {
  const c = config || {};
  if (readFile && Array.isArray(c.spec_paths) && c.spec_paths.length) return fileSource({ readFile, spec_paths: c.spec_paths });
  if (fetch && c.spec_repo) return repoSource({ fetch, token, api: c.api, spec_repo: c.spec_repo, spec_dir: c.spec_dir, code_repo: c.code_repo, ref: c.ref });
  return null;
}

/** The tick step. On by default: it is skipped only when config.enabled === false or no source can be built. */
export function step({ db, now, config = {}, readFile, fetch, token }) {
  if (config.enabled === false) return null;
  const src = sourceFor({ config, readFile, fetch, token });
  if (!src) return null;
  return { name: 'specloop', run: async (_db, ctx) => {
    const r = await sync({ db, now, config, ...src });
    ctx.notes.push(r.error ? `specloop: source unreadable (${r.error}); nothing closed` : `specloop: ${r.remaining} of ${r.lines} capabilities not built (${r.false_built} false BUILT), ${r.filed} filed, ${r.released} released, ${r.closed} closed, ${r.reopened} reopened`);
  } };
}
