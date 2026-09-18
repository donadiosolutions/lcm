import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  batchCompact,
  findUncompacted,
  formatLlmDiagnostic,
  runBatchWorkerPool,
  type CompactProgressEvent,
} from "../src/batch-compact.js";
import * as cliStorage from "../src/cli-storage.js";
import * as daemonConfig from "../src/daemon/config.js";
import * as publicationModule from "../src/storage/backend-publication.js";
import * as factoryModule from "../src/storage/factory.js";
import { DaemonClient } from "../src/daemon/client.js";
import {
  captureExistingLcmSnapshot,
  closeLcmConnection,
  getLcmConnection,
  getPoolStats,
  SQLITE_PREVIEW_SNAPSHOT_ERROR,
} from "../src/db/connection.js";
import { runLcmMigrations } from "../src/db/migration.js";
import {
  addProjectAlias,
  clearProjectMapCache,
  projectMapPath,
  renewRetiredProjectIdentity,
  setRemoteProjectBinding,
} from "../src/project-map.js";
import {
  ensureProjectDir,
  MAX_PROJECT_METADATA_BYTES,
  projectPaths,
} from "../src/daemon/project.js";
import { recoverMachineIdentity } from "../src/machine-identity.js";
import {
  RETIRED_PROJECT_IDENTITY_DIAGNOSTIC,
  serializeWorktreeReconciliationFence,
} from "../src/worktree-reconciliation-fence.js";
import { NinjaRenderer } from "../src/cli/pipeline-runner.js";
import { makeProgressState } from "../src/cli/progress-state.js";

const FULL_SUITE_DISCOVERY_TEST_TIMEOUT_MS = 15_000;
const BATCH_COMPACT_TEST_MACHINE_ID = "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9012";
const mutableFs = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;

function withBuiltinFsOverride<T>(
  name: string,
  replacement: unknown,
  operation: () => T,
): T {
  const original = mutableFs[name];
  mutableFs[name] = replacement;
  syncBuiltinESMExports();
  try {
    return operation();
  } finally {
    mutableFs[name] = original;
    syncBuiltinESMExports();
  }
}

function resetLcmHome(): void {
  rmSync(join(homedir(), ".lcm"), { recursive: true, force: true });
  mkdirSync(join(homedir(), ".lcm"), { recursive: true, mode: 0o700 });
  chmodSync(join(homedir(), ".lcm"), 0o700);
  clearProjectMapCache();
}

function makeDir(name: string): string {
  const path = join(homedir(), name);
  mkdirSync(path, { recursive: true });
  return path;
}

function insertMessages(db: DatabaseSync, conversationId: number, count = 9, totalTokens = 250): void {
  for (let seq = 1; seq <= count; seq++) {
    const result = db.prepare(
      "INSERT INTO messages (conversation_id, seq, role, content, token_count) VALUES (?, ?, ?, ?, ?)",
    ).run(conversationId, seq, "user", `hello ${conversationId}-${seq}`, seq === 1 ? totalTokens - count + 1 : 1);
    db.prepare(
      "INSERT INTO context_items (conversation_id, ordinal, item_type, message_id) VALUES (?, ?, 'message', ?)",
    ).run(conversationId, seq - 1, Number(result.lastInsertRowid));
  }
}

function seedConversation(dbPath: string, messageCount = 9): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    runLcmMigrations(db);
    db.prepare("INSERT INTO conversations (conversation_id, session_id) VALUES (?, ?)").run(1, "session-1");
    insertMessages(db, 1, messageCount);
  } finally {
    db.close();
  }
}

function seedConversations(dbPath: string, ids: readonly number[] = [1, 2]): void {
  const db = getLcmConnection(dbPath);
  try {
    runLcmMigrations(db);
    for (const id of ids) {
      db.prepare("INSERT INTO conversations (conversation_id, session_id) VALUES (?, ?)").run(id, `session-${id}`);
      insertMessages(db, id);
    }
  } finally {
    closeLcmConnection(dbPath);
  }
}

function fileSha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sqliteJournalMode(dbPath: string): string {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db.prepare("PRAGMA journal_mode").get() as { journal_mode: unknown };
    if (typeof row.journal_mode !== "string") throw new Error("missing SQLite journal mode");
    return row.journal_mode;
  } finally {
    db.close();
  }
}

function sqliteSidecars(dbPath: string): Array<{ name: string; bytes: Buffer }> {
  const parent = dirname(dbPath);
  const leaf = basename(dbPath);
  return readdirSync(parent)
    .filter(name => name === `${leaf}-wal` || name === `${leaf}-shm` || name === `${leaf}-journal`)
    .sort()
    .map(name => ({ name, bytes: readFileSync(join(parent, name)) }));
}

function sqliteSourceFiles(dbPath: string): Array<{ name: string; mode: number; sha256: string }> {
  const parent = dirname(dbPath);
  const leaf = basename(dbPath);
  return readdirSync(parent)
    .filter(name => name === leaf || name === `${leaf}-wal` || name === `${leaf}-shm` || name === `${leaf}-journal`)
    .sort()
    .map(name => ({
      name,
      mode: statSync(join(parent, name)).mode & 0o777,
      sha256: fileSha256(join(parent, name)),
    }));
}

function previewSnapshotDirectories(root: string): string[] {
  return readdirSync(root).filter(name => name.startsWith("lcm-sqlite-preview-")).sort();
}

function openCommittedWalFixture(dbPath: string, projectId = "wal-project"): DatabaseSync {
  seedConversation(dbPath);
  const writer = new DatabaseSync(dbPath);
  writer.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0");
  writer.exec(`BEGIN IMMEDIATE;
    CREATE TABLE wal_preview_probe(value TEXT NOT NULL);
    INSERT INTO wal_preview_probe(value) VALUES ('wal-only');
    INSERT INTO conversations (conversation_id, session_id) VALUES (2, 'wal-session');
    COMMIT;`);
  insertMessages(writer, 2);
  writer.prepare("INSERT INTO runtime_native_transcripts VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
    "wal-native-transcript",
    projectId,
    "local",
    "codex",
    "jsonl",
    "1",
    "wal-session",
    "sessions/wal-only.jsonl",
    1,
    "2026-09-16 00:00:00",
    "2026-09-16 00:00:01",
    "1",
    "d".repeat(64),
    "e".repeat(64),
    '{"message":"scrubbed"}',
  );
  return writer;
}

function copyCrashWalFixture(sourcePath: string, destinationPath: string): void {
  copyFileSync(sourcePath, destinationPath);
  copyFileSync(`${sourcePath}-wal`, `${destinationPath}-wal`);
  chmodSync(destinationPath, 0o600);
  chmodSync(`${destinationPath}-wal`, 0o600);
}

function sizedProjectMetadata(cwd: string, targetBytes: number): string {
  const prefix = `{"cwd":${JSON.stringify(cwd)},"padding":"`;
  const suffix = `"}`;
  const paddingBytes = targetBytes - Buffer.byteLength(prefix + suffix, "utf8");
  if (paddingBytes < 0) throw new Error("project metadata target is too small");
  return `${prefix}${"x".repeat(paddingBytes)}${suffix}`;
}

