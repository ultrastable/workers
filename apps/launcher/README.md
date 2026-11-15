# Door A: the web launcher (US-SPEC-19)

A person with no terminal opens one page, says what they want, ticks two agreements, and gets a live preview on a temporary Cloudflare account, a console key, and a private claim link.

- `src/` the launcher Worker (Free plan, stores nothing, logs nothing).
- `preview/` the Worker it deploys to the person's temporary account.
- `build.mjs` builds the preview bundle into `src/bundle.generated.js` (committed placeholder until a release build).
- `dev/demo.mjs` runs the launcher locally against a fake Cloudflare: `node apps/launcher/dev/demo.mjs`, then open http://localhost:8788.

Tests: `node --test --no-warnings apps/launcher/test/*.test.mjs` (set `ULTRASTABLE_BUILD_TEST=1` to also build the bundle; slow, release builds only).

Abuse controls (US-19-R09), all offline-tested in `test/turnstile.test.mjs`: Turnstile verification (`src/turnstile.js`, fails closed, fake siteverify in tests), a rate limit (`RATE_LIMITER`), and the launcher's own daily cap (`src/cap.js`, Durable Object `ProvisionCap`, one integer per UTC day). `LAUNCHER_MODE=public` refuses to serve until all three are configured. Nothing about a visitor is stored and nothing is logged; the claim link appears only in the response.

Not deployed yet: hosting on a permanent non-QNFO account and the `TURNSTILE_SECRET` secret are the card in `gate.json` (`IDENTITY-BOUND:`). Still open: release bundle publishing, the claim-time heartbeat.
