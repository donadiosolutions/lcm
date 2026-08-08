# Backend publication safety

This guide describes the backend-publication admission boundary delivered by
chore #408. It is written for operators and maintainers who need to understand
what LCM protects while local configuration, project bindings, and PostgreSQL
evidence are being coordinated.

## Current status

This boundary is a prerequisite for later backend activation work; it is not
the activation work itself. Issues #92 and #224 are not implemented.
PostgreSQL selection remains unavailable to normal production configuration,
the daemon, and the CLI. SQLite remains the only selectable production storage
backend. The PostgreSQL runtime, schema, direct repositories, and coordination
primitives described by the reference documentation are staged for direct
programmatic use and conformance; they do not make PostgreSQL authoritative for
normal application routes.

Do not configure a production installation expecting PostgreSQL daemon or CLI
routes to work. The publication boundary is the shared seam that those future
activation paths must consume when #92 and #224 are implemented.

## Current backend boundaries

LCM keeps the following Epic #79 invariants:

- SQLite is the default backend and remains the normal local behavior.
- PostgreSQL is a staged remote-primary target, not a currently selectable
  production backend. It does not silently fall back to SQLite and does not
  yet activate normal `ProjectStorage` routing.
- Hooks append events to the durable local SQLite outbox first. They do not
  require a live PostgreSQL connection to preserve the event, and an admission
  failure does not discard the local outbox record.
- A missing, unresolved, malformed, inconsistent, or unsafe publication state
  fails closed. LCM never treats a partially written configuration or project
  map as proof that a backend is active.
- The publication boundary is a shared seam for the not-yet-implemented #92
  and #224 work. Those features must consume it rather than introduce a second
  lock, journal, or fencing protocol.

For ordinary SQLite installations, this machinery is dormant after the
private state root is authenticated. It does not change SQLite's storage
semantics or require a new dependency.

## What the admission boundary protects

Every project-scoped PostgreSQL query and transaction declares its complete
project scope. Project identifiers are canonicalized to lower case and sorted
strictly before admission; cross-project operations cannot acquire only a
partial scope. A transaction establishes `READ COMMITTED` and `READ WRITE`
before its first admission or row read, so a deployment-wide PostgreSQL
default cannot change the coordination snapshot.

Normal project mutation takes shared admission through a project-scoped
transaction advisory lock and then checks the reserved publication resource
(`resource_type = 'backend-publication'`, `resource_key = 'selection'`) in
`lcm.fenced_leases`. An unreleased publication row blocks the mutation even if
its expiry is old: an unresolved publication must be recovered or completed,
not guessed to be harmless from elapsed local time.

The publication path has the corresponding exclusive advisory admission. Its
PostgreSQL runtime exposes exact `acquire`, `renew`, `release`, and `read`
operations through `backendPublicationGuard()`. The guard binds the target
backend and remote evidence digest to the reserved fenced lease. Lease expiry
is evaluated with the PostgreSQL database clock (`statement_timestamp()`), not
the application host clock. Every takeover receives a new monotonic fencing
token, and a predecessor token cannot renew, release, or authorize a later
generation.

If a PostgreSQL commit or connection response is uncertain, the caller reads
the exact fenced-lease row back authoritatively before advancing local
publication state. An absent, changed, expired, or contradictory row remains a
failure; LCM does not infer success from a lost response.

This coordination uses the existing `lcm.fenced_leases` table and advisory
namespace. Chore #408 adds no schema object, `MAINTAIN` privilege, full-table
lock, schema-creation privilege, ownership transfer, or broad future-object
grant.

## Durable local publication state

The local coordinator keeps its authenticated evidence below the private state
root:

```text
~/.lcm/backend-publication/
  journal.json
  <publication-id>.material
  history/
```

The exact path is derived from the configured home for isolated installations;
the default is under `~/.lcm`. Files are bounded, private, checksum-protected,
and opened through descriptor- and ownership-aware filesystem seams.

