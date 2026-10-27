import { canonicalJson, sha256 } from "../storage/portable-record.js";

/**
 * The deterministic publicationId an activation of one generation always
 * publishes under: the maintenance journal's publicationId, the version-2
 * backend-publication journal's publicationId, the activation artifact's
 * embedded publicationId (activation-artifact-store.ts), and the value the
 * activation selection binding later carries (generation-binding-store.ts)
 * are all this one value.
 *
 * It is a pure function of the generation id alone, mirroring rollback's
 * deriveRollbackPublicationId (coordinator-seam contract section 17:
 * "derive it without any attempt-time observation"), for the same two
 * load-bearing reasons:
 *
 * - plan-v5 S0 mints the publicationId before any lease exists and never
 *   refreshes it on retry. A value that rotated across retries would
 *   change the bytes of the already-published activation artifact (whose
 *   store key deliberately excludes publicationId, so a rotated id
 *   collides with the existing record and is refused), break assertFence
 *   at S13, and make the selection-binding write non-idempotent.
 * - Crash recovery must be able to find the publication without first
 *   knowing which attempt produced it: a resumed driver re-derives the
 *   same id from the generation id it was handed and compares, rather
 *   than searching for whatever id a previous process happened to mint.
 *
 * The domain prefix differs from rollback's so an activation and a rollback
 * of the same generation can never share a publicationId.
 */

const GENERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

/** The generation id handed in does not satisfy the identifier shape every
 * migration store in this directory requires. Thrown before any hashing. */
export class ActivationPublicationIdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActivationPublicationIdError";
  }
}

/**
 * Derive the activation publicationId for a generation. The result is 64
 * lowercase hex characters, which satisfies the PUBLICATION_ID_PATTERN
 * shared by backend-publication.ts, activation-artifact-store.ts and
 * activation-publication.ts (one leading alphanumeric, at most 127 more
 * characters from the identifier alphabet).
 */
export function deriveActivationPublicationId(generationId: string): string {
  if (typeof generationId !== "string" || !GENERATION_ID_PATTERN.test(generationId)) {
    throw new ActivationPublicationIdError("activation publication generation id is invalid");
  }
  return sha256(canonicalJson(["activation-publication-v1", generationId]));
}
