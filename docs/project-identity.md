# Machine registration and project identity

LCM keeps SQLite as the zero-configuration storage backend. A local project is
identified by the SHA-256 hash of its normalized canonical path. For a Git
repository, LCM first resolves the verified Git common directory and uses the
primary checkout as that canonical path, so linked worktrees share one local
project. A primary checkout created with `git init --separate-git-dir` and all
of its linked worktrees share that external Git directory as their stable local
anchor only after the external configuration's final `core.worktree` value
resolves back to the exact authenticated primary checkout. Relative
`core.worktree` values follow Git's metadata-directory-relative semantics.
Every standalone `.git` file pointer, whether absolute or relative, must supply
that proof. Relative pointers retain submodule-style checkout anchoring only
after verification; they cannot select unrelated metadata by traversal.
Missing, ambiguous, mismatched, or race-changed backlinks fail before project
storage opens. Git submodules remain independent projects anchored at their own
checkouts. Git config `include` and `includeIf` directives are rejected for
identity proof because their targets fall outside the bounded authenticated
config snapshot. A repository-local `.git` directory may use only a `commondir` that
remains inside that authenticated metadata root; local indirection cannot select
another checkout's administration directory. Non-Git directories continue to
use their normalized path directly.

LCM reads Git metadata through descriptor-bound, no-follow validation and
revalidates the marker, directories, topology pointers, and relevant config
bytes before accepting the identity. `HEAD`, `gitdir`, `commondir`, and other
topology pointers remain limited to 64 KiB; `.git/config` and
`config.worktree` accept valid files up to 4 MiB so accumulated branch metadata
does not block project identity. Larger, symlinked, non-regular, substituted,
or escaping metadata continues to fail closed.

On case-insensitive filesystems, a `.git` file may spell its target with
case-only component differences. LCM accepts that spelling only when the
requested and canonical paths have the same stable, nonzero filesystem
identity and every different component has one unique, bounded, unchanged
same-fold directory entry. The canonical Git directory remains the downstream
identity anchor. Symlinked, bind-equivalent, ambiguous, race-changed, or
cross-root aliases fail closed.

Git does not always write `core.worktree` when initializing a separate Git
directory. Make the relationship explicit before LCM first opens project
storage:

```bash
git -C /work/project config --local core.worktree /work/project
```

Use the authenticated checkout's real path. On case-insensitive filesystems,
LCM accepts a case-only `core.worktree` spelling only when every differently
spelled component has one stable same-fold directory entry and both spellings
authenticate to the same nonzero filesystem identity. Symlink, bind-mounted,
or ambiguous aliases, different roots or drives, and unverifiable spellings
fail closed.
When Git's common config repeats `extensions.worktreeConfig`, including across
multiple `[extensions]` sections, LCM follows Git's final-assignment behavior:
the last implicit, true/yes/on, or valid nonzero Git integer enables
per-worktree configuration, while an assigned empty value, false/no/off, or a
valid zero integer disables it. Integers support Git's decimal, octal,
and hexadecimal forms with optional `k`, `m`, or `g` scaling. Host-specific
numeric extensions such as the C23 `0b` binary prefix fail closed so project
identity does not vary by operating system or C library. For compatibility
across supported Git versions, scaled results use the symmetric portable range
from `-2147483647` through `2147483647`; older Git versions reject
`-2147483648` and equivalent scaled forms. Only integer values may have leading
ASCII C whitespace; trailing or internal whitespace remains invalid. Inline
`#` and `;` comments, quoted values, supported escapes,
continued lines, CRLF input, and case-insensitive section and key names are
parsed in one bounded linear pass. Git-compatible section headers and their
first assignment may share one physical line. A bare or deprecated dotted
section name must meet its closing `]` directly. A quoted subsection requires
one or more spaces or tabs before its opening quote and its closing quote must
meet `]` directly; whitespace after the completed header remains valid.
Any malformed, overflowing, or unsupported occurrence fails closed instead of
allowing an earlier or later truthy value to enable `config.worktree`.
The database and passive-learning sidecar remain under:

