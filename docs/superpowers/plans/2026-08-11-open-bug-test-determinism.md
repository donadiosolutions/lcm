# Open Bug Test Determinism Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close #601 and #605 by giving only two proven load-sensitive regression scenarios explicit test-owned deadlines without changing production behavior.

**Architecture:** Preserve both real SQLite/filesystem scenarios and all assertions. Prove that each inherits Vitest's global/CLI deadline, then assign one named 15-second local contract to each selected callback and verify the override under a one-millisecond CLI timeout.

**Tech Stack:** TypeScript, Vitest 4.1.10, Node.js 25.9.0, SQLite, Git.

## Global Constraints

- In a fresh isolated worker workspace, resolve `REVIEWED_PLANNING_HEAD=$(git rev-parse --verify 'refs/lcm/planning/open-bugs-2026-08-11^{commit}')`, require `test "$(git rev-parse HEAD)" = "$REVIEWED_PLANNING_HEAD"`, persist it with `git update-ref refs/lcm/implementation-bases/open-bug-test-determinism "$REVIEWED_PLANNING_HEAD"`, and create branch `fix/open-bug-test-determinism` from that exact SHA; never use a `codex/` prefix.
- Do not use, clean, stage, or modify the coordinator worktree or pre-existing files outside this branch.
- Modify only `test/batch-compact.test.ts` and `test/worktree-reconciliation.test.ts` unless verification exposes a directly caused test compile failure.
- Add no dependency and do not modify production TypeScript, fixtures, Vitest configuration, global timeout, pool topology, or collection scope.
- Add no skip, coverage exclusion, `v8 ignore`, retry, or narrowed test command.
- No Codecov taxonomy, user documentation, or Changeset change is required.
- GPG-sign every commit and include DCO `--signoff`.
- Merge with a merge commit only after exact-head MoM review and all gates pass.

---

### Task 1: Bound the batch-compaction discovery regression (#601)

**Files:**
- Modify: `test/batch-compact.test.ts`

**Interfaces:**
- Consumes: Vitest `it(name, callback, timeout)` and the existing synchronous `findUncompacted` fixture.
- Produces: `FULL_SUITE_DISCOVERY_TEST_TIMEOUT_MS = 15_000` applied only to `handles absent, malformed, summarized, and replay discovery entries`.

- [ ] **Step 1: Re-establish focused baseline**

```bash
npm exec -- vitest run test/batch-compact.test.ts \
  -t "handles absent, malformed, summarized, and replay discovery entries" \
  --reporter=verbose
```

Expected: the focused scenario passes in roughly one second, matching the issue's focused comparison.

- [ ] **Step 2: Prove RED through inherited deadline**

```bash
npm exec -- vitest run test/batch-compact.test.ts \
  -t "handles absent, malformed, summarized, and replay discovery entries" \
  --testTimeout=1 --reporter=dot
```

Expected: the exact scenario fails with `Test timed out in 1ms`, proving that it inherits the CLI/global deadline before the fix.

- [ ] **Step 3: Add the smallest test-owned contract**

Near the top-level test helpers, add:

```ts
const FULL_SUITE_DISCOVERY_TEST_TIMEOUT_MS = 15_000;
```

Change only the selected test's closing call from:

```ts
  });
```

to:

```ts
  }, FULL_SUITE_DISCOVERY_TEST_TIMEOUT_MS);
```

- [ ] **Step 4: Verify GREEN against the same one-millisecond deadline**

Run the command from Step 2 unchanged.

Expected: the scenario passes because its explicit local deadline overrides the inherited one-millisecond value.

- [ ] **Step 5: Run the complete file**

```bash
npm exec -- vitest run test/batch-compact.test.ts
```

Expected: all batch-compaction tests pass with no skipped test.

- [ ] **Step 6: Commit**

```bash
git add test/batch-compact.test.ts
git commit -S --signoff -m "test: bound batch discovery regression"
```

### Task 2: Bound the reconciliation timestamp matrix (#605)

