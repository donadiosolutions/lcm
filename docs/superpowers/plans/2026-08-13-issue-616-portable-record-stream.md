# Issue #616 Canonical Portable Record Stream Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development`. Follow this plan task by task,
> write the public-seam test first, and do not recursively invoke the MoM
> workflow.

**Goal:** Freeze one backend-neutral, versioned, bounded record stream whose
canonical bytes, domain order, and resumable checkpoints can be shared by
portable import/export and reversible SQLite/PostgreSQL migration.

**Architecture:** Add a strict domain codec in
`src/storage/portable-record.ts` and the stream/manifest/checkpoint protocol in
`src/storage/portable-record-stream.ts`. Source adapters normalize backend
values into the domain union and expose one already-bounded page seam; a shared
validated stream wrapper checks exact keys and dependencies, produces canonical
UTF-8 JSON and SHA-256 digests, and advances one domain checkpoint only after a
complete bounded page exists. The contract is project-scoped, contains no SQL,
table names, paths to storage files, publication mechanics, destination
transactions, or migration state machine types.

**Tech Stack:** TypeScript 6.0, Node.js 22+ `node:crypto`, Vitest 4.1.10. No
new dependency and no package-lock change.

## Global constraints

- This branch and PR close only issue #616. Do not absorb #615 or #617-#620,
  and do not publish #616 until the one-issue #615 PR is merged and the
  canonical Codex post-merge resync has passed.
- Preserve the existing `src/portable-knowledge.ts` `ExportDocument` version 1
  behavior. Issue #618 owns routing the CLI and replacing/bridging that
  promoted-memory-only format; #616 supplies the exact lower-level protocol.
- Do not modify `src/migration/**`, `src/security-files.ts`,
  `src/storage/backend-publication.ts`, or
  `src/storage/home-lock-topology.ts`. #621 owns the current migration protocol;
  #622 owns `src/migration/sqlite-snapshot.ts`; #623 owns
  `src/migration/batch-copy.ts`.
- The exact import seam for #622, #623, and #626 is
  `src/storage/portable-record-stream.ts`. That module re-exports the record
  types needed by consumers. It must not import from `src/migration/**`.
- #623 maps `PortableCheckpoint.checkpointSha256` to #621's
  `MigrationCheckpoint.sourceCheckpointSha256`, the `PortableDomain` literal to
  its string `domain`, `nextOrdinal` to its numeric `ordinal`, and
  `recordCount` directly. Portable control ordinals/counts are nonnegative safe
  JavaScript integers specifically to match #621; tagged signed-64 integers are
  reserved for record data. #623 alone owns `destinationCommitSha256`, fencing,
  destination idempotency, uncertain-commit readback, and publication.
  `nextOrdinal` is the exclusive next zero-based record position (initial `0`,
  terminal domain count) and maps unchanged to #621 `ordinal`; `recordCount`
  is the cumulative number accepted and is equal to `nextOrdinal` in v1. #623
  must durably store the canonical serialized portable checkpoint as its own
  generation artifact and bind its SHA-256 into #621; #621 intentionally stores
  the hash, not the resumable checkpoint body.
- Portable record timestamps retain exact six-digit source precision. The
  separate #621 manifest/witness/report timestamps remain canonical JavaScript
  millisecond ISO strings, as required by #621's exact parser; consumers must
  use their operation clock for those control timestamps and must not truncate
  a record timestamp into a #621 timestamp field.
- #622 and #626 own backend readers/snapshot lifecycles. This issue defines the
  normalization contract and validates backend-shaped fixtures, but does not
  open SQLite or PostgreSQL, execute SQL, acquire a lease, write a destination,
  or publish a migration artifact.
- `PortableRecordWriter` and transfer orchestration remain #618-owned for
  ordinary CLI import/export and #623-owned for fenced migration. #616 freezes
  the source checkpoint those writers acknowledge only after their own
  authoritative commit/readback; it does not invent a backend-neutral
  transaction or durability primitive.
- A stream represents exactly one project plus the authenticated identity and
  sidecar records needed to reconstruct it. Physical conversation/message/
  recall integer IDs are not portable: SQLite allocates them independently per
  project while PostgreSQL sequences are installation-global. Derive stable
  project-scoped logical identities from the exact tuples below and let #618/
  #623 writers maintain the logical-to-physical map transactionally. A portable
  project identity is exactly
  `{ scope: "shared", projectId: <registered remote UUIDv7> }` for any
  cross-backend stream, or
  `{ scope: "local", projectId: <64-hex local project hash> }` for an unbound
  SQLite-only export. Shared identity takes precedence whenever the project map
  carries a remote binding; the PostgreSQL source derives the same value from
  `projects.project_id`. Because that UUIDv7 is the registered stable project
  authority across machines, preserving it is intentional; it is not treated
  as a backend-local surrogate. A local-scoped stream may be reapplied only to
  that exact local project unless #618 performs an explicit authenticated
  rebind;
  it never silently compares equal to a shared stream. Local path hashes,
  display names, creation/update times, and alias-link timestamps are
  backend-local metadata, not substitute project identities.
  PostgreSQL `projects.identity_key` is excluded because current public reads
  do not expose it and it is neither authorization nor portable identity.
  PostgreSQL's required `projects.display_name` and local machine identity's
  required display name are also intentionally non-portable: #618/#623/#626
  writers preserve existing destination values or derive nonblank
  operator-facing names from their selected-project/host context, and #624
  excludes both from canonical reconciliation. Neither gates identity equality.
  Preserve caller-owned IDs (`partId`,
  `summaryId`, `fileId`, `memoryId`, event UUID, ingest key) verbatim. Preserve
  registered root `machineId`/`remoteProjectId` UUIDv7 bindings and identity
  keys. Exclude only
  nonportable physical keys (conversation/message/recall integers,
  `summary_key`, `file_key`, `inbox_id`, `instruction_id`, session-ingest
  `ingest_key`, transcript UUID), generated
  search/digest columns, indexes, ACLs, ledgers, FTS tables, leases, claims,
  retry deadlines, and local error logs.
- Portable records are sensitive transfer material, not log-safe diagnostics.
  Exact alias/worktree/cwd paths and native `sourceLocator` are included only
  because they are durable semantics needed to reconstruct identity,
  instruction scope, and ingest checkpoints. Hashes and scrubbed payloads are
  integrity/privacy boundaries, not secrecy: callers must protect stream bytes
  like the source database. Error/verification objects never echo those fields.
- Preserve acknowledged semantic state, not transient execution ownership.
  Passive-event records contain the immutable envelope and a normalized
  disposition (`pending`, `applied`, or `quarantined`). PostgreSQL
  `pending`/`claimed`/`retry` and local
  `pending`/`claimed`/`retry`/`replicated` normalize to `pending`; PostgreSQL
  `applied` and local `acknowledged` normalize to `applied`; both quarantine
  states normalize to `quarantined`. More exactly, a local row is `applied`
  when `processed_at` is non-null or delivery is `acknowledged`; it is
  `quarantined` only when not processed and delivery is `quarantined`; all
  other local delivery states are `pending`. This precedence prevents a
  promoted source event from being replayed after its resulting memories were
  copied. A PostgreSQL row maps `applied`/`quarantined` literally and maps
  `pending`/`claimed`/`retry` to `pending`. Destination writers may preserve a
  more advanced existing state but never regress it. Claim owner,
  attempt/retry timestamps, inbox ID, and arbitrary quarantine text are
  excluded.
- The passive-event semantic payload is exact rather than generic. V1 carries
  `sessionId`, nonnegative-safe `sessionSequence`, `category`, `data`,
  signed-safe `priority`, `sourceHook`, and `createdAt` alongside the outer event UUID,
  version, machine sequence, and type. This is the exact current local-to-remote
  replication projection and preserves every field consumed by promotion.
  Local `prev_event_id`/remote `payload.previousEventId` is explicitly excluded:
  it is a sidecar-local physical correlation pointer, PostgreSQL stores no
  portable predecessor identity, and current promotion derives correlations
  from session/sequence/content rather than this pointer. `processed_at` and
  all delivery bookkeeping are execution state represented only by normalized
  disposition where applicable.
