/**
 * Materializes runtime sidecar surfaces from a built rollback generation's
 * portable archive, for item #626, per plan-v2 section 4: "the transfer
 * writes eight domains into portable_archive_* tables inside the
 * destination file, but the runtime reads passive events from
 * `<lcmHome>/events/<projectId>.db` ... and session instructions from
 * session_instruction_cache inside the main database. Materialization
 * produces both runtime surfaces and verifies each against the archive
 * it came from and against validateSqliteSidecarSchema."
 *
 * SCOPE NOTE. runPortableTransfer already writes the OTHER 14 domains
 * (conversations, messages, promoted memories, ...) directly into their
 * live runtime tables as part of the ordinary transfer, via
 * writePortableRuntimeRecord (sqlite/portable-destination.ts's
 * applyPortableBatchInTransaction branches on PORTABLE_ARCHIVE_DOMAINS.
 * includes(domain) and calls writePortableRuntimeRecord for everything
 * NOT in that set). Those need no further work. This module handles only
 * the two archive-only domains plan-v2 names by name --
 * "session-instructions" and "passive-events" -- plus the machine-wide
 * sequence reconciliation passive-events requires. The other six
 * archive-only domains (machines, project, project-aliases, and the
 * three native-transcript domains) are consumed here only as lookup
 * data (machines, to resolve machineIdentityKey -> machine_id), never
 * materialized into a runtime surface of their own by this module.
 *
 * MATERIALIZATION REPRODUCES HISTORY; IT NEVER MINTS IT. Every archived
 * passive event is written back with its ORIGINAL event_uuid,
 * machine_sequence, and disposition-derived state -- never through
 * hooks/events-db.ts's `insertEvent`, which mints a fresh event_uuid
 * and allocates a NEW machine sequence for live, first-time event
 * creation. A future maintainer "simplifying" this to reuse insertEvent
 * would silently replace every event's original identity and ordering
 * with newly-minted ones, which is the opposite of what a rollback's
 * evidence must do.
 *
 * WHY project_id IS AN EXPLICIT, SEPARATE PARAMETER. session_instruction_
 * cache.project_id is the LOCAL project id (StorageIdentityContext.
 * localProjectId, confirmed against storage/sqlite/repositories.ts's
 * live read/write path), which is a genuinely different identity from
 * this module's BuildRollbackGenerationInput.projectIdentity (the
 * portable, possibly shared-scope identity used for the PostgreSQL-era
 * transfer). A project that has had a PostgreSQL era has both, and they
 * are not interchangeable. Deriving one from the other here would be
 * exactly the kind of plausible-but-wrong inference this Epic has
 * produced repeatedly; the caller (rollback.ts) already knows the local
 * project id independently and supplies it directly.
 *
 * THE SQLITE SURFACES ARE MACHINE-LOCAL; THE ARCHIVE IS NOT. A PostgreSQL
 * era archive holds every participating machine's rows, each keyed by
 * machineIdentityKey, while both runtime surfaces belong to one machine
 * by schema: session_instruction_cache has PRIMARY KEY (project_id,
 * scope_hash) with no machine column, and the events table's
 * machine_sequence is UNIQUE across the file and is drawn from this
 * machine's own sequence file. Two machines can hold a session
 * instruction under one scope hash and can each have issued the same
 * machine sequence, so materializing the whole archive either collides
 * (the second upsert overwrites the first, and verification reports
 * `holds 1 rows ... materialization reported 2`) or imports another
 * machine's events as if this one had written them. This module
 * therefore materializes, counts, verifies and reconciles ONLY the rows
 * whose machineIdentityKey resolves, through the archive's machines
 * domain, to the explicit `machineId` the caller supplies (the A12
 * roster's machine, which rollback already requires to equal this
 * machine's identity). Other machines' rows are not lost: they stay in
 * PostgreSQL and in the preserved source.
 *
 * THE LIVE LOCAL OUTBOX MAY HOLD MORE THAN THE ARCHIVE. Appends made after the
 * cutoff are in the events table but not in the archive. Archived rows are
 * imported and verified exactly; rows absent from the archive are preserved
 * untouched when they are still local appends (no remote_inbox_id and no
 * acknowledged_at, the events table's own delivery markers) and refuse when
 * they claim delivery. The two sets are counted separately; see
 * verifyPassiveEventsAgainstArchive.
 *
 * THE MACHINE-WIDE SEQUENCE FILE is reconciled via
 * local-hook-event-sequence.ts's own `reconcileCheckpoint` (added in
 * its own commit specifically for this), never written directly -- see
 * that file's doc comment for why a second module must not learn its
 * own path to the same shared file.
 *
 * WHY validateSqliteSidecarSchema APPLIES TO ONLY ONE OF THE TWO
 * SURFACES, VERIFIED RATHER THAN ASSUMED. Plan-v2's original text (above)
 * asked for both runtime surfaces to be checked against
 * validateSqliteSidecarSchema. That is buildable for passive events,
 * because the fresh per-project `events.db` this module creates is a
 * genuinely isolated file containing exactly the four tables that check
 * expects (events, error_log, missing_cwd_state, schema_version) -- the
 * same physical shape as the source side's captured sidecar files
 * (portable-source.ts:429, openCapturedSqliteDatabase on a standalone
 * per-machine file). It is NOT buildable for session instructions:
 * session_instruction_cache lives as one table inside the same
 * multi-table generation database as everything else (db/migration.ts:63
 * -- no ATTACH, no separate file), and validateSqliteSidecarSchema's
 * table-set check (portable-sidecars.ts:213-224) requires its connection
 * to contain EXACTLY the tables for that domain and nothing else. Proved
 * empirically rather than argued: .superpowers/626/impl/
 * probe-sidecar-check.mjs builds an in-memory db shaped like a real
 * generation (session_instruction_cache plus ordinary sibling tables)
 * and runs the check's own table-set query against it; it always throws
 * "unsupported-capability". Calling it on the real generation database
 * would therefore throw on every materialization, including every
 * correct one -- the same always-same-answer shape this Epic keeps
 * finding, just from the other direction: a check that can never
 * succeed rather than one that can never fail. A tempting third option
 * -- build a throwaway single-table copy of session_instruction_cache
 * purely so the check has something it can pass -- was considered and
 * rejected: it would prove something about an artifact that is not the
 * one that matters, while the rows that actually end up in the
 * generation database would still be covered only by the archive
 * comparison below. A check that passes about the wrong object is worse
 * than no check, because it reads as though the real surface had been
 * schema-verified when it had not. Session instructions are instead
 * verified against their archive directly: independent readback,
 * compared field-by-field against a fresh re-scan of the archive domain,
 * exactly as plan-v2's "verifies each against the archive it came from"
 * clause already requires regardless of the schema-check question.
 * Plan-v2 is being amended to remove the session-instructions half of
 * that sentence; this module is the corrected version.
 */

