import { describe, expect, it } from "vitest";
import {
  MIGRATION_EXIT_CLASSES,
  MIGRATION_COMMAND_CONTRACTS,
  migrationExitClassForCode,
  migrationExitClassForName,
  migrationCommandContract,
  EXIT_SIX_REQUIRES_GENUINE_RESUMABILITY,
  type MigrationExitCode,
} from "../../src/migration/exit-classes.js";

describe("MIGRATION_EXIT_CLASSES (section 5's closed vocabulary)", () => {
  it("has exactly nine classes, codes 0 through 8, each at its own array index", () => {
    expect(MIGRATION_EXIT_CLASSES).toHaveLength(9);
    MIGRATION_EXIT_CLASSES.forEach((entry, index) => {
      expect(entry.code).toBe(index);
    });
  });

  it("never reuses a code for two different names (section 5: codes are never reused for a different class)", () => {
    const names = new Map<number, string>();
    for (const entry of MIGRATION_EXIT_CLASSES) {
      expect(names.has(entry.code)).toBe(false);
      names.set(entry.code, entry.name);
    }
    expect(names.size).toBe(9);
  });

  it("names are unique too, so migrationExitClassForName is unambiguous", () => {
    const names = new Set(MIGRATION_EXIT_CLASSES.map((entry) => entry.name));
    expect(names.size).toBe(9);
  });

  it.each(MIGRATION_EXIT_CLASSES.map((entry) => [entry.code, entry.name] as const))(
    "migrationExitClassForCode(%i) resolves the same entry as migrationExitClassForName(%s)",
    (code, name) => {
      expect(migrationExitClassForCode(code)).toBe(migrationExitClassForName(name));
    },
  );

  it("refuses an unrecognised code rather than returning undefined (red: silently returning undefined would let a caller construct an envelope for a non-existent class)", () => {
    expect(() => migrationExitClassForCode(9 as MigrationExitCode)).toThrow("unknown migration exit code: 9");
  });

  it("refuses an unrecognised class name rather than returning undefined", () => {
    expect(() => migrationExitClassForName("not-a-real-class" as never)).toThrow("unknown migration exit class name: not-a-real-class");
  });

  it("is deeply frozen: the array, each entry, cannot be mutated", () => {
    expect(Object.isFrozen(MIGRATION_EXIT_CLASSES)).toBe(true);
    for (const entry of MIGRATION_EXIT_CLASSES) {
      expect(Object.isFrozen(entry)).toBe(true);
    }
  });
});

describe("MIGRATION_COMMAND_CONTRACTS (section 5.1's per-command postcondition and refusal mapping)", () => {
  const expectedCommands = ["plan", "dry-run", "apply", "resume", "verify", "report", "activate", "rollback", "abort"];

  it("names all nine commands from issue #627's contract, not only the four this candidate implements", () => {
    expect(MIGRATION_COMMAND_CONTRACTS.map((entry) => entry.command)).toEqual(expectedCommands);
  });

  it("marks all nine commands implemented: none is outline any more", () => {
    const implemented = MIGRATION_COMMAND_CONTRACTS.filter((entry) => entry.status === "implemented").map((entry) => entry.command);
    expect(implemented.sort()).toEqual([...expectedCommands].sort());
    expect(MIGRATION_COMMAND_CONTRACTS.filter((entry) => entry.status === "outline")).toEqual([]);
  });

  it("gives every command a non-empty, never-'nothing threw' exit-zero postcondition, and every command can emit 0", () => {
    for (const entry of MIGRATION_COMMAND_CONTRACTS) {
      expect(entry.exitZeroPostcondition.length).toBeGreaterThan(0);
      expect(entry.canEmit).toContain(0);
    }
  });

  it("never lets a command claim exit 6 without exit 2 also being available (section 5: exit 6 must have exit 2's remedy-abort alternative reachable for the unresumable case)", () => {
    for (const entry of MIGRATION_COMMAND_CONTRACTS) {
      if (entry.canEmit.includes(6)) {
        expect(entry.canEmit).toContain(2);
      }
    }
  });

  it.each(MIGRATION_COMMAND_CONTRACTS.map((entry) => entry.command))(
    "migrationCommandContract(%s) resolves the exact same entry as the table",
    (command) => {
      const fromTable = MIGRATION_COMMAND_CONTRACTS.find((entry) => entry.command === command)!;
      expect(migrationCommandContract(command)).toBe(fromTable);
    },
  );

  it("refuses an unrecognised command name rather than returning undefined", () => {
    expect(() => migrationCommandContract("not-a-real-command" as never)).toThrow("unknown migration command: not-a-real-command");
  });

  it("is deeply frozen", () => {
    expect(Object.isFrozen(MIGRATION_COMMAND_CONTRACTS)).toBe(true);
    for (const entry of MIGRATION_COMMAND_CONTRACTS) {
      expect(Object.isFrozen(entry)).toBe(true);
    }
  });

  it("apply's canEmit matches exactly section 5.1's row: 0,1,2,3,4,5,6,7, never 8 (exit 8 is activate/report's, not apply's)", () => {
    expect(migrationCommandContract("apply").canEmit).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("abort's canEmit is 0,1,2,3,4,5,6,7, never 8: it exits 6 only as a non-owner naming resume or verify (owner rulings R7 and the router)", () => {
    expect(migrationCommandContract("abort").canEmit).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("verify never emits 6 or 8 (it finishes its own pending effect), while resume emits what activate and rollback do at cells 11 and 12, which includes 6 and 8", () => {
    expect(migrationCommandContract("verify").canEmit).toEqual([0, 1, 2, 3, 4, 5, 7]);
    expect(migrationCommandContract("resume").canEmit).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    for (const code of [6, 8] as const) {
      expect(migrationCommandContract("resume").canEmit).toContain(code);
      expect(migrationCommandContract("activate").canEmit).toContain(code);
      expect(migrationCommandContract("rollback").canEmit).toContain(code);
    }
  });

  it("report emits exactly 0,1,2,4,5,8 and rollback gains 8 (plan-v5 Part A item 2)", () => {
    expect(migrationCommandContract("report").canEmit).toEqual([0, 1, 2, 4, 5, 8]);
    expect(migrationCommandContract("rollback").canEmit).toContain(8);
  });

  it("plan and dry-run's canEmit never include 3, 6, 7 or 8: neither command mutates, confirms a boundary, or reaches a durable-recoverable or restart-required state", () => {
    for (const command of ["plan", "dry-run"] as const) {
      const canEmit = migrationCommandContract(command).canEmit;
      expect(canEmit).toEqual(expect.arrayContaining([0, 1, 2, 4, 5]));
      expect(canEmit).not.toEqual(expect.arrayContaining([3, 6, 7, 8]));
    }
  });
});

describe("EXIT_SIX_REQUIRES_GENUINE_RESUMABILITY", () => {
  it("is a non-empty, standing statement of the rule, not a per-call check (nothing here can mechanically verify a specific refusal's honesty)", () => {
    expect(EXIT_SIX_REQUIRES_GENUINE_RESUMABILITY.length).toBeGreaterThan(0);
    expect(EXIT_SIX_REQUIRES_GENUINE_RESUMABILITY).toContain("exit 6");
    expect(EXIT_SIX_REQUIRES_GENUINE_RESUMABILITY).toContain("exit 2");
  });
});
