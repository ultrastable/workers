<!-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0 -->
<!-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas -->

# packs/social: claim-backed public posting

A class B pack (`US-SPEC-21`): it publishes short public posts to a configured account, from the organization's own claims registry (`core/describe`, `US-SPEC-22`), and reads each post back. It is OFF until a person enables it, and every post leaves through `guard.send` on channel `social`.

## Loops

| Loop | Does |
|---|---|
| `compose` | picks public, fresh, passing claims not used in the last `repeat_days`; writes a draft through the `compose` port (default: deterministic template); runs the checker; strips markers, tags links with UTM, queues with an idempotency key; predicts engagement |
| `publish` | reconciles with the guard ledger, then `guard.send` per queued post (caps, kill switch, approval by rung); below the act rung the post is a decision card showing its text |
| `verify` | `fetchPost` after publishing: `verified` or `failed` (a failure files item `SOCIALVERIFY-<id>`; a scheduler post still pending is waited for) |
| `metrics` | published, verified, removed, refused counts (`social_metrics`); engagement read-back; scores each prediction (`predictions` table) after `score_after_hours`; a post that vanishes is marked `removed` and files `SOCIALREMOVED-<id>` |

## Checker

`checkPost` is a function separate from the writer. It rejects a sentence without a claim id, a claim id that is not a fresh public claim, a number without a date or not in the cited claim, a link that is not `https` on the allowlist, and banned phrases from `voiceRules`. `settings.ports.checker` adds a second opinion that can only veto. `createModelPorts({ complete, composeModel, checkerModel })` builds a model writer and a fail-closed model checker over a `complete({model, system, prompt})` function (wire it to the router), and refuses a writer and checker of the same model family.

## Wiring

```js
import { createPacks, loadManifest } from '../../core/packs/index.js';
import { createBlueskyChannel, guardPort } from './index.js';

const channel = createBlueskyChannel({ fetch, env, service: config.service });   // or createSchedulerChannel({ fetch, env, baseUrl, profileId })
const packs = createPacks({ db, config: { packs: { social: {
  handle: '<account handle>', allowlist: ['<your link host>'], link_url: 'https://<your link host>/about',
  ports: { channel /*, compose, checker */ },
} } }, channels: { social: guardPort({ db, channel }) } });
await packs.register(loadManifest(dir), { dir });
```

Settings: `handle`, `allowlist`, `link_url`, `utm` (`hosts`, `params`), `claim_prefixes`, `repeat_days` (14), `max_per_run` (1), `max_backlog` (5), `max_length` (300), `baseline_engagement` (1), `verify_attempts` (3), `score_after_hours` (24), `voiceRules`. Apply `migrations/0001_social.sql` after the core and pack-host migrations. Secrets, by name only: `BLUESKY_IDENTIFIER`, `BLUESKY_APP_PASSWORD`, `SCHEDULER_ACCESS_TOKEN`; they are read from `env` at call time and never stored, logged or placed in a URL or error.

## How a person enables it

The console shows the manifest's `enable_gate` text as a decision card (what it does, will not do, cost, how to stop). The person's "yes" calls `packs.enablePack('social', { by, cardText })`; the text must equal the manifest card. Until the pack has earned the act rung, every post waits as its own card with the full text; `guard.approve(queueId, { by })` publishes it and the next `publish` run records it. `packs.disablePack('social')` or a kill switch (`pack:social`, `channel:social`, `global`) stops it at once.

## Requirements

| ID | Status | Where |
|---|---|---|
| US-21-R01 off until enabled, recorded decision, one-action disable | BUILT (host) | `enable_gate`, `core/packs` |
| US-21-R02 manifest validated at load | BUILT | `pack.json`, tested with `validateManifest` |
| US-21-R03 core imports no pack | BUILT | static check, tested here |
| US-21-R04 manager, charter, primary and guard metrics | BUILT | `social_posts_published_verified`; guards `social_removed_posts`, `social_refused_by_guard` |
| US-21-R06 every outbound action passes the guard | BUILT | `publish.js`, `guardPort` |
| US-21-R07 kill switch | BUILT | tested: stops publishing, post kept |
| US-21-R09 secrets by presence only | BUILT | channels read env by name; tested across tables and logs |
| US-21-R10 testable with fake ports | BUILT | `social.test.js`, fake channel and fake fetch |
| US-21-R11 no tenant names | BUILT | handles and hosts come from configuration; tested |
| US-21-R12 class B ceiling, queue as card below act | BUILT | tested with text shown on the card; approval publishes once |
| US-21-R13 suppression | BUILT (guard) | consent `none`; suppression is the guard's |
| US-21 s7 predicts engagement, is scored, reallocates | PARTLY: predicts and scores in `predictions`; the manager's reallocation is the core manager's | `queue.js`, `metrics.js` |
| US-22-R05 facts only from the registry | BUILT | `compose.js`, `check.js` |
| US-22-R06 numbers carry a date | BUILT | checker (`number_without_date`) |
| US-22-R07 checker separate from the writer, ideally another family | BUILT as a function and a family guard; which model runs it is host wiring | `createModelPorts` |
| Idempotent posting, daily and weekly caps | BUILT | `idem_key`, cap pre-check plus guard |
| Link facets with UTF-8 byte offsets, URL-safe truncation, UTM | BUILT | `text.js` |
| Bluesky channel (createSession, createRecord, getPosts, deleteRecord, replies) | BUILT against fake fetch; not run on the network | `channels/bluesky.js` |
| Scheduler channel (Buffer-style create, read, pending, delete) | BUILT against fake fetch; paths and base URL are configuration; no replies | `channels/scheduler.js` |
| Verification and removal incident items | BUILT | `verify.js`, `metrics.js` |
| Link cards (embed previews) | PLANNED | |
| Media posts, follow-back, replies to strangers | NOT COVERED (out of scope by design) | |
| Reading mentions or engagement from the scheduler beyond update statistics | NOT COVERED | |
