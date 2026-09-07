import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeSync,
  type BigIntStats as FsBigIntStats,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { withPrivateMutationLockAsync } from "../private-mutation-lock.js";
import { canonicalJson } from "../storage/portable-record.js";
import {
  backendPublicationCanonicalSha256,
  readBackendMaintenanceJournal,
  withBackendPublicationAppendBarrierAsync,
  withBackendPublicationConsumerLockAsync,
  type BackendPublicationLockToken,
} from "../storage/backend-publication.js";

const HASH = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const GENERATION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const ROLE_ORDER = ["project", "passive-events", "machine-sequence"] as const;
const CONTROL_LIMIT = 1024 * 1024;
const SOURCE_LIMIT = 8n * 1024n * 1024n * 1024n;
const SHM_LIMIT = 128n * 1024n * 1024n;
const COPY_CHUNK = 1024 * 1024;
const DIRECTORY_MODE = 0o700;
const CONTROL_MODE = 0o600;
const ARTIFACT_MODE = 0o400;
const OWNER_FILE_MODES = new Set([0o400, 0o500, 0o600, 0o700]);

export type SqliteSnapshotRole = (typeof ROLE_ORDER)[number];

export type AuthenticatedSqliteSnapshotAuthority = Readonly<{
  version: 1;
  sourceSelectionSha256: string;
  physicalProjectId: string;
  projectIdentity: Readonly<{ scope: "local" | "shared"; projectId: string }>;
  canonicalPath: string;
  aliases: readonly string[];
  projectDbPath: string;
  passiveEventsDbPath: string | null;
  machineSequenceDbPath: string;
  machineIdentity: Readonly<{ identityKey: string; machineId: string }>;
  machineIdentitySha256: string;
  projectMapSha256: string;
  projectMapEntrySha256: string;
  projectMetadataSha256: string;
}>;

export type SqliteSnapshotFileIdentity = Readonly<{
  dev: string;
  ino: string;
  uid: number;
  gid: number;
  mode: number;
  nlink: string;
  size: string;
  mtimeNs: string;
  ctimeNs: string;
  sha256: string;
}>;

export type SqliteSnapshotDirectoryIdentity = Readonly<{
  dev: string;
  ino: string;
  uid: number;
  gid: number;
  mode: number;
}>;

export type SqliteSnapshotSourceRoleWitness = Readonly<{
  version: 1;
  role: SqliteSnapshotRole;
  path: string;
  parent: SqliteSnapshotDirectoryIdentity;
  membershipBeforeSha256: string;
  membershipAfterSha256: string;
  mainBefore: SqliteSnapshotFileIdentity;
  mainAfter: SqliteSnapshotFileIdentity;
  walBefore: SqliteSnapshotFileIdentity | null;
  walAfter: SqliteSnapshotFileIdentity | null;
  shmBefore: SqliteSnapshotFileIdentity | null;
  shmAfter: SqliteSnapshotFileIdentity | null;
  checksumSha256: string;
}>;

export type SqliteSnapshotPrivateFileWitness = Readonly<{
  relativePath: string;
  dev: string;
  ino: string;
  mode: number;
  size: string;
  sha256: string;
}>;

export type SqliteSnapshotArtifactRoleWitness = Readonly<{
  version: 1;
  role: SqliteSnapshotRole;
  source: SqliteSnapshotSourceRoleWitness;
  rawMain: SqliteSnapshotPrivateFileWitness;
  rawWal: SqliteSnapshotPrivateFileWitness | null;
  normalizedMain: SqliteSnapshotPrivateFileWitness;
  encoding: "UTF-8";
  userVersion: 0;
  quickCheck: "ok";
  schemaSha256: string;
  contentSha256: string;
  checksumSha256: string;
}>;

export type SqliteSnapshotArtifactWitness = Readonly<{
  version: 1;
  generationId: string;
  requestSha256: string;
  authority: AuthenticatedSqliteSnapshotAuthority;
  sourceSelectionSha256: string;
  maintenanceChecksumSha256: string;
  queueEvidenceSha256: string;
  sourceByteWitnessSha256: string;
  roles: readonly SqliteSnapshotArtifactRoleWitness[];
  schemaSha256: string;
  contentSha256: string;
  capturedAt: string;
  artifactSha256: string;
  checksumSha256: string;
}>;

export type SqliteSnapshotSourceByteWitness = Readonly<{
  version: 1;
  sourceSelectionSha256: string;
  roles: readonly SqliteSnapshotSourceRoleWitness[];
  checksumSha256: string;
}>;

export type SqliteSnapshotDryRun = Readonly<{
  version: 1;
  sourceSelectionSha256: string;
  sourceByteWitnessSha256: string;
  roles: readonly Readonly<{
    role: SqliteSnapshotRole;
    source: SqliteSnapshotSourceRoleWitness;
    encoding: "UTF-8";
    userVersion: 0;
    quickCheck: "ok";
    schemaSha256: string;
    contentSha256: string;
  }>[];
  inspectedAt: string;
  checksumSha256: string;
}>;

export type SqliteSnapshotClassification =
  | Readonly<{ state: "absent" }>
  | Readonly<{ state: "partial"; generationId: string }>
  | Readonly<{ state: "complete"; witness: SqliteSnapshotArtifactWitness }>
  | Readonly<{ state: "replaced"; generationId: string }>
  | Readonly<{ state: "tampered"; generationId: string }>;

export type SqliteSnapshotErrorReason =
  | "invalid-input"
  | "maintenance-mismatch"
  | "snapshot-absent"
  | "snapshot-partial"
  | "snapshot-replaced"
  | "snapshot-tampered"
  | "source-unsafe"
  | "source-changed"
  | "unsupported-sqlite"
  | "snapshot-io";

export class SqliteSnapshotError extends Error {
  constructor(readonly reason: SqliteSnapshotErrorReason, message = reason, options?: ErrorOptions) {
    super(message, options);
    this.name = "SqliteSnapshotError";
  }
}

export type SqliteSnapshotBoundary =
  | "before-source-open"
  | "after-source-open"
  | "after-source-copy"
  | "before-source-revalidate"
  | "before-source-close"
  | "after-source-close"
  | "before-private-inspection"
  | "after-private-inspection"
  | "before-private-fsync"
  | "after-private-fsync"
  | "before-witness"
  | "before-commit-marker"
  | "after-commit-marker";

type BigIntStats = FsBigIntStats;

type DatabaseInspection = Readonly<{
  encoding: "UTF-8";
  userVersion: 0;
  quickCheck: "ok";
  schemaSha256: string;
}>;

export interface SqliteSnapshotOperations {
  now(): Date;
  nonce(): string;
  open(path: string, flags: number, mode?: number): number;
  close(fd: number): void;
  fstat(fd: number): BigIntStats;
  lstat(path: string): BigIntStats;
  read(fd: number, buffer: Buffer, offset: number, length: number, position: number): number;
  write(fd: number, buffer: Buffer, offset: number, length: number, position: number | null): number;
  fsync(fd: number): void;
  chmod(path: string, mode: number): void;
  mkdir(path: string, mode: number): void;
  link(source: string, destination: string): void;
  readdir(path: string): readonly string[];
  realpath(path: string): string;
  remove(path: string, options: Readonly<{ recursive?: boolean; force?: boolean }>): void;
  unlink(path: string): void;
  inspectDatabase(path: string, normalize: boolean): DatabaseInspection;
  observe(boundary: SqliteSnapshotBoundary, path: string, role: SqliteSnapshotRole | null): void | Promise<void>;
}

export type SqliteSnapshotOptions = Readonly<{
  homeDir: string;
  generationId: string;
  maintenanceChecksumSha256: string;
  expectedSourceBytes: SqliteSnapshotSourceByteWitness;
  lockToken?: BackendPublicationLockToken;
  _operationsForTesting?: Partial<SqliteSnapshotOperations>;
}>;

export type SqliteSnapshotSourceByteOptions = Readonly<{
  homeDir: string;
  lockToken: BackendPublicationLockToken;
  _operationsForTesting?: Partial<SqliteSnapshotOperations>;
}>;

