// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Provider adapter registry. Add an adapter by adding a module exporting buildRequest and parseResponse.
import * as openai from './openai.js';
import * as anthropic from './anthropic.js';
import * as workers_ai from './workers-ai.js';

export const ADAPTERS = { openai, anthropic, workers_ai };
