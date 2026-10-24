import { describe, expect, it } from "vitest";
import {
  matchingMigrationRouteRows,
  routeMigrationGeneration,
  type MigrationRouteInput,
  type MigrationRouteJournal,
  type MigrationRouteLink,
  type MigrationRouteManifest,
  type MigrationRouteSnapshot,
} from "../../src/migration/routing.js";
import { deriveRollbackPublicationId } from "../../src/migration/rollback.js";
import type { BackendMaintenancePhase, BackendPublicationPhase } from "../../src/storage/backend-publication.js";
import type { MigrationEffectKind, MigrationPhase } from "../../src/migration/protocol.js";

const GEN = "generation-1";
const PUB = "publication-1";
const ROLLBACK_PUB = deriveRollbackPublicationId(GEN);

const held = (phase: BackendMaintenancePhase, generationId = GEN): MigrationRouteJournal => ({ kind: "hold", phase, generationId });
const publication = (phase: BackendPublicationPhase, publicationId = PUB): MigrationRouteJournal => ({ kind: "publication", publicationId, phase });
const manifest = (phase: MigrationPhase, pending: MigrationEffectKind | null = null): MigrationRouteManifest => ({ kind: "present", phase, pending });
const ABSENT: MigrationRouteManifest = { kind: "absent" };
const NO_LINK: MigrationRouteLink = { kind: "absent" };
const OWN_LINK: MigrationRouteLink = { kind: "present", publicationId: PUB };

function cell(overrides: Partial<MigrationRouteInput>): MigrationRouteInput {
  return {
    journal: held("maintenance-held"), resolvedGenerationId: GEN, manifest: ABSENT, snapshot: "absent", link: NO_LINK,
    ...overrides,
  };
}

type Expectation = Readonly<{
  row: number; primary: string; allowed: readonly string[]; exit: number; next?: string;
}>;

