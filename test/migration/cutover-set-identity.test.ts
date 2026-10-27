import { describe, expect, it } from "vitest";
import {
  computeCutoverSetBase,
  computeMigrationGenerationBase,
  generationIdBelongsToBase,
  MigrationIdentityError,
} from "../../src/migration/generation-identity.js";

const TARGET = { host: "db.example", port: 5432, database: "lcm" } as const;
const MEMBERS = [
  { physicalProjectId: "b".repeat(64), generationId: "member-b-0" },
  { physicalProjectId: "a".repeat(64), generationId: "member-a-0" },
] as const;

describe("computeCutoverSetBase", () => {
  it("is deterministic and independent of member order", () => {
    const base = computeCutoverSetBase({ target: TARGET, members: MEMBERS });
    expect(base).toMatch(/^cutover-set-[a-f0-9]{64}$/);
    expect(computeCutoverSetBase({ target: { ...TARGET }, members: [...MEMBERS].reverse() })).toBe(base);
  });

  it("changes with the target coordinates and with every member generation id", () => {
    const base = computeCutoverSetBase({ target: TARGET, members: MEMBERS });
    expect(computeCutoverSetBase({ target: { ...TARGET, host: "other.example" }, members: MEMBERS })).not.toBe(base);
    expect(computeCutoverSetBase({ target: { ...TARGET, port: 5433 }, members: MEMBERS })).not.toBe(base);
    expect(computeCutoverSetBase({ target: { ...TARGET, database: "other" }, members: MEMBERS })).not.toBe(base);
    // A member whose ordinal advanced (its earlier generation was occupied) moves the set base.
    expect(computeCutoverSetBase({
      target: TARGET, members: [MEMBERS[0], { ...MEMBERS[1], generationId: "member-a-1" }],
    })).not.toBe(base);
  });

  it("is domain separated from a member generation base", () => {
    const member = computeMigrationGenerationBase({ physicalProjectId: "a".repeat(64), canonicalPath: "/p", target: TARGET });
    expect(computeCutoverSetBase({ target: TARGET, members: MEMBERS })).not.toBe(member);
  });

  it.each([
    ["no members", { target: TARGET, members: [] }],
    ["a member without a project id", { target: TARGET, members: [{ physicalProjectId: "", generationId: "g" }] }],
    ["a member without a generation id", { target: TARGET, members: [{ physicalProjectId: "a", generationId: "" }] }],
    ["a duplicated project", { target: TARGET, members: [MEMBERS[0], MEMBERS[0]] }],
    ["an invalid target", { target: { host: "", port: 5432, database: "lcm" }, members: MEMBERS }],
    ["a missing target", { members: MEMBERS }],
  ])("refuses %s", (_name, input) => {
    expect(() => computeCutoverSetBase(input as never)).toThrow(MigrationIdentityError);
  });
});

describe("generationIdBelongsToBase", () => {
  it("accepts exactly base plus separator plus a canonical ordinal within the probe bound", () => {
    expect(generationIdBelongsToBase("base", "base-0")).toBe(true);
    expect(generationIdBelongsToBase("base", "base-12")).toBe(true);
    expect(generationIdBelongsToBase("base", "base-9999")).toBe(true);
    expect(generationIdBelongsToBase("base", "base-10000")).toBe(false);
    expect(generationIdBelongsToBase("base", "base-3", 2)).toBe(false);
    expect(generationIdBelongsToBase("base", "base-01")).toBe(false);
    expect(generationIdBelongsToBase("base", "base-")).toBe(false);
    expect(generationIdBelongsToBase("base", "base-1-2")).toBe(false);
    expect(generationIdBelongsToBase("base", "other-1")).toBe(false);
    expect(generationIdBelongsToBase("base", "base0")).toBe(false);
    expect(generationIdBelongsToBase("base", "base-" + "9".repeat(400))).toBe(false);
  });
});

