# Issue #621 Reversible Migration Protocol Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the checksum-sealed reversible-migration manifest, legal transition reducer, and crash-recoverable private journal required by issue #621 before any SQLite/PostgreSQL data is moved.

**Architecture:** Keep policy pure and persistence explicit. `src/migration/protocol.ts` owns strict versioned types, canonical checksums, parsing, legal transition/effect rules, and deterministic recovery classification; `src/migration/manifest-store.ts` owns an immutable revision chain plus a small compare-and-swap head pointer under the existing private mutation lock and descriptor-safe durable file primitives. Terminal/settled manifests retain immutable lineage and report references, but readers never rehash a mutable live backend merely because a historical witness remains in the manifest.

**Tech Stack:** TypeScript/Node.js ESM, Vitest, Node `crypto` SHA-256, existing `security-files.ts` and `private-mutation-lock.ts` durability primitives, Codecov components, Changesets.

## Global Constraints

- Implement only issue #621. Snapshot capture, data copy, reconciliation, activation, rollback execution, CLI commands, and PostgreSQL behavior remain owned by #622-#628.
- Add no dependency. If implementation later requires one, stop and run the required exact-version Socket assessment before adding it.
- Every executable production TypeScript file must retain 100% line, branch, function, and statement coverage, including per-file thresholds.
- Durable directories are exact mode `0700`; files are owner-only, normally exact mode `0600`; symlinks, non-regular files, multiple links, wrong ownership/mode, oversized content, identity changes, checksum drift, and ambiguous recovery fail closed.
- Every manifest revision and head pointer uses canonical sorted-key JSON plus SHA-256. The checksum field is excluded from its own checksum payload.
- All mutations execute under one existing-style home-level private mutation lock at `~/.lcm.migration-manifest.lock` and publish with `atomicWritePrivateFileDurable`. This lock exists before `~/.lcm/migrations/` or a generation directory and serializes root/generation creation as well as update/recovery.
- Lock ordering is frozen: the manifest lock is always innermost. A caller may already hold backend-publication admission before entering the manifest store, but manifest code must never acquire or wrap a backend-publication lock.
- Before acquiring the home-level lock, authenticate `$HOME`, its parent topology, and ownership/mode with retained no-follow descriptors using the same fail-closed pattern as `openBackendPublicationLockParent`; revalidate that topology after lock acquisition and before every durable publication.
- A revision file is immutable and published before the head pointer. Recovery may advance the head only across one exact, checksum-valid successor whose `previousManifestSha256` equals the current head; zero, multiple, conflicting, or second-hop successors refuse or leave the current head unchanged as specified below. Recovery never walks an unbounded chain.
- `active`, `rolled-back`, and `aborted` records retain immutable lineage. Merely loading a settled record must not stat/hash/revalidate a live SQLite or PostgreSQL tree against an historical data witness. Explicit rollback from `active` is still legal and creates later revisions in the same generation.
- Use deterministic RED tests at public seams before implementation. No coverage exclusions, skipped tests, `v8 ignore`, or untested production wrappers.
- Commits must be signed by the configured Git signer and use `--signoff`. Branches must not start with `codex/`; commits and PRs must not attribute work to an AI system.

---

## File Map

