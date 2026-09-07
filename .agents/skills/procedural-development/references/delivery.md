# Item delivery and adversarial review

Read [the shared contract](../SKILL.md) first. Apply only the assigned role.

## Owner, plan and implementation

Spawn one dedicated `OWNER_MODEL` owner with `OWNER_REASONING` and best-effort
`OWNER_TIER` for each admitted item. It owns that item through planning, leaf
coordination, adjudication, publication requests, post-PR work and resolution;
it does not delegate ownership itself. Create an isolated worktree and dedicated
branch from the fresh selected target. Preserve unrelated work. Follow repository
dependency ordering; do not stack on unmerged work where policy forbids it.

Investigate the acceptance contract and produce a concrete implementation plan.
Before implementation, apply the review sequence below to that plan. The owner
reads every report, records accepted/rejected findings and rationale, and updates
the plan to address accepted actionable risks. If fixing the plan requires a
material scope/architecture decision outside the agreed work, send it to the
root; keep independent work moving. Plan review never spends candidate rounds.

Normally dispatch `IMPLEMENTER_MODEL` with its configured reasoning/tier. If the
work has a high chance of being security-related, the owner records why and routes
initial implementation to `SECURITY_IMPLEMENTER_MODEL` with that role's settings,
reporting the route for counters. Both paths use the same approved plan, owner,
workspace, budget and review process. Leave implementation to the assigned leaf.

Use worker-local home/XDG/temp state, sockets, databases and test services. Never
use shared production state or another worker's lock as an experiment. Preserve
supported integration harnesses. Required docs, release metadata and component
classification updates belong in the candidate along with code and focused tests.

## One review sequence, for plans and candidates

1. Dispatch `REVIEWER_A_MODEL` and `REVIEWER_B_MODEL` independently, using their
   respective reasoning and tier settings. Give each the original plan/item
   context and, for code review, the identical frozen SHA. Neither receives the
   other's first-pass report before finishing its own.
2. Once both reports complete, dispatch a separate `SYNTHESIS_REVIEWER_MODEL`
   worker with its settings, original material, and both reports. It independently
   checks disagreements, missed findings, assumptions, correctness, concurrency,
   security, compatibility, testing and maintenance risks. It is not a rubber
   stamp or a substitute for either first-pass reviewer.
3. The owner reads all reports and adjudicates every finding with severity and
   rationale. Reviewers recommend; the owner owns the decision. All reviewers
   remain read-only. Never collapse three reports into one even if model overrides
   select the same model for multiple roles.

Before candidate review, commit and freeze the exact SHA. Freeze implementation
until all reports are gathered. Use detached isolated checkouts or verify HEAD
and no uncommitted drift before and after each review. Reports name their SHA.
If a reviewer writes, the owner preserves evidence, restores only unauthorized
changes, verifies integrity, and repeats/revalidates affected reviews before
synthesis. The root coordinates recovery without editing owner worktrees.

## Candidate budget and severity

A candidate round starts at freeze and completes only after both independent
reports, the synthesis report and owner adjudication for that exact SHA. Track
completed rounds separately from incomplete attempts. Failed dispatches or retries
of missing reports on the unchanged SHA do not increment completed rounds.

Every completed candidate counts, including CI-only commits, automated-review
fixes, conflict resolutions and post-publication edits. Producing the next
candidate is not part of the preceding round. Neither resume nor changing the
implementer resets the item's three-round initial P2 budget.

| Accepted findings after review | Action |
| --- | --- |
| P0/P1/P2 after round 1 or 2 | Initial implementer fixes blocking findings, commits, freezes a new SHA; repeat all reviews |
| P0/P1 after round 3 | Replace initial implementer with `ESCALATED_IMPLEMENTER_MODEL` using that role's settings; defer remaining P2s |
| Only P2 after round 3 | Create actionable follow-ups; do not escalate solely for P2 |
| P0/P1 during escalation | Continue fixes and full exact-SHA review until resolved or a genuine external blocker prevents progress |
| P2 after budget exhaustion | Defer, including newly found P2s after escalation |
| P3 | Read and adjudicate; remediation is not required; handle PR threads under repository policy |

Escalation applies to either initial implementation route. The new implementer
inherits the existing worktree/branch, approved plan, implementation/review
history, all candidate SHAs, outstanding P0/P1 and exhausted/deferred P2 state.
Do not restart from scratch or invent another security escalation path.

A candidate is clean only when every report and adjudication is complete for its
exact SHA, no accepted P0/P1 remains, and every accepted P2 is fixed or eligible
for deferral and recorded in an actionable follow-up. A fixed P2 needs no issue.

Create deferred findings as GitHub issues under the caller's classification
policy. Include originating item, candidate, review context, evidence and
reproduction; describe the distinct remaining problem. Link the source item and
PR. Before a PR exists, create the follow-up with its PR link pending; creation
satisfies the pre-publication deferral gate. Add the link immediately after PR
publication; its absence blocks merge and final audit. Follow-ups never expand
the inventory or become native children of the run's tracker. Read back type
where required and resolution state; preserve valid duplicates, successors or
later fixes instead of reopening them just to satisfy counters.

## Publication and merge

Every PR-head change invalidates cleanliness, including tests, CI, external
reviews, rebases and merging the target branch. Freeze the new SHA and repeat
the full sequence. An ancestor's clean review never certifies its descendant.

The owner sends `publication-requested` with item ID, branch, exact clean SHA,
review/adjudication evidence, relevant local validation, proposed PR text and
follow-up state. Published-branch CI is not a prerequisite for this request.
The root verifies that evidence and executes push/PR creation under repository
policy, returning `pr-published` with URL and actual head SHA. Handle any mismatch
as a new candidate. Include a source closing reference only for a complete fix.

The owner remains responsible for CI, human/automated reviews, every finding,
review-thread resolution and conflicts through merge. Send `merge-requested`
with PR URL, clean SHA and complete exact-head CI, review and follow-up evidence.
Accepted P0/P1 and P2 within budget block. Resolve review threads according to
repository policy; do not bypass admission, weaken checks or force-push without
the required authorization.

Immediately before merging, the root rechecks the live PR head equals the declared
clean SHA and every required review/check is satisfied. Use an expected-head guard
when supported. On mismatch return to the owner for complete new-candidate review.
Merge ready work promptly using the repository's permitted method; do not delay
to avoid another owner's conflicts or impose a merge mutex for convenience.

Confirm GitHub reports `MERGED`, then emit `pr-merged` with PR, candidate and merge
SHA. Verify the result is on the selected target. Apply the caller's item-resolution
rule: require source closure when specified; if automatic closure failed, have the
owner provide resolution evidence for root closure/readback. Do not close an
incomplete item for accounting. Incorporating another merge and resolving conflicts
belongs to the affected owner and triggers full review of the resulting SHA.

## Events

Owners immediately report publication/merge requests, external blockers, parking,
worker failure, required escalation, cleared blockers and necessary deconfliction.
Include item ID, transition, worker ID, PR URL and candidate/merge SHA as applicable,
record location, evidence and requested coordinator action. Routine leaf chatter
stays with the owner. A parked owner waits for slot readmission before restarting
productive work; a cleared blocker never authorizes an extra active slot.
