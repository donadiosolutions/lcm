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

**How to update:** Create a `docs/<topic>` branch, push, get Copilot review, then queue it for main with `gh pr merge <number> --repo donadiosolutions/lcm --auto --squash`. Same flow as any other docs change.

## Branch Strategy

```text
feature/docs branches → main (default, protected)
```

- **`main`** — Default branch. All PRs target main. Protected: PRs and the merge queue are required; no force push. Pushing a matching `vX.Y.Z` tag triggers the publish workflow.
- **Feature branches** — `feat/<topic>`, `docs/<topic>`, `fix/<topic>`. Always branch from main and use an isolated worktree for each concurrent change.

Independent changes may be developed in parallel on isolated branches and worktrees, but the required merge queue serializes landings into `main`. Dependent work must wait for its upstream PR to merge, then fetch and rebase onto the new `main` before it is queued.

The merge queue uses squash merging and an `ALLGREEN` grouping strategy. It builds one entry at a time, with both the minimum and maximum merge-group size set to one, no minimum wait, and a 60-minute check-response timeout. Routine administrator bypasses are prohibited; the existing bypass is reserved for documented emergencies.

The required `external-admission` status separates pull-request admission from
merge-group validation for providers that do not report on synthetic queue
commits. On a non-draft PR, the trusted `pull_request_target`, `status`, and
`check_run` handlers in `external-admission.yml` require authenticated results
from CodeRabbit, `codecov/patch`, and DCO on the PR's exact head SHA. Provider
reruns revalidate that SHA and replace a stale successful admission with a
pending or failed result until all three providers pass again. Draft PRs are not
eligible for admission.

After PR-head admission, the separate
`external-admission-merge-group.yml` workflow runs a permissionless Actions
check named `external-admission` on each synthetic `merge_group` commit. It does
not publish a commit status. This exception applies only to the three external
providers, which cannot report on that commit: CI, both default CodeQL
analyses, the security-extended CodeQL analysis, and both Socket checks still
run against the synthetic commit before it may merge.

### Release Flow

1. Changesets accumulate on PRs targeting `main` (`.changeset/*.md` files)
2. Version PR is auto-created by `changesets/action` on each main push
3. When ready to release: merge the version PR on `main` (bumps package.json)
4. Create and push a signed annotated semver tag at the exact merged `main` commit, for example `vX.Y.Z`
5. The `publish.yml` workflow runs automatically from that tag
6. Let the publish workflow:
   - Type-check, test, build
   - Publish to npm (`@donadiosolutions/lcm`)
   - Create or update the GitHub release
   - Use the plugin manifest version already included in the version PR

The manual release helper performs step 4 idempotently: it pushes or fetches a valid one-sided signed annotated tag, requires exact tag-object and peeled-commit equality when both copies exist, and refuses to move, replace, or overwrite conflicts. It locates the resulting tag-triggered workflow using both the tag name and merge commit SHA, so later updates to `main` cannot select the wrong run.

### CI Triggers

| Workflow                             | Trigger                                                                              | Purpose                                                                                 |
| ------------------------------------ | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `ci.yml`                             | Push to main and release + all PRs + merge groups (`checks_requested`)               | Type-check, test, and build; upload Codecov reports outside merge groups                |
| `external-admission.yml`             | Non-draft PR lifecycle + authenticated CodeRabbit status and Codecov/DCO check runs  | Require all three external providers on the exact eligible PR head                      |
| `external-admission-merge-group.yml` | Merge groups (`checks_requested`)                                                    | Run the required `external-admission` Actions check on the synthetic merge-group commit |
| `codeql.yml`                         | Push to main + PRs targeting main + merge groups (`checks_requested`)                | Required CodeQL analysis and SARIF upload                                               |
| `codeql-extended.yml`                | Scheduled + manual dispatch + PRs targeting main + merge groups (`checks_requested`) | Required security-extended CodeQL analysis and SARIF upload                             |
| `version-pr.yml`                     | Push to main                                                                         | Auto-create version PR from changesets                                                  |
| `publish.yml`                        | Semver tag pushes (`vX.Y.Z`) + manual dispatch from a tag                            | Publish npm + create GitHub release                                                     |