export type SqliteSnapshotDryRunOptions = Readonly<{
  homeDir: string;
  lockToken?: BackendPublicationLockToken;
  _operationsForTesting?: Partial<SqliteSnapshotOperations>;
}>;

type ClassificationOptions = Readonly<{
  homeDir: string;
  _operationsForTesting?: Partial<SqliteSnapshotOperations>;
}>;

type RecordValue = Record<string, unknown>;

class InternalSnapshotError extends Error {
  constructor(readonly kind: "invalid" | "missing" | "changed" | "unsafe" | "unsupported" | "io", options?: ErrorOptions) {
    super(kind, options);
  }
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function withChecksum<T extends RecordValue>(body: T): T & Readonly<{ checksumSha256: string }> {
  return { ...body, checksumSha256: sha256(canonicalJson(body)) };
}

function isRecord(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: RecordValue, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function currentUid(): number {
  return process.getuid!();
}

function mode(stat: BigIntStats): number {
  return Number(stat.mode & 0o7777n);
}

function decimal(value: bigint): string {
  return value.toString(10);
}

function sameInode(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function exactPath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096
    && isAbsolute(value) && resolve(value) === value;
}

function validateGeneration(value: unknown): string {
  if (typeof value !== "string" || !GENERATION.test(value)) throw new SqliteSnapshotError("invalid-input");
  return value;
}

function authorityBody(authority: AuthenticatedSqliteSnapshotAuthority): Omit<AuthenticatedSqliteSnapshotAuthority, "sourceSelectionSha256"> {
  const { sourceSelectionSha256: _digest, ...body } = authority;
  return body;
}

function validateAuthority(value: unknown): AuthenticatedSqliteSnapshotAuthority {
  if (!isRecord(value) || !exactKeys(value, [
    "aliases", "canonicalPath", "machineIdentity", "machineIdentitySha256",
    "machineSequenceDbPath", "passiveEventsDbPath", "physicalProjectId",
    "projectDbPath", "projectIdentity", "projectMapEntrySha256", "projectMapSha256",
    "projectMetadataSha256", "sourceSelectionSha256", "version",
  ])) throw new SqliteSnapshotError("invalid-input");
  const authority = value as unknown as AuthenticatedSqliteSnapshotAuthority;
  if (
    authority.version !== 1
    || typeof authority.physicalProjectId !== "string" || authority.physicalProjectId.length === 0
    || !isRecord(authority.projectIdentity)
    || !exactKeys(authority.projectIdentity, ["projectId", "scope"])
    || (authority.projectIdentity.scope !== "local" && authority.projectIdentity.scope !== "shared")
    || typeof authority.projectIdentity.projectId !== "string" || authority.projectIdentity.projectId.length === 0
    || !exactPath(authority.canonicalPath)
    || !Array.isArray(authority.aliases) || authority.aliases.length > 1024
    || !authority.aliases.every(exactPath)
    || new Set(authority.aliases).size !== authority.aliases.length
    || authority.aliases.some((alias) => alias === authority.canonicalPath)
    || canonicalJson([...authority.aliases].sort()) !== canonicalJson(authority.aliases)
    || !exactPath(authority.projectDbPath)
    || (authority.passiveEventsDbPath !== null && !exactPath(authority.passiveEventsDbPath))
    || !exactPath(authority.machineSequenceDbPath)
    || !isRecord(authority.machineIdentity)
    || !exactKeys(authority.machineIdentity, ["identityKey", "machineId"])
    || typeof authority.machineIdentity.identityKey !== "string" || authority.machineIdentity.identityKey.length === 0
    || !UUID.test(authority.machineIdentity.machineId)
    || !HASH.test(authority.machineIdentitySha256)
    || !HASH.test(authority.projectMapSha256)
    || !HASH.test(authority.projectMapEntrySha256)
    || !HASH.test(authority.projectMetadataSha256)
    || !HASH.test(authority.sourceSelectionSha256)
  ) throw new SqliteSnapshotError("invalid-input");
  const rolePaths = [authority.projectDbPath, authority.machineSequenceDbPath];
  if (authority.passiveEventsDbPath !== null) rolePaths.push(authority.passiveEventsDbPath);
  if (new Set(rolePaths).size !== rolePaths.length) throw new SqliteSnapshotError("invalid-input");
  for (const path of rolePaths) {
    if (rolePaths.some((other) => other !== path && [other, `${other}-wal`, `${other}-shm`, `${other}-journal`].includes(path))) {
      throw new SqliteSnapshotError("invalid-input");
    }
  }
  if (backendPublicationCanonicalSha256(authorityBody(authority)) !== authority.sourceSelectionSha256) {
    throw new SqliteSnapshotError("invalid-input");
  }
  return authority;
}

function sqliteRows(database: DatabaseSync, sql: string): readonly RecordValue[] {
  return database.prepare(sql).all() as RecordValue[];
}

function inspectDatabase(path: string, normalize: boolean): DatabaseInspection {
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(path, normalize ? {} : { readOnly: true });
    if (normalize) {
      database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      database.exec("PRAGMA journal_mode = DELETE");
    }
    const encodingRows = sqliteRows(database, "PRAGMA encoding");
    const versionRows = sqliteRows(database, "PRAGMA user_version");
    const quickRows = sqliteRows(database, "PRAGMA quick_check(1)");
    const encoding = Object.values(encodingRows[0]!)[0];
    const userVersion = Object.values(versionRows[0]!)[0];
    const quickCheck = Object.values(quickRows[0]!)[0];
    if (encoding !== "UTF-8" || userVersion !== 0 || quickCheck !== "ok") {
      throw new InternalSnapshotError("unsupported");
    }
    const schema = sqliteRows(database, `
      SELECT type, name, tbl_name AS tableName, sql
      FROM sqlite_schema
      WHERE name NOT LIKE 'sqlite_autoindex_%'
      ORDER BY type COLLATE BINARY, name COLLATE BINARY, tbl_name COLLATE BINARY
    `);
    if (schema.length > 4096) throw new InternalSnapshotError("unsupported");
    return {
      encoding: "UTF-8",
      userVersion: 0,
      quickCheck: "ok",
      schemaSha256: sha256(canonicalJson(schema)),
    };
  } catch (error) {
    if (error instanceof InternalSnapshotError) throw error;
    throw new InternalSnapshotError("unsupported", { cause: error });
  } finally {
    database?.close();
  }
}

const DEFAULT_OPERATIONS: SqliteSnapshotOperations = {
  now: () => new Date(),
  nonce: () => randomBytes(24).toString("hex"),
  open: (path, flags, fileMode) => fileMode === undefined ? openSync(path, flags) : openSync(path, flags, fileMode),
  close: (fd) => closeSync(fd),
  fstat: (fd) => fstatSync(fd, { bigint: true }),
  lstat: (path) => lstatSync(path, { bigint: true }),
  read: (fd, buffer, offset, length, position) => readSync(fd, buffer, offset, length, position),
  write: (fd, buffer, offset, length, position) => writeSync(fd, buffer, offset, length, position),
  fsync: (fd) => fsyncSync(fd),
  chmod: (path, fileMode) => chmodSync(path, fileMode),
  mkdir: (path, fileMode) => mkdirSync(path, { mode: fileMode }),
  link: (source, destination) => linkSync(source, destination),
  readdir: (path) => readdirSync(path),
  realpath: (path) => realpathSync(path),
  remove: (path, options) => rmSync(path, options),
  unlink: (path) => unlinkSync(path),
  inspectDatabase,
  observe: () => undefined,
};

type Context = Readonly<{
  homeDir: string;
  generationId: string;
  maintenanceChecksumSha256?: string;
  lockToken?: BackendPublicationLockToken;
  ops: SqliteSnapshotOperations;
}>;

function contextFor(options: ClassificationOptions & Partial<Pick<SqliteSnapshotOptions, "generationId" | "maintenanceChecksumSha256" | "lockToken">>): Context {
  if (!exactPath(options.homeDir)) throw new SqliteSnapshotError("invalid-input");
  const ops = Object.freeze({ ...DEFAULT_OPERATIONS, ...options._operationsForTesting });
  return {
    homeDir: options.homeDir,
    generationId: options.generationId === undefined ? "" : validateGeneration(options.generationId),
    ...(options.maintenanceChecksumSha256 === undefined ? {} : { maintenanceChecksumSha256: options.maintenanceChecksumSha256 }),
    ...(options.lockToken === undefined ? {} : { lockToken: options.lockToken }),
    ops,
  };
}

async function observe(context: Context, boundary: SqliteSnapshotBoundary, path: string, role: SqliteSnapshotRole | null): Promise<void> {
  await context.ops.observe(boundary, path, role);
}

function rootPath(context: Context): string {
  return join(context.homeDir, ".lcm", "migration-snapshots");
}

function registrationsPath(context: Context): string {
  return join(rootPath(context), "registrations");
}

function generationsPath(context: Context): string {
  return join(rootPath(context), "generations");
}

function generationPath(context: Context, generationId = context.generationId): string {
  return join(generationsPath(context), generationId);
}

function lockPath(context: Context): string {
  return join(context.homeDir, ".lcm", ".sqlite-snapshot.lock");
}

function assertDirectory(context: Context, path: string): BigIntStats {
  const stat = context.ops.lstat(path);
  const uid = currentUid();
  if (!stat.isDirectory() || stat.isSymbolicLink() || mode(stat) !== DIRECTORY_MODE || Number(stat.uid) !== uid) {
    throw new InternalSnapshotError("unsafe");
  }
  if (context.ops.realpath(path) !== path) throw new InternalSnapshotError("unsafe");
  return stat;
}

function syncDirectory(context: Context, path: string): void {
  const fd = context.ops.open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    context.ops.fsync(fd);
  } finally {
    context.ops.close(fd);
  }
}

