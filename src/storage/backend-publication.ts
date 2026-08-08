import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  PrivateMutationPermit,
  withPrivateMutationLockAsync,
  withRevocablePrivateMutationPermit,
} from "../private-mutation-lock.js";
import {
  atomicWritePrivateFileDurable,
  consumeBoundedRegularFile,
  openPrivateDirectory,
  readBoundedRegularFileWithStat,
  syncPrivateDirectory,
} from "../security-files.js";
import type { StorageBackendName } from "./contracts.js";

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
      | "permit-mismatch",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "BackendPublicationJournalError";
  }
}

const NOOP_OBSERVER: BackendPublicationObserver = () => undefined;

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
    || !Number.isSafeInteger(witness.mode)
    || witness.mode < 0
    || witness.mode > 0o7777
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

function assertContentWitness(
  actual: BackendPublicationFileWitness,
  expected: BackendPublicationFileWitness,
  field: string,
): void {
  const fields = ["presence", "rawSha256", "semanticSha256", "byteLength", "mode", "uid", "gid", "nlink"] as const;
  if (fields.some((key) => actual[key] !== expected[key])) {
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
    || !Number.isSafeInteger(file.mode)
    || file.mode < 0
    || file.mode > 0o7777
    || (file.mode & 0o077) !== 0
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
  return join(backendPublicationDirectory(homeDir), "journal.lock");
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

function readJournal(homeDir?: string): BackendPublicationJournal | null {
  const directory = backendPublicationDirectory(homeDir);
  let directoryHandle;
  try {
    directoryHandle = openPrivateDirectory(directory);
  } catch (error) {
    if (isMissing(error)) return null;
    return fail("unsafe-storage", `backend publication directory cannot be opened: ${(error as Error).message}`);
  }
  directoryHandle.close();
  try {
    const content = readBoundedRegularFileWithStat(backendPublicationJournalPath(homeDir), {
      allowedRoot: directory,
      maxBytes: MAX_JOURNAL_BYTES,
      expectedUid: typeof process.getuid === "function" ? process.getuid() : undefined,
      allowedModes: [0o600],
      requireSingleLink: true,
    }).content;
    return parseJournal(content);
  } catch (error) {
    if (isMissing(error)) return null;
    if (error instanceof BackendPublicationJournalError) throw error;
    return fail("unsafe-storage", `backend publication journal cannot be read: ${(error as Error).message}`);
  }
}

export function readBackendPublicationJournal(homeDir?: string): BackendPublicationJournal | null {
  return readJournal(homeDir);
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
  atomicWritePrivateFileDurable(path, journalContent(journal), {
    requireAbsent: expectedChecksum === undefined,
    expectedContentSha256: current === null ? null : sha256(current.raw),
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
  consumeBoundedRegularFile(backendPublicationJournalPath(homeDir), {
    allowedRoot: directory,
    maxBytes: MAX_JOURNAL_BYTES,
    expectedUid: typeof process.getuid === "function" ? process.getuid() : undefined,
    allowedModes: [0o600],
    requireSingleLink: true,
    expectedRawSha256: sha256(current),
  });
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
  updates: Partial<Pick<BackendPublicationJournal, "publishedConfigSha256" | "publishedProjectMapSha256" | "projects" | "recoveryReference" | "targetState">> = {},
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
      writeJournal(preparing, this.#homeDir, this.#observer);
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
    ensurePublicationDirectory(this.#homeDir);
    return withPrivateMutationLockAsync(
      backendPublicationLockPath(this.#homeDir),
      "backend publication",
      callback,
    );
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
      permit.assertActive();
      const actual = await callback({ ...context, file, expectedWitness, permit });
      permit.assertActive();
      assertContentWitness(actual, expectedWitness, access);
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
    assertLogicalWitness(observed.projectMap, journal.sourceState.projectMap, "source project map");
    const publishing = journal.phase === "guarded"
      ? transition(journal, "map-publishing", this.#homeDir, this.#observer)
      : journal;
    await this.#mutate(context, "publish-project-map", context.material.target.projectMap, journal.targetState.projectMap, (input) => this.#driver.publishProjectMap(input));
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
    assertLogicalWitness(observed.config, journal.sourceState.config, "source config");
    const publishing = journal.phase === "map-published"
      ? transition(journal, "config-publishing", this.#homeDir, this.#observer)
      : journal;
    await this.#mutate(context, "publish-config", context.material.target.config, journal.targetState.config, (input) => this.#driver.publishConfig(input));
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
    if (!logicalWitnessMatches(observed.config, journal.sourceState.config)) {
      assertLogicalWitness(observed.config, journal.targetState.config, "config before restore");
      const restoring = journal.phase === "aborting"
        ? transition(journal, "config-restoring", this.#homeDir, this.#observer)
        : journal;
      await this.#mutate(context, "restore-config", context.material.source.config, journal.sourceState.config, (input) => this.#driver.restoreConfig(input));
      const after = await this.#observe({ ...context, journal: restoring });
      assertContentWitness(after.config, journal.sourceState.config, "restored config");
      return transition(restoring, "map-restoring", this.#homeDir, this.#observer);
    }
    return transition(journal, "map-restoring", this.#homeDir, this.#observer);
  }

  async #restoreMap(journal: BackendPublicationJournal): Promise<BackendPublicationJournal> {
    const context = await this.#materialContext(journal);
    const observed = await this.#observe(context);
    if (!logicalWitnessMatches(observed.projectMap, journal.sourceState.projectMap)) {
      assertLogicalWitness(observed.projectMap, journal.targetState.projectMap, "project map before restore");
      const restoring = journal;
      await this.#mutate(context, "restore-project-map", context.material.source.projectMap, journal.sourceState.projectMap, (input) => this.#driver.restoreProjectMap(input));
      const after = await this.#observe({ ...context, journal: restoring });
      assertContentWitness(after.projectMap, journal.sourceState.projectMap, "restored project map");
    }
    return transition(journal, "abort-releasing", this.#homeDir, this.#observer);
  }

  async #cleanupMaterial(journal: BackendPublicationJournal): Promise<void> {
    const context = await this.#materialContext(journal);
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
    if (["aborting", "config-restoring", "map-restoring"].includes(journal.phase)) {
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
