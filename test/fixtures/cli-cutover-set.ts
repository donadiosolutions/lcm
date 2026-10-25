import { afterEach } from "vitest";
import type { BackendMaintenanceJournal } from "../../src/storage/backend-publication.js";
import type { SetObservationOperations } from "../../src/migration/cli-cutover-set-state.js";
import type { MigrationSetOperations } from "../../src/migration/cli-cutover-set.js";
import type { MigrationJournalObservation } from "../../src/migration/journal-observation.js";
import { MigrationManifestStore } from "../../src/migration/manifest-store.js";
import { createFixtureManifest, makeFixtureHome, removeFixtureHomes, type FixtureStage } from "../migration/existing-fixtures.js";
import { targetConfig } from "./cutover-set-prepare.js";

/**
 * Crafted aggregate state for the set commands over a real manifest store:
 * the journal and the two record stores are injected closed values, the member
 * manifests are real. Nothing here needs PostgreSQL or a captured snapshot.
 */

export const SET_ID = "set-aaaa";
export const GENERATIONS = ["member-gen-1", "member-gen-2"] as const;
export const PROJECTS = ["a".repeat(64), "b".repeat(64)] as const;

const roots: string[] = [];
afterEach(() => removeFixtureHomes(roots));

export function craftedHome(stages: readonly (FixtureStage | "absent")[] = ["verified", "verified"]): { homeDir: string; store: MigrationManifestStore } {
  const homeDir = makeFixtureHome(roots);
  const store = new MigrationManifestStore({ homeDir });
  stages.forEach((stage, index) => {
    if (stage !== "absent") createFixtureManifest(store, stage, { generationId: GENERATIONS[index]! });
  });
  return { homeDir, store };
}

const members = GENERATIONS.map((generationId, index) => ({ physicalProjectId: PROJECTS[index]!, generationId }));

export function holdJournal(overrides: Readonly<{
  phase?: string; sourceBackend?: string; setId?: string; cutoverSet?: boolean; generationId?: string;
}> = {}): MigrationJournalObservation {
  const setId = overrides.setId ?? SET_ID;
  return {
    kind: "hold",
    journal: {
      phase: overrides.phase ?? "maintenance-held",
      generationId: overrides.generationId ?? setId,
      sourceBackend: overrides.sourceBackend ?? "sqlite",
      checksumSha256: "j".repeat(64),
      ...(overrides.cutoverSet === false ? {} : { cutoverSet: { manifest: { setId, members: members.map((member) => ({ ...member })) }, bindings: [] } }),
    } as unknown as BackendMaintenanceJournal,
  };
}

export function publicationJournal(publicationId = SET_ID, phase = "released"): MigrationJournalObservation {
  return { kind: "publication", publicationId, phase } as MigrationJournalObservation;
}

export const ABSENT_JOURNAL: MigrationJournalObservation = { kind: "absent" };

type Activation = ReturnType<SetObservationOperations["readActivation"]>;
type Rollback = ReturnType<SetObservationOperations["readRollback"]>;

export function resolvedActivation(selected = true): Activation {
  return {
    state: "resolved",
    checkpoint: { members, checksumSha256: "c".repeat(64) },
    selection: selected ? {} : null,
  } as unknown as Activation;
}

export function resolvedRollback(selected = true): Rollback {
  return {
    state: "resolved",
    checkpoint: { members, checksumSha256: "r".repeat(64) },
    installs: new Map(),
    selection: selected ? {} : null,
  } as unknown as Rollback;
}

export const ABSENT_RECORDS = { state: "authoritatively-absent" } as const;

export function observation(parts: Readonly<{
  journal?: MigrationJournalObservation;
  activation?: Activation;
  rollback?: Rollback;
  snapshot?: string;
  eligible?: boolean;
}> = {}): Partial<SetObservationOperations> {
  return {
    observeJournal: () => parts.journal ?? ABSENT_JOURNAL,
    readActivation: () => parts.activation ?? ABSENT_RECORDS,
    readRollback: () => parts.rollback ?? ABSENT_RECORDS,
    classifySnapshot: async () => ({ state: parts.snapshot ?? "complete" }) as never,
    readVerified: () => ({ status: parts.eligible === false ? "refuse" : "verified" }) as never,
  };
}

export function setOperations(
  home: Readonly<{ homeDir: string }>,
  parts: Parameters<typeof observation>[0],
  extra: Partial<MigrationSetOperations> = {},
): Partial<MigrationSetOperations> {
  void home;
  return {
    observeJournal: () => parts?.journal ?? ABSENT_JOURNAL,
    observation: observation(parts),
    resolveTargetConfig: () => ({ status: "resolved", config: targetConfig() }),
    classifyPresence: async () => ({ status: "authoritatively-absent" }),
    verifyReachability: async () => ({ status: "verified" }),
    ...extra,
  };
}