function ensureChildDirectory(context: Context, parent: string, name: string): string {
  assertDirectory(context, parent);
  const path = join(parent, name);
  try {
    context.ops.mkdir(path, DIRECTORY_MODE);
    syncDirectory(context, parent);
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
  }
  assertDirectory(context, parent);
  assertDirectory(context, path);
  return path;
}

function ensureArtifactDirectories(context: Context): void {
  const lcm = join(context.homeDir, ".lcm");
  assertDirectory(context, lcm);
  const root = ensureChildDirectory(context, lcm, "migration-snapshots");
  ensureChildDirectory(context, root, "registrations");
  ensureChildDirectory(context, root, "generations");
}

function writeAll(context: Context, fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = context.ops.write(fd, bytes, offset, bytes.byteLength - offset, null);
    if (written <= 0) throw new InternalSnapshotError("io");
    offset += written;
  }
}

function writeExclusive(context: Context, path: string, bytes: Buffer, fileMode: number): void {
  const fd = context.ops.open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, fileMode);
  try {
    writeAll(context, fd, bytes);
    context.ops.fsync(fd);
  } finally {
    context.ops.close(fd);
  }
  syncDirectory(context, dirname(path));
}

function controlBytes(body: RecordValue): Buffer {
  const value = withChecksum(body);
  const bytes = Buffer.from(`${canonicalJson(value)}\n`, "utf8");
  if (bytes.byteLength > CONTROL_LIMIT) throw new SqliteSnapshotError("invalid-input");
  return bytes;
}

function writeControl(context: Context, path: string, body: RecordValue): void {
  writeExclusive(context, path, controlBytes(body), CONTROL_MODE);
}

function publishCommitMarker(context: Context, generation: string, checksumSha256: string): void {
  const nonce = context.ops.nonce();
  if (!/^[0-9a-f]{48}$/u.test(nonce)) throw new InternalSnapshotError("invalid");
  const temporary = join(generation, `.commit.${nonce}`);
  const committed = join(generation, "witness.committed");
  writeExclusive(context, temporary, Buffer.from(`${checksumSha256}\n`, "ascii"), CONTROL_MODE);
  context.ops.link(temporary, committed);
  syncDirectory(context, generation);
  context.ops.unlink(temporary);
  syncDirectory(context, generation);
}

function streamHash(context: Context, fd: number, expectedSize: bigint, maximum: bigint): string {
  void maximum;
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(COPY_CHUNK);
  let position = 0n;
  while (position < expectedSize) {
    const wanted = Number(expectedSize - position > BigInt(buffer.byteLength) ? BigInt(buffer.byteLength) : expectedSize - position);
    const read = context.ops.read(fd, buffer, 0, wanted, Number(position));
    if (read <= 0) throw new InternalSnapshotError("changed");
    hash.update(buffer.subarray(0, read));
    position += BigInt(read);
  }
  const extra = context.ops.read(fd, buffer, 0, 1, Number(position));
  if (extra !== 0) throw new InternalSnapshotError("changed");
  return hash.digest("hex");
}

function validateSourceStat(stat: BigIntStats, maximum: bigint): void {
  const uid = currentUid();
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || !OWNER_FILE_MODES.has(mode(stat))
    || Number(stat.uid) !== uid || stat.size < 0n || stat.size > maximum) {
    throw new InternalSnapshotError("unsafe");
  }
}

function fileIdentity(stat: BigIntStats, digest: string): SqliteSnapshotFileIdentity {
  return {
    dev: decimal(stat.dev),
    ino: decimal(stat.ino),
    uid: Number(stat.uid),
    gid: Number(stat.gid),
    mode: mode(stat),
    nlink: decimal(stat.nlink),
    size: decimal(stat.size),
    mtimeNs: decimal(stat.mtimeNs),
    ctimeNs: decimal(stat.ctimeNs),
    sha256: digest,
  };
}

function sameFileIdentity(left: SqliteSnapshotFileIdentity, right: SqliteSnapshotFileIdentity): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function sourcePathMatches(context: Context, path: string, retained: BigIntStats): void {
  const current = context.ops.lstat(path);
  if (current.isSymbolicLink() || !sameInode(current, retained)) throw new InternalSnapshotError("changed");
}

type RetainedSourceFile = Readonly<{
  path: string;
  fd: number;
  stat: BigIntStats;
  maximum: bigint;
}>;

function openSourceFile(context: Context, path: string, maximum: bigint): RetainedSourceFile {
  const fd = context.ops.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = context.ops.fstat(fd);
    validateSourceStat(stat, maximum);
    sourcePathMatches(context, path, stat);
    return { path, fd, stat, maximum };
  } catch (error) {
    try { context.ops.close(fd); } catch (closeError) {
      throw new AggregateError([error, closeError], "snapshot source open cleanup failed", { cause: error });
    }
    throw error;
  }
}

function closeDescriptors(context: Context, descriptors: readonly number[], label: string): void {
  const errors: unknown[] = [];
  for (const fd of [...descriptors].reverse()) {
    try { context.ops.close(fd); } catch (error) { errors.push(error); }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, label);
}

function closeSourceFiles(context: Context, files: readonly RetainedSourceFile[]): void {
  closeDescriptors(context, files.map((file) => file.fd), "snapshot source descriptor cleanup failed");
}

function relevantMembership(context: Context, databasePath: string): readonly string[] {
  const parent = dirname(databasePath);
  const leaf = basename(databasePath);
  const relevant = new Set([leaf, `${leaf}-wal`, `${leaf}-shm`, `${leaf}-journal`]);
  return context.ops.readdir(parent).filter((entry) => relevant.has(entry)).sort();
}

function membershipDigest(databasePath: string, entries: readonly string[]): string {
  return sha256(canonicalJson({ version: 1, databasePath, entries }));
}

