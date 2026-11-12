# Door A: the web launcher (US-SPEC-19)

A person with no terminal opens one page, says what they want, ticks two agreements, and gets a live preview on a temporary Cloudflare account, a console key, and a private claim link.

- `src/` the launcher Worker (Free plan, stores nothing, logs nothing).
- `preview/` the Worker it deploys to the person's temporary account.
- `build.mjs` builds the preview bundle into `src/bundle.generated.js` (committed placeholder until a release build).
- `dev/demo.mjs` runs the launcher locally against a fake Cloudflare: `node apps/launcher/dev/demo.mjs`, then open http://localhost:8788.

Tests: `node --test --no-warnings apps/launcher/test/*.test.mjs` (set `ULTRASTABLE_BUILD_TEST=1` to also build the bundle; slow, release builds only).

Rate-limit binding is configured in `wrangler.template.jsonc`. Not yet built: Turnstile secret (hook exists, set `TURNSTILE_SECRET` at deploy), hosting on a permanent account, release bundle publishing, the claim-time heartbeat.
