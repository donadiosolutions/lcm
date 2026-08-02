import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  cpSync,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readlinkSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  type BigIntStats,
  type Stats,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { legacyLcmHomeDirname } from "./legacy-names.js";
import {
  atomicWritePrivateFile,
  atomicWritePrivateFileExclusive,
  deleteRegularFile,
  ensurePrivateDirectory,
  readBoundedRegularFile,
} from "./security-files.js";
import {
  assertBackendPublicationConsumerAccess,
  backendPublicationDirectory,
  withBackendPublicationConsumerLock,
} from "./storage/backend-publication.js";

export const LCM_HOME_DIRNAME = ".lcm";
export const LEGACY_LCM_HOME_DIRNAME = legacyLcmHomeDirname();

export type RuntimeHomeMigration = {
  migrated: boolean;
  from: string;
  to: string;
};

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

export function migrateLegacyHomeIfNeeded(homeDir: string = homedir()): RuntimeHomeMigration {
  return withBackendPublicationConsumerLock(homeDir, () => {
    assertBackendPublicationConsumerAccess({ homeDir });
    return migrateLegacyHomeUnlocked(homeDir);
  });
}

const EXDEV_JOURNAL_VERSION = 1;
const MAX_EXDEV_JOURNAL_BYTES = 2 * 1024;

type EntryKind = "directory" | "file" | "symlink";
type Phase = "reserved" | "copying" | "ready" | "published" | "removing";
type Identity = { readonly dev: string; readonly ino: string };
type Witness = Identity & {
  readonly fullHash: string;
  readonly immutableHash: string;
  readonly stableHash: string;
};
type TreeWitness = {
  readonly bindingHash: string;
  readonly contentHash: string;
  readonly root: Witness;
  readonly rootMode: number;
};
type Journal = {
  readonly version: typeof EXDEV_JOURNAL_VERSION;
  readonly phase: Phase;
  readonly nonce: string;
  readonly sourceName: string;
  readonly targetName: string;
  readonly sourceDev: string;
  readonly sourceIno: string;
  readonly sourceHash: string;
  readonly sourceTreeHash: string;
  readonly sourceMode: number;
  readonly kind: EntryKind;
  readonly stagingName: string;
  readonly reservedAtMs: number;
  readonly containerDev: string | null;
  readonly containerIno: string | null;
  readonly containerHash: string | null;
  readonly objectDev: string | null;
  readonly objectIno: string | null;
  readonly objectHash: string | null;
  readonly objectTreeHash: string | null;
};

function identityOf(stat: Stats): Identity {
  return { dev: String(stat.dev), ino: String(stat.ino) };
}

function digestStat(stat: BigIntStats, fields: readonly (keyof BigIntStats)[]): string {
  return createHash("sha256")
    .update(fields.map((field) => `${String(field)}=${String(stat[field])}\n`).join(""))
    .digest("hex");
}

const STABLE_STAT_FIELDS = ["dev", "ino", "uid", "gid", "rdev", "birthtimeNs"] as const;
const IMMUTABLE_STAT_FIELDS = [
  ...STABLE_STAT_FIELDS,
  "mode",
  "size",
  "mtimeNs",
] as const;
const FULL_STAT_FIELDS = [
  ...IMMUTABLE_STAT_FIELDS,
  "nlink",
  "blksize",
  "blocks",
  "ctimeNs",
] as const;

function witnessOf(path: string): Witness {
  const stat = lstatSync(path, { bigint: true });
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    stableHash: digestStat(stat, STABLE_STAT_FIELDS),
    immutableHash: digestStat(stat, IMMUTABLE_STAT_FIELDS),
    fullHash: digestStat(stat, FULL_STAT_FIELDS),
  };
}

