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

**How to update:** Create a `docs/TOPIC` branch, push, complete the Copilot review loop, and require a merge-ready Greptile report covering the exact current head. Then set `PR_NUMBER` to the pull request number and queue it for main with `gh pr merge "${PR_NUMBER}" --repo donadiosolutions/lcm --auto --squash`. Same flow as any other docs change.

## Branch Strategy

```text
feature/docs branches → main (default, protected)
```

- **`main`** — Default branch. All PRs target main. Protected: PRs and the merge queue are required; no force push. Pushing a matching stable `vX.Y.Z` or beta `vX.Y.Z-beta.N` tag triggers draft-release creation.
- **Feature branches** — `feat/TOPIC`, `docs/TOPIC`, `fix/TOPIC`. Always branch from main and use an isolated worktree for each concurrent change.

Independent changes may be developed in parallel on isolated branches and worktrees, but the required merge queue serializes landings into `main`. Dependent work must wait for its upstream PR to merge, then fetch and rebase onto the new `main` before it is queued.

The merge queue uses squash merging and an `ALLGREEN` grouping strategy. It builds one entry at a time, with both the minimum and maximum merge-group size set to one, no minimum wait, and a 60-minute check-response timeout. Routine administrator bypasses are prohibited; the existing bypass is reserved for documented emergencies.

The required `external-admission` status separates pull-request admission from
merge-group validation for providers that do not report on synthetic queue
commits. Authenticated provider `check_run` events drive
`external-admission.yml`; pull-request lifecycle events do not start this
write-capable workflow. The handler audits every paginated PR file record,
including both `filename` and `previous_filename`, before selecting one of two
admission paths. The flattened file records must exactly match the pull
request's authoritative `changed_files` count, so GitHub's file-list cap or an
incomplete page cannot silently produce a coverage-neutral classification. A
change to executable `.ts`, `.tsx`, `.mts`, or `.cts` TypeScript under `bin/`,
`installer/`, or `src/`; trust-sensitive automation under `.github/actions/`,
`.github/codeql/`, `.github/workflows/`, or `.github/scripts/`; or key coverage/build configuration (`package.json`, the
lockfile, Vitest config, or TypeScript config) requires authenticated
`Greptile Review` and DCO successes on the PR's exact head SHA. A diff with none
of those paths requires authenticated DCO and the exact-head `ci` check from
the GitHub Actions app. CI is polled but does not trigger the evaluator because
it also reports on synthetic merge-group commits, which are handled by the
separate merge-group admission workflow. The neutral path resolves the check's Actions run
and requires a successful `pull_request` run of `.github/workflows/ci.yml` for
the same repository and head SHA.
Every authenticated provider event with a valid commit SHA replaces any stale
successful admission with `pending` before the PR-association lookup. This is
necessary because GitHub may omit closed unmerged PRs from a commit's PR
associations. The handler admits only one open, non-draft, main-targeting PR at
the exact event SHA and repeats that validation immediately before publishing
success, including fresh file classification, check evaluation, and neutral CI
run validation; a closed, draft, ineligible, unassociated, or ambiguous commit remains
pending. Commit-associated PRs, PR files, and check runs are all paginated and
flattened before evaluation. The executable admission policy is sparsely
checked out from the trusted workflow revision with persisted credentials
disabled; it is never loaded from the untrusted PR head.

Changes to the admission workflow or its policy are themselves trust-sensitive
and therefore require Greptile after this policy is active. The PR that first
introduces this policy cannot use code that is not yet present on the default
branch to admit itself. A maintainer must use the documented one-time bootstrap
or emergency bypass for that rollout, inspect the exact head and successful CI
and DCO results manually, and then return to the normal no-bypass flow.

After PR-head admission, the separate
`external-admission-merge-group.yml` workflow runs a permissionless Actions
check named `external-admission` on each synthetic `merge_group` commit. It does
not publish a commit status. This exception applies only to those two external
providers, which cannot report on that commit: CI, both default CodeQL
analyses, the security-extended CodeQL analysis, and both Socket checks still
run against the synthetic commit before it may merge.