function copySourceToExclusive(
  context: Context,
  source: RetainedSourceFile,
  destination: string,
): SqliteSnapshotFileIdentity {
  const destinationFd = context.ops.open(
    destination,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    CONTROL_MODE,
  );
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(COPY_CHUNK);
  let position = 0n;
  try {
    while (position < source.stat.size) {
      const wanted = Number(source.stat.size - position > BigInt(buffer.byteLength) ? BigInt(buffer.byteLength) : source.stat.size - position);
      const read = context.ops.read(source.fd, buffer, 0, wanted, Number(position));
      if (read <= 0) throw new InternalSnapshotError("changed");
      hash.update(buffer.subarray(0, read));
      let written = 0;
      while (written < read) {
        const count = context.ops.write(destinationFd, buffer, written, read - written, null);
        if (count <= 0) throw new InternalSnapshotError("io");
        written += count;
      }
      position += BigInt(read);
    }
    if (context.ops.read(source.fd, buffer, 0, 1, Number(position)) !== 0) throw new InternalSnapshotError("changed");
    context.ops.fsync(destinationFd);
  } finally {
    context.ops.close(destinationFd);
  }
  const copied = context.ops.lstat(destination);
  if (!copied.isFile() || copied.nlink !== 1n || copied.size !== source.stat.size) throw new InternalSnapshotError("io");
  return fileIdentity(source.stat, hash.digest("hex"));
}

function copyPrivateFile(context: Context, source: string, destination: string): void {
  const sourceFd = context.ops.open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  let destinationFd: number | undefined;
  try {
    const sourceStat = context.ops.fstat(sourceFd);
    if (!sourceStat.isFile() || sourceStat.size > SOURCE_LIMIT) throw new InternalSnapshotError("unsafe");
    destinationFd = context.ops.open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, CONTROL_MODE);
    const buffer = Buffer.allocUnsafe(COPY_CHUNK);
    let position = 0n;
    while (position < sourceStat.size) {
      const wanted = Number(sourceStat.size - position > BigInt(buffer.byteLength) ? BigInt(buffer.byteLength) : sourceStat.size - position);
      const read = context.ops.read(sourceFd, buffer, 0, wanted, Number(position));
      if (read <= 0) throw new InternalSnapshotError("changed");
      let written = 0;
      while (written < read) {
        const count = context.ops.write(destinationFd, buffer, written, read - written, null);
        if (count <= 0) throw new InternalSnapshotError("io");
        written += count;
      }
      position += BigInt(read);
    }
    context.ops.fsync(destinationFd);
  } finally {
    closeDescriptors(
      context,
      destinationFd === undefined ? [sourceFd] : [sourceFd, destinationFd],
      "private snapshot copy descriptor cleanup failed",
    );
  }
}

function privateFileWitness(context: Context, generationRoot: string, path: string): SqliteSnapshotPrivateFileWitness {
  const stat = context.ops.lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || mode(stat) !== ARTIFACT_MODE || stat.size > SOURCE_LIMIT) {
    throw new InternalSnapshotError("invalid");
  }
  const fd = context.ops.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const retained = context.ops.fstat(fd);
    if (!sameInode(stat, retained)) throw new InternalSnapshotError("changed");
    const digest = streamHash(context, fd, retained.size, SOURCE_LIMIT);
    const relativePath = path.slice(generationRoot.length + 1);
    return {
      relativePath,
      dev: decimal(retained.dev),
      ino: decimal(retained.ino),
      mode: mode(retained),
      size: decimal(retained.size),
      sha256: digest,
    };
  } finally {
    context.ops.close(fd);
  }
}

function roleBase(role: SqliteSnapshotRole): string {
  return role;
}

function sourceRoleChecksum(body: Omit<SqliteSnapshotSourceRoleWitness, "checksumSha256">): SqliteSnapshotSourceRoleWitness {
  return withChecksum(body as unknown as RecordValue) as unknown as SqliteSnapshotSourceRoleWitness;
}

function artifactRoleChecksum(body: Omit<SqliteSnapshotArtifactRoleWitness, "checksumSha256">): SqliteSnapshotArtifactRoleWitness {
  return withChecksum(body as unknown as RecordValue) as unknown as SqliteSnapshotArtifactRoleWitness;
}

type AuthenticatedSourceFiles = Readonly<{
  main: RetainedSourceFile;
  wal: RetainedSourceFile | null;
  shm: RetainedSourceFile | null;
}>;

