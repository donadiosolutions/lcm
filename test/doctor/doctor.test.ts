import { afterEach, beforeEach, describe, expect, it, vi, type TestContext } from "vitest";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync, symlinkSync, lstatSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDoctor } from "../../src/doctor/doctor.js";
import { PrivateMutationLockContentionError } from "../../src/private-mutation-lock.js";
import { renderGuidance } from "../../src/connectors/template-service.js";
import { mergeClaudeSettings, REQUIRED_HOOKS } from "../../installer/install.js";
import { legacyLcmMcpServerName } from "../../src/legacy-names.js";
import { LCM_MD_CONTENT } from "../../src/daemon/orientation.js";
import { ensureDaemon, restartDaemon } from "../../src/daemon/lifecycle.js";
import { emitDaemonNotice } from "../../src/hooks/daemon-notice.js";
import { daemonRemediationMarkerPath } from "../../src/daemon/remediation.js";
import { packageExecutable } from "../../src/runtime-root.js";
import {
  clearProjectMapCache,
  hashProjectPath,
  normalizeProjectPath,
} from "../../src/project-map.js";
import * as projectMapModule from "../../src/project-map.js";
import {
  BackendPublicationJournalError,
  backendPublicationCanonicalSha256,
  withBackendPublicationConfigLockAsync,
} from "../../src/storage/backend-publication.js";

vi.mock("../../src/daemon/lifecycle.js", () => ({
  ensureDaemon: vi.fn().mockResolvedValue({ connected: false }),
  restartDaemon: vi.fn().mockResolvedValue({ connected: false, restarted: false }),
}));

vi.mock("../../src/db/events-stats.js", () => ({
  collectEventStats: vi.fn().mockReturnValue({ captured: 0, unprocessed: 0, errors: 0, lastCapture: null }),
  collectDetailedEventStats: vi.fn().mockReturnValue({ captured: 0, unprocessed: 0, errors: 0, lastCapture: null, projects: [], recentErrors: [] }),
}));

import { collectDetailedEventStats, collectEventStats } from "../../src/db/events-stats.js";
const mockCollectEventStats = vi.mocked(collectEventStats);
const mockCollectDetailedEventStats = vi.mocked(collectDetailedEventStats);
let defaultDoctorHome: string;
const TEST_RUNTIME_ENTRYPOINT = packageExecutable(import.meta.url, 3);

beforeEach(() => {
  defaultDoctorHome = mkdtempSync(join(tmpdir(), "lcm-doctor-default-home-"));
  chmodSync(defaultDoctorHome, 0o700);
  mkdirSync(join(defaultDoctorHome, ".lcm"), { recursive: true, mode: 0o700 });
  vi.mocked(ensureDaemon).mockReset();
  vi.mocked(ensureDaemon).mockResolvedValue({ connected: false });
  vi.mocked(restartDaemon).mockReset();
  vi.mocked(restartDaemon).mockResolvedValue({ connected: false, restarted: false });
  mockCollectEventStats.mockClear();
  mockCollectDetailedEventStats.mockClear();
  mockCollectEventStats.mockReturnValue({ captured: 0, unprocessed: 0, errors: 0, lastCapture: null });
  mockCollectDetailedEventStats.mockReturnValue({ captured: 0, unprocessed: 0, errors: 0, lastCapture: null, projects: [], recentErrors: [] });
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(defaultDoctorHome, { recursive: true, force: true });
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
      if (path.endsWith("lcm-memory/SKILL.md")) return renderGuidance("skill", "mcp");
      return "{}";
    },
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    spawnSync: vi.fn(() => ({ status: 0, stdout: "", stderr: "" })),
    fetch: vi.fn().mockResolvedValue({ ok: false }),
    _testMcpHandshake: vi.fn().mockResolvedValue({
      name: "mcp-handshake-lcm",
      category: "MCP Servers",
      status: "pass",
      message: "lcm: 7/7 tools",
    }),
    homedir: defaultDoctorHome,
    platform: "darwin",
    _assertBackendPublication: () => undefined,
    ...overrides,
  };
}

function writeLivePublicationOwner(home: string): void {
  const stat = readFileSync(`/proc/${process.pid}/stat`, "utf8");
  const processStartTime = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? "";
  writeFileSync(join(home, ".lcm.backend-publication.lock"), `${JSON.stringify({
    version: 1,
    pid: process.pid,
    processStartTime,
    nonce: "a".repeat(32),
    createdAtMs: Date.now(),
  })}\n`, { mode: 0o600 });
}

describe("doctor test fixture isolation", () => {
  it("uses an owned existing home for default dependencies", () => {
    const deps = minimalDeps();

    expect(deps.homedir).not.toBe("/tmp/test-home");
    expect(existsSync(deps.homedir)).toBe(true);
    expect(existsSync(join(deps.homedir, ".lcm"))).toBe(true);
  });
});

function publicationFileWitness(content: string | null): Record<string, unknown> {
  if (content === null) {
    return {
      presence: "absent",
      rawSha256: null,
      semanticSha256: null,
      byteLength: 0,
      mode: null,
      uid: null,
      gid: null,
      nlink: null,
      dev: null,
      ino: null,
      parentDev: null,
      parentIno: null,
    };
  }
  return {
    presence: "present",
    rawSha256: createHash("sha256").update(content).digest("hex"),
    semanticSha256: backendPublicationCanonicalSha256(JSON.parse(content)),
    byteLength: Buffer.byteLength(content),
    mode: 0o600,
    uid: 0,
    gid: 0,
    nlink: "1",
    dev: "1",
    ino: "1",
    parentDev: "1",
    parentIno: "1",
  };
}