Greptile is the authenticated review provider for coverable or trust-sensitive
diffs and must report success on the exact PR head before external admission
succeeds. CodeRabbit reports remain informational and best-effort and are not
encoded as an admission requirement.

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
| `external-admission.yml`             | Authenticated Greptile and DCO check runs                                              | Require Greptile+DCO for sensitive diffs or poll trusted CI+DCO for neutral diffs        |
| `external-admission-merge-group.yml` | Merge groups (`checks_requested`)                                                    | Run the required `external-admission` Actions check on the synthetic merge-group commit |
| `codeql.yml`                         | Push to main + PRs targeting main + merge groups (`checks_requested`)                | Required CodeQL analysis and SARIF upload                                               |
| `codeql-extended.yml`                | Scheduled + manual dispatch + PRs targeting main + merge groups (`checks_requested`) | Required security-extended CodeQL analysis and SARIF upload                             |
| `version-pr.yml`                     | Push to main + manual `beta`/`stable` dispatch                                      | Auto-create version PRs and enter or exit Changesets beta mode                          |
| `publish.yml`                        | Stable/beta tag pushes + GitHub release publication                                  | Create draft releases from tags; publish npm only after manual draft publication        |

The CI workflow keeps coverage reporting in separate read-only jobs that check
out `github.repository` at the workflow's `github.sha` with credentials disabled,
consume the fixed test artifact, and never execute repository code. This matches
the tree that produced the artifact, including the synthetic merge commit used by
pull-request runs, while `override_pr` associates the uploads with the PR. The
trusted job has OIDC permission and handles pushes and same-repository PRs,
including Dependabot PRs. A mutually exclusive fork-PR job omits OIDC permission
and uses Codecov's tokenless upload path. Both reporting jobs are skipped for
`merge_group`; the synthetic commit runs the full coverage suite in CI while its
separate merge-group workflow supplies the required `external-admission` check.

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
| PR review               | Greptile report on the exact head; CodeRabbit is informational |

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
7. Once the Copilot loop is complete (max 3 rounds — see Review Loop) and Greptile reports the exact current head as merge-ready, set `PR_NUMBER` to the pull request number and queue it with `gh pr merge "${PR_NUMBER}" --repo donadiosolutions/lcm --auto --squash`
8. Wait for the queued PR to land before starting implementation. Allow up to 65 minutes for GitHub to admit the PR and then 65 minutes for each position in the serialized queue: a PR entering at position 1 gets 65 minutes, while a PR entering at position N gets `N * 65` minutes so every entry ahead can consume the queue's 60-minute check timeout without taking time from this PR. Both waits are finite and fail with check diagnostics if GitHub never admits, removes, or rejects the still-open PR:

   ```bash
   PR_NUMBER=123

   show_pr_checks() {
     local pr_number=$1
     gh pr checks "$pr_number" --repo donadiosolutions/lcm >&2 || true
   }

   show_merge_group_checks() {
     local merge_group_sha=$1

     if [[ -z "$merge_group_sha" ]]; then
       echo "No synthetic merge-group SHA was observed for this queue attempt." >&2
       return
     fi

     echo "Check runs for synthetic merge-group commit $merge_group_sha:" >&2
     gh api \
       -H 'Accept: application/vnd.github+json' \
       "repos/donadiosolutions/lcm/commits/${merge_group_sha}/check-runs?per_page=100" \
       --jq '.check_runs[] |
         [.name, "status=" + .status, "conclusion=" + (.conclusion // "pending"),
          "app=" + (.app.slug // "unknown"), (.details_url // "no-details-url")] |
         @tsv' >&2 || true
   }

   show_queue_diagnostics() {
     local pr_number=$1
     local merge_group_sha=$2
     show_pr_checks "$pr_number"
     show_merge_group_checks "$merge_group_sha"
   }

   pr_is_merged() {
     local pr_number=$1
     [[ $(gh pr view "$pr_number" --repo donadiosolutions/lcm --json state --jq .state 2>/dev/null) == MERGED ]]
   }

   query_merge_queue_entry() {
     local pr_number=$1
     gh api graphql \
       -f query='query($owner: String!, $name: String!, $number: Int!) {
         repository(owner: $owner, name: $name) {
           pullRequest(number: $number) {
             mergeQueueEntry { position state headCommit { oid } }
           }
         }
       }' \
       -f owner=donadiosolutions \
       -f name=lcm \
       -F number="$pr_number" \
       --jq '.data.repository.pullRequest.mergeQueueEntry |
         if . == null then ""
         else [.position, .state, .headCommit.oid] | @tsv
         end'
   }

   wait_for_queued_pr() {
     local pr_number=$1
     local admission_deadline=$((SECONDS + 65 * 60))
     local current_merge_group_sha current_queue_position deadline merge_group_sha=""
     local queue_entry queue_position queue_state state

     # mergeQueueEntry can be temporarily absent while auto-merge waits for
     # required checks or GitHub propagates the newly queued entry.
     while :; do
       state=$(gh pr view "$pr_number" --repo donadiosolutions/lcm --json state --jq .state)
       case "$state" in
         MERGED) return ;;
         OPEN) ;;
         *)
           echo "PR #$pr_number entered unexpected state before queue admission: $state" >&2
           show_queue_diagnostics "$pr_number" "$merge_group_sha"
           return 1
           ;;
       esac

       if ! queue_entry=$(query_merge_queue_entry "$pr_number"); then
         if pr_is_merged "$pr_number"; then return; fi
         echo "Could not query the merge-queue entry for PR #$pr_number." >&2
         show_queue_diagnostics "$pr_number" "$merge_group_sha"
         return 1
       fi
       IFS=$'\t' read -r queue_position queue_state current_merge_group_sha <<<"$queue_entry"
       if [[ -n "$current_merge_group_sha" ]]; then
         merge_group_sha=$current_merge_group_sha
       fi

       if [[ "$queue_state" == UNMERGEABLE ]]; then
         if pr_is_merged "$pr_number"; then return; fi
         echo "PR #$pr_number became unmergeable before queue admission completed; inspect failed checks and requeue it:" >&2
         show_queue_diagnostics "$pr_number" "$merge_group_sha"
         return 1
       fi

       if [[ "$queue_position" =~ ^[1-9][0-9]*$ && -n "$merge_group_sha" ]]; then
         break
       fi

       if ((SECONDS >= admission_deadline)); then
         if pr_is_merged "$pr_number"; then return; fi
         echo "PR #$pr_number did not enter the merge queue within 65 minutes; inspect required checks and auto-merge state:" >&2
         show_queue_diagnostics "$pr_number" "$merge_group_sha"
         return 1
       fi
       sleep 15
     done

     deadline=$((SECONDS + queue_position * 65 * 60))
     echo "PR #$pr_number entered the merge queue at position $queue_position; waiting up to $((queue_position * 65)) minutes." >&2

     while :; do
       state=$(gh pr view "$pr_number" --repo donadiosolutions/lcm --json state --jq .state)
       case "$state" in
         MERGED) return ;;
         OPEN)
           ;;
         *)
           echo "PR #$pr_number entered unexpected state while queued: $state" >&2
           show_queue_diagnostics "$pr_number" "$merge_group_sha"
           return 1
           ;;
       esac

       if ! queue_entry=$(query_merge_queue_entry "$pr_number"); then
         if pr_is_merged "$pr_number"; then return; fi
         echo "Could not query the merge-queue entry for PR #$pr_number." >&2
         show_queue_diagnostics "$pr_number" "$merge_group_sha"
         return 1
       fi
       IFS=$'\t' read -r current_queue_position queue_state current_merge_group_sha <<<"$queue_entry"
       if [[ -n "$current_merge_group_sha" ]]; then
         merge_group_sha=$current_merge_group_sha
       fi

       if [[ -z "$current_queue_position" ]]; then
         if pr_is_merged "$pr_number"; then return; fi
         echo "PR #$pr_number is still open but is no longer in the merge queue; inspect failed checks and requeue it:" >&2
         show_queue_diagnostics "$pr_number" "$merge_group_sha"
         return 1
       fi

       if [[ "$queue_state" == UNMERGEABLE ]]; then
         if pr_is_merged "$pr_number"; then return; fi
         echo "PR #$pr_number became unmergeable at queue position $current_queue_position; inspect failed checks and requeue it:" >&2
         show_queue_diagnostics "$pr_number" "$merge_group_sha"
         return 1
       fi

       if ((SECONDS >= deadline)); then
         if pr_is_merged "$pr_number"; then return; fi
         echo "PR #$pr_number did not merge within its position-$queue_position allowance of $((queue_position * 65)) minutes; inspect failed checks and requeue it:" >&2
         show_queue_diagnostics "$pr_number" "$merge_group_sha"
         return 1
       fi
       sleep 15
     done
   }

   wait_for_queued_pr "$PR_NUMBER"
   ```

