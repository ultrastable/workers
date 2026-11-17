// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import * as ui from './index.js';

const shell = { brand: { name: 'Example', href: '/' }, nav: [{ label: 'One', href: '/one' }], search: { action: '/s', label: 'Search' }, footer: { columns: [{ title: 'Links', links: [{ label: 'A', href: '/a' }] }], note: 'Note' } };
const page = body => ui.renderPage(shell, { path: '/x', title: 'T', description: 'D', body }, 'https://e.test');

test('every colour pair meets its WCAG ratio in light and dark, and a theme is re-checked', () => {
  assert.deepEqual(ui.contrastReport().filter(r => !r.ok), []);
  assert.ok(ui.contrastReport({ light: { ink: '#cccccc' } }).some(r => !r.ok), 'a bad theme is caught');
});

test('a page built from the components passes the structural audit', () => {
  const body = `${ui.breadcrumbs([{ label: 'Home', href: '/' }, { label: 'X' }])}<h1>Title</h1>${ui.keyMessages(['<b>a</b>'])}${ui.cardGrid([ui.card({ title: 'C', href: '/c', body: 'b', badges: [ui.badge('ok', 'ok')] })])}
${ui.section({ id: 's', title: 'S', body: ui.table({ caption: 'T', head: ['', 'A'], rows: [['r', 'v']] }) + ui.summaryList([['k', 'v']]) })}${ui.facets({ action: '/s', groups: [{ name: 'g', label: 'G', options: [{ value: '', label: 'Any' }] }] })}${ui.pagination({ page: 2, pages: 5, href: n => '/p' + n })}`;
  assert.deepEqual(ui.auditHtml(page(body)), []);
});

test('text is escaped and unsafe link targets are neutralised', () => {
  const h = ui.card({ title: '<img onerror=x>', href: 'javascript:alert(1)', body: '"><script>' });
  assert.ok(!h.includes('<img') && !h.includes('<script') && h.includes('href="#"'));
  assert.equal(ui.jsonScript({ a: '</script><b>' }).split('</script>').length, 2, 'only the closing tag');
});

test('the auditor flags missing structure', () => {
  const bad = ui.auditHtml('<html><title></title><body><h1>a</h1><h3>b</h3><a href="/x"></a><img src="a"><table><tr><td>1</td></tr></table><script>1</script></body></html>');
  for (const r of ['lang', 'title', 'heading-order', 'main', 'skip-link', 'link-name', 'img-alt', 'table-caption', 'scripts']) assert.ok(bad.some(v => v.rule === r), r);
});

test('core/ui names no tenant and imports only itself', () => {
  for (const f of readdirSync(new URL('.', import.meta.url)).filter(f => f.endsWith('.js') && !f.endsWith('.test.js'))) {
    const t = readFileSync(new URL(f, import.meta.url), 'utf8');
    for (const m of t.matchAll(/from '([^']+)'/g)) assert.ok(m[1].startsWith('./'), `${f} imports ${m[1]}`);
    assert.ok(!/practical|workers\.dev|qnfo|github\.com/i.test(t.replace(/^\/\/.*$/gm, '')), f);
  }
});