- Create `src/migration/protocol.ts`: versioned manifest schema, strict parser, canonical checksum, legal effect table, pure begin/complete reducers, and recovery classification.
- Create `src/migration/manifest-store.ts`: private directory layout, immutable revision publication, checksum-sealed head compare-and-swap, bounded reads, and deterministic interrupted-head recovery.
- Create `src/migration/index.ts`: migration protocol exports for later #622-#628 modules.
- Create `src/storage/home-lock-topology.ts`: shared retained-descriptor `$HOME`/parent authentication and exact original-mode restoration for home-level mutation locks.
- Modify `src/storage/backend-publication.ts`: consume the shared home-lock topology helper with no behavior change.
- Modify `src/security-files.ts`: add optional expected-UID threading to retained-directory assertion and directory sync, preserving current-UID defaults.
- Create `test/migration/protocol.test.ts`: public pure-protocol RED/GREEN coverage.
- Create `test/migration/manifest-store.test.ts`: real-filesystem and injected durable-publication failure coverage through the public store seam.
- Modify `codecov.yml` and `test/codecov-config.test.ts`: add one exclusive stable `unit-migration-cutover` component owning `src/migration/`.
- Create `docs/migration-cutover.md`: operator-facing protocol, storage layout, phases, evidence, failure classes, and recovery contract.
- Modify `docs/README.md`: link the new operator guide in the existing documentation index.
- Create `.changeset/freeze-reversible-migration-protocol.md`: minor release note for the new protocol foundation.

## Frozen Public Contract

```ts
export type MigrationPhase =
  | "planned"
  | "dry-run-verified"
  | "copying"
  | "copied"
  | "verified"
  | "activating"
  | "active"
  | "rolling-back"
  | "rolled-back"
  | "aborted";

export type MigrationEffectKind =
  | "verify-dry-run"
  | "copy-batch"
  | "complete-copy"
  | "verify-generation"
  | "prepare-activation"
  | "publish-activation"
  | "prepare-rollback"
  | "publish-rollback"
  | "abort";

export type MigrationStorageWitness = Readonly<{
  version: 1;
  backend: "sqlite" | "postgresql";
  identitySha256: string;
  schemaSha256: string;
  contentSha256: string;
  capturedAt: string;
}>;

export type MigrationCheckpoint = Readonly<{
  domain: string;
  ordinal: number;
  recordCount: number;
  sourceCheckpointSha256: string;
  destinationCommitSha256: string;
}>;

export type MigrationReportReference = Readonly<{
  kind: "dry-run" | "verification" | "activation" | "rollback" | "abort" | "abandonment";
  reportId: string;
  reportSha256: string;
  createdAt: string;
}>;

export type MigrationRollbackLineage = Readonly<{
  parentGenerationId: string | null;
  preservedSourceGenerationId: string;
  mode: "pre-write" | "post-write" | null;
  returnPhase: "verified" | "active" | null;
}>;

export type PendingMigrationEffect = Readonly<{
  effectId: string;
  kind: MigrationEffectKind;
  fromPhase: MigrationPhase;
  targetPhase: MigrationPhase;
  inputSha256: string;
  recovery: "retry-idempotent" | "authoritative-readback-required";
  startedAt: string;
}>;

export type MigrationManifest = Readonly<{
  version: 1;
  generationId: string;
  revision: number;
  phase: MigrationPhase;
  source: MigrationStorageWitness;
  destination: MigrationStorageWitness;
  checkpoints: readonly MigrationCheckpoint[];
  reports: readonly MigrationReportReference[];
  activationEligible: boolean;
  rollbackLineage: MigrationRollbackLineage;
  pendingEffect: PendingMigrationEffect | null;
  previousManifestSha256: string | null;
  createdAt: string;
  updatedAt: string;
  checksumSha256: string;
}>;

export type BeginMigrationEffectInput = Readonly<{
  effectId: string;
  kind: MigrationEffectKind;
  inputSha256: string;
  startedAt: string;
}>;

export type CompleteMigrationEffectInput = Readonly<{
  effectId: string;
  completedAt: string;
  checkpoint?: MigrationCheckpoint;
  report?: MigrationReportReference;
  activationEligible?: boolean;
  rollbackMode?: "pre-write" | "post-write";
}>;

export type AbandonMigrationEffectInput = Readonly<{
  effectId: string;
  abandonedAt: string;
  report: MigrationReportReference & Readonly<{ kind: "abandonment" }>;
}>;

export type CreateMigrationManifestInput = Readonly<{
  generationId: string;
  source: MigrationStorageWitness;
  destination: MigrationStorageWitness;
  parentGenerationId: string | null;
  preservedSourceGenerationId: string;
  createdAt: string;
}>;

export type MigrationManifestHead = Readonly<{
  version: 1;
  generationId: string;
  revision: number;
  revisionFilename: string;
  manifestSha256: string;
  updatedAt: string;
  checksumSha256: string;
}>;

export function createMigrationManifest(input: CreateMigrationManifestInput): MigrationManifest;

export function beginMigrationEffect(
  manifest: MigrationManifest,
  input: BeginMigrationEffectInput,
): MigrationManifest;

export function completeMigrationEffect(
  manifest: MigrationManifest,
  input: CompleteMigrationEffectInput,
): MigrationManifest;

export function abandonMigrationEffect(
  manifest: MigrationManifest,
  input: AbandonMigrationEffectInput,
): MigrationManifest;

export function parseMigrationManifest(value: unknown): MigrationManifest;
export function migrationManifestCanonicalSha256(value: unknown): string;
export function classifyMigrationRecovery(manifest: MigrationManifest):
  | Readonly<{ action: "ready" }>
  | Readonly<{ action: "resume"; effect: PendingMigrationEffect }>
  | Readonly<{ action: "readback"; effect: PendingMigrationEffect }>
  | Readonly<{ action: "settled"; phase: "active" | "rolled-back" | "aborted" }>;

export class MigrationManifestStore {
  constructor(options?: Readonly<{
    homeDir?: string;
    observer?: (event: string, path: string) => void;
    /** @internal Deterministic owner-policy seam for public filesystem tests. */
    expectedUid?: number;
  }>);
  create(manifest: MigrationManifest): MigrationManifest;
  read(generationId: string): MigrationManifest;
  update(
    generationId: string,
    expectedChecksumSha256: string,
    reduce: (manifest: MigrationManifest) => MigrationManifest,
  ): MigrationManifest;
  recover(generationId: string): MigrationManifest;
}
```

