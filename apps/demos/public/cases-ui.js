// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
import { playCase } from "./engine.js";
const el = (tag, text, cls) => { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (cls) e.className = cls; return e; };
const data = await (await fetch("cases.json")).json();
const list = document.getElementById("list");
for (const c of data.cases) {
  const r = playCase(c), card = el("div", "", "card"); card.append(el("h2", c.title), el("p", c.situation, "mut"));
  const steps = el("div"); let n = 0;
  const reveal = el("button", "Try the next surface", "sec"), end = el("div");
  const show = () => {
    if (n < r.steps.length) { const s = r.steps[n++]; const d = el("div", "", "ev"); d.append(el("b", `surface ${n}`), document.createTextNode(` ${s.surface}: `), el("span", s.result, s.worked ? "ok" : "bad")); steps.append(d); }
    if (n === r.steps.length) {
      reveal.remove();
      if (r.disposition === "resolved") end.append(el("p", `Resolved via: ${r.via}. ${c.lesson || ""}`, "ok"));
      else { end.append(el("p", `Every surface tried. ${r.reversibleAttempt || ""} The step is gated, and the system takes its next item.`, "warn")); const g = r.card; end.append(el("pre", `What: ${g.what}\nWhy gated: ${g.why}\nPrepared: ${g.prepared}\nDefault in effect: ${g.default}\nClosing probe: ${g.probe}`)); }
      if (r.disposition === "resolved" && r.residualGate) { const g = r.residualGate; end.append(el("pre", `Residual owner card\nWhat: ${g.what}\nWhy gated: ${g.why}\nDefault in effect: ${g.default}\nClosing probe: ${g.probe}`)); }
    }
  };
  reveal.onclick = show; card.append(steps, reveal, end); list.append(card);
}
