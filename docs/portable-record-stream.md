# Portable record stream

This is the operator and adapter reference for the version-1 portable record
stream. It freezes a backend-neutral representation for one LCM project,
including its identity and the sidecar records needed to reconstruct it. The
stream is an internal programmatic compatibility seam: it is not an npm
package subpath, CLI format, migration command, or active backend cutover.

## Sensitivity and current status

Records can contain memory, conversation, transcript, file metadata, paths,
hook data, and adapter-provided payloads. Treat a stream, manifest, checkpoint,
and source evidence as sensitive application data. Redact according to the
normal LCM data-safety boundary before constructing records, protect files and
transport as you would the source store, and do not put credentials or secret
material in records, manifests, error messages, or checkpoints.

Issue #616 publishes the format and the validated source-stream wrapper only.
It does not open SQLite or PostgreSQL, execute SQL, acquire a lease, write a
destination, publish a migration artifact, route normal storage, or activate a
CLI or daemon path. Normal installations therefore continue using their
existing storage selection.

## Domains and dependency order

Every manifest contains exactly these 22 domains in this order. Domain and
domain-version negotiation is strict; a consumer must not reorder, omit, or
silently invent a domain. A record's dependency list must name the required
earlier-domain identities before the record is accepted.

| Order | Domain | Required dependencies | Coverage class |
| ---: | --- | --- | --- |
| 1 | `machines` | — | identity-sidecar |
| 2 | `project` | — | identity-sidecar |
| 3 | `project-aliases` | `machines`, `project` | identity-sidecar |
| 4 | `conversations` | `project` | database |
| 5 | `messages` | `conversations` | database |
| 6 | `message-parts` | `messages` | database |
| 7 | `large-files` | `conversations` | database |
| 8 | `summaries` | `conversations` | database |
| 9 | `summary-file-links` | `summaries` | database |
| 10 | `summary-message-links` | `summaries`, `messages` | database |
| 11 | `summary-parent-links` | `summaries` | database |
| 12 | `context-items` | `conversations`, `messages` or `summaries` | database |
| 13 | `promoted-memories` | `project` | database |
| 14 | `promoted-memory-tags` | `promoted-memories` | database |
| 15 | `recall-surfacings` | `project` | database |
| 16 | `redaction-counters` | `project` | database |
| 17 | `session-ingest` | `project` | database |
| 18 | `session-instructions` | `machines`, `project` | database-and-identity |
| 19 | `native-transcripts` | `machines`, `project` | database-or-sidecar |
| 20 | `native-transcript-message-links` | `native-transcripts`, `messages` | database-or-sidecar |
| 21 | `native-transcript-checkpoints` | `machines`, `project` | database-or-sidecar |
| 22 | `passive-events` | `machines`, `project` | database-or-sidecar |

The coverage class describes where an adapter obtains evidence; it is not a
permission to omit a domain. `available` coverage carries an evidence SHA-256.
`authoritative-empty` is allowed only with the reason
`not-in-source-generation` and its own evidence SHA-256. A source must not
claim empty coverage because a read failed or because an adapter has not yet
implemented the domain. An authoritative-empty domain must also have
`recordCount = 0` and the seeded boundary prefix for that domain. Its coverage
evidence SHA-256 proves the source-generation claim; it is distinct from the
boundary field `prefixSha256`.

## Construction versus wire data

Adapters may use backend-shaped raw values while constructing a record. Raw
integer inputs may be `bigint`, a safe integer `number`, or a canonical decimal
string; raw timestamps may be a `Date` or a supported timestamp string. The
selected project identity, parent conversation order, and parent message order
are also construction-only context used to derive stable flattened values.

That context is never serialized. The wire record is self-contained: its
canonical `order`, `identitySha256`, `dependencies`, and `value` are sufficient
for parsing and validation. Parsing reconstructs only the evidence needed to
validate those flattened values from canonical wire order. In particular, do
not add a cleartext project identity, local integer ID, database role, or
adapter object to the wire format.

Physical conversation, message, and recall integers are not portable. Stable
logical identities are derived from the exact domain and logical-key tuples;
destination writers maintain any logical-to-physical mapping transactionally.
For a cross-backend stream, the project identity is the registered shared
project UUIDv7 binding; a local-scoped stream remains bound to that exact local
identity unless a later authenticated workflow explicitly rebinds it.

## Canonical values and strict parsing

The following rules apply to both adapter output and every parsed byte stream:

- Version and domain versions are integer `1`. Domain names, field sets, and
  dependency domains are exact literals from the descriptor above.
- Portable integers use exact decimal values. On the wire they are objects of
  the form `{"$integer":"..."}` with no leading zeroes except `0`; ranges are
  explicit (`signed-int64`, `nonnegative-int64`, `positive-int4`,
  `nonnegative-int4`, `signed-safe-integer`, or `nonnegative-safe-integer`).
  Unsafe JavaScript numbers, `-0`, floating-point spellings, and out-of-range
  values are rejected.
- Timestamps are UTC RFC 3339 strings with exactly six fractional digits and
  `Z` (for example, `2026-01-02T03:04:05.123456Z`). Raw adapter values may be
  normalized from a valid `Date` or supported database timestamp, but the wire
  value retains six-digit precision and is checked for a real calendar date.
