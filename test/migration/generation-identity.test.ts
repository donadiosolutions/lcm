import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  classifyMigrationCandidateOccupancy,
  computeMigrationGenerationBase,
  DEFAULT_MAX_PROBE_ORDINAL,
  MigrationIdentityError,
  nonSecretPostgreSqlTargetCoordinates,
  resolveConfirmedMigrationGenerationId,
  resolveMigrationGenerationId,
  type MigrationCandidateOccupancy,
} from "../../src/migration/generation-identity.js";
import { MigrationManifestStore } from "../../src/migration/manifest-store.js";
import { withBackendPublicationAppendBarrierAsync, type BackendPublicationLockToken } from "../../src/storage/backend-publication.js";
import {
  classifySqliteSnapshotArtifact,
  SqliteSnapshotError,
  type SqliteSnapshotClassification,
} from "../../src/migration/sqlite-snapshot.js";
import { canonicalJson } from "../../src/storage/portable-record.js";
import { createMigrationManifest } from "../../src/migration/protocol.js";

const roots: string[] = [];

// classifyMigrationCandidateOccupancy now runtime-verifies the token via
// assertBackendPublicationConsumerAccess (section 4.9 exposure 1, layer 1),
// so every test that actually reaches that call uses a real token from
// withBackendPublicationAppendBarrierAsync below. This fixed placeholder
// remains valid only for the handful of tests whose input is rejected
// before the occupancy check ever runs (an overlong base, a missing base,
// an invalid probe-ordinal bound) — none of those consult the token.
const DUMMY_LOCK_TOKEN = {} as BackendPublicationLockToken;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "lcm-generation-identity-"));
  roots.push(home);
  mkdirSync(join(home, ".lcm"), { mode: 0o700 });
  return home;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function withChecksum(body: Record<string, unknown>): Record<string, unknown> {
  return { ...body, checksumSha256: sha256(canonicalJson(body)) };
}

/** Builds the minimal on-disk shape classifyInternal reads as "partial": an
 * intent registration only, no identity file, no generation directory. */
function writePartialSnapshotFixture(home: string, generationId: string): void {
  const root = join(home, ".lcm", "migration-snapshots");
  const registrations = join(root, "registrations");
  mkdirSync(root, { mode: 0o700 });
  mkdirSync(registrations, { mode: 0o700 });
  writeFileSync(
    join(registrations, `${generationId}.intent.json`),
    `${canonicalJson(withChecksum({ version: 1, generationId, requestSha256: "a".repeat(64) }))}\n`,
    { mode: 0o600 },
  );
}

/** Adds an identity registration on top of the partial fixture, with no
 * generation directory: classifyInternal reads this as "replaced" from the
 * two existence booleans alone, before ever reading identity content. */
function writeReplacedSnapshotFixture(home: string, generationId: string): void {
  writePartialSnapshotFixture(home, generationId);
  const registrations = join(home, ".lcm", "migration-snapshots", "registrations");
  writeFileSync(join(registrations, `${generationId}.identity.json`), "{}\n", { mode: 0o600 });
}

/** Adds a real generation directory on top of the replaced fixture so the
 * garbage identity content is actually read and rejected: classifyInternal
 * maps that internal failure to "tampered", not to a thrown error. */
function writeTamperedSnapshotFixture(home: string, generationId: string): void {
  writeReplacedSnapshotFixture(home, generationId);
  const generations = join(home, ".lcm", "migration-snapshots", "generations");
  mkdirSync(generations, { mode: 0o700 });
  mkdirSync(join(generations, generationId), { mode: 0o700 });
}

describe("nonSecretPostgreSqlTargetCoordinates", () => {
  it("extracts only host, port and database, never the credentials", () => {
    const result = nonSecretPostgreSqlTargetCoordinates("postgresql://scott:tiger@db.example:5544/appdb");
    expect(result).toEqual({ host: "db.example", port: 5544, database: "appdb" });
    expect(JSON.stringify(result)).not.toContain("scott");
    expect(JSON.stringify(result)).not.toContain("tiger");
  });

  it("defaults the port to 5432 when the URL omits it", () => {
    expect(nonSecretPostgreSqlTargetCoordinates("postgresql://db.example/appdb"))
      .toEqual({ host: "db.example", port: 5432, database: "appdb" });
  });

  it("rejects port 0 (red: without the check this parses as a valid target)", () => {
    expect(() => nonSecretPostgreSqlTargetCoordinates("postgresql://db.example:0/appdb"))
      .toThrow(MigrationIdentityError);
    try {
      nonSecretPostgreSqlTargetCoordinates("postgresql://db.example:0/appdb");
      throw new Error("expected throw");
    } catch (error) {
      expect((error as MigrationIdentityError).reason).toBe("invalid-input");
    }
  });

  it("rejects a missing URL", () => {
    expect(() => nonSecretPostgreSqlTargetCoordinates("")).toThrow(MigrationIdentityError);
  });

  it("rejects a malformed URL", () => {
    expect(() => nonSecretPostgreSqlTargetCoordinates("not a url")).toThrow(MigrationIdentityError);
  });

  it("rejects an empty host", () => {
    expect(() => nonSecretPostgreSqlTargetCoordinates("postgresql:///appdb")).toThrow(MigrationIdentityError);
  });

  it("rejects a missing database name", () => {
    expect(() => nonSecretPostgreSqlTargetCoordinates("postgresql://db.example/")).toThrow(MigrationIdentityError);
  });
});

