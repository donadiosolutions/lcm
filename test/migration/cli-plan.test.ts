import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { performMigrationPlan } from "../../src/migration/cli-plan.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function home(): string {
  const value = mkdtempSync(join(tmpdir(), "lcm-cli-plan-"));
  mkdirSync(join(value, ".lcm"), { mode: 0o700 });
  roots.push(value);
  return value;
}

describe("performMigrationPlan: entirely non-mutating, reports the shared preflight's result", () => {
  it("maps a ready preflight into an ok outcome with the candidate id, disposition and the full daemon presence, carried through rather than flattened", async () => {
    const homeDir = home();
    const result = await performMigrationPlan({
      cwd: join(homeDir, "project"),
      homeDir,
      _preflight: async () => ({
        status: "ready",
        targetConfig: {} as never,
        presence: { status: "present", storageBackend: "postgresql", pid: 1, daemonInstanceId: "gen-1" },
        candidate: { status: "candidate", disposition: "fresh", generationId: "generation-0" },
        local: { id: "a".repeat(64), canonical: "/projects/x", persisted: true },
        machineId: "machine-1",
        destinationProjectId: null,
        base: "base-identity",
      }),
    });
    expect(result).toEqual({
      status: "ok",
      generationId: "generation-0",
      disposition: "fresh",
      daemonPresence: { status: "present", storageBackend: "postgresql", pid: 1, daemonInstanceId: "gen-1" },
      identityPreview: { destinationProject: "will-be-created-at-apply", localProject: "persisted" },
    });
  });

  it("maps a ready preflight with an authoritatively-absent daemon into an ok outcome carrying that exact presence, distinct from the present case above (red: a boolean-flattened or dropped presence field could not tell these two apart)", async () => {
    const homeDir = home();
    const result = await performMigrationPlan({
      cwd: join(homeDir, "project"),
      homeDir,
      _preflight: async () => ({
        status: "ready",
        targetConfig: {} as never,
        presence: { status: "authoritatively-absent" },
        candidate: { status: "candidate", disposition: "fresh", generationId: "generation-0" },
        local: { id: "a".repeat(64), canonical: "/projects/x", persisted: true },
        machineId: "machine-1",
        destinationProjectId: null,
        base: "base-identity",
      }),
    });
    expect(result).toEqual({
      status: "ok",
      generationId: "generation-0",
      disposition: "fresh",
      daemonPresence: { status: "authoritatively-absent" },
      identityPreview: { destinationProject: "will-be-created-at-apply", localProject: "persisted" },
    });
  });

  it("maps an unknown throw from the preflight to unexpected-failure with only the error name (round-1 B-4)", async () => {
    const result = await performMigrationPlan({
      cwd: "/tmp/project", homeDir: "/tmp/home",
      _preflight: async () => { throw new TypeError("a message with /a/path"); },
    });
    expect(result).toEqual({ status: "refuse", reason: "unexpected-failure", evidence: "TypeError" });
  });

  it("propagates a preflight refusal unchanged, including its evidence", async () => {
    const homeDir = home();
    const result = await performMigrationPlan({
      cwd: join(homeDir, "project"),
      homeDir,
      _preflight: async () => ({ status: "refuse", reason: "migration-target-missing", evidence: "config-validation-error" }),
    });
    expect(result).toEqual({ status: "refuse", reason: "migration-target-missing", evidence: "config-validation-error" });
  });

  it("uses the real resolveMigrationPreflight default (no injection) end to end: a fresh home with no target configured really refuses migration-target-missing", async () => {
    const homeDir = home();
    const cwd = join(homeDir, "project");
    mkdirSync(cwd, { mode: 0o700 });
    const result = await performMigrationPlan({ cwd, homeDir });
    expect(result.status).toBe("refuse");
    expect((result as { reason: string }).reason).toMatch(/^migration-target-/);
  });
});
