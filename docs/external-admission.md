# External admission recovery

The required `external-admission` commit status admits an exact pull request
head only after authenticated CI and DCO checks succeed. A PR that authored
changes to CI or its control inputs also needs a trusted authorization for
that exact PR, head and authored-control digest.

Normal admission is automatic: every accepted authenticated DCO `check_run`,
canonical pull-request CI `workflow_run`, or default-branch recovery dispatch
wakes the reducer, which evaluates the latest exact-head snapshot without
polling on a runner. Event IDs are never state authority. Accepted CI and DCO
event IDs impose a freshness lower bound: older visible evidence may be
superseded, but newer or equal non-terminal event evidence remains pending
until the corresponding current check or run is visible.

DCO can also report against GitHub synthetic commits with an empty suite branch
or a `gh-readonly-queue/` ref. External admission requires a non-empty suite
branch and rejects the reserved queue prefix before writing a legacy commit
status because the permissionless `external-admission-merge-group.yml`
workflow owns the synthetic SHA.

Use repository-dispatch recovery only when an expected DCO or CI event was
delayed or lost. Recovery re-evaluates current GitHub state; it does not bypass,
replace, or manufacture any required check.

## Prerequisites and permissions

- Authenticate GitHub CLI as a repository maintainer and confirm the target
  account with `gh auth status`.
- The credential that creates the repository dispatch needs `Contents: write`
  repository permission. A classic personal access token needs the `repo`
  scope.
- The exact `external-admission-reconcile` event type and a current pull request
  head SHA are required.
- The workflow itself grants only `actions: read`, `checks: read`,
  `contents: read`, `pull-requests: read`, and `statuses: write`.

## Configuration

There are no user-configurable options. The accepted event identities,
freshness rules, status context, protected-base patterns, and trusted evaluator
behavior are repository policy. Changing them requires a reviewed workflow or
policy change; `PR_NUMBER` and `HEAD_SHA` in the recovery example are one-shot
operator variables, not configuration settings.

Changesets version pull requests retain their existing maintainer-operated
release path. This admission policy does not create a new automatic or
administrator-bypass path for them.

## Authorize authored control changes

The evaluator compares the immutable merge base A of the current protected
base B and PR head H against H. It reads complete Git trees, including object
identities and modes. It protects `.github/`, `scripts/`, `.agents/skills/`,
`test/setup/`, PostgreSQL shell initialization, the surface matrix, root package,
dependency and build/test configuration, checkout/package exclusions, unknown
root executables/configuration, and root Python modules and package subtrees
that can shadow the CI helper runner or its imports. Python source, bytecode
and extension modules are included regardless of executable mode.

Ordinary production code, assertion tests and documentation keep automatic
CI and DCO admission when they do not change this control projection. A stale
branch that authored no controls does not require authorization merely because
the base advanced. An authored control edit still requires authorization when
the current base already contains the same edit. This gate does not prove that
an older CI run executed the current synthetic merge tree.

For a control change, the workflow prints `Authored control digest for PR ...`
and waits for authorization. Review the exact PR/head and its authored changes,
then copy that 64-character digest from the trusted **External admission** run.
Authenticate as `bcdonadio` (numeric GitHub user ID `1458878`) and dispatch:

```bash
PR_NUMBER=265
HEAD_SHA="$(gh pr view "$PR_NUMBER" --repo donadiosolutions/lcm \
  --json headRefOid --jq .headRefOid)"
CONTROL_DIGEST='<64-character digest from the trusted evaluator>'
gh api --method POST repos/donadiosolutions/lcm/dispatches \
  -f event_type=external-admission-control-authorize \
  -F "client_payload[pr_number]=$PR_NUMBER" \
  -f "client_payload[head_sha]=$HEAD_SHA" \
  -f "client_payload[control_digest]=$CONTROL_DIGEST" --silent
```

The authenticated sender identity comes from GitHub, not the payload. The
default-branch evaluator independently rechecks the challenge and publishes
`external-admission-control-authorized` success with `controls-v1:<digest>`
and its trusted run URL. This receipt stays valid for the same PR/H/digest.
Moving B without changing A or the projection does not require a new receipt;
a new H or changed A/projection does. A newer invalid or failed receipt
supersedes an older success. Authorization can precede CI/DCO completion and
never replaces either check. Recovery dispatches do not authorize controls.
Maintainer-authored control maintenance uses this same explicit dispatch.

## Permanently revoke a head

Revocation creates a permanent, head-global failure tombstone in the separate
`external-admission-control-revoked` context. Any trusted tombstone overrides
every authorization on H, including later successes, changed digests, and
unchanged control projections. H cannot be reauthorized; create a new commit
H2 for a new authorization. The evaluator accepts revoke for the exact PR/H
even while the PR is closed and CI/DCO are absent or failing.

