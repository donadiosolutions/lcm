# Copilot Review Instructions — Long Context Manager (LCM) (lcm)

This repo is a TypeScript SQLite daemon that persists Agent session memories across context resets. It uses Node.js `DatabaseSync` (synchronous SQLite API) and exposes an HTTP daemon with REST routes.

## Primary concerns

### Database connection pattern (highest priority)

- All SQLite access MUST use `getLcmConnection()` and `closeLcmConnection()` from the shared connection module. Flag any `new DatabaseSync(...)` instantiated directly in route handlers or utility files.
- The shared connection ensures WAL mode and foreign key enforcement are set once at open time.
- Flag double-open patterns: calling `getLcmConnection()` without a corresponding `closeLcmConnection()` on all exit paths.

### PRAGMA enforcement

- If a new connection is ever opened directly (e.g., in migration scripts), it must immediately set:
  - `PRAGMA journal_mode=WAL`
  - `PRAGMA foreign_keys=ON`
- Flag connections missing these PRAGMAs.

### Type safety

- No implicit `any`. All function parameters, return types, and object shapes must be explicitly typed.
- Flag `as any` casts unless accompanied by a comment explaining why it's necessary.
- Route handler request/response objects must use typed interfaces, not `any`.

### `collectStats()` performance

- `collectStats()` takes ~13 seconds due to full-table scans. It must NEVER be called in:
  - HTTP request handlers
  - Any path that runs more than once per user action
  - Startup initialization (lazy evaluation only)
- Flag any `collectStats()` call that isn't in a dedicated stats endpoint or background job.
- In synchronous redaction paths, zero-width regex matches must reuse cached token boundaries, skip to the end of the consuming range, and avoid collecting duplicate ranges. Flag per-match rescans of the same token or one range allocation per character.
- At a token-end boundary, a zero-width positive lookbehind identifies the preceding token, while a whitespace lookahead identifies the following token. Require regressions for both directions when changing zero-width range selection.
- Do not derive zero-width token direction from the entire regex source when mixed assertions or alternatives can match different branches. Determine direction from the active match or redact every plausible adjacent token.
- Range skipping after a zero-width match must not hide a later consuming alternative that starts inside the expanded token and extends beyond it. Preserve such alternatives while retaining bounded work for pure repeated-zero patterns.
- Regex syntax detection must skip escaped characters and character classes; text such as `(?<=` inside `[...]` is not a lookbehind assertion.
- Parse user-configured regex source with one linear scanner; avoid nested or overlapping quantifier regexes that can backtrack over long escaped sequences.
- Cache immutable regex-source analysis when each scrub pattern is constructed; token-by-token collection must not reparse the same source.
- Skip empty segments from whitespace-preserving token splits before executing scrub patterns.
- Detached lookahead probes cannot preserve captures or assertions that inspect text before the anchor. Treat backreferences and nested lookbehinds as ambiguous, fail closed across plausible token boundaries, and require regressions for both dependency types.
- Normalize sensitive-data category metadata by trimming and filtering entries before joining or applying the `unknown` fallback. Whitespace-only arrays must never render an empty `pattern:` warning.

### Test coverage

- New HTTP routes must have corresponding tests in `test/daemon/routes/`.
- Tests should cover: happy path, missing required fields (400), and resource-not-found (404).
- Flag PRs adding routes without tests.
- Never delete legacy parsing fallbacks or defensive handling for non-`Error` thrown values merely to satisfy coverage. Cover those branches with deterministic failure injection while preserving compatibility behavior.
- Hook command or protocol changes must be searched and aligned across user docs, bundled hook READMEs and skill checklists, installer command registrations, and E2E tests.
- Test-only numeric capacity and limit seams must reject non-positive, non-integer, and non-finite values before mutating shared state.

### Search ranking compatibility

- Fallback lexical-search ranks and sentinel scores must remain compatible with every consumer, including deduplication thresholds, prompt-search minimum scores, and result ordering. Require regressions that both surface relevant fallback matches and prevent false deduplication merges, while preserving native FTS ranking behavior unchanged.
- Apply exact fallback-search filters before the caller's result limit; filtering an already-limited candidate set can hide lower-ranked qualifying rows.

### SQLite transaction safety