The head checksum is canonical SHA-256 over every head field except `checksumSha256`. Persisted head and manifest JSON is canonical ASCII-only JSON; parser input containing any non-ASCII code point is rejected before semantic parsing. Head replacement compare-and-swap is separately bound to SHA-256 of the exact UTF-8 string returned by the bounded descriptor read; `atomicWritePrivateFileDurable` receives that string digest as `expectedContentSha256` and always receives `maxExistingBytes: 1 MiB`. Genesis passes literal `null`, never `undefined`, as the absent-file precondition.

The implementation may expose narrower helper types, but it must not rename or weaken these public seams without returning the plan to MoM review.

## Legal Effect Table

| Current phase | Effect | Target phase | Recovery class | Required completion evidence |
| --- | --- | --- | --- | --- |
| `planned` | `verify-dry-run` | `dry-run-verified` | retry idempotently | one `dry-run` report |
| `dry-run-verified` | `copy-batch` | `copying` | authoritative readback | one monotonic checkpoint |
| `copying` | `copy-batch` | `copying` | authoritative readback | one monotonic checkpoint replacing the same domain or appending the next domain |
| `copying` | `complete-copy` | `copied` | authoritative readback | no new report; every declared checkpoint remains sealed |
| `copied` | `verify-generation` | `verified` | retry idempotently | one clean `verification` report and `activationEligible: true` |
| `verified` | `prepare-activation` | `activating` | retry idempotently | no report/checkpoint; pure durable boundary |
| `activating` | `publish-activation` | `active` | authoritative readback | one `activation` report |
| `verified` | `prepare-rollback` | `rolling-back` | retry idempotently | no report/checkpoint; pure durable boundary |
| `active` | `prepare-rollback` | `rolling-back` | retry idempotently | no report/checkpoint; pure durable boundary |
| `rolling-back` | `publish-rollback` | `rolled-back` | authoritative readback | one `rollback` report and explicit rollback mode |
| `planned`, `dry-run-verified`, `copying`, `copied`, `verified` | `abort` | `aborted` | retry idempotently | one sanitized `abort` report |