import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { ensurePrivateDirectory } from "../security-files.js";
import { eventsDir, eventSequenceDbPath } from "../db/events-path.js";
import { EventsDb } from "../hooks/events-db.js";
import {
  LocalHookEventSequenceAllocator,
  formatLocalHookMachineSequence,
} from "../storage/local-hook-event-sequence.js";
import { readArchiveDomain } from "../storage/sqlite/portable-archive.js";
import { validateSqliteSidecarSchema } from "../storage/sqlite/portable-sidecars.js";

export type RollbackSidecarErrorReason = "invalid-input" | "unsafe-storage" | "verification-failed";

export class RollbackSidecarError extends Error {
  constructor(readonly reason: RollbackSidecarErrorReason, message: string = reason, options?: ErrorOptions) {
    super(message, options);
    this.name = "RollbackSidecarError";
  }
}

export interface MaterializeRollbackSidecarsInput {
  readonly homeDir: string;
  /** The verified generation's database path (BuildRollbackGenerationOutcome's, state "verified"). Not yet installed at the canonical path. */
  readonly databasePath: string;
  /** StorageIdentityContext.localProjectId for the project being rolled back -- see the module doc comment on why this is explicit. */
  readonly localProjectId: string;
  /**
   * This machine's machine_id (the A12 roster's machine, equal to the
   * machine identity rollback requires). Only archive rows whose
   * machineIdentityKey maps to it are materialized; see the module doc.
   */
  readonly machineId: string;
}

