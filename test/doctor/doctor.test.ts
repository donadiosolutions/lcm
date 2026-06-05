import { beforeEach, describe, expect, it, vi } from "vitest";
import { runDoctor } from "../../src/doctor/doctor.js";
import { REQUIRED_HOOKS } from "../../installer/install.js";
import { LCM_MD_CONTENT } from "../../src/daemon/orientation.js";
import { ensureDaemon } from "../../src/daemon/lifecycle.js";

vi.mock("../../src/daemon/lifecycle.js", () => ({
  ensureDaemon: vi.fn().mockResolvedValue({ connected: false }),
}));

vi.mock("../../src/db/events-stats.js", () => ({
  collectEventStats: vi.fn().mockReturnValue({ captured: 0, unprocessed: 0, errors: 0, lastCapture: null }),
  collectDetailedEventStats: vi.fn().mockReturnValue({ captured: 0, unprocessed: 0, errors: 0, lastCapture: null, projects: [], recentErrors: [] }),
}));

import { collectDetailedEventStats, collectEventStats } from "../../src/db/events-stats.js";
const mockCollectEventStats = vi.mocked(collectEventStats);
const mockCollectDetailedEventStats = vi.mocked(collectDetailedEventStats);

beforeEach(() => {
  vi.mocked(ensureDaemon).mockReset();
  vi.mocked(ensureDaemon).mockResolvedValue({ connected: false });
  mockCollectEventStats.mockReturnValue({ captured: 0, unprocessed: 0, errors: 0, lastCapture: null });
  mockCollectDetailedEventStats.mockReturnValue({ captured: 0, unprocessed: 0, errors: 0, lastCapture: null, projects: [], recentErrors: [] });
});

function buildSettingsJson(): string {
  const hooks: Record<string, unknown[]> = {};
  for (const { event, command } of REQUIRED_HOOKS) {
    hooks[event] = [{ matcher: "", hooks: [{ type: "command", command }] }];
  }
  return JSON.stringify({ hooks, mcpServers: { "lcm": {} } });
}

function buildCleanSettingsJson(): string {
  // No hooks in settings.json — hooks are owned by plugin.json, not settings.json.
  // This produces hooks status: "pass" from the doctor.
  return JSON.stringify({ mcpServers: { "lcm": {} } });
}

function minimalDeps(overrides: Partial<Parameters<typeof runDoctor>[0]> = {}) {
  return {
    existsSync: () => true,
    readFileSync: (path: string) => {
      if (path.endsWith("config.json")) return "{}";
      if (path.endsWith("settings.json")) return buildCleanSettingsJson();
      if (path.endsWith("package.json")) return JSON.stringify({ version: "0.5.0" });
      if (path.endsWith("CLAUDE.md")) return "<!-- lcm:start -->\n<!-- Claude Code include: @lcm.md -->\n<!-- lcm:end -->\n";
      if (path.endsWith("lcm.md")) return LCM_MD_CONTENT;
      return "{}";
    },
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    spawnSync: vi.fn(() => ({ status: 0, stdout: "", stderr: "" })),
    fetch: vi.fn().mockResolvedValue({ ok: false }),
    homedir: "/tmp/test-home",
    platform: "darwin",
    ...overrides,
  };
}

describe("runDoctor security section", () => {
  it("shows gitleaks + native pattern counts as pass when generated-patterns.ts exists", async () => {
    const results = await runDoctor(minimalDeps({ cwd: "/tmp/nonexistent-project-xyz" }));
    const detection = results.find((r) => r.name === "secret-detection");
    expect(detection?.status).toBe("pass");
    expect(detection?.message).toContain("gitleaks");
    expect(detection?.message).toContain("native");
    expect(detection?.category).toBe("Security");
  });

  it("shows user pattern counts (no warning when zero project patterns)", async () => {
    const results = await runDoctor(minimalDeps({ cwd: "/tmp/nonexistent-project-xyz" }));
    const userPatterns = results.find((r) => r.name === "user-patterns");
    // No warning for zero patterns — just informational
    expect(userPatterns?.status).toBe("pass");
    expect(userPatterns?.category).toBe("Security");
  });
});