async function authenticateSourceRoleBytes<T>(
  context: Context,
  role: SqliteSnapshotRole,
  databasePath: string,
  operation: (files: AuthenticatedSourceFiles) => Promise<T> | T,
): Promise<Readonly<{ source: SqliteSnapshotSourceRoleWitness; value: T }>> {
  const parentPath = dirname(databasePath);
  await observe(context, "before-source-open", databasePath, role);
  const parentFd = context.ops.open(parentPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const sources: RetainedSourceFile[] = [];
  try {
    const parentStat = context.ops.fstat(parentFd);
    const parentPathStat = assertDirectory(context, parentPath);
    if (!sameInode(parentStat, parentPathStat)) throw new InternalSnapshotError("changed");
    const parentIdentity: SqliteSnapshotDirectoryIdentity = {
      dev: decimal(parentStat.dev), ino: decimal(parentStat.ino), uid: Number(parentStat.uid),
      gid: Number(parentStat.gid), mode: mode(parentStat),
    };
    const beforeEntries = relevantMembership(context, databasePath);
    if (beforeEntries.includes(`${basename(databasePath)}-journal`)) throw new InternalSnapshotError("unsupported");
    const main = openSourceFile(context, databasePath, SOURCE_LIMIT);
    sources.push(main);
    const walPath = `${databasePath}-wal`;
    const shmPath = `${databasePath}-shm`;
    const wal = beforeEntries.includes(`${basename(databasePath)}-wal`) ? openSourceFile(context, walPath, SOURCE_LIMIT) : null;
    if (wal !== null) sources.push(wal);
    const shm = beforeEntries.includes(`${basename(databasePath)}-shm`) ? openSourceFile(context, shmPath, SHM_LIMIT) : null;
    if (shm !== null) sources.push(shm);
    await observe(context, "after-source-open", databasePath, role);
    const mainBefore = fileIdentity(main.stat, streamHash(context, main.fd, main.stat.size, SOURCE_LIMIT));
    const walBefore = wal === null ? null : fileIdentity(wal.stat, streamHash(context, wal.fd, wal.stat.size, SOURCE_LIMIT));
    const shmBefore = shm === null ? null : fileIdentity(shm.stat, streamHash(context, shm.fd, shm.stat.size, SHM_LIMIT));
    const value = await operation({ main, wal, shm });
    await observe(context, "after-source-copy", databasePath, role);
    await observe(context, "before-source-revalidate", databasePath, role);

    const mainAfterStat = context.ops.fstat(main.fd);
    const mainAfter = fileIdentity(mainAfterStat, streamHash(context, main.fd, mainAfterStat.size, SOURCE_LIMIT));
    const walAfter = wal === null ? null : (() => {
      const stat = context.ops.fstat(wal.fd);
      return fileIdentity(stat, streamHash(context, wal.fd, stat.size, SOURCE_LIMIT));
    })();
    const shmAfter = shm === null ? null : (() => {
      const stat = context.ops.fstat(shm.fd);
      return fileIdentity(stat, streamHash(context, shm.fd, stat.size, SHM_LIMIT));
    })();
    sourcePathMatches(context, databasePath, mainAfterStat);
    if (wal !== null) sourcePathMatches(context, walPath, context.ops.fstat(wal.fd));
    if (shm !== null) sourcePathMatches(context, shmPath, context.ops.fstat(shm.fd));
    const afterEntries = relevantMembership(context, databasePath);
    const afterParent = context.ops.fstat(parentFd);
    if (!sameInode(parentStat, afterParent) || !sameInode(parentStat, assertDirectory(context, parentPath))) {
      throw new InternalSnapshotError("changed");
    }
    const membershipBeforeSha256 = membershipDigest(databasePath, beforeEntries);
    const membershipAfterSha256 = membershipDigest(databasePath, afterEntries);
    if (
      membershipBeforeSha256 !== membershipAfterSha256
      || !sameFileIdentity(mainBefore, mainAfter)
      || (walBefore === null) !== (walAfter === null)
      || (walBefore !== null && walAfter !== null && !sameFileIdentity(walBefore, walAfter))
      || (shmBefore === null) !== (shmAfter === null)
      || (shmBefore !== null && shmAfter !== null && !sameFileIdentity(shmBefore, shmAfter))
    ) throw new InternalSnapshotError("changed");

    await observe(context, "before-source-close", databasePath, role);
    closeSourceFiles(context, sources.splice(0));
    await observe(context, "after-source-close", databasePath, role);
    const source = sourceRoleChecksum({
      version: 1,
      role,
      path: databasePath,
      parent: parentIdentity,
      membershipBeforeSha256,
      membershipAfterSha256,
      mainBefore,
      mainAfter,
      walBefore,
      walAfter,
      shmBefore,
      shmAfter,
    });
    return { source, value };
  } finally {
    closeDescriptors(
      context,
      [...sources.map((file) => file.fd), parentFd],
      "snapshot role capture descriptor cleanup failed",
    );
  }
}

async function captureRole(
  context: Context,
  role: SqliteSnapshotRole,
  databasePath: string,
  destinationRoot: string,
): Promise<SqliteSnapshotArtifactRoleWitness> {
  const rawMainPath = join(destinationRoot, `${roleBase(role)}.raw.sqlite`);
  const rawWalPath = join(destinationRoot, `${roleBase(role)}.raw.sqlite-wal`);
  const authenticated = await authenticateSourceRoleBytes(context, role, databasePath, (files) => {
    copySourceToExclusive(context, files.main, rawMainPath);
    if (files.wal !== null) copySourceToExclusive(context, files.wal, rawWalPath);
    return { walPresent: files.wal !== null };
  });
  const normalizedMainPath = join(destinationRoot, `${roleBase(role)}.sqlite`);
  copyPrivateFile(context, rawMainPath, normalizedMainPath);
  if (authenticated.value.walPresent) copyPrivateFile(context, rawWalPath, `${normalizedMainPath}-wal`);
  await observe(context, "before-private-inspection", normalizedMainPath, role);
  const inspection = context.ops.inspectDatabase(normalizedMainPath, true);
  await observe(context, "after-private-inspection", normalizedMainPath, role);
  for (const suffix of ["-wal", "-shm"]) {
    try { context.ops.unlink(`${normalizedMainPath}${suffix}`); } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
  }
  const durablePaths = [rawMainPath, ...(authenticated.value.walPresent ? [rawWalPath] : []), normalizedMainPath];
  for (const path of durablePaths) {
    await observe(context, "before-private-fsync", path, role);
    const fd = context.ops.open(path, constants.O_RDWR | constants.O_NOFOLLOW);
    try { context.ops.fsync(fd); } finally { context.ops.close(fd); }
    context.ops.chmod(path, ARTIFACT_MODE);
    await observe(context, "after-private-fsync", path, role);
  }
  syncDirectory(context, destinationRoot);
    const rawMain = privateFileWitness(context, destinationRoot, rawMainPath);
    const rawWal = authenticated.value.walPresent ? privateFileWitness(context, destinationRoot, rawWalPath) : null;
    const normalizedMain = privateFileWitness(context, destinationRoot, normalizedMainPath);
    const contentSha256 = sha256(canonicalJson({ rawMain, rawWal, normalizedMain }));
    return artifactRoleChecksum({
      version: 1,
      role,
      source: authenticated.source,
      rawMain,
      rawWal,
      normalizedMain,
      ...inspection,
      contentSha256,
    });
}

function requestSha256(authority: AuthenticatedSqliteSnapshotAuthority, generationId: string, maintenanceChecksumSha256: string): string {
  return sha256(canonicalJson({ version: 1, generationId, sourceSelectionSha256: authority.sourceSelectionSha256, maintenanceChecksumSha256 }));
}

function assertMaintenance(context: Context, authority: AuthenticatedSqliteSnapshotAuthority): ReturnType<typeof readBackendMaintenanceJournal> & object {
  const journal = readBackendMaintenanceJournal(context.homeDir);
  if (
    journal === null
    || journal.version !== 3
    || journal.phase !== "maintenance-held"
    || journal.sourceBackend !== "sqlite"
    || journal.targetBackend !== null
    || journal.generationId !== context.generationId
    || journal.sourceSelectionSha256 !== authority.sourceSelectionSha256
    || journal.checksumSha256 !== context.maintenanceChecksumSha256
  ) throw new SqliteSnapshotError("maintenance-mismatch");
  return journal;
}

function roleInputs(authority: AuthenticatedSqliteSnapshotAuthority): readonly Readonly<{ role: SqliteSnapshotRole; path: string }>[] {
  return [
    { role: "project", path: authority.projectDbPath },
    ...(authority.passiveEventsDbPath === null ? [] : [{ role: "passive-events" as const, path: authority.passiveEventsDbPath }]),
    { role: "machine-sequence", path: authority.machineSequenceDbPath },
  ];
}

function sourceByteWitness(
  authority: AuthenticatedSqliteSnapshotAuthority,
  roles: readonly SqliteSnapshotSourceRoleWitness[],
): SqliteSnapshotSourceByteWitness {
  return withChecksum({
    version: 1,
    sourceSelectionSha256: authority.sourceSelectionSha256,
    roles,
  } as unknown as RecordValue) as unknown as SqliteSnapshotSourceByteWitness;
}

function validateSourceByteWitness(
  value: unknown,
  authority: AuthenticatedSqliteSnapshotAuthority,
): SqliteSnapshotSourceByteWitness {
  if (!isRecord(value) || !exactKeys(value, ["checksumSha256", "roles", "sourceSelectionSha256", "version"])) {
    throw new SqliteSnapshotError("invalid-input");
  }
  const { checksumSha256, ...body } = value;
  const inputs = roleInputs(authority);
  if (value.version !== 1 || value.sourceSelectionSha256 !== authority.sourceSelectionSha256
    || typeof checksumSha256 !== "string" || !HASH.test(checksumSha256)
    || sha256(canonicalJson(body)) !== checksumSha256 || !Array.isArray(value.roles)
    || value.roles.length !== inputs.length) throw new SqliteSnapshotError("invalid-input");
  value.roles.forEach((role, index) => validateSourceWitness(role, inputs[index]!.role, inputs[index]!.path));
  return value as unknown as SqliteSnapshotSourceByteWitness;
}

export async function authenticateSqliteSnapshotSourceBytes(
  authorityValue: AuthenticatedSqliteSnapshotAuthority,
  options: SqliteSnapshotSourceByteOptions,
): Promise<SqliteSnapshotSourceByteWitness> {
  const authority = validateAuthority(authorityValue);
  const context = contextFor({
    homeDir: options.homeDir,
    lockToken: options.lockToken,
    _operationsForTesting: options._operationsForTesting,
  });
  try {
    return await withBackendPublicationConsumerLockAsync(context.homeDir, async () => {
      const roles: SqliteSnapshotSourceRoleWitness[] = [];
      for (const input of roleInputs(authority)) {
        const authenticated = await authenticateSourceRoleBytes(context, input.role, input.path, () => undefined);
        roles.push(authenticated.source);
      }
      return sourceByteWitness(authority, roles);
    }, { allowUnresolved: true, lockToken: options.lockToken });
  } catch (error) {
    mapCaptureError(error);
  }
}

function artifactWitness(
  context: Context,
  authority: AuthenticatedSqliteSnapshotAuthority,
  roles: readonly SqliteSnapshotArtifactRoleWitness[],
  queueEvidenceSha256: string,
  sourceByteWitnessSha256: string,
): SqliteSnapshotArtifactWitness {
  const now = context.ops.now();
  if (!Number.isFinite(now.getTime())) throw new SqliteSnapshotError("invalid-input");
  const capturedAt = now.toISOString();
  const schemaSha256 = sha256(canonicalJson(roles.map((role) => ({ role: role.role, schemaSha256: role.schemaSha256 }))));
  const contentSha256 = sha256(canonicalJson(roles.map((role) => ({ role: role.role, contentSha256: role.contentSha256 }))));
  const artifactSha256 = sha256(canonicalJson({
    version: 1,
    generationId: context.generationId,
    sourceSelectionSha256: authority.sourceSelectionSha256,
    maintenanceChecksumSha256: context.maintenanceChecksumSha256,
    queueEvidenceSha256,
    sourceByteWitnessSha256,
    schemaSha256,
    contentSha256,
    roleChecksums: roles.map((role) => role.checksumSha256),
  }));
  return withChecksum({
    version: 1,
    generationId: context.generationId,
    requestSha256: requestSha256(authority, context.generationId, context.maintenanceChecksumSha256!),
    authority,
    sourceSelectionSha256: authority.sourceSelectionSha256,
    maintenanceChecksumSha256: context.maintenanceChecksumSha256!,
    queueEvidenceSha256,
    sourceByteWitnessSha256,
    roles,
    schemaSha256,
    contentSha256,
    capturedAt,
    artifactSha256,
  } as unknown as RecordValue) as unknown as SqliteSnapshotArtifactWitness;
}

function readSmallFile(context: Context, path: string, expectedMode = CONTROL_MODE): Buffer {
  const fd = context.ops.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = context.ops.fstat(fd);
    const uid = currentUid();
    if (!stat.isFile() || stat.nlink !== 1n || mode(stat) !== expectedMode || stat.size < 1n
      || stat.size > BigInt(CONTROL_LIMIT) || Number(stat.uid) !== uid) {
      throw new InternalSnapshotError("invalid");
    }
    const bytes = Buffer.alloc(Number(stat.size));
    let position = 0;
    while (position < bytes.byteLength) {
      const read = context.ops.read(fd, bytes, position, bytes.byteLength - position, position);
      if (read <= 0) throw new InternalSnapshotError("changed");
      position += read;
    }
    if (bytes[bytes.length - 1] !== 10 || bytes.includes(13)) throw new InternalSnapshotError("invalid");
    return bytes;
  } finally {
    context.ops.close(fd);
  }
}