- Native transcripts, their ordered message links, and native-ingest
  checkpoints are first-class separate domains, not opaque sidecars. Splitting
  links prevents one transcript envelope from becoming unbounded. Local
  transcript-quarantine rows remain authenticated recovery evidence owned by
  #622/#626 because no cross-backend authoritative repository consumes them.
- Every source declares every domain as `available` or
  `authoritative-empty`. Legacy SQLite may declare transcript/link/checkpoint
  domains authoritative-empty only when authenticated generation evidence
  proves that architecture never stored them; a reversed SQLite generation
  uses #626-owned sidecars and declares them available. SQLite machine/project/
  alias records come from authenticated installation identity/project-map
  material, instructions from the project cache plus machine identity, and
  passive events from the authenticated local outbox/generation sidecar. A
  missing or unsupported domain is incomplete coverage and cannot describe a
  complete stream. #622/#626 own capturing and restoring those sources.
- Keep the existing supported data contract: reject NUL and malformed UTF-16;
  recursively sort object keys using locale-independent code-unit order;
  preserve array order and duplicates; reject sparse arrays, extra array
  properties, accessors, symbol keys, cycles, unsupported prototypes,
  `undefined`, symbols, functions, non-finite numbers, negative zero, and
  unsafe JSON integers; cap JSON depth at 100. Canonical finite safe numbers
  use ECMAScript `JSON.stringify` spelling; the implementation ships golden
  ASCII/UTF-8/escape/exponent bytes and SHA-256 vectors.
- Canonical storage integers use `{ "$integer": "<decimal>" }`, with no plus
  sign, leading zero, or negative zero and with the exact signed 64-bit range.
  Domain validators narrow positive/nonnegative and PostgreSQL `int4` fields as
  required. Embedded user JSON remains JSON and is never reinterpreted merely
  because an object has a `$integer` key.
- Canonical timestamps use UTC RFC 3339 with exactly six fractional digits
  (`YYYY-MM-DDTHH:mm:ss.ffffffZ`). This preserves PostgreSQL microseconds and
  losslessly expands SQLite second/millisecond values. Adapters must not pass a
  JavaScript `Date` when doing so would discard source sub-millisecond digits;
  the contract accepts adapter-only raw timestamp strings and performs no
  repository-API round trip before canonicalization.
- Canonical floating fields (`confidence` and `stepCost`) are finite IEEE-754
  numbers serialized by canonical JSON; negative zero is rejected rather than
  normalized. Their existing repository/schema ranges still apply.
- Hash only exact canonical UTF-8 bytes with lowercase SHA-256. Domain prefix
  hashing uses an explicit version/domain seed and length-prefixed record bytes,
  so record boundaries cannot collide. `PORTABLE_RECORD_SCHEMA_SHA256` is
  `sha256(canonicalJson(["lcm-portable-schema-v1",
PORTABLE_RECORD_SCHEMA_DESCRIPTOR]))`. That one frozen descriptor contains
  exact domains, versions, fields, scalar/canonicalization rules,
  logical-key/order tuples, dependency domains, and coverage rules. Stream
  limits are exact manifest fields bound separately by the manifest checksum,
  avoiding a circular record/stream module dependency.
- `PORTABLE_LIMITS` is exactly `{ maxJsonDepth: 100,
maxRecordBytes: 64 * 1024 * 1024, maxBatchRecords: 500,
maxBatchBytes: 72 * 1024 * 1024, maxControlBytes: 1024 * 1024 }`. The five
  values are manifest-bound. A source always receives the global 500-record / 72
  MiB page limits even when the caller requests lower limits, so it returns a
  source-bounded page from which the wrapper selects the caller-bounded prefix. A
  globally representable record larger than the caller limit yields retryable
  `batch-limit-exceeded`; one above the global record limit yields terminal
  `record-unrepresentable`; neither advances the prior checkpoint. The 64 MiB
  limit exceeds the proven maximum canonical encoding of a valid 10 MiB native
  transcript input, including six-byte JSON escape forms, sorted keys,
  envelope fields, and one newline. Task 3 freezes both the mathematical bound
  and an adversarial near-limit vector; transcript links remain separate.
- Compatibility is exact in version 1: one stream version, one schema digest,
  the complete known domain inventory, and domain version 1. Unknown versions,
  domains, record fields, missing domains, or schema digests fail closed. A
  future version requires an explicit translator; there is no downgrade,
  unknown-record skip, or best-effort import.
- Every public value returned by the codec is deeply frozen. All errors are
  cause-free and serialize only fixed codes plus bounded domain, ordinal/count,
  retryability, manifest/checkpoint digest, and prior-checkpoint evidence.
  Never serialize record identity hashes, payloads, paths, arbitrary quarantine
  text, connection material, SQL, or raw driver/parser errors.
- `readBatch()` and `verify()` calls are serialized on one stream. An already
  aborted signal or an abort observed after queued/source work yields fixed
  cause-free `aborted` without a checkpoint. `close()` atomically rejects new
  work, waits for the current queued operation, closes the source once, and is
  idempotent; it does not manufacture successful evidence from aborted work.
- Maintain literal 100% statement, branch, function, and line coverage for
  every new production path. Do not add exclusions, ignore directives, skipped
  tests, or test-only production wrappers.
- Rebase onto the merged #615 `origin/main` before publishing #616. Preserve
  whatever #621 taxonomy/docs have merged by then, but do not treat #621 as a
  #616 hard blocker. Derive Codecov counts from the exact rebased tree; no
  forecast is authoritative.
- Every commit must be GPG-signed and use `--signoff`. Do not use prohibited
  branch/PR prefixes or agent attribution.

## Design alternatives resolved

1. **Selected: strict logical-domain union plus source-enforced pages.** This
   keeps dialect details in adapters, makes unknown fields impossible to skip,
   and lets the source prove record and memory bounds before returning a page.
   Each domain declares a portable total order and each resumed page
   includes one predecessor record, so the wrapper verifies boundary continuity
   without storing a sensitive key in the checkpoint or sorting whole domains.
2. **Rejected: generic canonical table rows.** The earlier reversible-migration
   prototype was compact, but physical table shapes leaked into the protocol,
   durable message-part fields were omitted, and transcript/event/checkpoint
   data became unaudited sidecars.
3. **Rejected: the issue sketch's unbounded async iterator.** A consumer-side
   `break` cannot prove a faulty reader bounded its own query/memory, and an
   iterator has no atomic place to return a verified next checkpoint after a
   complete page.

## Canonical domain inventory and dependency order

Each record envelope has exact keys
`{ version, domain, domainVersion, ordinal, order, identitySha256,
dependencies, value, recordSha256 }`. Each dependency has exact keys
`{ domain, identitySha256 }`. `identitySha256` is the SHA-256 of the canonical
logical-key preimage `["lcm-portable-identity-v1", domain, logicalKey]`, not a
backend row key. `recordSha256` hashes the canonical envelope without its
`recordSha256` member. Dependencies are sorted by domain order then hash,
contain no duplicates, and point only to an earlier domain. `logicalKey` is an
exact domain tuple from the table below whose scalar types are string, tagged
integer, or null. Each domain has a declared portable total order with explicit
tie-breakers. The logical-key fields (or the unhashed fields that produce a
key fingerprint) lead that order, so equal identities are necessarily adjacent;
the schema descriptor freezes and tests this invariant. Ordinals are positions
in that order. A resumed source page
contains the prior terminal record plus new records. The wrapper authenticates
the predecessor against the checkpoint's last identity/record digests, derives
and compares exact order tuples across the boundary, and rejects equality or
regression. Terminal count/prefix validation detects omissions and all other
cross-page drift; no whole-domain in-process sort or trusted inventory duplicate
claim is required. `order` is a domain-specific tuple of strings, tagged
integers, and nulls. Tuple comparison is positional: null sorts before non-null,
tagged integers compare numerically, and strings compare by unsigned UTF-8
bytes. Raw adapters use explicit `BINARY` (SQLite) or `C` (PostgreSQL)
collation, explicit null placement, and numeric column order. They may use a
bounded keyset/temporary-index query when the installed schema lacks the exact
portable index; #622/#618/#626 own those SQL plans. No adapter may substitute a
physical row ID as a final tie-breaker.