```text
~/.lcm/projects/<local-hash>/db.sqlite
~/.lcm/events/<local-hash>.db
```

PostgreSQL adds an explicit identity layer. A registered machine has a UUIDv7,
and a local project may be bound to a PostgreSQL project UUIDv7. The binding
lets two machines—or two unrelated paths—address the same remote project
without changing either local hash. Git common-directory evidence affects only
local identity. LCM never creates, selects, or changes a PostgreSQL UUID from a
Git remote, repository name, directory contents, or matching display names.

## Linked worktrees and reconciliation

On first local storage access after upgrade, LCM checks the current checkout's
verified Git common directory. If older `map.json` entries treated linked
worktrees as separate projects, LCM acquires a private cross-process lock and
merges their complete SQLite graph, promoted memories, ingest and recall
bookkeeping, redaction counts, instruction cache, passive events and errors,
and project-sensitive patterns into the primary checkout's local project.
Exact duplicates are retained once. Per-source merge markers make retries and
later-discovered generations idempotent, so each source generation is applied
exactly once.

Exact same-UUID passive events with the same immutable envelope, compatible
delivery state and checkpoints, and the same predecessor identity—the same
numeric ID or null—also reconcile idempotently. For such a compatible pair, if
the numeric predecessor row was pruned from both stores, LCM preserves the
recorded predecessor identity instead of remapping it. Once delivery is
observable, different predecessors, inconsistent predecessor presence, and any
actual remap fail closed to protect the immutable PostgreSQL envelope.
Divergent mapped numeric predecessors also fail closed, while compatible
pristine null-versus-numeric copies may coalesce before delivery. LCM neither
guesses a replacement nor discards either copy, so repeated reconciliation
remains safe.

Each operation has an atomically replaced journal under
`~/.lcm/reconciliations/`. The journal records discovery evidence, completed
merge work, backup locations, aliases, and the last durable phase so an
interrupted operation resumes instead of repeating committed work. LCM
permanently fences legacy project and event databases against writes before
committing their data to the canonical stores. After the merged databases pass
foreign-key and FTS verification, the legacy project directory and event
database sidecars move to timestamped private backups under
`~/.lcm/oldprojects/` and `~/.lcm/oldevents/`. Persistent blocker sentinels
remain at the retired project and event paths so an older LCM process cannot
recreate a split store. The project map then folds live and deleted worktree
paths into canonical aliases. Legacy data remains recoverable in the backups.
An event-path sentinel is recognized only when the hash-named
`~/.lcm/events/<local-hash>.db` path is a real directory containing exactly one
bounded, regular `fence.json` marker whose version, hash, kind, JSON bytes, and
trailing newline match the reconciliation serializer. Exact sentinels are
removed from passive-event scans before sorting, rotated start indexes, scan
budgets, database opens, or orphan pruning, so they never appear as a sidecar
or consume scan capacity. Symlinks, missing or oversized markers, malformed
JSON, wrong fields, extra directory entries, and other non-regular or
ambiguous candidates are not hidden; scans report them as failures, and
reconciliation continues to fail closed on the same shared validation.

Divergent identity collisions, malformed source state, and conflicting
PostgreSQL UUID bindings fail closed. The journal retains a blocked,
operator-visible result, and LCM does not publish a partially reconciled map.
After the conflict is corrected, rerun reconciliation; the durable journal and
merge markers continue from the verified state.

Reconciliation also fingerprints every mapped path so a repaired or remounted
worktree invalidates a completed discovery result. An `ENOTDIR` observation for
an unrelated map entry is recorded as stable unavailable evidence instead of
blocking the requested project. The requested project's own map entry and every
source proven to belong to that repository remain strict before any source
merge, archive, or map publication. `ENOTDIR` there—or any other unexpected
filesystem error anywhere—still fails closed.

The instruction cache keys every row by the complete local project, client,
agent session, verified worktree, and exact working directory scope. SQLite's
per-machine database path supplies the machine boundary; PostgreSQL includes
the registered machine UUID in the key. Reconciliation accepts only
byte-identical rows with the same complete scope. A differing row for the same
scope is a collision and blocks the run; content is never selected by a
timestamp or copied between scopes.

