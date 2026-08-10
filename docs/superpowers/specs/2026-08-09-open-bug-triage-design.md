# Open Bug Triage and Remediation Design

## Objective

Resolve every GitHub issue labeled `bug` that was open in
`donadiosolutions/lcm` on 2026-08-09. An issue is resolved only when current
protected-branch evidence proves that it is already fixed, or when a focused
regression fix has passed the complete repository gates, merged, and closed the
issue. The final audit must search GitHub again rather than relying on this
initial inventory.

## Initial Inventory and Disposition

The initial query returned twelve open bugs.

| Issue | Initial disposition | Required outcome |
| --- | --- | --- |
| #555 | Reproducible test-deadline defect | Fix with #563 in the worktree-reconciliation PR. |
| #557 | Fixed by merged PR #554 | Close with fixing-commit, ancestry, current-main, and focused-test evidence. |
| #558 | Historical report lacks actionable failure evidence and is not reproducible | Close `not_planned` with the complete forensic record and an explicit reopening condition. |
| #559 | Fixed by merged PR #554 | Close with fixing-commit, ancestry, current-main, and focused-test evidence. |
| #560 | Fixed by merged PR #554 | Close with fixing-commit, ancestry, current-main, and focused-test evidence. |
| #561 | Fixed by merged PR #554 | Close with fixing-commit, ancestry, current-main, and focused-test evidence. |
| #562 | Reproducible external-admission state defect | Fix with #567 in the external-admission PR. |
| #563 | Reproducible test-deadline defect | Fix with #555 in the worktree-reconciliation PR. |
| #564 | Reproducible runtime/schema validation drift | Fix in the missing-CWD validation PR. |
| #565 | Fixed on maintenance and main by PRs #566 and #568 | Close with branch-ancestry and focused-test evidence. |
| #567 | Reproducible unsupported-base admission defect | Fix with #562 in the external-admission PR. |
| #569 | Reproducible release-provenance topology defect | Fix in a separate release-policy PR. |

The preliminary current-main SHA is
`7bbf0a866c12b308e647732a746f6b0880aa3954`. Before each closure, branch, PR,
and merge decision, fetch `origin` and re-establish the evidence against the
then-current protected branch.

## PR Boundaries

Four implementation PRs are the minimum cohesive set. Issue #558 is resolved
through evidence-backed triage rather than a speculative implementation PR.

### PR 1: Full-Suite Test Determinism (#555, #563, #586, #587, #588, #589)

The four reported real-filesystem/SQLite reconciliation cases perform enough
setup, migration, archival, fencing, and durability work that five seconds is
not a reliable test-owned deadline under supported full-suite contention. Give
only those cases an explicit 15,000 ms timeout, matching adjacent heavyweight
reconciliation tests. Do not change Vitest's global timeout or production
behavior.

The four tests are:

- `fails closed on invalid foreign keys`
- `journals each archive rename and resumes from the failed phase`
- `fails closed if a source vanishes after discovery or a retired path is recreated`
- `rejects retired paths recreated between archival and fence publication`

Concurrent verification of that patch discovered #586: the compact-route test
`accepts previous_summary and returns latestSummaryContent` starts a real
daemon, ingests 100 messages into real SQLite storage, and performs real
compaction with a mock summarizer, but also inherits the five-second default.
Two concurrent coverage suites independently timed it out at 5,529 ms and
5,521 ms while the uncontended canonical suite passed. Give that case an
explicit 15,000 ms per-test deadline in the same test-determinism PR. Preserve
its real behavior and do not change production or the global timeout.

The next concurrent verification exposed three further test-owned defects:

- #587 uses real 200 ms sleeps around a 300 ms daemon idle timer. Under load,
  the server can receive the second request after the first real timer fires.
  Replace wall-clock sleeps with the existing `_setTimeout`/`_clearTimeout`
  seams, consume each real health response, assert cancellation/one-active-timer
  state, and manually fire the active callback.
- #588 runs complete real SQLite migrations and writes 35 promoted rows before
  testing recall ordering. The query itself is sub-millisecond, but two
  coverage processes took 5,201-5,256 ms. Give only that test 15,000 ms.
