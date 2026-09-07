# Item delivery and review

Apply [the run contract](../SKILL.md) and only the assigned role's instructions.

## Directives

One dedicated owner retains each admitted item through planning, adjudication,
publication, post-PR work and verified resolution; ownership is not delegated.
Use an isolated worktree/branch from the fresh selected target, preserving unrelated
work and repository dependency ordering. Do not stack on unmerged work where forbidden.

Implementers use worker-local home/XDG/temp state, sockets, databases and test
services. Never experiment on production state or another worker's publication
lock. Preserve supported integration harnesses. Include required docs, release
metadata, component classification and focused tests in the candidate.

All reviewers are read-only. Every PR-head change, including CI/test fixes,
automated-review remediation, rebases and conflicts, invalidates prior cleanliness.
An ancestor's approval does not certify its descendant.

## Plan and implement

1. The owner investigates acceptance and writes a concrete plan. Review the same
   frozen plan revision using the sequence below; the owner adjudicates every
   finding and records rationale. Address accepted risks before implementation;
   materially revised plans need review of the revised material. Plan review does
   not spend candidate rounds. Escalate out-of-scope architecture/scope decisions
   through the root while independent work proceeds.
2. Dispatch `IMPLEMENTER_MODEL` with its resolved settings. For work likely to be
   security-related, record why and dispatch `SECURITY_IMPLEMENTER_MODEL` instead.
   Report security routing for counters. Both paths retain the same owner, plan,
   workspace, budget and reviews; the assigned leaf implements.
3. Commit and freeze an exact candidate SHA. Pause implementation until reports
   finish. Use detached isolated checkouts or verify HEAD and no uncommitted drift
   before/after each review. Reports identify their SHA.

## Review sequence

1. Dispatch independent `REVIEWER_A_MODEL` and `REVIEWER_B_MODEL` workers with
   their respective reasoning/tier settings and identical original material.
   Neither receives the other's report before completing its own.
2. After both finish, dispatch a separate `SYNTHESIS_REVIEWER_MODEL` with original
   material and both reports. It independently checks disagreements, omissions,
   assumptions, correctness, concurrency, security, compatibility, testing and
   maintenance risks; it replaces neither first-pass reviewer.
3. The owner reads all three reports and adjudicates every finding with severity
   and rationale. Three separate reports remain required even when role bindings
   use the same model.

If a reviewer writes, preserve evidence, restore only unauthorized changes, verify
integrity and repeat/revalidate affected reports before synthesis. The root may
coordinate recovery but must not edit the owner's worktree.

## Candidate budget

A round starts at freeze and completes only with both independent reports,
synthesis and owner adjudication for that SHA. Track incomplete attempts separately;
failed dispatches or missing-report retries on unchanged SHA do not spend completed
rounds. Every completed candidate counts, including CI-only and post-publication
changes. The next candidate is a new round. Resume or implementer replacement never
resets the initial three-round P2 budget.

| Accepted findings | Required action |
| --- | --- |
| P0/P1/P2 after round 1 or 2 | Initial implementer fixes blockers; commit, freeze and repeat all reviews |
| P0/P1 after round 3 | Replace initial implementer with `ESCALATED_IMPLEMENTER_MODEL`; defer remaining P2 |
| Only P2 after round 3 | Create actionable follow-ups; do not escalate solely for P2 |
| P0/P1 during escalation | Fix and fully review until resolved or genuinely externally blocked |
| P2 after budget exhaustion, including new findings | Defer |
| P3 | Read/adjudicate; remediation is optional; handle PR threads under repository policy |

Escalation replaces either initial route using its configured settings. Transfer the
existing worktree/branch, approved plan, implementation/review history, all candidate
SHAs, outstanding P0/P1 and exhausted/deferred P2 state. Do not restart or invent a
separate security escalation path.

Clean means complete exact-SHA reports/adjudication, no accepted P0/P1, and every
accepted P2 fixed or eligible for deferral with an actionable follow-up. Fixed P2
findings need no follow-up.

### Deferred findings

Create GitHub issues under caller classification rules, describing the distinct
remaining problem with source item, candidate, review context, reproduction and
evidence. Link source and PR. Before publication, create the issue with its PR link
pending; this satisfies the pre-publication gate. Add that link immediately after
publication; missing links block merge/final audit. Follow-ups never enter inventory
or become native children of its tracker. Read back required type and current
resolution; preserve valid fixes, duplicates and successors.

## Publish and merge

1. Owner sends `publication-requested`: item, branch, clean SHA, complete review/
   adjudication evidence, relevant local validation, proposed PR text and follow-ups.
   Published-branch CI is not required before this request.
2. Root verifies evidence, pushes and creates the PR under repository policy, then
   returns `pr-published` with URL and actual head. A mismatch is a new candidate.
   Use source-closing references only for a complete fix and an authorized merge
   endpoint. Stop at draft/PR when that is the requested endpoint.
3. Owner handles CI, human/automated findings, thread resolution and conflicts.
   Send `merge-requested` with PR, clean SHA and complete exact-head CI, review and
   follow-up evidence. Accepted P0/P1 and in-budget P2 block. Never bypass admission,
   weaken checks or force-push without authorization.
4. Immediately before merging, root rechecks live head equals clean SHA and all
   required reviews/checks pass; use an expected-head guard when supported. Drift
   returns to the owner for full review. Merge ready work promptly using the
   permitted method, without a convenience mutex or waiting for other owners.
5. Confirm `MERGED`, emit `pr-merged` with PR/candidate/merge SHA and verify target
   ancestry. Apply caller source-resolution rules. If required automatic closure
   failed, owner supplies evidence for root closure/readback; incomplete fixes stay
   open. Owner conflict resolutions/target integrations require full new-SHA review.

## Event payload

Owners immediately report publication/merge requests, blockers, parking, worker
failure, escalation, cleared blockers and necessary deconfliction. Include item,
transition, worker, applicable PR/candidate/merge SHA, record location, evidence and
requested root action. Routine leaf chatter stays with its owner. A parked owner
awaits root slot readmission before productive work resumes.