- Any operation that modifies more than one table must be wrapped in `BEGIN`/`COMMIT`.
- Flag multi-table writes without transactions — they risk partial writes on crash.
- Keep checkpoint/count reads, slices derived from those checkpoints, and their inserts in the same repository transaction; otherwise concurrent ingestion can invalidate sequence allocation before the write begins.
- Transaction context is global across SQLite project executors: reject nested transactions and ordinary repository calls on any project while a transaction callback is active, preventing lock inversion and partial cross-project commits. These transaction-contract errors take precedence over poisoned-handle errors. If transaction rollback fails, preserve the original sanitized operation error while poisoning queued access and evicting the exact pooled handle generation.
- For transaction-scoped atomic savepoints, poison the executor only when `ROLLBACK TO SAVEPOINT` fails. Once rollback succeeds, a later `RELEASE SAVEPOINT` cleanup failure stays sanitized but must not fence the outer transaction because the operation's writes were already undone.
- A failure to open a transaction-scoped SQLite savepoint happens before its callback or writes: normalize the driver error and release the per-token FIFO without recovery SQL, token failure, or poisoning. A caught failure may continue and commit if later scoped work succeeds; an uncaught failure uses the outer rollback path, whose own failure still poisons the handle.
- Serialize transaction-scoped atomic savepoint lifecycles per SQLite transaction token. Concurrent repository calls sharing one token must never interleave `SAVEPOINT`, rollback, or release operations, queued work must revalidate that the token is still active before touching the database, and recursive same-token atomic calls must fail promptly instead of waiting on their own queue entry.
- Direct `ConversationStore.withTransaction()` reuse must preserve an operation-level savepoint around every public atomic batch method. A caller may catch one method failure and commit unrelated outer work without retaining that method's partial writes; serialize sibling savepoints per live same-handle token and reject recursive same-token atomic entry instead of self-deadlocking. Never expose a public flag or overload that lets direct callers bypass the atomic wrapper; repository adapters must use a private or internal instance-bound core seam.
- Direct `ConversationStore.withTransaction()` rollback recovery must preserve the exact original operation, drain, or commit failure when `ROLLBACK` also fails. Retry rollback only as bounded best-effort, fence later direct transactions when the handle remains unsafe, and recheck the fence after queued waits. Savepoint ordinals are transaction-local bounded state: concurrent siblings receive distinct FIFO names, and each new outer transaction restarts at zero.
- PostgreSQL advisory-lock get-or-create and row-lock append transactions must explicitly establish `READ COMMITTED` before their first lock or read on every retry. A configured `REPEATABLE READ` default can otherwise retain a pre-lock snapshot and miss the winning transaction's insert after waiting.
- Public store transaction helpers that call other atomic store methods must carry an active transaction token scoped to the exact database handle. Reuse only that live same-handle transaction; otherwise preserve normal per-handle serialization instead of recursively queueing behind the active operation.
- PostgreSQL APIs with unbounded batch inputs must keep the bind count constant through typed set-valued payload expansion, while preserving caller order and single-statement or transaction atomicity.
- PostgreSQL generated `bigint` identities exposed as JavaScript numbers must be mapped before their write transaction commits; post-autocommit safe-integer validation can reject the result while leaving an unusable row behind.
- Validate every batch element before the first write. Message sequences, token counts, and part ordinals must be non-negative safe integers in both SQLite and PostgreSQL so an invalid later element cannot leave partial rows behind.
- Reject embedded U+0000 before database access across all conversation-domain text inputs: conversation session/title values and session lookups, message content writes and exact-content lookups, every message-part text field, and message search queries where supported. Preserve every other character and keep validation errors value-free.
- PostgreSQL searchable-token limits apply after normalization and text parsing: #89 must test the 2,046-byte PostgreSQL 18 UTF-8 safe lexeme boundary and implement lossless handling before #224 enables application writes; do not substitute a raw whitespace-token limit or truncate canonical content.
- Preserve backend-neutral pagination sentinels: a negative message limit is unlimited, zero returns no rows, and only nonnegative limits belong in PostgreSQL `LIMIT` SQL.
- Backend health must apply the same integrity and write-readiness probe to active project scopes and databases retained from completed request scopes; never infer health from `SELECT 1`, `BEGIN IMMEDIATE` alone, or an empty active-project set. Prove SQLite writability with rollbacked main-schema DDL using a unique quoted internal table name, always roll back after `BEGIN`, and leave no probe object behind. If rollback fails, poison queued access and evict the exact pooled handle generation; stale scope releases must not decrement a replacement generation. SQLite timestamps produced by `CURRENT_TIMESTAMP` are timezone-free UTC and must be parsed and formatted explicitly as UTC.

### Migration safety

