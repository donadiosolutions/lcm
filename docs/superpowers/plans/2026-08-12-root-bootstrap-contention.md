# Root Bootstrap Contention Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close #673 by giving every non-help CLI invocation one bounded wait for an authenticated live root-bootstrap owner, with safe exhaustion guidance and no weakened lock recovery.

**Architecture:** Generalize the existing foreground-daemon retry into the sole `runCli()` bootstrap policy: 20 total attempts with 50 milliseconds between typed live-owner contention failures, for one invocation-wide 950-millisecond maximum. Remove the redundant migration from daemon-client creation and delete the obsolete foreground-only wrapper; preserve all ownership authentication and stale-lock handling in `src/runtime-paths.ts` except for safer typed contention wording.

**Tech Stack:** TypeScript, Commander, Vitest 4.1.10, Node.js 25.9.0, Git.

## Global Constraints

- Implement the approved behavior from GitHub issue #673 and `docs/superpowers/specs/2026-08-12-root-bootstrap-contention-design.md`.
- Work only in the assigned isolated worktree and do not modify unrelated user changes.
- Use strict TDD: add each regression first, run it to observe the intended failure, then make the smallest production change.
- Retry only the concrete `BootstrapLockContentionError`; do not use error-message matching.
- Preserve exactly 20 total attempts, 50 milliseconds between attempts, and one 950-millisecond maximum wait per CLI invocation.
- Never delete, rename, reclaim, or otherwise mutate bootstrap locks in the retry helper.
- Preserve authenticated owner checks, race-safe stale recovery, and fail-closed ambiguous/tampered/reclaim-race behavior in `src/runtime-paths.ts`.
- Keep custom help and internal test-identity validation ahead of bootstrap so rejected invocations perform no migration.
- Remove the redundant daemon-client migration and obsolete foreground-only classifier/wrapper; do not leave test-only production wrappers.
- Add no dependency and preserve exact pins and lockfile integrity.
- Review `codecov.yml` and `test/codecov-config.test.ts` atomically for classification accuracy after changing `bin/lcm.ts`; edit both only if the existing `bin/` ownership has become stale.
- Update user documentation and add one patch Changeset.
- Maintain 100% statement, branch, function, and line coverage for the complete collected production TypeScript scope.
- Do not commit, push, or publish from the implementation worker; the coordinator owns repository state and final workflow decisions.

---

### Task 1: Add one safe CLI-wide root-bootstrap retry boundary

**Files:**
- Modify: `test/bin/lcm-run-cli.test.ts`
- Modify: `test/bin/lcm-run-cli-boundaries.test.ts` if direct callback/import coverage requires alignment after obsolete exports are removed
- Modify: `test/runtime-paths.test.ts`
- Modify: `test/coverage-cli-runtime-path-errors.test.ts`
- Modify: `bin/lcm.ts`
- Modify: `src/runtime-paths.ts` only for the typed contention message; do not change lock acquisition, authentication, or reclamation logic
- Review together; modify only if classification is stale: `codecov.yml`, `test/codecov-config.test.ts`
- Modify: `docs/daemon-restart-recovery.md`
- Create: `.changeset/steady-bootstrap-retries.md`

**Interfaces:**
- Consumes: `BootstrapLockContentionError`, `migrateLegacyHomeIfNeeded()`, and the existing preflight seam accepted by `runCli()`.
- Produces:

```ts
export type RootBootstrapRetrySeams = {
  readonly migrate: () => unknown;
  readonly sleep: (delayMs: number) => Promise<void>;
  readonly attempt?: (attempt: number) => void;
};

export async function migrateLegacyHomeWithRetry(
  seams: RootBootstrapRetrySeams,
): Promise<void>;
```

- [ ] **Step 1: Add ordinary-command and single-boundary RED regressions**

