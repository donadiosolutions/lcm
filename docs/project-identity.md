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
invalid keys, and invalid UUIDs.

Registration first creates a private pending identity with an exclusive write,
then idempotently upserts its opaque key in PostgreSQL and atomically finalizes
the file. Concurrent registrations therefore converge on one machine UUID. If
a process stops after writing the pending file, rerun `lcm machine register`;
LCM reuses the same opaque key.

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

Pair another machine or path to that project:

```bash
lcm machine register --name laptop
lcm project link <project-uuid> /home/me/src/lcm
```

The path must be an existing directory. An identical link is idempotent. If
the same normalized path on the same machine already belongs to another remote
project, LCM reports a collision and does not merge or redirect either project.

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
```

Under SQLite, `list` and `show` use only the local map. Under PostgreSQL they
also read the authoritative remote projects. A missing remote project for a
stored binding fails closed and includes an explicit unlink or relink command.

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
Every map mutation holds a private owner-aware exclusive lock and clears only
the expected prior UUID. Locks record the owning PID and process-start marker;
LCM reclaims a lock only when the owner is provably dead or the PID has been
reused. Live, malformed, symlinked, non-regular, or otherwise ambiguous locks
fail closed. If an ambiguous lock remains, inspect `~/.lcm/map.json.lock` and
remove it only after confirming that no LCM project mutation is active. A
concurrent rebind or entry removal fails closed; it is never overwritten by a
stale unlink.

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
reports unavailable storage. `POST /status`, `/search`, `/grep`, `/recent`,
`/describe`, and `/expand`, plus `GET /stats` and `/stats/pool`, return fixed
`503` responses after their applicable identity checks. The hook-facing
`POST /prompt-search` endpoint remains best-effort and returns an empty hint
set during an outage so prompt hooks stay successful. The daemon does not run
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
