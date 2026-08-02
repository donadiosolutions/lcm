import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  chmodSync,
  unlinkSync,
  type Stats,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
  withPrivateMutationLock,
  withPrivateMutationLockAsync,
} from "../private-mutation-lock.js";
import {
  atomicWritePrivateFile,
  atomicWritePrivateFileExclusive,
  ensurePrivateDirectory,
  PRIVATE_DIRECTORY_MODE,
  PRIVATE_FILE_MODE,
  readBoundedRegularFile,
} from "../security-files.js";
import type { StorageBackendName } from "./contracts.js";
import type {
  PostgreSqlBackendPublicationFence,
} from "./postgresql/publication-guard.js";

const MAX_BACKEND_PUBLICATION_JOURNAL_BYTES = 1024 * 1024;
const MAX_BACKEND_PUBLICATION_STATE_BYTES = 4 * 1024 * 1024;
const MAX_BACKEND_PUBLICATION_HISTORY_ENTRIES = 1024;
const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const UUID_V7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const PUBLICATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const DECIMAL_BIGINT_PATTERN = /^[1-9]\d*$/u;

export const BACKEND_PUBLICATION_JOURNAL_VERSION = 1 as const;

export type BackendPublicationPhase =
  | "prepared"
  | "acquiring"
  | "guarded"
  | "map-published"
  | "config-published"
  | "releasing"
  | "released"
  | "abort-prepared"
  | "config-restored"
  | "map-restored"
  | "abort-releasing"
  | "completed"
  | "aborted";

export type BackendPublicationFileWitness =
  | {
    readonly presence: "absent";
    readonly rawSha256: null;
    readonly semanticSha256: null;
    readonly byteLength: 0;
    readonly mode: null;
    readonly uid: null;
    readonly gid: null;
    readonly nlink: null;
  }
  | {
    readonly presence: "present";
    readonly rawSha256: string;
    readonly semanticSha256: string;
    readonly byteLength: number;
    readonly mode: number;
    readonly uid: number;
    readonly gid: number;
    readonly nlink: 1;
  };

export type BackendPublicationStateWitness = {
  readonly config: BackendPublicationFileWitness;
  readonly projectMap: BackendPublicationFileWitness;
};

export type BackendPublicationRecoveryReference = {
  readonly relativePath: string;
  readonly sealSha256: string;
  readonly byteLength: number;
};

export type BackendPublicationRecoveryFile =
  | { readonly presence: "absent" }
  | {
    readonly presence: "present";
    readonly content: Uint8Array;
    readonly mode: number;
    readonly uid: number;
    readonly gid: number;
  };

export type BackendPublicationRecoveryMaterial = {
  readonly source: {
    readonly config: BackendPublicationRecoveryFile;
    readonly projectMap: BackendPublicationRecoveryFile;
  };
  readonly target: {
    readonly config: BackendPublicationRecoveryFile;
    readonly projectMap: BackendPublicationRecoveryFile;
  };
};

export type BackendPublicationFenceRecord = {
  readonly projectId: string;
  readonly machineId: string;
  readonly publicationId: string;
  readonly targetBackend: StorageBackendName;
  readonly evidenceSha256: string;
  readonly fencingToken: string;
  readonly acquiredAt: string;
  readonly renewedAt: string;
  readonly expiresAt: string;
  readonly releasedAt: string | null;
  readonly databaseExpired: boolean;
};

export type BackendPublicationProjectRecord = {
  readonly localProjectId: string;
  readonly remoteProjectId: string;
  readonly evidenceSha256: string;
  readonly fence: BackendPublicationFenceRecord | null;
};

export type BackendPublicationJournal = {
  readonly version: typeof BACKEND_PUBLICATION_JOURNAL_VERSION;
  readonly publicationId: string;
  readonly sourceBackend: StorageBackendName;
  readonly targetBackend: StorageBackendName;
  readonly phase: BackendPublicationPhase;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expectedConfigSha256: string;
  readonly expectedProjectMapSha256: string;
  readonly intendedConfigSha256: string;
  readonly intendedProjectMapSha256: string;
  readonly publishedConfigSha256: string | null;
  readonly publishedProjectMapSha256: string | null;
  readonly recoveryReference: BackendPublicationRecoveryReference | null;
  readonly sourceState: BackendPublicationStateWitness | null;
  readonly targetState: BackendPublicationStateWitness | null;
  readonly projects: readonly BackendPublicationProjectRecord[];
  readonly checksumSha256: string;
};

type JournalPayload = Omit<BackendPublicationJournal, "checksumSha256">;

export type BackendPublicationObserver = (
  event:
    | "before-journal-lock"
    | "after-journal-lock"
    | "before-journal-rename"
    | "after-journal-rename"
    | "before-journal-directory-fsync"
    | "after-journal-directory-fsync"
    | "before-material-seal"
    | "after-material-seal"
    | "before-material-authenticate"
    | "after-material-authenticate"
    | "before-remote-read"
    | "after-remote-read"
    | "before-remote-acquire"
    | "after-remote-acquire"
    | "before-remote-reacquire"
    | "after-remote-reacquire"
    | "before-remote-successor-read"
    | "after-remote-successor-read"
    | "before-release-fence-checkpoint"
    | "after-release-fence-checkpoint"
    | "before-remote-release"
    | "after-remote-release"
    | "before-map-publish"
    | "after-map-publish"
    | "before-config-publish"
    | "after-config-publish"
    | "before-config-restore"
    | "after-config-restore"
    | "before-map-restore"
    | "after-map-restore"
    | "before-material-retain"
    | "after-material-retain"
    | "before-material-cleanup"
    | "after-material-cleanup",
  path: string,
) => void;

const NOOP_OBSERVER: BackendPublicationObserver = () => undefined;

export class BackendPublicationJournalError extends Error {
  constructor(
    readonly reason:
      | "invalid-input"
      | "unsafe-storage"
      | "malformed-journal"
      | "checksum-mismatch"
      | "unexpected-state"
      | "unresolved-publication"
      | "backend-mismatch"
      | "publication-evidence-missing"
      | "permit-mismatch",
  message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "BackendPublicationJournalError";
  }
}

type PublicationPermit = {
  readonly publicationId: string;
  readonly checksumSha256: string;
  readonly lcmRoot: string;
  readonly phase: BackendPublicationPhase;
  readonly access:
    | "read-recovery"
    | "publish-project-map"
    | "publish-config"
    | "restore-config"
    | "restore-project-map";
  readonly stateSha256: string | null;
  active: boolean;
};

const publicationPermit = new AsyncLocalStorage<PublicationPermit>();
const journalLockContext = new AsyncLocalStorage<string>();