describe("computeMigrationGenerationBase", () => {
  const base = { physicalProjectId: "project-1", canonicalPath: "/home/user/project", target: { host: "db.example", port: 5432, database: "appdb" } };

  it("is deterministic for identical input", () => {
    expect(computeMigrationGenerationBase(base)).toBe(computeMigrationGenerationBase({ ...base }));
  });

  it("changes when physicalProjectId changes, independently of the other fields (red: a base that ignores this input cannot fail this assertion)", () => {
    expect(computeMigrationGenerationBase({ ...base, physicalProjectId: "project-2" }))
      .not.toBe(computeMigrationGenerationBase(base));
  });

  it("changes when canonicalPath changes, independently of the other fields", () => {
    expect(computeMigrationGenerationBase({ ...base, canonicalPath: "/home/user/other" }))
      .not.toBe(computeMigrationGenerationBase(base));
  });

  it("changes when the target host changes, independently of the other fields", () => {
    expect(computeMigrationGenerationBase({ ...base, target: { ...base.target, host: "other.example" } }))
      .not.toBe(computeMigrationGenerationBase(base));
  });

  it("changes when the target port changes, independently of the other fields", () => {
    expect(computeMigrationGenerationBase({ ...base, target: { ...base.target, port: 5433 } }))
      .not.toBe(computeMigrationGenerationBase(base));
  });

  it("changes when the target database changes, independently of the other fields", () => {
    expect(computeMigrationGenerationBase({ ...base, target: { ...base.target, database: "otherdb" } }))
      .not.toBe(computeMigrationGenerationBase(base));
  });

  it("produces an identifier-safe, boundedly short prefix", () => {
    const id = computeMigrationGenerationBase(base);
    expect(id).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
    expect(id.length).toBeLessThan(100);
  });

  it("rejects a missing physicalProjectId", () => {
    expect(() => computeMigrationGenerationBase({ ...base, physicalProjectId: "" })).toThrow(MigrationIdentityError);
  });

  it("rejects a missing canonicalPath", () => {
    expect(() => computeMigrationGenerationBase({ ...base, canonicalPath: "" })).toThrow(MigrationIdentityError);
  });

  it("rejects a missing target", () => {
    expect(() => computeMigrationGenerationBase({ ...base, target: undefined as unknown as typeof base.target }))
      .toThrow(MigrationIdentityError);
  });

  it("rejects target coordinates that were not built through the URL extractor and are directly invalid", () => {
    const invalidTargets = [
      { host: "", port: 5432, database: "appdb" },
      { host: "db.example", port: 5432, database: "" },
      { host: "db.example", port: 0, database: "appdb" },
      { host: "db.example", port: -1, database: "appdb" },
      { host: "db.example", port: 70000, database: "appdb" },
      { host: "db.example", port: 1.5, database: "appdb" },
    ];
    for (const target of invalidTargets) {
      expect(() => computeMigrationGenerationBase({ ...base, target })).toThrow(MigrationIdentityError);
    }
  });
});