describe("runDoctor lcm-md check", () => {
  it("passes when lcm.md exists and CLAUDE.md has managed block", async () => {
    const results = await runDoctor(minimalDeps({ cwd: "/tmp/nonexistent-project-xyz" }));
    const check = results.find((r) => r.name === "lcm-md");
    expect(check?.status).toBe("pass");
    expect(check?.message).toContain("lcm.md");
  });

  it("auto-restores and reports fixApplied when lcm.md is missing", async () => {
    const written: Record<string, string> = {};
    const deps = minimalDeps({
      cwd: "/tmp/nonexistent-project-xyz",
      existsSync: (p: string) => !p.endsWith("lcm.md"),
      writeFileSync: vi.fn((p: string, c: string) => { written[p] = c; }),
    });
    const results = await runDoctor(deps);
    const check = results.find((r) => r.name === "lcm-md");
    expect(check?.status).toBe("warn");
    expect(check?.fixApplied).toBe(true);
    expect(written["/tmp/test-home/.claude/lcm.md"]).toBeDefined();
  });
});

describe("runDoctor daemon version mismatch", () => {
  it("auto-restarts daemon on version mismatch and reports fixApplied when post-restart version matches", async () => {
    const pkgVersion = "0.6.0";
    const daemonVersion = "0.5.0";

    // ensureDaemon returns connected on restart attempt
    vi.mocked(ensureDaemon).mockResolvedValueOnce({ connected: true, port: 7865, spawned: true });

    const deps = minimalDeps({
      cwd: "/tmp/nonexistent-project-xyz",
      readFileSync: (path: string) => {
        if (path.endsWith("config.json")) return "{}";
        if (path.endsWith("settings.json")) return buildSettingsJson();
        if (path.endsWith("package.json")) return JSON.stringify({ version: pkgVersion });
        if (path.endsWith("CLAUDE.md")) return "<!-- lcm:start -->\n<!-- Claude Code include: @lcm.md -->\n<!-- lcm:end -->\n";
        if (path.endsWith("lcm.md")) return LCM_MD_CONTENT;
        return "{}";
      },
      // First fetch: daemon up with old version; second fetch: post-restart with new version
      fetch: vi.fn()
        .mockResolvedValueOnce({ ok: true, json: async () => ({ status: "ok", version: daemonVersion }) })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ status: "ok", version: pkgVersion }) }),
    });

    const results = await runDoctor(deps);
    const daemonResult = results.find((r) => r.name === "daemon");

    expect(vi.mocked(ensureDaemon)).toHaveBeenCalledWith(
      expect.objectContaining({ expectedVersion: pkgVersion }),
    );
    expect(daemonResult?.fixApplied).toBe(true);
    expect(daemonResult?.message).toContain("restarted");
    expect(daemonResult?.message).toContain(daemonVersion);
    expect(daemonResult?.message).toContain(pkgVersion);
  });

  it("reports warn with fixApplied:false when restart does not fix version mismatch", async () => {
    const pkgVersion = "0.6.0";
    const daemonVersion = "0.5.0";

    vi.mocked(ensureDaemon).mockResolvedValueOnce({ connected: true, port: 7865, spawned: true });

    const deps = minimalDeps({
      cwd: "/tmp/nonexistent-project-xyz",
      readFileSync: (path: string) => {
        if (path.endsWith("config.json")) return "{}";
        if (path.endsWith("settings.json")) return buildSettingsJson();
        if (path.endsWith("package.json")) return JSON.stringify({ version: pkgVersion });
        if (path.endsWith("CLAUDE.md")) return "<!-- lcm:start -->\n<!-- Claude Code include: @lcm.md -->\n<!-- lcm:end -->\n";
        if (path.endsWith("lcm.md")) return LCM_MD_CONTENT;
        return "{}";
      },
      // Post-restart health still returns old version
      fetch: vi.fn()
        .mockResolvedValueOnce({ ok: true, json: async () => ({ status: "ok", version: daemonVersion }) })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ status: "ok", version: daemonVersion }) }),
    });

    const results = await runDoctor(deps);
    const daemonResult = results.find((r) => r.name === "daemon");

    expect(daemonResult?.fixApplied).toBe(false);
    expect(daemonResult?.status).toBe("warn");
    expect(daemonResult?.message).toContain("did not fix mismatch");
    expect(daemonResult?.message).toContain("lcm daemon start --detach");
    expect(daemonResult?.message).not.toContain("lcm daemon restart");
  });

  it("does not recommend event promotion when a stale daemon restart throws", async () => {
    const pkgVersion = "0.6.0";
    const daemonVersion = "0.5.0";
    vi.mocked(ensureDaemon).mockRejectedValueOnce(new Error("restart failed"));
    mockCollectEventStats.mockReturnValue({ captured: 5000, unprocessed: 2000, errors: 0, lastCapture: "2026-03-26 10:00:00", sidecarsWithUnprocessed: 1 });

    const deps = minimalDeps({
      cwd: "/tmp/nonexistent-project-xyz",
      readFileSync: (path: string) => {
        if (path.endsWith("config.json")) return "{}";
        if (path.endsWith("settings.json")) return buildSettingsJson();
        if (path.endsWith("package.json")) return JSON.stringify({ version: pkgVersion });
        if (path.endsWith("CLAUDE.md")) return "<!-- lcm:start -->\n<!-- Claude Code include: @lcm.md -->\n<!-- lcm:end -->\n";
        if (path.endsWith("lcm.md")) return LCM_MD_CONTENT;
        return "{}";
      },
      fetch: vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ status: "ok", version: daemonVersion }) }),
    });

    const results = await runDoctor(deps);
    const capture = results.find((r) => r.name === "events-capture");
    const daemonResult = results.find((r) => r.name === "daemon");

    expect(daemonResult?.message).toContain("lcm daemon start --detach");
    expect(daemonResult?.message).not.toContain("lcm daemon restart");
    expect(capture?.message).toContain("daemon may be offline");
    expect(capture?.message).not.toContain("lcm events promote --all");
  });
});

