# Project path aliases

LCM stores project data under `~/.lcm/projects/<hash>` and passive-learning sidecars under `~/.lcm/events/<hash>.db`. The hash is normally derived from the canonical project path. `~/.lcm/map.json` lets LCM route additional paths to that same canonical project hash.

This is useful when the same repository is reached through multiple mount points, bind mounts, worktree aliases, or stable convenience paths.

## File format

`map.json` is owned by LCM and is written as pretty-printed JSON with two-space indentation and a trailing newline:

```json
{
  "64-character-sha256-hash": {
    "canonical": "/real/project/path",
    "aliases": [
      "/alternate/project/path"
    ]
  }
}
```

`canonical` is the path LCM uses for metadata. Edit `aliases` for manual path mapping. LCM may rewrite `canonical` when it creates a new project entry from a real project path.

Paths are normalized before matching:

- existing paths use `realpath`, so symlinked paths resolve to their real filesystem location
- missing paths use absolute `resolve`, so aliases can be reserved before the path exists

## CLI

Use `lcm map` to inspect and edit aliases:

```bash
lcm map list
lcm map list --json
lcm map show
lcm map show /path/or/64-character-hash
lcm map add /alias/path
lcm map add /alias/path --canonical /canonical/project/path
lcm map add /alias/path --hash 64-character-sha256-hash
lcm map remove /alias/path
```

`lcm map add` defaults to the current project. `--canonical` and `--hash` are mutually exclusive. Canonical targets must exist; aliases may be missing, but the command prints a warning when an alias path is not present yet.

LCM refuses to add an alias that already exists under the target hash or that would make a path resolve to more than one hash.

If the alias path was already seen before and only has an empty canonical map entry, `lcm map add` converts that entry into an alias for the target project. If the old alias project already has a `db.sqlite`, LCM refuses the conversion so existing project data is not hidden or stranded by a silent remap.

## Manual edits and daemon reloads

You can edit `~/.lcm/map.json` by hand. The daemon watches the file and reloads valid changes without restart. If an editor briefly saves invalid JSON, the daemon keeps the last valid in-memory map and tries again on the next file change.

When the daemon sees valid JSON that is not in LCM's canonical formatting, it rewrites the file in pretty-printed form without changing the parsed content.

Strict commands such as `lcm doctor` still report invalid JSON or schema errors. Invalid map files are not auto-repaired because LCM cannot safely infer the intended content.

## Backups

Before LCM writes over an existing map, it copies the previous file to:

```text
~/.lcm/oldmaps/map-<unix-epoch-seconds>.json
```

Backups use second-level timestamps. If a backup already exists for the current second, LCM keeps the existing backup and proceeds with the write.

## Doctor checks

`lcm doctor` validates `map.json`.

It reports failures for:

- invalid JSON
- invalid schema
- any path that maps to multiple hashes, including collisions between canonical paths and aliases

It auto-fixes:

- valid JSON that is not pretty-printed
- duplicate aliases within the same hash
- aliases that equal the same hash's canonical path

When doctor writes a fix, it reports `fixApplied: true` and includes the backup path in the check message.
