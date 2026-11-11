# What AIOS taught the seed

AIOS (`rwnq8/AIOS`, 30 commits from 2026-08-11 to 2026-11-09) is Rowan's design experiment in a system that bootstraps itself from nothing: a USB stick that boots Alpine Linux, picks a local model for the hardware, creates its own persistent storage and starts a multi-agent orchestrator with no human input. It never reached "builds an OS", but its first three days of boot testing produced the rules that govern any self-starting system. Ultrastable's seed is the same idea for an organization: the seed is the USB stick, the idea is the hardware, and the server is the machine it boots on.

## The mapping

| AIOS boot stage | Seed stage | What is detected or chosen |
|---|---|---|
| GRUB, kernel, initramfs | read | IDEA.md, `ultrastable.json`, `autonomy/policy.json` |
| `first_boot.sh` hardware detect (RAM, cores, disk) | detect | Which connector credentials exist, which tools are installed |
| Model chosen by RAM (4 GB gets Gemma 1B, 8 GB adds a reviewer) | select | Model tier chosen by monthly budget; the reviewer is a different model from the doer when the budget allows two |
| Partition and format persistence | plan, write | Charter, role instances, backlog, gate cards, D1 seed SQL |
| Extract bootstrap tarball, switch_root | provision | D1 created, migrations applied, rows seeded, Worker deployed |
| Launch `orchestrator.py`, `[AIOS] >` prompt | start | Cron heartbeat armed; first ticks observed on `/health` |
| Gatekeeper: safe, dangerous, destructive | autonomy policy | Surfaces, action classes, reversible vs identity-bound, ladder |
| Ensemble: primary, reviewer, validator | reviewer role | No work is verified by its own author |

## Lessons, each with the commit that taught it and where it lives now

1. **The boot must never die.** PID 1 exiting panics the kernel. Six boot-test iterations (commits `4e75671`, `09bc327`, `a29deb6`) ended in the same rule: every failure path drops to a shell instead of exiting, a missing model is a degraded console and not a fatal error. In the seed: every stage runs inside `Boot.guard`; a blocked stage becomes a backlog item with its blocker and a closing probe, and the next stage runs degraded. The Worker tick does the same per step (`worker/src/tick.js`). Tests: `test_missing_idea_degrades_not_dies`, `a failing step never kills the tick`.
2. **Test the whole chain end to end early; the failures are never where you expect.** QEMU boot tests found nine defects that reading the code did not: squashfs cannot be an initrd, the shebang needs busybox at one path, the serial console order, a read-only root, missing storage modules. The seed's `bootstrap.py --dry-run` runs the full chain with no credentials in CI on every push, and the first backlog items (KIT-2, KIT-3) are a real deploy and six observed ticks, not a statement that it works.
3. **Never swallow an error.** `2>/dev/null` hid the real `apk --root` failure (commit `8cfba48`). The seed checks every command's exit code and keeps the stderr tail (`Boot.run`); the shared agent protocol bans silent catches.
4. **Verify before you depend on it.** A phantom package (`alpine-mkinitfs`, commit `614acf3`), hyphen vs dot in a model filename that 404'd (`8fc44bc`), the renamed `llama-cli` target (BUILD.md Phase 1). The seed checks that tools and inputs exist before a stage uses them and records the checks in `boot-log.json`; the invention is to treat each check as a logged fact with a date, as BUILD.md did with SHA256 sums.
5. **Choose capability from the environment, not from a config the user must write.** AIOS picked its model from detected RAM. The seed picks its model tier from the stated budget and its autonomy start rungs from the policy, so the founder writes one file.
6. **Every commit carries its rationale.** AIOS commits read `ACTION:EDIT FILE: x RATIONALE: what broke and what the test proved`. That is why the boot-failure history above could be reconstructed months later. The seed's protocol requires the same: the PR or commit says what was verified and the evidence.
7. **Safety is a classification, not a prompt.** The gatekeeper sorted commands into safe (run), dangerous (show and wait) and destructive (block), and listed protected paths. The seed generalizes it: each action on each surface is marked reversible or not and identity-bound or not, the interrupt gate stops only the irreversible and identity-bound ones, and the harness deny list mirrors the gated shell commands (`tests/test_policy.py` checks the two agree).
8. **Local first, then widen.** AIOS started at three small models and a 4 GB laptop, with a reviewer added only when RAM allowed. The seed starts every surface at a low rung and widens only through computed trust and a reviewed PR; money, legal, outreach and secrets are capped below execute.
9. **The unfinished part is a lesson too.** AIOS stalled at Phase 1: `llama-cli` compiled but the in-guest model response was never confirmed. The fix in the seed is that nothing is "done" without a closing probe; a done check that was never observed is a loop that stays open.
10. **Agent instructions are part of the artifact.** From 2026-11-07 AIOS carries `AGENTS.md`, `CLAUDE.md`, `.github/copilot-instructions.md`, a handoff template and a skill, synced from a hub. The seed ships the same set from day one: any agent that opens the repo cold finds the protocol, its role file and its limits, and no agent depends on chat history.

## What this means for the invention

The bootstrapping claim is not "an AI sets up a computer". It is the combination: a single human-written idea file; a deterministic bootstrapper that plans, writes and provisions an organization (roles, backlog, autonomy policy, schema, scheduler); an autonomy policy that classifies every action by reversibility and identity-binding and fixes a permission ceiling per surface; a boot that cannot die and records each failure as work; a heartbeat that starts on the server and takes over; and a trust ladder that widens scope only by reviewed change. See `docs/bootstrapping.md` and the patent thread's embodiment note.