`beginMigrationEffect` records the pending effect without advancing `phase`; that begin is itself a new sealed revision linked to the input manifest. `targetPhase` describes the completion target. `completeMigrationEffect` requires the same `effectId`, validates the row above, advances the phase, attaches exact evidence, clears `pendingEffect`, and creates another linked sealed revision. Both functions increment `revision`, set `previousManifestSha256` to the immediate input manifest checksum, advance `updatedAt`, and reject revisions beyond `Number.MAX_SAFE_INTEGER`. Starting a second effect while one is pending, completing a different effect, direct phase mutation, evidence omission or surplus, report-kind mismatch, duplicate report identity, checkpoint regression, timestamp regression, or transition not listed above throws `MigrationProtocolError` with a sanitized stable reason.

The explicit `prepare-*` effects create the durable `activating`/`rolling-back` boundary without claiming an external publication occurred. Later #625/#626 code begins a fresh `publish-*` effect with a fresh `effectId` and input seal before the external effect. The protocol does not infer backend outcome from phase or timestamps.

When authoritative readback proves a pending `publish-activation` or `publish-rollback` effect did not occur, `abandonMigrationEffect` requires that exact pending `effectId` and one checksum-bound sanitized `abandonment` report. It creates a new revision, clears the pending effect, and returns activation to `verified` or rollback to the `rollbackLineage.returnPhase` sealed by `prepare-rollback`. It is illegal for retry-idempotent effects, effects without negative readback, every non-publication effect kind, or any manifest without an exact pending effect. This is resolution of a pending effect, not a second concurrently pending effect.

---

### Task 1: Strict Manifest Schema and Canonical Seal

**Files:**
- Create: `src/migration/protocol.ts`
- Test: `test/migration/protocol.test.ts`

**Interfaces:**
- Consumes: Node `createHash`; no filesystem or backend clients.
- Produces: all types, `MigrationProtocolError`, `migrationManifestCanonicalSha256`, `createMigrationManifest`, and `parseMigrationManifest` from the frozen contract.

- [ ] **Step 1: Write deterministic RED tests for creation and parsing**

  Add table-driven tests that create a valid generation and assert exact defaults (including rollback mode/return phase `null`), canonical checkpoint/report ordering, checksum reproducibility across object key order, lowercase 64-hex seals, ASCII-only persistence, frozen returned collections, and JSON round-trip. Add one mutation per exact schema field covering unknown/missing keys, non-ASCII persisted bytes/text, wrong version, unsafe generation/effect/report/domain identifiers, invalid dates, invalid hash widths/case, negative/fractional/unsafe numbers, duplicate report IDs, duplicate checkpoint domains/ordinals, wrong backend, checksum mismatch, and recursive checksum inclusion. Add cross-field cases: revision zero requires a null predecessor, later revisions require a predecessor, terminal `rolled-back`/`aborted` phases forbid pending effects, pending `fromPhase` must equal the manifest phase, pending target/effect must match the legal table, `activationEligible` is true only in verified/activating/active/rolling-back/rolled-back states with a bound verification report, rollback return phase is sealed only by `prepare-rollback`, and rollback mode is null until `rolled-back`.

- [ ] **Step 2: Run the focused test and prove RED**

  Run `npx vitest run test/migration/protocol.test.ts`.
  Expected: FAIL because `src/migration/protocol.ts` and its public exports do not exist.

- [ ] **Step 3: Implement the minimum strict schema and seal**

  Implement exact-key parsing, finite ISO timestamp round-trip validation, identifier bounds (`1..128`, first `[A-Za-z0-9]`, remaining `[A-Za-z0-9._:-]`), exact lowercase SHA-256 validation, safe non-negative integer validation bounded by `Number.MAX_SAFE_INTEGER`, all cross-field invariants from Step 1, deterministic canonical JSON for JSON-compatible values, immutable copies, and `MigrationProtocolError` reasons `invalid-input`, `malformed-manifest`, `checksum-mismatch`, `recovery-required`, and `unexpected-state`. Hash the payload with `checksumSha256` omitted.