function readControl(context: Context, path: string): RecordValue {
  let value: unknown;
  try { value = JSON.parse(readSmallFile(context, path).toString("utf8")); } catch (error) {
    if (error instanceof InternalSnapshotError) throw error;
    throw new InternalSnapshotError("invalid", { cause: error });
  }
  if (!isRecord(value) || typeof value.checksumSha256 !== "string" || !HASH.test(value.checksumSha256)) {
    throw new InternalSnapshotError("invalid");
  }
  const { checksumSha256, ...body } = value;
  if (sha256(canonicalJson(body)) !== checksumSha256) throw new InternalSnapshotError("invalid");
  return value;
}

function validatePrivateWitness(value: unknown): SqliteSnapshotPrivateFileWitness {
  if (!isRecord(value) || !exactKeys(value, ["dev", "ino", "mode", "relativePath", "sha256", "size"])
    || typeof value.relativePath !== "string" || value.relativePath.length === 0
    || value.relativePath.includes("/") || value.relativePath.includes("\\")
    || typeof value.dev !== "string" || typeof value.ino !== "string" || typeof value.size !== "string"
    || !/^\d+$/u.test(value.dev) || !/^\d+$/u.test(value.ino) || !/^\d+$/u.test(value.size)
    || value.mode !== ARTIFACT_MODE || typeof value.sha256 !== "string" || !HASH.test(value.sha256)) {
    throw new InternalSnapshotError("invalid");
  }
  return value as unknown as SqliteSnapshotPrivateFileWitness;
}

function validateSourceFileIdentity(value: unknown): SqliteSnapshotFileIdentity {
  if (!isRecord(value) || !exactKeys(value, ["ctimeNs", "dev", "gid", "ino", "mode", "mtimeNs", "nlink", "sha256", "size", "uid"])
    || !["ctimeNs", "dev", "ino", "mtimeNs", "nlink", "size"].every((key) => typeof value[key] === "string" && /^\d+$/u.test(value[key] as string))
    || !Number.isSafeInteger(value.uid) || !Number.isSafeInteger(value.gid) || !OWNER_FILE_MODES.has(value.mode as number)
    || typeof value.sha256 !== "string" || !HASH.test(value.sha256)) throw new InternalSnapshotError("invalid");
  return value as unknown as SqliteSnapshotFileIdentity;
}

function validateSourceWitness(value: unknown, role: SqliteSnapshotRole, path: string): SqliteSnapshotSourceRoleWitness {
  if (!isRecord(value) || !exactKeys(value, [
    "checksumSha256", "mainAfter", "mainBefore", "membershipAfterSha256", "membershipBeforeSha256",
    "parent", "path", "role", "shmAfter", "shmBefore", "version", "walAfter", "walBefore",
  ])) throw new InternalSnapshotError("invalid");
  const { checksumSha256, ...body } = value;
  if (value.version !== 1 || value.role !== role || value.path !== path || typeof checksumSha256 !== "string"
    || sha256(canonicalJson(body)) !== checksumSha256
    || !HASH.test(String(value.membershipBeforeSha256)) || value.membershipBeforeSha256 !== value.membershipAfterSha256
    || !isRecord(value.parent) || !exactKeys(value.parent, ["dev", "gid", "ino", "mode", "uid"])
    || value.parent.mode !== DIRECTORY_MODE) throw new InternalSnapshotError("invalid");
  const mainBefore = validateSourceFileIdentity(value.mainBefore);
  const mainAfter = validateSourceFileIdentity(value.mainAfter);
  const pair = (before: unknown, after: unknown): void => {
    if ((before === null) !== (after === null)) throw new InternalSnapshotError("invalid");
    if (before !== null && canonicalJson(validateSourceFileIdentity(before)) !== canonicalJson(validateSourceFileIdentity(after))) {
      throw new InternalSnapshotError("invalid");
    }
  };
  if (canonicalJson(mainBefore) !== canonicalJson(mainAfter)) throw new InternalSnapshotError("invalid");
  pair(value.walBefore, value.walAfter);
  pair(value.shmBefore, value.shmAfter);
  return value as unknown as SqliteSnapshotSourceRoleWitness;
}

function validateArtifactRole(value: unknown, input: Readonly<{ role: SqliteSnapshotRole; path: string }>): SqliteSnapshotArtifactRoleWitness {
  if (!isRecord(value) || !exactKeys(value, [
    "checksumSha256", "contentSha256", "encoding", "normalizedMain", "quickCheck", "rawMain",
    "rawWal", "role", "schemaSha256", "source", "userVersion", "version",
  ])) throw new InternalSnapshotError("invalid");
  const { checksumSha256, ...body } = value;
  if (value.version !== 1 || value.role !== input.role || value.encoding !== "UTF-8" || value.userVersion !== 0
    || value.quickCheck !== "ok" || typeof value.schemaSha256 !== "string" || !HASH.test(value.schemaSha256)
    || typeof value.contentSha256 !== "string" || !HASH.test(value.contentSha256)
    || typeof checksumSha256 !== "string" || sha256(canonicalJson(body)) !== checksumSha256) {
    throw new InternalSnapshotError("invalid");
  }
  validateSourceWitness(value.source, input.role, input.path);
  validatePrivateWitness(value.rawMain);
  if (value.rawWal !== null) validatePrivateWitness(value.rawWal);
  validatePrivateWitness(value.normalizedMain);
  return value as unknown as SqliteSnapshotArtifactRoleWitness;
}