All accepted writers for H share a repository-scoped concurrency group whose
keys match regardless of letter case, with `cancel-in-progress: false`. This prevents running
overlap, but GitHub does not promise FIFO delivery and can replace a pending
run. Use this operator sequence to contain queued or delayed old writers:

1. Close the PR before revoking. Keep the exact PR number and H.
2. As `bcdonadio`, dispatch the revoke operation below. Wait for its run; if
   displaced or pending, retry while the PR remains closed.
3. Confirm the run reports readback of both the trusted tombstone and
   `external-admission` failure on H. Confirm no earlier writer remains queued
   or running. If a POST or readback is uncertain, keep the PR closed and retry.
4. Reopen only after those confirmations. Admission of H remains forbidden;
   push a new commit before requesting authorization again.

```bash
gh pr close "$PR_NUMBER" --repo donadiosolutions/lcm
gh api --method POST repos/donadiosolutions/lcm/dispatches \
  -f event_type=external-admission-control-revoke \
  -F "client_payload[pr_number]=$PR_NUMBER" \
  -f "client_payload[head_sha]=$HEAD_SHA" --silent
gh api --paginate "repos/donadiosolutions/lcm/commits/$HEAD_SHA/statuses?per_page=100" \
  --jq '.[] | select(.context == "external-admission-control-revoked" or .context == "external-admission") | {id,context,state,creator,target_url}'
# After confirming readback and that earlier writers have finished:
gh pr reopen "$PR_NUMBER" --repo donadiosolutions/lcm
```

A delayed pre-revoke authorizer cannot overcome the tombstone. An ordinary CI,
DCO or recovery event rereads raw status history and fails admission for H.
History is read to an explicit short terminal page; malformed, incomplete or
oversized history fails closed instead of silently discarding old tombstones.

## Find and dispatch the exact PR head SHA

Set `PR_NUMBER` to the open pull request number. Read `headRefOid` immediately
before dispatching so a subsequent force-push or new commit cannot be mistaken
for the intended revision:

```bash
PR_NUMBER=265
HEAD_SHA="$(gh pr view "$PR_NUMBER" \
  --repo donadiosolutions/lcm \
  --json headRefOid \
  --jq .headRefOid)"
[[ "$HEAD_SHA" =~ ^[0-9a-fA-F]{40}$ ]] || {
  echo "Could not resolve an exact pull request head SHA." >&2
  exit 1
}
```

Send the recovery event with that exact SHA:

```bash
gh api --method POST \
  repos/donadiosolutions/lcm/dispatches \
  -f event_type=external-admission-reconcile \
  -F "client_payload[head_sha]=$HEAD_SHA" \
  --silent
```

The API returning successfully means GitHub accepted the event; it does not
mean admission succeeded. Inspect the new **External admission** workflow run
and the `external-admission` status on `HEAD_SHA`.

## Expected status behavior

- **Pending:** the workflow posts pending before PR association or policy
  evaluation. It remains pending when the current authenticated CI or DCO
  evidence is missing, incomplete, transient, or changes during the
  three-snapshot evaluation. A newer event ID than the visible evidence, an
  equal `requested` or `in_progress` CI event, or an equal DCO `created` or
  `rerequested` event also remains pending. A completed event may reconcile only
  once its matching current run is visible. Transient branch-protection API
  failures remain pending so recovery can retry them.
- **Success:** three consecutive fresh snapshots prove authenticated CI and DCO
  success on the same exact head, while live base protection and pull-request
  eligibility remain valid. Exactly one open, non-draft pull request in the
  exact repository must target protected `main` or protected
  `maintenance/X.Y.x`. The CI check must resolve to a successful terminal
  `pull_request` run of `.github/workflows/ci.yml` for the same repository and
  SHA. Each snapshot also binds current B, authenticated A/H trees, the authored
  control projection/digest, and authorization/tombstone identities. Authored
  controls require a valid sticky receipt; any tombstone forbids success.
- **Failure:** pull-request or base evidence is missing, ambiguous, invalid, or
  ineligible; a supported `main` or maintenance base returns HTTP 404 because
  it was deleted; a required check is terminally unsuccessful; CI provenance is
  invalid or terminally unsuccessful; or evaluation encounters a malformed or
  non-transient API or policy error. A deleted historical candidate is ignored
  only when another unique eligible pull request remains. Inspect the linked
  workflow run before retrying.

An invalid or missing SHA fails before a status can be safely written. The
workflow normalizes a valid hexadecimal payload SHA to lowercase before status
writes, PR association, and policy comparisons.

## Code Quality baseline and admission

`external-admission` success proves only that the exact pull-request head
passed authenticated CI and DCO evaluation. It does not prove that the same
head satisfies the separate Code Quality or other ruleset evaluations. The
repository/default-branch Code Quality findings endpoint is a backlog
inventory, never a candidate-diff attribution mechanism: do not infer
pull-request attribution from an aggregate finding's `created_at` timestamp.