function fail(
  reason: BackendPublicationJournalError["reason"],
  message: string,
): never {
  throw new BackendPublicationJournalError(reason, message);
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

function backendPublicationLockPath(homeDir?: string): string {
  return join(rootPath(homeDir), "backend-publication.lock");
}

export function backendPublicationHistoryDirectory(homeDir?: string): string {
  return join(backendPublicationDirectory(homeDir), "history");
}

function mode(stat: Stats): number {
  return stat.mode & 0o777;
}

function assertPrivateDirectory(path: string): void {
  const stat = lstatSync(path);
  const currentUid = process.getuid?.();
  if (
    !stat.isDirectory()
    || stat.isSymbolicLink()
    || (currentUid !== undefined && stat.uid !== currentUid)
    || mode(stat) !== PRIVATE_DIRECTORY_MODE
  ) {
    fail("unsafe-storage", "backend publication directory is not private");
  }
  if (realpathSync(path) !== path) {
    fail("unsafe-storage", "backend publication directory is not canonical");
  }
}

function ensurePrivateDirectoryExact(path: string): void {
  try {
    assertPrivateDirectory(path);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  mkdirSync(path, { mode: PRIVATE_DIRECTORY_MODE });
  assertPrivateDirectory(path);
  syncDirectory(dirname(path));
}

function publicationStorageExists(homeDir?: string): boolean {
  return lstatSync(backendPublicationDirectory(homeDir), {
    throwIfNoEntry: false,
  }) !== undefined;
}

function ensureLegacyRootForConsumer(homeDir?: string): void {
  const root = rootPath(homeDir);
  const stat = lstatSync(root, { throwIfNoEntry: false });
  if (stat === undefined) {
    mkdirSync(root, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    assertPrivateDirectory(root);
    return;
  }
  const currentUid = process.getuid?.();
  if (
    !stat.isDirectory()
    || stat.isSymbolicLink()
    || (currentUid !== undefined && stat.uid !== currentUid)
    || realpathSync(root) !== root
  ) {
    return fail("unsafe-storage", "LCM home is not a trusted directory");
  }
  if (publicationStorageExists(homeDir)) {
    assertPrivateDirectory(root);
    return;
  }
  if (mode(stat) !== PRIVATE_DIRECTORY_MODE) chmodSync(root, PRIVATE_DIRECTORY_MODE);
  assertPrivateDirectory(root);
}

function ensurePublicationDirectory(homeDir?: string): string {
  const root = rootPath(homeDir);
  ensurePrivateDirectoryExact(root);
  const directory = backendPublicationDirectory(homeDir);
  ensurePrivateDirectoryExact(directory);
  return directory;
}

function syncDirectory(path: string): void {
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function terminalArchiveName(journal: BackendPublicationJournal): string {
  return `${journal.publicationId}-${journal.checksumSha256}.json`;
}

function assertTerminalArchiveCapacity(
  journal: BackendPublicationJournal,
  homeDir?: string,
): void {
  const history = backendPublicationHistoryDirectory(homeDir);
  if (lstatSync(history, { throwIfNoEntry: false }) === undefined) return;
  const entries = readdirSync(history);
  if (
    entries.length === MAX_BACKEND_PUBLICATION_HISTORY_ENTRIES
    && !entries.includes(terminalArchiveName(journal))
  ) {
    return fail(
      "unexpected-state",
      "backend publication history is at capacity for a new terminal archive",
    );
  }
}

function archiveTerminalJournal(
  journal: BackendPublicationJournal,
  homeDir?: string,
): void {
  const history = backendPublicationHistoryDirectory(homeDir);
  ensurePrivateDirectoryExact(history);
  assertTerminalArchiveCapacity(journal, homeDir);
  const path = join(history, terminalArchiveName(journal));
  const content = journalContent(journal);
  if (!atomicWritePrivateFileExclusive(path, content)) {
    assertPublicationHistory(homeDir);
  }
  assertPrivateJournal(path);
  syncDirectory(history);
  syncDirectory(backendPublicationDirectory(homeDir));
}

function assertPrivateJournalStat(stat: Stats): void {
  const currentUid = process.getuid?.();
  if (
    !stat.isFile()
    || stat.isSymbolicLink()
    || (currentUid !== undefined && stat.uid !== currentUid)
    || stat.nlink !== 1
    || mode(stat) !== PRIVATE_FILE_MODE
    || stat.size > MAX_BACKEND_PUBLICATION_JOURNAL_BYTES
  ) {
    fail("unsafe-storage", "backend publication journal is not a private regular file");
  }
}

function assertPrivateJournal(path: string): void {
  assertPrivateJournalStat(lstatSync(path));
}

function sameFileProof(left: Stats, right: Stats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.uid === right.uid
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function readJournalDescriptor(
  path: string,
  afterRead?: () => void,
  afterStat?: () => void,
): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    assertPrivateJournalStat(before);
    afterStat?.();
    const buffer = Buffer.alloc(MAX_BACKEND_PUBLICATION_JOURNAL_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(fd, buffer, offset, buffer.length - offset, null);
      if (count === 0) break;
      offset += count;
    }
    if (offset > MAX_BACKEND_PUBLICATION_JOURNAL_BYTES) {
      return fail("unsafe-storage", "backend publication journal exceeds its size bound");
    }
    afterRead?.();
    const after = fstatSync(fd);
    const currentPath = lstatSync(path);
    assertPrivateJournalStat(after);
    assertPrivateJournalStat(currentPath);
    if (
      offset !== before.size
      || !sameFileProof(before, after)
      || !sameFileProof(after, currentPath)
    ) {
      return fail("unsafe-storage", "backend publication journal changed during authentication");
    }
    return buffer.subarray(0, offset).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
}

/** SHA-256 of recursively key-sorted semantic JSON. */
export function backendPublicationCanonicalSha256(value: unknown): string {
  return sha256(canonicalJson(value));
}

const ABSENT_FILE_WITNESS: BackendPublicationFileWitness = {
  presence: "absent",
  rawSha256: null,
  semanticSha256: null,
  byteLength: 0,
  mode: null,
  uid: null,
  gid: null,
  nlink: null,
};

function semanticFileSha256(content: Uint8Array, field: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(content).toString("utf8")) as unknown;
  } catch (error) {
    throw new BackendPublicationJournalError(
      "unexpected-state",
      `backend publication ${field} is not valid JSON`,
      { cause: error },
    );
  }
  return backendPublicationCanonicalSha256(parsed);
}

function witnessFromRecoveryFile(
  file: BackendPublicationRecoveryFile,
  field: string,
): BackendPublicationFileWitness {
  if (file.presence === "absent") return ABSENT_FILE_WITNESS;
  const currentUid = process.getuid?.();
  const currentGid = process.getgid?.();
  if (
    file.mode !== PRIVATE_FILE_MODE
    || !Number.isSafeInteger(file.uid)
    || file.uid < 0
    || !Number.isSafeInteger(file.gid)
    || file.gid < 0
    || (currentUid !== undefined && file.uid !== currentUid)
    || (currentGid !== undefined && file.gid !== currentGid)
    || file.content.byteLength > MAX_BACKEND_PUBLICATION_STATE_BYTES
  ) {
    return fail("invalid-input", `backend publication ${field} material is not private and bounded`);
  }
  return {
    presence: "present",
    rawSha256: sha256(file.content),
    semanticSha256: semanticFileSha256(file.content, field),
    byteLength: file.content.byteLength,
    mode: file.mode,
    uid: file.uid,
    gid: file.gid,
    nlink: 1,
  };
}

export function backendPublicationMaterialWitness(
  material: BackendPublicationRecoveryMaterial,
): { readonly source: BackendPublicationStateWitness; readonly target: BackendPublicationStateWitness } {
  return {
    source: {
      config: witnessFromRecoveryFile(material.source.config, "source config"),
      projectMap: witnessFromRecoveryFile(material.source.projectMap, "source project map"),
    },
    target: {
      config: witnessFromRecoveryFile(material.target.config, "target config"),
      projectMap: witnessFromRecoveryFile(material.target.projectMap, "target project map"),
    },
  };
}

function recoveryJsonObject(
  file: BackendPublicationRecoveryFile,
  field: string,
): Record<string, unknown> {
  if (file.presence === "absent") return {};
  const value = JSON.parse(Buffer.from(file.content).toString("utf8")) as unknown;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail("invalid-input", `backend publication ${field} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function recoveryConfigBackend(
  file: BackendPublicationRecoveryFile,
  field: string,
): StorageBackendName {
  const config = recoveryJsonObject(file, field);
  if (config.storage === undefined) return "sqlite";
  if (
    config.storage === null
    || typeof config.storage !== "object"
    || Array.isArray(config.storage)
  ) {
    return fail("invalid-input", `backend publication ${field}.storage must be an object`);
  }
  const configured = (config.storage as Record<string, unknown>).backend;
  if (configured === undefined) return "sqlite";
  if (configured === "sqlite" || configured === "postgresql") return configured;
  return fail(
    "invalid-input",
    `backend publication ${field}.storage.backend must be sqlite or postgresql`,
  );
}

type RecoveryProjectCoverage = ReadonlyMap<string, string>;

function recoveryProjectCoverage(
  file: BackendPublicationRecoveryFile,
  backendName: StorageBackendName,
  field: string,
): RecoveryProjectCoverage {
  const map = recoveryJsonObject(file, field);
  const coverage = new Map<string, string>();
  for (const [localProjectId, value] of Object.entries(map)) {
    if (!HASH_PATTERN.test(localProjectId)) {
      return fail("invalid-input", `backend publication ${field} has an invalid local project ID`);
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return fail("invalid-input", `backend publication ${field} entry must be an object`);
    }
    const entry = value as Record<string, unknown>;
    const expectedKeys = entry.remoteProjectId === undefined
      ? ["canonical", "aliases"]
      : ["canonical", "aliases", "remoteProjectId"];
    if (
      !exactKeys(entry, expectedKeys)
      || typeof entry.canonical !== "string"
      || entry.canonical.length === 0
      || !isAbsolute(entry.canonical)
      || !Array.isArray(entry.aliases)
      || !entry.aliases.every((alias) =>
        typeof alias === "string" && alias.length > 0 && isAbsolute(alias))
    ) {
      return fail("invalid-input", `backend publication ${field} entry is malformed`);
    }
    if (entry.remoteProjectId === undefined) {
      if (backendName === "postgresql") {
        return fail(
          "invalid-input",
          `backend publication ${field} PostgreSQL entry lacks a remote project ID`,
        );
      }
      continue;
    }
    if (typeof entry.remoteProjectId !== "string") {
      return fail("invalid-input", `backend publication ${field} remote project ID is invalid`);
    }
    const remoteProjectId = entry.remoteProjectId.toLowerCase();
    if (!UUID_V7_PATTERN.test(remoteProjectId)) {
      return fail("invalid-input", `backend publication ${field} remote project ID is invalid`);
    }
    coverage.set(localProjectId, remoteProjectId);
  }
  return coverage;
}

function readStateWitnessFile(
  path: string,
  field: string,
  afterRead?: (path: string) => void,
): BackendPublicationFileWitness {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return ABSENT_FILE_WITNESS;
    return fail("unsafe-storage", `backend publication ${field} is not a private regular file`);
  }
  try {
    const before = fstatSync(fd);
    const currentUid = process.getuid?.();
    if (
      !before.isFile()
      || before.isSymbolicLink()
      || before.nlink !== 1
      || mode(before) !== PRIVATE_FILE_MODE
      || (currentUid !== undefined && before.uid !== currentUid)
      || before.size > MAX_BACKEND_PUBLICATION_STATE_BYTES
    ) {
      return fail("unsafe-storage", `backend publication ${field} is not private and bounded`);
    }
    const content = readFileSync(fd);
    afterRead?.(path);
    const after = fstatSync(fd);
    const currentPath = lstatSync(path);
    if (
      content.byteLength !== before.size
      || content.byteLength > MAX_BACKEND_PUBLICATION_STATE_BYTES
      || !sameFileProof(before, after)
      || !sameFileProof(after, currentPath)
    ) {
      return fail("unsafe-storage", `backend publication ${field} changed during authentication`);
    }
    return {
      presence: "present",
      rawSha256: sha256(content),
      semanticSha256: semanticFileSha256(content, field),
      byteLength: content.byteLength,
      mode: mode(after),
      uid: after.uid,
      gid: after.gid,
      nlink: 1,
    };
  } finally {
    closeSync(fd);
  }
}

/** Descriptor-authenticated config and project-map witness with absence preserved. */
export function captureBackendPublicationState(
  homeDir?: string,
  /** @internal Deterministic descriptor/path replacement seam for tests. */
  afterRead?: (path: string) => void,
): BackendPublicationStateWitness {
  const root = rootPath(homeDir);
  assertPrivateDirectory(root);
  return {
    config: readStateWitnessFile(join(root, "config.json"), "config", afterRead),
    projectMap: readStateWitnessFile(join(root, "map.json"), "project map", afterRead),
  };
}

function readStateFile(path: string, root: string): string {
  try {
    return readBoundedRegularFile(path, {
      allowedRoot: root,
      maxBytes: MAX_BACKEND_PUBLICATION_STATE_BYTES,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "{}";
    throw error;
  }
}

/** Exact raw config bytes, with an absent config represented by literal `{}`. */
export function backendPublicationConfigSha256(homeDir?: string): string {
  const root = rootPath(homeDir);
  return sha256(readStateFile(join(root, "config.json"), root));
}

/** Canonical semantic project-map JSON, with an absent map represented by `{}`. */
export function backendPublicationProjectMapSha256(homeDir?: string): string {
  const root = rootPath(homeDir);
  const content = readStateFile(join(root, "map.json"), root);
  let value: unknown;
  try {
    value = JSON.parse(content) as unknown;
  } catch (error) {
    throw new BackendPublicationJournalError(
      "unexpected-state",
      "project map cannot be bound to backend publication evidence",
      { cause: error },
    );
  }
  return backendPublicationCanonicalSha256(value);
}

function payloadContent(payload: JournalPayload): string {
  return JSON.stringify(payload);
}

function journalFromPayload(payload: JournalPayload): BackendPublicationJournal {
  return {
    ...payload,
    checksumSha256: sha256(payloadContent(payload)),
  };
}

function journalContent(journal: BackendPublicationJournal): string {
  return `${JSON.stringify(journal, null, 2)}\n`;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === [...expected].sort()[index]);
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail("malformed-journal", "backend publication journal contains a non-object record");
  }
  return value as Record<string, unknown>;
}

function backend(value: unknown): StorageBackendName {
  if (value !== "sqlite" && value !== "postgresql") {
    return fail("malformed-journal", "backend publication journal contains an invalid backend");
  }
  return value;
}

function hash(value: unknown, field: string): string {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) {
    return fail("malformed-journal", `backend publication journal contains an invalid ${field}`);
  }
  return value;
}

function nullableHash(value: unknown, field: string): string | null {
  return value === null ? null : hash(value, field);
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return fail("malformed-journal", `backend publication journal contains an invalid ${field}`);
  }
  return value;
}

function parseFileWitness(
  value: unknown,
  field: string,
): BackendPublicationFileWitness {
  const input = record(value);
  const keys = [
    "presence", "rawSha256", "semanticSha256", "byteLength",
    "mode", "uid", "gid", "nlink",
  ] as const;
  if (!exactKeys(input, keys)) {
    return fail("malformed-journal", `backend publication ${field} witness has unexpected fields`);
  }
  if (input.presence === "absent") {
    if (
      input.rawSha256 !== null
      || input.semanticSha256 !== null
      || input.byteLength !== 0
      || input.mode !== null
      || input.uid !== null
      || input.gid !== null
      || input.nlink !== null
    ) {
      return fail("malformed-journal", `backend publication absent ${field} witness is invalid`);
    }
    return {
      presence: "absent",
      rawSha256: null,
      semanticSha256: null,
      byteLength: 0,
      mode: null,
      uid: null,
      gid: null,
      nlink: null,
    };
  }
  if (
    input.presence !== "present"
    || input.nlink !== 1
  ) {
    return fail("malformed-journal", `backend publication present ${field} witness is invalid`);
  }
  const fileMode = nonNegativeInteger(input.mode, `${field} mode`);
  if (fileMode > 0o777 || fileMode !== PRIVATE_FILE_MODE) {
    return fail("malformed-journal", `backend publication ${field} witness is not private`);
  }
  return {
    presence: "present",
    rawSha256: hash(input.rawSha256, `${field} rawSha256`),
    semanticSha256: hash(input.semanticSha256, `${field} semanticSha256`),
    byteLength: nonNegativeInteger(input.byteLength, `${field} byteLength`),
    mode: fileMode,
    uid: nonNegativeInteger(input.uid, `${field} uid`),
    gid: nonNegativeInteger(input.gid, `${field} gid`),
    nlink: 1,
  };
}

function parseStateWitness(
  value: unknown,
  field: string,
): BackendPublicationStateWitness | null {
  if (value === null) return null;
  const input = record(value);
  if (!exactKeys(input, ["config", "projectMap"])) {
    return fail("malformed-journal", `backend publication ${field} has unexpected fields`);
  }
  return {
    config: parseFileWitness(input.config, `${field} config`),
    projectMap: parseFileWitness(input.projectMap, `${field} project map`),
  };
}

function parseRecoveryReference(
  value: unknown,
): BackendPublicationRecoveryReference | null {
  if (value === null) return null;
  const input = record(value);
  if (!exactKeys(input, ["relativePath", "sealSha256", "byteLength"])) {
    return fail("malformed-journal", "backend publication recovery reference has unexpected fields");
  }
  if (
    typeof input.relativePath !== "string"
    || input.relativePath.length === 0
    || input.relativePath.length > 255
    || input.relativePath.startsWith("/")
    || input.relativePath.includes("\\")
    || input.relativePath.split("/").some((segment) =>
      segment.length === 0 || segment === "." || segment === "..")
  ) {
    return fail("malformed-journal", "backend publication recovery reference is not relative");
  }
  return {
    relativePath: input.relativePath,
    sealSha256: hash(input.sealSha256, "recovery sealSha256"),
    byteLength: nonNegativeInteger(input.byteLength, "recovery byteLength"),
  };
}

function date(value: unknown, field: string): string {
  if (typeof value !== "string") {
    return fail("malformed-journal", `backend publication journal contains an invalid ${field}`);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    return fail("malformed-journal", `backend publication journal contains an invalid ${field}`);
  }
  return value;
}

function nullableDate(value: unknown, field: string): string | null {
  return value === null ? null : date(value, field);
}

function phase(value: unknown): BackendPublicationPhase {
  switch (value) {
    case "prepared":
    case "acquiring":
    case "guarded":
    case "map-published":
    case "config-published":
    case "releasing":
    case "released":
    case "abort-prepared":
    case "config-restored":
    case "map-restored":
    case "abort-releasing":
    case "completed":
    case "aborted":
      return value;
    default:
      return fail("malformed-journal", "backend publication journal contains an invalid phase");
  }
}

function parseFence(
  value: unknown,
  project: { readonly remoteProjectId: string; readonly evidenceSha256: string },
): BackendPublicationFenceRecord | null {
  if (value === null) return null;
  const input = record(value);
  if (!exactKeys(input, [
    "projectId", "machineId", "publicationId", "targetBackend", "evidenceSha256",
    "fencingToken", "acquiredAt", "renewedAt", "expiresAt", "releasedAt",
    "databaseExpired",
  ])) {
    return fail("malformed-journal", "backend publication fence has unexpected fields");
  }
  if (
    input.projectId !== project.remoteProjectId
    || typeof input.machineId !== "string"
    || !UUID_V7_PATTERN.test(input.machineId)
    || typeof input.publicationId !== "string"
    || !PUBLICATION_ID_PATTERN.test(input.publicationId)
    || typeof input.fencingToken !== "string"
    || !DECIMAL_BIGINT_PATTERN.test(input.fencingToken)
    || input.evidenceSha256 !== project.evidenceSha256
    || typeof input.databaseExpired !== "boolean"
  ) {
    return fail("malformed-journal", "backend publication fence is invalid");
  }
  return {
    projectId: project.remoteProjectId,
    machineId: input.machineId,
    publicationId: input.publicationId,
    targetBackend: backend(input.targetBackend),
    evidenceSha256: project.evidenceSha256,
    fencingToken: input.fencingToken,
    acquiredAt: date(input.acquiredAt, "fence acquiredAt"),
    renewedAt: date(input.renewedAt, "fence renewedAt"),
    expiresAt: date(input.expiresAt, "fence expiresAt"),
    releasedAt: nullableDate(input.releasedAt, "fence releasedAt"),
    databaseExpired: input.databaseExpired,
  };
}

function parseProject(value: unknown): BackendPublicationProjectRecord {
  const input = record(value);
  if (!exactKeys(input, [
    "localProjectId", "remoteProjectId", "evidenceSha256", "fence",
  ])) {
    return fail("malformed-journal", "backend publication project has unexpected fields");
  }
  if (
    typeof input.localProjectId !== "string"
    || !HASH_PATTERN.test(input.localProjectId)
    || typeof input.remoteProjectId !== "string"
    || !UUID_V7_PATTERN.test(input.remoteProjectId)
  ) {
    return fail("malformed-journal", "backend publication project identity is invalid");
  }
  const project = {
    localProjectId: input.localProjectId,
    remoteProjectId: input.remoteProjectId,
    evidenceSha256: hash(input.evidenceSha256, "project evidenceSha256"),
  };
  return { ...project, fence: parseFence(input.fence, project) };
}

function parseJournal(content: string): BackendPublicationJournal {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch (error) {
    throw new BackendPublicationJournalError(
      "malformed-journal",
      "backend publication journal is not valid JSON",
      { cause: error },
    );
  }
  const input = record(parsed);
  if (!exactKeys(input, [
    "version", "publicationId", "sourceBackend", "targetBackend", "phase",
    "createdAt", "updatedAt", "expectedConfigSha256",
    "expectedProjectMapSha256", "publishedConfigSha256",
    "intendedConfigSha256", "intendedProjectMapSha256",
    "publishedProjectMapSha256", "recoveryReference", "sourceState",
    "targetState", "projects", "checksumSha256",
  ])) {
    return fail("malformed-journal", "backend publication journal has unexpected fields");
  }
  if (
    input.version !== BACKEND_PUBLICATION_JOURNAL_VERSION
    || typeof input.publicationId !== "string"
    || !PUBLICATION_ID_PATTERN.test(input.publicationId)
    || !Array.isArray(input.projects)
  ) {
    return fail("malformed-journal", "backend publication journal header is invalid");
  }
  const projects = input.projects.map(parseProject);
  const identities = projects.map(({ localProjectId }) => localProjectId);
  if (
    projects.length === 0
    || identities.some((identity, index) => identity !== [...identities].sort()[index])
    || new Set(identities).size !== identities.length
    || new Set(projects.map(({ remoteProjectId }) => remoteProjectId)).size !== projects.length
  ) {
    return fail("malformed-journal", "backend publication projects are not a unique sorted set");
  }
  const payload: JournalPayload = {
    version: BACKEND_PUBLICATION_JOURNAL_VERSION,
    publicationId: input.publicationId,
    sourceBackend: backend(input.sourceBackend),
    targetBackend: backend(input.targetBackend),
    phase: phase(input.phase),
    createdAt: date(input.createdAt, "createdAt"),
    updatedAt: date(input.updatedAt, "updatedAt"),
    expectedConfigSha256: hash(input.expectedConfigSha256, "expectedConfigSha256"),
    expectedProjectMapSha256: hash(input.expectedProjectMapSha256, "expectedProjectMapSha256"),
    intendedConfigSha256: hash(input.intendedConfigSha256, "intendedConfigSha256"),
    intendedProjectMapSha256: hash(
      input.intendedProjectMapSha256,
      "intendedProjectMapSha256",
    ),
    publishedConfigSha256: nullableHash(input.publishedConfigSha256, "publishedConfigSha256"),
    publishedProjectMapSha256: nullableHash(
      input.publishedProjectMapSha256,
      "publishedProjectMapSha256",
    ),
    recoveryReference: parseRecoveryReference(input.recoveryReference),
    sourceState: parseStateWitness(input.sourceState, "source state"),
    targetState: parseStateWitness(input.targetState, "target state"),
    projects,
  };
  if (
    typeof input.checksumSha256 !== "string"
    || input.checksumSha256 !== sha256(payloadContent(payload))
  ) {
    return fail("checksum-mismatch", "backend publication journal checksum does not match");
  }
  const journal = { ...payload, checksumSha256: input.checksumSha256 };
  assertJournalSemantics(journal);
  return journal;
}

function everyFence(
  journal: BackendPublicationJournal,
  predicate: (fence: BackendPublicationFenceRecord) => boolean,
): boolean {
  return journal.projects.every(({ fence }) => fence !== null && predicate(fence));
}

function assertJournalSemantics(journal: BackendPublicationJournal): void {
  if (journal.sourceBackend === journal.targetBackend) {
    return fail("malformed-journal", "backend publication source and target must differ");
  }
  if (Date.parse(journal.updatedAt) < Date.parse(journal.createdAt)) {
    return fail("malformed-journal", "backend publication timestamps are out of order");
  }
  const fenceMatches = (fence: BackendPublicationFenceRecord): boolean =>
    fence.publicationId === journal.publicationId
    && fence.targetBackend === journal.targetBackend;
  if (
    (journal.recoveryReference === null) !== (journal.sourceState === null)
    || (journal.recoveryReference === null) !== (journal.targetState === null)
  ) {
    return fail("malformed-journal", "backend publication recovery evidence is incomplete");
  }
  if (journal.sourceState !== null && journal.targetState !== null) {
    if (
      (journal.sourceState.config.rawSha256 ?? sha256("{}"))
        !== journal.expectedConfigSha256
      || (journal.sourceState.projectMap.semanticSha256
        ?? backendPublicationCanonicalSha256({})) !== journal.expectedProjectMapSha256
      || (journal.targetState.config.rawSha256 ?? sha256("{}"))
        !== journal.intendedConfigSha256
      || (journal.targetState.projectMap.semanticSha256
        ?? backendPublicationCanonicalSha256({})) !== journal.intendedProjectMapSha256
    ) {
      return fail("malformed-journal", "backend publication state witnesses do not bind journal hashes");
    }
  }
  for (const { fence } of journal.projects) {
    if (fence === null) continue;
    const acquired = Date.parse(fence.acquiredAt);
    const renewed = Date.parse(fence.renewedAt);
    const expires = Date.parse(fence.expiresAt);
    const released = fence.releasedAt === null
      ? null
      : Date.parse(fence.releasedAt);
    if (
      renewed < acquired
      || expires <= renewed
      || (released !== null && released < renewed)
    ) {
      return fail("malformed-journal", "backend publication fence timestamps are out of order");
    }
  }
  switch (journal.phase) {
    case "prepared":
      if (journal.projects.some(({ fence }) => fence !== null)) {
        return fail("malformed-journal", "prepared publication unexpectedly has a remote fence");
      }
      break;
    case "acquiring":
      if (!journal.projects.every(({ fence }) =>
        fence === null || (fenceMatches(fence) && fence.releasedAt === null))) {
        return fail("malformed-journal", "acquiring publication has an invalid remote fence set");
      }
      break;
    case "guarded":
    case "map-published":
    case "config-published":
      if (!everyFence(journal, (fence) => fenceMatches(fence) && fence.releasedAt === null)) {
        return fail("malformed-journal", "active publication has an invalid remote fence set");
      }
      break;
    case "abort-prepared":
    case "config-restored":
    case "map-restored":
      if (!journal.projects.every(({ fence }) =>
        fence === null || (fenceMatches(fence) && fence.releasedAt === null))) {
        return fail("malformed-journal", "aborting publication has an invalid remote fence set");
      }
      break;
    case "abort-releasing":
      if (!journal.projects.every(({ fence }) =>
        fence === null || fenceMatches(fence))) {
        return fail("malformed-journal", "abort release has an invalid remote fence set");
      }
      break;
    case "releasing":
      if (!everyFence(journal, fenceMatches)) {
        return fail("malformed-journal", "release has an invalid remote fence set");
      }
      break;
    case "released":
    case "completed":
      if (
        !everyFence(journal, (fence) =>
          fenceMatches(fence) && fence.releasedAt !== null)
      ) {
        return fail("malformed-journal", "released publication has an invalid remote fence set");
      }
      break;
    case "aborted":
      if (!journal.projects.every(({ fence }) => fence === null || (
        fenceMatches(fence) && fence.releasedAt !== null
      ))) {
        return fail("malformed-journal", "aborted publication retains an unresolved remote fence");
      }
      if (
        (journal.publishedProjectMapSha256 !== null
          && journal.publishedProjectMapSha256 !== journal.expectedProjectMapSha256)
        || (journal.publishedConfigSha256 !== null
          && journal.publishedConfigSha256 !== journal.expectedConfigSha256)
      ) {
        return fail("malformed-journal", "aborted publication does not prove restored local state");
      }
      break;
  }
  const expectedWitnesses = (() => {
    switch (journal.phase) {
      case "prepared":
      case "acquiring":
      case "guarded":
        return [null, null] as const;
      case "map-published":
        return [journal.intendedProjectMapSha256, null] as const;
      case "config-published":
      case "releasing":
      case "released":
      case "completed":
        return [
          journal.intendedProjectMapSha256,
          journal.intendedConfigSha256,
        ] as const;
      case "abort-prepared":
        return null;
      case "config-restored":
        return [journal.publishedProjectMapSha256, journal.expectedConfigSha256] as const;
      case "map-restored":
      case "abort-releasing":
      case "aborted":
        return [
          journal.expectedProjectMapSha256,
          journal.expectedConfigSha256,
        ] as const;
    }
  })();
  if (
    expectedWitnesses !== null
    && (
      journal.publishedProjectMapSha256 !== expectedWitnesses[0]
      || journal.publishedConfigSha256 !== expectedWitnesses[1]
    )
  ) {
    return fail("malformed-journal", "publication has phase-incompatible local witnesses");
  }
}

export function backendPublicationFenceRecord(
  fence: PostgreSqlBackendPublicationFence,
): BackendPublicationFenceRecord {
  return {
    projectId: fence.projectId,
    machineId: fence.machineId,
    publicationId: fence.publicationId,
    targetBackend: fence.targetBackend,
    evidenceSha256: fence.evidenceSha256,
    fencingToken: fence.fencingToken.toString(),
    acquiredAt: fence.acquiredAt,
    renewedAt: fence.renewedAt,
    expiresAt: fence.expiresAt,
    releasedAt: fence.releasedAt,
    databaseExpired: fence.databaseExpired,
  };
}

function readJournalAt(
  path: string,
  afterRead?: () => void,
  afterStat?: () => void,
): BackendPublicationJournal | null {
  try {
    return parseJournal(readJournalDescriptor(path, afterRead, afterStat));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      return fail("unsafe-storage", "backend publication journal is not a private regular file");
    }
    throw error;
  }
}

function assertPublicationHistory(homeDir?: string): void {
  const history = backendPublicationHistoryDirectory(homeDir);
  let entries: string[];
  try {
    assertPrivateDirectory(history);
    entries = readdirSync(history);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (entries.length > MAX_BACKEND_PUBLICATION_HISTORY_ENTRIES) {
    return fail("unsafe-storage", "backend publication history exceeds its entry bound");
  }
  for (const entry of entries) {
    const match = /^([A-Za-z0-9][A-Za-z0-9._:-]{0,127})-([0-9a-f]{64})\.json$/u.exec(entry);
    if (match === null) {
      return fail("unsafe-storage", "backend publication history contains unknown residue");
    }
    const archived = parseJournal(readJournalDescriptor(join(history, entry)));
    if (
      (archived.phase !== "completed" && archived.phase !== "aborted")
      || archived.publicationId !== match[1]
      || archived.checksumSha256 !== match[2]
    ) {
      return fail("malformed-journal", "backend publication history is not terminal evidence");
    }
  }
}

function assertPublicationStorageLayout(homeDir?: string): void {
  const directory = backendPublicationDirectory(homeDir);
  const entries = readdirSync(directory);
  for (const entry of entries) {
    if (entry !== "journal.json" && entry !== "history") {
      return fail("unsafe-storage", "backend publication storage contains unknown residue");
    }
  }
  assertPublicationHistory(homeDir);
}

function recoverJournalTemporaryFiles(homeDir?: string): void {
  const directory = backendPublicationDirectory(homeDir);
  let entries: string[];
  try {
    assertPrivateDirectory(directory);
    entries = readdirSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  let removed = false;
  for (const entry of entries) {
    if (!/^\.journal\.json\.[0-9a-f]{24}\.tmp$/u.test(entry)) continue;
    const path = join(directory, entry);
    assertPrivateJournal(path);
    unlinkSync(path);
    removed = true;
  }
  if (removed) syncDirectory(directory);
}

function hasBackendPublicationEvidence(homeDir?: string): boolean {
  const directory = backendPublicationDirectory(homeDir);
  if (!publicationStorageExists(homeDir)) return false;
  assertPrivateDirectory(rootPath(homeDir));
  assertPrivateDirectory(directory);
  assertPublicationStorageLayout(homeDir);
  const entries = readdirSync(directory);
  return entries.includes("journal.json")
    || (entries.includes("history")
      && readdirSync(backendPublicationHistoryDirectory(homeDir)).length > 0);
}

function preflightBackendPublicationPrepare(
  homeDir?: string,
): BackendPublicationJournal | null {
  if (!publicationStorageExists(homeDir)) return null;
  const directory = backendPublicationDirectory(homeDir);
  assertPrivateDirectory(directory);
  assertPublicationStorageLayout(homeDir);
  const existing = readJournalAt(backendPublicationJournalPath(homeDir));
  if (existing === null) {
    const entries = readdirSync(directory);
    if (
      entries.includes("history")
      && readdirSync(backendPublicationHistoryDirectory(homeDir)).length > 0
    ) {
      return fail(
        "publication-evidence-missing",
        "backend publication history has no active journal evidence",
      );
    }
    return null;
  }
  if (existing.phase !== "completed" && existing.phase !== "aborted") {
    return fail("unexpected-state", "an unresolved backend publication already exists");
  }
  assertTerminalArchiveCapacity(existing, homeDir);
  return existing;
}

export function readBackendPublicationJournal(
  homeDir?: string,
  afterRead?: () => void,
  /** @internal Deterministic descriptor-growth seam for tests. */
  afterStat?: () => void,
): BackendPublicationJournal | null {
  const directory = backendPublicationDirectory(homeDir);
  try {
    assertPrivateDirectory(rootPath(homeDir));
    assertPrivateDirectory(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  assertPublicationStorageLayout(homeDir);
  return readJournalAt(backendPublicationJournalPath(homeDir), afterRead, afterStat);
}

function writeJournal(
  journal: BackendPublicationJournal,
  homeDir: string | undefined,
  observer: BackendPublicationObserver,
): void {
  const directory = ensurePublicationDirectory(homeDir);
  const path = backendPublicationJournalPath(homeDir);
  atomicWritePrivateFile(path, journalContent(journal), {
    rename: (source, destination) => {
      observer("before-journal-rename", path);
      renameSync(source, destination);
      observer("after-journal-rename", path);
    },
  });
  assertPrivateJournal(path);
  observer("before-journal-directory-fsync", path);
  syncDirectory(directory);
  observer("after-journal-directory-fsync", path);
}

function withJournalLock<T>(
  homeDir: string | undefined,
  observer: BackendPublicationObserver,
  callback: () => T,
  normalizeLegacyRoot = false,
): T {
  if (normalizeLegacyRoot) ensureLegacyRootForConsumer(homeDir);
  else ensurePrivateDirectoryExact(rootPath(homeDir));
  const path = backendPublicationLockPath(homeDir);
  if (journalLockContext.getStore() === path) return callback();
  observer("before-journal-lock", path);
  return withPrivateMutationLock(path, "backend publication", () => {
    observer("after-journal-lock", path);
    return journalLockContext.run(path, callback);
  });
}

async function withJournalLockAsync<T>(
  homeDir: string | undefined,
  observer: BackendPublicationObserver,
  callback: () => Promise<T>,
): Promise<T> {
  ensurePrivateDirectoryExact(rootPath(homeDir));
  const path = backendPublicationLockPath(homeDir);
  if (journalLockContext.getStore() === path) return callback();
  observer("before-journal-lock", path);
  return withPrivateMutationLockAsync(path, "backend publication", async () => {
    observer("after-journal-lock", path);
    return journalLockContext.run(path, callback);
  });
}

/**
 * Low-level legacy journal primitive. It binds caller-supplied hashes but
 * cannot authenticate config bytes or project-map coverage. Production
 * backend changes must use BackendPublicationCoordinator.prepare().
 */
export function prepareBackendPublication(
  input: {
    readonly publicationId: string;
    readonly sourceBackend: StorageBackendName;
    readonly targetBackend: StorageBackendName;
    readonly expectedConfigSha256: string;
    readonly expectedProjectMapSha256: string;
    readonly intendedConfigSha256: string;
    readonly intendedProjectMapSha256: string;
    readonly recoveryReference?: BackendPublicationRecoveryReference;
    readonly sourceState?: BackendPublicationStateWitness;
    readonly targetState?: BackendPublicationStateWitness;
    readonly projects: readonly Omit<BackendPublicationProjectRecord, "fence">[];
    readonly now?: Date;
    readonly homeDir?: string;
    readonly observer?: BackendPublicationObserver;
  },
): BackendPublicationJournal {
  const observer = input.observer ?? NOOP_OBSERVER;
  return withJournalLock(input.homeDir, observer, () => {
    const existing = preflightBackendPublicationPrepare(input.homeDir);
    if (
      backendPublicationConfigSha256(input.homeDir)
        !== input.expectedConfigSha256
      || backendPublicationProjectMapSha256(input.homeDir)
        !== input.expectedProjectMapSha256
    ) {
      return fail(
        "unexpected-state",
        "backend publication preimage does not match current config and project map",
      );
    }
    if (existing !== null) archiveTerminalJournal(existing, input.homeDir);
    const now = (input.now ?? new Date()).toISOString();
    const payload: JournalPayload = {
      version: BACKEND_PUBLICATION_JOURNAL_VERSION,
      publicationId: input.publicationId,
      sourceBackend: input.sourceBackend,
      targetBackend: input.targetBackend,
      phase: "prepared",
      createdAt: now,
      updatedAt: now,
      expectedConfigSha256: input.expectedConfigSha256,
      expectedProjectMapSha256: input.expectedProjectMapSha256,
      intendedConfigSha256: input.intendedConfigSha256,
      intendedProjectMapSha256: input.intendedProjectMapSha256,
      publishedConfigSha256: null,
      publishedProjectMapSha256: null,
      recoveryReference: input.recoveryReference ?? null,
      sourceState: input.sourceState ?? null,
      targetState: input.targetState ?? null,
      projects: [...input.projects]
        .sort((left, right) => left.localProjectId.localeCompare(right.localProjectId))
        .map((project) => ({ ...project, fence: null })),
    };
    // Reuse the strict parser as the single input validator.
    const journal = parseJournal(journalContent(journalFromPayload(payload)));
    writeJournal(journal, input.homeDir, observer);
    return journal;
  });
}

const ALLOWED_TRANSITIONS: Readonly<Record<BackendPublicationPhase, readonly BackendPublicationPhase[]>> = {
  prepared: ["acquiring", "abort-prepared"],
  acquiring: ["acquiring", "guarded", "abort-prepared"],
  guarded: ["map-published", "abort-prepared"],
  "map-published": ["config-published", "abort-prepared"],
  "config-published": ["releasing", "abort-prepared"],
  releasing: ["releasing", "released"],
  released: ["completed"],
  "abort-prepared": ["config-restored"],
  "config-restored": ["map-restored"],
  "map-restored": ["abort-releasing"],
  "abort-releasing": ["abort-releasing", "aborted"],
  completed: [],
  aborted: [],
};

function assertProjectTransition(
  current: BackendPublicationJournal,
  projects: readonly BackendPublicationProjectRecord[],
  nextPhase: BackendPublicationPhase,
): void {
  if (projects.length !== current.projects.length) {
    return fail("unexpected-state", "backend publication project coverage changed");
  }
  current.projects.forEach((before, index) => {
    const after = projects[index];
    if (
      after === undefined
      || before.localProjectId !== after.localProjectId
      || before.remoteProjectId !== after.remoteProjectId
      || before.evidenceSha256 !== after.evidenceSha256
    ) {
      return fail("unexpected-state", "backend publication project identity changed");
    }
    if (before.fence === null) {
      if (
        after.fence !== null
        && nextPhase !== "acquiring"
        && nextPhase !== "guarded"
        && nextPhase !== "abort-prepared"
      ) {
        return fail("unexpected-state", "backend publication introduced a fence in the wrong phase");
      }
      return;
    }
    if (after.fence === null) {
      return fail("unexpected-state", "backend publication discarded remote fence evidence");
    }
    for (const field of [
      "projectId",
      "machineId",
      "publicationId",
      "targetBackend",
      "evidenceSha256",
    ] as const) {
      if (before.fence[field] !== after.fence[field]) {
        return fail("unexpected-state", "backend publication remote fence identity changed");
      }
    }
    const beforeToken = BigInt(before.fence.fencingToken);
    const afterToken = BigInt(after.fence.fencingToken);
    if (afterToken < beforeToken) {
      return fail("unexpected-state", "backend publication fencing token regressed");
    }
    if (
      afterToken === beforeToken
      && before.fence.acquiredAt !== after.fence.acquiredAt
    ) {
      return fail("unexpected-state", "backend publication changed a fence acquisition witness");
    }
    if (Date.parse(after.fence.renewedAt) < Date.parse(before.fence.renewedAt)) {
      return fail("unexpected-state", "backend publication fence renewal regressed");
    }
    if (
      before.fence.releasedAt !== null
      && after.fence.releasedAt !== before.fence.releasedAt
    ) {
      return fail("unexpected-state", "backend publication fence release witness changed");
    }
    if (
      before.fence.releasedAt === null
      && after.fence.releasedAt !== null
      && nextPhase !== "releasing"
      && nextPhase !== "released"
      && nextPhase !== "abort-releasing"
      && nextPhase !== "aborted"
    ) {
      return fail("unexpected-state", "backend publication released a fence in the wrong phase");
    }
  });
}

function assertLocalStateForTransition(
  current: BackendPublicationJournal,
  nextPhase: BackendPublicationPhase,
  homeDir?: string,
): void {
  const config = backendPublicationConfigSha256(homeDir);
  const map = backendPublicationProjectMapSha256(homeDir);
  const exact = (expectedConfig: string, expectedMap: string): void => {
    if (config !== expectedConfig || map !== expectedMap) {
      return fail("unexpected-state", "backend publication local state does not match its phase");
    }
  };
  switch (nextPhase) {
    case "acquiring":
    case "guarded":
      return exact(current.expectedConfigSha256, current.expectedProjectMapSha256);
    case "map-published":
      return exact(current.expectedConfigSha256, current.intendedProjectMapSha256);
    case "config-published":
    case "releasing":
    case "released":
    case "completed":
      return exact(current.intendedConfigSha256, current.intendedProjectMapSha256);
    case "abort-prepared": {
      let allowed = false;
      switch (current.phase) {
        case "prepared":
          allowed = config === current.expectedConfigSha256
            && map === current.expectedProjectMapSha256;
          break;
        case "acquiring":
        case "guarded":
          allowed = config === current.expectedConfigSha256
            && (map === current.expectedProjectMapSha256
              || map === current.intendedProjectMapSha256);
          break;
        case "map-published":
          allowed = map === current.intendedProjectMapSha256
            && (config === current.expectedConfigSha256
              || config === current.intendedConfigSha256);
          break;
        case "config-published":
          allowed = config === current.intendedConfigSha256
            && map === current.intendedProjectMapSha256;
          break;
      }
      if (!allowed) {
        return fail("unexpected-state", "backend publication cannot bind abort intent to local state");
      }
      return;
    }
    case "config-restored":
      if (
        config !== current.expectedConfigSha256
        || (map !== current.expectedProjectMapSha256
          && map !== current.intendedProjectMapSha256)
      ) {
        return fail("unexpected-state", "backend publication config restoration is incomplete");
      }
      return;
    case "map-restored":
    case "abort-releasing":
    case "aborted":
      return exact(current.expectedConfigSha256, current.expectedProjectMapSha256);
  }
}

function transitionWitnesses(
  current: BackendPublicationJournal,
  input: {
    readonly phase: BackendPublicationPhase;
    readonly publishedConfigSha256?: string | null;
    readonly publishedProjectMapSha256?: string | null;
  },
): Pick<JournalPayload, "publishedConfigSha256" | "publishedProjectMapSha256"> {
  const configSupplied = input.publishedConfigSha256 !== undefined;
  const mapSupplied = input.publishedProjectMapSha256 !== undefined;
  switch (input.phase) {
    case "map-published":
      if (!mapSupplied || configSupplied
        || input.publishedProjectMapSha256 !== current.intendedProjectMapSha256) break;
      return {
        publishedProjectMapSha256: current.intendedProjectMapSha256,
        publishedConfigSha256: null,
      };
    case "config-published":
      if (!configSupplied || mapSupplied
        || input.publishedConfigSha256 !== current.intendedConfigSha256) break;
      return {
        publishedProjectMapSha256: current.intendedProjectMapSha256,
        publishedConfigSha256: current.intendedConfigSha256,
      };
    case "config-restored":
      if (!configSupplied || mapSupplied
        || input.publishedConfigSha256 !== current.expectedConfigSha256) break;
      return {
        publishedProjectMapSha256: current.publishedProjectMapSha256,
        publishedConfigSha256: current.expectedConfigSha256,
      };
    case "map-restored":
      if (!mapSupplied || configSupplied
        || input.publishedProjectMapSha256 !== current.expectedProjectMapSha256) break;
      return {
        publishedProjectMapSha256: current.expectedProjectMapSha256,
        publishedConfigSha256: current.expectedConfigSha256,
      };
    default:
      if (!configSupplied && !mapSupplied) {
        return {
          publishedProjectMapSha256: current.publishedProjectMapSha256,
          publishedConfigSha256: current.publishedConfigSha256,
        };
      }
  }
  return fail("unexpected-state", "backend publication supplied phase-incompatible witnesses");
}

export function advanceBackendPublication(
  input: {
    readonly publicationId: string;
    readonly expectedChecksumSha256: string;
    readonly phase: BackendPublicationPhase;
    readonly projects?: readonly BackendPublicationProjectRecord[];
    readonly publishedConfigSha256?: string | null;
    readonly publishedProjectMapSha256?: string | null;
    readonly now?: Date;
    readonly homeDir?: string;
    readonly observer?: BackendPublicationObserver;
  },
): BackendPublicationJournal {
  const observer = input.observer ?? NOOP_OBSERVER;
  return withJournalLock(input.homeDir, observer, () => {
    assertPublicationStorageLayout(input.homeDir);
    const current = readJournalAt(backendPublicationJournalPath(input.homeDir));
    if (
      current === null
      || current.publicationId !== input.publicationId
      || current.checksumSha256 !== input.expectedChecksumSha256
      || !ALLOWED_TRANSITIONS[current.phase].includes(input.phase)
    ) {
      return fail("unexpected-state", "backend publication transition does not match durable state");
    }
    const projects = input.projects ?? current.projects;
    assertProjectTransition(current, projects, input.phase);
    assertLocalStateForTransition(current, input.phase, input.homeDir);
    const witnesses = transitionWitnesses(current, input);
    const { checksumSha256: _checksumSha256, ...currentPayload } = current;
    const payload: JournalPayload = {
      ...currentPayload,
      phase: input.phase,
      updatedAt: (input.now ?? new Date()).toISOString(),
      projects,
      ...witnesses,
    };
    const next = parseJournal(journalContent(journalFromPayload(payload)));
    writeJournal(next, input.homeDir, observer);
    return next;
  });
}

export type BackendPublicationRemoteOperation = "acquire" | "release";

export type BackendPublicationDriverContext = {
  readonly homeDir: string | undefined;
  readonly journal: BackendPublicationJournal;
  readonly recoveryReference: BackendPublicationRecoveryReference;
  readonly material: BackendPublicationRecoveryMaterial;
};

export type BackendPublicationFileMutationContext =
  BackendPublicationDriverContext & {
    readonly file: BackendPublicationRecoveryFile;
    readonly expectedWitness: BackendPublicationFileWitness;
  };

export type BackendPublicationRemoteContext = {
  readonly homeDir: string | undefined;
  readonly journal: BackendPublicationJournal;
  readonly project: BackendPublicationProjectRecord;
};

export interface BackendPublicationDriver {
  sealRecoveryMaterial(input: {
    readonly homeDir: string | undefined;
    readonly publicationId: string;
    readonly material: BackendPublicationRecoveryMaterial;
    readonly sourceState: BackendPublicationStateWitness;
    readonly targetState: BackendPublicationStateWitness;
  }): Promise<BackendPublicationRecoveryReference>;
  authenticateRecoveryMaterial(input: {
    readonly homeDir: string | undefined;
    readonly journal: BackendPublicationJournal;
    readonly recoveryReference: BackendPublicationRecoveryReference;
  }): Promise<BackendPublicationRecoveryMaterial>;
  observeLocalState(input: BackendPublicationDriverContext): Promise<BackendPublicationStateWitness>;
  publishProjectMap(input: BackendPublicationFileMutationContext): Promise<BackendPublicationFileWitness>;
  publishConfig(input: BackendPublicationFileMutationContext): Promise<BackendPublicationFileWitness>;
  restoreConfig(input: BackendPublicationFileMutationContext): Promise<BackendPublicationFileWitness>;
  restoreProjectMap(input: BackendPublicationFileMutationContext): Promise<BackendPublicationFileWitness>;
  acquireRemoteGuard(input: BackendPublicationRemoteContext): Promise<BackendPublicationFenceRecord>;
  readRemoteGuard(
    input: BackendPublicationRemoteContext,
    operation: BackendPublicationRemoteOperation,
  ): Promise<BackendPublicationFenceRecord | null>;
  releaseRemoteGuard(input: BackendPublicationRemoteContext & {
    readonly fence: BackendPublicationFenceRecord;
  }): Promise<void>;
  retainCompletedMaterial(input: BackendPublicationDriverContext): Promise<void>;
  cleanupAbortedMaterial(input: {
    readonly homeDir: string | undefined;
    readonly journal: BackendPublicationJournal;
    readonly recoveryReference: BackendPublicationRecoveryReference;
  }): Promise<void>;
}

export type PrepareBackendPublicationInput = {
  readonly publicationId: string;
  readonly sourceBackend: StorageBackendName;
  readonly targetBackend: StorageBackendName;
  readonly material: BackendPublicationRecoveryMaterial;
  readonly projects: readonly Omit<BackendPublicationProjectRecord, "fence">[];
  readonly now?: Date;
};

type ValidatedPrepareBackendPublicationInput = PrepareBackendPublicationInput & {
  readonly now: Date;
};

function validateCoordinatorPrepareInput(
  input: PrepareBackendPublicationInput,
): {
  readonly input: ValidatedPrepareBackendPublicationInput;
  readonly witnesses: ReturnType<typeof backendPublicationMaterialWitness>;
} {
  if (
    input === null
    || typeof input !== "object"
    || !exactKeys(input as unknown as Record<string, unknown>, input.now === undefined
      ? ["publicationId", "sourceBackend", "targetBackend", "material", "projects"]
      : ["publicationId", "sourceBackend", "targetBackend", "material", "projects", "now"])
    || typeof input.publicationId !== "string"
    || !PUBLICATION_ID_PATTERN.test(input.publicationId)
    || (input.sourceBackend !== "sqlite" && input.sourceBackend !== "postgresql")
    || (input.targetBackend !== "sqlite" && input.targetBackend !== "postgresql")
    || input.sourceBackend === input.targetBackend
  ) {
    return fail("invalid-input", "backend publication coordinator input is invalid");
  }
  const now = input.now ?? new Date();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    return fail("invalid-input", "backend publication coordinator timestamp is invalid");
  }
  if (
    input.material === null
    || typeof input.material !== "object"
    || !exactKeys(input.material as unknown as Record<string, unknown>, ["source", "target"])
    || input.material.source === null
    || typeof input.material.source !== "object"
    || !exactKeys(input.material.source as unknown as Record<string, unknown>, [
      "config", "projectMap",
    ])
    || input.material.target === null
    || typeof input.material.target !== "object"
    || !exactKeys(input.material.target as unknown as Record<string, unknown>, [
      "config", "projectMap",
    ])
  ) {
    return fail("invalid-input", "backend publication recovery material is invalid");
  }
  for (const file of [
    input.material.source.config,
    input.material.source.projectMap,
    input.material.target.config,
    input.material.target.projectMap,
  ]) {
    if (
      file === null
      || typeof file !== "object"
      || (file.presence !== "absent" && file.presence !== "present")
      || !exactKeys(file as unknown as Record<string, unknown>, file.presence === "absent"
        ? ["presence"]
        : ["presence", "content", "mode", "uid", "gid"])
      || (file.presence === "present" && !(file.content instanceof Uint8Array))
    ) {
      return fail("invalid-input", "backend publication recovery file is invalid");
    }
  }
  const witnesses = backendPublicationMaterialWitness(input.material);
  const sourceConfigBackend = recoveryConfigBackend(
    input.material.source.config,
    "source config",
  );
  const targetConfigBackend = recoveryConfigBackend(
    input.material.target.config,
    "target config",
  );
  if (
    sourceConfigBackend !== input.sourceBackend
    || targetConfigBackend !== input.targetBackend
  ) {
    return fail(
      "backend-mismatch",
      "backend publication config material conflicts with declared backends",
    );
  }

  const sourceCoverage = recoveryProjectCoverage(
    input.material.source.projectMap,
    input.sourceBackend,
    "source project map",
  );
  const targetCoverage = recoveryProjectCoverage(
    input.material.target.projectMap,
    input.targetBackend,
    "target project map",
  );
  const union = new Map(sourceCoverage);
  for (const [localProjectId, remoteProjectId] of targetCoverage) {
    const sourceRemoteProjectId = sourceCoverage.get(localProjectId);
    if (
      sourceRemoteProjectId !== undefined
      && sourceRemoteProjectId !== remoteProjectId
    ) {
      return fail(
        "backend-mismatch",
        "backend publication changes a project's remote identity",
      );
    }
    union.set(localProjectId, remoteProjectId);
  }
  if (new Set(union.values()).size !== union.size) {
    return fail("invalid-input", "backend publication project coverage reuses a remote identity");
  }
  if (!Array.isArray(input.projects) || input.projects.length === 0) {
    return fail("invalid-input", "backend publication project coverage is empty");
  }
  for (const project of input.projects as readonly unknown[]) {
    if (
      project === null
      || typeof project !== "object"
      || !exactKeys(project as Record<string, unknown>, [
        "localProjectId", "remoteProjectId", "evidenceSha256",
      ])
      || typeof (project as Record<string, unknown>).localProjectId !== "string"
      || !HASH_PATTERN.test((project as Record<string, string>).localProjectId)
      || typeof (project as Record<string, unknown>).remoteProjectId !== "string"
      || !UUID_V7_PATTERN.test((project as Record<string, string>).remoteProjectId)
      || typeof (project as Record<string, unknown>).evidenceSha256 !== "string"
      || !HASH_PATTERN.test((project as Record<string, string>).evidenceSha256)
    ) {
      return fail("invalid-input", "backend publication project evidence is invalid");
    }
  }
  const projects = [...input.projects].sort((left, right) =>
    left.localProjectId.localeCompare(right.localProjectId));
  if (
    new Set(projects.map(({ localProjectId }) => localProjectId)).size !== projects.length
    || new Set(projects.map(({ remoteProjectId }) => remoteProjectId)).size !== projects.length
    || projects.length !== union.size
    || projects.some((project) =>
      union.get(project.localProjectId) !== project.remoteProjectId)
  ) {
    return fail(
      "backend-mismatch",
      "backend publication guards do not exactly cover recovery project maps",
    );
  }
  return {
    input: { ...input, now, projects },
    witnesses,
  };
}

type RecoverPendingOptions = {
  readonly disposition?: "resume" | "abort";
};

function sameWitness(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function assertExactWitness(
  actual: BackendPublicationFileWitness,
  expected: BackendPublicationFileWitness,
  field: string,
): void {
  if (!sameWitness(actual, expected)) {
    return fail("unexpected-state", `backend publication ${field} witness does not match`);
  }
}

function assertExactState(
  actual: BackendPublicationStateWitness,
  expected: BackendPublicationStateWitness,
  field: string,
): void {
  if (!sameWitness(actual, expected)) {
    return fail("unexpected-state", `backend publication ${field} state does not match`);
  }
}

function requireRecoveryEvidence(journal: BackendPublicationJournal): {
  readonly recoveryReference: BackendPublicationRecoveryReference;
  readonly sourceState: BackendPublicationStateWitness;
  readonly targetState: BackendPublicationStateWitness;
} {
  if (
    journal.recoveryReference === null
    || journal.sourceState === null
    || journal.targetState === null
  ) {
    return fail("publication-evidence-missing", "backend publication recovery evidence is missing");
  }
  return {
    recoveryReference: journal.recoveryReference,
    sourceState: journal.sourceState,
    targetState: journal.targetState,
  };
}

function legacyConfigHash(witness: BackendPublicationFileWitness): string {
  return witness.rawSha256 ?? sha256("{}");
}

function legacyMapHash(witness: BackendPublicationFileWitness): string {
  return witness.semanticSha256 ?? backendPublicationCanonicalSha256({});
}

function isPreReleasePhase(phase: BackendPublicationPhase): boolean {
  return [
    "prepared", "acquiring", "guarded", "map-published", "config-published",
    "abort-prepared", "config-restored", "map-restored", "abort-releasing",
  ].includes(phase);
}

function assertReleaseFenceIdentityContinuity(
  persisted: BackendPublicationFenceRecord,
  authoritative: BackendPublicationFenceRecord,
): void {
  for (const field of [
    "projectId",
    "machineId",
    "publicationId",
    "targetBackend",
    "evidenceSha256",
  ] as const) {
    if (authoritative[field] !== persisted[field]) {
      return fail(
        "unexpected-state",
        "backend publication remote release readback changed persisted fence identity",
      );
    }
  }
}

function assertExactReleaseFenceContinuity(
  persisted: BackendPublicationFenceRecord,
  authoritative: BackendPublicationFenceRecord,
): void {
  assertReleaseFenceIdentityContinuity(persisted, authoritative);
  if (
    authoritative.fencingToken !== persisted.fencingToken
    || authoritative.acquiredAt !== persisted.acquiredAt
  ) {
    return fail(
      "unexpected-state",
      "backend publication remote release readback changed persisted fence generation",
    );
  }
}

function isReleaseFenceSuccessor(
  persisted: BackendPublicationFenceRecord,
  authoritative: BackendPublicationFenceRecord,
): boolean {
  return BigInt(authoritative.fencingToken) > BigInt(persisted.fencingToken);
}

function assertUnreleasedReleaseFenceSuccessor(
  persisted: BackendPublicationFenceRecord,
  authoritative: BackendPublicationFenceRecord,
): void {
  assertReleaseFenceIdentityContinuity(persisted, authoritative);
  if (!isReleaseFenceSuccessor(persisted, authoritative)) {
    return fail(
      "unexpected-state",
      "backend publication remote reacquire did not advance the fence generation",
    );
  }
  if (authoritative.releasedAt !== null) {
    return fail(
      "unexpected-state",
      "backend publication remote successor was already released",
    );
  }
}

function assertActiveReleaseFenceSuccessor(
  persisted: BackendPublicationFenceRecord,
  authoritative: BackendPublicationFenceRecord,
): void {
  assertUnreleasedReleaseFenceSuccessor(persisted, authoritative);
  if (authoritative.databaseExpired) {
    return fail(
      "unexpected-state",
      "backend publication remote reacquire lacks an active successor",
    );
  }
}

/**
 * Crash-recoverable orchestration for one backend publication generation.
 * Driver callbacks own sensitive bytes; the durable journal stores only their
 * authenticated relative reference and immutable witnesses.
 */
export class BackendPublicationCoordinator {
  readonly #homeDir: string | undefined;
  readonly #driver: BackendPublicationDriver;
  readonly #observer: BackendPublicationObserver;

  constructor(input: {
    readonly homeDir?: string;
    readonly driver: BackendPublicationDriver;
    readonly observer?: BackendPublicationObserver;
  }) {
    this.#homeDir = input.homeDir;
    this.#driver = input.driver;
    this.#observer = input.observer ?? NOOP_OBSERVER;
  }

  async prepare(input: PrepareBackendPublicationInput): Promise<BackendPublicationJournal> {
    return this.#locked(async () => {
      preflightBackendPublicationPrepare(this.#homeDir);
      const validated = validateCoordinatorPrepareInput(input);
      const preparedInput = validated.input;
      const { witnesses } = validated;
      const observed = await this.#driver.observeLocalState({
        homeDir: this.#homeDir,
        journal: this.#prospectiveJournal(preparedInput, witnesses),
        recoveryReference: {
          relativePath: "pending",
          sealSha256: "0".repeat(64),
          byteLength: 0,
        },
        material: preparedInput.material,
      });
      assertExactState(observed, witnesses.source, "prepare source");
      this.#observe("before-material-seal", preparedInput.publicationId);
      const untrustedReference = await this.#driver.sealRecoveryMaterial({
        homeDir: this.#homeDir,
        publicationId: preparedInput.publicationId,
        material: preparedInput.material,
        sourceState: witnesses.source,
        targetState: witnesses.target,
      });
      this.#observe("after-material-seal", preparedInput.publicationId);
      const recoveryReference = parseRecoveryReference(untrustedReference);
      if (recoveryReference === null) {
        return fail("invalid-input", "backend publication recovery reference is missing");
      }
      return prepareBackendPublication({
        publicationId: preparedInput.publicationId,
        sourceBackend: preparedInput.sourceBackend,
        targetBackend: preparedInput.targetBackend,
        expectedConfigSha256: legacyConfigHash(witnesses.source.config),
        expectedProjectMapSha256: legacyMapHash(witnesses.source.projectMap),
        intendedConfigSha256: legacyConfigHash(witnesses.target.config),
        intendedProjectMapSha256: legacyMapHash(witnesses.target.projectMap),
        recoveryReference,
        sourceState: witnesses.source,
        targetState: witnesses.target,
        projects: preparedInput.projects,
        now: preparedInput.now,
        homeDir: this.#homeDir,
        observer: this.#observer,
      });
    });
  }

  async resume(): Promise<BackendPublicationJournal> {
    return this.#locked(async () => this.#resumeUnlocked());
  }

  async abort(): Promise<BackendPublicationJournal> {
    return this.#locked(async () => this.#abortUnlocked());
  }

  async recoverPending(
    options: RecoverPendingOptions = {},
  ): Promise<BackendPublicationJournal | null> {
    return this.#locked(async () => {
      const journal = readBackendPublicationJournal(this.#homeDir);
      if (journal === null) return null;
      if (journal.phase === "completed") {
        const context = await this.#materialContext(journal);
        await this.#retainMaterial(context);
        return journal;
      }
      if (journal.phase === "aborted") {
        await this.#cleanupMaterial(journal);
        return journal;
      }
      if (
        options.disposition === "abort"
        && journal.phase !== "releasing"
        && journal.phase !== "released"
      ) {
        return this.#abortUnlocked();
      }
      try {
        return await this.#resumeUnlocked();
      } catch (error) {
        const current = readBackendPublicationJournal(this.#homeDir);
        if (
          error instanceof BackendPublicationJournalError
          && error.reason === "unexpected-state"
          && current !== null
          && isPreReleasePhase(current.phase)
          && current.phase !== "abort-releasing"
        ) {
          return this.#abortUnlocked();
        }
        throw error;
      }
    });
  }

  #observe(event: Parameters<BackendPublicationObserver>[0], path: string): void {
    this.#observer(event, path);
  }

  async #locked<T>(callback: () => Promise<T>): Promise<T> {
    return withJournalLockAsync(this.#homeDir, this.#observer, async () => {
      recoverJournalTemporaryFiles(this.#homeDir);
      return callback();
    });
  }

  #prospectiveJournal(
    input: ValidatedPrepareBackendPublicationInput,
    witnesses: ReturnType<typeof backendPublicationMaterialWitness>,
  ): BackendPublicationJournal {
    const now = input.now.toISOString();
    return journalFromPayload({
      version: BACKEND_PUBLICATION_JOURNAL_VERSION,
      publicationId: input.publicationId,
      sourceBackend: input.sourceBackend,
      targetBackend: input.targetBackend,
      phase: "prepared",
      createdAt: now,
      updatedAt: now,
      expectedConfigSha256: legacyConfigHash(witnesses.source.config),
      expectedProjectMapSha256: legacyMapHash(witnesses.source.projectMap),
      intendedConfigSha256: legacyConfigHash(witnesses.target.config),
      intendedProjectMapSha256: legacyMapHash(witnesses.target.projectMap),
      publishedConfigSha256: null,
      publishedProjectMapSha256: null,
      recoveryReference: null,
      sourceState: witnesses.source,
      targetState: witnesses.target,
      projects: [...input.projects]
        .sort((left, right) => left.localProjectId.localeCompare(right.localProjectId))
        .map((project) => ({ ...project, fence: null })),
    });
  }

  async #materialContext(
    journal: BackendPublicationJournal,
  ): Promise<BackendPublicationDriverContext> {
    const evidence = requireRecoveryEvidence(journal);
    this.#observe("before-material-authenticate", evidence.recoveryReference.relativePath);
    const material = await this.#driver.authenticateRecoveryMaterial({
      homeDir: this.#homeDir,
      journal,
      recoveryReference: evidence.recoveryReference,
    });
    this.#observe("after-material-authenticate", evidence.recoveryReference.relativePath);
    const witnesses = backendPublicationMaterialWitness(material);
    assertExactState(witnesses.source, evidence.sourceState, "authenticated source");
    assertExactState(witnesses.target, evidence.targetState, "authenticated target");
    return {
      homeDir: this.#homeDir,
      journal,
      recoveryReference: evidence.recoveryReference,
      material,
    };
  }

  async #observed(context: BackendPublicationDriverContext): Promise<BackendPublicationStateWitness> {
    const observed = await this.#driver.observeLocalState(context);
    const parsed = parseStateWitness(observed, "observed state");
    if (parsed === null) {
      return fail("unexpected-state", "backend publication driver omitted observed state");
    }
    return parsed;
  }

  async #readRemote(
    journal: BackendPublicationJournal,
    project: BackendPublicationProjectRecord,
    operation: BackendPublicationRemoteOperation,
  ): Promise<BackendPublicationFenceRecord | null> {
    this.#observe("before-remote-read", project.remoteProjectId);
    const untrusted = await this.#driver.readRemoteGuard({
      homeDir: this.#homeDir,
      journal,
      project,
    }, operation);
    this.#observe("after-remote-read", project.remoteProjectId);
    const result = parseFence(untrusted, project);
    if (result !== null && (
      result.publicationId !== journal.publicationId
      || result.targetBackend !== journal.targetBackend
    )) {
      return fail("unexpected-state", "backend publication remote readback has the wrong identity");
    }
    return result;
  }

  async #acquireAll(journal: BackendPublicationJournal): Promise<BackendPublicationJournal> {
    let current = journal;
    for (let index = 0; index < current.projects.length; index += 1) {
      const project = current.projects[index]!;
      let authoritative = await this.#readRemote(current, project, "acquire");
      const usable = authoritative !== null
        && authoritative.releasedAt === null
        && !authoritative.databaseExpired
        && (project.fence === null
          || (authoritative.machineId === project.fence.machineId
            && BigInt(authoritative.fencingToken) >= BigInt(project.fence.fencingToken)));
      if (!usable) {
        this.#observe("before-remote-acquire", project.remoteProjectId);
        await this.#driver.acquireRemoteGuard({
          homeDir: this.#homeDir,
          journal: current,
          project,
        });
        this.#observe("after-remote-acquire", project.remoteProjectId);
        authoritative = await this.#readRemote(current, project, "acquire");
      }
      if (
        authoritative === null
        || authoritative.releasedAt !== null
        || authoritative.databaseExpired
      ) {
        return fail("unexpected-state", "backend publication remote acquire lacks active readback");
      }
      const projects = current.projects.map((entry, entryIndex) =>
        entryIndex === index ? { ...entry, fence: authoritative } : entry);
      current = advanceBackendPublication({
        publicationId: current.publicationId,
        expectedChecksumSha256: current.checksumSha256,
        phase: "acquiring",
        projects,
        homeDir: this.#homeDir,
        observer: this.#observer,
      });
    }
    return advanceBackendPublication({
      publicationId: current.publicationId,
      expectedChecksumSha256: current.checksumSha256,
      phase: "guarded",
      homeDir: this.#homeDir,
      observer: this.#observer,
    });
  }

  async #releaseAll(
    journal: BackendPublicationJournal,
    aborting: boolean,
  ): Promise<BackendPublicationJournal> {
    let current = journal;
    const phase: BackendPublicationPhase = aborting ? "abort-releasing" : "releasing";
    for (let index = 0; index < current.projects.length; index += 1) {
      let project = current.projects[index]!;
      if (project.fence === null) continue;
      let authoritative = await this.#readRemote(current, project, "release");
      if (authoritative === null) {
        return fail("unexpected-state", "backend publication remote release evidence is missing");
      }
      let persisted = project.fence;

      const checkpointSuccessor = (
        successor: BackendPublicationFenceRecord,
      ): BackendPublicationJournal => {
        const projects = current.projects.map((entry, entryIndex) =>
          entryIndex === index ? { ...entry, fence: successor } : entry);
        this.#observe("before-release-fence-checkpoint", project.remoteProjectId);
        const checkpointed = advanceBackendPublication({
          publicationId: current.publicationId,
          expectedChecksumSha256: current.checksumSha256,
          phase,
          projects,
          homeDir: this.#homeDir,
          observer: this.#observer,
        });
        this.#observe("after-release-fence-checkpoint", project.remoteProjectId);
        return checkpointed;
      };

      if (isReleaseFenceSuccessor(persisted, authoritative)) {
        assertUnreleasedReleaseFenceSuccessor(persisted, authoritative);
        current = checkpointSuccessor(authoritative);
        project = current.projects[index]!;
        persisted = project.fence!;
      } else {
        assertExactReleaseFenceContinuity(persisted, authoritative);
      }

      if (authoritative.releasedAt === null && authoritative.databaseExpired) {
        this.#observe("before-remote-reacquire", project.remoteProjectId);
        await this.#driver.acquireRemoteGuard({
          homeDir: this.#homeDir,
          journal: current,
          project,
        });
        this.#observe("after-remote-reacquire", project.remoteProjectId);
        this.#observe("before-remote-successor-read", project.remoteProjectId);
        const successor = await this.#readRemote(current, project, "release");
        this.#observe("after-remote-successor-read", project.remoteProjectId);
        if (successor === null) {
          return fail(
            "unexpected-state",
            "backend publication remote reacquire evidence is missing",
          );
        }
        assertActiveReleaseFenceSuccessor(persisted, successor);
        current = checkpointSuccessor(successor);
        project = current.projects[index]!;
        persisted = project.fence!;
        authoritative = successor;
      }

      if (authoritative.releasedAt === null) {
        this.#observe("before-remote-release", project.remoteProjectId);
        await this.#driver.releaseRemoteGuard({
          homeDir: this.#homeDir,
          journal: current,
          project,
          fence: authoritative,
        });
        this.#observe("after-remote-release", project.remoteProjectId);
        authoritative = await this.#readRemote(current, project, "release");
      }
      if (authoritative === null || authoritative.releasedAt === null) {
        return fail("unexpected-state", "backend publication remote release lacks readback");
      }
      assertExactReleaseFenceContinuity(persisted, authoritative);
      const projects = current.projects.map((entry, entryIndex) =>
        entryIndex === index ? { ...entry, fence: authoritative } : entry);
      current = advanceBackendPublication({
        publicationId: current.publicationId,
        expectedChecksumSha256: current.checksumSha256,
        phase,
        projects,
        homeDir: this.#homeDir,
        observer: this.#observer,
      });
    }
    return advanceBackendPublication({
      publicationId: current.publicationId,
      expectedChecksumSha256: current.checksumSha256,
      phase: aborting ? "aborted" : "released",
      homeDir: this.#homeDir,
      observer: this.#observer,
    });
  }

  async #mutateLocal(
    context: BackendPublicationDriverContext,
    input: {
      readonly access: PublicationPermit["access"];
      readonly event: "map-publish" | "config-publish" | "config-restore" | "map-restore";
      readonly file: BackendPublicationRecoveryFile;
      readonly expectedWitness: BackendPublicationFileWitness;
      readonly callback: (input: BackendPublicationFileMutationContext) =>
        Promise<BackendPublicationFileWitness>;
      readonly stateSha256: string;
    },
  ): Promise<void> {
    const beforeEvent = `before-${input.event}` as Parameters<BackendPublicationObserver>[0];
    const afterEvent = `after-${input.event}` as Parameters<BackendPublicationObserver>[0];
    this.#observe(beforeEvent, context.recoveryReference.relativePath);
    const actual = await withBackendPublicationPermit({
      publicationId: context.journal.publicationId,
      expectedChecksumSha256: context.journal.checksumSha256,
      access: input.access,
      stateSha256: input.stateSha256,
      homeDir: this.#homeDir,
    }, () => input.callback({
      ...context,
      file: input.file,
      expectedWitness: input.expectedWitness,
    }));
    this.#observe(afterEvent, context.recoveryReference.relativePath);
    assertExactWitness(actual, input.expectedWitness, input.event);
  }

  async #retainMaterial(context: BackendPublicationDriverContext): Promise<void> {
    this.#observe("before-material-retain", context.recoveryReference.relativePath);
    await this.#driver.retainCompletedMaterial(context);
    this.#observe("after-material-retain", context.recoveryReference.relativePath);
  }

  async #cleanupMaterial(journal: BackendPublicationJournal): Promise<void> {
    const { recoveryReference } = requireRecoveryEvidence(journal);
    this.#observe("before-material-cleanup", recoveryReference.relativePath);
    await this.#driver.cleanupAbortedMaterial({
      homeDir: this.#homeDir,
      journal,
      recoveryReference,
    });
    this.#observe("after-material-cleanup", recoveryReference.relativePath);
  }

  async #resumeUnlocked(): Promise<BackendPublicationJournal> {
    let journal = readBackendPublicationJournal(this.#homeDir);
    if (journal === null) {
      return fail("publication-evidence-missing", "backend publication journal is missing");
    }
    if (journal.phase === "aborted") return journal;
    if (journal.phase === "completed") return journal;
    if (["abort-prepared", "config-restored", "map-restored", "abort-releasing"].includes(
      journal.phase,
    )) {
      return this.#abortUnlocked();
    }
    if (journal.phase === "prepared") {
      journal = advanceBackendPublication({
        publicationId: journal.publicationId,
        expectedChecksumSha256: journal.checksumSha256,
        phase: "acquiring",
        homeDir: this.#homeDir,
        observer: this.#observer,
      });
    }
    if (journal.phase === "acquiring") journal = await this.#acquireAll(journal);
    if (journal.phase === "guarded") {
      const context = await this.#materialContext(journal);
      const evidence = requireRecoveryEvidence(journal);
      let observed = await this.#observed(context);
      assertExactWitness(observed.config, evidence.sourceState.config, "guarded config");
      if (sameWitness(observed.projectMap, evidence.sourceState.projectMap)) {
        await this.#mutateLocal(context, {
          access: "publish-project-map",
          event: "map-publish",
          file: context.material.target.projectMap,
          expectedWitness: evidence.targetState.projectMap,
          callback: (input) => this.#driver.publishProjectMap(input),
          stateSha256: legacyMapHash(evidence.targetState.projectMap),
        });
        observed = await this.#observed(context);
      }
      assertExactWitness(observed.projectMap, evidence.targetState.projectMap, "published map");
      journal = advanceBackendPublication({
        publicationId: journal.publicationId,
        expectedChecksumSha256: journal.checksumSha256,
        phase: "map-published",
        publishedProjectMapSha256: journal.intendedProjectMapSha256,
        homeDir: this.#homeDir,
        observer: this.#observer,
      });
    }
    if (journal.phase === "map-published") {
      const context = await this.#materialContext(journal);
      const evidence = requireRecoveryEvidence(journal);
      let observed = await this.#observed(context);
      assertExactWitness(observed.projectMap, evidence.targetState.projectMap, "published map");
      if (sameWitness(observed.config, evidence.sourceState.config)) {
        await this.#mutateLocal(context, {
          access: "publish-config",
          event: "config-publish",
          file: context.material.target.config,
          expectedWitness: evidence.targetState.config,
          callback: (input) => this.#driver.publishConfig(input),
          stateSha256: legacyConfigHash(evidence.targetState.config),
        });
        observed = await this.#observed(context);
      }
      assertExactWitness(observed.config, evidence.targetState.config, "published config");
      journal = advanceBackendPublication({
        publicationId: journal.publicationId,
        expectedChecksumSha256: journal.checksumSha256,
        phase: "config-published",
        publishedConfigSha256: journal.intendedConfigSha256,
        homeDir: this.#homeDir,
        observer: this.#observer,
      });
    }
    if (journal.phase === "config-published") {
      journal = advanceBackendPublication({
        publicationId: journal.publicationId,
        expectedChecksumSha256: journal.checksumSha256,
        phase: "releasing",
        homeDir: this.#homeDir,
        observer: this.#observer,
      });
    }
    if (journal.phase === "releasing") journal = await this.#releaseAll(journal, false);
    const context = await this.#materialContext(journal);
    await this.#retainMaterial(context);
    journal = advanceBackendPublication({
      publicationId: journal.publicationId,
      expectedChecksumSha256: journal.checksumSha256,
      phase: "completed",
      homeDir: this.#homeDir,
      observer: this.#observer,
    });
    return journal;
  }

  async #abortUnlocked(): Promise<BackendPublicationJournal> {
    let journal = readBackendPublicationJournal(this.#homeDir);
    if (journal === null) {
      return fail("publication-evidence-missing", "backend publication journal is missing");
    }
    if (journal.phase === "completed") return journal;
    if (journal.phase === "aborted") {
      await this.#cleanupMaterial(journal);
      return journal;
    }
    if (journal.phase === "releasing" || journal.phase === "released") {
      return this.#resumeUnlocked();
    }
    if (!["abort-prepared", "config-restored", "map-restored", "abort-releasing"].includes(
      journal.phase,
    )) {
      journal = advanceBackendPublication({
        publicationId: journal.publicationId,
        expectedChecksumSha256: journal.checksumSha256,
        phase: "abort-prepared",
        homeDir: this.#homeDir,
        observer: this.#observer,
      });
    }
    if (journal.phase === "abort-prepared") {
      const context = await this.#materialContext(journal);
      const evidence = requireRecoveryEvidence(journal);
      let observed = await this.#observed(context);
      if (!sameWitness(observed.config, evidence.sourceState.config)) {
        await this.#mutateLocal(context, {
          access: "restore-config",
          event: "config-restore",
          file: context.material.source.config,
          expectedWitness: evidence.sourceState.config,
          callback: (input) => this.#driver.restoreConfig(input),
          stateSha256: legacyConfigHash(evidence.sourceState.config),
        });
        observed = await this.#observed(context);
      }
      assertExactWitness(observed.config, evidence.sourceState.config, "restored config");
      journal = advanceBackendPublication({
        publicationId: journal.publicationId,
        expectedChecksumSha256: journal.checksumSha256,
        phase: "config-restored",
        publishedConfigSha256: journal.expectedConfigSha256,
        homeDir: this.#homeDir,
        observer: this.#observer,
      });
    }
    if (journal.phase === "config-restored") {
      const context = await this.#materialContext(journal);
      const evidence = requireRecoveryEvidence(journal);
      let observed = await this.#observed(context);
      if (!sameWitness(observed.projectMap, evidence.sourceState.projectMap)) {
        await this.#mutateLocal(context, {
          access: "restore-project-map",
          event: "map-restore",
          file: context.material.source.projectMap,
          expectedWitness: evidence.sourceState.projectMap,
          callback: (input) => this.#driver.restoreProjectMap(input),
          stateSha256: legacyMapHash(evidence.sourceState.projectMap),
        });
        observed = await this.#observed(context);
      }
      assertExactWitness(observed.projectMap, evidence.sourceState.projectMap, "restored map");
      journal = advanceBackendPublication({
        publicationId: journal.publicationId,
        expectedChecksumSha256: journal.checksumSha256,
        phase: "map-restored",
        publishedProjectMapSha256: journal.expectedProjectMapSha256,
        homeDir: this.#homeDir,
        observer: this.#observer,
      });
    }
    if (journal.phase === "map-restored") {
      journal = advanceBackendPublication({
        publicationId: journal.publicationId,
        expectedChecksumSha256: journal.checksumSha256,
        phase: "abort-releasing",
        homeDir: this.#homeDir,
        observer: this.#observer,
      });
    }
    journal = await this.#releaseAll(journal, true);
    await this.#cleanupMaterial(journal);
    return journal;
  }
}

function assertBackendPublicationConsumerAccessUnlocked(
  options: {
    readonly backend?: StorageBackendName;
    readonly homeDir?: string;
  } = {},
): void {
  const journal = readBackendPublicationJournal(options.homeDir);
  if (journal === null) {
    if (!hasBackendPublicationEvidence(options.homeDir)) {
      if (options.backend !== "postgresql") return;
      return fail(
        "publication-evidence-missing",
        "PostgreSQL selection has no completed backend publication evidence",
      );
    }
    return fail(
      "publication-evidence-missing",
      "backend publication evidence is incomplete",
    );
  }
  const lcmRoot = rootPath(options.homeDir);
  const permit = publicationPermit.getStore();
  if (
    permit?.active === true
    && permit.lcmRoot === lcmRoot
    && permit.publicationId === journal.publicationId
    && permit.checksumSha256 === journal.checksumSha256
    && permit.phase === journal.phase
  ) {
    return;
  }
  if (journal.phase !== "completed" && journal.phase !== "aborted") {
    return fail(
      "unresolved-publication",
      "backend publication is unresolved; recover it before selecting storage",
    );
  }
  const expected = journal.phase === "completed"
    ? journal.targetBackend
    : journal.sourceBackend;
  if (options.backend !== undefined && options.backend !== expected) {
    return fail(
      "backend-mismatch",
      "stored backend does not match the completed publication journal",
    );
  }
}

export function assertBackendPublicationConsumerAccess(
  options: {
    readonly backend?: StorageBackendName;
    readonly homeDir?: string;
  } = {},
): void {
  return withBackendPublicationConsumerLock(options.homeDir, () =>
    assertBackendPublicationConsumerAccessUnlocked(options));
}

function permitForMutation(
  journal: BackendPublicationJournal,
  homeDir: string | undefined,
  access: PublicationPermit["access"],
  stateSha256: string,
): boolean {
  const permit = publicationPermit.getStore();
  return permit?.active === true
    && permit.lcmRoot === rootPath(homeDir)
    && permit.publicationId === journal.publicationId
    && permit.checksumSha256 === journal.checksumSha256
    && permit.phase === journal.phase
    && permit.access === access
    && permit.stateSha256 === stateSha256;
}

function assertContentWitness(
  content: string,
  witness: BackendPublicationFileWitness,
  field: string,
): void {
  if (
    witness.presence !== "present"
    || witness.rawSha256 !== sha256(content)
    || witness.byteLength !== Buffer.byteLength(content)
  ) {
    return fail("unexpected-state", `backend publication ${field} bytes do not match`);
  }
}

function assertCurrentConfigContent(
  homeDir: string,
  content: string | null,
): BackendPublicationFileWitness {
  const current = captureBackendPublicationState(homeDir).config;
  if (content === null) assertExactWitness(current, ABSENT_FILE_WITNESS, "current config");
  else assertContentWitness(content, current, "current config");
  return current;
}

function assertBackendPublicationConfigMutationUnlocked(
  homeDir: string,
  currentBackend: StorageBackendName,
  candidateBackend: StorageBackendName,
  candidateContent: string | null,
  currentContent?: string | null,
): void {
  const journal = readBackendPublicationJournal(homeDir);
  if (currentContent !== undefined) assertCurrentConfigContent(homeDir, currentContent);
  if (journal === null) {
    if (!hasBackendPublicationEvidence(homeDir)) {
      if (currentBackend !== candidateBackend && candidateBackend === "postgresql") {
        return fail(
          "publication-evidence-missing",
          "PostgreSQL backend selection requires publication control",
        );
      }
      return;
    }
    return fail("publication-evidence-missing", "backend publication evidence is incomplete");
  }
  if (journal.phase === "completed" || journal.phase === "aborted") {
    const expected = journal.phase === "completed"
      ? journal.targetBackend
      : journal.sourceBackend;
    if (candidateBackend !== expected) {
      return fail("backend-mismatch", "configuration mutation conflicts with publication evidence");
    }
    return;
  }
  const candidateSha256 = sha256(candidateContent ?? "{}");
  const access = journal.phase === "map-published"
    ? "publish-config"
    : journal.phase === "abort-prepared"
      ? "restore-config"
      : null;
  if (
    access === null
    || !permitForMutation(journal, homeDir, access, candidateSha256)
  ) {
    return fail("permit-mismatch", "configuration mutation lacks an exact publication permit");
  }
  const expectedBackend = access === "publish-config"
    ? journal.targetBackend
    : journal.sourceBackend;
  if (candidateBackend !== expectedBackend) {
    return fail(
      "backend-mismatch",
      "configuration candidate backend conflicts with publication evidence",
    );
  }
  const expected = access === "publish-config"
    ? journal.targetState?.config
    : journal.sourceState?.config;
  if (expected !== undefined) {
    if (candidateContent === null) {
      assertExactWitness(ABSENT_FILE_WITNESS, expected, "candidate config");
    } else {
      assertContentWitness(candidateContent, expected, "candidate config");
    }
  }
}

export function assertBackendPublicationConfigMutation(
  configPath: string,
  currentBackend: StorageBackendName,
  candidateBackend: StorageBackendName,
  candidateContent: string | null,
  currentContent?: string | null,
): void {
  const homeDir = backendPublicationHomeForConfigPath(configPath);
  if (homeDir === undefined) return;
  return withBackendPublicationConsumerLock(homeDir, () =>
    assertBackendPublicationConfigMutationUnlocked(
      homeDir,
      currentBackend,
      candidateBackend,
      candidateContent,
      currentContent,
    ));
}

function assertBackendPublicationProjectMapMutationUnlocked(
  map: unknown,
  homeDir?: string,
  candidateContent?: string | null,
): void {
  const journal = readBackendPublicationJournal(homeDir);
  if (journal === null) {
    if (!hasBackendPublicationEvidence(homeDir)) return;
    return fail("publication-evidence-missing", "backend publication evidence is incomplete");
  }
  if (journal.phase === "completed" || journal.phase === "aborted") return;
  const candidateSha256 = backendPublicationCanonicalSha256(map);
  const access = journal.phase === "guarded"
    ? "publish-project-map"
    : journal.phase === "config-restored"
      ? "restore-project-map"
      : null;
  if (
    access === null
    || !permitForMutation(journal, homeDir, access, candidateSha256)
  ) {
    return fail("permit-mismatch", "project-map mutation lacks an exact publication permit");
  }
  if (candidateContent !== undefined) {
    const expected = access === "publish-project-map"
      ? journal.targetState?.projectMap
      : journal.sourceState?.projectMap;
    if (expected !== undefined) {
      if (candidateContent === null) {
        assertExactWitness(ABSENT_FILE_WITNESS, expected, "candidate project map");
      } else {
        assertContentWitness(candidateContent, expected, "candidate project map");
        if (expected.semanticSha256 !== candidateSha256) {
          return fail("unexpected-state", "candidate project map semantics do not match");
        }
      }
    }
  }
}

export function assertBackendPublicationProjectMapMutation(
  map: unknown,
  homeDir?: string,
  candidateContent?: string | null,
): void {
  return withBackendPublicationConsumerLock(homeDir, () =>
    assertBackendPublicationProjectMapMutationUnlocked(map, homeDir, candidateContent));
}

export function assertBackendPublicationProjectMapAccess(input: {
  readonly homeDir?: string;
  readonly content: string | null;
  readonly map: unknown;
  readonly present: boolean;
}): void {
  return withBackendPublicationConsumerLock(input.homeDir, () => {
    assertBackendPublicationConsumerAccessUnlocked({ homeDir: input.homeDir });
    const journal = readBackendPublicationJournal(input.homeDir);
    if (journal === null && !hasBackendPublicationEvidence(input.homeDir)) return;
    const current = captureBackendPublicationState(input.homeDir).projectMap;
    if (!input.present || input.content === null) {
      if (input.present || input.content !== null) {
        return fail("unexpected-state", "project-map presence and content disagree");
      }
      assertExactWitness(current, ABSENT_FILE_WITNESS, "current project map");
    } else {
      assertContentWitness(input.content, current, "current project map");
      if (current.semanticSha256 !== backendPublicationCanonicalSha256(input.map)) {
        return fail("unexpected-state", "project-map bytes and parsed semantics disagree");
      }
    }
  });
}

export async function withBackendPublicationPermit<T>(
  input: {
    readonly publicationId: string;
    readonly expectedChecksumSha256: string;
    readonly access: PublicationPermit["access"];
    readonly stateSha256?: string;
    readonly homeDir?: string;
  },
  callback: () => T | Promise<T>,
): Promise<T> {
  return withJournalLockAsync(input.homeDir, NOOP_OBSERVER, async () => {
    const journal = readJournalAt(backendPublicationJournalPath(input.homeDir));
    const allowed = journal === null ? null : ({
      "read-recovery": [
        "prepared", "acquiring", "guarded", "map-published",
        "config-published", "abort-prepared", "config-restored",
        "map-restored", "abort-releasing", "releasing", "released",
      ],
      "publish-project-map": ["guarded"],
      "publish-config": ["map-published"],
      "restore-config": ["abort-prepared"],
      "restore-project-map": ["config-restored"],
    } as const)[input.access];
    const stateSha256 = input.stateSha256 ?? null;
    if (
      journal === null
      || journal.publicationId !== input.publicationId
      || journal.checksumSha256 !== input.expectedChecksumSha256
      || allowed === null
      || !(allowed as readonly BackendPublicationPhase[]).includes(journal.phase)
      || (input.access === "read-recovery"
        ? stateSha256 !== null
        : stateSha256 === null || !HASH_PATTERN.test(stateSha256))
    ) {
      return fail("permit-mismatch", "backend publication recovery permit does not match durable state");
    }
    const permit: PublicationPermit = {
      publicationId: journal.publicationId,
      checksumSha256: journal.checksumSha256,
      lcmRoot: rootPath(input.homeDir),
      phase: journal.phase,
      access: input.access,
      stateSha256,
      active: true,
    };
    try {
      return await publicationPermit.run(permit, callback);
    } finally {
      permit.active = false;
    }
  });
}

/** Serialize one synchronous local consumer with publication prepare/advance. */
export function withBackendPublicationConsumerLock<T>(
  homeDir: string | undefined,
  callback: () => T,
): T {
  return withJournalLock(homeDir, NOOP_OBSERVER, callback, true);
}

/** Serialize a canonical config read/write with publication prepare/advance. */
export function withBackendPublicationConfigLock<T>(
  configPath: string,
  callback: () => T,
): T {
  const homeDir = backendPublicationHomeForConfigPath(configPath);
  return homeDir === undefined
    ? callback()
    : withBackendPublicationConsumerLock(homeDir, () =>
      withPrivateMutationLock(
        `${resolve(configPath)}.lock`,
        "config file",
        callback,
      ));
}

/** Derive the home directory only for the canonical ~/.lcm/config.json shape. */
export function backendPublicationHomeForConfigPath(
  configPath: string,
): string | undefined {
  const canonicalConfigPath = resolve(configPath);
  const lcmRoot = dirname(canonicalConfigPath);
  return basename(canonicalConfigPath) === "config.json"
      && basename(lcmRoot) === ".lcm"
    ? dirname(lcmRoot)
    : undefined;
}

function assertBackendPublicationConfigAccessUnlocked(
  homeDir: string,
  backend: StorageBackendName,
  content?: string | null,
): void {
  const journal = readBackendPublicationJournal(homeDir);
  if (journal === null && !hasBackendPublicationEvidence(homeDir)) {
    if (backend === "postgresql") {
      return fail(
        "publication-evidence-missing",
        "PostgreSQL selection has no completed backend publication evidence",
      );
    }
    return;
  }
  assertBackendPublicationConsumerAccessUnlocked({ backend, homeDir });
  if (content !== undefined && journal !== null) {
    assertCurrentConfigContent(homeDir, content);
  }
}

export function assertBackendPublicationConfigAccess(
  configPath: string,
  backend: StorageBackendName,
  content?: string | null,
): void {
  const homeDir = backendPublicationHomeForConfigPath(configPath);
  if (homeDir === undefined) return;
  return withBackendPublicationConsumerLock(homeDir, () =>
    assertBackendPublicationConfigAccessUnlocked(homeDir, backend, content));
}
