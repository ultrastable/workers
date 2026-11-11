# Proof: a real model fixed a real bug under the loop (2026-11-10)

Setup: scratch git repo with `calc.py` (`add` returns `a - b`) and a failing `test_calc.py`. One work item: "Fix calc.py so test_calc.py passes."
Doer: `WorkersAIAgent` (Cloudflare Workers AI, `@cf/meta/llama-3.3-70b-instruct-fp8-fast`). Verifier: `python -m unittest`, a separate process from the doer. Config: `agents.doer.kind = "workers-ai"`.

| Tick | Result |
|---|---|
| 1 | `failed`: adapter bug (Workers AI returned pre-parsed JSON). Item stayed open, repo unchanged, trust for `repo/branch_commit_push` dropped (reliability 0.33). |
| 2 | Model rewrote `calc.py` (`return a + b`); `unittest` passed; outcome `verified`; item closed with disposition. |

Also observed: the ladder opened and applied a demotion item (`delegated -> assisted`) after the first failure, and the earlier Claude Code attempt (401) failed safe without certifying anything.

Limits: one toy task, one model, self-run, no outside audit. It proves the adapter path and the verify-by-separate-check rule, not production reliability.