The upgrade deliberately discards the old process-global, fixed-slot
instruction cache because its rows have no trustworthy client, session,
worktree, or working-directory provenance. The migration validates the legacy
or current schema before making any change and performs replacement in one
transaction. Unknown or partial schemas and interrupted replacements leave the
original database intact. In every blocked reconciliation case, the original
source project and event stores have not been discarded: after a successful
reconciliation they are archived as recoverable timestamped backups, and
before success the source stores remain in place for inspection or correction.

Preview, inspect, or retry manually:

```bash
lcm project reconcile-worktrees
lcm project reconcile-worktrees /work/lcm --dry-run
lcm project reconcile-worktrees --json
```

`--dry-run` performs no merge, fencing, backup, journal, or project-map
mutation. It previews the currently discovered sources and status only. A real
run revalidates that evidence while holding the reconciliation locks and can
still block if the source state changes or a writer cannot be fenced safely.
During a real run, LCM retains the authenticated target project and events
directory chain from before the first target mutation through source archival
and project-map publication. If that chain is replaced or loses its private
owner-only mode, reconciliation blocks before the next observable mutation;
snapshot cleanup also leaves a private residual snapshot rather than removing
a pathname that may have been rebound.

If a retained target directory handle fails while closing after the journal has
been durably marked completed and the final target validation has passed, LCM
still reports the cleanup error and closes every handle, while preserving the
completed journal and its folded map and archived-source evidence. A later run
can therefore discover and enqueue newly eligible work. Cleanup failures before
that completion boundary remain blocked and retain their failure reason.

`lcm doctor` reports completed, partial, and blocked journals without retrying a
blocked reconciliation while collecting project-sensitive-pattern diagnostics.

For deleted Codex-managed worktrees, reconciliation and import use bounded
`session_meta`, exact `codex-thread.json` ownership, and the
`~/.codex/worktrees/<token>` tombstone structure. An exact repository URL is
accepted only when it identifies one locally verified project; same-remote
clones are ambiguous and skipped. This repository metadata is historical
evidence only and never becomes a PostgreSQL binding.

A real Codex import reconciles the requested/current project's verified legacy
linked-worktree identity before taking the map snapshot used to classify
sessions. This remains current-project scoped even with `--all`; identities for
foreign projects discovered in the catalogue are not reconciled implicitly.
Remote passive-event operator commands perform the same reconciliation before
checking the current project's PostgreSQL binding. A compatible legacy binding
therefore carries to the primary checkout before either path uses it, while a
conflict fails before daemon or PostgreSQL access. Separate clones with the same
remote URL remain distinct.

An empty Codex catalogue and every Codex `--dry-run` remain read-only. A dry run
previews the unreconciled map snapshot, so during a legacy split it can report a
current-project session as ambiguous even though a subsequent real import
safely reconciles and imports it. The import result's `reconciled` count still
describes session resolution through thread-owner or worktree-tombstone
evidence; it does not count project-map reconciliation.

## Configure PostgreSQL

Machine registration and remote project operations require the PostgreSQL
storage configuration described in [Configuration](configuration.md). SQLite
commands need no PostgreSQL configuration.

## Register a machine

```bash
lcm machine register
lcm machine register --name "build workstation"
lcm machine show
lcm machine show --json
```

Registration creates `~/.lcm/machine.json`. The versioned file contains an
opaque random identity key, the PostgreSQL-assigned machine UUIDv7, and the
display name. LCM never prints the identity key.

The file and all recovery backups use mode `0600`; `~/.lcm` and backup
directories use mode `0700`. Recovery streams the validated source descriptor
into an exclusive private backup, so even a large rejected file is never
buffered in memory or copied through a later path lookup. LCM rejects symlinks, non-regular files,
over-sized files, permissive modes, malformed JSON, unsupported versions,
invalid keys, invalid display names, and invalid UUIDs. Permission-repair
commands quote the complete file path and separate it from options so spaces,
shell metacharacters, and leading dashes cannot change the command.