For a read-only baseline, inspect ruleset `15870347` and count the complete
repository/default-branch findings inventory. The documented endpoint supports
pagination and the `state=open` and `per_page=100` parameters:

```bash
gh api -H 'X-GitHub-Api-Version: 2026-03-10' \
  repos/donadiosolutions/lcm/rulesets/15870347 \
  --jq '{name,target,enforcement,bypass_actors,conditions,rules}'
gh api --paginate -H 'X-GitHub-Api-Version: 2026-03-10' \
  'repos/donadiosolutions/lcm/code-quality/findings?state=open&per_page=100' \
  --jq '.[].rule.severity' | sort | uniq -c
```

Record a UTC timestamp and count `.rule.severity` values from every page.
Analysis success, or resolving a review discussion, does not clear a blocking
finding.
Fix the finding or, only when a justified irrelevant or false-positive case
has been reviewed, use GitHub's explicit per-finding **Dismiss finding**
action. A finding is not dismissed merely because its pull-request discussion
was resolved. Preserve severity notes while triaging; do not bulk-dismiss the
backlog, change the rule to `evaluate` or `disabled`, lower its threshold,
alter unrelated rules, checks, or bypass actors, or use an administrator
bypass.

For rule-suite evidence, use GitHub's exact vocabulary: `pass` is protected
admission, `fail` is rejection, and `bypass` records a bypass and is never
acceptance evidence. Inspect a specific ruleset rule suite by its ID (this is
not a workflow or check-run ID):

```bash
RULE_SUITE_ID=3871813831
gh api --paginate -H 'X-GitHub-Api-Version: 2026-03-10' \
  "repos/donadiosolutions/lcm/rulesets/rule-suites/$RULE_SUITE_ID" \
  --jq '{id,result,rule_evaluations}'
```

On the dated 2026-08-30 snapshot, the active notes gate
coexisted with 46 open backlog findings (43 `note`, 3 `warning`). Clean PR
#771 had zero `github-code-quality[bot]` comments, and rule suite `3871813831`
reported overall `pass` with its `code_quality` evaluation `pass`. PR #739 had
one `js/missing-await` Code Quality bot comment; rule suite `3850764016`
reported overall `bypass` with `code_quality` `fail`. Its neither-fixed-nor-
dismissed finding remains open as warning #441 (`js/missing-await`). Do not
call #441 a proven real defect; it may be the argued false positive.

The dated counts are evidence, not configured constants, and will drift as
findings are fixed or explicitly dismissed. The unchanged ruleset still gives
`OrganizationAdmin` an `always` bypass. This increment forbids using that
bypass; narrowing it is a separate governance decision requiring its own
authorization, rollback, and review.

## Security and trusted revision

`repository_dispatch` runs this workflow only when the workflow file exists on
the repository's default branch. GitHub sets the run ref to the default branch
and the run SHA to its latest commit; callers cannot choose another branch or
tag. The executable evaluator and policy are sparsely checked out from
`github.workflow_sha` with credentials disabled. The client payload supplies
only selectors and a digest challenge, and is never used as a checkout ref or
executed as code.

Every accepted event revokes stale admission before checkout or PR association,
then evaluates the latest exact-head snapshot. Event IDs are wake-up context
only; accepted CI and DCO IDs additionally impose the path-specific freshness
lower bound described above. The evaluator paginates commit-associated pull
requests and check runs. It authenticates exact check names and application
identities, reads live base-branch protection, caches each base-ref lookup only
within one snapshot resolution, and revalidates PR eligibility, required checks,
CI provenance, immutable authored controls and raw authorization history
immediately before success. The evaluator reads Git object metadata as data;
it never checks out or executes pull-request-controlled content or consumes
CI artifacts or caches.

This boundary covers untrusted external public forks. The sole same-repository
human writer is currently `bcdonadio`, an administrator; fork PR tokens cannot
write these statuses. Before onboarding a lower-trust same-repository writer,
require native protected review or a distinct App status authority. This gate
does not protect against a malicious administrator. Merge groups retain the
existing constituent-admission assumption; no new human authorization of an
exact synthetic group is claimed. Protected ruleset `15870347` is unchanged.

Do not add or use `workflow_dispatch` for this recovery path. Its caller can
select a branch or tag containing a different workflow revision, which is not
an acceptable trust boundary for a workflow that can write commit statuses.

The initial transition from the legacy review-provider policy required one
maintainer bootstrap because the default-branch evaluator could not admit its
own replacement. That bootstrap required a manually recorded exact head plus
successful CI, DCO, Socket, CodeQL, coverage, and review results. It is not a
normal merge path; subsequent changes use protected CI and DCO admission plus
the explicit authorization above when they author control changes.
