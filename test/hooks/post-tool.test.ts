// test/hooks/post-tool.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { handlePostToolUse } from "../../src/hooks/post-tool.js";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { projectMetaPath } from "../../src/daemon/project.js";
import { eventsDbPath } from "../../src/db/events-path.js";
import { EventsDb } from "../../src/hooks/events-db.js";
import { loadHookConfig } from "../../src/hooks/config.js";
import { configPath as runtimeConfigPath } from "../../src/runtime-paths.js";
import {
  BackendPublicationCoordinator,
  backendPublicationMaterialWitness,
  captureBackendPublicationState,
  type BackendPublicationDriver,
  type BackendPublicationFenceRecord,
  type BackendPublicationRecoveryFile,
  type BackendPublicationRecoveryMaterial,
} from "../../src/storage/backend-publication.js";
import { applyBackendPublicationConfigFile } from "../../src/config-manager.js";
import { applyBackendPublicationProjectMapFile } from "../../src/project-map.js";

// Mock eventsDbPath to use temp directory
vi.mock("../../src/db/events-path.js", () => ({
  eventsDbPath: () => join(process.env.TEST_EVENTS_DIR!, "test.db"),
  eventsDir: () => process.env.TEST_EVENTS_DIR!,
}));

describe("handlePostToolUse", () => {
  let dir: string;
  let homeDir: string;
  let extraDirs: string[];
  let originalHome: string | undefined;

  function expectPersistedDecision(inputCwd: string): void {
    const db = new EventsDb(eventsDbPath(inputCwd));
    try {
      expect(db.getUnprocessed()).toEqual([
        expect.objectContaining({
          session_id: "test-session",
          data: expect.stringContaining("Use SQLite?"),
          source_hook: "PostToolUse",
        }),
      ]);
    } finally {
      db.close();
    }
  }

  async function installCompletedPostgreSqlPublication(
    sensitivePatterns: readonly string[],
  ): Promise<void> {
    const configDir = join(homeDir, ".lcm");
    const configPath = join(configDir, "config.json");
    const projectMapPath = join(configDir, "map.json");
    const publicationId = "post-tool-scrub-patterns";
    const localProjectId = "a".repeat(64);
    const remoteProjectId = "018f0000-0000-7000-8000-000000000001";
    const machineId = "018f0000-0000-7000-8000-000000000002";
    mkdirSync(configDir, { mode: 0o700 });
    const sourceConfig = JSON.stringify({
      storage: { backend: "sqlite" },
      security: { sensitivePatterns },
    });
    const targetConfig = JSON.stringify({
      storage: { backend: "postgresql" },
      security: { sensitivePatterns },
    });
    const projectMap = `${JSON.stringify({
      [localProjectId]: {
        canonical: "/workspace/post-tool",
        aliases: [],
        remoteProjectId,
      },
    }, null, 2)}\n`;
    writeFileSync(configPath, sourceConfig, { mode: 0o600 });
    writeFileSync(projectMapPath, projectMap, { mode: 0o600 });

    const uid = process.getuid?.() ?? 0;
    const gid = process.getgid?.() ?? 0;
    const recoveryFile = (content: string): BackendPublicationRecoveryFile => ({
      presence: "present",
      content: Buffer.from(content),
      mode: 0o600,
      uid,
      gid,
    });
    const material: BackendPublicationRecoveryMaterial = {
      source: {
        config: recoveryFile(sourceConfig),
        projectMap: recoveryFile(projectMap),
      },
      target: {
        config: recoveryFile(targetConfig),
        projectMap: recoveryFile(projectMap),
      },
    };
    const materialDirectory = join(
      configDir,
      "backend-publication-material",
      publicationId,
    );
    const materialRelativePath = join(
      "backend-publication-material",
      publicationId,
      "recovery.json",
    );
    const materialPath = join(configDir, materialRelativePath);
    type EncodedMaterial = {
      readonly source: { readonly config: string; readonly projectMap: string };
      readonly target: { readonly config: string; readonly projectMap: string };
      readonly mode: number;
      readonly uid: number;
      readonly gid: number;
    };
    const encodeMaterial = (input: BackendPublicationRecoveryMaterial): Buffer =>
      Buffer.from(JSON.stringify({
        source: {
          config: Buffer.from((input.source.config as { content: Uint8Array }).content)
            .toString("base64"),
          projectMap: Buffer.from((input.source.projectMap as { content: Uint8Array }).content)
            .toString("base64"),
        },
        target: {
          config: Buffer.from((input.target.config as { content: Uint8Array }).content)
            .toString("base64"),
          projectMap: Buffer.from((input.target.projectMap as { content: Uint8Array }).content)
            .toString("base64"),
        },
        mode: 0o600,
        uid,
        gid,
      } satisfies EncodedMaterial));
    const decodeMaterial = (content: Buffer): BackendPublicationRecoveryMaterial => {
      const encoded = JSON.parse(content.toString("utf8")) as EncodedMaterial;
      const decodeFile = (value: string): BackendPublicationRecoveryFile => ({
        presence: "present",
        content: Buffer.from(value, "base64"),
        mode: encoded.mode,
        uid: encoded.uid,
        gid: encoded.gid,
      });
      return {
        source: {
          config: decodeFile(encoded.source.config),
          projectMap: decodeFile(encoded.source.projectMap),
        },
        target: {
          config: decodeFile(encoded.target.config),
          projectMap: decodeFile(encoded.target.projectMap),
        },
      };
    };
    const sha256 = (content: Uint8Array): string =>
      createHash("sha256").update(content).digest("hex");
    let remoteFence: BackendPublicationFenceRecord | null = null;
    const driver: BackendPublicationDriver = {
      async sealRecoveryMaterial({ material: input }) {
        expect(input).toBe(material);
        const sealed = encodeMaterial(input);
        mkdirSync(materialDirectory, { recursive: true, mode: 0o700 });
        writeFileSync(materialPath, sealed, { mode: 0o600 });
        return {
          relativePath: materialRelativePath,
          sealSha256: sha256(sealed),
          byteLength: sealed.byteLength,
        };
      },
      async authenticateRecoveryMaterial({ recoveryReference }) {
        expect(recoveryReference.relativePath).toBe(materialRelativePath);
        const sealed = readFileSync(materialPath);
        expect(sealed.byteLength).toBe(recoveryReference.byteLength);
        expect(sha256(sealed)).toBe(recoveryReference.sealSha256);
        return decodeMaterial(sealed);
      },
      async observeLocalState() {
        return captureBackendPublicationState(homeDir);
      },
      publishProjectMap: applyBackendPublicationProjectMapFile,
      publishConfig: applyBackendPublicationConfigFile,
      restoreConfig: applyBackendPublicationConfigFile,
      restoreProjectMap: applyBackendPublicationProjectMapFile,
      async acquireRemoteGuard({ journal, project }) {
        remoteFence = {
          projectId: project.remoteProjectId,
          machineId,
          publicationId: journal.publicationId,
          targetBackend: journal.targetBackend,
          evidenceSha256: project.evidenceSha256,
          fencingToken: "1",
          acquiredAt: "2026-08-02T00:00:00.000Z",
          renewedAt: "2026-08-02T00:00:00.000Z",
          expiresAt: "2026-08-02T00:01:00.000Z",
          releasedAt: null,
          databaseExpired: false,
        };
        return remoteFence;
      },
      async readRemoteGuard() {
        return remoteFence;
      },
      async releaseRemoteGuard({ fence }) {
        expect(remoteFence).toEqual(fence);
        remoteFence = {
          ...fence,
          releasedAt: "2026-08-02T00:00:30.000Z",
        };
      },
      async retainCompletedMaterial() {
        expect(existsSync(materialPath)).toBe(true);
      },
      async cleanupAbortedMaterial() {
        throw new Error("completed post-tool publication must not abort");
      },
    };
    const coordinator = new BackendPublicationCoordinator({ homeDir, driver });
    const witnesses = backendPublicationMaterialWitness(material);
    const prepared = await coordinator.prepare({
      publicationId,
      sourceBackend: "sqlite",
      targetBackend: "postgresql",
      material,
      projects: [{
        localProjectId,
        remoteProjectId,
        evidenceSha256: "b".repeat(64),
      }],
      now: new Date("2026-08-02T00:00:00.000Z"),
    });
    expect(prepared).toMatchObject({
      phase: "prepared",
      recoveryReference: expect.objectContaining({ relativePath: materialRelativePath }),
      sourceState: witnesses.source,
      targetState: witnesses.target,
    });
    await expect(coordinator.resume()).resolves.toMatchObject({ phase: "completed" });
    expect(captureBackendPublicationState(homeDir)).toEqual(witnesses.target);
    expect(remoteFence).toMatchObject({
      fencingToken: "1",
      acquiredAt: "2026-08-02T00:00:00.000Z",
      releasedAt: "2026-08-02T00:00:30.000Z",
    });
    expect(runtimeConfigPath()).toBe(configPath);
    expect(loadHookConfig(runtimeConfigPath())).toMatchObject({
      storage: { backend: "postgresql" },
      security: { sensitivePatterns },
    });
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "post-tool-test-"));
    homeDir = mkdtempSync(join(tmpdir(), "post-tool-home-"));
    originalHome = process.env.HOME;
    process.env.HOME = homeDir;
    extraDirs = [];
    process.env.TEST_EVENTS_DIR = dir;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
    for (const extraDir of extraDirs) {
      rmSync(extraDir, { recursive: true, force: true });
    }
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    delete process.env.TEST_EVENTS_DIR;
    delete process.env.CLAUDE_PROJECT_DIR;
  });

  it("captures AskUserQuestion decision", async () => {
    const stdin = JSON.stringify({
      session_id: "test-session",
      tool_name: "AskUserQuestion",
      tool_input: { question: "Use SQLite?" },
      tool_response: "yes",
    });
    const result = await handlePostToolUse(stdin);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("returns empty stdout (PostToolUse hooks don't produce output)", async () => {
    const stdin = JSON.stringify({
      session_id: "test-session",
      tool_name: "Read",
      tool_input: { file_path: "/some/file.ts" },
    });
    const result = await handlePostToolUse(stdin);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("exits gracefully on invalid stdin", async () => {
    const result = await handlePostToolUse("not json");
    expect(result.exitCode).toBe(0); // silent fail
  });

  it("skips sensitive file paths", async () => {
    const stdin = JSON.stringify({
      session_id: "test-session",
      tool_name: "Read",
      tool_input: { file_path: "/project/.env" },
    });
    const result = await handlePostToolUse(stdin);
    expect(result.exitCode).toBe(0);
  });

  it("falls back to CLAUDE_PROJECT_DIR when input cwd is empty", async () => {
    const envCwd = mkdtempSync(join(tmpdir(), "post-tool-env-cwd-"));
    extraDirs.push(envCwd);
    process.env.CLAUDE_PROJECT_DIR = envCwd;

    const stdin = JSON.stringify({
      session_id: "test-session",
      tool_name: "Read",
      cwd: "",
      tool_input: { file_path: join(envCwd, "src/main.ts") },
    });
    const result = await handlePostToolUse(stdin);

    expect(result.exitCode).toBe(0);
    expect(existsSync(projectMetaPath(envCwd))).toBe(true);
    expect(JSON.parse(readFileSync(projectMetaPath(envCwd), "utf-8")).cwd).toBe(envCwd);
  });

  it("preserves surrounding whitespace in the selected cwd", async () => {
    const parent = mkdtempSync(join(tmpdir(), "post-tool-input-cwd-"));
    const inputCwd = join(parent, " project ");
    mkdirSync(inputCwd);
    extraDirs.push(parent);

    const stdin = JSON.stringify({
      session_id: "test-session",
      tool_name: "Read",
      cwd: inputCwd,
      tool_input: { file_path: join(inputCwd, "src/main.ts") },
    });
    const result = await handlePostToolUse(stdin);

    expect(result.exitCode).toBe(0);
    expect(existsSync(projectMetaPath(inputCwd))).toBe(true);
    expect(JSON.parse(readFileSync(projectMetaPath(inputCwd), "utf-8")).cwd).toBe(inputCwd);
  });

  it("persists captured passive events without trusting a payload daemon port", async () => {
    const inputCwd = mkdtempSync(join(tmpdir(), "post-tool-notify-cwd-"));
    extraDirs.push(inputCwd);

    await handlePostToolUse(JSON.stringify({
      session_id: "test-session",
      tool_name: "AskUserQuestion",
      cwd: inputCwd,
      daemon_port: 4567,
      tool_input: { question: "Use SQLite?" },
      tool_response: "yes",
    }));

    expectPersistedDecision(inputCwd);
  });

  it("uses persisted scrub patterns when PostgreSQL secrets are not staged yet", async () => {
    const inputCwd = mkdtempSync(join(tmpdir(), "post-tool-postgresql-cwd-"));
    extraDirs.push(inputCwd);
    await installCompletedPostgreSqlPublication(["SQLite"]);

    await handlePostToolUse(JSON.stringify({
      session_id: "test-session",
      tool_name: "AskUserQuestion",
      cwd: inputCwd,
      tool_input: { question: "Use SQLite?" },
      tool_response: "yes",
    }));

    const db = new EventsDb(eventsDbPath(inputCwd));
    try {
      expect(db.getUnprocessed()[0]?.data).toContain("Use [REDACTED]?");
    } finally {
      db.close();
    }
  });

  it("ignores daemon_port values even when a caller also supplies a port", async () => {
    const inputCwd = mkdtempSync(join(tmpdir(), "post-tool-invalid-port-cwd-"));
    extraDirs.push(inputCwd);

    await handlePostToolUse(JSON.stringify({
      session_id: "test-session",
      tool_name: "AskUserQuestion",
      cwd: inputCwd,
      daemon_port: "4567",
      tool_input: { question: "Use SQLite?" },
      tool_response: "yes",
    }), 4568);

    expectPersistedDecision(inputCwd);
  });

  it("ignores a non-boolean tool output error marker", async () => {
    const inputCwd = mkdtempSync(join(tmpdir(), "post-tool-output-cwd-"));
    extraDirs.push(inputCwd);

    const result = await handlePostToolUse(JSON.stringify({
      session_id: "test-session",
      tool_name: "AskUserQuestion",
      cwd: inputCwd,
      tool_input: { question: "Use SQLite?" },
      tool_response: "yes",
      tool_output: { isError: "false" },
    }));

    expect(result.exitCode).toBe(0);
  });

  it("handles invalid payload shapes and default cwd/port paths", async () => {
    expect(await handlePostToolUse(JSON.stringify({ session_id: "s1" }))).toEqual({ exitCode: 0, stdout: "" });
    expect(await handlePostToolUse(JSON.stringify({ tool_name: "Read" }))).toEqual({ exitCode: 0, stdout: "" });
    expect(await handlePostToolUse(JSON.stringify({ session_id: "s1", tool_name: "Read", tool_input: [] })))
      .toEqual({ exitCode: 0, stdout: "" });
    expect(await handlePostToolUse(JSON.stringify({
      session_id: "s1", tool_name: "AskUserQuestion", tool_input: {}, tool_output: { isError: true }, daemon_port: 0,
    }))).toEqual({ exitCode: 0, stdout: "" });
  });
});
