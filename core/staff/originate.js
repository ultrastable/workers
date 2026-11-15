// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Origination (US-SPEC-03 s4): once a day, a program with fewer than 3 open roadmap items asks a research agent for one
// improvement in the fields TITLE, WHY, code-task, code-anchor, EDIT, under a daily cap. The research agent is a port.
import { first, run, iso, TERMINAL_SQL } from '../kernel/util.js';
import { isControlPlane, planeOfProgram, logAction, dayOf } from './index.js';

const FIELDS = { title: 'TITLE', why: 'WHY', code_task: 'code-task', code_anchor: 'code-anchor', edit: 'EDIT' };

// Parse 'FIELD: value' lines; a value runs until the next field label. Returns { fields, missing }.
export function parseProposal(text) {
  const labels = Object.values(FIELDS).map(l => l.replace('-', '[-_ ]')).join('|');
  const re = new RegExp(`^\\s*(${labels})\\s*:\\s*`, 'i');
  const out = {}; let cur = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = re.exec(line);
    if (m) {
      const key = Object.keys(FIELDS).find(k => FIELDS[k].toLowerCase() === m[1].toLowerCase().replace(/[_ ]/, '-'));
      cur = key; out[key] = line.slice(m[0].length).trim();
    } else if (cur && line.trim()) out[cur] += `\n${line.trim()}`;
  }
  const missing = Object.keys(FIELDS).filter(k => !out[k]);
  return { fields: out, missing };
}

const ROADMAP = `i.kind IN ('work','plus') AND i.status NOT IN ${TERMINAL_SQL}
  AND (i.project = ? OR i.project IN (SELECT id FROM kernel_projects WHERE program_id = ?))`;

// Returns { filed: itemId } or { skipped | refused: reason }. Every ask of the research agent leaves a staff_originations row.
export async function originate(tools, personaId, { program_id = null, tickId = null } = {}) {
  const { db, ports, config: c } = tools, pz = await tools.identity(personaId), now = tools.now(), today = dayOf(now);
  const program = program_id ?? pz.program_id;
  if (!pz.authority.includes('originate')) return tools.refuse(pz, 'originate', program, 'authority', `originate is not in the decision authority of ${pz.id}`, tickId);
  // US-02-R08, R09: a persona originates in its own program and plane only.
  if (!program || program !== pz.program_id || (await planeOfProgram(db, program)) !== pz.plane) return tools.refuse(pz, 'originate', program, 'lane', 'a persona originates roadmap work in its own program and plane only', tickId);
  if (!ports.research) return { skipped: 'no research agent is configured' };
  if (await first(db, `SELECT 1 AS x FROM staff_originations WHERE program_id = ? AND day = ?`, program, today)) return { skipped: 'already asked today' };
  const open = (await first(db, `SELECT COUNT(*) AS n FROM items i WHERE ${ROADMAP}`, program, program)).n;
  if (open >= c.roadmap_min) return { skipped: `${open} open roadmap item(s)` };
  const used = (await first(db, `SELECT COUNT(*) AS n FROM staff_originations WHERE day = ? AND item_id IS NOT NULL`, today)).n;
  if (used >= c.origination_daily_cap) return { skipped: `daily cap of ${c.origination_daily_cap} reached` };

  let text, reason = null, f = {};
  try { text = await ports.research({ program_id: program, persona: pz.id, charter: pz.charter, open_roadmap_items: open, fields: Object.values(FIELDS) }); }
  catch (e) { reason = `research agent failed: ${e.message}`; }
  if (!reason) {
    const p = parseProposal(text); f = p.fields;
    if (p.missing.length) reason = `proposal lacks: ${p.missing.map(k => FIELDS[k]).join(', ')}`;
    else if (isControlPlane(f.code_task, c)) reason = `${f.code_task} is a control-plane file (US-02-R10)`;
    else if (ports.readFile) {
      let src = null; try { src = await ports.readFile(f.code_task); } catch (e) { reason = `cannot read ${f.code_task}: ${e.message}`; }
      if (!reason) { const n = String(src ?? '').split(f.code_anchor).length - 1; if (n !== 1) reason = `the anchor occurs ${n} time(s) in ${f.code_task}; exactly once is required`; }
    }
  }
  const nowIso = iso(now);
  const itemId = reason ? null : `ROADMAP-${program}-${today.replace(/-/g, '')}`;
  if (itemId && await first(db, `SELECT 1 AS x FROM items WHERE id = ?`, itemId)) reason = 'an origination item for today already exists';
  await run(db, `INSERT INTO staff_originations (program_id, persona_id, day, title, why, code_task, code_anchor, edit, item_id, reason, at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    program, pz.id, today, f.title ?? null, f.why ?? null, f.code_task ?? null, f.code_anchor ?? null, f.edit ?? null, reason ? null : itemId, reason, nowIso);
  if (reason) { await tools.refuse(pz, 'originate', program, reason.includes('control-plane') ? 'control_plane' : 'precondition', reason, tickId); return { refused: reason }; }
  await run(db, `INSERT INTO items (id, title, kind, project, owner_role, done_check, closing_probe, priority, status) VALUES (?,?,?,?,?,?,?,?, 'ready')`,
    itemId, f.title.slice(0, 300), 'work', program, 'staff', `in ${f.code_task} at the anchor: ${f.edit}`.slice(0, 500), `the edit is present in ${f.code_task} and its tests pass`, 30);
  // The doer line: the validated code task travels with the item.
  // Without a file reader the anchor was not validated, so no doer is assigned (the item ranks first as a no-doer item).
  if (ports.readFile) await run(db, `INSERT INTO kernel_item_meta (item_id, doer) VALUES (?, ?) ON CONFLICT(item_id) DO UPDATE SET doer = excluded.doer`, itemId, `code-task:${f.code_task}`);
  await logAction(db, pz, { op: 'originate', item_id: itemId, field: 'item', from: null, to: 'ready', evidence: `why: ${f.why}`.slice(0, 300), tick_id: tickId, at: nowIso });
  return { filed: itemId };
}
