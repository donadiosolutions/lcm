# Additional Reconciliation Timeout Plan (#608, #609)

**Goal:** Extend the existing test-determinism branch with local deadlines for
the newly discovered snapshot-migration and instruction-cache divergence
tests, without changing production behavior, assertions, fixtures, or global
test configuration.

**Root cause:** Three snapshot-migration reconciliation tests timed out in one
fresh canonical coverage run and then passed focused in 1.393, 1.967, and
2.536 seconds. In the next fresh coverage run, the instruction-cache divergence
test timed out at 5.385 seconds and then passed focused in 1.229 seconds. All
four tests perform real filesystem/SQLite reconciliation and inherit Vitest's
5,000 ms deadline. The changing failure set and immediate focused passes prove
load-sensitive test-harness deadlines rather than deterministic production
failures.

**Scope:** Extend `fix/601-605-test-determinism` in its dedicated worktree.
The historical branch name is retained because #608/#609 were discovered
during its canonical verification. Modify only
`test/worktree-reconciliation.test.ts` plus the reviewed planning documents.
Add no dependency, production code, global timeout, retry, skip, exclusion,
user documentation, Changeset, or Codecov change.

---

### Setup gate: Attach the reviewed #608/#609 plan

Run every command in
`/home/bcdonadio/.codex/worktrees/b6b7/lcm-issues-601-605`:

```bash
EXPECTED_EXISTING_TIP=280b51f4a8c2581734087bf465645675eb7d930b
EXISTING_TEST_BRANCH_TIP=$(
  git rev-parse --verify 'refs/heads/fix/601-605-test-determinism^{commit}'
)
REVIEWED_PLAN_HEAD=$(
  git rev-parse --verify 'refs/lcm/planning/open-bugs-2026-08-11^{commit}'
)
test "$(git rev-parse --show-toplevel)" = "/home/bcdonadio/.codex/worktrees/b6b7/lcm-issues-601-605"
test "$(git branch --show-current)" = "fix/601-605-test-determinism"
test "$(git rev-parse HEAD)" = "$EXISTING_TEST_BRANCH_TIP"
test "$EXISTING_TEST_BRANCH_TIP" = "$EXPECTED_EXISTING_TIP"
git merge-base --is-ancestor 1f221aa204c61600eba3751080cb17ec7f6f23f7 "$EXISTING_TEST_BRANCH_TIP"
git merge-base --is-ancestor 280b51f4a8c2581734087bf465645675eb7d930b "$EXISTING_TEST_BRANCH_TIP"
git update-ref refs/lcm/extension-bases/issues-608-609 "$EXISTING_TEST_BRANCH_TIP"
```

Require a clean worktree and valid GPG/DCO evidence for the existing history.
Then attach the separately reviewed planning history:

```bash
git merge --no-ff -S --signoff \
  -m "docs: merge additional timeout plan" \
  "$REVIEWED_PLAN_HEAD"
git merge-base --is-ancestor "$EXISTING_TEST_BRANCH_TIP" HEAD
git merge-base --is-ancestor "$REVIEWED_PLAN_HEAD" HEAD
git status --short
```

Stop without editing tests if any identity, SHA, ancestry, signature, merge, or
cleanliness check differs.

### Task 1: Bound the snapshot-migration scenarios (#608)

The exact tests are:

- `keeps dry-run read-only while previewing legacy metadata backfill`;
- `normalizes a legacy main snapshot with WAL state without migrating source evidence`;
- `keeps target and legacy evidence clean when snapshot migration fails, then retries`.

- [ ] **Step 1: Focused unchanged baseline**

```bash
npx vitest run test/worktree-reconciliation.test.ts \
  -t "keeps dry-run read-only while previewing legacy metadata backfill|normalizes a legacy main snapshot with WAL state without migrating source evidence|keeps target and legacy evidence clean when snapshot migration fails, then retries" \
  --reporter=verbose
```

Require all three unchanged tests to pass and record elapsed times.

- [ ] **Step 2: Deterministic inherited-deadline RED**

Before editing, rerun the exact command with `--testTimeout=1`. Require a
non-zero exit caused by `Test timed out in 1ms`.

- [ ] **Step 3: Add one local contract**

Add
`FULL_SUITE_SNAPSHOT_MIGRATION_TEST_TIMEOUT_MS = 15_000` beside the existing
full-suite reconciliation constants. Pass it as the final `it(...)` argument
to exactly the three tests above. Do not alter their callbacks, assertions,
fixtures, names, or neighbors.

