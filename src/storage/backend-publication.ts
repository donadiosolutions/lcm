import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readdirSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  PrivateMutationPermit,
  withPrivateMutationLock,
  withPrivateMutationLockAsync,
  withRevocablePrivateMutationPermit,
} from "../private-mutation-lock.js";
import {
  atomicWritePrivateFileDurable,
  consumeBoundedRegularFile,
  assertPrivateDirectory,
  OWNER_ONLY_FILE_MODES,
  openPrivateDirectory,
  readBoundedRegularFileWithStat,
  syncPrivateDirectory,
  isOwnerOnlyFileMode,
  openPrivateDirectoryIfExists,
} from "../security-files.js";
import type { StorageBackendName } from "./contracts.js";
import {
  HomeLockTopologyError,
  assertHomeLockTopology,
  closeHomeLockTopology,
  openHomeLockTopology,
  restoreHomeLockTopologyMode,
} from "./home-lock-topology.js";

const MAX_JOURNAL_BYTES = 1 * 1024 * 1024;
const MAX_MATERIAL_BYTES = 8 * 1024 * 1024;
const MAX_RECOVERY_FILE_BYTES = 4 * 1024 * 1024;
const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const PUBLICATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MATERIAL_PATH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\.material$/u;
const BACKEND_PUBLICATION_VERSION = 2 as const;

export type BackendPublicationPhase =
  | "preparing"
  | "prepared"
  | "acquiring"
  | "guarded"
  | "map-publishing"
  | "map-published"
  | "config-publishing"
  | "config-published"
  | "releasing"
  | "released"
  | "aborting"
  | "config-restoring"
  | "map-restoring"
  | "abort-releasing"
  | "aborted"
  | "completed";

export type BackendPublicationFileWitness =
  | Readonly<{
    presence: "absent";
    rawSha256: null;
    semanticSha256: null;
    byteLength: 0;
    mode: null;
    uid: null;
    gid: null;
    nlink: null;
    dev: null;
    ino: null;
    parentDev: null;
    parentIno: null;
  }>
  | Readonly<{
    presence: "present";
    rawSha256: string;
    semanticSha256: string;
    byteLength: number;
    mode: number;
    uid: number;
    gid: number;
    nlink: string;
    dev: string;
    ino: string;
    parentDev: string;
    parentIno: string;
  }>;

export type BackendPublicationStateWitness = Readonly<{
  config: BackendPublicationFileWitness;
  projectMap: BackendPublicationFileWitness;
}>;

/** Descriptor-bound subset used by non-mutating daemon config admission. */
export type BackendPublicationConfigReadWitness = Readonly<{
  presence: "absent" | "present";
  rawSha256: string | null;
  byteLength: number;
  dev: string | null;
  ino: string | null;
}>;

export type BackendPublicationRecoveryFile =
  | Readonly<{ presence: "absent" }>
  | Readonly<{
    presence: "present";
    content: Uint8Array;
    mode: number;
    uid: number;
    gid: number;
    nlink: string;
    dev: string;
    ino: string;
    parentDev: string;
    parentIno: string;
  }>;

export type BackendPublicationRecoveryMaterial = Readonly<{
  source: Readonly<{
    config: BackendPublicationRecoveryFile;
    projectMap: BackendPublicationRecoveryFile;
  }>;
  target: Readonly<{
    config: BackendPublicationRecoveryFile;
    projectMap: BackendPublicationRecoveryFile;
  }>;
}>;

export type BackendPublicationRecoveryReference = Readonly<{
  relativePath: string;
  sealSha256: string;
  byteLength: number;
}>;

export type BackendPublicationFenceRecord = Readonly<{
  projectId: string;
  machineId: string;
  publicationId: string;
  targetBackend: StorageBackendName;
  evidenceSha256: string;
  fencingToken: string;
  acquiredAt: string;
  renewedAt: string;
  expiresAt: string;
  releasedAt: string | null;
  databaseExpired: boolean;
}>;

export type BackendPublicationProjectRecord = Readonly<{
  localProjectId: string;
  remoteProjectId: string;
  evidenceSha256: string;
  fence: BackendPublicationFenceRecord | null;
}>;

export type BackendPublicationJournal = Readonly<{
  version: typeof BACKEND_PUBLICATION_VERSION;
  publicationId: string;
  sourceBackend: StorageBackendName;
  targetBackend: StorageBackendName;
  phase: BackendPublicationPhase;
  createdAt: string;
  updatedAt: string;
  expectedConfigSha256: string;
  expectedProjectMapSha256: string;
  intendedConfigSha256: string;
  intendedProjectMapSha256: string;
  publishedConfigSha256: string | null;
  publishedProjectMapSha256: string | null;
  recoveryReference: BackendPublicationRecoveryReference | null;
  sourceState: BackendPublicationStateWitness;
  targetState: BackendPublicationStateWitness;
  projects: readonly BackendPublicationProjectRecord[];
  checksumSha256: string;
}>;

export type BackendPublicationObserver = (event: string, path: string) => void;

export type BackendPublicationDriverContext = Readonly<{
  homeDir: string | undefined;
  journal: BackendPublicationJournal;
  recoveryReference: BackendPublicationRecoveryReference;
  material: BackendPublicationRecoveryMaterial;
}>;

export type BackendPublicationFileMutationContext = BackendPublicationDriverContext & Readonly<{
  file: BackendPublicationRecoveryFile;
  expectedWitness: BackendPublicationFileWitness;
  permit: PrivateMutationPermit;
  mutationAccess: BackendPublicationPermitAccess;
}>;

export type BackendPublicationRemoteContext = Readonly<{
  homeDir: string | undefined;
  journal: BackendPublicationJournal;
  project: BackendPublicationProjectRecord;
}>;

export interface BackendPublicationDriver {
  observeLocalState(input: BackendPublicationDriverContext): Promise<BackendPublicationStateWitness>;
  publishProjectMap(input: BackendPublicationFileMutationContext): Promise<BackendPublicationFileWitness>;
  publishConfig(input: BackendPublicationFileMutationContext): Promise<BackendPublicationFileWitness>;
  restoreConfig(input: BackendPublicationFileMutationContext): Promise<BackendPublicationFileWitness>;
  restoreProjectMap(input: BackendPublicationFileMutationContext): Promise<BackendPublicationFileWitness>;
  acquireRemoteGuard?(input: BackendPublicationRemoteContext): Promise<BackendPublicationFenceRecord>;
  readRemoteGuard?(
    input: BackendPublicationRemoteContext,
    operation: "acquire" | "release",
  ): Promise<BackendPublicationFenceRecord | null>;
  releaseRemoteGuard?(input: BackendPublicationRemoteContext & Readonly<{
    fence: BackendPublicationFenceRecord;
  }>): Promise<void>;
  retainCompletedMaterial?(input: BackendPublicationDriverContext): Promise<void>;
  cleanupAbortedMaterial?(input: Readonly<{
    homeDir: string | undefined;
    journal: BackendPublicationJournal;
    recoveryReference: BackendPublicationRecoveryReference;
  }>): Promise<void>;
}

export type PrepareBackendPublicationInput = Readonly<{
  publicationId: string;
  sourceBackend: StorageBackendName;
  targetBackend: StorageBackendName;
  material: BackendPublicationRecoveryMaterial;
  projects: readonly Readonly<{
    localProjectId: string;
    remoteProjectId: string;
    evidenceSha256: string;
  }>[];
  now?: Date;
}>;

export type RecoverPendingOptions = Readonly<{
  disposition?: "resume" | "abort";
}>;

export class BackendPublicationJournalError extends Error {
  constructor(
    readonly reason:
      | "invalid-input"
      | "unsafe-storage"
      | "malformed-journal"
      | "checksum-mismatch"
      | "unexpected-state"
      | "unresolved-publication"
      | "publication-evidence-missing"
      | "permit-mismatch"
      | "backend-mismatch",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "BackendPublicationJournalError";
  }
}

const NOOP_OBSERVER: BackendPublicationObserver = () => undefined;

export type BackendPublicationPermitAccess =
  | "read-recovery"
  | "publish-project-map"
  | "publish-config"
  | "restore-config"
  | "restore-project-map";

type BackendPublicationMutationPermitAccess = Exclude<BackendPublicationPermitAccess, "read-recovery">;

type BackendPublicationPermitInput = Readonly<{
  publicationId: string;
  expectedChecksumSha256: string;
  access: "read-recovery";
  stateSha256?: string;
  homeDir?: string;
}> | Readonly<{
  publicationId: string;
  expectedChecksumSha256: string;
  access: BackendPublicationMutationPermitAccess;
  expectedWitness: BackendPublicationFileWitness;
  stateSha256?: string;
  homeDir?: string;
}>;

type BackendPublicationPermitMetadata = Readonly<{
  homeDir: string | undefined;
  publicationId: string;
  checksumSha256: string;
  phase: BackendPublicationPhase;
  access: BackendPublicationPermitAccess;
  expectedWitness?: BackendPublicationFileWitness;
}>;

type BackendPublicationMutationPermitMetadata = BackendPublicationPermitMetadata & Readonly<{
  expectedWitness: BackendPublicationFileWitness;
}>;

/**
 * Active publication authorities are keyed by the permit object itself.
 * No path or ambient async context is sufficient to authorize a mutation.
 */
const activePublicationPermits = new WeakMap<PrivateMutationPermit, BackendPublicationPermitMetadata>();

/** A non-authorizing handle for one retained publication-lock operation. */
export type BackendPublicationLockToken = object;

const activePublicationLockTokens = new WeakMap<BackendPublicationLockToken, {
  readonly rootPath: string;
  active: boolean;
}>();

function fail(reason: BackendPublicationJournalError["reason"], message: string): never {
  throw new BackendPublicationJournalError(reason, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index]);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  throw new TypeError("value is not canonical JSON");
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function backendPublicationCanonicalSha256(value: unknown): string {
  return sha256(canonicalJson(value));
}

function presentFileWitness(
  content: Uint8Array,
  metadata: Readonly<{
    mode: number;
    uid: number;
    gid: number;
    nlink: string;
    dev: string;
    ino: string;
    parentDev: string;
    parentIno: string;
  }>,
): Extract<BackendPublicationFileWitness, { presence: "present" }> {
  const bytes = Buffer.from(content);
  let semanticSha256 = sha256(bytes);
  try {
    semanticSha256 = backendPublicationCanonicalSha256(JSON.parse(bytes.toString("utf8")));
  } catch {
    // The storage driver decides whether a particular config/map shape is
    // valid. The coordinator still authenticates its exact bytes.
  }
  return {
    presence: "present",
    rawSha256: sha256(bytes),
    semanticSha256,
    byteLength: bytes.byteLength,
    mode: metadata.mode,
    uid: metadata.uid,
    gid: metadata.gid,
    nlink: metadata.nlink,
    dev: metadata.dev,
    ino: metadata.ino,
    parentDev: metadata.parentDev,
    parentIno: metadata.parentIno,
  };
}

const ABSENT_WITNESS: BackendPublicationFileWitness = {
  presence: "absent",
  rawSha256: null,
  semanticSha256: null,
  byteLength: 0,
  mode: null,
  uid: null,
  gid: null,
  nlink: null,
  dev: null,
  ino: null,
  parentDev: null,
  parentIno: null,
};

function recoveryFileWitness(file: BackendPublicationRecoveryFile): BackendPublicationFileWitness {
  return file.presence === "absent"
    ? ABSENT_WITNESS
    : presentFileWitness(file.content, file);
}

export function backendPublicationMaterialWitness(
  material: BackendPublicationRecoveryMaterial,
): BackendPublicationStateWitness {
  return {
    config: recoveryFileWitness(material.source.config),
    projectMap: recoveryFileWitness(material.source.projectMap),
  };
}

export type BackendPublicationFileSnapshot = Readonly<{
  content: string | null;
  witness: BackendPublicationFileWitness;
}>;

/** Capture a descriptor-bound file witness for a later exact state check. */
export function captureBackendPublicationFileWitness(
  path: string,
  allowedRoot: string,
  maxBytes = MAX_RECOVERY_FILE_BYTES,
): BackendPublicationFileSnapshot {
  let observed;
  try {
    observed = readBoundedRegularFileWithStat(path, {
      allowedRoot,
      maxBytes,
      expectedUid: typeof process.getuid === "function" ? process.getuid() : undefined,
      allowedModes: OWNER_ONLY_FILE_MODES,
      requireSingleLink: true,
    });
  } catch (error) {
    if (isMissing(error)) return { content: null, witness: ABSENT_WITNESS };
    throw error;
  }
  const witness = presentFileWitness(Buffer.from(observed.content), {
    mode: observed.mode,
    uid: observed.uid,
    gid: observed.gid,
    nlink: observed.nlink,
    dev: observed.exactDev,
    ino: observed.exactIno,
    parentDev: observed.parentDev,
    parentIno: observed.parentIno,
  });
  return {
    content: observed.content,
    witness,
  };
}