- JSON is canonical UTF-8. Objects use unsigned UTF-16 code-unit key order;
  arrays preserve order and duplicates. Portable tuple/order string scalars
  use unsigned UTF-8 byte order. JSON numbers are finite and safely
  representable in ECMAScript JSON. Strings are well-formed UTF-16 and contain
  no NUL. Maximum JSON depth is 100.
- Objects must be plain objects with exactly the declared own keys; arrays must
  be dense ordinary arrays with no extra own properties. Hashes are lowercase
  64-hex SHA-256 values. Record and control bytes must round-trip to their
  canonical representation, so unknown keys, alternate spellings, malformed
  UTF-8, noncanonical JSON, and trailing data fail closed.

Record serialization is canonical JSON encoded as UTF-8 with one terminating
LF. A record is at most 128 MiB including that serialized envelope. Control
objects (manifests and checkpoints) are at most 1 MiB. Every `readBatch()`
request must supply both `maxRecords` and `maxBytes` as positive safe integers:
`maxRecords` must be no greater than 500 and `maxBytes` must be no greater than
144 MiB (150,994,944 bytes). These published constants are ceilings, not
defaults for omitted fields. An unknown domain is rejected.

## Manifests, records, and checkpoints

All formulas below use `SHA256`, canonical JSON without a trailing LF unless
the formula explicitly says “record bytes,” and lowercase hexadecimal output.
Length prefixes are unsigned 64-bit big-endian byte lengths.

### Record identity and digest

For a record's exact logical key `K`:

```text
identitySha256 = SHA256(canonicalJson(["lcm-portable-identity-v1", domain, K]))
recordSha256   = SHA256(UTF8(canonicalEnvelopeWithoutRecordSha256))
recordBytes    = UTF8(canonicalEnvelopeWithRecordSha256) + LF
```

The record envelope includes `version`, `domain`, `domainVersion`, `ordinal`,
`order`, `identitySha256`, `dependencies`, `value`, and `recordSha256`.
The digest is calculated before adding `recordSha256`; changing any other
canonical field changes the digest.

### Domain prefixes and manifest

For each domain `D`, start its prefix at:

```text
P0(D) = SHA256(canonicalJson(["lcm-portable-domain-v1", schemaSha256, D, 1]))
P(n+1) = SHA256(hexBytes(P(n)) || uint64be(byteLength(recordBytes)) || recordBytes)
```

The domain manifest records `D`, domain version `1`, coverage, record count,
and its terminal prefix `P(n)`. Aggregate the 22 prefixes in manifest order:

```text
C0      = SHA256(canonicalJson(["lcm-portable-content-v1", schemaSha256]))
content = fold(prefix => SHA256(hexBytes(previous) || uint64be(32) || hexBytes(prefix)), C0)
```

For an authoritative-empty domain, the terminal prefix is exactly `P0(D)`.
Recomputing `contentSha256` and `manifestSha256` cannot substitute for this
semantic invariant: those checksums authenticate the supplied fields, including
an invalid empty-domain count or boundary prefix.

Coverage also controls transfer-page dispatch. After manifest-bound source
authentication, a valid `authoritative-empty` domain is represented by a
canonical empty complete page and its empty terminal batch/checkpoint; the
wrapper never invokes the domain reader for that request. This does not apply
to an `available` domain whose source currently contains zero records: that
domain's reader is still invoked, and its returned empty terminal page is
authenticated and validated normally. An adapter must not use a failed,
missing, inaccessible, or unsupported reader as evidence for an
`authoritative-empty` claim.

The manifest checksum covers the canonical manifest body, excluding its own
checksum:

```text
manifestSha256 = SHA256(canonicalJson({
  version, schemaSha256, source, domains, contentSha256, limits
}))
```

The implementation's object form is equivalent to the displayed body; the
field names and canonical object ordering are part of the format.

Manifest `recordCount` values are nonnegative safe integers, with `-0`
explicitly rejected as `malformed-manifest` before checksum canonicalization.
This classification applies consistently to manifest construction,
serialization, negotiation, batch creation, and canonical wire parsing. A
checkpoint's `nextOrdinal` and `recordCount` values are also nonnegative safe
integers, with `-0` rejected as `checkpoint-mismatch` by direct checkpoint
serialization and verification and by canonical wire parsing before checksum
canonicalization. A negative-zero count encountered while verifying a
checkpoint therefore retains the compatibility classification
`checkpoint-mismatch`; a negative-zero value in a canonical record payload
remains `malformed-record`.

### Checkpoints and batches

A checkpoint is bound to its manifest, domain, exclusive `nextOrdinal`,
cumulative `recordCount` (equal to `nextOrdinal` in version 1), prefix, last
record identity and digest, predecessor checkpoint digest, and `complete` bit:

```text
checkpointSha256 = SHA256(canonicalJson({
  version, manifestSha256, domain, nextOrdinal, recordCount,
  prefixSha256, lastRecordIdentitySha256, lastRecordSha256,
  previousCheckpointSha256, complete
}))
```