Registration waits for exclusive remote-identity ownership, creates a private
pending identity with an exclusive write, idempotently upserts its opaque key
in PostgreSQL, and atomically finalizes the file before releasing that
ownership. Registration and recovery therefore cannot overwrite each other
from stale PostgreSQL reads, and concurrent registrations converge on one
machine UUID. If a process stops after writing the pending file, rerun `lcm
machine register`; LCM reuses the same opaque key.

## Recover after a reimage

Record the machine UUID from `lcm machine show --json` in an appropriate
recovery system. After restoring PostgreSQL but losing the local home
directory, run:

```bash
lcm machine recover <machine-uuid>
```

When `machine.json` is absent, recovery recreates it directly from the
authoritative PostgreSQL row. Existing corrupt, pending, stale, or conflicting
files are never silently replaced:

```bash
lcm machine recover <machine-uuid> --force
```

Forced recovery first writes a uniquely named, exclusive private backup under
`~/.lcm/oldmachines/` and then atomically replaces the file. If a backup name
collides, LCM selects a suffix and never replaces `machine.json` until its
previous bytes are preserved. Recovery requires the explicit machine UUID; it
does not search by hostname or display name. An unknown UUID fails without
changing the local file.

## Create and pair projects

Create a PostgreSQL project for the current directory:

```bash
lcm project create
lcm project create /work/lcm --name "LCM"
```

The name defaults to the path basename. The command creates the remote project
and first `(machine_id, normalized_path)` alias transactionally, then stores
the returned UUID in the existing local map entry.

When the selected path is a symlink for a previously unmapped directory, the
local hash and canonical path still use the resolved target. LCM also records
the absolute path entered as a local alias and uses that exact lexical spelling
for the PostgreSQL alias row. `project list`, `project show`, and exact
`project unlink` therefore continue to recognize the entered path without
allowing a later symlink replacement to redirect the stored remote identity.

Pair another machine or path to that project:

```bash
lcm machine register --name laptop
lcm project link <project-uuid> /home/me/src/lcm
```

The path must be an existing directory. An identical link is idempotent. If
the same normalized path on the same machine already belongs to another remote
project, LCM reports a collision and does not merge or redirect either project.
If the same remote project already owns that normalized path under a different
lexical path spelling, LCM also reports a collision; it does not replace the
winning spelling implicitly.

Binding a previously unbound local project preserves its local data. Rebinding
an entry that already points to a different remote UUID is blocked when that
entry has a SQLite database or passive-event sidecar:

```bash
lcm project link <new-project-uuid> /work/lcm --allow-existing-data
```

The flag acknowledges the rebind; it does not move, merge, or delete SQLite
data. Because `remoteProjectId` belongs to the whole local map entry, a rebind
atomically moves the canonical path and every alias in that entry from the
expected prior PostgreSQL project to the new UUID. Missing remote rows from a
pre-existing local alias are inserted into the new project in the same
transaction. If any path has a different owner, none of the paths are
redirected.

## Activate PostgreSQL daemon routing

Daemon and MCP project routes use PostgreSQL only when all of these boundaries
are established:

1. `storage.backend` is `postgresql`, the URL and CA file are supplied through
   the protected runtime environment, and the non-secret `migrationRole` names
   the schema owner.
2. The machine has a finalized `~/.lcm/machine.json` whose machine UUID is the
   registered PostgreSQL machine.
3. The local project-map entry contains the exact remote project UUID and the
   selected path is one of that machine's PostgreSQL aliases.
4. The backend-publication journal is terminal and publishes PostgreSQL for
   the same config and map witnesses, and the reviewed runtime grant scripts
   have been applied by the migration owner or an administrator.

The daemon verifies these facts before opening project storage and rechecks
publication admission at each bounded storage operation. An unbound or
unregistered project returns a sanitized HTTP `409` with identity guidance.
TLS, runtime, grant, publication, or selected-backend failures return a
sanitized `503`; URLs, credentials, filesystem paths, SQL causes, and stack
traces are not returned. PostgreSQL never causes a project SQLite database to
be opened as a fallback.

