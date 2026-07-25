# PostgreSQL development

LCM's PostgreSQL runtime, migration runner, and complete PostgreSQL 18 schema
baseline are internal until the domain adapters tracked by #84-#91 satisfy the
shared storage contracts and #92 enables cutover. SQLite remains the default,
and the application factory deliberately rejects `storage.backend=postgresql`
during this stage. See the [PostgreSQL schema reference](postgresql-schema.md)
for tables, integrity rules, index families, extension prerequisites, retention,
and backup implications.

## Run the conformance harness

Docker and the runner-provided OpenSSL must be available. From a clean checkout
with dependencies installed, run:

```bash
npm run test:postgresql
```

The same command runs locally and in CI. Locally it publishes a cryptographically
random loopback port. In CI, Vitest runs in the digest-pinned Node image on the
run's private Docker network, using a certificate hostname-valid network alias.
The CI runner uses Vitest's on-the-fly config loader because the checked-out
workspace and `node_modules` are mounted read-only.
No fixed host port, reusable password, global Docker resource, or developer
database is used.

The harness never discovers an existing server. A developer-installed
PostgreSQL instance, the default Unix socket, `localhost:5432`,
`LCM_POSTGRES_URL`, and every `PG*` environment variable are invalid harness
inputs and are never test targets.

Each run creates random credentials, a labeled container, network, volume, TLS
CA and server certificate, and a control database. PostgreSQL accepts host
connections only over TLS with SCRAM authentication. The harness verifies major
version 18, UTC, the server certificate and CA, least-privilege migrator and
runtime roles, and the `pg_trgm`, `unaccent`, `pgcrypto`, and
`pg_stat_statements` extensions. Every test or worker obtains a fresh database
with a private sentinel recording the run ID, database name, and expected
runtime role.

Every Docker object carries the random run ID, its resource kind, label-schema
version, owner PID, and a process-birth fingerprint. Linux uses the boot ID and
kernel start time, macOS uses `ps` start time, and Windows uses the PowerShell
CIM process creation time. A zero-signal process probe is checked first; the
PID alone is not ownership evidence because the birth fingerprint prevents a
recycled PID from making an orphan appear live.

Database drops and container cleanup fail closed. Before mutation, guards check
the generated name prefix, PostgreSQL major version, current role, private
sentinel, and complete Docker ownership labels. SIGINT, SIGTERM, and SIGHUP use
the same idempotent cleanup path and retain their conventional exit codes.
Removal is bounded and retryable, and every attempt reinspects the exact labels
before issuing an exact-name removal.

Before allocating a new run, the harness inspects labeled resources left by
earlier runs. It reclaims a set only when every discovered object has a
versioned, internally consistent owner record and the operating system proves
that owner exited or that its PID was reused. Live owners are preserved.
Legacy labels, malformed or incomplete records, inconsistent owners, denied
`/proc` evidence, and unsupported identity evidence are ambiguous and remain
untouched. This permits a later run to recover resources after an uncatchable
SIGKILL without using resource age, broad name matching, or global pruning.
A running stale database must make its sentinel observable before recovery;
an exactly owned stopped container can be removed without executing a sentinel
that Docker cannot expose.
While local Vitest is active, a private bounded consumer record keeps its PID
and birth fingerprint with the run. A later harness preserves the run if that
consumer survived its parent. CI similarly preserves a run while its labeled
runner or restore container is still running.

A failed ownership or database-sentinel guard intentionally leaves resources
for inspection. Never delete them by a broad name glob. Inspect the exact
labels first:

```bash
docker ps -a --filter label=com.donadiosolutions.lcm.postgresql-test-run
docker network ls --filter label=com.donadiosolutions.lcm.postgresql-test-run
docker volume ls --filter label=com.donadiosolutions.lcm.postgresql-test-run
```

For an ambiguous resource, inspect its complete labels and verify that the
recorded PID and birth fingerprint no longer identify a live process before
manually removing that exact object. If the evidence cannot be established,
preserve it for reconciliation; elapsed time is never proof of ownership.

## Add or change a migration

Migration files live in `src/storage/postgresql/migrations/`, use an ordered
four-digit prefix, and are copied to `dist` by `npm run build`. After changing a
file, calculate its SHA-256 digest and update the explicit manifest in
`src/storage/postgresql/migrations.ts`. Never edit an already released
migration: checksum drift is rejected. Add a new migration instead.