## Phase 3: Implementation (Sonnet subagents)

1. **Sync first:** `git checkout main && git pull --ff-only origin main` to get latest (including merged specs)
2. Dispatch `model: sonnet` subagents with `isolation: worktree` for each task in the plan
3. **Independent tasks** → launch in parallel (e.g., PR A: delete files, PR D: add new module)
4. **Sequential tasks** → launch the dependent branch only after the upstream PR lands through the queue, then branch from the updated `main`. If a downstream branch already exists on the old upstream tip, enter its isolated worktree, set `OLD_UPSTREAM_TIP` to that commit, and replay only its downstream commits with `git fetch origin main && git rebase --onto origin/main "${OLD_UPSTREAM_TIP}"`. Omitting the branch argument rebases the already checked-out downstream branch without asking Git to check it out in another worktree.
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
4. Once the Copilot loop is complete and Greptile reports the exact current head as merge-ready, set `PR_NUMBER` to the pull request number and queue it with `gh pr merge "${PR_NUMBER}" --repo donadiosolutions/lcm --auto --squash`
5. Wait for the implementation PR to land by calling `wait_for_queued_pr "$PR_NUMBER"` from Phase 2 with the implementation PR number. Do not begin post-merge validation or dependent work until it reports `MERGED`.

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
5. **Max 3 rounds.** After round 3, stop the Copilot loop if only minor nits remain. Do not chase zero Copilot comments indefinitely; Greptile readiness on the exact current head is still required before merge.
6. Review is "clean" when: 0 new comments, or only context-specific nits that Copilot can't understand (e.g., Agent conventions)

