import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  realpathSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { legacyLcmHomeDirname } from "./legacy-names.js";
import {
  assertBackendPublicationConsumerAccess,
  withBackendPublicationConsumerLock,
  type BackendPublicationLockToken,
} from "./storage/backend-publication.js";
import { readBoundedRegularFile } from "./security-files.js";

export const LCM_HOME_DIRNAME = ".lcm";
export const LEGACY_LCM_HOME_DIRNAME = legacyLcmHomeDirname();

const PRIVATE_ROOT_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MAX_MIGRATION_JOURNAL_BYTES = 64 * 1024;
const MAX_MIGRATION_FILE_BYTES = 4 * 1024 * 1024;
const MAX_MIGRATION_TREE_BYTES = 32 * 1024 * 1024;
const MAX_MIGRATION_TREE_ENTRIES = 8_192;
const MAX_MIGRATION_TREE_DEPTH = 32;
const MIGRATION_JOURNAL_VERSION = 1 as const;
const MIGRATION_JOURNAL_NAME = ".lcm-legacy-migration.json";
const OPERATION_ID_PATTERN = /^[a-f0-9]{48}$/u;

export type RuntimeHomeMigration = {
  migrated: boolean;
  from: string;
  to: string;
};

/** Result returned by the operator-assisted secure-root bootstrap. */
export type RuntimeHomeBootstrap = RuntimeHomeMigration & {
  created: boolean;
};

type BigIntFileStat = Readonly<{
  isDirectory: () => boolean;
  isFile: () => boolean;
  isSymbolicLink: () => boolean;
  mode: bigint;
  uid: bigint;
  gid: bigint;
  nlink: bigint;
  size: bigint;
  dev: bigint;
  ino: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}>;

type DirectoryWitness = Readonly<{
  dev: string;
  ino: string;
  uid: number;
  gid: number;
  mode: number;
}>;

type OpenDirectory = Readonly<{
  fd: number;
  witness: DirectoryWitness;
  close: () => void;
}>;

type Identity = Readonly<{ dev: string; ino: string }>;

type TreeWitness = Readonly<{
  identity: Identity;
  mode: number;
  uid: number;
  gid: number;
  hash: string;
}>;

type MigrationPhase = "planned" | "copying" | "published" | "removing";

type MigrationJournalPayload = Readonly<{
  version: typeof MIGRATION_JOURNAL_VERSION;
  phase: MigrationPhase;
  operationId: string;
  sourceName: string;
  targetName: string;
  stagingName: string;
  source: TreeWitness;
  target: TreeWitness | null;
  targetBaseHash: string | null;
}>;

type MigrationJournal = MigrationJournalPayload & Readonly<{
  checksumSha256: string;
}>;

type HomeTopology = Readonly<{
  parent: OpenDirectory;
  home: OpenDirectory;
}>;

type TreeBudget = {
  bytes: number;
  entries: number;
};

type TreeEntryKind = "directory" | "file";

type PublicationAdmission = Readonly<{
  topology: HomeTopology;
  withFinalLock: <T>(callback: (lockToken: BackendPublicationLockToken) => T) => T;
}>;

export function lcmHomeDir(homeDir: string = homedir()): string {
  return join(homeDir, LCM_HOME_DIRNAME);
}
export function legacyLcmHomeDir(homeDir: string = homedir()): string {
  return join(homeDir, LEGACY_LCM_HOME_DIRNAME);
}

export function lcmPath(...segments: string[]): string {
  return join(lcmHomeDir(), ...segments);
}

export function configPath(homeDir: string = homedir()): string {
  return join(lcmHomeDir(homeDir), "config.json");
}

export function daemonPidPath(homeDir: string = homedir()): string {
  return join(lcmHomeDir(homeDir), "daemon.pid");
}

export function daemonTokenPath(homeDir: string = homedir()): string {
  return join(lcmHomeDir(homeDir), "daemon.token");
}

export function projectsDir(homeDir: string = homedir()): string {
  return join(lcmHomeDir(homeDir), "projects");
}

export function tmpDir(homeDir: string = homedir()): string {
  return join(lcmHomeDir(homeDir), "tmp");
}

function currentUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function isUnsupportedDirectorySync(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "EINVAL" || code === "ENOTSUP" || code === "EOPNOTSUPP";
}

function syncDescriptorIfSupported(fd: number): void {
  try {
    fsyncSync(fd);
  } catch (error) {
    if (!isUnsupportedDirectorySync(error)) throw error;
  }
}

function statIdentity(stat: BigIntFileStat): Identity {
  return { dev: String(stat.dev), ino: String(stat.ino) };
}

