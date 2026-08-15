import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SearchResult } from "../../../src/db/promoted.js";
import { StorageOperationError } from "../../../src/storage/errors.js";

const state = vi.hoisted(() => ({
  cwdError: undefined as unknown,
  exists: true,
  existsSequence: [] as boolean[],
  migrationError: undefined as unknown,
  identityError: undefined as unknown,
  orientationError: undefined as unknown,
  phaseError: undefined as "instruction-read" | "summary" | "project-search" | "instruction-write" | "passive" | undefined,
  storageError: undefined as unknown,
  rows: [] as Array<{ content: string }>,
  promoted: [] as SearchResult[],
  passive: [] as SearchResult[],
  closed: [] as string[],
  instructionPaths: [] as string[],
  instructionContent: undefined as string | undefined,
  instructionRow: null as null | {
    clientName: "claude" | "codex";
    sessionId: string;
    worktreePath: string;
    cwdPath: string;
    content: string;
    contentHash: string;
    updatedAt: string;
  },
  instructionGets: [] as Array<{
    clientName: "claude" | "codex";
    sessionId: string;
    worktreePath: string;
    cwdPath: string;
  }>,
  instructionUpserts: [] as Array<{
    scope: {
      clientName: "claude" | "codex";
      sessionId: string;
      worktreePath: string;
      cwdPath: string;
    };
    content: string;
    hash: string;
  }>,
  instructionUpsertError: undefined as unknown,
  instructionDeletes: 0,
  instructionDeleteError: undefined as unknown,
  openCount: 0,
  projectExistsCount: 0,
  anchors: [] as Array<null | {
    canonical: string;
    worktreeRoot: string;
    commonDir: string;
  }>,
}));

vi.mock("../../../src/daemon/validate-cwd.js", () => ({
  validateCwd: (cwd: string) => {
    if (state.cwdError !== undefined) throw state.cwdError;
    return cwd;
  },
}));

vi.mock("../../../src/daemon/project.js", () => ({
  projectDbPath: (cwd: string) => `${cwd}/lcm.db`,
  projectIdentity: (cwd: string) => {
    if (state.identityError !== undefined) throw state.identityError;
    return { id: "pid", canonical: cwd };
  },
}));
vi.mock("../../../src/git-project.js", () => ({
  resolveGitProjectAnchor: () => state.anchors.shift() ?? null,
}));
vi.mock("../../../src/daemon/orientation.js", () => ({
  buildOrientationPrompt: () => {
    if (state.orientationError !== undefined) throw state.orientationError;
    return "orientation";
  },
}));
vi.mock("../../../src/daemon/content-fence.js", () => ({ fenceContent: (content: string, label: string) => `<${label}>${content}</${label}>` }));
vi.mock("../../../src/security-files.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/security-files.js")>()),
  readBoundedRegularFile: (path: string) => {
    state.instructionPaths.push(path);
    if (path === "/does-not-exist") return "{}";
    if (state.instructionContent !== undefined) return state.instructionContent;
    throw Object.assign(new Error("missing"), { code: "ENOENT" });
  },
}));
vi.mock("../../../src/daemon/routes/compact.js", () => ({
  justCompactedMap: new Map<string, number>(),
  JUST_COMPACTED_TTL_MS: 30_000,
}));
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  homedir: () => process.env.HOME!,
}));
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  existsSync: () => state.existsSequence.shift() ?? state.exists,
  mkdirSync: vi.fn(),
  readFileSync: () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
}));

const db = vi.hoisted(() => ({
  prepare: (sql: string) => ({
    get: () => sql.includes("session_instruction_cache") ? undefined : undefined,
    all: () => sql.includes("FROM summaries") ? state.rows : [],
    run: () => undefined,
  }),
}));

