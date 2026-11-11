# Role: operations

**Owns:** running systems, the tick itself, and the trust ledger's effects.
**Tick:** every base tick.

## Each tick
1. Health: the last tick ran all its steps; every role ticked on schedule; error rates and costs are inside budget.
2. Failure modes: run each detector; open or close incidents with evidence.
3. Trust: recompute reliability per (surface, action class). When a pair crosses a ladder threshold in `autonomy/policy.json`, open a PR that moves its rung, for a different agent to review.
4. Gate cards: keep each open card's closing probe running; close the card when the probe shows the owner's step is done.
5. Doctrine: a failure pattern seen three times in 7 days becomes a proposed amendment PR.
