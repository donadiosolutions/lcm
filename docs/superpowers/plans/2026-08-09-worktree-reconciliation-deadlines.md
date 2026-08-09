# Worktree Reconciliation Deadline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close #555 and #563 by giving exactly four process-heavy worktree-reconciliation tests explicit full-suite deadlines.

**Architecture:** This is a test-contract correction only. Reuse the existing `FULL_SUITE_PROCESS_TEST_TIMEOUT_MS` constant for the four real Git/SQLite/filesystem cases; do not change production code, fixtures, Vitest configuration, or global timeout policy.

**Tech Stack:** TypeScript, Vitest 4.1.10, Node.js 25.9.0, SQLite, Git.

## Global Constraints

- Branch from current `origin/main` as `fix/open-bug-test-determinism`; never use a `codex/` prefix.
- Preserve exact dependency pins and the lockfile; add no dependency.
- Use DCO `--signoff` on every commit.
- Do not add skips, coverage exclusions, `v8 ignore` directives, global timeout changes, or narrowed test collection.
- No production TypeScript changes means no Codecov component update.
- This test-only change needs no user documentation or Changeset.
- Merge with a merge commit only after exact-head checks and MoM reviews pass.

---

### Task 1: Prove the inherited deadline and add explicit bounds

**Files:**
- Inspect: `test/worktree-reconciliation.test.ts`
- Modify later: `test/worktree-reconciliation.test.ts`

**Interfaces:**
- Consumes: Vitest's optional third `it(name, callback, timeout)` argument.
- Produces: A red baseline showing that all four callbacks inherit the CLI timeout, followed by the four explicit 15-second contracts.

- [ ] **Step 1: Define the exact selection**

```bash
T=test/worktree-reconciliation.test.ts
F='fails closed on invalid foreign keys|journals each archive rename and resumes from the failed phase|fails closed if a source vanishes after discovery or a retired path is recreated|rejects retired paths recreated between archival and fence publication'
```

- [ ] **Step 2: Verify the current callbacks have no per-test timeout**

Run the TypeScript AST inspection and require `timeout` to be `null` for all four calls:

```bash
node --input-type=module -e '
import ts from "typescript";
import fs from "node:fs";
const file = "test/worktree-reconciliation.test.ts";
const names = new Set([
  "fails closed on invalid foreign keys",
  "journals each archive rename and resumes from the failed phase",
  "fails closed if a source vanishes after discovery or a retired path is recreated",
  "rejects retired paths recreated between archival and fence publication",
]);
const source = fs.readFileSync(file, "utf8");
const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
const found = [];
function visit(node) {
  if (ts.isCallExpression(node) && ts.isStringLiteral(node.arguments[0]) && names.has(node.arguments[0].text)) {
    found.push({ name: node.arguments[0].text, timeout: node.arguments[2]?.getText(tree) ?? null });
  }
  ts.forEachChild(node, visit);
}
visit(tree);
console.log(JSON.stringify(found, null, 2));
if (found.length !== 4 || found.some(({ timeout }) => timeout !== null)) process.exit(1);
'
```

Expected: four entries with `"timeout": null`.

- [ ] **Step 3: Demonstrate RED with a one-millisecond inherited timeout**

```bash
umask 0022
npm exec -- vitest run "$T" --testNamePattern="$F" --testTimeout=1 --reporter=dot
```

Expected: all four fail with `Test timed out in 1ms`. This proves that the test callbacks inherit the global/CLI deadline.

- [ ] **Step 4: Add the timeout to each callback**

Change only each selected test's closing call from:

```ts
  });
```

to:

```ts
  }, FULL_SUITE_PROCESS_TEST_TIMEOUT_MS);
```

Do not change fixture helpers, file modes, production code, or any other test timeout.

- [ ] **Step 5: Verify GREEN against the same one-millisecond CLI timeout**

```bash
umask 0022
npm exec -- vitest run "$T" --testNamePattern="$F" --testTimeout=1 --reporter=dot
```

Expected: four tests pass because their explicit 15-second deadline overrides the inherited one-millisecond value.

- [ ] **Step 6: Verify the AST contract**

Repeat Task 1 Step 2 with the final assertion changed to:

