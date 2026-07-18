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

### Test coverage
- New HTTP routes must have corresponding tests in `test/daemon/routes/`.
- Tests should cover: happy path, missing required fields (400), and resource-not-found (404).
- Flag PRs adding routes without tests.
- Never delete legacy parsing fallbacks or defensive handling for non-`Error` thrown values merely to satisfy coverage. Cover those branches with deterministic failure injection while preserving compatibility behavior.

### SQLite transaction safety
- Any operation that modifies more than one table must be wrapped in `BEGIN`/`COMMIT`.
- Flag multi-table writes without transactions — they risk partial writes on crash.

### Migration safety
- Prefer additive schema migrations: `ADD COLUMN`, `CREATE TABLE`, `CREATE INDEX`.
- When an incompatible virtual table must be replaced, require a staged migration that snapshots its data, replaces and restores it within one transaction, and proves rollback plus data preservation in tests.
- Flag `DROP COLUMN`, `DROP TABLE`, `ALTER COLUMN type`, or other destructive DDL outside such a tested staged replacement.
- Migrations must be idempotent (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`).

### Error handling
- Route handlers must catch errors and return structured JSON: `{ error: string, code?: string }`.
- Flag `res.send(e.message)` or unstructured error responses that leak stack traces.
- Unhandled promise rejections in route handlers are bugs — flag missing `try/catch` in `async` handlers.
- User-facing child-process errors must not include raw stdout or stderr; use an allowlisted summary and bound all user-controlled metadata before interpolation.
- Child-process timeout cleanup must guard `kill()` because the process can exit concurrently or the injected process implementation can throw.
- Provider CLI option enums must match the provider's configuration schema, not broader model capability labels exposed elsewhere in the product.
- When disabling a provider feature that also selects a related tier or mode, explicitly reset both process-local settings so global configuration cannot remain partially active.
- Keep shared process-adapter error sanitization, metadata bounding, and compatibility formatting in one helper rather than duplicating it across providers.
- Validation errors must report resolved effective values; do not hard-code the required value as though it were the current configuration.
- Treat a successful child-process exit with empty output as an empty-output failure, not a CLI rejection.
- When a provider supports no values for an optional control, say the control is unsupported; do not render an empty set as `Valid values: none`.
- Retry and backoff duration accounting must use a monotonic clock so wall-clock corrections cannot shorten or extend a wait.
- Normalize non-finite delay values before entering timer loops; security-sensitive timer scheduling must keep user-derived values out of `setTimeout` durations by using literal constants only.

## What to skip
- Don't flag `DatabaseSync` usage in test fixtures that mock the connection — context matters.
- Don't flag TypeScript-specific patterns that are idiomatic (e.g., discriminated unions, assertion functions).
