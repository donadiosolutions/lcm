# Test Determinism Review Evidence (#601, #605–#610)

This document is the retained review package for the test-only timeout work on
`fix/601-605-test-determinism`. It covers issues #601, #605, #606, #607, #608,
issue #609, and issue #610 from implementation base
`01cae5d5b4bbf4208b62f0fc5f8d1e33c7efcae5`.

## Evidence conventions

- **Copied historical output** is text preserved in command output, an issue
  body, or a worker completion record. Short excerpts remain verbatim.
- **Exact summarized evidence** is a faithful condensation of a retained
  command result or worker completion record. It is not represented as a raw
  terminal transcript.
- **Unavailable raw output** means the retained records prove the result but do
  not contain the requested raw line or timing. No replacement line or timing
  has been inferred.
- All durations below are Vitest-reported durations or selected-test timings
  unless explicitly described as shell wall time.

The pre-edit RED command and post-edit GREEN command shown for each issue are
identical. Only the selected test's local `15_000` millisecond timeout argument
changed between those executions.

## #601 — batch-compaction discovery

Selected test: `handles absent, malformed, summarized, and replay discovery
entries`.

### Unchanged focused baseline

Exact command:

```bash
npm exec -- vitest run test/batch-compact.test.ts \
  -t "handles absent, malformed, summarized, and replay discovery entries" \
  --reporter=verbose
```

**Copied historical output:** exit 0; `1 passed | 21 skipped`; selected test
`3540ms`; file duration `4.55s` with `tests 3.54s`.

### Pre-edit inherited-deadline RED

Exact command:

```bash
npm exec -- vitest run test/batch-compact.test.ts \
  -t "handles absent, malformed, summarized, and replay discovery entries" \
  --testTimeout=1 --reporter=dot
```

**Copied historical output:** exit 1; `Test timed out in 1ms.`; `1 failed | 21
skipped`; file duration `4.86s` with `tests 3.87s`.

### Identical-command GREEN

The exact RED command above was rerun unchanged after adding only
`FULL_SUITE_DISCOVERY_TEST_TIMEOUT_MS = 15_000` to the selected test.

**Copied historical output:** exit 0; `1 passed | 21 skipped`; file duration
`2.10s` with `tests 1.35s`.

### Twenty-process stability

Exact command:

```bash
for run in $(seq 1 20); do
  npm exec -- vitest run test/batch-compact.test.ts \
    -t "handles absent, malformed, summarized, and replay discovery entries" \
    --reporter=dot || exit 1
done
```

**Exact summarized evidence (retained worker record):** exit 0; 20/20 fresh processes passed. Each
process reported `1 passed | 21 skipped`; retained selected-test timings ranged
from 1.32s to 1.73s.

### Original full-suite failure

