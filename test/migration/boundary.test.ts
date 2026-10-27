import { describe, expect, it } from "vitest";
import {
  MIGRATION_UNEXPECTED_FAILURE_REASON,
  unexpectedFailureEvidence,
  withMigrationBoundary,
} from "../../src/migration/boundary.js";

describe("unexpectedFailureEvidence (round-1 B-4)", () => {
  it("keeps only the error's name", () => {
    expect(unexpectedFailureEvidence(new TypeError("a message with /a/path and a secret"))).toBe("TypeError");
  });

  it("never lets a name that is not a plain identifier through", () => {
    const error = new Error("x");
    error.name = "/home/someone/secret";
    expect(unexpectedFailureEvidence(error)).toBe("UnknownError");
    error.name = "A".repeat(65);
    expect(unexpectedFailureEvidence(error)).toBe("UnknownError");
  });

  it("reports a non-Error throw as UnknownError", () => {
    expect(unexpectedFailureEvidence("a string")).toBe("UnknownError");
    expect(unexpectedFailureEvidence(undefined)).toBe("UnknownError");
  });
});

describe("withMigrationBoundary", () => {
  const failed = (evidence: string) => ({ status: "refuse" as const, reason: MIGRATION_UNEXPECTED_FAILURE_REASON, evidence });

  it("passes a normal outcome through untouched", async () => {
    expect(await withMigrationBoundary(async () => ({ status: "ok" as const }), failed)).toEqual({ status: "ok" });
  });

  it("maps an unknown throw to the closed unexpected-failure refusal carrying only the name", async () => {
    const result = await withMigrationBoundary(async () => { throw new RangeError("with a /path"); }, failed);
    expect(result).toEqual({ status: "refuse", reason: "unexpected-failure", evidence: "RangeError" });
  });
});