function materialTargetWitness(material: BackendPublicationRecoveryMaterial): BackendPublicationStateWitness {
  return {
    config: recoveryFileWitness(material.target.config),
    projectMap: recoveryFileWitness(material.target.projectMap),
  };
}

function assertWitnessShape(witness: BackendPublicationFileWitness, field: string): void {
  if (witness.presence === "absent") {
    if (!sameValue(witness, ABSENT_WITNESS)) return fail("malformed-journal", `${field} absent witness is malformed`);
    return;
  }
  if (
    !HASH_PATTERN.test(witness.rawSha256)
    || !HASH_PATTERN.test(witness.semanticSha256)
    || !Number.isSafeInteger(witness.byteLength)
    || witness.byteLength <= 0
    || !isOwnerOnlyFileMode(witness.mode)
    || !Number.isSafeInteger(witness.uid)
    || witness.uid < 0
    || !Number.isSafeInteger(witness.gid)
    || witness.gid < 0
    || !/^\d+$/u.test(witness.nlink)
    || !/^\d+$/u.test(witness.dev)
    || !/^\d+$/u.test(witness.ino)
    || !/^\d+$/u.test(witness.parentDev)
    || !/^\d+$/u.test(witness.parentIno)
  ) {
    return fail("malformed-journal", `${field} present witness is malformed`);
  }
}

function assertStateShape(state: BackendPublicationStateWitness, field: string): void {
  if (!isRecord(state)) return fail("malformed-journal", `${field} state is malformed`);
  assertWitnessShape(state.config, `${field}.config`);
  assertWitnessShape(state.projectMap, `${field}.projectMap`);
}

function sameValue(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function assertLogicalWitness(
  actual: BackendPublicationFileWitness,
  expected: BackendPublicationFileWitness,
  field: string,
): void {
  if (!logicalWitnessMatches(actual, expected)) {
    return fail("unexpected-state", `${field} witness does not match`);
  }
}

function logicalWitnessMatches(
  actual: BackendPublicationFileWitness,
  expected: BackendPublicationFileWitness,
): boolean {
  const fields = ["presence", "rawSha256", "semanticSha256", "byteLength", "mode", "uid", "gid", "nlink"] as const;
  if (fields.some((key) => actual[key] !== expected[key])) {
    return false;
  }
  for (const key of ["dev", "ino", "parentDev", "parentIno"] as const) {
    if (actual[key] !== expected[key]) {
      return false;
    }
  }
  return true;
}

function contentWitnessMatches(
  actual: BackendPublicationFileWitness,
  expected: BackendPublicationFileWitness,
): boolean {
  const fields = ["presence", "rawSha256", "semanticSha256", "byteLength", "mode", "uid", "gid", "nlink"] as const;
  return !fields.some((key) => actual[key] !== expected[key]);
}

function mutationWitnessMatches(
  actual: BackendPublicationFileWitness,
  expected: BackendPublicationFileWitness,
): boolean {
  return actual.presence === "present"
    && expected.presence === "present"
    && contentWitnessMatches(actual, expected)
    && !logicalWitnessMatches(actual, expected);
}

function assertContentWitness(
  actual: BackendPublicationFileWitness,
  expected: BackendPublicationFileWitness,
  field: string,
): void {
  if (!contentWitnessMatches(actual, expected)) {
    return fail("unexpected-state", `${field} content witness does not match`);
  }
}

function assertContentState(
  actual: BackendPublicationStateWitness,
  expected: BackendPublicationStateWitness,
  field: string,
): void {
  assertContentWitness(actual.config, expected.config, `${field}.config`);
  assertContentWitness(actual.projectMap, expected.projectMap, `${field}.projectMap`);
}

function validateRecoveryFile(file: BackendPublicationRecoveryFile, field: string): void {
  if (!isRecord(file) || (file.presence !== "absent" && file.presence !== "present")) {
    return fail("invalid-input", `${field} recovery file is invalid`);
  }
  if (file.presence === "absent") return;
  if (
    !(file.content instanceof Uint8Array)
    || file.content.byteLength === 0
    || file.content.byteLength > MAX_RECOVERY_FILE_BYTES
    || !isOwnerOnlyFileMode(file.mode)
    || !Number.isSafeInteger(file.uid)
    || file.uid < 0
    || !Number.isSafeInteger(file.gid)
    || file.gid < 0
    || file.nlink !== "1"
    || !/^\d+$/u.test(file.dev)
    || !/^\d+$/u.test(file.ino)
    || !/^\d+$/u.test(file.parentDev)
    || !/^\d+$/u.test(file.parentIno)
  ) {
    return fail("invalid-input", `${field} recovery file is invalid`);
  }
}

function validateInput(input: PrepareBackendPublicationInput): PrepareBackendPublicationInput & Readonly<{ now: Date }> {
  if (
    !isRecord(input)
    || typeof input.publicationId !== "string"
    || !PUBLICATION_ID_PATTERN.test(input.publicationId)
    || (input.sourceBackend !== "sqlite" && input.sourceBackend !== "postgresql")
    || (input.targetBackend !== "sqlite" && input.targetBackend !== "postgresql")
    || input.sourceBackend === input.targetBackend
    || !isRecord(input.material)
    || !isRecord(input.material.source)
    || !isRecord(input.material.target)
    || !Array.isArray(input.projects)
  ) {
    return fail("invalid-input", "backend publication input is invalid");
  }
  const now = input.now ?? new Date();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    return fail("invalid-input", "backend publication timestamp is invalid");
  }
  validateRecoveryFile(input.material.source.config, "source config");
  validateRecoveryFile(input.material.source.projectMap, "source project map");
  validateRecoveryFile(input.material.target.config, "target config");
  validateRecoveryFile(input.material.target.projectMap, "target project map");
  const localIds = new Set<string>();
  const remoteIds = new Set<string>();
  for (const project of input.projects) {
    if (
      !isRecord(project)
      || typeof project.localProjectId !== "string"
      || project.localProjectId.length === 0
      || project.localProjectId.length > 256
      || typeof project.remoteProjectId !== "string"
      || project.remoteProjectId.length === 0
      || project.remoteProjectId.length > 256
      || typeof project.evidenceSha256 !== "string"
      || !HASH_PATTERN.test(project.evidenceSha256)
      || localIds.has(project.localProjectId)
      || remoteIds.has(project.remoteProjectId)
    ) {
      return fail("invalid-input", "backend publication project coverage is invalid");
    }
    localIds.add(project.localProjectId);
    remoteIds.add(project.remoteProjectId);
  }
  return {
    ...input,
    projects: [...input.projects].sort((left, right) => left.localProjectId.localeCompare(right.localProjectId)),
    now,
  };
}

function rootPath(homeDir?: string): string {
  return resolve(join(homeDir ?? homedir(), ".lcm"));
}

export function backendPublicationDirectory(homeDir?: string): string {
  return join(rootPath(homeDir), "backend-publication");
}

export function backendPublicationJournalPath(homeDir?: string): string {
  return join(backendPublicationDirectory(homeDir), "journal.json");
}

export function backendPublicationHistoryDirectory(homeDir?: string): string {
  return join(backendPublicationDirectory(homeDir), "history");
}

function backendPublicationLockPath(homeDir?: string): string {
  // Keep the admission lock one level above the optional .lcm root so
  // first-boot consumers can acquire the same admission point without
  // creating .lcm or backend-publication.
  return join(resolve(homeDir ?? homedir()), ".lcm.backend-publication.lock");
}

function withUnsafeStorageMapping<T>(callback: () => T): T {
  try {
    return callback();
  } catch (error) {
    if (error instanceof HomeLockTopologyError) {
      return fail("unsafe-storage", error.message.replace(/^HOME/u, "backend publication"));
    }
    throw error;
  }
}

function withBackendPublicationLock<T>(
  homeDir: string | undefined,
  callback: () => T,
): T {
  const topology = withUnsafeStorageMapping(() => openHomeLockTopology(homeDir));
  try {
    return withPrivateMutationLock(
      backendPublicationLockPath(homeDir),
      "backend publication",
      () => {
        withUnsafeStorageMapping(() => assertHomeLockTopology(topology));
        withUnsafeStorageMapping(() => restoreHomeLockTopologyMode(topology));
        const result = callback();
        withUnsafeStorageMapping(() => assertHomeLockTopology(topology));
        return result;
      },
    );
  } finally {
    try {
      withUnsafeStorageMapping(() => restoreHomeLockTopologyMode(topology));
    } finally {
      withUnsafeStorageMapping(() => closeHomeLockTopology(topology));
    }
  }
}

async function withBackendPublicationLockAsync<T>(
  homeDir: string | undefined,
  callback: () => Promise<T>,
): Promise<T> {
  const topology = withUnsafeStorageMapping(() => openHomeLockTopology(homeDir));
  try {
    return await withPrivateMutationLockAsync(
      backendPublicationLockPath(homeDir),
      "backend publication",
      async () => {
        withUnsafeStorageMapping(() => assertHomeLockTopology(topology));
        withUnsafeStorageMapping(() => restoreHomeLockTopologyMode(topology));
        const result = await callback();
        withUnsafeStorageMapping(() => assertHomeLockTopology(topology));
        return result;
      },
    );
  } finally {
    try {
      withUnsafeStorageMapping(() => restoreHomeLockTopologyMode(topology));
    } finally {
      withUnsafeStorageMapping(() => closeHomeLockTopology(topology));
    }
  }
}

