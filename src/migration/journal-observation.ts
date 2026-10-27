import {
  BackendPublicationJournalError,
  readBackendMaintenanceJournal,
  readBackendPublicationJournal,
  type BackendMaintenanceJournal,
  type BackendPublicationPhase,
} from "../storage/backend-publication.js";

/**
 * Section 4.2's four-valued journal resolution, and the section 2.8 repair:
 * a live, valid v2 publication journal is never read as absence, because
 * `readBackendMaintenanceJournal` returns `null` for three different facts
 * (an undefined directory handle, an absent journal file, and a present
 * valid v2 publication journal) and only the last of those is a genuine
 * occupant this item must not probe past.
 *
 * `apply` never calls `inspectMaintenance()` (or its module equivalent)
 * alone. It reads the v3 maintenance journal first; only when that is
 * genuinely null does it fall back to the v2 reader, exactly as
 * `enterMaintenance` itself does at its own existing-journal read
 * (`existing = maintenance ?? readJournalFromDirectory`).
 */

export type MigrationJournalObservation =
  | Readonly<{ kind: "hold"; journal: BackendMaintenanceJournal }>
  /**
   * A live v2 publication journal. It carries the parsed journal's identity
   * and phase (plan-v5 Part B (1)) because the router must tell the
   * generation's own in-flight or completed publication from a stranger's.
   */
  | Readonly<{ kind: "publication"; publicationId: string; phase: BackendPublicationPhase }>
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "unresolvable"; evidence: string }>;

export type MigrationJournalOperations = Readonly<{
  readMaintenance: typeof readBackendMaintenanceJournal;
  readPublication: typeof readBackendPublicationJournal;
}>;

function journalEvidence(error: unknown): string {
  if (error instanceof BackendPublicationJournalError) return `journal-${error.reason}`;
  return "journal-internal-error";
}

export function observeMigrationMaintenanceJournal(input: Readonly<{
  homeDir?: string;
  /**
   * @internal Deterministic failure-injection seam for tests only, matching
   * the `_operationsForTesting` convention used elsewhere in
   * `src/migration/`.
   */
  _operationsForTesting?: Partial<MigrationJournalOperations>;
}> = {}): MigrationJournalObservation {
  const readMaintenance = input._operationsForTesting?.readMaintenance ?? readBackendMaintenanceJournal;
  const readPublication = input._operationsForTesting?.readPublication ?? readBackendPublicationJournal;
  let maintenance: BackendMaintenanceJournal | null;
  try {
    maintenance = readMaintenance(input.homeDir);
  } catch (error) {
    return { kind: "unresolvable", evidence: journalEvidence(error) };
  }
  if (maintenance !== null) return { kind: "hold", journal: maintenance };
  let publication: ReturnType<typeof readBackendPublicationJournal>;
  try {
    publication = readPublication(input.homeDir);
  } catch (error) {
    return { kind: "unresolvable", evidence: journalEvidence(error) };
  }
  if (publication !== null) return { kind: "publication", publicationId: publication.publicationId, phase: publication.phase };
  return { kind: "absent" };
}