- [ ] **Step 4: Run focused tests and typecheck**

  Run `npx vitest run test/migration/protocol.test.ts && npm run typecheck`.
  Expected: PASS with no warning or skipped test.

---

### Task 2: Legal Effect Reducer and Recovery Classification

**Files:**
- Modify: `src/migration/protocol.ts`
- Modify: `test/migration/protocol.test.ts`

**Interfaces:**
- Consumes: strict `MigrationManifest` values from Task 1.
- Produces: `beginMigrationEffect`, `completeMigrationEffect`, and `classifyMigrationRecovery` from the frozen contract.

- [ ] **Step 1: Write RED tests for every legal and illegal edge**

  Drive every legal-effect-table row through begin and completion. Assert both begin and complete create consecutive revision/hash links, unchanged source/destination witnesses, one pending effect at a time, exact evidence requirements (including no surplus evidence on `prepare-*`), monotonic per-domain checkpoint replacement, stable report ordering, activation eligibility only after a clean verification report, explicit rollback lineage, abort restrictions, and `active -> rolling-back -> rolled-back`. Add negative-readback cases proving exact pending `publish-activation` abandonment returns `activating -> verified -> prepare-activation`, exact pending `publish-rollback` abandonment returns to its sealed `verified` or `active` return phase, and abandonment is illegal from every other phase/effect or with a mismatched effect/report. Exhaustively test every phase/effect pair not in the table and assert `unexpected-state` without returning a partially changed object.

- [ ] **Step 2: Write RED tests for crash classification**

  Assert: no pending effect in a non-settled phase returns `ready`; retry-idempotent pending effects return `resume`; copy/activation/rollback pending effects return `readback`; `active`, `rolled-back`, and `aborted` without a pending effect return `settled`. Mutate the live filesystem outside the manifest fixture and prove classification does not inspect it.

- [ ] **Step 3: Run focused tests and prove RED**

  Run `npx vitest run test/migration/protocol.test.ts`.
  Expected: FAIL on missing reducer/classifier behavior, not fixture construction.

- [ ] **Step 4: Implement the pure reducer**

  Encode the legal-effect table as immutable data, derive recovery class from effect kind, require exact pending-effect identity for completion/abandonment, enforce evidence-kind and checkpoint monotonicity, seal rollback return phase at preparation, and create each revision through one pure sealing helper. Do not accumulate mutable coordinator state or call the filesystem.

- [ ] **Step 5: Run focused coverage and inspect all four metrics**

  Run `npx vitest run test/migration/protocol.test.ts --coverage --coverage.include=src/migration/protocol.ts --coverage.reporter=text`.
  Expected: 100% statements, branches, functions, and lines for `protocol.ts`.

---

### Task 3: Immutable Revision Store and Head Recovery

**Files:**
- Create: `src/migration/manifest-store.ts`
- Create: `src/storage/home-lock-topology.ts`
- Modify: `src/storage/backend-publication.ts`
- Modify: `src/security-files.ts`
- Modify: `test/backend-publication.test.ts`
- Modify: `test/security-files.test.ts`
- Test: `test/migration/manifest-store.test.ts`

**Interfaces:**
- Consumes: `parseMigrationManifest`, canonical hashing, `withPrivateMutationLock`, `atomicWritePrivateFileDurable`, shared home-lock topology helpers, `openPrivateDirectory`, `assertPrivateDirectory`, `readBoundedRegularFileWithStat`, owner-only mode constants, and `syncPrivateDirectory`.
- Produces: `MigrationManifestStore` plus pure path helpers used by tests and later migration services.