const ROW_CELLS: ReadonlyArray<readonly [string, MigrationRouteInput, Expectation]> = [
  ["1 journal unresolvable", cell({ journal: { kind: "unresolvable" } }), { row: 1, primary: "none", allowed: [], exit: 5 }],
  ["1 manifest unresolvable", cell({ manifest: { kind: "unresolvable" } }), { row: 1, primary: "none", allowed: [], exit: 5 }],
  ["1 snapshot unresolvable", cell({ snapshot: "unresolvable" }), { row: 1, primary: "none", allowed: [], exit: 5 }],
  ["1 link unresolvable", cell({ link: { kind: "unresolvable" } }), { row: 1, primary: "none", allowed: [], exit: 5 }],
  ["2 foreign in-flight publication (link absent)", cell({ journal: publication("map-publishing") }), { row: 2, primary: "none", allowed: [], exit: 4 }],
  ["2 foreign in-flight publication (link names another)", cell({ journal: publication("prepared"), link: { kind: "present", publicationId: "other" } }), { row: 2, primary: "none", allowed: [], exit: 4 }],
  ["3 foreign completed publication", cell({ journal: publication("completed") }), { row: 3, primary: "none", allowed: [], exit: 5 }],
  ["3 foreign aborted publication", cell({ journal: publication("aborted") }), { row: 3, primary: "none", allowed: [], exit: 5 }],
  ["4 hold held for another generation", cell({ journal: held("maintenance-held", "other") }), { row: 4, primary: "abort", allowed: [], exit: 2 }],
  ["4 hold entering for another generation", cell({ journal: held("maintenance-entering", "other") }), { row: 4, primary: "abort", allowed: [], exit: 2 }],
  ["5 aborted hold, no manifest", cell({ journal: held("maintenance-aborted") }), { row: 5, primary: "none", allowed: ["apply", "abort"], exit: 2, next: "apply" }],
  ["5 aborted hold, settled aborted manifest", cell({ journal: held("maintenance-aborted"), manifest: manifest("aborted") }), { row: 5, primary: "none", allowed: ["apply", "abort"], exit: 2, next: "apply" }],
  ["6 aborted hold, pending abort", cell({ journal: held("maintenance-aborted"), manifest: manifest("copied", "abort") }), { row: 6, primary: "abort", allowed: ["resume"], exit: 6 }],
  ["7 aborted hold, pending copy-batch", cell({ journal: held("maintenance-aborted"), manifest: manifest("copying", "copy-batch") }), { row: 7, primary: "none", allowed: [], exit: 7 }],
  ["7 aborted hold, pending verify-generation", cell({ journal: held("maintenance-aborted"), manifest: manifest("copied", "verify-generation") }), { row: 7, primary: "none", allowed: [], exit: 7 }],
  ["8 aborted hold, copied, no pending (the crash cell)", cell({ journal: held("maintenance-aborted"), manifest: manifest("copied") }), { row: 8, primary: "abort", allowed: [], exit: 2 }],
  ["8 aborted hold, planned, no pending", cell({ journal: held("maintenance-aborted"), manifest: manifest("planned") }), { row: 8, primary: "abort", allowed: [], exit: 2 }],
  ["9 aborted hold, active manifest", cell({ journal: held("maintenance-aborted"), manifest: manifest("active") }), { row: 9, primary: "none", allowed: [], exit: 5 }],
  ["9 aborted hold, pending prepare-activation", cell({ journal: held("maintenance-aborted"), manifest: manifest("verified", "prepare-activation") }), { row: 9, primary: "none", allowed: [], exit: 5 }],
  ["10 own completed publication, active manifest", cell({ journal: publication("completed"), manifest: manifest("active"), link: OWN_LINK }), { row: 10, primary: "none", allowed: ["activate", "rollback"], exit: 2, next: "report" }],
  ["11 own in-flight publication, verified", cell({ journal: publication("releasing"), manifest: manifest("verified"), link: OWN_LINK }), { row: 11, primary: "activate", allowed: ["resume"], exit: 2 }],
  ["11 own aborted publication, verified", cell({ journal: publication("aborted"), manifest: manifest("verified"), link: OWN_LINK }), { row: 11, primary: "activate", allowed: ["resume"], exit: 2 }],
  ["11 selection-prepared hold, activating", cell({ journal: held("selection-prepared"), manifest: manifest("activating") }), { row: 11, primary: "activate", allowed: ["resume"], exit: 2 }],
  ["11 selection-completed hold, pending publish-activation", cell({ journal: held("selection-completed"), manifest: manifest("activating", "publish-activation") }), { row: 11, primary: "activate", allowed: ["resume"], exit: 6 }],
  ["12 rolling-back manifest", cell({ manifest: manifest("rolling-back"), journal: held("selection-completed") }), { row: 12, primary: "rollback", allowed: ["resume"], exit: 6 }],
  ["12 pending prepare-rollback", cell({ manifest: manifest("verified", "prepare-rollback") }), { row: 12, primary: "rollback", allowed: ["resume"], exit: 6 }],
  ["13 rolled-back manifest", cell({ manifest: manifest("rolled-back"), journal: held("selection-completed") }), { row: 13, primary: "none", allowed: ["rollback"], exit: 2, next: "report" }],
  ["13 rolled-back manifest beside the completed rollback publication (#1675)", cell({ journal: publication("completed", ROLLBACK_PUB), manifest: manifest("rolled-back"), link: OWN_LINK }), { row: 13, primary: "none", allowed: ["rollback"], exit: 2, next: "report" }],
  ["12 rolling-back manifest beside its in-flight rollback publication (#1675)", cell({ journal: publication("map-publishing", ROLLBACK_PUB), manifest: manifest("rolling-back"), link: OWN_LINK }), { row: 12, primary: "rollback", allowed: ["resume"], exit: 6 }],
  ["3 rolled-back manifest beside an unrelated completed publication stays foreign (#1675)", cell({ journal: publication("completed", "other"), manifest: manifest("rolled-back"), link: OWN_LINK }), { row: 3, primary: "none", allowed: [], exit: 5 }],
  ["25 a completed rollback publication is not an activation beside an active manifest (#1675)", cell({ journal: publication("completed", ROLLBACK_PUB), manifest: manifest("active"), link: OWN_LINK }), { row: 25, primary: "none", allowed: [], exit: 5 }],
  ["25 an in-flight rollback publication is not an activation beside a verified manifest (#1675)", cell({ journal: publication("map-publishing", ROLLBACK_PUB), manifest: manifest("verified"), link: OWN_LINK }), { row: 25, primary: "none", allowed: [], exit: 5 }],
  ["14 entering hold, no manifest, no snapshot", cell({ journal: held("maintenance-entering") }), { row: 14, primary: "apply", allowed: ["abort"], exit: 2 }],
  ["14 entering hold, no manifest, complete snapshot", cell({ journal: held("maintenance-entering"), snapshot: "complete" }), { row: 14, primary: "apply", allowed: ["abort"], exit: 2 }],
  ["15 held, no manifest, no snapshot", cell({}), { row: 15, primary: "apply", allowed: ["abort"], exit: 2 }],
  ["16 held, no manifest, complete snapshot", cell({ snapshot: "complete" }), { row: 16, primary: "apply", allowed: ["abort"], exit: 2 }],
  ["17 held, partial snapshot, no manifest", cell({ snapshot: "partial" }), { row: 17, primary: "abort", allowed: [], exit: 2 }],
  ["17 held, replaced snapshot, copied manifest, nothing pending", cell({ snapshot: "replaced", manifest: manifest("copied") }), { row: 17, primary: "abort", allowed: [], exit: 2 }],
  ["17 entering, tampered snapshot, planned manifest", cell({ journal: held("maintenance-entering"), snapshot: "tampered", manifest: manifest("planned") }), { row: 17, primary: "abort", allowed: [], exit: 2 }],
  ["18 held, partial snapshot, pending copy-batch", cell({ snapshot: "partial", manifest: manifest("copying", "copy-batch") }), { row: 18, primary: "none", allowed: [], exit: 7 }],
  ["19 held, complete snapshot, planned", cell({ snapshot: "complete", manifest: manifest("planned") }), { row: 19, primary: "resume", allowed: ["abort"], exit: 2 }],
  ["20 held, complete snapshot, pending verify-dry-run", cell({ snapshot: "complete", manifest: manifest("planned", "verify-dry-run") }), { row: 20, primary: "resume", allowed: [], exit: 6 }],
  ["21 held, dry-run-verified, no pending", cell({ snapshot: "complete", manifest: manifest("dry-run-verified") }), { row: 21, primary: "resume", allowed: ["abort"], exit: 2 }],
  ["21 held, copying, no pending", cell({ snapshot: "complete", manifest: manifest("copying") }), { row: 21, primary: "resume", allowed: ["abort"], exit: 2 }],
  ["21 held, pending copy-batch", cell({ snapshot: "complete", manifest: manifest("copying", "copy-batch") }), { row: 21, primary: "resume", allowed: [], exit: 6 }],
  ["21 held, pending complete-copy", cell({ snapshot: "complete", manifest: manifest("copying", "complete-copy") }), { row: 21, primary: "resume", allowed: [], exit: 6 }],
  ["22 held, copied, no pending", cell({ snapshot: "complete", manifest: manifest("copied") }), { row: 22, primary: "verify", allowed: ["abort"], exit: 2 }],
  ["23 held, pending verify-generation (snapshot not consulted)", cell({ snapshot: "absent", manifest: manifest("copied", "verify-generation") }), { row: 23, primary: "verify", allowed: ["resume"], exit: 6 }],
  ["24 held, verified, complete snapshot", cell({ snapshot: "complete", manifest: manifest("verified") }), { row: 24, primary: "activate", allowed: ["rollback", "abort", "verify"], exit: 2 }],
  ["25 held, manifest present but snapshot absent (snapshot-absent implies manifest-absent)", cell({ manifest: manifest("copied") }), { row: 25, primary: "none", allowed: [], exit: 5 }],
  ["25 absent journal with a manifest", cell({ journal: { kind: "absent" }, manifest: manifest("copied"), snapshot: "complete" }), { row: 25, primary: "none", allowed: [], exit: 5 }],
];