- Prefer additive schema migrations: `ADD COLUMN`, `CREATE TABLE`, `CREATE INDEX`.
- When an incompatible virtual table must be replaced, require a staged migration that snapshots its data, replaces and restores it within one transaction, and proves rollback plus data preservation in tests.
- Flag `DROP COLUMN`, `DROP TABLE`, `ALTER COLUMN type`, or other destructive DDL outside such a tested staged replacement.
- Migrations must be idempotent (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`).
- Multi-statement schema bootstrap and repair paths, including schema-version writes, must run in one explicit transaction and roll back every partial DDL or metadata change on failure.

### Error handling

- Installed best-effort hook wrappers must use secret-free stored-configuration projections and must not resolve remote-backend credentials before the handler's fail-open boundary. Manual CLI, daemon, and MCP paths must continue using fully resolved, fail-closed configuration.
- Any started CLI renderer must be stopped in a `finally` block so failures cannot leave its render loop active.
- Route handlers must catch errors and return structured JSON: `{ error: string, code?: string }`.
- Flag `res.send(e.message)` or unstructured error responses that leak stack traces.
- Unhandled promise rejections in route handlers are bugs — flag missing `try/catch` in `async` handlers.
- Every operation on a closeable factory or repository must reject after close, including retained repository references closed through factory shutdown. Keep `close()` idempotent; best-effort restoration failures must never prevent pool/reference release or registry/cache cleanup. Assert sanitized, cause-free post-close errors and cleanup-failure behavior in tests.
- User-facing child-process errors must not include raw stdout or stderr; use an allowlisted summary and bound all user-controlled metadata before interpolation.
- Child-process timeout cleanup must guard `kill()` because the process can exit concurrently or the injected process implementation can throw.
- Provider CLI option enums must match the provider's configuration schema, not broader model capability labels exposed elsewhere in the product.
- When disabling a provider feature that also selects a related tier or mode, explicitly reset both process-local settings so global configuration cannot remain partially active.
- Keep shared process-adapter error sanitization, metadata bounding, and compatibility formatting in one helper rather than duplicating it across providers.
- Validation errors must report resolved effective values; do not hard-code the required value as though it were the current configuration.
- When an environment or credential secret is validated after trimming whitespace, return and propagate that canonical trimmed value rather than the original raw string.
- Treat a successful child-process exit with empty output as an empty-output failure, not a CLI rejection.
- Registry subprocess failures must expose only bounded, allowlisted summaries; never include raw registry values, stdout, stderr, thrown messages, or causes in user-facing errors.
- When a provider supports no values for an optional control, say the control is unsupported; do not render an empty set as `Valid values: none`.
- Retry and backoff duration accounting must use a monotonic clock so wall-clock corrections cannot shorten or extend a wait.
- Validate runtime numeric overrides with `Number.isFinite()` before timeout arithmetic or interpolation into SQL/PRAGMA statements. Invalid values must preserve the documented default; tests must cover `NaN`, positive and negative infinity, and any clamp/truncation behavior. Security-sensitive timer scheduling must keep user-derived values out of `setTimeout` durations by using literal constants only.
- Reject executable directories containing the platform PATH delimiter before composing a restricted child-process `PATH`; otherwise one trusted path can inject additional search directories or the current directory.
- Managed-daemon executable search paths must reject project containment before recognizing global-install or bundled-runtime anchors; a project-local `.codex`, `.claude`, or package-manager-shaped directory is untrusted. Never add `npx`, any `node_modules` directory, the current project or its checkout ancestors, or ambient `PATH` entries.
- Diagnostics for a reused managed daemon must inspect that verified process's effective environment before using a deterministic startup fallback. Never reuse a PID from the initial health probe when lifecycle validation fails or throws.
- `DaemonClient` health-response deserialization must normalize a missing `storageBackend` to `sqlite` for compatibility with legacy daemons; do not treat the omitted field as a backend mismatch.
- Every shared daemon-client helper must select and preflight the resolved storage backend before calling `ensureDaemon()` or entering any daemon lifecycle path.
- Parent daemon start and restart flows must select and validate the storage backend before signaling an existing process or spawning a replacement.
- Authenticate the managed daemon token before every transition involving a storage-backend mismatch, including combined version-and-backend mismatches. Bind authentication to the exact PID ultimately signaled by revalidating the PID file and endpoint identity immediately before termination; never kill based only on a PID, health response, or reported backend.
- Authenticated termination succeeds only after confirming that the process died. If termination or death confirmation fails, preserve its PID state and do not spawn a replacement.
- Doctor configuration-validation failures are observational: report them without repairing or transitioning the daemon using a recovered, unvalidated backend value.
- Fail-closed daemon lifecycle results must include a sanitized, actionable warning that identifies the blocked transition without exposing tokens, credentials, or raw endpoint details.
- Never reproduce raw child-process stdout, stderr, or thrown error text in daemon lifecycle warnings. Use an allowlist-only process summary containing safe classifications, recognized error codes, validated signals, or bounded numeric exit status.
- PostgreSQL connection URLs must be hierarchical and include a non-empty hostname; reject opaque forms even when the platform URL parser accepts them.
- Normalize bracketed IPv6 URL hostnames before passing them to PostgreSQL clients or TLS identity checks.
- Abort-aware pooled PostgreSQL queries must recheck cancellation after asynchronous setup, await any in-flight backend cancellation before settlement, and destroy the target connection whenever abort was observed so a late cancel cannot hit a subsequent borrower.
- PostgreSQL repository savepoints must be owned by the active runtime transaction: serialize outer queries and complete savepoint lifecycles, use runtime-generated identifiers and a temporary drained inner executor, and use async-context provenance to reject outer or nested scope calls made inside the callback. Independent siblings must queue behind the lifecycle, while captured inner executors reject after settlement. Recover only ordinary SQL or post-query mapping failures after both `ROLLBACK TO` and `RELEASE` succeed; every open, control, connection, or abort failure must poison the outer transaction.
- Signal cleanup for resource-owning test harnesses must quiesce in-flight creation commands before inspecting labels or removing resources. Bound captured child output while retaining a useful diagnostic tail.
- Process-owner recovery must probe PID existence before comparing a portable birth fingerprint (`/proc` plus boot ID on Linux, `ps` on macOS, PowerShell CIM on Windows). Treat only `ESRCH` or PID-specific disappearance as stale; unsupported, denied, malformed, or missing platform identity evidence is ambiguous. Track surviving local child consumers explicitly, and preserve stale-parent Docker runs while a labeled runner/restore container or recorded consumer remains live.
- Configuration and CA-file preflight must accept only bounded regular files. Reject directories, FIFOs, devices, and oversized files before reading them.
- Return and propagate the canonical path established by file preflight; do not validate a resolved path and then retain an unvalidated alias.
- Dispatch tests must cover non-default storage-backend propagation through every backend-aware handler, while retaining the default SQLite cases.
- Staged unsupported storage backends must be selected and fail closed before any legacy SQLite read, write, or enumeration, including portable import/export, stats, and diagnostic paths; never fall back silently to SQLite.
- SQLite hook-outbox capture and persistence must complete before daemon-readiness checks; token-bearing or other network notification and daemon-dependent work must remain after verified daemon readiness.

### GitHub Actions and CodeQL

- When a workflow checks out a verified commit SHA, use `HEAD` for ancestry checks against that checkout instead of assuming its tag ref was fetched.
- Required CI and CodeQL workflows that validate synthetic merge-queue commits must retain the `merge_group` trigger with the `checks_requested` activity type. This requirement does not apply to the provider-driven `external-admission.yml`; `external-admission-merge-group.yml` handles synthetic admission.
- Keep `external-admission.yml` limited to authenticated provider `check_run` events, exact canonical CI `workflow_run` events, and default-branch `external-admission-reconcile` repository dispatch; never add a pull-request lifecycle trigger to this write-capable workflow. Authenticate checks by application ID, slug, and exact name. Accept CI wake-ups only for `event=pull_request`, `path=.github/workflows/ci.yml`, the exact repository, and the event head SHA; reject push and merge-group CI runs before a runner starts. Coverable or trust-sensitive diffs require `Greptile Review` from Greptile plus DCO; other diffs require `ci` from the GitHub Actions app plus DCO. All required successes must be on the exact head SHA of an open, non-draft PR targeting `main`.
- Treat admission as a stateless event reducer. Provider and CI created, requested, rerequested, or in-progress events revoke stale success and stop before policy checkout; completion and recovery events evaluate one fresh snapshot and exit. Never add a runner-resident polling loop. Leave incomplete or transient evidence pending for the next authenticated provider event, canonical CI lifecycle event, or repository-dispatch reconciliation.
- Workflow concurrency is evaluated before a job `if`; keep the canonical CI `workflow_run` exact-SHA group predicate identical to the job trust predicate, and route rejected workflow runs to a run-ID-specific fallback group so they cannot cancel eligible evaluation.
- Trusted status-write recovery must use the default-branch `repository_dispatch` event, never branch-selectable `workflow_dispatch`. Accept only `external-admission-reconcile` with `client_payload.head_sha`, and normalize that hexadecimal SHA to lowercase before status writes, PR association, or policy comparison.
- Classify admission using the complete paginated PR-file response, require its flattened record count to exactly equal the pull request's authoritative `changed_files`, and audit both `filename` and `previous_filename`. Require Greptile for executable `.ts`, `.tsx`, `.mts`, or `.cts` TypeScript under `bin/`, `installer/`, or `src/`; `.github/actions/`, `.github/codeql/`, `.github/workflows/`, and `.github/scripts/`; `package.json`, its lockfile, and Vitest or TypeScript configuration. The neutral path must validate the successful CI check's Actions run metadata: `event=pull_request`, `path=.github/workflows/ci.yml`, exact repository, and exact head SHA, with explicit `actions: read` permission for the run lookup. A successful aggregate `ci` check is not sufficient while its backing workflow run is transient; admit only terminal success and leave every documented nonterminal state pending.
- Every authenticated provider event with a valid commit SHA must publish a non-success external-admission status before checkout, PR association, or eligibility lookup, because GitHub may omit closed unmerged PRs from a commit's PR associations. Paginate and flatten every page of commit-associated PRs, changed files, and check runs before deciding uniqueness or success. Admit only one open, non-draft, main-targeting PR at the exact event SHA. Immediately before success, repeat PR uniqueness and eligibility, file classification, required-check evaluation, and neutral CI-run provenance validation; missing, changed, or ambiguous evidence remains non-successful.
- Load executable admission policy only from the trusted workflow revision using the pinned checkout action, a minimal sparse checkout, and `persist-credentials: false`; never execute policy from the PR head. The write-capable `workflow_run` path must never download CI artifacts or caches or execute PR-controlled content. Admission workflow or policy changes cannot self-admit new logic that is not yet on the default branch, so their initial rollout requires an explicitly documented one-time maintainer bootstrap before returning to the normal no-bypass flow.
- Keep `external-admission-merge-group.yml` limited to its `merge_group` / `checks_requested` trigger and permissionless Actions job named `external-admission`; it does not publish a commit status. CI, all required CodeQL categories, and both Socket checks must still validate the synthetic commit.
- Keep Codecov reporting in mutually exclusive read-only CI jobs. Checkout uses the job token to fetch `github.repository` at `github.sha`, but must set `persist-credentials: false` so credentials are not persisted. The jobs consume only the fixed CI artifact and never execute repository code. Pull-request artifacts are generated from the synthetic merge commit at that workflow SHA, not the PR head; keep `override_pr` solely for Codecov PR association. The trusted job must grant and use OIDC only for pushes and same-repository PRs (including Dependabot); the fork-PR job must omit OIDC permission and use tokenless uploads. Both jobs remain skipped for `merge_group`. Enforce the no-execution boundary with an exact allowlist of permitted `run:` step names and scripts, never a runtime-name blacklist.
- Every newly added CI matrix or sibling test job must feed a stable required aggregate check; required admission must fail when any matrix leg fails or is skipped.
- CodeQL SARIF upload remains required on merge groups using the pinned build-mode-none CodeQL actions.
- Advanced CodeQL workflows require GitHub default setup to be disabled before they upload SARIF.
- Keep CodeQL analysis enabled for fork pull requests, but set the analyze action's `upload` input to `never` for fork-origin pull requests and `always` for merge groups, same-repository pull requests, and pushes.
- Grant `security-events: write` only on the CodeQL analysis job that uploads SARIF; job-level permissions must restate every required read permission because they replace workflow defaults.
- Follow least privilege in workflow `permissions`; omit `packages: read` unless a step actually reads packages.
- Set `persist-credentials: false` on checkout steps in read-only workflows.
- Release-run recovery must read the canonical event tag from the workflow's strict `run-name`; do not infer historical tags from `head_branch`, a commit SHA, or another mutable/ref-derived field.
- Persist manual Changesets beta/stable intent on the single open `changeset-release/main` PR with exactly one internal release-channel label, and fail closed on duplicate PRs or conflicting channel labels.
- When replacing a generated workflow, update README badges and links to the new workflow filename.
- Production-path allowlists must cover the generated npm runtime and shipped
  native connector templates, not only the primary source directories.
- Keep CodeRabbit and Copilot out of required status checks and external-admission authentication. External admission authenticates only Greptile Review, DCO, or CI according to the file classification.

## What to skip

- Don't flag `DatabaseSync` usage in test fixtures that mock the connection — context matters.
- Don't flag TypeScript-specific patterns that are idiomatic (e.g., discriminated unions, assertion functions).
