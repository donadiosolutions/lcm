import type { AuthenticatedSqliteSnapshotAuthority } from "../../src/migration/sqlite-snapshot.js";
import type {
  CutoverSetManifest,
  CutoverSetMemberAuthorityOutcome,
} from "../../src/migration/cutover-set.js";

export const SET_MACHINE_ID = "018f0b5d-1234-7abc-8def-1234567890ab";
export const SET_ID = "cutover-set-1";

/** A deterministic 64-hex project id; ids sort in index order. */
export function projectHash(index: number): string {
  return index.toString(16).padStart(64, "0");
}

export function sourceHash(index: number): string {
  return (index + 0x1000).toString(16).padStart(64, "0");
}

export function setManifest(count = 2, setId = SET_ID): CutoverSetManifest {
  return {
    version: 1,
    setId,
    machineId: SET_MACHINE_ID,
    members: Array.from({ length: count }, (_, index) => ({
      physicalProjectId: projectHash(index + 1),
      generationId: `member-generation-${index + 1}`,
      sourceSelectionSha256: sourceHash(index + 1),
    })),
  };
}

/** A structurally sufficient authority; the builder reads only identity fields. */
export function fakeAuthority(
  index: number,
  overrides: Partial<Pick<AuthenticatedSqliteSnapshotAuthority, "projectIdentity" | "machineIdentity">> = {},
): AuthenticatedSqliteSnapshotAuthority {
  return {
    version: 1,
    physicalProjectId: projectHash(index),
    projectIdentity: { scope: "local", projectId: projectHash(index) },
    canonicalPath: `/project/${index}`,
    aliases: [],
    projectDbPath: `/project/${index}/db.sqlite`,
    passiveEventsDbPath: null,
    machineSequenceDbPath: "/machine-sequence.db",
    machineIdentity: { identityKey: "key", machineId: SET_MACHINE_ID },
    machineIdentitySha256: sourceHash(0),
    projectMapSha256: sourceHash(0),
    projectMapEntrySha256: sourceHash(0),
    projectMetadataSha256: sourceHash(0),
    sourceSelectionSha256: sourceHash(index),
    ...overrides,
  } as AuthenticatedSqliteSnapshotAuthority;
}

export function authenticated(
  index: number,
  overrides: Parameters<typeof fakeAuthority>[1] = {},
): CutoverSetMemberAuthorityOutcome {
  return { physicalProjectId: projectHash(index), status: "authenticated", authority: fakeAuthority(index, overrides) };
}

export function generationIds(count: number): Map<string, string> {
  return new Map(Array.from({ length: count }, (_, index) =>
    [projectHash(index + 1), `member-generation-${index + 1}`] as const));
}
