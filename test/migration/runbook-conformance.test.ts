import { readFileSync } from "node:fs";
import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import {
  MIGRATION_EXIT_CLASSES,
  MIGRATION_COMMAND_CONTRACTS,
} from "../../src/migration/exit-classes.js";
import { MIGRATION_REFUSAL_REASONS } from "../../src/migration/refusal-mapping.js";
import { registerMigrationCommand } from "../../bin/lcm.js";
import { printHelp } from "../../src/cli-help.js";

/**
 * Section 12's bidirectional conformance check: the runbook's own
 * machine-readable inventory block, compared against this candidate's
 * exported closed-vocabulary constants in both directions, plus a third
 * leg comparing the runbook's claimed "implemented" commands against what
 * bin/lcm.ts actually registers. All three sides are read fresh from their
 * real sources here -- nothing in this file hand-copies a value from the
 * runbook or from the constants, because a fixture that agrees with the
 * thing it checks by construction proves nothing.
 */

const docUrl = new URL("../../docs/migration-operations.md", import.meta.url);
const runbookText = readFileSync(docUrl, "utf8");

function extractInventory(): {
  exitClasses: unknown;
  commands: unknown;
  refusals: unknown;
} {
  const match = runbookText.match(/```json\r?\n([\s\S]*?)\r?\n```/u);
  if (!match) throw new Error("no fenced json inventory block found in the runbook");
  return JSON.parse(match[1]!) as { exitClasses: unknown; commands: unknown; refusals: unknown };
}

// Round-tripping the source constants through JSON strips their readonly
// typing and Object.freeze wrappers so they compare structurally against
// the plain JSON the runbook actually carries -- the same transformation
// the runbook's own generation step applies.
const jsonRoundTrip = <T>(value: T): unknown => JSON.parse(JSON.stringify(value));

describe("runbook machine-readable inventory (section 12 bidirectional conformance)", () => {
  it("carries a fenced json code block that parses and has exactly the three expected top-level keys", () => {
    const inventory = extractInventory();
    expect(Object.keys(inventory).sort()).toEqual(["commands", "exitClasses", "refusals"]);
  });

  it("exitClasses matches MIGRATION_EXIT_CLASSES exactly, in both directions", () => {
    const inventory = extractInventory();
    expect(inventory.exitClasses).toEqual(jsonRoundTrip(MIGRATION_EXIT_CLASSES));
  });

  it("red: exitClasses no longer matches once an entry is removed from either side", () => {
    const inventory = extractInventory();
    const shortSource = jsonRoundTrip(MIGRATION_EXIT_CLASSES) as unknown[];
    shortSource.pop();
    expect(inventory.exitClasses).not.toEqual(shortSource);
    const shortDoc = (inventory.exitClasses as unknown[]).slice(0, -1);
    expect(shortDoc).not.toEqual(jsonRoundTrip(MIGRATION_EXIT_CLASSES));
  });

  it("red: exitClasses no longer matches once a fake entry is added to either side", () => {
    const inventory = extractInventory();
    const fake = { code: 99, name: "not-a-real-class", description: "fabricated" };
    const extendedSource = [...(jsonRoundTrip(MIGRATION_EXIT_CLASSES) as unknown[]), fake];
    expect(inventory.exitClasses).not.toEqual(extendedSource);
    const extendedDoc = [...(inventory.exitClasses as unknown[]), fake];
    expect(extendedDoc).not.toEqual(jsonRoundTrip(MIGRATION_EXIT_CLASSES));
  });

  it("commands matches MIGRATION_COMMAND_CONTRACTS exactly, including each entry's status field, in both directions", () => {
    const inventory = extractInventory();
    expect(inventory.commands).toEqual(jsonRoundTrip(MIGRATION_COMMAND_CONTRACTS));
  });

  it("red: commands no longer matches once one entry's status is flipped on either side (the exact defect this test exists to catch: report was once marked implemented with no CLI wiring)", () => {
    const inventory = extractInventory();
    const sourceCopy = jsonRoundTrip(MIGRATION_COMMAND_CONTRACTS) as Array<{ command: string; status: string }>;
    const reportEntry = sourceCopy.find((entry) => entry.command === "activate");
    expect(reportEntry).toBeDefined();
    reportEntry!.status = "outline";
    expect(inventory.commands).not.toEqual(sourceCopy);
    const docCopy = JSON.parse(JSON.stringify(inventory.commands)) as Array<{ command: string; status: string }>;
    const docReportEntry = docCopy.find((entry) => entry.command === "activate");
    expect(docReportEntry).toBeDefined();
    docReportEntry!.status = "outline";
    expect(docCopy).not.toEqual(jsonRoundTrip(MIGRATION_COMMAND_CONTRACTS));
  });

  it("refusals matches MIGRATION_REFUSAL_REASONS exactly, in both directions", () => {
    const inventory = extractInventory();
    expect(inventory.refusals).toEqual(jsonRoundTrip(MIGRATION_REFUSAL_REASONS));
  });

  it("red: refusals no longer matches once one entry's remedy is corrupted on either side", () => {
    const inventory = extractInventory();
    const sourceCopy = jsonRoundTrip(MIGRATION_REFUSAL_REASONS) as Array<{ reason: string; remedy: string }>;
    sourceCopy[0]!.remedy = "corrupted remedy text";
    expect(inventory.refusals).not.toEqual(sourceCopy);
    const docCopy = JSON.parse(JSON.stringify(inventory.refusals)) as Array<{ reason: string; remedy: string }>;
    docCopy[0]!.remedy = "corrupted remedy text";
    expect(docCopy).not.toEqual(jsonRoundTrip(MIGRATION_REFUSAL_REASONS));
  });

  it("every refusal reason named in MIGRATION_REFUSAL_REASONS appears in the inventory, and vice versa (a set-level check independent of ordering)", () => {
    const inventory = extractInventory();
    const docReasons = new Set((inventory.refusals as Array<{ reason: string }>).map((entry) => entry.reason));
    const sourceReasons = new Set(MIGRATION_REFUSAL_REASONS.map((entry) => entry.reason));
    expect(docReasons).toEqual(sourceReasons);
  });
});

