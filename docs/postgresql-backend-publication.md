# Crash-recoverable PostgreSQL backend publication

LCM coordinates every supported PostgreSQL project mutation with backend
selection and recovery. This prevents a process from exposing PostgreSQL as
selected while migration evidence is only partly published locally.

The protocol is crash-recoverable rather than cross-system atomic. PostgreSQL
transactions cannot atomically commit the local project map, configuration
file, and private filesystem journal. LCM combines remote per-project guards
with an authenticated local state machine. Normal writers and
backend-selection consumers fail closed until recovery reaches a compatible
terminal state.

## Remote writer admission

Every normal project-scoped mutation submitted through `PostgreSqlRuntime`
declares its complete project scope before the transaction callback starts.
Callers supply `projectIds` as a unique set in canonical UUID order
(`projectId` remains the single-project shorthand). The runtime normalizes UUID
case, rejects a sequence that is not then strictly sorted and unique, takes one
shared transaction-scoped advisory lock per project in that order, and checks
each reserved lease row:

- `resource_type = 'backend-publication'`
- `resource_key = 'selection'`
- the row is scoped by the exact project UUID

The callback may query or create savepoints for a subset of its admitted
projects, but it cannot enlarge the scope. Identity transfer and restoration
declare both the prior and current project IDs. Machine-global
registration/recovery and administrative migration or health preflight are the
only projectless writer/admin exceptions.

An unreleased row blocks the project even after its lease expires. Expiry means
that the exact publication generation must recover its fence; it does not let
ordinary writers resume. Another project uses different advisory locks and a
different row, so it can continue independently.

Publication control uses `runtime.backendPublicationGuard()`. It takes the
exclusive half of the same advisory lock before it creates, recovers, renews,
or releases the reserved lease. This waits for admitted writers to commit and
prevents new writers from entering while the guard transaction runs. The
runtime's statement timeout and cancellation bound the wait.

The guard binds project, machine, publication generation, target backend,
evidence SHA-256, and a monotonically increasing fencing token. Recovery of an
expired same-generation row requires the exact prior token. A stale process
cannot renew or release a successor. When the client loses a commit response,
LCM performs authoritative database readback and accepts only the exact
resulting fence state. Sequence gaps after failed attempts are safe and are
never reset.

Ordinary `PostgreSqlWorkCoordinator` acquire, renew, release, validation,
inspection, diagnostics, manipulation, and cleanup APIs reject the reserved
resource before database effects. Only the dedicated publication guard can use
it.

## Local journal and recovery material

The active journal is `~/.lcm/backend-publication/journal.json`. Sensitive
source and target bytes remain in operation-owned sealed recovery material.
The journal stores only an authenticated relative reference, seal SHA-256,
byte length, and non-secret witnesses. Each config and project-map witness
records presence, raw and canonical-JSON SHA-256, byte length, mode, UID, GID,
and single-link status. Presence is explicit: an absent file is not treated as
a present file containing `{}`.

LCM requires the LCM root, publication directory, journal, lock, recovery
material, and retained history to remain private. Directories are mode `0700`;
files are mode `0600`, regular, single-link, same-owner, and opened without
following symlinks. Reads and writes are bounded. Durable file publication uses
an exclusive same-directory temporary file, file `fsync`, atomic rename, and
parent-directory `fsync`. Restoring absence uses unlink plus parent-directory
`fsync`. Terminal journals and their recovery evidence remain authenticated
history before another publication begins.

The forward state machine is:

1. `prepared`: seals source and target state before remote acquisition.
2. `acquiring`: persists progress after each acquisition attempt and readback.
3. `guarded`: proves an exact unreleased fence for every project.
4. `map-published`: proves the exact target project-map bytes and semantics.
5. `config-published`: proves the exact target configuration bytes and
   semantics.
6. `releasing`: persists progress after each release attempt and readback.
7. `released`: proves every fence is authoritatively released.
8. `completed`: proves backend selection and local state match the target.

Before release begins, recovery may choose abort:
`abort-prepared → config-restored → map-restored → abort-releasing → aborted`.
It restores exact source bytes, metadata, or absence and releases every fence
before becoming terminal. Once `releasing` begins, recovery is forward-only;
it cannot expose a partially restored source state after remote release has
started. Every transition requires the exact predecessor checksum and
reauthenticates local and remote evidence.

The per-home publication-journal lock is outermost and remains held for the
entire coordinator operation, including remote steps. Beneath it, one step
holds either the config or project-map lock for one local mutation, or one
PostgreSQL advisory transaction lock for one remote acquire, readback, or
release. The inner config and project-map locks are never held across a remote
transaction. Projects are processed in sorted local-project order, and each
remote transaction ends before the next project or local file step.
Normal runtime callbacks begin only after every requested shared project guard
is held. Migration and routing code must not invert these rules or acquire a
new project from inside a narrower transaction.

## Consumers and recovery

Backend selection, factory creation, daemon and hook configuration loading,
effective configuration projection, `lcm config get/set`, project-map loading,
validation, cache reload, and watcher startup all inspect the authenticated
journal. They reject every unresolved phase before exposing or mutating backend
selection. A terminal journal must agree with the completed or restored
backend. `lcm doctor` emits one sanitized failed configuration diagnostic,
continues unrelated checks, and never changes config, map, journal, recovery
material, or remote evidence while publication is unresolved.

A parseable legacy or staged PostgreSQL selection with no publication history
is untrusted: it cannot create a usable backend or authorize writes. Once any
history marker exists, missing active evidence is never grandfathered. SQLite
without publication history keeps its legacy behavior.

`BackendPublicationCoordinator` exposes prepare, resume, abort, and pending
recovery entry points for #92 and #224. It invokes caller-supplied config and
project-map drivers with authenticated recovery material. Each driver
atomically publishes or restores the exact requested bytes, metadata, or
absence and returns a post-write witness; the coordinator independently
observes that witness before advancing.

Recovery permits are operation-specific, revocable, and awaited. They bind the
exact publication ID, journal checksum, phase, local root, operation, and state
witness. Each protected consumer reauthenticates the journal, so a permit
expires when its callback settles or a phase transition changes the checksum.
Detached asynchronous work cannot inherit a usable permit.

After a crash, do not delete or edit the journal, recovery material, history,
or reserved lease row. Restart the exact owning operation or invoke pending
publication recovery. If authentication, checksums, raw or semantic witnesses,
metadata, project bindings, or fence evidence differ, LCM fails closed and
preserves the evidence for operator diagnosis.

## Privileges and threat boundary

Any process executing the dedicated guard requires the reviewed coordination
grant in
[`postgresql-runtime-coordination-grants.sql`](postgresql-runtime-coordination-grants.sql).
Ordinary domain writers receive only `SELECT` on `lcm.fenced_leases` from their
domain grant so they can perform shared admission; they do not receive lease
mutation or sequence privileges. The guard adds no schema object, migration,
table-wide lock, `MAINTAIN`, ownership, `ALTER`, `TRUNCATE`, or unrelated-table
privilege.

The contract covers cooperative LCM runtime and repository paths. Direct SQL
issued by an administrator or an uncooperative client bypasses application
admission and must be stopped separately during publication.
