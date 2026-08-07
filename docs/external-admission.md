# External admission recovery

The required `external-admission` commit status admits an exact pull request
head only after authenticated CI and DCO checks succeed. Normal admission is
automatic: authenticated DCO `check_run` events and canonical pull-request CI
`workflow_run` events re-evaluate the exact head SHA without polling on a
runner.

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
  evaluation. It remains pending when required evidence is incomplete,
  transient, changed during evaluation, or cannot identify exactly one open,
  non-draft PR targeting `main` at that SHA.
- **Success:** three consecutive fresh snapshots prove authenticated CI and DCO
  success on the same exact head. The CI check must resolve to a successful
  terminal `pull_request` run of `.github/workflows/ci.yml` for the same
  repository and SHA.
- **Failure:** a required check is terminally unsuccessful, CI provenance is
  invalid, or evaluation encounters an API or policy error. Inspect the linked
  workflow run before retrying.

An invalid or missing SHA fails before a status can be safely written. The
workflow normalizes a valid hexadecimal payload SHA to lowercase before status
writes, PR association, and policy comparisons.

## Security and trusted revision

`repository_dispatch` runs this workflow only when the workflow file exists on
the repository default branch. GitHub sets the run ref to the default branch
and the run SHA to its latest commit; callers cannot choose another branch or
tag. The executable evaluator and policy are sparsely checked out from
`github.workflow_sha` with credentials disabled. The client payload supplies
only the commit SHA to evaluate and is never used as a checkout ref or executed
as code.

Every valid event revokes stale admission before checkout or PR association.
The evaluator paginates commit-associated pull requests and check runs,
authenticates exact check names and application identities, and repeats PR
eligibility, required-check, and CI provenance validation immediately before
success. It never downloads CI artifacts or caches and never checks out or
executes pull-request-controlled content.

Do not add or use `workflow_dispatch` for this recovery path. Its caller can
select a branch or tag containing a different workflow revision, which is not
an acceptable trust boundary for a workflow that can write commit statuses.

The initial transition from the legacy review-provider policy required one
maintainer bootstrap because the default-branch evaluator could not admit its
own replacement. That bootstrap required a manually recorded exact head plus
successful CI, DCO, Socket, CodeQL, coverage, and review results. It is not a
normal merge path; subsequent changes use the standard protected CI-and-DCO
admission flow.
