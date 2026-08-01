import { describe, expect, it } from "vitest";
import {
  PostgreSqlConversationRepository,
  PostgreSqlContextRepository,
  PostgreSqlCoordinationRepository,
  PostgreSqlLargeFileRepository,
  PostgreSqlLexicalSearchRepository,
  PostgreSqlMigrationAdapter,
  PostgreSqlPassiveEventRepository,
  PostgreSqlPromotedMemoryRepository,
  PostgreSqlRecallRepository,
  PostgreSqlRedactionAdminRepository,
  PostgreSqlSummaryRepository,
} from "../../src/storage/postgresql/index.js";
import { exerciseConversationRepositoryConformance } from "./conversation-conformance.js";
import {
  exerciseCoordinationRepositoryConformance,
  exercisePromotedMemoryRepositoryConformance,
  exerciseRecallRepositoryConformance,
  exerciseRedactionAdminRepositoryConformance,
} from "./memory-conformance.js";
import {
  exerciseContextRepositoryConformance,
  exerciseLargeFileRepositoryConformance,
  exerciseSummaryRepositoryConformance,
} from "./summary-context-conformance.js";
import { exerciseLexicalSearchRepositoryConformance } from "./lexical-search-conformance.js";
import {
  POSTGRESQL_PROJECT_REPOSITORY_ADAPTERS,
  POSTGRESQL_PROJECT_REPOSITORY_CONFORMANCE,
  POSTGRESQL_STAGED_REPOSITORY_SUITES,
} from "./postgresql-conformance-manifest.js";

describe("PostgreSQL project repository conformance manifest", () => {
  it("registers every exposed project repository with its backend-neutral contract", () => {
    expect(Object.keys(POSTGRESQL_PROJECT_REPOSITORY_ADAPTERS)).toEqual([
      "conversations",
      "summaries",
      "context",
      "largeFiles",
      "promotedMemory",
      "recall",
      "redactionAdmin",
      "lexicalSearch",
      "coordination",
    ]);
    expect(Object.keys(POSTGRESQL_PROJECT_REPOSITORY_CONFORMANCE)).toEqual(
      Object.keys(POSTGRESQL_PROJECT_REPOSITORY_ADAPTERS)
    );
    expect(
      POSTGRESQL_PROJECT_REPOSITORY_ADAPTERS.conversations.implementation
    ).toBe(PostgreSqlConversationRepository);
    expect(
      POSTGRESQL_PROJECT_REPOSITORY_CONFORMANCE.conversations.exercise
    ).toBe(exerciseConversationRepositoryConformance);
    expect(
      POSTGRESQL_PROJECT_REPOSITORY_ADAPTERS.summaries.implementation
    ).toBe(PostgreSqlSummaryRepository);
    expect(POSTGRESQL_PROJECT_REPOSITORY_CONFORMANCE.summaries.exercise).toBe(
      exerciseSummaryRepositoryConformance
    );
    expect(POSTGRESQL_PROJECT_REPOSITORY_ADAPTERS.context.implementation).toBe(
      PostgreSqlContextRepository
    );
    expect(POSTGRESQL_PROJECT_REPOSITORY_CONFORMANCE.context.exercise).toBe(
      exerciseContextRepositoryConformance
    );
    expect(
      POSTGRESQL_PROJECT_REPOSITORY_ADAPTERS.largeFiles.implementation
    ).toBe(PostgreSqlLargeFileRepository);
    expect(POSTGRESQL_PROJECT_REPOSITORY_CONFORMANCE.largeFiles.exercise).toBe(
      exerciseLargeFileRepositoryConformance
    );
    expect(
      POSTGRESQL_PROJECT_REPOSITORY_ADAPTERS.promotedMemory.implementation
    ).toBe(PostgreSqlPromotedMemoryRepository);
    expect(
      POSTGRESQL_PROJECT_REPOSITORY_CONFORMANCE.promotedMemory.exercise
    ).toBe(exercisePromotedMemoryRepositoryConformance);
    expect(POSTGRESQL_PROJECT_REPOSITORY_ADAPTERS.recall.implementation).toBe(
      PostgreSqlRecallRepository
    );
    expect(POSTGRESQL_PROJECT_REPOSITORY_CONFORMANCE.recall.exercise).toBe(
      exerciseRecallRepositoryConformance
    );
    expect(
      POSTGRESQL_PROJECT_REPOSITORY_ADAPTERS.redactionAdmin.implementation
    ).toBe(PostgreSqlRedactionAdminRepository);
    expect(
      POSTGRESQL_PROJECT_REPOSITORY_CONFORMANCE.redactionAdmin.exercise
    ).toBe(exerciseRedactionAdminRepositoryConformance);
    expect(
      POSTGRESQL_PROJECT_REPOSITORY_ADAPTERS.lexicalSearch.implementation
    ).toBe(PostgreSqlLexicalSearchRepository);
    expect(
      POSTGRESQL_PROJECT_REPOSITORY_CONFORMANCE.lexicalSearch.exercise
    ).toBe(exerciseLexicalSearchRepositoryConformance);
    expect(
      POSTGRESQL_PROJECT_REPOSITORY_ADAPTERS.coordination.implementation
    ).toBe(PostgreSqlCoordinationRepository);
    expect(
      POSTGRESQL_PROJECT_REPOSITORY_CONFORMANCE.coordination.exercise
    ).toBe(exerciseCoordinationRepositoryConformance);
  });

  it("registers staged passive-event delivery without activating ProjectRepositories", () => {
    expect(POSTGRESQL_STAGED_REPOSITORY_SUITES).toEqual({
      passiveEvents: {
        implementation: PostgreSqlPassiveEventRepository,
        integrationSuites: [
          "test/postgresql/passive-event-repository.integration.ts",
          "test/postgresql/passive-event-replication.integration.ts",
        ],
      },
      migrations: {
        implementation: PostgreSqlMigrationAdapter,
        integrationSuites: ["test/postgresql/migration.integration.ts"],
      },
    });
    expect(POSTGRESQL_PROJECT_REPOSITORY_ADAPTERS).not.toHaveProperty(
      "passiveEvents"
    );
  });
});