The store, ingest, and promote routes select project-sensitive scrubber
patterns from one preflight storage-identity snapshot. Before opening the live
backend under publication admission, they compare its complete project
identity—backend project ID, local project ID, canonical path, and remote
project ID—with that snapshot. Any drift returns the bounded `503` publication
blocked response before a backend open or repository write. A change only to
the remote project binding is rejected conservatively even when the local path
and hash remain unchanged.

Request cancellation closes the active project, and daemon shutdown aborts and
drains foreground and passive consumers before closing the shared PostgreSQL
factory. Hook capture is intentionally independent: it commits to the local
SQLite outbox first and can be retried after PostgreSQL recovers. To recover
from an outage, restore the runtime service or grants and retry the operation.
To roll back selection, publish a new authenticated backend publication whose
target is SQLite, then restart the daemon; do not edit `map.json` or
`config.json` independently.

CLI/import-export and portable transfer remain #618-owned. Stats, pool
diagnostics, status, and doctor presentation remain #619-owned; their current
limitations do not change the daemon's project identity or publication gate.

## Same-machine aliases

A local hash or a known local path target adds a local alias. If the target is
remote-bound, LCM creates the matching PostgreSQL alias too:

```bash
lcm project link <64-character-local-hash> /mnt/work/lcm
lcm project link /work/lcm /mnt/work/lcm
```

Existing paths are normalized with `realpath`. Stored aliases retain the
absolute path entered, preventing later symlink replacement from silently
redirecting project identity. A path may resolve to only one local hash.

Use these commands to inspect both layers:

```bash
lcm project list
lcm project list --json
lcm project show
lcm project show /work/lcm
lcm project show <local-hash>
lcm project show <remote-project-uuid>
```

`project list` and `project show` finish the authenticated legacy-home
migration gate before reading the map. If the managed daemon is completing a
private publication, the read preparation retries only while the authenticated
daemon identity, process birth, and health evidence continue to match. The
same bounded gate applies to `machine show`; output is emitted only after the
read succeeds, so a contention retry cannot duplicate output. A missing or
foreign owner, changed publication evidence, or failed health check remains a
fail-closed error.

Under SQLite, `list` and `show` use only the local map. Under PostgreSQL they
also read the authoritative remote projects. A missing remote project for a
stored binding fails closed and includes an explicit unlink or relink command.
Remote UUID targets are first resolved through the local map: exactly one local
entry must bind the UUID before `show` reads its authoritative PostgreSQL
project. An unknown remote UUID fails with `unknown remote project UUIDv7`; a
UUID bound by multiple local entries is rejected as ambiguous. Use
`lcm project list --json`, then show the intended local path or hash, to
diagnose either case. `show` never returns a PostgreSQL-only project that has no
local mapping.

## Unlink and relink

Remove one alias:

```bash
lcm project unlink /mnt/work/lcm
```

LCM removes the local alias and, when applicable, its remote alias. It does not
delete the local hash, SQLite database, or passive-event sidecar.
Remote unlink resolves the alias by its stored lexical `path` and deletes the
persisted `normalized_path`; it does not run `realpath` again. Unlink therefore
remains exact after a symlink alias is deleted or retargeted and cannot remove
the alias currently occupying the symlink's new target.
Alias add/remove operations on a remote-bound entry require PostgreSQL
configuration so the local and remote path sets cannot intentionally diverge.
Only aliases on an unbound entry remain purely local under SQLite.

Unlink the canonical path:

```bash
lcm project unlink /work/lcm
```

This clears the local `remoteProjectId` and removes only the remote aliases
represented by that local entry's canonical path and aliases. Other local
entries may share the same PostgreSQL project UUID; their remote aliases are
not removed. The canonical map entry, its local aliases, SQLite database, and
sidecar remain. Relink explicitly with:

```bash
lcm project link <project-uuid> /work/lcm
```

## Map format and migration

`~/.lcm/map.json` remains backward-readable. Legacy non-worktree entries need
no migration; linked-worktree entries are reconciled automatically:

```json
{
  "64-character-sha256-hash": {
    "canonical": "/work/lcm",
    "aliases": ["/mnt/work/lcm"],
    "remoteProjectId": "0190b1d2-8f40-7abc-8def-0123456789ab"
  }
}
```

`remoteProjectId` is optional and must be a UUIDv7. Reconciliation preserves
legacy databases and sidecars as backups, then uses the primary checkout hash.
To bind a migrated project, select the intended remote UUID explicitly with
`lcm project link`; leaving the field absent preserves purely local SQLite
behavior.

## Atomic reconciliation and outages

Local map writes are atomic and privately backed up under `~/.lcm/oldmaps/`.
Every mutation that replaces an existing map reserves a new private backup
exclusively. Backups use `map-<unix-seconds>.json`, then suffixes `-1` through
`-999` when the same timestamp is already occupied; concurrent writers never
reuse or overwrite a backup. If all 1,000 bounded candidates are occupied, the
mutation fails before changing `map.json` and asks the operator to move old
backups aside.
Every map mutation holds a private owner-aware exclusive lock and clears only
the expected prior UUID. Locks record the owning PID, creation time, and a
platform process-birth marker (`/proc` on Linux, `ps` on Unix-like systems,
and the Windows process creation time). LCM reclaims a lock immediately when
the owner is provably dead or the PID has been reused. If the operating system
cannot supply an exact birth marker for a live PID, ownership is ambiguous and
LCM fails closed regardless of the lock's age. Legacy lock files without a
birth marker follow the same rule. Restore process-birth inspection or stop and
verify the recorded owner before manually removing such a lock; elapsed time
alone is never proof that no mutation is active. Exact matching birth markers
remain live regardless of age. Malformed, symlinked, and non-regular locks
always fail closed. A concurrent rebind or entry removal also fails closed; it
is never overwritten by a stale unlink.

Process-birth inspection never searches `PATH` or the current directory for
system helpers. LCM invokes the platform's fixed absolute `ps` path, or
PowerShell beneath a drive-absolute Windows `SystemRoot`. Missing helpers,
unsupported platforms, and missing or relative `SystemRoot` values make a live
owner ambiguous and keep the lock in place.

Remote project create, link, and unlink operations also share a cross-domain
identity lock with machine recovery. Project operations take the project lock
first and the cross-domain lock second; recovery takes only the cross-domain
lock. This keeps one machine ID stable across each PostgreSQL mutation and its
local map commit without deadlocking local-only SQLite alias operations.
Project creation snapshots the entered lexical path and its resolved identity
after the identity locks are acquired, so a retargeted symlink cannot bind one
local project to another project's PostgreSQL path. Local link and unlink
commands reconcile legacy worktree entries before resolving their target.

Stale-lock recovery uses a private, owner-recorded reclaim lease. If its
process crashes, another process may take over only after proving that lease
owner's PID/start generation is stale. Immutable `.stale-<nonce>` tombstone
directories prevent a delayed contender from moving or deleting a successor
lease; they are harmless audit artifacts and may be removed during maintenance
only when no project-map mutation is active.
If the protected mutation succeeds but releasing its exact-owner lock encounters
a transient filesystem failure, LCM applies the same ownership-checked cleanup
and same-process recovery used for failed mutations; a committed operation
cannot strand a live lock for the rest of the daemon process.

Remote mutations use PostgreSQL transactions. Only a transport failure after
`COMMIT` triggers authoritative readback; deterministic collisions and unknown
UUIDs retain their original errors. A confirmed create or link is retained.
Otherwise LCM restores the previous map or alias state and returns an exact,
idempotent recovery command. Restoration compares the expected PostgreSQL
owner transactionally and stops for manual reconciliation if a concurrent
operation has taken ownership of the path.

Once PostgreSQL confirms a project create, that published project and its
aliases are retained if the subsequent local map binding fails. LCM does not
delete them because another LCM home may already have adopted the published
identity. Reconcile the affected local path with the exact command reported by
the error:

```bash
lcm project link -- <created-project-uuid> <entered-path>
```

