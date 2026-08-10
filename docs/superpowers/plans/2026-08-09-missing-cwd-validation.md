# Missing-CWD Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close #564 by rejecting missing-CWD parking thresholds below the schema's fixed minimum before any SQLite read or write.

**Architecture:** Keep schema v5, the storage adapter, and the production route unchanged. `EventsDb.observeMissingCwd()` is the concrete validation boundary and already owns `MISSING_CWD_PARKING_OBSERVATIONS = 3`; align its argument guard with that same constant.

**Tech Stack:** TypeScript, Node.js SQLite `DatabaseSync`, Vitest 4.1.10.

## Global Constraints

- Start `fix/564-missing-cwd-threshold` from current `origin/main` after the deadline PR merges.
- Add no dependency and preserve exact pins/integrity.
- Use DCO `--signoff` on every commit.
- Preserve 100% line, branch, function, and statement coverage for all configured production TypeScript.
- Do not change `EVENTS_SCHEMA_VERSION`, `MISSING_CWD_STATE_SQL`, the outbox interface, or the route's fixed threshold.
- `docs/passive-learning.md` already documents three observations; no documentation change is needed.
- `observeMissingCwd` is an internal repository seam and production already passes three, so explicitly record `no Changeset` in the PR.
- No file moves/additions under production scope means Codecov taxonomy stays unchanged.

---

### Task 1: Add the schema-minimum regression

**Files:**
- Modify: `test/hooks/events-db.test.ts:230`
- Test: `test/hooks/events-db.test.ts`

**Interfaces:**
- Consumes: `new EventsDb(dbPath)` and `observeMissingCwd(observedAtMs, minimumIntervalMs, requiredObservations)`.
- Produces: An observable contract requiring deterministic validation for thresholds one and two.

- [ ] **Step 1: Add the failing boundary table near existing argument validation tests**

```ts
it.each([1, 2] as const)(
  "rejects requiredObservations below the schema minimum: %s",
  (requiredObservations) => {
    const db = new EventsDb(dbPath);
    try {
      expect(() => db.observeMissingCwd(0, 0, requiredObservations)).toThrow(
        "requiredObservations must be a positive safe integer no less than 3",
      );
    } finally {
      db.close();
    }
  },
);
```

The break this catches is a caller lowering `requiredObservations` below the persisted `parked_at` invariant. The expected string is hand-authored and does not reuse the implementation helper.

- [ ] **Step 2: Verify RED**

```bash
npm exec -- vitest run test/hooks/events-db.test.ts \
  -t "rejects requiredObservations below the schema minimum"
```

Expected on the pre-fix baseline:

- value `1` reaches SQLite and throws `CHECK constraint failed: parked_at IS NULL OR observations >= 3`, not the expected validation error;
- value `2` is accepted on the first observation, so the expectation reports that the function did not throw.

### Task 2: Align runtime validation with the persisted invariant

**Files:**
- Modify: `src/hooks/events-db.ts:569`
- Test: `test/hooks/events-db.test.ts`

**Interfaces:**
- Consumes: `MISSING_CWD_PARKING_OBSERVATIONS` (`3`) and `Number.isSafeInteger`.
- Produces: A synchronous validation error before state lookup or mutation.

- [ ] **Step 1: Replace only the existing `requiredObservations` guard**

```ts
if (
  !Number.isSafeInteger(requiredObservations)
  || requiredObservations < MISSING_CWD_PARKING_OBSERVATIONS
) {
  throw new Error(
    `requiredObservations must be a positive safe integer no less than ${MISSING_CWD_PARKING_OBSERVATIONS}`,
  );
}
```

Leave the `observedAtMs` and `minimumIntervalMs` guards untouched.

- [ ] **Step 2: Verify GREEN for the new boundary**

```bash
npm exec -- vitest run test/hooks/events-db.test.ts \
  -t "rejects requiredObservations below the schema minimum"
```

Expected: both table rows pass.

- [ ] **Step 3: Verify the complete direct behavior**

```bash
npm exec -- vitest run test/hooks/events-db.test.ts
```

Expected: all existing invalid values remain rejected, thresholds of three continue through the complete park/reopen lifecycle, and larger safe integers remain accepted.

- [ ] **Step 4: Commit the red-green change**

```bash
git add src/hooks/events-db.ts test/hooks/events-db.test.ts
git commit --signoff -m "fix(hooks): reject undersized parking thresholds"
```

### Task 3: Verify adapters, routes, reconciliation, and coverage

**Files:**
- Verify: `src/storage/local-hook-outbox.ts`
- Verify: `src/daemon/routes/promote-events.ts`
- Verify: `src/worktree-reconciliation.ts`
- Verify: `test/storage/local-hook-outbox.test.ts`
- Verify: `test/daemon/routes/promote-events.test.ts`
- Verify: `test/daemon/routes/promote-events-unit-boundaries.test.ts`
- Verify: `test/worktree-reconciliation.test.ts`

**Interfaces:**
- Consumes: The valid production threshold `3` through the forwarding adapter.
- Produces: Evidence that no valid caller or persisted-state behavior changed.

- [ ] **Step 1: Run related tests**

```bash
npm exec -- vitest run \
  test/hooks/events-db.test.ts \
  test/storage/local-hook-outbox.test.ts \
  test/daemon/routes/promote-events.test.ts \
  test/daemon/routes/promote-events-unit-boundaries.test.ts \
  test/worktree-reconciliation.test.ts
```

Expected: all selected tests pass.

- [ ] **Step 2: Run the full repository gates fresh**

```bash
npm run test:ci
npm run lint
npm run typecheck
npm run build
git diff --check
```

Expected: every command exits zero; coverage reports 100% statements, branches, functions, and lines with all per-file thresholds intact.

- [ ] **Step 3: Audit the exact diff**

```bash
git diff origin/main...HEAD --stat
git diff origin/main...HEAD -- src/hooks/events-db.ts test/hooks/events-db.test.ts
```

Expected: one guard and its direct regression, plus only approved plan/spec ancestry if those documents are already on main. No schema, adapter, route, docs, Codecov, dependency, or Changeset file changes.

### Task 4: Review, publish, and close #564

**Files:**
- Review: `src/hooks/events-db.ts`
- Review: `test/hooks/events-db.test.ts`

**Interfaces:**
- Consumes: Verified TDD commit.
- Produces: One merged PR closing #564.

- [ ] **Step 1: Run the required MoM reviews**

Dispatch max-effort GLM and Kimi reviewers independently, then give the implementation and both reports to medium-effort Opus. Fix every Critical/Important finding through a max-effort Luna worker and rerun Task 3.

- [ ] **Step 2: Open the PR**

Use title `Reject missing-CWD thresholds below the schema minimum`. Explain the runtime/schema drift, deterministic validation wording, unchanged schema/route, 100% coverage, and explicit no-Changeset decision. Include `Closes #564`.

- [ ] **Step 3: Complete exact-head checks and review threads**

Require all checks green. For every addressed review thread, push a signed-off fix commit, reply `Fixed in [commit hash].`, and resolve it.

- [ ] **Step 4: Merge with a merge commit and verify**

```bash
gh pr merge "$PR_NUMBER" --repo donadiosolutions/lcm --merge --delete-branch
git fetch origin --prune
gh pr view "$PR_NUMBER" --repo donadiosolutions/lcm --json state --jq .state
```

Expected: `MERGED`, with the merge commit reachable from `origin/main`.
