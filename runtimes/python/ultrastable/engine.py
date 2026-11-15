# SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
# Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
"""The heartbeat. One call to Engine.tick() is one pass of the control loop.

Every step is guarded: a failing step is recorded as an error and as a backlog item, and the
remaining steps still run (the "PID 1 never dies" rule inherited from AIOS).
"""
from __future__ import annotations
import json, math
from datetime import datetime, timedelta, timezone

from .agents import Result, build_agent, check_pairing
from .config import load_config, load_policy
from .store import Store, iso

OPS = {">=": lambda a, b: a >= b, "<=": lambda a, b: a <= b, ">": lambda a, b: a > b,
       "<": lambda a, b: a < b, "=": lambda a, b: a == b}
STEP_ORDER = ["reconcile", "reap_claims", "probe_gates", "score_predictions", "audit", "accrue_trust",
              "portfolio", "product", "execute", "amend", "plus_share"]
MGMT_ROLES = ("operations", "portfolio-manager", "product-manager", "project-manager")


def reliability(successes: int, n: int, trust: dict) -> float:
    return (successes + trust["baseline"] * trust["prior_weight"]) / (n + trust["prior_weight"])


class Engine:
    def __init__(self, store: Store, config: dict | None = None, policy: dict | None = None):
        self.s = store
        self.cfg = config or load_config()
        self.policy = policy or load_policy()
        check_pairing(self.cfg["agents"]["doer"], self.cfg["agents"]["reviewer"])
        self.doer = build_agent(self.cfg["agents"]["doer"], "doer")
        self.reviewer = build_agent(self.cfg["agents"]["reviewer"], "reviewer")

    # ---- metrics a prediction may name -------------------------------------------------
    def metric(self, name: str, now: datetime) -> float:
        s = self.s
        if name == "items_done":
            return s.scalar("SELECT COUNT(*) FROM items WHERE status='done'")
        if name == "open_gate_cards":
            return s.scalar("SELECT COUNT(*) FROM gate_cards WHERE status='open'")
        if name == "silent_drops_7d":
            return s.scalar("SELECT COUNT(*) FROM outcomes WHERE result='silent_drop' AND at>=?", iso(now - timedelta(days=7)))
        if name == "ticks_completed_1h":
            return s.scalar("SELECT COUNT(*) FROM tick_runs WHERE finished_at>=? AND steps_completed=steps_total", iso(now - timedelta(hours=1)))
        raise KeyError(name)

    # ---- helpers -----------------------------------------------------------------------
    def _ensure_item(self, now: str, **it) -> bool:
        if self.s.one("SELECT 1 FROM items WHERE id=?", it["id"]):
            return False
        self.s.x("""INSERT INTO items (id,title,kind,project,owner_role,trigger_on,done_check,closing_probe,priority,status,
                    surface,action_class,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                 it["id"], it["title"], it.get("kind", "work"), it.get("project"), it.get("owner_role", "staff"),
                 it.get("trigger_on"), it.get("done_check", "verified by a different agent"), it.get("closing_probe"),
                 it.get("priority", 50), it.get("status", "ready"), it.get("surface"), it.get("action_class"), now, now)
        return True

    def add_item(self, id: str, title: str, **kw) -> dict:
        now = iso(datetime.now(timezone.utc))
        self._ensure_item(now, id=id, title=title, **kw)
        self.s.event(now, "owner", "item_added", id, title)
        return self.s.one("SELECT * FROM items WHERE id=?", id)

    def _action(self, surface, action_class):
        return ((self.policy.get("surfaces", {}).get(surface) or {}).get("actions") or {}).get(action_class)

    def _rung(self, surface, action_class) -> str:
        r = self.s.one("SELECT rung FROM trust_ledger WHERE surface=? AND action_class=?", surface, action_class)
        if r:
            return r["rung"]
        return (self.policy.get("surfaces", {}).get(surface) or {}).get("start_rung", "observed")

    # ---- steps -------------------------------------------------------------------------
    def reconcile(self, c):
        s = self.s
        drops = s.q("SELECT id FROM items WHERE status IN ('done','superseded','cancelled') AND (disposition IS NULL OR disposition='')")
        for d in drops:
            s.x("UPDATE items SET status='open', updated_at=? WHERE id=?", c["nowi"], d["id"])
            s.x("INSERT INTO outcomes (item_id,agent,surface,action_class,result,evidence,at) VALUES (?,?,?,?,?,?,?)",
                d["id"], "reconcile", "work_tracker", "create_update_close", "silent_drop", "closed without disposition", c["nowi"])
        n = s.x("""UPDATE items SET status='ready', updated_at=? WHERE status='open'
                   AND (trigger_on IS NULL OR trigger_on IN (SELECT id FROM items WHERE status='done'))""", c["nowi"])
        c["notes"].append(f"reconciled {len(drops)} reopened, {n} ready")

    def reap_claims(self, c):
        cutoff = iso(c["now"] - timedelta(minutes=self.cfg["claim_ttl_minutes"]))
        for r in self.s.q("SELECT item_id FROM claims WHERE heartbeat_at<?", cutoff):
            self.s.x("DELETE FROM claims WHERE item_id=?", r["item_id"])
            self.s.x("UPDATE items SET status='ready', updated_at=? WHERE id=? AND status='claimed'", c["nowi"], r["item_id"])
            c["notes"].append(f"released stale claim {r['item_id']}")

    def probe_gates(self, c):
        for g in self.s.q("SELECT * FROM gate_cards WHERE status='open'"):
            kind, _, arg = g["closing_probe"].partition(":")
            # the gated item itself can never close its own gate; only an owner action (resolve_gate) or another item can
            if kind == "item_done" and arg != g["item_id"] and self.s.one("SELECT 1 FROM items WHERE id=? AND status='done'", arg):
                self.resolve_gate(g["id"], actor="probe", now=c["nowi"])
        c["open_gates"] = self.s.scalar("SELECT COUNT(*) FROM gate_cards WHERE status='open'")

    def resolve_gate(self, gate_id: str, actor="owner", now=None) -> bool:
        now = now or iso(datetime.now(timezone.utc))
        g = self.s.one("SELECT * FROM gate_cards WHERE id=?", gate_id)
        if not g or g["status"] != "open":
            return False
        self.s.x("UPDATE gate_cards SET status='closed', closed_at=? WHERE id=?", now, gate_id)
        approved = self.s.get("approved", [])
        if g["item_id"] and g["item_id"] not in approved:
            approved.append(g["item_id"])
            self.s.put("approved", approved)
            self.s.x("UPDATE items SET status='ready', blocker=NULL, updated_at=? WHERE id=? AND status='blocked'", now, g["item_id"])
        self.s.event(now, actor, "gate_resolved", g["item_id"], g["what"])
        return True

    def score_predictions(self, c):
        for p in self.s.q("SELECT * FROM predictions WHERE verdict IS NULL AND due_at<=?", c["nowi"]):
            try:
                obs = self.metric(p["metric"], c["now"])
                verdict = "hit" if OPS[p["op"]](obs, p["target"]) else "miss"
            except KeyError:
                obs, verdict = None, "miss"
            self.s.x("UPDATE predictions SET observed=?, verdict=? WHERE id=?", obs, verdict, p["id"])

    def audit(self, c):
        """Independent later audit: failures that slipped past review surface here and demote trust."""
        cutoff = iso(c["now"] - timedelta(minutes=self.cfg["tick_minutes"] * self.cfg["audit_after_ticks"]))
        for it in self.s.q("SELECT * FROM items WHERE status='done' AND evidence LIKE '%[hidden]%' AND updated_at<=?", cutoff):
            self.s.x("INSERT INTO outcomes (item_id,agent,surface,action_class,result,evidence,at) VALUES (?,?,?,?,?,?,?)",
                     it["id"], "audit", it["surface"] or "repo", it["action_class"] or "branch_commit_push",
                     "hidden_failure", "post-merge audit found the claimed result did not hold", c["nowi"])
            self.s.x("UPDATE items SET status='ready', attempts=attempts+1, evidence=replace(evidence,'[hidden]',''), "
                     "disposition=NULL, updated_at=? WHERE id=?", c["nowi"], it["id"])
            self.s.event(c["nowi"], "audit", "hidden_failure", it["id"], "reopened; trust will be demoted")
            c["notes"].append(f"audit caught hidden failure on {it['id']}")

    def accrue_trust(self, c):
        tr, ld = self.policy["trust"], self.policy["ladder"]
        rows = self.s.q("""SELECT surface, action_class, SUM(result='verified') ok,
                           SUM(result IN ('hidden_failure','silent_drop')) severe, COUNT(*) n
                           FROM outcomes GROUP BY surface, action_class""")
        for r in rows:
            rel = reliability(r["ok"], r["n"], tr)
            rung = self._rung(r["surface"], r["action_class"])
            self.s.x("""INSERT INTO trust_ledger (surface,action_class,rung,reliability,outcomes,updated_at) VALUES (?,?,?,?,?,?)
                        ON CONFLICT(surface,action_class) DO UPDATE SET reliability=excluded.reliability,
                        outcomes=excluded.outcomes, updated_at=excluded.updated_at""",
                     r["surface"], r["action_class"], rung, rel, r["n"], c["nowi"])
            idx = ld["rungs"].index(rung)
            surf = self.policy["surfaces"].get(r["surface"], {})
            ceil = ld["rungs"].index(ld["ceiling_by_max_permission"].get(surf.get("max_permission", "none"), "observed"))
            # higher rungs need proportionally more verified evidence
            promote = idx < ceil and r["n"] >= ld["promote_when"]["min_outcomes"] * (1 + idx // 2) and rel >= ld["promote_when"]["min_reliability"] and not r["severe"]
            demote = idx > 0 and (rel < ld["demote_when"]["reliability_below"] or r["severe"])
            if promote or demote:
                to = ld["rungs"][idx + (1 if promote else -1)]
                iid = f"LADDER-{r['surface']}-{r['action_class']}-{to}"
                if self._ensure_item(c["nowi"], id=iid, kind="ladder", owner_role="operations", priority=0 if demote else 20,
                                     title=f"{'Promote' if promote else 'Demote'} {r['surface']}/{r['action_class']} {rung} -> {to} (reliability {rel:.2f} over {r['n']})",
                                     done_check="rung changed after a different agent's review", surface=r["surface"], action_class=r["action_class"]):
                    c["notes"].append(f"ladder item {iid}")

    def portfolio(self, c):
        """Allocate this tick's execution slots across active projects by weight, reserving the plus share."""
        slots = self.cfg["slots_per_tick"]
        plus_slots = max(1, round(slots * self.cfg["plus_share"])) if slots > 1 else 0
        projects = self.s.q("SELECT id, weight FROM projects WHERE status='active'")
        ready = {p["id"]: self.s.scalar("SELECT COUNT(*) FROM items WHERE status='ready' AND project=? AND owner_role='staff' AND kind!='plus'", p["id"]) for p in projects}
        live = [p for p in projects if ready[p["id"]] > 0]
        total_w = sum(p["weight"] for p in live) or 1
        alloc = {p["id"]: min(ready[p["id"]], max(1, math.floor((slots - plus_slots) * p["weight"] / total_w))) for p in live}
        c["alloc"], c["plus_slots"] = alloc, plus_slots
        c["notes"].append("allocation " + (", ".join(f"{k}:{v}" for k, v in alloc.items()) or "none") + f" +{plus_slots} plus")

    def product(self, c):
        """Every closed work item proposes one plus; plus items do not spawn pluses."""
        open_plus = self.s.scalar("SELECT COUNT(*) FROM items WHERE kind='plus' AND status NOT IN ('done','superseded','cancelled')")
        for it in self.s.q("SELECT * FROM items WHERE status='done' AND kind IN ('work','fix') ORDER BY updated_at DESC LIMIT 20"):
            if open_plus >= 6:
                break
            pid = f"PLUS-{it['id']}"
            if self._ensure_item(c["nowi"], id=pid, kind="plus", project=it["project"], owner_role="staff", priority=40,
                                 title=f"Plus: make '{it['title'][:60]}' better than done",
                                 done_check="measurable improvement over the shipped version, verified by a different agent",
                                 surface=it["surface"], action_class=it["action_class"]):
                open_plus += 1
                self.s.event(c["nowi"], "product-manager", "plus_proposed", pid, f"from {it['id']}")

    # -- execution ------------------------------------------------------------------------
    def _gate(self, it, act, c) -> bool:
        """True if the item may proceed; otherwise it is blocked or a gate card is opened."""
        if not act:
            return True
        if act.get("denied"):
            self.s.x("UPDATE items SET status='blocked', blocker=?, disposition=?, updated_at=? WHERE id=?",
                     f"denied by policy: {act.get('reason', '')}", f"blocked: denied by policy ({act.get('reason', '')})", c["nowi"], it["id"])
            self.s.event(c["nowi"], "policy", "denied", it["id"], act.get("reason"))
            return False
        if act.get("identity_bound") and not act.get("reversible", True):
            if it["id"] in self.s.get("approved", []):
                return True
            gid = f"GATE-{it['id']}"
            if not self.s.one("SELECT 1 FROM gate_cards WHERE id=?", gid):
                self.s.x("""INSERT INTO gate_cards (id,item_id,what,why_gated,default_in_effect,prepared_by_fleet,closing_probe,opened_at)
                            VALUES (?,?,?,?,?,?,?,?)""",
                         gid, it["id"], it["title"], "irreversible and identity-bound (policy interrupt gate)",
                         "not done; the fleet continues with other items", "work prepared as a draft; nothing sent, spent or signed",
                         "manual:owner", c["nowi"])
                self.s.event(c["nowi"], "gate", "gate_opened", it["id"], it["title"])
            self.s.x("UPDATE items SET status='blocked', blocker=?, updated_at=? WHERE id=?",
                     f"gate card {gid} (owner step)", c["nowi"], it["id"])
            return False
        return True

    def _finish(self, it, ok, evidence, c, agent, hidden=False):
        surface, ac = it["surface"] or "repo", it["action_class"] or "branch_commit_push"
        if ok:
            ev = evidence[:400] + (" [hidden]" if hidden else "")
            self.s.x("UPDATE items SET status='done', disposition=?, evidence=?, updated_at=? WHERE id=?",
                     f"done: verified by {self.reviewer.name}", ev, c["nowi"], it["id"])
            if agent != "operations":
                self.s.x("INSERT INTO outcomes (item_id,agent,surface,action_class,result,evidence,at) VALUES (?,?,?,?,?,?,?)",
                         it["id"], agent, surface, ac, "verified", evidence[:400], c["nowi"])
        else:
            attempts = it["attempts"] + 1
            self.s.x("INSERT INTO outcomes (item_id,agent,surface,action_class,result,evidence,at) VALUES (?,?,?,?,?,?,?)",
                     it["id"], agent, surface, ac, "failed", evidence[:400], c["nowi"])
            if attempts >= self.cfg["max_attempts"]:
                self.s.x("UPDATE items SET status='blocked', attempts=?, blocker=?, disposition=?, evidence=?, updated_at=? WHERE id=?",
                         attempts, "failed verification repeatedly; root-cause item filed",
                         "blocked: owner=portfolio-manager; probe=FIX item done", evidence[:400], c["nowi"], it["id"])
                self._ensure_item(c["nowi"], id=f"FIX-{it['id']}", kind="fix", project=it["project"], owner_role="staff", priority=5,
                                  title=f"Root-cause repeated failure of {it['id']}", done_check="root cause removed, original item passes review",
                                  surface=it["surface"], action_class=it["action_class"])
            else:
                self.s.x("UPDATE items SET status='ready', attempts=?, evidence=?, updated_at=? WHERE id=?",
                         attempts, evidence[:400], c["nowi"], it["id"])
        self.s.x("DELETE FROM claims WHERE item_id=?", it["id"])

    def _run_internal(self, it, c):
        """Items owned by management roles are applied by the platform itself and reviewed via the ledger."""
        if it["kind"] == "ladder":
            to = it["title"].split("->")[1].split("(")[0].strip()
            self.s.x("UPDATE trust_ledger SET rung=?, updated_at=? WHERE surface=? AND action_class=?", to, c["nowi"], it["surface"], it["action_class"])
            self.s.event(c["nowi"], "operations", "rung_changed", it["id"], f"{it['surface']}/{it['action_class']} -> {to}")
            return True, f"rung set to {to}"
        if it["kind"] == "amendment":
            a = self.s.one("SELECT * FROM amendments WHERE id=?", "A-" + it["id"][len("AMEND-"):])
            if a:
                self.s.x("UPDATE amendments SET status='adopted' WHERE id=?", a["id"])
                rules = self.s.get("rules", {"version": 1, "list": []})
                rules["version"] += 1
                rules["list"].append({"id": a["id"], "rule": a["proposal"], "at": c["nowi"]})
                self.s.put("rules", rules)
                self.s.event(c["nowi"], "portfolio-manager", "rules_amended", it["id"], f"v{rules['version']}")
                return True, f"rules v{rules['version']} adopted: {a['proposal'][:120]}"
        return True, "internal item applied"

    def _await(self, it, evidence, c):
        self.s.x("UPDATE items SET status='verify', evidence=?, updated_at=? WHERE id=?", (evidence or "")[:400], c["nowi"], it["id"])
        self.s.x("UPDATE claims SET heartbeat_at=? WHERE item_id=?", c["nowi"], it["id"])
        self.s.event(c["nowi"], "reviewer", "awaiting_verification", it["id"], (evidence or "")[:200])
        c["notes"].append(f"{it['id']} awaiting verification")

    def _recheck_pending(self, c):
        """Items waiting on an external check are re-verified each tick; pending stays pending, only a real verdict closes them."""
        for it in self.s.q("SELECT * FROM items WHERE status='verify' ORDER BY priority, created_at"):
            ok, ev = self.reviewer.verify(it, Result(True, it["evidence"] or ""))
            if ok is None:
                self._await(it, ev, c)
                continue
            self.s.event(c["nowi"], "reviewer", "executed", it["id"], f"{'pass' if ok else 'FAIL'} after waiting")
            self._finish(it, ok, it["evidence"] if ok else ev, c, "doer")
            c["done" if ok else "failed"] += 1

    def execute(self, c):
        s, slots = self.s, self.cfg["slots_per_tick"]
        used_plus, per_project, executed = 0, {}, 0
        self._recheck_pending(c)
        for it in s.q("SELECT * FROM items WHERE status='ready' ORDER BY priority, created_at"):
            if executed >= slots + 4:
                break
            internal = it["owner_role"] in MGMT_ROLES
            if not internal:
                if it["kind"] == "plus":
                    if used_plus >= c.get("plus_slots", 1):
                        continue
                elif per_project.get(it["project"] or "_", 0) >= c.get("alloc", {}).get(it["project"], slots):
                    continue
            act = self._action(it["surface"], it["action_class"]) if it["surface"] else None
            if it["kind"] == "ladder" and it["title"].startswith("Promote"):
                to = it["title"].split("->")[1].split("(")[0].strip()
                rungs = self.policy["ladder"]["rungs"]
                if rungs.index(to) > rungs.index(self.cfg["max_auto_rung"]):
                    # widening an agent's own scope past the cap is an owner decision, never automatic
                    act = {"identity_bound": True, "reversible": False}
            if not self._gate(it, act, c):
                continue
            actor = "operations" if internal else "doer"
            s.x("INSERT OR IGNORE INTO claims (item_id,agent,claimed_at,heartbeat_at) VALUES (?,?,?,?)", it["id"], actor, c["nowi"], c["nowi"])
            s.x("UPDATE items SET status='claimed', updated_at=? WHERE id=?", c["nowi"], it["id"])
            s.x("INSERT INTO dispatches (tick_id,role_id,item_id,model,status,at) VALUES (?,?,?,?,?,?)",
                c["tick"], "operations" if internal else "staff", it["id"], self.cfg["agents"]["doer"].get("kind", "simulated"), "running", c["nowi"])
            executed += 1
            if internal:
                ok, ev = self._run_internal(it, c)
                self._finish(it, ok, ev, c, "operations")
                c["done"] += 1
                continue
            if it["kind"] == "plus":
                used_plus += 1
            else:
                per_project[it["project"] or "_"] = per_project.get(it["project"] or "_", 0) + 1
            rung = self._rung(it["surface"] or "repo", it["action_class"] or "branch_commit_push")
            s.x("INSERT OR IGNORE INTO predictions (id,item_id,agent,metric,op,target,due_at) VALUES (?,?,?,?,?,?,?)",
                f"P-{it['id']}-{c['tick']}", it["id"], "doer", "items_done", ">=", self.metric("items_done", c["now"]) + 1,
                iso(c["now"] + timedelta(minutes=self.cfg["tick_minutes"])))
            res = self.doer.do(it)
            ok, ev = self.reviewer.verify(it, res)
            if ok is None:  # verification pending (e.g. checks still running): wait, do not fail or reopen
                self._await(it, ev, c)
                continue
            if res.ok and not ok and res.revert:
                res.revert()
            mode = "pre-approval review" if self.policy["ladder"]["rungs"].index(rung) < 2 else "apply then audit"
            s.event(c["nowi"], "doer", "executed", it["id"], f"{'pass' if ok else 'FAIL'} via {mode} at rung {rung}")
            self._finish(it, ok, res.evidence if ok else ev, c, "doer", hidden=ok and res.hidden_failure)
            c["done" if ok else "failed"] += 1

    def amend(self, c):
        """Recurring failures become proposed rule amendments (reviewed, then adopted with a version bump)."""
        n = self.cfg["amend_after_failures"]
        for r in self.s.q("""SELECT surface, action_class, COUNT(*) n FROM outcomes WHERE result IN ('failed','hidden_failure')
                             GROUP BY surface, action_class HAVING COUNT(*)>=?""", n):
            key = f"{r['surface']}-{r['action_class']}-{r['n'] // n}"
            aid = f"A-{key}"
            if not self.s.one("SELECT 1 FROM amendments WHERE id=?", aid):
                prop = (f"Before executing any {r['surface']}/{r['action_class']} item, the reviewer reproduces the result in a clean "
                        f"environment (observed {r['n']} failed or hidden-failure outcomes).")
                self.s.x("INSERT INTO amendments (id,target,pattern,proposal,created_at) VALUES (?,?,?,?,?)",
                         aid, "agents/AGENTS.md", f"{r['n']} failures on {r['surface']}/{r['action_class']}", prop, c["nowi"])
                self._ensure_item(c["nowi"], id=f"AMEND-{key}", kind="amendment", owner_role="portfolio-manager", priority=15,
                                  title=f"Amend rules: {prop[:90]}", done_check="amendment adopted with version bump")
                c["notes"].append(f"amendment proposed {aid}")

    def plus_share(self, c):
        rows = self.s.q("SELECT kind FROM items WHERE status='done' AND kind IN ('work','fix','plus') ORDER BY updated_at DESC, rowid DESC LIMIT 20")
        if len(rows) >= 10:
            share = sum(r["kind"] == "plus" for r in rows) / len(rows)
            if share < self.cfg["plus_share"] / 2:
                self._ensure_item(c["nowi"], id=f"REBALANCE-{c['nowi'][:10]}", kind="rebalance", owner_role="portfolio-manager", priority=5,
                                  title=f"Plus share {share:.0%} is under half the {self.cfg['plus_share']:.0%} target; rebalance and file the cause",
                                  done_check="plus share restored over the next 20 closed items")

    # ---- tick --------------------------------------------------------------------------
    def tick(self, now: datetime | None = None) -> dict:
        now = now or datetime.now(timezone.utc)
        nowi = iso(now)
        tick_id = self.s.x("INSERT INTO tick_runs (started_at, steps_total) VALUES (?,?)", nowi, len(STEP_ORDER))
        c = {"now": now, "nowi": nowi, "tick": tick_id, "notes": [], "errors": [], "done": 0, "failed": 0, "open_gates": 0}
        completed = 0
        for name in STEP_ORDER:
            try:
                getattr(self, name)(c)
                completed += 1
            except Exception as e:  # noqa: BLE001 - recorded and filed as an item; the loop continues
                c["errors"].append(f"{name}: {e}")
                self._ensure_item(nowi, id=f"TICKFAIL-{name}-{nowi[:13].replace(' ', 'T')}", kind="fix", owner_role="operations",
                                  priority=0, title=f"Tick step {name} failed: {e}"[:300], done_check=f"next tick completes {name}")
        open_n = self.s.scalar("SELECT COUNT(*) FROM items WHERE status NOT IN ('done','superseded','cancelled')")
        report = "\n".join([
            f"Happened: tick {tick_id} ran {completed}/{len(STEP_ORDER)} steps; {c['done']} verified, {c['failed']} failed review; " + ("; ".join(c["notes"]) or "no other changes") + ".",
            f"Decided: {c['done'] + c['failed']} item(s) executed in driver order within project allocation and the plus reserve.",
            f"Next: tick {tick_id + 1} in {self.cfg['tick_minutes']} minutes.",
            f"Open: {open_n} active item(s), {c['open_gates']} gate card(s)" + (f", errors: {' | '.join(c['errors'])}" if c["errors"] else "") + ".",
        ])
        self.s.x("UPDATE tick_runs SET finished_at=?, steps_completed=?, report=?, errors=? WHERE id=?",
                 iso(now), completed, report, json.dumps(c["errors"]) if c["errors"] else None, tick_id)
        return {"tick": tick_id, "completed": completed, "total": len(STEP_ORDER), "report": report, "errors": c["errors"]}

    # ---- read model for CLI and dashboard -----------------------------------------------
    def state(self) -> dict:
        s = self.s
        preds = s.q("SELECT verdict, COUNT(*) n FROM predictions WHERE verdict IS NOT NULL GROUP BY verdict")
        hit = next((p["n"] for p in preds if p["verdict"] == "hit"), 0)
        scored = sum(p["n"] for p in preds)
        closed = s.q("SELECT kind FROM items WHERE status='done' AND kind IN ('work','fix','plus') ORDER BY updated_at DESC, rowid DESC LIMIT 20")
        return {
            "org": self.cfg["org_name"],
            "kpis": {
                "ticks": s.scalar("SELECT COUNT(*) FROM tick_runs"),
                "items_done": s.scalar("SELECT COUNT(*) FROM items WHERE status='done'"),
                "items_active": s.scalar("SELECT COUNT(*) FROM items WHERE status NOT IN ('done','superseded','cancelled')"),
                "open_gates": s.scalar("SELECT COUNT(*) FROM gate_cards WHERE status='open'"),
                "prediction_hit_rate": round(hit / scored, 3) if scored else None,
                "predictions_scored": scored,
                "plus_share": round(sum(r["kind"] == "plus" for r in closed) / len(closed), 3) if closed else None,
                "silent_drops": s.scalar("SELECT COUNT(*) FROM outcomes WHERE result='silent_drop'"),
                "rules_version": s.get("rules", {"version": 1})["version"],
            },
            "projects": s.q("SELECT p.*, (SELECT COUNT(*) FROM items i WHERE i.project=p.id AND i.status='done') done, "
                            "(SELECT COUNT(*) FROM items i WHERE i.project=p.id AND i.status NOT IN ('done','superseded','cancelled')) active FROM projects p"),
            "items": s.q("SELECT id,title,kind,project,owner_role,priority,status,attempts,blocker,surface,action_class FROM items "
                         "ORDER BY CASE status WHEN 'blocked' THEN 0 WHEN 'claimed' THEN 1 WHEN 'ready' THEN 2 WHEN 'open' THEN 3 ELSE 4 END, priority, id LIMIT 200"),
            "gates": s.q("SELECT * FROM gate_cards ORDER BY status, opened_at DESC LIMIT 50"),
            "trust": s.q("SELECT * FROM trust_ledger ORDER BY surface, action_class"),
            "events": s.q("SELECT * FROM events ORDER BY id DESC LIMIT 60"),
            "amendments": s.q("SELECT * FROM amendments ORDER BY created_at DESC LIMIT 20"),
            "last_tick": s.one("SELECT * FROM tick_runs ORDER BY id DESC LIMIT 1"),
            "managers": [
                {"role": "portfolio-manager", "does": "allocates capacity across projects, guards the plus share, adopts rule amendments"},
                {"role": "project-manager", "does": "owns backlog flow per project; reconciles dispositions; files root-cause fixes"},
                {"role": "product-manager", "does": "proposes one plus per closed item; ranks the plus queue"},
                {"role": "operations", "does": "applies reviewed trust-ladder changes; heals failed ticks"},
                {"role": "reviewer", "does": "independently verifies every claimed result; never the doer"},
            ],
        }