export interface MaterializeRollbackSidecarsOutcome {
  readonly sessionInstructionsMaterialized: number;
  readonly passiveEventsMaterialized: number;
  /**
   * Rows already in the live local outbox that the archive does not hold and that are legitimately pending local
   * appends (see {@link verifyPassiveEventsAgainstArchive}). They were left untouched and keep replicating later.
   */
  readonly passiveEventsPreservedPending: number;
  readonly eventsDbPath: string;
  /** The highest archived machine_sequence observed, or null when no passive events existed. reconcileCheckpoint was called with this value when non-null. */
  readonly reconciledUpTo: string | null;
}

/** @internal Exported for direct unit testing only; not part of the module's public surface. */
export function requireInteger(value: bigint | number | string, field: string): bigint {
  try {
    return BigInt(value as bigint | number | string);
  } catch {
    throw new RollbackSidecarError("invalid-input", `archived ${field} is not a valid integer`);
  }
}

/**
 * @internal Exported for direct unit testing only; not part of the
 * module's public surface. Accepts Date because archived timestamp
 * fields are typed PortableRawTimestamp = Date | string throughout
 * portable-record.ts; today's concrete decode() always normalizes TEXT
 * columns to a string before this module ever sees them, but the type
 * itself is real, not merely wider than any possible caller.
 */
export function requireTimestamp(value: Date | string, field: string): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value.length > 0) return value;
  throw new RollbackSidecarError("invalid-input", `archived ${field} is not a valid timestamp`);
}

type SessionInstructionReadbackRow = Readonly<{
  scope_hash: string;
  client_name: string | null;
  session_id: string | null;
  worktree_path: string | null;
  cwd_path: string | null;
  content: string;
  content_hash: string;
  updated_at: string;
}>;

function isLocalMachineRow(
  machineIds: ReadonlyMap<string, string | null>,
  machineIdentityKey: string,
  machineId: string,
): boolean {
  // An unknown key is an archive inconsistency, not another machine's row: refuse like passive events do.
  if (!machineIds.has(machineIdentityKey)) {
    throw new RollbackSidecarError("invalid-input", `session instruction references unknown machine identity key ${machineIdentityKey}`);
  }
  return machineIds.get(machineIdentityKey) === machineId;
}

function materializeSessionInstructions(db: DatabaseSync, localProjectId: string, machineId: string): number {
  const machineIds = readMachineIdByIdentityKey(db);
  const insert = db.prepare(`INSERT INTO session_instruction_cache
    (project_id, scope_hash, client_name, session_id, worktree_path, cwd_path, content, content_hash, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(project_id, scope_hash) DO UPDATE SET
      client_name = excluded.client_name, session_id = excluded.session_id,
      worktree_path = excluded.worktree_path, cwd_path = excluded.cwd_path,
      content = excluded.content, content_hash = excluded.content_hash,
      updated_at = excluded.updated_at`);
  let count = 0;
  for (const row of readArchiveDomain(db, "session-instructions")) {
    const v = row.value;
    if (!isLocalMachineRow(machineIds, v.machineIdentityKey, machineId)) continue;
    insert.run(
      localProjectId, v.scopeHash, v.clientName, v.sessionId,
      v.worktreePath, v.cwdPath, v.content, v.contentHash,
      requireTimestamp(v.updatedAt, "session-instructions.updatedAt"),
    );
    count++;
  }
  return count;
}

/**
 * Independently verifies the materialized session_instruction_cache rows
 * for this project against a FRESH re-scan of the archive domain they
 * were built from -- never against the loop variables the insert above
 * already used. See the module doc comment for why
 * validateSqliteSidecarSchema cannot stand in for this on this surface.
 */