Composite parent order is always flattened, never nested. The exact v1 flat
forms are:

- `conversations`: `[sessionId, title, bootstrappedAt, createdAt, updatedAt,
occurrenceOrdinal]`;
- `messages`: `[sessionId, title, bootstrappedAt, conversationCreatedAt,
conversationUpdatedAt, conversationOccurrenceOrdinal, seq]`;
- `message-parts`: `[sessionId, title, bootstrappedAt,
conversationCreatedAt, conversationUpdatedAt,
conversationOccurrenceOrdinal, messageSeq, ordinal]`;
- `context-items`: `[sessionId, title, bootstrappedAt,
conversationCreatedAt, conversationUpdatedAt,
conversationOccurrenceOrdinal, ordinal]`.

All other rows use the literal flat tuples printed in the table. These exact
field-name arrays live in the schema descriptor and therefore affect its digest.

```ts
export interface PortableRecord<D extends PortableDomain = PortableDomain> {
  readonly version: 1;
  readonly domain: D;
  readonly domainVersion: 1;
  /** Zero-based safe position in this domain's portable total order. */
  readonly ordinal: number;
  readonly order: readonly (string | PortableSignedInt64 | null)[];
  readonly identitySha256: string;
  readonly dependencies: readonly Readonly<{
    domain: PortableDomain;
    identitySha256: string;
  }>[];
  readonly value: PortableRecordValueByDomain[D];
  readonly recordSha256: string;
}
```

| Order | Domain and coverage                               | Logical-key tuple / portable order                                                                                                                                                   | Canonical value and earlier dependencies                                                                                                               |
| ----: | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
|     1 | `machines` (identity/sidecar)                     | `[identityKey]` / identity key                                                                                                                                                       | identity key and nullable registered machine UUIDv7; display name is deliberately excluded as mutable presentation metadata; none                      |
|     2 | `project` (identity/sidecar)                      | `[scope, projectId]` / same; shared takes precedence over local                                                                                                                      | exact portable identity only; none                                                                                                                     |
|     3 | `project-aliases` (identity/sidecar)              | key `[machineIdentityKey, normalizedPath]`; order adds `path` as a conflict tie-breaker                                                                                              | exact and normalized path; machine, project                                                                                                            |
|     4 | `conversations` (both DBs)                        | key `[conversationFingerprint, occurrenceOrdinal]`; order `[sessionId, title, bootstrappedAt, createdAt, updatedAt, occurrenceOrdinal]`                                              | fingerprint of the five preceding portable fields plus zero-based exact-duplicate occurrence; project                                                  |
|     5 | `messages` (both DBs)                             | key `[conversationIdentitySha256, seq]`; order `[sessionId, title, bootstrappedAt, conversationCreatedAt, conversationUpdatedAt, conversationOccurrenceOrdinal, seq]`                | conversation identity, sequence, role/content/tokens/time; conversation                                                                                |
|     6 | `message-parts` (raw DB)                          | key `[messageIdentitySha256, ordinal]`; order `[sessionId, title, bootstrappedAt, conversationCreatedAt, conversationUpdatedAt, conversationOccurrenceOrdinal, messageSeq, ordinal]` | message identity, caller part ID plus every durable part field; message                                                                                |
|     7 | `large-files` (both DBs)                          | `[fileId]` / exact file ID                                                                                                                                                           | file/conversation metadata and time; conversation                                                                                                      |
|     8 | `summaries` (both DBs)                            | `[summaryId]` / exact summary ID                                                                                                                                                     | summary metrics/content/times; conversation                                                                                                            |
|     9 | `summary-file-links` (raw DB)                     | key/order `[summaryId, ordinal]`; file ID in value                                                                                                                                   | one ordered opaque file reference; summary only because unresolved IDs are legal                                                                       |
|    10 | `summary-message-links` (both DBs)                | key `[summaryId, messageIdentitySha256]`; order `[summaryId, messageIdentitySha256, ordinal]`                                                                                        | ordered relationship; summary, message                                                                                                                 |
|    11 | `summary-parent-links` (both DBs)                 | key `[summaryId, parentSummaryId]`; order `[summaryId, parentSummaryId, ordinal]`                                                                                                    | ordered DAG edge; both summaries                                                                                                                       |
|    12 | `context-items` (both DBs)                        | key `[conversationIdentitySha256, ordinal]`; order `[sessionId, title, bootstrappedAt, conversationCreatedAt, conversationUpdatedAt, conversationOccurrenceOrdinal, ordinal]`        | exactly one message/summary target and time; conversation and target                                                                                   |
|    13 | `promoted-memories` (both DBs)                    | `[memoryId]` / exact memory ID                                                                                                                                                       | content, metadata, normalized external source project/summary, session/depth/confidence/times; project; source provenance remains deliberately unbound |
|    14 | `promoted-memory-tags` (both DBs)                 | `[memoryId, ordinal]` / same                                                                                                                                                         | one exact ordered tag; promoted memory                                                                                                                 |
|    15 | `recall-surfacings` (both DBs)                    | `[memoryId, sessionId, surfacedAt, occurrenceOrdinal]` / same                                                                                                                        | nullable-session occurrence preserves duplicates; project; no memory FK invented                                                                       |
|    16 | `redaction-counters` (both DBs)                   | `[category]` / category enum order                                                                                                                                                   | category/count; project                                                                                                                                |
|    17 | `session-ingest` (both DBs)                       | `[sessionId]` / exact session ID                                                                                                                                                     | session/count/completion; project                                                                                                                      |
|    18 | `session-instructions` (DB + identity)            | `[machineIdentityKey, scopeHash]` / same                                                                                                                                             | client/session/worktree/cwd/content/hash/time; machine, project                                                                                        |
|    19 | `native-transcripts` (PG or sidecar)              | `[machineIdentityKey, ingestKey]` / same                                                                                                                                             | client/format/session/source, source ordinal, times, scrubber/content/ingest hashes, payload; machine, project                                         |
|    20 | `native-transcript-message-links` (PG or sidecar) | key/order `[machineIdentityKey, ingestKey, sourceOrdinal]`; logical conversation/message identities in value                                                                         | transcript, message                                                                                                                                    |
|    21 | `native-transcript-checkpoints` (PG or sidecar)   | `[machineIdentityKey, clientName, sourceLocator]` / same                                                                                                                             | revision/counts/last ordinal/checkpoint/time; machine, project                                                                                         |
|    22 | `passive-events` (PG or sidecar)                  | key `[machineIdentityKey, eventId]`; order `[machineIdentityKey, eventId, machineSequence]`                                                                                          | exact session/sequence/category/data/priority/source-hook/time envelope and fixed disposition; machine, project                                        |

Physical extraction is deliberately downstream-owned, but the v1 mapping is
frozen here so adapters cannot select different semantics:

| Portable domain                                                                          | SQLite material                                                                          | PostgreSQL material                                                                                                  |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `machines`, `project`, `project-aliases`                                                 | authenticated `machine.json` and project-map/generation identity                         | `machines`, `projects`, `project_aliases`                                                                            |
| `conversations`, `messages`                                                              | same-named project tables                                                                | same-named `lcm` tables, with physical IDs used only to join during extraction                                       |
| `message-parts`                                                                          | all physical columns from `message_parts`                                                | all physical columns from `lcm.message_parts`                                                                        |
| `large-files`                                                                            | `large_files`                                                                            | `lcm.large_files`                                                                                                    |
| `summaries`                                                                              | `summaries` excluding embedded `file_ids`                                                | `lcm.summaries` excluding generated/internal columns                                                                 |
| `summary-file-links`                                                                     | explode `summaries.file_ids` by array ordinal                                            | `lcm.summary_large_files`                                                                                            |
| `summary-message-links`, `summary-parent-links`, `context-items`                         | same-named relationship tables                                                           | `lcm.summary_messages`, `lcm.summary_parents`, `lcm.context_items`, joining internal summary keys back to caller IDs |
| `promoted-memories`, `promoted-memory-tags`                                              | `promoted`, exploding embedded `tags` by ordinal                                         | `lcm.promoted_memories`, `lcm.promoted_memory_tags`                                                                  |
| `recall-surfacings`, `redaction-counters`, `session-ingest`                              | `recall_surfacing`, `redaction_stats`, `session_ingest_log`                              | corresponding `lcm` tables                                                                                           |
| `session-instructions`                                                                   | `session_instruction_cache` plus authenticated machine identity                          | `lcm.session_instructions` joined to machine identity key                                                            |
| `native-transcripts`, `native-transcript-message-links`, `native-transcript-checkpoints` | authenticated generation sidecar, or authoritative-empty only for a proven legacy source | `lcm.native_transcripts`, `lcm.transcript_messages`, `lcm.ingest_checkpoints`                                        |
| `passive-events`                                                                         | authenticated local outbox/generation sidecar                                            | `lcm.passive_event_inbox`, normalized as specified above                                                             |

`conversationFingerprint` is the SHA-256 of canonical
`["lcm-portable-conversation-value-v1", sessionId, title, bootstrappedAt,
createdAt, updatedAt]`; `occurrenceOrdinal` is zero-based only among records
with that exact fingerprint. `recall-surfacings` assigns the same kind of
ordinal within `[memoryId, sessionId|null, surfacedAt]`. Adapters may enumerate
physically distinct rows only to assign ordinals inside an otherwise
indistinguishable portable-value group, then must emit the portable tuple plus
ordinal. #618/#623 writers insert each equal group in occurrence order and
preserve its fields, so re-export recomputes the same ordinals. A subsequent
edit deliberately changes the conversation fingerprint and therefore the
snapshot identity; resume validation classifies that as source drift. Physical
IDs never enter a key, value other than the occurrence number, order tuple, or
hash. Task 3 proves equal-timestamp conversations with distinct portable
values sort independently of physical IDs, exact duplicates with different
dependent messages preserve occurrence order across a round trip, nullable
recalls, and repeated identical recalls remain byte-identical.

No repository API is assumed to expose the needed raw precision or physical
columns. #622 implements authenticated SQLite/snapshot extraction, #618 owns
ordinary selected-backend import/export adapters, and #623/#626 own migration
writers/reverse sidecars. #616 owns only these normalized shapes, ordering,
coverage states, and codec/stream validation.

Message-part parity explicitly includes `isIgnored`, `isSynthetic`,
`toolStatus`, `toolError`, `toolTitle`, `patchHash`, `patchFiles`, `fileMime`,
`fileName`, `fileUrl`, `subtaskPrompt`, `subtaskDescription`, `subtaskAgent`,
`stepReason`, `stepCost`, `stepTokensIn`, `stepTokensOut`, `snapshotHash`, and
`compactionAuto` in addition to the fields already exposed by
`MessagePartRecord`.

Promoted-memory `sourceProjectId` has one canonical spelling: `null` means
“this stream's own project or no distinct external source.” A SQLite adapter
emits `null` when stored `promoted.project_id` equals the stream's local/shared
project selector; PostgreSQL emits `null` for either SQL `NULL` or a
`source_project_id` equal to that same selected project identity. Writers map
canonical `null` to the backend's self/default representation and preserve only
a distinct external source string verbatim. Task 3 covers SQL `NULL`, explicit
self, and distinct external provenance in both directions.

### Exact v1 value shapes

All value objects are exact (no missing or additional keys), deeply frozen,
and use camelCase. `PortableSignedInt64`, `PortableNonnegativeInt64`,
`PortablePositiveInt4`, `PortableNonnegativeInt4`,
`PortableSignedSafeInteger`, and `PortableNonnegativeSafeInteger` share the exact wire shape
`{ "$integer": "<canonical decimal>" }` but enforce respectively signed int64,
`0..2^63-1`, `1..2^31-1`, `0..2^31-1`, signed safe integer,
and `0..Number.MAX_SAFE_INTEGER`. The type aliases are nominally branded so
validators cannot substitute one range for another.
`PortableTimestamp` is the exact
six-digit UTC string. `JsonValue` is the canonical JSON subset above. Nullable
means the key is present with `null`, never omitted. The discriminated union is
frozen as follows:

```ts
declare const portableIntegerRange: unique symbol;
type PortableInteger<R extends string> = Readonly<{
  $integer: string;
  /** Compile-time brand only; no symbol property exists on the wire object. */
  readonly [portableIntegerRange]: R;
}>;
type PortableSignedInt64 = PortableInteger<"signed-int64">;
type PortableNonnegativeInt64 = PortableInteger<"nonnegative-int64">;
type PortablePositiveInt4 = PortableInteger<"positive-int4">;
type PortableNonnegativeInt4 = PortableInteger<"nonnegative-int4">;
type PortableSignedSafeInteger = PortableInteger<"signed-safe-integer">;
type PortableNonnegativeSafeInteger =
  PortableInteger<"nonnegative-safe-integer">;
type PortableIntegerValue =
  | PortableSignedInt64
  | PortableNonnegativeInt64
  | PortablePositiveInt4
  | PortableNonnegativeInt4
  | PortableSignedSafeInteger
  | PortableNonnegativeSafeInteger;

type PortableProjectIdentity =
  | Readonly<{ scope: "shared"; projectId: string }>
  | Readonly<{ scope: "local"; projectId: string }>;

type PortableRecordValueByDomain = Readonly<{
  machines: Readonly<{ identityKey: string; machineId: string | null }>;
  project: Readonly<{ identity: PortableProjectIdentity }>;
  "project-aliases": Readonly<{
    machineIdentityKey: string;
    path: string;
    normalizedPath: string;
  }>;
  conversations: Readonly<{
    conversationFingerprint: string;
    occurrenceOrdinal: PortableNonnegativeSafeInteger;
    sessionId: string;
    createdAt: PortableTimestamp;
    title: string | null;
    bootstrappedAt: PortableTimestamp | null;
    updatedAt: PortableTimestamp;
  }>;
  messages: Readonly<{
    conversationIdentitySha256: string;
    seq: PortableNonnegativeInt64;
    role: "system" | "user" | "assistant" | "tool";
    content: string;
    tokenCount: PortableNonnegativeInt64;
    createdAt: PortableTimestamp;
  }>;
  "message-parts": Readonly<{
    messageIdentitySha256: string;
    partId: string;
    sessionId: string;
    partType:
      | "text"
      | "reasoning"
      | "tool"
      | "patch"
      | "file"
      | "subtask"
      | "compaction"
      | "step_start"
      | "step_finish"
      | "snapshot"
      | "agent"
      | "retry";
    ordinal: PortableNonnegativeInt64;
    textContent: string | null;
    isIgnored: boolean | null;
    isSynthetic: boolean | null;
    toolCallId: string | null;
    toolName: string | null;
    toolStatus: string | null;
    toolInput: string | null;
    toolOutput: string | null;
    toolError: string | null;
    toolTitle: string | null;
    patchHash: string | null;
    patchFiles: string | null;
    fileMime: string | null;
    fileName: string | null;
    fileUrl: string | null;
    subtaskPrompt: string | null;
    subtaskDescription: string | null;
    subtaskAgent: string | null;
    stepReason: string | null;
    stepCost: number | null;
    stepTokensIn: PortableNonnegativeInt64 | null;
    stepTokensOut: PortableNonnegativeInt64 | null;
    snapshotHash: string | null;
    compactionAuto: boolean | null;
    metadata: string | null;
  }>;
  "large-files": Readonly<{
    fileId: string;
    conversationIdentitySha256: string;
    fileName: string | null;
    mimeType: string | null;
    byteSize: PortableNonnegativeInt64 | null;
    storageUri: string;
    explorationSummary: string | null;
    createdAt: PortableTimestamp;
  }>;
  summaries: Readonly<{
    summaryId: string;
    conversationIdentitySha256: string;
    kind: "leaf" | "condensed";
    depth: PortableNonnegativeInt4;
    content: string;
    tokenCount: PortableNonnegativeInt64;
    earliestAt: PortableTimestamp | null;
    latestAt: PortableTimestamp | null;
    descendantCount: PortableNonnegativeInt64;
    descendantTokenCount: PortableNonnegativeInt64;
    sourceMessageTokenCount: PortableNonnegativeInt64;
    createdAt: PortableTimestamp;
  }>;
  "summary-file-links": Readonly<{
    summaryId: string;
    ordinal: PortableNonnegativeInt4;
    fileId: string;
  }>;
  "summary-message-links": Readonly<{
    summaryId: string;
    ordinal: PortableNonnegativeInt4;
    messageIdentitySha256: string;
  }>;
  "summary-parent-links": Readonly<{
    summaryId: string;
    ordinal: PortableNonnegativeInt4;
    parentSummaryId: string;
  }>;
  "context-items": Readonly<{
    conversationIdentitySha256: string;
    ordinal: PortableNonnegativeInt4;
    itemType: "message" | "summary";
    messageIdentitySha256: string | null;
    summaryId: string | null;
    createdAt: PortableTimestamp;
  }>;
  "promoted-memories": Readonly<{
    memoryId: string;
    content: string;
    metadata: JsonObject;
    sourceProjectId: string | null;
    sourceSummaryId: string | null;
    sessionId: string | null;
    depth: PortableNonnegativeInt4;
    confidence: number;
    createdAt: PortableTimestamp;
    archivedAt: PortableTimestamp | null;
  }>;
  "promoted-memory-tags": Readonly<{
    memoryId: string;
    ordinal: PortableNonnegativeInt4;
    tag: string;
  }>;
  "recall-surfacings": Readonly<{
    memoryId: string;
    sessionId: string | null;
    surfacedAt: PortableTimestamp;
    occurrenceOrdinal: PortableNonnegativeSafeInteger;
  }>;
  "redaction-counters": Readonly<{
    category: "built_in" | "global" | "project" | "gitleaks";
    count: PortableNonnegativeInt64;
  }>;
  "session-ingest": Readonly<{
    sessionId: string;
    messageCount: PortableNonnegativeInt64;
    completedAt: PortableTimestamp;
  }>;
  "session-instructions": Readonly<{
    machineIdentityKey: string;
    scopeHash: string;
    clientName: "claude" | "codex";
    sessionId: string;
    worktreePath: string;
    cwdPath: string;
    content: string;
    contentHash: string;
    updatedAt: PortableTimestamp;
  }>;
  "native-transcripts": Readonly<{
    machineIdentityKey: string;
    clientName: string;
    formatName: string;
    formatVersion: string;
    nativeSessionId: string;
    sourceLocator: string;
    sourceOrdinal: PortableNonnegativeInt64;
    observedAt: PortableTimestamp;
    ingestedAt: PortableTimestamp;
    scrubberVersion: string;
    contentSha256: string;
    ingestKey: string;
    nativePayload: JsonObject | readonly JsonValue[];
  }>;
  "native-transcript-message-links": Readonly<{
    machineIdentityKey: string;
    ingestKey: string;
    sourceOrdinal: PortableNonnegativeInt4;
    conversationIdentitySha256: string;
    messageIdentitySha256: string;
  }>;
  "native-transcript-checkpoints": Readonly<{
    machineIdentityKey: string;
    clientName: string;
    sourceLocator: string;
    revision: PortableNonnegativeSafeInteger;
    lastSourceOrdinal: PortableNonnegativeInt64;
    importedCount: PortableNonnegativeInt64;
    skippedCount: PortableNonnegativeInt64;
    quarantinedCount: PortableNonnegativeInt64;
    checkpoint: JsonObject;
    updatedAt: PortableTimestamp;
  }>;
  "passive-events": Readonly<{
    machineIdentityKey: string;
    eventId: string;
    eventVersion: PortablePositiveInt4;
    machineSequence: PortableNonnegativeInt64;
    eventType: string;
    sessionId: string;
    sessionSequence: PortableNonnegativeSafeInteger;
    category: string;
    data: string;
    priority: PortableSignedSafeInteger;
    sourceHook: string;
    createdAt: PortableTimestamp;
    disposition: "pending" | "applied" | "quarantined";
  }>;
}>;
```

The exact logical-key, order-field, dependency-domain, value-key, scalar-rule,
and coverage-rule arrays form `PORTABLE_RECORD_SCHEMA_DESCRIPTOR`. Its object
keys and every nested descriptor key are literal and canonicalized by the same
codec; `PORTABLE_RECORD_SCHEMA_SHA256` is the hash of
`["lcm-portable-schema-v1", PORTABLE_RECORD_SCHEMA_DESCRIPTOR]`. Task 1 checks
in the descriptor, its canonical byte vector, and its lowercase hash constant,
then tests that changing any field/order/dependency/nullable/range marker
changes the digest. No descriptive prose or TypeScript property enumeration is
used as runtime schema input.

## Exact public stream seam

```ts
export interface PortableRecordStream {
  describe(): PortableManifest;
  readBatch(input: PortableReadBatchInput): Promise<PortableBatch>;
  verify(checkpoint: PortableCheckpoint): Promise<PortableVerification>;
  close(): Promise<void>;
}

export interface PortableRecordSource {
  describeSource(): PortableSourceDescription;
  readDomainPage(input: PortableSourcePageInput): Promise<PortableSourcePage>;
  verifySource(
    input: PortableSourceVerificationInput
  ): Promise<"unchanged" | "changed" | "invalid" | "unavailable">;
  close(): Promise<void>;
}

export interface PortableSourcePageInput {
  readonly domain: PortableDomain;
  readonly afterOrdinal: number;
  readonly includePredecessor: boolean;
  /** Global source cap; the wrapper applies any lower caller record count. */
  readonly maxRecords: 500;
  /** Always PORTABLE_LIMITS.maxBatchBytes, even for a lower caller batch. */
  readonly maxBytes: 75497472;
  readonly signal?: AbortSignal;
}

export interface PortableSourcePage {
  readonly predecessor: PortableRecord | null;
  readonly records: readonly PortableRecord[];
  readonly complete: boolean;
}

export interface PortableSourceDescription {
  readonly capturedAt: string;
  readonly sourceIdentitySha256: string;
  readonly sourceWitnessSha256: string;
  readonly coverage: Readonly<Record<PortableDomain, PortableCoverageEvidence>>;
}

export type PortableCoverageEvidence =
  | Readonly<{ state: "available"; evidenceSha256: string }>
  | Readonly<{
      state: "authoritative-empty";
      reason: "not-in-source-generation";
      evidenceSha256: string;
    }>;

export interface PortableSourceVerificationInput {
  readonly sourceIdentitySha256: string;
  readonly sourceWitnessSha256: string;
  readonly contentSha256?: string;
  readonly manifestSha256?: string;
  readonly signal?: AbortSignal;
}

export interface PortableReadBatchInput {
  readonly domain: PortableDomain;
  readonly after?: PortableCheckpoint;
  readonly maxRecords: number;
  readonly maxBytes: number;
  readonly signal?: AbortSignal;
}

export interface PortableLimits {
  readonly maxJsonDepth: 100;
  readonly maxRecordBytes: 67108864;
  readonly maxBatchRecords: 500;
  readonly maxBatchBytes: 75497472;
  readonly maxControlBytes: 1048576;
}

export interface PortableDomainManifest {
  readonly domain: PortableDomain;
  readonly domainVersion: 1;
  readonly coverage: PortableCoverageEvidence;
  readonly recordCount: number;
  readonly prefixSha256: string;
}

export interface PortableManifest {
  readonly version: 1;
  readonly schemaSha256: string;
  readonly source: PortableSourceDescription;
  readonly domains: readonly PortableDomainManifest[];
  readonly contentSha256: string;
  readonly limits: PortableLimits;
  readonly manifestSha256: string;
}

export interface PortableCheckpoint {
  readonly version: 1;
  readonly manifestSha256: string;
  readonly domain: PortableDomain;
  /** Exclusive next record position; always a nonnegative safe integer. */
  readonly nextOrdinal: number;
  /** Equals nextOrdinal in v1; repeated for #621's exact field mapping. */
  readonly recordCount: number;
  readonly prefixSha256: string;
  readonly lastRecordIdentitySha256: string | null;
  readonly lastRecordSha256: string | null;
  readonly previousCheckpointSha256: string | null;
  readonly complete: boolean;
  readonly checkpointSha256: string;
}

export interface PortableBatch {
  readonly version: 1;
  readonly manifestSha256: string;
  readonly domain: PortableDomain;
  /** Predecessor is verification-only and never appears in records. */
  readonly records: readonly PortableRecord[];
  readonly framedBytes: number;
  readonly complete: boolean;
  readonly priorCheckpointSha256: string | null;
  readonly checkpoint: PortableCheckpoint;
}

export interface PortableVerification {
  readonly version: 1;
  readonly manifestSha256: string;
  readonly domain: PortableDomain;
  readonly checkpointSha256: string;
  readonly nextOrdinal: number;
  readonly recordCount: number;
  readonly prefixSha256: string;
  readonly complete: boolean;
  readonly matchesManifestBoundary: boolean;
}
```