The first checkpoint starts at ordinal zero and the domain's `P0`. A resumed
page includes the predecessor record at the boundary; the stream verifies its
ordinal, identity, and record digest before accepting the next records. Records
must be contiguous, strictly ordered, dependency-valid, and duplicate-free.
The source is authenticated before and after each available adapter page. An
authoritative-empty request retains the same two manifest-bound verification
calls around synthetic page construction, without invoking the domain reader.
For `readBatch()`, a closed stream rejects before queued work or input
inspection. For an open stream, a pre-aborted signal rejects before request
validation; otherwise the domain and both limits are captured once and
validated before an optional checkpoint is checked and before that request
authenticates or pages the adapter. A validation failure does not poison the
serial operation tail, so a later queued request can still run. If a page is
partial, the caller persists the canonical checkpoint and resumes with that
checkpoint; it must not skip an ordinal or treat an unverified destination
write as complete. `verify(checkpoint)` re-authenticates the source boundary
and returns an authoritative result only after the source confirms it is
unchanged.

## Negotiation and failure handling

Consumers negotiate version `1`, the exact
`PORTABLE_RECORD_SCHEMA_SHA256`, the exact 22-domain order, and valid limits
before reading records. A version-1 manifest's `limits` object must equal the
published `PORTABLE_LIMITS` constants exactly; it does not establish a lower
per-manifest ceiling. Unsupported versions, unknown domains, schema-digest
mismatches, malformed manifests, invalid limits, and incompatible checkpoints
are hard failures. There is no permissive field dropping, domain reordering,
version guessing, or silent integer/timestamp conversion on the wire.

Errors use `PortableStreamError` with a sanitized code and only bounded context
such as domain, ordinal, count, manifest digest, checkpoint digest, and a
retryable flag. The error classes are `unsupported-version`, `unknown-domain`,
`malformed-record`, `record-unrepresentable`, `duplicate-identity`,
`order-regression`, `dependency-order`, `malformed-manifest`,
`incompatible-schema`, `invalid-limit`, `batch-limit-exceeded`,
`checkpoint-mismatch`, `partial-batch`, `source-changed`, `source-invalid`,
`source-unavailable`, `aborted`, and `closed`. Adapter exceptions, SQL, paths,
credentials, payloads, and arbitrary backend messages must not escape through
this error boundary. Source unavailability, oversized batches, and aborts may
be retried according to the returned `retryable` flag. If an available-domain
page reader rejects and the read's signal was already aborted when the failure
was classified, the read fails as retryable `aborted` rather than
`source-unavailable` or `source-invalid`. The adapter error and abort reason
remain private, no checkpoint is returned or advanced, and the prior
checkpoint may be retried. A rejection without observed cancellation retains
the existing sanitized `source-unavailable` or `source-invalid`
classification. Changed or invalid source evidence requires investigation or
a fresh manifest.

## Source and destination duties

The source adapter must describe one stable project snapshot and provide
complete domain coverage evidence. For every domain it advertises as
`available`, it must read bounded pages after the requested ordinal and return
the exact predecessor when requested. A domain carrying valid
`authoritative-empty` generation evidence needs no page-reader implementation
for transfer reads because the wrapper synthesizes its canonical empty page.
Missing, inaccessible, failed, or merely unsupported readers must never be
mislabelled as authoritative-empty. The adapter must implement verification
for the source identity, witness, content/manifest digests, and optional
boundary; it must report change or invalid evidence rather than guessing. It
owns backend transactions, snapshots, locks, and cleanup and must close them
even after abort.

A destination consumer must negotiate before writing, apply records in domain
order, validate every record and dependency, persist the canonical checkpoint,
and use its own transaction/durability and authoritative readback rules before
acknowledging a batch. It must preserve logical identities and six-digit record
timestamps, maintain any backend-specific identity map transactionally, and
never infer success from a lost response, a local phase name, or elapsed time.
The portable stream does not provide a destination transaction or durability
primitive.

## Ownership boundaries

- **#616** owns this backend-neutral record, stream, manifest, checkpoint,
  canonicalization, and validation contract. It does not own backend readers,
  SQL, destination writes, leases, or routing.
- **#622** owns the authenticated immutable SQLite snapshot and witness
  lifecycle. It consumes this stream seam and does not redefine the record or
  checkpoint contract.
- **#623** owns fenced migration batch-copy orchestration, destination commit,
  durable resume/checkpoint acknowledgement, and migration-specific recovery.
  It may map the portable checkpoint digest into its migration evidence but
  does not replace this contract.
- **#618** owns CLI routing, the separate promoted-knowledge transfer contract,
  production SQLite/PostgreSQL canonical readers and writers, durable ordinary
  transfer receipts and the bounded runner. See [Canonical backend transfer](portable-transfer.md).
- **#626** owns rollback orchestration, verified fresh-generation publication
  and recovery archive materialization. It consumes the production adapters
  and does not add another wire format.

The record-stream contract does not perform snapshot capture, migration
cutover, global writer fencing, or recovery archive activation. The production
readers, writers and operational CLI surfaces are described in the
[canonical transfer guide](portable-transfer.md).