describe("classifyMigrationCandidateOccupancy (section 4.3 two-tree occupancy)", () => {
  it("refuses permit-mismatch for a dummy, non-live token, proving section 4.9 exposure 1 layer 1 is runtime-enforced and not only a compile-time signature (red: this is exactly what a token-shaped placeholder that satisfies the type but holds no real admission would slip past if this assertion were removed)", async () => {
    const home = makeHome();
    await expect(classifyMigrationCandidateOccupancy({ lockToken: DUMMY_LOCK_TOKEN, generationId: "generation-1", homeDir: home }))
      .rejects.toMatchObject({ reason: "permit-mismatch" });
  });

  it("accepts a real, live token acquired from withBackendPublicationAppendBarrierAsync (the positive control for the permit-mismatch test above: the same call succeeds once the token is genuinely active)", async () => {
    const home = makeHome();
    await withBackendPublicationAppendBarrierAsync(home, async (token) => {
      const result = await classifyMigrationCandidateOccupancy({ lockToken: token, generationId: "generation-1", homeDir: home });
      expect(result).toEqual({ status: "free" });
    });
  });

  it("is free when both trees are authoritatively absent", async () => {
    const home = makeHome();
    await withBackendPublicationAppendBarrierAsync(home, async (token) => {
      const result = await classifyMigrationCandidateOccupancy({ lockToken: token, generationId: "generation-1", homeDir: home });
      expect(result).toEqual({ status: "free" });
    });
  });

  it("is occupied when the snapshot is absent but the manifest is present (red: checking only the snapshot tree would wrongly free this candidate)", async () => {
    const home = makeHome();
    const store = new MigrationManifestStore({ homeDir: home });
    store.create(createMigrationManifest({
      generationId: "generation-1",
      source: { version: 1, backend: "sqlite", identitySha256: "1".repeat(64), schemaSha256: "2".repeat(64), contentSha256: "3".repeat(64), capturedAt: "2026-08-12T12:00:00.000Z" },
      destination: { version: 1, backend: "postgresql", identitySha256: "4".repeat(64), schemaSha256: "5".repeat(64), contentSha256: "6".repeat(64), capturedAt: "2026-08-12T12:00:00.000Z" },
      parentGenerationId: null,
      preservedSourceGenerationId: "generation-1",
      createdAt: "2026-08-12T12:00:00.000Z",
    }));
    await withBackendPublicationAppendBarrierAsync(home, async (token) => {
      const result = await classifyMigrationCandidateOccupancy({ lockToken: token, generationId: "generation-1", homeDir: home, manifestStore: store });
      expect(result).toEqual({ status: "occupied" });
    });
  });

  it("refuses when the manifest side is unresolvable, and never reports free (red: absence-by-catch would report free here)", async () => {
    const home = makeHome();
    const migrations = join(home, ".lcm", "migrations");
    mkdirSync(migrations, { mode: 0o700 });
    chmodSync(migrations, 0o755);
    let result: MigrationCandidateOccupancy;
    try {
      result = await withBackendPublicationAppendBarrierAsync(home, (token) =>
        classifyMigrationCandidateOccupancy({ lockToken: token, generationId: "generation-1", homeDir: home }));
    } finally {
      chmodSync(migrations, 0o700);
    }
    expect(result).toEqual({ status: "refuse", evidence: "manifest-internal-error" });
  });

  it("advances past a partial snapshot regardless of manifest state (evidence preserved, nothing deleted)", async () => {
    const home = makeHome();
    writePartialSnapshotFixture(home, "generation-1");
    // Positive control: confirm this really does classify as partial before
    // asking the occupancy function to interpret it.
    expect(await classifySqliteSnapshotArtifact("generation-1", { homeDir: home }))
      .toEqual({ state: "partial", generationId: "generation-1" });
    await withBackendPublicationAppendBarrierAsync(home, async (token) => {
      expect(await classifyMigrationCandidateOccupancy({ lockToken: token, generationId: "generation-1", homeDir: home }))
        .toEqual({ status: "occupied" });
    });
  });

  it("refuses a replaced snapshot rather than advancing past it (red: treating replaced like partial would occupy-not-refuse)", async () => {
    const home = makeHome();
    writeReplacedSnapshotFixture(home, "generation-1");
    expect(await classifySqliteSnapshotArtifact("generation-1", { homeDir: home }))
      .toEqual({ state: "replaced", generationId: "generation-1" });
    await withBackendPublicationAppendBarrierAsync(home, async (token) => {
      expect(await classifyMigrationCandidateOccupancy({ lockToken: token, generationId: "generation-1", homeDir: home }))
        .toEqual({ status: "refuse", evidence: "snapshot-replaced" });
    });
  });

  it("refuses a tampered snapshot rather than advancing past it", async () => {
    const home = makeHome();
    writeTamperedSnapshotFixture(home, "generation-1");
    expect(await classifySqliteSnapshotArtifact("generation-1", { homeDir: home }))
      .toEqual({ state: "tampered", generationId: "generation-1" });
    await withBackendPublicationAppendBarrierAsync(home, async (token) => {
      expect(await classifyMigrationCandidateOccupancy({ lockToken: token, generationId: "generation-1", homeDir: home }))
        .toEqual({ status: "refuse", evidence: "snapshot-tampered" });
    });
  });

  it("treats a complete snapshot as occupied without consulting the manifest tree", async () => {
    const home = makeHome();
    const fakeComplete: SqliteSnapshotClassification = { state: "complete", witness: {} as never };
    await withBackendPublicationAppendBarrierAsync(home, async (token) => {
      const result = await classifyMigrationCandidateOccupancy({ lockToken: token,
        generationId: "generation-1",
        homeDir: home,
        _operationsForTesting: { classifySnapshot: async () => fakeComplete },
      });
      expect(result).toEqual({ status: "occupied" });
    });
  });

  it("refuses when the real classifier throws its own typed error (a malformed generation id)", async () => {
    await expect(classifySqliteSnapshotArtifact("bad id", { homeDir: makeHome() }))
      .rejects.toBeInstanceOf(SqliteSnapshotError);
    const home = makeHome();
    await withBackendPublicationAppendBarrierAsync(home, async (token) => {
      const result = await classifyMigrationCandidateOccupancy({ lockToken: token, generationId: "bad id", homeDir: home });
      expect(result).toEqual({ status: "refuse", evidence: "snapshot-invalid-input" });
    });
  });

  it("propagates an unrecognised (non-SqliteSnapshotError) failure rather than fabricating evidence for it", async () => {
    const home = makeHome();
    await withBackendPublicationAppendBarrierAsync(home, async (token) => {
      await expect(classifyMigrationCandidateOccupancy({ lockToken: token,
        generationId: "generation-1",
        homeDir: home,
        _operationsForTesting: { classifySnapshot: async () => { throw new Error("unexpected shape"); } },
      })).rejects.toThrow("unexpected shape");
    });
  });
});