In `test/bin/lcm-run-cli.test.ts`, add a test named `retries transient root bootstrap contention for an ordinary command`. Configure `state.migrateLegacyHome` to throw one real `actualRuntimePaths.BootstrapLockContentionError` and then succeed. Use fake timers, start `invoke(["search", "q"])`, advance 50 milliseconds, and assert that `/search` dispatches successfully. Assert migration ran exactly twice—not three times—so the same test requires both initial retry and removal of the redundant daemon-client migration.

Add a preservation test for an immediately successful `search` that asserts migration runs exactly once. The production mutations these tests catch are direct fail-fast preflight, retaining the duplicate daemon-client migration, and retrying at more than one boundary.

- [ ] **Step 2: Run the ordinary-command tests RED**

```bash
npm exec -- vitest run test/bin/lcm-run-cli.test.ts \
  -t "root bootstrap contention for an ordinary command|single root bootstrap"
```

Expected: the transient test fails because non-foreground `runCli()` rethrows; the single-boundary test fails because daemon-backed commands currently migrate twice.

- [ ] **Step 3: Add direct policy RED tests**

Import the wished-for `migrateLegacyHomeWithRetry()` helper and add tests that prove:

- one typed contention followed by success records attempts `[1, 2]`, calls migration twice, and sleeps once with literal `50`;
- 20 typed contention failures make 20 migration calls, 19 sleeps of literal `50`, record attempts `1` through `20`, and rethrow the exact same error object;
- plain `Error` values with these exact messages each make one call and no sleep:
  - `LCM root bootstrap owner state is ambiguous`
  - `LCM root bootstrap stale-lock recovery is already in progress`
  - `bootstrap lock changed during stale-owner recovery`
  - `LCM root bootstrap lock was claimed concurrently`
  - `LCM root bootstrap lock could not be authenticated`
  - `non-contention migration failure`

The production mutations these tests catch are wrong bounds, wrong delay, message matching, or error replacement.

- [ ] **Step 4: Run the direct policy tests RED**

```bash
npm exec -- vitest run test/bin/lcm-run-cli.test.ts \
  -t "root bootstrap retry policy|does not retry"
```

Expected: FAIL because the general helper does not exist.

- [ ] **Step 5: Strengthen real runtime security controls before implementation**

In `test/runtime-paths.test.ts`, tighten `preserves a bootstrap lock owned by a live matching process` so the Linux/trusted-witness branch asserts the exact constructor is `BootstrapLockContentionError`; retain the platform fallback that accepts only the existing ambiguous plain `Error` when no trusted start witness exists.

Use existing deterministic cases in `test/coverage-cli-runtime-path-errors.test.ts` as real runtime controls and tighten assertions where necessary so they prove these results are **not** `BootstrapLockContentionError` while preserving evidence:

- malformed/tampered owner metadata;
- ambiguous owner liveness/start witness;
- concurrent live reclaim claim (`recovery is already in progress`);
- replacement during stale-owner recovery (`changed during stale-owner recovery`); and
- concurrent successor after stale removal (`claimed concurrently`).

Keep the existing definitively stale-owner success test as the recovery control. These tests exercise real `bootstrapLcmHome()` / `migrateLegacyHomeIfNeeded()` behavior, not fabricated helper inputs.

- [ ] **Step 6: Run runtime security controls GREEN before the CLI change**

```bash
npm exec -- vitest run test/runtime-paths.test.ts \
  test/coverage-cli-runtime-path-errors.test.ts \
  -t "live matching process|tampered owner metadata|owner state is ambiguous|recovery is already in progress|changed during stale-owner recovery|claimed concurrently|definitively dead owner"
```

Expected: the strengthened controls pass against the existing secure runtime implementation. If an assertion fails, fix the test only when it mischaracterized current authenticated behavior; do not alter runtime lock logic.

- [ ] **Step 7: Add safe exhaustion-rendering RED coverage**

In `test/bin/lcm-run-cli.test.ts`, extend `covers standalone parsing and entry guard fallbacks` or add a focused `handleCliError` test using a `BootstrapLockContentionError` whose message is the desired safe operator text. Assert `console.error` receives only `.message`, never the error object, and `exit(1)` is used. Preserve the generic-error test that still receives the original error object.

