import { describe, expect, it } from "vitest";
import { afterEach, beforeEach, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonClient } from "../src/daemon/client.js";
import { cwdToProjectHash, importSessions } from "../src/import.js";
import { clearProjectMapCache, hashProjectPath, normalizeProjectPath, projectMapPath } from "../src/project-map.js";
import {
  STORAGE_IDENTITY_REQUIRED_ERROR_CODE,
  STORAGE_IDENTITY_REQUIRED_UNBOUND_REASON,
  StorageIdentityConfigurationError,
  UNBOUND_POSTGRESQL_PROJECT_MESSAGE,
} from "../src/storage/identity-context.js";
import * as configModule from "../src/daemon/config.js";
import * as publicationModule from "../src/storage/backend-publication.js";
import { clearGitProjectAnchorCache } from "../src/git-project.js";
import { clearWorktreeReconciliationCache } from "../src/worktree-reconciliation.js";
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

describe("import dry-run agrees with the real run for unopenable projects", () => {
  let home: string;
  let claudeProjectsDir: string;
  let server: Server | undefined;
  const dirs: string[] = [];

  function makeTmpDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "lcm-import-agreement-"));
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    mkdirSync(join(home, ".lcm"), { mode: PRIVATE_DIRECTORY_MODE });
    chmodSync(join(home, ".lcm"), PRIVATE_DIRECTORY_MODE);
    writeFileSync(join(home, ".lcm", "machine.json"), JSON.stringify({
      version: 1,
      identityKey: "machine:" + "a".repeat(64),
      machineId: "01940000-0000-7000-8000-0000000000aa",
      displayName: "test",
    }), { mode: PRIVATE_FILE_MODE });
    clearProjectMapCache();
    clearGitProjectAnchorCache();
    clearWorktreeReconciliationCache();
    claudeProjectsDir = makeTmpDir("lcm-import-agreement-claude-");
  });

  afterEach(async () => {
    await new Promise<void>(resolve => server?.close(() => resolve()) ?? resolve());
    server = undefined;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    clearProjectMapCache();
    clearGitProjectAnchorCache();
    clearWorktreeReconciliationCache();
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
    rmSync(home, { recursive: true, force: true });
  });

  function selectPostgresqlBackend(): void {
    const config = configModule.loadDaemonConfig(join(home, ".lcm", "config.json"));
    vi.spyOn(configModule, "loadDaemonConfig").mockReturnValue({
      ...config,
      storage: { ...config.storage, backend: "postgresql" },
    });
    vi.spyOn(publicationModule, "assertBackendPublicationConsumerAccess").mockReturnValue(undefined);
  }

  function plantUnboundProjectWithSessions(name: string, sessionCount: number): string {
    const cwd = join(home, name);
    mkdirSync(cwd, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    chmodSync(cwd, PRIVATE_DIRECTORY_MODE);
    const canonical = normalizeProjectPath(cwd);
    writeFileSync(
      projectMapPath(),
      JSON.stringify({ [hashProjectPath(canonical)]: { canonical, aliases: [] } }) + "\n",
      { mode: PRIVATE_FILE_MODE },
    );
    clearProjectMapCache();
    const projectDir = join(claudeProjectsDir, cwdToProjectHash(canonical));
    mkdirSync(projectDir, { recursive: true });
    for (let index = 0; index < sessionCount; index += 1) {
      writeFileSync(join(projectDir, "session-" + index + ".jsonl"), "");
    }
    return canonical;
  }

  async function startUnboundDaemon(): Promise<{ client: DaemonClient; posts: string[] }> {
    const posts: string[] = [];
    const daemon = createServer((_req, res) => {
      posts.push("ingest");
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        code: STORAGE_IDENTITY_REQUIRED_ERROR_CODE,
        reason: STORAGE_IDENTITY_REQUIRED_UNBOUND_REASON,
        error: UNBOUND_POSTGRESQL_PROJECT_MESSAGE,
        storageBackend: "postgresql",
      }));
    });
    server = daemon;
    await new Promise<void>(resolve => daemon.listen(0, "127.0.0.1", resolve));
    const address = daemon.address();
    if (address === null || typeof address === "string") throw new Error("daemon server did not bind");
    return { client: new DaemonClient("http://127.0.0.1:" + address.port), posts };
  }

  it("fails the same sessions dry and real for an unbound PostgreSQL project", async () => {
    const unbound = plantUnboundProjectWithSessions("unbound", 2);
    selectPostgresqlBackend();
    const dry = await startUnboundDaemon();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const dryResult = await importSessions(dry.client, {
      all: true,
      provider: "claude",
      dryRun: true,
      verbose: true,
      _claudeProjectsDir: claudeProjectsDir,
    });

    expect(dry.posts).toEqual([]);
    expect(dryResult).toMatchObject({ imported: 0, failed: 2 });
    const dryLines = error.mock.calls.map(call => String(call[0]));
    expect(dryLines.filter(line => line === ("  " + unbound + ": " + UNBOUND_POSTGRESQL_PROJECT_MESSAGE))).toHaveLength(1);

    error.mockClear();
    const real = await startUnboundDaemon();
    const realResult = await importSessions(real.client, {
      all: true,
      provider: "claude",
      dryRun: false,
      verbose: true,
      _claudeProjectsDir: claudeProjectsDir,
    });

    expect(real.posts).toHaveLength(2);
    expect(realResult).toMatchObject({ imported: 0, failed: 2 });
    const realLines = error.mock.calls.map(call => String(call[0]));
    expect(realLines.filter(line => line === ("  " + unbound + ": " + UNBOUND_POSTGRESQL_PROJECT_MESSAGE))).toHaveLength(1);

    // The preview agrees with the real run instead of counting the
    // unopenable project's sessions as importable.
    expect({ imported: dryResult.imported, failed: dryResult.failed }).toEqual({
      imported: realResult.imported,
      failed: realResult.failed,
    });
  });

  it("counts the same sessions imported dry and real under SQLite", async () => {
    const cwd = join(home, "sqlite-project");
    mkdirSync(cwd, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    const canonical = normalizeProjectPath(cwd);
    const projectDir = join(claudeProjectsDir, cwdToProjectHash(canonical));
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "a.jsonl"), "");
    writeFileSync(join(projectDir, "b.jsonl"), "");
    const lcmDir = makeTmpDir("lcm-import-agreement-lcm-");
    mkdirSync(join(lcmDir, "projects", "valid"), { recursive: true });
    writeFileSync(
      join(lcmDir, "projects", "valid", "meta.json"),
      JSON.stringify({ cwd: canonical }),
    );
    const resolving = { post: vi.fn(async () => ({ ingested: 1, totalTokens: 10 })) };

    const dryResult = await importSessions(resolving as unknown as DaemonClient, {
      all: true,
      provider: "claude",
      dryRun: true,
      _claudeProjectsDir: claudeProjectsDir,
      _lcmDir: lcmDir,
    });
    expect(resolving.post).not.toHaveBeenCalled();
    const realResult = await importSessions(resolving as unknown as DaemonClient, {
      all: true,
      provider: "claude",
      dryRun: false,
      _claudeProjectsDir: claudeProjectsDir,
      _lcmDir: lcmDir,
    });

    expect(resolving.post).toHaveBeenCalledTimes(2);
    expect({ imported: dryResult.imported, failed: dryResult.failed }).toEqual({ imported: 2, failed: 0 });
    expect({ imported: realResult.imported, failed: realResult.failed }).toEqual({ imported: 2, failed: 0 });
  });
  it("imports dry-run sessions when the injected open validation succeeds", async () => {
    const cwd = "/validated/project";
    const projectDir = join(claudeProjectsDir, cwdToProjectHash(cwd));
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "session.jsonl"), "");
    const validate = vi.fn(async (_cwd: string) => undefined);
    const client = { post: vi.fn(async () => { throw new Error("must not ingest"); }) };
    const result = await importSessions(client as unknown as DaemonClient, {
      cwd,
      dryRun: true,
      _claudeProjectsDir: claudeProjectsDir,
      _validateProjectOpen: validate,
    });
    expect(validate).toHaveBeenCalledExactlyOnceWith(cwd);
    expect(client.post).not.toHaveBeenCalled();
    expect(result).toMatchObject({ imported: 1, failed: 0 });
  });
  it("fails dry-run sessions without a project line when validation fails generically", async () => {
    const cwd = "/broken/project";
    const projectDir = join(claudeProjectsDir, cwdToProjectHash(cwd));
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "session.jsonl"), "");
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const client = { post: vi.fn(async () => ({ ingested: 1, totalTokens: 1 })) };
    const result = await importSessions(client as unknown as DaemonClient, {
      cwd,
      dryRun: true,
      verbose: true,
      _claudeProjectsDir: claudeProjectsDir,
      _validateProjectOpen: async () => { throw new Error("storage boom"); },
    });
    expect(result).toMatchObject({ imported: 0, failed: 1 });
    const lines = error.mock.calls.map(call => String(call[0]));
    expect(lines).toContain("  \u274c session: ingest failed");
    expect(lines.some(line => line.includes(cwd))).toBe(false);
    expect(lines.join("\n")).not.toContain("storage boom");
  });
  it("keeps the generic diagnostic for real-run ingest failures", async () => {
    const cwd = "/failing/project";
    const projectDir = join(claudeProjectsDir, cwdToProjectHash(cwd));
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "session.jsonl"), "");
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const client = { post: vi.fn(async () => { throw new Error("ingest boom"); }) };
    const result = await importSessions(client as unknown as DaemonClient, {
      cwd,
      verbose: true,
      _claudeProjectsDir: claudeProjectsDir,
    });
    expect(result).toMatchObject({ imported: 0, failed: 1 });
    const lines = error.mock.calls.map(call => String(call[0]));
    expect(lines).toContain("  \u274c session: ingest failed");
    expect(lines.some(line => line.includes(cwd))).toBe(false);
    expect(lines.join("\n")).not.toContain("ingest boom");
  });
  it("prints the project remedy without per-session detail for quiet dry-run failures", async () => {
    const cwd = "/quiet-unbound/project";
    const projectDir = join(claudeProjectsDir, cwdToProjectHash(cwd));
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "session.jsonl"), "");
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const client = { post: vi.fn(async () => ({ ingested: 1, totalTokens: 1 })) };
    const result = await importSessions(client as unknown as DaemonClient, {
      cwd,
      dryRun: true,
      _claudeProjectsDir: claudeProjectsDir,
      _validateProjectOpen: async () => {
        throw new StorageIdentityConfigurationError("unbound in test");
      },
    });
    expect(result).toMatchObject({ imported: 0, failed: 1 });
    expect(error).toHaveBeenCalledExactlyOnceWith("  " + cwd + ": " + UNBOUND_POSTGRESQL_PROJECT_MESSAGE);
  });
});