describe("batch compaction discovery", () => {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  let tempHome: string | undefined;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "lcm-batch-home-"));
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    resetLcmHome();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearProjectMapCache();
    if (tempHome) rmSync(tempHome, { recursive: true, force: true });
    tempHome = undefined;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
  });

  it("discovers a persisted project binding without requiring redundant metadata", async () => {
    const cwd = makeDir("compact-bound-without-metadata");
    const paths = projectPaths(cwd);
    ensureProjectDir(cwd);
    seedConversation(paths.dbPath);
    rmSync(paths.metaPath);

    expect(await findUncompacted(100, true, cwd)).toEqual([
      expect.objectContaining({ cwd: paths.canonical, sessionId: "session-1" }),
    ]);
  });

  it("skips a bound project whose SQLite database does not exist without creating it", async () => {
    const cwd = makeDir("compact-bound-empty");
    const paths = projectPaths(cwd);
    ensureProjectDir(cwd);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    for (const dryRun of [true, false]) {
      expect(await batchCompact({ minTokens: 100, dryRun, port: 3737, cwd })).toEqual({
        compacted: 0, unchanged: 0, skipped: 0, failures: 0, compactedProjects: [],
      });
      expect(existsSync(paths.dbPath)).toBe(false);
    }
  });

  it.each([true, false])(
    "classifies an exact retired project fence before %s discovery child lookup",
    async (dryRun) => {
      const cwd = makeDir(`compact-retired-fence-${dryRun ? "dry" : "normal"}`);
      const paths = projectPaths(cwd);
      ensureProjectDir(cwd);
      rmSync(paths.dir, { recursive: true });
      writeFileSync(
        paths.dir,
        serializeWorktreeReconciliationFence(paths.id, "project"),
        { mode: 0o600 },
      );
      const events: CompactProgressEvent[] = [];
      vi.spyOn(console, "error").mockImplementation(() => undefined);

      expect(await batchCompact({
        minTokens: 100,
        dryRun,
        port: 3737,
        cwd,
        onEvent: event => events.push(event),
      })).toMatchObject({ failures: 1 });
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: "discovery-item-start",
          index: 1,
          total: 1,
          project: paths.canonical,
        }),
      expect.objectContaining({
          type: "phase-failure",
          phase: "Compact",
          project: paths.canonical,
          message: RETIRED_PROJECT_IDENTITY_DIAGNOSTIC,
        }),
        { type: "discovery-clear" },
      ]));
    },
  );

  it("classifies a retired local fence under PostgreSQL discovery without aborting enumeration of other projects", async () => {
    // Finding 2 reproduction: listCliProjects() used to resolve a
    // PostgreSQL identity for every map entry, including a fenced one with
    // no remote binding. That threw the generic unbound-project message,
    // which escaped listCliProjects entirely and made discoverUncompacted
    // report one global "project discovery failed" failure for the whole
    // run — the fenced project never reached withCliProjectStorage's
    // RetiredProjectIdentityError branch, and no other project enumerated.
    const fencedCwd = makeDir("compact-postgresql-retired-fenced");
    const fencedPaths = projectPaths(fencedCwd);
    ensureProjectDir(fencedCwd);
    rmSync(fencedPaths.dir, { recursive: true });
    writeFileSync(
      fencedPaths.dir,
      serializeWorktreeReconciliationFence(fencedPaths.id, "project"),
      { mode: 0o600 },
    );

    const boundCwd = makeDir("compact-postgresql-retired-bound");
    recoverMachineIdentity({
      version: 1,
      identityKey: `machine:${"a".repeat(64)}`,
      machineId: BATCH_COMPACT_TEST_MACHINE_ID,
      displayName: "Test machine",
    });
    setRemoteProjectBinding("018f22c4-6d2a-7f10-8a4c-6b8d3e5f9013", { canonical: boundCwd });

    const config = daemonConfig.loadDaemonConfig(join(tempHome!, ".lcm", "config.json"));
    vi.spyOn(daemonConfig, "loadDaemonConfig").mockReturnValue({
      ...config,
      storage: { ...config.storage, backend: "postgresql" },
    });
    // Bypass real PostgreSQL publication-journal verification and the real
    // network connection; only the fence-classification ordering is under
    // test here, not PostgreSQL storage itself.
    vi.spyOn(publicationModule, "assertBackendPublicationConsumerAccess").mockReturnValue(undefined);
    const realCreateStorageBackendFactory = factoryModule.createStorageBackendFactory;
    vi.spyOn(factoryModule, "createStorageBackendFactory").mockImplementation(async (...args) => {
      if (args[0].backend !== "postgresql") return realCreateStorageBackendFactory(...args);
      return {
        backend: "postgresql",
        capabilities: {},
        projectExists: async () => false,
        openExistingProject: async () => { throw new Error("postgresql storage unavailable in test"); },
        openProject: async () => { throw new Error("postgresql storage unavailable in test"); },
        health: async () => ({ ok: false }),
        close: async () => undefined,
      } as unknown as Awaited<ReturnType<typeof realCreateStorageBackendFactory>>;
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const events: CompactProgressEvent[] = [];
    const result = await batchCompact({
      minTokens: 100,
      dryRun: true,
      port: 3737,
      onEvent: event => events.push(event),
    });

    // Both projects still reach the per-project loop instead of the whole
    // run aborting on the fenced entry's identity resolution.
    expect(events.filter(event => event.type === "discovery-item-start")
      .map(event => (event as { project: string }).project).sort())
      .toEqual([boundCwd, fencedCwd].sort());
    expect(events).toContainEqual(expect.objectContaining({
      type: "phase-failure",
      phase: "Compact",
      project: fencedCwd,
      message: RETIRED_PROJECT_IDENTITY_DIAGNOSTIC,
    }));
    expect(events).not.toContainEqual(expect.objectContaining({
      message: "project discovery failed",
    }));
    const boundFailure = events.find(event => event.type === "phase-failure" && event.project === boundCwd);
    expect(boundFailure).toBeDefined();
    expect((boundFailure as { message: string }).message).not.toBe(RETIRED_PROJECT_IDENTITY_DIAGNOSTIC);
    expect(result.failures).toBe(2);
  });

  it("stops enumerating the retired identity after supported renewal", async () => {
    const cwd = makeDir("compact-retired-renewed");
    const paths = projectPaths(cwd);
    ensureProjectDir(cwd);
    rmSync(paths.dir, { recursive: true });
    writeFileSync(
      paths.dir,
      serializeWorktreeReconciliationFence(paths.id, "project"),
      { mode: 0o600 },
    );
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await batchCompact({ minTokens: 100, dryRun: true, port: 3737, cwd }))
      .toMatchObject({ failures: 1 });

    const renewed = renewRetiredProjectIdentity(cwd);
    const events: CompactProgressEvent[] = [];
    expect(await batchCompact({
      minTokens: 100,
      dryRun: true,
      port: 3737,
      cwd,
      onEvent: event => events.push(event),
    })).toEqual({ compacted: 0, unchanged: 0, skipped: 0, failures: 0, compactedProjects: [] });
    expect(events).toContainEqual(expect.objectContaining({
      type: "discovery-item-start",
      projectId: renewed.newId,
    }));
    expect(events).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ projectId: renewed.oldId }),
    ]));
  });

  it("carries one unambiguous native source locator through dry-run progress", async () => {
    const cwd = makeDir("compact-native-source-locator");
    const paths = projectPaths(cwd);
    ensureProjectDir(cwd);
    seedConversation(paths.dbPath);
    const db = new DatabaseSync(paths.dbPath);
    try {
      db.prepare("INSERT INTO runtime_native_transcripts VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
        "native-transcript",
        paths.id,
        "local",
        "codex",
        "jsonl",
        "1",
        "session-1",
        "sessions/native-session.jsonl",
        1,
        "2026-09-16 00:00:00",
        "2026-09-16 00:00:01",
        "1",
        "b".repeat(64),
        "c".repeat(64),
        '{"message":"scrubbed"}',
      );
    } finally {
      db.close();
    }
    const events: CompactProgressEvent[] = [];
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await batchCompact({
      minTokens: 100,
      dryRun: true,
      port: 3737,
      cwd,
      onEvent: event => events.push(event),
    });

    expect(events).toContainEqual(expect.objectContaining({
      type: "session-terminal",
      outcome: "dry-run",
      identity: expect.objectContaining({
        project: paths.canonical,
        sessionId: "session-1",
        conversationId: 1,
        sourceLocator: "sessions/native-session.jsonl",
      }),
    }));
  });

  it("leaves unmigrated SQLite schema and user version unchanged during preview", async () => {
    const cwd = makeDir("compact-unmigrated-preview");
    const paths = projectPaths(cwd);
    ensureProjectDir(cwd);
    seedConversation(paths.dbPath);
    const db = new DatabaseSync(paths.dbPath);
    db.exec("DROP TABLE session_ingest_log; PRAGMA user_version = 17");
    const schema = db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all();
    db.close();
    expect(await findUncompacted(100, true, cwd)).toEqual([
      expect.objectContaining({ sessionId: "session-1", messages: 9, tokens: 250 }),
    ]);
    const reopened = new DatabaseSync(paths.dbPath);
    try {
      expect(reopened.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 17 });
      expect(reopened.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all()).toEqual(schema);
    } finally { reopened.close(); }
    expect(getPoolStats().totalConnections).toBe(0);
  });

  it("leaves SQLite bytes, mode, journal mode, and sidecars unchanged during preview", async () => {
    const cwd = makeDir("compact-read-only-preview");
    const paths = projectPaths(cwd);
    ensureProjectDir(cwd);
    seedConversation(paths.dbPath);
    const journalMode = sqliteJournalMode(paths.dbPath);
    chmodSync(paths.dbPath, 0o640);
    writeFileSync(`${paths.dbPath}-journal`, "preexisting-sidecar", { mode: 0o640 });
    const before = {
      digest: fileSha256(paths.dbPath),
      mode: statSync(paths.dbPath).mode & 0o777,
      sidecars: sqliteSidecars(paths.dbPath),
    };

    expect(await findUncompacted(100, true, cwd)).toEqual([
      expect.objectContaining({ sessionId: "session-1", messages: 9, tokens: 250 }),
    ]);

    expect(fileSha256(paths.dbPath)).toBe(before.digest);
    expect(statSync(paths.dbPath).mode & 0o777).toBe(before.mode);
    expect(sqliteSidecars(paths.dbPath)).toEqual(before.sidecars);
    expect(getPoolStats().totalConnections).toBe(0);

    rmSync(`${paths.dbPath}-journal`);
    expect(sqliteJournalMode(paths.dbPath)).toBe(journalMode);
  });

  it("opens an existing main-only preview through a private disposable snapshot", () => {
    const cwd = makeDir("compact-read-only-media");
    const paths = projectPaths(cwd);
    ensureProjectDir(cwd);
    seedConversation(paths.dbPath);
    chmodSync(paths.dbPath, 0o440);
    const snapshotRoot = makeDir("compact-read-only-media-snapshots");
    chmodSync(snapshotRoot, 0o700);
    const beforeDigest = fileSha256(paths.dbPath);
    const beforeSidecars = sqliteSidecars(paths.dbPath);
    const snapshot = captureExistingLcmSnapshot(paths.dbPath, {
      _snapshotForTesting: { tempRoot: snapshotRoot },
    });
    expect(snapshot).not.toBeNull();
    if (snapshot === null) throw new Error("preview snapshot was not opened");
    try {
      expect(snapshot.db.prepare("SELECT session_id FROM conversations WHERE conversation_id = 1").get())
        .toMatchObject({ session_id: "session-1" });
      snapshot.db.exec("UPDATE conversations SET title = 'copy-only' WHERE conversation_id = 1");
      expect(snapshot.db.prepare("SELECT title FROM conversations WHERE conversation_id = 1").get())
        .toMatchObject({ title: "copy-only" });
    } finally {
      snapshot.close();
    }
    snapshot.close();

    expect(statSync(paths.dbPath).mode & 0o777).toBe(0o440);
    expect(fileSha256(paths.dbPath)).toBe(beforeDigest);
    expect(sqliteSidecars(paths.dbPath)).toEqual(beforeSidecars);
    expect(previewSnapshotDirectories(snapshotRoot)).toEqual([]);
  });

  it("captures committed live WAL-only rows, schema, and provenance without changing the source", async () => {
    const cwd = makeDir("compact-live-wal-preview");
    const paths = projectPaths(cwd);
    ensureProjectDir(cwd);
    const snapshotRoot = makeDir("compact-live-wal-preview-snapshots");
    chmodSync(snapshotRoot, 0o700);
    const writer = openCommittedWalFixture(paths.dbPath, paths.id);
    const before = sqliteSourceFiles(paths.dbPath);
    try {
      const snapshot = captureExistingLcmSnapshot(paths.dbPath, {
        _snapshotForTesting: { tempRoot: snapshotRoot },
      });
      expect(snapshot).not.toBeNull();
      if (snapshot === null) throw new Error("live WAL snapshot was not opened");
      try {
        expect(snapshot.db.prepare("SELECT value FROM wal_preview_probe").get())
          .toEqual({ value: "wal-only" });
        expect(snapshot.db.prepare("SELECT session_id FROM conversations WHERE conversation_id = 2").get())
          .toEqual({ session_id: "wal-session" });
        snapshot.db.exec("INSERT INTO wal_preview_probe(value) VALUES ('copy-only')");
        expect(snapshot.db.prepare("SELECT count(*) AS count FROM wal_preview_probe").get())
          .toEqual({ count: 2 });
      } finally {
        snapshot.close();
      }
      const events: CompactProgressEvent[] = [];
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      await batchCompact({
        minTokens: 100,
        dryRun: true,
        port: 3737,
        cwd,
        onEvent: event => events.push(event),
      });
      expect(events).toContainEqual(expect.objectContaining({
        type: "session-terminal",
        outcome: "dry-run",
        identity: expect.objectContaining({
          sessionId: "wal-session",
          sourceLocator: "sessions/wal-only.jsonl",
        }),
      }));
      expect(sqliteSourceFiles(paths.dbPath)).toEqual(before);
      expect(previewSnapshotDirectories(snapshotRoot)).toEqual([]);
    } finally {
      writer.close();
    }
  });

  it("rebuilds private shared memory for a retained crash WAL without copying source SHM", () => {
    const sourceCwd = makeDir("compact-crash-wal-source");
    const sourcePaths = projectPaths(sourceCwd);
    ensureProjectDir(sourceCwd);
    const writer = openCommittedWalFixture(sourcePaths.dbPath);
    const crashParent = makeDir("compact-crash-wal-retained");
    chmodSync(crashParent, 0o700);
    const crashPath = join(crashParent, "db.sqlite");
    copyCrashWalFixture(sourcePaths.dbPath, crashPath);
    writer.close();
    const snapshotRoot = makeDir("compact-crash-wal-snapshots");
    chmodSync(snapshotRoot, 0o700);
    const before = sqliteSourceFiles(crashPath);

    const snapshot = captureExistingLcmSnapshot(crashPath, {
      _snapshotForTesting: { tempRoot: snapshotRoot },
    });
    expect(snapshot).not.toBeNull();
    if (snapshot === null) throw new Error("crash WAL snapshot was not opened");
    try {
      expect(snapshot.db.prepare("SELECT value FROM wal_preview_probe").get())
        .toEqual({ value: "wal-only" });
    } finally {
      snapshot.close();
    }
    expect(sqliteSourceFiles(crashPath)).toEqual(before);
    expect(before.map(file => file.name)).not.toContain("db.sqlite-shm");
    expect(previewSnapshotDirectories(snapshotRoot)).toEqual([]);
  });

  it("retries one transient WAL generation drift and returns the new committed generation", () => {
    const cwd = makeDir("compact-wal-retry");
    const paths = projectPaths(cwd);
    ensureProjectDir(cwd);
    const writer = openCommittedWalFixture(paths.dbPath);
    const snapshotRoot = makeDir("compact-wal-retry-snapshots");
    chmodSync(snapshotRoot, 0o700);
    const attempts: number[] = [];
    try {
      const snapshot = captureExistingLcmSnapshot(paths.dbPath, {
        _snapshotForTesting: {
          tempRoot: snapshotRoot,
          afterCopy: ({ attempt }) => {
            attempts.push(attempt);
            if (attempt === 1) writer.exec("INSERT INTO wal_preview_probe(value) VALUES ('new-generation')");
          },
        },
      });
      expect(snapshot).not.toBeNull();
      if (snapshot === null) throw new Error("retried snapshot was not opened");
      try {
        expect(snapshot.db.prepare("SELECT value FROM wal_preview_probe ORDER BY rowid").all())
          .toEqual([{ value: "wal-only" }, { value: "new-generation" }]);
      } finally {
        snapshot.close();
      }
      expect(attempts).toEqual([1, 2]);
      expect(previewSnapshotDirectories(snapshotRoot)).toEqual([]);
    } finally {
      writer.close();
    }
  });

  it("exhausts exactly three attempts under permanent WAL churn and cleans every copy", () => {
    const cwd = makeDir("compact-wal-exhaustion");
    const paths = projectPaths(cwd);
    ensureProjectDir(cwd);
    const writer = openCommittedWalFixture(paths.dbPath);
    const snapshotRoot = makeDir("compact-wal-exhaustion-snapshots");
    chmodSync(snapshotRoot, 0o700);
    const attempts: number[] = [];
    try {
      expect(() => captureExistingLcmSnapshot(paths.dbPath, {
        _snapshotForTesting: {
          tempRoot: snapshotRoot,
          afterCopy: ({ attempt }) => {
            attempts.push(attempt);
            writer.exec(`INSERT INTO wal_preview_probe(value) VALUES ('generation-${attempt}')`);
          },
        },
      })).toThrow(SQLITE_PREVIEW_SNAPSHOT_ERROR);
      expect(attempts).toEqual([1, 2, 3]);
      expect(previewSnapshotDirectories(snapshotRoot)).toEqual([]);
    } finally {
      writer.close();
    }
  });

  it.each(["appearance", "disappearance", "checkpoint"] as const)(
    "retries a WAL %s generation transition without returning a partial source",
    (transition) => {
      const cwd = makeDir(`compact-wal-${transition}`);
      const paths = projectPaths(cwd);
      ensureProjectDir(cwd);
      const snapshotRoot = makeDir(`compact-wal-${transition}-snapshots`);
      chmodSync(snapshotRoot, 0o700);
      let writer: DatabaseSync | undefined;
      if (transition !== "appearance") writer = openCommittedWalFixture(paths.dbPath);
      else seedConversation(paths.dbPath);
      const attempts: number[] = [];
      try {
        const snapshot = captureExistingLcmSnapshot(paths.dbPath, {
          _snapshotForTesting: {
            tempRoot: snapshotRoot,
            afterCopy: ({ attempt }) => {
              attempts.push(attempt);
              if (attempt !== 1) return;
              if (transition === "appearance") {
                writer = new DatabaseSync(paths.dbPath);
                writer.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0");
                writer.exec("CREATE TABLE appeared_in_wal(value TEXT); INSERT INTO appeared_in_wal VALUES ('visible')");
              } else if (transition === "disappearance") {
                writer!.close();
                writer = undefined;
              } else {
                writer!.exec("PRAGMA wal_checkpoint(TRUNCATE)");
              }
            },
          },
        });
        expect(snapshot).not.toBeNull();
        if (snapshot === null) throw new Error("transition snapshot was not opened");
        try {
          if (transition === "appearance") {
            expect(snapshot.db.prepare("SELECT value FROM appeared_in_wal").get())
              .toEqual({ value: "visible" });
          } else {
            expect(snapshot.db.prepare("SELECT value FROM wal_preview_probe").get())
              .toEqual({ value: "wal-only" });
          }
        } finally {
          snapshot.close();
        }
        expect(attempts).toEqual([1, 2]);
        expect(previewSnapshotDirectories(snapshotRoot)).toEqual([]);
      } finally {
        writer?.close();
      }
    },
  );

  it.each(["main replacement", "WAL replacement", "WAL truncation", "WAL extension"] as const)(
    "fails closed on a source %s and removes the private attempt",
    (mutation) => {
      const sourceCwd = makeDir(`compact-source-${mutation.replaceAll(" ", "-")}`);
      const sourcePaths = projectPaths(sourceCwd);
      ensureProjectDir(sourceCwd);
      const writer = openCommittedWalFixture(sourcePaths.dbPath);
      const retainedParent = makeDir(`compact-retained-${mutation.replaceAll(" ", "-")}`);
      chmodSync(retainedParent, 0o700);
      const retainedPath = join(retainedParent, "db.sqlite");
      copyCrashWalFixture(sourcePaths.dbPath, retainedPath);
      writer.close();
      const snapshotRoot = makeDir(`compact-source-${mutation.replaceAll(" ", "-")}-snapshots`);
      chmodSync(snapshotRoot, 0o700);
      const attempts: number[] = [];

      expect(() => captureExistingLcmSnapshot(retainedPath, {
        _snapshotForTesting: {
          tempRoot: snapshotRoot,
          afterCopy: ({ attempt }) => {
            attempts.push(attempt);
            if (mutation === "main replacement") {
              renameSync(retainedPath, `${retainedPath}.old`);
              copyFileSync(`${retainedPath}.old`, retainedPath);
            } else if (mutation === "WAL replacement") {
              renameSync(`${retainedPath}-wal`, `${retainedPath}-wal.old`);
              copyFileSync(`${retainedPath}-wal.old`, `${retainedPath}-wal`);
            } else if (mutation === "WAL truncation") {
              const walPath = `${retainedPath}-wal`;
              const currentSize = statSync(walPath).size;
              if (currentSize <= 1) throw new Error("WAL truncation fixture requires at least two bytes");
              truncateSync(walPath, currentSize - 1);
            } else {
              appendFileSync(`${retainedPath}-wal`, "extended");
            }
          },
        },
      })).toThrow(SQLITE_PREVIEW_SNAPSHOT_ERROR);
      expect(attempts).toEqual(
        mutation === "main replacement" || mutation === "WAL replacement"
          ? [1]
          : [1, 2, 3],
      );
      expect(previewSnapshotDirectories(snapshotRoot)).toEqual([]);
    },
  );

  it("cleans the private snapshot after a preview query failure", () => {
    const cwd = makeDir("compact-preview-query-failure");
    const paths = projectPaths(cwd);
    ensureProjectDir(cwd);
    seedConversation(paths.dbPath);
    const snapshotRoot = makeDir("compact-preview-query-failure-snapshots");
    chmodSync(snapshotRoot, 0o700);
    const snapshot = captureExistingLcmSnapshot(paths.dbPath, {
      _snapshotForTesting: { tempRoot: snapshotRoot },
    });
    expect(snapshot).not.toBeNull();
    if (snapshot === null) throw new Error("query-failure snapshot was not opened");
    try {
      expect(() => snapshot.db.prepare("SELECT * FROM missing_preview_table").all()).toThrow();
    } finally {
      snapshot.close();
    }
    expect(previewSnapshotDirectories(snapshotRoot)).toEqual([]);
  });

  it("preserves existing-only absence semantics for memory and a missing parent", () => {
    expect(captureExistingLcmSnapshot(":memory:")).toBeNull();
    expect(captureExistingLcmSnapshot(join(homedir(), "missing-preview-parent", "db.sqlite")))
      .toBeNull();
  });

  it("retries membership drift observed immediately after source descriptors open", () => {
    const cwd = makeDir("compact-preview-membership-open-race");
    const paths = projectPaths(cwd);
    ensureProjectDir(cwd);
    seedConversation(paths.dbPath);
    const snapshotRoot = makeDir("compact-preview-membership-open-race-snapshots");
    chmodSync(snapshotRoot, 0o700);
    const attempts: number[] = [];
    const snapshot = captureExistingLcmSnapshot(paths.dbPath, {
      _snapshotForTesting: {
        tempRoot: snapshotRoot,
        afterSourceOpen: ({ attempt }) => {
          attempts.push(attempt);
          if (attempt === 1) writeFileSync(`${paths.dbPath}-shm`, "appeared", { mode: 0o600 });
        },
      },
    });
    expect(snapshot).not.toBeNull();
    if (snapshot === null) throw new Error("membership-race snapshot was not opened");
    snapshot.close();
    expect(attempts).toEqual([1, 2]);
    expect(readFileSync(`${paths.dbPath}-shm`, "utf8")).toBe("appeared");
    expect(previewSnapshotDirectories(snapshotRoot)).toEqual([]);
  });

  it.each(["transient", "persistent", "strict"] as const)(
    "handles %s WAL disappearance between membership and retained open",
    (scenario) => {
      const cwd = makeDir(`compact-preview-wal-pre-open-${scenario}`);
      const paths = projectPaths(cwd);
      ensureProjectDir(cwd);
      const writer = openCommittedWalFixture(paths.dbPath);
      const snapshotRoot = makeDir(`compact-preview-wal-pre-open-${scenario}-snapshots`);
      chmodSync(snapshotRoot, 0o700);
      const before = sqliteSourceFiles(paths.dbPath);
      const attempts: number[] = [];
      const originalOpen = mutableFs.openSync as (...args: unknown[]) => number;
      const canary = Object.assign(new Error("injected retained WAL open failure"), {
        code: scenario === "strict" ? "EACCES" : "ENOENT",
      });
      let failures = 0;
      const replacement = (...args: unknown[]): number => {
        const path = String(args[0]);
        const retainedWal = path.startsWith("/proc/self/fd/")
          && path.endsWith(`/${basename(paths.dbPath)}-wal`);
        if (retainedWal && (scenario !== "transient" || failures === 0)) {
          failures += 1;
          throw canary;
        }
        return Reflect.apply(originalOpen, mutableFs, args);
      };

      try {
        withBuiltinFsOverride("openSync", replacement, () => {
          const operation = () => captureExistingLcmSnapshot(paths.dbPath, {
            _snapshotForTesting: {
              tempRoot: snapshotRoot,
              beforeAttempt: ({ attempt }) => attempts.push(attempt),
            },
          });
          if (scenario === "transient") {
            const snapshot = operation();
            expect(snapshot).not.toBeNull();
            if (snapshot === null) throw new Error("transient WAL retry returned no snapshot");
            try {
              expect(snapshot.db.prepare("SELECT value FROM wal_preview_probe").get())
                .toEqual({ value: "wal-only" });
            } finally {
              snapshot.close();
            }
          } else {
            let thrown: unknown;
            try { operation(); } catch (error) { thrown = error; }
            expect(thrown).toMatchObject({ message: SQLITE_PREVIEW_SNAPSHOT_ERROR });
            if (scenario === "strict") {
              expect((thrown as Error & { cause: unknown }).cause).toBe(canary);
            }
          }
        });
        expect(attempts).toEqual(
          scenario === "transient" ? [1, 2] : scenario === "persistent" ? [1, 2, 3] : [1],
        );
        expect(failures).toBe(scenario === "persistent" ? 3 : 1);
        expect(sqliteSourceFiles(paths.dbPath)).toEqual(before);
        expect(previewSnapshotDirectories(snapshotRoot)).toEqual([]);
        expect(getPoolStats().totalConnections).toBe(0);
      } finally {
        writer.close();
      }
    },
  );

  it("refuses a WAL-less retry when pre-open disappearance leaves main unchanged", () => {
    const sourceCwd = makeDir("compact-preview-wal-pre-open-real-source");
    const sourcePaths = projectPaths(sourceCwd);
    ensureProjectDir(sourceCwd);
    const writer = openCommittedWalFixture(sourcePaths.dbPath);
    const retainedParent = makeDir("compact-preview-wal-pre-open-real");
    chmodSync(retainedParent, 0o700);
    const retainedPath = join(retainedParent, "db.sqlite");
    copyCrashWalFixture(sourcePaths.dbPath, retainedPath);
    writer.close();
    const walPath = `${retainedPath}-wal`;
    const displacedWal = `${walPath}.displaced`;
    const beforeMain = fileSha256(retainedPath);
    const beforeWal = fileSha256(walPath);
    const snapshotRoot = makeDir("compact-preview-wal-pre-open-real-snapshots");
    chmodSync(snapshotRoot, 0o700);
    const attempts: number[] = [];
    const originalOpen = mutableFs.openSync as (...args: unknown[]) => number;
    let injected = false;
    const replacement = (...args: unknown[]): number => {
      const path = String(args[0]);
      if (!injected && path.startsWith("/proc/self/fd/")
        && path.endsWith(`/${basename(retainedPath)}-wal`)) {
        injected = true;
        renameSync(walPath, displacedWal);
        throw Object.assign(new Error("injected real WAL disappearance"), { code: "ENOENT" });
      }
      return Reflect.apply(originalOpen, mutableFs, args);
    };

    try {
      withBuiltinFsOverride("openSync", replacement, () => {
        expect(() => captureExistingLcmSnapshot(retainedPath, {
          _snapshotForTesting: {
            tempRoot: snapshotRoot,
            beforeAttempt: ({ attempt }) => attempts.push(attempt),
          },
        })).toThrow(SQLITE_PREVIEW_SNAPSHOT_ERROR);
      });
      expect(injected).toBe(true);
      expect(attempts).toEqual([1, 2]);
      expect(fileSha256(retainedPath)).toBe(beforeMain);
      expect(previewSnapshotDirectories(snapshotRoot)).toEqual([]);
    } finally {
      if (existsSync(displacedWal)) renameSync(displacedWal, walPath);
    }
    expect(fileSha256(walPath)).toBe(beforeWal);
  });

  it("conservatively refuses a checkpoint at pre-open WAL disappearance", () => {
    const cwd = makeDir("compact-preview-wal-pre-open-checkpoint");
    const paths = projectPaths(cwd);
    ensureProjectDir(cwd);
    let writer: DatabaseSync | undefined = openCommittedWalFixture(paths.dbPath);
    const snapshotRoot = makeDir("compact-preview-wal-pre-open-checkpoint-snapshots");
    chmodSync(snapshotRoot, 0o700);
    const attempts: number[] = [];
    const originalOpen = mutableFs.openSync as (...args: unknown[]) => number;
    let injected = false;
    const replacement = (...args: unknown[]): number => {
      const path = String(args[0]);
      if (!injected && path.startsWith("/proc/self/fd/")
        && path.endsWith(`/${basename(paths.dbPath)}-wal`)) {
        injected = true;
        writer!.close();
        writer = undefined;
        throw Object.assign(new Error("injected checkpointed WAL disappearance"), {
          code: "ENOENT",
        });
      }
      return Reflect.apply(originalOpen, mutableFs, args);
    };

    try {
      withBuiltinFsOverride("openSync", replacement, () => {
        expect(() => captureExistingLcmSnapshot(paths.dbPath, {
          _snapshotForTesting: {
            tempRoot: snapshotRoot,
            beforeAttempt: ({ attempt }) => attempts.push(attempt),
          },
        })).toThrow(SQLITE_PREVIEW_SNAPSHOT_ERROR);
      });
      expect(injected).toBe(true);
      expect(attempts).toEqual([1, 2]);
      expect(existsSync(`${paths.dbPath}-wal`)).toBe(false);
      expect(previewSnapshotDirectories(snapshotRoot)).toEqual([]);
    } finally {
      writer?.close();
    }
  });

  it.each(["main", "WAL"] as const)(
    "refuses a cross-attempt %s inode replacement after generation drift",
    (role) => {
      const cwd = makeDir(`compact-preview-cross-attempt-${role.toLowerCase()}`);
      const paths = projectPaths(cwd);
      ensureProjectDir(cwd);
      const writer = openCommittedWalFixture(paths.dbPath);
      const snapshotRoot = makeDir(`compact-preview-cross-attempt-${role.toLowerCase()}-snapshots`);
      chmodSync(snapshotRoot, 0o700);
      const attempts: number[] = [];
      try {
        expect(() => captureExistingLcmSnapshot(paths.dbPath, {
          _snapshotForTesting: {
            tempRoot: snapshotRoot,
            beforeAttempt: ({ attempt }) => {
              attempts.push(attempt);
              if (attempt !== 2) return;
              const path = role === "main" ? paths.dbPath : `${paths.dbPath}-wal`;
              renameSync(path, `${path}.old`);
              copyFileSync(`${path}.old`, path);
            },
            afterCopy: ({ attempt }) => {
              if (attempt === 1) writer.exec("INSERT INTO wal_preview_probe(value) VALUES ('drift')");
            },
          },
        })).toThrow(SQLITE_PREVIEW_SNAPSHOT_ERROR);
        expect(attempts).toEqual([1, 2]);
        expect(previewSnapshotDirectories(snapshotRoot)).toEqual([]);
      } finally {
        writer.close();
      }
    },
  );

  it("refuses a rollback-mode database with a journal and removes the private attempt", () => {
    const parent = makeDir("compact-rollback-journal");
    chmodSync(parent, 0o700);
    const dbPath = join(parent, "db.sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE rollback_probe(value TEXT)");
    db.close();
    writeFileSync(`${dbPath}-journal`, "potentially-hot", { mode: 0o600 });
    const snapshotRoot = makeDir("compact-rollback-journal-snapshots");
    chmodSync(snapshotRoot, 0o700);
    const before = sqliteSourceFiles(dbPath);

    expect(() => captureExistingLcmSnapshot(dbPath, {
      _snapshotForTesting: { tempRoot: snapshotRoot },
    })).toThrow(SQLITE_PREVIEW_SNAPSHOT_ERROR);
    expect(sqliteSourceFiles(dbPath)).toEqual(before);
    expect(previewSnapshotDirectories(snapshotRoot)).toEqual([]);
  });

  it("refuses WAL disappearance without a changed main generation", () => {
    const sourceCwd = makeDir("compact-stale-wal-disappearance-source");
    const sourcePaths = projectPaths(sourceCwd);
    ensureProjectDir(sourceCwd);
    const writer = openCommittedWalFixture(sourcePaths.dbPath);
    const retainedParent = makeDir("compact-stale-wal-disappearance");
    chmodSync(retainedParent, 0o700);
    const retainedPath = join(retainedParent, "db.sqlite");
    copyCrashWalFixture(sourcePaths.dbPath, retainedPath);
    writer.close();
    const snapshotRoot = makeDir("compact-stale-wal-disappearance-snapshots");
    chmodSync(snapshotRoot, 0o700);
    const attempts: number[] = [];

    expect(() => captureExistingLcmSnapshot(retainedPath, {
      _snapshotForTesting: {
        tempRoot: snapshotRoot,
        afterCopy: ({ attempt, walPath }) => {
          attempts.push(attempt);
          if (attempt === 1) rmSync(walPath);
        },
      },
    })).toThrow(SQLITE_PREVIEW_SNAPSHOT_ERROR);
    expect(attempts).toEqual([1]);
    expect(previewSnapshotDirectories(snapshotRoot)).toEqual([]);
  });

  it("cleans the private attempt when opening the copied database fails", () => {
    const cwd = makeDir("compact-preview-open-failure");
    const paths = projectPaths(cwd);
    ensureProjectDir(cwd);
    seedConversation(paths.dbPath);
    const snapshotRoot = makeDir("compact-preview-open-failure-snapshots");
    chmodSync(snapshotRoot, 0o700);
    const canary = new Error("injected private preview open failure");

    expect(() => captureExistingLcmSnapshot(paths.dbPath, {
      _snapshotForTesting: {
        tempRoot: snapshotRoot,
        openDatabase: () => { throw canary; },
      },
    })).toThrow(SQLITE_PREVIEW_SNAPSHOT_ERROR);
    expect(previewSnapshotDirectories(snapshotRoot)).toEqual([]);
  });

  it("retains a close failure after closing SQLite and cleaning the private attempt", () => {
    const cwd = makeDir("compact-preview-close-failure");
    const paths = projectPaths(cwd);
    ensureProjectDir(cwd);
    seedConversation(paths.dbPath);
    const snapshotRoot = makeDir("compact-preview-close-failure-snapshots");
    chmodSync(snapshotRoot, 0o700);
    const canary = new Error("injected private preview close failure");
    const snapshot = captureExistingLcmSnapshot(paths.dbPath, {
      _snapshotForTesting: {
        tempRoot: snapshotRoot,
        closeDatabase: (database) => {
          database.close();
          throw canary;
        },
      },
    });
    expect(snapshot).not.toBeNull();
    if (snapshot === null) throw new Error("close-failure snapshot was not opened");

    expect(() => snapshot.close()).toThrow(canary);
    expect(snapshot.db.isOpen).toBe(false);
    expect(previewSnapshotDirectories(snapshotRoot)).toEqual([]);
  });

  it("reports both close and authenticated cleanup failure without deleting an unexpected entry", () => {
    const cwd = makeDir("compact-preview-combined-cleanup-failure");
    const paths = projectPaths(cwd);
    ensureProjectDir(cwd);
    seedConversation(paths.dbPath);
    const snapshotRoot = makeDir("compact-preview-combined-cleanup-failure-snapshots");
    chmodSync(snapshotRoot, 0o700);
    let snapshotPath = "";
    const snapshot = captureExistingLcmSnapshot(paths.dbPath, {
      _snapshotForTesting: {
        tempRoot: snapshotRoot,
        afterCopy: (input) => { snapshotPath = input.snapshotPath; },
        closeDatabase: (database) => {
          database.close();
          throw new Error("injected close failure");
        },
      },
    });
    expect(snapshot).not.toBeNull();
    if (snapshot === null) throw new Error("combined-failure snapshot was not opened");
    const unexpected = join(dirname(snapshotPath), "unexpected-directory");
    mkdirSync(unexpected, { mode: 0o700 });

    try {
      expect(() => snapshot.close()).toThrow(AggregateError);
      expect(existsSync(unexpected)).toBe(true);
    } finally {
      rmSync(dirname(snapshotPath), { recursive: true, force: true });
    }
  });

  it.each([
    "copy short read",
    "copy extra byte",
    "revalidation short read",
    "revalidation extra byte",
    "copy zero write",
  ] as const)("fails closed and cleans after an injected %s", (fault) => {
    const cwd = makeDir(`compact-preview-${fault.replaceAll(" ", "-")}`);
    const paths = projectPaths(cwd);
    ensureProjectDir(cwd);
    seedConversation(paths.dbPath);
    const snapshotRoot = makeDir(`compact-preview-${fault.replaceAll(" ", "-")}-snapshots`);
    chmodSync(snapshotRoot, 0o700);
    let afterCopy = false;
    let injected = false;
    let sawBulkRead = false;
    const originalRead = mutableFs.readSync as (...args: unknown[]) => number;
    const originalWrite = mutableFs.writeSync as (...args: unknown[]) => number;
    const readReplacement = (...args: unknown[]): number => {
      const length = Number(args[3]);
      if (length > 20) sawBulkRead = true;
      const copyPhase = !afterCopy;
      const targetPhase = fault.startsWith("copy") ? copyPhase : afterCopy;
      if (targetPhase && fault.endsWith("short read") && length > 20) {
        injected = true;
        return 0;
      }
      if (targetPhase && fault.endsWith("extra byte") && sawBulkRead && length === 1) {
        injected = true;
        return 1;
      }
      return Reflect.apply(originalRead, mutableFs, args);
    };
    const writeReplacement = (...args: unknown[]): number => {
      if (!injected) {
        injected = true;
        return 0;
      }
      return Reflect.apply(originalWrite, mutableFs, args);
    };
    expect(() => captureExistingLcmSnapshot(paths.dbPath, {
      _snapshotForTesting: {
        tempRoot: snapshotRoot,
        ...(fault === "copy zero write"
          ? { write: writeReplacement as never }
          : { read: readReplacement as never }),
        afterCopy: () => { afterCopy = true; },
      },
    })).toThrow(SQLITE_PREVIEW_SNAPSHOT_ERROR);
    expect(injected).toBe(true);
    expect(previewSnapshotDirectories(snapshotRoot)).toEqual([]);
  });

  it.each([
    "source path identity",
    "copied leaf identity",
    "source path read error",
  ] as const)("fails closed and cleans after an injected %s failure", (fault) => {
    const cwd = makeDir(`compact-preview-${fault.replaceAll(" ", "-")}`);
    const paths = projectPaths(cwd);
    ensureProjectDir(cwd);
    seedConversation(paths.dbPath);
    const snapshotRoot = makeDir(`compact-preview-${fault.replaceAll(" ", "-")}-snapshots`);
    chmodSync(snapshotRoot, 0o700);
    const originalLstat = mutableFs.lstatSync as (...args: unknown[]) => ReturnType<typeof statSync>;
    let afterCopy = false;
    let injected = false;
    const replacement = (...args: unknown[]): ReturnType<typeof statSync> => {
      const path = String(args[0]);
      if (!injected && fault === "source path identity" && path === paths.dbPath) {
        injected = true;
        const stat = Reflect.apply(originalLstat, mutableFs, args);
        return new Proxy(stat, { get: (target, property, receiver) =>
          property === "ino" ? BigInt(target.ino) + 1n : Reflect.get(target, property, receiver) });
      }
      if (!injected && fault === "copied leaf identity"
        && path.startsWith("/proc/self/fd/") && path.endsWith("/main.sqlite")) {
        injected = true;
        const stat = Reflect.apply(originalLstat, mutableFs, args);
        return new Proxy(stat, { get: (target, property, receiver) =>
          property === "isFile" ? () => false : Reflect.get(target, property, receiver) });
      }
      if (!injected && afterCopy && fault === "source path read error" && path === paths.dbPath) {
        injected = true;
        throw Object.assign(new Error("injected lstat failure"), { code: "EACCES" });
      }
      return Reflect.apply(originalLstat, mutableFs, args);
    };

    withBuiltinFsOverride("lstatSync", replacement, () => {
      expect(() => captureExistingLcmSnapshot(paths.dbPath, {
        _snapshotForTesting: {
          tempRoot: snapshotRoot,
          afterCopy: () => { afterCopy = true; },
        },
      })).toThrow(SQLITE_PREVIEW_SNAPSHOT_ERROR);
    });
    expect(injected).toBe(true);
    expect(previewSnapshotDirectories(snapshotRoot)).toEqual([]);
  });

  it("removes a newly-created temp directory when private admission fails", () => {
    const cwd = makeDir("compact-preview-temp-admission-failure");
    const paths = projectPaths(cwd);
    ensureProjectDir(cwd);
    seedConversation(paths.dbPath);
    const snapshotRoot = makeDir("compact-preview-temp-admission-failure-snapshots");
    chmodSync(snapshotRoot, 0o700);
    const originalOpen = mutableFs.openSync as (...args: unknown[]) => number;
    let injected = false;
    const replacement = (...args: unknown[]): number => {
      if (!injected && String(args[0]).includes("lcm-sqlite-preview-")) {
        injected = true;
        throw Object.assign(new Error("injected temp admission failure"), { code: "EACCES" });
      }
      return Reflect.apply(originalOpen, mutableFs, args);
    };

    withBuiltinFsOverride("openSync", replacement, () => {
      expect(() => captureExistingLcmSnapshot(paths.dbPath, {
        _snapshotForTesting: { tempRoot: snapshotRoot },
      })).toThrow(SQLITE_PREVIEW_SNAPSHOT_ERROR);
    });
    expect(injected).toBe(true);
    expect(previewSnapshotDirectories(snapshotRoot)).toEqual([]);
  });

  it("removes a newly-created temp directory when permission tightening fails", () => {
    const cwd = makeDir("compact-preview-temp-chmod-failure");
    const paths = projectPaths(cwd);
    ensureProjectDir(cwd);
    seedConversation(paths.dbPath);
    const snapshotRoot = makeDir("compact-preview-temp-chmod-failure-snapshots");
    chmodSync(snapshotRoot, 0o700);
    const originalChmod = mutableFs.chmodSync as (...args: unknown[]) => void;
    const primary = new Error("injected preview chmod failure");
    let injected = false;
    const replacement = (...args: unknown[]): void => {
      if (!injected && String(args[0]).includes("lcm-sqlite-preview-")) {
        injected = true;
        throw primary;
      }
      Reflect.apply(originalChmod, mutableFs, args);
    };

    withBuiltinFsOverride("chmodSync", replacement, () => {
      expect(() => captureExistingLcmSnapshot(paths.dbPath, {
        _snapshotForTesting: { tempRoot: snapshotRoot },
      })).toThrow(SQLITE_PREVIEW_SNAPSHOT_ERROR);
    });
    expect(injected).toBe(true);
    expect(previewSnapshotDirectories(snapshotRoot)).toEqual([]);
  });

  it("preserves chmod and removal failures when private temp initialization cannot be cleaned", () => {
    const cwd = makeDir("compact-preview-temp-chmod-cleanup-failure");
    const paths = projectPaths(cwd);
    ensureProjectDir(cwd);
    seedConversation(paths.dbPath);
    const snapshotRoot = makeDir("compact-preview-temp-chmod-cleanup-failure-snapshots");
    chmodSync(snapshotRoot, 0o700);
    const originalChmod = mutableFs.chmodSync as (...args: unknown[]) => void;
    const originalRmdir = mutableFs.rmdirSync as (...args: unknown[]) => void;
    const primary = new Error("injected preview chmod failure");
    const cleanup = new Error("injected preview removal failure");
    let chmodInjected = false;
    let cleanupInjected = false;
    const chmodReplacement = (...args: unknown[]): void => {
      if (!chmodInjected && String(args[0]).includes("lcm-sqlite-preview-")) {
        chmodInjected = true;
        throw primary;
      }
      Reflect.apply(originalChmod, mutableFs, args);
    };
    const rmdirReplacement = (...args: unknown[]): void => {
      if (!cleanupInjected && String(args[0]).includes("lcm-sqlite-preview-")) {
        cleanupInjected = true;
        throw cleanup;
      }
      Reflect.apply(originalRmdir, mutableFs, args);
    };
    let thrown: unknown;

    try {
      withBuiltinFsOverride("chmodSync", chmodReplacement, () =>
        withBuiltinFsOverride("rmdirSync", rmdirReplacement, () => {
          try {
            captureExistingLcmSnapshot(paths.dbPath, {
              _snapshotForTesting: { tempRoot: snapshotRoot },
            });
          } catch (error) {
            thrown = error;
          }
        }));
      expect(thrown).toMatchObject({
        message: SQLITE_PREVIEW_SNAPSHOT_ERROR,
        cause: expect.any(AggregateError),
      });
      expect((thrown as Error & { cause: AggregateError }).cause.errors).toEqual([primary, cleanup]);
      expect(chmodInjected).toBe(true);
      expect(cleanupInjected).toBe(true);
      expect(previewSnapshotDirectories(snapshotRoot)).toHaveLength(1);
    } finally {
      for (const leaf of previewSnapshotDirectories(snapshotRoot)) {
        rmSync(join(snapshotRoot, leaf), { recursive: true, force: true });
      }
    }
  });

  it.each(["source", "parent"] as const)(
    "cleans the private copy when retained %s descriptor close reports failure",
    (role) => {
      const cwd = makeDir(`compact-preview-${role}-close-failure`);
      const paths = projectPaths(cwd);
      ensureProjectDir(cwd);
      seedConversation(paths.dbPath);
      const snapshotRoot = makeDir(`compact-preview-${role}-close-failure-snapshots`);
      chmodSync(snapshotRoot, 0o700);
      const target = statSync(role === "source" ? paths.dbPath : dirname(paths.dbPath), { bigint: true });
      const originalClose = mutableFs.closeSync as (...args: unknown[]) => void;
      const actualFs = createRequire(import.meta.url)("node:fs") as typeof import("node:fs");
      let armed = false;
      let injected = false;
      const replacement = (...args: unknown[]): void => {
        const fd = Number(args[0]);
        if (!injected && armed) {
          const stat = actualFs.fstatSync(fd, { bigint: true });
          if (stat.dev === target.dev && stat.ino === target.ino) {
            injected = true;
            Reflect.apply(originalClose, mutableFs, args);
            throw new Error(`injected ${role} close failure`);
          }
        }
        Reflect.apply(originalClose, mutableFs, args);
      };

      withBuiltinFsOverride("closeSync", replacement, () => {
        expect(() => captureExistingLcmSnapshot(paths.dbPath, {
          _snapshotForTesting: {
            tempRoot: snapshotRoot,
            afterCopy: () => { armed = true; },
          },
        })).toThrow(SQLITE_PREVIEW_SNAPSHOT_ERROR);
      });
      expect(injected).toBe(true);
      expect(previewSnapshotDirectories(snapshotRoot)).toEqual([]);
    },
  );

  it("attaches a native transcript source locator during direct non-preview discovery", async () => {
    const cwd = makeDir("compact-native-source-locator");
    const paths = projectPaths(cwd);
    ensureProjectDir(cwd);
    seedConversation(paths.dbPath);
    const db = new DatabaseSync(paths.dbPath);
    const nativePayload = '{"message":"scrubbed"}';
    const contentSha256 = createHash("sha256").update(nativePayload).digest("hex");
    db.prepare(
      "INSERT INTO runtime_native_transcripts VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
      "native-source-locator-transcript",
      paths.id,
      "local",
      "codex",
      "jsonl",
      "1",
      "session-1",
      "sessions/native-source.jsonl",
      1,
      "2026-09-16 00:00:00",
      "2026-09-16 00:00:01",
      "1",
      contentSha256,
      "1".repeat(64),
      nativePayload,
    );
    db.close();

    expect(await findUncompacted(100, false, cwd)).toEqual([
      expect.objectContaining({ sessionId: "session-1", sourceLocator: "sessions/native-source.jsonl" }),
    ]);
  });

  it("omits the source locator during preview discovery when the transcript query fails", async () => {
    const cwd = makeDir("compact-native-source-locator-query-failure");
    const paths = projectPaths(cwd);
    ensureProjectDir(cwd);
    seedConversation(paths.dbPath);
    const db = new DatabaseSync(paths.dbPath);
    db.exec("DROP TABLE runtime_native_transcripts");
    db.close();

    expect(await findUncompacted(100, true, cwd)).toEqual([
      expect.objectContaining({ sessionId: "session-1" }),
    ]);
    const [candidate] = await findUncompacted(100, true, cwd);
    expect(candidate).not.toHaveProperty("sourceLocator");
  });

  it("omits the source locator during direct discovery when storage exposes no native transcripts", async () => {
    const cwd = makeDir("compact-storage-without-native-transcripts");
    const paths = projectPaths(cwd);
    ensureProjectDir(cwd);
    seedConversation(paths.dbPath);

    const realWithCliProjectStorage = cliStorage.withCliProjectStorage;
    vi.spyOn(cliStorage, "withCliProjectStorage").mockImplementationOnce((targetCwd, options, callback) =>
      realWithCliProjectStorage(targetCwd, options, context =>
        callback({ ...context, storage: { ...context.storage, nativeTranscripts: undefined } })));

    const [candidate] = await findUncompacted(100, false, cwd);
    expect(candidate).toMatchObject({ sessionId: "session-1", messages: 9, tokens: 250 });
    expect(candidate).not.toHaveProperty("sourceLocator");
  });

  it("carries a native transcript source locator through active-session and failure progress payloads", async () => {
    const cwd = makeDir("compact-source-locator-failure-progress");
    const paths = projectPaths(cwd);
    ensureProjectDir(cwd);
    seedConversation(paths.dbPath);
    const db = new DatabaseSync(paths.dbPath);
    const nativePayload = '{"message":"scrubbed"}';
    const contentSha256 = createHash("sha256").update(nativePayload).digest("hex");
    db.prepare(
      "INSERT INTO runtime_native_transcripts VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
      "native-source-locator-failure-transcript",
      paths.id,
      "local",
      "codex",
      "jsonl",
      "1",
      "session-1",
      "sessions/native-source-failure.jsonl",
      1,
      "2026-09-16 00:00:00",
      "2026-09-16 00:00:01",
      "1",
      contentSha256,
      "3".repeat(64),
      nativePayload,
    );
    db.close();

    vi.spyOn(DaemonClient.prototype, "post").mockRejectedValue(new Error("compact failed"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const progress: Array<Partial<ProgressState>> = [];
    const events: CompactProgressEvent[] = [];
    expect(await batchCompact({
      minTokens: 100,
      dryRun: false,
      port: 3737,
      cwd,
      onProgress: patch => progress.push(patch),
      onEvent: event => events.push(event),
    })).toMatchObject({ failures: 1 });

    expect(events).toContainEqual(expect.objectContaining({
      type: "session-start",
      identity: expect.objectContaining({ sourceLocator: "sessions/native-source-failure.jsonl" }),
    }));
    const failurePatch = progress.find(patch => Array.isArray(patch.errors) && patch.errors.length > 0);
    expect(failurePatch?.errors).toContainEqual(expect.objectContaining({
      sessionId: "session-1",
      sourceLocator: "sessions/native-source-failure.jsonl",
    }));
  });

  it("counts paginated messages and keeps descending token priority", async () => {
    const cwd = makeDir("compact-message-pages");
    const paths = projectPaths(cwd);
    ensureProjectDir(cwd);
    seedConversation(paths.dbPath);
    const db = new DatabaseSync(paths.dbPath);
    db.prepare("INSERT INTO conversations (conversation_id, session_id) VALUES (?, ?)").run(2, "large");
    insertMessages(db, 2, 501, 5010);
    db.close();
    expect(await findUncompacted(100, true, cwd)).toEqual([
      expect.objectContaining({ sessionId: "large", messages: 501, tokens: 5010 }),
      expect.objectContaining({ sessionId: "session-1", messages: 9, tokens: 250 }),
    ]);
  });

  it("rejects symlinked databases during preview without reading the target", async () => {
    const cwd = makeDir("compact-symlink-db");
    const paths = projectPaths(cwd);
    ensureProjectDir(cwd);
    const target = join(homedir(), "external.sqlite");
    seedConversation(target);
    symlinkSync(target, paths.dbPath);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await batchCompact({ minTokens: 100, dryRun: true, port: 3737, cwd })).toMatchObject({ failures: 1 });
    expect(getPoolStats().totalConnections).toBe(0);
  });

  it("keeps progress on stderr and hides raw transport errors", async () => {
    const cwd = makeDir("compact-private-output");
    const paths = projectPaths(cwd);
    ensureProjectDir(cwd);
    seedConversation(paths.dbPath);
    const canary = "postgresql://private-user:private-password@private-host/private-db SELECT secret";
    vi.spyOn(DaemonClient.prototype, "post").mockRejectedValue(new Error(canary));
    const stdout = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const progress: Array<Partial<ProgressState>> = [];
    expect(await batchCompact({ minTokens: 100, dryRun: false, port: 3737, cwd,
      onProgress: patch => progress.push(patch),
    })).toMatchObject({ failures: 1 });
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr.mock.calls.flat().join(" ")).not.toContain(cwd);
    expect(JSON.stringify([stderr.mock.calls, progress])).not.toContain(canary);
  });

  it("excludes empty conversations and conversations below the token threshold", async () => {
    const cwd = makeDir("compact-threshold");
    const paths = projectPaths(cwd);
    ensureProjectDir(cwd);
    seedConversation(paths.dbPath);
    const db = new DatabaseSync(paths.dbPath);
    db.prepare("INSERT INTO conversations (conversation_id, session_id) VALUES (?, ?)").run(2, "empty");
    db.close();
    expect(await findUncompacted(251, true, cwd)).toEqual([]);
  });

  it("rejects identities changed or removed after enumeration before opening SQLite", async () => {
    const cwd = makeDir("compact-rebound");
    const paths = projectPaths(cwd);
    ensureProjectDir(cwd);
    seedConversation(paths.dbPath);
    vi.spyOn(cliStorage, "listCliProjects").mockResolvedValue([
      { id: "0".repeat(64), canonical: cwd, aliases: [] },
      { id: "1".repeat(64), canonical: makeDir("compact-removed"), aliases: [] },
    ]);
    const output = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await batchCompact({ minTokens: 100, dryRun: true, port: 3737 })).toMatchObject({ failures: 2 });
    expect(output.mock.calls.flat().join(" ")).not.toContain(cwd);
    expect(getPoolStats().totalConnections).toBe(0);
  });

  it("rejects a changed backend selection before composing SQLite preview repositories", async () => {
    const cwd = makeDir("compact-selection-change");
    const paths = projectPaths(cwd);
    ensureProjectDir(cwd);
    seedConversation(paths.dbPath);
    vi.spyOn(cliStorage, "listCliProjects").mockResolvedValue([
      { id: paths.id, canonical: cwd, aliases: [] },
    ]);
    const config = daemonConfig.loadDaemonConfig(join(homedir(), ".lcm", "config.json"));
    vi.spyOn(daemonConfig, "loadDaemonConfig")
      .mockReturnValueOnce(config)
      .mockReturnValueOnce(config)
      .mockReturnValue({ ...config, storage: { ...config.storage, backend: "postgresql" } });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await batchCompact({ minTokens: 100, dryRun: true, port: 3737 })).toMatchObject({ failures: 1 });
    expect(getPoolStats().totalConnections).toBe(0);
  });

  it("matches current-project filters through project-map aliases", async () => {
    const canonical = makeDir("compact-canonical");
    const alias = makeDir("compact-alias");
    const paths = projectPaths(canonical);
    ensureProjectDir(canonical);
    writeFileSync(paths.metaPath, JSON.stringify({ cwd: paths.canonical }, null, 2) + "\n");
    seedConversation(paths.dbPath);
    addProjectAlias(alias, { canonical });
    const execSpy = vi.spyOn(DatabaseSync.prototype, "exec");

    const conversations = await findUncompacted(100, true, alias);

    expect(conversations).toHaveLength(1);
    expect(conversations[0].cwd).toBe(paths.canonical);
    expect(conversations[0].sessionId).toBe("session-1");
    expect(execSpy).not.toHaveBeenCalled();
    expect(getPoolStats().totalConnections).toBe(0);

    const victim = makeDir("compact-alias-victim");
    rmSync(alias, { recursive: true });
    symlinkSync(victim, alias, "dir");
    expect(await findUncompacted(100, true, alias)).toHaveLength(1);
    expect(await findUncompacted(100, true, victim)).toEqual([]);
  });

  it("does not match a current-project filter that is unrelated to the map entry", async () => {
    const canonical = makeDir("compact-unmatched");
    const unrelated = makeDir("compact-unrelated");
    const paths = projectPaths(canonical);
    ensureProjectDir(canonical);
    writeFileSync(paths.metaPath, JSON.stringify({ cwd: paths.canonical }, null, 2) + "\n");
    seedConversation(paths.dbPath);

    expect(await findUncompacted(100, true, unrelated)).toEqual([]);
  });

  it("discovers a linked Git worktree once using the shared canonical project", async () => {
    const canonical = makeDir("compact-git-main");
    const linked = join(homedir(), "compact-git-linked");
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: canonical });
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false",
      "commit", "--allow-empty", "--signoff", "-qm", "fixture"], { cwd: canonical });
    execFileSync("git", ["worktree", "add", "-q", "-b", "linked", linked], { cwd: canonical });
    const paths = projectPaths(canonical);
    ensureProjectDir(canonical);
    seedConversation(paths.dbPath);
    expect(projectPaths(linked).id).toBe(paths.id);
    expect(await findUncompacted(100, true, linked)).toEqual([
      expect.objectContaining({ cwd: canonical, projectDir: paths.dir, sessionId: "session-1" }),
    ]);
    expect(await findUncompacted(100, true)).toHaveLength(1);
  });

  it("requires at least one raw message outside the manual fresh tail", async () => {
    const protectedCwd = makeDir("compact-protected-tail");
    const protectedPaths = projectPaths(protectedCwd);
    ensureProjectDir(protectedCwd);
    writeFileSync(protectedPaths.metaPath, JSON.stringify({ cwd: protectedPaths.canonical }));
    seedConversation(protectedPaths.dbPath, 8);

    const eligibleCwd = makeDir("compact-outside-tail");
    const eligiblePaths = projectPaths(eligibleCwd);
    ensureProjectDir(eligibleCwd);
    writeFileSync(eligiblePaths.metaPath, JSON.stringify({ cwd: eligiblePaths.canonical }));
    seedConversation(eligiblePaths.dbPath, 9);

    expect(await findUncompacted(100, true, protectedCwd)).toEqual([]);
    expect(await findUncompacted(100, true, eligibleCwd)).toEqual([
      expect.objectContaining({ cwd: eligiblePaths.canonical, messages: 9 }),
    ]);
  });

  it("discovers authenticated legacy hash metadata through canonical symlinks", async () => {
    const canonical = makeDir("compact-legacy-canonical");
    const legacyLink = join(homedir(), "compact-legacy-link");
    symlinkSync(canonical, legacyLink, "dir");
    const projectDir = join(homedir(), ".lcm", "projects", "a".repeat(64));
    mkdirSync(projectDir, { recursive: true, mode: 0o700 });
    chmodSync(projectDir, 0o700);
    writeFileSync(join(projectDir, "meta.json"), JSON.stringify({ cwd: legacyLink }));
    seedConversation(join(projectDir, "db.sqlite"));

    expect(await findUncompacted(100, true, canonical)).toHaveLength(1);
  });

  it("returns failures while continuing to compact later sessions", async () => {
    const cwd = makeDir("compact-partial-failure");
    const paths = projectPaths(cwd);
    ensureProjectDir(cwd);
    writeFileSync(paths.metaPath, JSON.stringify({ cwd: paths.canonical }, null, 2) + "\n");
    seedConversations(paths.dbPath);
    const post = vi.spyOn(DaemonClient.prototype, "post")
      .mockRejectedValueOnce(new Error("provider unavailable"))
      .mockResolvedValueOnce({ tokensBefore: 250, tokensAfter: 50 });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const progress: Array<Partial<ProgressState>> = [];

    const result = await batchCompact({
      minTokens: 100,
      dryRun: false,
      port: 3737,
      cwd,
      onProgress: patch => progress.push(patch),
    });

    expect(result).toEqual({ compacted: 1, unchanged: 0, skipped: 0, failures: 1, compactedProjects: [paths.canonical] });
    expect(post).toHaveBeenCalledTimes(2);
    expect(progress.find(patch => patch.errors)).toMatchObject({ completed: 0, current: undefined });
    expect(progress.at(-1)).toMatchObject({ completed: 1, current: undefined });
  });

  it("keeps two failed compact items single-owned across event and progress updates", async () => {
    const cwd = makeDir("compact-error-snapshot-ownership");
    const paths = projectPaths(cwd);
    ensureProjectDir(cwd);
    seedConversations(paths.dbPath);
    vi.spyOn(DaemonClient.prototype, "post")
      .mockRejectedValueOnce(new Error("first failure"))
      .mockResolvedValueOnce({});
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const state = makeProgressState({
      phases: [{ name: "Compact", status: "active" }],
      total: 2,
    });
    const output: string[] = [];
    const errorSnapshots: string[][] = [];
    const renderer = new NinjaRenderer({
      state,
      renderOpts: { isTTY: false, width: 120, color: false, verbose: true },
      output: {
        columns: 120,
        write: (chunk: string | Uint8Array) => {
          output.push(String(chunk));
          return true;
        },
      },
      handleSignals: false,
    });

    const result = await batchCompact({
      minTokens: 100,
      dryRun: false,
      port: 3737,
      cwd,
      maxConcurrency: 1,
      onEvent: event => renderer.handleEvent(event),
      onProgress: patch => {
        if (patch.errors !== undefined) {
          errorSnapshots.push(patch.errors.map(error => error.sessionId));
        }
        Object.assign(state, patch);
      },
    });

    expect(result.failures).toBe(2);
    expect(state.errors).toEqual([
      expect.objectContaining({ sessionId: "session-1", message: "compaction request failed" }),
      expect.objectContaining({ sessionId: "session-2", message: "malformed compact response" }),
    ]);
    expect(errorSnapshots).toEqual([
      ["session-1"],
      ["session-1", "session-2"],
    ]);
    output.length = 0;
    renderer.printSummary();
    const summary = output.join("");
    expect(summary.match(/session-1/gu)).toHaveLength(1);
    expect(summary.match(/session-2/gu)).toHaveLength(1);
    expect(summary).toMatch(/Failed\s+2/u);
    expect(summary).toMatch(/Failure total\s+2/u);
  });

  it("retains SQLite scan failures while compacting readable projects", async () => {
    const healthyCwd = makeDir("compact-readable-project");
    const healthyPaths = projectPaths(healthyCwd);
    ensureProjectDir(healthyCwd);
    writeFileSync(healthyPaths.metaPath, JSON.stringify({ cwd: healthyPaths.canonical }));
    seedConversation(healthyPaths.dbPath);

    const corruptCwd = makeDir("compact-unreadable-project");
    const corruptProjectDir = projectPaths(corruptCwd).dir;
    ensureProjectDir(corruptCwd);
    writeFileSync(join(corruptProjectDir, "meta.json"), JSON.stringify({ cwd: corruptCwd }));
    writeFileSync(join(corruptProjectDir, "db.sqlite"), "not sqlite");

    const post = vi.spyOn(DaemonClient.prototype, "post")
      .mockResolvedValue({ tokensBefore: 250, tokensAfter: 50 });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const progress: Array<Partial<ProgressState>> = [];

    const result = await batchCompact({
      minTokens: 100,
      dryRun: false,
      port: 3737,
      onProgress: patch => progress.push(patch),
    });

    expect(result).toEqual({
      compacted: 1,
      unchanged: 0,
      skipped: 0,
      failures: 1,
      compactedProjects: [healthyPaths.canonical],
    });
    expect(post).toHaveBeenCalledOnce();
    expect(progress[0]).toEqual({
      total: 1,
      phaseErrors: [{
        phase: "Compact",
        target: corruptCwd,
        message: "project storage discovery failed",
      }],
    });
    expect(progress.at(-1)).toMatchObject({ completed: 1 });
    expect(error.mock.calls.flat().join(" ")).not.toContain(corruptCwd);
    expect(log).not.toHaveBeenCalledWith("Nothing to compact — no sessions are currently eligible.");
  });

  it("fails an all-unreadable scan without claiming there is nothing to compact", async () => {
    const corruptCwd = makeDir("compact-only-unreadable-project");
    const corruptProjectDir = projectPaths(corruptCwd).dir;
    ensureProjectDir(corruptCwd);
    writeFileSync(join(corruptProjectDir, "meta.json"), JSON.stringify({ cwd: corruptCwd }));
    writeFileSync(join(corruptProjectDir, "db.sqlite"), "not sqlite");

    const post = vi.spyOn(DaemonClient.prototype, "post");
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const progress: Array<Partial<ProgressState>> = [];

    expect(await batchCompact({
      minTokens: 100,
      dryRun: false,
      port: 3737,
      onProgress: patch => progress.push(patch),
    })).toEqual({
      compacted: 0,
      unchanged: 0,
      skipped: 0,
      failures: 1,
      compactedProjects: [],
    });
    expect(post).not.toHaveBeenCalled();
    expect(progress).toEqual([{
      total: 0,
      phaseErrors: [{
        phase: "Compact",
        target: corruptCwd,
        message: "project storage discovery failed",
      }],
    }]);
    expect(log).not.toHaveBeenCalledWith("Nothing to compact — no sessions are currently eligible.");
    expect(error).toHaveBeenCalledWith("No sessions were compacted because project discovery failed.");
  });

  it("ignores directories without authenticated project bindings", async () => {
    const projectsDir = join(homedir(), ".lcm", "projects");
    for (const [index, metadata] of [undefined, "{", "{}"].entries()) {
      const projectDir = join(projectsDir, String(index).repeat(64));
      mkdirSync(projectDir, { recursive: true, mode: 0o700 });
      seedConversation(join(projectDir, "db.sqlite"));
      if (metadata !== undefined) writeFileSync(join(projectDir, "meta.json"), metadata);
    }
    const post = vi.spyOn(DaemonClient.prototype, "post");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await batchCompact({ minTokens: 100, dryRun: true, port: 3737 })).toEqual({
      compacted: 0, unchanged: 0, skipped: 0, failures: 0, compactedProjects: [],
    });
    expect(post).not.toHaveBeenCalled();
  });

  it("uses authenticated bindings and ignores unsafe metadata leaves during discovery", async () => {
    const projectsDir = join(homedir(), ".lcm", "projects");
    const addProject = (name: string, cwd: string, metadata: string, validDb = false): string => {
      const projectDir = join(projectsDir, name);
      mkdirSync(projectDir, { recursive: true });
      const metaPath = join(projectDir, "meta.json");
      writeFileSync(metaPath, metadata);
      if (validDb) seedConversation(join(projectDir, "db.sqlite"));
      else writeFileSync(join(projectDir, "db.sqlite"), "must not be opened");
      return metaPath;
    };

    const trustedCwd = makeDir("compact-trusted-metadata");
    ensureProjectDir(trustedCwd);
    const trustedPaths = projectPaths(trustedCwd);
    seedConversation(trustedPaths.dbPath);
    const exactCwd = makeDir("compact-exact-metadata");
    const exactMetadata = sizedProjectMetadata(exactCwd, MAX_PROJECT_METADATA_BYTES);
    expect(Buffer.byteLength(exactMetadata, "utf8")).toBe(MAX_PROJECT_METADATA_BYTES);
    ensureProjectDir(exactCwd);
    const exactPaths = projectPaths(exactCwd);
    writeFileSync(exactPaths.metaPath, exactMetadata);
    seedConversation(exactPaths.dbPath);

    const hardlinkCwd = "/hardlink-compact-canary";
    const hardlinkMeta = addProject("hardlink-metadata", hardlinkCwd, JSON.stringify({ cwd: hardlinkCwd }));
    linkSync(hardlinkMeta, join(tempHome!, "hardlink-meta-alias.json"));

    const symlinkCwd = "/symlink-compact-canary";
    const symlinkProject = join(projectsDir, "symlink-metadata");
    mkdirSync(symlinkProject);
    writeFileSync(join(symlinkProject, "db.sqlite"), "must not be opened");
    const symlinkTarget = join(tempHome!, "symlink-meta-target.json");
    writeFileSync(symlinkTarget, JSON.stringify({ cwd: symlinkCwd }));
    symlinkSync(symlinkTarget, join(symlinkProject, "meta.json"));

    const oversizedCwd = "/oversized-compact-canary";
    const oversizedMetadata = sizedProjectMetadata(oversizedCwd, MAX_PROJECT_METADATA_BYTES + 1);
    expect(Buffer.byteLength(oversizedMetadata, "utf8")).toBe(MAX_PROJECT_METADATA_BYTES + 1);
    addProject("oversized-metadata", oversizedCwd, oversizedMetadata);

    const directoryProject = join(projectsDir, "directory-metadata");
    mkdirSync(join(directoryProject, "meta.json"), { recursive: true });
    writeFileSync(join(directoryProject, "db.sqlite"), "must not be opened");

    expect((await findUncompacted(100, true)).map(conversation => conversation.cwd).sort())
      .toEqual([exactCwd, trustedCwd].sort());

    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const progress: Array<Partial<ProgressState>> = [];
    const result = await batchCompact({
      minTokens: 100,
      dryRun: true,
      port: 3737,
      onProgress: patch => progress.push(patch),
    });

    // The selected-storage path never reads metadata for discovery. Unbound
    // unsafe leaves neither become targets nor generate metadata diagnostics.
    expect(result).toMatchObject({ failures: 0 });
    expect(progress.some(patch => (patch.phaseErrors?.length ?? 0) > 0)).toBe(false);
    expect(JSON.stringify(progress)).not.toMatch(/compact-canary/u);
  });

  it("uses the cwd binding without reading unsafe discovery metadata", async () => {
    const cwd = makeDir("compact-filtered-unsafe-metadata");
    const paths = projectPaths(cwd);
    ensureProjectDir(cwd);
    writeFileSync(paths.metaPath, JSON.stringify({ cwd: paths.canonical }));
    seedConversation(paths.dbPath);
    linkSync(paths.metaPath, join(tempHome!, "filtered-meta-alias.json"));
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const progress: Array<Partial<ProgressState>> = [];

    expect(await batchCompact({
      minTokens: 100,
      dryRun: true,
      port: 3737,
      cwd,
      onProgress: patch => progress.push(patch),
    })).toMatchObject({ failures: 0 });
    expect(progress.some(patch => (patch.phaseErrors?.length ?? 0) > 0)).toBe(false);
    expect(await findUncompacted(100, true, cwd)).toEqual([expect.objectContaining({ cwd: paths.canonical })]);
  });

  it("ignores unbound FIFO metadata without blocking compaction discovery", async () => {
    const projectDir = join(homedir(), ".lcm", "projects", "fifo-metadata");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "db.sqlite"), "must not be opened");
    const metaPath = join(projectDir, "meta.json");
    execFileSync("mkfifo", ["-m", "600", metaPath]);
    const writer = spawn(process.execPath, ["-e", `
      setTimeout(() => {
        const fs = require("node:fs");
        try {
          const fd = fs.openSync(process.argv[1], fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
          fs.writeSync(fd, JSON.stringify({ cwd: "/fifo-compact-canary" }));
          fs.closeSync(fd);
        } catch {}
      }, 1500);
    `, metaPath], { stdio: "ignore", env: {} });
    const exited = once(writer, "exit");
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const progress: Array<Partial<ProgressState>> = [];

    try {
      const started = performance.now();
      const result = await batchCompact({
        minTokens: 100,
        dryRun: true,
        port: 3737,
        onProgress: patch => progress.push(patch),
      });
      expect(performance.now() - started).toBeLessThan(1000);
      expect(result).toMatchObject({ failures: 0 });
      expect(progress.some(patch => (patch.phaseErrors?.length ?? 0) > 0)).toBe(false);
    } finally {
      writer.kill("SIGKILL");
      await exited;
    }
  });

  it("does not consult metadata ownership during authenticated discovery", async () => {
    const cwd = makeDir("compact-uid-metadata");
    const paths = projectPaths(cwd);
    ensureProjectDir(cwd);
    writeFileSync(paths.metaPath, JSON.stringify({ cwd: paths.canonical }));
    seedConversation(paths.dbPath);

    try {
      vi.resetModules();
      vi.doMock("node:fs", async (importOriginal) => {
        const actual = await importOriginal<typeof import("node:fs")>();
        const metadataIdentity = actual.statSync(paths.metaPath);
        const isMetadataIdentity = (stat: { dev: bigint | number; ino: bigint | number }): boolean =>
          String(stat.dev) === String(metadataIdentity.dev)
          && String(stat.ino) === String(metadataIdentity.ino);
        const withForeignUid = <T extends { uid: bigint | number }>(stat: T): T => new Proxy(stat, {
          get(target, property, receiver) {
            if (property === "uid") {
              return typeof target.uid === "bigint"
                ? target.uid + 1n
                : target.uid + 1;
            }
            return Reflect.get(target, property, receiver);
          },
        });
        return {
          ...actual,
          fstatSync: (fd: number, options?: unknown) => {
            const stat = actual.fstatSync(fd, options as never);
            return isMetadataIdentity(stat) ? withForeignUid(stat) : stat;
          },
          statSync: (path: Parameters<typeof actual.statSync>[0], options?: unknown) => {
            const stat = actual.statSync(path, options as never);
            return path === paths.metaPath && isMetadataIdentity(stat) ? withForeignUid(stat) : stat;
          },
        };
      });
      const isolated = await import("../src/batch-compact.js");
      expect(await isolated.findUncompacted(100, true)).toEqual([expect.objectContaining({ cwd: paths.canonical })]);

      vi.doUnmock("node:fs");
      vi.resetModules();
      const descriptor = Object.getOwnPropertyDescriptor(process, "getuid");
      Object.defineProperty(process, "getuid", { value: undefined, configurable: true });
      try {
        expect(await findUncompacted(100, true)).toEqual([]);
      } finally {
        if (descriptor) Object.defineProperty(process, "getuid", descriptor);
        else delete (process as { getuid?: unknown }).getuid;
      }
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });

  it("deduplicates canonical and alias bindings during all-project discovery", async () => {
    const cwd = makeDir("compact-dedup-canonical");
    const alias = makeDir("compact-dedup-alias");
    const paths = projectPaths(cwd);
    ensureProjectDir(cwd);
    seedConversation(paths.dbPath);
    addProjectAlias(alias, { canonical: cwd });
    const aliasHash = "a".repeat(64);
    const legacyDir = join(homedir(), ".lcm", "projects", aliasHash);
    mkdirSync(legacyDir, { mode: 0o700 });
    writeFileSync(join(legacyDir, "meta.json"), JSON.stringify({ cwd }));
    seedConversation(join(legacyDir, "db.sqlite"));
    expect(await findUncompacted(100, true)).toEqual([
      expect.objectContaining({ cwd, projectDir: paths.dir, sessionId: "session-1" }),
    ]);
  });

  it("fails closed when the project map is malformed instead of trusting metadata", async () => {
    const cwd = makeDir("compact-malformed-map");
    const paths = projectPaths(cwd);
    ensureProjectDir(cwd);
    seedConversation(paths.dbPath);
    writeFileSync(projectMapPath(), "{");
    clearProjectMapCache();
    const post = vi.spyOn(DaemonClient.prototype, "post");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const progress: Array<Partial<ProgressState>> = [];
    expect(await batchCompact({ minTokens: 100, dryRun: true, port: 3737, cwd,
      onProgress: patch => progress.push(patch),
    })).toEqual({ compacted: 0, unchanged: 0, skipped: 0, failures: 1, compactedProjects: [] });
    expect(progress).toEqual([{ total: 0, phaseErrors: [
      { phase: "Compact", target: cwd, message: "project discovery failed" },
    ] }]);
    expect(post).not.toHaveBeenCalled();
    expect(await batchCompact({ minTokens: 100, dryRun: true, port: 3737 })).toMatchObject({ failures: 1 });
  });

  it("counts each successful session once and falls back to discovered input tokens", async () => {
    const cwd = makeDir("compact-aggregate-totals");
    const paths = projectPaths(cwd);
    ensureProjectDir(cwd);
    writeFileSync(paths.metaPath, JSON.stringify({ cwd: paths.canonical }, null, 2) + "\n");
    seedConversations(paths.dbPath);
    const firstLabel = `${paths.canonical} conv #1 (9 msgs, 0.3k tokens)`;
    const secondLabel = `${paths.canonical} conv #2 (9 msgs, 0.3k tokens)`;
    const post = vi.spyOn(DaemonClient.prototype, "post")
      .mockResolvedValueOnce({ tokensBefore: 250, tokensAfter: 250 })
      .mockResolvedValueOnce({ tokensBefore: 300, tokensAfter: 30 });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const progress: Array<Record<string, unknown>> = [];

    const result = await batchCompact({
      minTokens: 100,
      dryRun: false,
      port: 3737,
      cwd,
      verbose: true,
      fastMode: false,
      requestPolicy: {
        requestTimeoutMs: 120_000,
        retry: { maxAttempts: 4, initialDelayMs: 500, maxDelayMs: 10_000, multiplier: 2 },
      },
      onProgress: patch => progress.push(patch),
    });

    expect(result).toEqual({ compacted: 2, unchanged: 0, skipped: 0, failures: 0, compactedProjects: [paths.canonical] });
    expect(progress.at(-1)).toMatchObject({
      completed: 2,
      messagesIn: 18,
      tokensIn: 550,
      tokensOut: 280,
      lastResult: {
        sessionId: "session-2",
        tokensBefore: 300,
        tokensAfter: 30,
      },
    });
    expect(log).toHaveBeenCalledWith(expect.stringContaining(
      "2 sessions compacted, 0.6k → 0.3k tokens (49% reduction, 0.3k freed)",
    ));
    expect(log.mock.calls.flat().join(" ")).not.toContain(firstLabel);
    expect(log.mock.calls.flat().join(" ")).not.toContain(secondLabel);
    expect(post).toHaveBeenNthCalledWith(1, "/compact", expect.objectContaining({
      fast_mode: false,
      request_timeout_ms: 120_000,
      retry: {
        max_attempts: 4,
        initial_delay_ms: 500,
        max_delay_ms: 10_000,
        multiplier: 2,
      },
    }));
  });

  it("threads invocation identity and abort signal through compact requests", async () => {
    const cwd = makeDir("compact-invocation-forwarding");
    const paths = projectPaths(cwd);
    ensureProjectDir(cwd);
    writeFileSync(paths.metaPath, JSON.stringify({ cwd: paths.canonical }));
    seedConversation(paths.dbPath);
    const signal = new AbortController().signal;
    const post = vi.spyOn(DaemonClient.prototype, "post")
      .mockResolvedValue({ tokensBefore: 250, tokensAfter: 50 });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await batchCompact({
      minTokens: 100,
      dryRun: false,
      port: 3737,
      cwd,
      invocationId: "22222222-2222-4222-8222-222222222222",
      signal,
    });

    expect(post).toHaveBeenCalledWith("/compact", expect.objectContaining({
      invocation_id: "22222222-2222-4222-8222-222222222222",
    }), { signal });
  });

  it("does not create compact requests during dry-run even when an invocation is supplied", async () => {
    const cwd = makeDir("compact-invocation-dry-run");
    const paths = projectPaths(cwd);
    ensureProjectDir(cwd);
    writeFileSync(paths.metaPath, JSON.stringify({ cwd: paths.canonical }));
    seedConversation(paths.dbPath);
    const post = vi.spyOn(DaemonClient.prototype, "post");

    await batchCompact({
      minTokens: 100,
      dryRun: true,
      port: 3737,
      cwd,
      invocationId: "22222222-2222-4222-8222-222222222222",
    });

    expect(post).not.toHaveBeenCalled();
  });

  it("reports daemon transport loss to the command drain callback", async () => {
    const cwd = makeDir("compact-transport-loss");
    const paths = projectPaths(cwd);
    ensureProjectDir(cwd);
    writeFileSync(paths.metaPath, JSON.stringify({ cwd: paths.canonical }));
    seedConversation(paths.dbPath);
    const transportError = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    vi.spyOn(DaemonClient.prototype, "post").mockRejectedValue(transportError);
    const onTransportFailure = vi.fn();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await batchCompact({
      minTokens: 100,
      dryRun: false,
      port: 3737,
      cwd,
      invocationId: "22222222-2222-4222-8222-222222222222",
      onTransportFailure,
    });

    expect(onTransportFailure).toHaveBeenCalledWith(transportError);
  });

  it("bounds even safe-looking upstream Error messages to stderr and progress", async () => {
    const cwd = makeDir("compact-upstream-failure");
    const paths = projectPaths(cwd);
    ensureProjectDir(cwd);
    writeFileSync(paths.metaPath, JSON.stringify({ cwd: paths.canonical }));
    seedConversation(paths.dbPath);
    const safeMessage = "Codex compaction upstream request failed. Retry later or choose another available model.";
    vi.spyOn(DaemonClient.prototype, "post").mockRejectedValue(new Error(safeMessage));
    const stdout = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const progress: Array<Partial<ProgressState>> = [];

    const result = await batchCompact({
      minTokens: 100,
      dryRun: false,
      port: 3737,
      cwd,
      onProgress: patch => progress.push(patch),
    });

    expect(result.failures).toBe(1);
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr.mock.calls.flat().join(" ")).not.toContain(cwd);
    expect(JSON.stringify([stderr.mock.calls, progress])).not.toContain(safeMessage);
    expect(progress.find(patch => patch.errors)?.errors).toEqual([
      expect.objectContaining({
        project: paths.canonical,
        sessionId: "session-1",
        conversationId: 1,
        message: "compaction request failed",
      }),
    ]);
  });

  it("reports daemon no-ops as unchanged and excludes them from promotion projects", async () => {
    const cwd = makeDir("compact-noop-accounting");
    const paths = projectPaths(cwd);
    ensureProjectDir(cwd);
    writeFileSync(paths.metaPath, JSON.stringify({ cwd: paths.canonical }));
    seedConversations(paths.dbPath);
    vi.spyOn(DaemonClient.prototype, "post")
      .mockResolvedValueOnce({
        actionTaken: false,
        summary: "Summarization disabled — no summarizer configured.",
        tokensBefore: 125,
        tokensAfter: 120,
      })
      .mockResolvedValueOnce({ actionTaken: true, tokensBefore: 250, tokensAfter: 50 });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const progress: Array<Partial<ProgressState>> = [];

    const result = await batchCompact({
      minTokens: 100,
      dryRun: false,
      port: 3737,
      cwd,
      onProgress: patch => progress.push(patch),
    });

    expect(result).toEqual({ compacted: 1, unchanged: 1, skipped: 0, failures: 0, compactedProjects: [paths.canonical] });
    expect(log.mock.calls.flat().join(" ")).not.toContain(paths.canonical);
    expect(progress.find(patch => patch.lastResult?.sessionId === "session-1")?.lastResult).toMatchObject({
      tokensBefore: 125,
      tokensAfter: 120,
    });
  });

  it("falls back to stored tokens and a generic message for metadata-free daemon no-ops", async () => {
    const cwd = makeDir("compact-noop-fallbacks");
    const paths = projectPaths(cwd);
    ensureProjectDir(cwd);
    writeFileSync(paths.metaPath, JSON.stringify({ cwd: paths.canonical }));
    seedConversation(paths.dbPath);
    vi.spyOn(DaemonClient.prototype, "post").mockResolvedValue({ actionTaken: false });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const progress: Array<Partial<ProgressState>> = [];

    const result = await batchCompact({
      minTokens: 100,
      dryRun: false,
      port: 3737,
      cwd,
      onProgress: patch => progress.push(patch),
    });

    expect(result).toEqual({ compacted: 0, unchanged: 1, skipped: 0, failures: 0, compactedProjects: [] });
    expect(log.mock.calls.flat().join(" ")).not.toContain(paths.canonical);
    expect(progress.at(-1)?.lastResult).toMatchObject({ tokensBefore: 250, tokensAfter: 250 });
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["empty object", {}],
  ] as const)("accounts a non-dry-run %s response as a failure", async (_name, response) => {
    const cwd = makeDir("compact-malformed-response");
    const paths = projectPaths(cwd);
    ensureProjectDir(cwd);
    writeFileSync(paths.metaPath, JSON.stringify({ cwd: paths.canonical }));
    seedConversation(paths.dbPath);
    const post = vi.spyOn(DaemonClient.prototype, "post").mockResolvedValue(response as never);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const progress: Array<Partial<ProgressState>> = [];

    const result = await batchCompact({
      minTokens: 100,
      dryRun: false,
      port: 3737,
      cwd,
      onProgress: patch => progress.push(patch),
    });

    expect(result).toEqual({ compacted: 0, unchanged: 0, skipped: 0, failures: 1, compactedProjects: [] });
    expect(post).toHaveBeenCalledOnce();
    expect(progress.find(patch => patch.errors)).toMatchObject({
      errors: [{ sessionId: "session-1", message: "malformed compact response" }],
    });
    expect(progress).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ messagesIn: expect.anything() }),
      expect.objectContaining({ tokensIn: expect.anything() }),
      expect.objectContaining({ tokensOut: expect.anything() }),
    ]));
    expect(log).toHaveBeenCalledWith("\nBatch compact complete.");
  });

  it("accepts a token-after-only compact response with discovered input fallback", async () => {
    const cwd = makeDir("compact-token-after-fallback");
    const paths = projectPaths(cwd);
    ensureProjectDir(cwd);
    writeFileSync(paths.metaPath, JSON.stringify({ cwd: paths.canonical }));
    seedConversation(paths.dbPath);
    vi.spyOn(DaemonClient.prototype, "post").mockResolvedValue({ tokensAfter: 50 });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await expect(batchCompact({ minTokens: 100, dryRun: false, port: 3737, cwd }))
      .resolves.toMatchObject({ compacted: 1, failures: 0 });
  });

  it("sends a process-provider timeout without an implicit retry override", async () => {
    const cwd = makeDir("compact-process-timeout-only");
    const paths = projectPaths(cwd);
    ensureProjectDir(cwd);
    writeFileSync(paths.metaPath, JSON.stringify({ cwd: paths.canonical }, null, 2) + "\n");
    seedConversations(paths.dbPath);
    const post = vi.spyOn(DaemonClient.prototype, "post")
      .mockResolvedValue({ tokensBefore: 250, tokensAfter: 50 });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await batchCompact({
      minTokens: 100,
      dryRun: false,
      port: 3737,
      cwd,
      requestPolicy: { requestTimeoutMs: 300_000 },
    });

    expect(post).toHaveBeenCalled();
    for (const [, body] of post.mock.calls) {
      expect(body).toMatchObject({ request_timeout_ms: 300_000 });
      expect(body).not.toHaveProperty("retry");
    }
  });

  it("handles absent, malformed, summarized, and replay discovery entries", async () => {
    expect(await findUncompacted(100, true)).toEqual([]);

    const projectsDir = join(homedir(), ".lcm", "projects");
    mkdirSync(projectsDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(projectsDir, "not-a-directory"), "ignored");
    mkdirSync(join(projectsDir, "missing-db"), { mode: 0o700 });

    const corruptMeta = join(projectsDir, "corrupt-meta");
    mkdirSync(corruptMeta, { mode: 0o700 });
    writeFileSync(join(corruptMeta, "db.sqlite"), "not sqlite");
    writeFileSync(join(corruptMeta, "meta.json"), "{");

    const missingCwd = join(projectsDir, "missing-cwd");
    mkdirSync(missingCwd, { mode: 0o700 });
    writeFileSync(join(missingCwd, "db.sqlite"), "not sqlite");
    writeFileSync(join(missingCwd, "meta.json"), "{}");

    const missingMeta = join(projectsDir, "missing-meta");
    mkdirSync(missingMeta, { mode: 0o700 });
    seedConversation(join(missingMeta, "db.sqlite"));

    const corruptDb = join(projectsDir, "corrupt-db");
    mkdirSync(corruptDb, { mode: 0o700 });
    writeFileSync(join(corruptDb, "db.sqlite"), "not sqlite");
    writeFileSync(join(corruptDb, "meta.json"), JSON.stringify({ cwd: "/corrupt" }));

    const cwd = makeDir("compact-replay");
    const paths = projectPaths(cwd);
    ensureProjectDir(cwd);
    writeFileSync(paths.metaPath, JSON.stringify({ cwd: paths.canonical }));
    seedConversation(paths.dbPath);
    const db = new DatabaseSync(paths.dbPath);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    db.prepare(
      "INSERT INTO summaries (summary_id, conversation_id, kind, content, token_count, file_ids) VALUES (?, ?, ?, ?, ?, '[]')",
    ).run("summary-1", 1, "leaf", "summary", 10);
    db.close();

    expect(await findUncompacted(100, true, cwd)).toEqual([]);
    expect(await findUncompacted(100, true, cwd, true)).toHaveLength(1);
    expect(await findUncompacted(100, false, cwd, true)).toHaveLength(1);
    expect(await findUncompacted(100, true)).toHaveLength(0);

    const replayDb = new DatabaseSync(paths.dbPath);
    try {
      replayDb.exec("PRAGMA journal_mode = WAL");
      replayDb.exec("PRAGMA foreign_keys = ON");
      replayDb.prepare(
        "UPDATE context_items SET item_type = 'summary', message_id = NULL, summary_id = ? WHERE conversation_id = ? AND ordinal = 0",
      ).run("summary-1", 1);
    } finally {
      replayDb.close();
    }
    expect(await findUncompacted(100, true, cwd, true)).toEqual([]);

    const condensationDb = new DatabaseSync(paths.dbPath);
    try {
      condensationDb.exec("PRAGMA journal_mode = WAL");
      condensationDb.exec("PRAGMA foreign_keys = ON");
      condensationDb.exec("BEGIN");
      const insertSummary = condensationDb.prepare(
        "INSERT INTO summaries (summary_id, conversation_id, kind, content, token_count, depth, file_ids) VALUES (?, ?, ?, ?, ?, ?, '[]')",
      );
      insertSummary.run("summary-2", 1, "leaf", "summary", 1_000, 0);
      insertSummary.run("summary-3", 1, "leaf", "x".repeat(4_000), 0, 0);
      const replaceMessage = condensationDb.prepare(
        "UPDATE context_items SET item_type = 'summary', message_id = NULL, summary_id = ? WHERE conversation_id = ? AND ordinal = ?",
      );
      replaceMessage.run("summary-2", 1, 1);
      replaceMessage.run("summary-3", 1, 2);
      condensationDb.exec("COMMIT");
    } finally {
      condensationDb.close();
    }
    expect(await findUncompacted(100, true, cwd, true)).toHaveLength(1);

    const interruptedRunDb = new DatabaseSync(paths.dbPath);
    try {
      interruptedRunDb.exec("PRAGMA journal_mode = WAL");
      interruptedRunDb.exec("PRAGMA foreign_keys = ON");
      interruptedRunDb.prepare("UPDATE summaries SET depth = CASE summary_id WHEN 'summary-1' THEN 1 ELSE 0 END WHERE conversation_id = ?").run(1);
    } finally {
      interruptedRunDb.close();
    }
    expect(await findUncompacted(100, true, cwd, true)).toEqual([]);

    const chunkLimitDb = new DatabaseSync(paths.dbPath);
    try {
      chunkLimitDb.exec("PRAGMA journal_mode = WAL");
      chunkLimitDb.exec("PRAGMA foreign_keys = ON");
      chunkLimitDb.prepare("UPDATE summaries SET depth = 0, token_count = CASE summary_id WHEN 'summary-1' THEN 15000 WHEN 'summary-2' THEN 6000 ELSE 1000 END WHERE conversation_id = ?").run(1);
    } finally {
      chunkLimitDb.close();
    }
    expect(await findUncompacted(100, true, cwd, true)).toEqual([]);

    const fullChunkDb = new DatabaseSync(paths.dbPath);
    try {
      fullChunkDb.exec("PRAGMA journal_mode = WAL");
      fullChunkDb.exec("PRAGMA foreign_keys = ON");
      fullChunkDb.prepare("UPDATE summaries SET token_count = CASE summary_id WHEN 'summary-1' THEN 20000 ELSE 1000 END WHERE conversation_id = ?").run(1);
    } finally {
      fullChunkDb.close();
    }
    expect(await findUncompacted(100, true, cwd, true)).toEqual([]);

    const condensedDb = new DatabaseSync(paths.dbPath);
    try {
      condensedDb.exec("PRAGMA journal_mode = WAL");
      condensedDb.exec("PRAGMA foreign_keys = ON");
      condensedDb.prepare("UPDATE summaries SET depth = 1, token_count = 1000 WHERE conversation_id = ?").run(1);
    } finally {
      condensedDb.close();
    }
    expect(await findUncompacted(100, true, cwd, true)).toHaveLength(1);

    const summaryOnlyDb = new DatabaseSync(paths.dbPath);
    try {
      summaryOnlyDb.exec("PRAGMA journal_mode = WAL");
      summaryOnlyDb.exec("PRAGMA foreign_keys = ON");
      summaryOnlyDb.prepare("DELETE FROM context_items WHERE conversation_id = ? AND item_type = 'message'").run(1);
    } finally {
      summaryOnlyDb.close();
    }
    expect(await findUncompacted(100, true, cwd, true)).toHaveLength(1);

    writeFileSync(projectMapPath(), "{");
    clearProjectMapCache();
    expect(await findUncompacted(100, true, "/unmapped", true)).toEqual([]);
  }, FULL_SUITE_DISCOVERY_TEST_TIMEOUT_MS);

  it("reports empty, dry-run, skipped, and unknown-error batch outcomes", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await batchCompact({ minTokens: 100, dryRun: true, port: 3737 })).toEqual({
      compacted: 0,
      unchanged: 0,
      skipped: 0,
      failures: 0,
      compactedProjects: [],
    });
    expect(log).toHaveBeenCalledWith("Nothing to compact — no sessions are currently eligible.");

    const cwd = makeDir("compact-boundary-outcomes");
    const paths = projectPaths(cwd);
    ensureProjectDir(cwd);
    writeFileSync(paths.metaPath, JSON.stringify({ cwd: paths.canonical }));
    seedConversations(paths.dbPath);
    const progress: Array<Partial<ProgressState>> = [];

    expect(await batchCompact({
      minTokens: 100,
      dryRun: true,
      port: 3737,
      cwd,
      onProgress: patch => progress.push(patch),
    })).toEqual({ compacted: 0, unchanged: 0, skipped: 0, failures: 0, compactedProjects: [] });
    expect(progress).toContainEqual({ total: 2 });
    expect(progress.at(-1)).toMatchObject({
      completed: 2,
      lastResult: { outcome: "dry-run", conversationId: 2 },
    });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Found 2 uncompacted conversations"));

    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const post = vi.spyOn(DaemonClient.prototype, "post")
      .mockResolvedValueOnce({ skipped: true })
      .mockRejectedValueOnce("no details");
    progress.length = 0;
    const events: CompactProgressEvent[] = [];
    expect(await batchCompact({
      minTokens: 100,
      dryRun: false,
      port: 3737,
      cwd,
      onProgress: patch => progress.push(patch),
      onEvent: event => events.push(event),
    })).toEqual({ compacted: 0, unchanged: 0, skipped: 1, failures: 1, compactedProjects: [] });
    expect(post).toHaveBeenCalledTimes(2);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "session-terminal", outcome: "skipped" }),
      expect.objectContaining({
        type: "session-terminal",
        outcome: "failed",
        message: "unknown error",
      }),
    ]));
    expect(log.mock.calls.flat().join(" ")).not.toContain(paths.canonical);
    expect(log).toHaveBeenCalledWith("\nBatch compact complete.");
  });

  it("prints the singular non-verbose success path", async () => {
    const cwd = makeDir("compact-single-success");
    const paths = projectPaths(cwd);
    ensureProjectDir(cwd);
    writeFileSync(paths.metaPath, JSON.stringify({ cwd: paths.canonical }));
    seedConversation(paths.dbPath);
    vi.spyOn(DaemonClient.prototype, "post").mockResolvedValue({ tokensBefore: 250 });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    expect(await batchCompact({ minTokens: 100, dryRun: false, port: 3737, cwd })).toEqual({
      compacted: 1,
      unchanged: 0,
      skipped: 0,
      failures: 0,
      compactedProjects: [paths.canonical],
    });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Found 1 uncompacted conversation ("));
    expect(log.mock.calls.flat().join(" ")).not.toContain(paths.canonical);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("1 session compacted"));
  });

  it("emits one complete labeled line for each staggered concurrent outcome", async () => {
    const cwd = makeDir("compact-labeled-output");
    const paths = projectPaths(cwd);
    ensureProjectDir(cwd);
    writeFileSync(paths.metaPath, JSON.stringify({ cwd: paths.canonical }));
    seedConversations(paths.dbPath, [1, 2, 3, 4, 5]);
    const conversations = await findUncompacted(100, true, cwd);
    const gates = new Map(conversations.map(conv => {
      let release!: () => void;
      const promise = new Promise<void>(resolve => { release = resolve; });
      return [conv.sessionId, { promise, release }] as const;
    }));
    const outcomes = new Map<string, object | Error>([
      ["session-1", { tokensBefore: 250, tokensAfter: 50 }],
      ["session-2", { tokensBefore: 250, tokensAfter: 50 }],
      ["session-3", { actionTaken: false, summary: "No action", tokensBefore: 250, tokensAfter: 250 }],
      ["session-4", { skipped: true }],
      ["session-5", new Error("provider unavailable")],
    ]);
    const post = vi.spyOn(DaemonClient.prototype, "post").mockImplementation(async (_path, body) => {
      const sessionId = String(body.session_id);
      await gates.get(sessionId)!.promise;
      const outcome = outcomes.get(sessionId)!;
      if (outcome instanceof Error) throw outcome;
      return outcome;
    });
    const lines: string[] = [];
    const events: CompactProgressEvent[] = [];
    vi.spyOn(console, "error").mockImplementation((line?: unknown) => { lines.push(String(line)); });
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const pending = batchCompact({
      minTokens: 100,
      dryRun: false,
      port: 3737,
      cwd,
      maxConcurrency: 5,
      onEvent: event => events.push(event),
    });
    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(5));
    for (const sessionId of ["session-5", "session-3", "session-2", "session-4", "session-1"]) {
      gates.get(sessionId)!.release();
    }

    await expect(pending).resolves.toEqual({
      compacted: 2,
      unchanged: 1,
      skipped: 1,
      failures: 1,
      compactedProjects: [paths.canonical],
    });

    const terminals = events.filter((event): event is Extract<CompactProgressEvent, { type: "session-terminal" }> =>
      event.type === "session-terminal");
    expect(terminals).toHaveLength(5);
    expect(terminals.map(event => [event.identity.sessionId, event.outcome])).toEqual(expect.arrayContaining([
      ["session-1", "done"],
      ["session-2", "done"],
      ["session-3", "unchanged"],
      ["session-4", "skipped"],
      ["session-5", "failed"],
    ]));
    expect(terminals.every(event => event.identity.project === paths.canonical)).toBe(true);
    expect(lines.join(" ")).not.toContain(paths.canonical);
  });

  it("includes the conversation label in verbose completion lines", async () => {
    const cwd = makeDir("compact-verbose-labeled-output");
    const paths = projectPaths(cwd);
    ensureProjectDir(cwd);
    writeFileSync(paths.metaPath, JSON.stringify({ cwd: paths.canonical }));
    seedConversation(paths.dbPath);
    vi.spyOn(DaemonClient.prototype, "post").mockResolvedValue({ tokensBefore: 250, tokensAfter: 50 });
    const lines: string[] = [];
    const events: CompactProgressEvent[] = [];
    vi.spyOn(console, "error").mockImplementation((line?: unknown) => { lines.push(String(line)); });
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await batchCompact({
      minTokens: 100,
      dryRun: false,
      port: 3737,
      cwd,
      verbose: true,
      onEvent: event => events.push(event),
    });

    expect(events).toContainEqual(expect.objectContaining({
      type: "session-terminal",
      outcome: "done",
      identity: expect.objectContaining({
        project: paths.canonical,
        sessionId: "session-1",
        conversationId: 1,
      }),
    }));
    expect(lines.join(" ")).not.toContain(paths.canonical);
  });

  it("limits concurrent compaction requests, keeps the oldest active session current, and orders projects by discovery", async () => {
    const firstCwd = makeDir("compact-pool-a");
    const firstPaths = projectPaths(firstCwd);
    ensureProjectDir(firstCwd);
    writeFileSync(firstPaths.metaPath, JSON.stringify({ cwd: firstPaths.canonical }));
    seedConversation(firstPaths.dbPath);

    const secondCwd = makeDir("compact-pool-b");
    const secondPaths = projectPaths(secondCwd);
    ensureProjectDir(secondCwd);
    writeFileSync(secondPaths.metaPath, JSON.stringify({ cwd: secondPaths.canonical }));
    seedConversation(secondPaths.dbPath);

    const expectedProjectOrder = [...new Set((await findUncompacted(100, true)).map(conv => conv.cwd))];
    expect(expectedProjectOrder).toEqual(expect.arrayContaining([
      firstPaths.canonical,
      secondPaths.canonical,
    ]));

    const releases = [0, 1].map(() => {
      let release!: () => void;
      const pending = new Promise<void>(resolve => { release = resolve; });
      return { pending, release };
    });
    const post = vi.spyOn(DaemonClient.prototype, "post").mockImplementation(async (_path, body) => {
      const index = body.cwd === firstPaths.canonical ? 0 : 1;
      await releases[index]!.pending;
      return { tokensBefore: 250, tokensAfter: 50 };
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const progress: Array<Partial<ProgressState>> = [];
    const events: CompactProgressEvent[] = [];

    const pending = batchCompact({
      minTokens: 100,
      dryRun: false,
      port: 3737,
      maxConcurrency: 2,
      onProgress: patch => progress.push(patch),
      onEvent: event => events.push(event),
    });
    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    const active = progress.filter(patch => patch.activeSessions !== undefined);
    expect(active.at(-1)?.activeSessions).toHaveLength(2);
    expect(active.at(-1)?.current).toMatchObject({ sessionId: "session-1" });

    releases[1]!.release();
    await vi.waitFor(() => expect(progress.at(-1)?.activeSessions).toHaveLength(1));
    expect(progress.at(-1)?.current).toMatchObject({ sessionId: "session-1" });
    releases[0]!.release();

    await expect(pending).resolves.toMatchObject({
      compacted: 2,
      compactedProjects: expectedProjectOrder,
    });
    expect(progress.at(-1)?.activeSessions).toEqual([]);
    expect(progress.at(-1)?.current).toBeUndefined();
    expect(events.filter(event => event.type === "session-terminal" && event.outcome === "done")).toHaveLength(2);
    expect(log.mock.calls.flat().join(" ")).not.toContain(firstPaths.canonical);
    expect(log.mock.calls.flat().join(" ")).not.toContain(secondPaths.canonical);
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining("compacting:"));
  });

  it("clamps replay compaction to one in-flight request", async () => {
    const cwd = makeDir("compact-replay-serial");
    const paths = projectPaths(cwd);
    ensureProjectDir(cwd);
    writeFileSync(paths.metaPath, JSON.stringify({ cwd: paths.canonical }));
    seedConversations(paths.dbPath);

    const releases = [0, 1].map(() => {
      let release!: () => void;
      const pending = new Promise<void>(resolve => { release = resolve; });
      return { pending, release };
    });
    let call = 0;
    const post = vi.spyOn(DaemonClient.prototype, "post").mockImplementation(async () => {
      const index = call++;
      await releases[index]!.pending;
      return { tokensBefore: 250, tokensAfter: 50 };
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const pending = batchCompact({
      minTokens: 100,
      dryRun: false,
      port: 3737,
      cwd,
      replay: true,
      maxConcurrency: 32,
    });
    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    releases[0]!.release();
    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    releases[1]!.release();

    await expect(pending).resolves.toMatchObject({ compacted: 2 });
  });
});

describe("batch worker pool", () => {
  it.each([1, 32])("accepts the %d worker concurrency boundary", async maxConcurrency => {
    let peak = 0;
    let active = 0;
    const results = await runBatchWorkerPool({
      items: [10, 20],
      maxConcurrency,
      worker: async item => {
        active++;
        peak = Math.max(peak, active);
        await Promise.resolve();
        active--;
        return item * 2;
      },
    });

    expect(peak).toBeLessThanOrEqual(maxConcurrency);
    expect(results.map(result => result.index)).toEqual(expect.arrayContaining([0, 1]));
  });

  it("rejects a non-positive worker concurrency", async () => {
    await expect(runBatchWorkerPool({
      items: [1],
      maxConcurrency: 0,
      worker: item => item,
    })).rejects.toThrow("maxConcurrency");
  });

  it("does not claim work when cancellation is already requested", async () => {
    const controller = new AbortController();
    controller.abort();
    const claimed: number[] = [];

    await expect(runBatchWorkerPool({
      items: [1, 2],
      maxConcurrency: 2,
      signal: controller.signal,
      onClaim: (_item, index) => claimed.push(index),
      worker: item => item,
    })).resolves.toEqual([]);
    expect(claimed).toEqual([]);
  });

  it("caps in-flight workers, reduces settled results synchronously, and preserves indexes", async () => {
    const active = new Set<number>();
    let peak = 0;
    const started: number[] = [];
    const reduced: Array<{ index: number; value?: number; error?: unknown }> = [];
    const gates = [0, 1, 2, 3].map(() => {
      let release!: () => void;
      const promise = new Promise<void>(resolve => { release = resolve; });
      return { promise, release };
    });

    const pending = runBatchWorkerPool({
      items: [10, 20, 30, 40],
      maxConcurrency: 2,
      worker: async (item, index) => {
        started.push(index);
        active.add(index);
        peak = Math.max(peak, active.size);
        await gates[index]!.promise;
        active.delete(index);
        return item * 2;
      },
      onResult: result => reduced.push(result),
    });

    await vi.waitFor(() => expect(started).toEqual([0, 1]));
    gates[1]!.release();
    await vi.waitFor(() => expect(started).toEqual([0, 1, 2]));
    gates[2]!.release();
    gates[0]!.release();
    await vi.waitFor(() => expect(started).toEqual([0, 1, 2, 3]));
    gates[3]!.release();

    const results = await pending;
    expect(peak).toBe(2);
    expect(results.map(result => result.index)).toEqual([1, 2, 0, 3]);
    expect(reduced).toEqual(results);
  });

  it("drains admitted workers before propagating an onResult callback failure", async () => {
    const callbackError = new Error("onResult failed");
    const started: number[] = [];
    const settled: number[] = [];
    const callbacks: number[] = [];
    const gates = [0, 1].map(() => {
      let release!: () => void;
      const promise = new Promise<void>(resolve => { release = resolve; });
      return { promise, release };
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);

    try {
      const pending = runBatchWorkerPool({
        items: [1, 2],
        maxConcurrency: 2,
        worker: async (_item, index) => {
          started.push(index);
          await gates[index]!.promise;
          settled.push(index);
          return index;
        },
        onResult: result => {
          callbacks.push(result.index);
          throw callbackError;
        },
      });

      await vi.waitFor(() => expect(started).toEqual([0, 1]));
      let rejected = false;
      void pending.catch(() => { rejected = true; });
      gates[0]!.release();
      await vi.waitFor(() => expect(callbacks).toEqual([0]));
      await Promise.resolve();
      expect(rejected).toBe(false);
      expect(settled).toEqual([0]);

      gates[1]!.release();
      await expect(pending).rejects.toBe(callbackError);
      expect(settled).toEqual([0, 1]);
      expect(callbacks).toEqual([0, 1]);
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
    }
  });

  it("stops claiming and drains admitted workers before propagating an onClaim failure", async () => {
    const callbackError = new Error("onClaim failed");
    const claimed: number[] = [];
    const started: number[] = [];
    const settled: number[] = [];
    const callbacks: number[] = [];
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });

    const pending = runBatchWorkerPool({
      items: [1, 2, 3],
      maxConcurrency: 2,
      onClaim: (_item, index) => {
        claimed.push(index);
        if (index === 1) throw callbackError;
      },
      worker: async (_item, index) => {
        started.push(index);
        await gate;
        settled.push(index);
        return index;
      },
      onResult: result => callbacks.push(result.index),
    });

    let rejected = false;
    void pending.catch(() => { rejected = true; });
    expect(claimed).toEqual([0, 1]);
    await vi.waitFor(() => expect(started).toEqual([0]));
    await Promise.resolve();
    expect(rejected).toBe(false);
    expect(callbacks).toEqual([]);
    release();

    await expect(pending).rejects.toBe(callbackError);
    expect(claimed).toEqual([0, 1]);
    expect(started).toEqual([0]);
    expect(settled).toEqual([0]);
    expect(callbacks).toEqual([0]);
  });

  it("stops claiming immediately after cancellation while awaiting admitted workers", async () => {
    const controller = new AbortController();
    const started: number[] = [];
    const gates = [0, 1].map(() => {
      let release!: () => void;
      const promise = new Promise<void>(resolve => { release = resolve; });
      return { promise, release };
    });

    const pending = runBatchWorkerPool({
      items: [1, 2, 3],
      maxConcurrency: 2,
      signal: controller.signal,
      worker: async (_item, index) => {
        started.push(index);
        await gates[index]!.promise;
        return index;
      },
    });

    await vi.waitFor(() => expect(started).toEqual([0, 1]));
    controller.abort();
    gates[0]!.release();
    gates[1]!.release();
    await expect(pending).resolves.toHaveLength(2);
    expect(started).toEqual([0, 1]);
  });
});

