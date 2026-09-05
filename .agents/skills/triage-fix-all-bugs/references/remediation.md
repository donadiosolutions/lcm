# Bug-owner remediation

Read the shared contract in [SKILL.md](../SKILL.md) before applying this phase.

**Contents:** Scheduling → ownership → plan review → implementation routing → frozen candidates → finding policy → round budget → escalation → clean head → PR and merge → coordinator events.

## Phase 2: Remediation

Maintain **up to 7 Bugs actively being remediated at once**.

Whenever fewer than 7 productive remediation owners are active and eligible Bugs remain, create additional owners until:

- the active count reaches 7; or
- no immediately actionable Bugs remain.

A Bug occupies an active remediation slot while useful work on it is progressing.

If a Bug becomes blocked solely on external input or another dependency and no useful work can continue, it may be parked so another Bug can use the slot.

The root coordinator should keep unrelated work moving even when one Bug is blocked.

Only S0 Bugs with triage disposition:

- `reproducible`; or
- `uncertain-needs-remediation`

are eligible for remediation.

## Conflict-aware scheduling

The root coordinator should make a **best-effort** attempt to launch bug owners in an order that reduces obvious conflict risk.

It may cheaply inspect:

- issue descriptions;
- affected components;
- triage notes;
- likely subsystems;
- known file areas.

Prefer concurrently scheduling Bugs that appear unrelated.

This is only an optimization.

Do not delay available remediation work while trying to construct a perfect conflict-free schedule.

Conflicts are expected and belong to bug owners.

Do not use exclusive source-file locks.

## Bug owner

For every Bug entering remediation, spawn:

**Astra, medium reasoning, priority service tier**

as its dedicated **bug owner**.

The owner remains responsible for that Bug through:

- planning;
- implementation coordination;
- review adjudication;
- PR publication;
- post-PR remediation;
- merge.

The bug owner must:

1. create a dedicated worktree for the Bug;
2. create a dedicated branch;
3. investigate the problem;
4. develop the remediation plan;
5. coordinate all reviewers and implementers;
6. adjudicate all review findings;
7. own the resulting PR until merge.

The bug owner must not delegate ownership of the Bug itself.

The bug owner should coordinate rather than unnecessarily perform implementation personally.

## Planning review

Before implementation begins, the bug owner must produce a concrete remediation plan.

The plan then receives two **independent first-pass adversarial reviews**:

- **GLM-5.3 Max**
- **Grok 4.6, medium reasoning**

The two first-pass reviewers must work independently.

Neither receives the other's review before completing its own.

They are reviewers only.

They must not modify the plan or implementation.

After both reviews complete, spawn:

**Opus 5, medium reasoning**

for a second-pass adversarial review.

Give Opus:

- the original plan;
- relevant issue context;
- the GLM review;
- the Grok review.

Opus must independently:

- adjudicate disagreements;
- identify findings missed by both first-pass reviewers;
- challenge assumptions;
- identify edge cases;
- identify correctness risks;
- identify concurrency risks;
- identify security risks;
- identify compatibility risks;
- identify testing risks;
- identify maintenance risks;
- produce a synthesized second-pass review.

The bug owner then reads and adjudicates all planning-review findings and updates the plan as necessary.

Only after this process may implementation begin.

## Implementation routing

### Default implementation path

Unless the Bug qualifies for security routing, spawn:

**Luna, high reasoning, priority service tier**

as the implementation sub-agent.

The Luna implementer works in the bug owner's worktree and implements the approved plan.

The bug owner continues coordinating the Bug but should leave implementation to the assigned implementer.

### Security routing

If the Bug has a high chance of being interpreted as security-related implementation work, route initial implementation directly to:

**Daybreak Blue, high reasoning, priority service tier**

instead of Luna.

Daybreak Blue receives the same:

- approved plan;
- worktree;
- branch;
- Bug ownership structure;
- candidate-freezing rules;
- review process;
- remediation-round budget;
- finding-classification rules