Create readback also compares the alias owner with the exact candidate project
UUID produced inside the uncertain transaction. A different project claiming
the path is reported as a collision and is never adopted. Authorized rebinds
replace every path in the selected local entry from the expected prior owner in
one transaction, without an intermediate unlink. Canonical unlinks delete that
same exact path set with expected-owner checks instead of deleting every alias
for the machine/project pair. Batch rebinds and unlinks read back every path
after an uncertain commit before changing the local map, and batch restoration
is all-or-nothing when a local map write fails.
Failures before the PostgreSQL create callback begins restore any provisional
local symlink alias with an exact prior-entry comparison, so retrying does not
produce duplicate normalized paths. After PostgreSQL publishes a project, LCM
does not delete that project or its aliases to compensate for a failed local
binding; it retains the published state and reports the exact
`lcm project link -- <created-project-uuid> <entered-path>` recovery command.
Project listings use one ordered PostgreSQL snapshot so project and alias rows
cannot come from different reads.

Hooks remain successful when PostgreSQL identity or storage is unavailable.
User-prompt passive events are written to the local SQLite outbox before remote
bootstrap and remain available for later promotion.

PostgreSQL domain repositories are active for daemon and MCP project routes.
With PostgreSQL selected, the daemon starts one verified factory and the
storage-backed routes including `/compact`, `/ingest`, `/promote`, `/restore`,
`/store`, `/session-complete`, `/review-stale`, `/prompt-search`,
`/promote-events`, `/promote-events/all`, `/search`, `/grep`, `/recent`,
`/describe`, and `/expand` execute their bounded batches against the selected
project. Public `GET /health` is a storage-free liveness response; authenticated
health reports selected-backend readiness. An absent project binding, missing or
pending registration, or invalid machine identity returns sanitized `409`
identity guidance with `code: "STORAGE_IDENTITY_REQUIRED"` and
`storageBackend: "postgresql"`. Runtime, grant, publication, or operation
failures return sanitized `503` responses. Unbound-project guidance omits the
local hash and filesystem path, and machine-file guidance replaces host-local
identity paths with `<path>`.

SQLite keeps its existing best-effort behavior when SQLite is selected. The
PostgreSQL routes never open a project SQLite database or return a false empty
read result as fallback. The raw hook-facing `POST /prompt-search` endpoint
still lets the prompt hook treat optional hint failure as non-fatal, while
identity errors remain visible as admission failures. A typed surfacing-log
failure under the selected PostgreSQL backend returns a sanitized HTTP `503`;
PostgreSQL never falls back to SQLite for that failure. Setting
`restoration.promptSearchMaxResults` to `0` suppresses returned hints but does
not bypass PostgreSQL identity or storage admission. Disabled compaction and
empty ingestion still authenticate the selected backend before returning their
normal no-op result. Passive hooks write the local SQLite outbox first; the
daemon's selected-backend consumer processes it in bounded batches.

Passive-event promotion derives scrubber paths from the same retained local
project identity used for backend admission. A mismatch in `id`,
`localProjectId`, `canonical`, or `remoteProjectId` is rejected before a
project backend opens or an event is acknowledged. The route returns a
sanitized `503` publication-admission response, leaves that batch pending, and
allows a later retry to reconcile the path and storage identity. In an
all-project promotion, projects completed before the mismatch stay committed;
the scan stops without visiting later sidecars.

Request cancellation closes project storage, and daemon shutdown drains active
routes and passive consumers before closing the shared factory. Recovery means
restoring PostgreSQL service or grants and retrying. Rollback means publishing
an authenticated SQLite selection and restarting the daemon; it is not a
manual edit to `config.json` or `map.json`.

## Ambiguity and doctor

LCM reports ambiguity when canonical paths or aliases match more than one local
hash. It never chooses one entry by ordering. Inspect:

```bash
lcm project list --json
lcm doctor
```

`lcm doctor` validates `map.json`, reports invalid JSON/schema/UUIDs and
cross-entry collisions, and can normalize formatting or remove same-entry
duplicate aliases. It preserves the last valid daemon map during transient
invalid editor saves and never auto-repairs an ambiguous mapping by guessing.