- #589 performs real Git/worktree creation, SQLite migration and merge,
  fencing, archival, journal/map publication, and portable import. Two coverage
  processes took 5,967-6,065 ms. Give it the same 10,000 ms deadline already
  used by its sibling legacy-worktree export test.

These remain test-only corrections. Do not modify daemon timer behavior,
recall queries, portable-knowledge production code, fixtures, or the global
timeout.

Commit `ce0de35be1373c93313c66917653455129415494` is prior partial work that
changes only the last two tests. It is evidence, not a complete patch. The
implementation must independently verify file modes and fixture ownership
under `umask 0022` so that an actual permission/isolation bug is not hidden by
the longer deadline.

### PR 2: Missing-CWD Observation Validation (#564)

The schema permits `parked_at` only after at least three observations, while
`EventsDb.observeMissingCwd()` currently accepts any positive safe integer.
Make the runtime contract match the durable invariant: reject
`requiredObservations` values below three before querying or mutating SQLite.

Tests must cover zero, one, two, three, a value above three, fractions,
non-finite numbers, and any typed-call boundary that can supply malformed
values. Exactly three and larger safe integers remain valid. Existing missing,
empty, invalid, and unavailable CWD behavior must remain fail closed and must
not fall back silently to the process CWD.

The threshold is an internal repository contract: production callers pass the
fixed value three, and no CLI or configuration surface exposes it. Record the
invariant in the existing passive-learning documentation, but do not add a
Changeset or invent a new user option.

### PR 3: External-Admission State and Supported Bases (#562, #567)

Model admission as one fail-closed state machine. A trusted event may revoke an
exact-head success only when the same run is guaranteed either to evaluate
that exact head to a terminal result or intentionally leave a current
revalidation state that another authenticated event must complete. A stale or
ineligible workflow event must not overwrite a current exact-head success with
an orphaned pending status.

Replace the hard-coded `main` eligibility predicate with an explicit trusted
supported-base policy covering `main` and protected maintenance branches. The
policy must be derived from trusted repository/event data and constrained to
the repository's intended maintenance namespace; arbitrary user-controlled
base names must not become eligible. Main, supported maintenance, unsupported
branches, drafts, closed PRs, forks, wrong repositories, wrong workflow
identity, mismatched head SHAs, ambiguous associated PRs, and merge-queue refs
all need explicit tests.

The implementation truth table must cover `check_run`, `workflow_run`, and
`repository_dispatch` start/in-progress/completed states; whether the runner
starts; whether revocation occurs; whether evaluation runs; and the resulting
pending, failure, or success status. Workflow permissions remain explicit,
actions stay commit-SHA pinned, PR-controlled content is never executed, and
ambiguous or evaluator-error paths fail closed.

Update `WORKFLOW.md`, `docs/external-admission.md`, and the Copilot instructions
atomically with the supported-base contract. This changes repository
governance rather than the published npm package, so it does not receive a
Changeset.

### PR 4: Maintenance Release Provenance (#569)

The release policy must accept both existing direct-main release commits and
the protected maintenance topology used by v1.4.3: a commit belongs to a merged
PR targeting an eligible protected maintenance branch, and that maintenance
merge is preserved as ancestry by a merged forward-port PR targeting `main`.

Acceptance requires validating the complete chain, not merely finding any PR
association. Tests must cover direct-main association, one valid maintenance
PR plus main forward-port, missing forward-port, wrong maintenance base,
unmerged or draft PRs, wrong repository/owner, ambiguous associations,
non-ancestry-preserving forward ports, and merge-commit identity mismatches.
The policy remains fail closed for unassociated or ambiguous commits.

Update release documentation. This repairs repository publication automation
rather than package runtime behavior, so it does not receive a Changeset.

## Issue #558 Forensic Disposition

The reported `identity-service` path-divergence case passed immediately after
the historical failure. The retained transcript records only the failing test
name and its approximately 134 ms duration; it does not retain Vitest's
expected/received block, the received exception, or a failing JUnit record.
The exact test body and uncertain-restoration control flow are unchanged from
the reported head to current main, so no later commit can honestly be credited
as a fix.

