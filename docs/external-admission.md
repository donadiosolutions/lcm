# External admission recovery

The required `external-admission` commit status admits pull requests whose
third-party checks do not run on synthetic merge-queue commits. Normal
admission is automatic: authenticated Greptile and DCO `check_run` events and
canonical pull-request CI `workflow_run` events re-evaluate the exact pull
request head SHA without polling on a runner.

Use repository-dispatch recovery only when an expected provider or CI event was
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
- **Success:** one fresh and final exact-SHA snapshot proves either authenticated
  Greptile plus DCO success for sensitive changes, or authenticated canonical CI
  plus DCO success for coverage-neutral changes.
- **Failure:** a required check is terminally unsuccessful, CI provenance is
  invalid, or evaluation encounters an API or policy error. Inspect the linked
  workflow run before retrying.

An invalid or missing SHA fails before a status can be safely written. The
workflow normalizes a valid hexadecimal payload SHA to lowercase before status
writes, PR association, and policy comparisons.

## Security and trusted revision

`repository_dispatch` runs this workflow only when the workflow file exists on
the repository's default branch. GitHub sets the run ref to the default branch
and the run SHA to its latest commit; callers cannot choose another branch or
tag. The executable policy is sparsely checked out from `github.workflow_sha`
with credentials disabled. The client payload supplies only the commit SHA to
evaluate and is never used as a checkout ref or executed as code.

Do not add or use `workflow_dispatch` for this recovery path. Its caller can
select a branch or tag containing a different workflow revision, which is not
an acceptable trust boundary for a workflow that can write commit statuses.
The workflow also never downloads CI artifacts or caches and never executes
pull-request-controlled content.
