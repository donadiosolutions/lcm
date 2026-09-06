import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadDaemonConfig } from "../../../src/daemon/config.js";
import { StorageOperationError } from "../../../src/storage/errors.js";
import { BackendPublicationJournalError } from "../../../src/storage/backend-publication.js";
import { PrivateDirectoryTopologyError } from "../../../src/security-files.js";
import { makeMockStorageFactory } from "./mock-storage-factory.js";
import {
  createInvocationCoordinator,
  InvocationCoordinatorError,
  type InvocationCoordinator,
} from "../../../src/daemon/invocation-coordinator.js";
import type { RouteExecutionContext } from "../../../src/daemon/server.js";
import { createAbortError } from "../../../src/daemon/cancellation.js";

const mocks = vi.hoisted(() => ({
  exists: vi.fn(() => true),
  read: vi.fn(() => "{}"),
  write: vi.fn(),
  readMetadata: vi.fn(() => "{}"),
  readMetadataWithStat: vi.fn(),
  metadataResult: vi.fn((content: string, parentDev = "1", parentIno = "1") => {
    const result = { content, mtimeMs: 0 };
    Object.defineProperties(result, {
      parentDev: { value: parentDev, enumerable: false },
      parentIno: { value: parentIno, enumerable: false },
    });
    return result as typeof result & { parentDev: string; parentIno: string };
  }),
  writeMetadata: vi.fn(),
  assertDirectoryEntry: vi.fn(),
  openDirectory: vi.fn(() => ({
    fd: 1,
    witness: { mode: 0o700, uid: 0, gid: 0, nlink: "1", dev: "1", ino: "1" },
    close: vi.fn(),
  })),
  mkdir: vi.fn(),
  getConnection: vi.fn(() => ({})),
  closeConnection: vi.fn(),
  migrate: vi.fn(),
  conversations: vi.fn(async () => [] as unknown[]),
  summaries: vi.fn(async () => [] as unknown[]),
  prefixes: vi.fn(() => [] as string[]),
  shouldPromote: vi.fn(() => ({ promote: false, tags: [], confidence: 0 })),
  dedup: vi.fn(async () => undefined),
  validate: vi.fn((cwd: string) => cwd),
  send: vi.fn(),
  scrub: vi.fn((text: string) => text),
  openProject: vi.fn(),
  projectClose: vi.fn(async () => undefined),
  factoryClose: vi.fn(async () => undefined),
  transaction: vi.fn(),
  projectExists: vi.fn(async () => true),
  createFactory: vi.fn(),
  dedupObserver: vi.fn(),
  ensureProjectDir: vi.fn(() => "/private/project"),
  scrubForProject: vi.fn(async () => ({ scrub: (text: string) => mocks.scrub(text) })),
  identity: vi.fn((cwd: string) => ({
    id: "pid",
    localProjectId: "pid",
    canonical: cwd,
    machineId: "machine-id",
    selectedPath: cwd,
  })),
  pathsForIdentity: vi.fn((identity: { id: string; canonical: string; remoteProjectId?: string }) => ({
    ...identity,
    dir: `/lcm/projects/${identity.id}`,
    dbPath: `/lcm/projects/${identity.id}/db.sqlite`,
    metaPath: `/lcm/projects/${identity.id}/meta.json`,
  })),
}));

vi.mock("node:fs", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs")>(),
  existsSync: mocks.exists,
  readFileSync: mocks.read,
  writeFileSync: mocks.write,
  mkdirSync: mocks.mkdir,
}));
vi.mock("../../../src/daemon/project.js", () => ({
  projectPaths: (cwd: string) => ({ id: "pid", dbPath: `${cwd}/lcm.db`, metaPath: `${cwd}/meta.json`, canonical: cwd }),
  projectPathsForIdentity: mocks.pathsForIdentity,
  projectIdentity: mocks.identity,
  ensureProjectDirForIdentity: mocks.ensureProjectDir,
  MAX_PROJECT_METADATA_BYTES: 1024 * 1024,
}));
vi.mock("../../../src/security-files.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../src/security-files.js")>(),
  readBoundedRegularFile: mocks.readMetadata,
  readBoundedRegularFileWithStat: mocks.readMetadataWithStat,
  atomicWritePrivateFile: mocks.writeMetadata,
  assertPrivateDirectoryEntry: mocks.assertDirectoryEntry,
  openPrivateDirectory: mocks.openDirectory,
}));
vi.mock("../../../src/daemon/server.js", () => ({ sendJson: mocks.send }));
vi.mock("../../../src/db/connection.js", () => ({ getLcmConnection: mocks.getConnection, closeLcmConnection: mocks.closeConnection }));
vi.mock("../../../src/db/migration.js", () => ({ runLcmMigrations: mocks.migrate }));
vi.mock("../../../src/store/conversation-store.js", () => ({ ConversationStore: class { listConversations = mocks.conversations; } }));
vi.mock("../../../src/store/summary-store.js", () => ({ SummaryStore: class { getSummariesByConversation = mocks.summaries; } }));
vi.mock("../../../src/db/promoted.js", () => ({ PromotedStore: class { listContentPrefixes = mocks.prefixes; } }));
vi.mock("../../../src/promotion/detector.js", () => ({ shouldPromote: mocks.shouldPromote }));
vi.mock("../../../src/promotion/dedup.js", () => ({ deduplicateAndInsert: mocks.dedup }));
vi.mock("../../../src/daemon/validate-cwd.js", () => ({ validateCwd: mocks.validate }));
vi.mock("../../../src/scrub.js", () => ({
  ScrubEngine: { forProject: mocks.scrubForProject },
}));
vi.mock("../../../src/storage/index.js", () => ({ createStorageBackendFactory: mocks.createFactory }));

import { createPromoteHandler } from "../../../src/daemon/routes/promote.js";

const config = loadDaemonConfig("/tmp/promote-boundaries");
const response = {} as never;

function makeDirectoryHandle(close = vi.fn()) {
  return {
    fd: 1,
    witness: { mode: 0o700, uid: 0, gid: 0, nlink: "1", dev: "1", ino: "1" },
    close,
  };
}

function queueMetadataDirectoryChain(closes: Partial<Record<"root" | "projects" | "leaf", () => void>> = {}) {
  const root = makeDirectoryHandle(vi.fn(closes.root ?? (() => undefined)));
  const projects = makeDirectoryHandle(vi.fn(closes.projects ?? (() => undefined)));
  const leaf = makeDirectoryHandle(vi.fn(closes.leaf ?? (() => undefined)));
  mocks.openDirectory
    .mockReturnValueOnce(root)
    .mockReturnValueOnce(projects)
    .mockReturnValueOnce(leaf);
  return { root, projects, leaf };
}

