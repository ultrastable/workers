// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Tests for the demos: engine invariants, case data, bundle size, and the public-safe guard.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { test } from "node:test";
import { simulate, playCase, readIdea, DEFAULT_SURFACES, SURFACE_LABELS } from "../public/engine.js";

const pub = new URL("../public/", import.meta.url);
const cases = JSON.parse(readFileSync(new URL("cases.json", pub), "utf8"));
const IDEAS = ["A booking marketplace for local repair shops", "A weekly newsletter about bike maintenance", "A reusable water bottle with a filter", "A tool that lints spreadsheets"];

test("same input gives the same run", () => {
  assert.deepEqual(simulate(IDEAS[0]), simulate(IDEAS[0]));
  assert.notDeepEqual(simulate(IDEAS[0]).events, simulate(IDEAS[1]).events);
});
test("idea types are detected", () => {
  assert.equal(readIdea(IDEAS[1]).type, "content"); assert.equal(readIdea(IDEAS[2]).type, "physical");
  assert.equal(readIdea(IDEAS[0]).type, "service"); assert.equal(readIdea(IDEAS[3]).type, "software");
  assert.throws(() => readIdea("   "), /empty/);
});
test("the loop never asks a question and every owner card has a default and a probe", () => {
  for (const idea of IDEAS) for (const surfaces of [DEFAULT_SURFACES, { ...DEFAULT_SURFACES, github: false, cloud: false }, Object.fromEntries(Object.keys(SURFACE_LABELS).map((k) => [k, true]))]) {
    const r = simulate(idea, surfaces); assert.equal(r.metrics.questionsAsked, 0);
    for (const e of r.events) assert.ok(!/\?/.test(e.text), "no question marks in events: " + e.text);
    for (const c of r.cards) { assert.ok(c.default && c.probe && c.prepared && c.why, "complete card " + c.item); }
    for (const rep of r.reports) { assert.equal(rep.lines.length, 4); assert.ok(!/\byou\b/i.test(rep.lines.join(" ")), "no 'you' as actor in reports"); }
  }
});
test("identity-bound steps are gated only when their surface is missing, and the loop keeps going", () => {
  const closed = simulate(IDEAS[0], DEFAULT_SURFACES, { ticks: 20 });
  assert.ok(closed.cards.some((c) => /legal entity/i.test(c.what)));
  assert.ok(closed.metrics.done >= 5, "work continues past gates");
  const open = simulate(IDEAS[0], Object.fromEntries(Object.keys(SURFACE_LABELS).map((k) => [k, true])), { ticks: 20 });
  assert.equal(open.backlog.filter((b) => b.state === "gated").length, 0);
});
test("missing non-identity surface takes a fallback, not a blocker", () => {
  const r = simulate(IDEAS[0], { ...DEFAULT_SURFACES, domain: false }, { ticks: 20 });
  assert.ok(r.events.some((e) => e.type === "remediate"));
  assert.equal(r.backlog.find((b) => b.id === "B-5").state, "done");
});
test("closed items propose pluses that enter the backlog", () => {
  const r = simulate(IDEAS[0], DEFAULT_SURFACES, { ticks: 25 });
  assert.ok(r.events.some((e) => e.type === "plus")); assert.ok(r.metrics.pluses >= 1);
});
test("failures are logged as gaps, never swallowed, and block only after two attempts", () => {
  for (const idea of IDEAS) { const r = simulate(idea, DEFAULT_SURFACES, { ticks: 30 });
    for (const g of r.gaps) assert.ok(g.symptom && g.next);
    for (const b of r.backlog.filter((x) => x.state === "blocked")) assert.ok(b.attempts >= 2); }
});
test("trust stays in range and maps to a rung", () => {
  const r = simulate(IDEAS[3], DEFAULT_SURFACES, { ticks: 30 });
  for (const v of Object.values(r.ledger)) { assert.ok(v.trust > 0.3 && v.trust < 1); assert.ok(["observed", "assisted", "delegated", "autonomous"].includes(v.rung)); }
});
test("cases: each ends resolved or gated with a complete card; none hands a step to a person", () => {
  assert.ok(cases.cases.length >= 6);
  for (const c of cases.cases) {
    const r = playCase(c); assert.ok(r.steps.length >= 2, c.id + " tried more than one surface");
    if (r.disposition === "gated") { const g = r.card; assert.ok(g.what && g.why && g.default && g.prepared && g.probe, c.id); assert.ok(r.reversibleAttempt, c.id + " made it reversible first"); }
    else assert.equal(r.disposition, "resolved", c.id);
  }
  assert.ok(cases.cases.map(playCase).some((r) => r.disposition === "gated"));
  assert.ok(cases.cases.map(playCase).some((r) => r.disposition === "resolved"));
});
test("public bundle is small (Cloudflare inline-upload lesson, BG-27)", () => {
  let total = 0; for (const f of readdirSync(pub)) total += statSync(new URL(f, pub)).size;
  assert.ok(total < 100_000, `bundle is ${total} bytes`);
});
test("public files name none of the banned terms", () => {
  const banned = JSON.parse(readFileSync(new URL("../publish.json", import.meta.url), "utf8")).banned.map((b) => new RegExp(b, "i"));
  for (const f of readdirSync(pub)) { const t = readFileSync(new URL(f, pub), "utf8"); for (const re of banned) assert.ok(!re.test(t), `${f} matches ${re}`); }
});
test("the built worker serves every public file under /demos/ and 404s the rest", async () => {
  const { build } = await import("../build-worker.mjs");
  const w = (await import("data:text/javascript," + encodeURIComponent(build()))).default;
  const r = await w.fetch(new Request("https://ultrastable.io/demos/")); assert.equal(r.status, 200); assert.match(r.headers.get("content-type"), /html/);
  assert.equal((await w.fetch(new Request("https://ultrastable.io/demos/engine.js"))).headers.get("content-type"), "text/javascript;charset=utf-8");
  assert.equal((await w.fetch(new Request("https://ultrastable.io/demos/nope"))).status, 404);
  assert.ok(build().length < 100_000);
});
