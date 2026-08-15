# Issue #617 Project Storage Runtime Design

## Goal

Route daemon-backed storage work, including MCP requests, compaction,
promotion, ingest, and retrieval, through the explicitly selected
`StorageBackendFactory`. SQLite remains the zero-configuration default and an
explicit PostgreSQL selection never reads or writes the project's SQLite
database as fallback.

## Selected approach

Create one eagerly verified backend factory when the daemon starts and share it
across built-in routes. Add one route lifecycle seam,
`withProjectStorage(request, operation)`, that resolves the selected project
under authenticated publication admission, opens the requested existing-or-
creatable project, runs one bounded storage batch, and closes request-scoped
storage in `finally`. The operation receives an `AbortSignal`; client
cancellation closes the project so PostgreSQL work observes its existing
project-scoped cancellation path. Daemon shutdown closes the shared factory and
all remaining projects.

The generic factory becomes asynchronous because PostgreSQL construction must
complete its existing runtime-readiness verification before routes are served.
SQLite construction remains behaviorally unchanged. Route-local fallback
construction uses the same generic factory, so tests and embedded route callers
cannot accidentally retain the staged PostgreSQL implementation.

MCP keeps its authenticated config/publication preflight but removes the
SQLite-only `selectStorageBackend` refusal. Storage tools continue to cross the
existing daemon transport, so they share the daemon factory and route error
contract instead of creating a second MCP-owned storage composition root.

The UserPromptSubmit, SessionEnd, PreCompact, and SessionStart runtime hooks
also remove only their staged PostgreSQL refusal before daemon transport. They
retain publication fences, daemon identity admission, hook failure behavior,
and local SQLite outbox enqueue. Installer/bootstrap and other CLI composition
remain #618-owned.

This is preferred over a factory per request, which would repeat PostgreSQL
pool and readiness setup, and over retained admission for whole mutating
handlers, which would fence discovery, transcript parsing, model calls, and
other non-storage waits.

## Admission and execution flow

The HTTP layer continues to authenticate and validate the request before route
execution. Built-in mutators receive a publication-admission callback. Routes
perform request validation, local discovery, debounce, and external inference
outside that callback, then call `withProjectStorage` for the actual repository
batch. Identity is re-resolved with the live publication token, the selected
factory opens the project with that token, the operation runs, and project
cleanup completes before admission is released.

Compaction retains its existing finer-grained admitted repository proxy because
model inference occurs between storage calls. The proxy admits each repository
method or transaction separately and never wraps summarizer work. Passive hook
enqueue remains the local SQLite outbox; only the consumer batch that promotes
queued events uses selected project storage.

The passive-event processor keeps debounce outside admission and is adjusted so
cwd validation, sidecar discovery/locking, local outbox reads, and scrubber
construction also finish before a per-project selected-storage callback takes
the publication token. `/promote-events/all` scans first and admits each project
batch independently; it never holds one token across the scan.

Custom mutating routes keep the existing retained-admission compatibility
contract. Built-in routes that own selected storage become operation-scoped.
Read routes retain the existing non-retained publication assertion and the
factory's bounded tokenless publication witnesses; #617 does not add an
interprocess consumer lock to every prompt-search read.

## Error and lifecycle contract

Identity configuration failures remain sanitized HTTP 409 responses. A
`StorageOperationError` under explicit PostgreSQL selection becomes a sanitized
HTTP 503 storage response using the existing cause-free
code/backend/project/domain/operation fields. SQLite read degradation and
route-specific failure behavior remain unchanged. No PostgreSQL failure is
reinterpreted as a reason to open SQLite.

Owned factories and opened projects close on success, validation exits,
publication contention, backend failure, request cancellation, and daemon
shutdown. Cleanup failure never replaces the primary operation response.
The daemon derives cancellation from HTTP request abort/connection close and a
daemon-wide shutdown controller. Scheduled work observes the shutdown signal;
compaction attaches it directly to its long-lived project because compaction
intentionally does not keep one admission callback around model inference.

## Verification

Public-seam RED tests will first prove asynchronous selected-factory activation,
bounded admission timing, normalized backend errors, cancellation cleanup, and
no fallback. Route-focused tests will cover retrieval, ingest, promotion,
compaction, and passive-event batches. A PostgreSQL 18 integration test will
exercise representative daemon writes and reads through the real factory and
prove the corresponding SQLite database is neither consulted nor created.
The final gate is the repository's complete 100% `npm run test:ci`, plus build,
lint, typecheck, documentation, package, and PostgreSQL conformance checks.

## Explicit boundaries

- #618 owns CLI and portable import/export routing.
- #619 owns stats, pool stats, status, doctor, and diagnostic presentation.
- #620 owns the final cross-backend parity matrix and certification evidence.
- Hook enqueue and local sidecar discovery remain SQLite-local by design.
- Installer/bootstrap backend selection remains part of #618 CLI composition.
- No dependency, schema, migration, configuration shape, or Codecov ownership
  change is planned for #617.
