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
  readlinkSync,
  readdirSync,
  renameSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { legacyLcmHomeDirname } from "./legacy-names.js";
import { processStartTime } from "./private-mutation-lock.js";
import {
  assertBackendPublicationConsumerAccess,
  withBackendPublicationConsumerLock,
  type BackendPublicationLockToken,
} from "./storage/backend-publication.js";
import {
  consumeBoundedRegularFile,
  readBoundedRegularFile,
  readBoundedRegularFileWithStat,
} from "./security-files.js";

export const LCM_HOME_DIRNAME = ".lcm";
export const LEGACY_LCM_HOME_DIRNAME = legacyLcmHomeDirname();

const PRIVATE_ROOT_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MAX_MIGRATION_JOURNAL_BYTES = 64 * 1024;
const MAX_MIGRATION_FILE_BYTES = 4 * 1024 * 1024;
const MAX_MIGRATION_TREE_BYTES = 32 * 1024 * 1024;
const MAX_MIGRATION_TREE_ENTRIES = 8_192;
const MAX_MIGRATION_TREE_DEPTH = 32;
const MAX_BOOTSTRAP_LOCK_BYTES = 1024;
const LEGACY_MIGRATION_JOURNAL_VERSION = 1 as const;
const MIGRATION_JOURNAL_VERSION = 2 as const;
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

/** Raised only when a validated bootstrap lock has a definitively live owner. */
export class BootstrapLockContentionError extends Error {}

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

type MigrationEntry = Readonly<{
  fd: number;
  descriptorPath: string;
  path: string;
  stat: BigIntFileStat;
  kind: TreeEntryKind;
  close: () => void;
}>;

type MigrationDirectory = MigrationEntry & Readonly<{ kind: "directory" }>;
type MigrationFile = MigrationEntry & Readonly<{ kind: "file" }>;

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

type MigrationPhase = "planned" | "copying" | "published" | "removing" | "retaining" | "retained";

type MigrationJournalPayload = Readonly<{
  version: typeof MIGRATION_JOURNAL_VERSION;
  phase: MigrationPhase;
  operationId: string;
  sourceName: string;
  targetName: string;
  stagingName: string;
  source: TreeWitness;
  target: TreeWitness | null;
  retained: TreeWitness | null;
  targetBaseHash: string | null;
}>;

