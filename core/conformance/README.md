<!-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0 -->
<!-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas -->

# core/conformance: levels, manifest, checker

US-SPEC-00. `manifest.json` maps every requirement of every specification to its level and to the tests that cite it, or lists it as a deviation with the reason. It is generated, then checked on every test run.

```
node core/conformance/cli.js --spec-dir ../spec/specs --write --check   # regenerate and verify
node core/conformance/cli.js --declare                                  # level, versions, deviation list (US-00-T01)
node core/conformance/cli.js --run L1                                   # run the tests that prove a level (US-00-T02)
```

| Requirement | Status |
|---|---|
| US-00-R01 declared level and specification versions | BUILT (`declaration`, `manifest.json`) |
| US-00-R02 published deviation list | BUILT: every requirement no test cites is a deviation with a reason |
| US-00-R03 no overstated label | BUILT (`check`: a met entry whose test file is gone or no longer cites the requirement fails `conformance.test.js`) |
| US-00-T03 RUNNING labels backed by a production ledger row | NOT COVERED: nothing in this repository is labelled RUNNING |
| L1 tests of US-SPEC-01 and US-SPEC-14 with ids cited | BUILT (`l1.test.js`) |
| L2 record mapping of US-SPEC-01 section 4.2 | BUILT (`l2-records.json`, checked in `l1.test.js`) |
| Certification by a party other than the implementer | NOT COVERED |

What "met" means here: a test in this repository names the requirement and the test file exists. It is the test author's claim that the test proves the requirement; the checker proves the claim is still attached to a real test, not that the test is sufficient. Requirements in US-SPEC-16 and 18 carry no level tag and are counted at L2.

Owner role: reviewer. Trigger: any change to a test or a specification. Closing probe: `node --test core/conformance/conformance.test.js`.
