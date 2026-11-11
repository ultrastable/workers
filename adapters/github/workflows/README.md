<!-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0 -->
<!-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas -->

# Workflow templates

Seven GitHub Actions templates for an organization repository: `canonical-deploy`, `pr-checks`, `pr-lane`, `apply-migrations`, `remediation-consumer`, `assign-agent-on-issue`, `agent-pr-lifecycle`. All are manual-trigger only (`workflow_dispatch`): no schedule, so Actions minutes stay minimal (US-SPEC-24; scheduled work runs from the Worker tick). They are not active here; copy one to `.github/workflows/`. `tests/test_extracted_tools.py` checks they stay manual-only and pass `tools/workflow_lint.py`.

Owner role: operations. Trigger: a person or the tick dispatches one. Closing probe: the template's job exits 0 and its tool printed its JSON result. The deploy workflow needs the two Cloudflare secrets by name in repository secrets; the agent-login variable `AGENT_LOGIN` is a repository variable.