Add a message assertion in `test/runtime-paths.test.ts` requiring the live-owner typed error to include all of:

- `verified live owner`
- `automatic lock recovery was not attempted`
- `retry after the competing LCM operation completes`
- `do not delete the bootstrap lock manually`

- [ ] **Step 8: Run exhaustion-rendering tests RED**

```bash
npm exec -- vitest run test/bin/lcm-run-cli.test.ts test/runtime-paths.test.ts \
  -t "bootstrap contention|live matching process|standalone parsing"
```

Expected: `handleCliError()` currently logs the error object and the runtime message lacks the new safe guidance.

- [ ] **Step 9: Implement the minimal single-boundary fix**

In `bin/lcm.ts`:

1. Rename the retry constants and seam type from foreground-specific names to root-bootstrap names.
2. Add `migrateLegacyHomeWithRetry()` with the exact 20-attempt/50-millisecond loop and concrete error-type gate.
3. Delete `isForegroundDaemonStartArgv()` and `migrateLegacyHomeForForegroundDaemonStart()` plus their imports/tests; do not leave test-only wrappers.
4. After help and internal test-identity validation, make every `runCli()` invocation await `migrateLegacyHomeWithRetry()` with the injected or production seams.
5. Remove `migrateLegacyHomeIfNeeded()` from `createDaemonClientOrExit()`; do not add a second retry or mutable memo.
6. Make `handleCliError()` render `BootstrapLockContentionError.message` like the existing expected user-facing error classes while generic errors still log as objects.

In `src/runtime-paths.ts`, change only the live-owner typed contention message to the exact safe guidance required by Step 7. Do not change acquisition, owner-state classification, stale reclamation, or cleanup.

- [ ] **Step 10: Run focused GREEN verification**

```bash
npm exec -- vitest run test/bin/lcm-run-cli.test.ts \
  test/bin/lcm-run-cli-boundaries.test.ts \
  test/runtime-paths.test.ts \
  test/coverage-cli-runtime-path-errors.test.ts
npm run typecheck
```

Expected: all selected tests and both TypeScript configurations pass. A normal daemon-backed command migrates once, transient contention waits no more than 950 milliseconds total, and every untyped unsafe/reclaim state remains immediately non-retryable.

- [ ] **Step 11: Review Codecov classification, document, and add release metadata**

Confirm `bin/lcm.ts` remains exclusively owned by `unit-cli` through the existing `bin/` path and `src/runtime-paths.ts` remains exclusively owned by `unit-configuration-security`. Run:

```bash
npm exec -- vitest run test/codecov-config.test.ts
```

If classification is accurate, leave both taxonomy files unchanged. If it is stale, update `codecov.yml` and `test/codecov-config.test.ts` atomically before proceeding.

Replace the foreground-only section in `docs/daemon-restart-recovery.md` with a CLI-wide root-bootstrap contention section. Document one fixed 20-attempt/50-millisecond/950-millisecond invocation budget; the typed verified-live-owner-only trigger; removal of duplicate daemon-client bootstrap; immediate fail-closed behavior for ambiguous, malformed, tampered, stale-recovery, and concurrent-reclaim states; safe retry after the competing operation; and the explicit prohibition on manual lock deletion. Do not claim that `lcm doctor` diagnoses the bootstrap lock.

Create `.changeset/steady-bootstrap-retries.md`:

```md
---
"@donadiosolutions/lcm": patch
---

Retry short authenticated root-bootstrap contention once across CLI startup so read-only commands such as `lcm search` continue after a competing bootstrap completes, while ambiguous or unsafe lock states still fail closed.
```

- [ ] **Step 12: Run full verification**

```bash
npm run lint
npm run typecheck
npm run build
npm run test:ci
git diff --check
git status --short
```

Expected: every command succeeds; `npm run test:ci` reports 100% statements, 100% branches, 100% functions, and 100% lines for the complete collected scope; only the planned implementation, tests, documentation, design/plan, and Changeset are modified.