describe("resolveMigrationGenerationId (section 4.1 probe ordinal)", () => {
  it("takes ordinal 0 when nothing occupies it", async () => {
    const home = makeHome();
    await withBackendPublicationAppendBarrierAsync(home, async (token) => {
      const result = await resolveMigrationGenerationId({ lockToken: token, base: "base", homeDir: home });
      expect(result).toEqual({ generationId: "base-0", probedOrdinals: 1 });
    });
  });

  it("advances past occupied ordinals to the first free one, and this is the cutover-collision regression: completing generation N must mint N+1, never reuse N (red: a resolver that never advances would loop forever or reuse an occupied id)", async () => {
    const home = makeHome();
    const store = new MigrationManifestStore({ homeDir: home });
    for (const ordinal of [0, 1]) {
      store.create(createMigrationManifest({
        generationId: `base-${ordinal}`,
        source: { version: 1, backend: "sqlite", identitySha256: "1".repeat(64), schemaSha256: "2".repeat(64), contentSha256: "3".repeat(64), capturedAt: "2026-08-12T12:00:00.000Z" },
        destination: { version: 1, backend: "postgresql", identitySha256: "4".repeat(64), schemaSha256: "5".repeat(64), contentSha256: "6".repeat(64), capturedAt: "2026-08-12T12:00:00.000Z" },
        parentGenerationId: null,
        preservedSourceGenerationId: `base-${ordinal}`,
        createdAt: "2026-08-12T12:00:00.000Z",
      }));
    }
    await withBackendPublicationAppendBarrierAsync(home, async (token) => {
      const result = await resolveMigrationGenerationId({ lockToken: token, base: "base", homeDir: home, manifestStore: store });
      expect(result).toEqual({ generationId: "base-2", probedOrdinals: 3 });
    });
  });

  it("refuses probe-bound-exceeded rather than looping once every ordinal up to the bound is occupied", async () => {
    const home = makeHome();
    const store = new MigrationManifestStore({ homeDir: home });
    for (const ordinal of [0, 1]) {
      store.create(createMigrationManifest({
        generationId: `base-${ordinal}`,
        source: { version: 1, backend: "sqlite", identitySha256: "1".repeat(64), schemaSha256: "2".repeat(64), contentSha256: "3".repeat(64), capturedAt: "2026-08-12T12:00:00.000Z" },
        destination: { version: 1, backend: "postgresql", identitySha256: "4".repeat(64), schemaSha256: "5".repeat(64), contentSha256: "6".repeat(64), capturedAt: "2026-08-12T12:00:00.000Z" },
        parentGenerationId: null,
        preservedSourceGenerationId: `base-${ordinal}`,
        createdAt: "2026-08-12T12:00:00.000Z",
      }));
    }
    await withBackendPublicationAppendBarrierAsync(home, async (token) => {
      await expect(resolveMigrationGenerationId({ lockToken: token, base: "base", homeDir: home, manifestStore: store, maxProbeOrdinal: 1 }))
        .rejects.toMatchObject({ reason: "probe-bound-exceeded" });
    });
  });

  it("refuses identifier-bound-exceeded rather than minting an out-of-pattern or overlong id", async () => {
    const home = makeHome();
    const overlong = "x".repeat(127);
    await expect(resolveMigrationGenerationId({ lockToken: DUMMY_LOCK_TOKEN, base: overlong, homeDir: home }))
      .rejects.toMatchObject({ reason: "identifier-bound-exceeded" });
  });

  it("propagates occupancy refusal evidence rather than skipping a refused candidate", async () => {
    const home = makeHome();
    writeTamperedSnapshotFixture(home, "base-0");
    await withBackendPublicationAppendBarrierAsync(home, async (token) => {
      await expect(resolveMigrationGenerationId({ lockToken: token, base: "base", homeDir: home }))
        .rejects.toMatchObject({ reason: "occupancy-refused", evidence: "snapshot-tampered" });
    });
  });

  it("rejects a missing base identity", async () => {
    const home = makeHome();
    await expect(resolveMigrationGenerationId({ lockToken: DUMMY_LOCK_TOKEN, base: "", homeDir: home })).rejects.toBeInstanceOf(MigrationIdentityError);
  });

  it("rejects an invalid probe ordinal bound", async () => {
    const home = makeHome();
    await expect(resolveMigrationGenerationId({ lockToken: DUMMY_LOCK_TOKEN, base: "base", homeDir: home, maxProbeOrdinal: -1 }))
      .rejects.toBeInstanceOf(MigrationIdentityError);
  });

  it("uses the documented default probe bound when none is supplied", () => {
    expect(DEFAULT_MAX_PROBE_ORDINAL).toBeGreaterThan(0);
  });
});

