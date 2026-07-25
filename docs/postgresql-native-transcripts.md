# PostgreSQL native transcripts

LCM can persist queryable, client-native transcript records in PostgreSQL
without sending the original, unsanitized record to the database. This
repository is available for explicit backfill and adapter conformance, but it
is not yet selected by normal daemon or CLI ingestion. PostgreSQL daemon/CLI
activation remains tracked by issue #224, and the broader migration and
cutover remains tracked by issue #92.

## What “raw transcript” means

In this feature, **raw** means the client's native JSON record and its
provenance **after mandatory local secret scrubbing**. It never means the
verbatim bytes read from the source transcript.

LCM currently recognizes these versioned formats:

| Client | Format identifier |
| --- | --- |
| Claude Code | `claude-code/claude-jsonl/v1` |
| Codex | `codex/codex-jsonl/v1` |

Embedded callers select these values through
`CLAUDE_NATIVE_TRANSCRIPT_FORMAT`, `CODEX_NATIVE_TRANSCRIPT_FORMAT`, or
`SUPPORTED_NATIVE_TRANSCRIPT_FORMATS`. `readNativeTranscriptJsonl()` exposes
the validated stream, while `runNativeTranscriptBackfill()` coordinates that
stream with the destination repository, exact message resolver, and local
quarantine. `createFileNativeTranscriptSource(clientRoot, sourceLocator)`
provides the bounded filesystem source,
`createExactNativeTranscriptMessageResolver(conversations)` provides exact
conversation/message lookup, and `createNativeTranscriptMessageMapper()`
provides the built-in Claude/Codex mapper. Callers may inject a mapper, while
the exact resolver is required. These are programmatic APIs, not daemon routes
or CLI commands.

Create a new exact resolver for each backfill. On first use for a native
session, it materializes one immutable destination snapshot: matching
conversations are ordered by creation time and then conversation ID, each
conversation must have a contiguous zero-based message sequence, and only the
IDs, roles, and contents required for linking are retained. Every later record
from that session resolves against the same snapshot, even if the underlying
conversation repository changes while the backfill is running.

Each accepted JSONL record must decode as valid UTF-8 and contain a JSON object
or array. LCM rejects malformed JSON, scalar JSON, U+0000, binary or invalid
UTF-8 input, records larger than 10 MiB, and JSON nested beyond the exported
`NATIVE_TRANSCRIPT_MAX_JSON_DEPTH` limit of 100 before a PostgreSQL repository
operation begins.

## Data stored remotely

For every accepted record, PostgreSQL retains:

- the sanitized client-native JSON object or array;
- the client, format name, and format version;
- the native session ID;
- the registered machine and bound project IDs;
- the client-root-relative source locator and source ordinal;
- the observed and ingested timestamps;
- the scrubber version, sanitized-content SHA-256 digest, and deterministic
  ingest key; and
- any exact link from the native record to its derived LCM message.

The native JSON is immutable. The repository provides reads by transcript ID,
native session, source order, and linked message, but no payload update or
deletion operation. A matching ingest-key retry is counted as skipped; reuse
of that key for different immutable data fails closed.

Programmatic callers use `NativeTranscriptRepository.ingestBatch()`,
`getById()`, `listByNativeSession()`, `listBySource()`, `listByMessage()`, and
`getCheckpoint()`. PostgreSQL callers construct
`PostgreSqlNativeTranscriptRepository` explicitly during this staged phase;
the repository is not part of `ProjectStorage`.

Message-producing records link only when the destination message has the exact
expected session order, role, and scrubbed content. A missing or mismatched
message aborts the destination transaction and does not advance the
checkpoint. Valid client-native events that do not represent messages remain
queryable without a message link.

## Local scrubbing and residual risk

LCM recursively scrubs every string key and value using the bundled Gitleaks
rules, built-in patterns, global `security.sensitivePatterns`, and the
project's `sensitive-patterns.txt`. The scrubber rejects an invalid custom
pattern, a collision between keys after redaction, and any residual match from
the effective pattern set. It then canonicalizes the sanitized JSON and hashes
that canonical form. The scrubber version binds the pipeline version to the
effective-pattern digest so a pattern change is observable.

This boundary substantially reduces accidental secret transmission, but
pattern-based redaction cannot identify every sensitive value. An
organization-specific token that matches no active rule can remain in the
sanitized record. Review and test project-specific patterns with
`lcm sensitive test` before a canary backfill, restrict PostgreSQL access, and
treat the remote transcript store as sensitive conversation data. Do not put
secret-bearing source locators or native session IDs into transcript paths or
identifiers; those provenance values are retained as metadata rather than
scrubbed payload content.

LCM never sends a record to PostgreSQL when decoding, parsing, scrubbing,
validation, or residual-match verification fails. It also never logs the
rejected payload.

