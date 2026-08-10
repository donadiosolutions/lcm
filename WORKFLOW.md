# Development Workflow

This workflow is the default for all non-trivial features. When superpowers brainstorming asks design questions, these defaults apply unless the user overrides.

## Continuous Improvement

This document is a living record. **Update it whenever you learn something:**

- A step that failed or caused rework → add it to Common Pitfalls
- A new default answer that proved correct → add it to the Defaults table
- A Copilot interaction pattern that worked (or didn't) → update the Copilot section
- A phase that needed reordering or an extra step → revise the phase
- A new tool, command, or technique that saved time → document it

**When to update:** At the end of every feature cycle (after the implementation PR merges), review this doc against what actually happened. If reality diverged from the doc, fix the doc — not reality.

**How to update:** Create a `docs/TOPIC` branch, push, complete the Copilot review loop, and require every protected exact-head check to pass. Set `PR_NUMBER` to the pull request number and merge it with `gh pr merge "${PR_NUMBER}" --repo donadiosolutions/lcm --merge`. Same flow as any other docs change.

## Branch Strategy

```text
feature/docs branches → main (default, protected)
```

- **`main`** — Default branch. All PRs target main. Protected: pull requests, required checks, and reviews are required; no force push. Pushing a matching stable `vX.Y.Z` or beta `vX.Y.Z-beta.N` tag triggers draft-release creation.
- **Feature branches** — `feat/TOPIC`, `docs/TOPIC`, `fix/TOPIC`. Always branch from main and use an isolated worktree for each concurrent change.

Independent changes may be developed in parallel on isolated branches and
worktrees. Dependent work must wait for its upstream PR to merge, then fetch
and rebase onto the new `main` before it is merged.

The repository does not use a merge queue. Merge protected pull requests
directly with merge commits only after every required exact-head check and
review passes. Do not squash or rebase PRs: release publication depends on
maintenance and forward-port commits remaining ancestors of `main`. Routine
administrator bypasses remain prohibited except for documented emergencies.

The required `external-admission` status separates pull-request admission from
merge-group validation for DCO, which does not report on synthetic queue
commits. Authenticated DCO `check_run` events and lifecycle events from the
canonical `.github/workflows/ci.yml` workflow drive `external-admission.yml`;
pull-request lifecycle events do not start this write-capable workflow. Every
accepted DCO event, canonical CI event, or default-branch
`external-admission-reconcile` dispatch is a wake-up for the stateless reducer:
it evaluates the latest exact-head snapshot and exits instead of polling on a
runner. A workflow or check-run event ID is wake-up context only, never state
authority; the reducer selects the latest authenticated CI and DCO evidence
for the exact head. Recovery dispatch with the exact PR head SHA provides
fail-closed reconciliation if an event is delayed or lost; see the
[external-admission recovery guide](docs/external-admission.md).

Every eligible pull request requires authenticated DCO and exact-head canonical
CI. Only one open, non-draft pull request in the exact repository, targeting a
protected `main` or protected `maintenance/X.Y.x` base, can satisfy admission.
Only `pull_request` runs of `.github/workflows/ci.yml` for the exact repository
and head SHA can satisfy its CI requirement; push and synthetic merge-group runs
are rejected before a runner starts. The reducer reads live base protection and
revalidates base and pull-request eligibility before success. An aggregate `ci`
check may succeed while a trailing workflow job is still running, so incomplete
current checks remain pending until the next trusted event. Invalid, ambiguous,
ineligible, or terminally unsuccessful evidence is a terminal failure.

Every accepted event replaces stale successful admission with `pending` before
checkout or PR association, then evaluates the latest exact-head snapshot.
Commit-associated PRs and check runs are paginated and flattened. The reducer
revalidates live base protection, PR uniqueness and eligibility, authenticated
CI and DCO evidence, and CI-run provenance at the initial, current, and final
snapshots before success. The executable evaluator and policy are sparsely
checked out from the trusted workflow revision with persisted credentials
disabled. Although a `workflow_run` handler receives a write-capable token, the
evaluator never downloads CI artifacts or caches and never checks out or
executes PR-controlled content.

The initial transition from the legacy review-provider policy required one
documented maintainer bootstrap because the default-branch evaluator could not
admit its own replacement. That exact head was manually required to pass CI,
DCO, Socket, CodeQL, coverage, and review gates. Subsequent admission changes
use the normal protected no-bypass flow.

After PR-head admission, the separate
`external-admission-merge-group.yml` workflow runs a permissionless Actions
check named `external-admission` on each synthetic `merge_group` commit. It does
not publish a commit status. This exception applies only to DCO, which cannot
report on that commit: CI, both default CodeQL analyses, the security-extended
CodeQL analysis, and both Socket checks still run against the synthetic commit
before it may merge.

CodeRabbit reports remain informational and best-effort and are not encoded as
an admission requirement.

### Release Flow

1. Changesets accumulate on PRs targeting `main` (`.changeset/*.md` files).
2. `changesets/action` creates or updates the version PR. Manual dispatch with
   `channel=beta` enters beta mode; `channel=stable` exits an active beta.
3. Merge the version PR, then create and push its exact signed annotated stable
   or `beta.N` tag.
4. The tag-triggered `publish.yml` job runs the complete validation suite,
   generates Highlights with Codex, and creates a draft GitHub release.
5. A maintainer reviews and publishes that draft manually.
6. Only the `release: published` job publishes npm: beta versions update the
   `beta` dist-tag, while stable versions update `latest`.

The manual release helper performs the tag step idempotently: it pushes or fetches a valid one-sided signed annotated tag, requires exact tag-object and peeled-commit equality when both copies exist, and refuses to move, replace, or overwrite conflicts. It locates the resulting tag-triggered workflow using both the tag name and merge commit SHA, verifies the draft release and that npm remains unpublished, then returns control for manual publication.

### CI Triggers

| Workflow                             | Trigger                                                                              | Purpose                                                                                 |
| ------------------------------------ | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `ci.yml`                             | Push to main and release + all PRs + merge groups (`checks_requested`)               | Type-check, test, and build; upload Codecov reports outside merge groups                |
| `external-admission.yml`             | Authenticated DCO checks, canonical PR CI lifecycle, default-branch exact-SHA repository dispatch | Statelessly require exact-head canonical CI and DCO for every eligible pull request |
| `external-admission-merge-group.yml` | Merge groups (`checks_requested`)                                                    | Run the required `external-admission` Actions check on the synthetic merge-group commit |
| `codeql.yml`                         | Push to main + PRs targeting main + merge groups (`checks_requested`)                | Required CodeQL analysis and SARIF upload                                               |
| `codeql-extended.yml`                | Scheduled + manual dispatch + PRs targeting main + merge groups (`checks_requested`) | Required security-extended CodeQL analysis and SARIF upload                             |
| `version-pr.yml`                     | Push to main + manual `beta`/`stable` dispatch                                      | Auto-create version PRs and enter or exit Changesets beta mode                          |
| `publish.yml`                        | Stable/beta tag pushes + GitHub release publication                                  | Create draft releases from tags; publish npm only after manual draft publication        |

### CI Environment Caches

The canonical CI workflow initializes its dependency environment in one
Blacksmith job before Core CI and the PostgreSQL matrix begin. The repository
local `.github/actions/setup-ci` composite action is the only installation
entrypoint used by those jobs. It maintains exact, fallback-free caches for:

- `node_modules`, keyed by the Node version, runner OS and architecture, and
  the complete npm installation contract: `package.json`, `package-lock.json`,
  and `.npmrc`;
- the digest-pinned PostgreSQL and Node images used by the conformance harness;
- a cleanly stopped PostgreSQL 18 cluster containing a secret-free
  `lcm_harness_template` database with the required extensions.

An exact `node_modules` hit skips `npm ci` only after the cache stamp, platform,
Node version, npm installation-contract digest, package inventory, and
`npm ls --all` all validate. Image restores are checked against their
repository digests.
Image and template archives carry SHA-256 sidecars, and PostgreSQL template
archives also reject unsafe or incomplete paths before use.

The PostgreSQL cache is immutable initialization state, not a reusable test
database. Each matrix leg extracts it into a new labeled volume, clones a unique
control database, generates new passwords and TLS material, inserts its own run
sentinel, and cleans every run-scoped container, network, volume, and secret.
The cached cluster contains no login-capable harness roles, credentials,
private keys, run identifiers, test databases, or sentinels.

Environment initialization, Core CI, PostgreSQL conformance, and both CodeQL
profiles use Blacksmith runners. The small aggregate check and read-only
Codecov upload jobs use GitHub-hosted runners. Publishing remains GitHub-hosted
because npm trusted provenance does not accept self-hosted runners.

The CI workflow keeps coverage reporting in separate read-only jobs. Checkout
uses the job token to fetch `github.repository` at the workflow's `github.sha`,
but `persist-credentials: false` ensures credentials are not persisted. The jobs
consume the fixed test artifact and never execute repository code. This matches
the tree that produced the artifact, including the synthetic merge commit used by
pull-request runs, while `override_pr` associates the uploads with the PR. The
trusted job has OIDC permission and handles pushes and same-repository PRs,
including Dependabot PRs. A mutually exclusive fork-PR job omits OIDC permission
and uses Codecov's tokenless upload path. Both reporting jobs are skipped for
`merge_group`; the synthetic commit runs the full coverage suite in CI while its
separate merge-group workflow supplies the required `external-admission` check.
Keep each upload job's job-level `if` as `!cancelled()` combined with, not
replacing, its existing event/trust predicates, including the `merge_group`
exclusion; retain `needs: ci` and `fail_ci_if_error: true` on every Codecov
upload action. Uploads are attempted after non-cancelled aggregate `ci` failures
while that required `ci` check remains red.
Uploads cannot succeed if the reports were not produced or if the Codecov uploader
or service fails.

## Defaults (predefined answers for brainstorming)

| Question                | Default Answer                                                 |
| ----------------------- | -------------------------------------------------------------- |
| Spec location           | PR or issue body unless the user asks for a tracked document   |
| Visual companion        | No (CLI project, no visual questions)                          |
| Implementation approach | Parallel tracks — breaking changes isolated from additive work |
| Registry/config format  | TypeScript (type-safe, compile-time checks)                    |
| Install behavior        | Auto-write files (match ByteRover (brv) UX)                    |
| State tracking          | Filesystem scan (no state files)                               |
| Release strategy        | Parallel tracks with separate PRs                              |
| PR review               | Copilot review loop; CodeRabbit is informational               |

## Phase 1: Design (Opus, max effort)

1. Study the spec/requirements using brainstorming skill
2. Ask clarifying questions only for genuinely ambiguous decisions — use defaults above for standard questions
3. Propose 2-3 approaches with trade-offs, recommend one
4. Present design sections incrementally, get user approval
5. Write the design spec in the PR or issue body unless the user asks for a tracked document
6. Run spec review loop (code-reviewer agent + user review)
7. Write the implementation plan in the PR or issue body unless the user asks for a tracked document

## Phase 2: Spec Review via PR

1. **Sync first:** `git checkout main && git pull --ff-only origin main` before branching — stale local bases cause Copilot to review unrelated code
2. Create a `docs/TOPIC` branch from main
3. Ensure only documentation files are in the diff — specs, plans, workflow docs
4. Push and open PR
5. Request Copilot review (add `copilot-pull-request-reviewer[bot]` to reviewers)
6. Run review loop (see Copilot Review Loop below)
7. Once the Copilot loop is complete (max 3 rounds — see Review Loop) and every protected exact-head check passes, set `PR_NUMBER` to the pull request number and merge it with `gh pr merge "${PR_NUMBER}" --repo donadiosolutions/lcm --merge`.
8. Confirm `gh pr view "${PR_NUMBER}" --repo donadiosolutions/lcm --json state --jq .state` reports `MERGED` before starting implementation. If the merge command or final state check fails, inspect `gh pr checks "${PR_NUMBER}" --repo donadiosolutions/lcm` and resolve the protected-branch failure without an administrator bypass.

## Phase 3: Implementation (Sonnet subagents)

1. **Sync first:** `git checkout main && git pull --ff-only origin main` to get latest (including merged specs)
2. Dispatch `model: sonnet` subagents with `isolation: worktree` for each task in the plan
3. **Independent tasks** → launch in parallel (e.g., PR A: delete files, PR D: add new module)
4. **Sequential tasks** → launch the dependent branch only after the upstream PR merges, then branch from the updated `main`. If a downstream branch already exists on the old upstream tip, enter its isolated worktree, set `OLD_UPSTREAM_TIP` to that commit, and replay only its downstream commits with `git fetch origin main && git rebase --onto origin/main "${OLD_UPSTREAM_TIP}"`. Omitting the branch argument rebases the already checked-out downstream branch without asking Git to check it out in another worktree.
5. Each subagent: implement code + tests, run `npm test`, commit (do NOT push)
6. After subagent completes: review the diff, push, open PR, request Copilot review

## Phase 4: Final Review (Opus, max effort)

1. Review all implementation work against the spec
2. Run full test suite — all tests must pass
3. Fix any issues found
4. Ensure changeset file exists if user-facing changes

## Phase 5: Implementation PR + Automated Review

1. Push implementation branch, open PR
2. Request Copilot review (add to reviewers list)
3. Run review loop (see below)
4. Once the Copilot loop is complete and every protected exact-head check passes, set `PR_NUMBER` to the pull request number and merge it with `gh pr merge "${PR_NUMBER}" --repo donadiosolutions/lcm --merge`
5. Confirm the implementation PR reports `MERGED` before beginning post-merge validation or dependent work.

## Copilot Interaction

### Actions

- **Trigger code review:** Add `copilot-pull-request-reviewer` to PR reviewers via `gh pr edit --add-reviewer`
- **Re-trigger review** (after pushing fixes): `gh pr edit --remove-reviewer` then `--add-reviewer` (see Exact Commands)
- **Delegate work** (have Copilot open a PR): Tag `@copilot` in a PR comment
- **Reply to Copilot comments:** Start inline replies with `@copilot`
- **Never** tag `@copilot` in comments when you want a review — it opens a new PR instead

### Exact Commands

```bash
# Request review (and re-trigger after fixes)
gh pr edit {n} --repo {owner}/{repo} --remove-reviewer copilot-pull-request-reviewer
sleep 2
gh pr edit {n} --repo {owner}/{repo} --add-reviewer copilot-pull-request-reviewer
```

**Why `gh pr edit` and not the REST API:**
The REST `requested_reviewers` endpoint returns **422** for bot reviewers ("Reviews may only be requested from collaborators"). `gh pr edit` uses the GraphQL API internally and handles bot reviewers correctly. Confirmed working on PR #56.

**Methods that do NOT work:**

- `gh api -X POST .../requested_reviewers -f 'reviewers[]=copilot-pull-request-reviewer'` — 422 for bots
- Empty commits — Copilot does not reliably trigger on diffs with no substantive changes
- Tagging `@copilot` in comments — opens a new PR instead of reviewing

### Polling for Review Completion

Copilot reviews take 1-3 minutes. Do NOT sleep-poll in a loop. Use background commands.

```bash
# 1. Check if review request is still pending (Copilot hasn't started):
gh pr view {n} --json reviewRequests --jq '.reviewRequests[].login'
# Empty = Copilot picked it up. "copilot-pull-request-reviewer[bot]" = still pending.

# 2. Check review count (compare before/after):
gh api repos/{owner}/{repo}/pulls/{n}/reviews --jq '. | length'

# 3. Most reliable: check timeline for reviewed event:
gh api 'repos/{owner}/{repo}/issues/{n}/timeline?per_page=100' \
  --jq '[.[] | select(.event == "review_requested" or .event == "reviewed")] | .[-2:]'
# If last event is "reviewed" → review complete.
# If last event is "review_requested" → still in progress.

# 4. Get latest review details:
gh api repos/{owner}/{repo}/pulls/{n}/reviews \
  --jq '.[-1] | {state: .state, body: .body[:300]}'

# 5. Get new inline comments (after a timestamp):
gh api repos/{owner}/{repo}/pulls/{n}/comments \
  --jq '[.[] | select(.created_at > "TIMESTAMP")] | .[] | {path: .path, line: .line, body: .body[:250]}'
```

### Copilot Review Loop

1. Request review (POST to requested_reviewers)
2. Launch one background polling command that sleeps for 180 seconds before checking the review count and comments
3. When notified, check latest review state and new comments
4. If comments found:
   a. **Batch ALL fixes** into a single commit (do not fix-push-review one at a time)
   b. Push once
   c. Re-trigger review (DELETE + POST)
5. **Max 3 rounds.** After round 3, stop the Copilot loop if only minor nits remain. Do not chase zero Copilot comments indefinitely; all protected exact-head checks and actionable review threads are still required before merge.
6. Review is "clean" when: 0 new comments, or only context-specific nits that Copilot can't understand (e.g., Agent conventions)

### Common Pitfalls

- **Stale diff**: Always sync main before creating branches. If main has unpushed local commits, the PR diff includes unrelated code and Copilot reviews the wrong things.
- **@copilot in comments**: Opens a new PR instead of triggering review. Always use the reviewers API.
- **REST API 422 for Copilot bot**: The `requested_reviewers` REST endpoint rejects bot slugs. Use `gh pr edit --add-reviewer` instead.
- **Empty commits don't trigger Copilot**: Copilot only reviews on substantive diffs. Use `gh pr edit` re-request instead.
- **Code in docs PRs**: Cherry-pick only docs commits if the branch has mixed content. Set `CLEAN_BRANCH` to the new branch name and `DOCS_COMMIT_SHA` to the documentation commit, then use `git checkout -B "${CLEAN_BRANCH}" origin/main && git cherry-pick "${DOCS_COMMIT_SHA}"`.
- **Sequential PR chains**: Create PR B from updated `main` only after PR A lands. If PR B already contains commits based on PR A's old tip, enter PR B's isolated worktree, set `OLD_PR_A_TIP` to that commit, and replay only its own commits with `git fetch origin main && git rebase --onto origin/main "${OLD_PR_A_TIP}"`. Omit the branch argument so Git rebases the branch already checked out in that worktree instead of attempting a conflicting cross-worktree checkout.
