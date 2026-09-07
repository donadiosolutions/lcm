import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerResponse } from "node:http";
import type { SearchResult } from "../../../src/db/promoted.js";
import type { RecallFeedback } from "../../../src/db/recall.js";
import type { ProjectStorage } from "../../../src/storage/index.js";
import { StorageOperationError } from "../../../src/storage/errors.js";
import { loadDaemonConfig } from "../../../src/daemon/config.js";
import { createPromptSearchHandler } from "../../../src/daemon/routes/prompt-search.js";
import { makeMockStorageFactory } from "./mock-storage-factory.js";

vi.mock("../../../src/daemon/validate-cwd.js", () => ({ validateCwd: (cwd: string) => cwd }));
vi.mock("../../../src/daemon/project.js", () => ({ projectIdentity: (cwd: string) => ({ id: cwd, canonical: cwd }) }));

const NOW = "2026-01-01T00:00:00.000Z";
type Candidate = { result: SearchResult; evidence: { matchedTermCount: number; queryTermCount: number } };
function candidate(m = 4, n = 4, overrides: Partial<SearchResult> = {}): Candidate {
  return { result: {
    id: "memory", content: "run swim jump walk", tags: [], projectId: "project", sessionId: "same",
    confidence: 0.8, createdAt: NOW, rank: -0.000001, ...overrides,
  }, evidence: { matchedTermCount: m, queryTermCount: n } };
}

type DebugCandidate = {
  id: string; rank: number; lexicalScore: number; matchedTermCount: number; queryTermCount: number;
  wholeTextMatch: boolean; strongMatchBonus: number; baseScore: number; finalScore: number;
  usageBoost: number; unusedPenalty: number; stalePenalty: number;
};
async function invoke(candidates: Candidate[], options: {
  query?: string; session?: string; minimum?: number; feedback?: RecallFeedback; feedbackById?: Map<string, RecallFeedback>;
  backend?: "sqlite" | "postgresql"; failure?: Error; debug?: boolean;
  restoration?: Partial<ReturnType<typeof loadDaemonConfig>["restoration"]>;
} = {}) {
  const config = loadDaemonConfig("/does-not-exist");
  config.restoration.maxInjectedMemoryBytes = 10_000;
  config.restoration.reservedForLearningInstruction = 0;
  Object.assign(config.restoration, options.restoration);
  if (options.minimum !== undefined) config.restoration.promptSearchMinScore = options.minimum;
  const backend = options.backend ?? "sqlite";
  if (backend === "postgresql") config.storage = { backend, postgresql: {
    url: "postgresql://user:secret@db.example/lcm", poolMax: 5, connectionTimeoutMs: 10_000,
    idleTimeoutMs: 30_000, statementTimeoutMs: 60_000,
  } };
  const getFeedback = vi.fn(async () => options.feedbackById ?? new Map(options.feedback ? candidates.map(({ result }) => [result.id, options.feedback!]) : []));
  const logSurfacing = vi.fn(async () => undefined);
  const close = vi.fn(async () => undefined);
  const searchPromoted = vi.fn(async () => candidates.map(({ result }) => result));
  const searchPromotedForRecall = vi.fn(async () => {
    if (options.failure) throw options.failure;
    return { candidates };
  });
  const factory = { ...makeMockStorageFactory({ openProject: async () => ({
    lexicalSearch: { searchPromoted, searchPromotedForRecall }, recall: { getFeedback, logSurfacing }, close,
  }) as unknown as ProjectStorage }), backend };
  let status = 0;
  let payload = "";
  const res = { writeHead: (code: number) => { status = code; }, end: (body: string) => { payload = body; } } as unknown as ServerResponse;
  await createPromptSearchHandler(config, factory)({} as never, res, JSON.stringify({
    query: options.query ?? "running swimming jumping walking", cwd: "/tmp", session_id: options.session,
    debug: options.debug ?? true,
  }));
  const body = JSON.parse(payload) as { hints: string[]; ids?: string[]; debug?: { candidates: DebugCandidate[] } };
  return { body, status, payload, getFeedback, logSurfacing, close, searchPromoted, searchPromotedForRecall };
}

