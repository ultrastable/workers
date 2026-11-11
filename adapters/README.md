# Adapters

The portable core is `worker/src/tick.js`. Adapters supply a scheduler and a D1-style store. Architecture, seams and status: [../docs/architecture.md](../docs/architecture.md).

| Adapter | Where | Status |
|---|---|---|
| Cloudflare (Worker, Cron, D1) | `worker/` | running for QNFO; seed template tested with 9 Worker tests; no `--apply` on a fresh account yet |
| Google Cloud (Cloud Run, Cloud Scheduler, volume) | `gcp/` | skeleton with 2 passing tests; deploy script unrun |
| SQLite handle (shared by GCP and local) | `sqlite/` | tested via GCP tests |

Run the GCP adapter locally: `TICK_TOKEN=x ULTRASTABLE_DB=./local.db node --no-warnings adapters/gcp/server.js` then `curl -XPOST -H 'X-Tick-Token: x' localhost:8080/tick`.
Test: `node --test --no-warnings adapters/gcp/test/*.js`.