```js
if (found.length !== 4 || found.some(({ timeout }) => timeout !== "FULL_SUITE_PROCESS_TEST_TIMEOUT_MS")) process.exit(1);
```

Expected: all four entries use exactly `FULL_SUITE_PROCESS_TEST_TIMEOUT_MS`.

- [ ] **Step 7: Commit the focused patch**

```bash
git add test/worktree-reconciliation.test.ts
git commit --signoff -m "test: bound reconciliation regressions"
```

### Task 2: Prove determinism under the reported conditions

**Files:**
- Verify: `test/worktree-reconciliation.test.ts`
- Generated and untracked during coverage: `coverage/`, `test-report.junit.xml`

**Interfaces:**
- Consumes: The four explicit deadlines from Task 1.
- Produces: Repetition, umask, concurrent-load, and complete-coverage evidence.

- [ ] **Step 1: Run twenty isolated repetitions under `umask 0022`**

```bash
set -Eeuo pipefail
for n in $(seq 1 20); do
  umask 0022
  npm exec -- vitest run "$T" --testNamePattern="$F" --reporter=dot
done
```

Expected: 20/20 processes pass all four tests.

- [ ] **Step 2: Run two concurrent complete coverage suites**

Use separate temporary report directories so the two processes do not race on coverage or JUnit output:

```bash
set -Eeuo pipefail
ROOT=$(mktemp -d)
trap 'rm -rf "$ROOT"' EXIT
(
  umask 0022
  npm exec -- vitest run --dir test --coverage \
    --coverage.reporter=text \
    --coverage.reportsDirectory="$ROOT/a-coverage" \
    --reporter=default --reporter=junit \
    --outputFile="$ROOT/a.junit.xml"
) >"$ROOT/a.log" 2>&1 &
a=$!
(
  umask 0022
  npm exec -- vitest run --dir test --coverage \
    --coverage.reporter=text \
    --coverage.reportsDirectory="$ROOT/b-coverage" \
    --reporter=default --reporter=junit \
    --outputFile="$ROOT/b.junit.xml"
) >"$ROOT/b.log" 2>&1 &
b=$!
wait "$a"
wait "$b"
tail -30 "$ROOT/a.log"
tail -30 "$ROOT/b.log"
```

Expected: both suites exit zero and each reports 100% statements, branches, functions, and lines.

- [ ] **Step 3: Run the canonical repository gates fresh**

```bash
npm run test:ci
npm run lint
npm run typecheck
npm run build
git diff --check
```

Expected: all commands exit zero; `npm run test:ci` reports 100% in all four dimensions and all per-file thresholds pass.

### Task 3: Review, publish, and close #555/#563

**Files:**
- Review: `docs/superpowers/specs/2026-08-09-open-bug-triage-design.md`
- Review: `docs/superpowers/plans/2026-08-09-worktree-reconciliation-deadlines.md`
- Review: `test/worktree-reconciliation.test.ts`

**Interfaces:**
- Consumes: Verified branch commits and the approved design.
- Produces: One merged PR closing #555 and #563.

- [ ] **Step 1: Run the required MoM review sequence**

Dispatch independent max-effort GLM and Kimi reviewers over `origin/main..HEAD`. Give both complete reports to a medium-effort Opus reviewer. Return every Critical or Important finding to a max-effort Luna implementer, then rerun Task 2 after fixes.

- [ ] **Step 2: Push and open the PR**

The PR title is `Bound worktree reconciliation regression deadlines`. Its body must explain the four cases, the inherited 5-second root cause, 20-process and concurrent-coverage evidence, no production/global-timeout change, no Changeset decision, and include `Closes #555` and `Closes #563`.

- [ ] **Step 3: Complete CI and Copilot review**

Require all protected exact-head checks, resolve every actionable review thread, and reply `Fixed in [commit hash].` before resolving each addressed thread.

- [ ] **Step 4: Merge with a merge commit and verify ancestry**

```bash
gh pr merge "$PR_NUMBER" --repo donadiosolutions/lcm --merge --delete-branch
git fetch origin --prune
git merge-base --is-ancestor "$(gh pr view "$PR_NUMBER" --repo donadiosolutions/lcm --json mergeCommit --jq .mergeCommit.oid)" origin/main
```

Expected: the PR reports `MERGED` and its merge commit is an ancestor of `origin/main`.