**Copied historical output (issue #601):** a fresh `npm test` at `origin/main` `3f15ab9f`
timed out the selected test at the inherited 5000ms deadline. The run reported
259 passed files, 1 failed file, 2 skipped files; 6,105 passed tests, 1 failed
test, 12 skipped tests; duration 295.26s. Its immediate focused comparison
passed with a 1.00s test body and 1.78s focused run.

Issue commit:
`8a05bc794dddd29b2b39adac62c22c651ebf1cda` (`test: bound batch discovery
regression`).

## #605 — reconciliation timestamp matrix

Selected matrix: `rejects divergent cache rows independently of` (15 generated
rows).

### Unchanged focused baseline

Exact command:

```bash
npm exec -- vitest run test/worktree-reconciliation.test.ts \
  -t "rejects divergent cache rows independently of" \
  --reporter=verbose
```

**Copied historical output:** exit 0; `15 passed | 185 skipped`; all generated
rows passed, including `non-leap-year source`; selected-row timings were
1.763–2.112s; file duration `28.63s` with `tests 27.74s`.

### Pre-edit inherited-deadline RED

Exact command:

```bash
npm exec -- vitest run test/worktree-reconciliation.test.ts \
  -t "rejects divergent cache rows independently of" \
  --testTimeout=1 --reporter=dot
```

**Copied historical output:** exit 1; all 15 rows failed with `Test timed out
in 1ms.`; `15 failed | 185 skipped`; file duration `27.68s` with `tests
26.75s`.

### Identical-command GREEN

The exact RED command above was rerun unchanged after adding only
`FULL_SUITE_RECONCILIATION_TEST_TIMEOUT_MS = 15_000` to the matrix.

**Copied historical output:** exit 0; `15 passed | 185 skipped`; file duration
`27.38s` with `tests 26.43s`.

### Twenty-process stability

Exact command:

```bash
for run in $(seq 1 20); do
  npm exec -- vitest run test/worktree-reconciliation.test.ts \
    -t "rejects divergent cache rows independently of" \
    --reporter=dot || exit 1
done
```

**Exact summarized evidence (retained worker record):** exit 0; 20/20 fresh processes passed; every
process reported `15 passed | 185 skipped`. The retained final process reported
file duration 30.89s with tests 29.85s; a complete per-process timing table was
not retained.

### Original full-suite failure

**Copied historical output (issue #605):** canonical `npm test` at
`3f15ab9f4dcf04e5ce8d6a82eb1255e3e64dfcc5` timed out the generated
`non-leap-year source` row at the inherited 5000ms deadline; Vitest reported
5778ms. The run otherwise had 259 passing files and 6,105 passing tests and
took 368.83s. All 15 rows passed in the focused comparison.

Issue commit:
`cacbc208042caa45f0d397a1f2b9ee482c511bba` (`test: bound reconciliation
timestamp matrix`).

## #606 — journal component snapshot validation

Selected tests: `validates journal component snapshots before merging` and
`accepts complete planned component snapshots before merging`.

### Unchanged focused baseline

Exact command:

```bash
npx vitest run test/worktree-reconciliation.test.ts \
  -t "validates journal component snapshots before merging|accepts complete planned component snapshots before merging" \
  --reporter=verbose
```

**Copied historical output:** exit 0; `2 passed | 198 skipped`; selected tests
1.943s and 1.486s; file duration 4.39s.

### Pre-edit inherited-deadline RED

Exact command:

```bash
npx vitest run test/worktree-reconciliation.test.ts \
  -t "validates journal component snapshots before merging|accepts complete planned component snapshots before merging" \
  --testTimeout=1 --reporter=verbose
```

**Copied historical output:** exit 1; both selected tests failed with `Test
timed out in 1ms`; their bodies reached 2.010s and 1.533s; `2 failed | 198
skipped`; file duration 4.52s.

### Identical-command GREEN

The exact RED command above was rerun unchanged after adding only
`FULL_SUITE_SNAPSHOT_VALIDATION_TEST_TIMEOUT_MS = 15_000` to the two selected
tests.

**Copied historical output:** exit 0; `2 passed | 198 skipped`; selected tests
7.798s and 6.104s; file duration 15.07s.

### Twenty-process stability

Exact command:

```bash
for run in $(seq 1 20); do
  npx vitest run test/worktree-reconciliation.test.ts \
    -t "validates journal component snapshots before merging|accepts complete planned component snapshots before merging" \
    --reporter=dot || exit 1
done
```

**Exact summarized evidence (retained worker record):** exit 0; 20/20 fresh processes passed; every
process reported both selected tests passing. A complete raw per-process timing
table was not retained.

### Original full-suite failure

**Copied historical output (issue #606):** a fresh solo `npm run test:ci` at
`ad5e4c44c3e129c8133e55edd3c897e85ab8cf15` timed out the two unchanged tests
at 5.983s and 6.080s. The run reported 259 passing files, 2 skipped files, 1
failed file; 6,126 passing tests, 12 skipped tests, and 2 failures. Both tests
passed in the focused comparison; that issue report did not retain focused
timings.

Issue commit:
`1f221aa204c61600eba3751080cb17ec7f6f23f7` (`test: bound reconciliation
snapshot validation`).

## #607 — source-store re-fencing

Selected test: `re-fences source stores when target merge markers already
exist`.

### Unchanged focused baseline

Exact command:

```bash
npx vitest run test/worktree-reconciliation.test.ts \
  -t "re-fences source stores when target merge markers already exist" \
  --reporter=verbose
```

**Copied historical output:** exit 0; `1 passed | 199 skipped`; selected test
3.187s; file duration 4.07s.

### Pre-edit inherited-deadline RED

Exact command:

```bash
npx vitest run test/worktree-reconciliation.test.ts \
  -t "re-fences source stores when target merge markers already exist" \
  --reporter=verbose --testTimeout=1
```

**Copied historical output:** exit 1; selected test reached 3.085s and failed
with `Test timed out in 1ms`; `1 failed | 199 skipped`; file duration 4.02s.

### Identical-command GREEN

The exact RED command above was rerun unchanged after adding only
`FULL_SUITE_SOURCE_STORE_REFENCING_TEST_TIMEOUT_MS = 15_000` to the selected
test.

**Copied historical output:** exit 0; `1 passed | 199 skipped`; selected test
3.474s; file duration 4.45s.

### Twenty-process stability

Exact command:

```bash
for run in $(seq 1 20); do
  npx vitest run test/worktree-reconciliation.test.ts \
    -t "re-fences source stores when target merge markers already exist" \
    --reporter=dot || exit 1
done
```

**Exact summarized evidence (retained worker record):** exit 0; 20/20 fresh processes passed; every
process reported the selected test passing. A complete raw per-process timing
table was not retained.

### Original full-suite failure

**Exact summarized evidence (retained worker record):** a fresh `npm test` timed out the unchanged
50,000-directory scenario and no assertion failed. An immediate focused run
passed in 3.40s, the subsequent coverage run passed in 2.41s, and an exact
second `npm test` passed all 6,106 tests.

**Unavailable raw output:** the original full-suite timeout's exact test timing
and total run timing were not retained. They are intentionally not inferred.

Issue commit:
`280b51f4a8c2581734087bf465645675eb7d930b` (`test: bound source-store
re-fencing`).

## #608 — snapshot migration reconciliation

Selected tests:

- `keeps dry-run read-only while previewing legacy metadata backfill`;
- `normalizes a legacy main snapshot with WAL state without migrating source
  evidence`;
- `keeps target and legacy evidence clean when snapshot migration fails, then
  retries`.

### Unchanged focused baseline

Exact command:

```bash
npx vitest run test/worktree-reconciliation.test.ts \
  -t "keeps dry-run read-only while previewing legacy metadata backfill|normalizes a legacy main snapshot with WAL state without migrating source evidence|keeps target and legacy evidence clean when snapshot migration fails, then retries" \
  --reporter=verbose
```

**Exact summarized evidence (retained worker record):** exit 0; all 3 selected tests passed in
1.559s, 2.023s, and 2.485s.

### Pre-edit inherited-deadline RED

Exact command:

```bash
npx vitest run test/worktree-reconciliation.test.ts \
  -t "keeps dry-run read-only while previewing legacy metadata backfill|normalizes a legacy main snapshot with WAL state without migrating source evidence|keeps target and legacy evidence clean when snapshot migration fails, then retries" \
  --testTimeout=1 --reporter=verbose
```

**Exact summarized evidence (retained worker record):** exit 1; all three selected tests failed
solely with `Test timed out in 1ms` after 1.326s, 2.166s, and 2.514s.

### Identical-command GREEN

The exact RED command above was rerun unchanged after adding only
`FULL_SUITE_SNAPSHOT_MIGRATION_TEST_TIMEOUT_MS = 15_000` to the three selected
tests.

**Exact summarized evidence (retained worker record):** exit 0; all three selected tests passed in
1.320s, 1.978s, and 3.059s.

### Twenty-process stability

Exact command:

```bash
for run in $(seq 1 20); do
  npx vitest run test/worktree-reconciliation.test.ts \
    -t "keeps dry-run read-only while previewing legacy metadata backfill|normalizes a legacy main snapshot with WAL state without migrating source evidence|keeps target and legacy evidence clean when snapshot migration fails, then retries" \
    --reporter=dot || exit 1
done
```

**Exact summarized evidence (retained worker record):** exit 0; 20/20 fresh processes and 60/60
selected executions passed; process durations ranged from 6.55s to 18.87s.

### Original full-suite failure

**Copied historical output (issue #608):** fresh `npm run test:ci` failed the three tests at
approximately 5.768s, 6.102s, and 7.259s with `Test timed out in 5000ms`. The
run reported 6,103 passed and 12 skipped tests.

Issue commit:
`5d408ffdeb5e7fbefc68940d07d43a8bf6e6c7f9` (`test: bound snapshot migration
reconciliation`).

## #609 — instruction-cache divergence

Selected test: `fails closed on instruction-cache divergence`.

### Unchanged focused baseline

Exact command:

```bash
npx vitest run test/worktree-reconciliation.test.ts \
  -t "fails closed on instruction-cache divergence" --reporter=verbose
```

**Exact summarized evidence (retained worker record):** exit 0; selected test passed in 1.856s.

### Pre-edit inherited-deadline RED

Exact command:

```bash
npx vitest run test/worktree-reconciliation.test.ts \
  -t "fails closed on instruction-cache divergence" \
  --testTimeout=1 --reporter=verbose
```

**Exact summarized evidence (retained worker record):** exit 1; selected test failed solely with
`Test timed out in 1ms` after 1.859s.

### Identical-command GREEN

The exact RED command above was rerun unchanged after adding only
`FULL_SUITE_INSTRUCTION_CACHE_DIVERGENCE_TEST_TIMEOUT_MS = 15_000` to the
selected test.

**Exact summarized evidence (retained worker record):** exit 0; selected test passed in 1.863s.

### Twenty-process stability

Exact command:

```bash
for run in $(seq 1 20); do
  npx vitest run test/worktree-reconciliation.test.ts \
    -t "fails closed on instruction-cache divergence" --reporter=dot || exit 1
done
```

**Exact summarized evidence (retained worker record):** exit 0; 20/20 fresh processes passed;
selected-test timings ranged from 1.65s to 2.16s.

### Original full-suite failure

**Copied historical output (issue #609):** a second fresh `npm run test:ci` timed out the
selected test at approximately 5.385s under full-suite coverage load with
`Test timed out in 5000ms`.

Issue commit:
`81b869bc73fce53fbac07427a9f5a25c4cbae0b9` (`test: bound instruction-cache
divergence`).

## #610 — completed no-op journal rediscovery

Selected test: `rediscovers mapped sources after a completed no-op journal`.

### Unchanged focused baseline

Exact command:

```bash
npx vitest run test/worktree-reconciliation.test.ts \
  -t "rediscovers mapped sources after a completed no-op journal" \
  --reporter=verbose
```

**Exact summarized evidence (retained worker record):** exit 0; selected test passed in 1.383s.

### Pre-edit inherited-deadline RED

Exact command:

```bash
npx vitest run test/worktree-reconciliation.test.ts \
  -t "rediscovers mapped sources after a completed no-op journal" \
  --testTimeout=1 --reporter=verbose
```

**Exact summarized evidence (retained worker record):** exit 1; selected test failed solely with
`Test timed out in 1ms` after 1.379s.

### Identical-command GREEN

The exact RED command above was rerun unchanged after adding only
`FULL_SUITE_NOOP_JOURNAL_REDISCOVERY_TEST_TIMEOUT_MS = 15_000` to the selected
test.

**Exact summarized evidence (retained worker record):** exit 0; selected test passed in 1.317s.

### Twenty-process stability

Exact command:

```bash
for run in $(seq 1 20); do
  npx vitest run test/worktree-reconciliation.test.ts \
    -t "rediscovers mapped sources after a completed no-op journal" \
    --reporter=dot || exit 1
done
```

**Exact summarized evidence (retained worker record):** exit 0; 20/20 fresh processes passed;
process durations ranged from 2.15s to 2.39s and selected-test timings from
1.32s to 1.54s.

### Original full-suite failure

**Copied historical output (issue #610):** fresh `npm run test:ci` at
`81b869bc73fce53fbac07427a9f5a25c4cbae0b9` timed out the selected test at
5.352s with Vitest's default 5s deadline. The four tests scoped to #608/#609
passed in that run.

Issue commit:
`8bd4bc27f342f0c783989c88c4bc025cbc31f3f1` (`test: bound no-op journal
rediscovery`).

## Final fresh branch verification

These commands were run fresh at executable/test head
`8bd4bc27f342f0c783989c88c4bc025cbc31f3f1`, after all seven issue fixes. The
later provenance and evidence commits change only Markdown and reviewer
instructions, so they preserve this executable/test-tree evidence.

### Affected files

Exact command:

```bash
npx vitest run test/batch-compact.test.ts test/worktree-reconciliation.test.ts
```

**Exact summarized evidence (retained worker record):** exit 0; 2/2 files and 222/222 tests passed;
duration 171.61s.

### Complete non-coverage suite

Exact command:

```bash
npm test
```

**Exact summarized evidence (retained worker record):** exit 0; 260 files passed, 2 skipped; 6,106
tests passed, 12 skipped; duration 276.81s.

### Complete V8 coverage suite

Exact command:

```bash
npm run test:ci
```

**Exact summarized evidence (retained worker record):** exit 0; 260 files passed, 2 skipped; 6,106
tests passed, 12 skipped; duration 291.19s. The #610 selected test passed under
coverage in 1.564s.

**Copied historical coverage counts:** statements 100% (26,541/26,541),
branches 100% (19,082/19,082), functions 100% (4,226/4,226), and lines 100%
(24,241/24,241).

Static gates at that head also passed: `npm run build` (9.92s), `npm run
typecheck` (8.51s), `npm run lint` (11.68s), and `git diff --check`.

## Commits, refs, and signed provenance

### Issue implementation commits

| Issue | Commit | Subject |
| --- | --- | --- |
| #601 | `8a05bc794dddd29b2b39adac62c22c651ebf1cda` | `test: bound batch discovery regression` |
| #605 | `cacbc208042caa45f0d397a1f2b9ee482c511bba` | `test: bound reconciliation timestamp matrix` |
| #606 | `1f221aa204c61600eba3751080cb17ec7f6f23f7` | `test: bound reconciliation snapshot validation` |
| #607 | `280b51f4a8c2581734087bf465645675eb7d930b` | `test: bound source-store re-fencing` |
| #608 | `5d408ffdeb5e7fbefc68940d07d43a8bf6e6c7f9` | `test: bound snapshot migration reconciliation` |
| #609 | `81b869bc73fce53fbac07427a9f5a25c4cbae0b9` | `test: bound instruction-cache divergence` |
| #610 | `8bd4bc27f342f0c783989c88c4bc025cbc31f3f1` | `test: bound no-op journal rediscovery` |

### Durable ref and checkpoint mapping

| Scope | Base ref/value | Immutable reviewed ref/value | Signed merge checkpoint/value | Checkpoint second parent |
| --- | --- | --- | --- | --- |
| #601/#605 | `refs/lcm/implementation-bases/issues-601-605-test-determinism` → `01cae5d5b4bbf4208b62f0fc5f8d1e33c7efcae5` | Plan already committed at the implementation base; no extension reviewed ref | No extension merge checkpoint | Not applicable |
| #606/#607 | `refs/lcm/extension-bases/issues-606-607` → `cacbc208042caa45f0d397a1f2b9ee482c511bba` | `refs/lcm/reviewed-plans/issues-606-607` → `47e322f922963a8be91223546bce952405493acf` | `refs/lcm/merge-checkpoints/issues-606-607` → `0ee5769975435a2b1ca7500c4d9a427c94763f3f` | `47e322f922963a8be91223546bce952405493acf` |
| #608/#609 | `refs/lcm/extension-bases/issues-608-609` → `280b51f4a8c2581734087bf465645675eb7d930b` | `refs/lcm/reviewed-plans/issues-608-609` → `d2aa2f5d3623b759b2c9496d9c98c6cc973a8144` | `refs/lcm/merge-checkpoints/issues-608-609` → `a5778cdac7e215a100fd729306e4df102ae7fcbf` | `d2aa2f5d3623b759b2c9496d9c98c6cc973a8144` |
| #610 | `refs/lcm/extension-bases/issue-610` → `81b869bc73fce53fbac07427a9f5a25c4cbae0b9` | `refs/lcm/reviewed-plans/issue-610` → `59e115fa1a6baeed2688cb8510a1d811eebffa45` | `refs/lcm/merge-checkpoints/issue-610` → `9b54b17c6af6d6b113db40a7fb601aef87b05c3f` | `59e115fa1a6baeed2688cb8510a1d811eebffa45` |

Every immutable reviewed ref equals its signed checkpoint's second parent.
Every checkpoint is a two-parent no-fast-forward merge and is an ancestor of
the review head.

### GPG and DCO audit

At provenance head `31c3f39e3ac58e6a91a2866f1113220851674113`,
all 20 commits after the implementation base reported `%G? = G`, passed
`git verify-commit`, and contained the required trailer:

```text
Signed-off-by: Bernardo Donadio <bcdonadio@bcdonadio.com>
```

The commit containing this evidence file is a docs-only follow-up and must be
checked by the same executable audit:

```bash
for commit in $(git rev-list \
  refs/lcm/implementation-bases/issues-601-605-test-determinism..HEAD)
do
  git verify-commit "$commit"
  git log -1 --format=%B "$commit" |
    rg -q '^Signed-off-by: Bernardo Donadio <bcdonadio@bcdonadio\.com>$'
done
```

## Changed-file review boundary

The complete review package from the implementation base contains exactly:

```text
.github/copilot-instructions.md
docs/superpowers/evidence/2026-08-11-test-determinism.md
docs/superpowers/plans/2026-08-11-additional-reconciliation-timeouts.md
docs/superpowers/plans/2026-08-11-noop-journal-rediscovery-timeout.md
docs/superpowers/plans/2026-08-11-open-bug-test-determinism.md
docs/superpowers/plans/2026-08-11-snapshot-validation-test-determinism.md
docs/superpowers/specs/2026-08-11-open-bug-remediation-design.md
test/batch-compact.test.ts
test/worktree-reconciliation.test.ts
```

Only the two test files contain executable changes. The evidence-package
follow-up changes only this document, the four linked plans, and Copilot review
instructions. No production file, test file, timeout behavior, fixture, global
configuration, dependency, Changeset, or Codecov configuration is changed by
the evidence package.

## Newly observed bug result

All unrelated timeout observations were tracked before scope expansion: #607
was retained from the initial full-suite verification, #608 and #609 were filed
during #606/#607 verification, and #610 was filed during #608/#609
verification. The final fresh #610 affected, `npm test`, and `npm run test:ci`
runs exposed no additional bug. There is no known newly observed, unfiled bug
in this review package.
