# Maintenance Release Provenance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close #569 by accepting release commits from an exact protected maintenance PR only when an exact ancestry-preserving forward-port merge proves that commit reached `main`.

**Architecture:** Remove the unsafe “one non-exact main association is enough” fallback. Direct-main releases require an exact merged PR and matching two-parent merge. Maintenance releases additionally require the target tag's exact `maintenance/MAJOR.MINOR.x` line and exactly one validated main forward-port merge whose second-parent ancestry contains the maintenance merge while its first parent does not.

**Tech Stack:** Node.js ESM, Git CLI, GitHub REST via Octokit, Node test runner, GitHub Actions publish workflow.

## Global Constraints

- Start `fix/maintenance-release-provenance` from current `origin/main` after earlier PRs merge.
- Add no dependency; use existing Git, Octokit, and release-tag parser.
- Every accepted PR must be merged, exact-SHA associated, in `donadiosolutions/lcm`, and represented by a genuine two-parent merge matching PR base/head SHAs.
- Maintenance base is derived from `parseReleaseTag(targetTag)` as `maintenance/${major}.${minor}.x`; never trust title/body or an arbitrary branch name.
- Preserve direct-main behavior while rejecting ambiguous, squash, rebase, wrong-line, wrong-parent-direction, and missing-forward-port topologies.
- Return the maintenance PR for release notes; use the forward-port PR only as provenance evidence.
- Use DCO `--signoff`, merge commits only, no dependency/Codecov changes, and no Changeset because this changes internal release automation.

---

### Task 1: Remove non-exact direct-main association fallback

**Files:**
- Modify: `.github/scripts/release-policy.mjs:204`
- Modify: `.github/scripts/release-policy.test.mjs:346`

**Interfaces:**
- Consumes: release commit SHAs and GitHub commit-associated PR lists.
- Produces: exact direct-main PR candidates only.

- [ ] **Step 1: Add failing exactness tests**

Keep the existing exact-main success fixture. Add:

```js
test("rejects a sole non-exact main PR association", () => {
  const commit = "c".repeat(40);
  const associations = new Map([[commit, [{
    number: 10,
    merged_at: "2026-08-01T00:00:00Z",
    merge_commit_sha: "d".repeat(40),
    base: { ref: "main" },
  }]]]);
  assert.throws(
    () => associateCommitsWithPullRequests([commit], associations),
    /no exact merged main PR/u,
  );
});
```

Add a second test where two PRs both claim the exact merge SHA; require an ambiguity error naming both PR numbers.

- [ ] **Step 2: Verify RED**

```bash
node --test \
  --test-name-pattern="non-exact main|ambiguous exact" \
  .github/scripts/release-policy.test.mjs
```

Expected: the sole non-exact fixture is currently accepted.

- [ ] **Step 3: Make association exact and unique**

Rewrite `associateCommitsWithPullRequests` so each commit:

```js
const exact = candidates.filter((pr) =>
  pr.merged_at
  && pr.base?.ref === "main"
  && pr.merge_commit_sha?.toLowerCase() === sha);
if (exact.length === 1) selected.push(exact[0]);
else if (exact.length === 0) missing.push(commit);
else throw new Error(`Release commit ${commit} has ambiguous exact merged main PR associations`);
```

Delete the `candidates.length === 1` fallback entirely. Update the final missing error to say `no exact merged main PR`.

- [ ] **Step 4: Verify GREEN and commit**

```bash
node --test .github/scripts/release-policy.test.mjs
git add .github/scripts/release-policy.mjs .github/scripts/release-policy.test.mjs
git commit --signoff -m "fix(release): require exact main PR associations"
```

### Task 2: Validate merge commits against PR parent identity

**Files:**
- Modify: `.github/scripts/release-policy.mjs`
- Modify: `.github/scripts/release-policy.test.mjs`

**Interfaces:**
- Consumes: commit SHA, PR `merge_commit_sha`, `base.sha`, `head.sha`, and `git show -s --format=%P`.
- Produces: `assertExactPullRequestMerge(pr, commit, { runGit, cwd, requiredBase })`.

- [ ] **Step 1: Add failing parent-shape tests**

Table-drive:

- exact two parents matching `base.sha` then `head.sha`: pass;
- one parent: reject squash/rebase;
- three parents: reject octopus merge;
- reversed parents: reject;
- mismatched base SHA, head SHA, merge SHA, base ref, or unmerged PR: reject.

The fake `runGit` returns a literal parent string for `show -s --format=%P <sha>`.

- [ ] **Step 2: Verify RED**

