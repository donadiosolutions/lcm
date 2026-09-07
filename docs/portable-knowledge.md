# Exporting and importing promoted knowledge

Use `lcm export` to share promoted memories and `lcm import-knowledge` to add
those memories to a project. Both commands use the backend selected by the
current LCM configuration. SQLite remains the default. PostgreSQL requires an
existing registered machine, project binding, and completed backend publication;
an unavailable or invalid PostgreSQL binding fails without creating a local
SQLite database.

```sh
lcm export --output knowledge.json
lcm export --tags decision,architecture --since 2026-01-01 --output decisions.json
lcm import-knowledge knowledge.json --dry-run
lcm import-knowledge knowledge.json
```

Export reads an existing project. Import can create a SQLite project through the
normal storage factory and creates its private discovery metadata. PostgreSQL
import always opens the already-bound project; it does not register a new remote
project. Each configured home selects one backend. There is no per-project
backend flag. Use separate configured homes and daemons for separate backends.

`lcm export --all` covers authenticated, locally known project bindings and
canonical paths. With PostgreSQL, this is the locally bound set, not every
project stored on the server. Aliases and linked worktrees resolve to their
canonical project. A missing remote binding is an error.

## Version 1 format and privacy

The JSON document retains the version 1 schema:

```json
{
  "version": 1,
  "exportedAt": "2026-09-06T12:00:00.000Z",
  "projectCwd": "/example/project",
  "entries": [
    {
      "content": "Use TypeScript for application code.",
      "tags": ["decision"],
      "confidence": 0.9,
      "createdAt": "2026-09-01T12:00:00.000Z",
      "sessionId": null
    }
  ]
}
```

Export scrubs content and tags using the configured global and project patterns.
Session IDs are exported as `null` so another project does not acquire dangling
session references. Import also scrubs content and tags before persisting them.
The document does not contain internal metadata, retry hashes, or storage
credentials. Exported knowledge is requested output and may contain project
information; choose the output destination accordingly.

## Atomic import and safe retries

An import validates the document and all entries before writing. Unsupported
versions or malformed document structure fail the command. Invalid individual
entries are skipped with their zero-based index in the result; their content and
underlying exception text are not echoed. `--dry-run` validates without opening
project storage, creating a database, or reconciling a worktree. It reports zero
imported entries and any invalid entries as skipped. `--confidence` must be a
finite number between zero and one.

All valid entries in one document are imported in one transaction. An unexpected
storage or scrubbing error before commit aborts the entire document, including
entries processed earlier in the transaction. A connection failure around commit
or a cleanup failure after commit can leave the caller uncertain whether the
whole document committed. Correct the failure and retry the same document from
the start: persisted retry identities distinguish committed work from rolled-back
work. This command does not resume from a partially committed prefix.

Each accepted source entry has a SHA-256 retry identity derived from the format
version, source project, position in the document, and original entry fields
before scrubbing. The identity is saved with the memory in the same transaction.
Repeating that document skips already accepted entries, including after sensitive
patterns change. The retry does not rewrite previously accepted content with new
scrub rules. Editing an entry, moving it to a different position, or changing the
source project makes a different import identity and invokes normal content
deduplication. Duplicate collapse retains retry identities and existing metadata;
canonical metadata values win conflicting keys.

Successful commands exit zero. Operational failures, including failed projects
in `export --all`, exit one. JSON output contains the requested payload; progress
and warnings go to stderr. A failed export does not emit a partial JSON document
or replace an existing output file before the complete result is available.

## Other transfer surfaces

Native conversation/session import (`lcm import`) ingests supported client
transcripts. It is separate from promoted-knowledge import.

Canonical full-backend transfer uses the separately versioned portable record
stream and its manifest/checkpoint contract. It includes storage domains that
are absent from knowledge version 1. It is a reusable internal/library transfer
surface, not a replacement for `lcm export` or a CLI cutover command. Knowledge
export/import does not perform database migration, publication, fencing, cutover,
or rollback orchestration.

`lcm import-knowledge --dry-run` reports valid entries separately from entries
skipped during document validation. It performs no storage writes and does not
claim that invalid entries would be imported.