Inside the locked migration transaction, the runner requires PostgreSQL 18 and
inspects `pg_trgm`, `unaccent`, `pgcrypto`, and `pg_stat_statements`.
Before opening that transaction, it reads
`pg_catalog.current_setting('server_encoding')` and requires exactly `UTF8`.
Non-UTF-8 or malformed results fail with sanitized database-recreation or
restore guidance; LCM never changes encoding. Runtime health enforces the same
requirement before extension or search-fingerprint inspection.
The first transaction operation sets a local `search_path` of
`pg_catalog, public`; it applies through the advisory lock, all preflights, and
all pending migration SQL, then reverts on commit or rollback. Extension
inspection additionally binds its operators to `pg_catalog` because runtime
health can run outside the migration transaction. Tests deliberately install
matching-signature hostile functions and operators ahead of `pg_catalog`.
Every extension must be installed in `public` at its available default version.
Unavailable, installed-but-unavailable, uninstalled, not-preloaded,
version-mismatched, or wrong-namespace extensions block migration and runtime
readiness with structured, sanitized administrator guidance. A version mismatch
does not infer upgrade direction or prescribe `ALTER EXTENSION ... UPDATE TO`,
because the installed version may be newer than the default and a downgrade
path may not exist. It directs administrators to their provider-supported
version-management path instead. Catalog-controlled version strings remain
available in structured diagnostics but are not interpolated into remediation
SQL or prose. An installed-but-unavailable
extension requires restoring its matching control files, not running `CREATE
EXTENSION`. For an otherwise-current `pg_stat_statements`, least-privilege
readiness functionally reads `public.pg_stat_statements_info`; only SQLSTATE
`55000` becomes `not-preloaded`. Migration performs this potentially failing
probe before its DDL transaction, then verifies the same postmaster epoch and
loaded module under the advisory lock. It also re-reads the non-probe extension
catalog contract after acquiring that lock, so a drop, relocation, or version
change while waiting cannot reach pending DDL; the functional probe is not
repeated inside the transaction. Remediation tells the administrator to add the module to
`shared_preload_libraries` and restart PostgreSQL. LCM
never creates, upgrades, relocates, reinstalls, or drops an extension. For a
wrong namespace, relocatable extensions receive `ALTER EXTENSION ... SET SCHEMA
"public"` guidance; non-relocatable extensions receive an explicit reinstall
requirement without automatic destructive SQL. Complete and verify the
operation through the cluster administrator, then rerun migration.

Schema conformance also exercises repository-defined opaque metadata and caller
identifiers directly: message-part metadata must round-trip as text, while
unbounded summary IDs round-trip exactly through bounded UUIDv7 relationship
keys and digest-plus-exact lookup. Unbounded large-file IDs use the same
UUIDv7-key and digest-plus-exact design and remain unique within a project
rather than globally.
Each remote project receives a globally unique opaque random 32-byte
`identity_key` that is independent of every machine-local path hash. The
internal UUID is the explicit cross-machine project identifier; another
machine joins that logical project only through `lcm project link <uuid>`, not
by reproducing a path-derived key. Arbitrary-length
session IDs remain exact text, but conversations, native transcripts, recall
surfacing, and ingest completion index only fixed-width SHA-256 candidates.
Repository lookups must retain exact session-text equality as the collision
residual. Session-ingest uniqueness uses an internal UUIDv7 key and an
advisory-locked digest-plus-residual trigger rather than a raw-text primary key.
All three exact-identity triggers are `ENABLE ALWAYS`; privileged replica-mode
sessions therefore execute the same uniqueness checks instead of bypassing
them.
Promoted-memory source IDs are preserved as external provenance without a
local-summary foreign key. Floating-point step costs reject `NaN` and both
infinities. Search and tag normalization use PostgreSQL 18's builtin
`pg_unicode_fast` full case mapping, whose behavior is stable within the
required major version and independent of libc or ICU provider upgrades.

The same backend-neutral contract preserves promoted-memory tags exactly,
including order, duplicates, case distinctions, empty values, and surrounding
whitespace; tag filters remain case-sensitive even though separately indexed
normalized and lexical projections support explicit normalized lookup and
tag-only search. Summary `earliestAt` and `latestAt` values are independently
optional and are ordered only when both exist. Summary file-reference arrays
likewise preserve order and duplicates, and unresolved or cross-conversation
IDs remain opaque rather than requiring a matching `large_files` row.
Recall surfacing IDs are also opaque text: orphan and historical observations
remain queryable after a promoted-memory row is absent or deleted.

