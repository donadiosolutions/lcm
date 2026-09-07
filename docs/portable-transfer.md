# Canonical backend transfer

LCM has three separate import and export contracts:

| Surface | Contents | Retry behavior |
| --- | --- | --- |
| `lcm import` | Client-native transcripts, their parsed messages, scrubbed native records and ingest checkpoints | Repeated import completes missing native work without duplicating already imported messages. |
| `lcm export` / `lcm import-knowledge` | The existing version 1 promoted-knowledge document | One document is atomic. Retry the document from the beginning; retained pre-scrub entry digests prevent duplicate effects. |
| Canonical storage adapters | All 22 domains of the version 1 canonical record stream | Each bounded batch has a durable receipt. A retry resumes from authenticated destination progress. |

Ordinary knowledge export keeps its existing format. Canonical transfer is a
library integration API in the [storage facade](../src/storage/index.ts), not a
new CLI command. It prepares and verifies an isolated destination. It does not
select a backend, publish a generation, replace an active project, activate an
outbox, or perform a cutover.

## Source and destination ownership

Choose the source generation and destination explicitly. Keep transfer files,
scratch directories and credentials private to the account performing the
transfer. A configured PostgreSQL backend never falls back to a local SQLite
database when admission fails.

The SQLite source opener takes an existing captured database, its expected
SHA-256, its project identity and capture timestamp. It checks the regular file,
owner, restrictive permissions, canonical path, open identity and expected hash.
The database must have no WAL or SHM sidecars. An immutable, existing-only
connection can read a checkpointed WAL-mode main file without creating sidecars
or changing captured bytes. The opener does not migrate the source. For a source without a recovery archive, supply the
captured machine and alias facts with their expected digest, plus explicit
captured event and instruction sidecars or their authenticated absence evidence.
There is no discovery of files in the live LCM home. Each supplied sidecar is
checked and held with the main generation. Set `machineIdentityKey` explicitly
when the main database contains machine-local facts and the captured identity
descriptor contains more than one machine.

A bound SQLite capture still stores its native project ID as a local path hash.
Set `sourceLocalProjectId` to that native ID and include the same value in
`identityFacts`, covered by `expectedFactsSha256`. Keep `projectIdentity` as the
registered shared identity emitted to the canonical stream. Native project
predicates and self-provenance normalization use the local ID; the canonical
identity and PostgreSQL destination use the shared UUID. No source rows or
capture IDs are rewritten to bridge the two identities.

For PostgreSQL promoted memories, both the authenticated local project hash
used by normal promotion and the shared owner UUID used by canonical imports
mean self-provenance. The canonical record encodes either as `null`; the
destination binds it to its own project identity. Other source project IDs
remain unchanged, including external origins, across PostgreSQL/SQLite transfers.

These checks establish that the supplied files match the chosen evidence. A
file digest cannot establish that separately captured files describe the same
historical instant. The snapshot producer owns source quiescence and coherent
capture across the database and sidecars. The snapshot workflow in #622 adds
that guarantee; the transfer adapter does not create snapshots itself.

The PostgreSQL source first admits verified TLS, PostgreSQL 18, schema,
privileges and the existing machine/project/path binding. It then holds a
dedicated read-only repeatable-read session. All source reads are serialized on
that session, and closing the source rolls it back and releases it. Ordinary
runtime transactions retain their existing mode.

A SQLite destination must be a new exclusively created file in an owner-only
directory, or the exact generation recorded by an earlier transfer ledger.
A PostgreSQL destination must have the exact registered project, machines and
complete alias set described by the source. Transfer records never register or
rebind those identities. PostgreSQL holds a dedicated advisory lock and admits
only empty project data domains or the exact earlier transfer run. A separate
schema inside an active database is not a substitute for an isolated target.

Provision the tracked transfer ledger migration and apply the narrowly scoped
[transfer grant script](../src/storage/postgresql/reference/postgresql-transfer-grants.sql)
for the selected transfer role. Transfer readiness is checked independently;
do not grant the ordinary runtime role owner or superuser privileges. Native
transcript runtime import also requires its documented native-transcript grants.

