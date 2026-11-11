#!/usr/bin/env python3
# SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
# Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
"""Outline of a module tree: for each .js/.mjs/.py file, its leading comment, exports and top-level defs. Lets an agent read the shape of
a module without reading the source. Two parsers (JS regex, Python ast), one output. --json for machine use.
  python tools/outline.py core/router [--json]"""
from __future__ import annotations
import argparse, ast, json, re, sys
from pathlib import Path

JS_EXPORT = re.compile(r"^export\s+(?:async\s+)?(?:function\*?|const|class|let)\s+([A-Za-z_$][\w$]*)", re.M)

def outline_file(p: Path):
    text = p.read_text(encoding="utf8", errors="replace")
    if p.suffix == ".py":
        try: tree = ast.parse(text)
        except SyntaxError as e: return {"file": str(p), "error": f"syntax error line {e.lineno}"}
        names = [n.name for n in tree.body if isinstance(n, (ast.FunctionDef, ast.ClassDef, ast.AsyncFunctionDef))]
        doc = (ast.get_docstring(tree) or "").splitlines()[:1]
        return {"file": str(p), "summary": doc[0] if doc else "", "defs": names}
    comments = [l[2:].strip() for l in text.splitlines()[:6] if l.startswith("//") and "SPDX" not in l and "Copyright" not in l]
    return {"file": str(p), "summary": comments[0] if comments else "", "defs": JS_EXPORT.findall(text)}

def outline(root):
    root = Path(root); fs = [root] if root.is_file() else sorted(x for x in root.rglob("*") if x.suffix in (".js", ".mjs", ".py") and "node_modules" not in x.parts and not x.name.endswith(".test.js"))
    return [outline_file(f) for f in fs]

def main(argv=None):
    ap = argparse.ArgumentParser(); ap.add_argument("path"); ap.add_argument("--json", action="store_true"); a = ap.parse_args(argv)
    o = outline(a.path)
    if a.json: print(json.dumps(o, indent=2))
    else:
        for e in o: print(f"{e['file']}: {e.get('summary') or e.get('error', '')}\n  " + ", ".join(e.get("defs", [])))
    return 1 if any("error" in e for e in o) else 0

if __name__ == "__main__":
    sys.exit(main())