vi.mock("../../../src/db/connection.js", () => ({
  getLcmConnection: () => db,
  closeLcmConnection: (path: string) => state.closed.push(path),
}));
vi.mock("../../../src/db/migration.js", () => ({
  runLcmMigrations: () => {
    if (state.migrationError !== undefined) throw state.migrationError;
  },
}));
vi.mock("../../../src/db/promoted.js", () => ({
  PromotedStore: class {
    search(query: string) { return query === "source passive capture" ? state.passive : state.promoted; }
  },
}));
vi.mock("../../../src/storage/index.js", () => ({
  createStorageBackendFactory: async () => {
    const projectExists = async () => {
      state.projectExistsCount += 1;
      return state.existsSequence.shift() ?? state.exists;
    };
    const openProject = async () => {
      state.openCount += 1;
      if (state.migrationError !== undefined) throw state.migrationError;
      return {
        summaries: {
          listRecentSummariesForSession: async () => {
            if (state.phaseError === "summary") throw state.storageError;
            return state.rows;
          },
        },
        lexicalSearch: {
          searchPromoted: async (query: string) => {
            if (query === "source passive capture" && state.phaseError === "passive") throw state.storageError;
            if (query !== "source passive capture" && state.phaseError === "project-search") throw state.storageError;
            return query === "source passive capture" ? state.passive : state.promoted;
          },
        },
        coordination: {
          getSessionInstructions: async (
            scope: (typeof state.instructionGets)[number],
          ) => {
            if (state.phaseError === "instruction-read") throw state.storageError;
            state.instructionGets.push(scope);
            return state.instructionRow;
          },
          upsertSessionInstructions: async (
            scope: (typeof state.instructionUpserts)[number]["scope"],
            content: string,
            hash: string,
          ) => {
            state.instructionUpserts.push({ scope, content, hash });
            if (state.phaseError === "instruction-write") throw state.storageError;
            if (state.instructionUpsertError !== undefined) {
              throw state.instructionUpsertError;
            }
          },
          deleteSessionInstructions: async () => {
            state.instructionDeletes += 1;
            if (state.phaseError === "instruction-write") throw state.storageError;
            if (state.instructionDeleteError !== undefined) {
              throw state.instructionDeleteError;
            }
          },
        },
        close: async () => { state.closed.push("project"); },
      };
    };
    return {
      projectExists,
      openExistingProject: async () => await projectExists() ? openProject() : null,
      openProject,
      close: async () => { state.closed.push("factory"); },
    };
  },
}));

import { loadDaemonConfig } from "../../../src/daemon/config.js";
import { JUST_COMPACTED_TTL_MS, justCompactedMap } from "../../../src/daemon/routes/compact.js";
import { createRestoreHandler } from "../../../src/daemon/routes/restore.js";

function response() {
  let payload = "";
  return {
    res: { writeHead: vi.fn().mockReturnThis(), end: vi.fn((body?: string) => { payload = body ?? ""; }) } as never,
    json: () => JSON.parse(payload || "{}") as Record<string, unknown>,
  };
}

function config() {
  const exists = state.exists;
  state.exists = false;
  try {
    return loadDaemonConfig("/does-not-exist");
  } finally {
    state.exists = exists;
  }
}

async function call(body: string, value = config()) {
  const output = response();
  await createRestoreHandler(value)({} as never, output.res, body);
  return output.json();
}

function promoted(id: string, overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    id,
    content: `content ${id}`,
    tags: ["source:passive-capture"],
    projectId: "project",
    sessionId: null,
    confidence: 0.9,
    createdAt: new Date().toISOString(),
    rank: -1,
    ...overrides,
  };
}