Both adapters issue private revocable capabilities after checking the actual
resources. A caller-provided object or boolean cannot supply this authority.
Operations recheck scope and resource identity. These checks coordinate
cooperating adapters and detect evidence drift; they cannot fence a second
process with the same database credentials that ignores the protocol. Global
migration writer fencing remains the responsibility of #623.

## Programmatic lifecycle

Integrations use the existing storage facade. The following example assumes
that the integration has already selected and validated its immutable source
bundle and separately provisioned an isolated destination:

```ts
import {
  createPortableRecordStream,
  createPostgreSqlPortableDestination,
  openSqlitePortableSource,
  runPortableTransfer,
} from "../src/storage/index.js";

const sourceHandle = await openSqlitePortableSource(verifiedSourceInput);
const source = await createPortableRecordStream(sourceHandle);

let destination;
try {
  destination = await createPostgreSqlPortableDestination({
    settings: destinationConnectionSettings,
    expectedOwner: destinationSchemaOwner,
    expectedIdentity: registeredDestinationIdentity,
    generationId: savedGenerationId,
    runId: savedRunId,
    scratchParent: privateScratchDirectory,
    signal,
  });
} catch (error) {
  await source.close();
  throw error;
}

const result = await runPortableTransfer({
  source,
  destination,
  maxRecords: 100,
  maxBytes: 8 * 1024 * 1024,
  signal,
  onProgress(progress) {
    // Counts and hashes only; send progress to stderr or private telemetry.
    process.stderr.write(`${progress.domain}: ${progress.recordCount}\n`);
  },
});
```

`runPortableTransfer` owns both handles once called and closes both on success
or failure. If opening the second handle fails, the integration still owns
cleanup of the first. Preserve the primary failure if cleanup also fails.
Factory inputs and source descriptors are typed by the facade; keep credentials
out of progress, exception messages and serialized transfer evidence.

The runner negotiates the manifest, performs a complete bounded destination
capability scan and obtains a private preflight artifact before admission. It
then reads the destination's durable progress, checks the contiguous domain
prefix and source boundaries, and applies batches in dependency order. Empty
domains also receive durable terminal checkpoints. Progress is emitted only
for an exact acknowledged checkpoint. The final result requires all domain
counts and hashes to agree with SQL readback and the source to remain stable.

For the opposite direction, use `createPostgreSqlPortableSource` followed by
`createPortableRecordStream`, and `openSqlitePortableDestination`. The SQLite
writer takes `databasePath`, `projectIdentity`, a saved
`generationIdentitySha256`, and `mode: "create"` or `mode: "resume"`.

## Fidelity and capability refusal

The canonical format preserves logical identities, dependency relationships,
64-bit integers and timestamps with six fractional digits. Physical database
IDs are allocated by the destination and mapped transactionally. Tags and
summary-file references preserve order and multiplicity. File URIs are opaque
values; transfer does not fetch or copy referenced file contents.

A record valid in the canonical format may still be unrepresentable in a
particular destination. The full preflight checks the current schema's actual
constraints before writing domain data, including:

- PostgreSQL UUID requirements for memory and message-part IDs.
- Shared project and registered machine identities required by PostgreSQL.
- Nonempty PostgreSQL promoted-memory content and relational timestamp rules.
- Unique relationship constraints, project/conversation scope and summary DAG
  integrity across records.
- Supported JSON, integer, string and per-record size limits.

An unsupported corpus fails as a whole. The adapters do not silently replace
identities, coerce incompatible values, discard unsupported domains or export
a partial manifest as complete. Correct the source or choose a compatible
new generation before retrying a non-retryable refusal. PostgreSQL passive-event
envelopes must have the supported seven keys and their native field types;
unknown envelope fields are refused rather than silently discarded. The `data`
string stays opaque, and event disposition normalization remains unchanged.

Readers use an owned disk index for ordering, logical identities, dependency
checks and duplicate conversation occurrence assignment. The index stores
metadata and physical locators, not a second destination containing serialized
canonical records. Each batch has at most 500 records and 144 MiB; a single
record has at most 128 MiB. Callers may request lower limits. A record larger
than the caller's byte budget is refused without advancing its checkpoint.
Disk scratch also has a finite budget and is removed when its owner closes.

