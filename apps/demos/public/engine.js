// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Bootstrap simulator engine. Deterministic model of the staged loop; no network, no accounts, no secrets.
// STATUS: the loop it models is BUILT (seed/ and platform/core/); this file is a MODEL of it (it never calls a model or an account).
// Works in the browser and in Node (ES module). Same input always gives the same run.

export const SURFACE_LABELS = {
  github: "Code host account", cloud: "Cloud hosting account", domain: "Domain and DNS",
  email: "Sending mailbox", entity: "Legal entity", payments: "Payment account",
};
export const DEFAULT_SURFACES = { github: true, cloud: true, domain: true, email: false, entity: false, payments: false };
export const LADDER = [[0.7, "autonomous"], [0.62, "delegated"], [0.56, "assisted"], [0, "observed"]];

export function hash(s) { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
export function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
export const rung = (t) => LADDER.find(([min]) => t >= min)[1];

const TYPES = [
  ["content", /\b(course|newsletter|podcast|book|blog|video|guide|magazine)\b/i],
  ["service", /\b(service|consult|agency|booking|marketplace|clinic|tutoring|repair)\b/i],
  ["physical", /\b(device|hardware|gadget|furniture|garment|food|bottle|bike|printer)\b/i],
];
export function readIdea(text) {
  const t = String(text || "").trim().replace(/\s+/g, " ");
  if (!t) throw new Error("idea is empty");
  const type = (TYPES.find(([, re]) => re.test(t)) || ["software"])[0];
  const title = t.length > 60 ? t.slice(0, 57).replace(/\s+\S*$/, "") + "..." : t;
  return { text: t, title, type };
}

// area is the (surface, action class) pair the trust ledger is kept per.
const item = (id, title, area, o = {}) => ({
  id, title, area, size: "S", owner: "staff", trigger: "on bootstrap", needs: [], priority: 50,
  irreversible: false, identityBound: false, probe: `${title} is observable in the repo or on a preview URL`, ...o,
});

export function planBacklog(idea, surfaces) {
  const b = [
    item("B-1", "Create repo, agent rules and role files", "ops/repo", { priority: 95, needs: ["github"], owner: "operations", probe: "agents/AGENTS.md exists on the default branch" }),
    item("B-2", "Write the idea brief and a ranked roadmap", "plan/docs", { priority: 90, owner: "project manager", needs: ["github"], probe: "ROADMAP.md lists every item with owner, trigger and probe" }),
  ];
  if (idea.type === "software") b.push(item("B-3", "Build the first working version with tests", "build/code", { priority: 85, size: "L", owner: "product manager", needs: ["github"], probe: "CI is green on the first version" }));
  if (idea.type === "content") b.push(item("B-3", "Draft the first three pieces and a publishing schedule", "build/content", { priority: 85, size: "M", owner: "product manager", needs: ["github"], probe: "three drafts and a schedule exist in the repo" }));
  if (idea.type === "service") b.push(item("B-3", "Write the service definition, intake flow and booking page", "build/code", { priority: 85, size: "M", owner: "product manager", needs: ["github"], probe: "the intake flow runs end to end on a preview" }));
  if (idea.type === "physical") b.push(item("B-3", "Write the specification and shortlist suppliers from public sources", "build/research", { priority: 85, size: "M", owner: "product manager", needs: ["github"], probe: "specification and supplier table exist with a source per row" }));
  b.push(
    item("B-4", "Deploy a preview and probe it", "ops/deploy", { priority: 80, needs: ["cloud"], owner: "operations", probe: "the preview URL answers 200" }),
    item("B-5", "Attach the domain to the preview", "ops/dns", { priority: 70, needs: ["domain"], owner: "operations", fallback: "keep the preview URL", probe: "the domain answers 200 over TLS" }),
    item("B-6", "Prepare a funding application packet", "biz/funding", { priority: 60, owner: "portfolio manager", size: "M", probe: "the packet validator reports no missing fields" }),
    item("B-7", "Register the legal entity", "legal/entity", { priority: 55, needs: ["entity"], irreversible: true, identityBound: true, owner: "portfolio manager", probe: "the registration number is recorded in the repo" }),
    item("B-8", "Open the payment account", "legal/payments", { priority: 50, needs: ["payments"], irreversible: true, identityBound: true, owner: "portfolio manager", probe: "the account id is recorded in the repo" }),
    item("B-9", "Send the launch announcement as the owner", "comms/send", { priority: 45, needs: ["email"], irreversible: true, identityBound: true, owner: "product manager", probe: "the sent message id is recorded in the repo" }),
  );
  return b;
}

export function roster(idea) {
  const base = ["portfolio manager", "project manager", "product manager", "operations", "reviewer"];
  return [...base, idea.type === "physical" ? "research staff" : "build staff"].map((name, i) => ({ name, model: i % 2 ? "model B" : "model A" }));
}

// Run the loop. Returns the full record; nothing here asks a question or waits for a person.
export function simulate(ideaText, surfaces = DEFAULT_SURFACES, opts = {}) {
  const ticks = opts.ticks ?? 14, idea = readIdea(ideaText), rand = rng(hash(idea.text));
  const backlog = planBacklog(idea, surfaces).map((x) => ({ ...x, state: "open", attempts: 0 }));
  const ledger = {}; const trust = (a) => (ledger[a] ??= { trust: 0.5, verified: 0, failed: 0 });
  const events = [], cards = [], gaps = [], reports = [], pluses = []; let planned = 0, nextGap = 1, plusN = 0;
  const log = (tick, type, text, extra = {}) => events.push({ tick, type, text, ...extra });
  log(0, "stage", `Read the idea: "${idea.title}" (${idea.type})`); log(0, "stage", `Detected ${Object.values(surfaces).filter(Boolean).length} of ${Object.keys(SURFACE_LABELS).length} surfaces`);
  const team = roster(idea); log(0, "stage", `Selected a roster of ${team.length}, two model families`); log(0, "stage", `Planned ${backlog.length} items, each with owner, trigger and closing probe`);
  const open = () => backlog.filter((x) => x.state === "open");
  for (let tick = 1; tick <= ticks; tick++) {
    planned++;
    const usePlus = planned % 5 === 0 && pluses.length; // 20% of pulls go to accepted pluses
    let it = usePlus ? pluses.shift() : null;
    if (!it) it = open().sort((a, b) => b.priority * (0.5 + trust(b.area).trust) - a.priority * (0.5 + trust(a.area).trust))[0];
    if (!it) { // empty backlog means audit and file gaps, never idle
      it = { id: `A-${tick}`, title: "Audit the repo against the idea and file gaps", area: "ops/audit", state: "open", attempts: 0, probe: "every open item has owner, trigger and probe", owner: "portfolio manager", needs: [], irreversible: false, identityBound: false };
      backlog.push(it);
    }
    const missing = it.needs.filter((n) => !surfaces[n]);
    let outcome, decided, next;
    if (missing.length && it.identityBound) {
      // Make it reversible first: prepare a draft the owner can sign in one step. Then gate it and move on.
      it.state = "gated";
      const card = { item: it.id, what: it.title, why: `irreversible and identity-bound (${missing.map((m) => SURFACE_LABELS[m]).join(", ")} not available to the system)`, prepared: "a complete draft packet and a preview, committed to the repo", default: "nothing is submitted, sent or paid", probe: it.probe };
      cards.push(card); log(tick, "gate", `Gate card opened for ${it.id}: ${card.what}`, { card });
      outcome = `${it.id} prepared and gated, owner card filed`; decided = "make it reversible, gate it, take the next item";
    } else if (missing.length) {
      it.state = "done"; trust(it.area).trust += 0.03; trust(it.area).verified++;
      log(tick, "remediate", `${missing.map((m) => SURFACE_LABELS[m]).join(", ")} unavailable; took the fallback: ${it.fallback || "construct the preview instead"}`);
      outcome = `${it.id} done by fallback`; decided = "next surface instead of a blocker";
    } else {
      it.attempts++;
      const p = Math.min(0.95, 0.7 + 0.5 * (trust(it.area).trust - 0.5)); // better ledger, better odds
      const prediction = `probe_pass >= 1 within 1 h (p=${p.toFixed(2)})`; log(tick, "predict", `${it.id}: ${prediction}`);
      if (rand() < p) {
        it.state = "done"; trust(it.area).trust += 0.02; trust(it.area).verified++; log(tick, "verify", `${it.id}: independent probe passed: ${it.probe}`);
        outcome = `${it.id} done and verified`; decided = "report as done";
        if (!it.id.startsWith("P-")) { // every closed item proposes one plus
          const pl = item(`P-${++plusN}`, `Plus for ${it.id}: add a check that would have caught the next failure`, it.area, { priority: 40, probe: "the new check fails when the behavior is broken" }); pl.attempts = 0; pl.state = "open"; pluses.push(pl); backlog.push(pl);
          log(tick, "plus", `Proposed ${pl.id}, accepted into the 20% plus share`);
        }
      } else {
        trust(it.area).failed++; trust(it.area).trust -= 0.02; log(tick, "verify", `${it.id}: probe failed; the failure is logged, not swallowed`);
        const g = { id: `G-${nextGap++}`, item: it.id, symptom: `${it.title} failed its probe on attempt ${it.attempts}`, next: it.attempts < 2 ? "retry with a corrected approach" : "stop retrying; block with owner and probe" }; gaps.push(g);
        if (it.attempts >= 2) { it.state = "blocked"; cards.push({ item: it.id, what: it.title, why: "failed twice", prepared: "failure logged with both attempts", default: "the item stays out of the release", probe: it.probe }); }
        outcome = `${it.id} failed verification, gap ${g.id} filed`; decided = g.next;
      }
    }
    next = open().sort((a, b) => b.priority - a.priority)[0]; const open_n = backlog.filter((x) => x.state === "blocked" || x.state === "gated").length;
    reports.push({ tick, lines: [`What happened: ${outcome}.`, `What I decided: ${decided}.`, `What is next: ${next ? next.id + " " + next.title : "audit and file gaps"}.`, `What is open: ${open_n} gated or blocked item(s), each with owner, default and probe.`] });
  }
  const done = backlog.filter((x) => x.state === "done");
  return { idea, surfaces, team, backlog, events, ledger: Object.fromEntries(Object.entries(ledger).map(([a, v]) => [a, { ...v, trust: +v.trust.toFixed(2), rung: rung(v.trust) }])), cards, gaps, reports,
    metrics: { done: done.length, pluses: done.filter((x) => x.id.startsWith("P-")).length, gated: backlog.filter((x) => x.state === "gated").length, blocked: backlog.filter((x) => x.state === "blocked").length, questionsAsked: 0 } };
}

// Case explorer: play a recorded blocker case. Each case lists the surfaces tried in order; the first that works wins.
export function playCase(c) {
  const steps = [];
  for (const s of c.surfaces) { steps.push({ surface: s.name, result: s.result, worked: !!s.worked }); if (s.worked) return { id: c.id, steps, disposition: "resolved", via: s.name, residualGate: c.gate || null }; }
  if (!c.gate) return { id: c.id, steps, disposition: "no-path" };
  return { id: c.id, steps, disposition: "gated", reversibleAttempt: c.reversible, card: c.gate };
}
