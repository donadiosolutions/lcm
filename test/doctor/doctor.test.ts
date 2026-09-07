import { afterEach, beforeEach, describe, expect, it, vi, type TestContext } from "vitest";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, lstatSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDoctor } from "../../src/doctor/doctor.js";
import type { DoctorDeps } from "../../src/doctor/types.js";
import { doctorConfigReadFailureSeams, doctorConfigSeams } from "./config-seams.js";
import { writeAbortedTerminalPublicationJournal } from "../fixtures/terminal-publication-journal.js";
import {
  PrivateMutationLockContentionError,
  processStartTime as observedProcessStartTime,
  readPrivateMutationLockOwner,
} from "../../src/private-mutation-lock.js";
import { renderGuidance } from "../../src/connectors/template-service.js";
import { mergeClaudeSettings, REQUIRED_HOOKS } from "../../installer/install.js";
import { legacyLcmMcpServerName } from "../../src/legacy-names.js";
import { LCM_MD_CONTENT } from "../../src/daemon/orientation.js";
import { ensureDaemon, restartDaemon } from "../../src/daemon/lifecycle.js";
import { emitDaemonNotice } from "../../src/hooks/daemon-notice.js";
import { daemonRemediationMarkerPath } from "../../src/daemon/remediation.js";
import { packageExecutable } from "../../src/runtime-root.js";
import { RUNTIME_DIGEST } from "../../src/daemon/version.js";
import {
  clearProjectMapCache,
  hashProjectPath,
  normalizeProjectPath,
} from "../../src/project-map.js";
import * as projectMapModule from "../../src/project-map.js";
import * as worktreeReconciliationModule from "../../src/worktree-reconciliation.js";
import {
  BackendPublicationJournalError,
  assertBackendPublicationConfigReadAccess,
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
const EXPECTED_RUNTIME_DIGEST = "a".repeat(64);

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

type DoctorOverrides = Partial<DoctorDeps> & {
  /** Legacy publication seam adapter kept for the remaining deterministic refusal tests. */
  _assertBackendPublication?: (homeDir: string, backend: "sqlite" | "postgresql") => void;
};

/**
 * Build doctor dependencies. Configuration bytes come from the injected
 * readFileSync/existsSync pair through the internal snapshot seam so the
 * single production admission path is exercised. Pass
 * `_readDaemonConfigRawSnapshot: undefined` explicitly to use the real
 * filesystem snapshot reader against `homedir`.
 */
function minimalDeps(overrides: DoctorOverrides = {}): DoctorDeps {
  const { _assertBackendPublication, ...rest } = overrides;
  const base = {
    collectBackendSnapshot: doctorConfigSeams("{}").collectBackendSnapshot,
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
    _expectedRuntimeDigestForTesting: EXPECTED_RUNTIME_DIGEST,
    platform: "darwin",
    ...rest,
  };
  if (Object.hasOwn(rest, "_readDaemonConfigRawSnapshot")) return base;
  const path = join(base.homedir, ".lcm", "config.json");
  const assertReadAccess: DoctorDeps["_assertPublicationReadAccess"] = _assertBackendPublication === undefined
    ? () => Object.freeze({ journalChecksumSha256: null })
    : (_configPath, backend) => {
      _assertBackendPublication(base.homedir, backend);
      return Object.freeze({ journalChecksumSha256: null });
    };
  if (!base.existsSync(path)) return { ...base, ...doctorConfigSeams(null, assertReadAccess) };
  let content: string;
  try {
    content = base.readFileSync(path, "utf-8");
  } catch (error) {
    return { ...base, ...doctorConfigReadFailureSeams(error) };
  }
  return { ...base, ...doctorConfigSeams(content, assertReadAccess) };
}

function writeLivePublicationOwner(home: string): void {
  const processStartTime = observedProcessStartTime(process.pid);
  if (processStartTime === null) throw new Error("current process birth time is unavailable");
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

function writeCompletedPublicationJournal(
  home: string,
  targetConfig: string | null,
  publicationId = "doctor-sentinel-test",
): void {
  const publicationDir = join(home, ".lcm", "backend-publication");
  mkdirSync(publicationDir, { recursive: true, mode: 0o700 });
  const sourceConfig = "{}";
  const absentProjectMap = publicationFileWitness(null);
  const payload = {
    version: 2,
    publicationId,
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

  it("recommends install when the canonical skill is missing", async () => {
    const written: Record<string, string> = {};
    const deps = minimalDeps({
      cwd: "/tmp/nonexistent-project-xyz",
      existsSync: (p: string) => !p.endsWith("lcm.md") && !p.endsWith("lcm-memory/SKILL.md"),
      writeFileSync: vi.fn((p: string, c: string) => { written[p] = c; }),
    });
    const results = await runDoctor(deps);
    const check = results.find((r) => r.name === "lcm-md");
    expect(check?.status).toBe("warn");
    expect(check).not.toHaveProperty("fixApplied");
    expect(written).toEqual({});
  });

  it("preserves a recognized legacy skill", async () => {
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
    expect(existsSync(legacySkillPath)).toBe(true);
  });
});

describe("runDoctor Claude integration ownership", () => {
  it("preserves legacy MCP entries when native hooks and runtime registration are current", async () => {
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

    expect(writes).not.toHaveBeenCalled();
    expect(results.find(r => r.name === "hooks")?.status).toBe("pass");
    expect(results.find(r => r.name === "mcp-lcm")?.status).toBe("pass");
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
        const results = await runDoctor(minimalDeps({ homedir: home, _readDaemonConfigRawSnapshot: undefined }));
        expect(results.find((result) => result.name === "config")).toMatchObject({ status: "pass" });
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("blocks admission when the LCM root cannot be inspected", async () => {
    const results = await runDoctor(minimalDeps({
      _lstatLcmRootForTesting: (() => { throw Object.assign(new Error("permission denied"), { code: "EACCES" }); }) as never,
    }));
    expect(results.find((result) => result.name === "backend-publication")).toMatchObject({
      status: "fail",
      message: expect.stringContaining("authenticated publication state is invalid or unsafe"),
    });
    expect(results.find((result) => result.name === "project-map")?.status).toBe("skip");
  });

  it("blocks admission when the LCM root is a symlink", async () => {
    const home = mkdtempSync(join(tmpdir(), "lcm-doctor-root-symlink-"));
    const realRoot = join(home, "real-lcm");
    mkdirSync(realRoot, { mode: 0o700 });
    symlinkSync(realRoot, join(home, ".lcm"));
    try {
      // No lstat seam: the production filesystem inspection is exercised.
      const results = await runDoctor(minimalDeps({ homedir: home, _readDaemonConfigRawSnapshot: undefined }));
      expect(results.find((result) => result.name === "backend-publication")).toMatchObject({
        status: "fail",
        message: expect.stringContaining("authenticated publication state is invalid or unsafe"),
      });
      expect(results.find((result) => result.name === "daemon")?.status).toBe("skip");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("blocks a symlink swap during the first publication admission", async () => {
    const home = mkdtempSync(join(tmpdir(), "lcm-doctor-root-first-admission-swap-"));
    const root = join(home, ".lcm");
    const retainedRoot = join(home, "retained-lcm");
    const configFile = join(root, "config.json");
    mkdirSync(root, { mode: 0o700 });
    writeFileSync(configFile, "{}\n", { mode: 0o600 });
    let admissions = 0;
    try {
      const results = await runDoctor(minimalDeps({
        homedir: home,
        _readDaemonConfigRawSnapshot: undefined,
        _assertPublicationReadAccess: (...args) => {
          admissions += 1;
          if (admissions === 1) {
            renameSync(root, retainedRoot);
            symlinkSync(retainedRoot, root);
          }
          return assertBackendPublicationConfigReadAccess(...args);
        },
      }));
      expect(admissions).toBe(1);
      expect(results.find((result) => result.name === "backend-publication")).toMatchObject({
        status: "fail",
        message: expect.stringContaining("authenticated publication state is invalid or unsafe"),
      });
      expect(results.find((result) => result.name === "daemon")?.status).toBe("skip");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("blocks an LCM root replacement on the invalid-config second snapshot path", async () => {
    const home = mkdtempSync(join(tmpdir(), "lcm-doctor-invalid-root-second-snapshot-swap-"));
    const root = join(home, ".lcm");
    const retainedRoot = join(home, "retained-lcm");
    const replacementRoot = join(home, "replacement-lcm");
    const configFile = join(root, "config.json");
    mkdirSync(root, { mode: 0o700 });
    mkdirSync(replacementRoot, { mode: 0o700 });
    writeFileSync(configFile, JSON.stringify({ storage: { backend: "invalid" } }), { mode: 0o600 });
    try {
      const results = await runDoctor(minimalDeps({
        homedir: home,
        _readDaemonConfigRawSnapshot: undefined,
        _betweenConfigSnapshotsForTesting: () => {
          renameSync(root, retainedRoot);
          renameSync(join(retainedRoot, "config.json"), join(replacementRoot, "config.json"));
          renameSync(replacementRoot, root);
        },
      }));
      expect(results.find((result) => result.name === "backend-publication")).toMatchObject({
        status: "fail",
        message: expect.stringContaining("authenticated publication state is invalid or unsafe"),
      });
      expect(results.find((result) => result.name === "daemon")?.status).toBe("skip");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it.each(["absent", "non-private"] as const)(
    "preserves the legacy %s LCM-root read without publication evidence",
    async (rootShape) => {
      const home = mkdtempSync(join(tmpdir(), `lcm-doctor-legacy-${rootShape}-root-`));
      if (rootShape === "non-private") {
        mkdirSync(join(home, ".lcm"), { mode: 0o755 });
        writeFileSync(join(home, ".lcm", "config.json"), "{}\n", { mode: 0o600 });
      }
      try {
        const results = await runDoctor(minimalDeps({
          homedir: home,
          _readDaemonConfigRawSnapshot: undefined,
        }));
        expect(results.find((result) => result.name === "backend-publication")).toBeUndefined();
        expect(results.find((result) => result.name === "config")).toMatchObject({ status: "pass" });
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
  );

  it("blocks admission when config bytes drift between lock-free snapshots", async () => {
    const home = mkdtempSync(join(tmpdir(), "lcm-doctor-config-drift-"));
    const configFile = join(home, ".lcm", "config.json");
    mkdirSync(join(home, ".lcm"), { recursive: true, mode: 0o700 });
    writeFileSync(configFile, "{}\n", { mode: 0o600 });
    const validateProjectMap = vi.spyOn(projectMapModule, "validateProjectMap");
    try {
      const results = await runDoctor(minimalDeps({
        homedir: home,
        _readDaemonConfigRawSnapshot: undefined,
        _betweenConfigSnapshotsForTesting: () => {
          writeFileSync(configFile, JSON.stringify({ daemon: { port: 4545 } }), { mode: 0o600 });
        },
      }));
      expect(results.find((result) => result.name === "backend-publication")).toMatchObject({
        status: "fail",
        message: expect.stringContaining("authenticated publication state is invalid or unsafe"),
      });
      expect(results.find((result) => result.name === "daemon")?.status).toBe("skip");
      expect(validateProjectMap).not.toHaveBeenCalled();
    } finally {
      validateProjectMap.mockRestore();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("blocks admission when invalid config bytes drift between lock-free snapshots", async () => {
    const home = mkdtempSync(join(tmpdir(), "lcm-doctor-invalid-config-drift-"));
    const lcmRoot = join(home, ".lcm");
    const configFile = join(lcmRoot, "config.json");
    const replacement = join(lcmRoot, "config.next.json");
    mkdirSync(lcmRoot, { recursive: true, mode: 0o700 });
    writeFileSync(configFile, JSON.stringify({ daemon: { port: 4545 }, storage: { backend: "invalid" } }), { mode: 0o600 });
    writeFileSync(replacement, JSON.stringify({ daemon: { port: 5656 }, storage: { backend: "invalid" } }), { mode: 0o600 });
    try {
      const results = await runDoctor(minimalDeps({
        homedir: home,
        _readDaemonConfigRawSnapshot: undefined,
        _betweenConfigSnapshotsForTesting: () => renameSync(replacement, configFile),
      }));
      expect(results.find((result) => result.name === "backend-publication")).toMatchObject({
        status: "fail",
        message: expect.stringContaining("authenticated publication state is invalid or unsafe"),
      });
      expect(results.find((result) => result.name === "daemon")?.status).toBe("skip");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("blocks invalid config when publication evidence changes between snapshots", async () => {
    const invalidConfig = JSON.stringify({ storage: { backend: "invalid" } });
    const admissions = vi.fn()
      .mockReturnValueOnce(Object.freeze({ journalChecksumSha256: "a".repeat(64) }))
      .mockReturnValueOnce(Object.freeze({ journalChecksumSha256: "b".repeat(64) }));
    const results = await runDoctor(minimalDeps({
      ...doctorConfigSeams(invalidConfig, admissions),
    }));
    expect(results.find((result) => result.name === "backend-publication")).toMatchObject({
      status: "fail",
      message: expect.stringContaining("authenticated publication state is invalid or unsafe"),
    });
    expect(results.find((result) => result.name === "daemon")?.status).toBe("skip");
  });

  it("blocks admission when publication evidence changes between lock-free snapshots", async () => {
    const home = mkdtempSync(join(tmpdir(), "lcm-doctor-journal-drift-"));
    mkdirSync(join(home, ".lcm"), { recursive: true, mode: 0o700 });
    writeFileSync(join(home, ".lcm", "config.json"), "{}", { mode: 0o600 });
    const firstChecksum = writeAbortedTerminalPublicationJournal(home, "terminal-publication-a");
    const validateProjectMap = vi.spyOn(projectMapModule, "validateProjectMap");
    const admissions: Array<string | null> = [];
    try {
      const results = await runDoctor(minimalDeps({
        homedir: home,
        _readDaemonConfigRawSnapshot: undefined,
        _assertPublicationReadAccess: (...args) => {
          const admission = assertBackendPublicationConfigReadAccess(...args);
          admissions.push(admission.journalChecksumSha256);
          return admission;
        },
        _betweenConfigSnapshotsForTesting: () => {
          // A second valid terminal journal with a different checksum: the
          // config bytes and descriptor are unchanged, so only the evidence
          // differs and the checksum inequality is the guard that fires.
          writeAbortedTerminalPublicationJournal(home, "terminal-publication-b");
        },
      }));
      expect(admissions).toHaveLength(2);
      expect(admissions[0]).toBe(firstChecksum);
      expect(admissions[1]).not.toBe(firstChecksum);
      expect(results.find((result) => result.name === "backend-publication")).toMatchObject({
        status: "fail",
        message: expect.stringContaining("authenticated publication state is invalid or unsafe"),
      });
      expect(results.find((result) => result.name === "config")?.status).toBe("pass");
      expect(validateProjectMap).not.toHaveBeenCalled();
    } finally {
      validateProjectMap.mockRestore();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("reports blocked publication admission without attempting repair", async () => {
    const home = mkdtempSync(join(tmpdir(), "lcm-doctor-publication-blocked-"));
    try {
      const publicationDir = join(home, ".lcm", "backend-publication");
      mkdirSync(publicationDir, { recursive: true, mode: 0o700 });
      writeFileSync(join(publicationDir, "journal.json"), "{", { mode: 0o600 });
      const results = await runDoctor(minimalDeps({
        homedir: home,
        _readDaemonConfigRawSnapshot: undefined,
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
        _readDaemonConfigRawSnapshot: undefined,
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
        _readDaemonConfigRawSnapshot: undefined,
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
    mkdirSync(join(home, ".lcm"), { recursive: true, mode: 0o700 });
    const configFile = join(home, ".lcm", "config.json");
    if (_label === "oversized") {
      // One byte over the bounded snapshot limit: the real reader refuses it
      // before any bytes are trusted.
      writeFileSync(configFile, "x".repeat(4 * 1024 * 1024 + 1), { mode: 0o600 });
    } else {
      // A directory in place of the config file fails the regular-file check.
      mkdirSync(configFile, { mode: 0o700 });
    }
    try {
      const results = await runDoctor(minimalDeps({
        homedir: home,
        _readDaemonConfigRawSnapshot: undefined,
      }));
      expect(results.find((result) => result.name === "backend-publication")).toMatchObject({
        status: "fail",
        message: expect.stringContaining("Backend publication admission is blocked"),
      });
      expect(results.find((result) => result.name === "config")).toMatchObject({ status: "fail" });
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
    const base = minimalDeps({
      readFileSync: (path: string) => path.endsWith("config.json") ? content : minimalDeps().readFileSync(path),
      _assertBackendPublication: assertPublication,
    });
    try {
      const results = await runDoctor(base);
      // Both variants observe bytes safely through the seam, so the candidate
      // backend is authenticated exactly once after validation fails.
      expect(assertPublication).toHaveBeenCalledOnce();
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

  it("sanitizes unexpected publication admission failures", async () => {
    const results = await runDoctor(minimalDeps({
      _assertBackendPublication: () => { throw new Error("unexpected private publication failure"); },
    }));
    expect(results.find(r => r.name === "doctor-observation")?.status).toBe("fail");
    expect(JSON.stringify(results)).not.toContain("private publication failure");
  });

  it("leaves reconciliation journals unprobed and provides an explicit command", async () => {
    const journalRoot = join(defaultDoctorHome, ".lcm", "reconciliations");
    mkdirSync(journalRoot, { mode: 0o700 });
    const journalPath = join(journalRoot, `${"a".repeat(64)}.json`);
    writeFileSync(journalPath, "private malformed journal", { mode: 0o600 });
    const before = statSync(journalPath);
    const results = await runDoctor(minimalDeps());
    expect(results.find(r => r.name === "worktree-reconciliation")).toMatchObject({
      status: "skip", message: expect.stringContaining("lcm project reconcile-worktrees"),
    });
    expect(statSync(journalPath).mtimeMs).toBe(before.mtimeMs);
    expect(readFileSync(journalPath, "utf8")).toBe("private malformed journal");
  });

  it("fails on invalid map JSON", async () => {
    const home = mkdtempSync(join(tmpdir(), "lcm-doctor-map-invalid-"));
    try {
      mkdirSync(join(home, ".lcm"), { recursive: true });
      writeFileSync(join(home, ".lcm", "map.json"), "{bad-json");

      const results = await runDoctor(minimalDeps({ homedir: home, cwd: "/tmp/nonexistent-project-xyz" }));
      const check = results.find((r) => r.name === "project-map");

      expect(check?.status).toBe("fail");
      expect(check?.message).toContain("Project map");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("preserves valid compact map JSON bytes", async () => {
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

      expect(check?.status).toBe("pass");
      expect(check).not.toHaveProperty("fixApplied");
      expect(readFileSync(mapPath, "utf-8")).toBe(JSON.stringify({ [hash]: { canonical, aliases: [] } }));
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

  it("reports a non-private map as unavailable without aborting doctor", async () => {
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
      expect(check?.message).toContain("Project map");
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
      expect(check?.message).toContain("ambiguous");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("runDoctor summarizer modes", () => {
  it("reports auto mode as Claude and Codex process defaults", async () => {
    const results = await runDoctor(minimalDeps({
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
    }));

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
    expect(config?.message).toContain("Configuration validation failed");
    for (const secret of secrets) expect(JSON.stringify(results)).not.toContain(secret);
    expect(stack?.status).toBe("pass");
    expect(stack?.message).toContain("Storage: unavailable");
    expect(stack?.message).toContain("Summarizer: unavailable");
    expect(results.some((result) => result.name === "secret-detection")).toBe(true);
  });

  it("does not probe a configured daemon when another config field is invalid", async () => {
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
    expect(fetch).not.toHaveBeenCalled();
    expect(ensureDaemon).not.toHaveBeenCalled();
    expect(results.find((result) => result.name === "daemon")?.status).toBe("skip");
  });

  it("does not transition a healthy SQLite daemon from an invalid PostgreSQL config", async () => {
    const previousUrl = process.env.LCM_POSTGRES_URL;
    const previousCaFile = process.env.LCM_POSTGRES_CA_FILE;
    delete process.env.LCM_POSTGRES_URL;
    delete process.env.LCM_POSTGRES_CA_FILE;
    try {
      const fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ status: "ok", version: "0.5.0", storageBackend: "sqlite", pid: 4242, entrypoint: TEST_RUNTIME_ENTRYPOINT, runtimeDigest: EXPECTED_RUNTIME_DIGEST }),
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
        status: "skip",
      });
      expect(fetch).not.toHaveBeenCalled();
      expect(ensureDaemon).not.toHaveBeenCalled();
    } finally {
      if (previousUrl === undefined) delete process.env.LCM_POSTGRES_URL;
      else process.env.LCM_POSTGRES_URL = previousUrl;
      if (previousCaFile === undefined) delete process.env.LCM_POSTGRES_CA_FILE;
      else process.env.LCM_POSTGRES_CA_FILE = previousCaFile;
    }
  });

  it("checks a valid PostgreSQL selection through observation only", async () => {
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
        expect(results.find((result) => result.name === "daemon")?.message).toContain("unavailable");
      }
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(ensureDaemon).not.toHaveBeenCalled();
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
      status: "unavailable", version: "0.5.0", storageBackend: "postgresql", uptime: 10, pid: 4242,
      entrypoint: TEST_RUNTIME_ENTRYPOINT, runtimeDigest: EXPECTED_RUNTIME_DIGEST,
      storage: { status: "unavailable", error: { code: "STORAGE_INITIALIZATION_FAILED", backend: "postgresql", domain: "factory", operation: "health" } },
    };
    const fetch = vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => stagedHealth });
    mockCollectEventStats.mockReturnValue({
      captured: 100,
      unprocessed: 5,
      errors: 0,
      lastCapture: "2026-03-26 10:00:00",
    });
    try {
      const results = await runDoctor(minimalDeps({
        fetch,
        _expectedRuntimeDigestForTesting: EXPECTED_RUNTIME_DIGEST,
        readFileSync: (path: string) => {
          if (path.endsWith("config.json")) {
            return JSON.stringify({ storage: { backend: "postgresql" } });
          }
          if (path.endsWith("daemon.token")) return "doctor-token";
          return minimalDeps().readFileSync(path);
        },
      }));

      expect(ensureDaemon).not.toHaveBeenCalled();
      expect(fetch).toHaveBeenCalledExactlyOnceWith("http://127.0.0.1:3737/health", {
        headers: { Authorization: "Bearer doctor-token" }, signal: expect.any(AbortSignal),
      });
      expect(results.find(r => r.name === "daemon")).toMatchObject({ status: "warn" });
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

  it.each(["unreadable", "empty"])("does not probe when the daemon token is %s", async state => {
    const fetch = vi.fn();
    const deps = minimalDeps({ fetch, readFileSync: path => {
      if (path.endsWith("daemon.token")) {
        if (state === "unreadable") throw new Error("secret access failure");
        return " ";
      }
      return minimalDeps().readFileSync(path);
    } });
    mockCollectEventStats.mockReturnValue({ captured: 100, unprocessed: 5, errors: 0, lastCapture: null } as never);
    const results = await runDoctor(deps);
    expect(fetch).not.toHaveBeenCalled();
    expect(results.find(r => r.name === "daemon")?.status).toBe("fail");
    expect(results.find(r => r.name === "events-capture")?.status).toBe("warn");
    expect(JSON.stringify(results)).not.toContain("queued for automatic daemon processing");
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

      expect(fetch).not.toHaveBeenCalled();
      expect(ensureDaemon).not.toHaveBeenCalled();
    },
  );

  it("reports malformed JSON without aborting doctor", async () => {
    const results = await runDoctor(minimalDeps({
      readFileSync: (path: string) => path.endsWith("config.json") ? "{" : minimalDeps().readFileSync(path),
    }));
    expect(results.find((result) => result.name === "config")).toMatchObject({ status: "fail" });
    expect(results.find((result) => result.name === "config")?.message).toContain("Configuration validation failed");
    expect(results.some((result) => result.name === "project-map")).toBe(true);
  });
});

describe("Passive Learning checks", () => {
  it("runs passive learning checks when hooks need operator repair", async () => {
    // Use deps where hooks check produces "warn" (duplicate hooks in settings.json need repair)
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
          json: async () => ({ status: "ok", version: "0.5.0", storageBackend: "sqlite", pid: 4242, entrypoint: TEST_RUNTIME_ENTRYPOINT, runtimeDigest: EXPECTED_RUNTIME_DIGEST }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ status: "ok", version: "0.5.0", storageBackend: "sqlite", pid: 4242, entrypoint: TEST_RUNTIME_ENTRYPOINT, runtimeDigest: EXPECTED_RUNTIME_DIGEST }),
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
        json: async () => ({ status: "ok", version: "0.5.0", storageBackend: "sqlite", pid: 4242, entrypoint: TEST_RUNTIME_ENTRYPOINT, runtimeDigest: EXPECTED_RUNTIME_DIGEST }),
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
        json: async () => ({ status: "ok", version: "0.5.0", storageBackend: "sqlite", pid: 4242, entrypoint: TEST_RUNTIME_ENTRYPOINT, runtimeDigest: EXPECTED_RUNTIME_DIGEST }),
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

  it("does not advertise pruning even when an injected scanner returns a legacy count", async () => {
    mockCollectEventStats.mockReturnValue({ captured: 0, unprocessed: 0, errors: 0, lastCapture: null, prunedSidecars: 2 } as never);
    const results = await runDoctor(minimalDeps());
    expect(results.some(r => r.name === "events-sidecar-prune" || "fixApplied" in r)).toBe(false);
    expect(mockCollectEventStats).toHaveBeenCalledWith(expect.objectContaining({ homeDir: defaultDoctorHome, pruneOrphanSidecars: false }));
  });

  it("passes doctor sidecar count limit through to passive learning stats", async () => {
    mockCollectEventStats.mockReturnValue({ captured: 100, unprocessed: 5, errors: 0, lastCapture: "2026-03-26 10:00:00" });
    await runDoctor(minimalDeps({ cwd: "/tmp/test-proj" }), { eventsMaxDbs: 123 });
    expect(mockCollectEventStats).toHaveBeenCalledWith({ homeDir: defaultDoctorHome, timeoutMs: 2000, maxDbs: 123, pruneOrphanSidecars: false });
  });

  it("falls back to the default sidecar count limit for invalid runDoctor options", async () => {
    mockCollectEventStats.mockReturnValue({ captured: 100, unprocessed: 5, errors: 0, lastCapture: "2026-03-26 10:00:00" });
    await runDoctor(minimalDeps({ cwd: "/tmp/test-proj" }), { eventsMaxDbs: 0 });
    expect(mockCollectEventStats).toHaveBeenCalledWith({ homeDir: defaultDoctorHome, timeoutMs: 2000, maxDbs: 50, pruneOrphanSidecars: false });
  });

  it("omits scan failure paths in verbose project output", async () => {
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
    const project = results.find(r => r.name === "events-project-1");
    expect(project?.status).toBe("warn");
    expect(project?.message).not.toContain("database disk image is malformed");
    expect(project?.message).not.toContain("/tmp/lcm-events/corrupt.db");
  });

  it("omits skipped scan paths in verbose project output", async () => {
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
    const project = results.find(r => r.name === "events-project-1");
    expect(project?.status).toBe("skip");
    expect(project?.message).toContain("scan skipped");
    expect(project?.message).not.toContain("/tmp/lcm-events/skipped.db");
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
    expect(output).not.toContain("bad.db");
    expect(output).not.toContain("bad path.db");
    expect(output).not.toContain("hook spoof: error");
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

describe("doctor observation contract", () => {
  it("leaves missing managed hooks and guidance unchanged", async () => {
    const deps = minimalDeps({ existsSync: path => !path.endsWith("SKILL.md") });
    const results = await runDoctor(deps);
    expect(results.find(r => r.name === "hooks")).toMatchObject({ status: "warn" });
    expect(results.find(r => r.name === "lcm-md")).toMatchObject({ status: "warn" });
    expect(deps.writeFileSync).not.toHaveBeenCalled();
    expect(deps.mkdirSync).not.toHaveBeenCalled();
    expect(results.some(r => "fixApplied" in r)).toBe(false);
    expect(ensureDaemon).not.toHaveBeenCalled();
    expect(restartDaemon).not.toHaveBeenCalled();
  });

  it("does not probe MCP or prune sidecars and omits arbitrary diagnostic metadata", async () => {
    const canary = "postgres://private-role@private-host/SECRET_TRANSCRIPT";
    mockCollectDetailedEventStats.mockReturnValue({ captured: 1, unprocessed: 0, errors: 1, lastCapture: null,
      projects: [{ file: canary, path: canary, projectId: canary, cwd: canary, captured: 1, unprocessed: 0, lastCapture: null, metadataMissing: true, scanError: canary }],
      recentErrors: [{ hook: canary, error: canary, created_at: canary }],
    } as never);
    const deps = minimalDeps();
    const results = await runDoctor(deps, true);
    expect(mockCollectDetailedEventStats).toHaveBeenCalledWith(expect.objectContaining({ pruneOrphanSidecars: false }));
    expect(deps._testMcpHandshake).not.toHaveBeenCalled();
    expect(results.find(r => r.name === "mcp-handshake-lcm")).toMatchObject({ status: "skip" });
    expect(JSON.stringify(results)).not.toContain(canary);
  });

  it("preserves existing map and remediation marker bytes and inode", async () => {
    const mapPath = join(defaultDoctorHome, ".lcm", "map.json");
    const markerPath = join(defaultDoctorHome, ".lcm", "daemon-remediation.json");
    writeFileSync(mapPath, "{}", { mode: 0o600 });
    writeFileSync(markerPath, "owner marker", { mode: 0o600 });
    const witness = () => [mapPath, markerPath].map(path => ({ content: readFileSync(path, "utf8"), ino: statSync(path).ino, mtime: statSync(path).mtimeMs }));
    const before = witness();
    await runDoctor(minimalDeps());
    expect(witness()).toEqual(before);
  });
});

it("does not promise queue drain without authenticated runtime identity", async () => {
  mockCollectEventStats.mockReturnValue({ captured: 100, unprocessed: 5, errors: 0, lastCapture: null } as never);
  const results = await runDoctor(minimalDeps());
  expect(results.find(r => r.name === "events-capture")).toMatchObject({ status: "warn" });
  expect(JSON.stringify(results)).not.toContain("queued for automatic daemon processing");
});

describe("doctor authenticated daemon identity", () => {
  function authenticatedDeps(health: Record<string, unknown>): DoctorDeps {
    return minimalDeps({
      _expectedRuntimeDigestForTesting: EXPECTED_RUNTIME_DIGEST,
      readFileSync: path => path.endsWith("daemon.token") ? "doctor-token" : minimalDeps().readFileSync(path),
      fetch: vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => health }),
    });
  }
  const healthy = { status: "ok", version: "0.5.0", storageBackend: "sqlite", pid: 4242,
    runtimeDigest: EXPECTED_RUNTIME_DIGEST, entrypoint: TEST_RUNTIME_ENTRYPOINT };

  it.each([
    ["version", undefined], ["version", "0.4.0"], ["runtimeDigest", undefined],
    ["runtimeDigest", "foreign-digest"], ["entrypoint", "/private/other-runtime"],
    ["storageBackend", "postgresql"], ["pid", undefined], ["pid", -1], ["pid", 1.5],
    ["status", "unavailable"],
  ])("rejects unmatched or missing %s without repairing it", async (key, value) => {
    const results = await runDoctor(authenticatedDeps({ ...healthy, [key as string]: value }));
    expect(results.find(r => r.name === "daemon")?.status).toBe("fail");
    expect(ensureDaemon).not.toHaveBeenCalled();
    expect(restartDaemon).not.toHaveBeenCalled();
  });

  it.each(["version", "digest"])("cannot trust peer identity when local %s is missing", async missing => {
    const deps = authenticatedDeps(healthy);
    const read = deps.readFileSync;
    if (missing === "version") deps.readFileSync = path => path.endsWith("package.json") ? "{}" : read(path, "utf8");
    else deps._expectedRuntimeDigestForTesting = undefined;
    const results = await runDoctor(deps);
    expect(results.find(r => r.name === "daemon")?.status).toBe("fail");
  });

  it.each(["fetch", "body"])("bounds a stalled %s and aborts its signal", async stage => {
    vi.useFakeTimers();
    const deps = authenticatedDeps(healthy);
    let signal: AbortSignal | undefined;
    deps.fetch = vi.fn().mockImplementation((_url, options) => {
      signal = options.signal;
      return stage === "fetch" ? new Promise(() => {})
        : Promise.resolve({ ok: true, status: 200, json: () => new Promise(() => {}) });
    });
    const pending = runDoctor(deps);
    await vi.advanceTimersByTimeAsync(2000);
    const results = await pending;
    expect(signal?.aborted).toBe(true);
    expect(results.find(r => r.name === "daemon")).toMatchObject({ status: "fail", message: expect.stringContaining("timed out") });
    const message = results.find(r => r.name === "daemon")?.message;
    expect(message).toContain("run 'lcm daemon restart' or 'lcm doctor'");
    expect(message).not.toMatch(/--detach|--foreground|\b(?:kill|pkill)\b/u);
    expect(ensureDaemon).not.toHaveBeenCalled();
    expect(restartDaemon).not.toHaveBeenCalled();
  });

  it("reports a verified daemon backlog even when optional sidecar metadata counts are absent", async () => {
    mockCollectEventStats.mockReturnValue({ captured: 2000, unprocessed: 1000, errors: 0, lastCapture: null } as never);
    const results = await runDoctor(authenticatedDeps(healthy));
    expect(results.find(r => r.name === "events-capture")).toMatchObject({ status: "warn", message: expect.stringContaining("lcm events promote --all") });
  });
});

describe("doctor bounded static map validation", () => {
  const hash = "a".repeat(64);
  it.each([
    null, [], 5, { wrong: {} }, { [hash]: null }, { [hash]: [] }, { [hash]: 1 },
    { [hash]: { canonical: 1, aliases: [] } },
    { [hash]: { canonical: "relative", aliases: [] } },
    { [hash]: { canonical: "/canonical", aliases: 1 } },
    { [hash]: { canonical: "/canonical", aliases: [1] } },
    { [hash]: { canonical: "/canonical", aliases: ["relative"] } },
    { [hash]: { canonical: "/canonical", aliases: [], remoteProjectId: 1 } },
    { [hash]: { canonical: "/canonical", aliases: [], remoteProjectId: "not-uuid" } },
  ])("refuses malformed map shape %j without rewriting it", async map => {
    const path = join(defaultDoctorHome, ".lcm", "map.json");
    const content = JSON.stringify(map);
    writeFileSync(path, content, { mode: 0o600 });
    const results = await runDoctor(minimalDeps());
    expect(results.find(r => r.name === "project-map")?.status).toBe("fail");
    expect(readFileSync(path, "utf8")).toBe(content);
  });

  it("accepts canonical aliases and a UUIDv7 binding without exposing them", async () => {
    const path = join(defaultDoctorHome, ".lcm", "map.json");
    writeFileSync(path, JSON.stringify({ [hash]: { canonical: "/SECRET_CANARY", aliases: ["/SECRET_CANARY"], remoteProjectId: "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9020" } }), { mode: 0o600 });
    const results = await runDoctor(minimalDeps());
    expect(results.find(r => r.name === "project-map")?.status).toBe("pass");
    expect(JSON.stringify(results)).not.toContain("SECRET_CANARY");
  });
});

it("reports an unreadable installed skill without disclosing the raw error", async () => {
  const deps = minimalDeps();
  const read = deps.readFileSync;
  deps.readFileSync = path => {
    if (path.endsWith("lcm-memory/SKILL.md")) throw new Error("PRIVATE_CA_PATH");
    return read(path, "utf8");
  };
  const results = await runDoctor(deps);
  expect(results.find(r => r.name === "lcm-md")?.status).toBe("fail");
  expect(JSON.stringify(results)).not.toContain("PRIVATE_CA_PATH");
});

it("reports the CLI transport when managed settings have no owned MCP entry", async () => {
  const deps = minimalDeps({ _claudeTransport: "cli" });
  const read = deps.readFileSync;
  deps.readFileSync = path => path.endsWith("settings.json")
    ? JSON.stringify(mergeClaudeSettings({}, TEST_RUNTIME_ENTRYPOINT, process.execPath, "cli"))
    : read(path, "utf8");
  const results = await runDoctor(deps);
  expect(results.find(r => r.name === "mcp-lcm")).toMatchObject({ status: "pass", message: "Claude CLI transport does not use MCP" });
});

it("leaves an absent diagnostic home absent", async () => {
  const home = join(defaultDoctorHome, "never-created");
  await runDoctor({ homedir: home, fetch: vi.fn(), spawnSync: vi.fn().mockReturnValue({ status: 0, stdout: "", stderr: "" }) });
  expect(existsSync(home)).toBe(false);
});

it("preserves real settings, guidance, config and remediation witnesses", async () => {
  const home = defaultDoctorHome;
  const root = join(home, ".lcm");
  const skillDir = join(home, ".claude", "skills", "lcm-memory");
  mkdirSync(skillDir, { recursive: true, mode: 0o700 });
  const files = new Map([
    [join(root, "config.json"), "{}"],
    [join(root, "map.json"), "{}"],
    [daemonRemediationMarkerPath(root), "{\"private-marker\":true}"],
    [join(home, ".claude", "settings.json"), '{"mcpServers":{"lcm":{}},"private":"KEEP"}'],
    [join(skillDir, "SKILL.md"), "old private guidance"],
  ]);
  for (const [path, content] of files) writeFileSync(path, content, { mode: 0o600 });
  const witness = () => [...files.keys()].map(path => ({ content: readFileSync(path, "utf8"), ino: statSync(path).ino, mtime: statSync(path).mtimeMs }));
  const before = witness();
  const results = await runDoctor({ homedir: home, fetch: vi.fn(), spawnSync: vi.fn().mockReturnValue({ status: 0, stdout: "", stderr: "" }) });
  expect(results.find(r => r.name === "hooks")?.status).toBe("warn");
  expect(witness()).toEqual(before);
  expect(existsSync(join(home, ".lcm.backend-publication.lock"))).toBe(false);
});

it("contains unexpected observation failures without returning raw error payloads", async () => {
  mockCollectEventStats.mockRejectedValueOnce(new Error("postgres://ROLE@HOST/SECRET_TRANSCRIPT"));
  const results = await runDoctor(minimalDeps());
  expect(results.find(r => r.name === "doctor-observation")?.status).toBe("fail");
  expect(JSON.stringify(results)).not.toContain("SECRET_TRANSCRIPT");
});

it("preserves an existing legacy-only home without creating the current root", async () => {
  const home = defaultDoctorHome;
  rmSync(join(home, ".lcm"), { recursive: true });
  const legacyRoot = join(home, ".lossless-claude");
  mkdirSync(legacyRoot, { mode: 0o700 });
  writeFileSync(join(legacyRoot, "config.json"), '{"private":"LEGACY_CANARY"}', { mode: 0o600 });
  const before = readdirSync(home);
  await runDoctor({ homedir: home, cwd: home, fetch: vi.fn(), spawnSync: vi.fn().mockReturnValue({ status: 0, stdout: "", stderr: "" }) });
  expect(readdirSync(home)).toEqual(before);
  expect(existsSync(join(home, ".lcm"))).toBe(false);
  expect(readFileSync(join(legacyRoot, "config.json"), "utf8")).toBe('{"private":"LEGACY_CANARY"}');
});

it("uses the authenticated configuration for global pattern counts", async () => {
  const content = JSON.stringify({ security: { sensitivePatterns: ["PATTERN_CANARY_A", "PATTERN_CANARY_B"] } });
  const results = await runDoctor({ ...minimalDeps(), ...doctorConfigSeams(content) });
  expect(results.find(row => row.name === "user-patterns")?.message).toContain("2 global");
  expect(JSON.stringify(results)).not.toContain("PATTERN_CANARY");
});
