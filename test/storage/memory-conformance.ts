import { expect } from "vitest";
import type {
  CoordinationRepository,
  PromotedMemoryRepository,
  RecallRepository,
  RedactionAdminRepository,
} from "../../src/storage/contracts.js";

export async function exercisePromotedMemoryRepositoryConformance(
  repository: PromotedMemoryRepository,
): Promise<string> {
  const memoryId = await repository.insert({
    content: "durable memory",
    tags: ["architecture", "Mixed", "", " spaced ", "Mixed"],
    metadata: {
      source: "conformance",
      nested: { enabled: true },
    },
    sourceSummaryId: "external-summary",
    sourceProjectId: "external-project",
    sessionId: "session-a",
    depth: 2,
    confidence: 0.75,
  });
  expect(await repository.getById(memoryId)).toMatchObject({
    id: memoryId,
    tags: ["architecture", "Mixed", "", " spaced ", "Mixed"],
    metadata: {
      nested: { enabled: true },
      source: "conformance",
    },
    projectId: "external-project",
  });
  expect(await repository.getById("missing")).toBeNull();
  expect(await repository.getAll({
    sourceProjectId: "external-project",
    tags: ["Mixed"],
  })).toHaveLength(1);
  expect(await repository.getAll({ since: "1970-01-01T00:00:00Z" }))
    .toHaveLength(1);
  expect(await repository.getAll({ sourceProjectId: "" })).toEqual([]);
  expect(await repository.getAll({ tags: ["mixed"] })).toEqual([]);
  expect(await repository.listContentPrefixes(0)).toEqual([]);
  expect(await repository.listContentPrefixes(-1)).toEqual(["durable memory"]);
  await repository.update(memoryId, {
    content: "updated durable memory",
    tags: ["updated"],
    metadata: { revision: 2 },
    confidence: 0.9,
  });
  expect(await repository.findStale({
    staleAfterDays: -1,
    staleSurfacingWithoutUseLimit: 2,
    sourceProjectId: "external-project",
  })).toMatchObject([{
    id: memoryId,
    metadata: { revision: 2 },
    surfacingCount: 0,
    usageCount: 0,
  }]);
  expect(await repository.findStale({
    staleAfterDays: -1,
    staleSurfacingWithoutUseLimit: 2,
    sourceProjectId: "",
  })).toEqual([]);
  await repository.archive(memoryId);
  expect(await repository.getAll()).toEqual([]);
  await repository.revive(memoryId);
  expect(await repository.getAll()).toHaveLength(1);
  return memoryId;
}

export async function exerciseRecallRepositoryConformance(
  repository: RecallRepository,
): Promise<void> {
  await repository.logSurfacing(["memory-a", "memory-a", "memory-b"], null);
  await repository.logSurfacing([], "session-a");
  const feedback = await repository.getFeedback(["memory-a", "memory-b"]);
  expect(feedback.get("memory-a")).toMatchObject({
    surfacingCount: 2,
    usageCount: 0,
  });
  expect(feedback.get("memory-a")?.lastSurfacedAt)
    .toMatch(/^\d{4}-\d{2}-\d{2}T/u);
  expect(feedback.get("memory-b")?.surfacingCount).toBe(1);
  expect(await repository.getFeedback([])).toEqual(new Map());
  expect(await repository.getStats()).toMatchObject({
    memoriesSurfaced: 2,
    memoriesActedUpon: 0,
    recallPrecision: 0,
    topRecalled: [],
  });
}

export async function exerciseRedactionAdminRepositoryConformance(
  repository: RedactionAdminRepository,
): Promise<void> {
  await repository.upsertCounts({
    gitleaks: 1,
    builtIn: 2,
    global: 3,
    project: 4,
  });
  await repository.upsertCounts({
    gitleaks: 0,
    builtIn: 0,
    global: 0,
    project: 0,
  });
  expect(await repository.getCounts()).toEqual({
    gitleaks: 1,
    builtIn: 2,
    global: 3,
    project: 4,
    total: 10,
  });
  expect(await repository.purgeProjectState()).toMatchObject({
    redactionCounters: 4,
  });
  expect(await repository.getCounts()).toEqual({
    gitleaks: 0,
    builtIn: 0,
    global: 0,
    project: 0,
    total: 0,
  });
}

export async function exerciseCoordinationRepositoryConformance(
  repository: CoordinationRepository,
): Promise<void> {
  expect(await repository.getSessionIngest("missing")).toBeNull();
  await repository.recordSessionIngest("session-a", 2);
  await repository.recordSessionIngest("session-a", 3);
  expect(await repository.getSessionIngest("session-a")).toMatchObject({
    sessionId: "session-a",
    messageCount: 3,
  });
  expect(await repository.getSessionInstructions(2, 1)).toBeNull();
  await repository.upsertSessionInstructions(2, "current", "hash-2");
  expect(await repository.getSessionInstructions(2)).toMatchObject({
    id: 2,
    content: "current",
    contentHash: "hash-2",
  });
  await repository.deleteSessionInstructions(2);
  expect(await repository.getSessionInstructions(2)).toBeNull();
}