The operator-visible journal progression is forward-only:

1. **`preparing`** — a deterministic journal is written before recovery
   material is sealed. The material contains bounded source and target copies
   of configuration and project-map state.
2. **Authenticated checkpoints** — the journal records exact witnesses for
   bytes, canonical semantics, ownership, mode, link count, and filesystem
   identity while it acquires fences, publishes the state, and releases the
   fences with authoritative readback.
3. **Terminal `completed` or `aborted`** — the final authenticated record is
   retained and terminal history is archived.

The coordinator writes the deterministic `preparing` journal before it seals
the recovery material. Writes use atomic replacement and directory durability
where the platform supports it; unsupported directory `fsync` is tolerated
only for the known platform error codes. Other durability failures fail
closed.

The internal coordinator exposes `prepare`, `resume`, `abort`, and
`recoverPending` seams for the activation workflow. Once remote release has
begun, recovery only moves forward. Mutation permits are tied to the permit
object and revoked when their callback ends, so an inherited asynchronous
callback cannot reuse authority after a phase change or release.

If a process dies at any checkpoint, the journal and material are recovery
evidence. Do not edit, delete, rename, or bulk-clean the directory. The current
command surface does not provide a general journal-editing command. Run
`lcm doctor`, preserve its sanitized output, and let the owning publication
recovery flow resume or abort the authenticated journal; rerun `lcm doctor`
and `lcm daemon restart` after the flow reaches a terminal state. An ambiguous
filesystem or database result is intentionally retained for inspection rather
than silently repaired.

Consumers accept only an authenticated terminal journal with matching
configuration, project-map, target-backend, recovery-material, and remote-fence
witnesses. Missing evidence, unknown residue, checksum drift, active remote
fences in a terminal record, and backend mismatch all remain blocked.

## Establishing `~/.lcm` safely

The normal `lcm install` and bootstrap paths establish the root through one
guarded TypeScript bootstrap operation. Do not pre-create a replacement root
with an untrusted recursive `mkdir -p` or copy state into it by hand.

The bootstrap checks the actual `$HOME` before creating state. `$HOME` must be
an existing, non-symlink directory owned by the current user and must not be
group- or world-writable. The active `~/.lcm` root is created as one final
component, tightened to exact mode `0700`, reopened through a directory
descriptor, and revalidated for owner, mode, identity, and durability. Root and
publication directories reject symlink substitution and use directory-safe
open flags where the platform provides them. Configuration reads and writes
are bounded and descriptor-aware; a config symlink, non-regular file, or
oversized file is rejected before mutation.

The installer refuses to establish an active root while the legacy
`~/.lossless-claude` state directory exists. An explicit migration is required
so two roots cannot silently become competing authorities. Legacy migration is
copy-first: it records a journal, verifies bounded regular files and
directories, rejects symlinks, writes a staging tree, performs the final
publication-lock handoff, and retains the source until the published target is
authenticated. Source and target identities, hashes, ownership, and modes are
rechecked at each boundary. A changed or ambiguous source is preserved with
its journal for recovery. This migration establishes the secure local root; it
does not perform PostgreSQL migration or backend cutover.

## Operator-visible failure behavior

Publication admission is checked at startup and again at consumer boundaries.
The check is deliberately short-lived around each operation; it is not held
across network calls, request bodies, model work, daemon spawning, or unrelated
health waits.

- **Daemon and health:** an unresolved or inconsistent publication returns a
  sanitized HTTP `503` with `status: "blocked"` and no filesystem, SQL, URL,
  credential, or raw driver detail. A staged PostgreSQL witness that is valid
  but not terminally usable reports storage unavailable rather than pretending
  that normal PostgreSQL routes are active.
- **MCP:** startup and each routed request authenticate a fresh publication
  witness. A blocked request is reported as `lcm error: backend publication
admission blocked; complete or recover the publication before retrying`.
  MCP does not restart or kill a daemon because of this condition.
