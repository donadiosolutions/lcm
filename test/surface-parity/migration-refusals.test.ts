import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { expectedMigrationObservations, runIdentityScenario } from "../postgresql/fixtures/surface-parity-identity.mjs";

// Injected fixture recorder: these results exercise the real scenario's call
// order, envelope checks and durable-byte witness, and are never backend
// conformance evidence.
const invalid = "--surface-parity-invalid-option";
const commands = ["plan", "dry-run", "apply", "resume", "verify", "report", "abort", "activate", "rollback"];

function envelope(command: string, expected: { code: number; outcome: string; refusal: string | null }, overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    schemaVersion: 1, command, outcome: expected.outcome, exitCode: expected.code, generation: null, manifestPhase: null,
    applied: false, next: null, evidence: {}, refusal: expected.refusal === null ? null : { reason: expected.refusal, remedy: "fixture" }, restart: null,
    ...overrides,
  });
}

function fixture(backend: "sqlite" | "postgresql", fault?: { command: string; kind: "mutate" | "no-envelope" | "exit-mismatch" | "wrong-command" }) {
  const homeDir = mkdtempSync(join(tmpdir(), "surface-migration-recorder-"));
  const lcm = join(homeDir, ".lcm");
  mkdirSync(join(lcm, "backend-publication"), { recursive: true, mode: 0o700 });
  writeFileSync(join(lcm, "config.json"), `{"storage":{"backend":"${backend}"}}\n`, { mode: 0o600 });
  writeFileSync(join(lcm, "map.json"), "{}\n", { mode: 0o600 });
  writeFileSync(join(lcm, "backend-publication", "journal.json"), "{}\n", { mode: 0o600 });
  const expected = expectedMigrationObservations(backend) as Record<string, { code: number; outcome: string; refusal: string | null }>;
  const calls: string[][] = [];
  const context = {
    homeDir, backend, projectPath: join(homeDir, "projects", "primary"),
    matrix: commands.map(command => ({ id: `cli:migration ${command}`, scenario: "migration", assertions: ["arguments", "result", "effects"] })),
    async cli(args: string[]) {
      calls.push([...args]);
      if (args.includes(invalid)) return { code: 1, stdout: "", stderr: "error: unknown option" };
      const command = args[1];
      const row = expected[`cli:migration ${command}`];
      if (fault?.command === command) {
        if (fault.kind === "mutate") writeFileSync(join(lcm, "migrations", "manifest.json"), "{}\n", { mode: 0o600 });
        if (fault.kind === "no-envelope") return { code: 1, stdout: "", stderr: "LCM command failed.\n" };
        if (fault.kind === "exit-mismatch") return { code: 1, stdout: envelope(command, row), stderr: "" };
        if (fault.kind === "wrong-command") return { code: row.code, stdout: envelope("plan", row), stderr: "" };
      }
      return { code: row.code, stdout: envelope(command, row), stderr: "" };
    },
  };
  if (fault?.kind === "mutate") mkdirSync(join(lcm, "migrations"), { mode: 0o700 });
  return { context, expected, calls, cleanup: () => rmSync(homeDir, { recursive: true, force: true }) };
}

it.each(["sqlite", "postgresql"] as const)("records one admission and one envelope receipt per cutover command on %s", async backend => {
  const f = fixture(backend);
  try {
    const rows = await runIdentityScenario("migration", f.context);
    expect(f.calls).toEqual(commands.flatMap(command => [["migration", command, invalid], ["migration", command, "--json"]]));
    expect(rows.map(row => row.id)).toEqual(commands.map(command => `cli:migration ${command}`));
    for (const row of rows) {
      expect(row.assertions).toEqual(["arguments", "result", "effects"]);
      expect(row.verdict).toBe("passed");
      expect(row.observation).toEqual(f.expected[row.id]);
    }
  } finally { f.cleanup(); }
});

it("declares a refusal for every command in both contexts that differs only where the architecture does", () => {
  const sqlite = expectedMigrationObservations("sqlite") as Record<string, { refusal: string; code: number }>;
  const postgresql = expectedMigrationObservations("postgresql") as Record<string, { refusal: string; code: number }>;
  expect(Object.keys(sqlite)).toEqual(commands.map(command => `cli:migration ${command}`));
  expect(Object.keys(postgresql)).toEqual(Object.keys(sqlite));
  for (const id of Object.keys(sqlite)) {
    expect(sqlite[id].refusal).not.toBeNull();
    expect(postgresql[id].refusal).not.toBeNull();
    expect([2, 4, 5]).toContain(sqlite[id].code);
    expect([2, 4, 5]).toContain(postgresql[id].code);
  }
  expect(Object.keys(sqlite).filter(id => sqlite[id].refusal !== postgresql[id].refusal)).toEqual(["cli:migration plan", "cli:migration apply", "cli:migration abort"]);
  expect(() => expectedMigrationObservations("mysql" as never)).toThrow();
});

it.each([
  ["mutate", "verify", "surface-migration:verify:durable-bytes-changed"],
  ["no-envelope", "report", "surface-migration:report:no-envelope"],
  ["exit-mismatch", "abort", "surface-migration:envelope-exit-code"],
  ["wrong-command", "activate", "surface-migration:envelope-command"],
] as const)("fails closed on a %s fault at %s", async (kind, command, message) => {
  const f = fixture("sqlite", { command, kind });
  try {
    await expect(runIdentityScenario("migration", f.context)).rejects.toThrow(message);
    expect(f.calls.at(-1)).toEqual(["migration", command, "--json"]);
  } finally { f.cleanup(); }
});