function validateWitness(value: unknown, generationId: string): SqliteSnapshotArtifactWitness {
  if (!isRecord(value) || !exactKeys(value, [
    "artifactSha256", "authority", "capturedAt", "checksumSha256", "contentSha256", "generationId",
    "maintenanceChecksumSha256", "queueEvidenceSha256", "requestSha256", "roles", "schemaSha256", "sourceByteWitnessSha256", "sourceSelectionSha256", "version",
  ])) throw new InternalSnapshotError("invalid");
  const { checksumSha256, ...body } = value;
  if (value.version !== 1 || value.generationId !== generationId
    || ![value.artifactSha256, value.contentSha256, value.maintenanceChecksumSha256, value.queueEvidenceSha256, value.requestSha256,
      value.sourceByteWitnessSha256,
      value.schemaSha256, value.sourceSelectionSha256, checksumSha256].every((entry) => typeof entry === "string" && HASH.test(entry))
    || typeof value.capturedAt !== "string" || !Number.isFinite(Date.parse(value.capturedAt))
    || sha256(canonicalJson(body)) !== checksumSha256) throw new InternalSnapshotError("invalid");
  let authority: AuthenticatedSqliteSnapshotAuthority;
  try { authority = validateAuthority(value.authority); } catch (error) {
    throw new InternalSnapshotError("invalid", { cause: error });
  }
  if (authority.sourceSelectionSha256 !== value.sourceSelectionSha256 || !Array.isArray(value.roles)) throw new InternalSnapshotError("invalid");
  const inputs = roleInputs(authority);
  if (value.roles.length !== inputs.length) throw new InternalSnapshotError("invalid");
  const roles = value.roles.map((role, index) => validateArtifactRole(role, inputs[index]!));
  const expectedSchema = sha256(canonicalJson(roles.map((role) => ({ role: role.role, schemaSha256: role.schemaSha256 }))));
  const expectedContent = sha256(canonicalJson(roles.map((role) => ({ role: role.role, contentSha256: role.contentSha256 }))));
  const expectedArtifact = sha256(canonicalJson({
    version: 1, generationId, sourceSelectionSha256: authority.sourceSelectionSha256,
    maintenanceChecksumSha256: value.maintenanceChecksumSha256,
    queueEvidenceSha256: value.queueEvidenceSha256,
    sourceByteWitnessSha256: value.sourceByteWitnessSha256,
    schemaSha256: expectedSchema, contentSha256: expectedContent,
    roleChecksums: roles.map((role) => role.checksumSha256),
  }));
  if (value.schemaSha256 !== expectedSchema || value.contentSha256 !== expectedContent || value.artifactSha256 !== expectedArtifact
    || value.requestSha256 !== requestSha256(authority, generationId, value.maintenanceChecksumSha256 as string)) {
    throw new InternalSnapshotError("invalid");
  }
  return value as unknown as SqliteSnapshotArtifactWitness;
}

function verifyPrivateFile(context: Context, generationRoot: string, witness: SqliteSnapshotPrivateFileWitness): void {
  const path = join(generationRoot, witness.relativePath);
  const actual = privateFileWitness(context, generationRoot, path);
  if (canonicalJson(actual) !== canonicalJson(witness)) throw new InternalSnapshotError("changed");
}

function verifyCompleteWitness(context: Context, witness: SqliteSnapshotArtifactWitness): void {
  const root = generationPath(context, witness.generationId);
  const allowed = new Set(["intent.json", "witness.json", "witness.committed"]);
  for (const role of witness.roles) {
    for (const file of [role.rawMain, role.rawWal, role.normalizedMain]) {
      if (file !== null) allowed.add(file.relativePath);
    }
  }
  if (context.ops.readdir(root).some((entry) => !allowed.has(entry))) throw new InternalSnapshotError("invalid");
  for (const role of witness.roles) {
    verifyPrivateFile(context, root, role.rawMain);
    if (role.rawWal !== null) verifyPrivateFile(context, root, role.rawWal);
    verifyPrivateFile(context, root, role.normalizedMain);
    const inspection = context.ops.inspectDatabase(join(root, role.normalizedMain.relativePath), false);
    if (canonicalJson(inspection) !== canonicalJson({
      encoding: role.encoding, userVersion: role.userVersion, quickCheck: role.quickCheck, schemaSha256: role.schemaSha256,
    })) throw new InternalSnapshotError("invalid");
  }
}

function registrationName(generationId: string, kind: "intent" | "identity"): string {
  return `${generationId}.${kind}.json`;
}

