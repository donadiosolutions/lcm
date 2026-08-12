import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  MigrationProtocolError,
  createMigrationManifest,
  migrationManifestCanonicalSha256,
  parseMigrationManifest,
  type MigrationCheckpoint,
  type MigrationManifest,
  type MigrationReportReference,
  type MigrationStorageWitness,
} from "../../src/migration/protocol.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const CREATED_AT = "2026-08-12T12:00:00.000Z";
const UPDATED_AT = "2026-08-12T12:00:01.000Z";

function witness(backend: MigrationStorageWitness["backend"], capturedAt: string): MigrationStorageWitness {
  return {
    version: 1,
    backend,
    identitySha256: HASH_A,
    schemaSha256: HASH_B,
    contentSha256: HASH_C,
    capturedAt,
  };
}

function createValidManifest(): MigrationManifest {
  return createMigrationManifest({
    generationId: "generation-1",
    source: witness("sqlite", CREATED_AT),
    destination: witness("postgresql", UPDATED_AT),
    parentGenerationId: null,
    preservedSourceGenerationId: "source-generation-1",
    createdAt: CREATED_AT,
  });
}

function unsignedManifest(manifest: MigrationManifest): Omit<MigrationManifest, "checksumSha256"> {
  const { checksumSha256: _checksum, ...payload } = manifest;
  return payload;
}

function sealManifest(
  manifest: MigrationManifest | Record<string, unknown>,
): MigrationManifest {
  const { checksumSha256: _checksum, ...payload } = manifest as MigrationManifest & Record<string, unknown>;
  return {
    ...payload,
    checksumSha256: migrationManifestCanonicalSha256(payload),
  } as MigrationManifest;
}

function expectProtocolError(
  callback: () => unknown,
  reason: MigrationProtocolError["reason"],
): void {
  try {
    callback();
    throw new Error("expected MigrationProtocolError");
  } catch (error) {
    expect(error).toBeInstanceOf(MigrationProtocolError);
    expect((error as MigrationProtocolError).reason).toBe(reason);
  }
}

function checkpoint(domain: string, ordinal: number): MigrationCheckpoint {
  return {
    domain,
    ordinal,
    recordCount: ordinal + 1,
    sourceCheckpointSha256: HASH_A,
    destinationCommitSha256: HASH_B,
  };
}

function report(
  reportId: string,
  kind: MigrationReportReference["kind"] = "dry-run",
  createdAt = CREATED_AT,
): MigrationReportReference {
  return { kind, reportId, reportSha256: HASH_C, createdAt };
}

