import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import * as sqliteConnection from "../../src/db/connection.js";
import { eventsDbPath } from "../../src/db/events-path.js";
import { loadDaemonConfig } from "../../src/daemon/config.js";
import { DaemonClient } from "../../src/daemon/client.js";
import { createDaemon } from "../../src/daemon/server.js";
import { appendLocalHookEvents } from "../../src/hooks/local-enqueue.js";
import { hashProjectPath } from "../../src/project-map.js";
import {
  applyBackendPublicationConfigFile,
} from "../../src/config-manager.js";
import {
  BackendPublicationCoordinator,
  assertBackendPublicationConsumerAccess,
  captureBackendPublicationState,
  readBackendPublicationJournal,
  type BackendPublicationDriver,
  type BackendPublicationFileMutationContext,
  type BackendPublicationRecoveryFile,
} from "../../src/storage/backend-publication.js";
import { applyBackendPublicationProjectMapFile } from "../../src/project-map.js";
import {
  PostgreSqlIdentityRepository,
  type RegisteredMachine,
  type RemoteProject,
} from "../../src/storage/postgresql/identity-repository.js";
import { PostgreSqlRuntime } from "../../src/storage/postgresql/runtime.js";
import { PostgreSqlSummaryRepository } from "../../src/storage/postgresql/summary-context-repositories.js";
import type { DescribeResult } from "../../src/retrieval.js";
import type { ExpansionResult } from "../../src/expansion.js";
import { SqliteStorageBackendFactory } from "../../src/storage/sqlite/factory.js";
import { SQLiteLocalHookOutboxFactory } from "../../src/storage/local-hook-outbox.js";
import {
  assertHarnessReady,
  settings,
  type PostgreSqlTestDatabase,
  withPostgreSqlTestDatabase,
} from "./harness.js";

beforeAll(assertHarnessReady);

const RUNTIME_GRANT_SCRIPTS = [
  "postgresql-runtime-readiness-grants.sql",
  "postgresql-runtime-identity-grants.sql",
  "postgresql-runtime-conversation-grants.sql",
  "postgresql-runtime-summary-context-grants.sql",
  "postgresql-runtime-memory-grants.sql",
  "postgresql-runtime-search-grants.sql",
  "postgresql-runtime-coordination-grants.sql",
  "postgresql-runtime-transcript-grants.sql",
] as const;

function quotePostgreSqlRole(role: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/u.test(role)) {
    throw new Error("unsafe PostgreSQL test role identifier");
  }
  return `"${role}"`;
}

async function applyRuntimeGrantScript(
  administrator: PostgreSqlRuntime,
  fileName: string,
  operation: string,
): Promise<void> {
  const template = readFileSync(
    join(process.cwd(), "src/storage/postgresql/reference", fileName),
    "utf8",
  );
  const sql = template
    .split("\n")
    .filter((line) => !line.startsWith("\\"))
    .join("\n")
    .replaceAll(":\"lcm_runtime_role\"", quotePostgreSqlRole("lcm_test_runtime"));
  await administrator.query({ text: sql }, { domain: "factory", operation });
}

async function applyAllRuntimeGrants(database: PostgreSqlTestDatabase): Promise<void> {
  const administrator = new PostgreSqlRuntime(settings(database.adminUrl));
  try {
    for (const fileName of RUNTIME_GRANT_SCRIPTS) {
      await applyRuntimeGrantScript(
        administrator,
        fileName,
        `apply${fileName.replaceAll(/[^A-Za-z0-9]/gu, "")}`,
      );
    }
  } finally {
    await administrator.close();
  }
}

function recoveryFile(content: string): BackendPublicationRecoveryFile {
  const bytes = Buffer.from(content);
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const gid = typeof process.getgid === "function" ? process.getgid() : 0;
  return {
    presence: "present",
    content: bytes,
    mode: 0o600,
    uid,
    gid,
    nlink: "1",
    dev: "1",
    ino: "2",
    parentDev: "3",
    parentIno: "4",
  };
}