describe("routeMigrationGeneration, one concrete cell per plan-v5 row", () => {
  it.each(ROW_CELLS)("%s", (_name, input, expected) => {
    const route = routeMigrationGeneration(input);
    expect(route.row).toBe(expected.row);
    expect(route.primary).toBe(expected.primary);
    expect([...route.allowed]).toEqual(expected.allowed);
    expect(route.exitIfRefused).toBe(expected.exit);
    if (expected.next !== undefined) expect(route.nextAction).toBe(expected.next);
  });

  it("covers every row 1 through 25", () => {
    const rows = new Set(ROW_CELLS.map(([, input]) => routeMigrationGeneration(input).row));
    expect([...rows].sort((a, b) => a - b)).toEqual(Array.from({ length: 25 }, (_value, index) => index + 1));
  });

  it("exposes the owner as nextAction when there is one", () => {
    expect(routeMigrationGeneration(cell({ snapshot: "complete", manifest: manifest("copied") })).nextAction).toBe("verify");
    expect(routeMigrationGeneration(cell({ snapshot: "partial" })).nextAction).toBe("abort");
    expect(routeMigrationGeneration(cell({ manifest: manifest("copied") })).nextAction).toBe("none");
  });
});

describe("rows 11, 12 and 24 are live: the non-owner exit is 6 when a pending effect exists, otherwise 2", () => {
  it.each([
    ["row 11 with a pending effect", cell({ journal: publication("prepared"), link: OWN_LINK, manifest: manifest("verified", "prepare-activation") }), 6],
    ["row 11 without one", cell({ journal: publication("prepared"), link: OWN_LINK, manifest: manifest("verified") }), 2],
    ["row 12", cell({ manifest: manifest("rolling-back") }), 6],
    ["row 24", cell({ snapshot: "complete", manifest: manifest("verified") }), 2],
  ])("%s", (_name, input, exit) => {
    expect(routeMigrationGeneration(input).exitIfRefused).toBe(exit);
  });
});

