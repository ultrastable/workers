# Second installation outside qnfo-workers (issue #5)

Run on 2026-11-10 from a fresh clone of this repo's branch, with no QNFO code or database present:

1. `python3 -m venv v && v/bin/pip install .` in `platform/core` (clean install, no network services).
2. `python -m unittest discover -s tests`: Ran 37 tests, OK (1 skipped: the Postgres test, which needs `DATABASE_URL`).
3. In an unrelated empty git repo: `ultrastable --db s.db init`, `demo --ticks 10`, `status`. Result: 10 ticks, 11 of 11 steps each, 31 items done, 9 active, 3 open gate cards, prediction hit rate 0.971 over 34 scored, 0 silent drops, rules version 2.

The same suite also runs in this repo's CI (`checks` job), a repository other than qnfo-workers.

Limit: this proves the core installs and runs in a non-QNFO repository. A real design-partner installation is #7 (owner-led outreach, card #107). Re-run probe: the commands above reproduce the result.
