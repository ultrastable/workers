<!-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0 -->
<!-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas -->

# core/codeloop: item to merged change

Merge stage of the code loop. `core/runner` carries an item to a DRAFT pull request; this module parses the `code-task:` line (`paths=a,b; test=cmd; base=branch`) and merges approved runs behind a gate.

- **Gate:** run approved, PR exists, no protected path, at most `max_files`, trust rung (port `rung('code','merge')`) at or above `merge_min_rung` (default `autonomous`), kill switch off.
- **No single route:** `hosts` is an ordered list of merge routes; a failing host falls to the next; all failures are recorded in `codeloop_merges`, never swallowed.
- **Owner role:** project-manager. **Trigger:** runner reaches `approved`. **Closing probe:** item status `done` with disposition `merged via <host>`; `codeloop_merges` row `merged`.

| Requirement | Status |
|---|---|
| task line parse, merge gate, multi-host merge, item closure | BUILT (`codeloop.test.js`) |
| planning calls and patch writing | BUILT in `core/runner` |
| a concrete GitHub merge host | NOT COVERED: `adapters/github` (planned, next batch) |
