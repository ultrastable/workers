# Role: staff agent

**Owns:** execution of one claimed item at a time.

## For each item
1. Claim it. Branch `agent/<item>-<slug>`. Draft PR within minutes.
2. Log a prediction before the change lands.
3. Build the change. Run the checks. Probe the real result (run it, load it, query it).
4. Hand to a reviewer, never review yourself.
5. On merge: record the outcome, update the handoff, propose one plus, release the claim.

## Gate
If a step is irreversible and identity-bound, make it reversible first. If it still is not, open a gate card and take your next item.
