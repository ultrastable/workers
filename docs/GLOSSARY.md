<!-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0 -->
<!-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas -->
<!-- GENERATED from core/principles/principles.json by `node core/principles/render.js --write`. Edit the JSON, not this file. -->

# Principles and glossary

> **A system is autonomous if it has self-referential loops and the privilege to close them.**

- Knowing something and being unable to act on it is useless: autonomy is doing.
- Nothing stays in a chat thread: everything the system learns is written back into the system.
- No open loops: every loop has a closure, and the closure is code.

## Terms

**Autonomy.** The property of a system that has self-referential loops and is privileged to close them. A system that knows what is wrong but cannot act on it is not autonomous. See: Loop, Closure, Self-referential.

**Bootstrapping.** Going from nothing to a running system: one idea file in, a running organization out, with the system setting itself up, recording what blocked it, and continuing. A failed step becomes a backlog item, never a stop. See: Seed.

**Capability pack.** An optional set of agents and code loops outside the core, off by default, enabled by a recorded decision, with its own manager, charter, caps and kill switch. Email, social posting, video, analytics, cloud operations and professional drafts are packs. See: Outbound guard, Core.

**Charter.** A manager's written objective, definition of done, primary metric and guard metrics. See: Manager, Guard metric.

**Claims registry.** The table of public statements about the organization, each with a probe and a freshness limit. A statement whose probe fails or goes stale is withdrawn automatically. See: Self-model, Probe.

**Closed system.** A system whose knowledge, decisions, rules and results live inside itself as records and files, so that nothing important exists only in a chat thread, a person's memory or an external agent's context. See: Record.

**Closing probe.** The probe that, when it passes, proves a work item or gate card is done. Every item has one. See: Probe, Closure.

**Closure.** The act and the record that end a loop: a probe passed, evidence stored, a disposition written. A loop without closure is an open loop. Closure is performed by code, never by someone remembering. See: Open loop, Closing probe.

**Core.** What Ultrastable is by default: elicit what a person wants, write specifications and charters, manage delivery with full project-management discipline, build and verify, and govern itself. See: Capability pack.

**Decision log.** The record of every decision with its prediction, the authority used and the revert path. See: Revert path.

**Default in effect.** What happens if a person does nothing. Every decision card states it, the work continues on it, and it is recorded with a way to revert. See: Gate card.

**Directive.** A standing instruction from the owner, stored in the principles register with the owner's words, its meaning and the code that enforces it. A directive with no enforcer and no tracking issue is an open loop. See: Open loop.

**Disposition.** The recorded reason an item left the active set: done, superseded, cancelled or blocked with a named blocker and a closing probe. See: Open loop.

**Doer and reviewer.** The doer produces a change; a different agent, on a different model family where possible, verifies it. Nothing is reviewed by its author. See: Probe.

**Door.** One independent way to satisfy a prerequisite (a credential, an account, a decision). Every prerequisite has at least two doors, ordered from least effort for the owner to most, and the system tries them in order. A single door is a single point of failure. See: Gate card, Single point of failure.

**Earned autonomy.** Permission to act without a person, widened only from a record of verified outcomes and only by a reviewed change to the autonomy policy. See: Trust ledger.

**Failure log.** The register of the system's own failures: what happened, the root cause, the code that fixes it and the probe that shows it stays fixed. Failures are recorded by the system, not left in a conversation. See: Closed system, Open loop.

**Gate card.** A decision or step only a person can take, written as a record with the default already in effect and a closing probe. It is never an instruction in prose. See: Interrupt gate, Default in effect.

**Guard metric.** A metric that must not get worse while a target metric improves. A gain that worsens a guard is reverted. See: Charter.

**Guided console.** The three-screen, buttons-first interface (Now, Needs you, Progress) with a prompt box second. The front end is the back end: every press writes the record an agent would write. See: Closed system.

