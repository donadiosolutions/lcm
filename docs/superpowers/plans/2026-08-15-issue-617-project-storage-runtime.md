# Issue #617 Project Storage Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Workers do not invoke the MoM workflow recursively.

**Goal:** Activate the selected project-storage backend for daemon and MCP storage operations without PostgreSQL-to-SQLite fallback or long-lived publication admission around non-storage work.

**Architecture:** The daemon eagerly creates one asynchronous selected-backend factory and shares it with built-in routes. A route-level `withProjectStorage` seam resolves identity, opens project storage, executes one bounded repository batch with cancellation, and closes project resources before releasing publication admission; compaction keeps its existing per-repository admission proxy so model inference remains outside the lock.

**Tech Stack:** TypeScript 6.0, Node.js 25.9.0, Vitest 4.1.10, SQLite, PostgreSQL 18. No new dependency.

## Global Constraints

- This branch and PR close only #617. #618 owns CLI/import/export, #619 owns stats/status/doctor diagnostics, and #620 owns final parity certification.
- SQLite remains the default. Explicit PostgreSQL selection never opens, reads, creates, or writes the project's SQLite database as fallback.
- Hook enqueue and sidecar discovery remain local SQLite operations; only consumer batches use selected project storage.
- Runtime hooks may call the selected-backend daemon; installer/bootstrap and other CLI composition remain #618-owned.
- Validate requests, discover files, debounce, and run model/network work outside publication admission.
- Preserve cause-free storage errors, verified TLS, explicit project identity, publication fencing, exact dependency pins, and 100% line/branch/function/statement coverage.
- Use signed DCO commits. Freeze and publish once acceptance-required gates and P0/P1 review are clean; track lower-severity findings separately.

---

### Task 1: Activate the asynchronous selected-backend factory

**Files:**
- Modify: `src/storage/factory.ts`
- Modify: `src/storage/postgresql/factory.ts`
- Mechanically modify every current `createStorageBackendFactory(...)` caller under `src/daemon/routes/` plus `src/daemon/server.ts`
- Modify: `test/storage/sqlite-conformance.test.ts`
- Modify: `test/storage/postgresql-factory.test.ts`
- Modify: `test/daemon/coverage-core-server-mocked.test.ts`
- Modify: `test/daemon/server.test.ts`
- Mechanically update affected route tests that mock or call `createStorageBackendFactory`

**Interfaces:**
- Produces: `createStorageBackendFactory(...): Promise<StorageBackendFactory>`
- Produces: internal `createPostgreSqlStorageBackendFactoryWithHome(config, homeDir, dependencies?)`
- Preserves: `createPostgreSqlStorageBackendFactoryForTesting` as a compatibility alias for tests
- Preserves: curated `@donadiosolutions/lcm/storage/postgresql` facade and `selectStorageBackend` staging for #618

- [ ] **Step 1: Write RED selected-factory tests**

Add tests proving SQLite resolves to `SqliteStorageBackendFactory`, PostgreSQL delegates to the real eager factory with the exact resolved config and home root, one effective home is used for both publication admission and factory binding, failed PostgreSQL construction stays a sanitized `StorageOperationError`, and no SQLite factory is constructed on either PostgreSQL success or failure.

```ts
await expect(createStorageBackendFactory({ backend: "sqlite" }))
  .resolves.toBeInstanceOf(SqliteStorageBackendFactory);
await expect(createStorageBackendFactory(postgresqlConfig, home))
  .resolves.toMatchObject({ backend: "postgresql" });
```

- [ ] **Step 2: Run RED tests**

Run: `npx vitest run test/storage/sqlite-conformance.test.ts test/storage/postgresql-factory.test.ts test/daemon/coverage-core-server-mocked.test.ts`

Expected: failures show the generic factory is synchronous and still returns `UnavailablePostgreSqlStorageBackendFactory`.

- [ ] **Step 3: Implement minimal activation**

Replace the staged branch with the existing production PostgreSQL composition root and keep explicit-home construction internal:

```ts
export async function createStorageBackendFactory(
  config: ResolvedStorageConfig,
  homeDir?: string,
  publicationCheck = assertStorageBackendPublication,
  publicationLockToken?: BackendPublicationLockToken,
): Promise<StorageBackendFactory> {
  const effectiveHome = homeDir ?? homedir();
  publicationCheck({ backend: config.backend, homeDir: effectiveHome }, publicationLockToken);
  return config.backend === "postgresql"
    ? createPostgreSqlStorageBackendFactoryWithHome(config, effectiveHome)
    : new SqliteStorageBackendFactory();
}
```

Rename the existing explicit-home implementation without duplicating it and
retain the old testing export as an alias. Delete
`UnavailablePostgreSqlStorageBackendFactory`; #619's staged diagnostic handlers
do not depend on that class. Add `await` at every generic-factory call site in
this same task so the commit remains buildable, and update synchronous test
mocks to return resolved promises. The curated public subpath remains unchanged.

Add `_createStorageBackendFactory?: typeof createStorageBackendFactory` to
`DaemonOptions` as an internal deterministic seam and await it at startup. Unit
tests that use PostgreSQL configuration inject a fake factory through this
seam; only the PG18 integration task creates the real PostgreSQL runtime.

- [ ] **Step 4: Run focused tests and coverage**

Run: `npx vitest run test/storage/sqlite-conformance.test.ts test/storage/postgresql-factory.test.ts test/daemon/coverage-core-server-mocked.test.ts`

Run focused coverage over `src/storage/factory.ts` and changed PostgreSQL factory branches; require 100% statements, branches, functions, and lines.

Run `npm run typecheck` before committing to prove no synchronous caller remains.

- [ ] **Step 5: Commit**

```bash
git add src/storage/factory.ts src/storage/postgresql/factory.ts src/daemon/server.ts test/storage/sqlite-conformance.test.ts test/storage/postgresql-factory.test.ts test/daemon/coverage-core-server-mocked.test.ts test/daemon/server.test.ts $(rg -l 'createStorageBackendFactory' src/daemon/routes test/daemon/routes test/daemon/storage-identity-routing.test.ts)
git commit -S --signoff -m "feat(storage): activate selected backend factory"
```

### Task 2: Add bounded project-storage lifecycle and request cancellation

**Files:**
- Modify: `src/daemon/routes/storage-lifecycle.ts`
- Modify: `src/daemon/server.ts`
- Modify: `test/daemon/routes/storage-lifecycle.test.ts`
- Modify: `test/daemon/routes/server-route-admission.test.ts`
- Modify: `test/daemon/server.test.ts`

**Interfaces:**
- Produces: `ProjectStorageRequest`
- Produces: `withProjectStorage<T>(request, operation): Promise<T | null>`
- Extends: `RouteExecutionContext.signal?: AbortSignal`

- [ ] **Step 1: Write RED lifecycle tests**

Cover create-vs-existing opens, shared-vs-owned factory cleanup, identity
resolution with the live token, operation completion before admission release,
HTTP request abort and connection close cancelling the operation, daemon
shutdown cancelling foreground/background work, cleanup rejection preserving
the primary error, and configuration-aware `StorageOperationError` response
classification. Include PostgreSQL factory-construction failure before an
active factory exists.

```ts
const result = await withProjectStorage({
  config,
  cwd,
  factory,
  context: { withPublicationAdmission, signal: controller.signal },
  mode: "existing",
}, async (storage, signal) => {
  expect(signal).toBe(controller.signal);
  return storage.projectId;
});
```

- [ ] **Step 2: Run RED tests**

Run: `npx vitest run test/daemon/routes/storage-lifecycle.test.ts test/daemon/routes/server-route-admission.test.ts test/daemon/server.test.ts`

- [ ] **Step 3: Implement `withProjectStorage`**

The helper must await owned factory construction, enter
`context.withPublicationAdmission` only when the mutating route supplied it,
return `null` only for an authenticated absent existing project, attach one
abort listener that closes opened project storage, remove the listener in
`finally`, close owned factories after admission release, and never close an
injected shared factory. Compact retains its existing specialized admitted
repository proxy until Task 6 because model work occurs between storage calls.

Map identity errors to the existing 409 body. Key classification from the
selected `config.storage.backend`, not an already-constructed factory. Only
under explicit PostgreSQL selection, map a cause-free `StorageOperationError`
to HTTP 503 with its `toJSON()` fields; preserve SQLite read degradation and
route-specific error behavior. Remove staged-factory type checks from route
failure classification; keep staged diagnostic helpers only where #619 still
owns stats/status presentation.

