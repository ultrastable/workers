// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { makeDb } from '../_shared/testdb.js';
import { sweep, extractItems } from './index.js';

const mig = fileURLToPath(new URL('./migrations/', import.meta.url));
const mkStore = docs => ({ name: 'docs', list: async () => docs.map(d => ({ key: d.key, size: d.text.length, uploaded: d.uploaded || '2026-06-01T00:00:00Z' })), text: async k => docs.find(d => d.key === k).text });
const mk = (docs, config = {}) => ({ db: makeDb([mig]), now: () => Date.parse('2026-06-10T12:00:00Z'), config, store: mkStore(docs) });

test('extractItems finds unchecked boxes and list lines under open-work headings only', () => {
  const t = '# Plan\n- done thing\n## Open items\n- fix login\n2. add tests\n## Notes\n- ignore\n- [ ] ship it\n- [x] shipped';
  assert.deepEqual(extractItems(t).map(x => x[1]), ['- fix login', '2. add tests', '- [ ] ship it']);
});

test('an untraced document files one orphan item; a traced one does not', async () => {
  const ctx = mk([{ key: 'notes/alpha-plan.md', text: 'hello' }, { key: 'notes/beta.md', text: 'hi' }, { key: 'img.png', text: '' }]);
  await ctx.db.prepare("INSERT INTO items (id,title,owner_role,done_check) VALUES ('X-1','Implement alpha-plan','project-manager','done')").run();
  const r = await sweep(ctx);
  assert.equal(r.total, 2); assert.equal(r.traced, 1); assert.equal(r.orphans, 0);
  const it = await ctx.db.prepare("SELECT title, status FROM items WHERE id LIKE 'DOC-ORPHAN-%'").first();
  assert.match(it.title, /1 untraced/); assert.equal(it.status, 'open');
  assert.equal((await sweep(ctx)).newDocs, 0);
});

test('open items inside a document become one work item, once', async () => {
  const ctx = mk([{ key: 'handoff.md', text: '## Remaining\n- wire the probe\n- [ ] add test' }]);
  await sweep(ctx); await sweep(ctx);
  const n = await ctx.db.prepare("SELECT COUNT(*) n FROM items WHERE id LIKE 'DOC-ITEMS-%'").first();
  assert.equal(n.n, 1);
});

test('documents older than grandfather_before get a disposition instead of an item', async () => {
  const ctx = mk([{ key: 'old.md', text: 'x', uploaded: '2025-01-01T00:00:00Z' }], { grandfather_before: '2026-01-01T00:00:00Z' });
  const r = await sweep(ctx);
  assert.equal(r.orphans, 0);
  assert.equal((await ctx.db.prepare("SELECT COUNT(*) n FROM items WHERE id LIKE 'DOC-ORPHAN-%'").first()).n, 0);
});
