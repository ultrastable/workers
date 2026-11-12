<!-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0 -->
<!-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas -->

# core/packs: capability packs and the outbound guard

Implements `US-SPEC-21`. A pack is an optional set of code loops (email, social, analytics, ...) with its own manager, charter, caps and kill switch. It is OFF until a person enables it, and everything it sends outside the organization goes through one function, `guard.send`. Core never imports a pack.

## Wiring

```js
import { createPacks, MIGRATIONS_DIR, loadManifest } from './core/packs/index.js';

const packs = createPacks({ db, now, config: { packs: { example: { recipients: [...] } } }, channels: { fake: fakeChannelPort } });
await packs.register(loadManifest(dir), { dir });       // validates; refuses at load (R02)
await packs.enablePack('example', { by: 'person', cardText });   // the console decision card (R01)
await runTick(db, { config, extraSteps: [...L2_EXTRA_STEPS, ...await packs.packSteps()] });   // enabled packs only
```

`channels` is the port the guard delivers through: `{ <name>: { send({pack, channel, kind, recipient, content, idempotencyKey}) -> { id }, maxLength?, senderId? } }`. `importer` (default: Node dynamic import) loads loop modules; a Worker host injects its own. Apply `core/packs/migrations/` after the seed and kernel migrations; a pack's own migrations are applied by the host through the canonical migration path.

## How a person enables a pack

The console shows the pack's `enable_gate` text as a decision card (what it does, will not do, costs, how to stop). The person's "yes" calls `enablePack(id, { by, cardText })`. The text must equal the manifest's card, so what was shown is what is recorded. That writes `packs_registry` (who, when, card text shown, decision id), a `kernel_decisions` row with revert path `disablePack(id)`, the pack's program charter and metrics (primary and guard), a manager role `pack-manager-<id>` and a first plus item. `disablePack(id)` stops the loops on the next tick and the guard refuses the pack's sends at once. Queued sends wait as gate cards for approval (`guard.approve(queueId, {by})` / `guard.reject`).

## How to write a pack

A directory with `core/packs/example/pack.json` and code. See `example/` (class B, a `noop-notify` loop, a fake channel).

| Manifest field | Notes |
|---|---|
| `id` (`[a-z][a-z0-9_]*`), `name`, `version`, `class` A-D | Metric ids and table names start with `<id>_` |
| `scope.does`, `scope.does_not` | `does` is scanned for the out-of-bounds behaviors of s3 and refused |
| `charter` | `objective`, `primary_metric`, at least one `guard_metrics` (`{id, op, target, read_probe}`; probe is one SELECT) |
| `requires` | `ports`, `secrets` (NAMES only), `specs` |
| `loops` | `{id, every_ticks, entry: "./file.js#export", outbound}`; the export is `async ({db, ctx, now, pack, settings, guard}) => {}` |
| `outbound` | required when a loop is outbound: `channels`, `caps: {ch: {per_day, per_week}}`, `consent` (`none`/`single_opt_in`/`double_opt_in`), `suppression: true`, `approval` (`by_rung`/`always`) |
| `defaults` | Config defaults; real hosts, account ids and configured tenant names are refused (R11) |
| `enable_gate` | The plain-words card |

A loop reaches outside only through the `guard` it is given, bound to its own pack id. Class C packs have no outbound loop and the guard also never lets them send. Class ceilings (config `ceilings`, `act_rung`): A top rung, B `autonomous`, C `observed`, D `delegated`; earned trust above the ceiling is clamped. The act rung is `delegated` by default; below it, sends queue as a card.

## Requirements

| ID | Status | Where |
|---|---|---|
| US-21-R01 off until enabled, recorded decision, one-action disable | BUILT | `enablePack`, `disablePack`, `packSteps` (enabled only) |
| US-21-R02 manifest validated at load | BUILT | `validateManifest`, `register` |
| US-21-R03 core does not import a pack | BUILT (static check) | `assertCoreImportsNoPacks`, tested over `core/` and `adapters/` |
| US-21-R04 manager role, charter, primary and guard metric, plus items | BUILT | `enablePack` seeds roles and kernel records (kernel tables optional) |
| US-21-R05 guarded tick step per loop | BUILT | error filed as `PACKFAIL-*` item, timeout, run counts in `packs_runs` |
| US-21-R06 every outbound action passes the guard | BUILT: the host gives loops only a frozen `boundGuard` and a sandboxed db | `createGuard.send` |
| US-21-R07 independent kill switch | BUILT | `packs_switches` (`global`, `pack:<id>`, `channel:<name>`) |
| US-21-R08 pack cannot change core or other packs | BUILT: loops get `sandboxDb` (writes only to `<id>_*`, `items`, `predictions`; no DDL, PRAGMA, registry, switches or consent tokens), a restricted ctx (no env or config) and a frozen bound guard; `register` scans pack source for escaping imports, fs, eval | `sandbox.js`, `sandbox.test.js` |
| US-21-R09 secrets by presence only | BUILT for manifests (names only) and content (secret patterns refused, hashes stored); the host must keep values out of loop logs | `SECRET_PATTERNS` |
| US-21-R10 testable with fake ports | BUILT | `packs.test.js` |
| US-21-R11 no tenant names in code or defaults | BUILT (hosts, account ids, configured `tenant_names`) | `validateManifest`, `core/test/no-qnfo.test.js` |
| US-21-R12 autonomy ceiling by class | BUILT | `rungCeilings`, rung clamp in the guard |
| US-21-R13 unsubscribe and suppression immediate | BUILT | `guard.unsubscribe`, `guard.suppress` (also cancels queued items) |
| US-21-R14 one guard for every pack and platform | BUILT | same `createGuard` code, ports injected |
| s6 check order | BUILT (pack, switches, class, idempotency, suppression, consent, caps, content, approval, deliver); re-run at approval | `guard.js` |
| T21-1 .. T21-8 | BUILT | `packs.test.js` |
| Honest sender identification | BUILT when the channel port declares `senderId` | |
| Bounce and complaint intake | NOT COVERED (use `guard.suppress({reason: 'bounce'})` from the pack) | |
| Class D routing through `core/deploy` | PARTLY: the guard refuses class D sends without `viaDeploy: true`; the deploy call itself is the pack's | |
| Applying a pack's own migrations on enable, loading packs from a directory scan | BUILT: `enablePack` applies the manifest's migrations once (ledger `packs_migrations`, digest kept; only `CREATE`/`ALTER`/`INSERT` on `<id>_*` objects; failure leaves the pack disabled); `loadFromDir(root)` registers every valid pack | `loader.js`, `loader.test.js` |

Storage note: `guard_ledger` holds only hashes of recipient and content. `guard_queue` holds the raw recipient and content while a send awaits approval and clears both when decided. Consent is per recipient, channel and pack (`*` means any pack).
