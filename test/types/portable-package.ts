import {
  createPortableRecordStream, createPostgreSqlPortableDestination,
  createPostgreSqlPortableSource, openSqlitePortableSource, openSqlitePortableDestination,
  sqlitePortableFileSha256, runPortableTransfer, canonicalSha256,
  type OpenSqlitePortableSourceInput, type OpenSqlitePortableDestinationInput,
  type PostgreSqlPortableSourceOptions, type PostgreSqlPortableDestinationInput,
  type PortableRecordSource, type PortableRecordStream, type PortableRecordWriter,
  type PortableTransferResult, type PortableCheckpoint, type PortableManifest,
  type StorageIdentityContext, type PostgreSqlConnectionSettings,
} from "@donadiosolutions/lcm/storage/portable";

declare const sqliteSource: OpenSqlitePortableSourceInput;
declare const sqliteTarget: OpenSqlitePortableDestinationInput;
declare const postgresSource: PostgreSqlPortableSourceOptions;
declare const postgresTarget: PostgreSqlPortableDestinationInput;
declare const identity: StorageIdentityContext;
declare const settings: PostgreSqlConnectionSettings;
declare const checkpoint: PortableCheckpoint;
declare const manifest: PortableManifest;
const source: Promise<PortableRecordSource> = openSqlitePortableSource(sqliteSource);
const remoteSource: Promise<PortableRecordSource> = createPostgreSqlPortableSource(postgresSource);
const stream: Promise<PortableRecordStream> = source.then(createPortableRecordStream);
const writer: Promise<PortableRecordWriter> = createPostgreSqlPortableDestination({ ...postgresTarget, expectedIdentity: identity, settings });
const sqliteWriter: Promise<PortableRecordWriter> = openSqlitePortableDestination(sqliteTarget);
const transferred: Promise<PortableTransferResult> = Promise.all([stream, writer]).then(([source, destination]) =>
  runPortableTransfer({ source, destination, maxRecords: 100 }));
const fileHash: string = sqlitePortableFileSha256("/supplied/capture.sqlite");
const generationHash: string = canonicalSha256("generation");
// The public source opener must not expose internal dependency injection.
// @ts-expect-error Only the documented options argument is public.
createPostgreSqlPortableSource(postgresSource, {});
void remoteSource; void sqliteWriter; void transferred; void fileHash; void generationHash; void checkpoint; void manifest;
