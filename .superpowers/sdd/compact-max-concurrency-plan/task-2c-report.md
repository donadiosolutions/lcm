# Task 2C report: CLI invocation lifecycle and fail-safe drain

## Scope and baseline

- Worktree: `/home/bcdonadio/.codex/worktrees/1a0d/lcm`
- Primary worktree: `/mnt/bcdtank/enc/oss/lcm`
- Branch: `feat/compact-max-concurrency`
- Base: `371f1d1643dea0876e27ab9c0ef806d48b5bcfde`
- No dependencies, pushes, PR operations, rebases, or primary-worktree edits.
- Daemon routes, provider implementations, and shared process teardown remain
  unchanged. The allowed read-only provider witness query was added.

## Implementation

- `NinjaRenderer` can delegate SIGINT/SIGTERM to a command-owned lifecycle and
  no longer exits when that delegation mode is selected. Legacy renderer users
  retain their existing default behavior; cleanup removes both signal handlers.
- Manual non-dry-run compact installs command signal handlers before config and
  daemon preflight, captures authenticated daemon identity, starts one UUID
  invocation, forwards invocation ID plus AbortSignal through compact and
  automatic promotion, heartbeats every 10 seconds, and finishes only after a
  targeted zero-active acknowledgement.
- First SIGINT/SIGTERM latches 130/143, aborts local dispatch, marks progress
  aborted, and starts drain. Repeated signals report draining without exit.
  Pre-registration signal paths avoid invocation registration and work dispatch.
- Cancellation uses a fresh non-aborted client, awaits local work, bounds
  cancel/health/retry work to ten seconds, retries exactly once only when the
  original daemon instance is still serving, and remains unproved without a
  verified managed restart. Restart acceptance requires stopped old PID,
  provider witness disappearance, and authenticated replacement identity,
  runtime digest, and storage backend.
- Foreground daemon signals await `daemon.stop()` before exit; synchronous
  compatibility fakes retain their prior behavior.
- Provider process witness reads are exposed as a side-effect-free snapshot
  query with malformed files failing closed.

## TDD evidence

RED-to-GREEN increments covered renderer delegation, invocation start/finish,
batch invocation forwarding, dry-run no-registration, signal cancel/drain,
heartbeat failure, SIGTERM precedence, repeated signals, preflight failure,
batch-failure precedence, deadline retry, restart identity proof, unsupported
provider disappearance, witness reads, heartbeat cleanup, and foreground daemon
stop ordering.

## Verification

Focused matrix:

```text
15 test files passed
579 tests passed
```

The matrix covered CLI, batch, renderer, daemon client/control/coordinator,
compact/promote routes, and process witness integration. Additional direct
runs covered the newly added foreground-stop and signal-precedence tests.

Additional gates passed:

- `npm run typecheck`
- Scoped ESLint for changed production and test files
- `git diff --check`
- Scoped pipeline-renderer coverage: 100% statements, branches, functions,
  and lines after the signal delegation tests.

The repository's complete `npm run test:ci` and final exact-head aggregate
coverage remain root-coordinator publication gates. A narrow changed-file
coverage run over only the selected CLI/process tests reports pre-existing
unexercised branches in the large `bin/lcm.ts` and `process-utils.ts` files;
this report does not waive the required full-repository gate.

## Changed files

- `bin/lcm.ts`
- `src/batch-compact.ts`
- `src/cli/pipeline-runner.ts`
- `src/llm/process-utils.ts`
- `test/batch-compact.test.ts`
- `test/bin/compact-lifecycle.test.ts`
- `test/bin/lcm-run-cli-boundaries.test.ts`
- `test/ninja-cli-coverage.test.ts`
- `test/llm/process-utils.test.ts`

## Concerns and follow-up gates

- The CLI keeps a compatibility path for old daemon responses or test doubles
  that do not expose an authenticated invocation identity; current packaged
  daemons are identity-aware and take the invocation path.
- Provider witness disappearance is deliberately fail-closed when the witness
  file is unreadable or malformed.
- Final full CI must certify complete all-file coverage after Task 3 metadata
  and documentation changes.
