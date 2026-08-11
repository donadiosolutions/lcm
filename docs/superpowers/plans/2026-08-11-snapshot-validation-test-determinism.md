# Reconciliation Verification Test Determinism Plan (#606, #607)

> Execute this addendum with the existing test-determinism plan and preserve
> strict RED-before-GREEN evidence.

**Goal:** Make the two snapshot-validation reconciliation tests and the
source-store re-fencing test reliable under canonical full-suite load without
weakening assertions, changing production behavior, or broadening a global
timeout.

**Root cause:** Both tests perform real filesystem, journal, project-map, and
SQLite reconciliation work but inherit Vitest's 5,000 ms wall-clock deadline.
In a fresh solo `npm run test:ci`, they took 5.983 and 6.080 seconds and timed
out. The unchanged tests pass together in a focused run, proving load-sensitive
test-harness deadlines rather than a production defect.

#607's source-store re-fencing test is another real filesystem/SQLite
reconciliation scenario with no local timeout. It timed out in one fresh full
suite, then passed in 3.40 seconds focused, 2.41 seconds under coverage, and in
an exact full-suite rerun. That pass/fail distribution is the same
load-sensitive test-deadline defect.

**Scope:** Extend branch `fix/601-605-test-determinism` in its dedicated
worktree after the #601/#605 commits. The branch name is retained because it
was created before verification discovered #606/#607. Modify only
`test/worktree-reconciliation.test.ts` plus the planning documents. Add no
dependency, user documentation, Changeset, production code, global Vitest
setting, skip, retry, exclusion, or coverage exception.

---

### Task 1: Bound the two snapshot-validation regressions

**Files:**

- Modify: `test/worktree-reconciliation.test.ts`
- Reference only: the failed canonical JUnit report; never commit it

- [ ] **Step 1: Re-establish the focused baseline**

```bash
npx vitest run test/worktree-reconciliation.test.ts \
  -t "validates journal component snapshots before merging|accepts complete planned component snapshots before merging" \
  --reporter=verbose
```

Require both unchanged tests to pass. Record elapsed times and the exact
command.

- [ ] **Step 2: Prove RED through the inherited deadline**

Before changing either test, run:

```bash
npx vitest run test/worktree-reconciliation.test.ts \
  -t "validates journal component snapshots before merging|accepts complete planned component snapshots before merging" \
  --testTimeout=1 --reporter=verbose
```

Require a non-zero exit caused by the inherited one-millisecond timeout. This
deterministically proves neither test owns a deadline.

- [ ] **Step 3: Add one scenario-local timeout contract**

Near the existing full-suite reconciliation constants, add:

```ts
const FULL_SUITE_SNAPSHOT_VALIDATION_TEST_TIMEOUT_MS = 15_000;
```

Pass that constant as the final `it(...)` argument to exactly:

- `validates journal component snapshots before merging`; and
- `accepts complete planned component snapshots before merging`.

Do not alter callbacks, assertions, fixtures, test names, other tests, or
global configuration.

- [ ] **Step 4: Prove GREEN with the identical deadline command**

Run the exact Step 2 command. Require both tests to pass despite
`--testTimeout=1`, proving the explicit local contract controls only these
two scenarios while preserving their behavior.

- [ ] **Step 5: Run twenty isolated repetitions**

```bash
for run in $(seq 1 20); do
  npx vitest run test/worktree-reconciliation.test.ts \
    -t "validates journal component snapshots before merging|accepts complete planned component snapshots before merging" \
    --reporter=dot || exit 1
done
```

Require all twenty separate processes to pass.

- [ ] **Step 6: Commit**

```bash
git add test/worktree-reconciliation.test.ts
git commit -S --signoff -m "test: bound reconciliation snapshot validation"
```

### Task 2: Bound the source-store re-fencing regression

**Files:**

- Modify: `test/worktree-reconciliation.test.ts`

- [ ] **Step 1: Re-establish focused baseline**

```bash
npx vitest run test/worktree-reconciliation.test.ts \
  -t "re-fences source stores when target merge markers already exist" \
  --reporter=verbose
```

Require the unchanged test to pass and record elapsed time.

- [ ] **Step 2: Prove inherited-deadline RED**

Before changing the test, rerun the same command with
`--testTimeout=1`. Require a non-zero exit caused by `Test timed out in
1ms`.

- [ ] **Step 3: Apply one test-local contract**

Add a clearly named
`FULL_SUITE_SOURCE_STORE_REFENCING_TEST_TIMEOUT_MS = 15_000` constant beside the
other full-suite reconciliation constants and pass it as the final argument to
exactly the source-store re-fencing `it(...)`. Do not modify its callback,
fixtures, assertions, neighbors, or global configuration.

- [ ] **Step 4: Prove identical-command GREEN**

Run the exact Step 2 command again. Require the selected test to pass despite
the one-millisecond command-level timeout.

- [ ] **Step 5: Run twenty isolated repetitions**

```bash
for run in $(seq 1 20); do
  npx vitest run test/worktree-reconciliation.test.ts \
    -t "re-fences source stores when target merge markers already exist" \
    --reporter=dot || exit 1
done
```

Require all twenty separate processes to pass.

- [ ] **Step 6: Commit**

```bash
git add test/worktree-reconciliation.test.ts
git commit -S --signoff -m "test: bound source-store re-fencing"
```

### Task 3: Re-run the complete test-determinism branch gates

- [ ] **Step 1: Run both complete affected files**

```bash
npx vitest run test/batch-compact.test.ts test/worktree-reconciliation.test.ts
```

- [ ] **Step 2: Run static gates**

```bash
npm run build
npm run typecheck
npm run lint
git diff --check
```

- [ ] **Step 3: Run fresh complete suites**

Ensure no other test process targets this worktree, then run one process at a
time:

```bash
npm test
npm run test:ci
```

The coverage run must report 100% lines, branches, functions, and statements
for the complete collected scope. File any newly observed unrelated bug
immediately under repository policy before continuing.

- [ ] **Step 4: Audit exact scope and signatures**

```bash
IMPLEMENTATION_BASE=$(
  git rev-parse --verify \
    'refs/lcm/implementation-bases/issues-601-605-test-determinism^{commit}'
)
git diff --check "$IMPLEMENTATION_BASE"...HEAD
git diff --name-only "$IMPLEMENTATION_BASE"...HEAD
git status --short
git log --show-signature --format=fuller "$IMPLEMENTATION_BASE"..HEAD
```

Require only the planning documents and the two intended test files in the
branch diff, a clean worktree, valid GPG signatures, and DCO trailers.

### Task 4: Preserve evidence for the MoM review package

Record #606's original 5.983/6.080-second canonical failures and #607's
full-suite timeout with its 3.40-second focused and 2.41-second coverage
comparisons. For both issues record the one-millisecond RED,
identical-command GREEN, twenty-process repetitions, full-suite result,
coverage percentages, exact head SHA, and changed-file list.
The whole-branch GLM/Grok adversarial review and Opus second pass must receive
this #606/#607 evidence together with #601/#605.
