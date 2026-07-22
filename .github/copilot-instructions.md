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

### Search ranking compatibility

- Fallback lexical-search ranks and sentinel scores must remain compatible with every consumer, including deduplication thresholds, prompt-search minimum scores, and result ordering. Require regressions that both surface relevant fallback matches and prevent false deduplication merges, while preserving native FTS ranking behavior unchanged.
- Apply exact fallback-search filters before the caller's result limit; filtering an already-limited candidate set can hide lower-ranked qualifying rows.

### SQLite transaction safety

- Any operation that modifies more than one table must be wrapped in `BEGIN`/`COMMIT`.
- Flag multi-table writes without transactions — they risk partial writes on crash.
- Keep checkpoint/count reads, slices derived from those checkpoints, and their inserts in the same repository transaction; otherwise concurrent ingestion can invalidate sequence allocation before the write begins.
- Transaction context is global across SQLite project executors: reject nested transactions and ordinary repository calls on any project while a transaction callback is active, preventing lock inversion and partial cross-project commits.
- Backend health must probe databases retained from completed request scopes, not infer health from an empty active-project set. SQLite timestamps produced by `CURRENT_TIMESTAMP` are timezone-free UTC and must be parsed and formatted explicitly as UTC.

### Migration safety

- Prefer additive schema migrations: `ADD COLUMN`, `CREATE TABLE`, `CREATE INDEX`.
- When an incompatible virtual table must be replaced, require a staged migration that snapshots its data, replaces and restores it within one transaction, and proves rollback plus data preservation in tests.
- Flag `DROP COLUMN`, `DROP TABLE`, `ALTER COLUMN type`, or other destructive DDL outside such a tested staged replacement.
- Migrations must be idempotent (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`).
- Multi-statement schema bootstrap and repair paths, including schema-version writes, must run in one explicit transaction and roll back every partial DDL or metadata change on failure.

### Error handling

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
- Configuration and CA-file preflight must accept only bounded regular files. Reject directories, FIFOs, devices, and oversized files before reading them.
- Return and propagate the canonical path established by file preflight; do not validate a resolved path and then retain an unvalidated alias.
- Dispatch tests must cover non-default storage-backend propagation through every backend-aware handler, while retaining the default SQLite cases.
- Staged unsupported storage backends must be selected and fail closed before any legacy SQLite read, write, or enumeration, including portable import/export, stats, and diagnostic paths; never fall back silently to SQLite.
- SQLite hook-outbox capture and persistence must complete before daemon-readiness checks; token-bearing or other network notification and daemon-dependent work must remain after verified daemon readiness.

### GitHub Actions and CodeQL

- When a workflow checks out a verified commit SHA, use `HEAD` for ancestry checks against that checkout instead of assuming its tag ref was fetched.
- Required CI and CodeQL workflows that validate synthetic merge-queue commits must retain the `merge_group` trigger with the `checks_requested` activity type. This requirement does not apply to the provider-driven `external-admission.yml`; `external-admission-merge-group.yml` handles synthetic admission.
- Keep `external-admission.yml` limited to provider `check_run` events; never add a pull-request lifecycle trigger to this write-capable workflow. Authenticate `codecov/patch` and DCO by application ID, slug, and check name. Require both successes on the exact head SHA of an open, non-draft PR targeting `main`.
- Every authenticated provider event with a valid commit SHA must publish a non-success external-admission status before PR association or eligibility lookup, because GitHub may omit closed unmerged PRs from a commit's PR associations. Paginate and flatten every page of commit-associated PRs before deciding uniqueness. Admit only one open, non-draft, main-targeting PR at the exact event SHA, and repeat that complete validation immediately before publishing success; missing or ambiguous associations remain non-successful.
- Keep `external-admission-merge-group.yml` limited to its `merge_group` / `checks_requested` trigger and permissionless Actions job named `external-admission`; it does not publish a commit status. CI, all required CodeQL categories, and both Socket checks must still validate the synthetic commit.
- Keep Codecov reporting in the separate no-checkout CI job. It must use OIDC for pushes and same-repository PRs (including Dependabot), use tokenless uploads for fork PRs, consume only the fixed CI artifact, and remain skipped for `merge_group`.
- CodeQL SARIF upload remains required on merge groups using the pinned build-mode-none CodeQL actions.
- Advanced CodeQL workflows require GitHub default setup to be disabled before they upload SARIF.
- Keep CodeQL analysis enabled for fork pull requests, but set the analyze action's `upload` input to `never` for fork-origin pull requests and `always` for merge groups, same-repository pull requests, and pushes.
- Grant `security-events: write` only on the CodeQL analysis job that uploads SARIF; job-level permissions must restate every required read permission because they replace workflow defaults.
- Follow least privilege in workflow `permissions`; omit `packages: read` unless a step actually reads packages.
- Set `persist-credentials: false` on checkout steps in read-only workflows.
- Release-run recovery must read the canonical event tag from the workflow's strict `run-name`; do not infer historical tags from `head_branch`, a commit SHA, or another mutable/ref-derived field.
- Persist manual Changesets beta/stable intent on the single open `changeset-release/main` PR with exactly one internal release-channel label, and fail closed on duplicate PRs or conflicting channel labels.
- When replacing a generated workflow, update README badges and links to the new workflow filename.
- Production-path allowlists must cover shipped executable plugin scripts such as `.claude-plugin/`, not only the primary source directories.
- Keep automated reviewer selection out of required status checks and external-admission authentication. The current review provider is a process-level choice; CodeRabbit is informational, while external admission authenticates only Codecov patch and DCO.

## What to skip

- Don't flag `DatabaseSync` usage in test fixtures that mock the connection — context matters.
- Don't flag TypeScript-specific patterns that are idiomatic (e.g., discriminated unions, assertion functions).