function exists(context: Context, path: string): boolean {
  try { context.ops.lstat(path); return true; } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

function classifyInternal(context: Context, generationId: string): SqliteSnapshotClassification {
  const intentPath = join(registrationsPath(context), registrationName(generationId, "intent"));
  const identityPath = join(registrationsPath(context), registrationName(generationId, "identity"));
  const directoryPath = generationPath(context, generationId);
  const intentExists = exists(context, intentPath);
  const identityExists = exists(context, identityPath);
  const directoryExists = exists(context, directoryPath);
  if (!intentExists && !identityExists && !directoryExists) return { state: "absent" };
  if (!intentExists) throw new InternalSnapshotError("invalid");
  const registrationIntent = readControl(context, intentPath);
  if (!exactKeys(registrationIntent, ["checksumSha256", "generationId", "requestSha256", "version"])
    || registrationIntent.version !== 1 || registrationIntent.generationId !== generationId || !HASH.test(String(registrationIntent.requestSha256))) {
    throw new InternalSnapshotError("invalid");
  }
  if (!identityExists && !directoryExists) return { state: "partial", generationId };
  if (!directoryExists) return { state: "replaced", generationId };
  const directoryStat = assertDirectory(context, directoryPath);
  if (!identityExists) return { state: "partial", generationId };
  const identity = readControl(context, identityPath);
  if (!exactKeys(identity, ["checksumSha256", "generationDev", "generationId", "generationIno", "generationsDev", "generationsIno", "requestSha256", "version"])
    || identity.version !== 1 || identity.generationId !== generationId
    || identity.requestSha256 !== registrationIntent.requestSha256
    || ![identity.generationDev, identity.generationIno, identity.generationsDev, identity.generationsIno].every((entry) => typeof entry === "string" && /^\d+$/u.test(entry))) {
    throw new InternalSnapshotError("invalid");
  }
  const generationsStat = assertDirectory(context, generationsPath(context));
  if (decimal(directoryStat.dev) !== identity.generationDev || decimal(directoryStat.ino) !== identity.generationIno
    || decimal(generationsStat.dev) !== identity.generationsDev || decimal(generationsStat.ino) !== identity.generationsIno) {
    return { state: "replaced", generationId };
  }
  const generationIntent = readControl(context, join(directoryPath, "intent.json"));
  if (!exactKeys(generationIntent, ["checksumSha256", "generationId", "nonce", "requestSha256", "version"])
    || generationIntent.version !== 1 || generationIntent.generationId !== generationId
    || generationIntent.requestSha256 !== registrationIntent.requestSha256
    || typeof generationIntent.nonce !== "string" || !/^[0-9a-f]{48}$/u.test(generationIntent.nonce)) {
    throw new InternalSnapshotError("invalid");
  }
  const markerPath = join(directoryPath, "witness.committed");
  if (!exists(context, markerPath)) return { state: "partial", generationId };
  const witness = validateWitness(readControl(context, join(directoryPath, "witness.json")), generationId);
  if (witness.requestSha256 !== registrationIntent.requestSha256) throw new InternalSnapshotError("invalid");
  const marker = readSmallFile(context, markerPath).toString("ascii");
  if (marker !== `${witness.checksumSha256}\n`) throw new InternalSnapshotError("invalid");
  verifyCompleteWitness(context, witness);
  return { state: "complete", witness };
}

function mapClassificationError(
  error: unknown,
  generationId: string,
): Extract<SqliteSnapshotClassification, { state: "tampered" }> {
  void error;
  return { state: "tampered", generationId };
}

export async function classifySqliteSnapshotArtifact(
  generationValue: string,
  options: ClassificationOptions,
): Promise<SqliteSnapshotClassification> {
  const generationId = validateGeneration(generationValue);
  const context = contextFor({ ...options, generationId });
  try { return classifyInternal(context, generationId); } catch (error) {
    return mapClassificationError(error, generationId);
  }
}

export async function inspectSqliteSnapshotArtifact(
  generationValue: string,
  options: ClassificationOptions,
): Promise<SqliteSnapshotArtifactWitness> {
  const classification = await classifySqliteSnapshotArtifact(generationValue, options);
  if (classification.state === "complete") return classification.witness;
  throw new SqliteSnapshotError(`snapshot-${classification.state}` as SqliteSnapshotErrorReason);
}

async function createGenerationPrefix(
  context: Context,
  authority: AuthenticatedSqliteSnapshotAuthority,
): Promise<string> {
  ensureArtifactDirectories(context);
  const request = requestSha256(authority, context.generationId, context.maintenanceChecksumSha256!);
  const registrationIntentPath = join(registrationsPath(context), registrationName(context.generationId, "intent"));
  writeControl(context, registrationIntentPath, { version: 1, generationId: context.generationId, requestSha256: request });
  const generation = generationPath(context);
  context.ops.mkdir(generation, DIRECTORY_MODE);
  syncDirectory(context, generationsPath(context));
  assertDirectory(context, generation);
  const nonce = context.ops.nonce();
  if (!/^[0-9a-f]{48}$/u.test(nonce)) throw new InternalSnapshotError("invalid");
  writeControl(context, join(generation, "intent.json"), {
    version: 1, generationId: context.generationId, requestSha256: request, nonce,
  });
  const generationsStat = assertDirectory(context, generationsPath(context));
  const generationStat = assertDirectory(context, generation);
  writeControl(context, join(registrationsPath(context), registrationName(context.generationId, "identity")), {
    version: 1,
    generationId: context.generationId,
    requestSha256: request,
    generationsDev: decimal(generationsStat.dev),
    generationsIno: decimal(generationsStat.ino),
    generationDev: decimal(generationStat.dev),
    generationIno: decimal(generationStat.ino),
  });
  return generation;
}

function classificationFailure(classification: Exclude<SqliteSnapshotClassification, { state: "absent" } | { state: "complete" }>): never {
  throw new SqliteSnapshotError(`snapshot-${classification.state}` as SqliteSnapshotErrorReason);
}

function mapCaptureError(error: unknown): never {
  if (error instanceof SqliteSnapshotError) throw error;
  if (error instanceof InternalSnapshotError) {
    if (error.kind === "changed") throw new SqliteSnapshotError("source-changed", undefined, { cause: error });
    if (error.kind === "unsafe") throw new SqliteSnapshotError("source-unsafe", undefined, { cause: error });
    if (error.kind === "unsupported") throw new SqliteSnapshotError("unsupported-sqlite", undefined, { cause: error });
  }
  throw new SqliteSnapshotError("snapshot-io", undefined, { cause: error });
}

export async function captureSqliteSnapshotArtifact(
  authorityValue: AuthenticatedSqliteSnapshotAuthority,
  options: SqliteSnapshotOptions,
): Promise<SqliteSnapshotArtifactWitness> {
  const authority = validateAuthority(authorityValue);
  const expectedSourceBytes = validateSourceByteWitness(options.expectedSourceBytes, authority);
  if (!HASH.test(options.maintenanceChecksumSha256)) throw new SqliteSnapshotError("invalid-input");
  const context = contextFor(options);
  try {
    return await withBackendPublicationConsumerLockAsync(context.homeDir, async (token) =>
      withPrivateMutationLockAsync(lockPath(context), "sqlite snapshot artifact", async () => {
        const maintenance = assertMaintenance(context, authority);
        if (maintenance.queueEvidenceSha256 !== expectedSourceBytes.checksumSha256) {
          throw new SqliteSnapshotError("maintenance-mismatch");
        }
        let existing: SqliteSnapshotClassification;
        try { existing = classifyInternal(context, context.generationId); } catch (error) {
          return classificationFailure(mapClassificationError(error, context.generationId));
        }
        if (existing.state === "complete") {
          assertMaintenance(context, authority);
          return existing.witness;
        }
        if (existing.state !== "absent") return classificationFailure(existing);
        const generation = await createGenerationPrefix(context, authority);
        const captureRoles = async (): Promise<SqliteSnapshotArtifactRoleWitness[]> => {
          assertMaintenance(context, authority);
          const captured: SqliteSnapshotArtifactRoleWitness[] = [];
          for (const input of roleInputs(authority)) captured.push(await captureRole(context, input.role, input.path, generation));
          if (canonicalJson(captured.map((role) => role.source)) !== canonicalJson(expectedSourceBytes.roles)) {
            throw new InternalSnapshotError("changed");
          }
          assertMaintenance(context, authority);
          return captured;
        };
        const roles = context.lockToken === undefined
          ? await withBackendPublicationAppendBarrierAsync(context.homeDir, captureRoles, token)
          : await captureRoles();
        await observe(context, "before-witness", generation, null);
        const witness = artifactWitness(
          context,
          authority,
          roles,
          maintenance.queueEvidenceSha256,
          expectedSourceBytes.checksumSha256,
        );
        writeControl(context, join(generation, "witness.json"), (() => {
          const { checksumSha256: _checksum, ...body } = witness;
          return body as unknown as RecordValue;
        })());
        await observe(context, "before-commit-marker", generation, null);
        assertMaintenance(context, authority);
        publishCommitMarker(context, generation, witness.checksumSha256);
        await observe(context, "after-commit-marker", generation, null);
        const completed = classifyInternal(context, context.generationId);
        if (completed.state !== "complete") throw new InternalSnapshotError("io");
        return completed.witness;
      }),
    { allowUnresolved: true, ...(context.lockToken === undefined ? {} : { lockToken: context.lockToken }) });
  } catch (error) {
    mapCaptureError(error);
  }
}

export async function dryRunSqliteSnapshotArtifact(
  authorityValue: AuthenticatedSqliteSnapshotAuthority,
  options: SqliteSnapshotDryRunOptions,
): Promise<SqliteSnapshotDryRun> {
  const authority = validateAuthority(authorityValue);
  const context = contextFor({
    homeDir: options.homeDir,
    lockToken: options.lockToken,
    _operationsForTesting: options._operationsForTesting,
  });
  try {
    return await withBackendPublicationConsumerLockAsync(context.homeDir, async (token) => {
      ensureArtifactDirectories(context);
      const inspections = ensureChildDirectory(context, rootPath(context), "inspections");
      const nonce = context.ops.nonce();
      if (!/^[0-9a-f]{48}$/u.test(nonce)) throw new InternalSnapshotError("invalid");
      const scratch = join(inspections, `dry-run.${nonce}`);
      context.ops.mkdir(scratch, DIRECTORY_MODE);
      syncDirectory(context, inspections);
      let result: SqliteSnapshotDryRun | undefined;
      let bodyError: unknown;
      try {
        const inspectRoles = async (): Promise<Readonly<{
          captured: SqliteSnapshotArtifactRoleWitness[];
          expectedSourceBytes: SqliteSnapshotSourceByteWitness;
        }>> => {
          const expectedSourceBytes = await authenticateSqliteSnapshotSourceBytes(authority, {
            homeDir: context.homeDir,
            lockToken: token,
            _operationsForTesting: options._operationsForTesting,
          });
          const captured: SqliteSnapshotArtifactRoleWitness[] = [];
          for (const input of roleInputs(authority)) captured.push(await captureRole(context, input.role, input.path, scratch));
          if (canonicalJson(captured.map((role) => role.source)) !== canonicalJson(expectedSourceBytes.roles)) {
            throw new InternalSnapshotError("changed");
          }
          return { captured, expectedSourceBytes };
        };
        const roles = context.lockToken === undefined
          ? await withBackendPublicationAppendBarrierAsync(context.homeDir, inspectRoles, token)
          : await inspectRoles();
        const inspectedAt = context.ops.now().toISOString();
        const body = {
          version: 1 as const,
          sourceSelectionSha256: authority.sourceSelectionSha256,
          sourceByteWitnessSha256: roles.expectedSourceBytes.checksumSha256,
          roles: roles.captured.map((role) => ({
            role: role.role,
            source: role.source,
            encoding: role.encoding,
            userVersion: role.userVersion,
            quickCheck: role.quickCheck,
            schemaSha256: role.schemaSha256,
            contentSha256: role.contentSha256,
          })),
          inspectedAt,
        };
        result = withChecksum(body as unknown as RecordValue) as unknown as SqliteSnapshotDryRun;
      } catch (error) {
        bodyError = error;
        throw error;
      } finally {
        try {
          context.ops.remove(scratch, { recursive: true, force: false });
          syncDirectory(context, inspections);
        } catch (cleanupError) {
          if (bodyError === undefined) throw cleanupError;
          throw new AggregateError([bodyError, cleanupError], "snapshot dry-run and cleanup failed", { cause: bodyError });
        }
      }
      return result!;
    }, { allowUnresolved: true, ...(context.lockToken === undefined ? {} : { lockToken: context.lockToken }) });
  } catch (error) {
    mapCaptureError(error);
  }
}
