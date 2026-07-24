import { beforeEach, describe, expect, it, vi, type TestContext } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDoctor } from "../../src/doctor/doctor.js";
import { REQUIRED_HOOKS } from "../../installer/install.js";
import { LCM_MD_CONTENT } from "../../src/daemon/orientation.js";
import { ensureDaemon } from "../../src/daemon/lifecycle.js";
import { hashProjectPath, normalizeProjectPath } from "../../src/project-map.js";

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

function makeTrustedCredentialDir(context: TestContext): string | undefined {
  if (typeof process.getuid !== "function") {
    context.skip();
    return undefined;
  }
  const baseDir = `/run/user/${process.getuid()}/credentials`;
  try {
    if (!existsSync(baseDir)) {
      context.skip();
      return undefined;
    }
    return mkdtempSync(join(baseDir, "lcm-doctor-credentials-"));
  } catch {
    context.skip();
    return undefined;
  }
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

describe("runDoctor project map checks", () => {
  it("fails on invalid map JSON", async () => {
    const home = mkdtempSync(join(tmpdir(), "lcm-doctor-map-invalid-"));
    try {
      mkdirSync(join(home, ".lcm"), { recursive: true });
      writeFileSync(join(home, ".lcm", "map.json"), "{bad-json");

      const results = await runDoctor(minimalDeps({ homedir: home, cwd: "/tmp/nonexistent-project-xyz" }));
      const check = results.find((r) => r.name === "project-map");

      expect(check?.status).toBe("fail");
      expect(check?.message).toContain("map.json");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("auto-formats valid compact map JSON", async () => {
    const home = mkdtempSync(join(tmpdir(), "lcm-doctor-map-format-"));
    try {
      const canonical = join(home, "project");
      mkdirSync(join(home, ".lcm"), { recursive: true });
      mkdirSync(canonical, { recursive: true });
      const hash = hashProjectPath(normalizeProjectPath(canonical));
      const mapPath = join(home, ".lcm", "map.json");
      writeFileSync(mapPath, JSON.stringify({ [hash]: { canonical, aliases: [] } }));

      const results = await runDoctor(minimalDeps({ homedir: home, cwd: "/tmp/nonexistent-project-xyz" }));
      const check = results.find((r) => r.name === "project-map");

      expect(check?.status).toBe("warn");
      expect(check?.fixApplied).toBe(true);
      expect(check?.message).toContain("backup:");
      expect(readFileSync(mapPath, "utf-8")).toBe(JSON.stringify({ [hash]: { canonical, aliases: [] } }, null, 2) + "\n");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("reports a missing project map without depending on validation warning text", async () => {
    const home = mkdtempSync(join(tmpdir(), "lcm-doctor-map-missing-"));
    try {
      mkdirSync(join(home, ".lcm"), { recursive: true });

      const results = await runDoctor(minimalDeps({ homedir: home, cwd: "/tmp/nonexistent-project-xyz" }));
      const check = results.find((r) => r.name === "project-map");

      expect(check?.status).toBe("pass");
      expect(check?.message).toBe("map.json not created yet");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("reports project map auto-fix write failures without aborting doctor", async () => {
    const home = mkdtempSync(join(tmpdir(), "lcm-doctor-map-write-fail-"));
    try {
      const canonical = join(home, "project");
      mkdirSync(join(home, ".lcm"), { recursive: true });
      mkdirSync(canonical, { recursive: true });
      writeFileSync(join(home, ".lcm", "oldmaps"), "not a directory");
      const hash = hashProjectPath(normalizeProjectPath(canonical));
      writeFileSync(join(home, ".lcm", "map.json"), JSON.stringify({ [hash]: { canonical, aliases: [] } }));

      const results = await runDoctor(minimalDeps({ homedir: home, cwd: "/tmp/nonexistent-project-xyz" }));
      const check = results.find((r) => r.name === "project-map");

      expect(check?.status).toBe("fail");
      expect(check?.message).toContain("map.json");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("fails on cross-hash path ambiguity", async () => {
    const home = mkdtempSync(join(tmpdir(), "lcm-doctor-map-ambiguous-"));
    try {
      const first = join(home, "first");
      const second = join(home, "second");
      const shared = join(home, "shared");
      mkdirSync(join(home, ".lcm"), { recursive: true });
      mkdirSync(first, { recursive: true });
      mkdirSync(second, { recursive: true });
      mkdirSync(shared, { recursive: true });
      const firstHash = hashProjectPath(normalizeProjectPath(first));
      const secondHash = hashProjectPath(normalizeProjectPath(second));
      writeFileSync(join(home, ".lcm", "map.json"), JSON.stringify({
        [firstHash]: { canonical: first, aliases: [shared] },
        [secondHash]: { canonical: second, aliases: [shared] },
      }, null, 2) + "\n");

      const results = await runDoctor(minimalDeps({ homedir: home, cwd: "/tmp/nonexistent-project-xyz" }));
      const check = results.find((r) => r.name === "project-map");

      expect(check?.status).toBe("fail");
      expect(check?.message).toContain("multiple hashes");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("runDoctor daemon version mismatch", () => {
  it("restarts a healthy daemon that is not parented by user systemd", async (): Promise<void> => {
    vi.mocked(ensureDaemon).mockResolvedValueOnce({
      connected: true,
      port: 7865,
      spawned: true,
      restartedForParent: true,
      startMethod: "systemd-user",
    });

    const deps = minimalDeps({
      cwd: "/tmp/nonexistent-project-xyz",
      fetch: vi.fn()
        .mockResolvedValueOnce({ ok: true, json: async () => ({ status: "ok", version: "0.5.0" }) })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ status: "ok", version: "0.5.0" }) }),
    });

    const results = await runDoctor(deps);
    const daemonResult = results.find((r) => r.name === "daemon");

    expect(vi.mocked(ensureDaemon)).toHaveBeenCalledWith(
      expect.objectContaining({ enforceUserManagerParent: true }),
    );
    expect(daemonResult?.status).toBe("warn");
    expect(daemonResult?.fixApplied).toBe(true);
    expect(daemonResult?.message).toContain("restarted under user systemd");
  });

  it("warns when Linux fallback starts a daemon without satisfying the parent invariant", async (): Promise<void> => {
    vi.mocked(ensureDaemon).mockResolvedValueOnce({
      connected: true,
      port: 7865,
      spawned: true,
      startMethod: "detached-spawn",
      warning: "user systemd start failed (No medium found); used detached spawn fallback; daemon parent invariant is not satisfied",
    });

    const deps = minimalDeps({
      cwd: "/tmp/nonexistent-project-xyz",
      fetch: vi.fn()
        .mockResolvedValueOnce({ ok: true, json: async () => ({ status: "ok", version: "0.5.0" }) })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ status: "ok", version: "0.5.0" }) }),
    });

    const results = await runDoctor(deps);
    const daemonResult = results.find((r) => r.name === "daemon");

    expect(daemonResult?.status).toBe("warn");
    expect(daemonResult?.fixApplied).toBe(false);
    expect(daemonResult?.message).toContain("daemon parent invariant is not satisfied");
  });

  it("auto-restarts daemon on version mismatch and reports fixApplied when post-restart version matches", async (): Promise<void> => {
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
      expect.objectContaining({ expectedVersion: pkgVersion, expectedStorageBackend: "sqlite" }),
    );
    expect(daemonResult?.fixApplied).toBe(true);
    expect(daemonResult?.message).toContain("restarted");
    expect(daemonResult?.message).toContain(daemonVersion);
    expect(daemonResult?.message).toContain(pkgVersion);
  });

  it("reports warn with fixApplied:false when restart does not fix version mismatch", async (): Promise<void> => {
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
    expect(daemonResult?.message).toContain("lcm daemon start");
    expect(daemonResult?.message).not.toContain("lcm daemon start --detach");
    expect(daemonResult?.message).not.toContain("lcm daemon restart");
  });

  it("treats missing daemon version as a mismatch when package version is known", async (): Promise<void> => {
    const pkgVersion = "0.6.0";

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
      fetch: vi.fn()
        .mockResolvedValueOnce({ ok: true, json: async () => ({ status: "ok" }) })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ status: "ok" }) }),
    });

    const results = await runDoctor(deps);
    const daemonResult = results.find((r) => r.name === "daemon");

    expect(daemonResult?.status).toBe("warn");
    expect(daemonResult?.fixApplied).toBe(false);
    expect(daemonResult?.message).toContain("unknown version running");
    expect(daemonResult?.message).toContain(`v${pkgVersion} installed`);
  });

  it("does not recommend event promotion when a stale daemon restart throws", async (): Promise<void> => {
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

    expect(daemonResult?.message).toContain("lcm daemon start");
    expect(daemonResult?.message).not.toContain("lcm daemon start --detach");
    expect(daemonResult?.message).not.toContain("lcm daemon restart");
    expect(capture?.message).toContain("daemon may be offline");
    expect(capture?.message).not.toContain("lcm events promote --all");
  });

  it("reports daemon validation failure when restart throws without version mismatch", async (): Promise<void> => {
    vi.mocked(ensureDaemon).mockRejectedValueOnce(new Error("restart failed"));

    const deps = minimalDeps({
      cwd: "/tmp/nonexistent-project-xyz",
      fetch: vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ status: "ok", version: "0.5.0" }) }),
    });

    const results = await runDoctor(deps);
    const daemonResult = results.find((r) => r.name === "daemon");

    expect(daemonResult?.status).toBe("warn");
    expect(daemonResult?.message).toContain("daemon validation failed");
    expect(daemonResult?.message).toContain("lcm daemon start");
    expect(daemonResult?.message).not.toContain("lcm daemon start --detach");
  });

  it("reports daemon auto-start warnings when starting an offline daemon", async (): Promise<void> => {
    vi.mocked(ensureDaemon).mockResolvedValueOnce({
      connected: true,
      port: 7865,
      spawned: true,
      startMethod: "detached-spawn",
      warning: "user systemd manager unavailable; daemon parent invariant is not verified",
    });

    const deps = minimalDeps({
      cwd: "/tmp/nonexistent-project-xyz",
      fetch: vi.fn().mockResolvedValueOnce({ ok: false }),
    });

    const results = await runDoctor(deps);
    const daemonResult = results.find((r) => r.name === "daemon");

    expect(daemonResult?.status).toBe("warn");
    expect(daemonResult?.fixApplied).toBe(true);
    expect(daemonResult?.message).toContain("localhost:3737");
    expect(daemonResult?.message).toContain("daemon parent invariant is not verified");
  });

  it("does not recognize a successful HTTP response with unavailable non-staged health", async () => {
    vi.mocked(ensureDaemon).mockResolvedValueOnce({
      connected: true,
      port: 3737,
      spawned: true,
    });
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: "unavailable", version: "0.5.0" }),
    });

    const results = await runDoctor(minimalDeps({
      cwd: "/tmp/nonexistent-project-xyz",
      fetch,
    }));

    expect(fetch).toHaveBeenCalledOnce();
    expect(results.find((result) => result.name === "daemon")).toMatchObject({
      status: "warn",
      fixApplied: true,
    });
    expect(results.find((result) => result.name === "daemon")?.message)
      .toContain("started");
  });

  it("ignores unrecognized health returned after validating a healthy daemon", async () => {
    vi.mocked(ensureDaemon).mockResolvedValueOnce({
      connected: true,
      port: 3737,
      spawned: false,
    });
    const fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ status: "ok", version: "0.5.0" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ status: "unavailable", version: "0.5.0" }),
      });

    const results = await runDoctor(minimalDeps({
      cwd: "/tmp/nonexistent-project-xyz",
      fetch,
    }));

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(results.find((result) => result.name === "daemon")).toMatchObject({
      status: "pass",
      message: "localhost:3737 (up)",
    });
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
    expect(results.find((result) => result.name === "stack")?.message).toContain("Storage: sqlite");
    expect(results.find((result) => result.name === "stack")?.message).toContain("reasoning effort: default");
    expect(results.find((result) => result.name === "stack")?.message).toContain("fast mode: off");
    expect(results.some((result) => result.name === "claude-process")).toBe(true);
    expect(results.some((result) => result.name === "codex-process")).toBe(true);
  });

  it("reports portable process-provider failures without managed PATH wording", async () => {
    const results = await runDoctor({
      ...minimalDeps({
        readFileSync: (path: string) => {
          if (path.endsWith("config.json")) return JSON.stringify({ llm: { provider: "auto" } });
          if (path.endsWith("settings.json")) return buildCleanSettingsJson();
          if (path.endsWith("package.json")) return JSON.stringify({ version: "0.5.0" });
          if (path.endsWith("lcm.md")) return LCM_MD_CONTENT;
          return "{}";
        },
        platform: "darwin",
      }),
      spawnSync: vi.fn((cmd: string, args: string[]) => ({
        status: cmd === "sh" && args[1]?.startsWith("command -v ") ? 1 : 0,
        stdout: "",
        stderr: "",
      })),
    });

    expect(results.find((result) => result.name === "claude-process")?.message)
      .toContain("claude CLI not found\n");
    expect(results.find((result) => result.name === "codex-process")?.message)
      .toContain("codex CLI not found\n");
    expect(results.filter((result) => result.category === "Summarizer").every((result) =>
      !result.message.includes("managed daemon PATH"),
    )).toBe(true);
  });

  it("reports effective process reasoning and fast-mode controls", async () => {
    const results = await runDoctor(minimalDeps({
      readFileSync: (path: string) => {
        if (path.endsWith("config.json")) return JSON.stringify({
          llm: { provider: "codex-process", reasoningEffort: "minimal", fastMode: true },
        });
        if (path.endsWith("settings.json")) return buildCleanSettingsJson();
        if (path.endsWith("package.json")) return JSON.stringify({ version: "0.5.0" });
        if (path.endsWith("CLAUDE.md")) return "<!-- lcm:start -->\n<!-- Claude Code include: @lcm.md -->\n<!-- lcm:end -->\n";
        if (path.endsWith("lcm.md")) return LCM_MD_CONTENT;
        return "{}";
      },
    }));
    const stack = results.find((result) => result.name === "stack");
    expect(stack?.message).toContain("Summarizer: codex-process");
    expect(stack?.message).toContain("reasoning effort: minimal");
    expect(stack?.message).toContain("fast mode: on");
  });

  it("reports effective OpenAI API mode, reasoning effort, timeout, and retry policy", async () => {
    const results = await runDoctor(minimalDeps({
      readFileSync: (path: string) => {
        if (path.endsWith("config.json")) return JSON.stringify({
          llm: {
            provider: "openai",
            model: "gpt-test",
            baseUrl: "http://localhost:11435/v1",
            apiMode: "responses",
            reasoningEffort: "medium",
            requestTimeoutMs: 45_000,
            retry: { maxAttempts: 4, initialDelayMs: 250, maxDelayMs: 2_000, multiplier: 1.5 },
          },
        });
        if (path.endsWith("settings.json")) return buildCleanSettingsJson();
        if (path.endsWith("package.json")) return JSON.stringify({ version: "0.5.0" });
        if (path.endsWith("CLAUDE.md")) return "<!-- lcm:start -->\n<!-- Claude Code include: @lcm.md -->\n<!-- lcm:end -->\n";
        if (path.endsWith("lcm.md")) return LCM_MD_CONTENT;
        return "{}";
      },
    }));
    const stack = results.find((result) => result.name === "stack");
    expect(stack?.message).toContain("API mode: responses");
    expect(stack?.message).toContain("reasoning effort: medium");
    expect(stack?.message).toContain("timeout: 45000ms");
    expect(stack?.message).toContain("retry: 4 attempts, 250-2000ms x1.5");
  });
});

