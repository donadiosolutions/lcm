import { isTerminalBackendMaintenancePhase } from "../storage/backend-publication.js";
import { observeMigrationMaintenanceJournal, type MigrationJournalObservation } from "./journal-observation.js";
import { MigrationManifestStore } from "./manifest-store.js";
import { MigrationProtocolError, type MigrationManifest } from "./protocol.js";
import { classifySqliteSnapshotArtifact } from "./sqlite-snapshot.js";
import { readActivationGenerationLink, type ActivationGenerationLinkReadResult } from "./activation-artifact-store.js";
import {
  routeMigrationGeneration,
  type MigrationRoute,
  type MigrationRouteCommand,
  type MigrationRouteInput,
  type MigrationRouteJournal,
  type MigrationRouteLink,
  type MigrationRouteManifest,
  type MigrationRouteSnapshot,
} from "./routing.js";

/**
 * Plan-v5 Part B (1), "section 3 resolution, existing-generation commands
 * only": resolve the explicit (or live) generation id, gather the four
 * observations the router consumes, and route.
 *
 * Every read here is lock-free and writes nothing: the journal observation,
 * the manifest probe and read, the snapshot classification and #625's
 * three-valued activation link reader. A resolved link names the generation's
 * own v2 publication, an authoritatively absent one is `absent`, and anything
 * else is `unresolvable` (exit 5).
 *
 * Fresh plan, apply and standalone dry-run never come through here.
 */

export type ExistingGenerationContext = Readonly<{
  generationId: string;
  journal: MigrationJournalObservation;
  /** The full manifest when one is present, so callers do not read it twice. */
  manifest: MigrationManifest | null;
  /** The snapshot class the route consumed, so `report` can show it. */
  snapshot: MigrationRouteSnapshot;
  /** The activation link read the route consumed, so `report` can show it. */
  activationLink: ActivationGenerationLinkReadResult;
  route: MigrationRoute;
}>;

export type ExistingGenerationResolution =
  | Readonly<{ status: "resolved"; context: ExistingGenerationContext }>
  | Readonly<{ status: "refuse"; reason: string; evidence?: string }>;

export type ExistingGenerationOperations = Readonly<{
  observeJournal: typeof observeMigrationMaintenanceJournal;
  classifySnapshot: typeof classifySqliteSnapshotArtifact;
  readLink: typeof readActivationGenerationLink;
}>;

export type ExistingGenerationInput = Readonly<{
  homeDir: string;
  /** The explicit `--generation`. Absent means "the live non-terminal hold". */
  generation?: string;
  manifestStore?: MigrationManifestStore;
  /**
   * @internal Deterministic failure-injection seam for tests only, matching
   * the `_operationsForTesting` convention used elsewhere in
   * `src/migration/`.
   */
  _operationsForTesting?: Partial<ExistingGenerationOperations>;
}>;

function routeJournal(observation: MigrationJournalObservation): MigrationRouteJournal {
  if (observation.kind === "hold") {
    return { kind: "hold", phase: observation.journal.phase, generationId: observation.journal.generationId };
  }
  if (observation.kind === "publication") {
    return { kind: "publication", publicationId: observation.publicationId, phase: observation.phase };
  }
  return { kind: observation.kind };
}

function routeLink(result: ActivationGenerationLinkReadResult): MigrationRouteLink {
  if (result.state === "resolved") return { kind: "present", publicationId: result.link.publicationId };
  return { kind: result.state === "authoritatively-absent" ? "absent" : "unresolvable" };
}

/**
 * Whether the journal is evidence that `generationId` exists: a hold naming
 * it, or a journal that could not be read. A v2 publication is activation
 * evidence, and activation requires the manifest this check already found
 * absent, so no publication proves a manifest-less id.
 */
function journalNames(journal: MigrationRouteJournal, generationId: string): boolean {
  if (journal.kind === "hold") return journal.generationId === generationId;
  return journal.kind === "unresolvable";
}

