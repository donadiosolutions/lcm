import * as PostgreSqlExports from "../../src/storage/postgresql/index.js";
import type { ProjectRepositories } from "../../src/storage/contracts.js";
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

type ProjectRepositoryDomain = keyof ProjectRepositories;

/**
 * Conventional public export names for PostgreSQL implementations of
 * ProjectRepositories domains. When a matching implementation is exported,
 * the mapped manifests below require both an adapter registration and a
 * backend-neutral conformance suite.
 */
const POSTGRESQL_PROJECT_REPOSITORY_EXPORT_NAMES = {
  conversations: "PostgreSqlConversationRepository",
  summaries: "PostgreSqlSummaryRepository",
  context: "PostgreSqlContextRepository",
  largeFiles: "PostgreSqlLargeFileRepository",
  promotedMemory: "PostgreSqlPromotedMemoryRepository",
  recall: "PostgreSqlRecallRepository",
  redactionAdmin: "PostgreSqlRedactionAdminRepository",
  lexicalSearch: "PostgreSqlLexicalSearchRepository",
  coordination: "PostgreSqlCoordinationRepository",
} as const satisfies Record<ProjectRepositoryDomain, string>;

type PostgreSqlProjectRepositoryExportName<
  Domain extends ProjectRepositoryDomain
> = (typeof POSTGRESQL_PROJECT_REPOSITORY_EXPORT_NAMES)[Domain];

type ExportedPostgreSqlProjectRepositoryDomain = {
  [Domain in ProjectRepositoryDomain]: PostgreSqlProjectRepositoryExportName<Domain> extends keyof typeof PostgreSqlExports
    ? Domain
    : never;
}[ProjectRepositoryDomain];

type ExportedPostgreSqlProjectRepository<
  Domain extends ExportedPostgreSqlProjectRepositoryDomain
> =
  PostgreSqlProjectRepositoryExportName<Domain> extends keyof typeof PostgreSqlExports
    ? (typeof PostgreSqlExports)[PostgreSqlProjectRepositoryExportName<Domain>]
    : never;

type PostgreSqlProjectRepositoryAdapterManifest = {
  readonly [Domain in ExportedPostgreSqlProjectRepositoryDomain]: {
    readonly implementation: ExportedPostgreSqlProjectRepository<Domain>;
  };
};

type PostgreSqlProjectRepositoryConformanceManifest = {
  readonly [Domain in keyof typeof POSTGRESQL_PROJECT_REPOSITORY_ADAPTERS]: {
    readonly exercise: (
      repository: ProjectRepositories[Domain]
    ) => Promise<unknown>;
  };
};

export const POSTGRESQL_PROJECT_REPOSITORY_ADAPTERS = {
  conversations: {
    implementation: PostgreSqlExports.PostgreSqlConversationRepository,
  },
  summaries: {
    implementation: PostgreSqlExports.PostgreSqlSummaryRepository,
  },
  context: {
    implementation: PostgreSqlExports.PostgreSqlContextRepository,
  },
  largeFiles: {
    implementation: PostgreSqlExports.PostgreSqlLargeFileRepository,
  },
  promotedMemory: {
    implementation: PostgreSqlExports.PostgreSqlPromotedMemoryRepository,
  },
  recall: {
    implementation: PostgreSqlExports.PostgreSqlRecallRepository,
  },
  redactionAdmin: {
    implementation: PostgreSqlExports.PostgreSqlRedactionAdminRepository,
  },
  lexicalSearch: {
    implementation: PostgreSqlExports.PostgreSqlLexicalSearchRepository,
  },
  coordination: {
    implementation: PostgreSqlExports.PostgreSqlCoordinationRepository,
  },
} as const satisfies PostgreSqlProjectRepositoryAdapterManifest;

export const POSTGRESQL_PROJECT_REPOSITORY_CONFORMANCE = {
  conversations: {
    exercise: exerciseConversationRepositoryConformance,
  },
  summaries: {
    exercise: exerciseSummaryRepositoryConformance,
  },
  context: {
    exercise: exerciseContextRepositoryConformance,
  },
  largeFiles: {
    exercise: exerciseLargeFileRepositoryConformance,
  },
  promotedMemory: {
    exercise: exercisePromotedMemoryRepositoryConformance,
  },
  recall: {
    exercise: exerciseRecallRepositoryConformance,
  },
  redactionAdmin: {
    exercise: exerciseRedactionAdminRepositoryConformance,
  },
  lexicalSearch: {
    exercise: exerciseLexicalSearchRepositoryConformance,
  },
  coordination: {
    exercise: exerciseCoordinationRepositoryConformance,
  },
} as const satisfies PostgreSqlProjectRepositoryConformanceManifest;

/**
 * Staged PostgreSQL repositories that are not yet part of ProjectRepositories
 * still need an explicit adapter and integration-suite inventory. This keeps
 * new public adapters visible to the PostgreSQL harness without activating
 * them through the daemon storage factory.
 */
export const POSTGRESQL_STAGED_REPOSITORY_SUITES = {
  passiveEvents: {
    implementation: PostgreSqlExports.PostgreSqlPassiveEventRepository,
    integrationSuites: [
      "test/postgresql/passive-event-repository.integration.ts",
      "test/postgresql/passive-event-replication.integration.ts",
    ],
  },
  migrations: {
    implementation: PostgreSqlExports.PostgreSqlMigrationAdapter,
    integrationSuites: ["test/postgresql/migration.integration.ts"],
  },
} as const;
