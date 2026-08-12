# Root Bootstrap Contention Design

## Objective

Close GitHub issue #673 by making normal LCM CLI invocations tolerate a short,
authenticated root bootstrap that is already in progress. A command continues
automatically when the live owner releases the lock within one bounded window,
while malformed, ambiguous, stale-recovery, or otherwise unauthenticated states
remain fail-closed and untouched.

## Root Cause

`migrateLegacyHomeIfNeeded()` acquires the authenticated
`.lcm-root-bootstrap.lock` even when the active runtime root already exists.
`runCli()` calls this migration before command parsing. Daemon-backed actions
then call it redundantly from `createDaemonClientOrExit()`, creating a second
same-process bootstrap boundary. Only the managed foreground daemon argv
currently retries `BootstrapLockContentionError`; ordinary commands fail
immediately if the first bootstrap overlaps a live authenticated owner. The
lock can disappear before the operator investigates, which explains why a
serialized retry succeeds without cleanup or daemon restart.

## Considered Approaches

### 1. One bounded bootstrap at the process entry boundary

This is the selected design. Generalize the existing 20-attempt,
50-millisecond policy to every non-help `runCli()` invocation and remove the
redundant daemon-client migration. The complete invocation then has exactly one
retry budget: at most 19 sleeps, or 950 milliseconds. The foreground-only argv
classifier and wrapper become obsolete and are removed rather than retained as
test-only production code.

This fixes `lcm search`, eliminates the second same-process TOCTOU window, and
does not require command allowlists, process-scoped mutable flags, or nested
retry budgets.

### 2. Keep both boundaries and share one invocation budget

Threading an attempt or deadline object through command registration and
daemon-client creation could cap the aggregate at 950 milliseconds. It adds
state and plumbing solely to preserve a redundant migration, so it is rejected.

### 3. Memoize successful migration for daemon-client creation

A process-scoped boolean could skip the second migration after `runCli()`
succeeds. The same guarantee is expressed more clearly by removing the duplicate
call. A mutable memo would also complicate repeated `runCli()` calls in tests or
embedded consumers, so it is rejected.

### 4. Retry only selected read-only commands

An argv allowlist would duplicate command classification before Commander
parsing and let new commands regress silently. Bootstrap admission protects the
runtime root independently of whether the eventual command is read-only or
mutating, so every non-help invocation can safely use the same bounded wait.

### 5. Keep commands fail-fast and add diagnostics only

Diagnostics would make contention easier to investigate but would not remove
the normal transient failure. Bounded retry is the primary correction. The
exhaustion path will still print a concise actionable message without a stack
dump, identify the authenticated live-owner condition, say that no unsafe lock
recovery was attempted, and explicitly tell operators not to delete the lock
manually.

## Detailed Design

Rename the foreground-specific constants and seam to represent root-bootstrap
retry generally. Add an exported internal helper accepting a synchronous
migration operation, asynchronous sleep operation, and optional attempt
observer. It attempts migration up to 20 times. After attempts 1 through 19
throw the concrete `BootstrapLockContentionError`, it sleeps for 50 milliseconds
and retries. Success returns immediately. Attempt 20 rethrows the same error
object. Every other thrown value is rethrown immediately without sleeping.

`runCli()` preserves custom-help and internal-identity validation before any
filesystem work, then invokes the helper exactly once before package loading and
Commander registration. `createDaemonClientOrExit()` stops calling
`migrateLegacyHomeIfNeeded()`: every production route to that function is an
action registered and dispatched by the already-preflighted `runCli()` process.
Direct command-registration tests mock daemon behavior and do not establish a
second production bootstrap contract.

The old `isForegroundDaemonStartArgv()` and
`migrateLegacyHomeForForegroundDaemonStart()` exports and their exact-argv tests
are deleted because all non-help invocations now share one production retry
path. The managed foreground process retains the same 950-millisecond maximum
it had before.

`handleCliError()` recognizes `BootstrapLockContentionError` and prints only its
safe message. The runtime error text is updated to explain that a verified live
owner remained active through the bounded wait, no automatic lock recovery was
attempted, the operator should retry after the competing LCM operation ends,
and the lock must not be manually deleted. The message does not expose raw lock
metadata or claim that `lcm doctor` diagnoses this lock.

## Error Handling and Security

- The retry trigger is the concrete `BootstrapLockContentionError` class, never
  message matching.
- Only `acquireBootstrapLock()`'s authenticated live matching owner branch
  constructs that class.
- Exhaustion rethrows the original object and renders its message without a
  stack trace.
- The helper never inspects, deletes, renames, reclaims, or otherwise mutates a
  lock; each attempt re-enters the secure runtime implementation.
- Definitively stale owners continue through existing authenticated race-safe
  reclamation. Ambiguous owners, malformed/tampered metadata, live PIDs with an
  unavailable start witness, concurrent reclaim claims, a lock changed during
  stale-owner recovery, and a lock claimed concurrently remain ordinary
  `Error` values and fail immediately. Those untyped reclaim races are
  deliberately out of retry scope because they do not prove one authenticated
  live bootstrap owner. No message-matching exception is added.
- One fixed 950-millisecond budget is below the 10-second Codex hook timeout;
  removing the duplicate daemon-client migration prevents wait amplification.
- Help preflight remains before bootstrap and has no migration side effects.

## Verification

Strict test-first coverage will prove:

- an ordinary `lcm search` retries typed contention at the sole `runCli()`
  bootstrap and dispatches after the lock clears;
- the production delay is exactly 50 milliseconds;
- retry stops after 20 attempts, sleeps 19 times, and rethrows the same object;
- a daemon-backed command performs no second migration after successful
  preflight;
- active-owner runtime evidence produces the typed retryable error, while stale
  owners recover and ambiguous, malformed/tampered, and concurrent reclaim
  states remain untyped and fail closed without a retry sleep;
- exhausted contention is rendered as a safe actionable message without a
  stack dump;
- existing help and internal-identity side-effect fences remain intact; and
- fresh `npm run test:ci` reports 100% statements, branches, functions, and
  lines for the complete production TypeScript scope.

Update daemon recovery documentation and add a patch Changeset because the fix
changes user-visible CLI behavior. Review `codecov.yml` and
`test/codecov-config.test.ts` atomically against the modified production file;
the existing `bin/` ownership is expected to remain accurate, so no taxonomy
edit is expected unless that review finds stale classification.