The dedicated Luna investigation found no reproducible defect after forty
independent exact-case processes, eight concurrent exact-case processes, four
concurrent complete identity-file processes, and the coordinator's complete
6,025-test baseline. The control path has no clock, randomness, or retry, and
the available artifacts cannot distinguish an unexpected return from a
different exception, filesystem error, or harness failure. This combination
is stronger than a finite pass streak alone: the report lacks the minimum
failure evidence needed to define a falsifiable bug, while extensive stress
failed to regenerate that evidence.

Close #558 as `not_planned` with the complete forensic record. The closure must
invite reopening when a recurrence includes the Vitest failure block or JUnit
testcase output and the exact commit/environment. Do not add retries, timeouts,
coverage exclusions, diagnostic production code, or a speculative fix. If the
issue is reopened with actionable evidence, it starts a fresh systematic
root-cause investigation and may receive an independent PR.

## Development and Review Method

Every code or behavior change follows systematic debugging and red-green TDD:

1. Reproduce the reported behavior or isolate the current source-level
   contradiction.
2. Trace the data/control flow to the root cause and compare it with a working
   repository pattern.
3. Write the smallest observable regression test and demonstrate the expected
   failure against the pre-fix baseline.
4. Apply one root-cause fix and demonstrate the focused test passing.
5. Refactor only while tests remain green.

The MoM workflow is mandatory. The coordinator owns planning. Independent
exploration and implementation use `gpt-5.6-luna` at max effort with disjoint
write sets. Before publication, `cortex-hq/zai-org-GLM-5.2` and
`gpu04/moonshotai-Kimi-K3` perform parallel max-effort adversarial reviews.
`anthropic/claude-opus-5` at medium effort receives the implementation plus
both first-pass reports and gives the second-pass merge verdict. Actionable
findings return to Luna max-effort workers, followed by fresh focused and full
verification.

## Verification and Merge Gates

Each implementation PR must satisfy all applicable gates before merge:

- Focused regressions pass, including repeated isolated-process execution for
  timing-sensitive tests. PR 1 runs the four reconciliation cases and the
  compact-route case at least twenty times under isolated conditions, then
  proves the complete suite under concurrent coverage load and `umask 0022`.
- A fresh `npm run test:ci` passes with 100% statements, branches, functions,
  and lines over the complete configured production scope and every per-file
  threshold.
- `npm run build`, type checking, linting, and repository-specific workflow
  tests pass through the canonical scripts.
- No global timeout increases, skipped tests, coverage exclusions, `v8 ignore`
  directives, narrowed collection scopes, flags, or report-only topology are
  introduced.
- Production TypeScript additions/moves update `codecov.yml` and
  `test/codecov-config.test.ts` atomically so every covered file has exactly one
  component owner.
- New dependencies are avoided. If one becomes necessary, it must be exactly
  pinned, integrity protected, and approved with `socket package score` before
  addition.
- Commits use DCO `--signoff`, contain no agent attribution, and PRs use merge
  commits rather than squash or rebase.
- User-facing behavior has complete `docs/` coverage and an explicit
  Changesets decision.
- Required GitHub checks and review threads are terminal and resolved. Any
  review fix receives `Fixed in [commit hash].` on its thread before resolution.

Independent branches start from current `origin/main`. Dependent changes start
only after their upstream PR merges. PR 1 merges first to stabilize the full
suite; PR 2 follows; security-sensitive PR 3 and release-sensitive PR 4 merge
after their own isolated review cycles. If concurrent implementation is used,
each branch keeps a disjoint write set and rebases only its own commits onto
the updated main before final verification.

## Closure and Final Audit

Already-fixed issues receive a comment that names the merged PR, fixing commit,
verified protected-branch SHA, exact focused command/test, and result, then are
closed as completed. Newly fixed issues close through their merged PR or an
equivalent evidence comment only after the merge commit is an ancestor of the
required protected branch.

After the last merge:

1. Search GitHub again for every open `bug` issue and reconcile the result with
   the initial inventory.
2. Verify every fixing merge is reachable from `origin/main` and, where
   applicable, the protected maintenance branch.
3. Run the Codex local stability workflow: update main, build, link, run
   `lcm doctor`, run `npm test`, install the Codex connector, and run the Codex
   connector doctor.
4. Store non-obvious root causes, decisions, and workflow learnings in LCM.
5. Mark the persistent goal complete only when the GitHub inventory, protected
   branches, local package, connector, and full verification evidence all agree.
