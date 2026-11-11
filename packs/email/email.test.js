// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Tests for the email pack (US-SPEC-21 class B). Fake channel and fake fetch, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { makeDb } from '../../core/_shared/testdb.js';
import { KERNEL_DIR } from '../../core/kernel/testkit.js';
import { runTick } from '../../core/src/tick.js';
import { createPacks, validateManifest, loadManifest, assertCoreImportsNoPacks, MIGRATIONS_DIR } from '../../core/packs/index.js';
import { createEmail } from './service.js';
import { guardPorts } from './port.js';
import { handle } from './http.js';
import { cloudflareEmail } from './channels/cloudflare-email.js';
import { smtpRelayHttp } from './channels/smtp-relay-http.js';

const DIR = fileURLToPath(new URL('./', import.meta.url));
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const T0 = Date.parse('2026-11-11T10:00:00Z');
const policy = JSON.parse(readFileSync(new URL('../../autonomy/policy.json', import.meta.url), 'utf8'));
const tickConfig = { org_slug: 't', claim_ttl_minutes: 120, max_wip_per_role: 3, plus_share: 0.2, policy };
const SETTINGS = { baseUrl: 'https://lists.example.org', senderLine: 'Sent by Example Org, a test sender', linkSecret: 'unit-test-link-key', hashSalt: 's' };

function fakeChannel({ fail = false } = {}) {
  const c = { sent: [], fail };
  c.deliver = async m => { if (c.fail) throw new Error('provider down'); c.sent.push(m); return { providerId: `p${c.sent.length}` }; };
  return c;
}

async function setup({ caps, settings = {}, logs = [] } = {}) {
  const clock = { t: T0 };
  const db = makeDb([MIGRATIONS_DIR, KERNEL_DIR, path.join(DIR, 'migrations')]);
  const channel = fakeChannel();
  const packs = createPacks({ db, now: () => clock.t, config: { step_timeout_ms: 2000, packs: { email: { ...SETTINGS, ...settings } } },
    channels: guardPorts({ channel, senderLine: SETTINGS.senderLine }) });
  const manifest = loadManifest(DIR);
  if (caps) manifest.outbound.caps.email = caps;
  assert.equal((await packs.register(manifest, { dir: DIR })).ok, true);
  assert.equal((await packs.enablePack('email', { by: 'owner', cardText: manifest.enable_gate })).ok, true);
  for (const kind of ['confirmation', 'newsletter', 'notice']) {
    db.raw.prepare(`INSERT INTO trust_ledger (surface, action_class, rung, reliability, outcomes) VALUES ('pack:email',?, 'delegated', 1, 50)`).run(kind);
  }
  const email = createEmail({ db, guard: packs.boundGuard('email'), now: () => clock.t, config: { ...SETTINGS, ...settings } });
  return { db, packs, channel, clock, email, guard: packs.guard };
}
const tokenFrom = mail => /\/confirm\?t=([0-9a-f]{32})/.exec(mail.text)[1];
const unsubFrom = mail => /\/unsubscribe\?u=([0-9.a-f]+)/.exec(mail.text)[1];
async function subscribeConfirmed(s, address) {
  const r = await s.email.subscribe({ email: address, source: 'test' });
  assert.equal(r.sent, true);
  assert.equal((await s.email.confirm(tokenFrom(s.channel.sent.at(-1)))).ok, true);
}
const count = (db, sql, ...a) => db.raw.prepare(sql).get(...a).n;

test('manifest is valid, class B, with the required charter, outbound block and plain-words scope', () => {
  const m = loadManifest(DIR);
  assert.deepEqual(validateManifest(m), []);
  assert.equal(m.class, 'B');
  assert.equal(m.charter.primary_metric.id, 'email_confirmed_subscribers');
  assert.deepEqual(m.charter.guard_metrics.map(g => g.id).sort(), ['email_complaint_rate', 'email_unsubscribe_rate']);
  assert.equal(m.outbound.consent, 'double_opt_in');
  assert.equal(m.outbound.suppression, true);
  assert.ok(m.outbound.channels.includes('email'));
  assert.ok(m.scope.does.length && m.scope.does_not.length);
});

