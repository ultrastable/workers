// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// US-19-R18 (issue #23): the console Help view is generated from docs/help.md and cannot drift from it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseHelp, render, SOURCE, TARGET } from '../../tools/build_help.mjs';
import { HELP_SECTIONS } from '../src/help-data.js';
import { CONSOLE_HTML } from '../src/console-ui.js';
import { handleConsole } from '../src/console.js';
import { makeDb } from '../_shared/testdb.js';
import { OUT_DIR } from '../../tools/build_migrations.mjs';

const root = (p) => fileURLToPath(new URL(`../../${p}`, import.meta.url));

test('help-data.js is exactly what tools/build_help.mjs generates from docs/help.md', () => {
  const generated = render(readFileSync(root(SOURCE), 'utf8'));
  assert.equal(readFileSync(root(TARGET), 'utf8').replace(/\r\n/g, '\n'), generated, 'stale: run node tools/build_help.mjs');
});

test('help sections are plain language: titled, non-empty, no secrets, no commands', () => {
  assert.ok(HELP_SECTIONS.length >= 5);
  for (const s of HELP_SECTIONS) {
    assert.ok(s.id && s.title && s.text.length > 40, s.id);
    assert.ok(!/wrangler|npm |node |python|`|https?:\/\//.test(s.text), `no commands or links in ${s.id}`);
    assert.ok(!/(sk-[A-Za-z0-9]{16}|cfut_|ghp_)/.test(s.text));
  }
});

test('parseHelp splits on level-2 headings and ignores the preamble', () => {
  const r = parseHelp('# T\n\npreamble\n\n## One\n\na\nb\n\nc\n\n## Empty\n\n## Two Words\n\nx\n');
  assert.deepEqual(r, [{ id: 'one', title: 'One', text: 'a b\n\nc' }, { id: 'two-words', title: 'Two Words', text: 'x' }]);
});

test('the console has a Help tab and serves the generated sections', async () => {
  assert.match(CONSOLE_HTML, /data-t="help"[^>]*>Help</);
  assert.match(CONSOLE_HTML, /id="s-help"/);
  const db = makeDb([OUT_DIR]);
  const env = { DB: db, CONSOLE_TOKEN: 'k3y' };
  const login = await handleConsole(new Request('https://x.example/console/login', { method: 'POST', body: new URLSearchParams({ key: 'k3y' }) }), env);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const res = await handleConsole(new Request('https://x.example/api/console', { headers: { cookie } }), env);
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).help, HELP_SECTIONS);
});