describe("runDoctor summarizer modes", () => {
  it("reports auto mode as Claude and Codex process defaults", async () => {
    const results = await runDoctor({
      existsSync: () => true,
      readFileSync: (path: string) => {
        if (path.endsWith("config.json")) return JSON.stringify({ llm: { provider: "auto" } });
        if (path.endsWith("settings.json")) return buildSettingsJson();
        if (path.endsWith("package.json")) return JSON.stringify({ version: "0.5.0" });
        return "{}";
      },
      writeFileSync: vi.fn(),
      mkdirSync: vi.fn(),
      spawnSync: vi.fn((cmd: string, args: string[]) => {
        if (cmd === "sh" && args[1]?.includes("command -v claude")) {
          return { status: 0, stdout: "/usr/bin/claude", stderr: "" };
        }
        if (cmd === "sh" && args[1]?.includes("command -v codex")) {
          return { status: 0, stdout: "/usr/bin/codex", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      }),
      fetch: vi.fn().mockResolvedValue({ ok: false }),
      homedir: "/tmp/test-home",
      platform: "darwin",
    });

    expect(results.find((result) => result.name === "stack")?.message).toContain("Summarizer: auto");
    expect(results.some((result) => result.name === "claude-process")).toBe(true);
    expect(results.some((result) => result.name === "codex-process")).toBe(true);
  });
});

describe("Passive Learning checks", () => {
  it("runs passive learning checks when hooks status is warn (auto-fixed duplicates)", async () => {
    // Use deps where hooks check produces "warn" (duplicate hooks in settings.json auto-fixed)
    mockCollectEventStats.mockReturnValue({ captured: 10, unprocessed: 0, errors: 0, lastCapture: null });
    const depsWithBadHooks = minimalDeps({
      readFileSync: (path: string) => {
        if (path.endsWith("settings.json")) return buildSettingsJson(); // duplicate hooks → produces warn
        if (path.endsWith("config.json")) return "{}";
        if (path.endsWith("package.json")) return JSON.stringify({ version: "0.5.0" });
        if (path.endsWith("CLAUDE.md")) return "<!-- lcm:start -->\n<!-- Claude Code include: @lcm.md -->\n<!-- lcm:end -->\n";
        if (path.endsWith("lcm.md")) return LCM_MD_CONTENT;
        return "{}";
      },
    });
    const results = await runDoctor(depsWithBadHooks);
    const plResults = results.filter(r => r.category === "Passive Learning");
    // "warn" status should allow passive learning checks to run
    expect(plResults.length).toBeGreaterThan(0);
  });

  it("warns when hooks installed but no events captured", async () => {
    mockCollectEventStats.mockReturnValue({ captured: 0, unprocessed: 0, errors: 0, lastCapture: null });
    const results = await runDoctor(minimalDeps({
      cwd: "/tmp/test-proj",
      fetch: vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ status: "ok", version: "0.5.0" }) }),
    }));
    const capture = results.find(r => r.name === "events-capture");
    expect(capture?.status).toBe("warn");
    expect(capture?.message).toContain("No events captured");
  });

  it("passes when events exist and low backlog awaits automatic processing", async () => {
    mockCollectEventStats.mockReturnValue({ captured: 100, unprocessed: 5, errors: 0, lastCapture: "2026-03-26 10:00:00" });
    const results = await runDoctor(minimalDeps({
      cwd: "/tmp/test-proj",
      fetch: vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ status: "ok", version: "0.5.0" }) }),
    }));
    const capture = results.find(r => r.name === "events-capture");
    expect(capture?.status).toBe("pass");
    expect(capture?.message).toContain("queued for automatic daemon processing");
  });

  it("warns when unprocessed events reach the passive backlog threshold", async () => {
    mockCollectEventStats.mockReturnValue({ captured: 5000, unprocessed: 200, errors: 0, lastCapture: "2026-03-26 10:00:00" });
    const results = await runDoctor(minimalDeps({
      cwd: "/tmp/test-proj",
      fetch: vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ status: "ok", version: "0.5.0" }) }),
    }));
    const capture = results.find(r => r.name === "events-capture");
    expect(capture?.status).toBe("warn");
    expect(capture?.message).toContain("unprocessed");
  });

  it("does not recommend global drain when every queued sidecar is orphaned", async () => {
    mockCollectEventStats.mockReturnValue({
      captured: 5000,
      unprocessed: 2000,
      errors: 0,
      lastCapture: "2026-03-26 10:00:00",
      sidecarsWithUnprocessed: 2,
      orphanedSidecarsWithUnprocessed: 2,
    });
    const results = await runDoctor(minimalDeps({
      cwd: "/tmp/test-proj",
      fetch: vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ status: "ok", version: "0.5.0" }) }),
    }));
    const capture = results.find(r => r.name === "events-capture");
    expect(capture?.status).toBe("warn");
    expect(capture?.message).toContain("project metadata is missing");
    expect(capture?.message).not.toContain("run: lcm events promote --all");
  });

  it("keeps global drain advice scoped when only some queued sidecars are orphaned", async () => {
    mockCollectEventStats.mockReturnValue({
      captured: 5000,
      unprocessed: 2000,
      errors: 0,
      lastCapture: "2026-03-26 10:00:00",
      sidecarsWithUnprocessed: 3,
      orphanedSidecarsWithUnprocessed: 1,
    });
    const results = await runDoctor(minimalDeps({
      cwd: "/tmp/test-proj",
      fetch: vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ status: "ok", version: "0.5.0" }) }),
    }));
    const capture = results.find(r => r.name === "events-capture");
    expect(capture?.status).toBe("warn");
    expect(capture?.message).toContain("run: lcm events promote --all for metadata-backed sidecars");
    expect(capture?.message).toContain("orphaned sidecars need metadata repair or pruning");
  });

  it("fails when errors >= 50", async () => {
    mockCollectEventStats.mockReturnValue({ captured: 100, unprocessed: 5, errors: 50, lastCapture: "2026-03-26 10:00:00" });
    const results = await runDoctor(minimalDeps({ cwd: "/tmp/test-proj" }));
    const errors = results.find(r => r.name === "events-errors");
    expect(errors?.status).toBe("fail");
  });

  it("passes errors when 0 errors", async () => {
    mockCollectEventStats.mockReturnValue({ captured: 100, unprocessed: 5, errors: 0, lastCapture: "2026-03-26 10:00:00" });
    const results = await runDoctor(minimalDeps({ cwd: "/tmp/test-proj" }));
    const errors = results.find(r => r.name === "events-errors");
    expect(errors?.status).toBe("pass");
  });

  it("warns separately for sidecar scan failures", async () => {
    mockCollectEventStats.mockReturnValue({ captured: 100, unprocessed: 5, errors: 0, scanErrors: 1, lastCapture: "2026-03-26 10:00:00" });
    const results = await runDoctor(minimalDeps({ cwd: "/tmp/test-proj" }));
    const hookErrors = results.find(r => r.name === "events-errors");
    const scanErrors = results.find(r => r.name === "events-sidecar-scan");
    expect(hookErrors?.status).toBe("pass");
    expect(scanErrors?.status).toBe("warn");
    expect(scanErrors?.message).toContain("run lcm doctor --verbose");
  });

  it("reports scan-budget sidecars as skips instead of warnings", async () => {
    mockCollectEventStats.mockReturnValue({ captured: 100, unprocessed: 5, errors: 0, scanSkipped: 4, lastCapture: "2026-03-26 10:00:00" });
    const results = await runDoctor(minimalDeps({ cwd: "/tmp/test-proj" }));
    const scanSkipped = results.find(r => r.name === "events-sidecar-scan-skipped");
    expect(scanSkipped?.status).toBe("skip");
    expect(scanSkipped?.message).toContain("--events-max-dbs all");
    expect(results.find(r => r.name === "events-sidecar-scan")).toBeUndefined();
  });

  it("reports pruned orphan sidecars as auto-fixed pass entries", async () => {
    mockCollectEventStats.mockReturnValue({ captured: 100, unprocessed: 5, errors: 0, prunedSidecars: 2, lastCapture: "2026-03-26 10:00:00" });
    const results = await runDoctor(minimalDeps({ cwd: "/tmp/test-proj" }));
    const pruned = results.find(r => r.name === "events-sidecar-prune");
    expect(pruned?.status).toBe("pass");
    expect(pruned?.fixApplied).toBe(true);
    expect(pruned?.message).toContain("pruned 2");
  });

  it("passes doctor sidecar count limit through to passive learning stats", async () => {
    mockCollectEventStats.mockReturnValue({ captured: 100, unprocessed: 5, errors: 0, lastCapture: "2026-03-26 10:00:00" });
    await runDoctor(minimalDeps({ cwd: "/tmp/test-proj" }), { eventsMaxDbs: 123 });
    expect(mockCollectEventStats).toHaveBeenCalledWith({ timeoutMs: 2000, maxDbs: 123, pruneOrphanSidecars: true });
  });

  it("falls back to the default sidecar count limit for invalid runDoctor options", async () => {
    mockCollectEventStats.mockReturnValue({ captured: 100, unprocessed: 5, errors: 0, lastCapture: "2026-03-26 10:00:00" });
    await runDoctor(minimalDeps({ cwd: "/tmp/test-proj" }), { eventsMaxDbs: 0 });
    expect(mockCollectEventStats).toHaveBeenCalledWith({ timeoutMs: 2000, maxDbs: 50, pruneOrphanSidecars: true });
  });

  it("shows scan failure paths in verbose project output", async () => {
    mockCollectDetailedEventStats.mockReturnValue({
      captured: 0,
      unprocessed: 0,
      errors: 0,
      scanErrors: 1,
      lastCapture: null,
      projects: [{
        file: "corrupt.db",
        projectId: "corrupt",
        metadataMissing: true,
        captured: 0,
        unprocessed: 0,
        lastCapture: null,
        path: "/tmp/lcm-events/corrupt.db",
        scanError: "database disk image is malformed",
      }],
      recentErrors: [],
    });
    const results = await runDoctor(minimalDeps({ cwd: "/tmp/test-proj" }), true);
    const project = results.find(r => r.name === "events-project-corrupt.db");
    expect(project?.status).toBe("warn");
    expect(project?.message).toContain("database disk image is malformed");
    expect(project?.message).toContain("/tmp/lcm-events/corrupt.db");
  });

  it("shows skipped scan paths in verbose project output", async () => {
    mockCollectDetailedEventStats.mockReturnValue({
      captured: 0,
      unprocessed: 0,
      errors: 0,
      scanSkipped: 1,
      lastCapture: null,
      projects: [{
        file: "skipped.db",
        projectId: "skipped",
        metadataMissing: false,
        captured: 0,
        unprocessed: 0,
        lastCapture: null,
        path: "/tmp/lcm-events/skipped.db",
        scanSkipped: "sidecar scan skipped after maxDbs limit",
      }],
      recentErrors: [],
    });
    const results = await runDoctor(minimalDeps({ cwd: "/tmp/test-proj" }), true);
    const project = results.find(r => r.name === "events-project-skipped.db");
    expect(project?.status).toBe("skip");
    expect(project?.message).toContain("scan skipped");
    expect(project?.message).toContain("/tmp/lcm-events/skipped.db");
  });

  it("passes staleness when last capture is recent", async () => {
    const now = new Date();
    const recentCapture = now.toISOString().replace("T", " ").replace("Z", "").split(".")[0];
    mockCollectEventStats.mockReturnValue({ captured: 100, unprocessed: 5, errors: 0, lastCapture: recentCapture });
    const results = await runDoctor(minimalDeps({ cwd: "/tmp/test-proj" }));
    const staleness = results.find(r => r.name === "events-staleness");
    expect(staleness?.status).toBe("pass");
  });

  it("warns staleness when last capture >= 7 days", async () => {
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    const oldCapture = old.toISOString().replace("T", " ").replace("Z", "").split(".")[0];
    mockCollectEventStats.mockReturnValue({ captured: 100, unprocessed: 5, errors: 0, lastCapture: oldCapture });
    const results = await runDoctor(minimalDeps({ cwd: "/tmp/test-proj" }));
    const staleness = results.find(r => r.name === "events-staleness");
    expect(staleness?.status).toBe("warn");
    expect(staleness?.message).toContain("hooks may not be firing");
  });
});