## Checkpoints, retries, and source changes

Backfill is explicit and processes transactional batches of 100 records by
default; callers may choose a value from 1 through 1000. A committed checkpoint
records the completed byte offset, completed-prefix digest, source metadata,
last source ordinal, and cumulative imported, skipped, and quarantined counts.
The checkpoint advances only in the same successful destination transaction as
the corresponding transcript records and links.

When the completed prefix is unchanged, LCM locally replays that verified
prefix from byte zero only to reconstruct identical-content occurrence
numbering, suppresses destination writes for checkpointed records, and resumes
destination work after the completed byte offset. This is not a physical file
seek.

`createFileNativeTranscriptSource()` binds one backfill to an opened file
descriptor after verifying that the locator is client-root-relative, the
resolved parent remains within that root, the leaf is not followed through a
symbolic link, and the opened descriptor still identifies the resolved file.
Prefix verification and replay read that same descriptor snapshot. An atomic
path replacement therefore cannot switch the bytes underneath a running
backfill. Descriptor identity, ownership/mode, size, modification time, and a
ctime change cookie detect changes to that bound source before prefix
validation and again before destination batches and checkpoint-only progress
writes. A ctime-only change is tolerated only when the locator now resolves to
a different inode while every stable property of the bound descriptor is
unchanged, which is the supported atomic-replacement case. If the locator
still identifies the opened inode—or cannot be resolved—the ctime change fails
closed. This also catches a same-size in-place rewrite whose modification time
was restored. A changed source never advances that batch.

If the completed prefix changed—including a reorder—LCM rescans from the
beginning and relies on deterministic ingest keys to skip records already
stored. The key includes the client and format, native session,
client-root-relative locator, sanitized-content digest, and occurrence number
among identical records. Identical retries and reordered non-message events
therefore converge without collapsing legitimate duplicates. The same is true
for message records whose exact linkage is unchanged. Reordering
message-producing records can change their required session sequence; when the
existing message order no longer matches exactly, linkage fails closed and the
prior checkpoint is preserved.

Every destination batch carries the complete expected prior checkpoint as a
compare-and-swap fence. A concurrent writer that advanced the same source from
a divergent snapshot cannot regress or overwrite that checkpoint. Identical
record retries still read back the existing immutable rows and count as
skipped.

## Local quarantine

Unsafe records are not stored remotely. LCM writes only metadata to the
project's private local SQLite quarantine store:

- client-root-relative source locator;
- source ordinal;
- bounded reason code;
- SHA-256 digest; and
- quarantine timestamp.

The original or partially scrubbed payload is never copied into quarantine.
Embedded callers use `openLocalTranscriptQuarantine()` and the resulting
repository's list/get operations to inspect these metadata records. By default,
`localTranscriptQuarantinePath()` resolves the store to
`~/.lcm/transcript-quarantine/<sha256-project-id>.db`; LCM creates the
directory with mode `0700` and the database file with mode `0600`. The store is
not synchronized to PostgreSQL.

Reason codes are bounded to `invalid-utf8`, `binary-input`,
`record-too-large`, `malformed-json`, `non-container-json`, `nul-character`,
`redacted-key-collision`, `residual-secret`, and `nesting-too-deep`. Correct
the source or active sensitive patterns, then rerun the explicit backfill—the
source transcript remains read-only.

## PostgreSQL privileges

Apply
[`postgresql-runtime-transcript-grants.sql`](postgresql-runtime-transcript-grants.sql)
as the migration owner:

```bash
psql "$LCM_POSTGRES_ADMIN_URL" \
  --set=lcm_runtime_role=lcm_runtime \
  --file=docs/postgresql-runtime-transcript-grants.sql
```

Replace `lcm_runtime` with the existing restricted runtime role. The script
grants only:

- `USAGE` on the `lcm` schema;
- `SELECT` and column-limited `INSERT` on `native_transcripts`;
- `SELECT` and column-limited `INSERT` on `transcript_messages`; and
- `SELECT`, column-limited `INSERT`, and checkpoint-field-only `UPDATE` on
  `ingest_checkpoints`.

It grants no payload update, `DELETE`, `TRUNCATE`, sequence privilege, or
privilege on unrelated repository tables. Conversation and identity
repositories require their separate reviewed grant scripts.

## Staged rollout and rollback

Run canary fixtures for each client and effective pattern set before starting a
larger backfill. Backfill reads the source transcript without modifying it and
can be stopped and resumed from a committed checkpoint.

Rollback is non-destructive: stop invoking the backfill or disable the later
cutover configuration. Do not delete immutable PostgreSQL transcript rows or
overwrite the preserved client source to compensate for a failed or reverted
run. Retry after correcting the local input or configuration; committed
records converge through ingest-key idempotency, and an uncommitted batch
leaves its prior checkpoint unchanged.
