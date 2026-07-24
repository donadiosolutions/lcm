# Machine registration and project identity

LCM keeps SQLite as the zero-configuration storage backend. A local project is
still identified by the SHA-256 hash of its normalized canonical path, and its
database and passive-learning sidecar remain under:

```text
~/.lcm/projects/<local-hash>/db.sqlite
~/.lcm/events/<local-hash>.db
```

PostgreSQL adds an explicit identity layer. A registered machine has a UUIDv7,
and a local project may be bound to a PostgreSQL project UUIDv7. The binding
lets two machines—or two unrelated paths—address the same remote project
without changing either local hash. LCM never infers identity from a Git
remote, repository name, directory contents, or matching display names.

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
directories use mode `0700`. LCM rejects symlinks, non-regular files,
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

`~/.lcm/map.json` remains backward-readable. Legacy entries need no migration:

```json
{
  "64-character-sha256-hash": {
    "canonical": "/work/lcm",
    "aliases": ["/mnt/work/lcm"],
    "remoteProjectId": "0190b1d2-8f40-7abc-8def-0123456789ab"
  }
}
```

`remoteProjectId` is optional and must be a UUIDv7. Existing hashes, canonical
paths, aliases, SQLite databases, sidecars, backups, and daemon reload behavior
are unchanged. To bind a migrated project, select the intended remote UUID
explicitly with `lcm project link`; leaving the field absent preserves purely
local SQLite behavior.

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

Remote project create, link, and unlink operations also share a cross-domain
identity lock with machine recovery. Project operations take the project lock
first and the cross-domain lock second; recovery takes only the cross-domain
lock. This keeps one machine ID stable across each PostgreSQL mutation and its
local map commit without deadlocking local-only SQLite alias operations.

Stale-lock recovery uses a private, owner-recorded reclaim lease. If its
process crashes, another process may take over only after proving that lease
owner's PID/start generation is stale. Immutable `.stale-<nonce>` tombstone
directories prevent a delayed contender from moving or deleting a successor
lease; they are harmless audit artifacts and may be removed during maintenance
only when no project-map mutation is active.

Remote mutations use PostgreSQL transactions. Only a transport failure after
`COMMIT` triggers authoritative readback; deterministic collisions and unknown
UUIDs retain their original errors. A confirmed create or link is retained.
Otherwise LCM restores the previous map or alias state and returns an exact,
idempotent recovery command. Restoration compares the expected PostgreSQL
owner transactionally and stops for manual reconciliation if a concurrent
operation has taken ownership of the path.

Create readback also compares the alias owner with the exact candidate project
UUID produced inside the uncertain transaction. A different project claiming
the path is reported as a collision and is never adopted. Authorized rebinds
replace every path in the selected local entry from the expected prior owner in
one transaction, without an intermediate unlink. Canonical unlinks delete that
same exact path set with expected-owner checks instead of deleting every alias
for the machine/project pair. Batch rebinds and unlinks read back every path
after an uncertain commit before changing the local map, and batch restoration
is all-or-nothing when a local map write fails.
Created-project compensation removes the complete exact alias set created for
the local entry (its canonical path and every alias) before deleting the
project if it remains unreferenced. Project listings use one ordered
PostgreSQL snapshot so project and alias rows cannot come from different reads.

Hooks remain successful when PostgreSQL identity or storage is unavailable.
User-prompt passive events are written to the local SQLite outbox before remote
bootstrap and remain available for later promotion.

PostgreSQL domain repositories are still staged. With PostgreSQL selected, the
daemon starts so identity validation remains reachable, but `GET /health`
reports unavailable storage. After applicable request and identity validation,
storage-backed routes including `/compact`, `/ingest`, `/promote`, `/restore`,
`/store`, `/session-complete`, `/review-stale`, `/prompt-search`,
`/promote-events`, `/promote-events/all`, `/search`, `/grep`, `/recent`,
`/describe`, and `/expand`, plus fixed `/status`, `/stats`, and `/stats/pool`,
return sanitized `503` responses. Before those project routes reach the staged
backend, an absent project binding, missing or pending registration, or invalid
machine identity returns `409` with
`code: "STORAGE_IDENTITY_REQUIRED"` and `storageBackend: "postgresql"`.
Unbound-project guidance intentionally omits the local hash and filesystem
path. Run the suggested `lcm project create` or
`lcm project link <project-id>` command from the affected project directory.
SQLite keeps its existing best-effort empty-result behavior. Every fixed staged
route response includes the stable machine-readable code
`STORAGE_BACKEND_STAGED` and `storageBackend: "postgresql"`; clients must not
authenticate or branch on the human-readable error text. The raw hook-facing
`POST /prompt-search` endpoint reports that same `503`; the prompt hook/client
layer treats the response as an unavailable optional hint source and still
exits successfully with the learning instruction. Passive events are already
durable in the local SQLite outbox before that request. The daemon does not run
SQLite transcript scans or passive-outbox sweeps. Other project operations fail
at a cause-free unavailable-backend boundary after validating machine
registration and the explicit project binding. LCM does not fall back to
SQLite, return false empty results from manual read routes, or advertise
PostgreSQL data capabilities during this staged state.

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
