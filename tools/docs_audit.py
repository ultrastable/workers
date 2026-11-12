"""Doc-consumption audit. Ultrastable is the foundation for any autonomous system. (owner, 2026-11-12)

Nobody reads documents here; the system runs on code. So a document may exist only if something consumes it: an agent instruction
import, code or data that names it, a check that reads it, or a generator that writes it. A document with no consumer is a CI failure.

  python3 -m foundation docs_audit --check     (or: python3 foundation/docs_audit.py --root DIR --check, the file is stdlib-only and is copied into sibling repos)  fail on orphans, broken registry rows, bad removal ledger, human-action regressions
  python3 -m foundation docs_audit --report    counts per consumption tier (docs found, wired, generated, converted, removed)
  python3 -m foundation docs_audit --orphans   list the documents nothing consumes
  python3 -m foundation docs_audit --humans    list documents that tell a person to act (a defect: file a backlog item instead)

Consumption tiers, strongest first (the registry is `doctrine/doc-consumers.json`):
  import     CLAUDE.md / AGENTS.md pull it in with `@path`, transitively
  path       a tracked non-document file (code, data, workflow, test) names its exact path
  generated  front matter `generated-by: <script>`, and the script exists
  declared   front matter `consumer: <path>`; the consumer exists, is not a document and names this file or its directory
  registry   a row in doc-consumers.json: glob -> consumer file that contains the row's `needle`
  verified   explain-only pages in `verified.globs`: every backticked file path in the page must exist, and at least one must, so the
             page cannot drift from the code it describes (a missing path is a CI failure naming the line)
  knowledge  reference documents inside `knowledge.globs`: foundation/kb.py ranks them against each issue and foundation/executor.py
             puts the best matches in the agent's prompt
A document that only mentions another document is not consuming it. Removed documents stay in the `removed` ledger with the
sha256 of what was removed and the file that still holds the same bytes, so nothing leaves the active set without a disposition.
"""
from __future__ import annotations
import fnmatch, hashlib, json, os, re, subprocess, sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
REGISTRIES = ("doctrine/doc-consumers.json", "tools/doc-consumers.json", "doc-consumers.json")
REGISTRY = REGISTRIES[0]
DOC_EXT = (".md", ".txt", ".rst")
BINARY = re.compile(r"\.(svg|png|pdf|jpe?g|ico|woff2?|zip|bundle|gif|webp)$", re.I)


def registry_path(root=REPO) -> str:
    """The registry is doctrine/doc-consumers.json here; sibling repos that carry a copy of this file keep it in tools/ or at the root."""
    for r in REGISTRIES:
        if (Path(root) / r).is_file():
            return r
    raise FileNotFoundError("no doc-consumers.json (looked in " + ", ".join(REGISTRIES) + ")")


def load(root=REPO) -> dict:
    return json.loads((Path(root) / registry_path(root)).read_text(encoding="utf-8"))


def tracked(root=REPO) -> list[str]:
    out = subprocess.run(["git", "-C", str(root), "ls-files"], capture_output=True, text=True)
    if out.returncode != 0:
        raise RuntimeError(f"git ls-files failed: {out.stderr.strip()}")
    return [f for f in out.stdout.splitlines() if (Path(root) / f).is_file()]


def is_doc(path: str) -> bool:
    return path.endswith(DOC_EXT)


def _read(root, rel):
    try:
        return (Path(root) / rel).read_text(encoding="utf-8")
    except (UnicodeDecodeError, OSError):
        return ""


def _glob(path: str, pattern: str) -> bool:
    if pattern.endswith("/**"):
        return path.startswith(pattern[:-2])
    return fnmatch.fnmatch(path, pattern)


def front_matter(text: str) -> dict:
    m = re.match(r"---\n(.*?)\n---\n", text, re.S)
    out = {}
    if m:
        for line in m.group(1).splitlines():
            k, _, v = line.partition(":")
            if k.strip() and v.strip():
                out[k.strip()] = v.strip().strip("'\"")
    return out


CODE_TOKEN = re.compile(r"`([A-Za-z0-9_][A-Za-z0-9_./-]*\.(?:js|mjs|cjs|py|json|sh|yml|yaml|toml|sql|md|html))`")


def verify_page(root, doc) -> tuple[list[str], list[str]]:
    """(resolved, unresolved) backticked file paths in a document, resolved against the repository root or the document's folder."""
    ok, missing = [], []
    for tok in sorted(set(CODE_TOKEN.findall(_read(root, doc)))):
        if "*" in tok or tok.startswith(("http", "~", "/")):
            continue
        cand = (Path(root) / tok, Path(root) / os.path.dirname(doc) / tok)
        (ok if any(c.exists() for c in cand) else missing).append(tok)
    return ok, missing