describe("runbook command registration (third leg: what bin/lcm.ts actually registers, not merely what the contract table claims)", () => {
  it("registers exactly the commands MIGRATION_COMMAND_CONTRACTS marks implemented -- no more, no fewer -- as subcommands of the migration group", () => {
    const program = new Command();
    registerMigrationCommand(program);
    const migrationGroup = program.commands.find((command) => command.name() === "migration");
    expect(migrationGroup).toBeDefined();
    const registered = migrationGroup!.commands.map((command) => command.name()).sort();
    const implemented = MIGRATION_COMMAND_CONTRACTS
      .filter((entry) => entry.status === "implemented")
      .map((entry) => entry.command)
      .sort();
    expect(registered).toEqual(implemented);
  });

  it("registers all nine commands, activate and rollback included, and the contract table has no outline command left to leave unregistered", () => {
    const program = new Command();
    registerMigrationCommand(program);
    const migrationGroup = program.commands.find((command) => command.name() === "migration");
    const registered = migrationGroup!.commands.map((command) => command.name()).sort();
    expect(registered).toEqual(["abort", "activate", "apply", "dry-run", "plan", "report", "resume", "rollback", "verify"]);
    expect(MIGRATION_COMMAND_CONTRACTS.filter((entry) => entry.status === "outline")).toEqual([]);
  });
});

describe("runbook prose: the obligations the cutover commands add (no mechanical backstop in the inventory block)", () => {
  function section(heading: string): string {
    const start = runbookText.indexOf(heading);
    expect(start).toBeGreaterThan(-1);
    const next = runbookText.indexOf(String.fromCharCode(10) + "## ", start + heading.length);
    return runbookText.slice(start, next === -1 ? undefined : next);
  }

  it("puts runtime grants before activation and transfer revocation before daemon start", () => {
    const activate = section("### `lcm migration activate");
    const cutover = section("## The cutover: activate and revoke transfer grants");
    for (const text of [activate, cutover]) {
      expect(text).toMatch(/runtime\s+grants/u);
      expect(text).toMatch(/revoke\s+the\s+transfer\s+grants/iu);
      expect(text).toContain("LCM_POSTGRES_RUNTIME_URL");
    }
    expect(cutover.indexOf("Apply the reviewed runtime grants")).toBeLessThan(cutover.indexOf("lcm migration activate"));
    expect(cutover.indexOf("Revoke the transfer grants")).toBeLessThan(cutover.indexOf("Start (or restart) the daemon"));
  });

  it("states rollback's remote-binding refusal (A14) in the rollback reference and the limits section", () => {
    expect(section("### `lcm migration rollback")).toMatch(/refuses\s+while\s+any\s+other\s+project\s+is\s+remotely\s+bound/u);
    expect(section("## Rollback and its limits")).toMatch(/refuses\s+while\s+any\s+other\s+project\s+is\s+remotely\s+bound/u);
    expect(section("## Rollback and its limits")).toMatch(/backend\s+selection\s+is\s+global/u);
  });

  it("states that --confirm-backend confirms intent and does not detect the wrong direction, naming both literals", () => {
    const commands = section("## Commands");
    expect(commands).toMatch(/--confirm-backend/u);
    expect(commands).toMatch(/only\s+legal\s+value/u);
    expect(commands).toMatch(/does\s+not\s+detect/u);
    expect(commands).toContain("`postgresql`");
    expect(commands).toContain("`sqlite`");
  });

  it("documents the JSON envelope the Commands section points to, field by field", () => {
    expect(runbookText).toContain('"The JSON envelope"');
    const envelope = section("## The JSON envelope");
    for (const field of ["schemaVersion", "command", "outcome", "exitCode", "generation", "manifestPhase", "applied", "next", "evidence", "refusal", "restart"]) {
      expect(envelope).toContain("`" + field + "`");
    }
  });

  it("lists the R5 coordination effects: only verify's fresh dry-run takes a lease and the barrier", () => {
    const commands = section("## Commands");
    expect(commands).toMatch(/verification lease/u);
    expect(commands).toMatch(/source append barrier/u);
  });

  it("no longer says any command is missing, deferred or unregistered", () => {
    expect(runbookText).not.toMatch(/not registered and not\s+available/u);
    expect(runbookText).not.toContain("Commands not available today");
    expect(runbookText).not.toContain("requires-625-project-map-witness");
    expect(runbookText).not.toContain("not-available-in-this-build");
    expect(runbookText).not.toContain("route-requires-activation");
    expect(runbookText).not.toContain("route-requires-rollback");
  });
});

