<!-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0 -->
<!-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas -->

# core/elicit: ignorance and prompted recall

US-SPEC-16. Tests: `elicit.test.js` (T16-1 to T16-9 and the rules below).

| Requirement | Status |
|---|---|
| US-16-R01 never ask what the idea already answers (T16-1) | BUILT (`registerNeeds`, `derive_from`) |
| US-16-R02 Ask card fields, 25 words, recognition (T16-2) | BUILT (`validateCard`) |
| US-16-R03 glossary: the person's words in every card, jargon defined in the card | BUILT (`learnTerm`, `applyGlossary`, `reviewCards`) |
| US-16-R04, R16 open cap, daily cap, quiet period (T16-5) | BUILT |
| US-16-R05, R10 Not sure and timeout become the default with an assumption log entry (T16-3) | BUILT |
| US-16-R06 no default for a not-reversible, identity-bound, over-cap or private need (T16-4) | BUILT (gate card) |
| US-16-R07, R09 verbatim answer, deterministic mapping, Tell me more keeps the card | BUILT |
| US-16-R08 neutral options, default marked | BUILT |
| US-16-R11, R12, R13 provenance tags, read-back with defaults first, corrections re-run artifacts (T16-6, T16-8) | BUILT; the read-back screen is in `core/walkthrough` |
| US-16-R14 an unconfirmed read-back does not hold work | BUILT in `core/walkthrough` |
| US-16-R15 computed readiness, G1 and G2 (T16-7) | BUILT (`readiness`) |
| US-16-R17 related needs as one card sequence | BUILT (`sequence` on each card) |
| US-16-R18 no escalation when the person stops answering | BUILT (`fatigue`) |
| Four-sweep ignorance audit (T16-9) | BUILT (`audit`); the analogy list and the red-team answer are passed in by the caller |
| Section 5.3 value-of-information estimates scored later like predictions | NOT COVERED: priority is computed and stored, not yet written to the prediction table |
| System-unknown research with cited sources | NOT COVERED: no research step; `provenance: researched` is accepted when a caller supplies it |

Ports: `db`, `now`, `config`. Owner role: portfolio-manager. Closing probe: `node --test core/elicit/elicit.test.js`.