describe("runDoctor configuration validation", () => {
  it("keeps the summarizer disabled when config.json is missing", async () => {
    const results = await runDoctor(minimalDeps({
      existsSync: (path: string) => !path.endsWith("config.json"),
    }));

    expect(results.find((result) => result.name === "stack")?.message).toContain("Summarizer: disabled");
    expect(results.find((result) => result.name === "stack")?.message).not.toContain("Summarizer: auto");
    expect(results.find((result) => result.name === "config")).toMatchObject({
      status: "fail",
      message: "Missing — run: lcm install",
    });
  });

  it("resolves provider API keys from the daemon's systemd credential environment", async (context: TestContext) => {
    const credentialsDir = makeTrustedCredentialDir(context);
    if (credentialsDir === undefined) return;
    const previousCredentialsDirectory = process.env.CREDENTIALS_DIRECTORY;
    const previousCredentialIds = process.env.LCM_SYSTEMD_CRED_IDS;
    const previousAnthropicKey = process.env.ANTHROPIC_API_KEY;
    const previousSummaryKey = process.env.LCM_SUMMARY_API_KEY;
    try {
      writeFileSync(join(credentialsDir, "ANTHROPIC_API_KEY"), "sk-doctor-credential\n", { mode: 0o600 });
      process.env.CREDENTIALS_DIRECTORY = credentialsDir;
      process.env.LCM_SYSTEMD_CRED_IDS = "ANTHROPIC_API_KEY";
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.LCM_SUMMARY_API_KEY;

      const results = await runDoctor(minimalDeps({
        readFileSync: (path: string) => {
          if (path.endsWith("config.json")) {
            return JSON.stringify({ llm: { provider: "anthropic", model: "claude-sonnet" } });
          }
          return minimalDeps().readFileSync(path, "utf-8");
        },
      }));

      expect(results.find((result) => result.name === "config")).toMatchObject({ status: "pass" });
      expect(results.find((result) => result.name === "stack")?.message).toContain("Summarizer: anthropic");
    } finally {
      rmSync(credentialsDir, { recursive: true, force: true });
      if (previousCredentialsDirectory === undefined) delete process.env.CREDENTIALS_DIRECTORY;
      else process.env.CREDENTIALS_DIRECTORY = previousCredentialsDirectory;
      if (previousCredentialIds === undefined) delete process.env.LCM_SYSTEMD_CRED_IDS;
      else process.env.LCM_SYSTEMD_CRED_IDS = previousCredentialIds;
      if (previousAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previousAnthropicKey;
      if (previousSummaryKey === undefined) delete process.env.LCM_SUMMARY_API_KEY;
      else process.env.LCM_SUMMARY_API_KEY = previousSummaryKey;
    }
  });

  it("fails the config check, redacts secrets, and continues diagnostics", async () => {
    const secrets = [
      "Bearer doctor-authorization-secret",
      "Basic doctor-proxy-secret",
      "doctor-cookie-secret",
      "doctor-custom-auth-secret",
    ];
    const results = await runDoctor(minimalDeps({
      readFileSync: (path: string) => {
        if (path.endsWith("config.json")) {
          return JSON.stringify({
            llm: {
              baseURL: {
                headers: {
                  Authorization: secrets[0],
                  "Proxy-Authorization": secrets[1],
                  Cookie: secrets[2],
                  "X-Custom-Auth": secrets[3],
                },
              },
            },
          });
        }
        if (path.endsWith("settings.json")) return buildCleanSettingsJson();
        if (path.endsWith("package.json")) return JSON.stringify({ version: "0.5.0" });
        if (path.endsWith("CLAUDE.md")) return "<!-- lcm:start -->\n<!-- Claude Code include: @lcm.md -->\n<!-- lcm:end -->\n";
        if (path.endsWith("lcm.md")) return LCM_MD_CONTENT;
        return "{}";
      },
    }));
    const config = results.find((result) => result.name === "config");
    const stack = results.find((result) => result.name === "stack");
    expect(config?.status).toBe("fail");
    expect(config?.message).toContain("ConfigValidationError");
    expect(config?.message).toContain("llm.baseURL");
    expect(config?.message).toContain("[REDACTED]");
    for (const secret of secrets) expect(JSON.stringify(results)).not.toContain(secret);
    expect(stack?.status).toBe("pass");
    expect(stack?.message).toContain("Storage: unavailable");
    expect(stack?.message).toContain("Summarizer: unavailable");
    expect(results.some((result) => result.name === "secret-detection")).toBe(true);
  });

  it("uses a valid configured daemon port when another config field is invalid", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: false });
    const results = await runDoctor(minimalDeps({
      fetch,
      readFileSync: (path: string) => {
        if (path.endsWith("config.json")) {
          return JSON.stringify({ daemon: { port: 4545 }, llm: { provider: "invalid" } });
        }
        return minimalDeps().readFileSync(path);
      },
    }));

    expect(results.find((result) => result.name === "config")).toMatchObject({ status: "fail" });
    expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:4545/health");
    expect(ensureDaemon).not.toHaveBeenCalled();
    expect(results.find((result) => result.name === "daemon")?.message).toContain("localhost:4545");
  });

  it("does not transition a healthy SQLite daemon from an invalid PostgreSQL config", async () => {
    const previousUrl = process.env.LCM_POSTGRES_URL;
    const previousCaFile = process.env.LCM_POSTGRES_CA_FILE;
    delete process.env.LCM_POSTGRES_URL;
    delete process.env.LCM_POSTGRES_CA_FILE;
    try {
      const fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ status: "ok", version: "0.5.0", storageBackend: "sqlite", pid: 4242 }),
      });
      const results = await runDoctor(minimalDeps({
        fetch,
        readFileSync: (path: string) => {
          if (path.endsWith("config.json")) {
            return JSON.stringify({ storage: { backend: "postgresql" } });
          }
          return minimalDeps().readFileSync(path);
        },
      }));

      expect(results.find((result) => result.name === "config")).toMatchObject({ status: "fail" });
      expect(results.find((result) => result.name === "stack")?.message).toContain("Storage: unavailable");
      expect(results.find((result) => result.name === "daemon")).toMatchObject({
        status: "warn",
        fixApplied: false,
      });
      expect(results.find((result) => result.name === "daemon")?.message).toContain("repair skipped because config is invalid");
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(ensureDaemon).not.toHaveBeenCalled();
    } finally {
      if (previousUrl === undefined) delete process.env.LCM_POSTGRES_URL;
      else process.env.LCM_POSTGRES_URL = previousUrl;
      if (previousCaFile === undefined) delete process.env.LCM_POSTGRES_CA_FILE;
      else process.env.LCM_POSTGRES_CA_FILE = previousCaFile;
    }
  });

  it("checks a valid PostgreSQL selection through daemon health and lifecycle", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lcm-doctor-postgres-"));
    const caFile = join(dir, "ca.pem");
    writeFileSync(caFile, "test-ca");
    const previousUrl = process.env.LCM_POSTGRES_URL;
    const previousCaFile = process.env.LCM_POSTGRES_CA_FILE;
    process.env.LCM_POSTGRES_URL = "postgresql://user:password@db.example/lcm";
    process.env.LCM_POSTGRES_CA_FILE = caFile;
    const fetch = vi.fn();
    try {
      for (const provider of ["auto", "openai"] as const) {
        const results = await runDoctor(minimalDeps({
          fetch,
          readFileSync: (path: string) => {
            if (path.endsWith("config.json")) {
              return JSON.stringify({
                storage: { backend: "postgresql" },
                llm: provider === "openai"
                  ? { provider, model: "gpt-5", baseUrl: "http://127.0.0.1:1234/v1" }
                  : { provider },
              });
            }
            return minimalDeps().readFileSync(path);
          },
        }));

        const configResult = results.find((result) => result.name === "config");
        expect(configResult, configResult?.message).toMatchObject({ status: "pass" });
        expect(results.find((result) => result.name === "stack")?.message).toContain("Storage: postgresql");
        expect(results.find((result) => result.name === "daemon")).toMatchObject({ status: "fail" });
        expect(results.find((result) => result.name === "daemon")?.message).toContain("not responding");
      }
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(ensureDaemon).toHaveBeenCalledTimes(2);
    } finally {
      if (previousUrl === undefined) delete process.env.LCM_POSTGRES_URL;
      else process.env.LCM_POSTGRES_URL = previousUrl;
      if (previousCaFile === undefined) delete process.env.LCM_POSTGRES_CA_FILE;
      else process.env.LCM_POSTGRES_CA_FILE = previousCaFile;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("recognizes exact staged PostgreSQL health without reporting a daemon start", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lcm-doctor-postgres-staged-"));
    const caFile = join(dir, "ca.pem");
    writeFileSync(caFile, "test-ca");
    const previousUrl = process.env.LCM_POSTGRES_URL;
    const previousCaFile = process.env.LCM_POSTGRES_CA_FILE;
    process.env.LCM_POSTGRES_URL = "postgresql://user:password@db.example/lcm";
    process.env.LCM_POSTGRES_CA_FILE = caFile;
    const stagedHealth = {
      status: "unavailable",
      version: "0.5.0",
      storageBackend: "postgresql",
      uptime: 10,
      pid: 4242,
      storage: {
        status: "unavailable",
        error: {
          code: "STORAGE_INITIALIZATION_FAILED",
          backend: "postgresql",
          domain: "factory",
          operation: "health",
        },
      },
    };
    const fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => stagedHealth,
    });
    vi.mocked(ensureDaemon).mockResolvedValueOnce({
      connected: true,
      port: 3737,
      spawned: false,
      pid: 4242,
      startMethod: "existing",
    });
    try {
      const results = await runDoctor(minimalDeps({
        fetch,
        readFileSync: (path: string) => {
          if (path.endsWith("config.json")) {
            return JSON.stringify({ storage: { backend: "postgresql" } });
          }
          return minimalDeps().readFileSync(path);
        },
      }));

      expect(ensureDaemon).toHaveBeenCalledWith(expect.objectContaining({
        expectedStorageBackend: "postgresql",
        expectedVersion: "0.5.0",
      }));
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(results.find((result) => result.name === "daemon")).toMatchObject({
        status: "pass",
        message: "localhost:3737 (up)",
      });
      expect(results.find((result) => result.name === "daemon")?.fixApplied)
        .not.toBe(true);
    } finally {
      if (previousUrl === undefined) delete process.env.LCM_POSTGRES_URL;
      else process.env.LCM_POSTGRES_URL = previousUrl;
      if (previousCaFile === undefined) delete process.env.LCM_POSTGRES_CA_FILE;
      else process.env.LCM_POSTGRES_CA_FILE = previousCaFile;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([0, 65536, 4545.5, "4545"])(
    "does not use invalid daemon port %j while reporting config errors",
    async (port) => {
      const fetch = vi.fn().mockResolvedValue({ ok: false });
      await runDoctor(minimalDeps({
        fetch,
        readFileSync: (path: string) => {
          if (path.endsWith("config.json")) {
            return JSON.stringify({ daemon: { port }, llm: { provider: "invalid" } });
          }
          return minimalDeps().readFileSync(path);
        },
      }));

      expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:3737/health");
      expect(ensureDaemon).not.toHaveBeenCalled();
    },
  );

  it("reports malformed JSON without aborting doctor", async () => {
    const results = await runDoctor(minimalDeps({
      readFileSync: (path: string) => path.endsWith("config.json") ? "{" : minimalDeps().readFileSync(path),
    }));
    expect(results.find((result) => result.name === "config")).toMatchObject({ status: "fail" });
    expect(results.find((result) => result.name === "config")?.message).toContain("malformed JSON");
    expect(results.some((result) => result.name === "project-map")).toBe(true);
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
    vi.mocked(ensureDaemon).mockResolvedValueOnce({ connected: true, port: 3737, spawned: false });
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
    vi.mocked(ensureDaemon).mockResolvedValueOnce({ connected: true, port: 3737, spawned: false });
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

  it("sanitizes untrusted sidecar diagnostics before terminal display", async () => {
    mockCollectDetailedEventStats.mockReturnValue({
      captured: 0,
      unprocessed: 0,
      errors: 1,
      lastCapture: null,
      projects: [{
        file: "bad\x1b[31m.db",
        projectId: "bad",
        metadataMissing: false,
        captured: 0,
        unprocessed: 0,
        lastCapture: null,
        path: "/tmp/bad\npath.db",
        scanError: "failure\x1b]52;c;YQ==\x07",
      }],
      recentErrors: [{ created_at: "now", hook: "hook\rspoof", error: "error\x1b[2J" }],
    });
    const results = await runDoctor(minimalDeps({ cwd: "/tmp/test-proj" }), true);
    const output = results.map(result => `${result.name}\n${result.message}`).join("\n");
    expect(output).toContain("bad.db");
    expect(output).toContain("bad path.db");
    expect(output).toContain("hook spoof: error");
    expect(output).not.toContain("\x1b");
    expect(output).not.toContain("\r");
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