`PortableSourceDescription` synchronously exposes a frozen capture timestamp,
opaque source identity/witness digest, and complete 22-domain coverage evidence;
it contains no terminal counts or content digests. Every `evidenceSha256` is the
hash of adapter-owned canonical evidence captured under the same source
witness. For `available`, that evidence binds the exact table/sidecar identity
and captured generation. For `authoritative-empty`, it additionally binds the
source-generation schema/version proof that the domain did not exist there;
the sole v1 reason is `not-in-source-generation`. “Reader does not support it,”
missing sidecar, inaccessible table, or failed probe is never empty—it is
`source-invalid` or `source-unavailable`. #622/#626 persist the canonical
evidence payload; #616 validates only its state/reason/digest and binds it into
the manifest. The exact control shapes above define all nullability and empty
semantics. The manifest does not contain a backend name, and verification never
claims all domains were transferred; #624 owns whole-generation reconciliation.

`createPortableRecordStream(source)` is async and owns a bounded manifest
pre-pass. It snapshots `describeSource()`, reads every available domain page by
page using the fixed global bounds, validates predecessor/order/duplicates and
hashes records without retaining prior pages, verifies the exact source witness
after the scan, and then freezes the manifest. The transfer read is a deliberate
second pass. Before and after every page and at `verify(checkpoint)`, the wrapper
calls `verifySource` with the original witness/source/content/manifest digests;
an explicit adapter `changed` result becomes terminal `source-changed`, while an
`invalid` result becomes terminal `source-invalid`, and an adapter exception or
`unavailable` result becomes retryable `source-unavailable`. Source validation
owns backend-side foreign-key, required-reference, summary-DAG, identity, and
coverage checks; fixed outcomes carry no raw database reason.

For resumed reads the wrapper asks `readDomainPage` for one predecessor plus at
most 500 globally representable records under the 72 MiB global page cap. The
source always receives those fixed global bounds; the wrapper applies lower
caller count/byte limits after receiving a source-bounded page. The wrapper
authenticates the predecessor against `lastRecordIdentitySha256` and
`lastRecordSha256`, compares
the exact per-domain order tuple, then returns retryable
`batch-limit-exceeded` when the first new record exceeds the caller's lower
byte limit. Otherwise it returns the longest prefix within both lower caller
limits; `complete` remains false unless that prefix consumed an actually
complete source page. It rejects global over-return and inconsistent
completion/ordinal metadata. Initial reads require a null
predecessor. `authoritative-empty` domains are terminal with the seeded empty
prefix and the source is never asked to read them. The wrapper owns idempotent
close and settles in-flight operations before closing the source once.

The initial domain prefix is
`sha256(canonicalJson(["lcm-portable-domain-v1", manifest.schemaSha256,
domain, domainVersion]))`. Each record advances it as
`sha256(previousPrefixBytes || uint64be(byteLength) ||
canonicalRecordBytes)`, where the prefix is the decoded 32-byte hash and length
is unsigned big-endian. A manifest/checkpoint checksum hashes its canonical
object without the self-checksum member. The aggregate content hash processes
ordered decoded terminal domain digests with the same length-prefix rule.
`createPortableBatch` is pure: it validates the prior checkpoint, predecessor,
contiguous ordinals, exact domain/version/dependencies, local duplicates,
strict portable order, record/batch limits, and the manifest's terminal
count/digest before returning the next checkpoint. A terminal mismatch is
`partial-batch`/`source-changed`, never a new checkpoint. Any throw leaves the
caller's prior checkpoint as the only resume authority.

## Planned file ownership

Create:

- `src/storage/portable-record.ts`
- `src/storage/portable-record-stream.ts`
- `test/storage/portable-record.test.ts`
- `test/storage/portable-record-stream.test.ts`
- `test/storage/portable-record-parity.test.ts`
- `test/fixtures/portable-records.ts`
- `docs/portable-record-stream.md`
- `.changeset/portable-record-stream.md` only if the final release-visibility
  audit finds this internal seam independently user-visible

Modify after rebasing onto merged #615:

- `src/storage/index.ts`
- `docs/architecture.md`
- `docs/README.md`
- `codecov.yml`
- `test/codecov-config.test.ts`

Explicitly unchanged:

- `src/portable-knowledge.ts` and its CLI/tests
- `package.json`, `package-lock.json`, and package export maps
- all SQLite/PostgreSQL factories and repositories
- `src/migration/**` and migration tests

## Task 1: Freeze canonical values and the complete record union

**Files:** create `src/storage/portable-record.ts` and
`test/storage/portable-record.test.ts`.

**Produces:** `PortableDomain`, the six branded portable integer ranges,
adapter-only
`PortableRawInteger`/`PortableRawTimestamp` scalar inputs, the complete
`PortableRecordValue` union, `PortableRecord`,
`PORTABLE_RECORD_DOMAIN_ORDER`, `PORTABLE_RECORD_SCHEMA_SHA256`,
`createPortableRecord`, `serializePortableRecord`, and
`parsePortableRecord`.

- [ ] Write RED tests importing the absent module and enumerating the literal
      22-domain order above. Assert each representative domain value creates a
      deeply frozen envelope with computed order/identity/dependencies and a
      lowercase 64-hex `recordSha256`.
- [ ] Run `npx vitest run test/storage/portable-record.test.ts`; require RED on
      the absent public seam.
- [ ] Implement canonical primitive helpers: signed-64-bit tagged integers,
      nonnegative int64, nonnegative/positive int4, and signed/nonnegative
      safe refinements,
      exact six-digit UTC timestamps, finite floats,
      printable/hash/UUID/client/role/category discriminants, malformed-UTF-16 and
      NUL rejection, plain/null-prototype object validation, depth/cycle checks,
      locale-independent key sorting, deep freeze, and canonical SHA-256.
- [ ] Freeze golden canonical vectors before broad validators: exact object-key
      order, UTF-8 and JSON escapes, safe integer/float/exponent spellings, six-digit
      timestamps, tagged integers, identity/record/schema/domain-prefix/aggregate/
      manifest/checkpoint hashes, and the eight-byte unsigned length preimage.
- [ ] Define exact adapter-only scalar normalization: integers accept only
      `bigint`, canonical decimal strings, or safe integer numbers and become
      tagged integers; timestamps accept only validated SQLite/UTC strings or a
      `Date` explicitly known to originate at millisecond precision and become the
      six-digit UTC form. Reject ambiguous numeric strings, timezone-less input
      outside the declared SQLite form, and any lossy precision conversion.
