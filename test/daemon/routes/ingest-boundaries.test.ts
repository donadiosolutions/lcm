import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadDaemonConfig } from "../../../src/daemon/config.js";
import { MachineIdentityFileError } from "../../../src/machine-identity.js";
import { createStorageBackendFactory } from "../../../src/storage/index.js";
import { makeStagedPostgreSqlStorageFactory } from "./mock-storage-factory.js";

const mocks = vi.hoisted(() => ({
  snapshotStream: vi.fn(async () => Buffer.from("{}")),
  snapshotClose: vi.fn(async () => undefined),
  snapshotAssert: vi.fn(async () => undefined),
  snapshotOpen: vi.fn(async () => undefined),
  nativeAvailable: vi.fn(() => true),
  nativeBackfill: vi.fn(async () => undefined),
  closeQuarantine: vi.fn(async () => undefined),
  loadPatterns: vi.fn(async () => []),
  exists: vi.fn(() => true),
  read: vi.fn(() => "{}"),
  write: vi.fn(),
  readMetadata: vi.fn(() => "{}"),
  writeMetadata: vi.fn(),
  closeMetadataDirectory: vi.fn(),
  openMetadataDirectory: vi.fn(() => ({
    fd: 1,
    witness: { mode: 0o700, uid: 0, gid: 0, nlink: "1", dev: "1", ino: "1" },
    close: mocks.closeMetadataDirectory,
  })),
  realpath: vi.fn((path: string) => path),
  getConnection: vi.fn(),
  closeConnection: vi.fn(),
  sessionGet: vi.fn(() => undefined),
  validate: vi.fn((cwd: string) => cwd),
  safeTranscript: vi.fn((path: string) => path),
  migrate: vi.fn(),
  getConversation: vi.fn(async () => ({ conversationId: 1 })),
  getCount: vi.fn(async () => 0),
  createBulk: vi.fn(async (inputs: unknown[]) => inputs.map((_, index) => ({ messageId: index + 1 }))),
  transaction: vi.fn(async (operation: () => unknown) => operation()),
  append: vi.fn(async () => undefined),
  tokens: vi.fn(async () => 7),
  parse: vi.fn(() => [] as unknown[]),
  normalize: vi.fn((client: unknown) => client ?? "claude"),
  scrubCounts: vi.fn((content: string) => ({ text: content, gitleaks: 0, builtIn: 0, global: 0, project: 0 })),
  forProject: vi.fn(async () => ({ scrubWithCounts: mocks.scrubCounts })),
  identity: vi.fn((cwd: string) => ({
    id: "pid",
    localProjectId: "pid",
    canonical: cwd,
    machineId: "machine-id",
    selectedPath: cwd,
  })),
  ensureProject: vi.fn(),
  ensureProjectForIdentity: vi.fn((identity: { id: string }) => `/lcm/projects/${identity.id}`),
  pathsForIdentity: vi.fn((identity: { id: string; canonical: string; remoteProjectId?: string }) => ({
    ...identity,
    dir: `/lcm/projects/${identity.id}`,
    dbPath: `/lcm/projects/${identity.id}/db.sqlite`,
    metaPath: `/lcm/projects/${identity.id}/meta.json`,
  })),
  openProject: vi.fn(),
  send: vi.fn(),
  logError: vi.fn(),
}));

const db = {
  prepare: () => ({ get: mocks.sessionGet }),
};

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  existsSync: mocks.exists,
  readFileSync: mocks.read,
  writeFileSync: mocks.write,
  realpathSync: mocks.realpath,
}));
vi.mock("../../../src/db/connection.js", () => ({
  getLcmConnection: mocks.getConnection,
  closeLcmConnection: mocks.closeConnection,
  withLcmConnectionLock: (_path: string, work: () => unknown) => work(),
}));
vi.mock("../../../src/daemon/project.js", () => ({
  MAX_PROJECT_METADATA_BYTES: 1024 * 1024,
  projectPaths: (cwd: string) => ({ id: "pid", dir: `${cwd}/project`, dbPath: `${cwd}/lcm.db`, metaPath: `${cwd}/meta.json`, canonical: cwd }),
  projectPathsForIdentity: mocks.pathsForIdentity,
  projectIdentity: mocks.identity,
  ensureProjectDir: mocks.ensureProject,
  ensureProjectDirForIdentity: mocks.ensureProjectForIdentity,
  isSafeTranscriptPath: mocks.safeTranscript,
}));
vi.mock("../../../src/security-files.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../src/security-files.js")>(),
  readBoundedRegularFile: mocks.readMetadata,
  atomicWritePrivateFile: mocks.writeMetadata,
  openPrivateDirectory: mocks.openMetadataDirectory,
}));
vi.mock("../../../src/daemon/server.js", () => ({ sendJson: mocks.send }));
vi.mock("../../../src/db/migration.js", () => ({ runLcmMigrations: mocks.migrate }));
vi.mock("../../../src/db/redaction-stats.js", () => ({ upsertRedactionCounts: vi.fn() }));
vi.mock("../../../src/store/conversation-store.js", () => ({
  ConversationStore: class {
    getOrCreateConversation = mocks.getConversation;
    getMessageCount = mocks.getCount;
    createMessagesBulk = mocks.createBulk;
    withTransaction = mocks.transaction;
  },
}));
vi.mock("../../../src/store/summary-store.js", () => ({
  SummaryStore: class { appendContextMessages = mocks.append; getContextTokenCount = mocks.tokens; },
}));
vi.mock("../../../src/storage/index.js", () => ({
  createStorageBackendFactory: async () => ({
    openProject: async (...args: unknown[]) => {
      mocks.openProject(...args);
      mocks.getConnection();
      const repositories = {
        conversations: {
          getOrCreateConversation: mocks.getConversation,
          getMessageCount: mocks.getCount,
          createMessagesBulk: mocks.createBulk,
        },
        context: { appendContextMessages: mocks.append, getContextTokenCount: mocks.tokens },
        coordination: {
          getSessionIngest: async (sessionId: string) => {
            const row = mocks.sessionGet(sessionId);
            return row ? { sessionId, messageCount: row.message_count, completedAt: "now" } : null;
          },
        },
        redactionAdmin: { upsertCounts: vi.fn(async () => undefined) },
      };
      return {
        ...repositories,
        projectId: "pid",
        ...(mocks.nativeAvailable() ? { nativeTranscripts: { machineId: "local", repository: {} } } : {}),
        transaction: (operation: (value: typeof repositories) => Promise<unknown>) =>
          mocks.transaction(() => operation(repositories)),
        close: async () => { mocks.closeConnection(); },
      };
    },
    close: async () => undefined,
  }),
}));
vi.mock("../../../src/transcript-provider.js", () => ({
  normalizeTranscriptClient: mocks.normalize,
  parseTranscriptTextForClient: mocks.parse,
}));
vi.mock("../../../src/scrub.js", () => ({ ScrubEngine: { forProject: mocks.forProject, loadProjectPatterns: mocks.loadPatterns } }));
vi.mock("../../../src/storage/native-transcript-ingest.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../src/storage/native-transcript-ingest.js")>(),
  CLAUDE_NATIVE_TRANSCRIPT_FORMAT: { clientName: "claude-code" },
  CODEX_NATIVE_TRANSCRIPT_FORMAT: { clientName: "codex" },
  createExactNativeTranscriptMessageResolver: () => ({}),
  createFileNativeTranscriptSource: () => ({ openSnapshot: async () => { await mocks.snapshotOpen(); return ({
    metadata: { sizeBytes: 2, modifiedAtMs: 0, changedAtMs: 0 },
    stream: async function* () { yield await mocks.snapshotStream(); },
    digestPrefix: async () => "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
    assertUnchanged: mocks.snapshotAssert,
    assertByteRangesUnchanged: async () => undefined,
    close: mocks.snapshotClose,
  }); } }),
  runNativeTranscriptBackfill: mocks.nativeBackfill,
}));
vi.mock("../../../src/storage/local-transcript-quarantine.js", () => ({
  openLocalTranscriptQuarantine: () => ({ close: mocks.closeQuarantine }),
}));
vi.mock("../../../src/daemon/validate-cwd.js", () => ({ validateCwd: mocks.validate }));
vi.mock("../../../src/hooks/hook-errors.js", () => ({ safeLogError: mocks.logError }));