- [ ] **Step 4: Make the daemon own one async factory and pass bounded admission**

Await `createStorageBackendFactory` before route registration. Pass a per-request
abort signal to every built-in route and the background publication callback
only to built-in mutators. Mark those storage mutators operation-scoped;
preserve the existing assertion-only read path and retained admission for
custom routes/overrides. Remove only the PostgreSQL gates on promote-event
notify, periodic transcript ingest, and passive-processor start; retain stats,
pool-stats, and status gates for #619. Ensure startup failure and `stop()` close
any constructed factory exactly once.

Create one daemon-wide shutdown `AbortController`. For each HTTP request,
combine that signal with a request controller triggered by `req.aborted` or a
premature response/connection close, pass the combined signal in
`RouteExecutionContext`, and detach listeners after the handler settles. Pass
the shutdown signal to scheduled ingest and background consumers. Abort the
daemon-wide controller before draining intervals/processors/projects/factory in
both startup-failure and normal-stop cleanup.

- [ ] **Step 5: Run focused tests and coverage**

Run the Task 2 test command and focused coverage for both changed production files at 100%.

- [ ] **Step 6: Commit**

```bash
git add src/daemon/routes/storage-lifecycle.ts src/daemon/server.ts test/daemon/routes/storage-lifecycle.test.ts test/daemon/routes/server-route-admission.test.ts test/daemon/server.test.ts
git commit -S --signoff -m "feat(daemon): bound project storage admission"
```

### Task 3: Allow runtime hooks to call the selected-backend daemon

**Files:**
- Modify: `src/hooks/user-prompt.ts`
- Modify: `src/hooks/session-end.ts`
- Modify: `src/hooks/compact.ts`
- Modify: `src/hooks/restore.ts`
- Modify: `test/hooks/user-prompt.test.ts`
- Modify: `test/hooks/session-end.test.ts`
- Modify: `test/hooks/compact.test.ts`
- Modify: `test/hooks/restore.test.ts`
- Modify: `test/e2e/flows/hooks.test.ts`