describe("prompt-search native evidence scoring", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(NOW)); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it.each([-0.000001, -0.1, -3.621484, -1000, 1000])("ignores native rank %s and keeps it in debug", async (rank) => {
    const output = await invoke([candidate(4, 4, { rank })]);
    expect(output.body.ids).toEqual(["memory"]);
    expect(output.body.debug?.candidates[0]).toMatchObject({ rank, lexicalScore: 4, baseScore: 4, finalScore: 4, matchedTermCount: 4, queryTermCount: 4, wholeTextMatch: false, strongMatchBonus: 0 });
    expect(output.searchPromoted).not.toHaveBeenCalled();
    expect(output.searchPromotedForRecall).toHaveBeenCalledWith("running swimming jumping walking", 15);
  });

  it.each([0, 1, 2, 3, 4])("scores %i matched native terms monotonically", async (m) => {
    const output = await invoke([candidate(m)]);
    expect(output.body.debug?.candidates[0]?.lexicalScore).toBe(m);
    expect(output.body.ids).toEqual(m >= 2 ? ["memory"] : []);
  });

  it.each([40, 80])("does not divide four matches by %i query terms", async (n) => {
    const output = await invoke([candidate(4, n)], { query: `running swimming jumping walking ${"unrelated ".repeat(n - 4)}` });
    expect(output.body.ids).toEqual(["memory"]);
    expect(output.body.debug?.candidates[0]).toMatchObject({ lexicalScore: 4, queryTermCount: n });
  });

  it.each([
    ["run swim jump walk", "RUN\u2003SWIM\u0085JUMP\uFEFFWALK", 4, true],
    ["ｒｕｎ swim jump walk", "run swim jump walk", 4, true],
    ["run swim jump walk", "walk jump swim run", 4, false],
    ["run swim jump walk", "run swim jump walk walk", 4, false],
    ["run, swim jump walk", "run swim jump walk", 4, false],
    ["prefix run swim jump walk suffix", "run swim jump walk", 4, false],
    ["run swim jump walk", "running swimming jumping walking", 4, false],
    ["café", "cafe", 1, false],
    ["different", "tag", 1, false],
    ["!!!", "!!!", 0, false],
    [" \uFEFF", "\u2003", 1, false],
    ["run", "run", 0, false],
    ["run", "run", 1, true],
    ["run swim", "run swim", 2, true],
  ] as const)("whole text guard: %j versus %j", async (content, query, m, wholeTextMatch) => {
    const output = await invoke([candidate(m, Math.max(m, 4), { content, tags: [query] })], { query });
    expect(output.body.debug?.candidates[0]).toMatchObject({ wholeTextMatch, strongMatchBonus: wholeTextMatch ? 4 : 0, lexicalScore: m + (wholeTextMatch ? 4 : 0) });
  });

  it.each([
    [0, undefined, 2, 4, true], [24, undefined, 2, 2, true], [48, undefined, 2, 1, false],
    [0, "same", 2, 4, true], [0, "other", 2, 3.4, true], [0, undefined, 5, 4, false],
  ] as const)("preserves age %i/session %s/threshold %i", async (age, session, minimum, score, surfaced) => {
    const output = await invoke([candidate(4, 4, { createdAt: new Date(Date.parse(NOW) - age * 3_600_000).toISOString() })], { session, minimum });
    expect(output.body.debug?.candidates[0]?.finalScore).toBe(score);
    expect(output.body.ids).toEqual(surfaced ? ["memory"] : []);
  });

  it.each([[1, 5, 4.25], [2, 6, 5.1], [4, 8, 6.8]])("adds whole-text bonus before affinity for m%i", async (m, same, cross) => {
    for (const [session, expected] of [[undefined, same], ["other", cross]] as const) {
      const output = await invoke([candidate(m)], { query: "run swim jump walk", session });
      expect(output.body.debug?.candidates[0]?.finalScore).toBe(expected);
      expect(output.body.ids).toEqual(["memory"]);
    }
  });

  it("does not bypass a stricter threshold for exact text", async () => {
    const output = await invoke([candidate()], { query: "run swim jump walk", minimum: 17 });
    expect(output.body.ids).toEqual([]);
    expect(output.body.debug?.candidates[0]?.finalScore).toBe(8);
  });

  it("refuses a two-term cross-session partial at default two", async () => {
    const output = await invoke([candidate(2)], { session: "other" });
    expect(output.body.debug?.candidates[0]?.finalScore).toBe(1.7);
    expect(output.body.ids).toEqual([]);
  });

  it.each([[false, 1, 3.85], [false, 10, 2.5], [true, 1, 7.85], [true, 10, 6.5]] as const)("pins unused penalty whole=%s count=%i", async (whole, count, score) => {
    const output = await invoke([candidate()], {
      query: whole ? "run swim jump walk" : undefined,
      feedback: { usageCount: 0, surfacingCount: count, lastSurfacedAt: null },
    });
    expect(output.body.debug?.candidates[0]).toMatchObject({ finalScore: score, unusedPenalty: count * 0.15 });
  });

  it("preserves usage boost and stale subtraction after lexical evidence", async () => {
    const used = await invoke([candidate()], { feedback: { usageCount: 2, surfacingCount: 10, lastSurfacedAt: null }, restoration: { recallUsageBoost: 0.5, recallUsageSmoothing: 2 } });
    expect(used.body.debug?.candidates[0]).toMatchObject({ usageBoost: 1.25, unusedPenalty: 0, finalScore: 5 });
    const stale = await invoke([candidate()], { feedback: { usageCount: 0, surfacingCount: 5, lastSurfacedAt: null }, restoration: { staleAfterDays: 0, staleSurfacingWithoutUseLimit: 5 } });
    expect(stale.body.debug?.candidates[0]).toMatchObject({ stalePenalty: 0.5, finalScore: 2.75 });
  });

  it("preserves repository ordering on exact comparator ties", async () => {
    const output = await invoke([candidate(4, 4, { id: "z" }), candidate(4, 4, { id: "a", content: "another four term memory" })]);
    expect(output.body.debug?.candidates.map(({ id }) => id)).toEqual(["z", "a"]);
    expect(output.body.ids).toEqual(["z", "a"]);
  });

  it("omits scoring evidence unless debug is requested", async () => {
    expect((await invoke([candidate()], { debug: false })).body).toEqual({ hints: ["run swim jump walk"], ids: ["memory"] });
  });

  it.each([NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, null, undefined])("rejects invalid native count %s before feedback", async (invalid) => {
    for (const field of ["matchedTermCount", "queryTermCount"] as const) {
      const bad = candidate();
      Object.assign(bad.evidence, { [field]: invalid });
      const output = await invoke([candidate(), bad]);
      expect(output.body).toEqual({ hints: [] });
      expect(output.getFeedback).not.toHaveBeenCalled();
      expect(output.logSurfacing).not.toHaveBeenCalled();
      expect(output.close).toHaveBeenCalledOnce();
    }
  });

  it("rejects m greater than n and keeps a complete n0 m0 candidate", async () => {
    expect((await invoke([candidate(2, 1)])).body).toEqual({ hints: [] });
    const empty = await invoke([candidate(0, 0)]);
    expect(empty.body.debug?.candidates[0]).toMatchObject({ lexicalScore: 0, queryTermCount: 0, matchedTermCount: 0 });
    expect(empty.body.ids).toEqual([]);
  });

  it.each(["sqlite", "postgresql"] as const)("does not expose partial candidates after late %s evidence failure", async (backend) => {
    const failure = new StorageOperationError("STORAGE_OPERATION_FAILED", backend, "/tmp", "lexical-search", "searchPromotedForRecall");
    const output = await invoke([candidate()], { backend, failure });
    expect(output.status).toBe(backend === "sqlite" ? 200 : 503);
    expect(output.body).toEqual(backend === "sqlite" ? { hints: [] } : failure.toJSON());
    expect(output.getFeedback).not.toHaveBeenCalled();
    expect(output.logSurfacing).not.toHaveBeenCalled();
    expect(output.close).toHaveBeenCalledOnce();
    expect(output.payload).not.toContain("secret");
  });

  it.each([null, undefined])("rejects missing evidence %s as a typed PostgreSQL failure", async (evidence) => {
    const malformed = candidate();
    Object.assign(malformed, { evidence });
    const output = await invoke([candidate(), malformed], { backend: "postgresql" });
    expect(output.status).toBe(503);
    expect(output.getFeedback).not.toHaveBeenCalled();
    expect(output.logSurfacing).not.toHaveBeenCalled();
  });

  it("keeps full native evidence above weak high-rank partials", async () => {
    const output = await invoke([
      candidate(1, 4, { id: "weak", rank: -1000, content: "running incidental prose" }),
      candidate(4, 4, { id: "full" }),
      candidate(0, 4, { id: "fallback", rank: 1000 }),
    ]);
    expect(output.body.ids).toEqual(["full"]);
    expect(output.body.debug?.candidates.map(({ id, lexicalScore }) => ({ id, lexicalScore })))
      .toEqual([{ id: "full", lexicalScore: 4 }, { id: "weak", lexicalScore: 1 }, { id: "fallback", lexicalScore: 0 }]);
    expect(output.logSurfacing).toHaveBeenCalledWith(["full"], null);
  });

  it.each([[4, false], [5, true]])("admits cooled score %i only at the configured margin", async (matched, admitted) => {
    const output = await invoke([
      candidate(4, 5, { id: "fresh" }),
      candidate(matched, 5, { id: "cooled", content: "different cooled content" }),
    ], {
      feedbackById: new Map([["cooled", { usageCount: 0, surfacingCount: 0, lastSurfacedAt: NOW }]]),
      restoration: { resurfaceMargin: 1 },
    });
    expect(output.body.ids).toEqual(admitted ? ["cooled", "fresh"] : ["fresh"]);
  });

  it("sanitizes invalid PostgreSQL evidence before feedback", async () => {
    const output = await invoke([candidate(2, 1)], { backend: "postgresql" });
    expect(output.status).toBe(503);
    expect(output.payload).not.toContain("secret");
    expect(output.getFeedback).not.toHaveBeenCalled();
    expect(output.logSurfacing).not.toHaveBeenCalled();
  });
});
