/** Public canonical transfer API. Backend publication and migration authority are separate. */
export {
  PORTABLE_LIMITS,
  PORTABLE_RECORD_DOMAIN_ORDER,
  PORTABLE_RECORD_SCHEMA_SHA256,
  PortableStreamError,
  canonicalJson,
  canonicalSha256,
  createPortableRecord,
  createPortableRecordStream,
  parsePortableCheckpoint,
  parsePortableManifest,
  parsePortableRecord,
  serializePortableCheckpoint,
  serializePortableManifest,
  serializePortableRecord,
  verifyPortableCheckpoint,
} from "./portable-record-stream.js";
export type {
  PortableBatch, PortableCheckpoint, PortableCoverageEvidence, PortableDomain,
  PortableDomainManifest, PortableIntegerValue, PortableLimits, PortableManifest,
  PortableProjectIdentity, PortableRawRecordInput, PortableRawRecordValueByDomain,
  PortableReadBatchInput, PortableRecord, PortableRecordInput, PortableRecordSource,
  PortableRecordStream, PortableRecordValue, PortableRecordValueByDomain,
  PortableSourceDescription, PortableSourcePage, PortableSourcePageInput,
  PortableSourceVerificationInput, PortableStreamErrorCode, PortableVerification,
} from "./portable-record-stream.js";
export { PortableTransferError, runPortableTransfer } from "./portable-transfer.js";
export type {
  PortableDestinationProgress, PortableDestinationVerification, PortablePreflight,
  PortableRecordWriter, PortableTransferErrorCode, PortableTransferProgress,
  PortableTransferResult, RunPortableTransferInput,
} from "./portable-transfer.js";
export { openSqlitePortableSource, sqlitePortableFileSha256 } from "./sqlite/portable-source.js";
export type {
  OpenSqlitePortableSourceInput, SqlitePortableIdentityFacts, SqlitePortableCapturedFile,
  SqlitePortableAbsentSidecar, SqlitePortableCapturedSidecars, SqlitePortableRecordSource,
} from "./sqlite/portable-source.js";
export { openSqlitePortableDestination } from "./sqlite/portable-destination.js";
export type { OpenSqlitePortableDestinationInput } from "./sqlite/portable-destination.js";
export type { SqlitePortableArchiveReader } from "./sqlite/portable-archive.js";
export { createPostgreSqlPortableDestination } from "./postgresql/portable-destination.js";
export type { PostgreSqlPortableDestinationInput } from "./postgresql/portable-destination.js";
export type { PostgreSqlPortableSourceOptions } from "./postgresql/portable-source.js";
export type { StorageIdentityContext } from "./contracts.js";
export type { PostgreSqlConnectionSettings } from "./postgresql/contracts.js";

import { createPostgreSqlPortableSource as openPostgreSqlSource } from "./postgresql/portable-source.js";
import type { PostgreSqlPortableSourceOptions } from "./postgresql/portable-source.js";
import type { PortableRecordSource } from "./portable-record-stream.js";

/** Same opener; internal dependency injection is absent from consumer declarations. */
export const createPostgreSqlPortableSource: (options: PostgreSqlPortableSourceOptions) => Promise<PortableRecordSource> = openPostgreSqlSource;