**Interfaces:**
- Preserves: publication fences, daemon identity admission, local outbox enqueue, and hook failure contracts
- Excludes: `src/bootstrap.ts`, installer composition, and general CLI backend selection (#618)

- [ ] **Step 1: Write RED hook tests**

Prove all four runtime hooks continue to daemon transport when PostgreSQL is
selected and publication evidence is valid; missing or unresolved publication
evidence retains the existing bounded hook behavior; daemon refusal never falls
back to SQLite; and user-prompt event enqueue remains local.

- [ ] **Step 2: Run RED tests**

Run: `npx vitest run test/hooks/user-prompt.test.ts test/hooks/session-end.test.ts test/hooks/compact.test.ts test/hooks/restore.test.ts test/e2e/flows/hooks.test.ts`

- [ ] **Step 3: Remove only the staged backend refusal**

Replace `selectStorageBackend` calls with the existing publication assertion or
hook fence appropriate to each hook. Remove `StorageBackendUnavailableError`
logging that represented staged support. Do not change daemon recovery, process
signaling, outbox writes, or bootstrap/CLI selection.

- [ ] **Step 4: Run focused tests and coverage**

Run the Task 3 command and focused coverage for all four changed hook files at
100%.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/user-prompt.ts src/hooks/session-end.ts src/hooks/compact.ts src/hooks/restore.ts test/hooks/user-prompt.test.ts test/hooks/session-end.test.ts test/hooks/compact.test.ts test/hooks/restore.test.ts test/e2e/flows/hooks.test.ts
git commit -S --signoff -m "feat(hooks): admit PostgreSQL daemon routes"
```

### Task 4: Route retrieval and MCP-backed reads through the lifecycle seam

**Files:**
- Modify: `src/daemon/routes/describe.ts`
- Modify: `src/daemon/routes/expand.ts`
- Modify: `src/daemon/routes/grep.ts`
- Modify: `src/daemon/routes/recent.ts`
- Modify: `src/daemon/routes/search.ts`
- Modify: `src/daemon/routes/prompt-search.ts`
- Modify: `src/mcp/server.ts`
- Modify: `test/daemon/routes/persistence-read-boundaries.test.ts`
- Modify: `test/daemon/routes/coverage-prompt-search.test.ts`
- Modify: `test/mcp/server.test.ts`

**Interfaces:**
- Consumes: Task 2 `withProjectStorage`
- Preserves: existing daemon response shapes and MCP-to-daemon endpoint mapping

- [ ] **Step 1: Write RED read-route tests**

For every read route, prove validation occurs before admission, the live token
reaches identity/open, missing projects retain current empty/not-found
responses, PostgreSQL storage failures become sanitized 503 responses,
injected factories are not closed, and no route consults a local SQLite path
when the injected backend is PostgreSQL. Inject typed failures inside both
retrieval and promoted lexical-search operations—not only project open—and
prove they escape current inner non-fatal catches under PostgreSQL while SQLite
keeps its existing empty-layer behavior. Prove MCP retains authenticated
config/publication checks, no longer calls the SQLite-only
`selectStorageBackend`, and continues to send search/grep/describe/expand
through daemon endpoints.

- [ ] **Step 2: Run RED tests**

Run: `npx vitest run test/daemon/routes/persistence-read-boundaries.test.ts test/daemon/routes/coverage-prompt-search.test.ts test/mcp/server.test.ts`

- [ ] **Step 3: Refactor read routes**

Move request parsing and validation before `withProjectStorage`; run the
retrieval or lexical-search batch inside its callback; format/send the response
after the callback returns where possible. In inner degradation catches,
rethrow `StorageOperationError` when `config.storage.backend === "postgresql"`
before applying existing SQLite non-fatal behavior. Delete staged-factory
branches and route-local project/factory cleanup now owned by the helper. In
MCP, preserve `assertStorageBackendPublication` and expected-backend equality,
remove only `selectStorageBackend`/`StorageBackendUnavailableError`, and let
daemon responses own backend availability.

- [ ] **Step 4: Run focused tests and coverage**

Run the Task 4 command and focused coverage for all six changed route files and
`src/mcp/server.ts` at 100%.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/routes/describe.ts src/daemon/routes/expand.ts src/daemon/routes/grep.ts src/daemon/routes/recent.ts src/daemon/routes/search.ts src/daemon/routes/prompt-search.ts src/mcp/server.ts test/daemon/routes/persistence-read-boundaries.test.ts test/daemon/routes/coverage-prompt-search.test.ts test/mcp/server.test.ts
git commit -S --signoff -m "feat(daemon): route retrieval through project storage"
```

### Task 5: Route ingest, promotion, restore, and mutation batches

**Files:**
- Modify: `src/daemon/routes/ingest.ts`
- Modify: `src/daemon/routes/store.ts`
- Modify: `src/daemon/routes/session-complete.ts`
- Modify: `src/daemon/routes/review-stale.ts`
- Modify: `src/daemon/routes/promote.ts`
- Modify: `src/daemon/routes/restore.ts`
- Modify: focused tests under `test/daemon/routes/`
- Modify: `test/daemon/storage-identity-routing.test.ts`

**Interfaces:**
- Consumes: Task 2 `withProjectStorage`
- Preserves: local transcript parsing, scrubbing, metadata best-effort behavior, and route response schemas

- [ ] **Step 1: Write RED mutation tests**

Prove transcript parsing, scrubber setup, request validation, and disabled/no-op
decisions occur outside publication admission; selected project repository
transactions occur inside it; PostgreSQL no-op requests still authenticate
identity/storage; cancellation and backend errors close projects and release
admission; and no PostgreSQL path creates local `db.sqlite`. Inject a typed
PostgreSQL failure from `deduplicateAndInsert` and prove it escapes the current
non-fatal promotion catch as the cause-free 503 response, while ordinary
non-storage/SQLite promotion failures retain existing behavior.

- [ ] **Step 2: Run RED route tests**

Run the ingest, store, session-complete, promote, restore, review-stale, and storage-identity focused test files named by `rg --files test/daemon/routes | rg '(ingest|store|session-complete|promote|restore|review-stale)'`.

- [ ] **Step 3: Refactor mutation routes**

Use `withProjectStorage` for each actual repository transaction/batch. Keep
transcript reads, event parsing, summarizer/model work, and metadata writes
outside the admission callback. Preserve transaction atomicity by keeping
transaction-scoped repository work inside one helper operation. Before current
route-local non-fatal handling, rethrow a `StorageOperationError` under explicit
PostgreSQL selection so an authoritative backend failure cannot be reported as
success.

- [ ] **Step 4: Run focused tests and coverage**

Run the Task 5 focused suites and require 100% coverage for every changed production file.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/routes/ingest.ts src/daemon/routes/store.ts src/daemon/routes/session-complete.ts src/daemon/routes/review-stale.ts src/daemon/routes/promote.ts src/daemon/routes/restore.ts test/daemon/routes/ingest-boundaries.test.ts test/daemon/routes/ingest.test.ts test/daemon/routes/store-boundaries.test.ts test/daemon/routes/store.test.ts test/daemon/routes/session-complete-boundaries.test.ts test/daemon/routes/promote-boundaries.test.ts test/daemon/routes/promote.test.ts test/daemon/routes/coverage-restore.test.ts test/daemon/routes/restore.test.ts test/daemon/routes/review-stale-boundaries.test.ts test/daemon/routes/review-stale.test.ts test/daemon/storage-identity-routing.test.ts
git commit -S --signoff -m "feat(daemon): route mutation batches through project storage"
```

### Task 6: Bound compaction and passive-event consumer admission

**Files:**
- Modify: `src/daemon/routes/compact.ts`
- Modify: `src/daemon/routes/promote-events.ts`
- Modify: `src/daemon/passive-event-processor.ts`
- Modify: `test/daemon/routes/compact.test.ts`
- Modify: `test/daemon/routes/coverage-compact.test.ts`
- Modify: `test/daemon/routes/promote-events.test.ts`
- Modify: `test/daemon/routes/promote-events-unit-boundaries.test.ts`
- Modify: `test/daemon/passive-event-processor.test.ts`

**Interfaces:**
- Preserves: compaction's admitted repository proxy and local SQLite hook outbox
- Activates: PostgreSQL passive-event draining and periodic selected-backend ingest

- [ ] **Step 1: Write RED boundary tests**

Prove compaction summarizer creation/inference is never inside publication
admission; each repository call/transaction is admitted; request abort and
daemon shutdown immediately close compaction's long-lived project; disabled and
duplicate compaction authenticate PostgreSQL without SQLite fallback; debounce,
cwd validation, sidecar discovery/locking, local outbox reads, and scrubber
construction occur outside admission; one selected-project promotion batch is
inside admission; `/promote-events/all` admits each project independently after
the scan; typed PostgreSQL per-event storage failure escapes as a cause-free
503 instead of a successful result; notify remains local and available for
either selected backend; and daemon stop cancels/drains background work before
factory close.

- [ ] **Step 2: Run RED focused tests**

Run: `npx vitest run test/daemon/routes/compact.test.ts test/daemon/routes/coverage-compact.test.ts test/daemon/routes/promote-events.test.ts test/daemon/routes/promote-events-unit-boundaries.test.ts test/daemon/passive-event-processor.test.ts`

- [ ] **Step 3: Activate and bound background storage work**

Remove staged PostgreSQL responses and preserve compaction's per-method proxy.
Attach the route signal directly to compaction's opened project and detach it
in cleanup. Change the passive promotion API so the processor invokes local
discovery without admission, then supplies its publication callback only to
the selected-project open/repository batch. Make `/promote-events/all` scan
first and call the same per-project seam; never retain one token across the
scan. Rethrow typed PostgreSQL storage failures before per-event non-fatal
handling. Preserve debounce policy and the local SQLite outbox format.

- [ ] **Step 4: Run focused tests and coverage**

Run the Task 6 command and focused coverage for all three changed production
files at 100%.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/routes/compact.ts src/daemon/routes/promote-events.ts src/daemon/passive-event-processor.ts test/daemon/routes/compact.test.ts test/daemon/routes/coverage-compact.test.ts test/daemon/routes/promote-events.test.ts test/daemon/routes/promote-events-unit-boundaries.test.ts test/daemon/passive-event-processor.test.ts
git commit -S --signoff -m "feat(daemon): activate bounded storage consumers"
```

### Task 7: Prove real PostgreSQL routing and publish operator guidance

**Files:**
- Create: `test/postgresql/daemon-runtime.integration.ts`
- Modify: `docs/configuration.md`
- Modify: `docs/architecture.md`
- Modify: `docs/backend-publication.md`
- Modify: `docs/project-identity.md`
- Modify: `docs/passive-learning.md`
- Modify: `docs/privacy.md`
- Add: `docs/superpowers/specs/2026-08-15-issue-617-project-storage-runtime-design.md`
- Add: `docs/superpowers/plans/2026-08-15-issue-617-project-storage-runtime.md`
- Modify: `README.md`
- Create: `.changeset/postgresql-daemon-runtime.md`
- Modify only if ownership changes: `codecov.yml`, `test/codecov-config.test.ts`

**Interfaces:**
- Consumes: final daemon routing from Tasks 1-6
- Produces: one minor user-facing runtime-activation changeset

- [ ] **Step 1: Write the real PostgreSQL 18 integration test**

Using the existing disposable PG18 harness, provision the exact runtime grants,
register/bind one machine/project identity, publish PostgreSQL as selected
backend, start the daemon with the real selected factory, ingest/store and
retrieve representative data, and assert the local SQLite database path does
not exist. Add a project-SQLite access sentinel by spying/guarding
`SqliteStorageBackendFactory` project methods and project connection inspection;
the PostgreSQL route must succeed without touching them. Keep intentionally
local hook/outbox SQLite available and prove it still functions. Add failure
cases for runtime outage and shutdown cleanup without exposing credentials or
paths.

- [ ] **Step 2: Run PostgreSQL 18 evidence**

Run the repository's existing PostgreSQL 18 conformance command for the focused integration file and then both standard PG18 shards. Record image/version and exact test counts in the PR body.

- [ ] **Step 3: Update documentation and Changeset**

Remove claims that normal daemon/MCP PostgreSQL routing is staged. Document
explicit selection, required machine/project binding and grants, local hook
enqueue, fail-closed 409/503 errors, cancellation/shutdown cleanup, recovery,
and explicit rollback by republishing the chosen backend. Update
`docs/privacy.md` so redaction occurs before writing the selected project
backend while native-transcript daemon routing remains accurately inactive and
local outbox/sidecar SQLite remains explicit. Keep CLI/import-export and
stats/doctor limitations attributed to #618/#619. Add a minor Changeset; do not
change package versions.

- [ ] **Step 4: Verify taxonomy without churn**

Run `npx vitest run test/codecov-config.test.ts`. If no production file was added or moved, leave `codecov.yml` unchanged and record the unchanged 30-component/201-file ownership. If implementation adds a production file, update both taxonomy files atomically and derive the new literal count from the complete tree.

- [ ] **Step 5: Run complete required gates**

Run:

```bash
npm run typecheck
npm run lint
npm run build
npm run verify:consumer-topology
npm run verify:postgresql-package
npm pack --dry-run --json
umask 0022; npm run test:ci
git diff --check
```

Require exact 100% statements, branches, functions, and lines across the complete collected scope.

- [ ] **Step 6: Commit and run MoM review**

```bash
git add README.md docs/architecture.md docs/backend-publication.md docs/configuration.md docs/project-identity.md docs/passive-learning.md docs/privacy.md docs/superpowers/specs/2026-08-15-issue-617-project-storage-runtime-design.md docs/superpowers/plans/2026-08-15-issue-617-project-storage-runtime.md .changeset/postgresql-daemon-runtime.md test/postgresql/daemon-runtime.integration.ts
# Only when Task 7 Step 4 made a real taxonomy change:
git add codecov.yml test/codecov-config.test.ts
git commit -S --signoff -m "docs(storage): activate PostgreSQL daemon routing"
```

Run GLM/max and Grok/high adversarial reviews in parallel, then Opus/medium second pass. Remediate only P0/P1 or required-gate failures before publishing; file lower-severity findings separately.

- [ ] **Step 7: Publish one issue-only PR**

Push `feat/617-project-storage-runtime`, open one PR targeting `main` with `Closes #617`, wait for exact-head required checks and hosted review, resolve actionable threads, and merge only this issue. Verify merge SHA, parents, signature, issue closure, `origin/main`, and canonical post-merge health before starting #618.