describe("formatLlmDiagnostic", () => {
  it("omits diagnostics without a provider and optional controls when absent", () => {
    expect(formatLlmDiagnostic({})).toBeUndefined();
    expect(formatLlmDiagnostic({ providerLabel: "Anthropic API" })).toBe("Anthropic API");
    expect(formatLlmDiagnostic({
      providerLabel: "OpenAI-compatible API",
      apiMode: "chat-completions",
    })).toBe("OpenAI-compatible API · chat-completions");
  });
  it("includes Responses API mode and the effective reasoning effort", () => {
    expect(formatLlmDiagnostic({
      providerLabel: "OpenAI API",
      apiMode: "responses",
      reasoningEffort: "high",
    })).toBe("OpenAI API · responses · reasoning=high");
  });

  it("shows the provider default when Responses reasoning is unset", () => {
    expect(formatLlmDiagnostic({
      providerLabel: "OpenAI API",
      apiMode: "responses",
      reasoningEffort: null,
    })).toBe("OpenAI API · responses · reasoning=default");
  });

  it("shows effective process controls including an explicit false", () => {
    expect(formatLlmDiagnostic({
      providerLabel: "Codex (process)",
      reasoningEffort: null,
      fastMode: false,
      requestTimeoutMs: 600_000,
      retry: null,
    })).toBe("Codex (process) · reasoning=default · fast=off · timeout=600000ms");

    expect(formatLlmDiagnostic({
      providerLabel: "Claude (process)",
      reasoningEffort: "max",
      fastMode: true,
    })).toBe("Claude (process) · reasoning=max · fast=on");
  });

  it("includes the effective request timeout and retry policy", () => {
    expect(formatLlmDiagnostic({
      providerLabel: "OpenAI-compatible API",
      apiMode: "chat-completions",
      requestTimeoutMs: 120_000,
      retry: { maxAttempts: 4, initialDelayMs: 500, maxDelayMs: 10_000, multiplier: 2 },
    })).toBe(
      "OpenAI-compatible API · chat-completions · timeout=120000ms · retry=4 attempts (500-10000ms ×2)",
    );
  });
});
