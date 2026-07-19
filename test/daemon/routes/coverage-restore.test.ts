import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SearchResult } from "../../../src/db/promoted.js";

const state = vi.hoisted(() => ({
  cwdError: undefined as unknown,
  exists: true,
  existsSequence: [] as boolean[],
  migrationError: undefined as unknown,
  rows: [] as Array<{ content: string }>,
  promoted: [] as SearchResult[],
  passive: [] as SearchResult[],
  closed: [] as string[],
}));

vi.mock("../../../src/daemon/validate-cwd.js", () => ({
  validateCwd: (cwd: string) => {
    if (state.cwdError !== undefined) throw state.cwdError;
    return cwd;
  },
}));

vi.mock("../../../src/daemon/project.js", () => ({ projectDbPath: (cwd: string) => `${cwd}/lcm.db` }));
vi.mock("../../../src/daemon/orientation.js", () => ({ buildOrientationPrompt: () => "orientation" }));
vi.mock("../../../src/daemon/content-fence.js", () => ({ fenceContent: (content: string, label: string) => `<${label}>${content}</${label}>` }));
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
    state.rows = [];
    state.promoted = [];
    state.passive = [];
    state.closed = [];
    justCompactedMap.clear();
  });

  it("uses empty-body and absent-cwd branches", async () => {
    expect(await call("")).toEqual({ context: "orientation" });
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
    expect(state.closed).toEqual([]);
  });

  it("skips a vanished database during passive insight lookup", async () => {
    state.existsSequence = [true, false];
    const body = await call(JSON.stringify({ session_id: "s", cwd: "/tmp" }));
    expect(body).toEqual({ context: "orientation" });
  });

  it("tolerates database failures in restoration phases", async () => {
    state.migrationError = new Error("broken database");
    expect(await call(JSON.stringify({ session_id: "s", cwd: "/tmp" }))).toEqual({ context: "orientation" });
    expect(state.closed.length).toBeGreaterThan(0);
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