**Files:**
- Modify: `test/worktree-reconciliation.test.ts`

**Interfaces:**
- Consumes: Vitest `it.each(table)(name, callback, timeout)` and the existing divergent-cache matrix.
- Produces: A named 15-second full-suite contention deadline applied only to the timestamp matrix.

- [ ] **Step 1: Re-establish all generated focused cases**

```bash
npm exec -- vitest run test/worktree-reconciliation.test.ts \
  -t "rejects divergent cache rows independently of" \
  --reporter=verbose
```

Expected: all fifteen generated cases pass, including `non-leap-year source`.

- [ ] **Step 2: Prove RED through inherited deadline**

```bash
npm exec -- vitest run test/worktree-reconciliation.test.ts \
  -t "rejects divergent cache rows independently of" \
  --testTimeout=1 --reporter=dot
```

Expected: generated cases fail with `Test timed out in 1ms`, proving the matrix inherits the global/CLI deadline.

- [ ] **Step 3: Add one matrix-local timeout**

Define an explicit matrix-owned constant; do not reuse the child-process-specific existing constant:

```ts
const FULL_SUITE_RECONCILIATION_TEST_TIMEOUT_MS = 15_000;
```

Change only the matrix closure from:

```ts
  });
```

to:

```ts
  }, FULL_SUITE_RECONCILIATION_TEST_TIMEOUT_MS);
```

Do not alter the matrix values, fixture helper, timestamp parser, reconciliation code, or any neighboring timeout.

- [ ] **Step 4: Verify GREEN against the identical one-millisecond command**

Run the command from Step 2 unchanged.

Expected: all generated cases pass under their explicit local deadline.

- [ ] **Step 5: Run twenty isolated repetitions**

```bash
for run in $(seq 1 20); do
  npm exec -- vitest run test/worktree-reconciliation.test.ts \
    -t "rejects divergent cache rows independently of" --reporter=dot || exit 1
done
```

Expected: twenty successful processes and all generated rows pass in every process.

- [ ] **Step 6: Commit**

```bash
git add test/worktree-reconciliation.test.ts
git commit -S --signoff -m "test: bound reconciliation timestamp matrix"
```

### Task 3: Verify the complete branch

**Files:**
- Verify only: complete repository

**Interfaces:**
- Consumes: both local timeout contracts.
- Produces: exact-head evidence for review and publication.

- [ ] **Step 1: Repeat the batch target twenty times**

```bash
for run in $(seq 1 20); do
  npm exec -- vitest run test/batch-compact.test.ts \
    -t "handles absent, malformed, summarized, and replay discovery entries" \
    --reporter=dot || exit 1
done
```

Expected: twenty successful processes.

- [ ] **Step 2: Run both complete files**

```bash
npm exec -- vitest run test/batch-compact.test.ts test/worktree-reconciliation.test.ts
```

Expected: both files pass completely.

- [ ] **Step 3: Run static gates**

```bash
npm run build
npm run typecheck
npm run lint
```

Expected: all commands exit zero.

- [ ] **Step 4: Run the canonical coverage gate**

```bash
npm test
npm run test:ci
```

Expected: both complete suites pass and coverage reports exactly 100% lines, branches, functions, and statements for the complete collected scope.

- [ ] **Step 5: Confirm branch scope**

```bash
IMPLEMENTATION_BASE=$(
  git rev-parse --verify 'refs/lcm/implementation-bases/open-bug-test-determinism^{commit}'
)
git diff --check "$IMPLEMENTATION_BASE"...HEAD
git diff --name-only "$IMPLEMENTATION_BASE"...HEAD
git status --short
git log --show-signature --format=fuller "$IMPLEMENTATION_BASE"..HEAD
```

Expected: only `test/batch-compact.test.ts` and `test/worktree-reconciliation.test.ts` differ from the recorded planning head; the worktree is clean; every commit has a valid GPG signature and `Signed-off-by` trailer.