const PHASES_MANIFEST: readonly MigrationPhase[] = [
  "planned", "dry-run-verified", "copying", "copied", "verified", "activating", "active", "rolling-back", "rolled-back", "aborted",
];
const EFFECTS: readonly MigrationEffectKind[] = [
  "verify-dry-run", "copy-batch", "complete-copy", "verify-generation", "prepare-activation", "publish-activation",
  "prepare-rollback", "publish-rollback", "abort",
];
const HOLD_PHASES: readonly BackendMaintenancePhase[] = [
  "maintenance-entering", "maintenance-held", "selection-prepared", "selection-completed", "maintenance-aborted",
];
const PUBLICATION_PHASES: readonly BackendPublicationPhase[] = [
  "preparing", "prepared", "acquiring", "guarded", "map-publishing", "map-published", "config-publishing", "config-published",
  "releasing", "released", "aborting", "config-restoring", "map-restoring", "abort-releasing", "aborted", "completed",
];
const SNAPSHOTS: readonly MigrationRouteSnapshot[] = ["absent", "partial", "complete", "replaced", "tampered", "unresolvable"];

function* everyCell(): Generator<MigrationRouteInput> {
  const journals: MigrationRouteJournal[] = [{ kind: "unresolvable" }, { kind: "absent" }];
  for (const phase of HOLD_PHASES) journals.push(held(phase), held(phase, "other"));
  for (const phase of PUBLICATION_PHASES) journals.push(publication(phase));
  const manifests: MigrationRouteManifest[] = [ABSENT, { kind: "unresolvable" }];
  for (const phase of PHASES_MANIFEST) {
    manifests.push(manifest(phase));
    for (const effect of EFFECTS) manifests.push(manifest(phase, effect));
  }
  const links: MigrationRouteLink[] = [
    NO_LINK, { kind: "unresolvable" }, OWN_LINK, { kind: "present", publicationId: "other" },
  ];
  for (const journal of journals) {
    for (const manifestValue of manifests) {
      for (const snapshot of SNAPSHOTS) {
        for (const link of links) yield { journal, resolvedGenerationId: GEN, manifest: manifestValue, snapshot, link };
      }
    }
  }
}

