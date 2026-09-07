import { afterAll, beforeEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { inspect } from "node:util";
import type { RecallStats } from "../src/stats.js";

interface FakeDatabaseState {
  readonly project: string;
}

interface FakeStaleQuery {
  staleAfterDays: number;
  staleSurfacingWithoutUseLimit: number;
  projectId: string;
}

interface CountRow { count: number }
interface MessageStatsRow extends CountRow { tokens: number }
interface SummaryStatsRow extends MessageStatsRow { maxDepth: number }
interface RedactionRow { category: string; count: number }
interface ConversationRow {
  conversation_id: number;
  messages: number;
  summaries: number;
  max_depth: number;
  raw_tokens: number;
  summary_tokens: number;
}

type FakeGetRow = CountRow | MessageStatsRow | SummaryStatsRow | { surfaced: number; acted: number };
type FakeAllRow = RedactionRow | ConversationRow;

interface FakeStatement {
  get(): FakeGetRow;
  all(): FakeAllRow[];
}

const mocks = vi.hoisted(() => {
  const getBuiltinModule = (process as NodeJS.Process & {
    getBuiltinModule: (specifier: string) => unknown;
  }).getBuiltinModule;
  const fs = getBuiltinModule("node:fs") as typeof import("node:fs");
  const os = getBuiltinModule("node:os") as typeof import("node:os");
  const path = getBuiltinModule("node:path") as typeof import("node:path");
  return {
    baseExists: true,
    configFails: false,
    eventsFail: false,
    publicationBlocked: false,
    storageUnavailable: false,
    privateContention: false,
    stalePrivateContention: false,
    entries: [] as Array<{ name: string; directory: boolean; dbExists: boolean }>,
    close: vi.fn<(project: string) => void>(),
    closeDirectory: vi.fn<(path: string) => void>(),
    assertDirectory: vi.fn<(path: string) => void>(),
    openDirectory: vi.fn<(path: string) => void>(),
    openOptionalDirectory: vi.fn<(path: string) => void>(),
    readDirectory: vi.fn<(path: string) => void>(),
    databaseStat: vi.fn<(path: string) => {
      exists: boolean;
      regular: boolean;
      device: bigint;
      inode: bigint;
    }>(),
    constructDatabase: vi.fn<(location: string) => void>(),
    execDatabase: vi.fn<(project: string, sql: string) => void>(),
    prepareDatabase: vi.fn<(project: string, sql: string) => void>(),
    databaseLocations: [] as string[],
    migrate: vi.fn<(db: FakeDatabaseState) => void>(),
    collectEvents: vi.fn<(maxDbs: number) => void>(),
    loadConfig: vi.fn<(path: string) => void>(),
    findStale: vi.fn<(args: FakeStaleQuery) => unknown[]>(),
    getRecallStats: vi.fn<() => RecallStats>(),
    publicationHome: fs.mkdtempSync(path.join(os.tmpdir(), "lcm-stats-services-")),
  };
});

const projects = new Map<string, {
  messages: number; messageTokens: number; summaries: number; summaryTokens: number; maxDepth: number;
  promoted: number; redactions: RedactionRow[];
  conversations: ConversationRow[];
}>();

vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: (path: string) => {
      if (path === "/coverage/projects") return mocks.baseExists;
      if (path.startsWith("/coverage/projects/")) {
        return mocks.entries.some((entry) => path === `/coverage/projects/${entry.name}/db.sqlite` && entry.dbExists);
      }
      return actual.existsSync(path);
    },
    lstatSync: (path: string, options?: unknown) => {
      if (path.startsWith("/coverage/projects/")) {
        const stat = mocks.databaseStat(path);
        if (!stat.exists) throw Object.assign(new Error("missing"), { code: "ENOENT" });
        return { isFile: () => stat.regular, dev: stat.device, ino: stat.inode };
      }
      return Reflect.apply(
        actual.lstatSync,
        actual,
        options === undefined ? [path] : [path, options],
      );
    },
    readdirSync: (path: string, options?: unknown) => path === "/coverage/projects"
      ? (mocks.readDirectory(path), mocks.entries.map((entry) => ({ name: entry.name, isDirectory: () => entry.directory })))
      : Reflect.apply(actual.readdirSync, actual, options === undefined ? [path] : [path, options]),
  };
});
vi.mock("../src/security-files.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/security-files.js")>();
  const handle = (path: string) => ({
    fd: 1,
    witness: { mode: 0o700, uid: 1000, gid: 1000, nlink: "1", dev: "1", ino: "1" },
    close: () => mocks.closeDirectory(path),
  });
  return {
    ...actual,
    openPrivateDirectoryIfExists: (path: string) => {
      mocks.openOptionalDirectory(path);
      if (path === "/coverage") return handle(path);
      if (path === "/coverage/projects") return mocks.baseExists ? handle(path) : undefined;
      throw new Error("unexpected optional directory");
    },
    openPrivateDirectory: (path: string) => {
      mocks.openDirectory(path);
      const entry = mocks.entries.find(
        (candidate) => path === `/coverage/projects/${candidate.name}`,
      );
      if (!entry?.directory) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return handle(path);
    },
    assertPrivateDirectoryEntry: (_handle: unknown, path: string) => {
      mocks.assertDirectory(path);
      return { mode: 0o700, uid: 1000, gid: 1000, nlink: "1", dev: "1", ino: "1" };
    },
  };
});
vi.mock("../src/runtime-paths.js", () => ({ projectsDir: () => "/coverage/projects" }));
vi.mock("../src/storage/diagnostics.js", () => ({
  collectBackendDiagnostics: async (options: { collectSqlite: (options: object) => Promise<void> }) => {
    const snapshot = {
      backend: "sqlite", classification: "healthy",
      outbox: { status: "ready", captured: 9, unprocessed: 2, errors: 1 },
    };
    try { await options.collectSqlite({ staleAfterDays: 90, staleSurfacingWithoutUseLimit: 5 }); }
    catch { snapshot.classification = "unavailable"; }
    return snapshot;
  },
}));
vi.mock("../src/db/diagnostic-sqlite.js", () => ({
  readDiagnosticSqlite: async (options: {
    path: string; parents: Array<{path: string}>;
    statements: Array<{sql: string; mode: "get" | "all"; params?: unknown[]}>;
  }) => {
    const { DatabaseSync } = await import("node:sqlite");
    const url = new URL(`file://${options.path}`);
    url.searchParams.set("mode", "ro");
    const db = new DatabaseSync(url, { readOnly: true });
    try {
      for (const parent of options.parents) mocks.assertDirectory(parent.path);
      return options.statements.map(statement => {
        const prepared = db.prepare(statement.sql);
        return statement.mode === "all" ? prepared.all() : prepared.get();
      });
    } finally { db.close(); }
  },
}));
vi.mock("node:sqlite", () => ({
  DatabaseSync: class {
    readonly project: string;
    constructor(path: string | URL) {
      const location = String(path);
      mocks.databaseLocations.push(location);
      mocks.constructDatabase(location);
      this.project = new URL(location).pathname.split("/").at(-2)!;
    }
    exec(sql: string): void { mocks.execDatabase(this.project, sql); }
    close(): void { mocks.close(this.project); }
    prepare(sql: string): FakeStatement {
      mocks.prepareDatabase(this.project, sql);
      const data = projects.get(this.project)!;
      return {
        get(): FakeGetRow {
          if (sql.includes("AS surfaced")) return { surfaced: 0, acted: 0 };
          if (sql.includes("FROM messages")) return { count: data.messages, tokens: data.messageTokens };
          if (sql.includes("FROM summaries")) return { count: data.summaries, tokens: data.summaryTokens, maxDepth: data.maxDepth };
          return { count: data.promoted };
        },
        all(): FakeAllRow[] {
          return sql.includes("redaction_stats") ? data.redactions : data.conversations;
        },
      };
    }
  },
}));