```bash
node --test \
  --test-name-pattern="pull request merge parent" \
  .github/scripts/release-policy.test.mjs
```

Expected: helper import/export failure.

- [ ] **Step 3: Implement the exact merge validator**

```js
export function assertExactPullRequestMerge(
  pr,
  commit,
  { runGit = defaultRunGit, cwd = process.cwd(), requiredBase },
) {
  const sha = commit.toLowerCase();
  if (!pr?.merged_at || pr.base?.ref !== requiredBase || pr.merge_commit_sha?.toLowerCase() !== sha) {
    throw new Error(`Pull request #${pr?.number ?? "unknown"} is not the exact ${requiredBase} merge for ${commit}`);
  }
  const parents = runGit(["show", "-s", "--format=%P", commit], cwd)
    .split(/\s+/u).filter(Boolean).map((value) => value.toLowerCase());
  if (
    parents.length !== 2
    || parents[0] !== pr.base?.sha?.toLowerCase()
    || parents[1] !== pr.head?.sha?.toLowerCase()
  ) throw new Error(`Pull request #${pr.number} merge parent identity is invalid`);
  return Object.freeze({ pr, parents: Object.freeze(parents) });
}
```

Validate each direct-main selection with this helper inside `collectReleasePullRequests` after fetching full PR details.

- [ ] **Step 4: Verify and commit**

```bash
node --test .github/scripts/release-policy.test.mjs
git add .github/scripts/release-policy.mjs .github/scripts/release-policy.test.mjs
git commit --signoff -m "fix(release): authenticate merge parent identity"
```

### Task 3: Resolve maintenance commits through exact main forward ports

**Files:**
- Modify: `.github/scripts/release-policy.mjs:241`
- Modify: `.github/scripts/release-policy.test.mjs:432`

**Interfaces:**
- Consumes: `targetTag`, release commit, exact maintenance PR, first-parent main merge candidates, exact forward-port PRs, and Git ancestry queries.
- Produces: `resolveMaintenanceReleasePullRequest(...) -> maintenance PR`.

- [ ] **Step 1: Add the real #569 topology fixture**

Use literal SHAs:

```js
const C = "1a104b5461d0a4cc6514b9ca2fb894658f8c30a4";
const B = "f6927a0cbded8b96eb9244a23c1bf6b66c43a262";
const H = "7e73785c0756bdf2ced7e948bfcb8ad4f4b30461";
const F = "22ef3a6b2d1d4a916a43fbd74fa5f50efefd2f72";
```

PR #566 fixture: merged exact `C`, base `maintenance/1.4.x`, base SHA `4bd87d59...`, head SHA `565f0d8f...`.

PR #568 fixture: merged exact `F`, base `main`, base SHA `B`, head SHA `H`.

Fake Git behavior:

- release range returns `C`;
- main merge list returns `F`;
- `show C` returns #566 base/head parents;
- `show F` returns `B H`;
- `merge-base --is-ancestor C H` succeeds;
- `merge-base --is-ancestor C B` fails.

Expect release entries to contain #566 exactly once and not #568.

- [ ] **Step 2: Add failing rejection matrix**

Add separate tests for:

- exact maintenance PR but no forward port;
- wrong maintenance line for target `v1.4.3`;
- unmerged/draft/wrong-repository maintenance PR;
- one-parent, three-parent, reversed, or mismatched forward-port merge;
- maintenance commit reachable through the forward port's first parent;
- maintenance commit absent from its second parent;
- two valid forward ports;
- non-exact/multiple associated PRs for either merge;
- GitHub lookup or Git command failure.

- [ ] **Step 3: Verify RED**

```bash
node --test \
  --test-name-pattern="maintenance release provenance" \
  .github/scripts/release-policy.test.mjs