The migration role must own an existing `lcm` schema. The runner permits an
absent schema because `0001` creates it as the current migration role, but it
fails closed when another role owns an existing schema even if that role has
delegated `CREATE` to the migrator. Transfer ownership explicitly with the
cluster administrator before retrying; LCM never changes schema ownership.
The locked migration transaction also requires its own backend session to
report `session_replication_role = origin` before taking the advisory lock or
trusting any LCM schema metadata. Replica or local mode can suppress internal
constraint triggers such as foreign-key enforcement, so readiness fails with
structured remediation instead of resetting this privileged, session-local
setting. Restore `origin` on that connection, or reconnect with the default
session state, before retrying.
On every run, a catalog-only ledger preflight permits
`lcm.schema_migrations` to be absent for first installation, but requires a
present ledger relation to be an ordinary table owned by the current migration
role. A view, materialized view, foreign table, or other relation kind is
rejected before any ledger row is read. The runner then checks ownership of
every existing allowlisted object through `pg_catalog`, verifies the ordered
ledger, and requires the exact managed inventory owned by the selected current
snapshot before pending SQL.
After pending SQL and ledger rows, it requires the target snapshot's managed
inventory before commit.
Schema snapshots are keyed by migration ID: walk validated history from newest
to oldest to select the first registered snapshot, validate the current
snapshot before pending SQL, and validate the target snapshot after applying
and recording the pending set but before commit. Registry order is irrelevant.
Add a new snapshot entry whenever a future migration intentionally changes a
fingerprinted definition or managed object. Each snapshot owns the exact
managed-object identities, every definition-group identity, derived count and
hash, plus the complete identity-function name/hash list.
A missing table, generated identity sequence, helper or trigger function,
text-search dictionary, or text-search configuration blocks repeated runs and
later pending migrations once that baseline is trusted; a smaller surviving
inventory is not accepted.
Unknown objects remain preserved and may have a different owner. The summary,
large-file, and session-ingest identity functions are also fingerprinted by
stored body and security configuration. Body, language/return type,
security-definer/leakproof, volatility, parallel-safety, fixed search path, or
complete normalized ACL drift fails closed.
The `0002` definition inventory also fingerprints the complete 205-column
ordinary inventory of its 24 allowlisted tables, including
`recall_surfacing.surfaced_at`. Each ordinary column retains its formatted
type, nullability, deparsed default, identity state, and resolved
namespace-qualified collation. Generated-column fingerprints retain the same
resolved collation in addition to formatted type, nullability, generated state,
and expression.
It fingerprints all six generated identity sequences by type, increment,
minimum, maximum, start, cache, cycle state, internal identity dependency, and
owning table/column, and requires permanent persistence.
It also requires all 24 allowlisted tables to remain ordinary permanent tables
with both row-level-security flags disabled and no inheritance or partition
parent/child relationships, and fingerprints the complete
effective ACL of every allowlisted table and identity sequence. ACL comparison
expands PostgreSQL default ACLs when the
stored ACL is null and normalizes only the owning role, so explicit owner-only
ACLs compare equal to defaults while `PUBLIC`, named-role, privilege,
grant-option, foreign-grantor, and missing-owner drift fail closed.
The separate 220-column ACL group includes one canonical identity row for
every ordinary and generated column even when `attacl` is null, then expands
all explicit column grants with the same owner-only normalization.
Constraint fingerprints include the owning table and constraint name as well
as type, definition, and internal-trigger state; renaming or swapping
same-type constraints is drift.
Failure diagnostics identify `requiredOwner` using the sanitized PostgreSQL
`CURRENT_USER` role and provide identifier-quoted transfer guidance. They do
not expose the existing owner, connection details, or raw database errors, and
missing or malformed catalog values fail closed.
Migration transactions pin `search_path = pg_catalog, public` and
`quote_all_identifiers = off` before catalog deparsing. Tests that change role,
database, or session GUC defaults must prove those ambient settings neither
change a fingerprint nor leak across commit or rollback.

Exercise at least the empty, repeated, concurrent, rollback, unknown-history,
out-of-order, and checksum-drift paths. Migration SQL and the ledger insertion
must remain in the same transaction under the database-scoped advisory lock.
Create owned helper functions without replacement. A same-signature function
is an operator collision that must fail and roll back the pending set while
leaving the existing function unchanged. Revoke `PUBLIC` privileges only from
explicit LCM-owned tables, sequences, and functions; never use a schema-wide
object revoke that would alter ACLs on unknown pre-existing objects.
A supported pre-existing `lcm` schema must not grant `CREATE` to `PUBLIC`.
Migration checks that prerequisite before owned DDL and fails without revoking
or otherwise changing the schema ACL; an administrator must remove the unsafe
grant explicitly before retrying.