function sameIdentity(left: Identity, right: Identity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function modeOf(stat: BigIntFileStat): number {
  return Number(stat.mode & 0o7777n);
}

function ownerMatches(stat: BigIntFileStat, allowSystemOwner = false): boolean {
  const uid = currentUid();
  const uidMatches = uid === undefined
    || Number(stat.uid) === uid
    || (allowSystemOwner && Number(stat.uid) === 0);
  // Group ownership does not grant access when the accepted home/root modes
  // remove group permissions; only the user owner is security-relevant here.
  return uidMatches;
}

type CanonicalJson = null | boolean | number | string | { [key: string]: CanonicalJson };

function canonicalJson(value: CanonicalJson): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  const record = value as Record<string, CanonicalJson>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function journalChecksum(payload: MigrationJournalPayload): string {
  return sha256(canonicalJson(payload as unknown as CanonicalJson));
}

function journalContent(journal: MigrationJournal): string {
  return `${canonicalJson(journal as unknown as CanonicalJson)}\n`;
}

function assertPathMatchesDirectory(handle: Pick<OpenDirectory, "fd">, path: string, label: string): void {
  const requested = resolve(path);
  const canonical = resolve(realpathForValidation(path));
  if (canonical !== requested) throw new Error(`${label} path is a symlink or non-canonical path`);
  const stat = fstatSync(handle.fd, { bigint: true }) as unknown as BigIntFileStat;
  const pathStat = statSync(canonical, { bigint: true }) as unknown as BigIntFileStat;
  if (!sameIdentity(statIdentity(stat), statIdentity(pathStat))) {
    throw new Error(`${label} changed during validation`);
  }
}

function realpathForValidation(path: string): string {
  // Kept as a tiny seam so tests can replace the filesystem implementation
  // without moving the descriptor-first ordering below.
  return requireRealpath(path);
}

function requireRealpath(path: string): string {
  return realpathSync(path);
}

function openDirectory(
  path: string,
  label: string,
  options: Readonly<{
    privateExact?: boolean;
    allowStickyParent?: boolean;
  }> = {},
): OpenDirectory {
  const fd = openSync(
    path,
    constants.O_RDONLY
      | (constants.O_DIRECTORY ?? 0)
      | (constants.O_NOFOLLOW ?? 0)
      | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const stat = fstatSync(fd, { bigint: true }) as unknown as BigIntFileStat;
    if (!stat.isDirectory()) throw new Error(`${label} is not a directory`);
    if (!ownerMatches(stat, options.allowStickyParent === true)) throw new Error(`${label} owner is not trusted`);
    const mode = modeOf(stat);
    if (options.privateExact === true && mode !== PRIVATE_ROOT_MODE) {
      throw new Error(`${label} must have exact mode 0700`);
    }
    if (options.privateExact !== true && (mode & 0o022) !== 0) {
      const stickyRoot = options.allowStickyParent === true
        && (mode & 0o1000) !== 0
        && Number(stat.uid) === 0;
      if (!stickyRoot) throw new Error(`${label} has unsafe writable mode`);
    }
    assertPathMatchesDirectory({ fd }, path, label);
    return {
      fd,
      witness: {
        dev: String(stat.dev),
        ino: String(stat.ino),
        uid: Number(stat.uid),
        gid: Number(stat.gid),
        mode,
      },
      close: () => {
        closeSync(fd);
      },
    };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function openHomeTopology(homeDir: string): HomeTopology {
  const absoluteHome = resolve(homeDir);
  const parent = openDirectory(dirname(absoluteHome), "home parent", { allowStickyParent: true });
  try {
    const home = openDirectory(absoluteHome, "home directory");
    return { parent, home };
  } catch (error) {
    parent.close();
    throw error;
  }
}

function openPrivateRoot(root: string): OpenDirectory {
  return openDirectory(root, "private LCM root", { privateExact: true });
}

function lstatIfPresent(path: string): BigIntFileStat | undefined {
  try {
    return lstatSync(path, { bigint: true }) as unknown as BigIntFileStat;
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

function assertRootParent(topology: HomeTopology, homeDir: string): void {
  assertPathMatchesDirectory(topology.home, homeDir, "home directory");
  assertPathMatchesDirectory(topology.parent, dirname(resolve(homeDir)), "home parent");
}

function createPrivateRoot(topology: HomeTopology, homeDir: string): { root: OpenDirectory; created: boolean } {
  const rootPath = lcmHomeDir(homeDir);
  const existing = lstatIfPresent(rootPath);
  if (existing !== undefined) {
    if (existing.isSymbolicLink() || !existing.isDirectory()) {
      throw new Error("private LCM root is not a directory");
    }
    return { root: openPrivateRoot(rootPath), created: false };
  }

  assertRootParent(topology, homeDir);
  let created = false;
  try {
    // This is deliberately non-recursive. The authenticated home descriptor
    // is the only accepted parent for the operator-assisted root creation.
    mkdirSync(rootPath, { mode: PRIVATE_ROOT_MODE });
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }

  const root = openPrivateRoot(rootPath);
  try {
    if (created) {
      // chmod(2) through the retained descriptor avoids a second pathname
      // lookup and makes umask differences converge to exact 0700.
      fchmodSync(root.fd, PRIVATE_ROOT_MODE);
      const checked = fstatSync(root.fd, { bigint: true }) as unknown as BigIntFileStat;
      if (modeOf(checked) !== PRIVATE_ROOT_MODE || !ownerMatches(checked)) {
        throw new Error("new private LCM root did not authenticate");
      }
      syncDescriptorIfSupported(root.fd);
      assertRootParent(topology, homeDir);
      syncDescriptorIfSupported(topology.home.fd);
      syncDescriptorIfSupported(topology.parent.fd);
    }
    return { root, created };
  } catch (error) {
    root.close();
    throw error;
  }
}

function updateHashPart(hash: ReturnType<typeof createHash>, label: string, value: string | Uint8Array): void {
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
  hash.update(`${label}\0${bytes.byteLength}\0`);
  hash.update(bytes);
}

function metadataFingerprint(stat: BigIntFileStat): string {
  return [
    stat.dev,
    stat.ino,
    stat.uid,
    stat.gid,
    stat.mode,
    stat.nlink,
    stat.size,
    stat.mtimeNs,
    stat.ctimeNs,
  ].map(String).join(":");
}

function assertSameStat(before: BigIntFileStat, after: BigIntFileStat, label: string): void {
  if (metadataFingerprint(before) !== metadataFingerprint(after)) {
    throw new Error(`${label} changed during migration`);
  }
}

function entryKind(stat: BigIntFileStat): TreeEntryKind {
  if (stat.isDirectory()) return "directory";
  if (stat.isFile()) return "file";
  if (stat.isSymbolicLink()) throw new Error("symlink entries are not supported in private LCM state");
  throw new Error("unsupported legacy entry type");
}

function readDescriptor(fd: number, maxBytes: number, budget: TreeBudget): Buffer {
  const chunks: Buffer[] = [];
  const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1));
  let total = 0;
  while (total <= maxBytes) {
    const bytesRead = readSync(fd, buffer, 0, Math.min(buffer.length, maxBytes + 1 - total), null);
    if (bytesRead === 0) break;
    const chunk = Buffer.from(buffer.subarray(0, bytesRead));
    chunks.push(chunk);
    total += bytesRead;
    budget.bytes += bytesRead;
    if (budget.bytes > MAX_MIGRATION_TREE_BYTES) throw new Error("legacy migration exceeds its byte limit");
  }
  if (total > maxBytes) throw new Error("legacy migration file exceeds its size limit");
  return Buffer.concat(chunks, total);
}

function treeWitnessOf(rootPath: string): TreeWitness {
  const hash = createHash("sha256");
  const budget: TreeBudget = { bytes: 0, entries: 0 };
  let rootWitness: TreeWitness | undefined;

  const visit = (path: string, relative: string, isRoot: boolean, depth: number): void => {
    if (depth > MAX_MIGRATION_TREE_DEPTH) throw new Error("legacy migration tree is too deep");
    budget.entries += 1;
    if (budget.entries > MAX_MIGRATION_TREE_ENTRIES) throw new Error("legacy migration has too many entries");

    const before = lstatSync(path, { bigint: true }) as unknown as BigIntFileStat;
    const kind = entryKind(before);
    const identity = statIdentity(before);
    updateHashPart(hash, "path", relative);
    updateHashPart(hash, "kind", kind);
    if (!isRoot) updateHashPart(hash, "mode", String(modeOf(before)));

    {
      const fd = openSync(
        path,
        constants.O_RDONLY
          | (kind === "directory" ? (constants.O_DIRECTORY ?? 0) : 0)
          | (constants.O_NOFOLLOW ?? 0)
          | (constants.O_NONBLOCK ?? 0),
      );
      try {
        const opened = fstatSync(fd, { bigint: true }) as unknown as BigIntFileStat;
        if (!sameIdentity(identity, statIdentity(opened)) || entryKind(opened) !== kind) {
          throw new Error("legacy migration entry changed before descriptor validation");
        }
        if (isRoot) {
          rootWitness = {
            identity,
            mode: modeOf(opened),
            uid: Number(opened.uid),
            gid: Number(opened.gid),
            hash: "",
          };
        }
        if (kind === "file") {
          const content = readDescriptor(fd, MAX_MIGRATION_FILE_BYTES, budget);
          updateHashPart(hash, "bytes", content);
        } else {
          const names = readdirSync(path, { withFileTypes: true })
            .map((entry) => entry.name)
            .sort();
          for (const name of names) {
            if (name === "." || name === ".." || name.includes("/")) {
              throw new Error("legacy migration encountered an invalid entry name");
            }
            visit(join(path, name), relative ? `${relative}/${name}` : name, false, depth + 1);
          }
          const namesAfter = readdirSync(path).sort();
          if (names.length !== namesAfter.length || names.some((name, index) => name !== namesAfter[index])) {
            throw new Error("legacy migration directory entries changed during validation");
          }
        }
        const afterFd = fstatSync(fd, { bigint: true }) as unknown as BigIntFileStat;
        assertSameStat(opened, afterFd, "legacy migration descriptor");
      } finally {
        closeSync(fd);
      }
      const after = lstatSync(path, { bigint: true }) as unknown as BigIntFileStat;
      assertSameStat(before, after, "legacy migration path");
    }
  };

  visit(rootPath, "", true, 0);
  return { ...rootWitness!, hash: hash.digest("hex") };
}

function migrationJournalPath(homeDir: string): string {
  return join(resolve(homeDir), MIGRATION_JOURNAL_NAME);
}

function stagingPath(homeDir: string, operationId: string): string {
  const digest = sha256(`${LCM_HOME_DIRNAME}\0${operationId}`);
  return join(resolve(homeDir), `.lcm-legacy-migration-${digest}.partial`);
}

function migrationPayload(journal: MigrationJournal): MigrationJournalPayload {
  const { checksumSha256: _checksum, ...payload } = journal;
  return payload;
}

function parseMigrationJournal(content: string): MigrationJournal {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(`legacy migration journal is malformed: ${(error as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("legacy migration journal is not an object");
  }
  const value = parsed as Record<string, unknown>;
  const expectedKeys = ["checksumSha256", "operationId", "phase", "source", "sourceName", "stagingName", "target", "targetBaseHash", "targetName", "version"];
  const actualKeys = Object.keys(value).sort();
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys.sort()[index])) {
    throw new Error("legacy migration journal has unexpected fields");
  }
  if (value.version !== MIGRATION_JOURNAL_VERSION
    || (value.phase !== "planned" && value.phase !== "copying" && value.phase !== "published" && value.phase !== "removing")
    || typeof value.operationId !== "string" || !OPERATION_ID_PATTERN.test(value.operationId)
    || value.sourceName !== LEGACY_LCM_HOME_DIRNAME
    || value.targetName !== LCM_HOME_DIRNAME
    || value.stagingName !== basename(stagingPath("/tmp", value.operationId)))
    throw new Error("legacy migration journal fields are invalid");
  if (typeof value.checksumSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(value.checksumSha256)) {
    throw new Error("legacy migration journal checksum is malformed");
  }
  const source = parseTreeWitness(value.source, "source");
  const target = value.target === null ? null : parseTreeWitness(value.target, "target");
  if (value.targetBaseHash !== null && (typeof value.targetBaseHash !== "string" || !/^[a-f0-9]{64}$/u.test(value.targetBaseHash))) {
    throw new Error("legacy migration target base witness is malformed");
  }
  const payload = {
    version: MIGRATION_JOURNAL_VERSION,
    phase: value.phase,
    operationId: value.operationId,
    sourceName: value.sourceName,
    targetName: value.targetName,
    stagingName: value.stagingName,
    source,
    target,
    targetBaseHash: value.targetBaseHash,
  } as MigrationJournalPayload;
  if (journalChecksum(payload) !== value.checksumSha256) {
    throw new Error("legacy migration journal checksum does not match");
  }
  return { ...payload, checksumSha256: value.checksumSha256 };
}

function parseTreeWitness(value: unknown, label: string): TreeWitness {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`legacy migration ${label} witness is malformed`);
  const record = value as Record<string, unknown>;
  const keys = ["gid", "hash", "identity", "mode", "uid"];
  const actual = Object.keys(record).sort();
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys.sort()[index])) {
    throw new Error(`legacy migration ${label} witness has unexpected fields`);
  }
  const identity = record.identity;
  if (!identity || typeof identity !== "object" || Array.isArray(identity)) {
    throw new Error(`legacy migration ${label} witness identity is malformed`);
  }
  const identityRecord = identity as Record<string, unknown>;
  const identityKeys = Object.keys(identityRecord).sort();
  if (identityKeys.length !== 2 || identityKeys[0] !== "dev" || identityKeys[1] !== "ino") {
    throw new Error(`legacy migration ${label} witness identity has unexpected fields`);
  }
  if (typeof identityRecord.dev !== "string" || !/^\d+$/u.test(identityRecord.dev)
    || typeof identityRecord.ino !== "string" || !/^\d+$/u.test(identityRecord.ino)
    || typeof record.hash !== "string" || !/^[a-f0-9]{64}$/u.test(record.hash)
    || !Number.isSafeInteger(record.mode) || (record.mode as number) < 0 || (record.mode as number) > 0o7777
    || !Number.isSafeInteger(record.uid) || (record.uid as number) < 0
    || !Number.isSafeInteger(record.gid) || (record.gid as number) < 0) {
    throw new Error(`legacy migration ${label} witness fields are invalid`);
  }
  return {
    identity: { dev: identityRecord.dev, ino: identityRecord.ino },
    mode: record.mode,
    uid: record.uid,
    gid: record.gid,
    hash: record.hash,
  } as TreeWitness;
}

function readMigrationJournal(homeDir: string): MigrationJournal | null {
  const path = migrationJournalPath(homeDir);
  try {
    const content = readBoundedRegularFile(path, {
      allowedRoot: resolve(homeDir),
      maxBytes: MAX_MIGRATION_JOURNAL_BYTES,
      expectedUid: currentUid(),
      allowedModes: [PRIVATE_FILE_MODE],
      requireSingleLink: true,
    });
    return parseMigrationJournal(content);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

function tempJournalPath(path: string): string {
  return join(dirname(path), `.${basename(path)}.${randomBytes(12).toString("hex")}.tmp`);
}

function writeBytesToDescriptor(fd: number, content: Uint8Array): void {
  const bytes = Buffer.from(content);
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset, null);
    if (written <= 0) throw new Error("durable migration write made no progress");
    offset += written;
  }
}

function removeOwnedTemporary(path: string, identity: Identity): void {
  const stat = lstatIfPresent(path);
  if (stat !== undefined && sameIdentity(statIdentity(stat), identity)) unlinkSync(path);
}

function writeMigrationJournal(homeDir: string, journal: MigrationJournal, exclusive: boolean): void {
  const path = migrationJournalPath(homeDir);
  const parent = openDirectory(resolve(homeDir), "home directory");
  const temporary = tempJournalPath(path);
  let temporaryIdentity: Identity | undefined;
  try {
    const fd = openSync(
      temporary,
      constants.O_WRONLY
        | constants.O_CREAT
        | constants.O_EXCL
        | (constants.O_NOFOLLOW ?? 0)
        | (constants.O_NONBLOCK ?? 0),
      PRIVATE_FILE_MODE,
    );
    try {
      const stat = fstatSync(fd, { bigint: true }) as unknown as BigIntFileStat;
      temporaryIdentity = statIdentity(stat);
      writeBytesToDescriptor(fd, Buffer.from(journalContent(journal), "utf8"));
      fchmodSync(fd, PRIVATE_FILE_MODE);
      syncDescriptorIfSupported(fd);
    } finally {
      closeSync(fd);
    }

    if (exclusive) {
      try {
        linkSync(temporary, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new Error("legacy migration journal already exists");
        }
        throw error;
      }
      removeOwnedTemporary(temporary, temporaryIdentity);
    } else {
      try {
        renameSync(temporary, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
        // EXDEV is not expected for a same-directory journal update. The
        // bounded fallback exists for platform shims and keeps the lock-held
        // state durable without pretending that the update was atomic.
        const targetFd = openSync(
          path,
          constants.O_WRONLY | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
        );
        try {
          writeBytesToDescriptor(targetFd, Buffer.from(journalContent(journal), "utf8"));
          syncDescriptorIfSupported(targetFd);
        } finally {
          closeSync(targetFd);
        }
        removeOwnedTemporary(temporary, temporaryIdentity);
      }
    }
    syncDescriptorIfSupported(parent.fd);
  } finally {
    if (temporaryIdentity !== undefined) {
      try { removeOwnedTemporary(temporary, temporaryIdentity); } catch { /* preserve the primary error */ }
    }
    parent.close();
  }
}

function deleteMigrationJournal(homeDir: string): void {
  const path = migrationJournalPath(homeDir);
  const stat = lstatIfPresent(path);
  if (stat === undefined) return;
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("legacy migration journal is not a regular file");
  unlinkSync(path);
  const home = openDirectory(resolve(homeDir), "home directory");
  try { syncDescriptorIfSupported(home.fd); } finally { home.close(); }
}

function makeJournal(source: TreeWitness): MigrationJournal {
  const operationId = randomBytes(24).toString("hex");
  const payload: MigrationJournalPayload = {
    version: MIGRATION_JOURNAL_VERSION,
    phase: "planned",
    operationId,
    sourceName: LEGACY_LCM_HOME_DIRNAME,
    targetName: LCM_HOME_DIRNAME,
    stagingName: basename(stagingPath("/tmp", operationId)),
    source,
    target: null,
    targetBaseHash: null,
  };
  return { ...payload, checksumSha256: journalChecksum(payload) };
}

function updateJournal(journal: MigrationJournal, patch: Partial<MigrationJournalPayload>): MigrationJournal {
  const payload: MigrationJournalPayload = { ...migrationPayload(journal), ...patch };
  return { ...payload, checksumSha256: journalChecksum(payload) };
}

function assertSourceMatches(path: string, expected: TreeWitness): TreeWitness {
  const current = treeWitnessOf(path);
  if (!sameIdentity(current.identity, expected.identity) || current.hash !== expected.hash) {
    throw new Error("legacy source changed during migration");
  }
  return current;
}

function assertTargetMatches(path: string, expected: TreeWitness, requirePrivateRoot: boolean): TreeWitness {
  const current = treeWitnessOf(path);
  if (!sameIdentity(current.identity, expected.identity)
    || current.hash !== expected.hash
    || (requirePrivateRoot && current.mode !== PRIVATE_ROOT_MODE)) {
    throw new Error("active migration target changed during recovery");
  }
  if (requirePrivateRoot) {
    const root = openPrivateRoot(path);
    root.close();
  }
  return current;
}

function openDestinationDirectory(path: string, label: string): OpenDirectory {
  return openDirectory(path, label);
}

function tightenRootMode(path: string): void {
  const directory = openDestinationDirectory(path, "migration target directory");
  try {
    fchmodSync(directory.fd, PRIVATE_ROOT_MODE);
    syncDescriptorIfSupported(directory.fd);
  } finally {
    directory.close();
  }
}

function existingEntry(path: string): BigIntFileStat | undefined {
  return lstatIfPresent(path);
}

function copyRegularEntry(sourcePath: string, targetPath: string, budget: TreeBudget): void {
  const sourceBefore = lstatSync(sourcePath, { bigint: true }) as unknown as BigIntFileStat;
  const sourceFd = openSync(sourcePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const sourceOpened = fstatSync(sourceFd, { bigint: true }) as unknown as BigIntFileStat;
    if (!sameIdentity(statIdentity(sourceBefore), statIdentity(sourceOpened))) {
      throw new Error("legacy migration source changed before copy");
    }
    const content = readDescriptor(sourceFd, MAX_MIGRATION_FILE_BYTES, budget);
    assertSameStat(sourceOpened, fstatSync(sourceFd, { bigint: true }) as unknown as BigIntFileStat, "legacy migration source");
    const targetFd = openSync(
      targetPath,
      constants.O_WRONLY
        | constants.O_CREAT
        | constants.O_EXCL
        | (constants.O_NOFOLLOW ?? 0)
        | (constants.O_NONBLOCK ?? 0),
      PRIVATE_FILE_MODE,
    );
    try {
      writeBytesToDescriptor(targetFd, content);
      fchmodSync(targetFd, modeOf(sourceOpened));
      syncDescriptorIfSupported(targetFd);
    } finally {
      closeSync(targetFd);
    }
  } finally {
    closeSync(sourceFd);
  }
  const after = lstatSync(sourcePath, { bigint: true }) as unknown as BigIntFileStat;
  assertSameStat(sourceBefore, after, "legacy migration source");
}

function copyDirectoryEntries(sourcePath: string, targetPath: string, budget: TreeBudget, depth: number): void {
  if (depth > MAX_MIGRATION_TREE_DEPTH) throw new Error("legacy migration tree is too deep");
  const sourceBefore = lstatSync(sourcePath, { bigint: true }) as unknown as BigIntFileStat;
  const sourceFd = openSync(sourcePath, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = fstatSync(sourceFd, { bigint: true }) as unknown as BigIntFileStat;
    if (!sameIdentity(statIdentity(sourceBefore), statIdentity(opened))) throw new Error("legacy migration directory changed before copy");
    const names = readdirSync(sourcePath, { withFileTypes: true }).map((entry) => entry.name).sort();
    for (const name of names) {
      const sourceChild = join(sourcePath, name);
      const targetChild = join(targetPath, name);
      const sourceStat = lstatSync(sourceChild, { bigint: true }) as unknown as BigIntFileStat;
      const kind = entryKind(sourceStat);
      const targetStat = existingEntry(targetChild);
      if (targetStat !== undefined) {
        const sourceWitness = treeWitnessOf(sourceChild);
        const targetWitness = treeWitnessOf(targetChild);
        if (sourceWitness.hash !== targetWitness.hash) throw new Error("legacy migration target conflicts with source");
        continue;
      }
      if (kind === "directory") {
        mkdirSync(targetChild, { mode: PRIVATE_ROOT_MODE });
        const targetDirectory = openDestinationDirectory(targetChild, "migration target directory");
        try {
          copyDirectoryEntries(sourceChild, targetChild, budget, depth + 1);
          fchmodSync(targetDirectory.fd, modeOf(sourceStat));
          syncDescriptorIfSupported(targetDirectory.fd);
        } finally {
          targetDirectory.close();
        }
      } else {
        copyRegularEntry(sourceChild, targetChild, budget);
      }
    }
    const after = fstatSync(sourceFd, { bigint: true }) as unknown as BigIntFileStat;
    assertSameStat(opened, after, "legacy migration directory");
    const namesAfter = readdirSync(sourcePath).sort();
    if (names.length !== namesAfter.length || names.some((name, index) => name !== namesAfter[index])) {
      throw new Error("legacy migration directory entries changed after copy");
    }
  } finally {
    closeSync(sourceFd);
  }
}

function copySourceToStaging(sourcePath: string, staging: string, source: TreeWitness): TreeWitness {
  const budget: TreeBudget = { bytes: 0, entries: 0 };
  copyDirectoryEntries(sourcePath, staging, budget, 0);
  const sourceAfter = assertSourceMatches(sourcePath, source);
  const stage = treeWitnessOf(staging);
  if (stage.hash !== sourceAfter.hash) throw new Error("legacy migration copy does not match source");
  const stageHandle = openDestinationDirectory(staging, "migration staging directory");
  try {
    fchmodSync(stageHandle.fd, PRIVATE_ROOT_MODE);
    syncDescriptorIfSupported(stageHandle.fd);
  } finally {
    stageHandle.close();
  }
  const verified = treeWitnessOf(staging);
  if (verified.hash !== source.hash || verified.mode !== PRIVATE_ROOT_MODE) {
    throw new Error("legacy migration staging witness does not match source");
  }
  return verified;
}

function removeTreeExactly(path: string, expected: Identity): void {
  const rootStat = lstatSync(path, { bigint: true }) as unknown as BigIntFileStat;
  if (!rootStat.isDirectory() || !sameIdentity(statIdentity(rootStat), expected)) {
    throw new Error("legacy migration removal target changed");
  }
  const rootFd = openSync(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = fstatSync(rootFd, { bigint: true }) as unknown as BigIntFileStat;
    if (!sameIdentity(statIdentity(opened), expected)) throw new Error("legacy migration removal target changed");
    const names = readdirSync(path).sort();
    for (const name of names) {
      const child = join(path, name);
      const stat = lstatSync(child, { bigint: true }) as unknown as BigIntFileStat;
      const childIdentity = statIdentity(stat);
      if (stat.isDirectory()) {
        removeTreeExactly(child, childIdentity);
      } else if (stat.isFile()) {
        const fd = openSync(child, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
        try {
          const openedChild = fstatSync(fd, { bigint: true }) as unknown as BigIntFileStat;
          if (!sameIdentity(statIdentity(openedChild), childIdentity)) throw new Error("legacy migration file changed during removal");
          const beforeUnlink = lstatSync(child, { bigint: true }) as unknown as BigIntFileStat;
          if (!sameIdentity(statIdentity(beforeUnlink), childIdentity)) throw new Error("legacy migration file changed during removal");
          unlinkSync(child);
        } finally {
          closeSync(fd);
        }
      } else if (stat.isSymbolicLink()) {
        throw new Error("symlink entry appeared during legacy migration removal");
      } else {
        throw new Error("legacy migration encountered an unsupported removal entry");
      }
    }
    const after = fstatSync(rootFd, { bigint: true }) as unknown as BigIntFileStat;
    if (!sameIdentity(statIdentity(after), expected) || readdirSync(path).length !== 0) {
      throw new Error("legacy migration directory changed during removal");
    }
  } finally {
    closeSync(rootFd);
  }
  rmdirSync(path);
}

function publishStaging(
  homeDir: string,
  staging: string,
  target: string,
  journal: MigrationJournal,
  admission: PublicationAdmission,
  finish: (published: MigrationJournal) => RuntimeHomeMigration,
): RuntimeHomeMigration {
  try {
    renameSync(staging, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    // A same-directory EXDEV indicates a platform shim or test adapter. Copy
    // through a newly authenticated target and retain the staging tree until
    // the target witness is complete.
    mkdirSync(target, { mode: PRIVATE_ROOT_MODE });
  }

  // The target becomes visible at rename (or mkdir in the EXDEV fallback).
  // Acquire the root-backed publication lock immediately at that boundary;
  // all witness advancement and source removal remain inside that lock.
  return admission.withFinalLock(() => {
    if (journal.target !== null && lstatIfPresent(staging) !== undefined) {
      const stage = lstatIfPresent(staging);
      if (stage === undefined || !sameIdentity(statIdentity(stage), journal.target.identity)) {
        throw new Error("legacy migration staging witness changed at publish");
      }
      copyDirectoryEntries(staging, target, { bytes: 0, entries: 0 }, 0);
      tightenRootMode(target);
      removeTreeExactly(staging, journal.target.identity);
    }
    const publishedCandidate = treeWitnessOf(target);
    if (publishedCandidate.hash !== journal.source.hash || publishedCandidate.mode !== PRIVATE_ROOT_MODE) {
      throw new Error("active migration target does not match source after publish");
    }
    const privateTarget = openPrivateRoot(target);
    privateTarget.close();
    const home = openDirectory(resolve(homeDir), "home directory");
    try { syncDescriptorIfSupported(home.fd); } finally { home.close(); }
    const published = updateJournal(journal, { phase: "published", target: publishedCandidate });
    writeMigrationJournal(homeDir, published, false);
    return finish(published);
  });
}

function finishPublishedMigration(homeDir: string, from: string, to: string, journal: MigrationJournal): RuntimeHomeMigration {
  const target = journal.target;
  if (target === null) throw new Error("legacy migration target witness is missing");
  assertTargetMatches(to, target, true);
  const source = lstatIfPresent(from);
  if (source !== undefined) {
    assertSourceMatches(from, journal.source);
    const removing = updateJournal(journal, { phase: "removing" });
    writeMigrationJournal(homeDir, removing, false);
    removeTreeExactly(from, journal.source.identity);
  }
  deleteMigrationJournal(homeDir);
  return { migrated: true, from, to };
}

function resumeMigration(
  homeDir: string,
  journal: MigrationJournal,
  admission: PublicationAdmission,
): RuntimeHomeMigration {
  const from = legacyLcmHomeDir(homeDir);
  const to = lcmHomeDir(homeDir);
  const staging = join(resolve(homeDir), journal.stagingName);
  switch (journal.phase) {
    case "published":
    case "removing":
      return admission.withFinalLock(() => finishPublishedMigration(homeDir, from, to, journal));
    case "planned": {
      assertSourceMatches(from, journal.source);
      const active = lstatIfPresent(to);
      if (active !== undefined) {
        throw new Error("legacy migration found an unauthenticated active root");
      }
      // Keep the authenticated legacy source intact until the copied active
      // root has crossed the final publication-lock handoff. A direct root
      // rename would erase the only source copy before a post-rename competitor
      // could be detected and would make fail-closed recovery impossible.
      mkdirSync(staging, { mode: PRIVATE_ROOT_MODE });
      const stagingWitness = treeWitnessOf(staging);
      const copying = updateJournal(journal, {
        phase: "copying",
        target: stagingWitness,
        targetBaseHash: stagingWitness.hash,
      });
      writeMigrationJournal(homeDir, copying, false);
      try {
        copySourceToStaging(from, staging, journal.source);
        return publishStaging(
          homeDir,
          staging,
          to,
          copying,
          admission,
          (published) => finishPublishedMigration(homeDir, from, to, published),
        );
      } catch (error) {
        // Clean only the operation-owned staging inode. If any identity check
        // is ambiguous, retain it and the journal for operator recovery.
        try {
          const current = lstatIfPresent(staging);
          if (current !== undefined && copying.target !== null && sameIdentity(statIdentity(current), copying.target.identity)) {
            removeTreeExactly(staging, copying.target.identity);
            deleteMigrationJournal(homeDir);
          }
        } catch { /* preserve the journal and source on ambiguous cleanup */ }
        throw error;
      }
    }
    case "copying": {
      assertSourceMatches(from, journal.source);
      const stagingStat = lstatIfPresent(staging);
      if (stagingStat === undefined || journal.target === null || !sameIdentity(statIdentity(stagingStat), journal.target.identity)) {
        throw new Error("legacy migration staging witness is missing or changed");
      }
      assertTargetMatches(staging, journal.target, false);
      const copying = updateJournal(journal, { phase: "copying" });
      copySourceToStaging(from, staging, journal.source);
      return publishStaging(
        homeDir,
        staging,
        to,
        copying,
        admission,
        (published) => finishPublishedMigration(homeDir, from, to, published),
      );
    }
  }
}

function migrateLegacyHomeUnlocked(
  homeDir: string,
  topology: HomeTopology,
  admission: PublicationAdmission,
): RuntimeHomeMigration {
  const from = legacyLcmHomeDir(homeDir);
  const to = lcmHomeDir(homeDir);
  const journal = readMigrationJournal(homeDir);
  const legacy = lstatIfPresent(from);
  const active = lstatIfPresent(to);

  if (journal !== null) {
    if (legacy === undefined && active === undefined) {
      throw new Error("legacy migration evidence has no authenticated source or target");
    }
    return resumeMigration(homeDir, journal, admission);
  }

  if (legacy === undefined) {
    if (active !== undefined) {
      const root = openPrivateRoot(to);
      root.close();
    }
    return { migrated: false, from, to };
  }
  const source = treeWitnessOf(from);
  if (!legacy.isDirectory() || legacy.isSymbolicLink() || !ownerMatches(legacy)) {
    throw new Error("legacy LCM home is not a trusted directory");
  }
  if (active !== undefined) {
    // This includes an empty active root. Without a journal proving that the
    // active inode was created by this operation, history is ambiguous.
    throw new Error("legacy and active LCM homes coexist without authenticated migration evidence");
  }
  assertRootParent(topology, homeDir);
  const planned = makeJournal(source);
  writeMigrationJournal(homeDir, planned, true);
  try {
    return resumeMigration(homeDir, planned, admission);
  } catch (error) {
    // The journal is deliberately retained if the operation reached an
    // ambiguous boundary. Safe pre-publication failures may remove it.
    if ((error as Error).message.includes("changed during migration")
      || (error as Error).message.includes("does not match source")) {
      try { deleteMigrationJournal(homeDir); } catch { /* retain evidence */ }
    }
    throw error;
  }
}

function bootstrapLockPath(homeDir: string): string {
  return join(resolve(homeDir), ".lcm-root-bootstrap.lock");
}

type BootstrapLock = Readonly<{
  close: () => void;
}>;

function acquireBootstrapLock(homeDir: string, topology: HomeTopology): BootstrapLock {
  assertRootParent(topology, homeDir);
  const path = bootstrapLockPath(homeDir);
  let fd: number;
  try {
    fd = openSync(
      path,
      constants.O_WRONLY
        | constants.O_CREAT
        | constants.O_EXCL
        | (constants.O_NOFOLLOW ?? 0)
        | (constants.O_NONBLOCK ?? 0),
      PRIVATE_FILE_MODE,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("LCM root bootstrap is already in progress; retry after it completes");
    }
    throw error;
  }
  let lockIdentity: Identity | undefined;
  try {
    const stat = fstatSync(fd, { bigint: true }) as unknown as BigIntFileStat;
    const identity = statIdentity(stat);
    lockIdentity = identity;
    writeBytesToDescriptor(fd, Buffer.from(JSON.stringify({
      pid: process.pid,
      nonce: randomBytes(16).toString("hex"),
      version: 1,
    }) + "\n", "utf8"));
    syncDescriptorIfSupported(fd);
    assertRootParent(topology, homeDir);
    return {
      close: () => {
        closeSync(fd);
        const current = lstatIfPresent(path);
        if (current === undefined || !sameIdentity(statIdentity(current), identity)) {
          throw new Error("LCM root bootstrap lock changed before release");
        }
        unlinkSync(path);
        syncDescriptorIfSupported(topology.home.fd);
      },
    };
  } catch (error) {
    try { closeSync(fd); } catch { /* preserve the primary error */ }
    try {
      const current = lstatIfPresent(path);
      if (current !== undefined && lockIdentity !== undefined && sameIdentity(statIdentity(current), lockIdentity)) {
        unlinkSync(path);
      }
    } catch { /* preserve evidence if cleanup is ambiguous */ }
    throw error;
  }
}

function withPublicationAdmission<T>(homeDir: string, callback: (admission: PublicationAdmission) => T): T {
  // Validate the user home before creating the bootstrap lock. In particular,
  // this path never uses the private-mutation-lock helper, whose historical
  // recursive directory hardening would chmod the home before validation.
  const topology = openHomeTopology(homeDir);
  let bootstrapLock: BootstrapLock | undefined;
  try {
    bootstrapLock = acquireBootstrapLock(homeDir, topology);
    const rootExists = lstatIfPresent(lcmHomeDir(homeDir)) !== undefined;
    if (rootExists) {
      return withBackendPublicationConsumerLock(homeDir, (lockToken) => {
        // Publication admission is deliberately the outermost durable
        // boundary. The callback keeps the acquired token through every
        // root/config/source witness in the established-root case.
        assertBackendPublicationConsumerAccess({ homeDir, lockToken });
        return callback({
          topology,
          withFinalLock: (nested) => nested(lockToken),
        });
      });
    }

    // There is no root-backed publication state to consume while the root is
    // absent. The authenticated bootstrap lock is the interprocess boundary
    // for this phase; withFinalLock performs the mandatory handoff as soon as
    // the active root appears.
    return callback({
      topology,
      withFinalLock: (nested) => withBackendPublicationConsumerLock(homeDir, (lockToken) => {
        assertBackendPublicationConsumerAccess({ homeDir, lockToken });
        return nested(lockToken);
      }),
    });
  } finally {
    try { bootstrapLock?.close(); } finally { topology.home.close(); topology.parent.close(); }
  }
}

/**
 * Operator-assisted bootstrap for ~/.lcm. This is the sole TypeScript path
 * that may create the private root. It authenticates the home and parent,
 * creates only the final component, tightens it through the retained fd, and
 * fsyncs the durable parent topology where the platform supports it.
 */
export function bootstrapLcmHome(homeDir: string = homedir()): RuntimeHomeBootstrap {
  return withPublicationAdmission(homeDir, (admission) => {
    const topology = admission.topology;
    const existingRoot = lstatIfPresent(lcmHomeDir(homeDir));
    const result = migrateLegacyHomeUnlocked(homeDir, topology, admission);
    const root = lstatIfPresent(lcmHomeDir(homeDir));
    if (root === undefined) {
      const created = createPrivateRoot(topology, homeDir);
      created.root.close();
      const expected = treeWitnessOf(lcmHomeDir(homeDir));
      return admission.withFinalLock(() => {
        const current = treeWitnessOf(lcmHomeDir(homeDir));
        if (!sameIdentity(current.identity, expected.identity) || current.hash !== expected.hash || current.mode !== PRIVATE_ROOT_MODE) {
          throw new Error("private LCM root changed before bootstrap handoff");
        }
        const rootHandle = openPrivateRoot(lcmHomeDir(homeDir));
        rootHandle.close();
        return { ...result, created: true };
      });
    }
    const rootHandle = openPrivateRoot(lcmHomeDir(homeDir));
    rootHandle.close();
    return { ...result, created: existingRoot === undefined };
  });
}

/**
 * Migrate legacy state under publication admission. With no roots this is a
 * read-only no-op; a fresh root is created only by bootstrapLcmHome or when a
 * legacy root is the authenticated source of an explicit migration.
 */
export function migrateLegacyHomeIfNeeded(homeDir: string = homedir()): RuntimeHomeMigration {
  return withPublicationAdmission(homeDir, (admission) => {
    return migrateLegacyHomeUnlocked(homeDir, admission.topology, admission);
  });
}