- [ ] Implement exact domain validators, raw adapter scalar normalization,
      declared-order tuple comparison, and logical-key/dependency derivation for
      all 22 domains. Use explicit key arrays per domain and reject both missing
      and additional fields. Validate message-part fields exhaustively, summary DAG
      self-links, context's exactly-one target, transcript payload/object shape and
      link ordinals, checkpoint counters, and passive terminal-disposition shape.
      Prove descriptor validation rejects any domain whose order does not make
      duplicate logical identities adjacent.
- [ ] Implement canonical envelope serialization and exact parsing. Parsing is
      byte-bounded, catches parser failures without retaining a cause, requires the
      input bytes to equal reserialization (thereby rejecting whitespace,
      noncanonical numeric spellings, reordered keys, and duplicate-key JSON),
      recomputes identity/dependencies/hash, and rejects any mismatch.
- [ ] Add fixed-code `PortableStreamError` categories needed at this layer:
      `unsupported-version`, `unknown-domain`, `malformed-record`,
      `record-unrepresentable`, `duplicate-identity`, `order-regression`, and
      `dependency-order`. Prove
      `toJSON()` is exactly `{ name, code, retryable, domain?, ordinal?,
recordCount?, manifestSha256?, checkpointSha256?, message }`, omits undefined
      optionals, and contains no identity digest, payload, path, raw input, parser
      text, quarantine reason, adapter message, or cause, even with canary secrets.
      `Error.stack` may contain ordinary code frames, but its first line is fixed
      and no canary input may appear anywhere in it.
- [ ] Cover valid extrema and every rejection branch: signed-64 limits,
      nonnegative int64, positive/nonnegative int4, and
      signed/nonnegative safe-integer limits,
      leading/negative zero, unsafe/non-finite JSON numbers, invalid dates and
      microseconds, malformed surrogates, NUL, cycles/shared cycles, exotic
      prototypes, forbidden values, depth 100/101, unknown/additional keys,
      digest/identity/dependency tampering, oversized UTF-8, and mutation attempts.
- [ ] Run focused coverage for `src/storage/portable-record.ts` and require
      exactly 100% statements, branches, functions, and lines; run typecheck,
      focused ESLint, and `git diff --check`.
- [ ] Commit with
      `git commit -S --signoff -m "feat(storage): define canonical portable records"`.

## Task 2: Implement manifests, negotiation, bounded batches, and checkpoints

**Files:** create `src/storage/portable-record-stream.ts` and
`test/storage/portable-record-stream.test.ts`.

**Consumes:** every Task 1 record/domain/codec export.

**Produces:** `PortableManifest`, `PortableCheckpoint`, `PortableBatch`,
`PortableVerification`, `PortableRecordStream`, `PortableRecordSource`,
`PortableSourceDescription`, `PortableSourcePageInput`, `PortableSourcePage`,
`PortableSourceVerificationInput`, all fixed limit constants,
`createPortableManifest`, `parsePortableManifest`,
`serializePortableManifest`, `negotiatePortableManifest`,
`createPortableBatch`, `serializePortableCheckpoint`,
`parsePortableCheckpoint`, `verifyPortableCheckpoint`, and
`createPortableRecordStream`.

- [ ] Write RED tests at the exact public seam for a complete multi-domain
      manifest, initial/resumed/final pages, empty domains, a page ending exactly at
      each byte/record limit, cancellation before work, shared-wrapper idempotent
      close semantics, and immutable/sanitized outputs. Use a fake source that
      records the exact fixed global page limits and verification digests it
      receives, while asserting lower caller limits are enforced by the wrapper.
- [ ] Run `npx vitest run test/storage/portable-record-stream.test.ts`; require
      RED on the absent stream module.
- [ ] Implement manifest construction and exact canonical parsing. Require all
      22 domains exactly once and in frozen order, exact coverage states, domain
      version 1, safe counts, valid prefix hashes, aggregate content hash, exact
      fixed limits, canonical capture timestamp/source witness/schema digest, and
      self-checksum. Build it only through the bounded pre-pass over the source and
      reject source-description drift before returning the stream.
- [ ] Implement exact v1 negotiation. Test unsupported stream/domain versions,
      missing/duplicate/reordered/unknown domains, wrong schema or limit values,
      malformed inventory, and attempted caller capability downgrade. Every case
      throws `PortableStreamError` before records are consumed.
- [ ] Implement pure initial-prefix, incremental-prefix, checkpoint creation,
      parse, and verification helpers with explicit domain separation. Validate
      manifest/domain/prior-checkpoint binding, contiguous ordinals/counts,
      previous-checkpoint chains, terminal count/digest, and self-checksums.
- [ ] Implement `createPortableBatch`: nonempty partial pages and empty terminal
      pages, requested/global record and byte limits, newline framing, same-domain
      records, authenticated predecessor overlap, batch-local identity uniqueness,
      exact portable order, dependency order, prior-checkpoint continuity, terminal
      manifest agreement, and abort checks before and after validation. Never emit
      a checkpoint for a partial/malformed page.
- [ ] Add remaining fixed error categories:
      `malformed-manifest`, `incompatible-schema`, `invalid-limit`,
      `batch-limit-exceeded`, `checkpoint-mismatch`, `partial-batch`,
      `source-changed`, `source-invalid`, `source-unavailable`, `aborted`, and
      `closed`. Serialize only safe bounded evidence and the prior checkpoint
      checksum—not raw records or adapter errors.
- [ ] Test checkpoint replay against another manifest/domain, reordered,
      omitted, duplicated, and appended records, wrong byte counts, exact and
      divergent duplicate identities, a record too large for a caller page, empty
      nonterminal output, final digest mismatch, source drift, and every
      serialization tamper. Prove the unchanged prior checkpoint resumes after each
      failure.
- [ ] Implement async `createPortableRecordStream`: snapshot/freeze the source
      description, run the bounded manifest pre-pass, freeze the manifest,
      reject calls after close, serialize concurrent close/read/verify settlement,
      pass bounded limits and the exclusive ordinal to the source, normalize source
      exceptions to cause-free errors, reject over-return/empty-nonterminal/
      inconsistent completion, and close the source exactly once. Prove close
      racing a read waits for settlement and no later call reaches the source.
      Serialize reads and verifies; prove queued abort, in-flight abort, source
      changed/invalid/unavailable, close failure, and concurrent close semantics.
- [ ] Run focused exact-100% coverage for both new production files; run
      typecheck, focused ESLint, and `git diff --check`.
- [ ] Commit with
      `git commit -S --signoff -m "feat(storage): add resumable portable stream checkpoints"`.

## Task 3: Prove SQLite/PostgreSQL fixture parity across every domain

**Files:** create `test/fixtures/portable-records.ts` and
`test/storage/portable-record-parity.test.ts`.

**Consumes:** Task 1 normalization constructors and Task 2 manifest/page
functions. Produces no backend implementation.

- [ ] Build one representative logical project covering all 22 domains,
      duplicate ordered tags/file IDs, two summary levels and parent/message edges,
      both context target types, every message-part field/null branch, orphan-legal
      summary file/source-memory references, repeated recall occurrences, four
      redaction categories, machine-scoped instructions, native payload arrays and
      objects, ordered transcript links, a native checkpoint, and pending/applied/
      quarantined passive events.
- [ ] For passive events, freeze local and PostgreSQL fixtures whose portable
      values contain exact session ID/sequence, category, data, priority,
      source hook, and created timestamp. Prove the local replication payload's
      `previousEventId`, local `prev_event_id`, and every delivery or remote
      claim field other than the state inputs to normalized disposition are
      deliberately excluded. Prove toggling `processed_at` changes disposition
      only when required by the precedence above, while all promotion-relevant
      fields change the record digest.
- [ ] Represent the SQLite declared-shape fixture using signed SQLite
      integer/REAL values,
      `0`/`1` nullable booleans, space-separated timestamps, JSON text, embedded
      tag/file arrays, local project/machine identity, and no generated remote
      surrogate IDs. Represent the PostgreSQL fixture using `bigint`/decimal driver
      strings, booleans, six-digit UTC timestamps, JSON objects, normalized
      relationship rows, generated UUID surrogates, and shared identity rows. Mark
      unavailable legacy SQLite transcript domains `authoritative-empty`; add a
      second authenticated-sidecar shape that populates them and matches PG. Bind
      every coverage entry to a deterministic evidence payload; prove missing or
      unsupported evidence cannot be mislabeled empty.