def _imports(root, docs) -> set[str]:
    seen, todo = set(), [d for d in ("CLAUDE.md", "AGENTS.md", "agents/AGENTS.md") if d in docs]
    seen.update(todo)
    while todo:
        cur = todo.pop()
        base = (Path(cur).parent)
        for ref in re.findall(r"(?m)^\s*@(\S+\.md)\s*$", _read(root, cur)):
            p = os.path.normpath((base / ref).as_posix() if not ref.startswith("/") else ref[1:]).replace(os.sep, "/")
            if p not in seen and p in docs:
                seen.add(p)
                todo.append(p)
    return seen


def _relatives(doc: str, referrer: str):
    """The spellings a file may use for `doc`: relative to its own folder or to any ancestor folder (a test that does parents[1] / "docs/X.md")."""
    out, a = [], os.path.dirname(referrer)
    while a:
        rel = os.path.relpath(doc, a)
        if not rel.startswith("..") and rel != doc:
            out.append(rel)
        a = os.path.dirname(a)
    return out


def evaluate(root=REPO) -> dict:
    """Return {doc: (tier, evidence)} for consumed docs, plus 'orphans', 'docs', and problems with registry rows."""
    root = Path(root)
    reg = load(root)
    files = tracked(root)
    docs = sorted(f for f in files if is_doc(f))
    ignore = tuple(reg.get("ignore_references_from", []))
    code = {f: _read(root, f) for f in files if not is_doc(f) and not BINARY.search(f) and not f.startswith(ignore) and f != registry_path(root)}
    consumed: dict[str, tuple[str, str]] = {}
    problems: list[str] = []
    for d in sorted(_imports(root, set(docs))):
        consumed[d] = ("import", "imported by an agent instruction file")
    for row in reg["consumers"]:
        c = row["consumer"]
        if is_doc(c) or not (root / c).is_file():
            problems.append(f"registry row {row['id']}: consumer {c} must be an existing non-document file")
            continue
        if row["needle"] not in _read(root, c):
            problems.append(f"registry row {row['id']}: consumer {c} does not contain its needle {row['needle']!r}")
            continue
        hit = [d for d in docs if any(_glob(d, g) for g in row["paths"])]
        if not hit:
            problems.append(f"registry row {row['id']}: no document matches {row['paths']} (remove the row)")
        for d in hit:
            consumed.setdefault(d, ("registry", f"{row['id']} -> {c}"))
    for d in docs:
        if d in consumed:
            continue
        fm = front_matter(_read(root, d))
        if fm.get("generated-by"):
            g = fm["generated-by"].split()[0]
            if (root / g).is_file() and not is_doc(g):
                consumed[d] = ("generated", g)
                continue
            problems.append(f"{d}: generated-by {g} does not exist")
        if fm.get("consumer"):
            c = fm["consumer"].split()[0]
            parent = str(Path(d).parent)
            if (root / c).is_file() and not is_doc(c) and (d in _read(root, c) or (parent != "." and parent + "/" in _read(root, c))):
                consumed[d] = ("declared", c)
                continue
            problems.append(f"{d}: front matter consumer {c} must be an existing non-document file that names this file or its directory")
        for f, t in code.items():
            if d in t or any(re.search(r"(?<![\w/.-])" + re.escape(rel) + r"(?![\w])", t) for rel in _relatives(d, f)):
                consumed[d] = ("path", f)
                break
    for d in docs:
        if d not in consumed and any(_glob(d, g) for g in reg.get("verified", {}).get("globs", [])):
            ok, missing = verify_page(root, d)
            if missing:
                problems.append(f"{d}: names files that do not exist ({', '.join(missing[:4])}); fix the page or the code so they agree")
            elif ok:
                consumed[d] = ("verified", f"every backticked path exists ({len(ok)})")
    kn = reg.get("knowledge", {})
    if kn:
        ex = _read(root, "foundation/executor.py")
        if "kb.retrieve" not in ex or not (root / "foundation/kb.py").is_file():
            problems.append("knowledge tier: foundation/executor.py must call kb.retrieve and foundation/kb.py must exist")
        else:
            for d in docs:
                if d.endswith(".md") and any(_glob(d, g) for g in kn["globs"]):
                    consumed.setdefault(d, ("knowledge", "foundation/kb.py -> foundation/executor.py"))
    orphans = [d for d in docs if d not in consumed]
    return {"docs": docs, "consumed": consumed, "orphans": orphans, "problems": problems, "registry": reg}


def _human_hits(text: str, pats) -> list[str]:
    hits = []
    for line in text.splitlines():
        for p in pats:
            if re.search(p, line, re.I):
                hits.append(line.strip()[:120])
                break
    return hits


def humans(root=REPO) -> dict[str, list[str]]:
    root = Path(root)
    reg = load(root)
    pats = reg["human_action_patterns"]
    exempt = reg.get("human_action_exempt", [])
    out = {}
    for d in (f for f in tracked(root) if is_doc(f)):
        if any(_glob(d, g) for g in exempt):
            continue
        h = _human_hits(_read(root, d), pats)
        if h:
            out[d] = h
    return out