- **CLI and hooks:** backend selection, project-map/configuration mutation,
  daemon lifecycle, and publication-dependent work fail closed without SQLite
  fallback. Hook capture still preserves the event in the local SQLite outbox
  before later publication-gated work is attempted.
- **Doctor:** `lcm doctor` emits a sanitized `backend-publication` failure with
  guidance appropriate to missing evidence, an unresolved journal, backend
  mismatch, or unsafe state. It continues unrelated diagnostics, but skips
  project-map and worktree reconciliation, automatic daemon start/restart or
  repair, hook/MCP/lcm.md repair, and project-pattern diagnostics while the
  publication gate is blocked. It does not mutate the journal to make the
  check pass.

The no-override `lcm compact --hook` wrapper is a deliberately narrow hook
exception. Before dispatch it does not resolve PostgreSQL credentials. If the
configured backend is unavailable, credentials are absent, or daemon
admission fails, the wrapper exits `0` with no output so it cannot block the
agent's own compaction. Explicit retry or timeout overrides only validate the
secret-free LLM request-policy projection; they do not resolve PostgreSQL
credentials before dispatch. This exception does not make PostgreSQL
selection available, bypass publication admission for storage work, or permit
SQLite fallback for normal routes.

The safe operator sequence is therefore: preserve the evidence, run
`lcm doctor`, resolve the authenticated publication through its owning flow,
then rerun doctor and restart the managed daemon. Never force a backend by
deleting `journal.json`, removing a fenced lease row manually, or changing the
configured backend until the corresponding publication evidence is terminal.

## PostgreSQL privilege and deployment posture

Provision PostgreSQL with the migration role, then apply only the reviewed
runtime grant scripts needed by the direct staged repositories as an
administrator. The runtime role must not own the schema or run migrations.
The [PostgreSQL schema reference](../src/storage/postgresql/reference/postgresql-schema.md)
and [configuration guide](configuration.md#provisioning-a-postgresql-database)
contain the complete staged deployment sequence. Applying that sequence does
not make PostgreSQL selection available or implement #92/#224.

The final audit found the SQL changes already implemented for chore #408
sufficient; this documentation lane required no additional SQL correction:

- The already-implemented domain grant updates add the narrow `SELECT` on
  `lcm.fenced_leases` needed for project mutation admission. The identity
  grant also includes `project_id` in the project-creation `INSERT` column set,
  so a UUID allocated before admission can be written without broadening the
  grant. These remain column-limited operations on the same configured
  runtime role.
- The reviewed coordination grant script supplies that same configured runtime
  role with the publication guard's required `SELECT`, `INSERT`, `UPDATE`,
  and bounded `DELETE` on `lcm.fenced_leases`, plus `USAGE` on its
  fencing-token sequence. It does not grant sequence inspection or restart
  authority.
- None of the scripts grants `MAINTAIN`, `TRUNCATE`, table ownership, schema
  creation, grant options, unrestricted future-object access, or unrelated
  domain tables. Readiness rejects broader, `PUBLIC`, grantable, or
  foreign-grantor privilege shapes.

Applying the selected scripts exposes direct staged repository and
coordination primitives to the same configured runtime role; it does not
activate normal PostgreSQL daemon/CLI routing. Keep `LCM_POSTGRES_URL`
restricted to that reviewed runtime role after migration and grant deployment,
and keep the migration role separate from the daemon.

## Related references

- [Storage-backend configuration](configuration.md#storage-backend)
- [Managed daemon recovery](daemon-restart-recovery.md)
- [PostgreSQL cross-machine coordination](../src/storage/postgresql/reference/postgresql-coordination.md)
- [PostgreSQL schema and privilege reference](../src/storage/postgresql/reference/postgresql-schema.md)
- [Architecture and staged activation](architecture.md)
