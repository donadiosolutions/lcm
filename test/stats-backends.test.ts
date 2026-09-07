import { afterEach, describe, expect, it, vi } from "vitest";
import type { BackendDiagnosticSnapshot } from "../src/storage/diagnostics.js";

const probe = vi.hoisted(() => ({ collect: vi.fn() }));
vi.mock("../src/storage/diagnostics.js", () => ({ collectBackendDiagnostics: probe.collect }));
import { collectStats, printStats, StatsUnavailableError } from "../src/stats.js";

function snapshot(): BackendDiagnosticSnapshot {
  return {
    backend: "postgresql", classification: "healthy", publication: "ready", tls: "ready",
    schema: "ready", extensions: "ready", search: "ready", pool: { origin: "diagnostic-probe", status: "ready" },
    project: { scope: "aggregate", status: "ready" }, identity: { status: "ready" }, outbox: { status: "unverified" }, remediation: "No action required.",
    metrics: {
      projects: 2, conversations: 3, compactedConversations: 1, messages: 8, summaries: 2,
      maxDepth: 2, rawTokens: 90, summaryTokens: 10, ratio: 9, promotedCount: 4,
      redactionCounts: { builtIn: 1, global: 2, project: 3, total: 6 },
      recallStats: { memoriesSurfaced: 2, memoriesActedUpon: 1, recallPrecision: 50 },
    },
  };
}

afterEach(() => { vi.resetAllMocks(); vi.restoreAllMocks(); });

describe("backend-aware statistics", () => {
  it.each(["healthy", "degraded"] as const)("returns %s remote metrics without attempting SQLite collection", async classification => {
    const diagnostics = snapshot();
    diagnostics.classification = classification;
    probe.collect.mockResolvedValue(diagnostics);
    const result = await collectStats({ homeDir: "/missing-home", projectId: "scoped-project" });
    expect(result).toMatchObject({ ...diagnostics.metrics, backendDiagnostics: diagnostics });
    expect(result).not.toHaveProperty("staleCount");
    expect(result).not.toHaveProperty("conversationDetails");
    expect(result.eventsCaptured).toBeUndefined();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    printStats(result, true);
    expect(log.mock.calls.flat().join("\n")).not.toContain("Per Conversation");
    expect(log.mock.calls.flat().join("\n")).toContain(`Classification: ${classification}`);
  });

  it.each(["unavailable", "permission-denied", "timeout", "stale-publication"] as const)("preserves %s without substituting empty metrics", async classification => {
    const diagnostics = snapshot();
    diagnostics.classification = classification;
    delete diagnostics.metrics;
    probe.collect.mockResolvedValue(diagnostics);
    const result = await collectStats().catch(error => error);
    expect(result).toBeInstanceOf(StatsUnavailableError);
    expect(result.diagnostics).toBe(diagnostics);
    expect(result).not.toHaveProperty("messages");
    expect(result.message).toBe("Statistics unavailable; run lcm doctor to inspect backend readiness.");
  });

  it("rejects an incomplete healthy snapshot without manufacturing zeros", async () => {
    const diagnostics = snapshot();
    delete diagnostics.metrics;
    probe.collect.mockResolvedValue(diagnostics);
    await expect(collectStats()).rejects.toBeInstanceOf(StatsUnavailableError);
  });
});