describe("resolveConfirmedMigrationGenerationId (section 4.9 exposure 1, layer 2: re-verify immediately before the hold)", () => {
  it("confirms the candidate when nothing occupied it between the probe and the re-check", async () => {
    const home = makeHome();
    await withBackendPublicationAppendBarrierAsync(home, async (token) => {
      const result = await resolveConfirmedMigrationGenerationId({ base: "base", homeDir: home, lockToken: token });
      expect(result).toEqual({ status: "confirmed", generationId: "base-0", probedOrdinals: 1 });
    });
  });

  it("refuses when the candidate is occupied between the probe and the re-check, and this is exactly what a bare probe (no re-check) would miss (red-first, both directions in one test)", async () => {
    const home = makeHome();
    const real = new MigrationManifestStore({ homeDir: home });
    let calls = 0;
    const fakeStore = {
      probeManifestPresence: (id: string) => {
        calls += 1;
        // First call: the initial probe inside resolveMigrationGenerationId,
        // genuinely absent. Every call after that: the layer-2 re-check,
        // modelling a competitor that created a manifest for this exact
        // candidate in the gap between the two observations.
        return calls === 1 ? real.probeManifestPresence(id) : { status: "present" as const };
      },
    } as unknown as MigrationManifestStore;

    await withBackendPublicationAppendBarrierAsync(home, async (token) => {
      // Without the re-check (the defect this layer exists to catch): a bare
      // resolveMigrationGenerationId call only sees the first (stale)
      // observation and wrongly reports the candidate free.
      const bare = await resolveMigrationGenerationId({ base: "base", homeDir: home, lockToken: token, manifestStore: fakeStore });
      expect(bare).toEqual({ generationId: "base-0", probedOrdinals: 1 });

      calls = 0;
      const confirmed = await resolveConfirmedMigrationGenerationId({ base: "base", homeDir: home, lockToken: token, manifestStore: fakeStore });
      expect(confirmed).toEqual({ status: "refuse", reason: "occupied-since-probe" });
    });
  });

  it("refuses as unresolvable-since-probe, never as confirmed, when the re-check itself cannot be established", async () => {
    const home = makeHome();
    const real = new MigrationManifestStore({ homeDir: home });
    let calls = 0;
    const fakeStore = {
      probeManifestPresence: (id: string) => {
        calls += 1;
        return calls === 1
          ? real.probeManifestPresence(id)
          : { status: "unresolvable" as const, reason: "internal-error" as const };
      },
    } as unknown as MigrationManifestStore;
    await withBackendPublicationAppendBarrierAsync(home, async (token) => {
      const result = await resolveConfirmedMigrationGenerationId({ base: "base", homeDir: home, lockToken: token, manifestStore: fakeStore });
      expect(result).toEqual({ status: "refuse", reason: "unresolvable-since-probe", evidence: "manifest-internal-error" });
    });
  });
});
