<!-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0 -->
<!-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas -->

# core/benefitcost: benefit-cost in one common, non-monetary metric

Primary metric: the **WELLBY** (one point of 0-10 life satisfaction for one person for one year; the unit used in UK Treasury Green Book wellbeing guidance and by the Happier Lives Institute). A result is **WELLBYs per USD 1,000 of cost**, so costs stay in money (a resource) and benefits are never priced in money. Every other unit converts through the published parameters in `conversions.js` (`daly`, `death_averted`, `sd_ls_year`, `consumption_doubling_year`), each a distribution with a status of `cited`, `assumption` or `unverified`.

- **Higher-order effects.** A model is a causal chain of nodes. A node may have a `parent` (second and third order effects, multipliers) or be `unintended` (negative). Each link carries an evidence grade A-D; a child inherits its parent's credibility haircut, so long weak chains are worth less than short strong ones. Results split by order and by evidence grade, and report the uplift from higher-order effects over first-order only.
- **Uncertainty.** Every input is a distribution; `score` runs a seeded Monte Carlo and returns p5-p95, the probability of net benefit, the probability of beating a caller-supplied benchmark, and a rank-correlation sensitivity list. `rank_key` is the 25th percentile.
- **Self-improvement.** `applyEvidence` pools new evidence into a link by inverse-variance weighting (the prior is down-weighted by its grade), raises the grade only when higher-grade evidence is pooled and never pools a source twice. `nextEvidenceTargets` points at the influential, weakly graded links; `refineLoop` runs the pass over a tenant's models through ports (`load`, `save`, `evidenceFor`).
- **Choices left to the tenant.** Models, benchmarks, parameter overrides and the evidence finder. Nothing here names a tenant, calls the network or a model.

Requirements: none yet in `ultrastable/spec` (item filed for the spec to name them). Owner role: knowledge. Trigger: a tenant adds a model or evidence arrives. Closing probe: `benefitcost.test.js` (10 tests). Status: BUILT. Not covered: correlated inputs across nodes (all independent except shared parameters), equity weights, a monetary conversion (a tenant must supply a verified value per WELLBY; none is bundled).