function writeCompletedPublicationJournal(home: string, targetConfig: string | null): void {
  const publicationDir = join(home, ".lcm", "backend-publication");
  mkdirSync(publicationDir, { recursive: true, mode: 0o700 });
  const sourceConfig = "{}";
  const absentProjectMap = publicationFileWitness(null);
  const payload = {
    version: 2,
    publicationId: "doctor-sentinel-test",
    sourceBackend: "postgresql",
    targetBackend: "sqlite",
    phase: "completed",
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T00:00:00.000Z",
    expectedConfigSha256: createHash("sha256").update(sourceConfig).digest("hex"),
    expectedProjectMapSha256: backendPublicationCanonicalSha256({}),
    intendedConfigSha256: targetConfig === null
      ? createHash("sha256").update("{}").digest("hex")
      : createHash("sha256").update(targetConfig).digest("hex"),
    intendedProjectMapSha256: backendPublicationCanonicalSha256({}),
    publishedConfigSha256: null,
    publishedProjectMapSha256: null,
    recoveryReference: null,
    sourceState: {
      config: publicationFileWitness(sourceConfig),
      projectMap: absentProjectMap,
    },
    targetState: {
      config: publicationFileWitness(targetConfig),
      projectMap: absentProjectMap,
    },
    projects: [],
  };
  const journal = {
    ...payload,
    checksumSha256: backendPublicationCanonicalSha256(payload),
  };
  writeFileSync(
    join(publicationDir, "journal.json"),
    `${JSON.stringify(journal)}\n`,
    { mode: 0o600 },
  );
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

describe("runDoctor canonical Claude skill check", () => {
  it("passes when the canonical lcm-memory skill exists", async () => {
    const results = await runDoctor(minimalDeps({ cwd: "/tmp/nonexistent-project-xyz" }));
    const check = results.find((r) => r.name === "lcm-md");
    expect(check?.status).toBe("pass");
    expect(check?.message).toContain("lcm-memory");
  });

  it("repairs the canonical skill when it is missing", async () => {
    const written: Record<string, string> = {};
    const deps = minimalDeps({
      cwd: "/tmp/nonexistent-project-xyz",
      existsSync: (p: string) => !p.endsWith("lcm.md") && !p.endsWith("lcm-memory/SKILL.md"),
      writeFileSync: vi.fn((p: string, c: string) => { written[p] = c; }),
    });
    const results = await runDoctor(deps);
    const check = results.find((r) => r.name === "lcm-md");
    expect(check?.status).toBe("warn");
    expect(check?.fixApplied).toBe(true);
    expect(written[join(defaultDoctorHome, ".claude", "skills", "lcm-memory", "SKILL.md")]).toBeDefined();
  });

  it("uses filesystem inspection before removing a recognized legacy skill", async () => {
    const legacySkillPath = join(defaultDoctorHome, ".claude", "skills", "lcm-context");
    mkdirSync(legacySkillPath, { recursive: true });
    writeFileSync(join(legacySkillPath, "SKILL.md"), "legacy lcm guidance\n");
    const baseReadFileSync = minimalDeps().readFileSync;

    const results = await runDoctor(minimalDeps({
      readFileSync: (path: string, encoding: string) => path.startsWith(`${legacySkillPath}/`)
        ? readFileSync(path, encoding as BufferEncoding)
        : baseReadFileSync(path, encoding),
      lstatSync,
      readdirSync,
    }));

    expect(results.find((result) => result.name === "lcm-md")?.status).toBe("pass");
    expect(existsSync(legacySkillPath)).toBe(false);
  });
});

describe("runDoctor Claude integration ownership", () => {
  it("persists legacy MCP cleanup when native hooks and the lcm MCP server are current", async () => {
    const runtimePath = join(process.cwd(), "dist", "lcm.mjs");
    const settings = mergeClaudeSettings({}, runtimePath);
    settings.mcpServers = {
      lcm: { type: "stdio", command: process.execPath, args: [runtimePath, "mcp"] },
      [legacyLcmMcpServerName()]: { command: "legacy" },
      unrelated: { command: "preserved" },
    };
    const writes = vi.fn();

    const results = await runDoctor(minimalDeps({
      readFileSync: (path: string) => {
        if (path.endsWith("settings.json")) return JSON.stringify(settings);
        return minimalDeps().readFileSync(path);
      },
      writeFileSync: writes,
    }));

    const settingsWrite = writes.mock.calls.find(([path]) => path.endsWith("settings.json"));
    expect(settingsWrite).toBeDefined();
    const persisted = JSON.parse(settingsWrite![1]);
    expect(persisted.mcpServers).toEqual({
      lcm: { type: "stdio", command: process.execPath, args: [runtimePath, "mcp"] },
      unrelated: { command: "preserved" },
    });
    expect(results.find((result) => result.name === "hooks")?.status).toBe("pass");
    expect(results.find((result) => result.name === "mcp-lcm")).toMatchObject({
      status: "warn",
      fixApplied: true,
      message: "Removed the legacy lossless-claude MCP registration",
    });
  });

  it("leaves an absent Claude integration read-only during Codex-only doctor runs", async () => {
    const writes = vi.fn();
    const results = await runDoctor(minimalDeps({
      existsSync: (path: string) => !path.endsWith(".claude/settings.json"),
      writeFileSync: writes,
    }));

    expect(writes.mock.calls.filter(([path]) => path.includes("/.claude/"))).toEqual([]);
    for (const name of ["hooks", "mcp-lcm", "lcm-md"]) {
      expect(results.find((result) => result.name === name)).toMatchObject({
        status: "pass",
        message: "Claude Code integration is not installed",
      });
    }
  });
});

describe("runDoctor project map checks", () => {
  it("admits a doctor read while the publication lock is held", async () => {
    const home = mkdtempSync(join(tmpdir(), "lcm-doctor-lock-contention-"));
    mkdirSync(join(home, ".lcm"), { recursive: true, mode: 0o700 });
    writeFileSync(join(home, ".lcm", "config.json"), "{}\n", { mode: 0o600 });
    try {
      await withBackendPublicationConfigLockAsync(join(home, ".lcm", "config.json"), async () => {
        const results = await runDoctor(minimalDeps({ homedir: home, _assertBackendPublication: undefined }));
        expect(results.find((result) => result.name === "config")).toMatchObject({ status: "pass" });
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("converges lifecycle admission only after authenticated daemon contention releases", async () => {
    const home = mkdtempSync(join(tmpdir(), "lcm-doctor-lifecycle-contention-"));
    const configPath = join(home, ".lcm", "config.json");
    mkdirSync(join(home, ".lcm"), { recursive: true, mode: 0o700 });
    writeFileSync(configPath, "{}\n", { mode: 0o600 });
    let signalLifecycleAttempt!: () => void;
    const lifecycleAttempted = new Promise<void>(resolve => { signalLifecycleAttempt = resolve; });
    const contention = new PrivateMutationLockContentionError("publication lock is busy");
    vi.mocked(ensureDaemon)
      .mockImplementationOnce(async () => {
        signalLifecycleAttempt();
        throw contention;
      })
      .mockResolvedValueOnce({ connected: false });
    const deps = minimalDeps({
      homedir: home,
      _assertBackendPublication: undefined,
      fetch: vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ status: "ok", version: "0.5.0", storageBackend: "sqlite", pid: process.pid, entrypoint: TEST_RUNTIME_ENTRYPOINT }),
      }),
      readFileSync: (path: string) => path.endsWith("daemon.token")
        ? "doctor-token"
        : minimalDeps().readFileSync(path),
    });
    let pending!: Promise<Awaited<ReturnType<typeof runDoctor>>>;
    const holder = withBackendPublicationConfigLockAsync(configPath, async () => {
      pending = runDoctor(deps);
      await lifecycleAttempted;
    });
    // The holder callback returns after the first contention, releasing the
    // lock while doctor remains in its bounded convergence helper.
    await holder;
    const results = await pending;
    expect(results.find((result) => result.name === "daemon")).toBeDefined();
    rmSync(home, { recursive: true, force: true });
  });

  it("keeps lifecycle contention fail closed for a foreign daemon owner", async () => {
    const home = mkdtempSync(join(tmpdir(), "lcm-doctor-foreign-contention-"));
    const configPath = join(home, ".lcm", "config.json");
    mkdirSync(join(home, ".lcm"), { recursive: true, mode: 0o700 });
    writeFileSync(configPath, "{}\n", { mode: 0o600 });
    let signalLifecycleAttempt!: () => void;
    const lifecycleAttempted = new Promise<void>(resolve => { signalLifecycleAttempt = resolve; });
    const contention = new PrivateMutationLockContentionError("publication lock is busy");
    vi.mocked(ensureDaemon).mockImplementationOnce(async () => {
      signalLifecycleAttempt();
      throw contention;
    });
    const foreignPid = process.pid + 1;
    const deps = minimalDeps({
      homedir: home,
      _assertBackendPublication: undefined,
      fetch: vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ status: "ok", version: "0.5.0", storageBackend: "sqlite", pid: foreignPid, entrypoint: TEST_RUNTIME_ENTRYPOINT }),
      }),
    });
    let pending!: Promise<Awaited<ReturnType<typeof runDoctor>>>;
    const holder = withBackendPublicationConfigLockAsync(configPath, async () => {
      pending = runDoctor(deps);
      await lifecycleAttempted;
    });
    await holder;
    const results = await pending;
    expect(vi.mocked(ensureDaemon)).toHaveBeenCalledOnce();
    expect(results.find((result) => result.name === "daemon")?.status).toBe("warn");
    rmSync(home, { recursive: true, force: true });
  });

  it("does not retry version-mismatch repair through daemon-owned contention", async () => {
    const home = mkdtempSync(join(tmpdir(), "lcm-doctor-version-contention-"));
    const configPath = join(home, ".lcm", "config.json");
    mkdirSync(join(home, ".lcm"), { recursive: true, mode: 0o700 });
    writeFileSync(configPath, "{}\n", { mode: 0o600 });
    let signalLifecycleAttempt!: () => void;
    const lifecycleAttempted = new Promise<void>(resolve => { signalLifecycleAttempt = resolve; });
    const contention = new PrivateMutationLockContentionError("publication lock is busy");
    vi.mocked(restartDaemon).mockImplementationOnce(async () => {
      signalLifecycleAttempt();
      throw contention;
    });
    const deps = minimalDeps({
      homedir: home,
      _assertBackendPublication: undefined,
      fetch: vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ status: "ok", version: "0.4.0", storageBackend: "sqlite", pid: process.pid, entrypoint: TEST_RUNTIME_ENTRYPOINT }),
      }),
    });
    let pending!: Promise<Awaited<ReturnType<typeof runDoctor>>>;
    const holder = withBackendPublicationConfigLockAsync(configPath, async () => {
      pending = runDoctor(deps);
      await lifecycleAttempted;
    });
    await holder;
    await pending;
    expect(vi.mocked(restartDaemon)).toHaveBeenCalledOnce();
    rmSync(home, { recursive: true, force: true });
  });

  it.each([
    ["entrypoint", { entrypoint: "/foreign/lcm.mjs" }, {}],
    ["runtime digest", { entrypoint: TEST_RUNTIME_ENTRYPOINT, runtimeDigest: "b".repeat(64) }, { _expectedRuntimeDigestForTesting: "a".repeat(64) }],
  ] as const)("does not converge when authenticated daemon %s identity changes", async (_label, healthIdentity, seam) => {
    const home = mkdtempSync(join(tmpdir(), "lcm-doctor-identity-contention-"));
    const configPath = join(home, ".lcm", "config.json");
    mkdirSync(join(home, ".lcm"), { recursive: true, mode: 0o700 });
    writeFileSync(configPath, "{}\n", { mode: 0o600 });
    writeLivePublicationOwner(home);
    const contention = new PrivateMutationLockContentionError("publication lock is busy");
    vi.mocked(ensureDaemon).mockImplementationOnce(async () => { throw contention; });
    const deps = minimalDeps({
      homedir: home,
      _assertBackendPublication: undefined,
      ...seam,
      fetch: vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ status: "ok", version: "0.5.0", storageBackend: "sqlite", pid: process.pid, ...healthIdentity }),
      }),
    });
    const results = await runDoctor(deps);
    expect(vi.mocked(ensureDaemon)).toHaveBeenCalledOnce();
    expect(results.find((result) => result.name === "daemon")).toBeDefined();
    rmSync(home, { recursive: true, force: true });
  });

  it("preserves typed contention at the convergence deadline", async () => {
    const home = mkdtempSync(join(tmpdir(), "lcm-doctor-deadline-contention-"));
    const configPath = join(home, ".lcm", "config.json");
    mkdirSync(join(home, ".lcm"), { recursive: true, mode: 0o700 });
    writeFileSync(configPath, "{}\n", { mode: 0o600 });
    writeLivePublicationOwner(home);
    const contention = new PrivateMutationLockContentionError("publication lock is busy");
    vi.mocked(ensureDaemon).mockRejectedValue(contention);
    let now = 0;
    const sleeps: number[] = [];
    const deps = minimalDeps({
      homedir: home,
      _assertBackendPublication: undefined,
      _publicationConvergenceNow: () => now,
      _publicationConvergenceSleep: async (delayMs) => { sleeps.push(delayMs); now += delayMs; },
      fetch: vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ status: "ok", version: "0.5.0", storageBackend: "sqlite", pid: process.pid, entrypoint: TEST_RUNTIME_ENTRYPOINT }),
      }),
    });
    const results = await runDoctor(deps);
    expect(vi.mocked(ensureDaemon).mock.calls.length).toBeGreaterThan(1);
    expect(sleeps.every(delay => delay <= 50)).toBe(true);
    expect(results.find((result) => result.name === "daemon")).toBeDefined();
    rmSync(home, { recursive: true, force: true });
  });

  it("reports blocked publication admission without attempting repair", async () => {
    const home = mkdtempSync(join(tmpdir(), "lcm-doctor-publication-blocked-"));
    try {
      const publicationDir = join(home, ".lcm", "backend-publication");
      mkdirSync(publicationDir, { recursive: true, mode: 0o700 });
      writeFileSync(join(publicationDir, "journal.json"), "{", { mode: 0o600 });
      const results = await runDoctor(minimalDeps({
        homedir: home,
        _assertBackendPublication: undefined,
      }));

      expect(results.find((result) => result.name === "backend-publication")).toMatchObject({
        status: "fail",
        message: expect.stringContaining("Backend publication admission is blocked"),
      });
      expect(results.find((result) => result.name === "version")?.status).toBe("pass");
      expect(results.find((result) => result.name === "project-map")?.status).toBe("skip");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("blocks repair when an absent config fails a completed byte witness", async () => {
    const home = mkdtempSync(join(tmpdir(), "lcm-doctor-missing-config-witness-"));
    const validateProjectMap = vi.spyOn(projectMapModule, "validateProjectMap");
    writeCompletedPublicationJournal(home, "{}");
    try {
      const results = await runDoctor(minimalDeps({
        homedir: home,
        existsSync: (path: string) => !path.endsWith("config.json"),
        _assertBackendPublication: undefined,
      }));
      expect(results.find((result) => result.name === "backend-publication")).toMatchObject({
        status: "fail",
        message: expect.stringContaining("Backend publication admission is blocked"),
      });
      expect(results.find((result) => result.name === "project-map")).toMatchObject({ status: "skip" });
      expect(results.find((result) => result.name === "events-capture")).toMatchObject({ status: "skip" });
      expect(validateProjectMap).not.toHaveBeenCalled();
    } finally {
      validateProjectMap.mockRestore();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("admits an absent config when the terminal publication witness is absent", async () => {
    const home = mkdtempSync(join(tmpdir(), "lcm-doctor-missing-config-absent-"));
    try {
      const results = await runDoctor(minimalDeps({
        homedir: home,
        existsSync: (path: string) => !path.endsWith("config.json"),
        _assertBackendPublication: undefined,
      }));
      expect(results.find((result) => result.name === "backend-publication")).toBeUndefined();
      expect(results.find((result) => result.name === "config")).toMatchObject({ status: "fail" });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it.each(["oversized", "unreadable"] as const)("blocks repair with an explicit admission result for %s config", async (_label) => {
    const home = mkdtempSync(join(tmpdir(), "lcm-doctor-untrusted-config-"));
    const validateProjectMap = vi.spyOn(projectMapModule, "validateProjectMap");
    writeCompletedPublicationJournal(home, null);
    try {
      const boundedRead: (path: string, maxBytes: number) => string = _label === "oversized"
        ? () => { throw new Error("file exceeds the configured size limit"); }
        : () => { throw new Error("config read refused"); };
      const results = await runDoctor(minimalDeps({
        homedir: home,
        _assertBackendPublication: undefined,
        _readBoundedConfig: boundedRead,
      }));
      expect(results.find((result) => result.name === "backend-publication")).toMatchObject({
        status: "fail",
        message: expect.stringContaining("Backend publication admission is blocked"),
      });
      expect(results.find((result) => result.name === "project-map")).toMatchObject({ status: "skip" });
      expect(results.find((result) => result.name === "events-capture")).toMatchObject({ status: "skip" });
      expect(validateProjectMap).not.toHaveBeenCalled();
    } finally {
      validateProjectMap.mockRestore();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it.each([
    ["malformed config", "{"],
    ["oversized config", "x".repeat(4 * 1024 * 1024 + 1)],
  ] as const)("authenticates publication and blocks repair for %s", async (_label, content) => {
    const validateProjectMap = vi.spyOn(projectMapModule, "validateProjectMap");
    const assertPublication = vi.fn(() => {
      throw new BackendPublicationJournalError("unresolved-publication", "publication remains unresolved");
    });
    const base = minimalDeps();
    try {
      const results = await runDoctor({
        ...base,
        readFileSync: (path: string) => path.endsWith("config.json") ? content : base.readFileSync(path),
        _assertBackendPublication: assertPublication,
      });
      if (_label === "malformed config") expect(assertPublication).toHaveBeenCalledOnce();
      else expect(assertPublication).not.toHaveBeenCalled();
      expect(validateProjectMap).not.toHaveBeenCalled();
      expect(results.find((result) => result.name === "backend-publication")).toMatchObject({ status: "fail" });
      expect(results.find((result) => result.name === "project-map")).toMatchObject({ status: "skip" });
      expect(results.find((result) => result.name === "daemon")).toMatchObject({ status: "skip" });
      expect(base.writeFileSync).not.toHaveBeenCalled();
      expect(base.mkdirSync).not.toHaveBeenCalled();
      expect(ensureDaemon).not.toHaveBeenCalled();
    } finally {
      validateProjectMap.mockRestore();
    }
  });

  it("blocks passive-learning collection and pruning on terminal publication witness mismatch", async () => {
    const validateProjectMap = vi.spyOn(projectMapModule, "validateProjectMap");
    const assertPublication = vi.fn(() => {
      throw new BackendPublicationJournalError("unexpected-state", "terminal publication witness mismatch");
    });
    try {
      const results = await runDoctor(minimalDeps({ _assertBackendPublication: assertPublication }));
      expect(validateProjectMap).not.toHaveBeenCalled();
      expect(mockCollectEventStats).not.toHaveBeenCalled();
      expect(mockCollectDetailedEventStats).not.toHaveBeenCalled();
      expect(results.find((result) => result.name === "events-capture")).toMatchObject({
        status: "skip",
        message: expect.stringContaining("publication admission"),
      });
    } finally {
      validateProjectMap.mockRestore();
    }
  });

  it.each([
    ["publication-evidence-missing", "completed publication evidence is missing"],
    ["unresolved-publication", "a backend publication is unresolved"],
    ["unsafe-storage", "authenticated publication state is invalid or unsafe"],
    ["malformed-journal", "authenticated publication state is invalid or unsafe"],
    ["checksum-mismatch", "authenticated publication state is invalid or unsafe"],
    ["unexpected-state", "authenticated publication state is invalid or unsafe"],
    ["permit-mismatch", "authenticated publication state is invalid or unsafe"],
    ["backend-mismatch", "authenticated publication state is invalid or unsafe"],
    ["invalid-input", "authenticated publication state is invalid or unsafe"],
  ] as const)("renders the %s publication admission message", async (reason, message) => {
    const results = await runDoctor(minimalDeps({
      _assertBackendPublication: () => {
        throw new BackendPublicationJournalError(reason, "test publication refusal");
      },
    }));
    expect(results.find((result) => result.name === "backend-publication")).toMatchObject({
      status: "fail",
      message: expect.stringContaining(message),
    });
  });

  it("rethrows unexpected publication admission failures", async () => {
    await expect(runDoctor(minimalDeps({
      _assertBackendPublication: () => {
        throw new Error("unexpected publication failure");
      },
    }))).rejects.toThrow("unexpected publication failure");
  });

  it("renders blocked reconciliation guidance without retrying through project patterns", async () => {
    const home = mkdtempSync(join(tmpdir(), "lcm-doctor-blocked-reconciliation-"));
    try {
      const main = join(home, "main");
      const linked = join(home, "linked");
      const commonDir = join(main, ".git");
      const linkedGitDir = join(commonDir, "worktrees", "linked");
      mkdirSync(join(commonDir, "objects"), { recursive: true });
      mkdirSync(linkedGitDir, { recursive: true });
      mkdirSync(linked);
      writeFileSync(join(commonDir, "HEAD"), "ref: refs/heads/main\n");
      writeFileSync(join(commonDir, "config"), "[core]\nrepositoryformatversion = 0\n");
      writeFileSync(join(linkedGitDir, "HEAD"), "ref: refs/heads/linked\n");
      writeFileSync(join(linkedGitDir, "commondir"), "../..\n");
      writeFileSync(join(linked, ".git"), `gitdir: ${linkedGitDir}\n`);
      writeFileSync(join(linkedGitDir, "gitdir"), `${join(linked, ".git")}\n`);
      const targetHash = hashProjectPath(main);
      const sourceHash = hashProjectPath(linked);
      mkdirSync(join(home, ".lcm", "reconciliations"), { recursive: true });
      writeFileSync(join(home, ".lcm", "map.json"), JSON.stringify({
        [targetHash]: {
          canonical: main,
          aliases: [],
          remoteProjectId: "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9020",
        },
        [sourceHash]: {
          canonical: linked,
          aliases: [],
          remoteProjectId: "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9021",
        },
      }));
      writeFileSync(
        join(home, ".lcm", "reconciliations", `${targetHash}.json`),
        JSON.stringify({
          version: 1,
          targetHash,
          canonical: main,
          sourceHashes: [],
          pendingSourceHashes: [],
          aliases: [main],
          createdAt: "2026-07-25T00:00:00.000Z",
          updatedAt: "2026-07-25T00:00:00.000Z",
          phase: "blocked",
          blockedFrom: "planned",
          reason: "conflicting PostgreSQL project bindings",
          backupPaths: [],
        }),
      );
      clearProjectMapCache();

      const results = await runDoctor(minimalDeps({
        homedir: home,
        cwd: main,
      }));

      expect(results.find((result) => result.name === "worktree-reconciliation"))
        .toMatchObject({
          status: "fail",
          message: expect.stringContaining("reconcile-worktrees"),
        });
      expect(results.find((result) => result.name === "user-patterns"))
        .toBeDefined();
    } finally {
      clearProjectMapCache();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it.each([
    ["blocked", "fail"],
    ["merged", "warn"],
    ["completed", "pass"],
  ] as const)("reports %s worktree reconciliation journals", async (phase, status) => {
    const home = mkdtempSync(join(tmpdir(), "lcm-doctor-reconciliation-"));
    try {
      const targetHash = "a".repeat(64);
      const root = join(home, ".lcm", "reconciliations");
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, `${targetHash}.json`), JSON.stringify({
        version: 1,
        targetHash,
        canonical: "/project",
        sourceHashes: ["b".repeat(64)],
        aliases: ["/project"],
        createdAt: "2026-07-25T00:00:00.000Z",
        updatedAt: "2026-07-25T00:00:00.000Z",
        phase,
        backupPaths: [],
      }));

      const results = await runDoctor(minimalDeps({
        homedir: home,
        cwd: "/tmp/nonexistent-project-xyz",
      }));
      expect(results.find((result) => result.name === "worktree-reconciliation"))
        .toMatchObject({ status });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("reports malformed reconciliation journals and plural completed counts", async () => {
    const home = mkdtempSync(join(tmpdir(), "lcm-doctor-reconciliation-malformed-"));
    try {
      const root = join(home, ".lcm", "reconciliations");
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, `${"a".repeat(64)}.json`), "{}");
      let results = await runDoctor(minimalDeps({
        homedir: home,
        cwd: "/tmp/nonexistent-project-xyz",
      }));
      expect(results.find((result) => result.name === "worktree-reconciliation"))
        .toMatchObject({ status: "fail", message: expect.stringContaining("malformed") });

      for (const hash of ["a".repeat(64), "b".repeat(64)]) {
        writeFileSync(join(root, `${hash}.json`), JSON.stringify({
          version: 1,
          targetHash: hash,
          canonical: "/project",
          sourceHashes: [],
          aliases: ["/project"],
          createdAt: "2026-07-25T00:00:00.000Z",
          updatedAt: "2026-07-25T00:00:00.000Z",
          phase: "completed",
          backupPaths: [],
        }));
      }
      results = await runDoctor(minimalDeps({
        homedir: home,
        cwd: "/tmp/nonexistent-project-xyz",
      }));
      expect(results.find((result) => result.name === "worktree-reconciliation"))
        .toMatchObject({ status: "pass", message: "2 completed reconciliations" });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

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
      writeFileSync(mapPath, JSON.stringify({ [hash]: { canonical, aliases: [] } }), { mode: 0o600 });

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

  it("uses the sole matching project-map entry for pattern diagnostics", async () => {
    const home = mkdtempSync(join(tmpdir(), "lcm-doctor-map-patterns-"));
    try {
      const cwd = join(home, "project");
      const hash = hashProjectPath(normalizeProjectPath(cwd));
      const projectDir = join(home, ".lcm", "projects", hash);
      mkdirSync(cwd, { recursive: true });
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(join(home, ".lcm", "map.json"), JSON.stringify({
        [hash]: { canonical: cwd, aliases: [] },
      }), { mode: 0o600 });
      writeFileSync(join(projectDir, "sensitive-patterns.txt"), "DOCTOR_PROJECT_PATTERN\n", { mode: 0o600 });
      clearProjectMapCache();

      const results = await runDoctor(minimalDeps({ homedir: home, cwd }));

      expect(results.find((result) => result.name === "user-patterns")).toMatchObject({
        status: "pass",
        message: expect.stringContaining("1 project"),
      });
    } finally {
      clearProjectMapCache();
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
      }, null, 2) + "\n", { mode: 0o600 });

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
  it("uses a lexical remediation scope when the state root is absent", async () => {
    const home = mkdtempSync(join(tmpdir(), "lcm-doctor-remediation-"));
    try {
      const results = await runDoctor(minimalDeps({
        homedir: home,
        cwd: "/tmp/nonexistent-project-xyz",
      }));
      expect(results.find((result) => result.name === "daemon")?.message).toContain(
        "lcm daemon unavailable (not-running)",
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("uses a lexical remediation scope when the home directory is not created", async () => {
    const home = mkdtempSync(join(tmpdir(), "lcm-doctor-missing-home-"));
    const uncreatedHome = home;
    symlinkSync(join(home, "missing-lcm"), join(home, ".lcm"));
    try {
      const results = await runDoctor(minimalDeps({
        homedir: uncreatedHome,
        cwd: "/tmp/nonexistent-project-xyz",
      }));

      expect(results.find((result) => result.name === "daemon")?.message).toContain(
        "backend publication admission is blocked",
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("uses an authoritative refusal reason for live daemon evidence", async () => {
    vi.mocked(ensureDaemon).mockResolvedValueOnce({
      connected: false,
      port: 3737,
      spawned: false,
      refusalReason: "live-no-response",
    } as never);
    const results = await runDoctor(minimalDeps({
      cwd: "/tmp/nonexistent-project-xyz",
      fetch: vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ status: "ok", version: "0.5.0" }),
      }),
    }));
    expect(results.find((result) => result.name === "daemon")?.message).toContain(
      "lcm daemon unavailable (live-no-response)",
    );
  });

  it.each(["fetch", "json"] as const)(
    "bounds the complete daemon health %s phase to two seconds",
    async (phase) => {
      vi.useFakeTimers();
      let signal: AbortSignal | undefined;
      const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        signal = init?.signal ?? undefined;
        if (phase === "fetch") {
          return await new Promise<Response>(() => undefined);
        }
        return {
          ok: true,
          status: 200,
          json: async () => await new Promise(() => undefined),
        } as Response;
      });

      const pending = runDoctor(minimalDeps({
        cwd: "/tmp/nonexistent-project-xyz",
        fetch: fetch as typeof globalThis.fetch,
      }));
      await vi.advanceTimersByTimeAsync(1999);
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const results = await pending;

      expect(signal?.aborted).toBe(true);
      expect(results.find((result) => result.name === "daemon")).toMatchObject({
        status: "fail",
      });
    },
  );

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

    // restartDaemon returns connected on the authenticated migration attempt
    vi.mocked(restartDaemon).mockResolvedValueOnce({ connected: true, port: 7865, spawned: true, restarted: true });

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

    expect(vi.mocked(restartDaemon)).toHaveBeenCalledWith(
      expect.objectContaining({ expectedVersion: pkgVersion, expectedStorageBackend: "sqlite" }),
    );
    expect(vi.mocked(ensureDaemon)).not.toHaveBeenCalled();
    expect(daemonResult?.fixApplied).toBe(true);
    expect(daemonResult?.message).toContain("restarted");
    expect(daemonResult?.message).toContain(daemonVersion);
    expect(daemonResult?.message).toContain(pkgVersion);
  });

  it("keeps matching-version health on ensureDaemon and never calls restartDaemon", async (): Promise<void> => {
    vi.mocked(ensureDaemon).mockResolvedValueOnce({ connected: true, port: 7865, spawned: false });
    const deps = minimalDeps({
      cwd: "/tmp/nonexistent-project-xyz",
      fetch: vi.fn()
        .mockResolvedValueOnce({ ok: true, json: async () => ({ status: "ok", version: "0.5.0" }) })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ status: "ok", version: "0.5.0" }) }),
    });

    const results = await runDoctor(deps);
    expect(vi.mocked(ensureDaemon)).toHaveBeenCalledOnce();
    expect(vi.mocked(restartDaemon)).not.toHaveBeenCalled();
    expect(results.find((result) => result.name === "daemon")).toMatchObject({ status: "pass" });
  });

  it.each([
    undefined,
    "managed restart warning",
  ] as const)("repairs matching-version stale configuration with an identical restart request (%s)", async (warning): Promise<void> => {
    vi.mocked(ensureDaemon).mockResolvedValueOnce({
      connected: false,
      port: 3737,
      spawned: false,
      refusalReason: "stale-config",
    });
    vi.mocked(restartDaemon).mockResolvedValueOnce({
      connected: true,
      port: 3737,
      spawned: true,
      restarted: true,
      ...(warning === undefined ? {} : { warning }),
    });
    const fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: "ok", version: "0.5.0" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: "ok", version: "0.5.0" }) });

    const results = await runDoctor(minimalDeps({
      cwd: "/tmp/nonexistent-project-xyz",
      fetch,
    }));
    const daemonResult = results.find((result) => result.name === "daemon");
    const ensureOptions = vi.mocked(ensureDaemon).mock.calls[0]?.[0];

    expect(ensureOptions).toBeDefined();
    expect(vi.mocked(restartDaemon)).toHaveBeenCalledOnce();
    expect(vi.mocked(restartDaemon)).toHaveBeenCalledWith(ensureOptions);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(daemonResult).toMatchObject({ status: "warn", fixApplied: true });
    expect(daemonResult?.message).toContain("stale configuration repaired");
    expect(daemonResult?.message).toContain("daemon restarted");
    if (warning === undefined) expect(daemonResult?.message).not.toContain("Warning:");
    else expect(daemonResult?.message).toContain(warning);
  });

  it.each(["null", "reject"] as const)(
    "does not report stale configuration repair as healthy when authenticated follow-up health %s",
    async (followUpOutcome): Promise<void> => {
      vi.mocked(ensureDaemon).mockResolvedValueOnce({
        connected: false,
        port: 3737,
        spawned: false,
        refusalReason: "stale-config",
      });
      vi.mocked(restartDaemon).mockResolvedValueOnce({
        connected: true,
        port: 3737,
        spawned: true,
        restarted: true,
      });

      const stateRoot = join(defaultDoctorHome, ".lcm");
      const markerPath = daemonRemediationMarkerPath(stateRoot);
      emitDaemonNotice({
        scope: stateRoot,
        stateRoot,
        reason: "stale-config",
        write: () => undefined,
      });
      expect(existsSync(markerPath)).toBe(true);

      const fetch = vi.fn()
        .mockResolvedValueOnce({ ok: true, json: async () => ({ status: "ok", version: "0.5.0" }) });
      if (followUpOutcome === "null") {
        fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ status: "degraded", version: "0.5.0" }) });
      } else {
        fetch.mockRejectedValueOnce(new Error("authenticated health unavailable"));
      }

      const results = await runDoctor(minimalDeps({
        cwd: "/tmp/nonexistent-project-xyz",
        fetch,
      }));
      const daemonResult = results.find((result) => result.name === "daemon");

      expect(vi.mocked(ensureDaemon)).toHaveBeenCalledOnce();
      expect(vi.mocked(restartDaemon)).toHaveBeenCalledOnce();
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(fetch.mock.calls[0]?.[1]).not.toMatchObject({ headers: expect.anything() });
      expect(fetch.mock.calls[1]?.[1]).toMatchObject({ headers: { Authorization: "Bearer {}" } });
      expect(daemonResult).toMatchObject({ status: "fail", fixApplied: false });
      expect(daemonResult?.message).toContain("authenticated health could not be verified after restart");
      expect(daemonResult?.message).toContain(
        "lcm daemon unavailable (stale-config); run 'lcm daemon restart'.",
      );
      expect(results.find((result) => result.name === "mcp-handshake-lcm")).toBeUndefined();
      expect(existsSync(markerPath)).toBe(true);
    },
  );

  it("does not restart a matching-version daemon for a non-stale ensure refusal", async (): Promise<void> => {
    vi.mocked(ensureDaemon).mockResolvedValueOnce({
      connected: false,
      port: 3737,
      spawned: false,
      refusalReason: "invalid-collision",
    });

    const results = await runDoctor(minimalDeps({
      cwd: "/tmp/nonexistent-project-xyz",
      fetch: vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: "ok", version: "0.5.0" }),
      }),
    }));
    const daemonResult = results.find((result) => result.name === "daemon");

    expect(vi.mocked(restartDaemon)).not.toHaveBeenCalled();
    expect(daemonResult).toMatchObject({ status: "fail", fixApplied: false });
    expect(daemonResult?.message).toContain(
      "lcm daemon unavailable (invalid-collision); run 'lcm daemon restart' or 'lcm doctor'.",
    );
  });

  it("keeps a stale-config restart refusal failed with its exact remediation", async (): Promise<void> => {
    vi.mocked(ensureDaemon).mockResolvedValueOnce({
      connected: false,
      port: 3737,
      spawned: false,
      refusalReason: "stale-config",
    });
    vi.mocked(restartDaemon).mockResolvedValueOnce({
      connected: false,
      port: 3737,
      spawned: false,
      restarted: false,
      refusalReason: "stale-config",
    });

    const results = await runDoctor(minimalDeps({
      cwd: "/tmp/nonexistent-project-xyz",
      fetch: vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: "ok", version: "0.5.0" }),
      }),
    }));
    const daemonResult = results.find((result) => result.name === "daemon");

    expect(vi.mocked(restartDaemon)).toHaveBeenCalledOnce();
    expect(daemonResult).toMatchObject({ status: "fail", fixApplied: false });
    expect(daemonResult?.message).toContain(
      "lcm daemon unavailable (stale-config); run 'lcm daemon restart'.",
    );
  });

  it("reports warn with fixApplied:false when restart does not fix version mismatch", async (): Promise<void> => {
    const pkgVersion = "0.6.0";
    const daemonVersion = "0.5.0";

    vi.mocked(restartDaemon).mockResolvedValueOnce({ connected: true, port: 7865, spawned: true, restarted: true });

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

    vi.mocked(restartDaemon).mockResolvedValueOnce({ connected: true, port: 7865, spawned: true, restarted: true });

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
    vi.mocked(restartDaemon).mockRejectedValueOnce(new Error("restart failed"));
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

  it("authenticates healthy storage after auto-start before promising queue drain", async () => {
    vi.mocked(ensureDaemon).mockResolvedValueOnce({
      connected: true,
      port: 3737,
      spawned: true,
      pid: 4242,
      startMethod: "systemd-user",
    });
    mockCollectEventStats.mockReturnValue({
      captured: 100,
      unprocessed: 5,
      errors: 0,
      lastCapture: "2026-03-26 10:00:00",
    });
    const fetch = vi.fn()
      .mockRejectedValueOnce(new Error("daemon offline"))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          status: "ok",
          version: "0.5.0",
          storageBackend: "sqlite",
          uptime: 1,
          pid: 4242,
        }),
      });

    const results = await runDoctor(minimalDeps({
      cwd: "/tmp/nonexistent-project-xyz",
      fetch,
      readFileSync: (path: string) => path.endsWith("daemon.token")
        ? "doctor-token"
        : minimalDeps().readFileSync(path),
    }));

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "http://127.0.0.1:3737/health",
      {
        headers: { Authorization: "Bearer doctor-token" },
        signal: expect.any(AbortSignal),
      },
    );
    expect(results.find((result) => result.name === "daemon")).toMatchObject({
      status: "warn",
      fixApplied: true,
      message: expect.stringContaining("started"),
    });
    expect(results.find((result) => result.name === "events-capture")).toMatchObject({
      status: "pass",
      message: expect.stringContaining("queued for automatic daemon processing"),
    });
  });

  it("reports authenticated staged storage after PostgreSQL auto-start", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lcm-doctor-postgres-autostart-"));
    const caFile = join(dir, "ca.pem");
    writeFileSync(caFile, "test-ca");
    const previousUrl = process.env.LCM_POSTGRES_URL;
    const previousCaFile = process.env.LCM_POSTGRES_CA_FILE;
    const previousMigrationRole = process.env.LCM_POSTGRES_MIGRATION_ROLE;
    process.env.LCM_POSTGRES_URL = "postgresql://user:password@db.example/lcm";
    process.env.LCM_POSTGRES_CA_FILE = caFile;
    process.env.LCM_POSTGRES_MIGRATION_ROLE = "lcm_test_migrator";
    const stagedHealth = {
      status: "unavailable",
      version: "0.5.0",
      storageBackend: "postgresql",
      uptime: 1,
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
    const fetch = vi.fn()
      .mockRejectedValueOnce(new Error("daemon offline"))
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        json: async () => stagedHealth,
      });
    vi.mocked(ensureDaemon).mockResolvedValueOnce({
      connected: true,
      port: 3737,
      spawned: true,
      pid: 4242,
      startMethod: "systemd-user",
    });
    mockCollectEventStats.mockReturnValue({
      captured: 100,
      unprocessed: 5,
      errors: 0,
      lastCapture: "2026-03-26 10:00:00",
    });
    try {
      const results = await runDoctor(minimalDeps({
        cwd: "/tmp/nonexistent-project-xyz",
        fetch,
        readFileSync: (path: string) => {
          if (path.endsWith("config.json")) {
            return JSON.stringify({ storage: { backend: "postgresql" } });
          }
          if (path.endsWith("daemon.token")) return "doctor-token";
          return minimalDeps().readFileSync(path);
        },
      }));

      expect(fetch).toHaveBeenCalledTimes(2);
      expect(fetch).toHaveBeenNthCalledWith(
        2,
        "http://127.0.0.1:3737/health",
        {
          headers: { Authorization: "Bearer doctor-token" },
          signal: expect.any(AbortSignal),
        },
      );
      expect(results.find((result) => result.name === "events-capture")).toMatchObject({
        status: "warn",
        message: expect.stringContaining("storage is unavailable"),
      });
      expect(results.find((result) => result.name === "events-capture")?.message)
        .not.toContain("could not be authenticated");
    } finally {
      if (previousUrl === undefined) delete process.env.LCM_POSTGRES_URL;
      else process.env.LCM_POSTGRES_URL = previousUrl;
      if (previousCaFile === undefined) delete process.env.LCM_POSTGRES_CA_FILE;
      else process.env.LCM_POSTGRES_CA_FILE = previousCaFile;
      if (previousMigrationRole === undefined) delete process.env.LCM_POSTGRES_MIGRATION_ROLE;
      else process.env.LCM_POSTGRES_MIGRATION_ROLE = previousMigrationRole;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps auto-started storage unverified when the daemon token is unreadable", async () => {
    vi.mocked(ensureDaemon).mockResolvedValueOnce({
      connected: true,
      port: 3737,
      spawned: true,
      pid: 4242,
      startMethod: "systemd-user",
    });
    mockCollectEventStats.mockReturnValue({
      captured: 100,
      unprocessed: 5,
      errors: 0,
      lastCapture: "2026-03-26 10:00:00",
    });
    const fetch = vi.fn().mockRejectedValueOnce(new Error("daemon offline"));

    const results = await runDoctor(minimalDeps({
      cwd: "/tmp/nonexistent-project-xyz",
      fetch,
      readFileSync: (path: string) => {
        if (path.endsWith("daemon.token")) throw new Error("permission denied");
        return minimalDeps().readFileSync(path);
      },
    }));

    expect(fetch).toHaveBeenCalledOnce();
    expect(results.find((result) => result.name === "daemon")).toMatchObject({
      status: "warn",
      fixApplied: true,
      message: expect.stringContaining("started"),
    });
    expect(results.find((result) => result.name === "events-capture")).toMatchObject({
      status: "warn",
      message: expect.stringContaining("storage readiness could not be authenticated"),
    });
    expect(results.find((result) => result.name === "events-capture")?.message)
      .toContain("restore access to the daemon token and authenticated diagnostics");
  });

  it("does not recognize unavailable non-staged health before or after auto-start", async () => {
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
      readFileSync: (path: string) => path.endsWith("daemon.token")
        ? "doctor-token"
        : minimalDeps().readFileSync(path),
    }));

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "http://127.0.0.1:3737/health",
      {
        headers: { Authorization: "Bearer doctor-token" },
        signal: expect.any(AbortSignal),
      },
    );
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
        if (cmd === "/bin/sh" && args[1]?.includes("command -v claude")) {
          return { status: 0, stdout: "/usr/bin/claude", stderr: "" };
        }
        if (cmd === "/bin/sh" && args[1]?.includes("command -v codex")) {
          return { status: 0, stdout: "/usr/bin/codex", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      }),
      fetch: vi.fn().mockResolvedValue({ ok: false }),
      homedir: defaultDoctorHome,
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
        platform: "win32",
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
      const credentialPath = join(credentialsDir, "ANTHROPIC_API_KEY");
      writeFileSync(credentialPath, "sk-doctor-credential\n", { mode: 0o400 });
      chmodSync(credentialsDir, 0o500);
      expect(statSync(credentialsDir).mode & 0o7777).toBe(0o500);
      expect(statSync(credentialPath).mode & 0o7777).toBe(0o400);
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
      chmodSync(credentialsDir, 0o700);
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
    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:4545/health",
      { signal: expect.any(AbortSignal) },
    );
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
    const previousMigrationRole = process.env.LCM_POSTGRES_MIGRATION_ROLE;
    process.env.LCM_POSTGRES_URL = "postgresql://user:password@db.example/lcm";
    process.env.LCM_POSTGRES_CA_FILE = caFile;
    process.env.LCM_POSTGRES_MIGRATION_ROLE = "lcm_test_migrator";
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
      if (previousMigrationRole === undefined) delete process.env.LCM_POSTGRES_MIGRATION_ROLE;
      else process.env.LCM_POSTGRES_MIGRATION_ROLE = previousMigrationRole;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses authenticated staged PostgreSQL health for an already-running daemon", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lcm-doctor-postgres-staged-"));
    const caFile = join(dir, "ca.pem");
    writeFileSync(caFile, "test-ca");
    const previousUrl = process.env.LCM_POSTGRES_URL;
    const previousCaFile = process.env.LCM_POSTGRES_CA_FILE;
    const previousMigrationRole = process.env.LCM_POSTGRES_MIGRATION_ROLE;
    process.env.LCM_POSTGRES_URL = "postgresql://user:password@db.example/lcm";
    process.env.LCM_POSTGRES_CA_FILE = caFile;
    process.env.LCM_POSTGRES_MIGRATION_ROLE = "lcm_test_migrator";
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
    const fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          status: "ok",
          version: "0.5.0",
          storageBackend: "postgresql",
          uptime: 10,
          pid: 4242,
        }),
      })
      .mockResolvedValueOnce({
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
    mockCollectEventStats.mockReturnValue({
      captured: 100,
      unprocessed: 5,
      errors: 0,
      lastCapture: "2026-03-26 10:00:00",
    });
    try {
      const results = await runDoctor(minimalDeps({
        fetch,
        readFileSync: (path: string) => {
          if (path.endsWith("config.json")) {
            return JSON.stringify({ storage: { backend: "postgresql" } });
          }
          if (path.endsWith("daemon.token")) return "doctor-token";
          return minimalDeps().readFileSync(path);
        },
      }));

      expect(ensureDaemon).toHaveBeenCalledWith(expect.objectContaining({
        expectedStorageBackend: "postgresql",
        expectedVersion: "0.5.0",
      }));
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(fetch).toHaveBeenNthCalledWith(
        1,
        "http://127.0.0.1:3737/health",
        { signal: expect.any(AbortSignal) },
      );
      expect(fetch).toHaveBeenNthCalledWith(
        2,
        "http://127.0.0.1:3737/health",
        {
          headers: { Authorization: "Bearer doctor-token" },
          signal: expect.any(AbortSignal),
        },
      );
      expect(results.find((result) => result.name === "daemon")).toMatchObject({
        status: "pass",
        message: "localhost:3737 (up)",
      });
      expect(results.find((result) => result.name === "daemon")?.fixApplied)
        .not.toBe(true);
      expect(results.find((result) => result.name === "events-capture")).toMatchObject({
        status: "warn",
        message: expect.stringContaining("queue cannot drain until storage is healthy"),
      });
      expect(results.find((result) => result.name === "events-capture")?.message)
        .not.toContain("queued for automatic daemon processing");
    } finally {
      if (previousUrl === undefined) delete process.env.LCM_POSTGRES_URL;
      else process.env.LCM_POSTGRES_URL = previousUrl;
      if (previousCaFile === undefined) delete process.env.LCM_POSTGRES_CA_FILE;
      else process.env.LCM_POSTGRES_CA_FILE = previousCaFile;
      if (previousMigrationRole === undefined) delete process.env.LCM_POSTGRES_MIGRATION_ROLE;
      else process.env.LCM_POSTGRES_MIGRATION_ROLE = previousMigrationRole;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not send an authenticated health request when the daemon token is unreadable", async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        status: "ok",
        version: "0.5.0",
        storageBackend: "sqlite",
        uptime: 10,
        pid: 4242,
      }),
    });
    vi.mocked(ensureDaemon).mockResolvedValueOnce({
      connected: true,
      port: 3737,
      spawned: false,
      pid: 4242,
      startMethod: "existing",
    });
    mockCollectEventStats.mockReturnValue({
      captured: 100,
      unprocessed: 5,
      errors: 0,
      lastCapture: "2026-03-26 10:00:00",
    });

    const results = await runDoctor(minimalDeps({
      fetch,
      readFileSync: (path: string) => {
        if (path.endsWith("daemon.token")) throw new Error("permission denied");
        return minimalDeps().readFileSync(path);
      },
    }));

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:3737/health",
      { signal: expect.any(AbortSignal) },
    );
    expect(results.find((result) => result.name === "daemon")).toMatchObject({
      status: "pass",
      message: "localhost:3737 (up)",
    });
    expect(results.find((result) => result.name === "events-capture")).toMatchObject({
      status: "warn",
      message: expect.stringContaining("storage readiness could not be authenticated"),
    });
    expect(results.find((result) => result.name === "events-capture")?.message)
      .toContain("restore access to the daemon token and authenticated diagnostics");
    expect(results.find((result) => result.name === "events-capture")?.message)
      .not.toContain("storage is unavailable");
    expect(results.find((result) => result.name === "events-capture")?.message)
      .not.toContain("queued for automatic daemon processing");
  });

  it("does not send an authenticated health request when the daemon token is empty", async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        status: "ok",
        version: "0.5.0",
        storageBackend: "sqlite",
        uptime: 10,
        pid: 4242,
      }),
    });
    vi.mocked(ensureDaemon).mockResolvedValueOnce({
      connected: true,
      port: 3737,
      spawned: false,
      pid: 4242,
      startMethod: "existing",
    });
    mockCollectEventStats.mockReturnValue({
      captured: 100,
      unprocessed: 5,
      errors: 0,
      lastCapture: "2026-03-26 10:00:00",
    });

    const results = await runDoctor(minimalDeps({
      fetch,
      readFileSync: (path: string) => {
        if (path.endsWith("daemon.token")) return " \n";
        return minimalDeps().readFileSync(path);
      },
    }));

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:3737/health",
      { signal: expect.any(AbortSignal) },
    );
    expect(results.find((result) => result.name === "events-capture")).toMatchObject({
      status: "warn",
      message: expect.stringContaining("storage readiness could not be authenticated"),
    });
    expect(results.find((result) => result.name === "events-capture")?.message)
      .toContain("restore access to the daemon token and authenticated diagnostics");
    expect(results.find((result) => result.name === "events-capture")?.message)
      .not.toContain("storage is unavailable");
    expect(results.find((result) => result.name === "events-capture")?.message)
      .not.toContain("queued for automatic daemon processing");
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

      expect(fetch).toHaveBeenCalledWith(
        "http://127.0.0.1:3737/health",
        { signal: expect.any(AbortSignal) },
      );
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
    vi.mocked(ensureDaemon).mockResolvedValueOnce({
      connected: true,
      port: 3737,
      spawned: false,
      pid: 4242,
      startMethod: "existing",
    });
    mockCollectEventStats.mockReturnValue({ captured: 100, unprocessed: 5, errors: 0, lastCapture: "2026-03-26 10:00:00" });
    const results = await runDoctor(minimalDeps({
      cwd: "/tmp/test-proj",
      fetch: vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ status: "ok", version: "0.5.0", storageBackend: "sqlite", pid: 4242 }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ status: "ok", version: "0.5.0", storageBackend: "sqlite", pid: 4242 }),
        }),
      readFileSync: (path: string) => path.endsWith("daemon.token")
        ? "doctor-token"
        : minimalDeps().readFileSync(path),
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
      fetch: vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ status: "ok", version: "0.5.0", storageBackend: "sqlite", pid: 4242 }),
      }),
      readFileSync: (path: string) => path.endsWith("daemon.token")
        ? "doctor-token"
        : minimalDeps().readFileSync(path),
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
      fetch: vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ status: "ok", version: "0.5.0", storageBackend: "sqlite", pid: 4242 }),
      }),
      readFileSync: (path: string) => path.endsWith("daemon.token")
        ? "doctor-token"
        : minimalDeps().readFileSync(path),
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
