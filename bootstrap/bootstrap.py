#!/usr/bin/env python3
# SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
# Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
"""Ultrastable bootstrapper: idea in, running organization out.

Stages (the AIOS boot chain, moved from a laptop to a server):

  read      IDEA.md + ultrastable.json + autonomy/policy.json   (AIOS: GRUB -> kernel)
  detect    which connectors have credentials, which tools exist (AIOS: RAM, CPU, disk)
  select    model tier from budget                             (AIOS: model by RAM)
  plan      charter, role instances, kit backlog, gate cards   (AIOS: partition plan)
  write     org/ files, worker config, D1 seed SQL             (AIOS: extract tarball)
  provision D1 create, migrations, seed rows, deploy           (AIOS: switch_root)
  start     first tick observed via /health                    (AIOS: orchestrator up)
  report    boot log + four-line report                        (AIOS: [AIOS] > prompt)

Rules carried over from AIOS:
  - The boot never dies (AIOS: PID 1 must never exit). A failed stage is logged, becomes a
    backlog item with its blocker and closing probe, and the next stage runs degraded.
  - No silent error swallowing (AIOS commit 8cfba48). Every command's exit code is checked
    and its stderr tail is logged.
  - Verify before depending (AIOS: phantom package, filename gotcha). Tools and inputs are
    checked to exist before a stage uses them.
  - Idempotent. Running it twice changes nothing that is already in place.

Stdlib only. Never reads, prints or writes a secret value; it checks only whether an
environment variable is set.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

VERSION = "0.1.0"
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))
import cases as case_library  # noqa: E402  (bootstrap case library, bootstrap/cases.json)
import ladder  # noqa: E402  (docs/BOOTSTRAP-LADDER.md as code)
from ownerdoc import owner_readme  # noqa: E402  (owner README generated from docs/help.md)


# ---------------------------------------------------------------- helpers

def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()


def sql_str(v) -> str:
    if v is None:
        return "NULL"
    if isinstance(v, (int, float)):
        return repr(v)
    return "'" + str(v).replace("'", "''") + "'"


def slugify(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")[:40] or "org"


def parse_idea(text: str) -> dict:
    """Front matter (key: value) plus '# Section' bodies; bullet lists become lists."""
    idea: dict = {"front": {}, "sections": {}}
    body = text
    m = re.match(r"^---\n(.*?)\n---\n(.*)$", text, re.S)
    if m:
        for line in m.group(1).splitlines():
            line = line.split("#", 1)[0].strip()
            if ":" in line:
                k, _, v = line.partition(":")
                idea["front"][k.strip()] = v.strip()
        body = m.group(2)
    current = None
    for line in body.splitlines():
        h = re.match(r"^#\s+(.+?)\s*$", line)
        if h:
            current = h.group(1).strip().lower()
            idea["sections"][current] = []
            continue
        if current is not None:
            idea["sections"][current].append(line)
    out = {}
    for name, lines in idea["sections"].items():
        bullets = [l.strip()[2:].strip() for l in lines if l.strip().startswith("- ")]
        prose = "\n".join(l for l in lines if l.strip() and not l.strip().startswith("- ")
                          and not l.strip().startswith("Example:") and not l.strip().startswith("Each line"))
        out[name] = {"bullets": bullets, "prose": prose.strip()}
    idea["sections"] = out
    return idea


def budget_from(idea: dict) -> float:
    for line in idea["sections"].get("constraints", {}).get("bullets", []):
        m = re.search(r"budget[^0-9]*([0-9]+(?:\.[0-9]+)?)", line, re.I)
        if m:
            return float(m.group(1))
    return 0.0


def temporary_wrangler(text: str) -> str:
    """Variant of the rendered wrangler.jsonc that a temporary Cloudflare account accepts (issue #22, trial findings 1, 3):
    no cron (temporary accounts allow no triggers), workers_dev on (the only address it gets), and no database_id so
    `wrangler deploy --temporary` creates the database."""
    out = ladder.render_wrangler(text, "alarm")  # no cron: the Heartbeat Durable Object alarm ticks the Worker
    out = re.sub(r'\n[ \t]*"triggers":\s*\{[^}]*\},?', "", out)
    out = re.sub(r',\s*"database_id":\s*"[^"]*"', "", out)
    out = out.replace('"workers_dev": false', '"workers_dev": true')
    return out


def fill(template: str, values: dict) -> str:
    return re.sub(r"\{(\w+)\}", lambda m: str(values.get(m.group(1), m.group(0))), template)


class Boot:
    def __init__(self, root: Path, out: Path, apply: bool, idea_path: Path | None = None, config_path: Path | None = None, interactive: bool = False,
                 temporary: bool = False, console_key_file: Path | None = None, tick_mode: str | None = None):
        self.tick_mode = tick_mode  # overrides runtime.tick_mode (self_start passes "alarm" when the cron never fired)
        self.root, self.out, self.apply, self.interactive = root, out, apply, interactive
        self.temporary, self.console_key_file = temporary, console_key_file
        self.idea_path, self.config_path = idea_path, config_path  # optional overrides, so one repo can boot a different org (self-hosting)
        self.log: list[dict] = []
        self.state: dict = {"blocked_items": [], "gate_cards": []}

    # Each stage runs inside guard(); a failure never stops the boot.
    def guard(self, name, fn):
        started = now_iso()
        try:
            status, detail = fn()
        except Exception as e:  # recorded, not swallowed: it becomes a backlog item below
            status, detail = "blocked", f"{type(e).__name__}: {e}"
        self.log.append({"stage": name, "status": status, "detail": detail, "started": started, "finished": now_iso()})
        if status == "blocked":
            self.state["blocked_items"].append({
                "id": f"BOOT-{name.upper()}",
                "title": f"Boot stage '{name}' blocked: {detail}"[:300],
                "owner_role": "operations",
                "done_check": f"bootstrap.py --apply reports stage '{name}' ok",
                "closing_probe": f"org/boot-log.json stage {name} status ok",
                "priority": 0,
            })
        return status

    # -------------------------------------------------------------- stages

    def read(self):
        idea_path = self.idea_path or self.root / "IDEA.md"
        self.config = json.loads((self.config_path or self.root / "ultrastable.json").read_text())
        self.policy = json.loads((self.root / "autonomy" / "policy.json").read_text())
        if not idea_path.exists():
            self.idea = parse_idea("---\norg_name: Unnamed\n---\n# Idea\n\n# First outcomes\n")
            self.org_name, self.slug, self.outcomes, self.budget = "Unnamed org", "unnamed", [], 0.0
            self.state["gate_cards"].append(self.card("GATE-IDEA", "Write the idea in IDEA.md",
                "Only the owner knows the idea", "the org boots with no outcomes and waits",
                "IDEA.md template", "item_done:KIT-0"))
            return "degraded", "IDEA.md missing; booting with an empty charter"
        self.idea = parse_idea(idea_path.read_text())
        f = self.idea["front"]
        self.org_name = f.get("org_name") or "Unnamed org"
        self.slug = slugify(f.get("slug") or self.org_name)
        self.outcomes = self.idea["sections"].get("first outcomes", {}).get("bullets", [])
        self.budget = budget_from(self.idea)
        problems = validate_policy(self.policy)
        if problems:
            return "blocked", "policy invalid: " + "; ".join(problems)
        return "ok", f"org '{self.org_name}', {len(self.outcomes)} outcome(s), budget {self.budget:g} USD/month"

    def detect(self):
        found, missing = [], []
        for name, c in self.config["connectors"].items():
            (found if os.environ.get(c["env"]) else missing).append((name, c))
        self.connectors_present = {n for n, _ in found}
        self.tools = {t: bool(shutil.which(t)) for t in ("git", "node", "npx", "wrangler")}
        for name, c in missing:
            if c.get("optional"):
                continue
            self.state["gate_cards"].append(self.card(
                f"GATE-SECRET-{c['env']}",
                f"Set the {c['env']} secret (connector '{name}', needed for {', '.join(c['required_for'])})",
                "a credential only the owner can mint", f"{', '.join(c['required_for'])} stay in dry-run",
                "the binding name is already in config; only the value is missing", f"env:{c['env']}"))
        detail = f"connectors present: {sorted(self.connectors_present) or 'none'}; tools: " + \
                 ", ".join(f"{t}={'yes' if ok else 'no'}" for t, ok in self.tools.items())
        return ("ok" if not missing else "degraded"), detail

    def select(self):
        tiers = sorted(self.config["model_ladder"]["tiers"], key=lambda t: t["budget_usd_per_month_min"])
        tier = [t for t in tiers if self.budget >= t["budget_usd_per_month_min"]][-1]
        aliases = self.config["model_ladder"]["aliases"]
        self.models = {k: aliases[tier[k]] for k in ("doer", "reviewer", "manager")}
        if self.budget > 0:
            self.state["gate_cards"].append(self.card(
                "GATE-BUDGET", f"Approve spending up to {self.budget:g} USD/month on model and runtime usage",
                "spending money is identity-bound", "free tiers only; the fleet logs cost estimates",
                "cost estimate per role in org/charter.md", "manual"))
        return "ok", f"tier for {self.budget:g} USD: " + ", ".join(f"{k}={v}" for k, v in self.models.items())

    def cases(self):
        """Match the starting conditions against the case library: routes around each blocker, at most one owner card per blocker."""
        facts = {}
        fp = self.root / "facts.json"
        if fp.exists():
            facts.update(json.loads(fp.read_text()))
        for k, v in self.idea["front"].items():  # IDEA.md front matter may state a fact, e.g. `us_domiciled: false`
            if k in case_library.load_library()["defaults"]:
                facts[k] = {"true": True, "false": False}.get(v.lower(), int(v) if v.isdigit() else v)
        facts.setdefault("budget_usd_per_month", self.budget)
        if "has_org_admin_token" not in facts:
            facts["has_org_admin_token"] = "ORG_ADMIN_TOKEN" in os.environ
        plan = case_library.plan_cases(facts, packs=tuple(self.config.get("packs", [])))
        for c in plan["cards"]:
            self.state["gate_cards"].append(self.card(
                f"CASE-{c['id']}", c["what"], c["why"], c["default"],
                "routes for " + ", ".join(c["cases"]) + " are in org/bootstrap-cases.json", c["probe"]))
        self.out.mkdir(parents=True, exist_ok=True)
        (self.out / "bootstrap-cases.json").write_text(json.dumps({"facts": facts, **plan}, indent=2) + "\n")
        return "ok", f"{len(plan['applicable'])} case(s) matched, {len(plan['cards'])} owner card(s), {len(plan['assumed'])} fact(s) assumed"

    def plan(self):
        roles = []
        for r in self.config["roles"]:
            model = self.models["manager"] if r["id"].endswith("manager") else \
                self.models["reviewer"] if r["id"] == "reviewer" else self.models["doer"]
            if r["count"] == "per_outcome":
                for i, _ in enumerate(self.outcomes, 1):
                    roles.append({"id": f"{r['id']}-{i}", "role": r["id"], "project": f"OUT-{i}",
                                  "tick_every": r["tick_every"], "model": model})
            else:
                n = 1 if r["count"] in (1, "pool") and self.budget < 50 else 2 if r["count"] == "pool" else int(r["count"])
                for i in range(1, n + 1):
                    roles.append({"id": f"{r['id']}-{i}", "role": r["id"], "project": None,
                                  "tick_every": r["tick_every"], "model": model})
        self.roles = roles

        kit = [
            ("KIT-0", "Charter recorded: idea, users, outcomes, constraints in org/charter.md", "portfolio-manager", None,
             "org/charter.md committed", "git log -- org/charter.md"),
            ("KIT-1", "Repos exist, default branch protected, AGENTS.md in place", "operations", "KIT-0",
             "every repo has agents/AGENTS.md on main and branch protection on", "GitHub API: protection on main"),
            ("KIT-2", "Runtime provisioned: D1 migrated and seeded, Worker deployed with the cron", "operations", "KIT-0",
             "wrangler deployments list shows the Worker; D1 has roles rows", "GET /health returns JSON"),
            ("KIT-3", "Heartbeat observed: six complete ticks in one hour", "operations", "KIT-2",
             "tick_runs_completed_1h >= 6", "GET /health ok=true"),
            ("KIT-4", "Reports reach the owner's channel in four lines", "operations", "KIT-3",
             "a tick report is visible in the channel", "channel shows last tick id"),
            ("KIT-5", "First plus accepted into the reserved share", "product-manager", "KIT-3",
             "one item of kind plus is done", "SELECT COUNT(*) FROM items WHERE kind='plus' AND status='done'"),
            ("KIT-7", "Analytics live: beacon on every site, scoreboard registered (analytics/analytics.js REGISTRY), collector self-check green",
             "operations", "KIT-2", "GET /api/analytics shows collector_selfcheck = 1 and every metric has a trigger or exemption",
             "GET /api/analytics with the bearer token returns breaches and metrics"),
        ]
        items = [{"id": i, "title": t, "kind": "work", "project": None, "owner_role": o, "trigger_on": trig,
                  "done_check": d, "closing_probe": p, "priority": 10 + n}
                 for n, (i, t, o, trig, d, p) in enumerate(kit)]
        constraints = " ".join(self.idea["sections"].get("constraints", {}).get("bullets", [])).lower()
        if "nothing public" in constraints or "not public" in constraints:
            items.append({"id": "KIT-6", "title": "Honour the owner's no-public-posting rule: repos private, sites behind access, no public posts",
                          "kind": "work", "project": None, "owner_role": "portfolio-manager", "trigger_on": None,
                          "done_check": "standing rule; audited each portfolio tick", "closing_probe": "owner lifts the gate",
                          "priority": 5})
        for i, outcome in enumerate(self.outcomes, 1):
            items.append({"id": f"OUT-{i}", "title": f"Outcome: {outcome}", "kind": "work", "project": f"OUT-{i}",
                          "owner_role": "product-manager", "trigger_on": "KIT-0",
                          "done_check": "roadmap of at most five items, each with goal, user and success metric",
                          "closing_probe": f"items with project OUT-{i} exist with metrics", "priority": 30 + i})
        items += self.state["blocked_items"]
        self.items = items
        self.predictions = [{"id": "P-KIT-3", "item_id": "KIT-3", "metric": "tick_runs_completed_1h", "op": ">=",
                             "target": 6, "due_hours": 2}]
        return "ok", f"{len(roles)} role instance(s), {len(items)} item(s), {len(self.state['gate_cards'])} gate card(s)"

    def write(self):
        self.out.mkdir(parents=True, exist_ok=True)
        f = self.idea["front"]
        s = self.idea["sections"]
        charter = [f"# {self.org_name}: charter", "",
                   f"Bootstrapped by ultrastable/seed {VERSION} on {now_iso()[:10]}. Source: IDEA.md.", "",
                   "## Idea", "", s.get("idea", {}).get("prose", "") or "(not written yet)", "",
                   "## Who it is for", ""] + [f"- {b}" for b in s.get("who it is for", {}).get("bullets", [])] + \
                  ["", "## Objectives (first outcomes)", ""] + [f"- OUT-{i}: {o}" for i, o in enumerate(self.outcomes, 1)] + \
                  ["", "## Constraints", ""] + [f"- {b}" for b in s.get("constraints", {}).get("bullets", [])] + \
                  ["", "## Owner", "", f"{f.get('owner', 'unknown')}. The owner sets direction and answers gate cards; "
                   "the fleet carries every other step.", "",
                   "## Models", ""] + [f"- {k}: {v}" for k, v in self.models.items()] + [""]
        (self.out / "charter.md").write_text("\n".join(charter))
        help_src = self.root / "docs" / "help.md"
        (self.out / "README.md").write_text(owner_readme(
            self.org_name, s.get("idea", {}).get("prose", ""), self.outcomes, self.state["gate_cards"],
            help_src.read_text(encoding="utf-8") if help_src.exists() else ""))
        (self.out / "roles.json").write_text(json.dumps(self.roles, indent=2) + "\n")
        (self.out / "backlog.json").write_text(json.dumps(self.items, indent=2) + "\n")
        (self.out / "gate-cards.json").write_text(json.dumps(self.state["gate_cards"], indent=2) + "\n")
        (self.out / "seed.sql").write_text(self.seed_sql())
        values = {**self.config["runtime"], "slug": self.slug}
        values = {k: fill(v, {"slug": self.slug}) if isinstance(v, str) else v for k, v in values.items()}
        values.setdefault("d1_database_id", "{d1_database_id}")
        values.setdefault("tick_mode", "cron")
        if self.tick_mode:
            values["tick_mode"] = self.tick_mode
        self.runtime = values
        worker = self.root / "adapters" / "cloudflare"
        rendered = fill((worker / "wrangler.template.jsonc").read_text(), values)
        if self.temporary:
            rendered = temporary_wrangler(rendered)
        elif values.get("tick_mode") == "alarm":  # the org config asks for the Durable Object heartbeat (no cron), e.g. when an account's cron never fires (live trial 2026-11-12)
            rendered = ladder.render_wrangler(rendered, "alarm")
        (worker / "wrangler.jsonc").write_text(rendered)
        cfg = {
            "org_slug": self.slug,
            "claim_ttl_minutes": 120,
            "max_wip_per_role": self.config["capacity"]["max_wip_per_role"],
            "plus_share": self.config["capacity"]["plus_share"],
            "policy": {k: self.policy[k] for k in ("trust", "ladder", "surfaces")},
        }
        (worker / "src" / "config.js").write_text(
            "// Generated by bootstrap/bootstrap.py from ultrastable.json and autonomy/policy.json. Do not edit.\n"
            f"export default {json.dumps(cfg, indent=2)};\n")
        return "ok", f"wrote {self.out.relative_to(self.root) if self.out.is_relative_to(self.root) else self.out}/ and worker config"

    def seed_sql(self) -> str:
        lines = ["-- Generated by bootstrap/bootstrap.py. Idempotent (INSERT OR IGNORE).", ""]
        org = {"name": self.org_name, "slug": self.slug, "seed_version": VERSION, "booted_at": now_iso()}
        for k, v in org.items():
            lines.append(f"INSERT OR IGNORE INTO org (key, value) VALUES ({sql_str(k)}, {sql_str(v)});")
        for r in self.roles:
            lines.append("INSERT OR IGNORE INTO roles (id, role, project, tick_every, model) VALUES "
                         f"({sql_str(r['id'])}, {sql_str(r['role'])}, {sql_str(r['project'])}, {r['tick_every']}, {sql_str(r['model'])});")
        for i in self.items:
            lines.append("INSERT OR IGNORE INTO items (id, title, kind, project, owner_role, trigger_on, done_check, closing_probe, priority) VALUES "
                         f"({', '.join(sql_str(i.get(k)) for k in ('id', 'title', 'kind', 'project', 'owner_role', 'trigger_on', 'done_check', 'closing_probe'))}, {i['priority']});")
        for c in self.state["gate_cards"]:
            lines.append("INSERT OR IGNORE INTO gate_cards (id, what, why_gated, default_in_effect, prepared_by_fleet, closing_probe) VALUES "
                         f"({', '.join(sql_str(c[k]) for k in ('id', 'what', 'why_gated', 'default_in_effect', 'prepared_by_fleet', 'closing_probe'))});")
        base = self.policy["trust"]["baseline"]
        for sname, surface in self.policy["surfaces"].items():
            for aname in surface["actions"]:
                lines.append("INSERT OR IGNORE INTO trust_ledger (surface, action_class, rung, reliability, outcomes) VALUES "
                             f"({sql_str(sname)}, {sql_str(aname)}, {sql_str(surface['start_rung'])}, {base}, 0);")
        for p in self.predictions:
            lines.append("INSERT OR IGNORE INTO predictions (id, item_id, metric, op, target, due_at) VALUES "
                         f"({sql_str(p['id'])}, {sql_str(p['item_id'])}, {sql_str(p['metric'])}, {sql_str(p['op'])}, {p['target']}, "
                         f"datetime('now', '+{p['due_hours']} hours'));")
        lines.append(f"INSERT OR IGNORE INTO doctrine_lineage (version, source) VALUES ({sql_str('seed-' + VERSION)}, 'agents/AGENTS.md + autonomy/policy.json');")
        return "\n".join(lines) + "\n"

    @staticmethod
    def _gh_admin_org() -> bool:
        """BG-13: a logged-in `gh` with admin:org scope is an org-admin credential."""
        if not shutil.which("gh"):
            return False
        try:
            r = subprocess.run(["gh", "auth", "status"], capture_output=True, text=True, timeout=20)
        except Exception:
            return False
        return r.returncode == 0 and "admin:org" in (r.stdout + r.stderr)

    def surfaces(self):
        """Health-check every route before relying on it (BG-9, BG-12). Recorded, never fatal."""
        free_gb = shutil.disk_usage(self.root).free / 1e9
        env = os.environ
        s = {
            "disk_free_gb": round(free_gb, 1),
            "disk_ok": free_gb >= 2.0,
            "gh_cli": bool(shutil.which("gh")),
            "git": bool(shutil.which("git")),
            "org_admin_token": bool(env.get("ORG_ADMIN_TOKEN") or env.get("GH_ORG_TOKEN")) or self._gh_admin_org(),
            "cloudflare_token": bool(env.get("CLOUDFLARE_API_TOKEN")),
        }
        self.state["surfaces"] = s
        bad = [k for k in ("disk_ok", "gh_cli", "git") if not s[k]]
        if bad:
            return "degraded", "surfaces not ready: " + ", ".join(bad)
        return "ok", "surfaces: " + ", ".join(k for k, v in s.items() if v is True)

    def org(self):
        """Org initialization plan (BG-1 to BG-7, BG-11). Applied only with an admin token."""
        org = self.config.get("org", {})
        front = self.idea["front"] if hasattr(self, "idea") else {}
        repos = [r.strip() for r in front.get("repos", "").split(",") if r.strip()] or org.get("repos", [])
        name = front.get("github_org") or org.get("name", "")  # the idea file may name its own target (GAP-SCAFFOLD-1)
        plan = [f"gh repo create {name}/{r} --private (skip if exists)" for r in repos]
        plan += [f"gh repo unarchive {name}/{r} --yes (if archived and not superseded)" for r in repos]
        plan += [f"publish brand/public-profile/profile to {name}/.github/profile and set it public",
                 "gh api PATCH orgs/%s description/blog/email" % name,
                 "org-manage projects; close-superseded"]
        self.state["org_plan"] = plan
        if not name:
            return "degraded", "ultrastable.json org.name unset; org plan not applied"
        if not self.apply:
            return "degraded", f"dry run: {len(plan)} org steps planned (see boot-log.json org_plan)"
        if not self.state.get("surfaces", {}).get("org_admin_token"):
            self.state["gate_cards"].append({
                "id": "GATE-ORG-TOKEN", "line": "IDENTITY-BOUND: mint ORG_ADMIN_TOKEN (docs/ops/ORG-TOKEN.md)",
                "default_in_effect": "profile content staged in the repo; all non-org stages continue",
                "closing_probe": "org-init workflow succeeds; curl https://github.com/" + name + " shows the profile"})
            return "blocked", "no org-admin token: gate card opened, run the org-init workflow once it exists"
        return "ok", "org token present: run the org-init workflow (.github/workflows/org-init.yml)"

    def scaffold(self):
        """Generate each target repository's CI and scheduled-cycle workflows from the idea file (GAP-SCAFFOLD-1).
        Generic: the idea names runtime, cycle_command and cycle_ledger; nothing platform-specific lives here."""
        f = self.idea["front"]
        repos = [r.strip() for r in f.get("repos", "").split(",") if r.strip()]
        if not repos:
            return "ok", "idea names no repos; nothing to scaffold"
        runtime = f.get("runtime", "python")
        cmd = f.get("cycle_command", "")
        ledger = f.get("cycle_ledger", "ledger/cycles.jsonl")
        if not cmd:
            return "degraded", "idea has repos but no cycle_command; workflows not generated"
        if runtime == "node":
            setup = ["      - uses: actions/setup-node@v4", "        with: { node-version: 22 }", "      - run: npm ci || npm install"]
            test = "npm test"
        else:
            setup = ["      - uses: actions/setup-python@v5", '        with: { python-version: "3.12" }', "      - run: pip install -e ."]
            test = "python -m unittest discover -s tests -t . -v"
        ci = ["name: ci", "# budget: about 3 minutes per push", "# trigger: push and pull_request, the check that gates merge",
              "# free-alternative: none for the test run itself; draft PRs do not run CI", "on:", "  push:", "  pull_request:",
              "permissions:", "  contents: read", "concurrency:", "  group: ci-${{ github.ref }}", "  cancel-in-progress: true",
              "jobs:", "  test:", "    runs-on: ubuntu-latest", "    timeout-minutes: 10", "    steps:", "      - uses: actions/checkout@v4"] + setup + [f"      - run: {test}"]
        cycle = ["name: cycle", f"# allow-schedule: the cycle needs a clock and the Cloudflare tick does not host this runtime; one job a day is about 150 of the 2000 free minutes a month",
                 "# budget: about 5 minutes per day", "# trigger: daily cron and manual dispatch, never faster than daily",
                 "# free-alternative: a Cloudflare cron worker that dispatches this workflow", "on:", "  schedule:", '    - cron: "17 3 * * *"',
                 "  workflow_dispatch:", "permissions:", "  contents: write", "concurrency:", "  group: cycle", "  cancel-in-progress: false",
                 "jobs:", "  cycle:", "    runs-on: ubuntu-latest", "    timeout-minutes: 15", "    steps:", "      - uses: actions/checkout@v4"] + setup + [
                f"      - run: {test}", "      - name: Run one cycle and append to the ledger",
                f"        run: {cmd} --ledger {ledger}", "      - name: Commit ledger", "        run: |",
                '          git config user.name "cycle-bot"', '          git config user.email "bot@users.noreply.github.com"',
                f"          git add {ledger}", '          git commit -m "cycle ${{ github.run_number }}" || exit 0', "          git push"]
        for r in repos:
            d = self.out / "scaffold" / r
            (d / ".github" / "workflows").mkdir(parents=True, exist_ok=True)
            (d / ".github" / "workflows" / "ci.yml").write_text("\n".join(ci) + "\n")
            (d / ".github" / "workflows" / "cycle.yml").write_text("\n".join(cycle) + "\n")
            (d / ".gitignore").write_text("__pycache__/\n*.egg-info/\nnode_modules/\n")
        return "ok", f"scaffolded CI and cycle workflows for {len(repos)} repo(s) under {self.out / 'scaffold'}"

    def ladder(self):
        """Try the bootstrap ladder (docs/BOOTSTRAP-LADDER.md) before provisioning: connect, temporary, scoped token."""
        if self.temporary:
            return "ok", "temporary route chosen with --temporary: the ladder is not needed (alarm tick, no account credential)"
        have_wrangler = bool(self.tools.get("wrangler"))
        # A dry run never downloads or starts anything: it only asks an already-installed wrangler.
        usable = have_wrangler or (self.apply and bool(self.tools.get("npx")))
        res = ladder.run_ladder(self.run_cmd, dict(os.environ), wrangler_available=usable,
                                wrangler=["wrangler"] if have_wrangler else ["npx", "wrangler"], interactive=self.interactive and self.apply,
                                target=ladder.target_account(self.config.get("runtime"), os.environ))
        self.state["ladder"] = res
        self.out.mkdir(parents=True, exist_ok=True)
        (self.out / "ladder.json").write_text(json.dumps(res, indent=2) + "\n")
        if res["route"]:  # a working route replaces the "paste a token" cards
            self.state["gate_cards"] = [c for c in self.state["gate_cards"] if not re.search(r"CLOUDFLARE_(API_TOKEN|ACCOUNT_ID)$", c["id"])]
        else:
            card = ladder.gate_card(res)
            if card and not any(c["id"] == "GATE-LADDER" for c in self.state["gate_cards"]):
                self.state["gate_cards"].append(card)
        (self.out / "gate-cards.json").write_text(json.dumps(self.state["gate_cards"], indent=2) + "\n")
        tried = ", ".join(f"{a['rung']}={a['status']}" for a in res["attempts"])
        return ("ok" if res["route"] else "degraded"), f"route {res['route'] or 'none'}; {tried}"

    def run_cmd(self, cmd, env=None, timeout=None):
        cmd = [shutil.which(cmd[0]) or cmd[0], *cmd[1:]]  # same Windows .cmd resolution as run()
        try:
            return subprocess.run(cmd, capture_output=True, text=True, env=env, timeout=timeout)
        except (OSError, subprocess.TimeoutExpired) as e:  # a missing or hung tool is a failed rung, not a crash
            return subprocess.CompletedProcess(cmd, 127, "", f"{type(e).__name__}: {e}")
    def console_token(self) -> str | None:
        """The console key for a temporary deploy. Taken from ULTRASTABLE_CONSOLE_TOKEN, else generated and written (mode 600)
        to --console-key-file so the person can read it once. Never printed, logged or put on a command line."""
        env = os.environ.get("ULTRASTABLE_CONSOLE_TOKEN")
        if env:
            return env
        if not self.console_key_file:
            return None
        import secrets
        tok = secrets.token_urlsafe(24)
        self.console_key_file.write_text(tok + "\n")
        try:
            self.console_key_file.chmod(0o600)
        except OSError:
            pass
        return tok

    def provision_temporary(self):
        """Deploy to a temporary Cloudflare account with no manual edits (issue #22): the rendered config is already the
        temporary variant; secrets and migrations use the --temporary flag, in the order the 2026-11-11 trial needed."""
        worker = self.root / "adapters" / "cloudflare"
        db = "DB"
        plan = [
            (["npx", "wrangler", "deploy", "--temporary"], None),
            (["npx", "wrangler", "d1", "migrations", "apply", db, "--temporary"], None),
            (["npx", "wrangler", "d1", "execute", db, f"--file={self.out / 'seed.sql'}", "--temporary"], None),
            (["npx", "wrangler", "secret", "put", "CONSOLE_TOKEN", "--temporary"], "token"),
        ]
        self.state["provision_plan"] = [" ".join(c) for c, _ in plan]
        if not self.apply:
            return "degraded", "dry run (temporary): planned " + str(len(plan)) + " commands (see boot-log.json provision_plan)"
        if not self.tools.get("npx"):
            return "blocked", "npx not found; install Node.js 20+"
        token = self.console_token()
        if not token:
            return "blocked", "no console key: set ULTRASTABLE_CONSOLE_TOKEN or pass --console-key-file"
        for cmd, stdin in plan:
            self.run(cmd, worker, stdin=(token + "\n") if stdin else None, scrub=token)
        return "ok", "temporary account: Worker deployed, migrations applied, seed loaded, CONSOLE_TOKEN set (no cron on this path)"

    def provision(self):
        if self.temporary:
            return self.provision_temporary()
        plan = [
            ["npx", "wrangler", "d1", "create", self.runtime["d1_database"]],
            ["npx", "wrangler", "d1", "migrations", "apply", self.runtime["d1_database"], "--remote"],
            ["npx", "wrangler", "d1", "execute", self.runtime["d1_database"], "--remote", f"--file={self.out / 'seed.sql'}"],
            ["npx", "wrangler", "deploy"],
        ]
        self.state["provision_plan"] = [" ".join(c) for c in plan]
        if not self.apply:
            return "degraded", "dry run: planned " + str(len(plan)) + " commands (see boot-log.json provision_plan)"
        route = self.state.get("ladder", {})
        if not route.get("route"):
            return "blocked", "no ladder rung reached a Cloudflare account (see org/ladder.json; one gate card opened)"
        self.cmd_env = ladder.command_env(dict(os.environ), route)  # extras applied; a token set aside by the ladder is removed
        if not self.tools.get("npx"):
            return "blocked", "npx not found; install Node.js 20+"
        worker = self.root / "adapters" / "cloudflare"
        existing = self.run(["npx", "wrangler", "d1", "list", "--json"], worker)
        db_id = None
        for d in json.loads(existing or "[]"):
            if d.get("name") == self.runtime["d1_database"]:
                db_id = d.get("uuid")
        if not db_id:
            created = self.run(plan[0], worker)
            m = re.search(r'"?database_id"?\s*[:=]\s*"([0-9a-f-]{36})"', created)
            if not m:
                return "blocked", "d1 create gave no database_id"
            db_id = m.group(1)
        wr = worker / "wrangler.jsonc"
        wr.write_text(wr.read_text().replace("{d1_database_id}", db_id))
        for cmd in plan[1:]:
            if cmd[:3] == ["npx", "wrangler", "deploy"]:
                self.deploy_with_recovery(cmd, worker, wr)
            else:
                self.run(cmd, worker)
        return "ok", f"D1 {self.runtime['d1_database']} ({db_id}) migrated and seeded; Worker deployed (tick: {self.runtime['tick_mode']}, route: {route['route']})"

    def deploy_with_recovery(self, cmd, worker, wr):
        """Deploy; on a known refusal repair and retry, once per kind. Rung 3: an account that refuses cron triggers is redeployed ticking
        from the Durable Object alarm. Heartbeat reconcile (issue #167): a redeploy failing with provisioned_class_missing_from_config is
        repaired by deleting this org's own Worker (named by the org config only; D1 and its data are separate and untouched, the Heartbeat
        object holds only alarm timestamps, and the next self-start re-puts the Worker secrets) and deploying fresh, the sequence the live
        trial proved. Both repairs are recorded in ladder.json."""
        done: set[str] = set()
        while True:
            try:
                self.run(cmd, worker)
                return
            except RuntimeError as e:
                msg = str(e)
                if ladder.is_cron_refusal(msg) and "alarm" not in done:
                    done.add("alarm")
                    wr.write_text(ladder.render_wrangler(wr.read_text(), "alarm"))
                    self.runtime["tick_mode"] = "alarm"
                    self.state["ladder"]["tick_mode"] = "alarm"
                elif ladder.is_heartbeat_reconcile_failure(msg) and "recreate" not in done:
                    done.add("recreate")
                    self.run(["npx", "wrangler", "delete", "--name", self.runtime["worker_name"], "--force"], worker)
                    self.state["ladder"]["heartbeat_recreated"] = True
                else:
                    raise
                (self.out / "ladder.json").write_text(json.dumps(self.state["ladder"], indent=2) + "\n")

    def start(self):
        if not self.apply:
            return "degraded", "dry run: the first tick runs on the Worker's cron after --apply"
        if self.runtime.get("tick_mode") == "alarm":
            return "ok", "Worker ticks from its Durable Object alarm (no cron); KIT-3 closes when six complete ticks are observed in one hour (prediction P-KIT-3)"
        return "ok", "Worker cron armed; KIT-3 closes when six complete ticks are observed in one hour (prediction P-KIT-3)"

    def run(self, cmd, cwd, stdin: str | None = None, scrub: str | None = None) -> str:
        cmd = [shutil.which(cmd[0]) or cmd[0], *cmd[1:]]  # Windows: npx is npx.cmd, which CreateProcess does not find by bare name (live trial 2026-11-12)
        p = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=600, input=stdin, env=getattr(self, "cmd_env", None))
        for _ in range(2):  # a native crash of wrangler itself (Windows libuv teardown 0xC0000409, or V8 out-of-memory 134) is not an answer; every provisioning step is idempotent, so retry (live trial 2026-11-12)
            if p.returncode not in (0xC0000409, 134) or stdin:
                break
            p = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=600, input=stdin, env=getattr(self, "cmd_env", None))
        if p.returncode != 0:
            tail = p.stderr.strip()[-400:]
            if scrub:
                tail = tail.replace(scrub, "[redacted]")
            raise RuntimeError(f"{' '.join(cmd[:4])} exited {p.returncode}: {tail}")
        return p.stdout

    @staticmethod
    def card(id_, what, why, default, prepared, probe):
        return {"id": id_, "what": what, "why_gated": why, "default_in_effect": default,
                "prepared_by_fleet": prepared, "closing_probe": probe}

    def finalize(self):
        """Stages after 'plan' may have blocked; record those as backlog items too (nothing drops silently)."""
        if not hasattr(self, "items"):
            return
        have = {i["id"] for i in self.items}
        extra = [i for i in self.state["blocked_items"] if i["id"] not in have]
        if extra:
            self.items += [dict(i, kind="work", project=None, trigger_on=None) for i in extra]
            (self.out / "backlog.json").write_text(json.dumps(self.items, indent=2) + "\n")
            (self.out / "seed.sql").write_text(self.seed_sql())

    def report(self) -> str:
        ok = sum(1 for s in self.log if s["status"] == "ok")
        blocked = [s["stage"] for s in self.log if s["status"] == "blocked"]
        lines = [
            f"Happened: seed {VERSION} booted '{getattr(self, 'org_name', '?')}' ({'apply' if self.apply else 'dry run'}): "
            f"{ok}/{len(self.log)} stages ok" + (f", blocked: {', '.join(blocked)}" if blocked else "") + ".",
            f"Decided: {len(getattr(self, 'roles', []))} role instances on models {getattr(self, 'models', {})}.",
            "Next: " + ("the Worker cron runs the tick every 10 minutes." if self.apply and not blocked
                        else "run with --apply once the gate cards below are closed."),
            f"Open: {len(getattr(self, 'items', []))} backlog item(s), {len(self.state['gate_cards'])} gate card(s): "
            + "; ".join(c["what"] for c in self.state["gate_cards"]) + ".",
        ]
        return "\n".join(lines)


def validate_policy(policy: dict) -> list[str]:
    """The rules a policy must keep. Used by the bootstrapper and by tests."""
    problems = []
    rungs = policy["ladder"]["rungs"]
    order = ["none", "propose", "execute"]
    for sname, s in policy["surfaces"].items():
        if s["start_rung"] not in rungs:
            problems.append(f"{sname}: unknown start_rung {s['start_rung']}")
        if s["max_permission"] not in order:
            problems.append(f"{sname}: unknown max_permission {s['max_permission']}")
        ceiling = policy["ladder"]["ceiling_by_max_permission"][s["max_permission"]]
        if rungs.index(s["start_rung"]) > rungs.index(ceiling):
            problems.append(f"{sname}: start_rung above its ceiling {ceiling}")
        for aname, a in s["actions"].items():
            if not a["reversible"] and a["identity_bound"] and a.get("reversible_path"):
                problems.append(f"{sname}.{aname}: gated action claims a reversible_path; then it is not gated")
            if not a["reversible"] and not a["identity_bound"] and not a.get("reversible_path") and not a.get("denied"):
                problems.append(f"{sname}.{aname}: irreversible but not gated needs a reversible_path or denied")
    for must in ("harness", "secret", "override"):
        if not any(must in l for l in policy["standing_limits"]["limits"]):
            problems.append(f"standing_limits missing '{must}'")
    return problems


def gated_actions(policy: dict):
    for sname, s in policy["surfaces"].items():
        for aname, a in s["actions"].items():
            if not a["reversible"] and a["identity_bound"]:
                yield sname, aname, a


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    mode = ap.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", action="store_true", help="plan and write files only (default)")
    mode.add_argument("--apply", action="store_true", help="also provision Cloudflare and deploy")
    ap.add_argument("--temporary", action="store_true", help="target a temporary Cloudflare account: no cron, workers_dev on, no database_id, --temporary flags")
    ap.add_argument("--console-key-file", type=Path, default=None, help="with --temporary --apply: where to write a generated console key (mode 600)")
    ap.add_argument("--root", type=Path, default=ROOT)
    ap.add_argument("--out", type=Path, default=None, help="output folder (default <root>/org)")
    ap.add_argument("--idea", type=Path, default=None, help="idea file (default <root>/IDEA.md)")
    ap.add_argument("--config", type=Path, default=None, help="org config (default <root>/ultrastable.json)")
    ap.add_argument("--tick-mode", choices=("cron", "alarm"), default=None, help="override runtime.tick_mode (alarm: the Heartbeat Durable Object ticks, no cron)")
    ap.add_argument("--interactive", action="store_true", help="with --apply, let the connect rung start `wrangler login` (the person clicks Allow)")
    a = ap.parse_args(argv)
    root = a.root.resolve()
    boot = Boot(root, (a.out or root / "org").resolve(), apply=a.apply,
                idea_path=a.idea.resolve() if a.idea else None, config_path=a.config.resolve() if a.config else None,
                interactive=a.interactive, temporary=a.temporary, tick_mode=a.tick_mode,
                console_key_file=a.console_key_file.resolve() if a.console_key_file else None)
    for name in ("read", "detect", "select", "cases", "plan", "write", "surfaces", "org", "scaffold", "ladder", "provision", "start"):
        st = boot.guard(name, getattr(boot, name))
        if name == "read" and st == "blocked" and not hasattr(boot, "idea"):
            break  # nothing to plan from; the report says why
    boot.finalize()
    rep = boot.report()
    boot.out.mkdir(parents=True, exist_ok=True)
    (boot.out / "boot-log.json").write_text(json.dumps(
        {"seed_version": VERSION, "mode": "apply" if a.apply else "dry-run", "stages": boot.log,
         "provision_plan": boot.state.get("provision_plan", []),
         "surfaces": boot.state.get("surfaces", {}), "org_plan": boot.state.get("org_plan", [])}, indent=2) + "\n")
    (boot.out / "boot-report.md").write_text(rep + "\n")
    print(rep)
    return 0 if all(s["status"] != "blocked" for s in boot.log) else 2


if __name__ == "__main__":
    sys.exit(main())
