# Adapters

The portable core is [`../core/src/tick.js`](../core/src/tick.js): pure logic over a D1-shaped database handle. An adapter supplies three things: a **scheduler** that calls the tick, a **store** with the D1 handle interface, and **secrets/bindings**. Nothing in `core/` names a cloud.

| Adapter | Where | Scheduler | Store | Status |
|---|---|---|---|---|
| Cloudflare | [`cloudflare/`](cloudflare/) | Worker cron trigger | D1 | First adapter. Runs the fleet for QNFO; template tested; no `--apply` on a fresh account yet |
| Google Cloud | [`gcp/`](gcp/) | Cloud Scheduler to Cloud Run `POST /tick` | SQLite on a volume now; Cloud SQL or Firestore later | Skeleton; 13 tests incl. the port contract (`gcp/test/ports.test.js`); deploy script unrun |
| SQLite handle | [`sqlite/`](sqlite/) | none | `node:sqlite` behind the D1 interface | Shared by GCP and tests |

## Adding an adapter (what Google Cloud follows)

1. Implement the handle in `sqlite/d1-sqlite.js` terms: `prepare(sql).bind(...).all()/first()/run()` and `batch([...])`.
2. Call `runTick(db, config, env)` from your scheduler entry point, guarded by a shared secret.
3. Load `core/migrations/*.sql` in order at start-up.
4. Pass the same `autonomy/policy.json`; never fork it per cloud.
5. Add a test that runs the core test cases against your handle, and a deploy script that reads credentials from the environment only.

Run the GCP adapter locally: `TICK_TOKEN=x ULTRASTABLE_DB=./local.db node --no-warnings adapters/gcp/server.js` then `curl -XPOST -H 'X-Tick-Token: x' localhost:8080/tick`.
Tests: `node --test --no-warnings adapters/gcp/test/*.js`.

## Google Cloud path (for a Google for Startups application)

Cloud Run (tick service) + Cloud Scheduler (10-minute trigger) + Secret Manager (bindings) + Cloud SQL for PostgreSQL (store, via the Postgres store in [`../runtimes/python`](../runtimes/python)) + Vertex AI (model ladder rung). Deploy script: [`gcp/deploy.sh`](gcp/deploy.sh). Unproven until it has run in a real project; the README must say so until then.
