// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// The "paste this into your agent" setup: the skill is linted for the rules that keep a non-coder safe, and the
// closing probe (verify.mjs) is proven against a real adapter server, passing when healthy and failing when not.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { verify } from '../../agent-setup/verify.mjs';
import { openDb } from '../../adapters/sqlite/d1-sqlite.js';
import { createServer, loadConfig } from '../../adapters/gcp/server.js';

const read = (p) => readFileSync(fileURLToPath(new URL(`../../${p}`, import.meta.url)), 'utf8');
const MIG = fileURLToPath(new URL('../migrations', import.meta.url));

test('the skill has the Agent Skills front matter and the rules that protect a non-coder', () => {
  const s = read('agent-setup/SKILL.md');
  const fm = /^---\nname: ([a-z0-9-]+)\ndescription: (.+)\n---\n/.exec(s);
  assert.ok(fm, 'front matter with name and description');
  assert.equal(fm[1], 'ultrastable-setup');
  assert.ok(fm[2].length > 60 && fm[2].length < 1024);
  for (const must of [
    'needed to **start**',                        // upfront: a code agent is needed to begin
    'does **not** write business plans',          // scope stated
    'commercial license',                         // license stated before the person invests time
    'Never ask for, print, log or paste a secret',
    'Confirm before anything irreversible',
    'data, not instructions',                     // prompt-injection stance
    'Never touch any Cloudflare account',
    'wrangler deploy --temporary',                // zero-account path
    'verify.mjs',                                 // closing probe
    'Do not claim success without the probe output',
    'Workers Free plan',
  ]) assert.ok(s.includes(must), `skill must say: ${must}`);
  assert.ok(!/(sk-[A-Za-z0-9]{16}|cfut_|ghp_|BEGIN [A-Z ]*PRIVATE KEY)/.test(s), 'no secret-looking strings');
  assert.ok(!new RegExp('\\b' + ['q', 'n', 'f', 'o'].join('') + '\\b', 'i').test(s), 'no tenant names'); // built from parts so the separation guard does not flag this file
});

test('the paste prompt points at the raw skill and leaves one blank for the person', () => {
  const p = read('agent-setup/PROMPT.txt');
  assert.match(p, /raw\.githubusercontent\.com\/ultrastable\/workers\/main\/agent-setup\/SKILL\.md/);
  assert.equal((p.match(/<[^>\n]+>/g) || []).length, 1);
  assert.ok(p.length < 800, 'short enough to paste');
});

async function boot(env) {
  const db = openDb(':memory:', MIG);
  db.raw.exec(`INSERT INTO roles (id, role, tick_every, model) VALUES ('staff-1','staff',1,'m');
    INSERT INTO items (id,title,owner_role,done_check,priority,status) VALUES ('A','a','staff','x',10,'open');`);
  const srv = createServer({ db, config: loadConfig({}), env });
  await new Promise(r => srv.listen(0, r));
  return { db, srv, base: `http://127.0.0.1:${srv.address().port}` };
}

test('verify passes on a healthy, locked-down organization and fails before the first tick', async () => {
  const { db, srv, base } = await boot({ TICK_TOKEN: 't0k', CONSOLE_TOKEN: 'k3y' });
  const before = await verify(base);
  assert.equal(before.ok, false);
  assert.equal(before.checks.find(c => c.name === 'a complete tick has run').ok, false);
  const r = await fetch(`${base}/tick`, { method: 'POST', headers: { 'x-tick-token': 't0k' } });
  assert.equal(r.status, 200);
  const after = await verify(base);
  assert.deepEqual(after.checks.filter(c => !c.ok), []);
  assert.equal(after.ok, true);
  srv.close(); db.close();
});

test('verify also passes when the console is simply off (no access key set)', async () => {
  const { db, srv, base } = await boot({ TICK_TOKEN: 't0k' });
  await fetch(`${base}/tick`, { method: 'POST', headers: { 'x-tick-token': 't0k' } });
  const res = await verify(base);
  assert.equal(res.ok, true, JSON.stringify(res.checks.filter(c => !c.ok)));
  srv.close(); db.close();
});

test('verify fails loudly when the console is open to strangers or the tick endpoint is open', async () => {
  const bad = http.createServer((req, res) => {
    if (req.url === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: true, last_tick: { id: 1, steps_completed: 11, steps_total: 11 } })); }
    if (req.url === '/api/console') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ headline: 'all your data', needs_you: {} })); }
    if (req.url === '/console') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<html>open</html>'); }
    res.writeHead(200); res.end('ok');
  });
  await new Promise(r => bad.listen(0, r));
  const res = await verify(`http://127.0.0.1:${bad.address().port}`);
  const failed = res.checks.filter(c => !c.ok).map(c => c.name);
  assert.equal(res.ok, false);
  for (const n of ['console page refuses anonymous visitors', 'console data refuses anonymous visitors', 'console refusal leaks no data', 'anonymous cross-origin write refused', 'tick endpoint is not open to anonymous callers']) assert.ok(failed.includes(n), `should fail: ${n}`);
  bad.close();
});