```

Expected: valid #569 fixture fails because current policy filters out maintenance PRs.

- [ ] **Step 4: Add injectable ancestry helper**

```js
function defaultIsAncestor(ancestor, descendant, cwd) {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
      cwd,
      stdio: "ignore",
    });
    return true;
  } catch (error) {
    if (error?.status === 1) return false;
    throw error;
  }
}
```

Extend `collectReleasePullRequests` inputs:

```js
mainRef = "origin/main",
isAncestor = defaultIsAncestor,
```

- [ ] **Step 5: Implement maintenance resolution**

Replace `collectReleasePullRequests`' one-shot
`associateCommitsWithPullRequests(commits, associations)` call with a
per-commit resolver. For each release commit, first select exact-main
candidates from its associated PRs: one is validated and returned, more than
one is rejected as ambiguous, and zero enters maintenance resolution. Keep the
exported `associateCommitsWithPullRequests` as the strict direct-main helper
for its existing callers/tests; do not let its missing-main error run before
the maintenance fallback.

For a release commit with zero exact-main candidates:

1. Parse `targetTag`; derive `maintenance/${major}.${minor}.x`.
2. Require exactly one associated merged PR whose merge SHA equals the release commit, base ref equals that maintenance branch, and base repository full name equals `${owner}/${repo}`.
3. Fetch its full PR and validate exact two-parent identity.
4. Enumerate `git rev-list --first-parent --merges --reverse ${baseTag}..${mainRef}`.
5. For each candidate, require two parents, `isAncestor(commit, secondParent, cwd) === true`, and `isAncestor(commit, firstParent, cwd) === false`.
6. Fetch associated/full PR data for each remaining candidate and require exactly one exact merged `main` PR with matching parent identity and base repository full name `${owner}/${repo}`.
7. Reject zero or multiple valid forward ports; otherwise return the maintenance PR.

Do not use tree equality, PR title/body, or a sole non-exact association as authority.

- [ ] **Step 6: Verify GREEN and commit**

```bash
node --test .github/scripts/release-policy.test.mjs
git add .github/scripts/release-policy.mjs .github/scripts/release-policy.test.mjs
git commit --signoff -m "fix(release): accept proven maintenance ancestry"
```

### Task 4: Document the exact release topology

**Files:**
- Modify: `docs/releasing.md`
- Modify: `RELEASING.md`
- Verify: `.github/workflows/publish.yml`
- Modify only if caller input changes: `test/release-workflows.test.ts`

**Interfaces:**
- Consumes: Final provenance algorithm.
- Produces: Maintainer instructions for maintenance release and forward-port merges.

- [ ] **Step 1: Update both release guides**

Document that:

- maintenance release commits must be exact merge commits from `maintenance/MAJOR.MINOR.x`;
- the maintenance merge must reach main through exactly one ancestry-preserving merge PR;
- the maintenance commit must enter through the forward port's second-parent history, not already exist on its first parent;
- squash/rebase/cherry-pick forward ports are invalid;
- release notes use the maintenance PR, while the forward-port PR is provenance only.

- [ ] **Step 2: Keep the workflow caller unchanged unless explicit `mainRef` is necessary**

Because `collectReleasePullRequests` defaults `mainRef` to `origin/main`, prefer no `publish.yml` change. If implementation needs explicit input, add `mainRef: "origin/main"` to the existing call and update `test/release-workflows.test.ts` to assert it.

- [ ] **Step 3: Verify and commit**

```bash
node --test .github/scripts/release-policy.test.mjs
npm exec -- vitest run test/release-workflows.test.ts
git diff --check
git add docs/releasing.md RELEASING.md
git diff --quiet -- .github/workflows/publish.yml test/release-workflows.test.ts || \
  git add .github/workflows/publish.yml test/release-workflows.test.ts
git commit --signoff -m "docs(release): explain maintenance provenance"
```

### Task 5: Verify, review, publish, and close #569

**Files:**
- Review all Task 1-4 files.

**Interfaces:**
- Consumes: Complete provenance branch.
- Produces: One merged PR closing #569.

- [ ] **Step 1: Run focused and complete gates**

```bash
node --test .github/scripts/release-policy.test.mjs
node --test .github/scripts/*.test.mjs
npm exec -- vitest run test/release-workflows.test.ts
npm run test:ci
npm run lint
npm run typecheck
npm run build
git diff --check
```

Expected: all pass; complete coverage remains 100% in every dimension.

- [ ] **Step 2: Run MoM review**

Dispatch max-effort GLM and Kimi adversarial reviewers with emphasis on ancestry confusion, ambiguous association, wrong-parent acceptance, and Git/GitHub failure handling. Give both reports and the full implementation to medium-effort Opus. Fix all Critical/Important findings via max-effort Luna and rerun Step 1.

- [ ] **Step 3: Open the PR**

Use title `Recognize proven maintenance release ancestry`. Include the exact #566/#568 graph, direct-main preservation, fail-closed rejection matrix, docs/no-Changeset decision, verification, and `Closes #569`.

- [ ] **Step 4: Complete protected checks and merge**

Resolve every actionable review thread with `Fixed in [commit hash].`, require all exact-head checks, then:

```bash
gh pr merge "$PR_NUMBER" --repo donadiosolutions/lcm --merge --delete-branch
git fetch origin --prune
gh pr view "$PR_NUMBER" --repo donadiosolutions/lcm --json state,mergeCommit
```

Expected: state `MERGED` and merge commit reachable from `origin/main`.