- [ ] **Step 1: Write RED public-seam tests for layout and compare-and-swap**

  Use a real temporary home containing an exact-mode `0700` `.lcm` root. Assert `create` publishes revision zero then the head; revision files and head are `0600`, single-link regular files; every intermediate directory is exact `0700`; `read` authenticates both; `update` requires the exact observed checksum; stale concurrent updates fail; a reducer cannot alter generation identity, skip a revision, break the previous hash, or return an unsealed object; and existing generation IDs cannot be replaced. Concurrent genesis creation is serialized by `~/.lcm.migration-manifest.lock`, before the migrations/generation directories exist.

- [ ] **Step 2: Write RED tamper/race tests**

  Cover symlink leaf and parent substitution, hard links, deterministic wrong-owner refusal through a store-level expected-UID test override threaded through every open/read/assert/sync, wrong modes, group/world-writable or replaced `$HOME` topology before lock acquisition, oversized files, malformed/non-ASCII JSON, unknown fields, revision filename/content disagreement, head checksum drift, manifest checksum drift, changed inode/content during read, lock contention, UTF-8-string head compare-and-swap loss, and a replacement head shorter than its predecessor (proving the fixed 1 MiB precondition bound). Preserve suspicious evidence on every refusal. Prove an original `0755` `$HOME` is restored exactly after both successful and throwing store callbacks.

- [ ] **Step 3: Write RED crash-boundary tests**

  Use the store observer events `before-revision-publication`, `after-revision-publication`, `before-head-publication`, and `after-head-publication` to inject crashes. Prove: a crash before the immutable revision leaves the old head; a crash after one valid successor revision but before head publication makes ordinary `read` fail with `recovery-required` and is recovered by one head advance; a crash after head publication reads the new state; an orphan with the wrong predecessor is refused as tampering; two valid successors are ambiguous and fail closed; and a valid second-hop successor beyond the single recoverable revision also fails closed. For genesis, one valid revision with no head is recoverable, while multiple genesis candidates refuse. `update` performs the same stale-head check while locked and refuses before attempting a colliding revision publication.

- [ ] **Step 4: Run focused tests and prove RED**

  Run `npx vitest run test/migration/manifest-store.test.ts`.
  Expected: FAIL because the store does not exist.

- [ ] **Step 5: Extract and regression-test shared home-lock topology**

  Move the current private backend-publication topology behavior into `src/storage/home-lock-topology.ts` with stable functions `openHomeLockTopology(homeDir?, expectedUid?)`, `assertHomeLockTopology(topology)`, `restoreHomeLockTopologyMode(topology)`, and `closeHomeLockTopology(topology)`. Preserve the current no-follow retained descriptors, parent/grandparent identity checks, ownership and group/world-write refusals, saved original home mode, mode restoration, and error aggregation. Refactor backend publication to consume these functions without changing observable behavior. Add focused RED/GREEN regressions proving backend publication still restores an original `0755` home after success and failure, and rejects topology replacement.

- [ ] **Step 6: Thread expected UID through security directory helpers**

  Add an optional `expectedUid` argument to `assertPrivateDirectory` and an optional `{ expectedUid?: number }` options object to `syncPrivateDirectory`, both defaulting to the current UID. Ensure sync passes the same expected UID to open and assert. Add RED/GREEN tests for mismatched and matching injected UIDs and preserve 100% per-file coverage for `src/security-files.ts`.