If startup reports unknown, out-of-order, or checksum-drifted history, stop and
compare the packaged manifest with `lcm.schema_migrations`. Do not edit the
ledger, replace a released migration, or skip the check. Restore the expected
artifact or database from a known-good backup, then retry. A failed pending
migration rolls back its SQL and ledger insert together and can be retried only
after its underlying SQL or schema prerequisite is corrected in a new
migration.

## Managed-service operation

For DigitalOcean Managed PostgreSQL 18 Standard Edition, use separate login
roles for migration and runtime work. The migrator owns LCM schemas and applies
the ordered migration set; the runtime role receives only the object privileges
needed by repositories. Keep extension installation with the cluster
administrator because `pg_stat_statements` and other extensions may exceed the
migrator's privileges. Confirm the exact target cluster against DigitalOcean's
[supported-extension matrix](https://docs.digitalocean.com/products/databases/postgresql/details/supported-extensions/)
and its `extwlist.extensions` setting before rollout, then confirm the installed
namespace is `public`.

Size `poolMax` against the cluster connection limit after reserving capacity for
administration, migrations, monitoring, and other services. Multiply the value
by the maximum number of simultaneously running LCM daemon processes; do not
treat it as a host-wide total. `connectionTimeoutMs` bounds pool acquisition and
new connections, `idleTimeoutMs` retires unused pooled clients, and
`statementTimeoutMs` also supplies the idle-in-transaction session bound. Keep
all three finite and below upstream load-balancer or maintenance timeouts so LCM
fails with a sanitized storage error first.

To rotate the managed CA, download the replacement from DigitalOcean's
Connection Details page, write it atomically to a new private regular file,
update `LCM_POSTGRES_CA_FILE`, and restart LCM. Confirm health before removing
the old file. Never append server certificates, client keys, or connection URL
parameters to bypass CA or hostname verification.

## Refresh container images

The PostgreSQL and CI-only Node references in
`scripts/postgresql-harness.mjs` must include an exact tag and immutable
`sha256` digest. To refresh one:

1. Select the exact upstream patch tag (`18.x-bookworm` for PostgreSQL or the
   approved exact Node release).
2. Pull that exact tag and inspect its repository digest for the CI runner's
   architecture with Docker. Do not copy a mutable-tag-only reference.
3. Review upstream release and security notes and confirm the image still
   provides the expected entrypoint, OpenSSL compatibility, extensions, and
   Debian base.
4. Replace both tag and full digest in the harness, update the image assertions,
   and run `npm run test:postgresql` locally and through both CI matrix jobs.
   The stable required `ci` check depends on the complete matrix, so any
   PostgreSQL conformance failure blocks admission even when core CI passes.
5. Confirm the reports and failure output contain no connection URL, password,
   SQL parameter, CA or private-key material, or temporary secret path.

The PostgreSQL entrypoint sources initialization scripts as the `postgres` user.
The harness therefore starts through a root wrapper that copies host-owned
`0600` secrets and the server key into a private PostgreSQL-owned runtime
directory before invoking the official entrypoint. Removing that wrapper causes
permission failures and must not be worked around by weakening host file modes.

## Troubleshooting

- `permission denied` below `/run/lcm-harness`: retain the root copy wrapper and
  PostgreSQL-owned `0700` runtime directory; do not make credentials world
  readable.
- certificate hostname errors: local URLs must use `127.0.0.1`; CI URLs must use
  the run-specific network alias included in the certificate SAN. Do not disable
  hostname or CA verification.
- `pg_stat_statements` creation denied: extensions are installed by the harness
  administrator before migrations; the migrator is intentionally not a
  superuser.
- cleanup refusal: inspect the exact run ID, schema, kind, PID, birth
  fingerprint, and database sentinel. A refusal indicates ownership cannot be
  proven; preserve the resources until the mismatch is understood. Do not
  remove resources merely because they are old or share an `lcm-pg-` prefix.
- pool exhaustion or idle-transaction disconnects: acquisition, statement, and
  idle-transaction bounds are deliberate. Keep tests shorter than their
  transaction idle timeout unless the timeout itself is under test.
