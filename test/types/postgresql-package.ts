import {
  createPostgreSqlStorageBackendFactory,
  type PostgreSqlStorageBackendFactory,
  type ProjectStorage,
  type ResolvedPostgreSqlConfig,
  type StorageHealth,
  type StorageIdentityContext,
} from "@donadiosolutions/lcm/storage/postgresql";

declare const config: ResolvedPostgreSqlConfig;
declare const identity: StorageIdentityContext;
const factory: Promise<PostgreSqlStorageBackendFactory> =
  createPostgreSqlStorageBackendFactory(config);
declare const project: ProjectStorage;
declare const health: StorageHealth;
void identity;
void factory;
void project;
void health;