import { createIngestHandler } from "../../../src/daemon/routes/ingest.js";

const config = loadDaemonConfig("/tmp/ingest-boundaries");
const postgresqlConfig = {
  ...config,
  storage: {
    backend: "postgresql",
    postgresql: {
      url: "postgresql://user:secret@db.example/lcm",
      poolMax: 5,
      connectionTimeoutMs: 10_000,
      idleTimeoutMs: 30_000,
      statementTimeoutMs: 60_000,
    },
  },
} as const;
const response = {} as never;
const validMessage = { role: "user", content: "content", tokenCount: 2 };

describe("ingest persistence boundaries", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockClear();
    mocks.snapshotStream.mockReset().mockResolvedValue(Buffer.from("{}"));
    mocks.snapshotClose.mockReset().mockResolvedValue(undefined);
    mocks.snapshotAssert.mockReset().mockResolvedValue(undefined);
    mocks.snapshotOpen.mockReset().mockResolvedValue(undefined);
    mocks.getConnection.mockReturnValue(db);
    mocks.exists.mockReturnValue(true);
    mocks.read.mockReturnValue("{}");
    mocks.readMetadata.mockReturnValue("{}");
    mocks.writeMetadata.mockImplementation(() => undefined);
    mocks.closeMetadataDirectory.mockImplementation(() => undefined);
    mocks.openMetadataDirectory.mockImplementation(() => ({
      fd: 1,
      witness: { mode: 0o700, uid: 0, gid: 0, nlink: "1", dev: "1", ino: "1" },
      close: mocks.closeMetadataDirectory,
    }));
    mocks.sessionGet.mockReturnValue(undefined);
    mocks.validate.mockImplementation((cwd: string) => cwd);
    mocks.safeTranscript.mockImplementation((path: string) => path);
    mocks.getConversation.mockResolvedValue({ conversationId: 1 });
    mocks.getCount.mockResolvedValue(0);
    mocks.createBulk.mockImplementation(async (inputs: unknown[]) => inputs.map((_, index) => ({ messageId: index + 1 })));
    mocks.transaction.mockImplementation(async (operation: () => unknown) => operation());
    mocks.tokens.mockResolvedValue(7);
    mocks.parse.mockReset().mockReturnValue([]);
    mocks.normalize.mockImplementation((client: unknown) => client ?? "claude");
    mocks.scrubCounts.mockImplementation((content: string) => ({ text: content, gitleaks: 0, builtIn: 0, global: 0, project: 0 }));
    mocks.forProject.mockImplementation(async () => ({ scrubWithCounts: mocks.scrubCounts }));
    mocks.identity.mockImplementation((cwd: string) => ({
      id: "pid",
      localProjectId: "pid",
      canonical: cwd,
      machineId: "machine-id",
      selectedPath: cwd,
    }));
    mocks.ensureProjectForIdentity.mockImplementation(identity => `/lcm/projects/${identity.id}`);
    mocks.pathsForIdentity.mockImplementation(identity => ({
      ...identity,
      dir: `/lcm/projects/${identity.id}`,
      dbPath: `/lcm/projects/${identity.id}/db.sqlite`,
      metaPath: `/lcm/projects/${identity.id}/meta.json`,
    }));
  });

  for (const client of ["claude", "codex"] as const) {
    for (const outcome of ["success", "admission", "identity"] as const) {
      it(`${client} prepares both attempts outside admission and handles ${outcome}`, async () => {
        const { NativeTranscriptSourceChangedError } = await import("../../../src/storage/native-transcript-ingest.js");
        const { BackendPublicationJournalError } = await import("../../../src/storage/backend-publication.js");
        mocks.parse.mockReturnValue([validMessage]);
        mocks.nativeBackfill.mockRejectedValueOnce(new NativeTranscriptSourceChangedError());
        let admitted = false;
        let attempts = 0;
        let preparations = 0;
        mocks.forProject.mockImplementation(async () => {
          expect(admitted).toBe(false);
          expect(mocks.closeConnection).toHaveBeenCalledTimes(preparations);
          preparations++;
          return { scrubWithCounts: mocks.scrubCounts };
        });
        const identity = mocks.identity("/ok");
        mocks.identity.mockClear();
        if (outcome === "identity") {
          mocks.identity.mockReturnValueOnce(identity).mockReturnValueOnce(identity)
            .mockReturnValueOnce({ ...identity, canonical: "/changed" });
        }
        const admission = async (operation: (token: object) => Promise<unknown>) => {
          expect(preparations).toBe(++attempts);
          if (attempts === 2 && outcome === "admission") {
            throw new BackendPublicationJournalError("unexpected-state", "synthetic blocked publication");
          }
          admitted = true;
          try { return await operation({}); } finally { admitted = false; }
        };
        await createIngestHandler(config)({} as never, response, JSON.stringify({
          client, session_id: "native-admission", cwd: "/ok", transcript_path: "/safe",
        }), { withPublicationAdmission: admission });
        expect(preparations).toBe(2);
        expect(mocks.snapshotOpen).toHaveBeenCalledTimes(2);
        expect(mocks.snapshotClose).toHaveBeenCalledTimes(2);
        expect(mocks.logError).not.toHaveBeenCalled();
        if (outcome === "success") {
          expect(mocks.send).toHaveBeenLastCalledWith(response, 200, { ingested: 2, totalTokens: 7 });
          expect(mocks.createBulk).toHaveBeenCalledTimes(2);
          expect(mocks.closeConnection).toHaveBeenCalledTimes(2);
        } else {
          expect(mocks.send).toHaveBeenLastCalledWith(response, 503, {
            status: "blocked", error: "backend publication admission blocked",
          });
          expect(mocks.createBulk).toHaveBeenCalledOnce();
          expect(mocks.nativeBackfill).toHaveBeenCalledOnce();
          expect(mocks.closeConnection).toHaveBeenCalledOnce();
        }
      });
    }
  }

  it("prepares an appended parsed message outside the second admission after metadata-only input", async () => {
    const { NativeTranscriptSourceChangedError } = await import("../../../src/storage/native-transcript-ingest.js");
    mocks.parse.mockReturnValueOnce([]).mockReturnValueOnce([validMessage]);
    mocks.nativeBackfill.mockRejectedValueOnce(new NativeTranscriptSourceChangedError());
    let admitted = false;
    let attempts = 0;
    mocks.forProject.mockImplementationOnce(async () => {
      expect(admitted).toBe(false);
      expect(attempts).toBe(1);
      expect(mocks.closeConnection).toHaveBeenCalledOnce();
      return { scrubWithCounts: mocks.scrubCounts };
    });
    const admission = async (operation: (token: object) => Promise<unknown>) => {
      attempts++;
      admitted = true;
      try { return await operation({}); } finally { admitted = false; }
    };
    await createIngestHandler(config)({} as never, response, JSON.stringify({
      session_id: "metadata-append", cwd: "/ok", transcript_path: "/safe",
    }), { withPublicationAdmission: admission });
    expect(attempts).toBe(2);
    expect(mocks.forProject).toHaveBeenCalledOnce();
    expect(mocks.createBulk).toHaveBeenCalledOnce();
    expect(mocks.snapshotClose).toHaveBeenCalledTimes(2);
    expect(mocks.send).toHaveBeenLastCalledWith(response, 200, { ingested: 1, totalTokens: 7 });
  });

  it("closes its prepared source without writes when first publication admission blocks", async () => {
    const { BackendPublicationJournalError } = await import("../../../src/storage/backend-publication.js");
    mocks.parse.mockReturnValue([validMessage]);
    const admission = async () => {
      expect(mocks.forProject).toHaveBeenCalledOnce();
      throw new BackendPublicationJournalError("unexpected-state", "synthetic malformed publication journal");
    };
    await createIngestHandler(config)({} as never, response, JSON.stringify({
      session_id: "blocked-prepared", cwd: "/ok", transcript_path: "/safe",
    }), { withPublicationAdmission: admission });
    expect(mocks.getConnection).not.toHaveBeenCalled();
    expect(mocks.createBulk).not.toHaveBeenCalled();
    expect(mocks.nativeBackfill).not.toHaveBeenCalled();
    expect(mocks.snapshotClose).toHaveBeenCalledOnce();
    expect(mocks.send).toHaveBeenLastCalledWith(response, 503, {
      status: "blocked", error: "backend publication admission blocked",
    });
  });

  for (const boundary of ["preparation", "admission", "open"] as const) {
    it(`closes its prepared source once on ${boundary} cancellation`, async () => {
      const controller = new AbortController();
      mocks.parse.mockReturnValue([validMessage]);
      if (boundary === "preparation") mocks.forProject.mockImplementationOnce(async () => {
        controller.abort();
        return { scrubWithCounts: mocks.scrubCounts };
      });
      if (boundary === "open") mocks.getConnection.mockImplementationOnce(() => {
        controller.abort();
        return db;
      });
      const admission = async (operation: (token: object) => Promise<unknown>) => {
        if (boundary === "admission") controller.abort();
        return operation({});
      };
      await createIngestHandler(config)({} as never, response, JSON.stringify({
        session_id: "prepare-cancel", cwd: "/ok", transcript_path: "/safe",
      }), { signal: controller.signal, withPublicationAdmission: admission });
      expect(mocks.snapshotOpen).toHaveBeenCalledOnce();
      expect(mocks.snapshotClose).toHaveBeenCalledOnce();
      expect(mocks.createBulk).not.toHaveBeenCalled();
      expect(mocks.logError).not.toHaveBeenCalled();
      expect(mocks.send).toHaveBeenLastCalledWith(response, 499, { status: "cancelled", error: "ingest cancelled" });
    });
  }

  for (const cleanup of ["source", "quarantine", "clean"] as const) {
    it(`handles retryable source mutation with ${cleanup} cleanup`, async () => {
      const { NativeTranscriptSourceChangedError } = await import("../../../src/storage/native-transcript-ingest.js");
      const primary = new NativeTranscriptSourceChangedError();
      const cleanupFailure = new Error("synthetic cleanup failure");
      mocks.nativeBackfill.mockRejectedValueOnce(primary);
      if (cleanup === "source") mocks.snapshotClose.mockRejectedValueOnce(cleanupFailure);
      // Boundary consistency control: production quarantine close currently suppresses DB close errors.
      if (cleanup === "quarantine") mocks.closeQuarantine.mockRejectedValueOnce(cleanupFailure);
      await createIngestHandler(config)({} as never, response, JSON.stringify({
        session_id: "retry-cleanup", cwd: "/ok", transcript_path: "/safe",
      }));
      const attempts = cleanup === "clean" ? 2 : 1;
      expect(mocks.snapshotOpen).toHaveBeenCalledTimes(attempts);
      expect(mocks.snapshotClose).toHaveBeenCalledTimes(attempts);
      expect(mocks.closeQuarantine).toHaveBeenCalledTimes(attempts);
      expect(mocks.nativeBackfill).toHaveBeenCalledTimes(attempts);
      expect(mocks.closeConnection).toHaveBeenCalledTimes(attempts);
      if (cleanup === "clean") {
        expect(mocks.send).toHaveBeenLastCalledWith(response, 200, { ingested: 0, totalTokens: 0 });
        expect(mocks.logError).not.toHaveBeenCalled();
      } else {
        expect(mocks.send).toHaveBeenLastCalledWith(response, 500, { error: "ingest failed", code: "INGEST_FAILED" });
        expect(mocks.logError).toHaveBeenCalledOnce();
        const failure = mocks.logError.mock.calls[0]![1] as AggregateError;
        expect(failure).toBeInstanceOf(AggregateError);
        expect(failure.errors).toEqual([primary, cleanupFailure]);
        expect(failure.cause).toBe(primary);
        expect(failure.message).toBe(`Native ingest ${cleanup} cleanup failed`);
      }
    });
  }

  for (const cleanup of ["source", "quarantine"] as const) {
    it(`preserves terminal mutation over ${cleanup} cleanup failure`, async () => {
      const { NativeTranscriptSourceChangedError } = await import("../../../src/storage/native-transcript-ingest.js");
      const primary = new NativeTranscriptSourceChangedError();
      mocks.nativeBackfill.mockRejectedValueOnce(primary).mockRejectedValueOnce(primary);
      const close = cleanup === "source" ? mocks.snapshotClose : mocks.closeQuarantine;
      close.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("terminal cleanup failure"));
      await createIngestHandler(config)({} as never, response, JSON.stringify({
        session_id: "terminal-cleanup", cwd: "/ok", transcript_path: "/safe",
      }));
      expect(mocks.snapshotOpen).toHaveBeenCalledTimes(2);
      expect(mocks.snapshotClose).toHaveBeenCalledTimes(2);
      expect(mocks.closeQuarantine).toHaveBeenCalledTimes(2);
      expect(mocks.logError).toHaveBeenCalledExactlyOnceWith("ingest", primary, expect.anything());
      expect(mocks.send).toHaveBeenLastCalledWith(response, 500, { error: "ingest failed", code: "INGEST_FAILED" });
    });
  }

  it("does not turn cancelled mutation into a quarantine cleanup retry", async () => {
    const { NativeTranscriptSourceChangedError } = await import("../../../src/storage/native-transcript-ingest.js");
    const controller = new AbortController();
    mocks.nativeBackfill.mockImplementationOnce(async () => {
      controller.abort();
      throw new NativeTranscriptSourceChangedError();
    });
    mocks.closeQuarantine.mockRejectedValueOnce(new Error("cancelled cleanup failure"));
    await createIngestHandler(config)({} as never, response, JSON.stringify({
      session_id: "cancel-cleanup", cwd: "/ok", transcript_path: "/safe",
    }), { signal: controller.signal });
    expect(mocks.snapshotOpen).toHaveBeenCalledOnce();
    expect(mocks.snapshotClose).toHaveBeenCalledOnce();
    expect(mocks.closeQuarantine).toHaveBeenCalledOnce();
    expect(mocks.logError).not.toHaveBeenCalled();
    expect(mocks.send).toHaveBeenLastCalledWith(response, 499, { status: "cancelled", error: "ingest cancelled" });
  });

  for (const boundary of ["open", "read", "stream", "parser", "scrubber", "native", "close"] as const) {
    it(`preserves the primary ${boundary} failure and closes the bound source`, async () => {
      const primary = new Error(`${boundary} failure`);
      mocks.parse.mockReturnValue([validMessage]);
      if (boundary === "open") mocks.snapshotOpen.mockRejectedValueOnce(primary);
      if (boundary === "stream") mocks.snapshotStream.mockRejectedValueOnce(primary);
      if (boundary === "read") mocks.snapshotAssert.mockRejectedValueOnce(primary);
      if (boundary === "parser") mocks.parse.mockImplementationOnce(() => { throw primary; });
      if (boundary === "scrubber") mocks.forProject.mockRejectedValueOnce(primary);
      if (boundary === "native") mocks.nativeBackfill.mockRejectedValueOnce(primary);
      mocks.snapshotClose.mockRejectedValueOnce(boundary === "close" ? primary : new Error("cleanup failure"));
      await createIngestHandler(config)({} as never, response, JSON.stringify({ session_id: "failure", cwd: "/ok", transcript_path: "/safe" }));
      expect(mocks.send).toHaveBeenLastCalledWith(response, 500, { error: "ingest failed", code: "INGEST_FAILED" });
      expect(mocks.logError).toHaveBeenCalledWith("ingest", primary, expect.anything());
      expect(mocks.snapshotClose).toHaveBeenCalledTimes(boundary === "open" ? 0 : 1);
      expect(mocks.snapshotOpen).toHaveBeenCalledTimes(1);
    });
  }

  it("does not retry mutation before a trustworthy source witness exists", async () => {
    const { NativeTranscriptSourceChangedError } = await import("../../../src/storage/native-transcript-ingest.js");
    const primary = new NativeTranscriptSourceChangedError();
    mocks.snapshotAssert.mockRejectedValueOnce(primary);
    await createIngestHandler(config)({} as never, response, JSON.stringify({ session_id: "early-mutation", cwd: "/ok", transcript_path: "/safe" }));
    expect(mocks.snapshotOpen).toHaveBeenCalledTimes(1);
    expect(mocks.snapshotClose).toHaveBeenCalledTimes(1);
    expect(mocks.createBulk).not.toHaveBeenCalled();
    expect(mocks.logError).toHaveBeenCalledWith("ingest", primary, expect.anything());
  });

  it("cancels after source mutation without starting another attempt", async () => {
    const { NativeTranscriptSourceChangedError } = await import("../../../src/storage/native-transcript-ingest.js");
    const controller = new AbortController();
    mocks.snapshotAssert.mockImplementationOnce(async () => {
      controller.abort();
      throw new NativeTranscriptSourceChangedError();
    });
    await createIngestHandler(config)({} as never, response, JSON.stringify({ session_id: "cancel", cwd: "/ok", transcript_path: "/safe" }), { signal: controller.signal });
    expect(mocks.send).toHaveBeenLastCalledWith(response, 499, { status: "cancelled", error: "ingest cancelled" });
    expect(mocks.snapshotOpen).toHaveBeenCalledTimes(1);
    expect(mocks.snapshotClose).toHaveBeenCalledTimes(1);
    expect(mocks.logError).not.toHaveBeenCalled();
  });

  it("preserves an ordinary failure even when cancellation coincides", async () => {
    const controller = new AbortController();
    const primary = new Error("storage failure");
    mocks.nativeBackfill.mockImplementationOnce(async () => { controller.abort(); throw primary; });
    await createIngestHandler(config)({} as never, response, JSON.stringify({ session_id: "cancel", cwd: "/ok", transcript_path: "/safe" }), { signal: controller.signal });
    expect(mocks.send).toHaveBeenLastCalledWith(response, 500, { error: "ingest failed", code: "INGEST_FAILED" });
    expect(mocks.logError).toHaveBeenCalledWith("ingest", primary, expect.anything());
  });

  for (const state of [{}, { headersSent: true }, { writableEnded: true }, { destroyed: true }, { writable: false }]) {
    it(`handles cancellation before opening with response state ${JSON.stringify(state)}`, async () => {
      const controller = new AbortController();
      controller.abort();
      await createIngestHandler(config)({} as never, state as never, JSON.stringify({ session_id: "cancel", cwd: "/ok", transcript_path: "/safe" }), { signal: controller.signal });
      expect(mocks.getConnection).not.toHaveBeenCalled();
      expect(mocks.snapshotOpen).not.toHaveBeenCalled();
      expect(mocks.logError).not.toHaveBeenCalled();
      if (Object.keys(state).length === 0) expect(mocks.send).toHaveBeenCalledWith(state, 499, { status: "cancelled", error: "ingest cancelled" });
      else expect(mocks.send).not.toHaveBeenCalled();
    });
  }

  it("uses default native patterns when no security configuration is supplied", async () => {
    mocks.parse.mockReturnValueOnce([validMessage]);
    await createIngestHandler({ ...config, security: undefined })({} as never, response,
      JSON.stringify({ session_id: "native-defaults", cwd: "/ok", transcript_path: "/safe" }));
    expect(mocks.send).toHaveBeenLastCalledWith(response, 200, { ingested: 1, totalTokens: 7 });
  });

  it("refuses native imports when the selected backend has no native capability", async () => {
    mocks.nativeAvailable.mockReturnValueOnce(false);
    mocks.parse.mockReturnValueOnce([validMessage]);
    await createIngestHandler(config)({} as never, response, JSON.stringify({ session_id: "native", cwd: "/ok", transcript_path: "/safe" }));
    expect(mocks.send).toHaveBeenLastCalledWith(response, 500, { error: "ingest failed", code: "INGEST_FAILED" });
    expect(mocks.createBulk).not.toHaveBeenCalled();
  });

  it("does not acknowledge raw backfill failure and preserves it if cleanup also fails", async () => {
    const failure = new Error("raw persistence failure");
    mocks.nativeBackfill.mockRejectedValueOnce(failure);
    mocks.closeQuarantine.mockRejectedValueOnce(new Error("cleanup failure"));
    mocks.parse.mockReturnValueOnce([validMessage]);
    await createIngestHandler(config)({} as never, response, JSON.stringify({ session_id: "native", cwd: "/ok", transcript_path: "/safe" }));
    expect(mocks.send).toHaveBeenLastCalledWith(response, 500, { error: "ingest failed", code: "INGEST_FAILED" });
    expect(mocks.logError).toHaveBeenLastCalledWith("ingest", failure, { cwd: "/ok", sessionId: "native" });
  });

  it("archives metadata-only input and fails a successful backfill whose cleanup fails", async () => {
    mocks.parse.mockReset().mockReturnValue([]);
    mocks.closeQuarantine.mockRejectedValueOnce(new Error("cleanup failure"));
    await createIngestHandler(config)({} as never, response, JSON.stringify({ session_id: "native", cwd: "/ok", transcript_path: "/safe" }));
    expect(mocks.send).toHaveBeenLastCalledWith(response, 500, { error: "ingest failed", code: "INGEST_FAILED" });
    expect(mocks.createBulk).not.toHaveBeenCalled();
    await createIngestHandler(config)({} as never, response, JSON.stringify({ session_id: "native", cwd: "/ok", transcript_path: "/safe" }));
    expect(mocks.send).toHaveBeenLastCalledWith(response, 200, { ingested: 0, totalTokens: 0 });
  });

  it("validates required fields and typed cwd failures", async () => {
    const handler = createIngestHandler(config);
    for (const invalidBody of [null, [], "invalid"]) {
      await handler({} as never, response, JSON.stringify(invalidBody));
      expect(mocks.send).toHaveBeenLastCalledWith(response, 400, {
        error: "invalid request body",
      });
    }
    await handler({} as never, response, "");
    expect(mocks.send).toHaveBeenLastCalledWith(response, 400, { error: "session_id and cwd are required" });
    mocks.validate.mockImplementationOnce(() => { throw new Error("bad cwd"); });
    await handler({} as never, response, JSON.stringify({ session_id: "s", cwd: "/bad", messages: [validMessage] }));
    expect(mocks.send).toHaveBeenLastCalledWith(response, 400, { error: "bad cwd" });
    mocks.validate.mockImplementationOnce(() => { throw "failure"; });
    await handler({} as never, response, JSON.stringify({ session_id: "s", cwd: "/bad", messages: [validMessage] }));
    expect(mocks.send).toHaveBeenLastCalledWith(response, 400, { error: "invalid cwd" });
  });

  it("filters malformed messages and handles empty transcript paths", async () => {
    const handler = createIngestHandler(config);
    await handler({} as never, response, JSON.stringify({ session_id: "empty", cwd: "/ok" }));
    expect(mocks.send).toHaveBeenLastCalledWith(response, 200, { ingested: 0, totalTokens: 0 });
    await handler({} as never, response, JSON.stringify({
      session_id: "s", cwd: "/ok",
      messages: [null, "x", {}, { role: "bad", content: "x", tokenCount: 1 },
        { role: "user", content: 1, tokenCount: 1 }, { role: "user", content: "x", tokenCount: "1" }],
    }));
    expect(mocks.send).toHaveBeenLastCalledWith(response, 200, { ingested: 0, totalTokens: 0 });
    mocks.safeTranscript.mockReturnValueOnce("");
    await handler({} as never, response, JSON.stringify({ session_id: "s", cwd: "/ok", transcript_path: "/unsafe" }));
    mocks.safeTranscript.mockReturnValueOnce("/missing");
    mocks.exists.mockReturnValueOnce(false);
    await handler({} as never, response, JSON.stringify({ session_id: "s", cwd: "/ok", transcript_path: "/missing" }));
    expect(mocks.parse).not.toHaveBeenCalled();
  });

  it("parses transcripts through client, provider, and default precedence", async () => {
    const handler = createIngestHandler(config);
    for (const input of [
      { client: "codex", provider: "ignored" },
      { provider: "codex" },
      {},
    ]) {
      mocks.parse.mockReturnValueOnce([validMessage]);
      await handler({} as never, response, JSON.stringify({ session_id: String(Math.random()), cwd: "/ok", transcript_path: "/safe", ...input }));
    }
    expect(mocks.normalize.mock.calls.map((call) => call[0])).toEqual(["codex", "codex", undefined]);
  });

  it("skips completed sessions and rolls back when coordination lookup fails", async () => {
    const handler = createIngestHandler(config);
    mocks.sessionGet.mockReturnValueOnce({ message_count: 1 });
    await handler({} as never, response, JSON.stringify({ session_id: "complete", cwd: "/ok", messages: [validMessage] }));
    expect(mocks.send).toHaveBeenLastCalledWith(response, 200, { ingested: 0, totalTokens: 0 });
    const failure = new Error("coordination failed");
    mocks.sessionGet.mockImplementationOnce(() => { throw failure; });
    await handler({} as never, response, JSON.stringify({ session_id: "failed", cwd: "/ok", messages: [validMessage] }));
    expect(mocks.send).toHaveBeenLastCalledWith(response, 500, { error: "ingest failed", code: "INGEST_FAILED" });
    expect(mocks.getConversation).not.toHaveBeenCalled();
    expect(mocks.createBulk).not.toHaveBeenCalled();
    expect(mocks.logError).toHaveBeenLastCalledWith("ingest", failure, { cwd: "/ok", sessionId: "failed" });
  });

  it("reports every redaction category and tolerates metadata write failures", async () => {
    const noSecurityConfig = { ...config, security: undefined };
    const handler = createIngestHandler(noSecurityConfig);
    mocks.scrubCounts.mockReturnValueOnce({ text: "redacted", gitleaks: 1, builtIn: 2, global: 3, project: 4 });
    mocks.readMetadata.mockReturnValueOnce(JSON.stringify({ existing: true }));
    await handler({} as never, response, JSON.stringify({ session_id: "redacted", cwd: "/ok", messages: [validMessage] }));
    expect(mocks.send).toHaveBeenLastCalledWith(response, 200, {
      ingested: 1,
      totalTokens: 7,
      redacted: 10,
      redactedCategories: ["gitleaks", "built_in", "global", "project"],
    });
    mocks.readMetadata.mockImplementationOnce(() => { throw new Error("metadata failed"); });
    await handler({} as never, response, JSON.stringify({ session_id: "metadata-failure", cwd: "/ok", messages: [validMessage] }));
    expect(mocks.send).toHaveBeenLastCalledWith(response, 200, { ingested: 1, totalTokens: 7 });
    mocks.readMetadata.mockImplementationOnce(() => {
      throw Object.assign(new Error("missing metadata"), { code: "ENOENT" });
    });
    await handler({} as never, response, JSON.stringify({ session_id: "metadata-absent", cwd: "/ok", messages: [validMessage] }));
    expect(mocks.send).toHaveBeenLastCalledWith(response, 200, { ingested: 1, totalTokens: 7 });
    expect(mocks.writeMetadata).toHaveBeenCalledTimes(2);
  });

  it("publishes bounded private metadata after a persisted ingest", async () => {
    mocks.readMetadata.mockReturnValueOnce(JSON.stringify({ retained: true, lastCompact: "old" }));

    await createIngestHandler(config)(
      {} as never,
      response,
      JSON.stringify({ session_id: "private-meta", cwd: "/ok", messages: [validMessage] }),
    );

    expect(mocks.ensureProjectForIdentity).toHaveBeenCalledWith(
      expect.objectContaining({ id: "pid", canonical: "/ok" }),
    );
    expect(mocks.readMetadata).toHaveBeenCalledWith("/lcm/projects/pid/meta.json", {
      allowedRoot: "/lcm/projects/pid",
      maxBytes: 1024 * 1024,
      expectedUid: process.getuid?.(),
      requireSingleLink: true,
    });
    expect(mocks.openMetadataDirectory).toHaveBeenCalledWith("/lcm/projects/pid", {
      expectedUid: process.getuid?.(),
    });
    expect(mocks.writeMetadata).toHaveBeenCalledOnce();
    const [path, serialized, options, parent] = mocks.writeMetadata.mock.calls[0] as [
      string,
      string,
      Record<string, never>,
      unknown,
    ];
    expect(path).toBe("/lcm/projects/pid/meta.json");
    expect(options).toEqual({});
    expect(parent).toEqual(expect.objectContaining({ fd: 1 }));
    expect(JSON.parse(serialized)).toMatchObject({
      retained: true,
      lastCompact: "old",
      cwd: "/ok",
      lastIngest: expect.any(String),
    });
    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(1024 * 1024);
    expect(mocks.closeMetadataDirectory).toHaveBeenCalledOnce();
  });

  it.each([
    ["malformed JSON", "{"],
    ["null", "null"],
    ["array", "[]"],
    ["primitive", "42"],
  ])("preserves %s metadata and keeps ingest successful", async (_label, content) => {
    mocks.readMetadata.mockReturnValueOnce(content);

    await createIngestHandler(config)(
      {} as never,
      response,
      JSON.stringify({ session_id: `invalid-${_label}`, cwd: "/ok", messages: [validMessage] }),
    );

    expect(mocks.writeMetadata).not.toHaveBeenCalled();
    expect(mocks.openMetadataDirectory).not.toHaveBeenCalled();
    expect(mocks.send).toHaveBeenLastCalledWith(response, 200, { ingested: 1, totalTokens: 7 });
  });

  it("preserves rejected and oversized input metadata", async () => {
    for (const error of [
      new Error("metadata owner or topology is not trusted"),
      new Error("file exceeds the configured size limit"),
    ]) {
      mocks.readMetadata.mockImplementationOnce(() => { throw error; });
      await createIngestHandler(config)(
        {} as never,
        response,
        JSON.stringify({ session_id: error.message, cwd: "/ok", messages: [validMessage] }),
      );
    }

    expect(mocks.writeMetadata).not.toHaveBeenCalled();
    expect(mocks.send).toHaveBeenLastCalledWith(response, 200, { ingested: 1, totalTokens: 7 });
  });

  it("bounds serialized metadata, closes the parent, and keeps failures best-effort", async () => {
    mocks.readMetadata.mockReturnValueOnce(JSON.stringify({ retained: "é".repeat(524_288) }));
    await createIngestHandler(config)(
      {} as never,
      response,
      JSON.stringify({ session_id: "expanded-output", cwd: "/ok", messages: [validMessage] }),
    );
    expect(mocks.writeMetadata).not.toHaveBeenCalled();

    mocks.writeMetadata.mockImplementationOnce(() => { throw new Error("atomic publication failed"); });
    mocks.closeMetadataDirectory.mockImplementationOnce(() => { throw new Error("close failed"); });
    await createIngestHandler(config)(
      {} as never,
      response,
      JSON.stringify({ session_id: "write-close", cwd: "/ok", messages: [validMessage] }),
    );
    expect(mocks.writeMetadata).toHaveBeenCalledOnce();
    expect(mocks.closeMetadataDirectory).toHaveBeenCalledOnce();
    expect(mocks.send).toHaveBeenLastCalledWith(response, 200, { ingested: 1, totalTokens: 7 });
  });

  it("keeps ingest successful when metadata directory cleanup alone fails", async () => {
    mocks.closeMetadataDirectory.mockImplementationOnce(() => { throw new Error("close failed"); });

    await createIngestHandler(config)(
      {} as never,
      response,
      JSON.stringify({ session_id: "close-only", cwd: "/ok", messages: [validMessage] }),
    );

    expect(mocks.writeMetadata).toHaveBeenCalledOnce();
    expect(mocks.closeMetadataDirectory).toHaveBeenCalledOnce();
    expect(mocks.send).toHaveBeenLastCalledWith(response, 200, { ingested: 1, totalTokens: 7 });
  });

  it("keeps ingest successful when only the metadata writer fails", async () => {
    mocks.writeMetadata.mockImplementationOnce(() => { throw new Error("atomic publication failed"); });

    await createIngestHandler(config)(
      {} as never,
      response,
      JSON.stringify({ session_id: "write-only", cwd: "/ok", messages: [validMessage] }),
    );

    expect(mocks.writeMetadata).toHaveBeenCalledOnce();
    expect(mocks.closeMetadataDirectory).toHaveBeenCalledOnce();
    expect(mocks.send).toHaveBeenLastCalledWith(response, 200, { ingested: 1, totalTokens: 7 });
  });

  it("accepts metadata at the exact byte limit when updated output stays bounded", async () => {
    const template = {
      retained: "",
      cwd: "/ok",
      lastIngest: "1970-01-01T00:00:00.000Z",
    };
    const fixedBytes = Buffer.byteLength(JSON.stringify(template, null, 2) + "\n", "utf8");
    template.retained = "x".repeat(1024 * 1024 - fixedBytes);
    const content = JSON.stringify(template, null, 2) + "\n";
    expect(Buffer.byteLength(content, "utf8")).toBe(1024 * 1024);
    mocks.readMetadata.mockReturnValueOnce(content);

    await createIngestHandler(config)(
      {} as never,
      response,
      JSON.stringify({ session_id: "exact-limit", cwd: "/ok", messages: [validMessage] }),
    );

    expect(mocks.writeMetadata).toHaveBeenCalledOnce();
    const serialized = mocks.writeMetadata.mock.calls[0]![1] as string;
    expect(Buffer.byteLength(serialized, "utf8")).toBe(1024 * 1024);
  });

  it("supports metadata publication without process.getuid", async () => {
    const originalGetuid = process.getuid;
    Object.defineProperty(process, "getuid", { configurable: true, value: undefined });
    try {
      await createIngestHandler(config)(
        {} as never,
        response,
        JSON.stringify({ session_id: "no-uid", cwd: "/ok", messages: [validMessage] }),
      );
    } finally {
      Object.defineProperty(process, "getuid", { configurable: true, value: originalGetuid });
    }
    expect(mocks.readMetadata).toHaveBeenCalledWith(
      "/lcm/projects/pid/meta.json",
      expect.objectContaining({ expectedUid: undefined }),
    );
  });

  it("returns a stable error without disclosing persistence details and releases connections", async () => {
    const handler = createIngestHandler(config);
    const failure = new Error("database password=hunter2");
    mocks.getConversation.mockRejectedValueOnce(failure);
    await handler({} as never, response, JSON.stringify({ session_id: "error", cwd: "/ok", messages: [validMessage] }));
    expect(mocks.send).toHaveBeenLastCalledWith(response, 500, { error: "ingest failed", code: "INGEST_FAILED" });
    expect(mocks.logError).toHaveBeenLastCalledWith("ingest", failure, { cwd: "/ok", sessionId: "error" });
    mocks.getConversation.mockRejectedValueOnce("failure");
    await handler({} as never, response, JSON.stringify({ session_id: "error-two", cwd: "/ok", messages: [validMessage] }));
    expect(mocks.send).toHaveBeenLastCalledWith(response, 500, { error: "ingest failed", code: "INGEST_FAILED" });
    expect(mocks.closeConnection).toHaveBeenCalledTimes(2);
  });

  it("fails PostgreSQL identity before creating local directories, scrubbers, or storage", async () => {
    const handler = createIngestHandler(postgresqlConfig);
    const failure = new MachineIdentityFileError(
      "machine identity is not registered",
      "Run `lcm machine register`.",
    );
    mocks.identity.mockImplementationOnce(() => { throw failure; });

    await handler({} as never, response, JSON.stringify({
      session_id: "unbound",
      cwd: "/ok",
      transcript_path: "/safe",
    }));

    expect(mocks.send).toHaveBeenLastCalledWith(response, 409, {
      code: "STORAGE_IDENTITY_REQUIRED",
      error: "Machine identity is unavailable. Run `lcm machine show` for recovery guidance.",
      storageBackend: "postgresql",
    });
    expect(mocks.ensureProject).not.toHaveBeenCalled();
    expect(mocks.forProject).not.toHaveBeenCalled();
    expect(mocks.getConnection).not.toHaveBeenCalled();
    expect(mocks.safeTranscript).not.toHaveBeenCalled();
    expect(mocks.exists).not.toHaveBeenCalled();
    expect(mocks.parse).not.toHaveBeenCalled();
    expect(mocks.logError).toHaveBeenLastCalledWith("ingest", failure, {
      cwd: "/ok",
      sessionId: "unbound",
    });
  });

  it("reports staged PostgreSQL after transcript discovery stays outside admission", async () => {
    const handler = createIngestHandler(
      postgresqlConfig,
      makeStagedPostgreSqlStorageFactory(),
    );
    await handler({} as never, response, JSON.stringify({
      session_id: "staged",
      cwd: "/ok",
      transcript_path: "/safe",
    }));

    expect(mocks.send).toHaveBeenLastCalledWith(response, 503, {
      code: "STORAGE_BACKEND_STAGED",
      error: "ingest is unavailable while PostgreSQL storage repositories are staged",
      storageBackend: "postgresql",
    });
    expect(mocks.safeTranscript).toHaveBeenCalled();
    expect(mocks.exists).toHaveBeenCalled();
    expect(mocks.parse).toHaveBeenCalledOnce();
    expect(mocks.snapshotClose).toHaveBeenCalledOnce();
  });

  it("reuses the admitted PostgreSQL project for non-empty ingestion", async () => {
    const factory = await createStorageBackendFactory(config.storage);
    const handler = createIngestHandler(postgresqlConfig, factory);
    await handler({} as never, response, JSON.stringify({
      session_id: "postgresql-ingest",
      cwd: "/ok",
      messages: [validMessage],
    }));

    expect(mocks.send).toHaveBeenLastCalledWith(response, 200, {
      ingested: 1,
      totalTokens: 7,
    });
    expect(mocks.getConnection).toHaveBeenCalledOnce();
    expect(mocks.ensureProjectForIdentity.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.getConnection.mock.invocationCallOrder[0]);
  });

  it("keeps PostgreSQL project identity after final publication fails and retry is a no-op", async () => {
    let metadata: Record<string, unknown> | undefined;
    mocks.ensureProjectForIdentity.mockImplementation((
      identity: { id: string; canonical: string },
      options?: { writeMetadata?: boolean },
    ) => {
      if (options?.writeMetadata !== false) metadata = { cwd: identity.canonical };
      return `/lcm/projects/${identity.id}`;
    });
    mocks.writeMetadata.mockImplementationOnce(() => {
      expect(metadata).toEqual({ cwd: "/ok" });
      throw new Error("atomic publication failed");
    });
    const factory = await createStorageBackendFactory(postgresqlConfig.storage);
    const handler = createIngestHandler(postgresqlConfig, factory);

    await handler({} as never, response, JSON.stringify({
      session_id: "postgresql-publication-retry",
      cwd: "/ok",
      messages: [validMessage],
    }));
    expect(mocks.send).toHaveBeenLastCalledWith(response, 200, {
      ingested: 1,
      totalTokens: 7,
    });
    expect(metadata).toEqual({ cwd: "/ok" });

    mocks.sessionGet.mockReturnValue({ message_count: 1 });
    await handler({} as never, response, JSON.stringify({
      session_id: "postgresql-publication-retry",
      cwd: "/ok",
      messages: [validMessage],
    }));

    expect(mocks.send).toHaveBeenLastCalledWith(response, 200, {
      ingested: 0,
      totalTokens: 0,
    });
    expect(metadata).toEqual({ cwd: "/ok" });
    expect(mocks.ensureProjectForIdentity.mock.calls).toEqual([
      [{ id: "pid", canonical: "/ok" }],
      [{ id: "pid", canonical: "/ok" }],
    ]);
    expect(mocks.writeMetadata).toHaveBeenCalledOnce();
  });

  it("keeps successful SQLite identity ahead of local persistence setup", async () => {
    const handler = createIngestHandler(config);
    await handler({} as never, response, JSON.stringify({
      session_id: "sqlite-order",
      cwd: "/ok",
      messages: [validMessage],
    }));

    expect(mocks.identity.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.ensureProjectForIdentity.mock.invocationCallOrder[0]);
    expect(mocks.ensureProjectForIdentity.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.forProject.mock.invocationCallOrder[0]);
    expect(mocks.forProject.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.getConnection.mock.invocationCallOrder[0]);
  });

  it("runs the selected repository batch inside operation-scoped admission and authenticates PostgreSQL no-ops", async () => {
    const admission = vi.fn(async (operation: (token: object) => Promise<unknown>) => operation({}));
    const signal = new AbortController().signal;
    const handler = createIngestHandler(postgresqlConfig);
    mocks.exists.mockReturnValueOnce(false);

    await handler({} as never, response, JSON.stringify({
      session_id: "postgresql-empty",
      cwd: "/ok",
      transcript_path: "/missing",
    }), { withPublicationAdmission: admission, signal });

    expect(admission).toHaveBeenCalledOnce();
    expect(mocks.send).toHaveBeenLastCalledWith(response, 200, { ingested: 0, totalTokens: 0 });
    expect(mocks.getConnection).toHaveBeenCalledOnce();
  });

  it("blocks live identity drift after selecting scrubber patterns from the preflight identity", async () => {
    const preflight = {
      id: "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9020",
      localProjectId: "local-hash-a",
      canonical: "/work/project",
      remoteProjectId: "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9020",
      machineId: "machine-id",
      selectedPath: "/work/project",
    };
    const live = {
      ...preflight,
      canonical: "/work/different",
    };
    mocks.identity.mockReturnValueOnce(preflight).mockReturnValueOnce(live);
    const order: string[] = [];
    mocks.forProject.mockImplementationOnce(async () => {
      order.push("scrubber");
      return { scrubWithCounts: mocks.scrubCounts };
    });
    const admission = vi.fn(async (operation: (token: object) => Promise<unknown>) => {
      order.push("admission");
      return operation({});
    });

    await createIngestHandler(config)(
      {} as never,
      response,
      JSON.stringify({ session_id: "drift", cwd: preflight.canonical, messages: [validMessage] }),
      { withPublicationAdmission: admission, signal: new AbortController().signal },
    );

    const localIdentity = {
      id: preflight.localProjectId,
      canonical: preflight.canonical,
      remoteProjectId: preflight.remoteProjectId,
    };
    expect(mocks.pathsForIdentity).toHaveBeenCalledWith(localIdentity);
    expect(mocks.ensureProjectForIdentity).toHaveBeenCalledWith(localIdentity);
    expect(mocks.forProject).toHaveBeenCalledWith(
      config.security.sensitivePatterns,
      `/lcm/projects/${preflight.localProjectId}`,
    );
    expect(order).toEqual(["scrubber", "admission"]);
    expect(mocks.send).toHaveBeenLastCalledWith(response, 503, {
      status: "blocked",
      error: "backend publication admission blocked",
    });
    expect(mocks.openProject).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.createBulk).not.toHaveBeenCalled();
    expect(mocks.logError).not.toHaveBeenCalled();
  });

  it("blocks PostgreSQL remote-only drift even when there are no messages", async () => {
    const preflight = {
      id: "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9020",
      localProjectId: "local-hash-empty",
      canonical: "/work/empty",
      remoteProjectId: "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9020",
      machineId: "machine-id",
      selectedPath: "/work/empty",
    };
    const live = {
      ...preflight,
      id: "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9021",
      remoteProjectId: "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9021",
    };
    mocks.identity.mockReturnValueOnce(preflight).mockReturnValueOnce(live);

    await createIngestHandler(postgresqlConfig)(
      {} as never,
      response,
      JSON.stringify({ session_id: "remote-drift-empty", cwd: preflight.canonical, messages: [] }),
      { withPublicationAdmission: operation => operation({}) },
    );

    expect(mocks.send).toHaveBeenLastCalledWith(response, 503, {
      status: "blocked",
      error: "backend publication admission blocked",
    });
    expect(mocks.openProject).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.logError).not.toHaveBeenCalled();
  });

  it("passes the matching preflight identity through the live storage open", async () => {
    const identity = {
      id: "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9020",
      localProjectId: "local-hash-same",
      canonical: "/work/same",
      remoteProjectId: "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9020",
      machineId: "machine-id",
      selectedPath: "/work/same",
    };
    mocks.identity.mockReturnValue(identity);

    await createIngestHandler(postgresqlConfig)(
      {} as never,
      response,
      JSON.stringify({ session_id: "same", cwd: identity.canonical, messages: [validMessage] }),
      { withPublicationAdmission: operation => operation({}) },
    );

    expect(mocks.openProject).toHaveBeenCalledWith(identity, expect.any(Object), expect.any(AbortSignal));
    expect(mocks.send).toHaveBeenLastCalledWith(response, 200, { ingested: 1, totalTokens: 7 });
  });
});
