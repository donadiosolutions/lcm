import { describe, expect, it } from "vitest";
import {
  buildMigrationEnvelope,
  sanitizeMigrationEvidence,
  serializeMigrationEnvelope,
  MigrationEnvelopeError,
  type MigrationEvidence,
} from "../../src/migration/envelope.js";

describe("buildMigrationEnvelope (section 10's eleven-field envelope)", () => {
  it("builds a minimal envelope with every field present, defaults filled to null/empty", () => {
    const envelope = buildMigrationEnvelope({
      command: "plan",
      outcome: "ok",
      exitCode: 0,
      applied: false,
    });
    expect(Object.keys(envelope).sort()).toEqual(
      [
        "schemaVersion", "command", "outcome", "exitCode", "generation",
        "manifestPhase", "applied", "next", "evidence", "refusal", "restart",
      ].sort(),
    );
    expect(envelope.schemaVersion).toBe(1);
    expect(envelope.generation).toBeNull();
    expect(envelope.manifestPhase).toBeNull();
    expect(envelope.next).toBeNull();
    expect(envelope.evidence).toEqual({});
    expect(envelope.refusal).toBeNull();
    expect(envelope.restart).toBeNull();
  });

  it("carries through every optional field when supplied", () => {
    const envelope = buildMigrationEnvelope({
      command: "apply",
      outcome: "refused-precondition",
      exitCode: 2,
      generation: "gen-1",
      manifestPhase: "captured",
      applied: true,
      next: "abort",
      evidence: { digest: "abc123" },
      refusal: { reason: "journal-unresolvable", remedy: "run lcm migration abort" },
      restart: { answer: "unresolvable", presence: "absent" },
    });
    expect(envelope.generation).toBe("gen-1");
    expect(envelope.manifestPhase).toBe("captured");
    expect(envelope.applied).toBe(true);
    expect(envelope.next).toBe("abort");
    expect(envelope.evidence).toEqual({ digest: "abc123" });
    expect(envelope.refusal).toEqual({ reason: "journal-unresolvable", remedy: "run lcm migration abort" });
    expect(envelope.restart).toEqual({ answer: "unresolvable", presence: "absent" });
  });

  it("refuses when outcome and exitCode disagree (red: this is the construction-time invariant, not a consumer re-check)", () => {
    expect(() =>
      buildMigrationEnvelope({ command: "plan", outcome: "ok", exitCode: 2, applied: false }),
    ).toThrow(MigrationEnvelopeError);
    expect(() =>
      buildMigrationEnvelope({ command: "plan", outcome: "ok", exitCode: 2, applied: false }),
    ).toThrow(/does not agree with exitCode/);
  });

  it("agrees for every one of the nine exit classes (a construction-time round trip through the real table)", () => {
    const pairs: Array<[string, number]> = [
      ["ok", 0], ["usage", 1], ["refused-precondition", 2], ["refused-confirmation", 3],
      ["refused-contention", 4], ["refused-evidence", 5], ["incomplete-recoverable", 6],
      ["failed-operator-required", 7], ["restart-required", 8],
    ];
    for (const [outcome, exitCode] of pairs) {
      expect(() =>
        buildMigrationEnvelope({
          command: "apply",
          outcome: outcome as never,
          exitCode: exitCode as never,
          applied: false,
        }),
      ).not.toThrow();
    }
  });

  it("returns a frozen object", () => {
    const envelope = buildMigrationEnvelope({ command: "plan", outcome: "ok", exitCode: 0, applied: false });
    expect(Object.isFrozen(envelope)).toBe(true);
  });

  it("sanitizes evidence unconditionally, including on an exit-0 (happy) path, not only when refusal is present", () => {
    expect(() =>
      buildMigrationEnvelope({
        command: "plan",
        outcome: "ok",
        exitCode: 0,
        applied: false,
        evidence: { canonicalPath: "/home/user/.lcm/project.db" },
      }),
    ).toThrow(MigrationEnvelopeError);
  });
});