- [ ] **Step 7: Implement bounded durable storage**

  Use layout `~/.lcm/migrations/<generationId>/revisions/<16-digit-revision>/<manifest-sha256>.json` and `~/.lcm/migrations/<generationId>/head.json`; revision values remain safe integers and each revision directory may contain exactly one manifest candidate. Open home topology before `withPrivateMutationLock`; inside the lock assert topology then restore its original mode; reassert after the callback; in `finally` restore original mode before closing topology, preserving/aggregating primary errors exactly like backend publication. Authenticate the existing `.lcm` root through the same injected expected UID. Create `migrations/`, `<generationId>/`, `revisions/`, and each numeric revision directory one level at a time with non-recursive `mkdir(0o700)`, open via `openPrivateDirectory({ expectedUid })`, tighten via descriptor `fchmod`, and revalidate via `assertPrivateDirectory(..., expectedUid)`; never trust recursive mkdir or path-based chmod. Thread the same expected UID through every bounded read and `syncPrivateDirectory`. Publish ASCII canonical immutable revisions with `requireAbsent: true`, sync containing directories, then publish the exact `MigrationManifestHead` with UTF-8-string compare-and-swap (`expectedContentSha256: null` for genesis, otherwise SHA-256 of the bounded observed string; always `maxExistingBytes: 1 MiB`). Limit each manifest/head to 1 MiB.

- [ ] **Step 8: Implement exact recovery**

  Compute only the exact expected next revision directory from the authenticated head; never enumerate all historical revisions. Require that numeric directory to be absent or an authenticated exact-mode owner directory containing at most two entries, of which exactly one may match the `<manifest-sha256>.json` grammar. Authenticate the candidate as an ASCII owner-only single-link regular file; reject extra entries, symlinks, directories, devices, sockets, hard links, and unsafe metadata before parsing. Require directory/revision/filename/checksum agreement and advance only through that unique immediate successor linked to the current manifest checksum. After selecting it, probe only the following numeric revision directory; its presence is a forbidden second hop and fails closed. Do not skip revisions, choose by timestamp/lexical order, delete/rewrite orphans, inspect live backend data, or iterate beyond one head advance. Return the authenticated selected manifest.

- [ ] **Step 9: Run focused coverage and inspect all four metrics**

  Run `npx vitest run test/migration/manifest-store.test.ts test/migration/protocol.test.ts test/backend-publication.test.ts test/security-files.test.ts --coverage --coverage.include=src/migration/protocol.ts --coverage.include=src/migration/manifest-store.ts --coverage.include=src/storage/home-lock-topology.ts --coverage.include=src/storage/backend-publication.ts --coverage.include=src/security-files.ts --coverage.reporter=text`.
  Expected: 100% statements, branches, functions, and lines for every included file.

---

### Task 4: Package Surface and Codecov Ownership

**Files:**
- Create: `src/migration/index.ts`
- Modify: `codecov.yml`
- Modify: `test/codecov-config.test.ts`
- Test: `test/migration/protocol.test.ts`

**Interfaces:**
- Consumes: Task 1-3 public exports.
- Produces: one discoverable migration module and exclusive `unit-migration-cutover` coverage ownership.

- [ ] **Step 1: Write RED export and taxonomy assertions**

  Import public migration types/functions through `src/migration/index.ts`. In the Codecov regression, add exact expected component `{ component_id: "unit-migration-cutover", name: "Unit - Migration and Cutover", paths: ["src/migration/"] }`; add `^src/storage/home-lock-topology\\.ts$` to the existing `unit-storage-abstractions` component; change the literal component contract/count from 29 to 30, and change both production-file/ownership literal counts from 191 to 195 for the four new production files. Retain the complete exclusive-production-file scan.

- [ ] **Step 2: Run the focused tests and prove RED**

  Run `npx vitest run test/migration/protocol.test.ts test/codecov-config.test.ts`.
  Expected: FAIL because exports and ownership are absent.

- [ ] **Step 3: Add exports and atomic Codecov configuration**

  Export protocol and store only from `src/migration/index.ts`; do not re-export the filesystem store through `src/storage/index.ts` or the PostgreSQL migration barrel. Add the identical component and exact updated literals/test title to both Codecov contract surfaces. Do not add flags, statuses, ignore entries, threshold changes, or reporting-topology changes.