function publicationDriver(homeDir: string): BackendPublicationDriver {
  return {
    observeLocalState: async () => captureBackendPublicationState(homeDir),
    publishProjectMap: (input: BackendPublicationFileMutationContext) =>
      applyBackendPublicationProjectMapFile(input),
    publishConfig: (input: BackendPublicationFileMutationContext) =>
      applyBackendPublicationConfigFile(input),
    restoreConfig: (input: BackendPublicationFileMutationContext) =>
      applyBackendPublicationConfigFile(input),
    restoreProjectMap: (input: BackendPublicationFileMutationContext) =>
      applyBackendPublicationProjectMapFile(input),
  };
}

async function publishPostgreSqlSelection(
  homeDir: string,
  machine: RegisteredMachine,
  project: RemoteProject,
  projectPath: string,
): Promise<void> {
  const lcmDir = join(homeDir, ".lcm");
  mkdirSync(lcmDir, { recursive: true, mode: 0o700 });
  const sourceConfig = "{\"storage\":{\"backend\":\"sqlite\"}}\n";
  const sourceMap = "{}\n";
  const targetConfig = "{\"storage\":{\"backend\":\"postgresql\"}}\n";
  const targetMap = `${JSON.stringify({
    [hashProjectPath(projectPath)]: {
      canonical: projectPath,
      aliases: [],
      remoteProjectId: project.projectId,
    },
  })}\n`;
  writeFileSync(join(lcmDir, "config.json"), sourceConfig, { mode: 0o600 });
  writeFileSync(join(lcmDir, "map.json"), sourceMap, { mode: 0o600 });

  const coordinator = new BackendPublicationCoordinator({
    homeDir,
    driver: publicationDriver(homeDir),
  });
  await coordinator.prepare({
    publicationId: `daemon-runtime-${machine.machineId}`,
    sourceBackend: "sqlite",
    targetBackend: "postgresql",
    material: {
      source: {
        config: recoveryFile(sourceConfig),
        projectMap: recoveryFile(sourceMap),
      },
      target: {
        config: recoveryFile(targetConfig),
        projectMap: recoveryFile(targetMap),
      },
    },
    projects: [{
      localProjectId: hashProjectPath(projectPath),
      remoteProjectId: project.projectId,
      evidenceSha256: createHash("sha256").update(projectPath).digest("hex"),
    }],
  });
  await expect(coordinator.resume()).resolves.toMatchObject({
    phase: "completed",
    targetBackend: "postgresql",
  });
  expect(readBackendPublicationJournal(homeDir)).toMatchObject({
    phase: "completed",
    targetBackend: "postgresql",
  });
  expect(() => assertBackendPublicationConsumerAccess({
    backend: "postgresql",
    homeDir,
  })).not.toThrow();
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe("PostgreSQL 18 daemon runtime", { timeout: 120_000 }, () => {
  it("routes real daemon writes and reads without project SQLite fallback", async () => {
    await withPostgreSqlTestDatabase("daemon-runtime", async (database) => {
      await applyAllRuntimeGrants(database);

      const homeDir = mkdtempSync(join(tmpdir(), "lcm-pg-daemon-home-"));
      const projectRoot = mkdtempSync(join(tmpdir(), "lcm-pg-daemon-project-"));
      const projectPath = join(projectRoot, "project");
      mkdirSync(projectPath);
      const transcriptPath = join(projectPath, "session.jsonl");
      writeFileSync(transcriptPath, [
        JSON.stringify({ message: { role: "user", content: "PostgreSQL daemon ingestion needle NATIVE_PG_SECRET" } }),
        JSON.stringify({ message: { role: "assistant", content: "The selected backend accepted this transcript." } }),
      ].join("\n") + "\n");

      const repository = new PostgreSqlIdentityRepository(database.migrator);
      const machine = await repository.registerMachine(
        `machine:${createHash("sha256").update(projectPath).digest("hex")}`,
        "PostgreSQL daemon integration",
      );
      const project = await repository.createProject({
        machineId: machine.machineId,
        displayName: "PostgreSQL daemon integration project",
        path: projectPath,
        normalizedPath: resolve(projectPath),
      });
      const administratorSettings = settings(database.adminUrl);

      const originalHome = process.env.HOME;
      const originalUserProfile = process.env.USERPROFILE;
      const originalPostgreSqlUrl = process.env.LCM_POSTGRES_URL;
      const originalPostgreSqlCaFile = process.env.LCM_POSTGRES_CA_FILE;
      const originalPostgreSqlMigrationRole = process.env.LCM_POSTGRES_MIGRATION_ROLE;
      let daemon: Awaited<ReturnType<typeof createDaemon>> | undefined;
      const sqliteProjectExists = vi.spyOn(
        SqliteStorageBackendFactory.prototype,
        "projectExists",
      ).mockRejectedValue(new Error("project SQLite fallback sentinel"));
      const sqliteOpenExisting = vi.spyOn(
        SqliteStorageBackendFactory.prototype,
        "openExistingProject",
      ).mockRejectedValue(new Error("project SQLite fallback sentinel"));
      const sqliteOpenProject = vi.spyOn(
        SqliteStorageBackendFactory.prototype,
        "openProject",
      ).mockRejectedValue(new Error("project SQLite fallback sentinel"));
      const sqlitePathInspection = vi.spyOn(
        sqliteConnection,
        "inspectExistingLcmDatabasePath",
      ).mockImplementation(() => {
        throw new Error("project SQLite connection inspection sentinel");
      });
      const runtimeClose = vi.spyOn(PostgreSqlRuntime.prototype, "close");
      const localProjectDbPath = join(
        homeDir,
        ".lcm",
        "projects",
        hashProjectPath(projectPath),
        "db.sqlite",
      );

      try {
        process.env.HOME = homeDir;
        process.env.USERPROFILE = homeDir;
        process.env.LCM_POSTGRES_URL = database.runtimeUrl;
        process.env.LCM_POSTGRES_CA_FILE = process.env.LCM_TEST_POSTGRES_CA_FILE;
        process.env.LCM_POSTGRES_MIGRATION_ROLE = "lcm_test_migrator";
        mkdirSync(join(homeDir, ".lcm"), { recursive: true, mode: 0o700 });
        mkdirSync(join(homeDir, ".claude"), { recursive: true, mode: 0o700 });
        mkdirSync(join(homeDir, ".codex"), { recursive: true, mode: 0o700 });
        writeFileSync(
          join(homeDir, ".lcm", "machine.json"),
          `${JSON.stringify({
            version: 1,
            identityKey: machine.identityKey,
            machineId: machine.machineId,
            displayName: machine.displayName,
          })}\n`,
          { mode: 0o600 },
        );
        await publishPostgreSqlSelection(homeDir, machine, project, projectPath);

        const configPath = join(homeDir, ".lcm", "config.json");
        const config = loadDaemonConfig(
          configPath,
          {
            daemon: { port: 0, idleTimeoutMs: 0 },
            summarizer: { mock: true },
            security: { sensitivePatterns: ["NATIVE_PG_SECRET"] },
          },
          {
            ...process.env,
          },
        );

        daemon = await createDaemon(config, { publicationConfigPath: configPath });
        const client = new DaemonClient(`http://127.0.0.1:${daemon.address().port}`);
        const healthResponse = await fetch(`http://127.0.0.1:${daemon.address().port}/health`);
        const healthBody = await healthResponse.json() as Record<string, unknown>;
        expect(healthResponse.status, JSON.stringify(healthBody)).toBe(200);
        expect(healthBody).toMatchObject({
          status: "ok",
          storageBackend: "postgresql",
        });

        const stored = await client.post<{ stored: boolean; id: string }>("/store", {
          cwd: projectPath,
          text: "PostgreSQL promoted daemon needle",
          tags: ["runtime", "postgresql"],
          metadata: {
            projectPath,
            projectId: project.projectId,
            sessionId: "daemon-runtime-store",
          },
        });
        expect(stored.stored).toBe(true);
        expect(stored.id).toEqual(expect.any(String));

        const ingested = await client.post<{ ingested: number; totalTokens: number }>("/ingest", {
          session_id: "daemon-runtime-ingest",
          cwd: projectPath,
          client: "claude",
          transcript_path: transcriptPath,
        });
        expect(ingested.ingested).toBe(2);
        expect(ingested.totalTokens).toBeGreaterThan(0);
        const raw = await database.migrator.query({
          text: "SELECT native_payload FROM lcm.native_transcripts WHERE project_id=$1 ORDER BY source_ordinal",
          values: [project.projectId],
        }, { domain: "native-transcripts", operation: "verifyNativeImport" });
        expect(raw.rows).toHaveLength(2);
        expect(JSON.stringify(raw.rows)).toContain("[REDACTED]");
        expect(JSON.stringify(raw.rows)).not.toContain("NATIVE_PG_SECRET");
        const links = await database.migrator.query({
          text: "SELECT t.source_ordinal, m.content FROM lcm.transcript_messages AS l JOIN lcm.native_transcripts AS t ON t.project_id=l.project_id AND t.transcript_id=l.transcript_id JOIN lcm.messages AS m ON m.project_id=l.project_id AND m.conversation_id=l.conversation_id AND m.message_id=l.message_id WHERE l.project_id=$1 ORDER BY t.source_ordinal",
          values: [project.projectId],
        }, { domain: "native-transcripts", operation: "verifyNativeLinks" });
        expect(links.rows).toEqual([
          { source_ordinal: "0", content: "PostgreSQL daemon ingestion needle [REDACTED]" },
          { source_ordinal: "1", content: "The selected backend accepted this transcript." },
        ]);
        const retry = await client.post("/ingest", {
          session_id: "daemon-runtime-ingest", cwd: projectPath, client: "claude", transcript_path: transcriptPath,
        });
        expect(retry).toEqual({ ingested: 0, totalTokens: 0 });
        const checkpoint = await database.migrator.query({
          text: "SELECT last_source_ordinal, imported_count FROM lcm.ingest_checkpoints WHERE project_id=$1 AND machine_id=$2",
          values: [project.projectId, machine.machineId],
        }, { domain: "native-transcripts", operation: "verifyNativeCheckpoint" });
        expect(checkpoint.rows).toEqual([{ last_source_ordinal: "1", imported_count: "2" }]);

        const sourceMessages = await database.runtime.query<{
          conversation_id: number; message_id: number; role: string; content: string; token_count: number;
        }>({
          text: `SELECT m.conversation_id::integer, m.message_id::integer, m.role, m.content, m.token_count::integer
                 FROM lcm.messages AS m
                 JOIN lcm.conversations AS c
                   ON c.project_id=m.project_id AND c.conversation_id=m.conversation_id
                 WHERE c.project_id=$1 AND c.session_id=$2 ORDER BY m.seq`,
          values: [project.projectId, "daemon-runtime-ingest"],
        }, { domain: "conversations", operation: "readSummarySources" });
        expect(sourceMessages.rows).toHaveLength(2);
        const summaryId = "sum_daemon_runtime_retrieval";
        const summaryContent = "The selected PostgreSQL backend preserves native import and retrieval provenance.";
        const sourceMessageIds = sourceMessages.rows.map(message => message.message_id);
        const sourceTokenCount = sourceMessages.rows.reduce((total, message) => total + message.token_count, 0);
        const summaries = new PostgreSqlSummaryRepository(database.runtime, project.projectId);
        await summaries.insertSummary({
          summaryId,
          conversationId: sourceMessages.rows[0]!.conversation_id,
          kind: "leaf",
          depth: 0,
          content: summaryContent,
          tokenCount: 12,
          sourceMessageTokenCount: sourceTokenCount,
        });
        await summaries.linkSummaryToMessages(summaryId, sourceMessageIds);
        const described = await client.post<{ node: DescribeResult }>("/describe", {
          cwd: projectPath, nodeId: summaryId,
        });
        expect(described.node).toMatchObject({
          id: summaryId,
          type: "summary",
          summary: {
            conversationId: sourceMessages.rows[0]!.conversation_id,
            kind: "leaf",
            content: summaryContent,
            depth: 0,
            tokenCount: 12,
            sourceMessageTokenCount: sourceTokenCount,
            parentIds: [],
            childIds: [],
            messageIds: sourceMessageIds,
          },
        });
        const parentSummaryId = "sum_daemon_runtime_retrieval_parent";
        await summaries.insertSummary({
          summaryId: parentSummaryId,
          conversationId: sourceMessages.rows[0]!.conversation_id,
          kind: "condensed",
          depth: 1,
          content: "PostgreSQL daemon retrieval overview.",
          tokenCount: 6,
        });
        await summaries.linkSummaryToParents(summaryId, [parentSummaryId]);
        const expanded = await client.post<ExpansionResult>("/expand", {
          cwd: projectPath, nodeId: parentSummaryId, depth: 1,
        });
        expect(expanded).toEqual({
          expansions: [{
            summaryId: parentSummaryId,
            children: [{ summaryId, kind: "leaf", snippet: summaryContent, tokenCount: 12 }],
            messages: [],
          }],
          citedIds: [parentSummaryId, summaryId],
          totalTokens: 12,
          truncated: false,
        });
        const nativeAdministrator = new PostgreSqlRuntime(administratorSettings);
        try {
          await nativeAdministrator.query({ text: "REVOKE SELECT ON lcm.native_transcripts FROM lcm_test_runtime" },
            { domain: "native-transcripts", operation: "injectNativeFailure" });
          const nativeFailurePath = join(projectPath, "native-failure.jsonl");
          writeFileSync(nativeFailurePath, JSON.stringify({ message: { role: "user", content: "retry native failure" } }) + "\n");
          const failedNative = await fetch(`http://127.0.0.1:${daemon.address().port}/ingest`, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ cwd: projectPath, session_id: "native-failure", transcript_path: nativeFailurePath }),
          });
          expect(failedNative.status).toBe(503);
          expect(await failedNative.text()).not.toContain("permission denied");
          const partial = await database.migrator.query({
            text: "SELECT count(*) AS n FROM lcm.messages AS m JOIN lcm.conversations AS c ON c.project_id=m.project_id AND c.conversation_id=m.conversation_id WHERE c.project_id=$1 AND c.session_id=$2",
            values: [project.projectId, "native-failure"],
          }, { domain: "native-transcripts", operation: "verifyParsedBeforeNativeFailure" });
          expect(partial.rows).toEqual([{ n: "1" }]);
          await applyRuntimeGrantScript(nativeAdministrator, "postgresql-runtime-transcript-grants.sql", "restoreNativeGrants");
          expect(await client.post("/ingest", {
            cwd: projectPath, session_id: "native-failure", transcript_path: nativeFailurePath,
          })).toEqual({ ingested: 0, totalTokens: 0 });
          const recovered = await database.migrator.query({
            text: "SELECT count(*) AS n FROM lcm.native_transcripts WHERE project_id=$1 AND native_session_id=$2",
            values: [project.projectId, "native-failure"],
          }, { domain: "native-transcripts", operation: "verifyNativeRetry" });
          expect(recovered.rows).toEqual([{ n: "1" }]);
        } finally { await nativeAdministrator.close(); }



        const search = await client.post<{ promoted: unknown[] }>("/search", {
          cwd: projectPath,
          query: "promoted daemon needle",
        });
        expect(search.promoted.length).toBeGreaterThan(0);

        const grep = await client.post<{ messages: unknown[]; totalMatches: number }>("/grep", {
          cwd: projectPath,
          query: "selected backend accepted",
        });
        expect(grep.messages.length).toBeGreaterThan(0);
        expect(grep.totalMatches).toBeGreaterThan(0);

        const unboundPath = mkdtempSync(join(projectRoot, "unbound-"));
        const unbound = await fetch(`http://127.0.0.1:${daemon.address().port}/store`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            cwd: unboundPath,
            text: "must not be accepted",
          }),
        });
        const unboundBody = await unbound.json() as Record<string, unknown>;
        expect(unbound.status).toBe(409);
        expect(unboundBody).toMatchObject({
          code: "STORAGE_IDENTITY_REQUIRED",
          storageBackend: "postgresql",
        });

        const enqueue = await appendLocalHookEvents({
          cwd: projectPath,
          sessionId: "daemon-runtime-hook",
          events: [{
            type: "decision",
            category: "learning",
            data: "local hook enqueue remains SQLite-backed",
            priority: 1,
          }],
          sourceHook: "UserPromptSubmit",
        });
        expect(enqueue).toMatchObject({ inserted: 1, pendingCount: 1 });
        const localOutboxPath = eventsDbPath(projectPath);
        expect(existsSync(localOutboxPath)).toBe(true);
        const localOutboxFactory = new SQLiteLocalHookOutboxFactory();
        const localOutbox = await localOutboxFactory.openExisting(localOutboxPath);
        try {
          expect(localOutbox).not.toBeNull();
          await expect(localOutbox!.getUnprocessed()).resolves.toHaveLength(1);
        } finally {
          await localOutboxFactory.close();
        }

        expect(existsSync(localProjectDbPath)).toBe(false);
        expect(sqliteProjectExists).not.toHaveBeenCalled();
        expect(sqliteOpenExisting).not.toHaveBeenCalled();
        expect(sqliteOpenProject).not.toHaveBeenCalled();
        expect(sqlitePathInspection).not.toHaveBeenCalled();

        const administrator = new PostgreSqlRuntime(administratorSettings);
        await administrator.query({
          text: "REVOKE ALL ON TABLE lcm.projects FROM lcm_test_runtime",
        }, { domain: "factory", operation: "revokeRuntimeProjectAccess" });
        await administrator.close();

        const outage = await fetch(`http://127.0.0.1:${daemon.address().port}/search`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ cwd: projectPath, query: "outage" }),
        });
        const outageBody = await outage.json() as Record<string, unknown>;
        expect(outage.status).toBe(503);
        expect(outageBody).toMatchObject({
          backend: "postgresql",
          code: expect.any(String),
        });
        const serializedOutage = JSON.stringify(outageBody).toLowerCase();
        expect(serializedOutage).not.toContain(database.runtimeUrl.toLowerCase());
        expect(serializedOutage).not.toContain(database.adminUrl.toLowerCase());
        expect(serializedOutage).not.toContain(projectPath.toLowerCase());
        expect(serializedOutage).not.toContain("cause");
        expect(serializedOutage).not.toContain("stack");

        const closesBeforeStop = runtimeClose.mock.calls.length;
        await daemon.stop();
        daemon = undefined;
        expect(runtimeClose.mock.calls.length).toBeGreaterThan(closesBeforeStop);
        expect(existsSync(localProjectDbPath)).toBe(false);
      } finally {
        if (daemon !== undefined) {
          await daemon.stop();
          daemon = undefined;
        }
        runtimeClose.mockRestore();
        sqlitePathInspection.mockRestore();
        sqliteOpenProject.mockRestore();
        sqliteOpenExisting.mockRestore();
        sqliteProjectExists.mockRestore();
        restoreEnvironment("HOME", originalHome);
        restoreEnvironment("USERPROFILE", originalUserProfile);
        restoreEnvironment("LCM_POSTGRES_URL", originalPostgreSqlUrl);
        restoreEnvironment("LCM_POSTGRES_CA_FILE", originalPostgreSqlCaFile);
        restoreEnvironment("LCM_POSTGRES_MIGRATION_ROLE", originalPostgreSqlMigrationRole);
        rmSync(homeDir, { recursive: true, force: true });
        rmSync(projectRoot, { recursive: true, force: true });
      }
    });
  });
});