**Interrupt gate.** The narrow rule that the system stops for a person only for a step that is both irreversible and identity-bound (money, signing or filing, destroying unbacked data, using the person's own credentials). Everything else proceeds. See: Gate card.

**Loop.** A cycle that reads a record, decides, acts, verifies the result by an independent path, records the outcome, and feeds what it learned into the next pass. Managers, probes, plussing, the tick, code loops and outreach loops are all loops. See: Probe, Manager, Plussing.

**Manager.** A virtual role (portfolio, program, product or project) that owns a charter and metrics, ranks work, allocates capacity and runs its own loop on every tick. Managers are loops. See: Charter, Plussing.

**Needs register.** The list of everything the system requires to produce its required artifacts, each with a state (open, derived, asked, answered, defaulted). The system knows what it needs; the person does not have to. See: Prompted recall, Read-back.

**Open loop.** Anything that was started or noticed and has no owner, no closing probe and no path to closure. It is a defect. Open loops are detected by code (gaplint, the loop closer, the kernel reconcile step) and are themselves turned into items. See: Closure, Disposition.

**Outbound guard.** The single door through which every outward action of every pack passes: consent, suppression, caps, content rules, approval by autonomy rung and kill switches, all logged. See: Capability pack.

**Plussing.** A protected share of capacity (default 20 percent) reserved for improvements, including improving the loops themselves, so the system does not decay into only fixing bugs. Every closed item proposes one improvement. See: Loop.

**Prediction.** A checkable statement the system logs before it acts (metric, operator, number, deadline) and scores afterward. Scoring its own predictions is how the system learns how reliable it is. See: Trust ledger.

**Probe.** A read-only check that returns pass, fail or unknown with evidence and can be re-run by a different agent. Probes verify claims, gate cards, deploys, predictions and closures. See: Closing probe, Claims registry.

**Prompted recall.** Asking a person to recognize an answer from options and cues instead of recalling it from scratch. The way a person who does not know what they do not know can still steer. See: Needs register.

**Read-back.** The system's restatement of the specification in the person's own words, defaults listed first, for correction before planning is accepted. See: Needs register.

**Record.** A commit, an issue, a pull request, a file or a database row. If it is not a record, it does not exist. See: Closed system.

**Revert path.** The recorded way to undo a decision or change. Reversibility is engineered before an action, not hoped for. See: Decision log.

**Scope gate.** The hold placed on a request that falls outside the core: it is recorded, not worked, until a pack is enabled by a decision. See: Core, Capability pack.

**Seed.** The starting template and bootstrapper from which an organization grows: roles, policy, config and the first backlog. See: Bootstrapping.

**Self-model.** The organization's description of itself, built only from its own records, with limits shown as prominently as capabilities. See: Claims registry.

**Self-referential.** A loop that can read and act on loops, including itself: managers manage loops, probes check loops, the loop closer closes the tracker's loops, and the system reads its own backlog, claims, principles and results. See: Loop, Closure.

**Single point of failure.** Any step, tool, person, account or path whose loss stops the system with no workaround. It is a defect: every critical path has a second door that works without the first. See: Door, Open loop.

**Tick.** The heartbeat: one pass of the system's loops on a schedule. Each step is guarded so a failing step never stops the rest. See: Loop.

**Trust ledger.** The record of verified outcomes per surface and action class from which autonomy is earned, promoted and demoted. Trust is computed, not granted. See: Earned autonomy.

**Work claim.** An exclusive, time-limited hold on an item or path, with a fence token, so two agents never do or overwrite the same work. See: Loop.

## Standing directives

Each is the owner's instruction, kept with the code that enforces it. A directive that is not yet enforced is tracked by an issue.

| Id | In the owner's words | Status | Enforced by |
|---|---|---|---|
| D-NOTHING-IN-CHAT | Nothing can stay in a chat thread. All of your Claude Code stuff needs to be in the repo. | enforced | `agents/AGENTS.md`, `tools/loop_closer.py`, `.github/workflows/loops.yml` |
| D-NO-OPEN-LOOPS | No open loops. Everything must have a closure and a loop. Self-referential closure. | enforced | `tools/loop_closer.py`, `tests/test_loop_closer.py`, `products/gaplint/gaplint`, `core/kernel/index.js` |
| D-AUTONOMY-IS-LOOPS | A system is autonomous if it has self-referential loops and the ability to close those loops. | enforced | `core/kernel/index.js`, `core/claims/index.js`, `core/runner/index.js`, `autonomy/policy.json` |
| D-NO-CODE-FOR-THE-PERSON | Never have to write a line of code. Never have to look under the hood. The front end is your back end. | enforced | `core/src/console.js`, `core/test/console.test.js` |
| D-BOOTSTRAP | Bootstrapping is super important. Start from nothing. | enforced | `bootstrap/bootstrap.py`, `self/IDEA.md` |
| D-IGNORANCE-ASSUMED | Somebody's not going to know the details. The ignorance part of this is really important. | planned | tracked by #60 |
| D-SCOPE-AND-PACKS | Know what our core mission is and what boundaries we're willing to push that out to. Talking about it is totally insufficient. It has to be implemented in code. | partial | `bootstrap/cases.py`, `SCOPE.md`; tracked by #28 |
| D-OUTREACH-AS-LOOPS | Outreach, marketing and branding all need to be managers, part of the plussing and part of the code loops. | planned | tracked by #30 |
| D-SEPARATE-FROM-FIRST-INSTALLATION | I need the code base for Ultrastable to start being completely separate from the first installation. | enforced | `core/test/no-qnfo.test.js` |
| D-RUN-ON-ITSELF | We need to run Ultrastable on Ultrastable infrastructure. | partial | `self/ultrastable.json`, `tools/spec_backlog.py`; tracked by #13 |
| D-PLATFORM-AGNOSTIC | Starting with Cloudflare, but it would work with Google Cloud Platform too, and in theory could work with any platform. | enforced | `adapters/gcp/server.js`, `adapters/gcp/test/gcp.test.js` |
| D-LICENSE-HYBRID | Non-commercial is free, but any kind of money-making commercial use needs a license. | enforced | `LICENSE`, `COMMERCIAL-TERMS.md` |
| D-BITE-SIZED-CONSOLE | Three screens, bite-sized information, buttons or things to click; don't assume they know what to type. | enforced | `core/test/console.test.js` |
| D-NO-SINGLE-POINT-OF-FAILURE | There should never be a single point of failure ever. You should always have workarounds. | enforced | `self/doors.json`, `tests/test_doors.py`, `core/principles/principles.json` |
| D-NON-CODER-START | A non-coder user is not going to know how to do this. This should have happened automatically. | partial | `self/doors.json`, `tests/test_doors.py`; tracked by #84 |

## Failure log

Failures the system has had, with the code that keeps each from recurring.

| Id | What happened | Root cause | Fixed by |
|---|---|---|---|
| F-001 | The start of the self-hosted organization was blocked on the owner creating a Cloudflare API token and running `gh secret set`, and the gate issue said so in prose. | The start path had a single door (a manual API token). Nobody had written down the non-coder rule as a test, so a terminal step passed as acceptable. | self/doors.json gives every prerequisite two or more ordered doors; tests/test_doors.py fails the build if one has a single door or the first door needs a terminal; the gate issue now renders the doors, simplest first, as 'do any one'. |
| F-002 | A syntax error in tools/self_start.py was merged to main before its tests ran, and a schedule trigger failed the workflow linter after merge. | Merging relied on the author's judgment instead of a required check; pull requests ran no CI. | Fixed (#78, #79, #100). Required checks are enforced in code because branch protection is a paid feature on private repositories: tools/safe_merge.py refuses to merge unless the test job passed on the head commit; the loop closer opens an incident when main is red and closes it when ci is green again. |
