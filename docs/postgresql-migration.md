# Reversible SQLite/PostgreSQL data migration

LCM can inventory every data-bearing local project, rehearse a SQLite-to-PostgreSQL migration, copy it in resumable fenced batches, verify it, and later roll it back without deleting the original SQLite source. The migration is installation-wide because `storage.backend` is global.

This feature does not provide continuous dual writes, automatic conflict merging, in-place source conversion, or source cleanup. Configuration, project-map, and filesystem publication spans multiple files and is therefore **crash-recoverable, not atomic**. A checksummed journal records prepare, commit, recovery, and completed phases; after an interruption, rerun the same command with the same generation ID.

## Prerequisites

Before the maintenance window:

1. Upgrade all machines that can write the installation and back up `~/.lcm`.
2. Provision the exact packaged PostgreSQL 18 schema with `lcm postgres migrate` as the migration owner.
3. Register this machine and explicitly bind every data-bearing local project to its remote UUID. The remote project identity key and aliases must match the local project map.
4. Apply the reviewed grants in [`postgresql-data-migration-grants.sql`](postgresql-data-migration-grants.sql) to a dedicated data-migration role. Put its URL and CA path only in `LCM_POSTGRES_URL` and `LCM_POSTGRES_CA_FILE`; do not store credentials in `config.json` or migration artifacts.
5. Confirm that each target remote project has zero domain, transcript, ingest-checkpoint, passive-inbox, or coordination rows. Other projects and shared machine identities may remain.
6. Drain or explicitly resolve local outbox pending, claimed, retry, replicated, and quarantined entries. Migration reuses the #91 delivery state; it does not create another queue.
7. Configure and test independent PostgreSQL backups and point-in-time recovery. LCM's retained SQLite files are a reversible application cutover mechanism, not a substitute for server PITR.

Activation additionally requires the live non-staged PostgreSQL storage factory supplied by #224. Until that factory is behaviorally available, `migration activate` reports an exact blocker and leaves configuration and the project map unchanged.

## Rehearsal and plan

Create an installation-wide generation:

```bash
lcm migration plan --json
```

The plan holds the project-map reconciliation lock while it inventories project databases and event sidecars. Unmapped artifacts, missing remote UUIDs, or alias collisions fail closed. The generation root is mode `0700`; manifests, checkpoints, reports, journals, retained files, and sidecars are mode `0600`, no-follow, single-link artifacts.

Run the required destination-read-only rehearsal:

```bash
lcm migration dry-run GENERATION_ID --json
```

Dry-run does not write PostgreSQL. For every existing SQLite source, it opens a read-only handle and uses Node's online backup API only into a new path inside that generation's private directory. The tool compares the main database and WAL fingerprints before and after backup; concurrent-writer drift fails the rehearsal. Legacy SQLite migrations run only against the private copy. Integrity, foreign keys, schema fingerprints, canonical row counts/digests, aliases, the PostgreSQL `0001`-`0005` ledger, and local delivery state are checked.

The generated `manifest.json`, `checkpoint.json`, and `report.json` are versioned. Treat them as private operational evidence. Do not hand-edit them. `--json` keeps stdout machine-pure; sanitized progress is written to stderr.

## Maintenance-window apply and resume

Stop the LCM daemon and prevent hooks or other machines from writing this installation. Then apply the exact dry-run generation:

```bash
lcm migration apply GENERATION_ID --confirm GENERATION_ID --json
```

Before the first remote write, LCM rechecks the exact source main/WAL identity and retains byte-identical private archives. Each table is copied in dependency order with original stable IDs and timestamps. Every batch and the #90 fencing-token validation execute in one PostgreSQL transaction. A local checkpoint advances only after commit and authoritative destination readback. Stable-ID reruns compare complete rows; divergent collisions fail rather than being hidden by `DO NOTHING`.

If the process is interrupted after a checkpoint, keep writers stopped and resume:

```bash
lcm migration resume GENERATION_ID --confirm GENERATION_ID --json
```

Resume accepts only the same generation, schema/manifest checksum, project identities, source fingerprints, and durable checkpoints. After an uncertain commit outcome, it reads the authoritative destination and advances only if every row is exactly equal. Shared sequences advance monotonically to at least the greatest existing or imported value; they are never reset to one project's maximum.

## Verification and activation

Verification recomputes canonical counts and row digests, FK/DAG/transcript coverage, deterministic samples, schema history, aliases, and source preservation:

```bash
lcm migration verify GENERATION_ID --json
lcm migration report GENERATION_ID --json
```

Keep the daemon stopped for activation:

```bash
lcm migration activate GENERATION_ID --confirm GENERATION_ID --json
```

Activation is all-or-nothing at the global-backend decision. Every current project-map entry with stored local data must still be represented by a terminal verified project in the generation. Local hashes, canonical paths, aliases, remote bindings, source fingerprints, schema/manifest checksums, delivery state, and quiescence must still match. A live PostgreSQL factory must report `healthy` and successfully find every bound project. The candidate factory is always closed in a `finally` path.

Publication writes a prepare journal, enters commit/recovery, revalidates and folds each project-map entry back into its **original canonical local hash**, then changes `storage.backend`. A stale/manual binding is insufficient. If any blocker exists, no map or configuration mutation occurs.

After activation, run #225's production gate, monitoring, failover, and PITR drills. Retain the entire migration generation and the canonical preserved SQLite copies for the rollback window.

## Rollback

### Before any PostgreSQL data write

When no batch checkpoint has remote rows, rollback selects the untouched SQLite source and completes only generation-owned journal state:

```bash
lcm migration rollback GENERATION_ID --confirm GENERATION_ID --json
```

The global backend must still be SQLite. Existing project identities and bindings are not forked, and the source is not rewritten.

### After PostgreSQL writes and activation

Stop all writers. Post-write rollback reads every project in the globally active set, stages a **new** SQLite database for each one, runs integrity/FK and canonical digest verification, checkpoints and closes it, and only then begins publication. PostgreSQL-only transcript, passive-inbox, and ingest-checkpoint evidence is retained in private checksummed sidecars.

During publication the journal preserves the prior canonical main/WAL under generation-qualified names, copies the verified staged database through an exclusive no-follow incoming path, and publishes it under the existing canonical local project hash. The global backend changes to SQLite only after every project is published. A crash may leave some project files published while the backend remains PostgreSQL; rerunning rollback reads the recovery journal and completes idempotently. It never switches the backend for a subset.

Never delete the original SQLite main/WAL, generation directory, journal, or server backups until the rollback window and #225 evidence requirements are complete. Cleanup is deliberately manual and outside this command.

## Recovery limits

- Source drift, unknown/legacy outbox schema, checksum mismatch, unsafe artifact permissions, hard links, symlinks, active daemon, held/expired fence mismatch, destination divergence, transcript/DAG gaps, sequence regression, or factory unavailability fail closed.
- LCM does not repair a divergent destination automatically. Restore it from the rehearsed PostgreSQL backup or create a fresh empty target generation.
- Do not copy a generation between installations and do not edit its JSON. Absolute source paths and file identities are revalidated locally.
- Preserve stderr and the private report for diagnosis, but do not publish artifact payloads or credential-bearing environment variables.
