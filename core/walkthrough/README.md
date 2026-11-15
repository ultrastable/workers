<!-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0 -->
<!-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas -->

# core/walkthrough: first run, Ask cards, read-back, profile

US-SPEC-18 sections 4 to 6. Tests: `walkthrough.test.js`, `console-rules.test.js`.

| Requirement | Status |
|---|---|
| Walkthrough generated from the needs register (`catalog.json` is the default catalog), steps 1 to 5 | BUILT (`current`, `submitIdea`); step 3 cards ride beside every step |
| US-18-R11 resumable, never blocked on one card | BUILT: the step is computed from the records on every call |
| US-18-R12 ends with exactly what runs and what does not yet | BUILT (`whatWorks`) |
| Elicitation Ask cards as decision cards with buttons (section 4) | BUILT (`answer`, `compose`) |
| Read-back screen (US-16-R12, R13, R14) | BUILT (`renderReadBack`, `correct`, `confirmReadBack`) |
| Per-person profile set from answers, with the limits of section 6 | BUILT (`profile`, `setProfile`, `validateProfile`, `compose`) |
| US-18-R01, R02, R03, R04, R08 cited against `core/src/console.js` | BUILT as tests |
| Mounted in the served console | NOT COVERED here: `core/src/console.js` is shared; it has to call `handle(request, { person })` from its signed-in routes and `screens(person, data)` for `GET /api/console` |
| The page script of the console drawing Ask cards and the walkthrough | NOT COVERED: `core/src/console-ui.js` is shared; the data and the read-back page are served |
| Languages other than English | NOT COVERED: the profile stores the language; no text is translated |

Ports: `db`, `elicit`, `now`, `config`. Owner role: product-manager. Closing probe: `node --test core/walkthrough/walkthrough.test.js`.
