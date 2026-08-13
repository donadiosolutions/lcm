import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MigrationProtocolError,
  assertMigrationManifestGenesis,
  assertMigrationManifestSuccessor,
  abandonMigrationEffect,
  beginMigrationEffect,
  completeMigrationEffect,
  classifyMigrationRecovery,
  createMigrationManifest,
  migrationManifestCanonicalSha256,
  parseMigrationManifest,
  type MigrationCheckpoint,
  type BeginMigrationEffectInput,
  type CompleteMigrationEffectInput,
  type AbandonMigrationEffectInput,
  type MigrationManifest,
  type MigrationReportReference,
  type MigrationStorageWitness,
} from "../../src/migration/protocol.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const CREATED_AT = "2026-08-12T12:00:00.000Z";
const UPDATED_AT = "2026-08-12T12:00:01.000Z";
const EFFECT_AT = "2026-08-12T12:00:02.000Z";
const COMPLETE_AT = "2026-08-12T12:00:03.000Z";

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

function manifestInPhase(phase: "dry-run-verified" | "copying"): MigrationManifest {
  const manifest = createValidManifest();
  return parseMigrationManifest(sealManifest({
    ...manifest,
    revision: 1,
    previousManifestSha256: manifest.checksumSha256,
    phase,
    updatedAt: UPDATED_AT,
  }));
}

