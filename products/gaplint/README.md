# gaplint

Finds open loops in any repository. Standard library only, Python 3.9+.

```
python3 -m gaplint .            # from products/gaplint, or with PYTHONPATH=products/gaplint
python3 -m gaplint . --json
pip install ./products/gaplint  # installs the `gaplint` command
```

Exit code 1 when there is any finding, so it works as a CI gate.

## Rules

| Id | Checks |
|---|---|
| GL001 | Each open `## BG-n` entry in the gap register names symptom, a fix in code, a default in effect and a closing probe. |
| GL002 | Each `OWNER-CARD*.md` names the default in effect and a closing probe. |
| GL003 | Agent files carry the standing rules, including **code is all that matters, never rely on user impact**. |
| GL004 | Hand-off reports do not assign a next step to a person (`needs you to`, `if you want`, `let me know if`). |
| GL005 | Public files contain none of the banned terms (off by default; configure `public_safe`). |
| GL006 | No secret-shaped strings. |
| GL007 | The memory file exists and has a `Last updated: YYYY-MM-DD` line. |

## Configure

Put `gaplint.json` at the repository root. Keys merge over the defaults in `gaplint/config.py`, except `required`, which replaces the default whole. `agent_rules` may be one spec or a list of specs. This repository's own file is `gaplint.json`.

## Status

BUILT: 11 tests (`python3 -m unittest discover -s tests`), run in CI as a step of the existing `checks` workflow (pull requests only, about 10 seconds, no separate workflow). NOT MEASURED: any use outside this repository. Impact is a hypothesis until another repository runs it.

## Why it exists

The agent operating agreement (`agents/AGENTS.md`) is only real if something fails when it is broken. gaplint is that check, and it ships as a tool so any repository can adopt the same loop discipline.
