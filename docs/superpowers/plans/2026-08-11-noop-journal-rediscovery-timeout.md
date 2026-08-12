# No-op Journal Rediscovery Timeout Plan (#610)

**Goal:** Make the completed no-op journal source-rediscovery regression
reliable under full V8 coverage load using one test-local deadline.

**Initial evidence:** A fresh `npm run test:ci` at
`81b869bc73fce53fbac07427a9f5a25c4cbae0b9` timed out
`rediscovers mapped sources after a completed no-op journal` at 5.352 seconds
against Vitest's inherited 5,000 ms deadline. The #608/#609 tests passed in
that same run. Root cause remains provisional until the unchanged focused
baseline and deterministic one-millisecond RED below establish a
load-sensitive missing local contract.

**Scope:** Extend `fix/601-605-test-determinism` in
`/home/bcdonadio/.codex/worktrees/b6b7/lcm-issues-601-605`. Modify only
`test/worktree-reconciliation.test.ts` plus the reviewed design and this
plan. Add no dependency, production code, fixture/assertion change, global
timeout, retry, skip, exclusion, Changeset, user documentation, or Codecov
change.

### Setup gate

```bash
set -euo pipefail
EXPECTED_EXISTING_TIP=81b869bc73fce53fbac07427a9f5a25c4cbae0b9
EXISTING_TEST_BRANCH_TIP=$(git rev-parse --verify 'refs/heads/fix/601-605-test-determinism^{commit}')
REVIEWED_PLAN_HEAD=$(git rev-parse --verify 'refs/lcm/reviewed-plans/issue-610^{commit}')
test "$REVIEWED_PLAN_HEAD" = "$(git rev-parse --verify 'refs/lcm/planning/open-bugs-2026-08-11^{commit}')"
test "$(git rev-parse --show-toplevel)" = "/home/bcdonadio/.codex/worktrees/b6b7/lcm-issues-601-605"
test "$(git branch --show-current)" = "fix/601-605-test-determinism"
test "$(git rev-parse HEAD)" = "$EXISTING_TEST_BRANCH_TIP"
test "$EXISTING_TEST_BRANCH_TIP" = "$EXPECTED_EXISTING_TIP"
test -z "$(git status --porcelain)"
git merge-base --is-ancestor 5d408ffdeb5e7fbefc68940d07d43a8bf6e6c7f9 "$EXISTING_TEST_BRANCH_TIP"
git merge-base --is-ancestor 81b869bc73fce53fbac07427a9f5a25c4cbae0b9 "$EXISTING_TEST_BRANCH_TIP"
git verify-commit "$EXPECTED_EXISTING_TIP"
git log -1 --format=%B "$EXPECTED_EXISTING_TIP" | rg -q '^Signed-off-by: Bernardo Donadio <bcdonadio@bcdonadio\.com>$'
git update-ref refs/lcm/extension-bases/issue-610 "$EXISTING_TEST_BRANCH_TIP"
test "$(git rev-parse --verify 'refs/lcm/extension-bases/issue-610^{commit}')" = "$EXPECTED_EXISTING_TIP"
git merge --no-ff -S --signoff -m "docs: merge no-op journal timeout plan" "$REVIEWED_PLAN_HEAD"
git merge-base --is-ancestor "$EXISTING_TEST_BRANCH_TIP" HEAD
git merge-base --is-ancestor "$REVIEWED_PLAN_HEAD" HEAD
test "$(git rev-list --parents -n 1 HEAD | wc -w)" -eq 3
git verify-commit HEAD
git log -1 --format=%B HEAD | rg -q '^Signed-off-by: Bernardo Donadio <bcdonadio@bcdonadio\.com>$'
git update-ref refs/lcm/merge-checkpoints/issue-610 HEAD
test -z "$(git status --porcelain)"
```

Stop without editing the test if any command fails.

### Task 1: Add the regression-owned deadline

- [ ] **Step 1: Run the unchanged focused baseline**

```bash
npx vitest run test/worktree-reconciliation.test.ts -t "rediscovers mapped sources after a completed no-op journal" --reporter=verbose
```

Require the selected unchanged test to pass and record its elapsed time.

- [ ] **Step 2: Prove inherited-deadline RED**

```bash
npx vitest run test/worktree-reconciliation.test.ts -t "rediscovers mapped sources after a completed no-op journal" --testTimeout=1 --reporter=verbose
```

Before editing, require a non-zero exit caused by `Test timed out in 1ms`.

- [ ] **Step 3: Add the smallest local contract**

