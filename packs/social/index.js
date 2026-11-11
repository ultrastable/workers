// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Public surface of the social pack: the host wires channels and ports, the loops are entered through pack.json.
export { composeLoop, defaultCompose } from './compose.js';
export { publishLoop, guardPort, reconcile, CHANNEL } from './publish.js';
export { verifyLoop } from './verify.js';
export { metricsLoop } from './metrics.js';
export { checkPost, createModelPorts, modelFamily } from './check.js';
export { findUrls, linkFacets, truncate, addUtm, hostAllowed } from './text.js';
export { createBlueskyChannel } from './channels/bluesky.js';
export { createSchedulerChannel } from './channels/scheduler.js';