def removed_check(root, reg) -> list[str]:
    """Every removed document has a disposition: identical bytes elsewhere (duplicate_of), a live replacement (superseded_by), or
    evidence that it was a dead end; its sha256 and the commit that still holds it make the removal recoverable; and nothing
    live may still name it."""
    bad, root = [], Path(root)
    removed = reg.get("removed", [])
    for r in removed:
        for k in ("path", "sha256", "reason", "date", "recover"):
            if not r.get(k):
                bad.append(f"removed ledger {r.get('path', '?')}: lacks {k}")
        if not (r.get("duplicate_of") or r.get("superseded_by") or r.get("evidence")):
            bad.append(f"removed ledger {r.get('path', '?')}: needs duplicate_of, superseded_by or evidence")
        if (root / r.get("path", "-")).exists():
            bad.append(f"removed ledger: {r['path']} is listed as removed but still exists")
        if r.get("duplicate_of"):
            dup = root / r["duplicate_of"]
            if not dup.is_file() or hashlib.sha256(dup.read_bytes()).hexdigest() != r.get("sha256"):
                bad.append(f"removed ledger {r['path']}: {r['duplicate_of']} no longer holds the same bytes (sha256 differs); restore or re-record")
        if r.get("superseded_by") and not (root / r["superseded_by"]).exists():
            bad.append(f"removed ledger {r['path']}: superseded_by {r['superseded_by']} does not exist")
    ignore = tuple(reg.get("ignore_references_from", [])) + (registry_path(root),)
    paths = {r["path"] for r in removed if r.get("path")}
    for f in tracked(root):
        if is_doc(f) or BINARY.search(f) or f.startswith(ignore):
            continue
        t = _read(root, f)
        for p in paths:
            if p in t:
                bad.append(f"{f}: still names removed document {p}; point it at the replacement or drop the reference")
    return bad


def converted_check(root, reg) -> list[str]:
    """A document converted to data keeps a row: the data file exists and a non-document consumer names it."""
    bad, root = [], Path(root)
    for c in reg.get("converted", []):
        for k in ("from", "to", "consumer", "sha256", "recover", "date"):
            if not c.get(k):
                bad.append(f"converted ledger {c.get('from', '?')}: lacks {k}")
        if (root / c.get("from", "-")).exists():
            bad.append(f"converted ledger: {c['from']} still exists next to its data file")
        if not (root / c.get("to", "-")).is_file() or is_doc(c.get("to", "")):
            bad.append(f"converted ledger {c.get('from')}: data file {c.get('to')} must exist and not be a document")
        elif not (root / c.get("consumer", "-")).is_file() or c["to"] not in _read(root, c["consumer"]):
            bad.append(f"converted ledger {c['from']}: consumer {c.get('consumer')} must exist and name {c['to']}")
    return bad


def check(root=REPO) -> list[str]:
    root = Path(root)
    ev = evaluate(root)
    reg = ev["registry"]
    bad = list(ev["problems"])
    bad += [f"orphan document (nothing consumes it): {d}: wire it, convert it to data, merge it, or remove it with a ledger row" for d in ev["orphans"]]
    bad += removed_check(root, reg)
    bad += converted_check(root, reg)
    tpl = _read(root, "brand/templates/doc-template.md")  # doc-template.md: the template every new document starts from
    if (root / "brand/templates/doc-template.md").is_file() and not re.search(r"(?m)^consumer:", tpl):
        bad.append("brand/templates/doc-template.md must carry a `consumer:` front matter line")
    base = reg.get("human_action_baseline", {})
    for d, hits in humans(root).items():
        if len(hits) > base.get(d, 0):
            bad.append(f"{d}: tells a person to act ({len(hits)} lines, baseline {base.get(d, 0)}): {hits[0]!r}; file an automatic backlog item (owner, trigger, verification) instead of writing an instruction")
    return bad


def report(root=REPO) -> dict:
    ev = evaluate(root)
    tiers: dict[str, int] = {}
    for tier, _ in ev["consumed"].values():
        tiers[tier] = tiers.get(tier, 0) + 1
    reg = ev["registry"]
    return {"docs": len(ev["docs"]), "consumed": len(ev["consumed"]), "orphans": len(ev["orphans"]), "tiers": tiers,
            "removed": len(reg.get("removed", [])), "converted": len(reg.get("converted", [])),
            "human_action_docs": len(humans(root))}


def main(argv=None) -> int:
    global REPO
    argv = list(sys.argv[1:] if argv is None else argv)
    if "--root" in argv:  # run against another checkout: python3 tools/docs_audit.py --root . --check
        i = argv.index("--root")
        REPO = Path(argv[i + 1]).resolve()
        del argv[i:i + 2]
    if "--report" in argv:
        print(json.dumps(report(REPO), indent=1))
        return 0
    if "--orphans" in argv:
        print("\n".join(evaluate(REPO)["orphans"]) or "no orphans")
        return 0
    if "--humans" in argv:
        for d, h in humans(REPO).items():
            print(d, len(h), h[0])
        return 0
    bad = check(REPO)
    print("\n".join(bad) or "docs-audit ok: " + json.dumps(report(REPO)))
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main())
