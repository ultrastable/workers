// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
import { simulate, SURFACE_LABELS, DEFAULT_SURFACES } from "./engine.js";
const $ = (id) => document.getElementById(id);
const el = (tag, text, cls) => { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (cls) e.className = cls; return e; };
const surf = $("surfaces"); const boxes = {};
for (const [k, label] of Object.entries(SURFACE_LABELS)) { const l = el("label", "", "chk"); const c = document.createElement("input"); c.type = "checkbox"; c.checked = DEFAULT_SURFACES[k]; boxes[k] = c; l.append(c, label); surf.append(l); }
let run = null, shown = 0;
function compute() { try { run = simulate($("idea").value, Object.fromEntries(Object.entries(boxes).map(([k, c]) => [k, c.checked])), { ticks: +$("ticks").value }); } catch (e) { run = null; $("out").replaceChildren(el("p", e.message, "bad")); } }
function table(head, rows) { const t = el("table"); const th = el("tr"); head.forEach((h) => th.append(el("th", h))); t.append(th); rows.forEach((r) => { const tr = el("tr"); r.forEach((c) => tr.append(el("td", String(c)))); t.append(tr); }); return t; }
function render() {
  if (!run) return; const out = $("out"); out.replaceChildren();
  const upto = Math.min(shown, run.reports.length);
  const m = run.metrics; out.append(Object.assign(el("div", "", "card"), {}));
  out.lastChild.append(el("p", `Idea: ${run.idea.title} (${run.idea.type}). Tick ${upto} of ${run.reports.length}. Done ${m.done}, plus items shipped ${m.pluses}, gated ${m.gated}, blocked ${m.blocked}, questions asked ${m.questionsAsked}.`));
  const tl = el("div", "", "card"); tl.append(el("h2", "Timeline"));
  run.events.filter((e) => e.tick <= upto).forEach((e) => { const d = el("div", "", "ev"); d.append(el("b", e.tick ? `tick ${e.tick} ${e.type}` : "stage"), document.createTextNode(" " + e.text)); tl.append(d); });
  out.append(tl);
  if (upto) { const r = el("div", "", "card"); r.append(el("h2", `Report, tick ${upto}`)); run.reports[upto - 1].lines.forEach((l) => r.append(el("p", l))); out.append(r); }
  const cards = run.cards.filter((c) => run.events.some((e) => e.type === "gate" && e.card === c && e.tick <= upto) || c.why === "failed twice");
  const oc = el("div", "", "card"); oc.append(el("h2", `Owner cards (${cards.length})`));
  if (!cards.length) oc.append(el("p", "None yet. A card appears only for a step that is irreversible and identity-bound, after the system has made it reversible.", "mut"));
  cards.forEach((c) => oc.append(table(["Field", "Value"], [["What", c.what], ["Why gated", c.why], ["Prepared", c.prepared], ["Default in effect", c.default], ["Closing probe", c.probe]])));
  out.append(oc);
  const tr = el("div", "", "card"); tr.append(el("h2", "Autonomy per area")); tr.append(table(["Area", "Level", "Score", "Verified", "Failed"], Object.entries(run.ledger).map(([a, v]) => [a, v.rung, v.trust, v.verified, v.failed]))); out.append(tr);
  const bl = el("div", "", "card"); bl.append(el("h2", "Backlog")); bl.append(table(["Id", "Item", "Owner", "State"], run.backlog.map((b) => [b.id, b.title, b.owner, b.state]))); out.append(bl);
}
$("ticks").oninput = () => { $("tn").textContent = $("ticks").value; };
$("run").onclick = () => { compute(); shown = run ? run.reports.length : 0; render(); };
$("step").onclick = () => { if (!run) compute(); shown = Math.min((shown || 0) + 1, run.reports.length); render(); };
for (const c of Object.values(boxes)) c.onchange = () => { run = null; shown = 0; };
compute(); shown = run ? run.reports.length : 0; render();