type LegacyMigrationJournalPayload = Readonly<{
  version: typeof LEGACY_MIGRATION_JOURNAL_VERSION;
  phase: Exclude<MigrationPhase, "retaining" | "retained">;
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

type ReadyMigrationJournal = MigrationJournal & Readonly<{ target: TreeWitness }>;

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

export function currentUid(): number | undefined {
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

function secureOpenFlags(): number {
  if (typeof constants.O_NOFOLLOW !== "number" || typeof constants.O_NONBLOCK !== "number") {
    throw new Error("legacy migration requires no-follow nonblocking descriptor access");
  }
  return constants.O_NOFOLLOW | constants.O_NONBLOCK;
}

function statIdentity(stat: BigIntFileStat): Identity {
  return { dev: String(stat.dev), ino: String(stat.ino) };
}

function sameIdentity(left: Identity, right: Identity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameTreeWitness(left: TreeWitness, right: TreeWitness): boolean {
  return sameIdentity(left.identity, right.identity)
    && left.mode === right.mode
    && left.uid === right.uid
    && left.gid === right.gid
    && left.hash === right.hash;
}

function sameTreeContent(left: TreeWitness, right: TreeWitness): boolean {
  return left.uid === right.uid && left.gid === right.gid && left.hash === right.hash;
}

function descriptorPathFor(fd: number): string {
  // Node has no portable openat(2) or fchdir(2) API. The Linux proc
  // descriptor namespace is the only path form this walker treats as
  // descriptor-relative. In particular, do not substitute /dev/fd: on macOS
  // its entries are not readlink-able traversal links and descendant lookup
  // through them is not supported.
  const candidate = join("/proc/self/fd", String(fd));
  try {
    readlinkSync(candidate);
    return candidate;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code !== "ENOENT" && code !== "ENOTDIR" && code !== "EINVAL") throw error;
  }
  throw new Error("legacy migration requires descriptor-relative filesystem access");
}

function openMigrationEntry(path: string, label: string): MigrationEntry {
  let fd: number;
  try {
    fd = openSync(
      path,
      constants.O_RDONLY
        | secureOpenFlags(),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new Error("symlink entries are not supported in private LCM state");
    }
    throw error;
  }
  try {
    const stat = fstatSync(fd, { bigint: true }) as unknown as BigIntFileStat;
    const descriptorPath = descriptorPathFor(fd);
    const pathStat = lstatSync(path, { bigint: true }) as unknown as BigIntFileStat;
    if (!sameIdentity(statIdentity(stat), statIdentity(pathStat))) {
      throw new Error(`${label} changed before descriptor validation`);
    }
    const kind = entryKind(stat);
    if (entryKind(pathStat) !== kind) throw new Error(`${label} changed before descriptor validation`);
    return {
      fd,
      descriptorPath,
      path,
      stat,
      kind,
      close: () => closeSync(fd),
    };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function openMigrationDirectory(path: string, label: string): MigrationDirectory {
  const entry = openMigrationEntry(path, label);
  if (entry.kind !== "directory") {
    entry.close();
    throw new Error(`${label} is not a directory`);
  }
  return entry as MigrationDirectory;
}

function openMigrationEntryIfPresent(path: string, label: string): MigrationEntry | undefined {
  try {
    return openMigrationEntry(path, label);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
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

function journalChecksum(payload: MigrationJournalPayload | LegacyMigrationJournalPayload): string {
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
      | secureOpenFlags(),
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

function treeWitnessFromEntry(rootEntry: MigrationEntry): TreeWitness {
  const hash = createHash("sha256");
  const budget: TreeBudget = { bytes: 0, entries: 0 };
  let rootWitness: TreeWitness | undefined;

  const visit = (entry: MigrationEntry, relative: string, isRoot: boolean, depth: number): void => {
    if (depth > MAX_MIGRATION_TREE_DEPTH) throw new Error("legacy migration tree is too deep");
    budget.entries += 1;
    if (budget.entries > MAX_MIGRATION_TREE_ENTRIES) throw new Error("legacy migration has too many entries");

    const opened = entry.stat;
    const kind = entry.kind;
    const identity = statIdentity(opened);
    updateHashPart(hash, "path", relative);
    updateHashPart(hash, "kind", kind);
    if (!isRoot) updateHashPart(hash, "mode", String(modeOf(opened)));

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
      const content = readDescriptor(entry.fd, MAX_MIGRATION_FILE_BYTES, budget);
      updateHashPart(hash, "bytes", content);
    } else {
      const names = readdirSync(entry.descriptorPath, { withFileTypes: true })
        .map((child) => child.name)
        .sort();
      for (const name of names) {
        if (name === "." || name === ".." || name.includes("/")) {
          throw new Error("legacy migration encountered an invalid entry name");
        }
        const child = openMigrationEntry(join(entry.descriptorPath, name), "legacy migration entry");
        try {
          visit(child, relative ? `${relative}/${name}` : name, false, depth + 1);
        } finally {
          child.close();
        }
      }
      const namesAfter = readdirSync(entry.descriptorPath).sort();
      if (names.length !== namesAfter.length || names.some((name, index) => name !== namesAfter[index])) {
        throw new Error("legacy migration directory entries changed during validation");
      }
    }
    const afterFd = fstatSync(entry.fd, { bigint: true }) as unknown as BigIntFileStat;
    assertSameStat(opened, afterFd, "legacy migration descriptor");
    const afterPath = lstatSync(entry.path, { bigint: true }) as unknown as BigIntFileStat;
    assertSameStat(opened, afterPath, "legacy migration path");
  };

  visit(rootEntry, "", true, 0);
  return { ...rootWitness!, hash: hash.digest("hex") };
}

function treeWitnessOf(rootPath: string): TreeWitness {
  const root = openMigrationEntry(rootPath, "legacy migration entry");
  try {
    return treeWitnessFromEntry(root);
  } finally {
    root.close();
  }
}

function treeWitnessIfPresent(rootPath: string): TreeWitness | undefined {
  const root = openMigrationEntryIfPresent(rootPath, "legacy migration entry");
  if (root === undefined) return undefined;
  try {
    return treeWitnessFromEntry(root);
  } finally {
    root.close();
  }
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
  const legacy = value.version === LEGACY_MIGRATION_JOURNAL_VERSION;
  const current = value.version === MIGRATION_JOURNAL_VERSION;
  const expectedKeys = legacy || (!current && !("retained" in value))
    ? ["checksumSha256", "operationId", "phase", "source", "sourceName", "stagingName", "target", "targetBaseHash", "targetName", "version"]
    : ["checksumSha256", "operationId", "phase", "retained", "source", "sourceName", "stagingName", "target", "targetBaseHash", "targetName", "version"];
  const actualKeys = Object.keys(value).sort();
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys.sort()[index])) {
    throw new Error("legacy migration journal has unexpected fields");
  }
  const phaseValid = value.phase === "planned" || value.phase === "copying" || value.phase === "published" || value.phase === "removing"
    || (current && (value.phase === "retaining" || value.phase === "retained"));
  if ((!legacy && !current)
    || !phaseValid
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
  const retained = legacy || value.retained === null ? null : parseTreeWitness(value.retained, "retained");
  if (value.targetBaseHash !== null && (typeof value.targetBaseHash !== "string" || !/^[a-f0-9]{64}$/u.test(value.targetBaseHash))) {
    throw new Error("legacy migration target base witness is malformed");
  }
  if (current
    && (((value.phase === "planned" || value.phase === "copying" || value.phase === "removing") && retained !== null)
      || ((value.phase === "retaining" || value.phase === "retained") && (retained === null || target === null)))) {
    throw new Error("legacy migration journal retained evidence is invalid");
  }
  const common = {
    phase: value.phase as MigrationPhase,
    operationId: value.operationId,
    sourceName: value.sourceName,
    targetName: value.targetName,
    stagingName: value.stagingName,
    source,
    target,
    targetBaseHash: value.targetBaseHash,
  };
  const checksummedPayload = legacy
    ? { ...common, version: LEGACY_MIGRATION_JOURNAL_VERSION } as LegacyMigrationJournalPayload
    : { ...common, version: MIGRATION_JOURNAL_VERSION, retained } as MigrationJournalPayload;
  if (journalChecksum(checksummedPayload) !== value.checksumSha256) {
    throw new Error("legacy migration journal checksum does not match");
  }
  return {
    ...common,
    version: MIGRATION_JOURNAL_VERSION,
    retained,
    checksumSha256: value.checksumSha256,
  } as MigrationJournal;
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
        | secureOpenFlags(),
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
          constants.O_WRONLY | constants.O_TRUNC | secureOpenFlags(),
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
    retained: null,
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
  if (!sameTreeWitness(current, expected)) {
    throw new Error("legacy source changed during migration");
  }
  return current;
}

function assertTargetMatches(path: string, expected: TreeWitness): TreeWitness {
  const current = treeWitnessOf(path);
  if (!sameTreeWitness(current, expected) || current.mode !== PRIVATE_ROOT_MODE) {
    throw new Error("active migration target changed during recovery");
  }
  const root = openPrivateRoot(path);
  root.close();
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

function copyRegularEntry(source: MigrationFile, targetPath: string, budget: TreeBudget): void {
  const content = readDescriptor(source.fd, MAX_MIGRATION_FILE_BYTES, budget);
  assertSameStat(
    source.stat,
    fstatSync(source.fd, { bigint: true }) as unknown as BigIntFileStat,
    "legacy migration source",
  );
  const targetFd = openSync(
    targetPath,
    constants.O_WRONLY
      | constants.O_CREAT
      | constants.O_EXCL
      | secureOpenFlags(),
    PRIVATE_FILE_MODE,
  );
  try {
    writeBytesToDescriptor(targetFd, content);
    fchmodSync(targetFd, modeOf(source.stat));
    syncDescriptorIfSupported(targetFd);
  } finally {
    closeSync(targetFd);
  }
  const after = lstatSync(source.path, { bigint: true }) as unknown as BigIntFileStat;
  assertSameStat(source.stat, after, "legacy migration source");
}

function copyDirectoryEntries(
  sourceDirectory: MigrationDirectory,
  targetDirectory: MigrationDirectory,
  budget: TreeBudget,
  depth: number,
): void {
  if (depth > MAX_MIGRATION_TREE_DEPTH) throw new Error("legacy migration tree is too deep");
  const names = readdirSync(sourceDirectory.descriptorPath, { withFileTypes: true })
    .map((entry) => entry.name)
    .sort();
  for (const name of names) {
    const sourceChildPath = join(sourceDirectory.descriptorPath, name);
    const targetChildPath = join(targetDirectory.descriptorPath, name);
    const sourceChild = openMigrationEntry(sourceChildPath, "legacy migration source");
    try {
      const targetChild = openMigrationEntryIfPresent(targetChildPath, "legacy migration target");
      if (targetChild !== undefined) {
        try {
          const sourceWitness = treeWitnessFromEntry(sourceChild);
          const targetWitness = treeWitnessFromEntry(targetChild);
          if (!sameTreeContent(sourceWitness, targetWitness) || sourceWitness.mode !== targetWitness.mode) {
            throw new Error("legacy migration target conflicts with source");
          }
        } finally {
          targetChild.close();
        }
        continue;
      }
      if (sourceChild.kind === "directory") {
        mkdirSync(targetChildPath, { mode: PRIVATE_ROOT_MODE });
        const targetChildDirectory = openMigrationDirectory(targetChildPath, "migration target directory");
        try {
          copyDirectoryEntries(sourceChild as MigrationDirectory, targetChildDirectory, budget, depth + 1);
          fchmodSync(targetChildDirectory.fd, modeOf(sourceChild.stat));
          syncDescriptorIfSupported(targetChildDirectory.fd);
        } finally {
          targetChildDirectory.close();
        }
      } else {
        copyRegularEntry(sourceChild as MigrationFile, targetChildPath, budget);
      }
    } finally {
      sourceChild.close();
    }
  }
  const after = fstatSync(sourceDirectory.fd, { bigint: true }) as unknown as BigIntFileStat;
  assertSameStat(sourceDirectory.stat, after, "legacy migration directory");
  const namesAfter = readdirSync(sourceDirectory.descriptorPath).sort();
  if (names.length !== namesAfter.length || names.some((name, index) => name !== namesAfter[index])) {
    throw new Error("legacy migration directory entries changed after copy");
  }
  const afterPath = lstatSync(sourceDirectory.path, { bigint: true }) as unknown as BigIntFileStat;
  assertSameStat(sourceDirectory.stat, afterPath, "legacy migration source");
}

function copySourceToStaging(sourcePath: string, staging: string, source: TreeWitness): TreeWitness {
  const budget: TreeBudget = { bytes: 0, entries: 0 };
  const sourceDirectory = openMigrationDirectory(sourcePath, "legacy migration source");
  const targetDirectory = openMigrationDirectory(staging, "migration target directory");
  try {
    copyDirectoryEntries(sourceDirectory, targetDirectory, budget, 0);
  } finally {
    sourceDirectory.close();
    targetDirectory.close();
  }
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

function verifyTreeExactly(path: string, expected: TreeWitness, errorMessage: string): TreeWitness {
  const current = treeWitnessOf(path);
  if (!sameTreeWitness(current, expected)) {
    throw new Error(errorMessage);
  }
  return current;
}

function publishStaging(
  homeDir: string,
  staging: string,
  target: string,
  journal: ReadyMigrationJournal,
  admission: PublicationAdmission,
  finish: (published: MigrationJournal) => RuntimeHomeMigration,
): RuntimeHomeMigration {
  let crossDevice = false;
  try {
    renameSync(staging, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    // A same-directory EXDEV indicates a platform shim or test adapter. Copy
    // through a newly authenticated target and retain the staging tree until
    // the target witness is complete.
    crossDevice = true;
    mkdirSync(target, { mode: PRIVATE_ROOT_MODE });
  }

  // The target becomes visible at rename (or mkdir in the EXDEV fallback).
  // Acquire the root-backed publication lock immediately at that boundary;
  // all witness advancement and source removal remain inside that lock.
  return admission.withFinalLock(() => {
    if (crossDevice) {
      verifyTreeExactly(staging, journal.target, "legacy migration staging witness changed at publish");
      const sourceDirectory = openMigrationDirectory(staging, "migration staging directory");
      const targetDirectory = openMigrationDirectory(target, "migration target directory");
      try {
        copyDirectoryEntries(sourceDirectory, targetDirectory, { bytes: 0, entries: 0 }, 0);
      } finally {
        sourceDirectory.close();
        targetDirectory.close();
      }
      tightenRootMode(target);
      verifyTreeExactly(staging, journal.target, "legacy migration staging witness changed at publish");
    }
    const publishedCandidate = treeWitnessOf(target);
    if (publishedCandidate.hash !== journal.source.hash || publishedCandidate.mode !== PRIVATE_ROOT_MODE) {
      throw new Error("active migration target does not match source after publish");
    }
    const privateTarget = openPrivateRoot(target);
    privateTarget.close();
    const home = openDirectory(resolve(homeDir), "home directory");
    try { syncDescriptorIfSupported(home.fd); } finally { home.close(); }
    const published = updateJournal(journal, {
      phase: "published",
      target: publishedCandidate,
      retained: crossDevice ? journal.target : null,
    });
    writeMigrationJournal(homeDir, published, false);
    return finish(published);
  });
}

function emptyDirectoryTreeHash(): string {
  const hash = createHash("sha256");
  updateHashPart(hash, "path", "");
  updateHashPart(hash, "kind", "directory");
  return hash.digest("hex");
}

function retainedCopyMatchesSource(retained: TreeWitness, source: TreeWitness): boolean {
  const uid = currentUid();
  return retained.hash === source.hash
    && retained.mode === PRIVATE_ROOT_MODE
    && (uid === undefined || retained.uid === uid);
}

function sameRootMetadata(left: TreeWitness, right: TreeWitness): boolean {
  return sameIdentity(left.identity, right.identity)
    && left.mode === right.mode
    && left.uid === right.uid
    && left.gid === right.gid;
}

function finishPublishedMigration(homeDir: string, from: string, to: string, journal: MigrationJournal): RuntimeHomeMigration {
  const target = journal.target;
  if (target === null) throw new Error("legacy migration target witness is missing");
  assertTargetMatches(to, target);

  const retainedPath = join(resolve(homeDir), journal.stagingName);
  if (journal.phase === "published" && journal.retained !== null) {
    const retained = verifyTreeExactly(
      retainedPath,
      journal.retained,
      "legacy migration retained evidence changed",
    );
    if (!retainedCopyMatchesSource(retained, journal.source)) {
      throw new Error("legacy migration retained evidence does not match source");
    }
    const terminal = updateJournal(journal, { phase: "retained", retained });
    writeMigrationJournal(homeDir, terminal, false);
    return { migrated: true, from, to };
  }

  let retained = treeWitnessIfPresent(retainedPath);
  if (journal.phase === "retaining") {
    if (retained === undefined || !sameRootMetadata(retained, journal.retained!)) {
      throw new Error("legacy migration retaining root changed");
    }
  } else if (retained !== undefined && retainedCopyMatchesSource(retained, journal.source)) {
    const terminal = updateJournal(journal, { phase: "retained", retained });
    writeMigrationJournal(homeDir, terminal, false);
    return { migrated: true, from, to };
  } else {
    if (retained !== undefined
      && (retained.hash !== emptyDirectoryTreeHash()
        || retained.mode !== PRIVATE_ROOT_MODE
        || (currentUid() !== undefined && retained.uid !== currentUid()))) {
      throw new Error("legacy migration retained evidence path is not an empty private directory");
    }
    const source = treeWitnessIfPresent(from);
    if (source === undefined) {
      deleteMigrationJournal(homeDir);
      return { migrated: true, from, to };
    }
    if (!sameTreeWitness(source, journal.source)) throw new Error("legacy source changed during migration");
    if (retained === undefined) {
      mkdirSync(retainedPath, { mode: PRIVATE_ROOT_MODE });
      retained = treeWitnessOf(retainedPath);
    }
    const retaining = updateJournal(journal, { phase: "retaining", retained });
    writeMigrationJournal(homeDir, retaining, false);
    journal = retaining;
  }

  retained = treeWitnessOf(retainedPath);
  if (!sameRootMetadata(retained, journal.retained!)) {
    throw new Error("legacy migration retaining root changed");
  }
  if (!retainedCopyMatchesSource(retained, journal.source)) {
    const source = assertSourceMatches(from, journal.source);
    retained = copySourceToStaging(from, retainedPath, source);
  }
  const terminal = updateJournal(journal, { phase: "retained", retained });
  writeMigrationJournal(homeDir, terminal, false);
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
    case "retaining":
      return admission.withFinalLock(() => finishPublishedMigration(homeDir, from, to, journal));
    case "retained": {
      const active = openPrivateRoot(to);
      active.close();
      return { migrated: true, from, to };
    }
    case "planned": {
      const active = lstatIfPresent(to);
      const source = treeWitnessIfPresent(from);
      if (source === undefined && active === undefined) {
        throw new Error("legacy migration evidence has no authenticated source or target");
      }
      if (source === undefined || !sameTreeWitness(source, journal.source)) {
        throw new Error("legacy source changed during migration");
      }
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
        const staged = copySourceToStaging(from, staging, source);
        const ready = updateJournal(copying, { target: staged });
        writeMigrationJournal(homeDir, ready, false);
        return publishStaging(
          homeDir,
          staging,
          to,
          ready as ReadyMigrationJournal,
          admission,
          (published) => finishPublishedMigration(homeDir, from, to, published),
        );
      } catch (error) {
        // Retain the operation-owned staging inode and journal. Its recorded
        // root witness permits deterministic descriptor-bound resumption.
        throw error;
      }
    }
    case "copying": {
      assertSourceMatches(from, journal.source);
      const stagingWitness = treeWitnessIfPresent(staging);
      if (stagingWitness === undefined || journal.target === null || !sameRootMetadata(stagingWitness, journal.target)) {
        throw new Error("legacy migration staging witness is missing or changed");
      }
      const staged = copySourceToStaging(from, staging, journal.source);
      const copying = updateJournal(journal, { phase: "copying", target: staged });
      writeMigrationJournal(homeDir, copying, false);
      return publishStaging(
        homeDir,
        staging,
        to,
        copying as ReadyMigrationJournal,
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

  if (journal !== null) {
    return resumeMigration(homeDir, journal, admission);
  }

  const sourceEntry = openMigrationEntryIfPresent(from, "legacy LCM home");
  const active = lstatIfPresent(to);
  if (sourceEntry === undefined) {
    if (active !== undefined) {
      const root = openPrivateRoot(to);
      root.close();
    }
    return { migrated: false, from, to };
  }
  if (sourceEntry.kind !== "directory" || !ownerMatches(sourceEntry.stat)) {
    sourceEntry.close();
    throw new Error("legacy LCM home is not a trusted directory");
  }
  let source: TreeWitness;
  try {
    source = treeWitnessFromEntry(sourceEntry);
  } finally {
    sourceEntry.close();
  }
  if (active !== undefined) {
    // This includes an empty active root. Without a journal proving that the
    // active inode was created by this operation, history is ambiguous.
    throw new Error("legacy and active LCM homes coexist without authenticated migration evidence");
  }
  assertRootParent(topology, homeDir);
  const planned = makeJournal(source);
  writeMigrationJournal(homeDir, planned, true);
  // Keep the journal for every post-publication or ambiguous failure. The
  // source and any operation-owned staging tree are retained for recovery;
  // no pathname cleanup is safe after a hostile substitution boundary.
  return resumeMigration(homeDir, planned, admission);
}

function bootstrapLockPath(homeDir: string): string {
  return join(resolve(homeDir), ".lcm-root-bootstrap.lock");
}

type BootstrapLockOwner = Readonly<{
  version: 1;
  pid: number;
  processStartTime: string | null;
  nonce: string;
}>;

type BootstrapLockSnapshot = Readonly<{
  content: string;
  identity: Identity;
}>;

type BootstrapReclaimClaim = BootstrapLockOwner & Readonly<{
  staleDev: string;
  staleIno: string;
  staleContentSha256: string;
}>;

type BootstrapReclaimSnapshot = BootstrapLockSnapshot & Readonly<{
  claim: BootstrapReclaimClaim;
}>;

type BootstrapLock = Readonly<{
  close: () => void;
}>;

function bootstrapLockError(detail: string): Error {
  return new Error(
    `LCM root bootstrap lock could not be authenticated; automatic recovery was not attempted (${detail}); inspect the lock metadata and running processes before retrying`,
  );
}

function parseBootstrapOwnerFields(record: Record<string, unknown>, label: string): BootstrapLockOwner {
  const version = record.version;
  const pid = record.pid;
  const processStartTime = record.processStartTime;
  const nonce = record.nonce;
  if (
    version !== 1
    || typeof pid !== "number"
    || !Number.isSafeInteger(pid)
    || pid <= 0
    || (processStartTime !== null
      && (typeof processStartTime !== "string" || processStartTime.length === 0))
    || typeof nonce !== "string"
    || !/^[a-f0-9]{32}$/u.test(nonce)
  ) {
    throw new Error(`${label} owner metadata is invalid`);
  }
  return { version: 1, pid, processStartTime, nonce };
}

function parseBootstrapLockOwner(content: string, label: string): BootstrapLockOwner {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw bootstrapLockError(`${label} metadata is malformed`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw bootstrapLockError(`${label} metadata is malformed`);
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expected = ["nonce", "pid", "processStartTime", "version"];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw bootstrapLockError(`${label} owner metadata has unexpected fields`);
  }
  return parseBootstrapOwnerFields(record, label);
}

function parseBootstrapReclaimClaim(content: string, label: string): BootstrapReclaimClaim {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new Error(`${label} metadata is malformed`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} metadata is malformed`);
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expected = [
    "nonce",
    "pid",
    "processStartTime",
    "sourceContentSha256",
    "sourceDev",
    "sourceIno",
    "version",
  ];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} claim metadata has unexpected fields`);
  }
  const owner = parseBootstrapOwnerFields(record, label);
  const staleDev = record.sourceDev;
  const staleIno = record.sourceIno;
  const staleContentSha256 = record.sourceContentSha256;
  if (
    typeof staleDev !== "string"
    || !/^\d+$/u.test(staleDev)
    || typeof staleIno !== "string"
    || !/^\d+$/u.test(staleIno)
    || typeof staleContentSha256 !== "string"
    || !/^[a-f0-9]{64}$/u.test(staleContentSha256)
  ) {
    throw new Error(`${label} source metadata is invalid`);
  }
  return { ...owner, staleDev, staleIno, staleContentSha256 };
}

function readBootstrapFileSnapshot(
  path: string,
  homeDir: string,
  label: string,
): BootstrapLockSnapshot {
  try {
    const result = readBoundedRegularFileWithStat(path, {
      allowedRoot: resolve(homeDir),
      maxBytes: MAX_BOOTSTRAP_LOCK_BYTES,
      expectedUid: currentUid(),
      allowedModes: [PRIVATE_FILE_MODE],
      requireSingleLink: true,
    });
    return {
      content: result.content,
      identity: { dev: result.exactDev, ino: result.exactIno },
    };
  } catch (error) {
    throw bootstrapLockError(`${label}: ${String(error)}`);
  }
}

function readBootstrapLock(
  path: string,
  homeDir: string,
): BootstrapLockSnapshot & Readonly<{ owner: BootstrapLockOwner }> {
  const snapshot = readBootstrapFileSnapshot(path, homeDir, "existing lock");
  return { ...snapshot, owner: parseBootstrapLockOwner(snapshot.content, "bootstrap lock") };
}

function readBootstrapReclaim(
  path: string,
  homeDir: string,
): BootstrapReclaimSnapshot {
  const snapshot = readBootstrapFileSnapshot(path, homeDir, "reclaim claim");
  return { ...snapshot, claim: parseBootstrapReclaimClaim(snapshot.content, "bootstrap reclaim claim") };
}

function sameBootstrapFile(
  left: BootstrapLockSnapshot,
  right: BootstrapLockSnapshot,
): boolean {
  return sameIdentity(left.identity, right.identity) && left.content === right.content;
}

function bootstrapOwnerState(owner: BootstrapLockOwner): "live" | "stale" | "ambiguous" {
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException | undefined)?.code === "ESRCH" ? "stale" : "ambiguous";
  }
  if (owner.processStartTime === null) return "ambiguous";
  const observedStartTime = processStartTime(owner.pid);
  if (observedStartTime === null) return "ambiguous";
  if (observedStartTime !== owner.processStartTime) return "stale";
  return "live";
}

function bootstrapLockContent(): Readonly<{ content: string; owner: BootstrapLockOwner }> {
  const owner: BootstrapLockOwner = {
    version: 1,
    pid: process.pid,
    processStartTime: processStartTime(process.pid),
    nonce: randomBytes(16).toString("hex"),
  };
  return { content: `${JSON.stringify(owner)}\n`, owner };
}

function bootstrapReclaimClaimPath(lockPath: string, owner: BootstrapLockOwner): string {
  return `${lockPath}.reclaim-${owner.nonce}`;
}

function bootstrapReclaimContent(
  owner: BootstrapLockOwner,
  stale: BootstrapLockSnapshot,
): string {
  return `${JSON.stringify({
    ...owner,
    sourceDev: stale.identity.dev,
    sourceIno: stale.identity.ino,
    sourceContentSha256: sha256(stale.content),
  })}\n`;
}

function createBootstrapReclaimClaim(
  homeDir: string,
  topology: HomeTopology,
  lockPath: string,
  stale: BootstrapLockSnapshot,
  successor: Readonly<{ content: string; owner: BootstrapLockOwner }>,
): BootstrapReclaimSnapshot | undefined {
  const claimPath = bootstrapReclaimClaimPath(lockPath, parseBootstrapLockOwner(stale.content, "bootstrap lock"));
  let fd: number;
  try {
    fd = openSync(
      claimPath,
      constants.O_WRONLY
        | constants.O_CREAT
        | constants.O_EXCL
        | secureOpenFlags(),
      PRIVATE_FILE_MODE,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return undefined;
    throw error;
  }

  let claimIdentity: Identity | undefined;
  const content = bootstrapReclaimContent(successor.owner, stale);
  try {
    const stat = fstatSync(fd, { bigint: true }) as unknown as BigIntFileStat;
    claimIdentity = statIdentity(stat);
    if (!stat.isFile() || !ownerMatches(stat) || modeOf(stat) !== PRIVATE_FILE_MODE || stat.nlink !== 1n) {
      throw new Error("new bootstrap reclaim claim did not authenticate");
    }
    writeBytesToDescriptor(fd, Buffer.from(content, "utf8"));
    syncDescriptorIfSupported(fd);
    assertRootParent(topology, homeDir);
    syncDescriptorIfSupported(topology.home.fd);
    closeSync(fd);
    return {
      content,
      identity: claimIdentity,
      claim: parseBootstrapReclaimClaim(content, "bootstrap reclaim claim"),
    };
  } catch (error) {
    try { closeSync(fd); } catch { /* preserve the primary error */ }
    try {
      const current = lstatIfPresent(claimPath);
      if (current !== undefined && claimIdentity !== undefined && sameIdentity(statIdentity(current), claimIdentity)) {
        unlinkSync(claimPath);
      }
    } catch { /* preserve evidence if cleanup is ambiguous */ }
    throw error;
  }
}

function removeExactBootstrapFile(
  path: string,
  homeDir: string,
  expected: BootstrapLockSnapshot,
  label: string,
): void {
  consumeBoundedRegularFile(path, {
    allowedRoot: resolve(homeDir),
    maxBytes: MAX_BOOTSTRAP_LOCK_BYTES,
    expectedUid: currentUid(),
    allowedModes: [PRIVATE_FILE_MODE],
    requireSingleLink: true,
    expectedRawSha256: sha256(expected.content),
    _beforeUnlinkForTesting: () => {
      const current = readBootstrapFileSnapshot(path, homeDir, label);
      if (!sameBootstrapFile(current, expected)) {
        throw new Error(`${label} changed during exact removal`);
      }
    }
  });
}

function acquireBootstrapReclaimClaim(
  homeDir: string,
  topology: HomeTopology,
  lockPath: string,
  stale: BootstrapLockSnapshot,
  successor: Readonly<{ content: string; owner: BootstrapLockOwner }>,
): BootstrapReclaimSnapshot {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const created = createBootstrapReclaimClaim(homeDir, topology, lockPath, stale, successor);
    if (created !== undefined) return created;

    const claimPath = bootstrapReclaimClaimPath(lockPath, parseBootstrapLockOwner(stale.content, "bootstrap lock"));
    const existing = readBootstrapReclaim(claimPath, homeDir);
    if (
      existing.claim.staleDev !== stale.identity.dev
      || existing.claim.staleIno !== stale.identity.ino
      || existing.claim.staleContentSha256 !== sha256(stale.content)
    ) {
      throw new Error("bootstrap reclaim claim does not match the stale lock; retry the operation");
    }
    const state = bootstrapOwnerState(existing.claim);
    if (state === "live") {
      throw new Error("LCM root bootstrap stale-lock recovery is already in progress; retry after it completes");
    }
    if (state === "ambiguous") {
      throw new Error("LCM root bootstrap reclaim owner state is ambiguous; automatic recovery was not attempted; inspect the claim and running processes before retrying");
    }
    removeExactBootstrapFile(claimPath, homeDir, existing, "bootstrap reclaim claim");
  }
  throw new Error("LCM root bootstrap stale-lock recovery changed repeatedly; retry the operation");
}

function openOwnedBootstrapLock(
  homeDir: string,
  topology: HomeTopology,
  path: string,
  content: string,
): BootstrapLock {
  const fd = openSync(
    path,
    constants.O_WRONLY
      | constants.O_CREAT
      | constants.O_EXCL
      | secureOpenFlags(),
    PRIVATE_FILE_MODE,
  );
  let lockIdentity: Identity | undefined;
  try {
    const stat = fstatSync(fd, { bigint: true }) as unknown as BigIntFileStat;
    const identity = statIdentity(stat);
    lockIdentity = identity;
    fchmodSync(fd, PRIVATE_FILE_MODE);
    const checked = fstatSync(fd, { bigint: true }) as unknown as BigIntFileStat;
    if (!checked.isFile() || !ownerMatches(checked) || modeOf(checked) !== PRIVATE_FILE_MODE || checked.nlink !== 1n) {
      throw new Error("new bootstrap lock did not authenticate");
    }
    writeBytesToDescriptor(fd, Buffer.from(content, "utf8"));
    syncDescriptorIfSupported(fd);
    assertRootParent(topology, homeDir);
    return {
      close: () => {
        closeSync(fd);
        const current = lstatIfPresent(path);
        if (current === undefined || !sameIdentity(statIdentity(current), identity)) {
          throw new Error("LCM root bootstrap lock changed before release");
        }
        let currentContent: string;
        try {
          currentContent = readBootstrapFileSnapshot(path, homeDir, "bootstrap lock").content;
        } catch {
          throw new Error("LCM root bootstrap lock changed before release");
        }
        if (currentContent !== content) throw new Error("LCM root bootstrap lock changed before release");
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

function reclaimBootstrapLock(
  homeDir: string,
  topology: HomeTopology,
  path: string,
  stale: BootstrapLockSnapshot,
  successor: Readonly<{ content: string; owner: BootstrapLockOwner }>,
): BootstrapLock {
  const claim = acquireBootstrapReclaimClaim(homeDir, topology, path, stale, successor);
  let successorPublished = false;
  try {
    assertRootParent(topology, homeDir);
    const current = readBootstrapLock(path, homeDir);
    if (!sameBootstrapFile(current, stale)) {
      throw new Error("bootstrap lock changed during stale-owner recovery; retry the operation");
    }
    removeExactBootstrapFile(path, homeDir, stale, "stale bootstrap lock");
    let lock: BootstrapLock;
    try {
      lock = openOwnedBootstrapLock(homeDir, topology, path, successor.content);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === "EEXIST") {
        throw new Error("LCM root bootstrap lock was claimed concurrently; retry the operation");
      }
      throw error;
    }
    successorPublished = true;
    return lock;
  } finally {
    try {
      removeExactBootstrapFile(
        bootstrapReclaimClaimPath(path, parseBootstrapLockOwner(stale.content, "bootstrap lock")),
        homeDir,
        claim,
        "bootstrap reclaim claim",
      );
      syncDescriptorIfSupported(topology.home.fd);
    } catch (error) {
      // A published successor is authoritative; preserve the claim as evidence
      // rather than reporting acquisition failure after the protected lock exists.
      if (!successorPublished) throw error;
    }
  }
}

function acquireBootstrapLock(homeDir: string, topology: HomeTopology): BootstrapLock {
  assertRootParent(topology, homeDir);
  const path = bootstrapLockPath(homeDir);
  const successor = bootstrapLockContent();
  try {
    return openOwnedBootstrapLock(homeDir, topology, path, successor.content);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }

  const existing = readBootstrapLock(path, homeDir);
  const state = bootstrapOwnerState(existing.owner);
  if (state === "live") {
    throw new BootstrapLockContentionError(
      "LCM root bootstrap contention: verified live owner; automatic lock recovery was not attempted; "
      + "retry after the competing LCM operation completes; do not delete the bootstrap lock manually",
    );
  }
  if (state === "ambiguous") {
    throw new Error("LCM root bootstrap owner state is ambiguous; automatic recovery was not attempted; inspect the lock metadata and running processes before retrying");
  }
  return reclaimBootstrapLock(homeDir, topology, path, existing, successor);
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
