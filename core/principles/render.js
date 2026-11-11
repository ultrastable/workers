// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// node core/principles/render.js --write   regenerates docs/GLOSSARY.md from the register.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { load, renderGlossary } from './index.js';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../docs/GLOSSARY.md');
const text = renderGlossary(load());
if (process.argv.includes('--write')) { writeFileSync(OUT, text, 'utf8'); console.log(`wrote ${OUT}`); } else process.stdout.write(text);