describe("totality: every cell of journal x manifest x snapshot x link maps to a row, and the invariants hold", () => {
  it("never throws for a known value, always lands in rows 1-25, and keeps each journal family in its own rows", () => {
    let cells = 0;
    for (const input of everyCell()) {
      cells += 1;
      const { journal, manifest: m, snapshot, link } = input;
      const route = routeMigrationGeneration(input);
      expect(route.row).toBeGreaterThanOrEqual(1);
      expect(route.row).toBeLessThanOrEqual(25);
      const matching = matchingMigrationRouteRows(input);
      expect(matching[0]).toBe(route.row);
      expect(matching.at(-1)).toBe(25);
      expect([2, 4, 5, 6, 7]).toContain(route.exitIfRefused);
      expect([2, 4, 5, 6, 7]).toContain(route.exitIfRefused);
      // Any unresolvable observation is exit 5, never exit 2.
      if (journal.kind === "unresolvable" || m.kind === "unresolvable" || snapshot === "unresolvable" || link.kind === "unresolvable") {
        expect(route.row).toBe(1);
      }
      if (route.row !== 1 && journal.kind === "publication") {
        const own = link.kind === "present" && link.publicationId === journal.publicationId;
        if (!own) {
          expect(route.row).toBe(journal.phase === "completed" || journal.phase === "aborted" ? 3 : 2);
        } else {
          expect([10, 11, 12, 13, 25]).toContain(route.row);
        }
      }
      if (route.row !== 1 && journal.kind === "hold" && journal.phase === "maintenance-aborted") {
        expect([5, 6, 7, 8, 9]).toContain(route.row);
      }
      // A pending copy-class effect or a verify effect is never routed to a mutating owner without a held, matching journal.
      if (route.row >= 14 && route.row <= 24) {
        expect(journal.kind).toBe("hold");
      }
      // Exit 6 only ever points at a durably begun, non-terminal state that resume (or its owner) finishes:
      // a pending effect, or the rolling-back phase #626's re-entry finishes.
      if (route.exitIfRefused === 6) {
        expect(m.kind === "present" && (m.pending !== null || m.phase === "rolling-back")).toBe(true);
      }
      // Report is never an owner.
      expect(route.primary).not.toBe("report");
      expect(route.allowed).not.toContain("report");
    }
    expect(cells).toBe((2 + HOLD_PHASES.length * 2 + PUBLICATION_PHASES.length) * (2 + PHASES_MANIFEST.length * (1 + EFFECTS.length)) * SNAPSHOTS.length * 4);
    // An exhaustive in-process enumeration (about 69,000 cells), so it is given an explicit budget
    // rather than the 5 s default, which coverage instrumentation exceeds.
  }, 120_000);

  it("maps a planned manifest with nothing pending to exit 2, never exit 6", () => {
    for (const snapshot of SNAPSHOTS) {
      const route = routeMigrationGeneration(cell({ snapshot, manifest: manifest("planned") }));
      expect(route.exitIfRefused).not.toBe(6);
    }
  });
});

describe("unknown values throw rather than defaulting (the boundary maps the throw to exit 5)", () => {
  const throwing: ReadonlyArray<readonly [string, MigrationRouteInput]> = [
    ["a journal kind", cell({ journal: { kind: "terminal" } as never })],
    ["a hold phase", cell({ journal: held("maintenance-bogus" as never) })],
    ["a publication phase", cell({ journal: publication("bogus" as never) })],
    ["a manifest kind", cell({ manifest: { kind: "bogus" } as never })],
    ["a manifest phase", cell({ manifest: manifest("bogus" as never) })],
    ["a pending effect kind", cell({ manifest: manifest("copied", "bogus" as never) })],
    ["a snapshot class", cell({ snapshot: "bogus" as never })],
    ["a link status", cell({ link: { kind: "bogus" } as never })],
  ];

  it.each(throwing)("throws for %s", (_name, input) => {
    expect(() => routeMigrationGeneration(input)).toThrow(/unknown migration route/u);
    expect(() => matchingMigrationRouteRows(input)).toThrow(/unknown migration route/u);
  });
});
