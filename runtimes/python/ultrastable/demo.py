"""Seed a small demonstration organization (simulated agents; clearly labeled as such)."""
from __future__ import annotations
from datetime import datetime, timedelta, timezone

from .engine import Engine
from .store import iso

PROJECTS = [
    ("web", "Launch the public website", "Site live with pilot sign-up and analytics", 2.0),
    ("api", "Ship the customer API", "API v1 deployed with docs and rate limits", 1.5),
    ("growth", "First 50 design-partner conversations", "50 logged discovery calls", 1.0),
]

WORK = [  # (project, title, surface, action_class, priority)
    ("web", "Build landing page sections", "repo", "branch_commit_push", 20),
    ("web", "Add pilot sign-up form", "repo", "open_pr", 15),
    ("web", "Wire analytics events", "repo", "branch_commit_push", 30),
    ("web", "Fix mobile layout regressions", "repo", "branch_commit_push", 25),
    ("web", "Deploy preview of the site", "runtime", "deploy_preview", 22),
    ("web", "Point apex domain at the site", "dns", "add_record", 35),
    ("web", "Merge the green site PR", "repo", "merge_pr_green", 18),
    ("api", "Define the work-item schema", "repo", "branch_commit_push", 12),
    ("api", "Implement /items endpoints", "repo", "branch_commit_push", 14),
    ("api", "Add rate limiting", "repo", "branch_commit_push", 28),
    ("api", "Write API reference docs", "repo", "branch_commit_push", 33),
    ("api", "Deploy API preview", "runtime", "deploy_preview", 26),
    ("api", "Open PR for auth middleware", "repo", "open_pr", 21),
    ("api", "Migrate the schema (additive)", "runtime", "migrate_additive", 24),
    ("growth", "Draft outreach to 20 agencies", "outreach", "draft", 16),
    ("growth", "Send the outreach as the founder", "outreach", "send_as_owner", 17),
    ("growth", "Buy the conference sponsor package", "money", "spend", 45),
    ("growth", "Sign the pilot agreement template", "legal", "sign_or_file", 40),
    ("growth", "Draft the case study from run data", "repo", "branch_commit_push", 19),
    ("growth", "Build the discovery-call tracker", "repo", "branch_commit_push", 23),
    ("web", "Force-push cleanup of old history", "repo", "force_push_default_branch", 50),
    ("api", "Backfill pagination tests", "repo", "branch_commit_push", 31),
    ("web", "Add accessibility audit fixes", "repo", "branch_commit_push", 27),
    ("api", "Generate SDK stubs", "repo", "branch_commit_push", 34),
    ("web", "Write the pricing page copy", "repo", "branch_commit_push", 29),
    ("growth", "Open PR for the demo-video script", "repo", "open_pr", 32),
]


def seed_demo(eng: Engine, clock: datetime | None = None) -> None:
    now = iso(clock or datetime.now(timezone.utc))
    s = eng.s
    s.put("meta", {"demo": True, "agents": "simulated"})
    for pid, title, outcome, w in PROJECTS:
        s.x("INSERT OR IGNORE INTO projects (id,title,outcome,weight) VALUES (?,?,?,?)", pid, title, outcome, w)
    for i, (proj, title, surface, ac, prio) in enumerate(WORK, 1):
        eng._ensure_item(now, id=f"W-{i:03d}", title=title, project=proj, owner_role="staff", priority=prio,
                         surface=surface, action_class=ac, done_check="change merged or draft prepared, independently verified")


def run_demo(eng: Engine, ticks: int = 40, start: datetime | None = None) -> list[dict]:
    clock = start or datetime(2026, 11, 10, 9, 0, tzinfo=timezone.utc)
    seed_demo(eng, clock)
    out = []
    for _ in range(ticks):
        out.append(eng.tick(clock))
        clock += timedelta(minutes=eng.cfg["tick_minutes"])
    return out