describe("runbook obligations with no mechanical backstop (the inventory block cannot catch a missing prose paragraph)", () => {
  it("states the maintenance-hold warning before the Commands section, not after it", () => {
    const holdWarningIndex = runbookText.indexOf("maintenance hold that only");
    const commandsHeaderIndex = runbookText.indexOf("## Commands");
    expect(holdWarningIndex).toBeGreaterThan(-1);
    expect(commandsHeaderIndex).toBeGreaterThan(-1);
    expect(holdWarningIndex).toBeLessThan(commandsHeaderIndex);
  });

  it("states the fencing residue: same-host processes only, and names all three unprotected cases", () => {
    expect(runbookText).toMatch(/same-host/iu);
    expect(runbookText).toMatch(/second LCM installation/iu);
    expect(runbookText).toMatch(/direct `sqlite3`/u);
    expect(runbookText).toMatch(/[Aa]nother host/u);
  });

  it("states the no-drain-liveness claim: apply does not flush a pending backlog", () => {
    expect(runbookText).toMatch(/does not flush a pending/iu);
    expect(runbookText).toMatch(/daemon restart[\s\S]{0,200}resumes processing/iu);
  });

  it("states the config semantics: storage.backend is active, storage.postgresql is destination reachability, read regardless of backend", () => {
    expect(runbookText).toMatch(/`storage\.backend`[\s\S]{0,200}active/u);
    expect(runbookText).toMatch(/`storage\.postgresql`[\s\S]{0,200}reach PostgreSQL/u);
    expect(runbookText).toMatch(/regardless of/iu);
  });

  it("states that the maintenance window scales with the amount of data being migrated", () => {
    expect(runbookText).toMatch(/maintenance window scales with/iu);
  });
});
describe("operator-facing surfaces cannot disagree with the runbook (round-1 A-13/B-7, A-12, A-14)", () => {
  function migrationHelpText(): string {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      printHelp("migration");
      return out.mock.calls.map((call) => String(call[0])).join("");
    } finally {
      out.mockRestore();
    }
  }

  it("the help page states the project-linking rule the runbook states (must not be linked), never the inverse", () => {
    const help = migrationHelpText();
    expect(runbookText).toMatch(/must not be linked/u);
    expect(help).toMatch(/must not be linked/u);
    expect(help).toContain("lcm project link");
    expect(runbookText).toContain("lcm project link");
    expect(help).not.toMatch(/must already be linked/u);
    expect(runbookText).not.toMatch(/must already be linked/u);
  });

  it("red: the rule is checked in both directions, so inverting either surface would fail", () => {
    const inverted = "This project must already be linked to a PostgreSQL project";
    expect(inverted).not.toMatch(/must not be linked/u);
    expect(migrationHelpText().replace(/must not be linked/u, "must be linked")).not.toMatch(/must not be linked/u);
  });

  it("every other documentation entry point links the runbook: docs/cli.md and docs/migration-cutover.md", () => {
    for (const relative of ["../../docs/cli.md", "../../docs/migration-cutover.md"]) {
      expect(readFileSync(new URL(relative, import.meta.url), "utf8")).toContain("migration-operations.md");
    }
  });

  it("the runbook promises only the help that exists: no per-command help page, and the group page is named", () => {
    expect(runbookText).not.toMatch(/lcm migration <command> --help/u);
    expect(runbookText).toContain("lcm migration --help");
    expect(runbookText).not.toMatch(/generated from the\s+same source/u);
  });
});