/** @internal Exported for direct unit testing only; not part of the module's public surface. */
export function verifySessionInstructionsAgainstArchive(
  db: DatabaseSync,
  localProjectId: string,
  materializedCount: number,
  machineId: string,
): void {
  const machineIds = readMachineIdByIdentityKey(db);
  const readback = db.prepare(
    `SELECT scope_hash, client_name, session_id, worktree_path, cwd_path, content, content_hash, updated_at
     FROM session_instruction_cache WHERE project_id = ?`,
  ).all(localProjectId) as SessionInstructionReadbackRow[];
  if (readback.length !== materializedCount) {
    throw new RollbackSidecarError(
      "verification-failed",
      `session_instruction_cache holds ${readback.length} rows for this project but materialization reported ${materializedCount}`,
    );
  }
  const byScopeHash = new Map(readback.map(row => [row.scope_hash, row]));
  let archiveCount = 0;
  for (const row of readArchiveDomain(db, "session-instructions")) {
    const v = row.value;
    if (!isLocalMachineRow(machineIds, v.machineIdentityKey, machineId)) continue;
    archiveCount++;
    const stored = byScopeHash.get(v.scopeHash);
    const expectedUpdatedAt = requireTimestamp(v.updatedAt, "session-instructions.updatedAt");
    if (
      !stored
      || stored.client_name !== v.clientName
      || stored.session_id !== v.sessionId
      || stored.worktree_path !== v.worktreePath
      || stored.cwd_path !== v.cwdPath
      || stored.content !== v.content
      || stored.content_hash !== v.contentHash
      || stored.updated_at !== expectedUpdatedAt
    ) {
      throw new RollbackSidecarError(
        "verification-failed",
        `materialized session instruction for scope ${v.scopeHash} diverges from its archive row`,
      );
    }
  }
  if (archiveCount !== materializedCount) {
    throw new RollbackSidecarError(
      "verification-failed",
      `archive holds ${archiveCount} session-instructions rows for this machine but ${materializedCount} were materialized`,
    );
  }
}

/** @internal Exported for direct unit testing only; not part of the module's public surface. */
export function readMachineIdByIdentityKey(db: DatabaseSync): ReadonlyMap<string, string | null> {
  const map = new Map<string, string | null>();
  for (const row of readArchiveDomain(db, "machines")) {
    map.set(row.value.identityKey, row.value.machineId);
  }
  return map;
}

/**
 * Maps the archive's three-valued disposition onto the events table's
 * richer delivery_state machinery, satisfying every CHECK constraint
 * without claiming operational state the archive never captured (remote
 * replication attempts, claim ownership, a quarantine's original reason).
 * "applied" sets processed_at (which alone satisfies the runtime's own
 * "applied" predicate: processed_at IS NOT NULL OR delivery_state=
 * 'acknowledged') rather than delivery_state='acknowledged', because
 * 'acknowledged' requires a remote_inbox_id this module has none of.
 */
/** @internal Exported for direct unit testing only; not part of the module's public surface. */
export function dispositionColumns(disposition: "pending" | "applied" | "quarantined", createdAt: string): Readonly<{
  deliveryState: string;
  processedAt: string | null;
  quarantineReason: string | null;
}> {
  if (disposition === "applied") return { deliveryState: "pending", processedAt: createdAt, quarantineReason: null };
  if (disposition === "quarantined") return { deliveryState: "quarantined", processedAt: null, quarantineReason: "materialized from rollback archive; original quarantine reason was not preserved" };
  return { deliveryState: "pending", processedAt: null, quarantineReason: null };
}

