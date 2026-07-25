import * as PostgreSqlExports from "../../src/storage/postgresql/index.js";
import type { ProjectRepositories } from "../../src/storage/contracts.js";
import { exerciseConversationRepositoryConformance } from "./conversation-conformance.js";

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
  Domain extends ProjectRepositoryDomain,
> = (typeof POSTGRESQL_PROJECT_REPOSITORY_EXPORT_NAMES)[Domain];

type ExportedPostgreSqlProjectRepositoryDomain = {
  [Domain in ProjectRepositoryDomain]:
  PostgreSqlProjectRepositoryExportName<Domain> extends keyof typeof PostgreSqlExports
    ? Domain
    : never;
}[ProjectRepositoryDomain];

type ExportedPostgreSqlProjectRepository<
  Domain extends ExportedPostgreSqlProjectRepositoryDomain,
> = PostgreSqlProjectRepositoryExportName<Domain> extends keyof typeof PostgreSqlExports
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
      repository: ProjectRepositories[Domain],
    ) => Promise<unknown>;
  };
};

export const POSTGRESQL_PROJECT_REPOSITORY_ADAPTERS = {
  conversations: {
    implementation: PostgreSqlExports.PostgreSqlConversationRepository,
  },
} as const satisfies PostgreSqlProjectRepositoryAdapterManifest;

export const POSTGRESQL_PROJECT_REPOSITORY_CONFORMANCE = {
  conversations: {
    exercise: exerciseConversationRepositoryConformance,
  },
} as const satisfies PostgreSqlProjectRepositoryConformanceManifest;
