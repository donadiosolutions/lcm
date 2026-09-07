import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadDaemonConfig } from "../../../src/daemon/config.js";
import { MachineIdentityFileError } from "../../../src/machine-identity.js";
import { createStorageBackendFactory } from "../../../src/storage/index.js";
import { makeStagedPostgreSqlStorageFactory } from "./mock-storage-factory.js";

const mocks = vi.hoisted(() => ({
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
  parseTranscriptForClient: mocks.parse,
}));
vi.mock("../../../src/scrub.js", () => ({ ScrubEngine: { forProject: mocks.forProject, loadProjectPatterns: mocks.loadPatterns } }));
vi.mock("../../../src/storage/native-transcript-ingest.js", () => ({
  CLAUDE_NATIVE_TRANSCRIPT_FORMAT: { clientName: "claude-code" },
  CODEX_NATIVE_TRANSCRIPT_FORMAT: { clientName: "codex" },
  createExactNativeTranscriptMessageResolver: () => ({}),
  createFileNativeTranscriptSource: () => ({}),
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
    mocks.parse.mockReturnValue([]);
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
    mocks.parse.mockReturnValue([]);
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
    expect(mocks.parse).toHaveBeenCalled();
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