function beginFrom(
  manifest: MigrationManifest,
  kind: BeginMigrationEffectInput["kind"],
  effectId = `effect-${kind}`,
): MigrationManifest {
  return beginMigrationEffect(manifest, {
    effectId,
    kind,
    inputSha256: HASH_A,
    startedAt: EFFECT_AT,
  });
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

  it("accepts only the exact genesis state for headless recovery", () => {
    const genesis = createValidManifest();
    expect(assertMigrationManifestGenesis(genesis)).toEqual(genesis);
    for (const [candidate, reason] of [
      [sealManifest({ ...genesis, updatedAt: UPDATED_AT }), "unexpected-state"],
      [sealManifest({ ...genesis, phase: "aborted" }), "unexpected-state"],
      [sealManifest({ ...genesis, activationEligible: true }), "malformed-manifest"],
      [sealManifest({ ...genesis, checkpoints: [checkpoint("forged", 1)] }), "unexpected-state"],
      [sealManifest({ ...genesis, reports: [report("forged-report")] }), "unexpected-state"],
      [sealManifest({
        ...genesis,
        rollbackLineage: { ...genesis.rollbackLineage, mode: "pre-write" },
      }), "malformed-manifest"],
    ]) {
      expectProtocolError(
        () => assertMigrationManifestGenesis(candidate as MigrationManifest),
        reason as MigrationProtocolError["reason"],
      );
    }
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

  it.each([
    ["revision", { revision: -0 }],
    ["checkpoint ordinal", { checkpoints: [{ ...checkpoint("domain-1", 1), ordinal: -0 }] }],
    ["checkpoint record count", { checkpoints: [{ ...checkpoint("domain-1", 1), recordCount: -0 }] }],
  ] as const)("rejects negative zero persisted semantic integers during parsing: %s", (_label, overrides) => {
    const persisted = sealManifest({ ...createValidManifest(), ...overrides });
    expectProtocolError(() => parseMigrationManifest(persisted), "malformed-manifest");
  });

  it.each([
    ["checkpoint ordinal", "ordinal"],
    ["checkpoint record count", "recordCount"],
  ] as const)("rejects negative zero semantic integers while creating completion successors: %s", (_label, field) => {
    const pending = beginFrom(manifestInPhase("copying"), "copy-batch");
    const invalidCheckpoint = { ...checkpoint("domain-1", 1), [field]: -0 } as MigrationCheckpoint;
    expectProtocolError(() => completeMigrationEffect(pending, {
      effectId: pending.pendingEffect!.effectId,
      completedAt: COMPLETE_AT,
      checkpoint: invalidCheckpoint,
    }), "invalid-input");
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

  it.each([
    ["sqlite -> postgresql", "sqlite", "postgresql", true],
    ["postgresql -> sqlite", "postgresql", "sqlite", false],
    ["sqlite -> sqlite", "sqlite", "sqlite", false],
    ["postgresql -> postgresql", "postgresql", "postgresql", false],
  ] as const)("enforces the positional backend direction during creation: %s", (
    _label,
    sourceBackend,
    destinationBackend,
    valid,
  ) => {
    const input = {
      generationId: "backend-direction-create",
      source: witness(sourceBackend, CREATED_AT),
      destination: witness(destinationBackend, UPDATED_AT),
      parentGenerationId: null,
      preservedSourceGenerationId: "source-generation-1",
      createdAt: CREATED_AT,
    };

    if (valid) {
      const created = createMigrationManifest(input);
      expect(created.source.backend).toBe("sqlite");
      expect(created.destination.backend).toBe("postgresql");
      expect(created.source.identitySha256).toBe(created.destination.identitySha256);
      expect(created).not.toHaveProperty("role");
      return;
    }

    expectProtocolError(() => createMigrationManifest(input), "invalid-input");
  });

  it.each([
    ["sqlite -> postgresql", "sqlite", "postgresql", true],
    ["postgresql -> sqlite", "postgresql", "sqlite", false],
    ["sqlite -> sqlite", "sqlite", "sqlite", false],
    ["postgresql -> postgresql", "postgresql", "postgresql", false],
  ] as const)("enforces the positional backend direction while parsing persisted manifests: %s", (
    _label,
    sourceBackend,
    destinationBackend,
    valid,
  ) => {
    const baseline = createValidManifest();
    const persisted = sealManifest({
      ...baseline,
      source: witness(sourceBackend, CREATED_AT),
      destination: witness(destinationBackend, UPDATED_AT),
    });

    if (valid) {
      const parsed = parseMigrationManifest(persisted);
      expect(parsed.source.backend).toBe("sqlite");
      expect(parsed.destination.backend).toBe("postgresql");
      expect(parsed.source.identitySha256).toBe(parsed.destination.identitySha256);
      expect(parsed).not.toHaveProperty("role");
      return;
    }

    expectProtocolError(() => parseMigrationManifest(persisted), "malformed-manifest");
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

    expectProtocolError(() => parseMigrationManifest(sealManifest({
      ...base,
      phase: "rolling-back",
      rollbackLineage: {
        parentGenerationId: null,
        preservedSourceGenerationId: "source-generation-1",
        mode: null,
        returnPhase: null,
      },
    })), "malformed-manifest");
  });

  it("authenticates only exact public-reducer successors", () => {
    const initial = createValidManifest();
    const begun = beginMigrationEffect(initial, {
      effectId: "effect-successor",
      kind: "verify-dry-run",
      inputSha256: HASH_A,
      startedAt: EFFECT_AT,
    });
    expect(assertMigrationManifestSuccessor(initial, begun)).toEqual(begun);
    const completed = completeMigrationEffect(begun, {
      effectId: "effect-successor",
      completedAt: COMPLETE_AT,
      report: report("report-successor", "dry-run", COMPLETE_AT),
    });
    expect(assertMigrationManifestSuccessor(begun, completed)).toEqual(completed);

    const copyBase = manifestInPhase("dry-run-verified");
    const copyPending = beginMigrationEffect(copyBase, {
      effectId: "copy-successor",
      kind: "copy-batch",
      inputSha256: HASH_A,
      startedAt: EFFECT_AT,
    });
    const firstCheckpoint = completeMigrationEffect(copyPending, {
      effectId: "copy-successor",
      completedAt: COMPLETE_AT,
      checkpoint: checkpoint("messages", 1),
    });
    expect(assertMigrationManifestSuccessor(copyPending, firstCheckpoint)).toEqual(firstCheckpoint);
    const nextCopyPending = beginMigrationEffect(firstCheckpoint, {
      effectId: "copy-successor-next",
      kind: "copy-batch",
      inputSha256: HASH_B,
      startedAt: "2026-08-12T12:00:04.000Z",
    });
    const replacedCheckpoint = completeMigrationEffect(nextCopyPending, {
      effectId: "copy-successor-next",
      completedAt: "2026-08-12T12:00:05.000Z",
      checkpoint: checkpoint("messages", 2),
    });
    expect(assertMigrationManifestSuccessor(nextCopyPending, replacedCheckpoint))
      .toEqual(replacedCheckpoint);

    const verified = parseMigrationManifest(sealManifest({
      ...initial,
      revision: 4,
      previousManifestSha256: HASH_A,
      phase: "verified",
      reports: [report("verified-successor", "verification", UPDATED_AT)],
      activationEligible: true,
      updatedAt: UPDATED_AT,
    }));
    const preparing = beginMigrationEffect(verified, {
      effectId: "prepare-successor",
      kind: "prepare-activation",
      inputSha256: HASH_A,
      startedAt: EFFECT_AT,
    });
    const activating = completeMigrationEffect(preparing, {
      effectId: "prepare-successor",
      completedAt: COMPLETE_AT,
    });
    const publishing = beginMigrationEffect(activating, {
      effectId: "publish-successor",
      kind: "publish-activation",
      inputSha256: HASH_B,
      startedAt: "2026-08-12T12:00:04.000Z",
    });
    const abandoned = abandonMigrationEffect(publishing, {
      effectId: "publish-successor",
      abandonedAt: "2026-08-12T12:00:05.000Z",
      report: {
        kind: "abandonment",
        reportId: "abandon-successor",
        reportSha256: HASH_C,
        createdAt: "2026-08-12T12:00:05.000Z",
      },
    });
    expect(assertMigrationManifestSuccessor(publishing, abandoned)).toEqual(abandoned);
    const copied = parseMigrationManifest(sealManifest({
      ...initial,
      revision: 2,
      previousManifestSha256: HASH_A,
      phase: "copied",
      updatedAt: UPDATED_AT,
    }));
    const verifyPending = beginMigrationEffect(copied, {
      effectId: "verify-successor",
      kind: "verify-generation",
      inputSha256: HASH_A,
      startedAt: EFFECT_AT,
    });
    const verifiedSuccessor = completeMigrationEffect(verifyPending, {
      effectId: "verify-successor",
      completedAt: COMPLETE_AT,
      report: report("verify-successor-report", "verification", COMPLETE_AT),
      activationEligible: true,
    });
    expect(assertMigrationManifestSuccessor(verifyPending, verifiedSuccessor))
      .toEqual(verifiedSuccessor);

    const rolling = completeMigrationEffect(beginMigrationEffect(verifiedSuccessor, {
      effectId: "prepare-rollback-successor",
      kind: "prepare-rollback",
      inputSha256: HASH_A,
      startedAt: "2026-08-12T12:00:04.000Z",
    }), {
      effectId: "prepare-rollback-successor",
      completedAt: "2026-08-12T12:00:05.000Z",
    });
    const rollbackPending = beginMigrationEffect(rolling, {
      effectId: "publish-rollback-successor",
      kind: "publish-rollback",
      inputSha256: HASH_B,
      startedAt: "2026-08-12T12:00:06.000Z",
    });
    const rolledBack = completeMigrationEffect(rollbackPending, {
      effectId: "publish-rollback-successor",
      completedAt: "2026-08-12T12:00:07.000Z",
      report: report("rollback-successor-report", "rollback", "2026-08-12T12:00:07.000Z"),
      rollbackMode: "pre-write",
    });
    expect(assertMigrationManifestSuccessor(rollbackPending, rolledBack)).toEqual(rolledBack);

    for (const candidate of [
      sealManifest({ ...begun, source: witness("postgresql", CREATED_AT) }),
      sealManifest({ ...begun, phase: "dry-run-verified", pendingEffect: null }),
      sealManifest({ ...begun, reports: [report("injected", "dry-run")] }),
      sealManifest({ ...begun, checkpoints: [checkpoint("injected", 1)] }),
    ]) {
      expectProtocolError(
        () => assertMigrationManifestSuccessor(initial, candidate),
        "unexpected-state",
      );
    }
    expectProtocolError(
      () => assertMigrationManifestSuccessor(initial, initial),
      "unexpected-state",
    );
    expectProtocolError(
      () => assertMigrationManifestSuccessor(begun, sealManifest({
        ...completed,
        pendingEffect: {
          effectId: "illegal-second-pending",
          kind: "copy-batch",
          fromPhase: "dry-run-verified",
          targetPhase: "copying",
          inputSha256: HASH_A,
          recovery: "authoritative-readback-required",
          startedAt: "2026-08-12T12:00:04.000Z",
        },
      })),
      "unexpected-state",
    );
    expectProtocolError(
      () => assertMigrationManifestSuccessor(begun, sealManifest({
        ...completed,
        reports: [],
      })),
      "unexpected-state",
    );
    expectProtocolError(
      () => assertMigrationManifestSuccessor(begun, sealManifest({
        ...completed,
        reports: [report("wrong-abandonment", "abandonment", COMPLETE_AT)],
      })),
      "unexpected-state",
    );
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

  describe("beginMigrationEffect", () => {
    const verifyInput: BeginMigrationEffectInput = {
      effectId: "effect-1",
      kind: "verify-dry-run",
      inputSha256: HASH_A,
      startedAt: EFFECT_AT,
    };

    it("seals a new immutable pending-effect revision without mutating the input", () => {
      const manifest = createValidManifest();
      const next = beginMigrationEffect(manifest, verifyInput);

      expect(next).toMatchObject({
        revision: 1,
        phase: "planned",
        previousManifestSha256: manifest.checksumSha256,
        updatedAt: EFFECT_AT,
        pendingEffect: {
          ...verifyInput,
          fromPhase: "planned",
          targetPhase: "dry-run-verified",
          recovery: "retry-idempotent",
        },
      });
      expect(next.checksumSha256).toBe(migrationManifestCanonicalSha256(unsignedManifest(next)));
      expect(next.source).toEqual(manifest.source);
      expect(next.destination).toEqual(manifest.destination);
      expect(next.checkpoints).toEqual(manifest.checkpoints);
      expect(next.reports).toEqual(manifest.reports);
      expect(next.version).toBe(manifest.version);
      expect(next.generationId).toBe(manifest.generationId);
      expect(next.createdAt).toBe(manifest.createdAt);
      expect(next.activationEligible).toBe(manifest.activationEligible);
      expect(next.rollbackLineage).toEqual(manifest.rollbackLineage);
      expect(manifest.pendingEffect).toBeNull();
      expect(Object.isFrozen(next.pendingEffect)).toBe(true);
    });

    it("derives authoritative readback for a legal copy effect", () => {
      const manifest = manifestInPhase("dry-run-verified");
      const next = beginMigrationEffect(manifest, {
        effectId: "copy-1",
        kind: "copy-batch",
        inputSha256: HASH_B,
        startedAt: EFFECT_AT,
      });

      expect(next.pendingEffect).toMatchObject({
        fromPhase: "dry-run-verified",
        targetPhase: "copying",
        recovery: "authoritative-readback-required",
      });
    });

    it("rejects a second pending effect and illegal phase-effect pairs", () => {
      const pending = beginMigrationEffect(createValidManifest(), verifyInput);
      expectProtocolError(() => beginMigrationEffect(pending, { ...verifyInput, effectId: "effect-2" }), "unexpected-state");
      expectProtocolError(() => beginMigrationEffect(createValidManifest(), {
        ...verifyInput,
        kind: "publish-activation",
      }), "unexpected-state");
    });

    it.each([
      ["invalid input shape", { extra: true }],
      ["invalid effect id", { effectId: "-bad" }],
      ["invalid input hash", { inputSha256: "A".repeat(64) }],
      ["invalid started time", { startedAt: "2026-08-12" }],
    ] as const)("rejects %s", (_name, overrides) => {
      expectProtocolError(
        () => beginMigrationEffect(createValidManifest(), { ...verifyInput, ...overrides }),
        "invalid-input",
      );
    });

    it("rejects a timestamp older than the current manifest", () => {
      const manifest = manifestInPhase("copying");
      expectProtocolError(() => beginMigrationEffect(manifest, {
        effectId: "copy-2",
        kind: "copy-batch",
        inputSha256: HASH_B,
        startedAt: CREATED_AT,
      }), "unexpected-state");
    });

    it("rejects revision overflow", () => {
      const manifest = createValidManifest();
      const exhausted = parseMigrationManifest(sealManifest({
        ...manifest,
        revision: Number.MAX_SAFE_INTEGER,
        previousManifestSha256: HASH_A,
        updatedAt: UPDATED_AT,
      }));
      expectProtocolError(() => beginMigrationEffect(exhausted, verifyInput), "unexpected-state");
    });

    it("exhaustively accepts only the legal phase-effect pairs and never mutates rejected inputs", () => {
      const phases = [
        "planned", "dry-run-verified", "copying", "copied", "verified",
        "activating", "active", "rolling-back", "rolled-back", "aborted",
      ] as const;
      const effects = [
        "verify-dry-run", "copy-batch", "complete-copy", "verify-generation",
        "prepare-activation", "publish-activation", "prepare-rollback",
        "publish-rollback", "abort",
      ] as const;
      const legalPairs = new Set([
        "planned:verify-dry-run",
        "dry-run-verified:copy-batch",
        "copying:copy-batch",
        "copying:complete-copy",
        "copied:verify-generation",
        "verified:prepare-activation",
        "activating:publish-activation",
        "verified:prepare-rollback",
        "active:prepare-rollback",
        "rolling-back:publish-rollback",
        "planned:abort",
        "dry-run-verified:abort",
        "copying:abort",
        "copied:abort",
        "verified:abort",
      ]);
      const genesis = createValidManifest();

      for (const phase of phases) {
        const eligible = ["verified", "activating", "active", "rolling-back", "rolled-back"].includes(phase);
        const manifest = parseMigrationManifest(sealManifest({
          ...genesis,
          revision: 1,
          phase,
          previousManifestSha256: genesis.checksumSha256,
          reports: eligible ? [report("verification-exhaustive", "verification", UPDATED_AT)] : [],
          activationEligible: eligible,
          rollbackLineage: {
            ...genesis.rollbackLineage,
            mode: phase === "rolled-back" ? "pre-write" : null,
            returnPhase: phase === "rolling-back" || phase === "rolled-back" ? "active" : null,
          },
          updatedAt: UPDATED_AT,
        }));
        for (const kind of effects) {
          const key = `${phase}:${kind}`;
          const before = JSON.stringify(manifest);
          const invoke = () => beginMigrationEffect(manifest, {
            effectId: `effect-${phase}-${kind}`,
            kind,
            inputSha256: HASH_A,
            startedAt: EFFECT_AT,
          });
          if (legalPairs.has(key)) {
            expect(invoke().pendingEffect?.kind, key).toBe(kind);
          } else {
            expectProtocolError(invoke, "unexpected-state");
            expect(JSON.stringify(manifest), key).toBe(before);
          }
        }
      }
    });
  });

  describe("completeMigrationEffect", () => {
    it("completes dry-run verification with the exact report and linked revision", () => {
      const pending = beginFrom(createValidManifest(), "verify-dry-run");
      const dryRunReport = report("dry-run-1", "dry-run", COMPLETE_AT);
      const next = completeMigrationEffect(pending, {
        effectId: "effect-verify-dry-run",
        completedAt: COMPLETE_AT,
        report: dryRunReport,
      });

      expect(next).toMatchObject({
        revision: pending.revision + 1,
        phase: "dry-run-verified",
        previousManifestSha256: pending.checksumSha256,
        updatedAt: COMPLETE_AT,
        pendingEffect: null,
        reports: [dryRunReport],
        activationEligible: false,
      });
      expect(next.checksumSha256).toBe(migrationManifestCanonicalSha256(unsignedManifest(next)));
      expect(pending.pendingEffect).not.toBeNull();
      expect(next.version).toBe(pending.version);
      expect(next.generationId).toBe(pending.generationId);
      expect(next.createdAt).toBe(pending.createdAt);
      expect(next.source).toEqual(pending.source);
      expect(next.destination).toEqual(pending.destination);
      expect(next.rollbackLineage).toEqual(pending.rollbackLineage);
    });

    it("publishes a monotonic per-domain copy checkpoint", () => {
      const current = manifestInPhase("dry-run-verified");
      const first = completeMigrationEffect(beginFrom(current, "copy-batch", "copy-1"), {
        effectId: "copy-1",
        completedAt: COMPLETE_AT,
        checkpoint: checkpoint("messages", 1),
      });
      const second = completeMigrationEffect(beginMigrationEffect(first, {
        effectId: "copy-2",
        kind: "copy-batch",
        inputSha256: HASH_B,
        startedAt: "2026-08-12T12:00:04.000Z",
      }), {
        effectId: "copy-2",
        completedAt: "2026-08-12T12:00:05.000Z",
        checkpoint: checkpoint("messages", 2),
      });

      expect(first.phase).toBe("copying");
      expect(second.checkpoints).toEqual([checkpoint("messages", 2)]);
      expectProtocolError(() => completeMigrationEffect(beginMigrationEffect(second, {
        effectId: "copy-3",
        kind: "copy-batch",
        inputSha256: HASH_C,
        startedAt: "2026-08-12T12:00:06.000Z",
      }), {
        effectId: "copy-3",
        completedAt: "2026-08-12T12:00:07.000Z",
        checkpoint: checkpoint("messages", 2),
      }), "unexpected-state");
      expectProtocolError(() => completeMigrationEffect(beginMigrationEffect(second, {
        effectId: "copy-4",
        kind: "copy-batch",
        inputSha256: HASH_C,
        startedAt: "2026-08-12T12:00:08.000Z",
      }), {
        effectId: "copy-4",
        completedAt: "2026-08-12T12:00:09.000Z",
        checkpoint: {
          ...checkpoint("messages", 3),
          recordCount: 1,
        },
      }), "unexpected-state");
      const copied = completeMigrationEffect(beginMigrationEffect(second, {
        effectId: "copy-complete",
        kind: "complete-copy",
        inputSha256: HASH_C,
        startedAt: "2026-08-12T12:00:10.000Z",
      }), {
        effectId: "copy-complete",
        completedAt: "2026-08-12T12:00:11.000Z",
      });
      expect(copied.phase).toBe("copied");
    });

    it("completes verification, activation boundaries, and activation publication", () => {
      const genesis = createValidManifest();
      const copied = parseMigrationManifest(sealManifest({
        ...genesis,
        revision: 1,
        phase: "copied",
        previousManifestSha256: genesis.checksumSha256,
        updatedAt: UPDATED_AT,
      }));
      const verified = completeMigrationEffect(beginFrom(copied, "verify-generation", "verify-1"), {
        effectId: "verify-1",
        completedAt: COMPLETE_AT,
        report: report("verify-report", "verification", COMPLETE_AT),
        activationEligible: true,
      });
      const activating = completeMigrationEffect(beginMigrationEffect(verified, {
        effectId: "prepare-1",
        kind: "prepare-activation",
        inputSha256: HASH_B,
        startedAt: "2026-08-12T12:00:04.000Z",
      }), {
        effectId: "prepare-1",
        completedAt: "2026-08-12T12:00:05.000Z",
      });
      const active = completeMigrationEffect(beginMigrationEffect(activating, {
        effectId: "publish-1",
        kind: "publish-activation",
        inputSha256: HASH_C,
        startedAt: "2026-08-12T12:00:06.000Z",
      }), {
        effectId: "publish-1",
        completedAt: "2026-08-12T12:00:07.000Z",
        report: report("activation-report", "activation", "2026-08-12T12:00:07.000Z"),
      });

      expect(verified).toMatchObject({ phase: "verified", activationEligible: true });
      expect(activating).toMatchObject({ phase: "activating", activationEligible: true });
      expect(active).toMatchObject({ phase: "active", activationEligible: true });
    });

    it("seals rollback return phase and terminal mode", () => {
      const genesis = createValidManifest();
      const verified = parseMigrationManifest(sealManifest({
        ...genesis,
        revision: 1,
        phase: "verified",
        previousManifestSha256: genesis.checksumSha256,
        reports: [report("verify-report", "verification")],
        activationEligible: true,
        updatedAt: UPDATED_AT,
      }));
      const rolling = completeMigrationEffect(beginFrom(verified, "prepare-rollback", "prepare-rb"), {
        effectId: "prepare-rb",
        completedAt: COMPLETE_AT,
      });
      const rolledBack = completeMigrationEffect(beginMigrationEffect(rolling, {
        effectId: "publish-rb",
        kind: "publish-rollback",
        inputSha256: HASH_B,
        startedAt: "2026-08-12T12:00:04.000Z",
      }), {
        effectId: "publish-rb",
        completedAt: "2026-08-12T12:00:05.000Z",
        report: report("rollback-report", "rollback", "2026-08-12T12:00:05.000Z"),
        rollbackMode: "pre-write",
      });
      const rolledBackPostWrite = completeMigrationEffect(beginMigrationEffect(rolling, {
        effectId: "publish-rb-post-write",
        kind: "publish-rollback",
        inputSha256: HASH_C,
        startedAt: "2026-08-12T12:00:06.000Z",
      }), {
        effectId: "publish-rb-post-write",
        completedAt: "2026-08-12T12:00:07.000Z",
        report: report("rollback-report-post-write", "rollback", "2026-08-12T12:00:07.000Z"),
        rollbackMode: "post-write",
      });

      expect(rolling.rollbackLineage.returnPhase).toBe("verified");
      expect(rolledBack).toMatchObject({
        phase: "rolled-back",
        rollbackLineage: { returnPhase: "verified", mode: "pre-write" },
      });
      expect(rolledBackPostWrite.rollbackLineage.mode).toBe("post-write");
    });

    it("requires the exact pending effect and completion evidence", () => {
      const pending = beginFrom(createValidManifest(), "verify-dry-run");
      expectProtocolError(() => completeMigrationEffect(pending, {
        effectId: "wrong",
        completedAt: COMPLETE_AT,
        report: report("dry-run-1", "dry-run", COMPLETE_AT),
      }), "unexpected-state");
      expectProtocolError(() => completeMigrationEffect(pending, {
        effectId: "effect-verify-dry-run",
        completedAt: COMPLETE_AT,
      }), "invalid-input");
      expectProtocolError(() => completeMigrationEffect(pending, {
        effectId: "effect-verify-dry-run",
        completedAt: COMPLETE_AT,
        checkpoint: checkpoint("messages", 1),
        report: report("dry-run-1", "dry-run", COMPLETE_AT),
      }), "invalid-input");
      expectProtocolError(() => completeMigrationEffect(pending, {
        effectId: "effect-verify-dry-run",
        completedAt: COMPLETE_AT,
        report: report("wrong-kind", "verification", COMPLETE_AT),
      }), "invalid-input");
      expectProtocolError(() => completeMigrationEffect(createValidManifest(), {
        effectId: "effect-verify-dry-run",
        completedAt: COMPLETE_AT,
        report: report("dry-run-1", "dry-run", COMPLETE_AT),
      }), "unexpected-state");
    });

    it.each([
      ["invalid shape", null],
      ["surplus field", { effectId: "effect-verify-dry-run", completedAt: COMPLETE_AT, extra: true }],
      ["invalid effect id", { effectId: "-bad", completedAt: COMPLETE_AT }],
      ["invalid completion time", { effectId: "effect-verify-dry-run", completedAt: "2026-08-12" }],
      ["invalid eligibility type", { effectId: "effect-verify-dry-run", completedAt: COMPLETE_AT, activationEligible: "yes" }],
      ["invalid rollback mode", { effectId: "effect-verify-dry-run", completedAt: COMPLETE_AT, rollbackMode: "sideways" }],
    ] as const)("rejects %s completion input", (_name, candidate) => {
      const pending = beginFrom(createValidManifest(), "verify-dry-run");
      expectProtocolError(
        () => completeMigrationEffect(pending, candidate as unknown as CompleteMigrationEffectInput),
        "invalid-input",
      );
    });

    it("rejects exhausted revisions and report timestamps outside the effect", () => {
      const pending = beginFrom(createValidManifest(), "verify-dry-run");
      const exhausted = parseMigrationManifest(sealManifest({
        ...pending,
        revision: Number.MAX_SAFE_INTEGER,
        previousManifestSha256: HASH_A,
      }));
      expectProtocolError(() => completeMigrationEffect(exhausted, {
        effectId: "effect-verify-dry-run",
        completedAt: COMPLETE_AT,
        report: report("dry-run-1", "dry-run", COMPLETE_AT),
      }), "unexpected-state");
      for (const createdAt of [UPDATED_AT, "2026-08-12T12:00:04.000Z"]) {
        expectProtocolError(() => completeMigrationEffect(pending, {
          effectId: "effect-verify-dry-run",
          completedAt: COMPLETE_AT,
          report: report(`dry-run-${createdAt}`, "dry-run", createdAt),
        }), "invalid-input");
      }
    });

    it("rejects duplicate report identities", () => {
      const genesis = createValidManifest();
      const withReport = parseMigrationManifest(sealManifest({
        ...genesis,
        reports: [report("dry-run-1", "dry-run", CREATED_AT)],
      }));
      const pending = beginFrom(withReport, "verify-dry-run");
      expectProtocolError(() => completeMigrationEffect(pending, {
        effectId: "effect-verify-dry-run",
        completedAt: COMPLETE_AT,
        report: report("dry-run-1", "dry-run", COMPLETE_AT),
      }), "unexpected-state");
    });

    it("completes abort with sanitized evidence and rejects timestamp regression", () => {
      const pending = beginFrom(createValidManifest(), "abort", "abort-1");
      const aborted = completeMigrationEffect(pending, {
        effectId: "abort-1",
        completedAt: COMPLETE_AT,
        report: report("abort-report", "abort", COMPLETE_AT),
      });
      expect(aborted.phase).toBe("aborted");
      expectProtocolError(() => completeMigrationEffect(pending, {
        effectId: "abort-1",
        completedAt: CREATED_AT,
        report: report("abort-report", "abort", CREATED_AT),
      }), "unexpected-state");
    });
  });

  describe("abandonMigrationEffect", () => {
    function verifiedManifest(): MigrationManifest {
      const genesis = createValidManifest();
      return parseMigrationManifest(sealManifest({
        ...genesis,
        revision: 1,
        phase: "verified",
        previousManifestSha256: genesis.checksumSha256,
        reports: [report("verification-1", "verification", UPDATED_AT)],
        activationEligible: true,
        updatedAt: UPDATED_AT,
      }));
    }

    function abandonment(effectId: string, abandonedAt: string): AbandonMigrationEffectInput {
      return {
        effectId,
        abandonedAt,
        report: report(`abandon-${effectId}`, "abandonment", abandonedAt) as AbandonMigrationEffectInput["report"],
      };
    }

    it("returns a negatively-read-back activation publication to verified", () => {
      const verified = verifiedManifest();
      const activating = completeMigrationEffect(beginMigrationEffect(verified, {
        effectId: "prepare-a",
        kind: "prepare-activation",
        inputSha256: HASH_A,
        startedAt: EFFECT_AT,
      }), {
        effectId: "prepare-a",
        completedAt: COMPLETE_AT,
      });
      const pending = beginMigrationEffect(activating, {
        effectId: "publish-a",
        kind: "publish-activation",
        inputSha256: HASH_B,
        startedAt: "2026-08-12T12:00:04.000Z",
      });
      const next = abandonMigrationEffect(pending, abandonment("publish-a", "2026-08-12T12:00:05.000Z"));

      expect(next).toMatchObject({
        revision: pending.revision + 1,
        phase: "verified",
        activationEligible: true,
        pendingEffect: null,
        previousManifestSha256: pending.checksumSha256,
        updatedAt: "2026-08-12T12:00:05.000Z",
      });
      expect(next.reports.some((item) => item.kind === "abandonment")).toBe(true);
      expect(beginMigrationEffect(next, {
        effectId: "prepare-a-2",
        kind: "prepare-activation",
        inputSha256: HASH_C,
        startedAt: "2026-08-12T12:00:06.000Z",
      }).pendingEffect?.kind).toBe("prepare-activation");
    });

    it.each(["verified", "active"] as const)("returns rollback publication to sealed %s phase", (returnPhase) => {
      const base = returnPhase === "verified"
        ? verifiedManifest()
        : parseMigrationManifest(sealManifest({
          ...verifiedManifest(),
          revision: 2,
          phase: "active",
          previousManifestSha256: HASH_A,
          updatedAt: EFFECT_AT,
        }));
      const rolling = completeMigrationEffect(beginMigrationEffect(base, {
        effectId: `prepare-r-${returnPhase}`,
        kind: "prepare-rollback",
        inputSha256: HASH_A,
        startedAt: COMPLETE_AT,
      }), {
        effectId: `prepare-r-${returnPhase}`,
        completedAt: "2026-08-12T12:00:04.000Z",
      });
      const pending = beginMigrationEffect(rolling, {
        effectId: `publish-r-${returnPhase}`,
        kind: "publish-rollback",
        inputSha256: HASH_B,
        startedAt: "2026-08-12T12:00:05.000Z",
      });
      const next = abandonMigrationEffect(pending, abandonment(
        `publish-r-${returnPhase}`,
        "2026-08-12T12:00:06.000Z",
      ));
      expect(next).toMatchObject({
        phase: returnPhase,
        activationEligible: true,
        pendingEffect: null,
        rollbackLineage: { returnPhase: null, mode: null },
      });
    });

    it("rejects non-publication effects and mismatched identities", () => {
      const retryPending = beginFrom(createValidManifest(), "verify-dry-run");
      expectProtocolError(
        () => abandonMigrationEffect(retryPending, abandonment("effect-verify-dry-run", COMPLETE_AT)),
        "unexpected-state",
      );
      const verified = verifiedManifest();
      const activating = completeMigrationEffect(beginMigrationEffect(verified, {
        effectId: "prepare-a",
        kind: "prepare-activation",
        inputSha256: HASH_A,
        startedAt: EFFECT_AT,
      }), { effectId: "prepare-a", completedAt: COMPLETE_AT });
      const pending = beginMigrationEffect(activating, {
        effectId: "publish-a",
        kind: "publish-activation",
        inputSha256: HASH_B,
        startedAt: "2026-08-12T12:00:04.000Z",
      });
      expectProtocolError(
        () => abandonMigrationEffect(pending, abandonment("wrong-effect", "2026-08-12T12:00:05.000Z")),
        "unexpected-state",
      );
    });

    it("rejects malformed evidence and timestamps outside the pending effect", () => {
      const verified = verifiedManifest();
      const activating = completeMigrationEffect(beginMigrationEffect(verified, {
        effectId: "prepare-a",
        kind: "prepare-activation",
        inputSha256: HASH_A,
        startedAt: EFFECT_AT,
      }), { effectId: "prepare-a", completedAt: COMPLETE_AT });
      const pending = beginMigrationEffect(activating, {
        effectId: "publish-a",
        kind: "publish-activation",
        inputSha256: HASH_B,
        startedAt: "2026-08-12T12:00:04.000Z",
      });
      expectProtocolError(() => abandonMigrationEffect(pending, {
        ...abandonment("publish-a", "2026-08-12T12:00:05.000Z"),
        report: report("wrong", "abort", "2026-08-12T12:00:05.000Z") as AbandonMigrationEffectInput["report"],
      }), "invalid-input");
      for (const abandonedAt of [COMPLETE_AT, "2026-08-12T12:00:06.000Z"]) {
        const input = abandonedAt === COMPLETE_AT
          ? abandonment("publish-a", abandonedAt)
          : {
            ...abandonment("publish-a", abandonedAt),
            report: report("bad-report-time", "abandonment", "2026-08-12T12:00:07.000Z") as AbandonMigrationEffectInput["report"],
          };
        expectProtocolError(() => abandonMigrationEffect(pending, input), abandonedAt === COMPLETE_AT ? "unexpected-state" : "invalid-input");
      }
    });

    it.each([
      ["invalid shape", null],
      ["surplus field", { ...abandonment("publish-a", "2026-08-12T12:00:05.000Z"), extra: true }],
      ["invalid effect id", { ...abandonment("publish-a", "2026-08-12T12:00:05.000Z"), effectId: "-bad" }],
      ["invalid abandonment time", { ...abandonment("publish-a", "2026-08-12T12:00:05.000Z"), abandonedAt: "2026-08-12" }],
    ] as const)("rejects %s abandonment input", (_name, candidate) => {
      expectProtocolError(
        () => abandonMigrationEffect(createValidManifest(), candidate as unknown as AbandonMigrationEffectInput),
        "invalid-input",
      );
    });

    it("rejects exhausted abandonment revisions and missing rollback return lineage", () => {
      const verified = verifiedManifest();
      const activating = completeMigrationEffect(beginMigrationEffect(verified, {
        effectId: "prepare-a",
        kind: "prepare-activation",
        inputSha256: HASH_A,
        startedAt: EFFECT_AT,
      }), { effectId: "prepare-a", completedAt: COMPLETE_AT });
      const pendingActivation = beginMigrationEffect(activating, {
        effectId: "publish-a",
        kind: "publish-activation",
        inputSha256: HASH_B,
        startedAt: "2026-08-12T12:00:04.000Z",
      });
      const exhausted = parseMigrationManifest(sealManifest({
        ...pendingActivation,
        revision: Number.MAX_SAFE_INTEGER,
        previousManifestSha256: HASH_A,
      }));
      expectProtocolError(
        () => abandonMigrationEffect(exhausted, abandonment("publish-a", "2026-08-12T12:00:05.000Z")),
        "unexpected-state",
      );

    });
  });

  describe("classifyMigrationRecovery", () => {
    it("classifies ready and settled manifests without touching live storage", () => {
      const root = mkdtempSync(join(tmpdir(), "lcm-migration-classifier-"));
      try {
        const marker = join(root, "mutable-live-tree");
        writeFileSync(marker, "before", "utf8");
        expect(classifyMigrationRecovery(createValidManifest())).toEqual({ action: "ready" });

        const verified = parseMigrationManifest(sealManifest({
          ...createValidManifest(),
          revision: 1,
          phase: "verified",
          previousManifestSha256: HASH_A,
          reports: [report("verification-1", "verification")],
          activationEligible: true,
          updatedAt: UPDATED_AT,
        }));
        const active = completeMigrationEffect(beginMigrationEffect(
          completeMigrationEffect(beginMigrationEffect(verified, {
            effectId: "prepare-a",
            kind: "prepare-activation",
            inputSha256: HASH_A,
            startedAt: EFFECT_AT,
          }), { effectId: "prepare-a", completedAt: COMPLETE_AT }),
          {
            effectId: "publish-a",
            kind: "publish-activation",
            inputSha256: HASH_B,
            startedAt: "2026-08-12T12:00:04.000Z",
          },
        ), {
          effectId: "publish-a",
          completedAt: "2026-08-12T12:00:05.000Z",
          report: report("activation-1", "activation", "2026-08-12T12:00:05.000Z"),
        });
        writeFileSync(marker, "after", "utf8");
        expect(classifyMigrationRecovery(active)).toEqual({ action: "settled", phase: "active" });

        const aborted = completeMigrationEffect(beginFrom(createValidManifest(), "abort", "abort-1"), {
          effectId: "abort-1",
          completedAt: COMPLETE_AT,
          report: report("abort-1", "abort", COMPLETE_AT),
        });
        expect(classifyMigrationRecovery(aborted)).toEqual({ action: "settled", phase: "aborted" });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("classifies retry-idempotent effects for resume", () => {
      const pending = beginFrom(createValidManifest(), "verify-dry-run");
      expect(classifyMigrationRecovery(pending)).toEqual({ action: "resume", effect: pending.pendingEffect });
    });

    it("classifies uncertain durable effects for authoritative readback", () => {
      const pending = beginMigrationEffect(manifestInPhase("dry-run-verified"), {
        effectId: "copy-1",
        kind: "copy-batch",
        inputSha256: HASH_A,
        startedAt: EFFECT_AT,
      });
      expect(classifyMigrationRecovery(pending)).toEqual({ action: "readback", effect: pending.pendingEffect });
    });

    it("reports rolled-back terminal lineage as settled", () => {
      const genesis = createValidManifest();
      const rolledBack = parseMigrationManifest(sealManifest({
        ...genesis,
        revision: 4,
        phase: "rolled-back",
        previousManifestSha256: HASH_A,
        reports: [
          report("verification-1", "verification"),
          report("rollback-1", "rollback", UPDATED_AT),
        ],
        activationEligible: true,
        rollbackLineage: {
          ...genesis.rollbackLineage,
          mode: "post-write",
          returnPhase: "active",
        },
        updatedAt: UPDATED_AT,
      }));
      expect(classifyMigrationRecovery(rolledBack)).toEqual({ action: "settled", phase: "rolled-back" });
    });
  });
});