### Common Pitfalls

- **Stale diff**: Always sync main before creating branches. If main has unpushed local commits, the PR diff includes unrelated code and Copilot reviews the wrong things.
- **@copilot in comments**: Opens a new PR instead of triggering review. Always use the reviewers API.
- **REST API 422 for Copilot bot**: The `requested_reviewers` REST endpoint rejects bot slugs. Use `gh pr edit --add-reviewer` instead.
- **Empty commits don't trigger Copilot**: Copilot only reviews on substantive diffs. Use `gh pr edit` re-request instead.
- **Code in docs PRs**: Cherry-pick only docs commits if the branch has mixed content. Set `CLEAN_BRANCH` to the new branch name and `DOCS_COMMIT_SHA` to the documentation commit, then use `git checkout -B "${CLEAN_BRANCH}" origin/main && git cherry-pick "${DOCS_COMMIT_SHA}"`.
- **Sequential PR chains**: Create PR B from updated `main` only after PR A lands. If PR B already contains commits based on PR A's old tip, enter PR B's isolated worktree, set `OLD_PR_A_TIP` to that commit, and replay only its own commits with `git fetch origin main && git rebase --onto origin/main "${OLD_PR_A_TIP}"`. Omit the branch argument so Git rebases the branch already checked out in that worktree instead of attempting a conflicting cross-worktree checkout.