import {
  collectStats,
  formatNumber,
  formatRatio,
  printStats,
  StatsDatabaseAdmissionError,
  StatsUnavailableError,
} from "../src/stats.js";
import { selectStorageBackendForConfig, StorageBackendUnavailableError } from "../src/storage/backend.js";
import { BackendPublicationJournalError } from "../src/storage/backend-publication.js";
import { PrivateMutationLockContentionError } from "../src/private-mutation-lock.js";
import { PrivateDirectoryTopologyError } from "../src/security-files.js";

type Stats = Parameters<typeof printStats>[0];

describe("stats service coverage", () => {
  beforeAll(() => {
    expect(dirname(mocks.publicationHome)).toBe(tmpdir());
    mkdirSync(mocks.publicationHome, { recursive: true, mode: 0o700 });
    mkdirSync(`${mocks.publicationHome}/.lcm`, { mode: 0o700 });
  });

  afterAll(() => {
    rmSync(mocks.publicationHome, { recursive: true, force: true });
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.baseExists = true;
    mocks.configFails = false;
    mocks.eventsFail = false;
    mocks.publicationBlocked = false;
    mocks.storageUnavailable = false;
    mocks.privateContention = false;
    mocks.stalePrivateContention = false;
    mocks.entries = [];
    mocks.databaseLocations = [];
    mocks.close.mockImplementation(() => undefined);
    mocks.closeDirectory.mockImplementation(() => undefined);
    mocks.openDirectory.mockImplementation(() => undefined);
    mocks.openOptionalDirectory.mockImplementation(() => undefined);
    mocks.assertDirectory.mockImplementation(() => undefined);
    mocks.readDirectory.mockImplementation(() => undefined);
    mocks.databaseStat.mockImplementation((path) => {
      const entry = mocks.entries.find(
        (candidate) => path === `/coverage/projects/${candidate.name}/db.sqlite`,
      );
      return {
        exists: entry?.dbExists ?? false,
        regular: true,
        device: 1n,
        inode: BigInt(entry ? mocks.entries.indexOf(entry) + 1 : 0),
      };
    });
    mocks.constructDatabase.mockImplementation(() => undefined);
    mocks.execDatabase.mockImplementation(() => undefined);
    mocks.prepareDatabase.mockImplementation(() => undefined);
    projects.clear();
    mocks.getRecallStats.mockReturnValue({ memoriesSurfaced: 0, memoriesActedUpon: 0, recallPrecision: null, topRecalled: [] });
    mocks.findStale.mockReturnValue([]);
  });

  function setProject(name = "alpha", messages = 1): void {
    mocks.entries = [{ name, directory: true, dbExists: true }];
    projects.set(name, {
      messages,
      messageTokens: messages,
      summaries: 0,
      summaryTokens: 0,
      maxDepth: 0,
      promoted: 0,
      redactions: [],
      conversations: [],
    });
  }

  it("formats all numeric boundaries", () => {
    expect([formatNumber(1), formatNumber(1000), formatNumber(1_000_000)]).toEqual(["1", "1.0k", "1.0M"]);
    expect([formatRatio(10, 2), formatRatio(0, 2), formatRatio(2, 0)]).toEqual(["5.0", "–", "–"]);
  });

  it("normalizes unsafe database leaves and raw inspection failures", async () => {
    setProject();
    mocks.databaseStat.mockReturnValue({
      exists: true, regular: false, device: 1n, inode: 1n,
    });
    await expect(collectStats()).rejects.toBeInstanceOf(StatsUnavailableError);
    expect(mocks.constructDatabase).not.toHaveBeenCalled();

    mocks.databaseStat.mockImplementation(() => {
      throw Object.assign(new Error("secret /coverage/projects/alpha"), { code: "EACCES" });
    });
    const error = await collectStats().catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(StatsUnavailableError);
    expect(String(error)).not.toContain("/coverage/projects/alpha");
  });

  it("normalizes directory-open and enumeration failures", async () => {
    setProject();
    mocks.readDirectory.mockImplementation(() => {
      throw new Error("private path leaked");
    });
    await expect(collectStats()).rejects.toBeInstanceOf(StatsUnavailableError);

    mocks.readDirectory.mockImplementation(() => undefined);
    mocks.openDirectory.mockImplementation(() => {
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    });
    await expect(collectStats()).rejects.toBeInstanceOf(StatsUnavailableError);
    expect(mocks.constructDatabase).not.toHaveBeenCalled();
  });

  it("removes retained-directory causes from inspected admission errors", async () => {
    setProject();
    const sentinel = "secret-topology-cause";
    mocks.assertDirectory.mockImplementation((path) => {
      if (path.endsWith("/alpha")) {
        throw new PrivateDirectoryTopologyError(
          "private directory topology is not trusted",
          { cause: new Error(sentinel) },
        );
      }
    });

    const error = await collectStats().catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(StatsUnavailableError);
    expect(error).not.toHaveProperty("cause");
    expect(inspect(error)).not.toContain(sentinel);
  });

  it("normalizes typed directory failures from the open boundary", async () => {
    const failure = new PrivateDirectoryTopologyError("private directory topology is not trusted");
    mocks.openOptionalDirectory.mockImplementation(() => { throw failure; });
    await expect(collectStats()).rejects.toBeInstanceOf(StatsUnavailableError);

    const admission = new StatsDatabaseAdmissionError();
    mocks.openOptionalDirectory.mockImplementation(() => { throw admission; });
    await expect(collectStats()).rejects.toBeInstanceOf(StatsUnavailableError);
  });

  it("treats database removal during existing-only open as an absent project", async () => {
    setProject();
    mocks.databaseStat
      .mockReturnValueOnce({ exists: true, regular: true, device: 1n, inode: 1n })
      .mockReturnValueOnce({ exists: false, regular: true, device: 0n, inode: 0n });
    mocks.constructDatabase.mockImplementation(() => { throw new Error("unable to open"); });

    await expect(collectStats()).rejects.toBeInstanceOf(StatsUnavailableError);
    expect(mocks.close).not.toHaveBeenCalled();
    expect(mocks.closeDirectory).toHaveBeenCalledTimes(3);
  });

  it("keeps an ordinary constructor failure as a best-effort project skip", async () => {
    setProject();
    mocks.constructDatabase.mockImplementation(() => { throw new Error("database is locked"); });

    await expect(collectStats()).rejects.toBeInstanceOf(StatsUnavailableError);
    expect(mocks.databaseStat).toHaveBeenCalledTimes(2);
    expect(mocks.close).not.toHaveBeenCalled();
  });

  it("rejects a database identity replacement during constructor failure", async () => {
    setProject();
    mocks.databaseStat
      .mockReturnValueOnce({ exists: true, regular: true, device: 1n, inode: 1n })
      .mockReturnValueOnce({ exists: true, regular: true, device: 1n, inode: 2n });
    mocks.constructDatabase.mockImplementation(() => { throw new Error("unable to open"); });

    await expect(collectStats()).rejects.toBeInstanceOf(StatsUnavailableError);
    expect(mocks.close).not.toHaveBeenCalled();
    expect(mocks.closeDirectory).toHaveBeenCalledTimes(3);
  });

  it("closes an acquired database after a post-open leaf replacement", async () => {
    setProject();
    mocks.databaseStat
      .mockReturnValueOnce({ exists: true, regular: true, device: 1n, inode: 1n })
      .mockReturnValueOnce({ exists: true, regular: true, device: 2n, inode: 1n });

    await expect(collectStats()).rejects.toBeInstanceOf(StatsUnavailableError);
    expect(mocks.execDatabase).not.toHaveBeenCalled();
    expect(mocks.migrate).not.toHaveBeenCalled();
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(mocks.closeDirectory).toHaveBeenCalledTimes(3);
  });

  it("closes an acquired database after a post-open parent replacement", async () => {
    setProject();
    mocks.constructDatabase.mockImplementation(() => {
      mocks.assertDirectory.mockImplementation((path) => {
        if (path.endsWith("/alpha")) {
          throw new PrivateDirectoryTopologyError("private directory topology is not trusted");
        }
      });
    });

    await expect(collectStats()).rejects.toBeInstanceOf(StatsUnavailableError);
    expect(mocks.execDatabase).not.toHaveBeenCalled();
    expect(mocks.migrate).not.toHaveBeenCalled();
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(mocks.closeDirectory).toHaveBeenCalledTimes(3);
  });

  it("preserves a final admission failure when database close also fails", async () => {
    setProject();
    mocks.databaseStat
      .mockReturnValueOnce({ exists: true, regular: true, device: 1n, inode: 1n })
      .mockReturnValueOnce({ exists: true, regular: true, device: 1n, inode: 1n })
      .mockReturnValueOnce({ exists: true, regular: true, device: 1n, inode: 2n });
    mocks.close.mockImplementation(() => { throw new Error("close exposed a private path"); });

    await expect(collectStats()).rejects.toBeInstanceOf(StatsUnavailableError);
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(mocks.closeDirectory).toHaveBeenCalledTimes(3);
  });

  it("keeps a standalone database close failure as a best-effort skip", async () => {
    setProject();
    mocks.close.mockImplementation(() => { throw new Error("database close failed"); });

    await expect(collectStats()).rejects.toBeInstanceOf(StatsUnavailableError);
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(mocks.closeDirectory).toHaveBeenCalledTimes(3);
  });

  it("attempts every directory close while preserving the admission failure", async () => {
    setProject();
    const failure = new StatsDatabaseAdmissionError();
    mocks.constructDatabase.mockImplementation(() => {
      mocks.assertDirectory.mockImplementation((path) => {
        if (path.endsWith("/alpha")) throw failure;
      });
    });
    mocks.closeDirectory.mockImplementation(() => {
      throw new Error("close exposed a private path");
    });

    await expect(collectStats()).rejects.toBeInstanceOf(StatsUnavailableError);
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(mocks.closeDirectory).toHaveBeenCalledTimes(3);
  });

  it("normalizes directory close failures after a successful scan", async () => {
    mocks.closeDirectory.mockImplementation(() => {
      throw new Error("close exposed a private path");
    });

    const error = await collectStats().catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(StatsUnavailableError);
    expect(String(error)).not.toContain("private path");
    expect(mocks.closeDirectory).toHaveBeenCalledTimes(2);
  });

  it("rejects a project replaced at its open boundary before any SQL", async () => {
    setProject();
    mocks.openDirectory.mockImplementation((openedPath) => {
      mocks.assertDirectory.mockImplementation((path) => {
        if (path === openedPath) {
          throw new PrivateDirectoryTopologyError("private directory topology is not trusted");
        }
      });
    });

    await expect(collectStats()).rejects.toBeInstanceOf(StatsUnavailableError);
    expect(mocks.databaseStat).not.toHaveBeenCalled();
    expect(mocks.constructDatabase).not.toHaveBeenCalled();
    expect(mocks.execDatabase).not.toHaveBeenCalled();
    expect(mocks.closeDirectory).toHaveBeenCalledTimes(3);
  });

  it("revalidates retained parents when the database constructor fails", async () => {
    setProject();
    mocks.constructDatabase.mockImplementation(() => {
      mocks.assertDirectory.mockImplementation((path) => {
        if (path === "/coverage/projects") {
          throw new PrivateDirectoryTopologyError("private directory topology is not trusted");
        }
      });
      throw new Error("unable to open");
    });

    await expect(collectStats()).rejects.toBeInstanceOf(StatsUnavailableError);
    expect(mocks.databaseStat).toHaveBeenCalledOnce();
    expect(mocks.close).not.toHaveBeenCalled();
    expect(mocks.closeDirectory).toHaveBeenCalledTimes(3);
  });

  it("closes project resources when a query fails", async () => {
    setProject();
    vi.clearAllMocks();
    mocks.execDatabase.mockImplementation(() => undefined);
    mocks.prepareDatabase.mockImplementation((_project, sql) => {
      if (sql.includes("FROM messages")) throw new Error("schema unavailable");
    });
    await expect(collectStats()).rejects.toBeInstanceOf(StatsUnavailableError);
    expect(mocks.migrate).not.toHaveBeenCalled();
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(mocks.closeDirectory).toHaveBeenCalledTimes(3);
  });

  it("prints every display section and conditional variant", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const base = {
      projects: 2, conversations: 2, compactedConversations: 1, messages: 2, summaries: 1, maxDepth: 2,
      rawTokens: 1000, summaryTokens: 10, ratio: 100, promotedCount: 1,
      conversationDetails: [
        { conversationId: 1, messages: 2, summaries: 1, maxDepth: 2, rawTokens: 1000, summaryTokens: 10, ratio: 100, promotedCount: 0 },
      ],
      redactionCounts: { builtIn: 1, global: 2, project: 3, total: 6 },
      eventsCaptured: 3, eventsUnprocessed: 1, eventsErrors: 1,
      recallStats: { memoriesSurfaced: 2, memoriesActedUpon: 1, recallPrecision: 50, topRecalled: [
        { id: "long", content: "x".repeat(70), actCount: 2 }, { id: "short", content: "short", actCount: 1 },
      ] }, staleCount: 2,
    } as unknown as Stats;
    printStats(base, true);
    const output = log.mock.calls.flat().join("\n");
    expect(output).toContain("Stale Memories");
    expect(output).toContain("Per Conversation");
    expect(output).not.toContain("…");
    expect(output).toContain("100.0x");

    log.mockClear();
    printStats({
      ...base, summaries: 1, rawTokens: 0, summaryTokens: 0, ratio: 0, eventsCaptured: 0,
      redactionCounts: { builtIn: 0, global: 0, project: 0, total: 0 },
      recallStats: { memoriesSurfaced: 0, memoriesActedUpon: 1, recallPrecision: null, topRecalled: [] },
      staleCount: 0, conversationDetails: [{ ...base.conversationDetails[0], ratio: 0 }],
    }, true);
    expect(log.mock.calls.flat().join("\n")).toContain("0.0% compressed");

    log.mockClear();
    printStats({
      ...base, summaries: 0, recallStats: { memoriesSurfaced: 0, memoriesActedUpon: 0, recallPrecision: null, topRecalled: [] },
      staleCount: 0, conversationDetails: [],
    }, true);
    expect(log.mock.calls.flat().join("\n")).not.toContain("Compression");
    printStats(base, false);
    log.mockRestore();
  });
});