Literal U+0000 and malformed UTF-16 are outside the version 1 format. SQLite
readers admit UTF-8 database encoding and validate bounded raw text bytes with
fatal decoding before canonical parsing. Malformed UTF-8 is refused; genuine
U+FFFD and valid Unicode remain unchanged. The driver cannot erase a NUL or
replace invalid bytes and turn changed content into a verified export. Literal backslash
text such as `\u0000` remains distinct from a NUL character.

## Receipts, retries and interruption

Data mutations, identity mappings and immutable batch receipts share one
destination transaction: SQLite uses `BEGIN IMMEDIATE`; PostgreSQL uses
`READ COMMITTED` and locks the run row. A different run or generation requires a fresh isolated destination; do not
delete a ledger or reuse a populated project in place. A batch is keyed by its
domain and prior checkpoint. Exact replay returns its saved receipt. Changed replay, a stale
checkpoint or a different manifest fails without accepting a new checkpoint.

If the commit response is lost, the writer reconciles against the same
admitted destination's immutable receipt. An unavailable readback remains
`destination-uncertain`; it is not an acknowledgement or a rollback claim.
Cancellation after commit likewise cannot establish that data was rolled back.
Keep the private target and source evidence for diagnosis or resume.

To resume, reopen the same target generation with the same run identity and
supply the exact admitted source generation and manifest. The runner reads
progress from the target; a caller's last printed checkpoint is not the source
of truth. A persistent supplied SQLite generation can survive process restart.
A PostgreSQL read-only session is an ephemeral snapshot: losing that session
loses the source generation. Reopening a new live session does not recreate its
manifest or establish crash-resumable snapshot identity. Capture a persistent
generation through the snapshot owner when restart-resumable source evidence
is required.

## SQLite recovery archive

Canonical imports write ordinary runtime data to real SQLite tables. Facts
without a corresponding live local representation remain in typed recovery
archive tables in the same isolated database. This includes multi-machine
instructions, native transcripts and links, native ingest checkpoints and
passive-event facts. They are not opaque canonical record envelopes.

The authenticated SQLite source exposes its generation-bound recovery reader.
It supports scoped transcript lookup/listing, transcript-message links,
checkpoint lookup, session-instruction listing and passive-event listing.
Reads use keyset pagination, limits from 1 through 500, byte bounds and abort
signals. Closing the source revokes the reader. These APIs expose recovery
facts; ordinary runtime repositories expose imported conversations, messages,
summaries and memories.

Passive-event disposition is normalized to `pending`, `applied` or
`quarantined`. Imported records carry no active lease, retry owner or raw
quarantine reason. Quarantine uses a fixed recovery marker. Import does not
start a consumer or replay hooks. A completed archive generation stays
immutable until the recovery/publication owner in #626 defines materialization
and activation. The source refuses mixed archive/runtime facts and verifies a recorded archive
generation against its saved manifest. Do not merge old archive rows with later
live writes and call them the current canonical state.

## Failure codes

`PortableTransferError` contains a generic message, an allowlisted `code` and
`retryable`. It contains no raw driver cause, SQL, connection URL, credential,
filesystem path or record payload.

| Code | Required response |
| --- | --- |
| `invalid-input`, `unsupported-capability` | Correct the request or unsupported corpus before retrying. |
| `source-changed` | Select and admit a new coherent source generation. |
| `source-failed`, `destination-failed` | Inspect the sanitized failure; retry only if `retryable` is true and the same source/target authority is retained. |
| `destination-conflict` | Correct target ownership, identity or existing-state conflict; never clear unrelated data automatically. |
| `destination-uncertain` | Retain evidence and reconcile the exact run receipt before resuming. |
| `checkpoint-mismatch`, `verification-failed` | Stop; investigate the manifest, progress or actual destination data. |
| `zero-progress` | Correct the adapter or batch request; no checkpoint was accepted. |
| `aborted` | Retain the target; retry only with the same valid source generation and target authority. |
| `close-failed` | Cleanup failed after the operation; do not report overall success. |

The [canonical record-stream reference](portable-record-stream.md) defines the
unchanged version 1 encoding, manifest, checkpoints and stream error mapping.
The [knowledge-transfer guide](portable-knowledge.md) describes the separate
version 1 knowledge format and its document-level retry behavior.