- [ ] Normalize both through test-only declared-shape adapters into
      `createPortableRecord`; these fixtures prove the protocol and do not claim or
      transfer ownership of #622/#626 raw extraction.
      Assert every canonical record byte, identity/dependency hash, domain
      inventory, manifest content digest, batch boundary, checkpoint chain, and
      round-tripped parsed value is identical. Explicitly prove generated
      PostgreSQL internal keys/search digests and SQLite rowid/FTS details never
      enter bytes. Exact equality requires the same logical source data and
      authenticated sidecar coverage, not equal physical database IDs.
- [ ] Prove promoted source-project normalization with PostgreSQL SQL `NULL`,
      PostgreSQL explicit self, SQLite stored self/default, and a distinct
      external source. The first three must produce canonical `null`; the
      external source survives exactly.
- [ ] Prove integer extrema remain exact, physical conversation/message/recall
      IDs may differ while canonical logical records remain identical; prove
      duplicate sessions with equal timestamps, nullable recall sessions, and
      repeated identical recall tuples retain their occurrence ordinals. Prove
      transcript message ordering survives,
      summary DAG edges survive, array order/duplicates survive, aliases retain
      exact and normalized paths, and all three passive dispositions preserve
      logical outcome without claim/retry ownership.
- [ ] Exercise every branded integer field at its accepted minimum/maximum and
      one step outside, including the different int64 transcript ordinal and
      int4 transcript-link ordinal; require rejection before a writer could
      receive an uninsertable destination value.
- [ ] Prove the 64 MiB global record bound covers the maximum canonical
      representation of an accepted 10 MiB native JSONL record. Freeze the bound:
      canonicalizing a parsed valid JSON record cannot exceed its original JSON
      token bytes (all mandatory quote/backslash/control escaping was already
      present; reordering adds no bytes), while scrubbing replaces matched source
      spans with the fixed 10-byte `[REDACTED]` token. The native scrubber must
      expose/verify the post-scrub canonical payload bound used by the adapter;
      then add the exact fixed envelope/order/dependency/digest/newline overhead.
      Run adversarial escape/key-order vectors plus one bounded near-limit vector.
      Also prove a 64 MiB+1 record fails terminally and a globally valid record
      above a caller's lower
      byte limit fails retryably without source ambiguity or checkpoint advance.
- [ ] Add malformed fixture cases for unknown domain/version, duplicate and
      regressed identity/order tuples across a predecessor boundary, omission caught
      by terminal digest, dangling required dependency, DAG self/cycle, malformed
      record, incomplete coverage, source changed, source invalid, and source
      unavailable during bounded page construction. Place duplicate summary-edge
      and passive-event identities on different pages to prove adjacency plus the
      predecessor catches them. Require sanitized resumable evidence and no
      advanced checkpoint.
- [ ] Run
      `npx vitest run test/storage/portable-record.test.ts test/storage/portable-record-stream.test.ts test/storage/portable-record-parity.test.ts`
      and focused coverage. Require 100% for both production files.
- [ ] Commit with
      `git commit -S --signoff -m "test(storage): prove portable backend fixture parity"`.

## Task 4: Export the internal seam and document the compatibility policy

**Files:** modify `src/storage/index.ts` and `docs/architecture.md`; create
`docs/portable-record-stream.md`; conditionally create
`.changeset/portable-record-stream.md` after the release-visibility audit.
After the merged #615 rebase, modify `docs/README.md`, `codecov.yml`, and
`test/codecov-config.test.ts` atomically.

- [ ] Rebase this branch onto the exact merged #615 `origin/main` before shared
      edits. Preserve any merged #621 `unit-migration-cutover`, topology ownership,
      docs links, and actual component/count literals; do not wait for #621 solely
      as a dependency and do not transplant forecasted values.
- [ ] Export `portable-record-stream.ts` from the internal storage barrel; that
      file re-exports the Task 1 types/functions used by consumers. Do not add an
      npm package subpath or expose unfinished CLI behavior.
- [ ] Document the format for operators and future adapter authors: purpose,
      sensitivity, 22-domain order, exact coverage and raw-scalar boundaries,
      canonical integer/timestamp/JSON rules,
      limits, manifest and record/checkpoint hash formulas, strict compatibility
      policy, source/destination responsibilities, partial-page recovery, sanitized
      failure classes, and the explicit #622/#623/#618/#626 ownership boundaries.
- [ ] Add the docs index link and update architecture prose to replace the
      generic future-portability claim with this landed contract while keeping all
      runtime/CLI/migration routing staged.
- [ ] Audit release visibility. If the internal exported seam and docs merit
      release notes, add the smallest appropriate (normally minor) Changeset for
      `@donadiosolutions/lcm`; otherwise document the evidence-backed no-Changeset
      decision in the PR. Never claim CLI routing or cutover is active.
- [ ] Classify both new production files under `unit-storage-abstractions` in
      `codecov.yml` and mirror the exact paths in
      `test/codecov-config.test.ts`. Derive the literal production count from
      `bin/**/*.ts`, `installer/**/*.ts`, and `src/**/*.ts`; component count changes
      only if the merged taxonomy actually requires it.
- [ ] Run `npx vitest run test/codecov-config.test.ts test/package-config.test.ts`,
      docs/config tests affected by the links, typecheck, lint, build, and
      `git diff --check`.
- [ ] Commit with
      `git commit -S --signoff -m "docs(storage): publish portable stream contract"`.

## Task 5: Mandatory MoM review, verification, and one-issue PR

- [ ] Run fresh exact-head gates: `npm run test:ci` (literal 100% in all four
      metrics and per-file), `npm run typecheck`, `npm run lint`, `npm run build`,
      `npm run verify:consumer-topology` with an isolated HOME until #679 is fixed,
      `npm pack --dry-run`, `npm run test:postgresql`, and `git diff --check`.
- [ ] Run the canonical MoM adversarial sequence: parallel
      `cortex-hq/zai-org-GLM-5.2` max and `xai/grok-4.6` **high** over issue, plan,
      exact diff, tests, and #92 boundaries; then `anthropic/claude-opus-5` medium
      with both reports. If changes are required, dispatch accepted fixes to
      `gpt-5.6-luna` max and repeat both review rounds and affected/full gates until
      approved.
- [ ] Audit `git diff origin/main...HEAD`, all signatures, DCO trailers,
      dependency/lockfile absence, an explicit Changeset decision, Codecov
      exclusivity, canonical
      fixture completeness, secret leakage, and zero `src/migration/**` overlap.
      Require a clean worktree.
- [ ] Send the final module/type/checkpoint names to the Epic #92 task so #622
      and #623 import rather than redefine them; also notify #618 and #624 as stream
      transfer/reconciliation consumers. Include the exact safe-number #621 adapter
      mapping and the source coverage/sidecar ownership boundary.
- [ ] Push only `feat/616-portable-record-stream` and open one ready PR closing
      #616. Do not include #615 or #617-#620. Batch review fixes; for every addressed
      GitHub thread reply `Fixed in <commit hash>.` and resolve it.
- [ ] Require exact-head CI, DCO, CodeQL, Socket, coverage, Copilot, and
      repository admission. Merge with a merge commit only after all gates pass;
      confirm GitHub reports `MERGED`.
- [ ] Run the canonical Codex post-merge workflow in the primary worktree:
      update `main` exactly to `origin/main`; `npm run build && npm link && lcm
doctor && npm test`; then `lcm connectors install codex && lcm connectors
doctor codex`. Fix failures before starting #617/#619 work.
- [ ] Store the final domain/schema/checkpoint decisions and exact evidence in
      LCM. Close #616 with the merged SHA, then select the next unblocked Epic #224
      issue on a fresh branch and separate PR.