The CI workflow keeps coverage reporting in a separate no-checkout job that
consumes the fixed test artifact. Codecov uses OIDC for pushes and same-repository
PRs, including Dependabot PRs; fork PRs use Codecov's tokenless upload path. The
reporting job is skipped for `merge_group`, where `external-admission` represents
the Codecov result already verified on the exact PR head.

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
| PR review               | Copilot via reviewers list, not @copilot tag                   |

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
2. Create `docs/<topic>` branch from main
3. Ensure only documentation files are in the diff — specs, plans, workflow docs
4. Push and open PR
5. Request Copilot review (add `copilot-pull-request-reviewer[bot]` to reviewers)
6. Run review loop (see Copilot Review Loop below)
7. Once Copilot has no issues (max 3 rounds — see Review Loop), queue the PR with `gh pr merge <number> --repo donadiosolutions/lcm --auto --squash`
8. Wait for the queued PR to land before starting implementation:
   ```bash
   while :; do
     state=$(gh pr view <number> --repo donadiosolutions/lcm --json state --jq .state)
     case "$state" in
       MERGED) break ;;
       OPEN) sleep 15 ;;
       *) echo "spec PR entered unexpected state: $state" >&2; exit 1 ;;
     esac
   done
   ```

## Phase 3: Implementation (Sonnet subagents)

1. **Sync first:** `git checkout main && git pull --ff-only origin main` to get latest (including merged specs)
2. Dispatch `model: sonnet` subagents with `isolation: worktree` for each task in the plan
3. **Independent tasks** → launch in parallel (e.g., PR A: delete files, PR D: add new module)
4. **Sequential tasks** → launch the dependent branch only after the upstream PR lands through the queue, then branch from the updated `main`. If a downstream branch already exists on the old upstream tip, replay only its downstream commits with `git fetch origin main && git rebase --onto origin/main <old-upstream-tip> <downstream-branch>`.
5. Each subagent: implement code + tests, run `npm test`, commit (do NOT push)
6. After subagent completes: review the diff, push, open PR, request Copilot review

## Phase 4: Final Review (Opus, max effort)

1. Review all implementation work against the spec
2. Run full test suite — all tests must pass
3. Fix any issues found
4. Ensure changeset file exists if user-facing changes

## Phase 5: Implementation PR + Copilot Review

1. Push implementation branch, open PR
2. Request Copilot review (add to reviewers list)
3. Run review loop (see below)
4. Once Copilot review has no remaining inline comments, queue the PR with `gh pr merge <number> --repo donadiosolutions/lcm --auto --squash`

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
2. Launch ONE background command: `sleep 180 && <check review count + comments>`
3. When notified, check latest review state and new comments
4. If comments found:
   a. **Batch ALL fixes** into a single commit (do not fix-push-review one at a time)
   b. Push once
   c. Re-trigger review (DELETE + POST)
5. **Max 3 rounds.** After round 3, if remaining comments are minor nits (1-2 editorial suggestions), merge. Do not chase zero comments indefinitely.
6. Review is "clean" when: 0 new comments, or only context-specific nits that Copilot can't understand (e.g., Agent conventions)

### Common Pitfalls

- **Stale diff**: Always sync main before creating branches. If main has unpushed local commits, the PR diff includes unrelated code and Copilot reviews the wrong things.
- **@copilot in comments**: Opens a new PR instead of triggering review. Always use the reviewers API.
- **REST API 422 for Copilot bot**: The `requested_reviewers` REST endpoint rejects bot slugs. Use `gh pr edit --add-reviewer` instead.
- **Empty commits don't trigger Copilot**: Copilot only reviews on substantive diffs. Use `gh pr edit` re-request instead.
- **Code in docs PRs**: Cherry-pick only docs commits if the branch has mixed content. Use `git checkout -B <clean-branch> origin/main && git cherry-pick <docs-commits>`.
- **Sequential PR chains**: Create PR B from updated `main` only after PR A lands. If PR B already contains commits based on PR A's old tip, replay only its own commits with `git fetch origin main && git rebase --onto origin/main <old-PR-A-tip> <PR-B-branch>`.
