# Platform roadmap

| # | Item | Why | Status |
|---|---|---|---|
| 1 | Run a real agent against a real repo with a real check command | Replace "simulated" with evidence | **first proof done** ([proof-real-agent.md](proof-real-agent.md)): Workers AI model fixed a bug, verified by `unittest`. Next: Claude Code (needs agent credential), a real repo, more tasks |
| 2 | Postgres store adapter + Cloud SQL deploy | Durable, multi-instance | next |
| 3 | GitHub connector: items from issues, PRs as execution, merge on green | The surface teams use | next |
| 4 | Vertex AI (Gemini) and Anthropic reviewer/doer pairing, different model per role | Model-agnostic claim, never self-review | next |
| 5 | Custom prediction metrics from tenant data | Calibration on real outcomes | later |
| 6 | Tenant isolation, per-user auth (OIDC) | Multi-customer | later |
| 7 | Outside audit of prediction match rate | Customer proof | later |
| 8 | `ultrastable init` from IDEA.md (the seed bootstrapper) into the core | Idea-to-org in one command | later |