function ensurePublicationDirectory(homeDir?: string): void {
  const root = rootPath(homeDir);
  let rootHandle;
  try {
    rootHandle = openPrivateDirectory(root);
  } catch (error) {
    return fail("unsafe-storage", `private LCM root cannot be opened: ${(error as Error).message}`);
  }
  const directory = backendPublicationDirectory(homeDir);
  try {
    let created = false;
    try {
      mkdirSync(directory, { mode: 0o700 });
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (created) {
      chmodSync(directory, 0o700);
      syncPrivateDirectory(root);
    }
    const handle = openPrivateDirectory(directory);
    handle.close();
  } catch (error) {
    return fail("unsafe-storage", `backend publication directory is unsafe: ${(error as Error).message}`);
  } finally {
    rootHandle.close();
  }
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function materialPath(homeDir: string | undefined, publicationId: string): string {
  return join(backendPublicationDirectory(homeDir), `${publicationId}.material`);
}

function journalPayload(journal: Omit<BackendPublicationJournal, "checksumSha256">): Omit<BackendPublicationJournal, "checksumSha256"> {
  return journal;
}

function withChecksum(payload: Omit<BackendPublicationJournal, "checksumSha256">): BackendPublicationJournal {
  const { checksumSha256: _previousChecksum, ...cleanPayload } = payload as Omit<BackendPublicationJournal, "checksumSha256"> & Partial<Pick<BackendPublicationJournal, "checksumSha256">>;
  return {
    ...cleanPayload,
    checksumSha256: backendPublicationCanonicalSha256(journalPayload(cleanPayload)),
  };
}

function journalContent(journal: BackendPublicationJournal): string {
  return `${canonicalJson(journal)}\n`;
}

function parseWitness(value: unknown, field: string): BackendPublicationFileWitness {
  if (!isRecord(value)) return fail("malformed-journal", `${field} witness is malformed`);
  if (value.presence === "absent") {
    if (!exactKeys(value, ["byteLength", "dev", "gid", "ino", "mode", "nlink", "parentDev", "parentIno", "presence", "rawSha256", "semanticSha256", "uid"])) {
      return fail("malformed-journal", `${field} absent witness has unknown fields`);
    }
    const witness = value as unknown as BackendPublicationFileWitness;
    if (!sameValue(witness, ABSENT_WITNESS)) return fail("malformed-journal", `${field} absent witness is malformed`);
    return ABSENT_WITNESS;
  }
  if (value.presence !== "present") return fail("malformed-journal", `${field} witness presence is invalid`);
  if (!exactKeys(value, ["byteLength", "dev", "gid", "ino", "mode", "nlink", "parentDev", "parentIno", "presence", "rawSha256", "semanticSha256", "uid"])) {
    return fail("malformed-journal", `${field} present witness has unknown fields`);
  }
  const witness = value as unknown as BackendPublicationFileWitness;
  assertWitnessShape(witness, field);
  return witness;
}

function parseState(value: unknown, field: string): BackendPublicationStateWitness {
  if (!isRecord(value)) return fail("malformed-journal", `${field} state is malformed`);
  const state = {
    config: parseWitness(value.config, `${field}.config`),
    projectMap: parseWitness(value.projectMap, `${field}.projectMap`),
  };
  assertStateShape(state, field);
  return state;
}

function parseReference(value: unknown): BackendPublicationRecoveryReference | null {
  if (value === null) return null;
  if (
    !isRecord(value)
    || !exactKeys(value, ["byteLength", "relativePath", "sealSha256"])
    || typeof value.relativePath !== "string"
    || !MATERIAL_PATH_PATTERN.test(value.relativePath)
    || !HASH_PATTERN.test(String(value.sealSha256))
    || !Number.isSafeInteger(value.byteLength)
    || Number(value.byteLength) <= 0
    || Number(value.byteLength) > MAX_MATERIAL_BYTES
  ) {
    return fail("malformed-journal", "recovery material reference is malformed");
  }
  return {
    relativePath: value.relativePath,
    sealSha256: value.sealSha256 as string,
    byteLength: value.byteLength as number,
  };
}

function parseFence(value: unknown, field: string): BackendPublicationFenceRecord | null {
  if (value === null) return null;
  if (
    !isRecord(value)
    || !exactKeys(value, ["acquiredAt", "databaseExpired", "evidenceSha256", "expiresAt", "fencingToken", "machineId", "publicationId", "projectId", "releasedAt", "renewedAt", "targetBackend"])
    || typeof value.projectId !== "string"
    || typeof value.machineId !== "string"
    || typeof value.publicationId !== "string"
    || (value.targetBackend !== "sqlite" && value.targetBackend !== "postgresql")
    || !HASH_PATTERN.test(String(value.evidenceSha256))
    || !/^\d+$/u.test(String(value.fencingToken))
    || typeof value.acquiredAt !== "string"
    || typeof value.renewedAt !== "string"
    || typeof value.expiresAt !== "string"
    || !Number.isFinite(Date.parse(value.acquiredAt))
    || !Number.isFinite(Date.parse(value.renewedAt))
    || !Number.isFinite(Date.parse(value.expiresAt))
    || (value.releasedAt !== null && typeof value.releasedAt !== "string")
    || (value.releasedAt !== null && !Number.isFinite(Date.parse(value.releasedAt)))
    || typeof value.databaseExpired !== "boolean"
  ) {
    return fail("malformed-journal", `${field} fence is malformed`);
  }
  return value as unknown as BackendPublicationFenceRecord;
}

function parseProject(value: unknown, field: string): BackendPublicationProjectRecord {
  if (
    !isRecord(value)
    || !exactKeys(value, ["evidenceSha256", "fence", "localProjectId", "remoteProjectId"])
    || typeof value.localProjectId !== "string"
    || typeof value.remoteProjectId !== "string"
    || !HASH_PATTERN.test(String(value.evidenceSha256))
    || !(value.fence === null || isRecord(value.fence))
  ) {
    return fail("malformed-journal", `${field} project is malformed`);
  }
  return {
    localProjectId: value.localProjectId,
    remoteProjectId: value.remoteProjectId,
    evidenceSha256: value.evidenceSha256 as string,
    fence: parseFence(value.fence, `${field}.fence`),
  };
}

function parseJournal(content: string): BackendPublicationJournal {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (error) {
    return fail("malformed-journal", "backend publication journal is not valid JSON");
  }
  if (!isRecord(value)) return fail("malformed-journal", "backend publication journal is not an object");
  if (!exactKeys(value, [
    "checksumSha256", "createdAt", "expectedConfigSha256", "expectedProjectMapSha256",
    "intendedConfigSha256", "intendedProjectMapSha256", "phase", "projects", "publishedConfigSha256",
    "publishedProjectMapSha256", "publicationId", "recoveryReference", "sourceBackend", "sourceState",
    "targetBackend", "targetState", "updatedAt", "version",
  ])) {
    return fail("malformed-journal", "backend publication journal has unknown fields");
  }
  const checksum = value.checksumSha256;
  if (typeof checksum !== "string" || !HASH_PATTERN.test(checksum)) {
    return fail("malformed-journal", "backend publication journal checksum is malformed");
  }
  const payload = { ...value };
  delete payload.checksumSha256;
  if (backendPublicationCanonicalSha256(payload) !== checksum) {
    return fail("checksum-mismatch", "backend publication journal checksum does not match");
  }
  const phaseValues: readonly BackendPublicationPhase[] = [
    "preparing", "prepared", "acquiring", "guarded", "map-publishing", "map-published",
    "config-publishing", "config-published", "releasing", "released", "aborting",
    "config-restoring", "map-restoring", "abort-releasing", "aborted", "completed",
  ];
  if (
    value.version !== BACKEND_PUBLICATION_VERSION
    || typeof value.publicationId !== "string"
    || !PUBLICATION_ID_PATTERN.test(value.publicationId)
    || (value.sourceBackend !== "sqlite" && value.sourceBackend !== "postgresql")
    || (value.targetBackend !== "sqlite" && value.targetBackend !== "postgresql")
    || value.sourceBackend === value.targetBackend
    || !phaseValues.includes(value.phase as BackendPublicationPhase)
    || typeof value.createdAt !== "string"
    || typeof value.updatedAt !== "string"
    || !Number.isFinite(Date.parse(value.createdAt))
    || !Number.isFinite(Date.parse(value.updatedAt))
    || !HASH_PATTERN.test(String(value.expectedConfigSha256))
    || !HASH_PATTERN.test(String(value.expectedProjectMapSha256))
    || !HASH_PATTERN.test(String(value.intendedConfigSha256))
    || !HASH_PATTERN.test(String(value.intendedProjectMapSha256))
    || !(value.publishedConfigSha256 === null || HASH_PATTERN.test(String(value.publishedConfigSha256)))
    || !(value.publishedProjectMapSha256 === null || HASH_PATTERN.test(String(value.publishedProjectMapSha256)))
    || !Array.isArray(value.projects)
  ) {
    return fail("malformed-journal", "backend publication journal fields are malformed");
  }
  const projects = value.projects.map((project, index) => parseProject(project, `projects[${index}]`));
  const sorted = [...projects].sort((left, right) => left.localProjectId.localeCompare(right.localProjectId));
  if (
    !sameValue(projects, sorted)
    || new Set(projects.map(({ localProjectId }) => localProjectId)).size !== projects.length
    || new Set(projects.map(({ remoteProjectId }) => remoteProjectId)).size !== projects.length
    || projects.some(({ localProjectId, remoteProjectId }) => localProjectId.length === 0 || remoteProjectId.length === 0)
  ) {
    return fail("malformed-journal", "backend publication projects are not canonically sorted");
  }
  const journal: BackendPublicationJournal = {
    version: BACKEND_PUBLICATION_VERSION,
    publicationId: value.publicationId,
    sourceBackend: value.sourceBackend,
    targetBackend: value.targetBackend,
    phase: value.phase as BackendPublicationPhase,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    expectedConfigSha256: value.expectedConfigSha256 as string,
    expectedProjectMapSha256: value.expectedProjectMapSha256 as string,
    intendedConfigSha256: value.intendedConfigSha256 as string,
    intendedProjectMapSha256: value.intendedProjectMapSha256 as string,
    publishedConfigSha256: value.publishedConfigSha256 as string | null,
    publishedProjectMapSha256: value.publishedProjectMapSha256 as string | null,
    recoveryReference: parseReference(value.recoveryReference),
    sourceState: parseState(value.sourceState, "source"),
    targetState: parseState(value.targetState, "target"),
    projects,
    checksumSha256: checksum,
  };
  return journal;
}

type BackendPublicationDirectoryHandle = ReturnType<typeof openPrivateDirectory>;

function openBackendPublicationDirectoryForRead(
  homeDir?: string,
): BackendPublicationDirectoryHandle | undefined {
  const directory = backendPublicationDirectory(homeDir);
  try {
    return openPrivateDirectoryIfExists(directory);
  } catch (error) {
    return fail("unsafe-storage", `backend publication directory cannot be opened: ${(error as Error).message}`);
  }
}

function withBackendPublicationDirectoryRead<T>(
  homeDir: string | undefined,
  callback: (handle: BackendPublicationDirectoryHandle | undefined) => T,
): T {
  const handle = openBackendPublicationDirectoryForRead(homeDir);
  try {
    return callback(handle);
  } finally {
    handle?.close();
  }
}

function readJournalFromDirectory(
  homeDir: string | undefined,
  directoryHandle: BackendPublicationDirectoryHandle | undefined,
): BackendPublicationJournal | null {
  if (directoryHandle === undefined) return null;
  const directory = backendPublicationDirectory(homeDir);
  try {
    assertPrivateDirectory(directoryHandle, directory, directoryHandle.witness);
    let journal: BackendPublicationJournal | null;
    try {
      const observed = readBoundedRegularFileWithStat(backendPublicationJournalPath(homeDir), {
        allowedRoot: directory,
        maxBytes: MAX_JOURNAL_BYTES,
        expectedUid: typeof process.getuid === "function" ? process.getuid() : undefined,
        allowedModes: [0o600],
        requireSingleLink: true,
      });
      if (
        observed.parentDev !== directoryHandle.witness.dev
        || observed.parentIno !== directoryHandle.witness.ino
      ) {
        return fail("unsafe-storage", "backend publication journal parent does not match the authenticated directory");
      }
      journal = parseJournal(observed.content);
    } catch (error) {
      if (isMissing(error)) journal = null;
      else if (error instanceof BackendPublicationJournalError) throw error;
      else return fail("unsafe-storage", `backend publication journal cannot be read: ${(error as Error).message}`);
    }
    assertPrivateDirectory(directoryHandle, directory, directoryHandle.witness);
    return journal;
  } catch (error) {
    if (error instanceof BackendPublicationJournalError) throw error;
    return fail(
      "unsafe-storage",
      `backend publication directory changed during journal read: ${(error as Error).message}`,
    );
  }
}

function readJournal(homeDir?: string): BackendPublicationJournal | null {
  return withBackendPublicationDirectoryRead(
    homeDir,
    (handle) => readJournalFromDirectory(homeDir, handle),
  );
}

export function readBackendPublicationJournal(homeDir?: string): BackendPublicationJournal | null {
  return readJournal(homeDir);
}

function assertBackendPublicationEvidenceDirectory(
  homeDir: string | undefined,
  handle: BackendPublicationDirectoryHandle,
): void {
  const directory = backendPublicationDirectory(homeDir);
  try {
    assertPrivateDirectory(handle, directory, handle.witness);
    const entries = readdirSync(directory);
    for (const entry of entries) {
      if (
        entry !== "journal.json"
        && entry !== "history"
        && !MATERIAL_PATH_PATTERN.test(entry)
      ) {
        return fail("unsafe-storage", `backend publication directory contains unknown residue: ${entry}`);
      }
    }
    assertPrivateDirectory(handle, directory, handle.witness);
  } catch (error) {
    if (error instanceof BackendPublicationJournalError) throw error;
    return fail(
      "unsafe-storage",
      `backend publication directory changed during evidence enumeration: ${(error as Error).message}`,
    );
  }
}

function readPublicationJournalForConsumer(homeDir?: string): BackendPublicationJournal | null {
  const inspect = (
    handle: BackendPublicationDirectoryHandle | undefined,
  ): BackendPublicationJournal | null => {
    const journal = readJournalFromDirectory(homeDir, handle);
    if (journal === null && handle !== undefined) {
      assertBackendPublicationEvidenceDirectory(homeDir, handle);
      return fail("publication-evidence-missing", "backend publication evidence is incomplete");
    }
    return journal;
  };
  return withBackendPublicationDirectoryRead(homeDir, (initialHandle) => {
    if (initialHandle !== undefined) return inspect(initialHandle);
    return withBackendPublicationDirectoryRead(homeDir, inspect);
  });
}

function readPublicationJournalForAccess(
  homeDir: string | undefined,
  permit: PrivateMutationPermit | undefined,
): BackendPublicationJournal | null {
  const journal = permit === undefined
    ? readPublicationJournalForConsumer(homeDir)
    : readJournal(homeDir);
  if (journal === null && permit !== undefined) {
    return fail("permit-mismatch", "backend publication permit has no durable journal");
  }
  return journal;
}

function assertTerminalPublicationEvidence(
  journal: BackendPublicationJournal,
  homeDir?: string,
): void {
  if (journal.phase !== "completed" && journal.phase !== "aborted") {
    return fail("unresolved-publication", "backend publication is unresolved; recover it before consuming local state");
  }
  if (journal.recoveryReference === null) {
    return fail("malformed-journal", "terminal backend publication has no recovery reference");
  }
  for (const project of journal.projects) {
    if (project.fence !== null && activeFence(project.fence)) {
      return fail("malformed-journal", "terminal backend publication retains an active remote fence");
    }
  }
  try {
    authenticateMaterial(homeDir, journal);
  } catch (error) {
    // Aborted publications remove their recovery material after the journal
    // reaches its terminal state. The journal checksum and state witnesses
    // are the retained authenticated evidence in that case.
    if (
      journal.phase !== "aborted"
      || !isMissing(error)
    ) throw error;
  }
  if (
    journal.phase === "completed"
    && (
      journal.publishedConfigSha256 !== journal.intendedConfigSha256
      || journal.publishedProjectMapSha256 !== journal.intendedProjectMapSha256
    )
  ) {
    return fail("malformed-journal", "completed backend publication lacks intended-state witnesses");
  }
}

function readConsumerPublicationJournal(
  homeDir?: string,
): BackendPublicationJournal | null {
  const journal = readPublicationJournalForConsumer(homeDir);
  if (journal === null) return null;
  assertTerminalPublicationEvidence(journal, homeDir);
  return journal;
}

function permitMetadata(
  permit: PrivateMutationPermit | undefined,
  homeDir: string | undefined,
  journal?: BackendPublicationJournal,
): BackendPublicationPermitMetadata {
  if (permit === undefined) return fail("permit-mismatch", "backend publication permit is required");
  try {
    permit.assertActive();
  } catch (error) {
    return fail("permit-mismatch", (error as Error).message);
  }
  const metadata = activePublicationPermits.get(permit);
  if (
    metadata === undefined
    || resolve(join(metadata.homeDir ?? homedir(), ".lcm")) !== rootPath(homeDir)
    || (journal !== undefined && (
      metadata.publicationId !== journal.publicationId
      || metadata.checksumSha256 !== journal.checksumSha256
      || metadata.phase !== journal.phase
    ))
  ) {
    return fail("permit-mismatch", "backend publication permit does not match durable state");
  }
  return metadata;
}

export function assertBackendPublicationPermit(
  permit: PrivateMutationPermit,
  homeDir?: string,
  journal?: BackendPublicationJournal,
): void {
  permitMetadata(permit, homeDir, journal);
}

function assertBackendPublicationConsumerAccessUnlocked(options: {
  readonly backend?: StorageBackendName;
  readonly homeDir?: string;
  readonly permit?: PrivateMutationPermit;
  readonly lockToken?: BackendPublicationLockToken;
} = {}): void {
  const journal = readPublicationJournalForAccess(options.homeDir, options.permit);
  if (journal === null) {
    if (options.backend === "postgresql") {
      return fail("publication-evidence-missing", "PostgreSQL selection has no completed backend publication evidence");
    }
    return;
  }
  if (options.permit !== undefined) {
    permitMetadata(options.permit, options.homeDir, journal);
    return;
  }
  assertTerminalPublicationEvidence(journal, options.homeDir);
  const expected = journal.phase === "completed" ? journal.targetBackend : journal.sourceBackend;
  if (options.backend !== undefined && options.backend !== expected) {
    return fail("backend-mismatch", "stored backend does not match the completed publication journal");
  }
}

type ConsumerLockOptions = Readonly<{
  readonly permit?: PrivateMutationPermit;
  readonly allowUnresolved?: boolean;
  readonly lockToken?: BackendPublicationLockToken;
}>;

function assertLockToken(
  token: BackendPublicationLockToken,
  homeDir: string | undefined,
): void {
  const state = activePublicationLockTokens.get(token);
  if (state === undefined || !state.active || state.rootPath !== rootPath(homeDir)) {
    return fail("permit-mismatch", "backend publication lock token is not active");
  }
}

function newLockToken(homeDir: string | undefined): BackendPublicationLockToken {
  const token = {};
  activePublicationLockTokens.set(token, { rootPath: rootPath(homeDir), active: true });
  return token;
}

function revokeLockToken(token: BackendPublicationLockToken): void {
  activePublicationLockTokens.get(token)!.active = false;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof value === "object"
    && value !== null
    && "then" in value
    && typeof (value as { then?: unknown }).then === "function";
}

function requireSynchronousResult<T>(
  value: T,
  token?: BackendPublicationLockToken,
  permit?: PrivateMutationPermit,
): T {
  if (!isThenable(value)) return value;
  if (token !== undefined) revokeLockToken(token);
  permit?.revoke();
  return fail("unsafe-storage", "synchronous backend publication consumer callback returned a promise");
}

function checkRetainedConsumerDirectories(
  homeDir: string | undefined,
  rootHandle: ReturnType<typeof openPrivateDirectory>,
  publicationHandle: ReturnType<typeof openPrivateDirectory> | undefined,
): void {
  // nlink changes as ordinary consumers create/remove LCM children. The
  // retained descriptor and no-follow pathname check still bind dev/ino;
  // requiring the original nlink would reject legitimate map/config work.
  assertPrivateDirectory(rootHandle, rootPath(homeDir));
  if (publicationHandle !== undefined) {
    assertPrivateDirectory(
      publicationHandle,
      backendPublicationDirectory(homeDir),
    );
  }
}

function openOptionalPublicationDirectory(homeDir?: string): ReturnType<typeof openPrivateDirectory> | undefined {
  try {
    return openPrivateDirectory(backendPublicationDirectory(homeDir));
  } catch (error) {
    if (isMissing(error)) return undefined;
    return fail("unsafe-storage", `backend publication directory cannot be opened: ${(error as Error).message}`);
  }
}

function openOptionalRootDirectory(homeDir?: string): ReturnType<typeof openPrivateDirectory> | undefined {
  try {
    return openPrivateDirectory(rootPath(homeDir));
  } catch (error) {
    if (isMissing(error)) return undefined;
    // Older ordinary SQLite installations may have a non-private .lcm root.
    // Do not repair it during a read-only publication preflight. If the
    // publication directory exists, however, its authenticated root is part
    // of the evidence and the unsafe mode must fail closed.
    if ((error as Error).message.includes("private directory mode is not trusted")) {
      try {
        const publication = openPrivateDirectory(backendPublicationDirectory(homeDir));
        publication.close();
        return fail("unsafe-storage", "backend publication root is not private");
      } catch (publicationError) {
        if (isMissing(publicationError)) return undefined;
        return fail(
          "unsafe-storage",
          "backend publication directory cannot be opened: " + (publicationError as Error).message,
        );
      }
    }
    return fail("unsafe-storage", `private LCM root cannot be opened: ${(error as Error).message}`);
  }
}

/** Open the canonical LCM root using the consumer path's legacy-read compatibility rule. */
export function openBackendPublicationReadRoot(
  homeDir?: string,
): ReturnType<typeof openPrivateDirectory> | undefined {
  return openOptionalRootDirectory(homeDir);
}

/**
 * Retain the canonical LCM root across one lock-free publication read.
 * Legacy installations without an admissible root receive a refreshable
 * no-op assertion until a private root or publication evidence appears.
 */
export function withBackendPublicationReadRoot<T>(
  homeDir: string | undefined,
  callback: (assertReadRoot: () => void) => T,
): T {
  const root = rootPath(homeDir);
  let rootHandle: ReturnType<typeof openPrivateDirectory> | undefined;
  const assertReadRoot = (): void => {
    try {
      if (rootHandle === undefined) {
        rootHandle = openBackendPublicationReadRoot(homeDir);
        return;
      }
      assertPrivateDirectory(rootHandle, root);
      // Reopen with O_NOFOLLOW so a symlink to the retained inode is not
      // accepted merely because path-based realpath identity still matches.
      const currentRoot = openPrivateDirectory(root);
      try {
        assertPrivateDirectory(rootHandle, root);
        assertPrivateDirectory(currentRoot, root);
      } finally {
        currentRoot.close();
      }
    } catch (error) {
      if (error instanceof BackendPublicationJournalError) throw error;
      return fail(
        "unsafe-storage",
        `private LCM root changed during validation: ${(error as Error).message}`,
      );
    }
  };
  try {
    return callback(assertReadRoot);
  } finally {
    rootHandle?.close();
  }
}

function consumerLockCallback<T>(
  homeDir: string | undefined,
  callback: (token: BackendPublicationLockToken) => T,
  options: ConsumerLockOptions,
): T {
  if (options.permit !== undefined) {
    assertBackendPublicationPermit(options.permit, homeDir);
    return requireSynchronousResult(callback({}), undefined, options.permit);
  }
  let rootHandle = openOptionalRootDirectory(homeDir);
  let publicationHandle = rootHandle === undefined
    ? undefined
    : openOptionalPublicationDirectory(homeDir);
  const refreshDirectories = (): void => {
    rootHandle ??= openOptionalRootDirectory(homeDir);
    if (rootHandle !== undefined && publicationHandle === undefined) {
      publicationHandle = openOptionalPublicationDirectory(homeDir);
    }
  };
  const run = (): T => {
    refreshDirectories();
    const token = newLockToken(homeDir);
    if (rootHandle !== undefined) checkRetainedConsumerDirectories(homeDir, rootHandle, publicationHandle);
    if (!options.allowUnresolved) assertBackendPublicationConsumerAccessUnlocked({ homeDir });
    try {
      const result = requireSynchronousResult(callback(token), token, options.permit);
      refreshDirectories();
      if (rootHandle !== undefined) checkRetainedConsumerDirectories(homeDir, rootHandle, publicationHandle);
      if (!options.allowUnresolved) assertBackendPublicationConsumerAccessUnlocked({ homeDir });
      return result;
    } finally {
      revokeLockToken(token);
    }
  };
  try {
    return withBackendPublicationLock(homeDir, run);
  } finally {
    publicationHandle?.close();
    rootHandle?.close();
  }
}

/** Serialize a synchronous local consumer without creating publication roots. */
export function withBackendPublicationConsumerLock<T>(
  homeDir: string | undefined,
  callback: (token: BackendPublicationLockToken) => T,
  options: ConsumerLockOptions = {},
): T {
  if (options.lockToken !== undefined) assertLockToken(options.lockToken, homeDir);
  if (options.lockToken !== undefined && options.permit === undefined) {
    return requireSynchronousResult(callback(options.lockToken));
  }
  return consumerLockCallback(homeDir, callback, options);
}

/** Async counterpart used by watcher and sensitive-file boundaries. */
export async function withBackendPublicationConsumerLockAsync<T>(
  homeDir: string | undefined,
  callback: (token: BackendPublicationLockToken) => Promise<T> | T,
  options: ConsumerLockOptions = {},
): Promise<T> {
  if (options.lockToken !== undefined) assertLockToken(options.lockToken, homeDir);
  if (options.lockToken !== undefined && options.permit === undefined) {
    return callback(options.lockToken);
  }
  if (options.permit !== undefined) {
    assertBackendPublicationPermit(options.permit, homeDir);
    return callback({});
  }
  let rootHandle = openOptionalRootDirectory(homeDir);
  let publicationHandle = rootHandle === undefined
    ? undefined
    : openOptionalPublicationDirectory(homeDir);
  const refreshDirectories = (): void => {
    rootHandle ??= openOptionalRootDirectory(homeDir);
    if (rootHandle !== undefined && publicationHandle === undefined) {
      publicationHandle = openOptionalPublicationDirectory(homeDir);
    }
  };
  const run = async (): Promise<T> => {
    refreshDirectories();
    const token = newLockToken(homeDir);
    if (rootHandle !== undefined) checkRetainedConsumerDirectories(homeDir, rootHandle, publicationHandle);
    if (!options.allowUnresolved) assertBackendPublicationConsumerAccessUnlocked({ homeDir });
    try {
      const result = await callback(token);
      refreshDirectories();
      if (rootHandle !== undefined) checkRetainedConsumerDirectories(homeDir, rootHandle, publicationHandle);
      if (!options.allowUnresolved) assertBackendPublicationConsumerAccessUnlocked({ homeDir });
      return result;
    } finally {
      revokeLockToken(token);
    }
  };
  try {
    return await withBackendPublicationLockAsync(homeDir, run);
  } finally {
    publicationHandle?.close();
    rootHandle?.close();
  }
}

export function assertBackendPublicationConsumerAccess(options: {
  readonly backend?: StorageBackendName;
  readonly homeDir?: string;
  readonly permit?: PrivateMutationPermit;
  readonly lockToken?: BackendPublicationLockToken;
} = {}): void {
  if (options.permit !== undefined) {
    assertBackendPublicationPermit(options.permit, options.homeDir);
    return assertBackendPublicationConsumerAccessUnlocked(options);
  }
  if (options.lockToken !== undefined) {
    assertLockToken(options.lockToken, options.homeDir);
    return assertBackendPublicationConsumerAccessUnlocked(options);
  }
  return withBackendPublicationConsumerLock(
    options.homeDir,
    (token) => assertBackendPublicationConsumerAccessUnlocked({ ...options, lockToken: token }),
  );
}

/** Serialize the canonical config file after publication admission. */
export function withBackendPublicationConfigLock<T>(
  configPath: string,
  callback: (token: BackendPublicationLockToken) => T,
  permit?: PrivateMutationPermit,
): T {
  const homeDir = backendPublicationHomeForConfigPath(configPath);
  if (homeDir === undefined) return requireSynchronousResult(callback({}), undefined, permit);
  return withBackendPublicationConsumerLock(homeDir, (token) =>
    withPrivateMutationLock(`${resolve(configPath)}.lock`, "config file", () =>
      requireSynchronousResult(callback(token), token, permit)),
  { permit });
}

/** Async config lock variant for coordinator callbacks. */
export async function withBackendPublicationConfigLockAsync<T>(
  configPath: string,
  callback: (token: BackendPublicationLockToken) => Promise<T> | T,
  permit?: PrivateMutationPermit,
): Promise<T> {
  const homeDir = backendPublicationHomeForConfigPath(configPath);
  if (homeDir === undefined) return callback({});
  return withBackendPublicationConsumerLockAsync(homeDir, (token) =>
    withPrivateMutationLockAsync(`${resolve(configPath)}.lock`, "config file", async () => callback(token)),
  { permit });
}

/** Derive the home directory only for the canonical ~/.lcm/config.json shape. */
export function backendPublicationHomeForConfigPath(configPath: string): string | undefined {
  const canonical = resolve(configPath);
  const lcmRoot = resolve(join(canonical, ".."));
  return basename(canonical) === "config.json" && basename(lcmRoot) === ".lcm"
    ? resolve(join(lcmRoot, ".."))
    : undefined;
}

/** Capture descriptor-bound config and project-map witnesses from the LCM root. */
export function captureBackendPublicationState(homeDir?: string): BackendPublicationStateWitness {
  const root = rootPath(homeDir);
  const rootHandle = openPrivateDirectory(root);
  try {
    assertPrivateDirectory(rootHandle, root, rootHandle.witness);
    return {
      config: captureBackendPublicationFileWitness(
        join(root, "config.json"),
        root,
        MAX_RECOVERY_FILE_BYTES,
      ).witness,
      projectMap: captureBackendPublicationFileWitness(
        join(root, "map.json"),
        root,
        MAX_RECOVERY_FILE_BYTES,
      ).witness,
    };
  } finally {
    rootHandle.close();
  }
}

function readStateContent(path: string, root: string): string | null {
  try {
    return readBoundedRegularFileWithStat(path, {
      allowedRoot: root,
      maxBytes: MAX_RECOVERY_FILE_BYTES,
      expectedUid: typeof process.getuid === "function" ? process.getuid() : undefined,
      allowedModes: OWNER_ONLY_FILE_MODES,
      requireSingleLink: true,
    }).content;
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

export function backendPublicationConfigSha256(homeDir?: string): string {
  const root = rootPath(homeDir);
  const content = readStateContent(join(root, "config.json"), root);
  return sha256(content ?? "{}");
}

export function backendPublicationProjectMapSha256(homeDir?: string): string {
  const root = rootPath(homeDir);
  const content = readStateContent(join(root, "map.json"), root) ?? "{}";
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    return fail("unexpected-state", "project map cannot be bound to backend publication evidence");
  }
  return backendPublicationCanonicalSha256(parsed);
}

function assertRawContentWitness(
  actual: BackendPublicationFileWitness,
  content: string | null,
  field: string,
): void {
  if (content === null) {
    assertLogicalWitness(actual, ABSENT_WITNESS, field);
    return;
  }
  if (
    actual.presence !== "present"
    || actual.rawSha256 !== sha256(content)
    || actual.byteLength !== Buffer.byteLength(content)
  ) {
    return fail("unexpected-state", `${field} bytes do not match the descriptor-bound witness`);
  }
}

function currentConfigWitness(homeDir: string | undefined, content: string | null): BackendPublicationFileWitness {
  const current = captureBackendPublicationState(homeDir).config;
  assertRawContentWitness(current, content, "current config");
  return current;
}

function assertConfigReadWitness(
  configPath: string,
  expected: BackendPublicationConfigReadWitness,
): void {
  const actual = captureBackendPublicationFileWitness(
    configPath,
    dirname(configPath),
    MAX_RECOVERY_FILE_BYTES,
  ).witness;
  if (
    actual.presence !== expected.presence
    || actual.rawSha256 !== expected.rawSha256
    || actual.byteLength !== expected.byteLength
    || actual.dev !== expected.dev
    || actual.ino !== expected.ino
  ) {
    return fail("unexpected-state", "current config witness does not match the read admission snapshot");
  }
}

function currentProjectMapWitness(homeDir: string | undefined, content: string): BackendPublicationFileWitness {
  const current = captureBackendPublicationState(homeDir).projectMap;
  assertRawContentWitness(current, content, "current project map");
  return current;
}

function mutationPermitFor(
  permit: PrivateMutationPermit | undefined,
  homeDir: string | undefined,
  journal: BackendPublicationJournal,
  access: BackendPublicationMutationPermitAccess,
): BackendPublicationMutationPermitMetadata {
  const metadata = permitMetadata(permit, homeDir, journal);
  if (metadata.access !== access) {
    return fail("permit-mismatch", `backend publication permit is not valid for ${access}`);
  }
  return metadata as BackendPublicationMutationPermitMetadata;
}

function expectedWitnessForMutationAccess(
  journal: BackendPublicationJournal,
  access: BackendPublicationMutationPermitAccess,
): BackendPublicationFileWitness {
  const witnesses: Readonly<Record<BackendPublicationMutationPermitAccess, BackendPublicationFileWitness>> = {
    "publish-project-map": journal.targetState.projectMap,
    "publish-config": journal.targetState.config,
    "restore-config": journal.sourceState.config,
    "restore-project-map": journal.sourceState.projectMap,
  };
  return witnesses[access];
}

function assertCandidateWitness(
  candidate: string | null,
  expected: BackendPublicationFileWitness,
  field: string,
  semantic = false,
): void {
  if (candidate === null) {
    assertLogicalWitness(ABSENT_WITNESS, expected, field);
    return;
  }
  let semanticSha256: string | undefined;
  if (semantic) {
    try {
      semanticSha256 = backendPublicationCanonicalSha256(JSON.parse(candidate));
    } catch {
      return fail("unexpected-state", `${field} semantic JSON is invalid`);
    }
  }
  if (
    expected.presence !== "present"
    || expected.rawSha256 !== sha256(candidate)
    || expected.byteLength !== Buffer.byteLength(candidate)
    || (semantic && expected.semanticSha256 !== semanticSha256)
  ) {
    return fail("unexpected-state", `${field} bytes do not match authenticated publication material`);
  }
}

function assertBackendPublicationConfigAccessUnlocked(
  configPath: string,
  homeDir: string,
  backend: StorageBackendName,
  content: string | null | undefined,
  permit?: PrivateMutationPermit,
): void {
  const journal = permit === undefined
    ? readConsumerPublicationJournal(homeDir)
    : readPublicationJournalForAccess(homeDir, permit);
  if (journal === null) {
    if (backend === "postgresql") {
      return fail("publication-evidence-missing", "PostgreSQL selection has no completed backend publication evidence");
    }
    return;
  }
  if (permit !== undefined) {
    permitMetadata(permit, homeDir, journal);
  } else if (
    backend !== (journal.phase === "completed" ? journal.targetBackend : journal.sourceBackend)
  ) {
    return fail("backend-mismatch", "stored backend does not match completed publication evidence");
  }
  if (content !== undefined) currentConfigWitness(homeDir, content);
}

export function assertBackendPublicationConfigAccess(
  configPath: string,
  backend: StorageBackendName,
  content?: string | null,
  permit?: PrivateMutationPermit,
  lockToken?: BackendPublicationLockToken,
): void {
  const homeDir = backendPublicationHomeForConfigPath(configPath);
  if (homeDir === undefined) return;
  if (permit !== undefined) {
    return assertBackendPublicationConfigAccessUnlocked(configPath, homeDir, backend, content, permit);
  }
  if (lockToken !== undefined) {
    assertLockToken(lockToken, homeDir);
    return assertBackendPublicationConfigAccessUnlocked(configPath, homeDir, backend, content, permit);
  }
  return withBackendPublicationConsumerLock(
    homeDir,
    (token) => assertBackendPublicationConfigAccessUnlocked(configPath, homeDir, backend, content, permit),
  );
}

/**
 * Validate a daemon config snapshot against publication state without taking
 * the exclusive consumer lock. Callers must perform their own bounded
 * double-read race check around this admission.
 */
export function assertBackendPublicationConfigReadAccess(
  configPath: string,
  backend: StorageBackendName,
  witness: BackendPublicationConfigReadWitness,
): Readonly<{ journalChecksumSha256: string | null }> {
  const homeDir = backendPublicationHomeForConfigPath(configPath);
  if (homeDir === undefined) return Object.freeze({ journalChecksumSha256: null });
  const journal = readConsumerPublicationJournal(homeDir);
  if (journal === null) {
    if (backend === "postgresql") {
      return fail("publication-evidence-missing", "PostgreSQL selection has no completed backend publication evidence");
    }
    return Object.freeze({ journalChecksumSha256: null });
  }
  const expectedBackend = journal.phase === "completed" ? journal.targetBackend : journal.sourceBackend;
  if (backend !== expectedBackend) {
    return fail("backend-mismatch", "stored backend does not match completed publication evidence");
  }
  assertConfigReadWitness(configPath, witness);
  return Object.freeze({ journalChecksumSha256: journal.checksumSha256 });
}

function assertBackendPublicationConfigMutationUnlocked(
  configPath: string,
  homeDir: string,
  currentBackend: StorageBackendName,
  candidateBackend: StorageBackendName,
  candidateContent: string | null,
  currentContent: string | null | undefined,
  permit?: PrivateMutationPermit,
): void {
  const journal = readPublicationJournalForAccess(homeDir, permit);
  if (currentContent !== undefined) currentConfigWitness(homeDir, currentContent);
  if (journal === null) {
    if (currentBackend !== candidateBackend && candidateBackend === "postgresql") {
      return fail("publication-evidence-missing", "PostgreSQL backend selection requires publication control");
    }
    return;
  }
  if (journal.phase === "completed" || journal.phase === "aborted") {
    const expected = journal.phase === "completed" ? journal.targetBackend : journal.sourceBackend;
    if (candidateBackend !== expected) return fail("backend-mismatch", "configuration mutation conflicts with publication evidence");
    return;
  }
  const access = ["map-published", "config-publishing"].includes(journal.phase)
    ? "publish-config"
    : ["aborting", "config-restoring"].includes(journal.phase)
      ? "restore-config"
      : ["map-restoring", "abort-releasing"].includes(journal.phase)
        ? "restore-project-map"
        : null;
  if (access !== "publish-config" && access !== "restore-config") {
    return fail("permit-mismatch", "configuration mutation is not valid in the durable publication phase");
  }
  const metadata = mutationPermitFor(permit, homeDir, journal, access);
  const expectedBackend = access === "publish-config" ? journal.targetBackend : journal.sourceBackend;
  if (candidateBackend !== expectedBackend) {
    return fail("backend-mismatch", "configuration candidate backend conflicts with publication evidence");
  }
  assertCandidateWitness(candidateContent, metadata.expectedWitness, "candidate config");
}

export function assertBackendPublicationConfigMutation(
  configPath: string,
  currentBackend: StorageBackendName,
  candidateBackend: StorageBackendName,
  candidateContent: string | null,
  currentContent?: string | null,
  permit?: PrivateMutationPermit,
  lockToken?: BackendPublicationLockToken,
): void {
  const homeDir = backendPublicationHomeForConfigPath(configPath);
  if (homeDir === undefined) return;
  if (permit !== undefined) {
    return assertBackendPublicationConfigMutationUnlocked(
      configPath,
      homeDir,
      currentBackend,
      candidateBackend,
      candidateContent,
      currentContent,
      permit,
    );
  }
  if (lockToken !== undefined) {
    assertLockToken(lockToken, homeDir);
    return assertBackendPublicationConfigMutationUnlocked(
      configPath,
      homeDir,
      currentBackend,
      candidateBackend,
      candidateContent,
      currentContent,
      permit,
    );
  }
  return withBackendPublicationConsumerLock(
    homeDir,
    (token) => assertBackendPublicationConfigMutationUnlocked(
      configPath,
      homeDir,
      currentBackend,
      candidateBackend,
      candidateContent,
      currentContent,
      permit,
    ),
  );
}

function assertBackendPublicationProjectMapMutationUnlocked(
  map: unknown,
  homeDir: string | undefined,
  candidateContent: string | null | undefined,
  permit?: PrivateMutationPermit,
): void {
  const journal = readPublicationJournalForAccess(homeDir, permit);
  if (journal === null) return;
  if (journal.phase === "completed" || journal.phase === "aborted") return;
  const access = ["guarded", "map-publishing"].includes(journal.phase)
    ? "publish-project-map"
    : journal.phase === "map-restoring"
      ? "restore-project-map"
      : null;
  if (access === null) return fail("permit-mismatch", "project-map mutation is not valid in the durable publication phase");
  const metadata = mutationPermitFor(permit, homeDir, journal, access);
  if (candidateContent !== undefined) {
    assertCandidateWitness(candidateContent, metadata.expectedWitness, "candidate project map", true);
  } else if (
    metadata.expectedWitness?.presence === "present"
    && metadata.expectedWitness.semanticSha256 !== backendPublicationCanonicalSha256(map)
  ) {
    return fail("unexpected-state", "project-map semantics do not match authenticated publication material");
  }
}

export function assertBackendPublicationProjectMapMutation(
  map: unknown,
  homeDir?: string,
  candidateContent?: string | null,
  permit?: PrivateMutationPermit,
  lockToken?: BackendPublicationLockToken,
): void {
  if (permit !== undefined) {
    return assertBackendPublicationProjectMapMutationUnlocked(map, homeDir, candidateContent, permit);
  }
  if (lockToken !== undefined) {
    assertLockToken(lockToken, homeDir);
    return assertBackendPublicationProjectMapMutationUnlocked(map, homeDir, candidateContent, permit);
  }
  return withBackendPublicationConsumerLock(
    homeDir,
    () => assertBackendPublicationProjectMapMutationUnlocked(map, homeDir, candidateContent, permit),
  );
}

function assertBackendPublicationProjectMapAccessUnlocked(input: {
  readonly homeDir?: string;
  readonly content: string | null;
  readonly map: unknown;
  readonly present: boolean;
  readonly permit?: PrivateMutationPermit;
}): void {
  if (input.present !== (input.content !== null)) {
    return fail("unexpected-state", "project-map presence and content disagree");
  }
  const journal = input.permit === undefined
    ? readConsumerPublicationJournal(input.homeDir)
    : readPublicationJournalForAccess(input.homeDir, input.permit);
  if (journal === null) return;
  if (input.content === null) {
    assertLogicalWitness(captureBackendPublicationState(input.homeDir).projectMap, ABSENT_WITNESS, "current project map");
  } else {
    const current = currentProjectMapWitness(input.homeDir, input.content);
    if (current.semanticSha256 !== backendPublicationCanonicalSha256(input.map)) {
      return fail("unexpected-state", "project-map bytes and parsed semantics disagree");
    }
  }
}

export function assertBackendPublicationProjectMapAccess(input: {
  readonly homeDir?: string;
  readonly content: string | null;
  readonly map: unknown;
  readonly present: boolean;
  readonly permit?: PrivateMutationPermit;
  readonly lockToken?: BackendPublicationLockToken;
}): void {
  if (input.permit !== undefined) {
    assertBackendPublicationPermit(input.permit, input.homeDir);
    return assertBackendPublicationProjectMapAccessUnlocked(input);
  }
  if (input.lockToken !== undefined) {
    assertLockToken(input.lockToken, input.homeDir);
    return assertBackendPublicationProjectMapAccessUnlocked(input);
  }
  return withBackendPublicationConsumerLock(
    input.homeDir,
    () => assertBackendPublicationProjectMapAccessUnlocked(input),
  );
}

/** Issue an explicit permit for a guarded coordinator callback. */
export async function withBackendPublicationPermit<T>(
  input: BackendPublicationPermitInput,
  callback: (permit: PrivateMutationPermit) => T | Promise<T>,
): Promise<T> {
  return withBackendPublicationConsumerLockAsync(
    input.homeDir,
    async () => {
      const journal = readJournal(input.homeDir);
      if (
        journal === null
        || journal.publicationId !== input.publicationId
        || journal.checksumSha256 !== input.expectedChecksumSha256
        || journal.phase === "completed"
        || journal.phase === "aborted"
      ) {
        return fail("permit-mismatch", "backend publication recovery permit does not match durable state");
      }
      const allowed: Readonly<Record<BackendPublicationPermitAccess, readonly BackendPublicationPhase[]>> = {
        "read-recovery": ["preparing", "prepared", "acquiring", "guarded", "map-publishing", "map-published", "config-publishing", "config-published", "aborting", "config-restoring", "map-restoring", "abort-releasing", "releasing", "released"],
        "publish-project-map": ["guarded"],
        "publish-config": ["map-published"],
        "restore-config": ["aborting", "config-restoring"],
        "restore-project-map": ["map-restoring", "abort-releasing"],
      };
      if (!allowed[input.access].includes(journal.phase)) {
        return fail("permit-mismatch", "backend publication recovery permit phase is invalid");
      }
      const expectedWitness = input.access === "read-recovery"
        ? undefined
        : input.expectedWitness;
      if (input.access !== "read-recovery") {
        if (expectedWitness === undefined) {
          return fail("permit-mismatch", "backend publication mutation permit requires an exact expected witness");
        }
        if (!sameValue(expectedWitness, expectedWitnessForMutationAccess(journal, input.access))) {
          return fail("permit-mismatch", "backend publication mutation permit witness does not match durable state");
        }
      }
      if (input.stateSha256 !== undefined && !HASH_PATTERN.test(input.stateSha256)) {
        return fail("permit-mismatch", "backend publication recovery permit state witness is invalid");
      }
      return withRevocablePrivateMutationPermit(`backend publication ${input.access}`, async (permit) => {
        activePublicationPermits.set(permit, {
          homeDir: input.homeDir,
          publicationId: journal.publicationId,
          checksumSha256: journal.checksumSha256,
          phase: journal.phase,
          access: input.access,
          expectedWitness,
        });
        try {
          return await callback(permit);
        } finally {
          activePublicationPermits.delete(permit);
        }
      });
    },
    { allowUnresolved: true },
  );
}

function writeJournal(
  journal: BackendPublicationJournal,
  homeDir: string | undefined,
  observer: BackendPublicationObserver,
  expectedChecksum?: string,
): void {
  ensurePublicationDirectory(homeDir);
  const path = backendPublicationJournalPath(homeDir);
  observer("before-journal-read", path);
  const current = (() => {
    try {
      const raw = readBoundedRegularFileWithStat(path, {
        allowedRoot: backendPublicationDirectory(homeDir),
        maxBytes: MAX_JOURNAL_BYTES,
        expectedUid: typeof process.getuid === "function" ? process.getuid() : undefined,
        allowedModes: [0o600],
        requireSingleLink: true,
      }).content;
      return { raw, journal: parseJournal(raw) };
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  })();
  if (expectedChecksum !== undefined && (current === null || current.journal.checksumSha256 !== expectedChecksum)) {
    return fail("unexpected-state", "backend publication journal changed before update");
  }
  if (expectedChecksum === undefined && current !== null) {
    return fail("unresolved-publication", "backend publication journal already exists");
  }
  observer("before-journal-write", path);
  // The checksum check is journal-protocol admission under its lock; the
  // generic durable helper performs unconditional publication when present.
  atomicWritePrivateFileDurable(path, journalContent(journal), {
    requireAbsent: expectedChecksum === undefined,
    maxExistingBytes: MAX_JOURNAL_BYTES,
  });
  observer("after-journal-write", path);
}

function archiveTerminalJournal(
  homeDir: string | undefined,
  journal: BackendPublicationJournal,
): void {
  const directory = backendPublicationDirectory(homeDir);
  const history = backendPublicationHistoryDirectory(homeDir);
  const current = readBoundedRegularFileWithStat(backendPublicationJournalPath(homeDir), {
    allowedRoot: directory,
    maxBytes: MAX_JOURNAL_BYTES,
    expectedUid: typeof process.getuid === "function" ? process.getuid() : undefined,
    allowedModes: [0o600],
    requireSingleLink: true,
  }).content;
  let historyHandle;
  try {
    historyHandle = openPrivateDirectory(history);
  } catch (error) {
    if (!isMissing(error)) throw error;
    mkdirSync(history, { mode: 0o700 });
    historyHandle = openPrivateDirectory(history);
  }
  historyHandle.close();
  const archivePath = join(history, journal.publicationId + "." + journal.checksumSha256 + ".json");
  try {
    atomicWritePrivateFileDurable(archivePath, current, {
      requireAbsent: true,
      maxExistingBytes: MAX_JOURNAL_BYTES,
    });
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "private file already exists") throw error;
    readBoundedRegularFileWithStat(archivePath, {
      allowedRoot: history,
      maxBytes: MAX_JOURNAL_BYTES,
      expectedUid: typeof process.getuid === "function" ? process.getuid() : undefined,
      allowedModes: [0o600],
      requireSingleLink: true,
      expectedRawSha256: sha256(current),
    });
  }
  syncPrivateDirectory(history);
  syncPrivateDirectory(directory);
}

function materialToJson(file: BackendPublicationRecoveryFile): Record<string, unknown> {
  return file.presence === "absent"
    ? { presence: "absent" }
    : {
      presence: "present",
      contentBase64: Buffer.from(file.content).toString("base64"),
      mode: file.mode,
      uid: file.uid,
      gid: file.gid,
      nlink: file.nlink,
      dev: file.dev,
      ino: file.ino,
      parentDev: file.parentDev,
      parentIno: file.parentIno,
    };
}

function materialFromJson(value: unknown, field: string): BackendPublicationRecoveryFile {
  if (!isRecord(value) || value.presence === "absent") {
    if (!isRecord(value) || !exactKeys(value, ["presence"]) || value.presence !== "absent") {
      return fail("malformed-journal", `${field} material is malformed`);
    }
    return { presence: "absent" };
  }
  if (
    !exactKeys(value, ["contentBase64", "dev", "gid", "ino", "mode", "nlink", "parentDev", "parentIno", "presence", "uid"])
    || value.presence !== "present"
    || typeof value.contentBase64 !== "string"
    || !Number.isSafeInteger(value.mode)
    || !Number.isSafeInteger(value.uid)
    || !Number.isSafeInteger(value.gid)
    || typeof value.nlink !== "string"
    || typeof value.dev !== "string"
    || typeof value.ino !== "string"
    || typeof value.parentDev !== "string"
    || typeof value.parentIno !== "string"
  ) {
    return fail("malformed-journal", `${field} material is malformed`);
  }
  const content = Buffer.from(value.contentBase64, "base64");
  const mode = value.mode as number;
  const uid = value.uid as number;
  const gid = value.gid as number;
  validateRecoveryFile({
    presence: "present",
    content,
    mode,
    uid,
    gid,
    nlink: value.nlink as string,
    dev: value.dev as string,
    ino: value.ino as string,
    parentDev: value.parentDev as string,
    parentIno: value.parentIno as string,
  }, field);
  return {
    presence: "present",
    content,
    mode,
    uid,
    gid,
    nlink: value.nlink as string,
    dev: value.dev as string,
    ino: value.ino as string,
    parentDev: value.parentDev as string,
    parentIno: value.parentIno as string,
  };
}

function materialJson(
  publicationId: string,
  material: BackendPublicationRecoveryMaterial,
): string {
  return `${canonicalJson({
    version: 1,
    publicationId,
    source: {
      config: materialToJson(material.source.config),
      projectMap: materialToJson(material.source.projectMap),
    },
    target: {
      config: materialToJson(material.target.config),
      projectMap: materialToJson(material.target.projectMap),
    },
  })}\n`;
}

function parseMaterial(content: string, publicationId: string): BackendPublicationRecoveryMaterial {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (error) {
    return fail("malformed-journal", "backend publication recovery material is not JSON");
  }
  if (
    !isRecord(value)
    || !exactKeys(value, ["publicationId", "source", "target", "version"])
    || value.version !== 1
    || value.publicationId !== publicationId
    || !isRecord(value.source)
    || !isRecord(value.target)
    || !exactKeys(value.source, ["config", "projectMap"])
    || !exactKeys(value.target, ["config", "projectMap"])
  ) {
    return fail("malformed-journal", "backend publication recovery material envelope is malformed");
  }
  return {
    source: {
      config: materialFromJson(value.source.config, "source config"),
      projectMap: materialFromJson(value.source.projectMap, "source project map"),
    },
    target: {
      config: materialFromJson(value.target.config, "target config"),
      projectMap: materialFromJson(value.target.projectMap, "target project map"),
    },
  };
}

function sealMaterial(
  homeDir: string | undefined,
  publicationId: string,
  material: BackendPublicationRecoveryMaterial,
): BackendPublicationRecoveryReference {
  const content = materialJson(publicationId, material);
  const bytes = Buffer.byteLength(content);
  if (bytes > MAX_MATERIAL_BYTES) return fail("invalid-input", "backend publication recovery material is too large");
  const path = materialPath(homeDir, publicationId);
  atomicWritePrivateFileDurable(path, content, {
    requireAbsent: true,
    maxExistingBytes: MAX_MATERIAL_BYTES,
  });
  return {
    relativePath: basename(path),
    sealSha256: sha256(content),
    byteLength: bytes,
  };
}

function authenticateMaterial(
  homeDir: string | undefined,
  journal: BackendPublicationJournal,
): { reference: BackendPublicationRecoveryReference; material: BackendPublicationRecoveryMaterial } {
  const reference = journal.recoveryReference ?? {
    relativePath: `${journal.publicationId}.material`,
    sealSha256: "",
    byteLength: 0,
  };
  if (reference.relativePath !== `${journal.publicationId}.material`) {
    return fail("malformed-journal", "backend publication recovery material path is not deterministic");
  }
  const path = join(backendPublicationDirectory(homeDir), reference.relativePath);
  const content = readBoundedRegularFileWithStat(path, {
    allowedRoot: backendPublicationDirectory(homeDir),
    maxBytes: MAX_MATERIAL_BYTES,
    expectedUid: typeof process.getuid === "function" ? process.getuid() : undefined,
    allowedModes: [0o600],
    requireSingleLink: true,
  }).content;
  const digest = sha256(content);
  if (
    (reference.sealSha256 !== "" && digest !== reference.sealSha256)
    || (reference.byteLength !== 0 && content.length !== reference.byteLength)
  ) {
    return fail("checksum-mismatch", "backend publication recovery material checksum does not match");
  }
  const material = parseMaterial(content, journal.publicationId);
  assertContentState(backendPublicationMaterialWitness(material), journal.sourceState, "material source");
  assertContentState(materialTargetWitness(material), journal.targetState, "material target");
  return {
    reference: {
      relativePath: reference.relativePath,
      sealSha256: digest,
      byteLength: content.length,
    },
    material,
  };
}

function prospectiveJournal(
  input: PrepareBackendPublicationInput & Readonly<{ now: Date }> ,
  sourceState: BackendPublicationStateWitness,
  targetState: BackendPublicationStateWitness,
  phase: BackendPublicationPhase,
  recoveryReference: BackendPublicationRecoveryReference | null,
): BackendPublicationJournal {
  return withChecksum({
    version: BACKEND_PUBLICATION_VERSION,
    publicationId: input.publicationId,
    sourceBackend: input.sourceBackend,
    targetBackend: input.targetBackend,
    phase,
    createdAt: input.now.toISOString(),
    updatedAt: input.now.toISOString(),
    expectedConfigSha256: sourceState.config.rawSha256 ?? sha256("{}"),
    expectedProjectMapSha256: sourceState.projectMap.semanticSha256 ?? backendPublicationCanonicalSha256({}),
    intendedConfigSha256: targetState.config.rawSha256 ?? sha256("{}"),
    intendedProjectMapSha256: targetState.projectMap.semanticSha256 ?? backendPublicationCanonicalSha256({}),
    publishedConfigSha256: null,
    publishedProjectMapSha256: null,
    recoveryReference,
    sourceState,
    targetState,
    projects: input.projects.map((project) => ({ ...project, fence: null })),
  });
}

function transition(
  journal: BackendPublicationJournal,
  phase: BackendPublicationPhase,
  homeDir: string | undefined,
  observer: BackendPublicationObserver,
  updates: Partial<Pick<BackendPublicationJournal, "publishedConfigSha256" | "publishedProjectMapSha256" | "projects" | "recoveryReference" | "sourceState" | "targetState">> = {},
): BackendPublicationJournal {
  const next = withChecksum({
    ...journal,
    phase,
    updatedAt: new Date().toISOString(),
    ...updates,
  });
  writeJournal(next, homeDir, observer, journal.checksumSha256);
  return next;
}

function activeFence(fence: BackendPublicationFenceRecord | null): boolean {
  return fence !== null && fence.releasedAt === null && !fence.databaseExpired;
}

function sameFenceIdentity(left: BackendPublicationFenceRecord, right: BackendPublicationFenceRecord): boolean {
  return left.projectId === right.projectId
    && left.machineId === right.machineId
    && left.publicationId === right.publicationId
    && left.targetBackend === right.targetBackend
    && left.evidenceSha256 === right.evidenceSha256;
}

function assertFence(fence: BackendPublicationFenceRecord, journal: BackendPublicationJournal, project: BackendPublicationProjectRecord): void {
  if (
    fence.publicationId !== journal.publicationId
    || fence.targetBackend !== journal.targetBackend
    || fence.evidenceSha256 !== project.evidenceSha256
    || fence.projectId !== project.remoteProjectId
  ) {
    return fail("unexpected-state", "backend publication remote fence identity does not match");
  }
  if (!/^\d+$/u.test(fence.fencingToken)) return fail("unexpected-state", "backend publication fencing token is invalid");
}

function operationPath(homeDir: string | undefined): string {
  return backendPublicationDirectory(homeDir);
}

/** Crash-recoverable local orchestration for backend publication. */
export class BackendPublicationCoordinator {
  readonly #homeDir: string | undefined;
  readonly #driver: BackendPublicationDriver;
  readonly #observer: BackendPublicationObserver;

  constructor(input: Readonly<{
    homeDir?: string;
    driver: BackendPublicationDriver;
    observer?: BackendPublicationObserver;
  }>) {
    this.#homeDir = input.homeDir;
    this.#driver = input.driver;
    this.#observer = input.observer ?? NOOP_OBSERVER;
  }

  async prepare(input: PrepareBackendPublicationInput): Promise<BackendPublicationJournal> {
    return this.#locked(async () => {
      const validated = validateInput(input);
      const existing = readJournal(this.#homeDir);
      if (existing !== null) {
        if (existing.phase !== "completed" && existing.phase !== "aborted") {
          return fail("unresolved-publication", "backend publication journal already exists");
        }
        archiveTerminalJournal(this.#homeDir, existing);
      }
      const targetState = materialTargetWitness(validated.material);
      const initial = prospectiveJournal(validated, targetState, targetState, "preparing", null);
      const observed = await this.#driver.observeLocalState({
        homeDir: this.#homeDir,
        journal: initial,
        recoveryReference: {
          relativePath: `${validated.publicationId}.material`,
          sealSha256: "0".repeat(64),
          byteLength: 0,
        },
        material: validated.material,
      });
      assertStateShape(observed, "observed");
      const preparing = prospectiveJournal(validated, observed, targetState, "preparing", null);
      writeJournal(preparing, this.#homeDir, this.#observer, existing?.checksumSha256);
      this.#observer("before-material-seal", materialPath(this.#homeDir, validated.publicationId));
      const reference = sealMaterial(this.#homeDir, validated.publicationId, validated.material);
      this.#observer("after-material-seal", materialPath(this.#homeDir, validated.publicationId));
      const sealedJournal = withChecksum({ ...preparing, recoveryReference: reference });
      this.#observer("before-material-authenticate", reference.relativePath);
      authenticateMaterial(this.#homeDir, sealedJournal);
      this.#observer("after-material-authenticate", reference.relativePath);
      const prepared = transition(
        preparing,
        "prepared",
        this.#homeDir,
        this.#observer,
        { recoveryReference: reference },
      );
      this.#observer("after-prepared", backendPublicationJournalPath(this.#homeDir));
      return prepared;
    });
  }

  async resume(): Promise<BackendPublicationJournal> {
    return this.#locked(async () => this.#resumeUnlocked());
  }

  async abort(): Promise<BackendPublicationJournal> {
    return this.#locked(async () => this.#abortUnlocked());
  }

  async recoverPending(options: RecoverPendingOptions = {}): Promise<BackendPublicationJournal | null> {
    return this.#locked(async () => {
      const journal = readJournal(this.#homeDir);
      if (journal === null) return null;
      if (options.disposition === "abort") return this.#abortUnlocked();
      return this.#resumeUnlocked();
    });
  }

  async #locked<T>(callback: () => Promise<T>): Promise<T> {
    return withBackendPublicationLockAsync(this.#homeDir, async () => {
      ensurePublicationDirectory(this.#homeDir);
      return callback();
    });
  }

  async #materialContext(journal: BackendPublicationJournal): Promise<BackendPublicationDriverContext> {
    this.#observer("before-material-authenticate", operationPath(this.#homeDir));
    const authenticated = authenticateMaterial(this.#homeDir, journal);
    this.#observer("after-material-authenticate", operationPath(this.#homeDir));
    return {
      homeDir: this.#homeDir,
      journal,
      recoveryReference: authenticated.reference,
      material: authenticated.material,
    };
  }

  async #observe(context: BackendPublicationDriverContext): Promise<BackendPublicationStateWitness> {
    const observed = await this.#driver.observeLocalState(context);
    assertStateShape(observed, "observed");
    return observed;
  }

  async #mutate(
    context: BackendPublicationDriverContext,
    access: "publish-project-map" | "publish-config" | "restore-config" | "restore-project-map",
    file: BackendPublicationRecoveryFile,
    expectedWitness: BackendPublicationFileWitness,
    callback: (input: BackendPublicationFileMutationContext) => Promise<BackendPublicationFileWitness>,
  ): Promise<void> {
    await withRevocablePrivateMutationPermit(`backend publication ${access}`, async (permit) => {
      activePublicationPermits.set(permit, {
        homeDir: context.homeDir,
        publicationId: context.journal.publicationId,
        checksumSha256: context.journal.checksumSha256,
        phase: context.journal.phase,
        access,
        expectedWitness,
      });
      try {
        permit.assertActive();
        const actual = await callback({
          ...context,
          file,
          expectedWitness,
          permit,
          mutationAccess: access,
        });
        permit.assertActive();
        assertContentWitness(actual, expectedWitness, access);
      } finally {
        activePublicationPermits.delete(permit);
      }
    });
  }

  async #acquireAll(journal: BackendPublicationJournal): Promise<BackendPublicationJournal> {
    if (
      this.#driver.acquireRemoteGuard === undefined
      || this.#driver.readRemoteGuard === undefined
    ) {
      return transition(journal, "guarded", this.#homeDir, this.#observer);
    }
    let current = journal;
    for (let index = 0; index < current.projects.length; index += 1) {
      const project = current.projects[index]!;
      let fence = await this.#driver.readRemoteGuard({ homeDir: this.#homeDir, journal: current, project }, "acquire");
      if (!activeFence(fence)) {
        await this.#driver.acquireRemoteGuard({ homeDir: this.#homeDir, journal: current, project });
        fence = await this.#driver.readRemoteGuard({ homeDir: this.#homeDir, journal: current, project }, "acquire");
      }
      if (fence === null || !activeFence(fence)) return fail("unexpected-state", "remote guard is not active after acquisition");
      assertFence(fence, current, project);
      const projects = current.projects.map((entry, entryIndex) => entryIndex === index ? { ...entry, fence } : entry);
      current = transition(current, "acquiring", this.#homeDir, this.#observer, { projects });
    }
    return transition(current, "guarded", this.#homeDir, this.#observer);
  }

  async #releaseAll(journal: BackendPublicationJournal, aborting: boolean): Promise<BackendPublicationJournal> {
    const phase = aborting ? "abort-releasing" : "releasing" as const;
    let current = aborting
      ? transition(journal, phase, this.#homeDir, this.#observer)
      : journal;
    if (
      this.#driver.releaseRemoteGuard === undefined
      || this.#driver.readRemoteGuard === undefined
    ) {
      return aborting
        ? current
        : transition(current, "released", this.#homeDir, this.#observer);
    }
    for (let index = 0; index < current.projects.length; index += 1) {
      let project = current.projects[index]!;
      let persisted = project.fence;
      if (persisted === null) continue;
      let authoritative = await this.#driver.readRemoteGuard({ homeDir: this.#homeDir, journal: current, project }, "release");
      if (authoritative === null) return fail("unexpected-state", "remote release evidence is missing");
      assertFence(authoritative, current, project);
      if (!sameFenceIdentity(persisted, authoritative)) return fail("unexpected-state", "remote release fence identity changed");
      if (BigInt(authoritative.fencingToken) < BigInt(persisted.fencingToken)) {
        return fail("unexpected-state", "remote release fencing token regressed");
      }
      if (BigInt(authoritative.fencingToken) > BigInt(persisted.fencingToken)) {
        if (authoritative.releasedAt !== null || authoritative.databaseExpired) {
          return fail("unexpected-state", "remote release fence successor is not active");
        }
        current = transition(current, phase, this.#homeDir, this.#observer, {
          projects: current.projects.map((entry, entryIndex) => entryIndex === index ? { ...entry, fence: authoritative } : entry),
        });
        project = current.projects[index]!;
        persisted = project.fence!;
      }
      if (authoritative.releasedAt === null) {
        if (authoritative.databaseExpired) {
          if (this.#driver.acquireRemoteGuard === undefined) {
            return fail("unexpected-state", "expired remote release fence cannot be reacquired");
          }
          await this.#driver.acquireRemoteGuard({ homeDir: this.#homeDir, journal: current, project });
          authoritative = await this.#driver.readRemoteGuard({ homeDir: this.#homeDir, journal: current, project }, "release");
          if (authoritative === null || authoritative.releasedAt !== null || authoritative.databaseExpired) {
            return fail("unexpected-state", "remote release successor is not active");
          }
          assertFence(authoritative, current, project);
          if (!sameFenceIdentity(persisted, authoritative) || BigInt(authoritative.fencingToken) <= BigInt(persisted.fencingToken)) {
            return fail("unexpected-state", "remote release reacquisition did not advance the fence");
          }
          current = transition(current, phase, this.#homeDir, this.#observer, {
            projects: current.projects.map((entry, entryIndex) => entryIndex === index ? { ...entry, fence: authoritative } : entry),
          });
          project = current.projects[index]!;
          persisted = project.fence!;
        }
        this.#observer("before-release", project.remoteProjectId);
        await this.#driver.releaseRemoteGuard({ homeDir: this.#homeDir, journal: current, project, fence: authoritative });
        this.#observer("after-release", project.remoteProjectId);
        authoritative = await this.#driver.readRemoteGuard({ homeDir: this.#homeDir, journal: current, project }, "release");
        if (authoritative === null || authoritative.releasedAt === null) return fail("unexpected-state", "remote release lacks authoritative readback");
        assertFence(authoritative, current, project);
      }
      if (!sameFenceIdentity(persisted, authoritative) || BigInt(authoritative.fencingToken) < BigInt(persisted.fencingToken)) {
        return fail("unexpected-state", "remote release fence generation changed");
      }
      current = transition(current, phase, this.#homeDir, this.#observer, {
        projects: current.projects.map((entry, entryIndex) => entryIndex === index ? { ...entry, fence: authoritative } : entry),
      });
    }
    return aborting
      ? transition(current, "abort-releasing", this.#homeDir, this.#observer)
      : transition(current, "released", this.#homeDir, this.#observer);
  }

  async #publishMap(journal: BackendPublicationJournal): Promise<BackendPublicationJournal> {
    const context = await this.#materialContext(journal);
    const observed = await this.#observe(context);
    if (logicalWitnessMatches(observed.projectMap, journal.targetState.projectMap)) {
      return transition(journal, "map-published", this.#homeDir, this.#observer, {
        publishedProjectMapSha256: journal.intendedProjectMapSha256,
        targetState: { ...journal.targetState, projectMap: observed.projectMap },
      });
    }
    if (journal.phase === "map-publishing" && mutationWitnessMatches(observed.projectMap, journal.targetState.projectMap)) {
      return transition(journal, "map-published", this.#homeDir, this.#observer, {
        publishedProjectMapSha256: journal.intendedProjectMapSha256,
        targetState: { ...journal.targetState, projectMap: observed.projectMap },
      });
    }
    assertLogicalWitness(observed.projectMap, journal.sourceState.projectMap, "source project map");
    const publishing = journal.phase === "guarded"
      ? transition(journal, "map-publishing", this.#homeDir, this.#observer)
      : journal;
    await this.#mutate(
      { ...context, journal: publishing },
      "publish-project-map",
      context.material.target.projectMap,
      journal.targetState.projectMap,
      (input) => this.#driver.publishProjectMap(input),
    );
    const after = await this.#observe({ ...context, journal: publishing });
    assertContentWitness(after.projectMap, journal.targetState.projectMap, "published project map");
    return transition(publishing, "map-published", this.#homeDir, this.#observer, {
      publishedProjectMapSha256: journal.intendedProjectMapSha256,
      targetState: { ...journal.targetState, projectMap: after.projectMap },
    });
  }

  async #publishConfig(journal: BackendPublicationJournal): Promise<BackendPublicationJournal> {
    const context = await this.#materialContext(journal);
    const observed = await this.#observe(context);
    if (logicalWitnessMatches(observed.config, journal.targetState.config)) {
      return transition(journal, "config-published", this.#homeDir, this.#observer, {
        publishedConfigSha256: journal.intendedConfigSha256,
        targetState: { ...journal.targetState, config: observed.config },
      });
    }
    if (journal.phase === "config-publishing" && mutationWitnessMatches(observed.config, journal.targetState.config)) {
      return transition(journal, "config-published", this.#homeDir, this.#observer, {
        publishedConfigSha256: journal.intendedConfigSha256,
        targetState: { ...journal.targetState, config: observed.config },
      });
    }
    assertLogicalWitness(observed.config, journal.sourceState.config, "source config");
    const publishing = journal.phase === "map-published"
      ? transition(journal, "config-publishing", this.#homeDir, this.#observer)
      : journal;
    await this.#mutate(
      { ...context, journal: publishing },
      "publish-config",
      context.material.target.config,
      journal.targetState.config,
      (input) => this.#driver.publishConfig(input),
    );
    const after = await this.#observe({ ...context, journal: publishing });
    assertContentWitness(after.config, journal.targetState.config, "published config");
    return transition(publishing, "config-published", this.#homeDir, this.#observer, {
      publishedConfigSha256: journal.intendedConfigSha256,
      targetState: { ...journal.targetState, config: after.config },
    });
  }

  async #restoreConfig(journal: BackendPublicationJournal): Promise<BackendPublicationJournal> {
    const context = await this.#materialContext(journal);
    const observed = await this.#observe(context);
    if (journal.phase === "config-restoring" && mutationWitnessMatches(observed.config, journal.sourceState.config)) {
      return transition(journal, "map-restoring", this.#homeDir, this.#observer, {
        sourceState: { ...journal.sourceState, config: observed.config },
      });
    }
    if (!logicalWitnessMatches(observed.config, journal.sourceState.config)) {
      if (!mutationWitnessMatches(observed.config, journal.targetState.config)) {
        assertLogicalWitness(observed.config, journal.targetState.config, "config before restore");
      }
      const restoring = journal.phase === "aborting"
        ? transition(journal, "config-restoring", this.#homeDir, this.#observer)
        : journal;
      await this.#mutate(
        { ...context, journal: restoring },
        "restore-config",
        context.material.source.config,
        journal.sourceState.config,
        (input) => this.#driver.restoreConfig(input),
      );
      const after = await this.#observe({ ...context, journal: restoring });
      assertContentWitness(after.config, journal.sourceState.config, "restored config");
      return transition(restoring, "map-restoring", this.#homeDir, this.#observer);
    }
    return transition(journal, "map-restoring", this.#homeDir, this.#observer);
  }

  async #restoreMap(journal: BackendPublicationJournal): Promise<BackendPublicationJournal> {
    const context = await this.#materialContext(journal);
    const observed = await this.#observe(context);
    if (journal.phase === "map-restoring" && mutationWitnessMatches(observed.projectMap, journal.sourceState.projectMap)) {
      return transition(journal, "abort-releasing", this.#homeDir, this.#observer, {
        sourceState: { ...journal.sourceState, projectMap: observed.projectMap },
      });
    }
    if (!logicalWitnessMatches(observed.projectMap, journal.sourceState.projectMap)) {
      if (!mutationWitnessMatches(observed.projectMap, journal.targetState.projectMap)) {
        assertLogicalWitness(observed.projectMap, journal.targetState.projectMap, "project map before restore");
      }
      const restoring = journal;
      await this.#mutate(
        { ...context, journal: restoring },
        "restore-project-map",
        context.material.source.projectMap,
        journal.sourceState.projectMap,
        (input) => this.#driver.restoreProjectMap(input),
      );
      const after = await this.#observe({ ...context, journal: restoring });
      assertContentWitness(after.projectMap, journal.sourceState.projectMap, "restored project map");
    }
    return transition(journal, "abort-releasing", this.#homeDir, this.#observer);
  }

  async #cleanupMaterial(journal: BackendPublicationJournal): Promise<void> {
    let context: BackendPublicationDriverContext;
    try {
      context = await this.#materialContext(journal);
    } catch (error) {
      // A crash after authenticated cleanup deleted the material but before
      // the terminal checkpoint leaves the durable abort-releasing phase.
      // Only that exact cleanup replay may treat ENOENT as already complete;
      // earlier phases still fail closed on missing recovery evidence.
      if (journal.phase === "abort-releasing" && isMissing(error)) return;
      throw error;
    }
    if (this.#driver.cleanupAbortedMaterial !== undefined) {
      await this.#driver.cleanupAbortedMaterial({ homeDir: this.#homeDir, journal, recoveryReference: context.recoveryReference });
      return;
    }
    const path = materialPath(this.#homeDir, journal.publicationId);
    consumeBoundedRegularFile(path, {
      allowedRoot: backendPublicationDirectory(this.#homeDir),
      maxBytes: MAX_MATERIAL_BYTES,
      expectedUid: typeof process.getuid === "function" ? process.getuid() : undefined,
      allowedModes: [0o600],
      requireSingleLink: true,
      expectedRawSha256: context.recoveryReference.sealSha256,
    });
    syncPrivateDirectory(backendPublicationDirectory(this.#homeDir));
  }

  async #resumeUnlocked(): Promise<BackendPublicationJournal> {
    let journal = readJournal(this.#homeDir);
    if (journal === null) return fail("publication-evidence-missing", "backend publication journal is missing");
    if (journal.phase === "completed" || journal.phase === "aborted") return journal;
    if (["aborting", "config-restoring", "map-restoring", "abort-releasing"].includes(journal.phase)) {
      return this.#abortUnlocked();
    }
    if (journal.phase === "preparing") {
      const authenticated = authenticateMaterial(this.#homeDir, journal);
      journal = transition(journal, "prepared", this.#homeDir, this.#observer, { recoveryReference: authenticated.reference });
    }
    if (journal.phase === "prepared") journal = transition(journal, "acquiring", this.#homeDir, this.#observer);
    if (journal.phase === "acquiring") journal = await this.#acquireAll(journal);
    if (journal.phase === "guarded" || journal.phase === "map-publishing") journal = await this.#publishMap(journal);
    if (journal.phase === "map-published" || journal.phase === "config-publishing") journal = await this.#publishConfig(journal);
    if (journal.phase === "config-published") journal = transition(journal, "releasing", this.#homeDir, this.#observer);
    if (journal.phase === "releasing") journal = await this.#releaseAll(journal, false);
    // All valid forward phases above converge on released: a recovered
    // released journal skips the release call, while every earlier phase
    // advances through it. Finalize that invariant directly so an
    // unrecognized intermediate cannot be treated as a successful return.
    const context = await this.#materialContext(journal);
    this.#observer("before-finalize", context.recoveryReference.relativePath);
    if (this.#driver.retainCompletedMaterial !== undefined) await this.#driver.retainCompletedMaterial(context);
    this.#observer("after-finalize", context.recoveryReference.relativePath);
    journal = transition(journal, "completed", this.#homeDir, this.#observer);
    return journal;
  }

  async #abortUnlocked(): Promise<BackendPublicationJournal> {
    let journal = readJournal(this.#homeDir);
    if (journal === null) return fail("publication-evidence-missing", "backend publication journal is missing");
    if (journal.phase === "completed" || journal.phase === "aborted") return journal;
    if (journal.phase === "abort-releasing") {
      journal = await this.#releaseAll(journal, true);
    } else {
      if (journal.phase === "preparing" && journal.recoveryReference === null) {
        try {
          const authenticated = authenticateMaterial(this.#homeDir, journal);
          journal = transition(journal, "prepared", this.#homeDir, this.#observer, {
            recoveryReference: authenticated.reference,
          });
        } catch (error) {
          if (isMissing(error)) return transition(journal, "aborted", this.#homeDir, this.#observer);
          throw error;
        }
      }
      if (!["aborting", "config-restoring", "map-restoring"].includes(journal.phase)) {
        journal = transition(journal, "aborting", this.#homeDir, this.#observer);
      }
      if (journal.phase === "aborting" || journal.phase === "config-restoring") {
        journal = await this.#restoreConfig(journal);
      }
      // Every non-terminal path reaches map-restoring here: restoreConfig
      // checkpoints it explicitly, while a recovered map-restoring journal is
      // already at that checkpoint. Continue the abort state machine
      // unconditionally so an unknown intermediate cannot be reported as safe.
      journal = await this.#restoreMap(journal);
      journal = await this.#releaseAll(journal, true);
    }
    await this.#cleanupMaterial(journal);
    return transition(journal, "aborted", this.#homeDir, this.#observer);
  }
}
