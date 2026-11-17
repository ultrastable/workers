// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// core/benefitcost: benefit-cost analysis in one common, non-monetary metric (the WELLBY), with higher-order effects, evidence grades,
// Monte Carlo uncertainty and a loop that refines estimates as evidence arrives. Tenant-agnostic: models, evidence and benchmarks are the tenant's data.
export { rng, sample, summarize, validDist, moments } from './dist.js';
export { PARAMS, GRADES, UNITS } from './conversions.js';
export { validate, score, order } from './model.js';
export { pool, applyEvidence, nextEvidenceTargets, refineLoop } from './refine.js';
export { inContext, scoreIn, scoreAcross } from './context.js';
