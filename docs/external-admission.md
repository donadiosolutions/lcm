# External admission recovery

The required `external-admission` commit status admits pull requests whose
third-party checks do not run on synthetic merge-queue commits. Normal
admission is automatic: authenticated Greptile and DCO `check_run` events and
canonical pull-request CI `workflow_run` events re-evaluate the exact pull
request head SHA without polling on a runner.

Provider checks can also report against GitHub's synthetic commits with an
empty suite branch or a `gh-readonly-queue/` ref. External admission requires
a non-empty suite branch and rejects the reserved queue prefix before writing
a legacy commit status because the permissionless
`external-admission-merge-group.yml` workflow owns the synthetic SHA. Normal
pull-request provider events remain subject to the complete exact-SHA
admission policy.

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
- **Success:** one fresh and final exact-SHA snapshot proves authenticated
  Greptile plus DCO success for sensitive changes from normal contributors, or
  authenticated canonical CI plus DCO success for either coverage-neutral
  changes or sensitive same-repository Dependabot changes. The Dependabot
  exception requires the exact `dependabot[bot]` login, GitHub `Bot` type, a
  non-empty `dependabot/` head ref, equal authoritative head/base repository
  names, and an explicit match in trusted root `greptile.json`. The CI check
  must resolve to a successful canonical pull-request workflow run for the
  same repository and head SHA.
- **Failure:** a required check is terminally unsuccessful, CI provenance is
  invalid, or evaluation encounters an API or policy error. Inspect the linked
  workflow run before retrying.

## Greptile author exclusions

The repository-root [`greptile.json`](../greptile.json) lists authors that
Greptile itself excludes from review. External admission reads that file only
from the trusted workflow revision, never from the pull request head. The
current configuration excludes only `dependabot[bot]`.

An excluded login bypasses Greptile only for authoritative same-repository
Dependabot provenance: the pull-request author must have the exact
`dependabot[bot]` login and GitHub type `Bot`, the head ref must start with
`dependabot/` and contain a suffix, and the authoritative head and base
repository names must match exactly. A human account, a different bot,
cross-repository head, non-Dependabot branch, or absent/malformed provenance
remains on the Greptile path or fails evaluation closed.

Because it controls this exception, changing `greptile.json` is itself a
non-bypassable trust-sensitive diff. It requires authenticated Greptile Review
plus DCO on the exact PR head for every author, including an author excluded by
the current trusted configuration. This also applies when `greptile.json` is a
rename's `previous_filename`.

For another coverable or trust-sensitive diff, qualifying Dependabot
provenance follows the exact-head canonical CI plus DCO path. Other authors
require authenticated Greptile Review plus DCO. In particular,
`github-actions[bot]` and the `changeset-release/main` version PR always require
Greptile for sensitive changes. The evaluator re-reads the current PR
identity, changed-file classification, and trusted configuration before it
posts success.

Sensitive paths include every file below `bin/`, `installer/`, and `src/`
(including shipped prompt and connector assets and PostgreSQL migrations);
every `.mjs` file below `scripts/` at any depth; trust-sensitive `.github`
automation; `greptile.json`; package manifests and lockfiles; and Vitest or
TypeScript configuration. Tests, documentation, Changesets metadata, and other
paths remain coverage-neutral unless a rename's previous path is sensitive.

Author matching is case-insensitive. The supported Greptile-compatible glob
syntax is `*` and `?`; `[`, `]`, and `!` are literal characters, so
`dependabot[bot]` matches the GitHub bot login rather than a character class.
A missing, unreadable, invalid-JSON, or malformed `excludeAuthors` value fails
admission closed rather than granting an exclusion.

An invalid or missing SHA fails before a status can be safely written. The
workflow normalizes a valid hexadecimal payload SHA to lowercase before status
writes, PR association, and policy comparisons.

## Security and trusted revision

`repository_dispatch` runs this workflow only when the workflow file exists on
the repository's default branch. GitHub sets the run ref to the default branch
and the run SHA to its latest commit; callers cannot choose another branch or
tag. The executable policy and root `greptile.json` are sparsely checked out
from `github.workflow_sha` with credentials disabled. The client payload
supplies only the commit SHA to evaluate and is never used as a checkout ref or
executed as code.

Do not add or use `workflow_dispatch` for this recovery path. Its caller can
select a branch or tag containing a different workflow revision, which is not
an acceptable trust boundary for a workflow that can write commit statuses.
The workflow also never downloads CI artifacts or caches and never executes
pull-request-controlled content.
