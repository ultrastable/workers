// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { toRss, toJsonFeed, itemsFrom } from './index.js';

test('feed renders escaped RSS and JSON Feed from described changes', () => {
  const items = itemsFrom([{ at: '2026-11-16T00:00:00Z', kind: 'a', id: 'x', status: 'ok' }, { at: '2026-11-16T00:00:00Z', kind: 'skip' }],
    c => c.kind === 'a' ? { title: 'a <b> & c', link: 'https://x/y', summary: c.status } : null);
  assert.equal(items.length, 1);
  assert.match(toRss({ title: 't', link: 'https://x', description: 'd', items }), /a &lt;b&gt; &amp; c/);
  assert.equal(toJsonFeed({ title: 't', link: 'https://x', feedUrl: 'https://x/feed.json', description: 'd', items }).items[0].url, 'https://x/y');
});
