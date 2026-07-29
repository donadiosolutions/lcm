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
  const signalId = await repository.insert({
    content: "acted on durable memory",
    tags: [
      "signal:memory_used",
      "signal:memory_used",
      `memory_id:${memoryId}`,
      "memory_id:not-the-first-reference",
    ],
  });
  expect(await repository.findStale({
    staleAfterDays: -1,
    staleSurfacingWithoutUseLimit: 2,
    sourceProjectId: "external-project",
  })).toEqual([]);
  await repository.deleteById(signalId);
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
  promotedMemory?: PromotedMemoryRepository,
): Promise<void> {
  if (promotedMemory) {
    await promotedMemory.insert({
      content: "acted on memory-a",
      tags: [
        "signal:memory_used",
        "signal:memory_used",
        "memory_id:memory-a",
        "memory_id:memory-b",
      ],
    });
  }
  await repository.logSurfacing(["memory-a", "memory-a", "memory-b"], null);
  await repository.logSurfacing([], "session-a");
  const feedback = await repository.getFeedback(["memory-a", "memory-b"]);
  expect(feedback.get("memory-a")).toMatchObject({
    surfacingCount: 2,
    usageCount: promotedMemory ? 1 : 0,
  });
  expect(feedback.get("memory-a")?.lastSurfacedAt)
    .toMatch(/^\d{4}-\d{2}-\d{2}T/u);
  expect(feedback.get("memory-b")).toMatchObject({
    surfacingCount: 1,
    usageCount: 0,
  });
  expect(await repository.getFeedback([])).toEqual(new Map());
  expect(await repository.getStats()).toMatchObject({
    memoriesSurfaced: 2,
    memoriesActedUpon: promotedMemory ? 1 : 0,
    recallPrecision: promotedMemory ? 50 : 0,
    topRecalled: promotedMemory
      ? [{
          id: "memory-a",
          content: "(memory not found)",
          actCount: 1,
        }]
      : [],
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
  const instructionScope = {
    clientName: "codex",
    sessionId: "session-a",
    worktreePath: "/repo/worktree-a",
    cwdPath: "/repo/worktree-a/src",
  } as const;
  expect(await repository.getSessionIngest("missing")).toBeNull();
  await repository.recordSessionIngest("session-a", 2);
  await repository.recordSessionIngest("session-a", 3);
  expect(await repository.getSessionIngest("session-a")).toMatchObject({
    sessionId: "session-a",
    messageCount: 3,
  });
  expect(await repository.getSessionInstructions(instructionScope)).toBeNull();
  await repository.upsertSessionInstructions(
    instructionScope,
    "current",
    "hash-2",
  );
  expect(await repository.getSessionInstructions(instructionScope)).toMatchObject({
    ...instructionScope,
    content: "current",
    contentHash: "hash-2",
  });
  for (const changed of [
    { ...instructionScope, clientName: "claude" as const },
    { ...instructionScope, sessionId: "session-b" },
    { ...instructionScope, worktreePath: "/repo/worktree-b" },
    { ...instructionScope, cwdPath: "/repo/worktree-a/test" },
  ]) {
    expect(await repository.getSessionInstructions(changed)).toBeNull();
  }
  await repository.deleteSessionInstructions(instructionScope);
  expect(await repository.getSessionInstructions(instructionScope)).toBeNull();
}