function materializePassiveEvents(
  db: DatabaseSync,
  eventsDb: DatabaseSync,
  machineIds: ReadonlyMap<string, string | null>,
  localMachineId: string,
): Readonly<{ count: number; highestSequence: bigint | null }> {
  const insert = eventsDb.prepare(`INSERT INTO events
    (event_uuid, event_version, machine_id, machine_sequence, session_id, seq,
     type, category, data, priority, source_hook, created_at,
     delivery_state, delivery_generation, delivery_attempts,
     delivery_next_attempt_at, delivery_updated_at, processed_at, quarantine_reason)
    VALUES (?,?,?,?,?,?, ?,?,?,?,?,?, ?,0,0,?,?,?,?)
    ON CONFLICT(event_uuid) DO NOTHING`);
  // E2: the replication worker acknowledges a local row (delivery_state, remote_inbox_id, acknowledged_at) without
  // ever setting processed_at, and the SQLite consumer this rollback hands the project to selects on processed_at
  // alone (EventsDb.getUnprocessed). An archive-applied event whose existing row is acknowledged but unmarked would
  // be applied a second time, so its marker is set to exactly what a fresh applied insert encodes; the row's
  // identity, acknowledgement and remote inbox id are kept. Any other existing shape is left for the verifier.
  const markApplied = eventsDb.prepare(
    "UPDATE events SET processed_at = ? WHERE event_uuid = ? AND processed_at IS NULL AND delivery_state = 'acknowledged'",
  );
  let count = 0;
  let highestSequence: bigint | null = null;
  for (const row of readArchiveDomain(db, "passive-events")) {
    const v = row.value;
    if (!machineIds.has(v.machineIdentityKey)) {
      throw new RollbackSidecarError("invalid-input", `passive event references unknown machine identity key ${v.machineIdentityKey}`);
    }
    const machineId = machineIds.get(v.machineIdentityKey)!;
    if (machineId !== localMachineId) continue;
    const sequence = requireInteger(v.machineSequence, "passive-events.machineSequence");
    const createdAt = requireTimestamp(v.createdAt, "passive-events.createdAt");
    const columns = dispositionColumns(v.disposition, createdAt);
    const changes = insert.run(
      v.eventId, requireInteger(v.eventVersion, "passive-events.eventVersion"), machineId,
      formatLocalHookMachineSequence(sequence), v.sessionId, requireInteger(v.sessionSequence, "passive-events.sessionSequence"),
      v.eventType, v.category, v.data, requireInteger(v.priority, "passive-events.priority"),
      v.sourceHook, createdAt,
      columns.deliveryState, createdAt, createdAt, columns.processedAt, columns.quarantineReason,
    ).changes;
    if (changes > 0) count++;
    else if (columns.processedAt !== null) markApplied.run(columns.processedAt, v.eventId);
    if (highestSequence === null || sequence > highestSequence) highestSequence = sequence;
  }
  return { count, highestSequence };
}

const SQLITE_OR_PORTABLE_TIMESTAMP = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z?$/;

/** Rewrites SQLite `datetime('now')` text or portable timestamp text to `YYYY-MM-DDTHH:MM:SS.ffffffZ`, else null. */
function canonicalTimestamp(text: string): string | null {
  const match = SQLITE_OR_PORTABLE_TIMESTAMP.exec(text);
  return match === null ? null : `${match[1]}T${match[2]}.${(match[3] ?? "").padEnd(6, "0")}Z`;
}

type PassiveEventReadbackRow = Readonly<{
  event_version: number;
  machine_id: string | null;
  machine_sequence: string;
  session_id: string;
  seq: number;
  type: string;
  category: string;
  data: string;
  priority: number;
  source_hook: string;
  created_at: string;
  disposition: "applied" | "pending" | "quarantined";
}>;