function statIfPresent(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function hasIdentity(path: string, identity: Identity): boolean {
  const current = statIfPresent(path);
  return current !== undefined
    && String(current.dev) === identity.dev
    && String(current.ino) === identity.ino;
}

function assertIdentity(path: string, identity: Identity, label: string): void {
  if (!hasIdentity(path, identity)) throw new Error(`${label} changed during cross-device migration`);
}

function entryKind(stat: Stats): EntryKind {
  if (stat.isDirectory()) return "directory";
  if (stat.isFile()) return "file";
  if (stat.isSymbolicLink()) return "symlink";
  throw new Error("unsupported legacy entry type for cross-device migration");
}

const TREE_READ_BUFFER_BYTES = 64 * 1024;

function updateTreePart(
  hash: ReturnType<typeof createHash>,
  label: string,
  value: string | Buffer,
): void {
  const bytes = typeof value === "string" ? Buffer.from(value) : value;
  hash.update(`${label}\0${bytes.length}\0`);
  hash.update(bytes);
}

function assertSameBoundStat(before: BigIntStats, after: BigIntStats, label: string): void {
  if (digestStat(before, FULL_STAT_FIELDS) !== digestStat(after, FULL_STAT_FIELDS)) {
    throw new Error(`${label} changed while building a migration tree witness`);
  }
}

function treeWitnessOf(rootPath: string, ignoredRootName?: string): TreeWitness {
  const binding = createHash("sha256");
  const content = createHash("sha256");
  let root: Witness | undefined;
  let rootMode: number | undefined;

  const visit = (path: string, relativePath: string, isRoot: boolean): void => {
    const before = lstatSync(path, { bigint: true });
    const kind = entryKind(before as unknown as Stats);
    if (isRoot) {
      root = {
        dev: String(before.dev),
        ino: String(before.ino),
        stableHash: digestStat(before, STABLE_STAT_FIELDS),
        immutableHash: digestStat(before, IMMUTABLE_STAT_FIELDS),
        fullHash: digestStat(before, FULL_STAT_FIELDS),
      };
      rootMode = Number(before.mode);
    }
    updateTreePart(binding, "path", relativePath);
    updateTreePart(binding, "kind", kind);
    updateTreePart(
      binding,
      "metadata",
      digestStat(before, isRoot ? STABLE_STAT_FIELDS : IMMUTABLE_STAT_FIELDS),
    );
    updateTreePart(content, "path", relativePath);
    updateTreePart(content, "kind", kind);
    if (!isRoot) updateTreePart(content, "mode", String(before.mode & 0o7777n));

    if (kind === "symlink") {
      const target = readlinkSync(path, { encoding: "buffer" });
      updateTreePart(binding, "symlink", target);
      updateTreePart(content, "symlink", target);
    } else {
      const flags = kind === "directory"
        ? constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
        : constants.O_RDONLY | constants.O_NOFOLLOW;
      const fd = openSync(path, flags);
      try {
        assertSameBoundStat(before, fstatSync(fd, { bigint: true }), "migration tree entry");
        if (kind === "file") {
          binding.update(`file-bytes\0${String(before.size)}\0`);
          content.update(`file-bytes\0${String(before.size)}\0`);
          const buffer = Buffer.allocUnsafe(TREE_READ_BUFFER_BYTES);
          for (;;) {
            const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
            if (bytesRead === 0) break;
            const chunk = buffer.subarray(0, bytesRead);
            binding.update(chunk);
            content.update(chunk);
          }
        } else {
          const names = readdirSync(path, { withFileTypes: true })
            .map((entry) => entry.name)
            .filter((name) => !isRoot || name !== ignoredRootName)
            .sort();
          for (const name of names) {
            visit(join(path, name), relativePath ? `${relativePath}/${name}` : name, false);
          }
          const afterNames = readdirSync(path)
            .filter((name) => !isRoot || name !== ignoredRootName)
            .sort();
          if (afterNames.length !== names.length
            || afterNames.some((name, index) => name !== names[index])) {
            throw new Error("migration directory entries changed while building a tree witness");
          }
        }
        assertSameBoundStat(before, fstatSync(fd, { bigint: true }), "migration tree entry");
      } finally {
        closeSync(fd);
      }
    }
    assertSameBoundStat(
      before,
      lstatSync(path, { bigint: true }),
      "migration tree path",
    );
  };

  visit(rootPath, "", true);
  return {
    bindingHash: binding.digest("hex"),
    contentHash: content.digest("hex"),
    root: root!,
    rootMode: rootMode!,
  };
}

function journalPath(targetPath: string): string {
  const digest = createHash("sha256").update(basename(targetPath)).digest("hex");
  return join(dirname(targetPath), `.lcm-legacy-copy-${digest}.json`);
}

function stagingName(targetName: string, nonce: string): string {
  const digest = createHash("sha256").update(`${targetName}\0${nonce}`).digest("hex");
  return `.lcm-legacy-copy-${digest}.partial`;
}

function parseJournal(content: string): Journal {
  const value = JSON.parse(content) as Partial<Journal> | null;
  const keys = [
    "containerDev", "containerHash", "containerIno", "kind", "nonce", "objectDev",
    "objectHash", "objectIno", "objectTreeHash", "phase", "reservedAtMs", "sourceDev",
    "sourceHash", "sourceIno", "sourceMode", "sourceName", "sourceTreeHash", "stagingName",
    "targetName", "version",
  ];
  if (!value || Object.keys(value).sort().join() !== keys.sort().join()
    || value.version !== EXDEV_JOURNAL_VERSION
    || (value.phase !== "reserved" && value.phase !== "copying" && value.phase !== "ready"
      && value.phase !== "published" && value.phase !== "removing")
    || (value.kind !== "directory" && value.kind !== "file" && value.kind !== "symlink")
    || typeof value.nonce !== "string" || !/^[a-f0-9]{48}$/.test(value.nonce)
    || typeof value.sourceName !== "string" || typeof value.targetName !== "string"
    || typeof value.sourceDev !== "string" || typeof value.sourceIno !== "string"
    || typeof value.sourceHash !== "string" || !/^[a-f0-9]{64}$/.test(value.sourceHash)
    || !Number.isSafeInteger(value.sourceMode) || (value.sourceMode ?? -1) < 0
    || !Number.isSafeInteger(value.reservedAtMs) || (value.reservedAtMs ?? -1) < 0
    || typeof value.stagingName !== "string"
    || ![value.containerDev, value.containerIno, value.objectDev, value.objectIno]
      .every((part) => part === null || typeof part === "string")
    || typeof value.sourceTreeHash !== "string" || !/^[a-f0-9]{64}$/.test(value.sourceTreeHash)
    || ![value.containerHash, value.objectHash, value.objectTreeHash]
      .every((part) => part === null || (typeof part === "string" && /^[a-f0-9]{64}$/.test(part)))) {
    throw new Error("invalid cross-device migration journal");
  }
  return value as Journal;
}

function readJournal(path: string, root: string): { journal: Journal; identity: Identity } | undefined {
  const before = statIfPresent(path);
  if (!before) return undefined;
  if (!before.isFile()) throw new Error("cross-device migration journal is not a regular file");
  const identity = identityOf(before);
  const journal = parseJournal(readBoundedRegularFile(path, {
    allowedRoot: root,
    maxBytes: MAX_EXDEV_JOURNAL_BYTES,
  }));
  assertIdentity(path, identity, "cross-device migration journal");
  return { journal, identity };
}

function syncDirectory(path: string, expected?: Identity): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    if (expected) {
      const current = identityOf(fstatSync(fd));
      if (current.dev !== expected.dev || current.ino !== expected.ino) {
        throw new Error("directory changed during cross-device migration");
      }
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function writeJournal(path: string, journal: Journal, exclusive: boolean): Identity {
  const content = `${JSON.stringify(journal)}\n`;
  if (exclusive) {
    if (!atomicWritePrivateFileExclusive(path, content)) {
      throw Object.assign(new Error("cross-device migration journal already exists"), { code: "EEXIST" });
    }
  } else {
    atomicWritePrivateFile(path, content);
  }
  const identity = identityOf(lstatSync(path));
  syncDirectory(dirname(path));
  return identity;
}

function deleteJournal(path: string, identity: Identity): void {
  assertIdentity(path, identity, "cross-device migration journal");
  if (!deleteRegularFile(path)) throw new Error("cross-device migration journal disappeared");
  syncDirectory(dirname(path));
}

function tokenPath(containerPath: string, nonce: string): string {
  return join(containerPath, `.lcm-legacy-copy-${nonce}.token`);
}

function tokenContent(journal: Journal): string {
  return `${JSON.stringify({
    nonce: journal.nonce,
    sourceHash: journal.sourceHash,
    sourceTreeHash: journal.sourceTreeHash,
    sourceName: journal.sourceName,
    targetName: journal.targetName,
    version: EXDEV_JOURNAL_VERSION,
  })}\n`;
}

function writeContainerToken(containerPath: string, journal: Journal): void {
  if (!atomicWritePrivateFileExclusive(tokenPath(containerPath, journal.nonce), tokenContent(journal))) {
    throw new Error("cross-device migration container token already exists");
  }
  syncDirectory(containerPath);
}

function hasContainerToken(containerPath: string, journal: Journal): boolean {
  const path = tokenPath(containerPath, journal.nonce);
  if (!statIfPresent(path)) return false;
  return readBoundedRegularFile(path, {
    allowedRoot: containerPath,
    maxBytes: 512,
  }) === tokenContent(journal);
}

function deleteContainerToken(containerPath: string, journal: Journal): void {
  if (!hasContainerToken(containerPath, journal)) {
    throw new Error("cross-device migration container token is missing or invalid");
  }
  if (!deleteRegularFile(tokenPath(containerPath, journal.nonce))) {
    throw new Error("cross-device migration container token disappeared");
  }
  syncDirectory(containerPath);
}

type QuarantineExpectation =
  | { readonly kind: "tree"; readonly hash: string; readonly rootHash: string }
  | { readonly kind: "token"; readonly hash: string; readonly journal: Journal }
  | { readonly kind: "pristine"; readonly journal: Journal };

function quarantinePath(path: string, journal: Journal, role: "container" | "source"): string {
  const parent = role === "source" ? dirname(dirname(path)) : dirname(path);
  const digest = createHash("sha256")
    .update(`${journal.targetName}\0${journal.nonce}\0${role}`)
    .digest("hex");
  return join(parent, `.lcm-legacy-quarantine-${digest}`);
}

function isPristineContainer(path: string, journal: Journal): boolean {
  const stat = lstatSync(path, { bigint: true });
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  return stat.isDirectory()
    && Number(stat.mode & 0o777n) === 0o700
    && stat.nlink === 2n
    && (uid === undefined || stat.uid === BigInt(uid))
    && (gid === undefined || stat.gid === BigInt(gid))
    && Number(stat.mtimeMs) >= journal.reservedAtMs - 2_000
    && readdirSync(path).length === 0;
}

function quarantineAndValidate(
  path: string,
  journal: Journal,
  role: "container" | "source",
  expectation: QuarantineExpectation,
): string | undefined {
  const quarantine = quarantinePath(path, journal, role);
  const canonical = statIfPresent(path);
  const retained = statIfPresent(quarantine);
  if (canonical && retained) {
    throw new Error(`cross-device migration found both canonical and quarantined ${role} paths`);
  }
  if (!retained) {
    if (!canonical) return undefined;
    renameSync(path, quarantine);
    syncDirectory(dirname(quarantine));
  }
  const witness = witnessOf(quarantine);
  const matches = expectation.kind === "tree"
      ? (() => {
        const tree = treeWitnessOf(quarantine);
        return tree.root.immutableHash === expectation.rootHash
          && tree.bindingHash === expectation.hash;
      })()
    : expectation.kind === "token"
      ? witness.stableHash === expectation.hash && hasContainerToken(quarantine, expectation.journal)
      : isPristineContainer(quarantine, expectation.journal);
  if (!matches) {
    throw new Error(`cross-device migration preserved an unrecognized ${role} at ${quarantine}`);
  }
  return quarantine;
}

function deleteQuarantinedPath(quarantine: string): void {
  rmSync(quarantine, { recursive: true, force: false });
  syncDirectory(dirname(quarantine));
}

function quarantineAndDelete(
  path: string,
  journal: Journal,
  role: "container" | "source",
  expectation: QuarantineExpectation,
): void {
  const quarantine = quarantineAndValidate(path, journal, role, expectation);
  if (quarantine) deleteQuarantinedPath(quarantine);
}

function journalIdentity(journal: Journal, prefix: "container" | "object"): Identity | undefined {
  const dev = prefix === "container" ? journal.containerDev : journal.objectDev;
  const ino = prefix === "container" ? journal.containerIno : journal.objectIno;
  return dev === null || ino === null ? undefined : { dev, ino };
}

function journalHash(journal: Journal, prefix: "container" | "object"): string | undefined {
  return (prefix === "container" ? journal.containerHash : journal.objectHash) ?? undefined;
}

function restoreCopiedDirectoryModes(
  sourcePath: string,
  targetPath: string,
  restoreThisDirectory = true,
): void {
  const fd = openSync(targetPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    for (const entry of readdirSync(sourcePath, { withFileTypes: true })) {
      const child = join(sourcePath, entry.name);
      if (lstatSync(child).isDirectory()) restoreCopiedDirectoryModes(child, join(targetPath, entry.name));
    }
    if (restoreThisDirectory) chmodSync(targetPath, lstatSync(sourcePath).mode);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function syncCopiedTree(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    for (const name of readdirSync(path)) syncCopiedTree(join(path, name));
    syncDirectory(path, identityOf(stat));
    return;
  }
  if (!stat.isFile()) throw new Error("unsupported copied entry type during cross-device migration");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const expected = identityOf(stat);
    const current = identityOf(fstatSync(fd));
    if (current.dev !== expected.dev || current.ino !== expected.ino) {
      throw new Error("copied file changed during cross-device migration");
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function newJournal(
  sourcePath: string,
  targetPath: string,
  source: Witness,
  sourceMode: number,
  kind: EntryKind,
  sourceTreeHash: string,
): Journal {
  const nonce = randomBytes(24).toString("hex");
  const targetName = basename(targetPath);
  return {
    version: EXDEV_JOURNAL_VERSION,
    phase: "reserved",
    nonce,
    sourceName: basename(sourcePath),
    targetName,
    sourceDev: source.dev,
    sourceIno: source.ino,
    sourceHash: source.immutableHash,
    sourceTreeHash,
    sourceMode,
    kind,
    stagingName: stagingName(targetName, nonce),
    reservedAtMs: Date.now(),
    containerDev: null,
    containerIno: null,
    containerHash: null,
    objectDev: null,
    objectIno: null,
    objectHash: null,
    objectTreeHash: null,
  };
}

function updatedJournal(
  journal: Journal,
  phase: Phase,
  container: Witness,
  object?: Witness,
  objectTreeHash: string | null = null,
): Journal {
  return {
    ...journal,
    phase,
    containerDev: container.dev,
    containerIno: container.ino,
    containerHash: container.stableHash,
    objectDev: object?.dev ?? null,
    objectIno: object?.ino ?? null,
    objectHash: object?.immutableHash ?? null,
    objectTreeHash,
  };
}

function hasValidJournalShape(journal: Journal): boolean {
  const container = journalIdentity(journal, "container");
  const object = journalIdentity(journal, "object");
  const containerHash = journalHash(journal, "container");
  const objectHash = journalHash(journal, "object");
  if (journal.phase === "reserved") {
    return container === undefined && object === undefined
      && containerHash === undefined && objectHash === undefined
      && journal.objectTreeHash === null;
  }
  if (!container || !containerHash) return false;
  if (journal.phase === "copying") {
    return object === undefined && objectHash === undefined && journal.objectTreeHash === null;
  }
  return object !== undefined && objectHash !== undefined && journal.objectTreeHash !== null;
}

function assertJournalLocator(journal: Journal, sourcePath: string, targetPath: string): void {
  if (journal.sourceName !== basename(sourcePath) || journal.targetName !== basename(targetPath)
    || journal.stagingName !== stagingName(journal.targetName, journal.nonce)
    || !hasValidJournalShape(journal)) {
    throw new Error("cross-device migration journal does not match the source entry");
  }
}

function assertJournalMatches(journal: Journal, sourcePath: string, targetPath: string, stat: Stats): void {
  assertJournalLocator(journal, sourcePath, targetPath);
  const sourceTree = treeWitnessOf(sourcePath);
  const source = sourceTree.root;
  if (journal.sourceDev !== source.dev || journal.sourceIno !== source.ino
    || journal.sourceHash !== source.immutableHash
    || journal.sourceTreeHash !== sourceTree.bindingHash
    || journal.sourceMode !== stat.mode
    || journal.kind !== entryKind(stat)) {
    throw new Error("cross-device migration journal does not match the source entry");
  }
}

function matchesSourceWitness(path: string, journal: Journal): boolean {
  if (!hasIdentity(path, { dev: journal.sourceDev, ino: journal.sourceIno })) return false;
  const tree = treeWitnessOf(path);
  return tree.root.immutableHash === journal.sourceHash
    && tree.bindingHash === journal.sourceTreeHash;
}

function matchesJournalWitness(path: string, journal: Journal, prefix: "container" | "object"): boolean {
  const identity = journalIdentity(journal, prefix);
  const hash = journalHash(journal, prefix);
  if (!identity || !hash || !hasIdentity(path, identity)) return false;
  const witness = witnessOf(path);
  return prefix === "container" ? witness.stableHash === hash : witness.immutableHash === hash;
}

function matchesPublishedObject(path: string, journal: Journal): boolean {
  const prefix = journal.kind === "directory" && journal.phase === "ready"
    ? "container"
    : "object";
  if (!matchesJournalWitness(path, journal, prefix)) return false;
  const ignoredToken = journal.phase === "ready"
    && journal.kind === "directory" ? basename(tokenPath(path, journal.nonce))
    : undefined;
  return treeWitnessOf(path, ignoredToken).bindingHash === journal.objectTreeHash;
}

function assertReadyObjectTree(
  path: string,
  journal: Journal,
  label: string,
  requireFinalDirectoryMode = false,
): TreeWitness {
  const ignoredToken = journal.kind === "directory"
    ? basename(tokenPath(path, journal.nonce))
    : undefined;
  const tree = treeWitnessOf(path, ignoredToken);
  const rootMatches = journal.kind === "directory"
    ? !requireFinalDirectoryMode || tree.rootMode === journal.sourceMode
    : tree.root.immutableHash === journal.objectHash;
  if (tree.bindingHash !== journal.objectTreeHash || !rootMatches) {
    throw new Error(`${label} changed after ready publication`);
  }
  return tree;
}

function containerPathFor(targetPath: string, journal: Journal): string {
  return journal.kind === "directory"
    ? targetPath
    : join(dirname(targetPath), journal.stagingName);
}

function cleanupPartialContainer(
  targetPath: string,
  journal: Journal,
  allowPristine: boolean,
): void {
  const path = containerPathFor(targetPath, journal);
  quarantineAndDelete(
    path,
    journal,
    "container",
    allowPristine
      ? { kind: "pristine", journal }
      : { kind: "token", hash: journalHash(journal, "container")!, journal },
  );
}

function finalizeDirectoryPublication(
  targetPath: string,
  markerPath: string,
  journal: Journal,
): { journal: Journal; identity: Identity } {
  if (!matchesPublishedObject(targetPath, journal)) {
    throw new Error("cross-device migration directory changed before publication");
  }
  if (hasContainerToken(targetPath, journal)) {
    deleteContainerToken(targetPath, journal);
    assertReadyObjectTree(targetPath, journal, "cross-device migration directory");
  }
  chmodSync(targetPath, journal.sourceMode);
  assertReadyObjectTree(targetPath, journal, "cross-device migration directory", true);
  syncDirectory(targetPath);
  assertReadyObjectTree(targetPath, journal, "cross-device migration directory", true);
  syncDirectory(dirname(targetPath));
  const targetTree = assertReadyObjectTree(
    targetPath,
    journal,
    "cross-device migration directory",
    true,
  );
  const target = targetTree.root;
  const published = updatedJournal(journal, "published", target, target, journal.objectTreeHash);
  return { journal: published, identity: writeJournal(markerPath, published, false) };
}

function recoverCrossDeviceCopy(sourcePath: string, targetPath: string): "none" | "retry" | "published" {
  const markerPath = journalPath(targetPath);
  const read = readJournal(markerPath, dirname(targetPath));
  if (!read) return "none";
  let { journal } = read;
  assertJournalMatches(journal, sourcePath, targetPath, lstatSync(sourcePath));
  const containerPath = containerPathFor(targetPath, journal);
  if (journal.phase === "reserved") {
    cleanupPartialContainer(targetPath, journal, true);
    deleteJournal(markerPath, read.identity);
    return "retry";
  }
  if (journal.phase === "copying") {
    cleanupPartialContainer(targetPath, journal, false);
    deleteJournal(markerPath, read.identity);
    return "retry";
  }
  if (journal.phase === "ready" && journal.kind === "directory") {
    journal = finalizeDirectoryPublication(targetPath, markerPath, journal).journal;
    return "published";
  }
  if (journal.phase === "ready") {
    const target = statIfPresent(targetPath);
    if (target && matchesPublishedObject(targetPath, journal)) {
      cleanupPartialContainer(targetPath, journal, false);
      const publishedTree = assertReadyObjectTree(
        targetPath,
        journal,
        "cross-device migration leaf target",
      );
      const publishedTarget = publishedTree.root;
      const published: Journal = {
        ...updatedJournal(
          journal,
          "published",
          publishedTarget,
          publishedTarget,
          journal.objectTreeHash,
        ),
        objectHash: journal.objectHash,
      };
      writeJournal(markerPath, published, false);
      return "published";
    }
    if (statIfPresent(containerPath)) cleanupPartialContainer(targetPath, journal, false);
    if (target) throw new Error("cross-device migration target changed before recovery");
    deleteJournal(markerPath, read.identity);
    return "retry";
  }
  if (!matchesPublishedObject(targetPath, journal)) {
    throw new Error("cross-device migration published target changed before source removal");
  }
  return "published";
}

function copyDirectoryAcrossDevices(
  sourcePath: string,
  targetPath: string,
  sourceTree: TreeWitness,
  sourceMode: number,
): void {
  const markerPath = journalPath(targetPath);
  let journal = newJournal(
    sourcePath,
    targetPath,
    sourceTree.root,
    sourceMode,
    "directory",
    sourceTree.bindingHash,
  );
  let markerIdentity = writeJournal(markerPath, journal, true);
  try {
    mkdirSync(targetPath, { mode: 0o700 });
    writeContainerToken(targetPath, journal);
    const target = witnessOf(targetPath);
    journal = updatedJournal(journal, "copying", target);
    markerIdentity = writeJournal(markerPath, journal, false);
    cpSync(sourcePath, targetPath, {
      recursive: true,
      force: false,
      errorOnExist: true,
      verbatimSymlinks: true,
    });
    restoreCopiedDirectoryModes(sourcePath, targetPath, false);
    const currentSourceTree = treeWitnessOf(sourcePath);
    if (currentSourceTree.bindingHash !== sourceTree.bindingHash
      || currentSourceTree.root.fullHash !== sourceTree.root.fullHash) {
      throw new Error("legacy source tree changed during cross-device migration");
    }
    syncCopiedTree(targetPath);
    const copiedTree = treeWitnessOf(targetPath, basename(tokenPath(targetPath, journal.nonce)));
    if (copiedTree.contentHash !== currentSourceTree.contentHash) {
      throw new Error("copied directory tree does not match the legacy source");
    }
    const copied = copiedTree.root;
    journal = updatedJournal(journal, "ready", copied, copied, copiedTree.bindingHash);
    markerIdentity = writeJournal(markerPath, journal, false);
    ({ journal, identity: markerIdentity } = finalizeDirectoryPublication(targetPath, markerPath, journal));
  } catch (error) {
    if (journal.phase === "reserved" || journal.phase === "copying") {
      cleanupPartialContainer(targetPath, journal, journal.phase === "reserved");
      deleteJournal(markerPath, markerIdentity);
    }
    throw error;
  }
}

function copyLeafAcrossDevices(
  sourcePath: string,
  targetPath: string,
  sourceTree: TreeWitness,
  sourceMode: number,
  kind: Exclude<EntryKind, "directory">,
): void {
  const markerPath = journalPath(targetPath);
  let journal = newJournal(
    sourcePath,
    targetPath,
    sourceTree.root,
    sourceMode,
    kind,
    sourceTree.bindingHash,
  );
  let markerIdentity = writeJournal(markerPath, journal, true);
  const stagingPath = containerPathFor(targetPath, journal);
  const payloadPath = join(stagingPath, "entry");
  try {
    mkdirSync(stagingPath, { mode: 0o700 });
    writeContainerToken(stagingPath, journal);
    const staging = witnessOf(stagingPath);
    journal = updatedJournal(journal, "copying", staging);
    markerIdentity = writeJournal(markerPath, journal, false);
    cpSync(sourcePath, payloadPath, {
      recursive: false,
      force: false,
      errorOnExist: true,
      verbatimSymlinks: true,
    });
    const currentSourceTree = treeWitnessOf(sourcePath);
    if (currentSourceTree.bindingHash !== sourceTree.bindingHash
      || currentSourceTree.root.fullHash !== sourceTree.root.fullHash) {
      throw new Error("legacy source tree changed during cross-device migration");
    }
    syncCopiedTree(payloadPath);
    syncDirectory(stagingPath);
    const payloadTree = treeWitnessOf(payloadPath);
    if (payloadTree.contentHash !== currentSourceTree.contentHash) {
      throw new Error("copied leaf content does not match the legacy source");
    }
    const payload = payloadTree.root;
    journal = updatedJournal(
      journal,
      "ready",
      witnessOf(stagingPath),
      payload,
      payloadTree.bindingHash,
    );
    markerIdentity = writeJournal(markerPath, journal, false);
    linkSync(payloadPath, targetPath);
    syncDirectory(dirname(targetPath));
    if (!matchesPublishedObject(targetPath, journal)) {
      throw new Error("published migration target changed during cross-device migration");
    }
    cleanupPartialContainer(targetPath, journal, false);
    const targetTree = assertReadyObjectTree(
      targetPath,
      journal,
      "cross-device migration leaf target",
    );
    const target = targetTree.root;
    journal = {
      ...updatedJournal(journal, "published", target, target, journal.objectTreeHash),
      objectHash: journal.objectHash,
    };
    markerIdentity = writeJournal(markerPath, journal, false);
  } catch (error) {
    if (journal.phase === "reserved" || journal.phase === "copying") {
      cleanupPartialContainer(targetPath, journal, journal.phase === "reserved");
      deleteJournal(markerPath, markerIdentity);
    }
    throw error;
  }
}

function removePublishedSource(sourcePath: string, targetPath: string): void {
  const markerPath = journalPath(targetPath);
  const read = readJournal(markerPath, dirname(targetPath));
  if (!read) throw new Error("cross-device migration publication journal is missing");
  let { journal } = read;
  assertJournalLocator(journal, sourcePath, targetPath);
  if (journal.phase !== "published" && journal.phase !== "removing") {
    throw new Error("cross-device migration source removal was requested before publication");
  }
  if (!matchesPublishedObject(targetPath, journal)) {
    throw new Error("cross-device migration published target changed before source removal");
  }
  if (statIfPresent(sourcePath) && !matchesSourceWitness(sourcePath, journal)) {
    throw new Error("cross-device migration source changed before source removal");
  }
  let markerIdentity = read.identity;
  if (journal.phase === "published") {
    journal = { ...journal, phase: "removing" };
    markerIdentity = writeJournal(markerPath, journal, false);
  }
  const quarantine = quarantineAndValidate(
    sourcePath,
    journal,
    "source",
    { kind: "tree", hash: journal.sourceTreeHash, rootHash: journal.sourceHash },
  );
  if (!matchesPublishedObject(targetPath, journal)) {
    throw new Error("cross-device migration published target changed during source removal");
  }
  if (quarantine) deleteQuarantinedPath(quarantine);
  deleteJournal(markerPath, markerIdentity);
}

function recoverInterruptedSourceRemovals(from: string, to: string): void {
  for (const name of readdirSync(to)) {
    if (!/^\.lcm-legacy-copy-[a-f0-9]{64}\.json$/.test(name)) continue;
    const markerPath = join(to, name);
    const read = readJournal(markerPath, to);
    if (!read || read.journal.phase !== "removing") continue;
    const sourcePath = join(from, read.journal.sourceName);
    const targetPath = join(to, read.journal.targetName);
    assertJournalLocator(read.journal, sourcePath, targetPath);
    removePublishedSource(sourcePath, targetPath);
  }
}

function migrateLegacyHomeUnlocked(homeDir: string): RuntimeHomeMigration {
  const from = legacyLcmHomeDir(homeDir);
  const to = lcmHomeDir(homeDir);
  if (existsSync(backendPublicationDirectory(homeDir))) {
    return { migrated: false, from, to };
  }
  mkdirSync(dirname(to), { recursive: true });
  // The publication consumer preflight has already established the active
  // root, so legacy migration always merges entries into that trusted root.
  mkdirSync(to, { recursive: true });
  recoverInterruptedSourceRemovals(from, to);
  if (!existsSync(from)) {
    ensurePrivateDirectory(to);
    return { migrated: false, from, to };
  }
  if (existsSync(join(to, "config.json")) || existsSync(join(to, "projects")) || existsSync(join(to, "events"))) {
    ensurePrivateDirectory(to);
    return { migrated: false, from, to };
  }
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const sourcePath = join(from, entry.name);
    const targetPath = join(to, entry.name);
    const recovery = recoverCrossDeviceCopy(sourcePath, targetPath);
    if (recovery === "published") {
      removePublishedSource(sourcePath, targetPath);
      continue;
    }
    if (existsSync(targetPath)) continue;
    try {
      renameSync(sourcePath, targetPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
      const sourceStat = lstatSync(sourcePath);
      const kind = entryKind(sourceStat);
      const sourceTree = treeWitnessOf(sourcePath);
      if (kind === "directory") {
        copyDirectoryAcrossDevices(sourcePath, targetPath, sourceTree, sourceTree.rootMode);
      } else {
        copyLeafAcrossDevices(sourcePath, targetPath, sourceTree, sourceTree.rootMode, kind);
      }
      removePublishedSource(sourcePath, targetPath);
    }
  }
  rmSync(from, { recursive: true, force: true });
  ensurePrivateDirectory(to);
  return { migrated: true, from, to };
}