describe("promote persistence boundaries", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockClear();
    mocks.exists.mockReturnValue(true);
    mocks.projectExists.mockResolvedValue(true);
    mocks.read.mockReturnValue("{}");
    mocks.readMetadata.mockReturnValue("{}");
    mocks.readMetadataWithStat.mockReset();
    mocks.readMetadataWithStat.mockImplementation((path: string, options: unknown) =>
      mocks.metadataResult(mocks.readMetadata(path, options), "1", "1"));
    mocks.openDirectory.mockReset();
    mocks.openDirectory.mockImplementation(() => makeDirectoryHandle());
    mocks.assertDirectoryEntry.mockReset();
    mocks.assertDirectoryEntry.mockReturnValue({
      mode: 0o700,
      uid: 0,
      gid: 0,
      nlink: "1",
      dev: "1",
      ino: "1",
    });
    mocks.getConnection.mockReturnValue({});
    mocks.conversations.mockResolvedValue([]);
    mocks.summaries.mockResolvedValue([]);
    mocks.prefixes.mockReturnValue([]);
    mocks.shouldPromote.mockReturnValue({ promote: false, tags: [], confidence: 0 });
    mocks.dedup.mockResolvedValue(undefined);
    mocks.dedupObserver.mockReset();
    mocks.ensureProjectDir.mockReturnValue("/private/project");
    mocks.scrubForProject.mockResolvedValue({ scrub: (text: string) => mocks.scrub(text) });
    mocks.identity.mockImplementation((cwd: string) => ({
      id: "pid",
      localProjectId: "pid",
      canonical: cwd,
      machineId: "machine-id",
      selectedPath: cwd,
    }));
    mocks.pathsForIdentity.mockImplementation(identity => ({
      ...identity,
      dir: `/lcm/projects/${identity.id}`,
      dbPath: `/lcm/projects/${identity.id}/db.sqlite`,
      metaPath: `/lcm/projects/${identity.id}/meta.json`,
    }));
    mocks.validate.mockImplementation((cwd: string) => cwd);
    mocks.scrub.mockImplementation((text: string) => text);
    mocks.createFactory.mockImplementation(async () => makeMockStorageFactory({
      projectExists: mocks.projectExists,
      openProject: mocks.openProject,
      close: mocks.factoryClose,
    }));
    mocks.openProject.mockResolvedValue({
      conversations: { listConversations: mocks.conversations },
      summaries: { getSummariesByConversation: mocks.summaries },
      promotedMemory: { listContentPrefixes: mocks.prefixes },
      lexicalSearch: {},
      transaction: mocks.transaction,
      close: mocks.projectClose,
    });
  });

  it("authenticates the sidecar directory before scrubber setup", async () => {
    await createPromoteHandler(config)({} as never, response, JSON.stringify({ cwd: "/ok" }));

    expect(mocks.ensureProjectDir).toHaveBeenCalledOnce();
    expect(mocks.ensureProjectDir).toHaveBeenCalledWith(
      expect.objectContaining({ id: "pid", canonical: "/ok" }),
      { writeMetadata: false },
    );
    expect(mocks.scrubForProject).toHaveBeenCalledWith(
      config.security.sensitivePatterns,
      "/private/project",
    );
    expect(mocks.ensureProjectDir.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.scrubForProject.mock.invocationCallOrder[0]!);
    expect(mocks.mkdir).not.toHaveBeenCalled();
  });

  it("fails closed when the private sidecar directory is untrusted", async () => {
    mocks.ensureProjectDir.mockImplementationOnce(() => {
      throw new Error("private directory mode is not trusted");
    });

    await createPromoteHandler(config)({} as never, response, JSON.stringify({ cwd: "/ok" }));

    expect(mocks.send).toHaveBeenLastCalledWith(response, 500, {
      error: "private directory mode is not trusted",
    });
    expect(mocks.scrubForProject).not.toHaveBeenCalled();
    expect(mocks.openProject).not.toHaveBeenCalled();
  });

  it("compares stored prefixes with the same scrubbed content used for insertion", async () => {
    mocks.conversations.mockResolvedValueOnce([{ conversationId: 1, sessionId: "s" }]);
    mocks.summaries.mockResolvedValueOnce([
      { content: "token=secret", depth: 1, tokenCount: 1, sourceMessageTokenCount: 3 },
    ]);
    mocks.scrub.mockReturnValueOnce("token=[REDACTED]");
    mocks.prefixes.mockReturnValueOnce(["token=[REDACTED]"]);

    const injected = makeMockStorageFactory({
      projectExists: mocks.projectExists,
      openProject: mocks.openProject,
      close: mocks.factoryClose,
    });
    await createPromoteHandler(config, injected)({} as never, response, JSON.stringify({ cwd: "/ok" }));

    expect(mocks.shouldPromote).not.toHaveBeenCalled();
    expect(mocks.dedup).not.toHaveBeenCalled();
    expect(mocks.scrub).toHaveBeenCalledOnce();
    expect(mocks.factoryClose).not.toHaveBeenCalled();
  });

  it("validates cwd and missing databases", async () => {
    const handler = createPromoteHandler(config);
    await handler({} as never, response, "");
    expect(mocks.send).toHaveBeenLastCalledWith(response, 400, { error: "cwd is required" });
    mocks.validate.mockImplementationOnce(() => { throw new Error("bad cwd"); });
    await handler({} as never, response, JSON.stringify({ cwd: "/bad" }));
    expect(mocks.send).toHaveBeenLastCalledWith(response, 400, { error: "bad cwd" });
    mocks.validate.mockImplementationOnce(() => { throw "failure"; });
    await handler({} as never, response, JSON.stringify({ cwd: "/bad" }));
    expect(mocks.send).toHaveBeenLastCalledWith(response, 400, { error: "invalid cwd" });
    mocks.projectExists.mockResolvedValueOnce(false);
    await handler({} as never, response, JSON.stringify({ cwd: "/missing" }));
    expect(mocks.send).toHaveBeenLastCalledWith(response, 200, { processed: 0, promoted: 0 });
  });

  it("skips duplicates and low-signal summaries and counts dry runs", async () => {
    mocks.conversations.mockResolvedValueOnce([{ conversationId: 1, sessionId: "s" }]);
    mocks.summaries.mockResolvedValueOnce([
      { content: "duplicate", depth: 0, tokenCount: 1, sourceMessageTokenCount: 2 },
      { content: "low signal", depth: 0, tokenCount: 1, sourceMessageTokenCount: 2 },
      { content: "promote", depth: 1, tokenCount: 1, sourceMessageTokenCount: 3 },
    ]);
    mocks.prefixes.mockReturnValueOnce(["duplicate"]);
    mocks.shouldPromote
      .mockReturnValueOnce({ promote: false, tags: [], confidence: 0 })
      .mockReturnValueOnce({ promote: true, tags: ["depth"], confidence: 0.25 });
    await createPromoteHandler(config)({} as never, response, JSON.stringify({ cwd: "/ok", dry_run: true }));
    expect(mocks.send).toHaveBeenLastCalledWith(response, 200, { processed: 2, promoted: 1, conversations: 1 });
    expect(mocks.dedup).not.toHaveBeenCalled();
    expect(mocks.openDirectory).not.toHaveBeenCalled();
    expect(mocks.readMetadata).not.toHaveBeenCalled();
    expect(mocks.assertDirectoryEntry).not.toHaveBeenCalled();
    expect(mocks.writeMetadata).not.toHaveBeenCalled();
  });

  it("inserts promoted summaries, ignores individual failures, and updates metadata", async () => {
    mocks.conversations.mockResolvedValueOnce([{ conversationId: 1, sessionId: "s" }]);
    mocks.summaries.mockResolvedValueOnce([
      { content: "first", depth: 1, tokenCount: 1, sourceMessageTokenCount: 3 },
      { content: "second", depth: 1, tokenCount: 1, sourceMessageTokenCount: 3 },
    ]);
    mocks.shouldPromote.mockReturnValue({ promote: true, tags: ["depth"], confidence: 0.25 });
    mocks.dedup.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("duplicate failed"));
    mocks.readMetadata.mockReturnValueOnce(JSON.stringify({ existing: true }));
    await createPromoteHandler(config)({} as never, response, JSON.stringify({ cwd: "/ok" }));
    expect(mocks.send).toHaveBeenLastCalledWith(response, 200, { processed: 2, promoted: 1, conversations: 1 });
    expect(mocks.writeMetadata).toHaveBeenCalledOnce();
    expect(mocks.readMetadata).toHaveBeenCalledWith("/lcm/projects/pid/meta.json", {
      allowedRoot: "/lcm/projects/pid",
      maxBytes: 1024 * 1024,
      expectedUid: process.getuid?.(),
      requireSingleLink: true,
    });
    const [metadataPath, serialized] = mocks.writeMetadata.mock.calls[0] as [string, string];
    expect(metadataPath).toBe("/lcm/projects/pid/meta.json");
    expect(JSON.parse(serialized)).toMatchObject({ existing: true, cwd: "/ok" });
    expect(JSON.parse(serialized).lastPromote).toEqual(expect.any(String));
    expect(serialized.endsWith("\n")).toBe(true);

    mocks.exists.mockReturnValueOnce(true);
    await createPromoteHandler(config)({} as never, response, JSON.stringify({ cwd: "/ok" }));
    expect(mocks.writeMetadata).toHaveBeenCalledTimes(2);
    mocks.readMetadata.mockImplementationOnce(() => { throw new Error("meta failed"); });
    await createPromoteHandler(config)({} as never, response, JSON.stringify({ cwd: "/ok" }));
    expect(mocks.send).toHaveBeenLastCalledWith(response, 200, { processed: 0, promoted: 0, conversations: 0 });
  });

  it("retains and reasserts the complete metadata directory chain", async () => {
    const chain = queueMetadataDirectoryChain();

    await createPromoteHandler(config)({} as never, response, JSON.stringify({ cwd: "/chain" }));

    expect(mocks.openDirectory.mock.calls.slice(0, 3)).toEqual([
      ["/lcm", { expectedUid: process.getuid?.() }],
      ["/lcm/projects", { expectedUid: process.getuid?.() }],
      ["/lcm/projects/pid", { expectedUid: process.getuid?.() }],
    ]);
    expect(mocks.assertDirectoryEntry.mock.calls.slice(-6)).toEqual([
      [chain.root, "/lcm", 0],
      [chain.projects, "/lcm/projects", 0],
      [chain.leaf, "/lcm/projects/pid", 0],
      [chain.root, "/lcm", 0],
      [chain.projects, "/lcm/projects", 0],
      [chain.leaf, "/lcm/projects/pid", 0],
    ]);
    expect(mocks.writeMetadata).toHaveBeenCalledWith(
      "/lcm/projects/pid/meta.json",
      expect.any(String),
      {},
      chain.leaf,
    );
    expect(chain.leaf.close.mock.invocationCallOrder[0])
      .toBeLessThan(chain.projects.close.mock.invocationCallOrder[0]!);
    expect(chain.projects.close.mock.invocationCallOrder[0])
      .toBeLessThan(chain.root.close.mock.invocationCallOrder[0]!);
  });

  it.each([
    ["unexpected projects component", "/lcm/not-projects/pid", "/lcm/not-projects/pid/meta.json"],
    ["unexpected leaf component", "/lcm/projects/other", "/lcm/projects/other/meta.json"],
    ["unexpected metadata leaf", "/lcm/projects/pid", "/lcm/projects/pid/other.json"],
    ["unexpected relative metadata chain", "projects/pid", "projects/pid/meta.json"],
  ])("rejects an %s before opening directories", async (_label, dir, metaPath) => {
    mocks.pathsForIdentity.mockReturnValueOnce({
      id: "pid",
      canonical: "/unexpected",
      dir,
      dbPath: `${dir}/db.sqlite`,
      metaPath,
    });

    await createPromoteHandler(config)({} as never, response, JSON.stringify({ cwd: "/unexpected" }));

    expect(mocks.openDirectory).not.toHaveBeenCalled();
    expect(mocks.writeMetadata).not.toHaveBeenCalled();
    expect(mocks.send).toHaveBeenLastCalledWith(response, 500, {
      error: "project directory topology changed before metadata publication",
    });
  });

  it("does not create a missing projects directory and closes the acquired root", async () => {
    const root = makeDirectoryHandle();
    mocks.openDirectory
      .mockReturnValueOnce(root)
      .mockImplementationOnce(() => {
        throw Object.assign(new Error("projects missing"), { code: "ENOENT" });
      });

    await createPromoteHandler(config)({} as never, response, JSON.stringify({ cwd: "/missing-projects" }));

    expect(mocks.mkdir).not.toHaveBeenCalled();
    expect(root.close).toHaveBeenCalledOnce();
    expect(mocks.openDirectory).toHaveBeenCalledTimes(2);
    expect(mocks.writeMetadata).not.toHaveBeenCalled();
    expect(mocks.send).toHaveBeenLastCalledWith(response, 500, {
      error: "project directory topology changed before metadata publication",
    });
  });

  it("keeps an acquisition assertion critical while attempting cleanup", async () => {
    const close = vi.fn(() => { throw new Error("root close failed"); });
    const root = makeDirectoryHandle(close);
    mocks.openDirectory.mockReturnValueOnce(root);
    mocks.assertDirectoryEntry.mockImplementationOnce(() => {
      throw new PrivateDirectoryTopologyError("root entry changed", {
        cause: Object.assign(new Error("resource-coded assertion cause"), { code: "EMFILE" }),
      });
    });

    await createPromoteHandler(config)({} as never, response, JSON.stringify({ cwd: "/assert-root" }));

    expect(mocks.openDirectory).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(mocks.writeMetadata).not.toHaveBeenCalled();
    expect(mocks.send).toHaveBeenLastCalledWith(response, 500, {
      error: "project directory topology changed before metadata publication",
    });
  });

  it("promotes partial-chain drift over an ordinary resource open failure", async () => {
    const root = makeDirectoryHandle();
    mocks.openDirectory
      .mockReturnValueOnce(root)
      .mockImplementationOnce(() => {
        throw Object.assign(new Error("projects descriptors exhausted"), { code: "EMFILE" });
      });
    mocks.assertDirectoryEntry.mockImplementation(() => {
      if (mocks.assertDirectoryEntry.mock.calls.length === 2) {
        throw new PrivateDirectoryTopologyError("root changed during projects open");
      }
      return { mode: 0o700, uid: 0, gid: 0, nlink: "1", dev: "1", ino: "1" };
    });

    await createPromoteHandler(config)({} as never, response, JSON.stringify({ cwd: "/partial-drift" }));

    expect(root.close).toHaveBeenCalledOnce();
    expect(mocks.writeMetadata).not.toHaveBeenCalled();
    expect(mocks.send).toHaveBeenLastCalledWith(response, 500, {
      error: "project directory topology changed before metadata publication",
    });
  });

  it("attempts every metadata directory close when multiple closes fail", async () => {
    const closeOrder: string[] = [];
    const chain = queueMetadataDirectoryChain({
      root: () => { closeOrder.push("root"); throw new Error("root close failed"); },
      projects: () => { closeOrder.push("projects"); throw new Error("projects close failed"); },
      leaf: () => { closeOrder.push("leaf"); },
    });

    await createPromoteHandler(config)({} as never, response, JSON.stringify({ cwd: "/close-all" }));

    expect(closeOrder).toEqual(["leaf", "projects", "root"]);
    expect(chain.leaf.close).toHaveBeenCalledOnce();
    expect(chain.projects.close).toHaveBeenCalledOnce();
    expect(chain.root.close).toHaveBeenCalledOnce();
    expect(mocks.send).toHaveBeenLastCalledWith(response, 200, {
      processed: 0,
      promoted: 0,
      conversations: 0,
    });
  });

  it("normalizes typed and untyped failures and closes acquired connections", async () => {
    const handler = createPromoteHandler(config);
    mocks.openProject.mockRejectedValueOnce(new Error("migration failed"));
    await handler({} as never, response, JSON.stringify({ cwd: "/ok" }));
    expect(mocks.send).toHaveBeenLastCalledWith(response, 500, { error: "migration failed" });
    mocks.openProject.mockRejectedValueOnce("failure");
    await handler({} as never, response, JSON.stringify({ cwd: "/ok" }));
    expect(mocks.send).toHaveBeenLastCalledWith(response, 500, { error: "promote failed" });
    expect(mocks.projectClose).not.toHaveBeenCalled();
    expect(mocks.factoryClose).toHaveBeenCalledTimes(2);
  });

  it("creates metadata when the file is absent", async () => {
    mocks.readMetadata.mockImplementationOnce(() => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); });
    await createPromoteHandler(config)({} as never, response, JSON.stringify({ cwd: "/ok" }));
    expect(mocks.writeMetadata).toHaveBeenCalledOnce();
    expect(mocks.send).toHaveBeenLastCalledWith(response, 200, {
      processed: 0,
      promoted: 0,
      conversations: 0,
    });

    const closeError = new Error("metadata parent close failed");
    queueMetadataDirectoryChain({ leaf: () => { throw closeError; } });
    await createPromoteHandler(config)({} as never, response, JSON.stringify({ cwd: "/cleanup-only" }));
    expect(mocks.send).toHaveBeenLastCalledWith(response, 200, {
      processed: 0,
      promoted: 0,
      conversations: 0,
    });
  });

  it.each([
    ["malformed JSON", "{"],
    ["null metadata", "null"],
    ["array metadata", "[]"],
    ["primitive metadata", "42"],
  ])("leaves %s unchanged and keeps promotion successful", async (_label, content) => {
    mocks.readMetadata.mockReturnValueOnce(content);
    await createPromoteHandler(config)({} as never, response, JSON.stringify({ cwd: "/invalid" }));
    expect(mocks.writeMetadata).not.toHaveBeenCalled();
    expect(mocks.send).toHaveBeenLastCalledWith(response, 200, {
      processed: 0,
      promoted: 0,
      conversations: 0,
    });
  });

  it("skips metadata publication when the bounded reader rejects an existing file", async () => {
    mocks.readMetadata.mockImplementationOnce(() => {
      throw new Error("metadata owner or topology is not trusted");
    });
    await createPromoteHandler(config)({} as never, response, JSON.stringify({ cwd: "/invalid" }));
    expect(mocks.writeMetadata).not.toHaveBeenCalled();
    expect(mocks.send).toHaveBeenLastCalledWith(response, 200, {
      processed: 0,
      promoted: 0,
      conversations: 0,
    });
  });

  it.each([
    ["bounded read", () => mocks.readMetadata.mockImplementationOnce(() => {
      throw new Error("metadata read failed");
    })],
    ["JSON parse", () => mocks.readMetadata.mockReturnValueOnce("{")],
    ["metadata shape", () => mocks.readMetadata.mockReturnValueOnce("[]")],
    ["serialized size", () => mocks.readMetadata.mockReturnValueOnce(
      JSON.stringify({ existing: "é".repeat(524_288) }),
    )],
  ])("revalidates and closes the admitted parent after an ordinary %s failure", async (_label, fail) => {
    const chain = queueMetadataDirectoryChain();
    fail();

    await createPromoteHandler(config)({} as never, response, JSON.stringify({ cwd: "/ordinary-failure" }));

    expect(mocks.openDirectory.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.readMetadata.mock.invocationCallOrder[0]!);
    expect(mocks.assertDirectoryEntry.mock.calls.slice(-3)).toEqual([
      [chain.root, "/lcm", 0],
      [chain.projects, "/lcm/projects", 0],
      [chain.leaf, "/lcm/projects/pid", 0],
    ]);
    expect(mocks.writeMetadata).not.toHaveBeenCalled();
    expect(chain.root.close).toHaveBeenCalledOnce();
    expect(chain.projects.close).toHaveBeenCalledOnce();
    expect(chain.leaf.close).toHaveBeenCalledOnce();
    expect(mocks.send).toHaveBeenLastCalledWith(response, 200, {
      processed: 0,
      promoted: 0,
      conversations: 0,
    });
  });

  it.each([
    ["bounded read", () => mocks.readMetadata.mockImplementationOnce(() => {
      throw new Error("file changed during validation");
    })],
    ["JSON parse", () => mocks.readMetadata.mockReturnValueOnce("{")],
    ["metadata shape", () => mocks.readMetadata.mockReturnValueOnce("[]")],
    ["serialized size", () => mocks.readMetadata.mockReturnValueOnce(
      JSON.stringify({ existing: "é".repeat(524_288) }),
    )],
  ])("fails closed when ordinary %s failure reveals a replaced parent", async (_label, fail) => {
    const chain = queueMetadataDirectoryChain();
    fail();
    mocks.assertDirectoryEntry.mockImplementation(() => {
      if (mocks.assertDirectoryEntry.mock.calls.length === 10) {
        throw new PrivateDirectoryTopologyError("private directory topology is not trusted", {
          cause: Object.assign(new Error("resource-coded assertion cause"), { code: "EMFILE" }),
        });
      }
      return { mode: 0o700, uid: 0, gid: 0, nlink: "1", dev: "1", ino: "1" };
    });

    await createPromoteHandler(config)({} as never, response, JSON.stringify({ cwd: "/replaced-parent" }));

    expect(mocks.writeMetadata).not.toHaveBeenCalled();
    expect(chain.root.close).toHaveBeenCalledOnce();
    expect(chain.projects.close).toHaveBeenCalledOnce();
    expect(chain.leaf.close).toHaveBeenCalledOnce();
    expect(mocks.send).toHaveBeenLastCalledWith(response, 500, {
      error: "project directory topology changed before metadata publication",
    });
  });

  it("preserves a critical read primary without assertion masking", async () => {
    const chain = queueMetadataDirectoryChain();
    const topologyError = new PrivateDirectoryTopologyError("critical metadata read");
    mocks.readMetadata.mockImplementationOnce(() => {
      throw topologyError;
    });

    await createPromoteHandler(config)({} as never, response, JSON.stringify({ cwd: "/critical-read" }));

    expect(mocks.assertDirectoryEntry).toHaveBeenCalledTimes(9);
    expect(mocks.writeMetadata).not.toHaveBeenCalled();
    expect(chain.root.close).toHaveBeenCalledOnce();
    expect(chain.projects.close).toHaveBeenCalledOnce();
    expect(chain.leaf.close).toHaveBeenCalledOnce();
    expect(mocks.send).toHaveBeenLastCalledWith(response, 500, {
      error: "critical metadata read",
    });
  });

  it("preserves assertion failure when retained-parent cleanup also fails", async () => {
    const close = vi.fn(() => { throw new Error("metadata parent close failed"); });
    const chain = queueMetadataDirectoryChain({ leaf: close });
    mocks.readMetadata.mockImplementationOnce(() => {
      throw new Error("metadata read failed");
    });
    mocks.assertDirectoryEntry.mockImplementation(() => {
      if (mocks.assertDirectoryEntry.mock.calls.length === 10) {
        throw new PrivateDirectoryTopologyError("parent replaced");
      }
      return { mode: 0o700, uid: 0, gid: 0, nlink: "1", dev: "1", ino: "1" };
    });

    await createPromoteHandler(config)({} as never, response, JSON.stringify({ cwd: "/assertion-close" }));

    expect(close).toHaveBeenCalledOnce();
    expect(chain.projects.close).toHaveBeenCalledOnce();
    expect(chain.root.close).toHaveBeenCalledOnce();
    expect(mocks.send).toHaveBeenLastCalledWith(response, 500, {
      error: "project directory topology changed before metadata publication",
    });
  });

  it("keeps ordinary read and cleanup failures best-effort", async () => {
    const close = vi.fn(() => {
      throw new Error("metadata parent close failed");
    });
    const chain = queueMetadataDirectoryChain({ leaf: close });
    mocks.readMetadata.mockImplementationOnce(() => {
      throw new Error("metadata read failed");
    });

    await createPromoteHandler(config)({} as never, response, JSON.stringify({ cwd: "/ordinary-close" }));

    expect(mocks.assertDirectoryEntry.mock.calls.slice(-3)).toEqual([
      [chain.root, "/lcm", 0],
      [chain.projects, "/lcm/projects", 0],
      [chain.leaf, "/lcm/projects/pid", 0],
    ]);
    expect(close).toHaveBeenCalledOnce();
    expect(mocks.send).toHaveBeenLastCalledWith(response, 200, {
      processed: 0,
      promoted: 0,
      conversations: 0,
    });
  });

  it("covers platforms without process.getuid while preserving bounded read options", async () => {
    const originalGetuid = process.getuid;
    Object.defineProperty(process, "getuid", { configurable: true, value: undefined });
    try {
      await createPromoteHandler(config)({} as never, response, JSON.stringify({ cwd: "/no-uid" }));
    } finally {
      Object.defineProperty(process, "getuid", { configurable: true, value: originalGetuid });
    }
    expect(mocks.readMetadata).toHaveBeenCalledWith("/lcm/projects/pid/meta.json", {
      allowedRoot: "/lcm/projects/pid",
      maxBytes: 1024 * 1024,
      expectedUid: undefined,
      requireSingleLink: true,
    });
    expect(mocks.writeMetadata).toHaveBeenCalledOnce();
  });

  it.each([
    ["device", "2", "1"],
    ["inode", "1", "2"],
  ])("fails closed when the sampled metadata parent %s differs", async (_field, parentDev, parentIno) => {
    const chain = queueMetadataDirectoryChain();
    mocks.readMetadataWithStat.mockReturnValueOnce(
      mocks.metadataResult(JSON.stringify({ injected: true }), parentDev, parentIno),
    );

    await createPromoteHandler(config)({} as never, response, JSON.stringify({ cwd: "/sampled-parent" }));

    expect(mocks.writeMetadata).not.toHaveBeenCalled();
    expect(mocks.assertDirectoryEntry).toHaveBeenCalledTimes(9);
    expect(chain.root.close).toHaveBeenCalledOnce();
    expect(chain.projects.close).toHaveBeenCalledOnce();
    expect(chain.leaf.close).toHaveBeenCalledOnce();
    expect(mocks.send).toHaveBeenLastCalledWith(response, 500, {
      error: "project directory topology changed before metadata publication",
    });
  });

  it("accepts matching non-enumerable sampled parent identity", async () => {
    const observed = mocks.metadataResult(JSON.stringify({ retained: true }));
    expect(Object.keys(observed)).not.toContain("parentDev");
    expect(Object.keys(observed)).not.toContain("parentIno");
    mocks.readMetadataWithStat.mockReturnValueOnce(observed);

    await createPromoteHandler(config)({} as never, response, JSON.stringify({ cwd: "/matching-parent" }));

    expect(mocks.writeMetadata).toHaveBeenCalledOnce();
    const [, serialized] = mocks.writeMetadata.mock.calls[0] as [string, string];
    expect(JSON.parse(serialized)).toMatchObject({ retained: true, cwd: "/matching-parent" });
    expect(mocks.send).toHaveBeenLastCalledWith(response, 200, {
      processed: 0,
      promoted: 0,
      conversations: 0,
    });
  });

  it("bounds serialized metadata by bytes and keeps the promotion result", async () => {
    mocks.readMetadata.mockReturnValueOnce(JSON.stringify({ existing: "é".repeat(524_288) }));
    await createPromoteHandler(config)({} as never, response, JSON.stringify({ cwd: "/oversized" }));
    expect(mocks.writeMetadata).not.toHaveBeenCalled();
    expect(mocks.send).toHaveBeenLastCalledWith(response, 200, {
      processed: 0,
      promoted: 0,
      conversations: 0,
    });
  });

  it("keeps a writer rejection best-effort", async () => {
    mocks.writeMetadata.mockImplementationOnce(() => { throw new Error("publish failed"); });
    await createPromoteHandler(config)({} as never, response, JSON.stringify({ cwd: "/writer-error" }));
    expect(mocks.send).toHaveBeenLastCalledWith(response, 200, {
      processed: 0,
      promoted: 0,
      conversations: 0,
    });
  });

  it.each([
    ["root", "EMFILE", 0],
    ["projects", "ENFILE", 1],
    ["leaf", "ENOSPC", 2],
  ] as const)(
    "keeps promotion successful when the %s metadata directory open fails with direct %s",
    async (_component, code, priorHandles) => {
      const opened = [makeDirectoryHandle(), makeDirectoryHandle()];
      for (let index = 0; index < priorHandles; index += 1) {
        mocks.openDirectory.mockReturnValueOnce(opened[index]!);
      }
      const resourceError = Object.assign(new Error(`metadata directory ${code}`), { code });
      mocks.openDirectory.mockImplementationOnce(() => { throw resourceError; });

      await createPromoteHandler(config)({} as never, response, JSON.stringify({ cwd: "/resource" }));

      expect(mocks.readMetadata).not.toHaveBeenCalled();
      expect(mocks.writeMetadata).not.toHaveBeenCalled();
      for (const handle of opened.slice(0, priorHandles)) {
        expect(handle.close).toHaveBeenCalledOnce();
      }
      expect(mocks.send).toHaveBeenLastCalledWith(response, 200, {
        processed: 0,
        promoted: 0,
        conversations: 0,
      });
    },
  );

  it("keeps a metadata-parent resource failure best-effort through publication admission", async () => {
    const resourceError = Object.assign(new Error("metadata parent unavailable"), { code: "EMFILE" });
    mocks.openDirectory.mockImplementationOnce(() => { throw resourceError; });
    const withPublicationAdmission = vi.fn(
      async <T>(operation: (token: object) => Promise<T> | T): Promise<T> => operation({}),
    );

    await createPromoteHandler(config)({} as never, response, JSON.stringify({ cwd: "/resource-admission" }), {
      withPublicationAdmission,
    });

    expect(withPublicationAdmission).toHaveBeenCalledTimes(2);
    expect(mocks.readMetadata).not.toHaveBeenCalled();
    expect(mocks.assertDirectoryEntry).not.toHaveBeenCalled();
    expect(mocks.writeMetadata).not.toHaveBeenCalled();
    expect(mocks.send).toHaveBeenLastCalledWith(response, 200, {
      processed: 0,
      promoted: 0,
      conversations: 0,
    });
  });

  it.each([
    ["ENOENT", Object.assign(new Error("metadata parent missing"), { code: "ENOENT" })],
    ["ELOOP", Object.assign(new Error("metadata parent loop"), { code: "ELOOP" })],
    ["ENOTDIR", Object.assign(new Error("metadata parent is not a directory"), { code: "ENOTDIR" })],
    ["ENOMEM", Object.assign(new Error("metadata parent allocation failed"), { code: "ENOMEM" })],
    ["owner rejection", new Error("metadata parent owner is not trusted")],
    ["mode rejection", new Error("metadata parent mode is not trusted")],
    ["unknown error", new Error("metadata parent failed")],
    [
      "non-resource code with a resource cause",
      Object.assign(
        new Error("metadata parent failed", {
          cause: Object.assign(new Error("descriptor exhaustion"), { code: "EMFILE" }),
        }),
        { code: "EIO" },
      ),
    ],
    [
      "unknown error with a resource cause",
      new Error("metadata parent failed", {
        cause: Object.assign(new Error("descriptor exhaustion"), { code: "ENFILE" }),
      }),
    ],
  ])("fails closed for metadata parent open %s", async (_label, parentError) => {
    mocks.openDirectory.mockImplementationOnce(() => { throw parentError; });

    await createPromoteHandler(config)({} as never, response, JSON.stringify({ cwd: "/parent-failure" }));

    expect(mocks.readMetadata).not.toHaveBeenCalled();
    expect(mocks.assertDirectoryEntry).not.toHaveBeenCalled();
    expect(mocks.writeMetadata).not.toHaveBeenCalled();
    expect(mocks.send).toHaveBeenLastCalledWith(response, 500, {
      error: "project directory topology changed before metadata publication",
    });
  });

  it.each([
    [
      "typed topology",
      Object.assign(new PrivateDirectoryTopologyError("typed topology"), { code: "EMFILE" }),
    ],
    [
      "named topology",
      Object.assign(new Error("named topology"), {
        code: "ENFILE",
        name: "PrivateDirectoryTopologyError",
      }),
    ],
    [
      "cancellation",
      Object.assign(createAbortError(), { code: "ENOSPC" }),
    ],
  ])("keeps a resource-coded %s failure critical", async (_label, topologyError) => {
    mocks.openDirectory.mockImplementationOnce(() => { throw topologyError; });

    await createPromoteHandler(config)({} as never, response, JSON.stringify({ cwd: "/critical-resource" }));

    expect(mocks.readMetadata).not.toHaveBeenCalled();
    expect(mocks.assertDirectoryEntry).not.toHaveBeenCalled();
    expect(mocks.writeMetadata).not.toHaveBeenCalled();
    expect(mocks.send).toHaveBeenLastCalledWith(response, 500, {
      error: "project directory topology changed before metadata publication",
    });
  });

  it("keeps a resource-coded publication admission failure blocked", async () => {
    const admissionError = Object.assign(
      new BackendPublicationJournalError("unexpected-state", "publication changed"),
      { code: "ENOSPC" },
    );
    const withPublicationAdmission = vi.fn()
      .mockImplementationOnce(async (operation: (token: object) => Promise<unknown> | unknown) => operation({}))
      .mockRejectedValueOnce(admissionError);

    await createPromoteHandler(config)({} as never, response, JSON.stringify({ cwd: "/critical-admission" }), {
      withPublicationAdmission,
    });
    expect(withPublicationAdmission).toHaveBeenCalledTimes(2);
    expect(mocks.openDirectory).not.toHaveBeenCalled();
    expect(mocks.readMetadata).not.toHaveBeenCalled();
    expect(mocks.assertDirectoryEntry).not.toHaveBeenCalled();
    expect(mocks.writeMetadata).not.toHaveBeenCalled();
    expect(mocks.send).toHaveBeenLastCalledWith(response, 503, {
      status: "blocked",
      error: "backend publication admission blocked",
    });
  });

  it("does not swallow a topology failure while reopening metadata parent", async () => {
    mocks.openDirectory.mockImplementationOnce(() => {
      throw new PrivateDirectoryTopologyError("project directory topology changed");
    });

    await createPromoteHandler(config)({} as never, response, JSON.stringify({ cwd: "/topology" }));

    expect(mocks.readMetadata).not.toHaveBeenCalled();
    expect(mocks.assertDirectoryEntry).not.toHaveBeenCalled();
    expect(mocks.send).toHaveBeenLastCalledWith(response, 500, {
      error: "project directory topology changed before metadata publication",
    });
    expect(mocks.writeMetadata).not.toHaveBeenCalled();
  });

  it("preserves a topology primary when metadata-parent cleanup also fails", async () => {
    const topologyError = new PrivateDirectoryTopologyError("topology primary");
    const closeError = new Error("metadata parent close failed");
    const closeOrder: string[] = [];
    const firstChain = queueMetadataDirectoryChain({
      root: () => { closeOrder.push("root"); },
      projects: () => { closeOrder.push("projects"); },
      leaf: () => { closeOrder.push("leaf"); throw closeError; },
    });
    mocks.writeMetadata.mockImplementationOnce(() => { throw topologyError; });

    await createPromoteHandler(config)({} as never, response, JSON.stringify({ cwd: "/topology-close" }));

    expect(mocks.writeMetadata).toHaveBeenCalledOnce();
    expect(mocks.send).toHaveBeenLastCalledWith(response, 500, { error: "topology primary" });
    expect(closeOrder).toEqual(["leaf", "projects", "root"]);
    expect(firstChain.root.close).toHaveBeenCalledOnce();
    expect(firstChain.projects.close).toHaveBeenCalledOnce();
    expect(firstChain.leaf.close).toHaveBeenCalledOnce();

    queueMetadataDirectoryChain({ leaf: () => { throw closeError; } });
    mocks.writeMetadata.mockImplementationOnce(() => { throw topologyError; });
    const withPublicationAdmission = vi.fn(async <T>(operation: (token: object) => Promise<T> | T): Promise<T> => operation({}));
    await createPromoteHandler(config)({} as never, response, JSON.stringify({ cwd: "/topology-close-admission" }), {
      withPublicationAdmission,
    });

    expect(mocks.send).toHaveBeenLastCalledWith(response, 500, { error: "topology primary" });
    expect(withPublicationAdmission).toHaveBeenCalledTimes(2);
  });

  it("keeps metadata cleanup failures best-effort while preserving writer errors", async () => {
    const closeError = new Error("metadata parent close failed");
    queueMetadataDirectoryChain({ leaf: () => { throw closeError; } });
    mocks.writeMetadata.mockImplementationOnce(() => { throw new Error("metadata writer failed"); });

    await createPromoteHandler(config)({} as never, response, JSON.stringify({ cwd: "/cleanup" }));

    expect(mocks.send).toHaveBeenLastCalledWith(response, 200, {
      processed: 0,
      promoted: 0,
      conversations: 0,
    });
  });

  it("does not swallow typed PostgreSQL repository failures from deduplication", async () => {
    const postgresqlConfig = {
      ...config,
      storage: {
        backend: "postgresql",
        postgresql: {
          url: "postgresql://user:secret@db.example/lcm",
          poolMax: 1,
          connectionTimeoutMs: 100,
          idleTimeoutMs: 100,
          statementTimeoutMs: 100,
        },
      },
    } as const;
    mocks.conversations.mockResolvedValueOnce([{ conversationId: 1, sessionId: "s" }]);
    mocks.summaries.mockResolvedValueOnce([
      { content: "promote", depth: 1, tokenCount: 1, sourceMessageTokenCount: 3 },
    ]);
    mocks.shouldPromote.mockReturnValueOnce({ promote: true, tags: [], confidence: 0.5 });
    mocks.dedup.mockRejectedValueOnce(new StorageOperationError(
      "STORAGE_OPERATION_FAILED",
      "postgresql",
      "project",
      "repository",
      "promote",
    ));

    await createPromoteHandler(postgresqlConfig)({} as never, response, JSON.stringify({ cwd: "/pg" }));

    expect(mocks.send).toHaveBeenLastCalledWith(response, 503, expect.objectContaining({
      code: "STORAGE_OPERATION_FAILED",
      backend: "postgresql",
    }));
  });

  it("rejects unknown invocation identifiers before opening project storage", async () => {
    const coordinator = createInvocationCoordinator({
      daemonInstanceId: "11111111-1111-4111-8111-111111111111",
    });
    const handler = createPromoteHandler(config, makeMockStorageFactory({
      projectExists: mocks.projectExists,
      openProject: mocks.openProject,
      close: mocks.factoryClose,
    }));

    await handler(
      {} as never,
      response,
      JSON.stringify({ cwd: "/unknown", invocation_id: "22222222-2222-4222-8222-222222222222" }),
      { invocationCoordinator: coordinator } satisfies RouteExecutionContext,
    );

    expect(mocks.openProject).not.toHaveBeenCalled();
    expect(mocks.send).toHaveBeenLastCalledWith(response, 404, {
      error: expect.stringMatching(/unknown|invocation/i),
    });
    await coordinator.shutdown();
  });

  it("fails closed when a supplied invocation has no coordinator", async () => {
    const handler = createPromoteHandler(config, makeMockStorageFactory({
      projectExists: mocks.projectExists,
      openProject: mocks.openProject,
      close: mocks.factoryClose,
    }));
    await handler(
      {} as never,
      response,
      JSON.stringify({ cwd: "/missing-coordinator", invocation_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }),
    );
    expect(mocks.openProject).not.toHaveBeenCalled();
    expect(mocks.send).toHaveBeenLastCalledWith(response, 503, {
      error: "invocation control unavailable",
    });
  });

  it("returns bounded cancellation when coordinator admission is already aborted", async () => {
    const base = createInvocationCoordinator({
      daemonInstanceId: "11111111-1111-4111-8111-111111111111",
    });
    const coordinator = {
      ...base,
      heartbeat: () => { throw createAbortError(); },
    } as unknown as InvocationCoordinator;
    await createPromoteHandler(config, makeMockStorageFactory({
      projectExists: mocks.projectExists,
      openProject: mocks.openProject,
      close: mocks.factoryClose,
    }))(
      {} as never,
      response,
      JSON.stringify({ cwd: "/admission-abort", invocation_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }),
      { invocationCoordinator: coordinator } satisfies RouteExecutionContext,
    );
    expect(mocks.openProject).not.toHaveBeenCalled();
    expect(mocks.send).toHaveBeenLastCalledWith(response, 499, {
      status: "cancelled",
      error: "promote cancelled",
    });
    await base.shutdown();
  });

  it("absorbs a cancellation response when the transport is already closed", async () => {
    const base = createInvocationCoordinator({
      daemonInstanceId: "11111111-1111-4111-8111-111111111111",
    });
    const coordinator = {
      ...base,
      heartbeat: () => { throw createAbortError(); },
    } as unknown as InvocationCoordinator;
    const closedResponse = { headersSent: true } as never;
    await createPromoteHandler(config, makeMockStorageFactory({
      projectExists: mocks.projectExists,
      openProject: mocks.openProject,
      close: mocks.factoryClose,
    }))(
      {} as never,
      closedResponse,
      JSON.stringify({ cwd: "/closed", invocation_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" }),
      { invocationCoordinator: coordinator } satisfies RouteExecutionContext,
    );
    expect(mocks.send).not.toHaveBeenCalled();
    await base.shutdown();
  });

  it("uses a bounded fallback for non-Error coordinator admission failures", async () => {
    const base = createInvocationCoordinator({
      daemonInstanceId: "11111111-1111-4111-8111-111111111111",
    });
    const coordinator = {
      ...base,
      heartbeat: () => { throw "admission failed"; },
    } as unknown as InvocationCoordinator;
    await createPromoteHandler(config, makeMockStorageFactory({
      projectExists: mocks.projectExists,
      openProject: mocks.openProject,
      close: mocks.factoryClose,
    }))(
      {} as never,
      response,
      JSON.stringify({ cwd: "/primitive-admission", invocation_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" }),
      { invocationCoordinator: coordinator } satisfies RouteExecutionContext,
    );
    expect(mocks.send).toHaveBeenLastCalledWith(response, 409, {
      error: "invocation admission failed",
    });
    await base.shutdown();
  });

  it("cancels a supplied invocation whose request signal was already aborted", async () => {
    const daemonInstanceId = "11111111-1111-4111-8111-111111111111";
    const invocationId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    const coordinator = createInvocationCoordinator({ daemonInstanceId });
    coordinator.start({ invocationId, command: "compact", daemonInstanceId });
    const requestController = new AbortController();
    requestController.abort();

    await createPromoteHandler(config, makeMockStorageFactory({
      projectExists: mocks.projectExists,
      openProject: mocks.openProject,
      close: mocks.factoryClose,
    }))(
      {} as never,
      response,
      JSON.stringify({ cwd: "/pre-aborted", invocation_id: invocationId }),
      {
        signal: requestController.signal,
        invocationCoordinator: coordinator,
      } satisfies RouteExecutionContext,
    );
    expect(mocks.openProject).not.toHaveBeenCalled();
    expect(mocks.send).toHaveBeenLastCalledWith(response, 499, {
      status: "cancelled",
      error: "promote cancelled",
    });
    expect(coordinator.snapshot(invocationId)).toMatchObject({ state: "cancelled", activeCount: 0 });
    await coordinator.shutdown();
  });

  it("keeps cancellation bounded when targeted cancel control rejects", async () => {
    const daemonInstanceId = "11111111-1111-4111-8111-111111111111";
    const invocationId = "12121212-1212-4212-8212-121212121212";
    const base = createInvocationCoordinator({ daemonInstanceId });
    base.start({ invocationId, command: "compact", daemonInstanceId });
    const requestController = new AbortController();
    const coordinator = {
      ...base,
      cancel: async () => { throw new Error("control unavailable"); },
    } as unknown as InvocationCoordinator;
    mocks.conversations.mockResolvedValueOnce([{ conversationId: 1, sessionId: "s" }]);
    mocks.summaries.mockResolvedValueOnce([
      { content: "first", depth: 1, tokenCount: 1, sourceMessageTokenCount: 3 },
    ]);
    mocks.shouldPromote.mockReturnValue({ promote: true, tags: [], confidence: 0.25 });
    mocks.dedup.mockImplementation(async () => { requestController.abort(); });

    await createPromoteHandler(config, makeMockStorageFactory({
      projectExists: mocks.projectExists,
      openProject: mocks.openProject,
      close: mocks.factoryClose,
    }))(
      {} as never,
      response,
      JSON.stringify({ cwd: "/cancel-reject", invocation_id: invocationId }),
      {
        signal: requestController.signal,
        invocationCoordinator: coordinator,
      } satisfies RouteExecutionContext,
    );
    expect(mocks.send).toHaveBeenLastCalledWith(response, 499, {
      status: "cancelled",
      error: "promote cancelled",
    });
    await base.shutdown();
  });

  it("keeps project storage open until a cancelled commit releases", async () => {
    const daemonInstanceId = "11111111-1111-4111-8111-111111111111";
    const invocationId = "14141414-1414-4414-8414-141414141414";
    const coordinator = createInvocationCoordinator({ daemonInstanceId });
    coordinator.start({ invocationId, command: "compact", daemonInstanceId });
    const requestController = new AbortController();
    let observedOpenCommit = false;
    mocks.conversations.mockResolvedValueOnce([{ conversationId: 1, sessionId: "s" }]);
    mocks.summaries.mockResolvedValueOnce([
      { content: "first", depth: 1, tokenCount: 1, sourceMessageTokenCount: 3 },
    ]);
    mocks.shouldPromote.mockReturnValue({ promote: true, tags: [], confidence: 0.25 });
    mocks.dedup.mockImplementation(async () => {
      requestController.abort();
      expect(mocks.projectClose).not.toHaveBeenCalled();
      observedOpenCommit = true;
    });

    await createPromoteHandler(config, makeMockStorageFactory({
      projectExists: mocks.projectExists,
      openProject: mocks.openProject,
      close: mocks.factoryClose,
    }))(
      {} as never,
      response,
      JSON.stringify({ cwd: "/commit-close-order", invocation_id: invocationId }),
      {
        signal: requestController.signal,
        invocationCoordinator: coordinator,
      } satisfies RouteExecutionContext,
    );

    expect(observedOpenCommit).toBe(true);
    expect(mocks.projectClose).toHaveBeenCalledOnce();
    expect(mocks.send).toHaveBeenLastCalledWith(response, 499, {
      status: "cancelled",
      error: "promote cancelled",
    });
    expect(coordinator.snapshot(invocationId)).toMatchObject({ state: "cancelled", activeCount: 0 });
    await coordinator.shutdown();
  });

  it("detaches request and composed-signal listeners after invocation settlement", async () => {
    const daemonInstanceId = "11111111-1111-4111-8111-111111111111";
    const invocationId = "13131313-1313-4313-8313-131313131313";
    const coordinator = createInvocationCoordinator({ daemonInstanceId });
    coordinator.start({ invocationId, command: "compact", daemonInstanceId });
    const requestController = new AbortController();
    const addListener = vi.spyOn(requestController.signal, "addEventListener");
    const removeListener = vi.spyOn(requestController.signal, "removeEventListener");

    try {
      await createPromoteHandler(config, makeMockStorageFactory({
        projectExists: mocks.projectExists,
        openProject: mocks.openProject,
        close: mocks.factoryClose,
      }))(
        {} as never,
        response,
        JSON.stringify({ cwd: "/listener-cleanup", invocation_id: invocationId }),
        {
          signal: requestController.signal,
          invocationCoordinator: coordinator,
        } satisfies RouteExecutionContext,
      );
      const added = addListener.mock.calls
        .filter(([type]) => type === "abort")
        .map(([, listener]) => listener);
      const removed = removeListener.mock.calls
        .filter(([type]) => type === "abort")
        .map(([, listener]) => listener);
      expect(added.length).toBeGreaterThan(0);
      expect(removed).toEqual(expect.arrayContaining(added));
      expect(coordinator.snapshot(invocationId)).toMatchObject({
        state: "active",
        activeCount: 0,
        workCount: 0,
        commitCount: 0,
      });
    } finally {
      addListener.mockRestore();
      removeListener.mockRestore();
      await coordinator.shutdown();
    }
  });

  it("rejects malformed and late invocation identifiers before opening project storage", async () => {
    const handler = createPromoteHandler(config, makeMockStorageFactory({
      projectExists: mocks.projectExists,
      openProject: mocks.openProject,
      close: mocks.factoryClose,
    }));

    await handler(
      {} as never,
      response,
      JSON.stringify({ cwd: "/malformed", invocation_id: "not-a-uuid" }),
    );
    expect(mocks.openProject).not.toHaveBeenCalled();
    expect(mocks.send).toHaveBeenLastCalledWith(response, 400, {
      error: "invocation_id must be a canonical UUID",
    });

    const daemonInstanceId = "11111111-1111-4111-8111-111111111111";
    const invocationId = "55555555-5555-4555-8555-555555555555";
    const coordinator = createInvocationCoordinator({ daemonInstanceId });
    coordinator.start({ invocationId, command: "compact", daemonInstanceId });
    await coordinator.finish({ invocationId, command: "compact", daemonInstanceId });

    await handler(
      {} as never,
      response,
      JSON.stringify({ cwd: "/late", invocation_id: invocationId }),
      { invocationCoordinator: coordinator } satisfies RouteExecutionContext,
    );
    expect(mocks.openProject).not.toHaveBeenCalled();
    expect(mocks.send).toHaveBeenLastCalledWith(response, 409, {
      error: expect.stringMatching(/terminal|cancel/i),
    });
    await coordinator.shutdown();
  });

  it("cancels the targeted invocation during promotion and releases active work", async () => {
    const daemonInstanceId = "11111111-1111-4111-8111-111111111111";
    const invocationId = "33333333-3333-4333-8333-333333333333";
    const coordinator = createInvocationCoordinator({ daemonInstanceId });
    coordinator.start({ invocationId, command: "compact", daemonInstanceId });
    const requestController = new AbortController();
    mocks.conversations.mockResolvedValueOnce([{ conversationId: 1, sessionId: "s" }]);
    mocks.summaries.mockResolvedValueOnce([
      { content: "first", depth: 1, tokenCount: 1, sourceMessageTokenCount: 3 },
      { content: "second", depth: 1, tokenCount: 1, sourceMessageTokenCount: 3 },
    ]);
    mocks.shouldPromote.mockReturnValue({ promote: true, tags: ["depth"], confidence: 0.25 });
    mocks.dedupObserver.mockImplementation(() => { requestController.abort(); });
    mocks.dedup.mockImplementation(async () => {
      await mocks.dedupObserver?.();
    });

    await createPromoteHandler(config, makeMockStorageFactory({
      projectExists: mocks.projectExists,
      openProject: mocks.openProject,
      close: mocks.factoryClose,
    }))(
      {} as never,
      response,
      JSON.stringify({ cwd: "/cancel", invocation_id: invocationId }),
      {
        signal: requestController.signal,
        invocationCoordinator: coordinator,
      } satisfies RouteExecutionContext,
    );

    expect(mocks.dedup).toHaveBeenCalledOnce();
    expect(mocks.send).toHaveBeenLastCalledWith(response, 499, {
      status: "cancelled",
      error: "promote cancelled",
    });
    expect(coordinator.snapshot(invocationId)).toMatchObject({
      state: "cancelled",
      activeCount: 0,
      workCount: 0,
      commitCount: 0,
    });
    await coordinator.shutdown();
  });

  it("lets a pre-cancel commit finish one write but starts no later summary", async () => {
    const daemonInstanceId = "11111111-1111-4111-8111-111111111111";
    const invocationId = "44444444-4444-4444-8444-444444444444";
    const coordinator = createInvocationCoordinator({ daemonInstanceId });
    coordinator.start({ invocationId, command: "compact", daemonInstanceId });
    const requestController = new AbortController();
    let abortOnCommit = true;
    const wrappedCoordinator = {
      ...coordinator,
      acquireCommit: (target: Parameters<typeof coordinator.acquireCommit>[0]) => {
        const permit = coordinator.acquireCommit(target);
        if (abortOnCommit) {
          abortOnCommit = false;
          requestController.abort();
        }
        return permit;
      },
    } as unknown as InvocationCoordinator;
    mocks.conversations.mockResolvedValueOnce([{ conversationId: 1, sessionId: "s" }]);
    mocks.summaries.mockResolvedValueOnce([
      { content: "first", depth: 1, tokenCount: 1, sourceMessageTokenCount: 3 },
      { content: "second", depth: 1, tokenCount: 1, sourceMessageTokenCount: 3 },
    ]);
    mocks.shouldPromote.mockReturnValue({ promote: true, tags: ["depth"], confidence: 0.25 });

    await createPromoteHandler(config, makeMockStorageFactory({
      projectExists: mocks.projectExists,
      openProject: mocks.openProject,
      close: mocks.factoryClose,
    }))(
      {} as never,
      response,
      JSON.stringify({ cwd: "/pre-cancel", invocation_id: invocationId }),
      {
        signal: requestController.signal,
        invocationCoordinator: wrappedCoordinator,
      } satisfies RouteExecutionContext,
    );

    expect(mocks.dedup).toHaveBeenCalledOnce();
    expect(mocks.send).toHaveBeenLastCalledWith(response, 499, {
      status: "cancelled",
      error: "promote cancelled",
    });
    expect(coordinator.snapshot(invocationId)).toMatchObject({ state: "cancelled", activeCount: 0 });
    await coordinator.shutdown();
  });

  it("lets a pre-cancel metadata permit finish its atomic write and skips later work", async () => {
    const daemonInstanceId = "11111111-1111-4111-8111-111111111111";
    const invocationId = "66666666-6666-4666-8666-666666666666";
    const coordinator = createInvocationCoordinator({ daemonInstanceId });
    coordinator.start({ invocationId, command: "compact", daemonInstanceId });
    const requestController = new AbortController();
    let abortOnCommit = true;
    const wrappedCoordinator = {
      ...coordinator,
      acquireCommit: (target: Parameters<typeof coordinator.acquireCommit>[0]) => {
        const permit = coordinator.acquireCommit(target);
        if (abortOnCommit) {
          abortOnCommit = false;
          requestController.abort();
        }
        return permit;
      },
    } as unknown as InvocationCoordinator;

    await createPromoteHandler(config, makeMockStorageFactory({
      projectExists: mocks.projectExists,
      openProject: mocks.openProject,
      close: mocks.factoryClose,
    }))(
      {} as never,
      response,
      JSON.stringify({ cwd: "/metadata-latch", invocation_id: invocationId }),
      {
        signal: requestController.signal,
        invocationCoordinator: wrappedCoordinator,
      } satisfies RouteExecutionContext,
    );

    expect(mocks.writeMetadata).toHaveBeenCalledOnce();
    expect(mocks.send).toHaveBeenLastCalledWith(response, 499, {
      status: "cancelled",
      error: "promote cancelled",
    });
    expect(coordinator.snapshot(invocationId)).toMatchObject({ state: "cancelled", activeCount: 0 });
    await coordinator.shutdown();
  });

  it("runs metadata under the supplied publication admission", async () => {
    const withPublicationAdmission = vi.fn(async <T>(operation: (token: object) => Promise<T> | T): Promise<T> =>
      await operation({}),
    );
    mocks.conversations.mockResolvedValueOnce([]);
    await createPromoteHandler(config, makeMockStorageFactory({
      projectExists: mocks.projectExists,
      openProject: mocks.openProject,
      close: mocks.factoryClose,
    }))(
      {} as never,
      response,
      JSON.stringify({ cwd: "/publication" }),
      { withPublicationAdmission } satisfies RouteExecutionContext,
    );
    expect(withPublicationAdmission).toHaveBeenCalledTimes(2);
    expect(mocks.writeMetadata).toHaveBeenCalledOnce();
  });

  it("returns the coordinator cancellation response when a commit permit is refused", async () => {
    const daemonInstanceId = "11111111-1111-4111-8111-111111111111";
    const invocationId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const base = createInvocationCoordinator({ daemonInstanceId });
    base.start({ invocationId, command: "compact", daemonInstanceId });
    const coordinator = {
      ...base,
      acquireCommit: () => {
        throw new InvocationCoordinatorError("cancelled", "invocation is cancelling", 409);
      },
    } as unknown as InvocationCoordinator;

    await createPromoteHandler(config, makeMockStorageFactory({
      projectExists: mocks.projectExists,
      openProject: mocks.openProject,
      close: mocks.factoryClose,
    }))(
      {} as never,
      response,
      JSON.stringify({ cwd: "/commit-refused", invocation_id: invocationId }),
      { invocationCoordinator: coordinator } satisfies RouteExecutionContext,
    );
    expect(mocks.send).toHaveBeenLastCalledWith(response, 409, {
      error: "invocation admission failed",
    });
    await base.shutdown();
  });

  it("maps publication admission failures to the bounded blocked response", async () => {
    const admission = vi.fn(async () => {
      throw new BackendPublicationJournalError("unexpected-state", "publication changed");
    });
    await createPromoteHandler(config, makeMockStorageFactory({
      projectExists: mocks.projectExists,
      openProject: mocks.openProject,
      close: mocks.factoryClose,
    }))(
      {} as never,
      response,
      JSON.stringify({ cwd: "/publication-failure" }),
      { withPublicationAdmission: admission } satisfies RouteExecutionContext,
    );
    expect(mocks.send).toHaveBeenLastCalledWith(response, 503, {
      status: "blocked",
      error: "backend publication admission blocked",
    });
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
      localProjectId: "local-hash-b",
    };
    mocks.identity.mockReturnValueOnce(preflight).mockReturnValueOnce(live);
    const order: string[] = [];
    mocks.scrubForProject.mockImplementationOnce(async () => {
      order.push("scrubber");
      return { scrub: mocks.scrub };
    });
    const admission = vi.fn(async (operation: (token: object) => Promise<unknown>) => {
      order.push("admission");
      return operation({});
    });

    await createPromoteHandler(config)(
      {} as never,
      response,
      JSON.stringify({ cwd: preflight.canonical }),
      { withPublicationAdmission: admission, signal: new AbortController().signal },
    );

    const localIdentity = {
      id: preflight.localProjectId,
      canonical: preflight.canonical,
      remoteProjectId: preflight.remoteProjectId,
    };
    expect(mocks.pathsForIdentity).toHaveBeenCalledWith(localIdentity);
    expect(mocks.ensureProjectDir).toHaveBeenCalledWith(localIdentity, { writeMetadata: false });
    expect(mocks.scrubForProject).toHaveBeenCalledWith(
      config.security.sensitivePatterns,
      "/private/project",
    );
    expect(order).toEqual(["scrubber", "admission"]);
    expect(mocks.send).toHaveBeenLastCalledWith(response, 503, {
      status: "blocked",
      error: "backend publication admission blocked",
    });
    expect(mocks.openProject).not.toHaveBeenCalled();
    expect(mocks.dedup).not.toHaveBeenCalled();
    expect(mocks.writeMetadata).not.toHaveBeenCalled();
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

    await createPromoteHandler(config)(
      {} as never,
      response,
      JSON.stringify({ cwd: identity.canonical, dry_run: true }),
      { withPublicationAdmission: operation => operation({}) },
    );

    expect(mocks.openProject).toHaveBeenCalledWith(identity, expect.any(Object), expect.any(AbortSignal));
    expect(mocks.send).toHaveBeenLastCalledWith(response, 200, {
      processed: 0,
      promoted: 0,
      conversations: 0,
    });
  });

  it("isolates cancellation to the matching invocation while another promotion completes", async () => {
    const daemonInstanceId = "11111111-1111-4111-8111-111111111111";
    const firstInvocationId = "77777777-7777-4777-8777-777777777777";
    const secondInvocationId = "88888888-8888-4888-8888-888888888888";
    const coordinator = createInvocationCoordinator({ daemonInstanceId });
    coordinator.start({ invocationId: firstInvocationId, command: "compact", daemonInstanceId });
    coordinator.start({ invocationId: secondInvocationId, command: "compact", daemonInstanceId });
    const firstRequest = new AbortController();
    const secondRequest = new AbortController();
    mocks.openProject.mockImplementation(async (identity: { canonical: string }) => ({
      conversations: { listConversations: async () => [{ conversationId: identity.canonical, sessionId: identity.canonical }] },
      summaries: {
        getSummariesByConversation: async () => [
          { content: identity.canonical, depth: 1, tokenCount: 1, sourceMessageTokenCount: 3 },
        ],
      },
      promotedMemory: { listContentPrefixes: async () => [] },
      lexicalSearch: {},
      transaction: mocks.transaction,
      close: mocks.projectClose,
    }) as never);
    mocks.shouldPromote.mockReturnValue({ promote: true, tags: ["depth"], confidence: 0.25 });
    mocks.dedup.mockImplementation(async (params: { content: string }) => {
      if (params.content === "/first") firstRequest.abort();
    });
    const factory = makeMockStorageFactory({
      projectExists: mocks.projectExists,
      openProject: mocks.openProject,
      close: mocks.factoryClose,
    });
    const handler = createPromoteHandler(config, factory);

    const first = handler(
      {} as never,
      response,
      JSON.stringify({ cwd: "/first", invocation_id: firstInvocationId }),
      { signal: firstRequest.signal, invocationCoordinator: coordinator } satisfies RouteExecutionContext,
    );
    const second = handler(
      {} as never,
      response,
      JSON.stringify({ cwd: "/second", invocation_id: secondInvocationId }),
      { signal: secondRequest.signal, invocationCoordinator: coordinator } satisfies RouteExecutionContext,
    );
    await Promise.all([first, second]);

    expect(mocks.dedup).toHaveBeenCalledTimes(2);
    expect(coordinator.snapshot(firstInvocationId)).toMatchObject({ state: "cancelled", activeCount: 0 });
    expect(coordinator.snapshot(secondInvocationId)).toMatchObject({ state: "active", activeCount: 0 });
    expect(mocks.send).toHaveBeenCalledWith(response, 499, {
      status: "cancelled",
      error: "promote cancelled",
    });
    expect(mocks.send).toHaveBeenCalledWith(response, 200, {
      processed: 1,
      promoted: 1,
      conversations: 1,
    });
    await coordinator.shutdown();
  });

  it("waits for an invocation-owned promotion to settle during coordinator shutdown", async () => {
    const daemonInstanceId = "11111111-1111-4111-8111-111111111111";
    const invocationId = "99999999-9999-4999-8999-999999999999";
    const coordinator = createInvocationCoordinator({ daemonInstanceId });
    coordinator.start({ invocationId, command: "compact", daemonInstanceId });
    mocks.conversations.mockResolvedValueOnce([{ conversationId: 1, sessionId: "s" }]);
    mocks.summaries.mockResolvedValueOnce([
      { content: "held", depth: 1, tokenCount: 1, sourceMessageTokenCount: 3 },
    ]);
    mocks.shouldPromote.mockReturnValue({ promote: true, tags: [], confidence: 0.25 });
    let releaseDedup!: () => void;
    const dedupGate = new Promise<void>(resolve => { releaseDedup = resolve; });
    mocks.dedup.mockImplementation(async () => { await dedupGate; });
    const handler = createPromoteHandler(config, makeMockStorageFactory({
      projectExists: mocks.projectExists,
      openProject: mocks.openProject,
      close: mocks.factoryClose,
    }));
    const pending = handler(
      {} as never,
      response,
      JSON.stringify({ cwd: "/shutdown", invocation_id: invocationId }),
      { invocationCoordinator: coordinator } satisfies RouteExecutionContext,
    );
    await vi.waitFor(() => expect(mocks.dedup).toHaveBeenCalledOnce());
    const stopping = coordinator.shutdown();
    let settled = false;
    void stopping.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    releaseDedup();
    await pending;
    await expect(stopping).resolves.toBeUndefined();
    expect(coordinator.snapshot(invocationId)).toMatchObject({ state: "cancelled", activeCount: 0 });
  });
});
