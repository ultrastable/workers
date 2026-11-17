// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// IGN-6 and IGN-3b: the org tick applies ignorance mapping to its own items, and the red team can use GitHub Models with an Actions token.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { makeDb } from '../_shared/testdb.js';
import { createOrg } from '../org/index.js';
import { ignoranceStep, itemSubjects, modelFor } from './org.js';
import { githubModelsEndpoint, workersAiEndpoint, parseJsonObject, redTeamModel } from './models.js';
import { dbStore } from './store.js';
import { createModelPort } from '../modelport/index.js';
import { createRegistry } from './index.js';

const MIGS = ['core/ignorance/migrations/'].map(p => fileURLToPath(new URL('../../' + p, import.meta.url)));
const T = Date.UTC(2026, 10, 17, 12);
const mk = () => { const db = makeDb(MIGS); db.raw.exec(`INSERT INTO items (id,title,owner_role,done_check,closing_probe,status,created_at) VALUES ('a','Ship the thing','dev','tests pass',NULL,'open','2026-11-01 00:00:00'),('b','Fix the other','dev','x','probe','blocked','2026-11-16 00:00:00')`); return db; };
const ctx = () => ({ notes: [] });

test('the step maps open items, finds what they do not say, and keeps its own records in the database', async () => {
  const db = mk(), c = ctx();
  assert.equal((await itemSubjects(db)).length, 2);
  await ignoranceStep({ db, now: () => T }).run(db, c);
  assert.match(c.notes[0], /ignorance: \d+ open.*rule-based red team/);
  const reg = createRegistry({ store: dbStore(db), now: () => T }), all = await reg.list();
  assert.ok(all.some(g => /no closing probe/.test(g.text)) && all.some(g => /open 16 days/.test(g.text)) && all.some(g => /is blocked/.test(g.text)));
  assert.equal((await reg.audit()).balanced, true);
  assert.ok(JSON.parse(await dbStore(db).get('ignorance:last')).metrics);
});

test('createOrg runs the step when config.ignorance.enabled and not otherwise', async () => {
  const db = mk();
  const names = on => createOrg({ db, env: {}, config: { org_slug: 't', ignorance: { enabled: on } }, fetch: async () => new Response('{}'), now: () => T }).extraSteps({}).map(s => s.name);
  assert.ok(names(true).includes('ignorance')); assert.ok(!names(false).includes('ignorance'));
});

test('GitHub Models route: Actions token as bearer, parsed, validated, tagged unverified, family kept apart from the author', async () => {
  const calls = [];
  const f = async (url, o) => { calls.push({ url, auth: o.headers.authorization, body: JSON.parse(o.body) }); return new Response(JSON.stringify({ choices: [{ message: { content: 'Here:\n{"findings":[{"pass":"inversion","q":4,"challenge":"What if doing nothing beats this intervention in low-burden settings?","falsifier":"a head to head trial","severity":3}]}' } }], usage: { prompt_tokens: 50, completion_tokens: 40 } }), { status: 200 }); };
  const config = { ignorance: { enabled: true, model_alias: 'red', author_family: 'anthropic', token_env: 'GITHUB_TOKEN', models: { red: { endpoint: 'github_models', model: 'openai/gpt-4.1-mini', family: 'openai' } } } };
  const { model, author_family } = modelFor({ config, env: { GITHUB_TOKEN: 'ghs_x' }, fetch: f });
  assert.equal(author_family, 'anthropic'); assert.ok(model);
  const out = await model({ prompt: 'p' });
  assert.equal(out.family, 'openai'); assert.equal(calls[0].auth, 'Bearer ghs_x'); assert.match(calls[0].url, /models\.github\.ai/); assert.equal(calls[0].body.model, 'openai/gpt-4.1-mini');
  const db = mk(), c = ctx(); await ignoranceStep({ db, now: () => T, config, env: { GITHUB_TOKEN: 'ghs_x' }, fetch: f }).run(db, c);
  assert.doesNotMatch(c.notes[0], /rule-based/);
  assert.ok((await createRegistry({ store: dbStore(db), now: () => T }).list()).some(g => g.source === 'model'));
});

test('no token, a failing route, or the author family all degrade to the rule-based red team, never to silence', async () => {
  const base = { ignorance: { enabled: true, model_alias: 'red', models: { red: { endpoint: 'github_models', model: 'm', family: 'openai' } } } };
  assert.equal(modelFor({ config: base, env: {} }).model, null);
  const bad = async () => new Response('no', { status: 500 });
  const db = mk(), c = ctx(); await ignoranceStep({ db, now: () => T, config: base, env: { GITHUB_TOKEN: 't' }, fetch: bad }).run(db, c);
  assert.match(c.notes[0], /model errors 2/);
  const same = { ignorance: { ...base.ignorance, author_family: 'openai' } };
  const db2 = mk(), c2 = ctx(); const f = async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"findings":[]}' } }] }), { status: 200 });
  await ignoranceStep({ db: db2, now: () => T, config: same, env: { GITHUB_TOKEN: 't' }, fetch: f }).run(db2, c2);
  assert.match(c2.notes[0], /model errors 2/);
  assert.ok((await createRegistry({ store: dbStore(db2), now: () => T }).list()).length > 0);
});

test('endpoints: Workers AI binding, missing token, defensive JSON parsing', async () => {
  const out = await workersAiEndpoint({ ai: { run: async () => ({ response: 'hi' }) } })({ model: 'm', messages: [] }); assert.equal(out.text, 'hi'); assert.ok(out.tokens_out >= 1);
  await assert.rejects(() => githubModelsEndpoint({ fetch: async () => {} })({ model: 'm', messages: [] }), /no token/);
  assert.throws(() => parseJsonObject('nothing here'), /no JSON/);
  const port = createModelPort({ config: { aliases: { r: { endpoint: 'e', model: 'm', family: 'f' } } }, endpoints: { e: async () => ({ text: '{"findings":[]}', tokens_in: 1, tokens_out: 1 }) } });
  assert.deepEqual(await redTeamModel(port, 'r')({ prompt: 'p' }), { family: 'f', findings: [] });
});