export async function resolveExistingMigrationGeneration(
  input: ExistingGenerationInput,
): Promise<ExistingGenerationResolution> {
  const observeJournal = input._operationsForTesting?.observeJournal ?? observeMigrationMaintenanceJournal;
  const classifySnapshot = input._operationsForTesting?.classifySnapshot ?? classifySqliteSnapshotArtifact;
  const readLink = input._operationsForTesting?.readLink ?? readActivationGenerationLink;
  const store = input.manifestStore ?? new MigrationManifestStore({ homeDir: input.homeDir });

  const observation = observeJournal({ homeDir: input.homeDir });
  let generationId = input.generation;
  if (generationId === undefined) {
    if (observation.kind === "unresolvable") {
      return { status: "refuse", reason: "journal-unresolvable", evidence: observation.evidence };
    }
    if (observation.kind !== "hold" || isTerminalBackendMaintenancePhase(observation.journal.phase)) {
      return { status: "refuse", reason: "generation-required" };
    }
    generationId = observation.journal.generationId;
  }

  // The explicit id is resolved against manifest presence first. A malformed
  // id is a usage error; an unreadable manifest is evidence, never absence.
  let manifestRoute: MigrationRouteManifest;
  let manifest: MigrationManifest | null = null;
  try {
    const presence = store.probeManifestPresence(generationId);
    if (presence.status === "unresolvable") {
      manifestRoute = { kind: "unresolvable" };
    } else if (presence.status === "absent") {
      manifestRoute = { kind: "absent" };
    } else {
      manifest = store.read(generationId);
      manifestRoute = { kind: "present", phase: manifest.phase, pending: manifest.pendingEffect?.kind ?? null };
    }
  } catch (error) {
    if (error instanceof MigrationProtocolError && error.reason === "invalid-input") {
      return { status: "refuse", reason: "generation-invalid" };
    }
    manifestRoute = { kind: "unresolvable" };
  }

  const journal = routeJournal(observation);
  // An explicit id exists when its manifest is present, or when the journal
  // names it: a hold for a different generation is that generation's
  // evidence, not this one's, so a mistyped id refuses here instead of
  // routing against a stranger's hold (row 4 still applies once the explicit
  // id's own manifest exists). An unresolvable journal stays unresolvable.
  if (manifestRoute.kind === "absent" && !journalNames(journal, generationId)) {
    return { status: "refuse", reason: "generation-unknown" };
  }

  let snapshot: MigrationRouteSnapshot;
  try {
    snapshot = (await classifySnapshot(generationId, { homeDir: input.homeDir })).state;
  } catch {
    snapshot = "unresolvable";
  }

  let activationLink: ActivationGenerationLinkReadResult;
  try {
    activationLink = readLink({ homeDir: input.homeDir, generationId });
  } catch (error) {
    // The reader is lock-free and three-valued; a raw failure is unresolvable evidence, never absence.
    activationLink = {
      state: "unresolvable", reason: "read-unresolvable",
      detail: error instanceof Error ? error.name : "unknown-link-read-failure",
    };
  }

  const routeInput: MigrationRouteInput = {
    journal, resolvedGenerationId: generationId, manifest: manifestRoute, snapshot, link: routeLink(activationLink),
  };
  return {
    status: "resolved",
    context: { generationId, journal: observation, manifest, snapshot, activationLink, route: routeMigrationGeneration(routeInput) },
  };
}

export type RouteRefusal = Readonly<{ status: "refuse"; reason: string; next: string | null }>;

/**
 * The refusal an invoked command gets when it is neither the cell's owner nor
 * allowed to run it, or `null` when it may proceed. `report` never refuses:
 * it only reads.
 */
export function refuseUnlessRouted(command: MigrationRouteCommand, route: MigrationRoute): RouteRefusal | null {
  if (command === "report" || route.primary === command || (route.allowed as readonly string[]).includes(command)) {
    return null;
  }
  const next = route.nextAction === "none" ? null : route.nextAction;
  switch (route.exitIfRefused) {
    case 2: return { status: "refuse", reason: "route-not-owner", next };
    case 4: return { status: "refuse", reason: "route-publication-in-flight", next };
    case 6: return { status: "refuse", reason: "route-resume-required", next };
    case 7:
      return { status: "refuse", reason: "route-operator-required", next };
    default:
      if (route.row === 1) return { status: "refuse", reason: "route-unresolvable", next };
      return {
        status: "refuse",
        reason: route.row === 3 ? "route-foreign-publication" : "route-contradiction",
        next,
      };
  }
}