- [ ] **Step 4: Identical-command GREEN**

Rerun the exact one-millisecond RED command. Require all three tests to pass.

- [ ] **Step 5: Twenty separate processes**

```bash
for run in $(seq 1 20); do
  npx vitest run test/worktree-reconciliation.test.ts \
    -t "keeps dry-run read-only while previewing legacy metadata backfill|normalizes a legacy main snapshot with WAL state without migrating source evidence|keeps target and legacy evidence clean when snapshot migration fails, then retries" \
    --reporter=dot || exit 1
done
```

- [ ] **Step 6: Commit**

```bash
git add test/worktree-reconciliation.test.ts
git commit -S --signoff -m "test: bound snapshot migration reconciliation"
```

### Task 2: Bound instruction-cache divergence (#609)

- [ ] **Step 1: Focused unchanged baseline**

```bash
npx vitest run test/worktree-reconciliation.test.ts \
  -t "fails closed on instruction-cache divergence" --reporter=verbose
```

Require the unchanged test to pass and record elapsed time.

- [ ] **Step 2: Deterministic inherited-deadline RED**

Before editing, rerun the exact command with `--testTimeout=1`. Require a
non-zero exit caused by `Test timed out in 1ms`.

- [ ] **Step 3: Add one local contract**

Add
`FULL_SUITE_INSTRUCTION_CACHE_DIVERGENCE_TEST_TIMEOUT_MS = 15_000` beside the
other full-suite reconciliation constants. Pass it as the final `it(...)`
argument to exactly the selected test, without changing its body or neighbors.

- [ ] **Step 4: Identical-command GREEN**

Rerun the exact one-millisecond RED command. Require the test to pass.

- [ ] **Step 5: Twenty separate processes**

```bash
for run in $(seq 1 20); do
  npx vitest run test/worktree-reconciliation.test.ts \
    -t "fails closed on instruction-cache divergence" --reporter=dot || exit 1
done
```

- [ ] **Step 6: Commit**

```bash
git add test/worktree-reconciliation.test.ts
git commit -S --signoff -m "test: bound instruction-cache divergence"
```

### Task 3: Verify and audit the complete branch

- [ ] Run `npx vitest run test/batch-compact.test.ts
  test/worktree-reconciliation.test.ts`.
- [ ] Run `npm run build`, `npm run typecheck`, `npm run lint`, and
  `git diff --check`.
- [ ] With no duplicate runner in this worktree, run one fresh `npm test`
  followed by one fresh `npm run test:ci`.
- [ ] Require 100% statements, branches, functions, and lines across the full
  collected production scope.
- [ ] File any newly observed unrelated bug immediately before continuing.

Final audit:

```bash
IMPLEMENTATION_BASE=$(
  git rev-parse --verify \
    'refs/lcm/implementation-bases/issues-601-605-test-determinism^{commit}'
)
EXTENSION_BASE=$(
  git rev-parse --verify \
    'refs/lcm/extension-bases/issues-608-609^{commit}'
)
REVIEWED_PLAN_HEAD=$(
  git rev-parse --verify 'refs/lcm/planning/open-bugs-2026-08-11^{commit}'
)
test "$(git branch --show-current)" = "fix/601-605-test-determinism"
git merge-base --is-ancestor "$IMPLEMENTATION_BASE" HEAD
git merge-base --is-ancestor "$EXTENSION_BASE" HEAD
git merge-base --is-ancestor "$REVIEWED_PLAN_HEAD" HEAD
git diff --check "$IMPLEMENTATION_BASE"...HEAD
git diff --name-only "$IMPLEMENTATION_BASE"...HEAD
git diff --check "$EXTENSION_BASE"...HEAD
git diff --name-only "$EXTENSION_BASE"...HEAD
git status --short
git log --show-signature --format=fuller "$IMPLEMENTATION_BASE"..HEAD
```

Require only the two test files and reviewed planning documents in the complete
branch diff; only `test/worktree-reconciliation.test.ts` and the new planning
documents in the extension diff; a clean worktree; valid GPG signatures and
DCO trailers; and both implementation/planning histories as ancestors.

### Task 4: Preserve review evidence

Record both original coverage failures, focused baselines, one-millisecond RED
outputs, identical-command GREEN outputs, twenty-process results, fresh full
suite, 100%-coverage summary, exact head, signatures, and changed files. Add
the evidence to the same GLM/Grok adversarial package and Opus second pass used
for #601/#605/#606/#607.