test('migration is idempotent and every table is email_ prefixed', async () => {
  const { db } = await setup();
  const sql = readFileSync(path.join(DIR, 'migrations/0001_email.sql'), 'utf8');
  db.raw.exec(sql); db.raw.exec(sql);
  const names = db.raw.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'email_%'`).all().map(r => r.name).sort();
  assert.deepEqual(names, ['email_deliveries', 'email_events', 'email_messages', 'email_metrics', 'email_subscribers', 'email_tokens']);
});

test('double opt-in end to end: subscribe sends a confirmation, confirm records consent, a newsletter then reaches the subscriber', async () => {
  const s = await setup();
  const r = await s.email.subscribe({ email: 'Reader@Example.com ', source: 'footer' });
  assert.deepEqual([r.ok, r.status, r.sent], [true, 'pending', true]);
  assert.equal(s.channel.sent.length, 1);
  assert.equal(s.channel.sent[0].to, 'reader@example.com');
  assert.match(s.channel.sent[0].text, /lists\.example\.org\/confirm\?t=/);
  assert.ok(s.channel.sent[0].text.includes(SETTINGS.senderLine));
  // before confirmation a newsletter goes nowhere
  await s.email.queueMessage({ subject: 'Too early', text: 'Hello readers' });
  assert.equal((await s.email.sendPending()).sent, 0);
  assert.equal(s.channel.sent.length, 1);
  assert.equal((await s.email.confirm(tokenFrom(s.channel.sent[0]))).ok, true);
  await s.email.queueMessage({ subject: 'Issue 1', text: 'Hello readers' });
  const out = await s.email.sendPending();
  assert.equal(out.sent, 1);
  const mail = s.channel.sent[1];
  assert.equal(mail.subject, 'Issue 1');
  assert.ok(mail.text.includes(SETTINGS.senderLine), 'honest sender line');
  assert.match(mail.text, /https:\/\/lists\.example\.org\/unsubscribe\?u=/);
  assert.match(mail.headers['List-Unsubscribe'], /^<https:\/\/lists\.example\.org\/unsubscribe\?u=/);
  assert.equal(mail.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  assert.equal(count(s.db, `SELECT COUNT(*) AS n FROM email_messages WHERE status='done'`), 2);
});

test('the guard refuses a newsletter send before consent', async () => {
  const s = await setup();
  await s.email.subscribe({ email: 'a@example.com' });
  const r = await s.packs.boundGuard('email').send({ channel: 'email', kind: 'newsletter', recipient: 'a@example.com', content: JSON.stringify({ subject: 'x', text: `body ${SETTINGS.senderLine}` }), idempotencyKey: 'direct-1' });
  assert.equal(r.decision, 'refused');
  assert.equal(r.reason, 'consent_not_confirmed');
  assert.equal(s.channel.sent.length, 1);   // only the confirmation
});

test('confirmation token is single use and stored hashed', async () => {
  const s = await setup();
  await s.email.subscribe({ email: 'a@example.com' });
  const token = tokenFrom(s.channel.sent[0]);
  assert.equal((await s.email.confirm(token)).ok, true);
  assert.deepEqual(await s.email.confirm(token), { ok: false, reason: 'invalid_or_used_token' });
  assert.equal((await s.email.confirm('0'.repeat(32))).ok, false);
  for (const t of ['email_tokens', 'guard_consent', 'email_subscribers', 'guard_ledger', 'guard_queue']) {
    assert.ok(!JSON.stringify(s.db.raw.prepare(`SELECT * FROM ${t}`).all()).includes(token), `${t} must not hold the raw token`);
  }
});

test('unsubscribe is immediate, needs no approval, clears the address and later sends never reach it', async () => {
  const s = await setup();
  await subscribeConfirmed(s, 'a@example.com');
  await subscribeConfirmed(s, 'b@example.com');
  const link = unsubFrom({ text: (await (async () => { await s.email.queueMessage({ subject: 'n', text: 'hi' }); await s.email.sendPending(); return s.channel.sent.at(-1); })()).text });
  const before = s.channel.sent.length;
  assert.equal((await s.email.unsubscribe({ token: link })).ok, true);
  assert.equal((await s.email.unsubscribe({ token: 'bad.token' })).ok, false);
  const row = s.db.raw.prepare(`SELECT status, address FROM email_subscribers WHERE id = ?`).get(Number(link.split('.')[0]));
  assert.deepEqual({ ...row }, { status: 'unsubscribed', address: null });
  await s.email.queueMessage({ subject: 'n2', text: 'again' });
  await s.email.sendPending();
  const recipients = s.channel.sent.slice(before).map(m => m.to);
  assert.equal(recipients.length, 1, 'only the remaining subscriber is mailed');
  // by address too, and re-subscribing does not override the suppression
  assert.equal((await s.email.unsubscribe({ email: 'b@example.com' })).ok, true);
  const again = await s.email.subscribe({ email: 'b@example.com' });
  assert.equal(again.sent, false);
});

test('a suppressed address is never sent, even when it is still marked confirmed', async () => {
  const s = await setup();
  await subscribeConfirmed(s, 'a@example.com');
  await s.guard.suppress({ channel: '*', recipient: 'a@example.com', reason: 'manual' });
  await s.email.queueMessage({ subject: 'n', text: 'hi' });
  const before = s.channel.sent.length;
  const out = await s.email.sendPending();
  assert.equal(s.channel.sent.length, before);
  assert.equal(out.skipped, 1);
});

test('caps are respected: the batch stops at the daily cap and resumes the next day', async () => {
  const s = await setup({ caps: { per_day: 3, per_week: 100 } });
  for (const a of ['a', 'b', 'c', 'd']) await subscribeConfirmed(s, `${a}@example.com`);   // confirmations use their own channel cap
  await s.email.queueMessage({ subject: 'n', text: 'hi' });
  const first = await s.email.sendPending();
  assert.equal(first.sent, 3);
  assert.equal(first.stopped, 'cap_per_day');
  assert.equal(s.channel.sent.filter(m => m.subject === 'n').length, 3);
  s.clock.t += 25 * 3600e3;
  const second = await s.email.sendPending();
  assert.equal(second.sent, 1);
  assert.equal(s.channel.sent.filter(m => m.subject === 'n').length, 4);
});

test('batch size bounds one pass', async () => {
  const s = await setup();
  for (const a of ['a', 'b', 'c']) await subscribeConfirmed(s, `${a}@example.com`);
  await s.email.queueMessage({ subject: 'n', text: 'hi' });
  assert.equal((await s.email.sendPending({ limit: 2 })).sent, 2);
  assert.equal((await s.email.sendPending({ limit: 2 })).sent, 1);
});

test('idempotent retry sends once: a crash after delivery and a second pass do not duplicate', async () => {
  const s = await setup();
  await subscribeConfirmed(s, 'a@example.com');
  const { messageId } = await s.email.queueMessage({ subject: 'n', text: 'hi' });
  await s.email.sendPending();
  const n = s.channel.sent.filter(m => m.subject === 'n').length;
  assert.equal(n, 1);
  // simulate losing the delivery record, then retrying
  s.db.raw.prepare(`DELETE FROM email_deliveries`).run();
  s.db.raw.prepare(`UPDATE email_messages SET status = 'queued' WHERE id = ?`).run(messageId);
  const r = await s.email.sendPending();
  assert.equal(s.channel.sent.filter(m => m.subject === 'n').length, 1);
  assert.equal(r.sent, 1);   // recorded as sent from the guard's duplicate answer
});

test('bounce and complaint intake suppress at once; soft bounces suppress on the third', async () => {
  const s = await setup();
  await subscribeConfirmed(s, 'a@example.com');
  await subscribeConfirmed(s, 'b@example.com');
  await subscribeConfirmed(s, 'c@example.com');
  assert.equal((await s.email.recordBounce({ address: 'a@example.com', type: 'hard' })).suppressed, true);
  assert.equal((await s.email.recordBounce({ address: 'b@example.com', type: 'complaint' })).suppressed, true);
  assert.equal((await s.email.recordBounce({ address: 'c@example.com', type: 'soft' })).suppressed, false);
  assert.equal((await s.email.recordBounce({ address: 'c@example.com', type: 'soft' })).suppressed, false);
  assert.equal((await s.email.recordBounce({ address: 'c@example.com', type: 'soft' })).suppressed, true);
  const before = s.channel.sent.length;
  await s.email.queueMessage({ subject: 'n', text: 'hi' });
  await s.email.sendPending();
  assert.equal(s.channel.sent.length, before);
  const st = Object.fromEntries(s.db.raw.prepare(`SELECT status, COUNT(*) AS n FROM email_subscribers GROUP BY status`).all().map(r => [r.status, r.n]));
  assert.deepEqual(st, { bounced: 2, unsubscribed: 1 });
  assert.equal(count(s.db, `SELECT COUNT(*) AS n FROM guard_suppression`), 3);
});

test('metrics step writes confirmed, pending, unsubscribed and bounced counts and the pack loops run as tick steps', async () => {
  const s = await setup();
  await subscribeConfirmed(s, 'a@example.com');
  await s.email.subscribe({ email: 'p@example.com' });
  await s.email.recordBounce({ address: 'a@example.com' });
  await s.email.queueMessage({ subject: 'n', text: 'hi' });
  const r = await runTick(s.db, { config: tickConfig, now: T0, extraSteps: await s.packs.packSteps() });
  assert.deepEqual(r.errors || [], []);
  const m = s.db.raw.prepare(`SELECT confirmed, pending, unsubscribed, bounced FROM email_metrics`).get();
  assert.deepEqual({ ...m }, { confirmed: 0, pending: 1, unsubscribed: 0, bounced: 1 });
  const probe = s.db.raw.prepare(loadManifest(DIR).charter.primary_metric.read_probe).get();
  assert.equal(probe.value, 0);
});

test('a confirmation is refused for a suppressed address and counts against caps', async () => {
  const s = await setup();
  await s.email.unsubscribe({ email: 'x@example.com' });
  const r = await s.email.subscribe({ email: 'x@example.com' });
  assert.equal(r.sent, false);
  assert.equal(s.channel.sent.length, 0);
  const s2 = await setup();
  s2.db.raw.prepare(`UPDATE packs_registry SET manifest_json = json_set(manifest_json, '$.outbound.caps.email_confirm.per_day', 1)`).run();
  assert.equal((await s2.email.subscribe({ email: 'a@example.com' })).sent, true);
  assert.equal((await s2.email.subscribe({ email: 'b@example.com' })).sent, false);
});

test('addresses and tokens never appear in logs, tick notes or error text', async () => {
  const seen = [];
  const orig = {}; for (const k of ['log', 'info', 'warn', 'error', 'debug']) { orig[k] = console[k]; console[k] = (...a) => seen.push(a.join(' ')); }
  try {
    const s = await setup();
    await subscribeConfirmed(s, 'secret.person@example.com');
    await s.email.queueMessage({ subject: 'n', text: 'hi' });
    const r = await runTick(s.db, { config: tickConfig, now: T0, extraSteps: await s.packs.packSteps() });
    seen.push(JSON.stringify(r));
    s.channel.fail = true;
    await s.email.queueMessage({ subject: 'm', text: 'hi' });
    seen.push(JSON.stringify(await s.email.sendPending()));
    const req = (p, init) => new Request(`https://lists.example.org${p}`, init);
    const bad = await handle(req('/subscribe', { method: 'POST', headers: { origin: 'https://lists.example.org', 'content-type': 'application/json' }, body: JSON.stringify({ email: 'secret.person@example.com' }) }), { email: s.email, baseUrl: SETTINGS.baseUrl });
    seen.push(await bad.text());
    // the guard ledger holds hashes only
    assert.ok(!JSON.stringify(s.db.raw.prepare(`SELECT * FROM guard_ledger`).all()).includes('secret.person'));
    assert.ok(!JSON.stringify(s.db.raw.prepare(`SELECT * FROM packs_runs`).all()).includes('secret.person'));
  } finally { Object.assign(console, orig); }
  assert.ok(!seen.join('\n').includes('secret.person'), 'no address in any log or output');
});