/**
 * Independently verifies every archived passive event actually reached
 * the runtime events table intact: a fresh re-scan of the archive domain
 * (never the insertion loop's own variables) compared against a fresh
 * per-row SELECT. Idempotent retries are compatible with this: ON CONFLICT
 * DO NOTHING means a retry's insert count under-reports already-materialized
 * rows, but every archived row must still be present with matching
 * content for this to pass, which is the invariant that actually matters.
 *
 * An archived event is matched by its canonical identity and content and by its portable disposition (applied,
 * pending or quarantined), classified exactly as the portable encoders do (sqlite/portable-sidecars.ts and
 * postgresql/portable-mapping.ts): applied when processed_at is set or delivery_state is 'acknowledged',
 * quarantined when delivery_state is 'quarantined', else pending. The row a fresh insert writes and a row the
 * replication worker has since acknowledged are both applied, so an existing acknowledged row keeps its
 * remote_inbox_id and acknowledgement and is not rewritten; materializePassiveEvents gives it the processing
 * marker a fresh applied insert carries so the SQLite consumer does not replay it (E2). A row whose content or
 * disposition differs from the archive still refuses. created_at is compared by instant in canonical form, because a
 * row the hook outbox wrote keeps SQLite's `YYYY-MM-DD HH:MM:SS` text while the archive carries the portable form.
 *
 * The two sets are accounted for separately. The live local outbox legitimately holds appends made after the
 * cutoff that the archive never saw. The events table's own state model (hooks/events-db.ts) marks a row as
 * delivered through remote_inbox_id (set when the remote inbox accepted it) and acknowledged_at (set on the
 * remote acknowledgement). The schema's CHECK constraints tie the two (acknowledged_at is set exactly when
 * delivery_state is 'acknowledged', and that state requires a remote_inbox_id), so remote_inbox_id alone decides
 * and acknowledged_at needs no read of its own. A row without one is still a local append awaiting replication, whether it is
 * pending, retrying, claimed or quarantined. Such a row absent from the archive is preserved untouched and
 * counted. A row absent from the archive that claims either marker contradicts the archive (a delivered event
 * PostgreSQL does not hold) and refuses.
 */
/** @internal Exported for direct unit testing only; not part of the module's public surface. */
export function verifyPassiveEventsAgainstArchive(
  db: DatabaseSync,
  eventsDb: DatabaseSync,
  machineIds: ReadonlyMap<string, string | null>,
  localMachineId: string,
): Readonly<{ verifiedImported: number; preservedPending: number }> {
  const select = eventsDb.prepare(
    `SELECT event_version, machine_id, machine_sequence, session_id, seq, type, category, data,
            priority, source_hook, created_at,
            CASE WHEN processed_at IS NOT NULL OR delivery_state = 'acknowledged' THEN 'applied'
                 WHEN delivery_state = 'quarantined' THEN 'quarantined'
                 ELSE 'pending' END AS disposition
     FROM events WHERE event_uuid = ?`,
  );
  let archiveCount = 0;
  const archivedEventIds = new Set<string>();
  for (const row of readArchiveDomain(db, "passive-events")) {
    const v = row.value;
    const machineId = machineIds.get(v.machineIdentityKey);
    if (machineId !== localMachineId) continue;
    archiveCount++;
    archivedEventIds.add(v.eventId);
    const sequence = requireInteger(v.machineSequence, "passive-events.machineSequence");
    const createdAt = requireTimestamp(v.createdAt, "passive-events.createdAt");
    const stored = select.get(v.eventId) as PassiveEventReadbackRow | undefined;
    if (
      !stored
      || BigInt(stored.event_version) !== requireInteger(v.eventVersion, "passive-events.eventVersion")
      || stored.machine_id !== machineId
      || stored.machine_sequence !== formatLocalHookMachineSequence(sequence)
      || stored.session_id !== v.sessionId
      || BigInt(stored.seq) !== requireInteger(v.sessionSequence, "passive-events.sessionSequence")
      || stored.type !== v.eventType
      || stored.category !== v.category
      || stored.data !== v.data
      || BigInt(stored.priority) !== requireInteger(v.priority, "passive-events.priority")
      || stored.source_hook !== v.sourceHook
      || canonicalTimestamp(stored.created_at) === null
      || canonicalTimestamp(stored.created_at) !== canonicalTimestamp(createdAt)
      || stored.disposition !== v.disposition
    ) {
      throw new RollbackSidecarError(
        "verification-failed",
        `materialized passive event ${v.eventId} diverges from its archive row`,
      );
    }
  }
  const others = (eventsDb.prepare(
    "SELECT event_uuid, remote_inbox_id FROM events",
  ).all() as Array<{ event_uuid: string; remote_inbox_id: string | null }>)
    .filter((stored) => !archivedEventIds.has(stored.event_uuid));
  for (const stored of others) {
    if (stored.remote_inbox_id !== null) {
      throw new RollbackSidecarError(
        "verification-failed",
        `events table holds delivered event ${stored.event_uuid} that the archive does not contain`,
      );
    }
  }
  return { verifiedImported: archiveCount, preservedPending: others.length };
}

