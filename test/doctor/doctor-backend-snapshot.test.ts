import { renderBackendDiagnostics } from "../../src/storage/diagnostic-renderer.js";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runDoctor, formatResultsPlain } from "../../src/doctor/doctor.js";
import { backendDiagnosticFailure, type BackendDiagnosticSnapshot } from "../../src/storage/diagnostics.js";
import { collectStats, StatsUnavailableError } from "../../src/stats.js";

vi.mock("../../src/stats.js", async importOriginal => ({
  ...await importOriginal<typeof import("../../src/stats.js")>(),
  collectStats: vi.fn(),
}));
vi.mock("../../src/db/events-stats.js", () => ({
  collectEventStats: vi.fn().mockResolvedValue({ captured: 0, unprocessed: 0, errors: 0, lastCapture: null }),
  collectDetailedEventStats: vi.fn(),
}));
let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "lcm-doctor-snapshot-"));
  mkdirSync(join(home, ".lcm"), { mode: 0o700 });
  writeFileSync(join(home, ".lcm", "config.json"), "{}", { mode: 0o600 });
  vi.mocked(collectStats).mockReset();
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function snapshot(classification: BackendDiagnosticSnapshot["classification"]): BackendDiagnosticSnapshot {
  return { ...backendDiagnosticFailure(new Error("private source error")), backend: "postgresql", classification };
}
function run(overrides = {}) {
  return runDoctor({ homedir: home, cwd: home, fetch: vi.fn(),
    spawnSync: vi.fn().mockReturnValue({ status: 0, stdout: "", stderr: "" }), ...overrides });
}

describe("doctor common backend snapshot", () => {
  it.each([
    ["healthy", "pass"], ["degraded", "warn"], ["unavailable", "fail"],
    ["permission-denied", "fail"], ["timeout", "fail"], ["stale-publication", "fail"],
  ] as const)("renders %s consistently as %s and carries the same DTO", async (classification, status) => {
    const diagnostics = snapshot(classification);
    const collector = vi.fn().mockResolvedValue(diagnostics);
    const results = await run({ collectBackendSnapshot: collector });
    expect(collector).toHaveBeenCalledExactlyOnceWith(home);
    expect(collectStats).not.toHaveBeenCalled();
    const result = results.find(row => row.name === "backend-health");
    expect(result).toEqual({ name: "backend-health", category: "Storage", status,
      message: renderBackendDiagnostics(diagnostics),
      backendDiagnostics: diagnostics });
    expect(formatResultsPlain(results)).toContain(`Classification: ${classification}`);
  });

  it("uses the stats reader bridge with the configured home for SQLite readiness", async () => {
    const diagnostics = { ...snapshot("healthy"), backend: "sqlite" as const, schema: "ready" as const };
    vi.mocked(collectStats).mockResolvedValue({ backendDiagnostics: diagnostics, privateMetadata: "SECRET_TRANSCRIPT" } as never);
    const results = await run();
    expect(collectStats).toHaveBeenCalledExactlyOnceWith({ homeDir: home });
    expect(results.find(row => row.name === "backend-health")?.backendDiagnostics).toEqual(diagnostics);
    expect(JSON.stringify(results)).not.toContain("SECRET_TRANSCRIPT");
  });

  it("retains the safe classified snapshot from unavailable statistics", async () => {
    const diagnostics = snapshot("permission-denied");
    const failure = new StatsUnavailableError(diagnostics);
    failure.message = "postgres://ROLE@PRIVATE_HOST/SECRET_TRANSCRIPT";
    vi.mocked(collectStats).mockRejectedValue(failure);
    const results = await run();
    expect(results.find(row => row.name === "backend-health")).toMatchObject({ status: "fail", backendDiagnostics: diagnostics });
    expect(JSON.stringify(results)).not.toContain("SECRET_TRANSCRIPT");
  });

  it("sanitizes an unexpected stats-reader failure into the common failure DTO", async () => {
    const failure = Object.assign(new Error("PRIVATE_CA_PATH/SECRET_TRANSCRIPT"), { code: "EACCES" });
    vi.mocked(collectStats).mockRejectedValue(failure);
    const results = await run();
    expect(results.find(row => row.name === "backend-health")?.backendDiagnostics).toEqual(backendDiagnosticFailure(failure));
    expect(JSON.stringify(results)).not.toContain("SECRET_TRANSCRIPT");
  });
});
