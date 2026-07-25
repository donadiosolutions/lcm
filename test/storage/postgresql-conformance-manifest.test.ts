import { describe, expect, it } from "vitest";
import { PostgreSqlConversationRepository } from "../../src/storage/postgresql/index.js";
import { exerciseConversationRepositoryConformance } from "./conversation-conformance.js";
import {
  POSTGRESQL_PROJECT_REPOSITORY_ADAPTERS,
  POSTGRESQL_PROJECT_REPOSITORY_CONFORMANCE,
} from "./postgresql-conformance-manifest.js";

describe("PostgreSQL project repository conformance manifest", () => {
  it("registers every exposed project repository with its backend-neutral contract", () => {
    expect(Object.keys(POSTGRESQL_PROJECT_REPOSITORY_ADAPTERS)).toEqual(["conversations"]);
    expect(Object.keys(POSTGRESQL_PROJECT_REPOSITORY_CONFORMANCE))
      .toEqual(Object.keys(POSTGRESQL_PROJECT_REPOSITORY_ADAPTERS));
    expect(POSTGRESQL_PROJECT_REPOSITORY_ADAPTERS.conversations.implementation)
      .toBe(PostgreSqlConversationRepository);
    expect(POSTGRESQL_PROJECT_REPOSITORY_CONFORMANCE.conversations.exercise)
      .toBe(exerciseConversationRepositoryConformance);
  });
});