- [ ] **Step 4: Verify configuration and type surface**

  Run `npx vitest run test/migration/protocol.test.ts test/codecov-config.test.ts && npm run typecheck`.
  Expected: PASS.

---

### Task 5: Operator Documentation and Release Note

**Files:**
- Create: `docs/migration-cutover.md`
- Modify: `docs/README.md`
- Create: `.changeset/freeze-reversible-migration-protocol.md`

**Interfaces:**
- Consumes: the implemented phase/effect table, storage layout, error reasons, and recovery behavior.
- Produces: user/operator guidance and a minor Changeset.

- [ ] **Step 1: Document the protocol without claiming later issue behavior**

  Explain generation identity, source/destination witness meaning, phase/effect table, pending-effect readback/abandonment rule, immutable sharded revisions/head, exact private modes and size bounds, lock ordering, compare-and-swap behavior, settled lineage, why live post-cutover trees are not rehashed on ordinary reads, sanitized failure classes, and which later commands will consume the protocol. Explicitly state that #621 alone does not copy, activate, or rollback data.

- [ ] **Step 2: Link the operator guide from the documentation index**

  Add `migration-cutover.md` to the appropriate operations/storage section of `docs/README.md`, using the established one-line description style.

- [ ] **Step 3: Add the minor Changeset**

  Use package `@donadiosolutions/lcm` and summary: `Add the checksum-sealed reversible-migration manifest, legal transition protocol, and crash-recoverable private revision journal used by SQLite/PostgreSQL cutover workflows.`

- [ ] **Step 4: Run documentation/static consistency checks**

  Run `rg -n "planned|dry-run-verified|copying|copied|verified|activating|active|rolling-back|rolled-back|aborted" docs/migration-cutover.md src/migration/protocol.ts` and compare every documented phase/error/layout value to production constants.

---

### Task 6: Complete Verification and Signed Commit

**Files:**
- Verify all files above; do not add unrelated fixes.

**Interfaces:**
- Consumes: completed #621 implementation.
- Produces: exact-head evidence suitable for MoM review and the protected PR workflow.

- [ ] **Step 1: Run focused tests**

  Run `npx vitest run test/migration/protocol.test.ts test/migration/manifest-store.test.ts test/codecov-config.test.ts`.

- [ ] **Step 2: Run static and build gates**

  Run `npm run typecheck && npm run lint && npm run build`.

- [ ] **Step 3: Run the complete coverage gate**

  Run `npm run test:ci` and require fresh exact output showing 100% statements, branches, functions, and lines for the complete collected scope and every production file.

- [ ] **Step 4: Review the diff and changeset question**

  Run `git diff --check`, inspect `git diff --stat` and `git diff --name-only`, confirm only #621 files changed, confirm no dependency/lockfile changes, and confirm the minor Changeset accurately describes the new behavior.

- [ ] **Step 5: Commit the reviewed implementation**

  Stage only the intended files and run `git commit --signoff -m "feat(migration): freeze reversible protocol"`. Verify `git verify-commit HEAD`, the DCO trailer, clean status, and the exact commit SHA before MoM adversarial review.

## Plan Self-Review

- Spec coverage: durable generation identity, source/destination witnesses, ordered phases, canonical checksums, checkpoints, reports, activation eligibility, rollback lineage, terminal retention, legal transitions, private/fsync-safe writes, and crash recovery each map to Tasks 1-3; docs/Changeset and exact 100% gates map to Tasks 4-6.
- Placeholder scan: no `TBD`, `TODO`, “similar to,” unspecified test request, or unresolved interface remains.
- Type consistency: every Task 2-5 symbol is defined in the Frozen Public Contract or produced by an earlier task; `active` is settled only when no effect is pending and retains the explicit legal rollback edge.
- Scope check: #621 supplies protocol and journal only. No snapshot bytes, PostgreSQL transaction, configuration publication, CLI, or rehearsal implementation is pulled forward from #622-#628.
