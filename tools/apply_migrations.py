#!/usr/bin/env python3
# SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
# Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
"""Apply the built migrations (adapters/cloudflare/migrations/*.sql, in order) to a database. Idempotent: every migration is
IF NOT EXISTS. Two targets (no single route): --sqlite FILE applies directly; --d1 NAME prints (or with --run executes) the
wrangler command per file. A failing file stops the run with its name; nothing is swallowed.
  python tools/apply_migrations.py --sqlite local.db            python tools/apply_migrations.py --d1 my-db [--run]"""
from __future__ import annotations
import argparse, sqlite3, subprocess, sys
from pathlib import Path

DEFAULT_DIR = Path(__file__).resolve().parent.parent / "adapters" / "cloudflare" / "migrations"

def files(d):
    fs = sorted(Path(d).glob("*.sql"))
    if not fs: raise SystemExit(f"no migrations in {d}")
    return fs

def apply_sqlite(db, d=DEFAULT_DIR):
    con = sqlite3.connect(db)
    try:
        for f in files(d):
            try: con.executescript(f.read_text(encoding="utf8"))
            except sqlite3.Error as e: raise SystemExit(f"{f.name}: {e}")
        con.commit()
    finally: con.close()
    return len(files(d))

def main(argv=None):
    ap = argparse.ArgumentParser(); ap.add_argument("--sqlite"); ap.add_argument("--d1"); ap.add_argument("--run", action="store_true"); ap.add_argument("--dir", default=str(DEFAULT_DIR))
    a = ap.parse_args(argv)
    if bool(a.sqlite) == bool(a.d1): ap.error("give exactly one of --sqlite or --d1")
    if a.sqlite:
        print(f"applied {apply_sqlite(a.sqlite, a.dir)} migrations to {a.sqlite}"); return 0
    for f in files(a.dir):
        cmd = ["npx", "wrangler", "d1", "execute", a.d1, "--remote", "--file", str(f)]
        print(" ".join(cmd))
        if a.run and subprocess.run(cmd).returncode: print(f"failed: {f.name}", file=sys.stderr); return 1
    return 0

if __name__ == "__main__":
    sys.exit(main())
