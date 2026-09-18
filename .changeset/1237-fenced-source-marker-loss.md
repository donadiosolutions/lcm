---
"@donadiosolutions/lcm": patch
---

Document the third worktree-reconciliation refusal state. The recovery notes
covered an uncommitted source fence that rolls back and a target refusal whose
source fence may already be committed, but not the case where the completed
marker is present at the read-only precheck and durably absent inside the target
transaction. The source fence is committed by then, so the normalized source
recheck refuses against an already-retired source: nothing is copied or
truncated, but the documented in-place `UPDATE promoted` repair aborts against
the retained fence and later runs refuse at the source guard. The privacy
documentation now describes that state and states plainly that no in-place
repair is supported, rather than implying the earlier procedure applies.
