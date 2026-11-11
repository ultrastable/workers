# SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
# Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
"""ultrastable command line."""
from __future__ import annotations
import argparse, json, os, sys

from . import __version__
from .config import load_config
from .demo import run_demo, seed_demo
from .engine import Engine
from .store import Store


def _engine(a) -> Engine:
    return Engine(Store(a.db), load_config(a.config))


def _table(rows, cols):
    if not rows:
        return "(none)"
    w = [max(len(c), *(len(str(r.get(c, ""))) for r in rows)) for c in cols]
    line = lambda r: "  ".join(str(r.get(c, "") if r.get(c) is not None else "").ljust(w[i])[:w[i]] for i, c in enumerate(cols))
    return "\n".join([line({c: c for c in cols}), "  ".join("-" * x for x in w)] + [line(r) for r in rows])


def main(argv=None) -> int:
    p = argparse.ArgumentParser(prog="ultrastable", description="Self-governing control loop around your coding agents.")
    p.add_argument("--db", default=os.environ.get("ULTRASTABLE_DB", "ultrastable.db"))
    p.add_argument("--config", default=os.environ.get("ULTRASTABLE_CONFIG", "ultrastable.json"))
    p.add_argument("--version", action="version", version=__version__)
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("init", help="create the database")
    t = sub.add_parser("tick", help="run the control loop N times"); t.add_argument("-n", type=int, default=1)
    sub.add_parser("status", help="KPIs, last tick report")
    b = sub.add_parser("backlog", help="list work items"); b.add_argument("--all", action="store_true")
    sub.add_parser("trust", help="trust ladder per surface/action")
    sub.add_parser("gates", help="owner gate cards")
    r = sub.add_parser("resolve", help="resolve a gate card (an owner step)"); r.add_argument("gate_id")
    a = sub.add_parser("add", help="add a work item"); a.add_argument("title")
    a.add_argument("--id"); a.add_argument("--project"); a.add_argument("--surface", default="repo")
    a.add_argument("--action", default="branch_commit_push"); a.add_argument("--priority", type=int, default=50)
    d = sub.add_parser("demo", help="seed + run a simulated organization"); d.add_argument("--ticks", type=int, default=40)
    s = sub.add_parser("serve", help="dashboard + API"); s.add_argument("--port", type=int, default=int(os.environ.get("PORT", 8080)))
    s.add_argument("--host", default="0.0.0.0"); s.add_argument("--auto-tick", type=int, default=0, help="seconds between ticks (0 = use POST /tick)")
    s.add_argument("--seed-demo", action="store_true")
    args = p.parse_args(argv)
    eng = _engine(args)

    if args.cmd == "init":
        print(f"database ready: {args.db}")
    elif args.cmd == "tick":
        for _ in range(args.n):
            print(eng.tick()["report"], "\n")
    elif args.cmd == "status":
        st = eng.state()
        print(f"{st['org']}\n" + "\n".join(f"  {k}: {v}" for k, v in st["kpis"].items()))
        if st["last_tick"]:
            print("\n" + (st["last_tick"]["report"] or ""))
    elif args.cmd == "backlog":
        rows = [i for i in eng.state()["items"] if args.all or i["status"] != "done"]
        print(_table(rows, ["id", "status", "kind", "project", "priority", "title", "blocker"]))
    elif args.cmd == "trust":
        print(_table(eng.state()["trust"], ["surface", "action_class", "rung", "reliability", "outcomes"]))
    elif args.cmd == "gates":
        print(_table(eng.state()["gates"], ["id", "status", "what", "why_gated"]))
    elif args.cmd == "resolve":
        print("resolved" if eng.resolve_gate(args.gate_id) else "no open gate with that id")
    elif args.cmd == "add":
        iid = args.id or "W-" + str(eng.s.scalar("SELECT COUNT(*)+1 FROM items")).zfill(3)
        it = eng.add_item(iid, args.title, project=args.project, surface=args.surface, action_class=args.action, priority=args.priority)
        print(json.dumps(it, indent=2))
    elif args.cmd == "demo":
        out = run_demo(eng, args.ticks)
        print(out[-1]["report"])
        print("\n" + json.dumps(eng.state()["kpis"], indent=2))
    elif args.cmd == "serve":
        from .server import serve
        if args.seed_demo and not eng.s.scalar("SELECT COUNT(*) FROM projects"):
            seed_demo(eng)
        serve(eng, args.host, args.port, args.auto_tick)
    return 0


if __name__ == "__main__":
    sys.exit(main())
