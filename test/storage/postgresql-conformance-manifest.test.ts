import { describe, expect, it } from "vitest";
import {
  PostgreSqlConversationRepository,
  PostgreSqlCoordinationRepository,
  PostgreSqlPromotedMemoryRepository,
  PostgreSqlRecallRepository,
  PostgreSqlRedactionAdminRepository,
} from "../../src/storage/postgresql/index.js";
import { exerciseConversationRepositoryConformance } from "./conversation-conformance.js";
import {
  exerciseCoordinationRepositoryConformance,
  exercisePromotedMemoryRepositoryConformance,
  exerciseRecallRepositoryConformance,
  exerciseRedactionAdminRepositoryConformance,
} from "./memory-conformance.js";
import {
  POSTGRESQL_PROJECT_REPOSITORY_ADAPTERS,
  POSTGRESQL_PROJECT_REPOSITORY_CONFORMANCE,
} from "./postgresql-conformance-manifest.js";

describe("PostgreSQL project repository conformance manifest", () => {
  it("registers every exposed project repository with its backend-neutral contract", () => {
    expect(Object.keys(POSTGRESQL_PROJECT_REPOSITORY_ADAPTERS)).toEqual([
      "conversations",
      "promotedMemory",
      "recall",
      "redactionAdmin",
      "coordination",
    ]);
    expect(Object.keys(POSTGRESQL_PROJECT_REPOSITORY_CONFORMANCE))
      .toEqual(Object.keys(POSTGRESQL_PROJECT_REPOSITORY_ADAPTERS));
    expect(POSTGRESQL_PROJECT_REPOSITORY_ADAPTERS.conversations.implementation)
      .toBe(PostgreSqlConversationRepository);
    expect(POSTGRESQL_PROJECT_REPOSITORY_CONFORMANCE.conversations.exercise)
      .toBe(exerciseConversationRepositoryConformance);
    expect(POSTGRESQL_PROJECT_REPOSITORY_ADAPTERS.promotedMemory.implementation)
      .toBe(PostgreSqlPromotedMemoryRepository);
    expect(POSTGRESQL_PROJECT_REPOSITORY_CONFORMANCE.promotedMemory.exercise)
      .toBe(exercisePromotedMemoryRepositoryConformance);
    expect(POSTGRESQL_PROJECT_REPOSITORY_ADAPTERS.recall.implementation)
      .toBe(PostgreSqlRecallRepository);
    expect(POSTGRESQL_PROJECT_REPOSITORY_CONFORMANCE.recall.exercise)
      .toBe(exerciseRecallRepositoryConformance);
    expect(POSTGRESQL_PROJECT_REPOSITORY_ADAPTERS.redactionAdmin.implementation)
      .toBe(PostgreSqlRedactionAdminRepository);
    expect(POSTGRESQL_PROJECT_REPOSITORY_CONFORMANCE.redactionAdmin.exercise)
      .toBe(exerciseRedactionAdminRepositoryConformance);
    expect(POSTGRESQL_PROJECT_REPOSITORY_ADAPTERS.coordination.implementation)
      .toBe(PostgreSqlCoordinationRepository);
    expect(POSTGRESQL_PROJECT_REPOSITORY_CONFORMANCE.coordination.exercise)
      .toBe(exerciseCoordinationRepositoryConformance);
  });
});