describe("migration manifest protocol", () => {
  it("creates the exact genesis defaults and a lowercase canonical seal", () => {
    const manifest = createValidManifest();

    expect(manifest).toEqual({
      version: 1,
      generationId: "generation-1",
      revision: 0,
      phase: "planned",
      source: witness("sqlite", CREATED_AT),
      destination: witness("postgresql", UPDATED_AT),
      checkpoints: [],
      reports: [],
      activationEligible: false,
      rollbackLineage: {
        parentGenerationId: null,
        preservedSourceGenerationId: "source-generation-1",
        mode: null,
        returnPhase: null,
      },
      pendingEffect: null,
      previousManifestSha256: null,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      checksumSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(manifest.checksumSha256).toBe(
      migrationManifestCanonicalSha256(unsignedManifest(manifest)),
    );
    expect(JSON.stringify(manifest)).not.toMatch(/[^\x00-\x7F]/u);
  });

  it("canonicalizes checkpoint and report collection order and deeply freezes returned copies", () => {
    const genesis = createValidManifest();
    const checkpoints = [checkpoint("alpha", 1), checkpoint("zulu", 2)];
    const reports = [
      report("report-a", "dry-run", "2026-08-12T12:00:02.000Z"),
      report("report-b", "verification", "2026-08-12T12:00:03.000Z"),
    ];
    const parsed = parseMigrationManifest(sealManifest({
      ...genesis,
      checkpoints: [...checkpoints].reverse(),
      reports: [...reports].reverse(),
      updatedAt: UPDATED_AT,
      checksumSha256: "0".repeat(64),
    }));

    expect(parsed.checkpoints.map((item) => item.domain)).toEqual(["alpha", "zulu"]);
    expect(parsed.reports.map((item) => item.reportId)).toEqual(["report-a", "report-b"]);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.checkpoints)).toBe(true);
    expect(Object.isFrozen(parsed.checkpoints[0])).toBe(true);
    expect(Object.isFrozen(parsed.reports)).toBe(true);
    expect(Object.isFrozen(parsed.reports[0])).toBe(true);
    expect(Object.isFrozen(parsed.source)).toBe(true);
    expect(() => (parsed.checkpoints as MigrationCheckpoint[]).push(checkpoint("new", 3))).toThrow();
  });

  it("reproduces the same seal when object keys are reordered", () => {
    const manifest = createValidManifest();
    const reordered = {
      checksumSha256: manifest.checksumSha256,
      updatedAt: manifest.updatedAt,
      createdAt: manifest.createdAt,
      previousManifestSha256: manifest.previousManifestSha256,
      pendingEffect: manifest.pendingEffect,
      rollbackLineage: manifest.rollbackLineage,
      activationEligible: manifest.activationEligible,
      reports: manifest.reports,
      checkpoints: manifest.checkpoints,
      destination: manifest.destination,
      source: manifest.source,
      phase: manifest.phase,
      revision: manifest.revision,
      generationId: manifest.generationId,
      version: manifest.version,
    };

    expect(migrationManifestCanonicalSha256(unsignedManifest(manifest))).toBe(
      migrationManifestCanonicalSha256(unsignedManifest(reordered as MigrationManifest)),
    );
    expect(parseMigrationManifest(reordered)).toEqual(manifest);
    expect(parseMigrationManifest(JSON.stringify(manifest))).toEqual(manifest);
  });

  it.each([
    ["unknown top-level key", { extra: true }],
    ["non-ASCII persisted text", { generationId: "génération-1" }],
    ["wrong version", { version: 2 }],
    ["unsafe generation identifier", { generationId: "-unsafe" }],
    ["invalid created date", { createdAt: "2026-08-12" }],
    ["invalid source hash width", { source: { ...witness("sqlite", CREATED_AT), identitySha256: "a" } }],
    ["uppercase checksum", { checksumSha256: "A".repeat(64) }],
    ["negative revision", { revision: -1 }],
    ["fractional revision", { revision: 0.5 }],
    ["unsafe revision", { revision: Number.MAX_SAFE_INTEGER + 1 }],
    ["wrong source backend", { source: { ...witness("sqlite", CREATED_AT), backend: "mysql" } }],
    ["duplicate report ID", { reports: [report("same"), report("same", "verification", UPDATED_AT)] }],
    ["duplicate checkpoint domain", { checkpoints: [checkpoint("same", 0), checkpoint("same", 1)] }],
  ] as const)("rejects %s", (_name, overrides) => {
    const manifest = createValidManifest();
    const candidate = {
      ...manifest,
      ...overrides,
      checksumSha256: "0".repeat(64),
    };
    if (_name === "uppercase checksum") candidate.checksumSha256 = overrides.checksumSha256;
    expectProtocolError(() => parseMigrationManifest(candidate), "malformed-manifest");
  });

  it("rejects a manifest whose top-level key is absent rather than undefined", () => {
    const manifest = createValidManifest();
    const candidate: Record<string, unknown> = { ...manifest };
    delete candidate.updatedAt;
    expect("updatedAt" in candidate).toBe(false);
    expectProtocolError(() => parseMigrationManifest(candidate), "malformed-manifest");
  });

  it("accepts equal ordinals across distinct checkpoint domains", () => {
    const manifest = createValidManifest();
    const parsed = parseMigrationManifest(sealManifest({
      ...manifest,
      checkpoints: [checkpoint("alpha", 0), checkpoint("zulu", 0)],
      checksumSha256: "0".repeat(64),
    }));

    expect(parsed.checkpoints.map((item) => [item.domain, item.ordinal])).toEqual([["alpha", 0], ["zulu", 0]]);
  });

  it.each([
    ["unsafe effect identifier", { effectId: "effect/unsafe" }],
    ["unsafe report identifier", { reportId: "report unsafe" }],
    ["unsafe checkpoint domain", { domain: "domain unsafe" }],
  ] as const)("rejects %s", (_name, mutation) => {
    const manifest = createValidManifest();
    const pendingEffect = {
      effectId: "effect-1",
      kind: "verify-dry-run" as const,
      fromPhase: "planned" as const,
      targetPhase: "dry-run-verified" as const,
      inputSha256: HASH_A,
      recovery: "retry-idempotent" as const,
      startedAt: CREATED_AT,
    };
    const candidate = sealManifest({
      ...manifest,
      pendingEffect: {
        ...pendingEffect,
        ...("effectId" in mutation ? mutation : {}),
      },
      reports: [report("report-1")],
      checkpoints: [checkpoint("domain-1", 0)],
    });
    if ("reportId" in mutation) candidate.reports[0] = { ...candidate.reports[0], reportId: mutation.reportId };
    if ("domain" in mutation) candidate.checkpoints[0] = { ...candidate.checkpoints[0], domain: mutation.domain };
    expectProtocolError(() => parseMigrationManifest(candidate), "malformed-manifest");
  });

  it.each([
    ["negative record count", { recordCount: -1 }],
    ["fractional ordinal", { ordinal: 1.5 }],
    ["unsafe report timestamp", { createdAt: "not-a-date" }],
    ["uppercase nested hash", { sourceCheckpointSha256: HASH_A.toUpperCase() }],
  ] as const)("rejects %s", (_name, mutation) => {
    const manifest = createValidManifest();
    const candidate = sealManifest({
      ...manifest,
      checkpoints: [{
        ...checkpoint("domain-1", 0),
        ...("recordCount" in mutation ? mutation : {}),
        ...("ordinal" in mutation ? mutation : {}),
        ...("sourceCheckpointSha256" in mutation ? mutation : {}),
      }],
      reports: [{
        ...report("report-1"),
        ...( "createdAt" in mutation ? mutation : {}),
      }],
    });
    expectProtocolError(() => parseMigrationManifest(candidate), "malformed-manifest");
  });

  it("rejects persisted non-ASCII JSON before semantic parsing", () => {
    const manifest = createValidManifest();
    const persisted = JSON.stringify({ ...manifest, generationId: "génération-1" });
    expectProtocolError(() => parseMigrationManifest(persisted), "malformed-manifest");
  });

  it("rejects malformed and recursive checksum payloads", () => {
    const manifest = createValidManifest();
    expectProtocolError(() => parseMigrationManifest("{"), "malformed-manifest");
    expectProtocolError(() => parseMigrationManifest(null), "malformed-manifest");
    expectProtocolError(() => parseMigrationManifest({
      ...manifest,
      checksumSha256: migrationManifestCanonicalSha256(manifest),
    }), "checksum-mismatch");
    expectProtocolError(() => parseMigrationManifest({
      ...manifest,
      checksumSha256: "0".repeat(64),
    }), "checksum-mismatch");
  });

  it.each([
    ["revision zero with predecessor", { previousManifestSha256: HASH_A }],
    ["later revision without predecessor", { revision: 1, previousManifestSha256: null }],
    ["rolled-back with pending effect", {
      phase: "rolled-back",
      pendingEffect: {
        effectId: "effect-1",
        kind: "publish-rollback",
        fromPhase: "rolling-back",
        targetPhase: "rolled-back",
        inputSha256: HASH_A,
        recovery: "authoritative-readback-required",
        startedAt: CREATED_AT,
      },
    }],
    ["aborted with pending effect", {
      phase: "aborted",
      pendingEffect: {
        effectId: "effect-1",
        kind: "abort",
        fromPhase: "planned",
        targetPhase: "aborted",
        inputSha256: HASH_A,
        recovery: "retry-idempotent",
        startedAt: CREATED_AT,
      },
    }],
    ["pending from phase mismatch", {
      pendingEffect: {
        effectId: "effect-1",
        kind: "verify-dry-run",
        fromPhase: "copying",
        targetPhase: "dry-run-verified",
        inputSha256: HASH_A,
        recovery: "retry-idempotent",
        startedAt: CREATED_AT,
      },
    }],
    ["pending target mismatch", {
      pendingEffect: {
        effectId: "effect-1",
        kind: "verify-dry-run",
        fromPhase: "planned",
        targetPhase: "copying",
        inputSha256: HASH_A,
        recovery: "retry-idempotent",
        startedAt: CREATED_AT,
      },
    }],
    ["pending recovery mismatch", {
      pendingEffect: {
        effectId: "effect-1",
        kind: "copy-batch",
        fromPhase: "planned",
        targetPhase: "copying",
        inputSha256: HASH_A,
        recovery: "retry-idempotent",
        startedAt: CREATED_AT,
      },
    }],
    ["activation eligible in planned", { activationEligible: true }],
    ["activation eligible without verification report", { phase: "verified", activationEligible: true }],
    ["activation eligible in copying", {
      phase: "copying",
      activationEligible: true,
      reports: [report("report-1", "verification")],
    }],
    ["rollback return phase without prepare state", {
      rollbackLineage: {
        parentGenerationId: null,
        preservedSourceGenerationId: "source-generation-1",
        mode: null,
        returnPhase: "active",
      },
    }],
    ["rollback mode before terminal phase", {
      rollbackLineage: {
        parentGenerationId: null,
        preservedSourceGenerationId: "source-generation-1",
        mode: "post-write",
        returnPhase: "active",
      },
    }],
  ] as const)("rejects cross-field mutation: %s", (_name, overrides) => {
    const manifest = createValidManifest();
    const candidate = sealManifest({ ...manifest, ...overrides });
    expectProtocolError(() => parseMigrationManifest(candidate), "malformed-manifest");
  });

  it("rejects a canonical hash request for non-JSON-compatible values", () => {
    expect(() => migrationManifestCanonicalSha256(undefined)).toThrow(TypeError);
    expect(() => migrationManifestCanonicalSha256(Number.NaN)).toThrow(TypeError);
    expect(() => migrationManifestCanonicalSha256({ value: BigInt(1) })).toThrow(TypeError);
    expect(() => migrationManifestCanonicalSha256({ value: new Date(CREATED_AT) })).toThrow(TypeError);
    expect(createHash("sha256").update("{}").digest("hex")).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("rejects cyclic values when computing a canonical hash", () => {
    const cyclicObject: Record<string, unknown> = {};
    cyclicObject.self = cyclicObject;
    const cyclicArray: unknown[] = [];
    cyclicArray.push(cyclicArray);

    expect(() => migrationManifestCanonicalSha256(cyclicObject)).toThrow(TypeError);
    expect(() => migrationManifestCanonicalSha256(cyclicArray)).toThrow(TypeError);
    expect(() => migrationManifestCanonicalSha256(Object.create(null) as object)).not.toThrow();
  });

  it("normalizes negative zero and preserves stable order for equal collection keys", () => {
    expect(migrationManifestCanonicalSha256({ value: -0 })).toBe(migrationManifestCanonicalSha256({ value: 0 }));

    const duplicateOrder = [
      report("report-a", "dry-run", CREATED_AT),
      report("report-a", "dry-run", CREATED_AT),
    ];
    expect(migrationManifestCanonicalSha256({ reports: duplicateOrder })).toBe(
      migrationManifestCanonicalSha256({ reports: [...duplicateOrder].reverse() }),
    );

    const equalCheckpoints = [checkpoint("alpha", 3), checkpoint("alpha", 3)];
    expect(migrationManifestCanonicalSha256({ checkpoints: equalCheckpoints })).toBe(
      migrationManifestCanonicalSha256({ checkpoints: [...equalCheckpoints].reverse() }),
    );

    const sameDomain = [checkpoint("alpha", 1), checkpoint("alpha", 2)];
    expect(migrationManifestCanonicalSha256({ checkpoints: sameDomain })).toBe(
      migrationManifestCanonicalSha256({ checkpoints: [...sameDomain].reverse() }),
    );
  });

  it("leaves malformed collections unsorted when normalizing a canonical hash", () => {
    expect(migrationManifestCanonicalSha256({ checkpoints: [{ domain: 1, ordinal: "x" }] })).toMatch(/^[0-9a-f]{64}$/u);
    expect(migrationManifestCanonicalSha256({ reports: [{ kind: 1 }] })).toMatch(/^[0-9a-f]{64}$/u);
    expect(migrationManifestCanonicalSha256("plain")).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("accepts a 128-character identifier and rejects a 129-character identifier", () => {
    const maximum = `g${"a".repeat(127)}`;
    const overflow = `g${"a".repeat(128)}`;
    expect(maximum).toHaveLength(128);
    expect(overflow).toHaveLength(129);

    const accepted = createMigrationManifest({
      generationId: maximum,
      source: witness("sqlite", CREATED_AT),
      destination: witness("postgresql", UPDATED_AT),
      parentGenerationId: null,
      preservedSourceGenerationId: "source-generation-1",
      createdAt: CREATED_AT,
    });
    expect(accepted.generationId).toBe(maximum);

    expectProtocolError(() => createMigrationManifest({
      generationId: overflow,
      source: witness("sqlite", CREATED_AT),
      destination: witness("postgresql", UPDATED_AT),
      parentGenerationId: null,
      preservedSourceGenerationId: "source-generation-1",
      createdAt: CREATED_AT,
    }), "invalid-input");
  });

  it("rejects invalid creation input with invalid-input", () => {
    const valid = {
      generationId: "generation-1",
      source: witness("sqlite", CREATED_AT),
      destination: witness("postgresql", UPDATED_AT),
      parentGenerationId: null,
      preservedSourceGenerationId: "source-generation-1",
      createdAt: CREATED_AT,
    };

    expectProtocolError(() => createMigrationManifest(null as never), "invalid-input");
    expectProtocolError(() => createMigrationManifest({ ...valid, extra: true } as never), "invalid-input");
    const { createdAt: _omitted, ...missing } = valid;
    expectProtocolError(() => createMigrationManifest(missing as never), "invalid-input");
    expectProtocolError(() => createMigrationManifest({ ...valid, generationId: "-bad" }), "invalid-input");
    expectProtocolError(() => createMigrationManifest({ ...valid, parentGenerationId: "bad id" }), "invalid-input");
    expectProtocolError(() => createMigrationManifest({ ...valid, preservedSourceGenerationId: "" }), "invalid-input");
    expectProtocolError(() => createMigrationManifest({ ...valid, createdAt: "2026-08-12" }), "invalid-input");
    expectProtocolError(
      () => createMigrationManifest({ ...valid, source: { ...witness("sqlite", CREATED_AT), version: 2 } as never }),
      "invalid-input",
    );
    expectProtocolError(
      () => createMigrationManifest({ ...valid, source: { ...witness("sqlite", CREATED_AT), backend: "mysql" } as never }),
      "invalid-input",
    );
    expectProtocolError(
      () => createMigrationManifest({ ...valid, source: { ...witness("sqlite", CREATED_AT), capturedAt: "nope" } }),
      "invalid-input",
    );
    expectProtocolError(
      () => createMigrationManifest({ ...valid, destination: { ...witness("postgresql", UPDATED_AT), schemaSha256: HASH_A.toUpperCase() } }),
      "invalid-input",
    );
    expectProtocolError(
      () => createMigrationManifest({ ...valid, destination: { ...witness("postgresql", UPDATED_AT), contentSha256: "abc" } }),
      "invalid-input",
    );
    expectProtocolError(() => createMigrationManifest({ ...valid, destination: null as never }), "invalid-input");
    expectProtocolError(
      () => createMigrationManifest({ ...valid, source: { identitySha256: HASH_A } as never }),
      "invalid-input",
    );

    const parentLinked = createMigrationManifest({ ...valid, parentGenerationId: "generation-0" });
    expect(parentLinked.rollbackLineage.parentGenerationId).toBe("generation-0");
  });

  it("accepts valid rolling-back and rolled-back terminal lineage", () => {
    const genesis = createValidManifest();
    const base = {
      ...genesis,
      revision: 4,
      previousManifestSha256: HASH_A,
      reports: [report("report-1", "verification")],
      activationEligible: true,
      updatedAt: UPDATED_AT,
    };

    const rollingBack = parseMigrationManifest(sealManifest({
      ...base,
      phase: "rolling-back",
      rollbackLineage: {
        parentGenerationId: null,
        preservedSourceGenerationId: "source-generation-1",
        mode: null,
        returnPhase: "active",
      },
    }));
    expect(rollingBack.phase).toBe("rolling-back");
    expect(rollingBack.rollbackLineage.returnPhase).toBe("active");
    expect(rollingBack.rollbackLineage.mode).toBeNull();

    const rolledBack = parseMigrationManifest(sealManifest({
      ...base,
      phase: "rolled-back",
      rollbackLineage: {
        parentGenerationId: null,
        preservedSourceGenerationId: "source-generation-1",
        mode: "post-write",
        returnPhase: "active",
      },
    }));
    expect(rolledBack.phase).toBe("rolled-back");
    expect(rolledBack.rollbackLineage.mode).toBe("post-write");
    expect(rolledBack.rollbackLineage.returnPhase).toBe("active");

    expectProtocolError(() => parseMigrationManifest(sealManifest({
      ...base,
      phase: "rolled-back",
      rollbackLineage: {
        parentGenerationId: null,
        preservedSourceGenerationId: "source-generation-1",
        mode: null,
        returnPhase: "active",
      },
    })), "malformed-manifest");

    expectProtocolError(() => parseMigrationManifest(sealManifest({
      ...base,
      phase: "rolled-back",
      rollbackLineage: {
        parentGenerationId: null,
        preservedSourceGenerationId: "source-generation-1",
        mode: "pre-write",
        returnPhase: null,
      },
    })), "malformed-manifest");

    expectProtocolError(() => parseMigrationManifest(sealManifest({
      ...base,
      phase: "rolling-back",
      rollbackLineage: {
        parentGenerationId: null,
        preservedSourceGenerationId: "source-generation-1",
        mode: "pre-write",
        returnPhase: "verified",
      },
    })), "malformed-manifest");
  });

  it.each([
    ["planned", "verify-dry-run", "dry-run-verified", "retry-idempotent"],
    ["dry-run-verified", "copy-batch", "copying", "authoritative-readback-required"],
    ["copying", "copy-batch", "copying", "authoritative-readback-required"],
    ["copying", "complete-copy", "copied", "authoritative-readback-required"],
    ["copied", "verify-generation", "verified", "retry-idempotent"],
    ["verified", "prepare-activation", "activating", "retry-idempotent"],
    ["activating", "publish-activation", "active", "authoritative-readback-required"],
    ["verified", "prepare-rollback", "rolling-back", "retry-idempotent"],
    ["active", "prepare-rollback", "rolling-back", "retry-idempotent"],
    ["rolling-back", "publish-rollback", "rolled-back", "authoritative-readback-required"],
    ["planned", "abort", "aborted", "retry-idempotent"],
    ["dry-run-verified", "abort", "aborted", "retry-idempotent"],
    ["copying", "abort", "aborted", "retry-idempotent"],
    ["copied", "abort", "aborted", "retry-idempotent"],
    ["verified", "abort", "aborted", "retry-idempotent"],
  ] as const)("accepts pending %s -> %s", (phase, kind, targetPhase, recovery) => {
    const genesis = createValidManifest();
    const eligible = phase === "verified" || phase === "activating" || phase === "active" || phase === "rolling-back";
    const parsed = parseMigrationManifest(sealManifest({
      ...genesis,
      revision: 2,
      previousManifestSha256: HASH_A,
      phase,
      reports: eligible ? [report("report-1", "verification")] : [],
      activationEligible: eligible,
      rollbackLineage: {
        parentGenerationId: null,
        preservedSourceGenerationId: "source-generation-1",
        mode: null,
        returnPhase: phase === "rolling-back" ? "active" : null,
      },
      pendingEffect: {
        effectId: "effect-1",
        kind,
        fromPhase: phase,
        targetPhase,
        inputSha256: HASH_A,
        recovery,
        startedAt: CREATED_AT,
      },
      updatedAt: UPDATED_AT,
    }));

    expect(parsed.pendingEffect).toEqual({
      effectId: "effect-1",
      kind,
      fromPhase: phase,
      targetPhase,
      inputSha256: HASH_A,
      recovery,
      startedAt: CREATED_AT,
    });
  });

  it.each([
    ["illegal effect for phase", "planned", "publish-activation"],
    ["abort from activating", "activating", "abort"],
    ["abort from rolling-back", "rolling-back", "abort"],
    ["copy-batch from planned", "planned", "copy-batch"],
  ] as const)("rejects pending %s", (_name, phase, kind) => {
    const genesis = createValidManifest();
    const eligible = phase === "activating" || phase === "rolling-back";
    expectProtocolError(() => parseMigrationManifest(sealManifest({
      ...genesis,
      revision: 2,
      previousManifestSha256: HASH_A,
      phase,
      reports: eligible ? [report("report-1", "verification")] : [],
      activationEligible: eligible,
      rollbackLineage: {
        parentGenerationId: null,
        preservedSourceGenerationId: "source-generation-1",
        mode: null,
        returnPhase: phase === "rolling-back" ? "active" : null,
      },
      pendingEffect: {
        effectId: "effect-1",
        kind,
        fromPhase: phase,
        targetPhase: "aborted",
        inputSha256: HASH_A,
        recovery: "retry-idempotent",
        startedAt: CREATED_AT,
      },
      updatedAt: UPDATED_AT,
    })), "malformed-manifest");
  });

  it("rejects every invalid rollback lineage field", () => {
    const manifest = createValidManifest();
    const lineage = {
      parentGenerationId: null as string | null,
      preservedSourceGenerationId: "source-generation-1",
      mode: null as string | null,
      returnPhase: null as string | null,
    };

    for (const overrides of [
      { parentGenerationId: "bad id" },
      { preservedSourceGenerationId: "-bad" },
      { mode: "sideways" },
      { returnPhase: "copying" },
    ]) {
      expectProtocolError(
        () => parseMigrationManifest(sealManifest({ ...manifest, rollbackLineage: { ...lineage, ...overrides } })),
        "malformed-manifest",
      );
    }

    const withParent = parseMigrationManifest(sealManifest({
      ...manifest,
      rollbackLineage: { ...lineage, parentGenerationId: "generation-0" },
    }));
    expect(withParent.rollbackLineage.parentGenerationId).toBe("generation-0");
  });
});