as the default Luna implementer.

For purposes of the remediation budget, Daybreak Blue is treated as the initial implementer.

If unresolved accepted P0 or P1 findings remain after Daybreak Blue's third reviewed candidate round, replace Daybreak Blue with:

**Astra, high reasoning, priority service tier**

using the same escalation inheritance semantics defined below.

Security routing therefore follows the explicit path:

`Daybreak Blue high → Astra high`

when escalation is required.

Do not infer a different security escalation path.

## Frozen candidate invariant

When implementation reaches a candidate state:

1. commit it;
2. record the exact commit SHA;
3. freeze that SHA as the candidate head.

All reviewers in that review round must review **exactly that candidate SHA**.

Do not allow implementation changes while reviews of that candidate are still being gathered.

A review result belongs only to the exact SHA reviewed.

Review cleanliness does not transfer automatically to another commit on the same branch.

## Candidate review structure

For every frozen candidate, perform the complete adversarial review structure.

### Independent first pass

Spawn independently:

- **GLM-5.3 Max**
- **Grok 4.6, medium reasoning**

Neither reviewer receives the other's review before completing its own.

Both review exactly the same frozen candidate SHA.

### Second pass

After both first-pass reviews complete, spawn:

**Opus 5, medium reasoning**

Give Opus:

- the exact candidate SHA;
- relevant Bug context;
- the approved remediation plan;
- the GLM implementation review;
- the Grok implementation review.

Opus must independently:

- adjudicate disagreements;
- inspect assumptions;
- identify missed findings;
- consider correctness;
- consider concurrency;
- consider security;
- consider compatibility;
- consider testing;
- consider maintenance;
- produce a synthesized second-pass implementation review.

The bug owner then reads and adjudicates the combined findings.

## Finding classification

Classify every actionable review finding as:

- P0;
- P1;
- P2;
- P3.

The bug owner owns final adjudication.

Reviewers recommend findings and severity but do not unilaterally control remediation policy.

## P0 / P1

Accepted P0 and P1 findings always block completion.

The implementer must address every accepted P0 and P1 finding before a candidate can be considered clean.

A candidate is never clean while any accepted P0 or P1 finding remains unresolved.

## P2

Accepted P2 findings block completion only while the initial implementer's remediation budget remains available.

During the initial three-round remediation budget:

- accepted P2 findings must be addressed;
- they block candidate cleanliness;
- they participate in the next remediation cycle.

Once the initial implementer's three reviewed candidate rounds are exhausted:

- remaining accepted P2 findings no longer block the current Bug;
- they must be deferred;
- they do **not** cause implementer escalation.

For every deferred accepted P2 finding:

1. create a new GitHub issue;
2. assign its native GitHub issue type to exactly `Bug`;
3. include enough context, evidence, and reproduction information to make it independently actionable;
4. link it to the current Bug;
5. link it to the current PR;
6. record the originating candidate/review context;
7. leave it for future remediation.

These newly created Bug issues are **not part of S0**.

They must not recursively expand the current run.

Once the initial P2 budget has been exhausted, it remains exhausted after implementer escalation.

Any new accepted P2 finding discovered during Astra escalation is therefore deferred rather than used to extend the current remediation.

## P3

P3 findings do not require remediation as part of this task.

They may be left unimplemented after the bug owner has read and adjudicated them.

PR review conversations should still be resolved appropriately so the PR is not left with dangling review threads.

## Remediation-round semantics

The initial implementation budget is exactly:

**3 reviewed candidate rounds**

A reviewed candidate round begins when a candidate SHA is frozen.

It ends when:

1. GLM has reviewed that exact SHA;
2. Grok has independently reviewed that exact SHA;
3. Opus has reviewed that exact SHA using both first-pass reviews;
4. the bug owner has read and adjudicated all findings.

Production of the next candidate is **not part of the preceding reviewed candidate round**.

