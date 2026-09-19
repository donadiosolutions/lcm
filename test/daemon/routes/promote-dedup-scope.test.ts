import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DaemonConfig, ResolvedStorageConfig } from "../../../src/daemon/config.js";
import { createPromoteHandler } from "../../../src/daemon/routes/promote.js";
import {
  recoverMachineIdentity,
  type MachineIdentity,
} from "../../../src/machine-identity.js";
import {
  clearProjectMapCache,
  resolveProjectIdentity,
  setRemoteProjectBinding,
} from "../../../src/project-map.js";
import type {
  ProjectStorage,
  StorageBackendFactory,
  TransactionRepositories,
} from "../../../src/storage/index.js";

const MACHINE_ID = "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9012";
const PROJECT_ID = "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9020";
const POSTGRESQL_STORAGE: ResolvedStorageConfig = {
  backend: "postgresql",
  postgresql: {
    url: "postgresql://user:secret@db.example/lcm",
    poolMax: 5,
    connectionTimeoutMs: 10_000,
    idleTimeoutMs: 30_000,
    statementTimeoutMs: 60_000,
  },
};

/** Content that carries no searchable terms, so ranked search cannot recall it. */
const PUNCTUATION_ONLY = "!!! ??? --- ### @@@ %%% &&& decided";

function makeConfig(): DaemonConfig {
  return {
    version: 1,
    storage: POSTGRESQL_STORAGE,
    compaction: {
      leafTokens: 1000,
      maxDepth: 5,
      autoCompactMinTokens: 10000,
      promotionThresholds: {
        minDepth: 1,
        compressionRatio: 0.9,
        keywords: { decision: ["decided"] },
        architecturePatterns: [],
        dedupBm25Threshold: 15,
        dedupCandidateLimit: 3,
      },
    },
    security: { sensitivePatterns: [] },
  } as unknown as DaemonConfig;
}

function mockRes() {
  let body = "";
  const res = {
    writeHead: vi.fn().mockReturnThis(),
    end: vi.fn((data?: string) => { body = data ?? ""; }),
  };
  return { res: res as never, getBody: () => JSON.parse(body || "{}") as Record<string, unknown> };
}

// #1390: the route must reach the digest-backed exact lookup on PostgreSQL.
// The repositories here are fakes; the deduplication helper is the real one,
// so a call to findExactContent can only come from the route supplying the
// owner scope and backend it previously omitted.
describe("promote route deduplication scope", () => {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  let home: string;
  let cwd: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "lcm-promote-dedup-scope-"));
    cwd = join(home, "project");
    mkdirSync(cwd);
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    clearProjectMapCache();
    const machine: MachineIdentity = {
      version: 1,
      identityKey: `machine:${"a".repeat(64)}`,
      machineId: MACHINE_ID,
      displayName: "Machine A",
    };
    recoverMachineIdentity(machine, { homeDir: home });
    setRemoteProjectBinding(PROJECT_ID, { hash: resolveProjectIdentity(cwd).id });
  });

  afterEach(() => {
    clearProjectMapCache();
    vi.restoreAllMocks();
    rmSync(home, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
  });

  function makeProject(exact: Awaited<ReturnType<TransactionRepositories["promotedMemory"]["findExactContent"]>>) {
    const searchPromoted = vi.fn(async () => []);
    const findExactContent = vi.fn(async () => exact);
    const insert = vi.fn(async () => "fresh-id");
    const update = vi.fn(async () => undefined);
    const archive = vi.fn(async () => undefined);
    const serializeDecision = vi.fn(async () => undefined);
    const repositories = {
      lexicalSearch: { searchPromoted },
      promotedMemory: { findExactContent, insert, update, archive },
      promotedDecisionSerializer: { serializeDecision },
    } as unknown as TransactionRepositories;
    const project = {
      backend: "postgresql",
      projectId: PROJECT_ID,
      conversations: {
        listConversations: vi.fn(async () => [{ conversationId: 1, sessionId: "session-a" }]),
      },
      summaries: {
        getSummariesByConversation: vi.fn(async () => [{
          content: PUNCTUATION_ONLY,
          depth: 2,
          tokenCount: 10,
          sourceMessageTokenCount: 500,
        }]),
      },
      promotedMemory: { listContentPrefixes: vi.fn(async () => []) },
      transaction: vi.fn(async <T>(callback: (repositories: TransactionRepositories) => Promise<T>) =>
        callback(repositories)),
      close: vi.fn(async () => undefined),
    } as unknown as ProjectStorage;
    const factory = {
      backend: "postgresql",
      capabilities: {
        transactions: true,
        lexicalSearch: true,
        regexSearch: true,
        nativeFullTextSearch: "available",
        coordination: "distributed",
      },
      projectExists: vi.fn(async () => true),
      openExistingProject: vi.fn(async () => project),
      openProject: vi.fn(async () => project),
      health: vi.fn(async () => ({ status: "healthy", backend: "postgresql" })),
      close: vi.fn(async () => undefined),
    } as unknown as StorageBackendFactory;
    return { factory, searchPromoted, findExactContent, insert, update, archive, serializeDecision };
  }

  it("merges into the exact owner-scoped match that lexical search cannot recall", async () => {
    const existing = {
      id: "existing-id",
      content: PUNCTUATION_ONLY,
      tags: ["earlier"],
      metadata: {},
      sourceSummaryId: null,
      projectId: "other-machine-hash",
      sessionId: "session-earlier",
      depth: 1,
      confidence: 0.4,
      createdAt: "2026-01-01T00:00:00.000Z",
      archivedAt: null,
    };
    const project = makeProject(existing);
    const { res, getBody } = mockRes();

    await createPromoteHandler(makeConfig(), project.factory)({} as never, res, JSON.stringify({ cwd }));

    expect(getBody()).toMatchObject({ processed: 1, promoted: 1 });
    expect(project.serializeDecision).toHaveBeenCalledOnce();
    // Owner scope: neither lookup is narrowed to this machine's local hash.
    expect(project.searchPromoted).toHaveBeenCalledWith(PUNCTUATION_ONLY, 3, undefined, undefined);
    expect(project.findExactContent).toHaveBeenCalledWith(PUNCTUATION_ONLY, undefined);
    expect(project.insert).not.toHaveBeenCalled();
    expect(project.update).toHaveBeenCalledWith("existing-id", {
      confidence: expect.any(Number),
      tags: expect.arrayContaining(["earlier", "decision"]),
    });
    expect(project.archive).not.toHaveBeenCalled();
  });

  it("still inserts when the exact owner-scoped lookup finds nothing", async () => {
    const project = makeProject(null);
    const { res, getBody } = mockRes();

    await createPromoteHandler(makeConfig(), project.factory)({} as never, res, JSON.stringify({ cwd }));

    expect(getBody()).toMatchObject({ processed: 1, promoted: 1 });
    expect(project.findExactContent).toHaveBeenCalledWith(PUNCTUATION_ONLY, undefined);
    expect(project.insert).toHaveBeenCalledOnce();
    expect(project.insert).toHaveBeenCalledWith(expect.objectContaining({
      content: PUNCTUATION_ONLY,
      sourceProjectId: resolveProjectIdentity(cwd).id,
      sessionId: "session-a",
      depth: 2,
    }));
    expect(project.update).not.toHaveBeenCalled();
  });
});
