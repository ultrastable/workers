// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Worker entry for the deploy gateway. Bindings: ALLOW (plain_text JSON rules), CF_ACCOUNT_ID (plain_text), CF_DEPLOY_TOKEN (secret_text).
import { createGate } from './index.js';
export default { fetch: (req, env) => createGate({ config: { rules: JSON.parse(env.ALLOW), accountId: env.CF_ACCOUNT_ID, token: env.CF_DEPLOY_TOKEN } }).handle(req) };