describe("restore route coverage", () => {
  beforeEach(() => {
    state.cwdError = undefined;
    state.exists = true;
    state.existsSequence = [];
    state.migrationError = undefined;
    state.identityError = undefined;
    state.orientationError = undefined;
    state.phaseError = undefined;
    state.storageError = undefined;
    state.rows = [];
    state.promoted = [];
    state.passive = [];
    state.closed = [];
    state.instructionPaths = [];
    state.instructionContent = undefined;
    state.instructionRow = null;
    state.instructionGets = [];
    state.instructionUpserts = [];
    state.instructionUpsertError = undefined;
    state.instructionDeletes = 0;
    state.instructionDeleteError = undefined;
    state.openCount = 0;
    state.projectExistsCount = 0;
    state.anchors = [];
    justCompactedMap.clear();
  });

  it("uses empty-body and absent-cwd branches", async () => {
    expect(await call("")).toEqual({ context: "orientation" });
    expect(await call(JSON.stringify({ cwd: "/tmp" }))).toEqual({
      error: "session_id must be a non-empty string",
    });
    expect(await call(JSON.stringify({ cwd: "/tmp", session_id: "" }))).toEqual({
      error: "session_id must be a non-empty string",
    });
  });

  it("bounds instruction framing before reading files with oversized labels", async () => {
    const oversizedCwd = `/${"x".repeat(1024 * 1024)}`;
    const body = await call(JSON.stringify({
      session_id: "oversized-instruction-label",
      cwd: oversizedCwd,
      source: "startup",
      client: "codex",
    }));
    expect(body).toEqual({ context: "orientation" });
    expect(state.instructionPaths.some((path) => path.startsWith(oversizedCwd))).toBe(false);
  });

  it("skips filesystem work when framing exactly consumes the remaining budget", async () => {
    const suffix = "/AGENTS.md";
    const exactCwd = `/${"x".repeat(1024 * 1024 - Buffer.byteLength(`/${suffix}`) - 3)}`;
    const body = await call(JSON.stringify({
      session_id: "exact-instruction-label",
      cwd: exactCwd,
      source: "startup",
      client: "codex",
    }));

    expect(body).toEqual({ context: "orientation" });
    expect(state.instructionPaths).not.toContain(`${exactCwd}${suffix}`);
  });

  it.each([
    [new Error("bad cwd"), "bad cwd"],
    ["bad cwd", "invalid cwd"],
  ])("reports cwd validation failures", async (error, message) => {
    state.cwdError = error;
    expect(await call(JSON.stringify({ session_id: "s", cwd: "/tmp" }))).toEqual({ error: message });
  });

  it("does not treat an expired compaction marker as post-compact", async () => {
    justCompactedMap.set("old", Date.now() - JUST_COMPACTED_TTL_MS - 1);
    expect(await call(JSON.stringify({ session_id: "old" }))).toEqual({ context: "orientation" });
  });

  it("restores persisted instructions after compaction", async () => {
    state.instructionRow = {
      clientName: "claude",
      sessionId: "s",
      worktreePath: "/tmp",
      cwdPath: "/tmp",
      content: "persisted rules",
      contentHash: "hash",
      updatedAt: "now",
    };
    expect(await call(JSON.stringify({ session_id: "s", cwd: "/tmp", source: "compact" })))
      .toEqual({ context: "orientation\n\n<project-instructions>\npersisted rules\n</project-instructions>" });
    expect(state.instructionGets).toEqual([{
      clientName: "claude",
      sessionId: "s",
      worktreePath: "/tmp",
      cwdPath: "/tmp",
    }]);
  });

  it("uses the authenticated worktree scope and rejects topology changes before storage", async () => {
    const anchor = {
      canonical: "/repo",
      worktreeRoot: "/repo/worktrees/one",
      commonDir: "/repo/.git",
    };
    state.anchors = [anchor, anchor];
    await call(JSON.stringify({
      session_id: "scoped-session",
      cwd: "/repo/worktrees/one/src",
      source: "compact",
      client: "codex",
    }));
    expect(state.instructionGets).toEqual([{
      clientName: "codex",
      sessionId: "scoped-session",
      worktreePath: "/repo/worktrees/one",
      cwdPath: "/repo/worktrees/one/src",
    }]);

    state.instructionGets = [];
    state.openCount = 0;
    state.projectExistsCount = 0;
    state.anchors = [
      anchor,
      { ...anchor, worktreeRoot: "/repo/worktrees/two" },
    ];
    expect(await call(JSON.stringify({
      session_id: "changed-topology",
      cwd: "/repo/worktrees/one/src",
      source: "startup",
    }))).toEqual({ context: "orientation" });
    expect(state.instructionGets).toEqual([]);
    expect(state.openCount).toBe(0);
    expect(state.projectExistsCount).toBe(0);
  });

  it.each([
    ["lone high surrogate one", "\ud800"],
    ["lone high surrogate two", "\ud801"],
    ["lone low surrogate one", "\udc00"],
    ["lone low surrogate two", "\udc01"],
  ])("rejects a %s session identity before storage", async (_label, sessionId) => {
    expect(await call(JSON.stringify({
      session_id: sessionId,
      cwd: "/tmp",
      client: "claude",
    }))).toEqual({ context: "orientation" });
    expect({
      instructionGets: state.instructionGets,
      instructionUpserts: state.instructionUpserts,
      instructionDeletes: state.instructionDeletes,
      openCount: state.openCount,
      projectExistsCount: state.projectExistsCount,
    }).toEqual({
      instructionGets: [],
      instructionUpserts: [],
      instructionDeletes: 0,
      openCount: 0,
      projectExistsCount: 0,
    });
  });

  it("captures changed instruction files through coordination repositories", async () => {
    state.instructionContent = "new rules";
    const body = await call(JSON.stringify({ session_id: "s", cwd: "/tmp", client: "claude" }));
    expect(body.context).toContain("new rules");
    expect(state.instructionUpserts).toHaveLength(1);
    expect(state.instructionUpserts[0]?.scope).toEqual({
      clientName: "claude",
      sessionId: "s",
      worktreePath: "/tmp",
      cwdPath: "/tmp",
    });
    expect(state.instructionUpserts[0]?.content).toContain("new rules");
    const currentHash = state.instructionUpserts[0]!.hash;

    state.instructionRow = {
      clientName: "claude",
      sessionId: "s",
      worktreePath: "/tmp",
      cwdPath: "/tmp",
      content: "old rules",
      contentHash: "old",
      updatedAt: "now",
    };
    await call(JSON.stringify({ session_id: "s", cwd: "/tmp", client: "claude" }));
    expect(state.instructionUpserts).toHaveLength(2);

    state.instructionRow = {
      clientName: "claude",
      sessionId: "s",
      worktreePath: "/tmp",
      cwdPath: "/tmp",
      content: "new rules",
      contentHash: currentHash,
      updatedAt: "now",
    };
    await call(JSON.stringify({ session_id: "s", cwd: "/tmp", client: "claude" }));
    expect(state.instructionUpserts).toHaveLength(2);
  });

  it("returns fresh local instructions when best-effort cache upsert fails", async () => {
    state.instructionContent = "fresh local rules";
    state.instructionRow = {
      clientName: "claude",
      sessionId: "s",
      worktreePath: "/tmp",
      cwdPath: "/tmp",
      content: "stale cached rules",
      contentHash: "stale",
      updatedAt: "now",
    };
    state.instructionUpsertError = new Error("upsert failed");

    const body = await call(JSON.stringify({
      session_id: "s",
      cwd: "/tmp",
      client: "claude",
    }));

    expect(body.context).toContain("fresh local rules");
    expect(body.context).not.toContain("stale cached rules");
    expect(state.instructionUpserts).toHaveLength(1);
    expect(state.instructionRow.content).toBe("stale cached rules");
  });

  it("clears stale returned instructions when best-effort cache delete fails", async () => {
    state.instructionRow = {
      clientName: "claude",
      sessionId: "s",
      worktreePath: "/tmp",
      cwdPath: "/tmp",
      content: "stale cached rules",
      contentHash: "stale",
      updatedAt: "now",
    };
    state.instructionDeleteError = new Error("delete failed");

    const body = await call(JSON.stringify({
      session_id: "s",
      cwd: "/tmp",
      client: "claude",
    }));

    expect(body.context).not.toContain("project-instructions");
    expect(body.context).not.toContain("stale cached rules");
    expect(state.instructionDeletes).toBe(1);
    expect(state.instructionRow.content).toBe("stale cached rules");
  });

  it("fences recent summaries and applies default insight thresholds", async () => {
    state.rows = [{ content: "first" }, { content: "second" }];
    state.promoted = [promoted("project")];
    state.passive = [promoted("passive")];
    const value = config();
    delete value.compaction.promotionThresholds.eventConfidence;
    delete value.compaction.promotionThresholds.insightsMaxAgeDays;
    const body = await call(JSON.stringify({ session_id: "s", cwd: "/tmp" }), value);
    expect(body.context).toContain("<recent-session-context>first\n\nsecond</recent-session-context>");
    expect(body).toHaveProperty("insights.0.content", "content passive");
  });

  it("skips missing databases in both lookup phases", async () => {
    state.exists = false;
    const body = await call(JSON.stringify({ session_id: "s", cwd: "/tmp", source: "compact" }));
    expect(body).toEqual({ context: "orientation" });
    expect(state.closed).toEqual(["factory"]);
  });

  it("creates project storage during startup restoration", async () => {
    state.exists = false;
    const body = await call(JSON.stringify({ session_id: "s", cwd: "/tmp" }));
    expect(body).toEqual({ context: "orientation" });
    expect(state.openCount).toBe(1);
    expect(state.projectExistsCount).toBe(0);
    expect(state.closed).toEqual(["project", "factory"]);
  });

  it("reuses one opened project throughout startup restoration", async () => {
    state.existsSequence = [true, false];
    const body = await call(JSON.stringify({ session_id: "s", cwd: "/tmp" }));
    expect(body).toEqual({ context: "orientation" });
    expect(state.openCount).toBe(1);
    expect(state.projectExistsCount).toBe(0);
    expect(state.existsSequence).toEqual([true, false]);
  });

  it("tolerates database failures in restoration phases", async () => {
    state.migrationError = new Error("broken database");
    expect(await call(JSON.stringify({ session_id: "s", cwd: "/tmp" }))).toEqual({ context: "orientation" });
    expect(state.closed.length).toBeGreaterThan(0);
  });

  it("maps typed PostgreSQL failures from identity, opening, and every repository phase", async () => {
    const typed = () => new StorageOperationError(
      "STORAGE_OPERATION_FAILED",
      "postgresql",
      "project",
      "restore",
      "restore",
    );
    const postgresql = {
      ...config(),
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
    } as Parameters<typeof createRestoreHandler>[0];

    state.identityError = typed();
    expect(await call(JSON.stringify({ session_id: "s", cwd: "/tmp" }), postgresql)).toMatchObject({
      code: "STORAGE_OPERATION_FAILED",
    });
    state.identityError = undefined;

    state.migrationError = typed();
    expect(await call(JSON.stringify({ session_id: "s", cwd: "/tmp" }), postgresql)).toMatchObject({
      code: "STORAGE_OPERATION_FAILED",
    });
    state.migrationError = undefined;

    state.instructionContent = "rules";
    for (const phase of ["instruction-read", "summary", "project-search", "instruction-write", "passive"] as const) {
      state.phaseError = phase;
      state.storageError = typed();
      expect(await call(JSON.stringify({ session_id: `s-${phase}`, cwd: "/tmp" }), postgresql)).toMatchObject({
        code: "STORAGE_OPERATION_FAILED",
      });
      state.phaseError = undefined;
    }

    state.orientationError = typed();
    expect(await call(JSON.stringify({ session_id: "s", cwd: "/tmp" }), postgresql)).toMatchObject({
      code: "STORAGE_OPERATION_FAILED",
    });
  });

  it("reports Error and non-Error outer failures", async () => {
    expect(await call("{")).toEqual({ error: expect.stringContaining("JSON") });
    const value = config();
    const parse = vi.spyOn(JSON, "parse").mockImplementationOnce(() => { throw "parse failed"; });
    const output = response();
    await createRestoreHandler(value)({} as never, output.res, "{}");
    parse.mockRestore();
    expect(output.json()).toEqual({ error: "restore failed" });
  });
});
