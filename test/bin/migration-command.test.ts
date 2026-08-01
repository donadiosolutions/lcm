import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";

const state = vi.hoisted(() => ({
  exit: vi.fn((code?: string | number | null): never => { throw new Error(`exit:${code ?? 0}`); }),
  printHelp: vi.fn(),
  plan: vi.fn(),
  dryRun: vi.fn(),
  apply: vi.fn(),
  resume: vi.fn(),
  verify: vi.fn(),
  report: vi.fn(),
  list: vi.fn(),
  activate: vi.fn(),
  rollback: vi.fn(),
}));

vi.mock("node:process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:process")>()),
  exit: state.exit,
}));

vi.mock("../../src/cli-help.js", () => ({ printHelp: state.printHelp }));
vi.mock("../../src/storage/project-migration.js", () => ({
  planProjectMigration: state.plan,
  dryRunProjectMigration: state.dryRun,
  applyProjectMigration: state.apply,
  resumeProjectMigration: state.resume,
  verifyProjectMigration: state.verify,
  reportProjectMigration: state.report,
  listProjectMigrationReports: state.list,
  activateProjectMigration: state.activate,
  rollbackProjectMigration: state.rollback,
}));

const { registerMigrationCommand } = await import("../../bin/lcm.js");

function migrationResult(operation: string, blockers: readonly string[] = []) {
  return {
    operation,
    generationId: "018f1234-5678-7abc-8def-0123456789ab",
    status: operation === "plan" ? "planned" : "verified",
    ready: blockers.length === 0,
    blockers,
    projects: [],
  };
}

async function invoke(...args: string[]): Promise<void> {
  const program = new Command().name("lcm").helpCommand(false).helpOption(false);
  registerMigrationCommand(program);
  await program.parseAsync(["node", "lcm", ...args]);
}

function stdoutText(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls.map(([value]) => String(value)).join("");
}

describe("lcm migration command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
    state.plan.mockReturnValue(migrationResult("plan", ["dry-run required before apply"]));
    state.dryRun.mockResolvedValue(migrationResult("dry-run"));
    state.apply.mockResolvedValue(migrationResult("apply"));
    state.resume.mockResolvedValue(migrationResult("resume"));
    state.verify.mockResolvedValue(migrationResult("verify"));
    state.report.mockReturnValue(migrationResult("report"));
    state.list.mockReturnValue([migrationResult("report")]);
    state.activate.mockResolvedValue(migrationResult("activate"));
    state.rollback.mockResolvedValue(migrationResult("rollback"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it("plans with bounded options and keeps JSON stdout machine-pure", async () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await invoke("migration", "plan", "--batch-size", "17", "--sample-size", "5", "--json");
    expect(state.plan).toHaveBeenCalledWith({ batchSize: 17, sampleSize: 5, progress: undefined });
    expect(JSON.parse(stdoutText(out))).toMatchObject({ operation: "plan", status: "planned" });
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it("routes progress and blockers only to stderr in human output", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    state.dryRun.mockImplementationOnce(async (_generationId, options) => {
      options.progress?.("project:abcdef123456 dry-run");
      return migrationResult("dry-run", ["blocked"]);
    });
    await invoke("migration", "dry-run", "generation-1");
    expect(state.dryRun).toHaveBeenCalledWith("generation-1", expect.objectContaining({ progress: expect.any(Function) }));
    expect(log).toHaveBeenCalledWith("dry-run 018f1234-5678-7abc-8def-0123456789ab: verified");
    expect(error).toHaveBeenCalledWith("project:abcdef123456 dry-run");
    expect(error).toHaveBeenCalledWith("blocker: blocked");
    expect(process.exitCode).toBe(1);
  });

  it.each([
    ["apply", state.apply],
    ["resume", state.resume],
    ["activate", state.activate],
    ["rollback", state.rollback],
  ] as const)("requires exact confirmation before %s", async (operation, implementation) => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await invoke("migration", operation, "generation-1");
    expect(implementation).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("pass --confirm generation-1"));
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
    await invoke("migration", operation, "generation-1", "--confirm", "generation-1");
    expect(implementation).toHaveBeenCalledWith("generation-1", expect.objectContaining({ progress: expect.any(Function) }));
  });

  it("dispatches verify and both report forms", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await invoke("migration", "verify", "generation-1");
    expect(state.verify).toHaveBeenCalledWith("generation-1", expect.any(Object));
    await invoke("migration", "report", "generation-1");
    expect(state.report).toHaveBeenCalledWith("generation-1", expect.any(Object));
    await invoke("migration", "report");
    expect(state.list).toHaveBeenCalledWith(expect.any(Object));
    expect(log).toHaveBeenCalledWith("Found 1 migration generation(s).");
  });

  it("does not fail plan, apply, or resume solely for advisory blockers", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    state.apply.mockResolvedValueOnce(migrationResult("apply", ["verification required before activation"]));
    state.resume.mockResolvedValueOnce(migrationResult("resume", ["verification required before activation"]));
    await invoke("migration", "plan");
    await invoke("migration", "apply", "g", "--confirm", "g");
    await invoke("migration", "resume", "g", "--confirm", "g");
    expect(process.exitCode).toBeUndefined();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("blocker:"));
    expect(log).toHaveBeenCalled();
  });

  it("sanitizes JSON and human failures without leaking credentials or paths", async () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    state.plan.mockImplementationOnce(() => { throw new Error("postgresql://user:secret@db.example/lcm /private/home/project/file"); });
    await invoke("migration", "plan", "--json");
    const json = stdoutText(out);
    expect(json).toContain("postgresql://<redacted>");
    expect(json).toContain("<path>");
    expect(json).not.toContain("secret");
    expect(error).not.toHaveBeenCalled();

    out.mockClear();
    state.verify.mockRejectedValueOnce("opaque failure");
    await invoke("migration", "verify", "generation-1");
    expect(error).toHaveBeenCalledWith("migration verify failed: migration operation failed");
    expect(process.exitCode).toBe(1);
  });

  it("rejects invalid numeric options before planning", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(invoke("migration", "plan", "--batch-size", "0")).rejects.toThrow("exit:1");
    expect(error).toHaveBeenCalledWith("Invalid --batch-size: 0");
    expect(state.plan).not.toHaveBeenCalled();
  });

  it("prints dedicated help and rejects a missing subcommand", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(invoke("migration", "--help")).rejects.toThrow("exit:0");
    expect(state.printHelp).toHaveBeenCalledWith("migration");
    state.exit.mockClear();
    state.printHelp.mockClear();
    await expect(invoke("migration", "plan", "--help")).rejects.toThrow("exit:0");
    expect(state.printHelp).toHaveBeenCalledWith("migration");
    state.exit.mockClear();
    await invoke("migration");
    expect(error).toHaveBeenCalledWith("Usage: lcm migration plan|dry-run|apply|resume|verify|report|activate|rollback");
    expect(process.exitCode).toBe(1);
  });
});