If blocking accepted findings remain and budget remains:

1. the implementer remediates them;
2. the implementer commits the changes;
3. the new commit becomes the candidate for the next reviewed candidate round.

This definition ensures that every candidate subject to completion decisions receives its own review round.

## Initial implementer remediation loop

For the first and second reviewed candidate rounds:

If any accepted P0, P1, or P2 finding remains unresolved:

1. the initial implementer fixes the accepted blocking findings;
2. commits the result;
3. freezes the new candidate SHA;
4. the complete GLM + Grok + Opus review process repeats.

After the third reviewed candidate round:

### If P0 or P1 remains

Escalate the implementer.

### If only P2 remains

Defer every unresolved accepted P2 into a new native `Bug` issue.

Do not escalate solely because of P2.

### If neither P0 nor P1 remains and all remaining P2s have been either fixed or properly deferred

The candidate may be considered clean.

## Implementer escalation

If accepted P0 or P1 findings still remain after the initial implementer's third reviewed candidate round, replace the initial implementer with:

**Astra, high reasoning, priority service tier**

This applies whether the initial implementer was:

- Luna high; or
- Daybreak Blue high.

The Astra implementer inherits:

- the existing worktree;
- the existing branch;
- the approved plan;
- implementation history;
- review history;
- all candidate SHAs;
- all adjudicated findings;
- all outstanding accepted P0/P1 findings;
- knowledge of deferred or exhausted P2 state.

Do not restart the Bug from scratch.

Astra continues remediation using the same:

- frozen-candidate semantics;
- independent GLM review;
- independent Grok review;
- Opus second-pass review;
- bug-owner adjudication.

Astra continues until:

- the candidate has no unresolved accepted P0 or P1 findings; or
- the bug owner determines that a genuine external blocker prevents autonomous progress.

Because the initial P2 budget is already exhausted at escalation, accepted P2 findings discovered during Astra remediation are deferred into new `Bug` issues and do not block Astra completion.

## Clean candidate definition

A frozen candidate SHA is clean only when all of the following are true:

1. no unresolved accepted P0 finding remains;
2. no unresolved accepted P1 finding remains;
3. every accepted P2 has either:
   - been remediated in the candidate; or
   - become eligible for deferral because the initial three-round P2 budget is exhausted and has been converted into a linked native `Bug` issue;
4. every review finding has been read and adjudicated by the bug owner;
5. the complete GLM + Grok + Opus review process has completed for that exact SHA.

Cleanliness belongs to the exact candidate SHA only.

## Clean-head invariant

A clean candidate remains clean only while its exact SHA remains the PR head.

**Any PR-head SHA change invalidates clean-candidate status.**

This includes changes caused by:

- implementation edits;
- test fixes;
- CI fixes;
- PR-review fixes;
- automated-review fixes;
- conflict resolution;
- rebasing;
- merging the latest default branch into the Bug branch;
- manual changes;
- any other commit that advances or rewrites the PR head.

After any PR-head SHA change:

1. freeze the new SHA;
2. run the complete independent GLM + Grok first pass;
3. run the Opus second pass;
4. perform bug-owner adjudication;
5. satisfy the normal finding-handling rules.

Do not reuse a clean judgment from an ancestor commit.

Immediately before merge:

`current PR head SHA == latest clean candidate SHA`

must be true.

If it is false, the PR is not ready to merge.

## Pull request

Once there is a clean candidate, the bug owner publishes the PR.

The bug owner owns the PR until merge.

The owner must continue processing:

- repository CI;
- human reviews;
- automated reviews;
- GitHub review threads;
- conflict resolution;
- default-branch changes relevant to the branch.

Opening the PR does not end candidate-review requirements.

Any PR-head change after publication triggers the clean-head invariant and therefore requires a new complete candidate review.

## Pre-merge requirements

Before merging, the bug owner must ensure:

- required repository tests pass;
- required CI checks pass;
- the implementation matches the intended fix;
- every PR review has been read;
- every automated review has been read;
- every finding has been adjudicated;
- every accepted blocking finding has been addressed;
- every unresolved accepted P2 eligible for deferral has a corresponding native `Bug` issue;
- every relevant review thread has been closed or resolved;
- no unresolved accepted P0 remains;
- no unresolved accepted P1 remains;
- the current PR head SHA is exactly the latest clean candidate SHA.

An accepted P2 that was actually fixed does **not** require a follow-up Bug issue.

Only deferred accepted P2 findings require new Bug issues.

## Merge policy

When a PR is ready, **merge it promptly**.

Do not intentionally delay a ready PR merely to avoid creating conflicts for other active Bug owners.

Do not serialize merges for convenience.

Do not use exclusive source-file locks.

When another active Bug becomes conflicted because a PR merged, resolving that conflict is the responsibility of that Bug's owner.

The affected bug owner should incorporate the latest default branch as needed and continue.

Any resulting PR-head SHA change invalidates its previous clean-candidate status and requires complete candidate review again.

When a Bug owner merges a PR, it must immediately notify the root coordinator so the root can:

- update S0 state;
- update the root Epic;
- replenish the remediation slot;
- process the new default-branch HEAD;
- update LCM as required.

## Bug-owner coordinator events

A bug owner must immediately notify the root coordinator when any of these meaningful state transitions occurs:

- the Bug becomes externally blocked and useful work cannot continue;
- the Bug is parked;
- an unrecoverable worker failure occurs;
- escalation to Astra becomes necessary;
- a PR is opened;
- a PR becomes clean and merge-ready;
- a PR is merged;
- another exceptional condition requires coordinator intervention.

These are coordinator wake-up events.

They do not automatically become user-facing notifications.

Routine internal worker chatter must not be forwarded.

## Execution clarifications

- **Round accounting:** every frozen candidate that completes GLM, Grok, Opus,
  and owner adjudication counts as one reviewed candidate round. This includes
  CI fixes, automated-review fixes, conflict commits, and changes after publication.
  There is no separate count of "real implementation" rounds. Failed dispatches
  and retries of missing reports for the same unchanged candidate do not create
  an extra completed round. Track completed rounds and incomplete candidate
  attempts separately. Once the first three rounds have completed, the initial
  P2 budget remains exhausted for the rest of that Bug, including escalation.
- **Candidate integrity:** reviewers operate read-only on the frozen SHA. Use
  an isolated detached checkout or verify the reviewed worktree has the expected
  HEAD and no uncommitted drift before and after review. Reports name the exact
  SHA. If a reviewer writes, the owner preserves the evidence, restores only the
  unauthorized changes without deleting unrelated work, verifies the candidate,
  and revalidates or repeats every affected review before synthesis. The root
  coordinates this recovery without editing the owner's worktree. A changed
  candidate SHA always requires the complete review cycle.
- **Implementation isolation:** use worker-local fixtures, home/XDG/temp state,
  sockets, databases, and test daemons for reproductions and state-changing tests.
  Never use the main daemon's state or another worker's lock as an experimental
  target. Preserve the repository's supported isolation and integration harnesses.
- **Security routing:** the Bug owner decides during planning whether the Bug
  needs Daybreak Blue, records the reason, and reports that decision to the root
  for the routing counter. The initial and escalation paths remain as specified.
- **Resuming parked work:** a parked owner reports when its blocker clears and
  waits for the root to reassign an active slot before resuming productive work.
  It does not self-resume into an eighth slot. A parked agent may send state events
  while waiting; slot accounting remains the root's responsibility.
- **Publication events:** apply the `publication-requested`/`pr-published` and
  `merge-requested`/`pr-merged` protocol in [SKILL.md](../SKILL.md). Owners remain
  responsible for evidence and their PR, while the root performs repository
  publication/merge operations and the final live-head admission check.
