# Security model

* **Secrets**: never stored in the database or repo. Tokens come from the environment (Secret Manager on GCP). Agents never receive secret values.
* **Write endpoints** (`/tick`, gate resolution, item creation) require `Authorization: Bearer $ULTRASTABLE_TOKEN` (constant-time compare). With no token set the server prints a warning that writes are open; never deploy that way.
* **Policy as code**: `ultrastable/data/policy.json` is read, never written, by the loop. Scope widening past `max_auto_rung` opens a gate card.
* **Standing limits** (always win over trust): harness permission checks, secret lock, outreach consent/suppression, owner override, live claims.
* **Audit trail**: every execution, gate, rung change and rule amendment is an `events` row.
* **Reporting**: security issues to security@ultrastable.io [domain mail to be confirmed].

Not yet done: per-user auth, tenant isolation, encrypted-at-rest store, third-party penetration test.