test('HTTP: subscribe is same-origin only, confirm and unsubscribe work from links, one-click POST unsubscribes', async () => {
  const s = await setup();
  const ctx = { email: s.email, baseUrl: SETTINGS.baseUrl };
  const req = (p, init) => new Request(`https://lists.example.org${p}`, init);
  const post = (origin, email) => handle(req('/subscribe', { method: 'POST', headers: { ...(origin ? { origin } : {}), 'content-type': 'application/x-www-form-urlencoded' }, body: `email=${encodeURIComponent(email)}` }), ctx);
  assert.equal((await post('https://evil.example.net', 'a@example.com')).status, 403);
  assert.equal((await post(null, 'a@example.com')).status, 403);
  assert.equal((await post('https://lists.example.org', 'not-an-email')).status, 400);
  assert.equal((await post('https://lists.example.org', 'a@example.com')).status, 202);
  assert.equal(s.channel.sent.length, 1);
  const c = await handle(req(`/confirm?token=${tokenFrom(s.channel.sent[0])}`), ctx);
  assert.equal(c.status, 200);
  assert.equal((await handle(req(`/confirm?t=${tokenFrom(s.channel.sent[0])}`), ctx)).status, 400);
  await s.email.queueMessage({ subject: 'n', text: 'hi' });
  await s.email.sendPending();
  const u = unsubFrom(s.channel.sent.at(-1));
  const oneClick = await handle(req(`/unsubscribe?u=${u}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' }), ctx);
  assert.equal(oneClick.status, 200);
  assert.equal(count(s.db, `SELECT COUNT(*) AS n FROM email_subscribers WHERE status='unsubscribed'`), 1);
  assert.equal((await handle(req(`/unsubscribe?u=${u}`), ctx)).status, 200);
  assert.equal((await handle(req('/unsubscribe?u=zzz'), ctx)).status, 400);
  assert.equal((await handle(req('/nope'), ctx)).status, 404);
});

test('HTTP: subscribe is rate limited per hour', async () => {
  const s = await setup({ settings: { subscribePerHour: 2 } });
  const ctx = { email: s.email, baseUrl: SETTINGS.baseUrl };
  const go = e => handle(new Request('https://lists.example.org/subscribe', { method: 'POST', headers: { origin: 'https://lists.example.org', 'content-type': 'application/json' }, body: JSON.stringify({ email: e }) }), ctx);
  assert.equal((await go('a@example.com')).status, 202);
  assert.equal((await go('b@example.com')).status, 202);
  assert.equal((await go('c@example.com')).status, 429);
});

test('config is required: no default tenant for links or sender line', async () => {
  const s = await setup();
  const bare = createEmail({ db: s.db, guard: s.packs.boundGuard('email'), config: {} });
  await assert.rejects(() => bare.subscribe({ email: 'a@example.com' }), /baseUrl/);
});

test('cloudflare-email adapter posts through the injected fetch and hides the token from errors', async () => {
  const calls = [];
  const fetch = async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, json: async () => ({ success: true, result: { message_id: 'm-1' } }) }; };
  const ch = cloudflareEmail({ fetch, config: { accountId: 'acct-1', from: 'list@example.org' }, env: { EMAIL_PROVIDER_TOKEN: 'tok-value-1234' } });
  assert.deepEqual(await ch.deliver({ to: 'a@example.com', subject: 's', text: 't', headers: { 'List-Unsubscribe': '<u>' } }), { providerId: 'm-1' });
  assert.equal(calls[0].url, 'https://api.cloudflare.com/client/v4/accounts/acct-1/email/sending/send');
  assert.equal(calls[0].init.headers.authorization, 'Bearer tok-value-1234');
  assert.deepEqual(JSON.parse(calls[0].init.body), { from: 'list@example.org', to: 'a@example.com', subject: 's', text: 't', headers: { 'List-Unsubscribe': '<u>' } });
  const failing = cloudflareEmail({ fetch: async () => ({ ok: false, status: 429, json: async () => ({ success: false, errors: [{ message: 'slow down' }] }) }), config: { accountId: 'acct-1', from: 'l@example.org' }, env: { EMAIL_PROVIDER_TOKEN: 'tok-value-1234' } });
  await assert.rejects(() => failing.deliver({ to: 'a@example.com', subject: 's', text: 't' }), e => /429/.test(e.message) && !/tok-value|a@example/.test(e.message));
  await assert.rejects(() => cloudflareEmail({ fetch, config: { accountId: 'a', from: 'f@example.org' }, env: {} }).deliver({ to: 'a@example.com', subject: 's', text: 't' }), /not set/);
  assert.throws(() => cloudflareEmail({ fetch, config: {} }), /accountId/);
});

test('smtp-relay-http adapter posts one JSON message to the configured https endpoint', async () => {
  const calls = [];
  const fetch = async (url, init) => { calls.push({ url, init }); return { ok: true, status: 202, json: async () => ({ id: 'r-9' }) }; };
  const ch = smtpRelayHttp({ fetch, config: { endpoint: 'https://relay.example.net/v1/send', from: 'list@example.org', authHeader: 'x-api-key', authScheme: '' }, env: { EMAIL_PROVIDER_TOKEN: 'tok-value-1234' } });
  assert.deepEqual(await ch.deliver({ to: 'a@example.com', subject: 's', text: 't', html: '<p>t</p>' }), { providerId: 'r-9' });
  assert.equal(calls[0].url, 'https://relay.example.net/v1/send');
  assert.equal(calls[0].init.headers['x-api-key'], 'tok-value-1234');
  assert.equal(JSON.parse(calls[0].init.body).html, '<p>t</p>');
  assert.throws(() => smtpRelayHttp({ fetch, config: { endpoint: 'http://insecure.example.net', from: 'f@example.org' } }), /https/);
  const failing = smtpRelayHttp({ fetch: async () => ({ ok: false, status: 500 }), config: { endpoint: 'https://relay.example.net/v1/send', from: 'f@example.org' }, env: { EMAIL_PROVIDER_TOKEN: 'x1234567890' } });
  await assert.rejects(() => failing.deliver({ to: 'a@example.com', subject: 's', text: 't' }), /500/);
});

test('a provider outage is retried, then given up after three attempts, never duplicated', async () => {
  const s = await setup();
  await subscribeConfirmed(s, 'a@example.com');
  await s.email.queueMessage({ subject: 'n', text: 'hi' });
  s.channel.fail = true;
  for (let i = 0; i < 4; i++) await s.email.sendPending();
  const d = s.db.raw.prepare(`SELECT status, attempts FROM email_deliveries`).get();
  assert.deepEqual({ ...d }, { status: 'failed', attempts: 3 });
  s.channel.fail = false;
  assert.equal((await s.email.sendPending()).sent, 0);
});

test('core imports no pack, and the pack source names no tenant', () => {
  assert.deepEqual(assertCoreImportsNoPacks(ROOT), []);
  const forbidden = new RegExp(['qn' + 'fo', 'quni' + 'verse', '\\bq0' + '8\\b', 'rwn' + 'q8', 'edb1' + '67b7'].join('|'), 'i');
  const hits = [];
  const walk = p => statSync(p).isDirectory() ? readdirSync(p).forEach(n => walk(path.join(p, n))) : (() => {
    readFileSync(p, 'utf8').split('\n').forEach((l, i) => { if (forbidden.test(l) && !/SPDX|Copyright \(c\)/.test(l)) hits.push(`${p}:${i + 1}`); });
    if (/\.(js|sql)$/.test(p)) assert.match(readFileSync(p, 'utf8').split('\n').slice(0, 2).join('\n'), /SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0\n(\/\/|--) Copyright/, `SPDX header in ${p}`);
  })();
  walk(DIR);
  assert.deepEqual(hits, []);
});
