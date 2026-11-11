<!-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0 -->
<!-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas -->

# packs/email: the email list pack (class B)

Implements the `email` pack of `US-SPEC-21` s7: subscribe with double opt-in, confirm, unsubscribe, newsletters and notices, bounce and complaint handling. Every message leaves through `guard.send` (`core/packs`). Facts that go into message bodies belong to the claims registry (`US-SPEC-22`); this pack sends the text it is given and adds only the sender line and the unsubscribe link.

## Files

| File | Role |
|---|---|
| `pack.json` | Manifest: charter (`email_confirmed_subscribers`; guards `email_complaint_rate`, `email_unsubscribe_rate`), outbound block, `enable_gate` card |
| `service.js` | `createEmail({db, guard, now, config, env})`: `subscribe`, `confirm`, `unsubscribe`, `recordBounce`, `queueMessage`, `sendPending`, `writeMetrics` |
| `loops.js` | Tick-step entries `send` and `metrics` |
| `http.js` | `handle(request, ctx)`: `POST /subscribe`, `GET /confirm?t=`, `GET`/`POST /unsubscribe` |
| `port.js` | `emailChannel` interface (`deliver({to, subject, text, html, headers}) -> {providerId}`) and `guardPorts()` |
| `channels/cloudflare-email.js`, `channels/smtp-relay-http.js` | Provider adapters over an injected `fetch` |
| `migrations/0001_email.sql` | `email_` tables, idempotent |

## Wiring

```js
const channel = cloudflareEmail({ fetch, config: { accountId, from }, env });      // or smtpRelayHttp(...)
const packs = createPacks({ db, config: { packs: { email: { baseUrl, senderLine, hashSalt, linkSecret } } },
                            channels: guardPorts({ channel, senderLine }) });       // ports: email, email_confirm
await packs.register(loadManifest('packs/email'), { dir: 'packs/email' });
const email = createEmail({ db, guard: packs.boundGuard('email'), config, env });
handle(request, { email, baseUrl });                                                // HTTP surface
```

`baseUrl`, `senderLine` (the honest sender identification, carried by every message) and the link-signing secret `EMAIL_LINK_SECRET` come from configuration; none has a default and the service throws if one is missing. Apply the pack's migration through the host's canonical migration path, after `core/packs/migrations`.

## How a person enables the pack

The console shows the manifest's `enable_gate` text as a decision card (what the pack does, will not do, what it costs, how to stop). The person's "yes" calls `packs.enablePack('email', { by, cardText })` with that exact text, which records who, when, the text shown and a revert path (`disablePack`). A new pack starts below the act rung, so the guard queues its first sends as approval cards until trust is earned for each kind (`confirmation`, `newsletter`, `notice`).

## Design notes

- Confirmation mail goes on its own channel, `email_confirm`, because the guard refuses any `email` send before consent. Asking to subscribe is the person's own opt-in for that one message: the service grants consent on `email_confirm`, sends, then revokes it. Suppression and caps still apply to it.
- Tokens: the confirmation token comes from the guard's consent API (`crypto.getRandomValues`) and is stored hashed in `email_tokens` and in the guard. Claiming it is one conditional `UPDATE`, so it works once. Unsubscribe links carry an HMAC-signed id, so nothing is stored for them.
- Links use `?t=` and `?u=`, not `?token=`, because the guard refuses content that looks like `token=<secret>`. The HTTP surface also accepts `?token=` on `/confirm`.
- The address is stored only while it may be mailed and is cleared on unsubscribe or bounce; lookups use a salted hash. Nothing logs an address; errors from adapters carry status codes only.
- A message goes to the confirmed audience at the time of the pass; people who confirm later are not sent older issues.

## Requirements

| ID | Status | Where |
|---|---|---|
| US-21-R01 off until enabled, recorded, reversible | BUILT (core host) | `enable_gate`, test `setup` |
| US-21-R02 manifest valid | BUILT | `pack.json`, manifest test |
| US-21-R03 core imports no pack | BUILT | static check in `email.test.js` |
| US-21-R04 charter, primary and guard metrics | BUILT | `pack.json` |
| US-21-R05 loops are guarded tick steps | BUILT | `loops.js`, tick test |
| US-21-R06 every send passes `guard.send` | BUILT | `service.js` calls nothing else |
| US-21-R07 kill switch | BUILT (core host) | guard `pack:email` and `channel:email` |
| US-21-R09 secrets by presence | BUILT | token and link secret from `env`, never stored or logged |
| US-21-R10 fake ports, no network | BUILT | fake channel and fake fetch tests |
| US-21-R11 no tenant names | BUILT | test scans the pack source |
| US-21-R12 ceiling by class | BUILT (core guard) | class B |
| US-21-R13 unsubscribe and bounce immediate | BUILT | `unsubscribe`, `recordBounce` |
| s7 subscribe, confirm, unsubscribe, send, bounces | BUILT | `service.js` |
| One-click unsubscribe header | BUILT | `List-Unsubscribe`, `List-Unsubscribe-Post` |
| Webhook intake of provider bounce events | PLANNED (`recordBounce` is the entry; the HTTP route is not wired) | |
| Composing messages from the claims registry (US-SPEC-22) | PLANNED (caller supplies text) | |
| Per-subscriber unsubscribe preference center | NOT COVERED | |
| Applying the migration, scheduling `send` on a real Worker cron | PLANNED (host) | |
