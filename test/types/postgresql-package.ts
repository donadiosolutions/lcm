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

// Both existing consumers and recall consumers use the public factory output.
async function consumeFactoryOutput(): Promise<void> {
  const backend = await factory;
  const opened = await backend.openProject(identity);
  const ordinary = await opened.lexicalSearch.searchPromoted("quince orchard", 10);
  const recalled = await opened.lexicalSearch.searchPromotedForRecall("quince orchard", 10);
  const ids: string[] = ordinary.map((row) => row.id);
  const nativeCounts: number[] = recalled.candidates.map((candidate) => candidate.evidence.matchedTermCount);
  const canonicalContents: string[] = recalled.candidates.map((candidate) => candidate.result.content);
  void ids;
  void nativeCounts;
  void canonicalContents;
  await opened.close();
  await backend.close();
}
void consumeFactoryOutput;
