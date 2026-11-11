// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Node-only loaders for the data files (kept apart so index.js stays free of file-system imports).
import { readFileSync } from 'node:fs';

const read = name => JSON.parse(readFileSync(new URL(name, import.meta.url), 'utf8'));
export const loadSeedClaims = () => read('./seed-claims.json');
export const loadVoiceRules = () => read('./voice-rules.json');