Add
`FULL_SUITE_NOOP_JOURNAL_REDISCOVERY_TEST_TIMEOUT_MS = 15_000` beside the
existing full-suite reconciliation constants. Pass it as the final
`it(...)` argument to exactly the selected test. Do not change the body,
fixtures, assertions, name, or neighbors.

- [ ] **Step 4: Prove identical-command GREEN**

Run the Step 2 command verbatim and require the test to pass.

- [ ] **Step 5: Run twenty isolated processes**

```bash
for run in $(seq 1 20); do npx vitest run test/worktree-reconciliation.test.ts -t "rediscovers mapped sources after a completed no-op journal" --reporter=dot || exit 1; done
```

- [ ] **Step 6: Commit**

```bash
git add test/worktree-reconciliation.test.ts
git commit -S --signoff -m "test: bound no-op journal rediscovery"
```

### Task 2: Verify and audit

- [ ] Run
  `npx vitest run test/batch-compact.test.ts test/worktree-reconciliation.test.ts`.
- [ ] Run `npm run build`, `npm run typecheck`, `npm run lint`, and
  `git diff --check`.
- [ ] With no duplicate runner in this worktree, run one fresh `npm test`
  followed by one fresh `npm run test:ci`.
- [ ] Require 100% statements, branches, functions, and lines for the complete
  collected production scope.
- [ ] File any new unrelated bug immediately and stop before scope expansion.

```bash
set -euo pipefail
IMPLEMENTATION_BASE=$(git rev-parse --verify 'refs/lcm/implementation-bases/issues-601-605-test-determinism^{commit}')
EXTENSION_BASE=$(git rev-parse --verify 'refs/lcm/extension-bases/issue-610^{commit}')
REVIEWED_PLAN_HEAD=$(git rev-parse --verify 'refs/lcm/reviewed-plans/issue-610^{commit}')
MERGE_CHECKPOINT=$(git rev-parse --verify 'refs/lcm/merge-checkpoints/issue-610^{commit}')
test "$(git branch --show-current)" = "fix/601-605-test-determinism"
test "$EXTENSION_BASE" = 81b869bc73fce53fbac07427a9f5a25c4cbae0b9
test "$REVIEWED_PLAN_HEAD" = "$(git rev-parse --verify 'refs/lcm/planning/open-bugs-2026-08-11^{commit}')"
git merge-base --is-ancestor "$IMPLEMENTATION_BASE" HEAD
git merge-base --is-ancestor "$EXTENSION_BASE" HEAD
git merge-base --is-ancestor "$REVIEWED_PLAN_HEAD" HEAD
git merge-base --is-ancestor "$MERGE_CHECKPOINT" HEAD
test "$(git rev-list --parents -n 1 "$MERGE_CHECKPOINT" | wc -w)" -eq 3
git verify-commit "$MERGE_CHECKPOINT"
git diff --check "$IMPLEMENTATION_BASE"...HEAD
git diff --check "$EXTENSION_BASE"...HEAD
FULL_ACTUAL=$(git diff --name-only "$IMPLEMENTATION_BASE"...HEAD | sort)
FULL_EXPECTED=$(printf '%s\n' docs/superpowers/plans/2026-08-11-additional-reconciliation-timeouts.md docs/superpowers/plans/2026-08-11-noop-journal-rediscovery-timeout.md docs/superpowers/plans/2026-08-11-snapshot-validation-test-determinism.md docs/superpowers/specs/2026-08-11-open-bug-remediation-design.md test/batch-compact.test.ts test/worktree-reconciliation.test.ts | sort)
test "$FULL_ACTUAL" = "$FULL_EXPECTED"
EXTENSION_ACTUAL=$(git diff --name-only "$EXTENSION_BASE"...HEAD | sort)
EXTENSION_EXPECTED=$(printf '%s\n' docs/superpowers/plans/2026-08-11-noop-journal-rediscovery-timeout.md docs/superpowers/specs/2026-08-11-open-bug-remediation-design.md test/worktree-reconciliation.test.ts | sort)
test "$EXTENSION_ACTUAL" = "$EXTENSION_EXPECTED"
test -z "$(git status --porcelain)"
for commit in $(git rev-list "$IMPLEMENTATION_BASE"..HEAD); do git verify-commit "$commit"; git log -1 --format=%B "$commit" | rg -q '^Signed-off-by: Bernardo Donadio <bcdonadio@bcdonadio\.com>$'; done
```

Require every command to pass. Preserve the original 5.352-second failure,
focused baseline, exact RED/GREEN, twenty-process result, complete 100%
coverage table, exact head, changed files, and signature/DCO audit for the
whole-branch GLM/Grok review and Opus second pass.