describe("sanitizeMigrationEvidence (section 10: closed, pinned, non-path, non-secret)", () => {
  it("passes through non-string values unchanged: numbers, booleans, null", () => {
    const evidence: MigrationEvidence = { count: 3, ok: true, missing: null };
    expect(sanitizeMigrationEvidence(evidence)).toEqual(evidence);
  });

  it("passes through an ordinary short string that is not a path or credentialed URL", () => {
    const evidence: MigrationEvidence = { phase: "captured", digest: "a".repeat(64) };
    expect(sanitizeMigrationEvidence(evidence)).toEqual(evidence);
  });

  it("refuses a POSIX absolute path (red: mutate the pattern to never match and this must fail)", () => {
    expect(() => sanitizeMigrationEvidence({ path: "/etc/passwd" })).toThrow(/absolute path/);
  });

  it("refuses a Windows drive-letter absolute path", () => {
    expect(() => sanitizeMigrationEvidence({ path: "C:\\Users\\alice\\.lcm\\project.db" })).toThrow(/absolute path/);
  });

  it("refuses a UNC path", () => {
    expect(() => sanitizeMigrationEvidence({ path: "\\\\server\\share\\file" })).toThrow(/absolute path/);
  });

  it("refuses a credentialed URL", () => {
    expect(() => sanitizeMigrationEvidence({ target: "postgresql://user:hunter2@db.example.com/proj" })).toThrow(/credentialed URL/);
  });

  it("does not refuse a non-credentialed URL (a bare host is not a leak)", () => {
    expect(() => sanitizeMigrationEvidence({ target: "postgresql://db.example.com/proj" })).not.toThrow();
  });

  it("refuses an oversized string even when it is not a path or URL (red: shorten the string by one char below the bound and it must pass)", () => {
    const oversized = "a".repeat(257);
    expect(() => sanitizeMigrationEvidence({ blob: oversized })).toThrow(/length bound/);
    const atBound = "a".repeat(256);
    expect(() => sanitizeMigrationEvidence({ blob: atBound })).not.toThrow();
  });

  it("names the offending key in the thrown message", () => {
    expect(() => sanitizeMigrationEvidence({ myKey: "/abs/path" })).toThrow(/"myKey"/);
  });

  it("returns a frozen object with keys in sorted order regardless of input order", () => {
    const sanitized = sanitizeMigrationEvidence({ zeta: "1", alpha: "2" });
    expect(Object.isFrozen(sanitized)).toBe(true);
    expect(Object.keys(sanitized)).toEqual(["alpha", "zeta"]);
  });

  it("handles an empty evidence object", () => {
    expect(sanitizeMigrationEvidence({})).toEqual({});
  });
});

describe("serializeMigrationEnvelope (section 10: exact frozen key order)", () => {
  it("serializes keys in the exact section 10 order regardless of construction order", () => {
    const envelope = buildMigrationEnvelope({
      command: "plan",
      outcome: "ok",
      exitCode: 0,
      applied: false,
      evidence: { a: 1 },
    });
    const serialized = serializeMigrationEnvelope(envelope);
    const parsed: unknown = JSON.parse(serialized);
    expect(Object.keys(parsed as object)).toEqual([
      "schemaVersion", "command", "outcome", "exitCode", "generation",
      "manifestPhase", "applied", "next", "evidence", "refusal", "restart",
    ]);
  });

  it("is a pure function: the same envelope serializes to the byte-identical string twice", () => {
    const envelope = buildMigrationEnvelope({ command: "apply", outcome: "ok", exitCode: 0, applied: true });
    expect(serializeMigrationEnvelope(envelope)).toBe(serializeMigrationEnvelope(envelope));
  });

  it("ends with exactly one trailing newline", () => {
    const envelope = buildMigrationEnvelope({ command: "abort", outcome: "ok", exitCode: 0, applied: true });
    const serialized = serializeMigrationEnvelope(envelope);
    expect(serialized.endsWith("\n")).toBe(true);
    expect(serialized.endsWith("\n\n")).toBe(false);
  });

  it("round-trips through JSON.parse to a structurally equal document", () => {
    const envelope = buildMigrationEnvelope({
      command: "apply",
      outcome: "refused-contention",
      exitCode: 4,
      generation: "gen-2",
      applied: false,
      refusal: { reason: "publication-occupies-slot", remedy: "retry later" },
    });
    const serialized = serializeMigrationEnvelope(envelope);
    expect(JSON.parse(serialized)).toEqual(JSON.parse(JSON.stringify(envelope)));
  });
});