/**
 * Materializes both archive-only runtime surfaces plan-v2 requires
 * (session_instruction_cache inside input.databasePath, and a fresh
 * per-project events db under `<homeDir>/events/`) and reconciles
 * the shared machine-sequence checkpoint. Idempotent: session
 * instructions upsert by (project_id, scope_hash); events insert with
 * ON CONFLICT(event_uuid) DO NOTHING, so a retry after a partial run
 * neither duplicates nor errors on already-materialized rows.
 */
export function materializeRollbackSidecars(
  input: MaterializeRollbackSidecarsInput,
): MaterializeRollbackSidecarsOutcome {
  const db = new DatabaseSync(input.databasePath);
  let sessionInstructionsMaterialized: number;
  let passiveEventsMaterialized = 0;
  let passiveEventsPreservedPending = 0;
  let reconciledUpTo: string | null = null;
  const targetEventsDbPath = join(eventsDir(input.homeDir), `${input.localProjectId}.db`);
  try {
    db.exec("PRAGMA foreign_keys=ON");
    sessionInstructionsMaterialized = materializeSessionInstructions(db, input.localProjectId, input.machineId);
    verifySessionInstructionsAgainstArchive(db, input.localProjectId, sessionInstructionsMaterialized, input.machineId);

    try {
      ensurePrivateDirectory(eventsDir(input.homeDir));
    } catch (error) {
      throw new RollbackSidecarError("unsafe-storage", "rollback events directory could not be created", { cause: error });
    }
    // Bootstrap the exact schema_version=5 schema through EventsDb's own
    // migration, the same schema-creation code the live runtime uses --
    // never hand-written here. The historical rows themselves are
    // written through a raw connection afterward, because EventsDb's own
    // insertEvent mints identities this module must not mint.
    new EventsDb(targetEventsDbPath).close();
    const eventsDb = new DatabaseSync(targetEventsDbPath);
    try {
      eventsDb.exec("PRAGMA foreign_keys=ON");
      const machineIds = readMachineIdByIdentityKey(db);
      const result = materializePassiveEvents(db, eventsDb, machineIds, input.machineId);
      passiveEventsMaterialized = result.count;
      passiveEventsPreservedPending = verifyPassiveEventsAgainstArchive(db, eventsDb, machineIds, input.machineId).preservedPending;
      if (result.highestSequence !== null) {
        const allocator = new LocalHookEventSequenceAllocator(eventSequenceDbPath(input.homeDir));
        try {
          allocator.reconcileCheckpoint(result.highestSequence);
        } finally {
          allocator.close();
        }
        reconciledUpTo = result.highestSequence.toString();
      }
    } finally {
      eventsDb.close();
    }
    // The passive-events surface genuinely is an isolated sidecar file
    // (see the module doc comment), so this check is meaningful here.
    // validateSqliteSidecarSchema only reads; the handle is this function's to close (PR #1556 thread 4308518712).
    const validation = new DatabaseSync(targetEventsDbPath, { readOnly: true });
    try {
      validateSqliteSidecarSchema(validation, "passive-events");
    } finally {
      validation.close();
    }
  } finally {
    db.close();
  }
  return {
    sessionInstructionsMaterialized,
    passiveEventsMaterialized,
    passiveEventsPreservedPending,
    eventsDbPath: targetEventsDbPath,
    reconciledUpTo,
  };
}
