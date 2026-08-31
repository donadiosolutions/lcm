# LCM documentation

Start with the [project README](../README.md) for an overview and installation.
The guides below are grouped by audience so you can go directly to the level of
detail you need.

## User documentation

### Start here

- [Configuration guide](configuration.md) — install LCM, choose integrations,
  configure summarization, and select a storage backend.
- [Command-line behavior](cli.md) — navigate command help and understand how
  commands behave when the daemon is unavailable.
- [Agent tools](agent-tools.md) — search, inspect, expand, and store memory from
  an MCP-capable coding agent.

### Features and data safety

- [Passive learning](passive-learning.md) — understand automatic observation,
  promotion, recovery, and configuration.
- [Privacy and data handling](privacy.md) — see what LCM stores, what can leave
  the machine, and how secret redaction and retention work.
- [Machine registration and project identity](project-identity.md) — configure
  shared PostgreSQL identities, linked worktrees, pairing, and recovery.

### Setup and troubleshooting

- [Managed daemon recovery](daemon-restart-recovery.md) — diagnose and recover
  the user-managed daemon safely.
- [Managed daemon temporary storage](daemon-temporary-storage.md) — understand
  the stable private temporary root used by background daemons.
- [Backend publication safety](backend-publication.md) — understand secure
  `~/.lcm` establishment, publication recovery, PostgreSQL admission, and
  fail-closed operator behavior.
- [Reversible migration and cutover journal](migration-cutover.md) — understand
  checksum-sealed migration phases, immutable revisions, and exact crash recovery.
- [Optional FTS5 setup](fts5.md) — enable faster ranked local full-text search
  when the active Node.js runtime does not include FTS5.
- [VS Code and Codex setup](vscode-codex.md) — connect LCM to Codex or GitHub
  Copilot in VS Code and understand the current integration boundaries.

## Developer and maintainer documentation

These references describe internals, repository automation, and release
operations. They are not required for normal LCM use.

- [Architecture](architecture.md) — storage selection, repositories, the data
  model, compaction, context assembly, and expansion.
- [Portable record stream](portable-record-stream.md) — the versioned,
  backend-neutral record, manifest, checkpoint, and adapter compatibility
  contract.
- [Claude Code hook protocol](hook-protocol.md) — hook payloads, durability, and
  lifecycle behavior.
- [Canonical tag schema](tag-schema.md) — the tag vocabulary shared by agents
  and memory tools.
- [Automated issue triage](issue-triage.md) — classification, duplicate checks,
  rollout, and operational policy.
- [External admission recovery](external-admission.md) — recover delayed
  protected-branch admission without bypassing exact-head policy.
- [Stable and beta releases](releasing.md) — prepare versions and recover
  immutable release publication safely.

### PostgreSQL implementation references

The PostgreSQL reference suite documents staged repository contracts, schema
details, privilege scripts, and conformance workflows. Operators should begin
with the [storage-backend configuration guide](configuration.md#storage-backend).

- [Schema reference](../src/storage/postgresql/reference/postgresql-schema.md)
- [Development and conformance](../src/storage/postgresql/reference/postgresql-development.md)
- [Native transcripts](../src/storage/postgresql/reference/postgresql-native-transcripts.md)
- [Promoted memory and administration](../src/storage/postgresql/reference/postgresql-memory-administration.md)
- [Lexical search](../src/storage/postgresql/reference/postgresql-search.md)
- [Cross-machine coordination](../src/storage/postgresql/reference/postgresql-coordination.md)
- [Summaries, context, and large files](../src/storage/postgresql/reference/postgresql-summary-context.md)

Each PostgreSQL guide links to the reviewed runtime grant scripts required by
the repository it describes.
