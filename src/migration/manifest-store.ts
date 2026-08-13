import { createHash } from "node:crypto";
import {
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  opendirSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { withPrivateMutationLock } from "../private-mutation-lock.js";
import {
  atomicWritePrivateFileDurable,
  assertPrivateDirectory,
  consumeBoundedRegularFile,
  consumeAuthenticatedWriterAlias,
  openPrivateDirectory,
  readBoundedRegularFileWithStat,
  syncPrivateDirectory,
  type PrivateDirectoryHandle,
} from "../security-files.js";
import {
  assertHomeLockTopology,
  closeHomeLockTopology,
  openHomeLockTopology,
  restoreHomeLockTopologyMode,
} from "../storage/home-lock-topology.js";
import {
  MigrationProtocolError,
  assertMigrationManifestGenesis,
  assertMigrationManifestSuccessor,
  parseMigrationManifest,
  type MigrationManifest,
  type MigrationManifestHead,
} from "./protocol.js";

const GENERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const MANIFEST_FILENAME_PATTERN = /^([0-9a-f]{64})\.json$/u;
const MAX_MANIFEST_BYTES = 1 * 1024 * 1024;

function invalidPathInput(message: string): never {
  throw new MigrationProtocolError("invalid-input", message);
}

function assertGenerationId(generationId: string): void {
  if (typeof generationId !== "string" || !GENERATION_ID_PATTERN.test(generationId)) {
    return invalidPathInput("migration generation id is invalid");
  }
}

function isSafeRevision(revision: unknown): revision is number {
  return typeof revision === "number" && Number.isSafeInteger(revision) && revision >= 0;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !value.endsWith("Z")) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function headPayloadContent(
  value: Omit<MigrationManifestHead, "checksumSha256">,
): string {
  return `{"generationId":${JSON.stringify(value.generationId)},"manifestSha256":"${value.manifestSha256}","revision":${value.revision},"revisionFilename":"${value.revisionFilename}","updatedAt":"${value.updatedAt}","version":1}`;
}

function sealedHeadContent(value: MigrationManifestHead): string {
  return `{"checksumSha256":"${value.checksumSha256}","generationId":${JSON.stringify(value.generationId)},"manifestSha256":"${value.manifestSha256}","revision":${value.revision},"revisionFilename":"${value.revisionFilename}","updatedAt":"${value.updatedAt}","version":1}\n`;
}

function malformedHead(message: string): never {
  throw new MigrationProtocolError("malformed-manifest", message);
}

function exactHeadKeys(value: Record<string, unknown>): boolean {
  const expected = [
    "checksumSha256",
    "generationId",
    "manifestSha256",
    "revision",
    "revisionFilename",
    "updatedAt",
    "version",
  ];
  const actual = Object.keys(value).sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function migrationRoot(homeDir?: string): string {
  return join(resolve(homeDir ?? homedir()), ".lcm", "migrations");
}

function lcmRoot(homeDir: string): string {
  return join(homeDir, ".lcm");
}

type CanonicalJson = null | boolean | number | string
  | readonly CanonicalJson[]
  | Readonly<{ [key: string]: CanonicalJson }>;

function canonicalJson(value: CanonicalJson): string {
  if (
    value === null
    || typeof value === "boolean"
    || typeof value === "string"
    || typeof value === "number"
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Readonly<Record<string, CanonicalJson>>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key]!)}`).join(",")}}`;
}

function manifestContent(manifest: MigrationManifest): string {
  return `${canonicalJson(manifest as unknown as CanonicalJson)}\n`;
}

function boundedManifestContent(manifest: MigrationManifest): string {
  const content = manifestContent(manifest);
  if (Buffer.byteLength(content, "utf8") > MAX_MANIFEST_BYTES) {
    throw new MigrationProtocolError("invalid-input", "migration manifest exceeds the size limit");
  }
  return content;
}

function parseManifestContent(content: string): MigrationManifest {
  if (!/^[\x00-\x7f]*$/u.test(content) || !content.endsWith("\n")) {
    return malformedHead("migration manifest content is invalid");
  }
  let value: unknown;
  try {
    value = JSON.parse(content.slice(0, -1));
  } catch (error) {
    throw new MigrationProtocolError("malformed-manifest", "migration manifest JSON is invalid", {
      cause: error,
    });
  }
  const manifest = parseMigrationManifest(value);
  if (content !== manifestContent(manifest)) {
    return malformedHead("migration manifest content is not canonical");
  }
  return manifest;
}

function currentUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function closeHandles(handles: readonly PrivateDirectoryHandle[]): unknown[] {
  const errors: unknown[] = [];
  for (const handle of [...handles].reverse()) {
    try {
      handle.close();
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

function revisionDirectoryName(revision: number): string {
  return revision.toString(10).padStart(16, "0");
}

function withAuthenticatedDirectories<T>(
  paths: readonly string[],
  expectedUid: number | undefined,
  callback: () => T,
): T {
  const handles: PrivateDirectoryHandle[] = [];
  let result: T | undefined;
  let primaryError: unknown;
  try {
    for (const path of paths) handles.push(openPrivateDirectory(path, { expectedUid }));
    for (let index = 0; index < paths.length; index += 1) {
      assertPrivateDirectory(handles[index]!, paths[index]!, handles[index]!.witness, expectedUid);
    }
    result = callback();
    for (let index = 0; index < paths.length; index += 1) {
      assertPrivateDirectory(handles[index]!, paths[index]!, undefined, expectedUid);
    }
  } catch (error) {
    primaryError = error;
  } finally {
    const cleanupErrors = closeHandles(handles);
    if (primaryError !== undefined && cleanupErrors.length > 0) {
      throw new AggregateError(
        [primaryError, ...cleanupErrors],
        "migration manifest operation and directory cleanup failed",
        { cause: primaryError },
      );
    }
    if (cleanupErrors.length === 1) throw cleanupErrors[0];
    if (cleanupErrors.length > 1) {
      throw new AggregateError(cleanupErrors, "migration manifest directory cleanup failed");
    }
  }
  if (primaryError !== undefined) throw primaryError;
  return result as T;
}

function readDirectoryEntriesBounded(path: string, maxEntries: number): string[] {
  const directory = opendirSync(path, { bufferSize: 1 });
  const entries: string[] = [];
  try {
    while (entries.length <= maxEntries) {
      const entry = directory.readSync();
      if (entry === null) break;
      entries.push(entry.name);
    }
  } finally {
    directory.closeSync();
  }
  return entries;
}

type AuthenticatedManifestState = Readonly<{
  head: MigrationManifestHead;
  headContent: string;
  headAliasPath: string | null;
  headTemporary: AuthenticatedHeadTemporary | null;
  manifest: MigrationManifest;
  generation: string;
  revisions: string;
}>;

function assertNoImmediateSuccessor(
  revisions: string,
  revision: number,
): void {
  if (revision === Number.MAX_SAFE_INTEGER) return;
  const successorPath = join(revisions, revisionDirectoryName(revision + 1));
  try {
    lstatSync(successorPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new MigrationProtocolError(
    "recovery-required",
    "migration manifest has an unpublished immediate successor",
  );
}

function exactRecoveryCandidate(
  revisions: string,
  generationId: string,
  revision: number,
  previousManifestSha256: string | null,
  expectedUid: number | undefined,
): Readonly<{ kind: "manifest"; manifest: MigrationManifest; directory: string }>
  | Readonly<{ kind: "incomplete"; directory: string }>
  | null {
  const directory = join(revisions, revisionDirectoryName(revision));
  try {
    lstatSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  return withAuthenticatedDirectories([directory], expectedUid, () => {
    const entries = readDirectoryEntriesBounded(directory, 2);
    if (entries.length === 0) return { kind: "incomplete", directory };
    const manifestEntries = entries.filter((entry) => MANIFEST_FILENAME_PATTERN.test(entry));
    if (manifestEntries.length === 0 && entries.length === 1) {
      const scratch = revisionScratchMatch(entries[0]!);
      if (scratch !== null) {
        // Authenticate the scratch against its own exact filename here. Because
        // incomplete evidence never advances the head, the intended candidate
        // checksum is bound later by the exact create/update retry.
        assertRecoverableRevisionEntries(directory, scratch[1]!, expectedUid);
        return { kind: "incomplete", directory };
      }
    }
    if (manifestEntries.length !== 1) {
      return malformedHead("migration manifest recovery directory is ambiguous");
    }
    const match = MANIFEST_FILENAME_PATTERN.exec(manifestEntries[0]!)!;
    const checksumSha256 = match[1]!;
    const state = assertRecoverableRevisionEntries(directory, checksumSha256, expectedUid);
    const manifest = parseManifestContent(state.manifestContent!);
    if (
      manifest.generationId !== generationId
      || manifest.revision !== revision
      || manifest.checksumSha256 !== checksumSha256
    ) {
      return malformedHead("migration manifest recovery candidate does not match its path");
    }
    if (manifest.previousManifestSha256 !== previousManifestSha256) {
      throw new MigrationProtocolError(
        "unexpected-state",
        "migration manifest recovery candidate has the wrong predecessor",
      );
    }
    return { kind: "manifest", manifest, directory };
  });
}

function assertNoRecoverySecondHop(revisions: string, revision: number): void {
  if (revision === Number.MAX_SAFE_INTEGER) return;
  const secondHop = join(revisions, revisionDirectoryName(revision + 1));
  try {
    lstatSync(secondHop);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new MigrationProtocolError(
    "unexpected-state",
    "migration manifest recovery found a forbidden second hop",
  );
}

function ensurePrivateChild(
  parentPath: string,
  name: string,
  expectedUid: number | undefined,
): string {
  const childPath = join(parentPath, name);
  return withAuthenticatedDirectories([parentPath], expectedUid, () => {
    let created = false;
    try {
      mkdirSync(childPath, { mode: 0o700 });
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const child = openPrivateDirectory(childPath, { expectedUid });
    try {
      if (created) {
        fchmodSync(child.fd, 0o700);
        fsyncSync(child.fd);
      }
      assertPrivateDirectory(child, childPath, child.witness, expectedUid);
    } finally {
      child.close();
    }
    if (created) {
      const parent = openPrivateDirectory(parentPath, { expectedUid });
      try {
        fsyncSync(parent.fd);
      } finally {
        parent.close();
      }
    }
    return childPath;
  });
}

function revisionScratchMatch(name: string): RegExpMatchArray | null {
  return /^\.([0-9a-f]{64})\.json\.[0-9a-f]{24}\.tmp$/u.exec(name);
}

function headScratchMatch(name: string): RegExpMatchArray | null {
  return /^\.head\.json\.[0-9a-f]{24}\.tmp$/u.exec(name);
}

function exactWriterLinkPair(
  left: ReturnType<typeof readBoundedRegularFileWithStat>,
  right: ReturnType<typeof readBoundedRegularFileWithStat>,
): boolean {
  return left.nlink === "2"
    && right.nlink === "2"
    && left.exactDev === right.exactDev
    && left.exactIno === right.exactIno
    && left.parentDev === right.parentDev
    && left.parentIno === right.parentIno
    && left.mode === right.mode
    && left.uid === right.uid
    && left.gid === right.gid
    && left.mtimeMs === right.mtimeMs
    && left.content === right.content;
}

type AuthenticatedHeadContent =
  | Readonly<{
    kind: "absent";
    temporary: AuthenticatedHeadTemporary | null;
  }>
  | Readonly<{
    kind: "present";
    content: string;
    aliasPath: string | null;
    temporary: AuthenticatedHeadTemporary | null;
  }>;

type AuthenticatedHeadTemporary = Readonly<{
  path: string;
  head: MigrationManifestHead;
  contentSha256: string;
}>;

function readAuthenticatedHeadContent(
  generation: string,
  expectedUid: number | undefined,
): AuthenticatedHeadContent {
  try {
    const entries = readDirectoryEntriesBounded(generation, 3);
    if (entries.length > 3) return malformedHead("migration manifest head directory is ambiguous");
    const scratchEntries = entries.filter((entry) => headScratchMatch(entry) !== null);
    if (entries.some((entry) => entry !== "revisions" && entry !== "head.json" && headScratchMatch(entry) === null)) {
      return malformedHead("migration manifest head directory is ambiguous");
    }
    if (scratchEntries.length > 1) {
      return malformedHead("migration manifest head directory is ambiguous");
    }
    const headPresent = entries.includes("head.json");
    if (!headPresent) {
      if (scratchEntries.length === 0) {
        return { kind: "absent", temporary: null };
      }
      const temporaryPath = join(generation, scratchEntries[0]!);
      const temporaryContent = readBoundedRegularFileWithStat(temporaryPath, {
        allowedRoot: generation,
        maxBytes: MAX_MANIFEST_BYTES,
        expectedUid,
        allowedModes: [0o600],
        requireSingleLink: true,
      }).content;
      return {
        kind: "absent",
        temporary: {
          path: temporaryPath,
          head: parseMigrationManifestHeadContent(temporaryContent),
          contentSha256: sha256(temporaryContent),
        },
      };
    }
    const head = readBoundedRegularFileWithStat(join(generation, "head.json"), {
      allowedRoot: generation,
      maxBytes: MAX_MANIFEST_BYTES,
      expectedUid,
      allowedModes: [0o600],
      requireSingleLink: false,
    });
    if (scratchEntries.length === 0) {
      if (head.nlink !== "1") return malformedHead("migration manifest head has invalid link topology");
      return {
        kind: "present",
        content: head.content,
        aliasPath: null,
        temporary: null,
      };
    }
    const scratchPath = join(generation, scratchEntries[0]!);
    const scratch = readBoundedRegularFileWithStat(scratchPath, {
      allowedRoot: generation,
      maxBytes: MAX_MANIFEST_BYTES,
      expectedUid,
      allowedModes: [0o600],
      requireSingleLink: false,
    });
    if (exactWriterLinkPair(head, scratch)) {
      return {
        kind: "present",
        content: head.content,
        aliasPath: scratchPath,
        temporary: null,
      };
    }
    if (head.nlink !== "1" || scratch.nlink !== "1") {
      return malformedHead("migration manifest head has invalid link topology");
    }
    return {
      kind: "present",
      content: head.content,
      aliasPath: null,
      temporary: {
        path: scratchPath,
        head: parseMigrationManifestHeadContent(scratch.content),
        contentSha256: sha256(scratch.content),
      },
    };
  } catch (error) {
    if (error instanceof MigrationProtocolError) throw error;
    throw new MigrationProtocolError(
      "malformed-manifest",
      "migration manifest head is invalid",
      { cause: error },
    );
  }
}

function assertHeadMatchesManifest(
  head: MigrationManifestHead,
  manifest: MigrationManifest,
): void {
  if (
    head.generationId !== manifest.generationId
    || head.revision !== manifest.revision
    || head.manifestSha256 !== manifest.checksumSha256
    || head.updatedAt !== manifest.updatedAt
  ) {
    return malformedHead("migration manifest head writer temporary does not match its immutable revision");
  }
}

function consumeAuthenticatedHeadTemporary(
  generation: string,
  temporary: AuthenticatedHeadTemporary,
  expectedUid: number | undefined,
): void {
  try {
    consumeBoundedRegularFile(temporary.path, {
      allowedRoot: generation,
      maxBytes: MAX_MANIFEST_BYTES,
      expectedUid,
      allowedModes: [0o600],
      requireSingleLink: true,
      expectedRawSha256: temporary.contentSha256,
    });
    syncPrivateDirectory(generation, { expectedUid });
  } catch (error) {
    throw new MigrationProtocolError(
      "malformed-manifest",
      "migration manifest head writer temporary is invalid",
      { cause: error },
    );
  }
}

function assertHeadTemporarySuccessor(
  revisions: string,
  current: MigrationManifest,
  temporary: AuthenticatedHeadTemporary,
  expectedUid: number | undefined,
): MigrationManifest {
  const candidate = exactRecoveryCandidate(
    revisions,
    current.generationId,
    current.revision + 1,
    current.checksumSha256,
    expectedUid,
  );
  if (candidate?.kind !== "manifest") {
    return malformedHead("migration manifest head writer temporary has no immutable successor revision");
  }
  const successor = assertMigrationManifestSuccessor(current, candidate.manifest);
  assertHeadMatchesManifest(temporary.head, successor);
  return successor;
}

function assertHeadTemporaryGenesis(
  revisions: string,
  generationId: string,
  temporary: AuthenticatedHeadTemporary,
  expectedUid: number | undefined,
): MigrationManifest {
  const candidate = exactRecoveryCandidate(
    revisions,
    generationId,
    0,
    null,
    expectedUid,
  );
  if (candidate?.kind !== "manifest") {
    return malformedHead("migration manifest head writer temporary has no immutable genesis revision");
  }
  const genesis = assertMigrationManifestGenesis(candidate.manifest);
  assertHeadMatchesManifest(temporary.head, genesis);
  return genesis;
}

function consumeAuthenticatedHeadAlias(
  headPath: string,
  aliasPath: string,
  expectedUid: number | undefined,
): void {
  try {
    consumeAuthenticatedWriterAlias(headPath, aliasPath, {
      maxBytes: MAX_MANIFEST_BYTES,
      expectedUid,
      allowedModes: [0o600],
    });
  } catch (error) {
    throw new MigrationProtocolError(
      "malformed-manifest",
      "migration manifest head writer alias is invalid",
      { cause: error },
    );
  }
}

function assertRecoverableRevisionEntries(
  directory: string,
  checksumSha256: string,
  expectedUid: number | undefined,
): Readonly<{ manifestContent: string | null }> {
  const entries = readDirectoryEntriesBounded(directory, 2);
  if (entries.length > 2) return malformedHead("migration manifest revision directory is ambiguous");
  const manifestName = `${checksumSha256}.json`;
  const manifestPresent = entries.includes(manifestName);
  if (!manifestPresent && entries.length > 1) {
    return malformedHead("migration manifest revision directory is ambiguous");
  }
  for (const entry of entries) {
    if (entry === manifestName) continue;
    const scratch = revisionScratchMatch(entry);
    if (scratch === null || scratch[1] !== checksumSha256) {
      return malformedHead("migration manifest revision directory is ambiguous");
    }
  }
  const allowPostLinkPair = manifestPresent && entries.length === 2;
  const authenticated = new Map(entries.map((entry) => [
    entry,
    readBoundedRegularFileWithStat(join(directory, entry), {
      allowedRoot: directory,
      maxBytes: MAX_MANIFEST_BYTES,
      expectedUid,
      allowedModes: [0o600],
      requireSingleLink: !allowPostLinkPair,
    }),
  ]));
  if (allowPostLinkPair) {
    const manifest = authenticated.get(manifestName)!;
    const scratch = authenticated.get(entries.find((entry) => entry !== manifestName)!)!;
    if (!exactWriterLinkPair(manifest, scratch)) {
      return malformedHead("migration manifest revision directory has invalid link topology");
    }
  }
  return { manifestContent: authenticated.get(manifestName)?.content ?? null };
}

function stageRevision(
  revisions: string,
  manifest: MigrationManifest,
  content: string,
  expectedUid: number | undefined,
  beforeContentPublication: (directory: string) => void,
): string {
  const revisionName = revisionDirectoryName(manifest.revision);
  const revisionDirectory = ensurePrivateChild(revisions, revisionName, expectedUid);
  return withAuthenticatedDirectories([revisions, revisionDirectory], expectedUid, () => {
    const state = assertRecoverableRevisionEntries(
      revisionDirectory,
      manifest.checksumSha256,
      expectedUid,
    );
    if (state.manifestContent !== null) {
      throw new MigrationProtocolError(
        "recovery-required",
        "migration manifest revision was already published",
      );
    }
    const scratch = readDirectoryEntriesBounded(revisionDirectory, 1)
      .find((entry) => revisionScratchMatch(entry) !== null);
    if (scratch !== undefined) {
      consumeBoundedRegularFile(join(revisionDirectory, scratch), {
        allowedRoot: revisionDirectory,
        maxBytes: MAX_MANIFEST_BYTES,
        expectedUid,
        allowedModes: [0o600],
        requireSingleLink: true,
      });
    }
    beforeContentPublication(revisionDirectory);
    atomicWritePrivateFileDurable(
      join(revisionDirectory, `${manifest.checksumSha256}.json`),
      content,
      {
        expectedUid,
        expectedContentSha256: null,
        requireAbsent: true,
        maxExistingBytes: MAX_MANIFEST_BYTES,
      },
    );
    return revisionDirectory;
  });
}

function withManifestMutationLock<T>(
  homeDir: string | undefined,
  expectedUid: number | undefined,
  callback: () => T,
): T {
  const topology = openHomeLockTopology(homeDir, expectedUid);
  try {
    return withPrivateMutationLock(
      migrationManifestLockPath(homeDir),
      "migration manifest",
      () => {
        assertHomeLockTopology(topology);
        restoreHomeLockTopologyMode(topology);
        const result = callback();
        assertHomeLockTopology(topology);
        return result;
      },
    );
  } finally {
    try {
      restoreHomeLockTopologyMode(topology);
    } finally {
      closeHomeLockTopology(topology);
    }
  }
}

/** Home-level lock acquired before the migration tree exists. */
export function migrationManifestLockPath(homeDir?: string): string {
  return join(resolve(homeDir ?? homedir()), ".lcm.migration-manifest.lock");
}

/** Private directory for one immutable migration generation. */
export function migrationManifestGenerationDirectory(
  generationId: string,
  homeDir?: string,
): string {
  assertGenerationId(generationId);
  return join(migrationRoot(homeDir), generationId);
}

/** Compare-and-swap head pointer for one migration generation. */
export function migrationManifestHeadPath(generationId: string, homeDir?: string): string {
  return join(migrationManifestGenerationDirectory(generationId, homeDir), "head.json");
}

/** Immutable revision path bound to the manifest's canonical checksum. */
export function migrationManifestRevisionPath(
  input: Readonly<{
    generationId: string;
    revision: number;
    checksumSha256: string;
  }>,
  homeDir?: string,
): string {
  assertGenerationId(input.generationId);
  if (!Number.isSafeInteger(input.revision) || input.revision < 0) {
    return invalidPathInput("migration manifest revision is invalid");
  }
  if (!SHA256_PATTERN.test(input.checksumSha256)) {
    return invalidPathInput("migration manifest checksum is invalid");
  }
  return join(
    migrationManifestGenerationDirectory(input.generationId, homeDir),
    "revisions",
    revisionDirectoryName(input.revision),
    `${input.checksumSha256}.json`,
  );
}

/** Create and checksum one immutable compare-and-swap head pointer. */
export function createMigrationManifestHead(
  input: Readonly<{
    generationId: string;
    revision: number;
    manifestSha256: string;
    updatedAt: string;
  }>,
): MigrationManifestHead {
  if (input === null || typeof input !== "object") {
    return invalidPathInput("migration manifest head input is invalid");
  }
  assertGenerationId(input.generationId);
  if (!isSafeRevision(input.revision)) {
    return invalidPathInput("migration manifest head revision is invalid");
  }
  if (!isSha256(input.manifestSha256)) {
    return invalidPathInput("migration manifest head checksum is invalid");
  }
  if (!isIsoTimestamp(input.updatedAt)) {
    return invalidPathInput("migration manifest head timestamp is invalid");
  }
  const payload = {
    version: 1 as const,
    generationId: input.generationId,
    revision: input.revision,
    revisionFilename: `${input.manifestSha256}.json`,
    manifestSha256: input.manifestSha256,
    updatedAt: input.updatedAt,
  };
  return Object.freeze({
    ...payload,
    checksumSha256: sha256(headPayloadContent(payload)),
  });
}

/** Serialize an authenticated head to exact canonical ASCII JSON. */
export function migrationManifestHeadContent(head: MigrationManifestHead): string {
  let expected: MigrationManifestHead;
  try {
    expected = createMigrationManifestHead(head);
  } catch (error) {
    throw new MigrationProtocolError("malformed-manifest", "migration manifest head is invalid", {
      cause: error,
    });
  }
  if (
    head.version !== 1
    || head.revisionFilename !== expected.revisionFilename
    || head.checksumSha256 !== expected.checksumSha256
  ) {
    return malformedHead("migration manifest head is invalid");
  }
  return sealedHeadContent(expected);
}

/** Parse and authenticate exact canonical persisted head bytes. */
export function parseMigrationManifestHeadContent(content: string): MigrationManifestHead {
  if (
    typeof content !== "string"
    || !/^[\x00-\x7f]*$/u.test(content)
    || !content.endsWith("\n")
  ) {
    return malformedHead("migration manifest head content is invalid");
  }
  let value: unknown;
  try {
    value = JSON.parse(content.slice(0, -1));
  } catch (error) {
    throw new MigrationProtocolError("malformed-manifest", "migration manifest head JSON is invalid", {
      cause: error,
    });
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return malformedHead("migration manifest head has an invalid shape");
  }
  const record = value as Record<string, unknown>;
  if (!exactHeadKeys(record)) {
    return malformedHead("migration manifest head has an invalid shape");
  }
  if (
    record.version !== 1
    || typeof record.generationId !== "string"
    || !isSafeRevision(record.revision)
    || !isSha256(record.manifestSha256)
    || typeof record.revisionFilename !== "string"
    || !isIsoTimestamp(record.updatedAt)
    || !isSha256(record.checksumSha256)
  ) {
    return malformedHead("migration manifest head is invalid");
  }
  let expected: MigrationManifestHead;
  try {
    expected = createMigrationManifestHead({
      generationId: record.generationId,
      revision: record.revision,
      manifestSha256: record.manifestSha256,
      updatedAt: record.updatedAt,
    });
  } catch (error) {
    throw new MigrationProtocolError("malformed-manifest", "migration manifest head is invalid", {
      cause: error,
    });
  }
  if (record.revisionFilename !== expected.revisionFilename) {
    return malformedHead("migration manifest head revision filename is invalid");
  }
  if (record.checksumSha256 !== expected.checksumSha256) {
    throw new MigrationProtocolError("checksum-mismatch", "migration manifest head checksum does not match");
  }
  if (content !== sealedHeadContent(expected)) {
    return malformedHead("migration manifest head content is not canonical");
  }
  return expected;
}

type MigrationManifestStoreObserver = (event: string, path: string) => void;

/** Durable immutable revision store for one reversible migration protocol. */
export class MigrationManifestStore {
  readonly #homeDir: string;
  readonly #observer: MigrationManifestStoreObserver;
  readonly #expectedUid: number | undefined;

  constructor(options: Readonly<{
    homeDir?: string;
    observer?: MigrationManifestStoreObserver;
    expectedUid?: number;
  }> = {}) {
    this.#homeDir = resolve(options.homeDir ?? homedir());
    this.#observer = options.observer ?? (() => undefined);
    this.#expectedUid = options.expectedUid ?? currentUid();
  }

  create(manifest: MigrationManifest): MigrationManifest {
    const authenticated = parseMigrationManifest(manifest);
    assertMigrationManifestGenesis(authenticated);
    const content = boundedManifestContent(authenticated);
    return withManifestMutationLock(this.#homeDir, this.#expectedUid, () => {
      const root = lcmRoot(this.#homeDir);
      return withAuthenticatedDirectories([root], this.#expectedUid, () => {
        const migrations = ensurePrivateChild(root, "migrations", this.#expectedUid);
        const revisionPath = migrationManifestRevisionPath({
          generationId: authenticated.generationId,
          revision: authenticated.revision,
          checksumSha256: authenticated.checksumSha256,
        }, this.#homeDir);
        let generationExists = false;
        try {
          lstatSync(migrationManifestGenerationDirectory(authenticated.generationId, this.#homeDir));
          generationExists = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        let existingHeadTemporary: AuthenticatedHeadTemporary | null = null;
        if (generationExists) {
          const existingHeadContent = withAuthenticatedDirectories(
            [migrationManifestGenerationDirectory(authenticated.generationId, this.#homeDir)],
            this.#expectedUid,
            () => readAuthenticatedHeadContent(
              migrationManifestGenerationDirectory(authenticated.generationId, this.#homeDir),
              this.#expectedUid,
            ),
          );
          if (existingHeadContent.kind === "present") {
            throw new MigrationProtocolError("unexpected-state", "migration generation already exists");
          }
          existingHeadTemporary = existingHeadContent.temporary;
        }
        this.#observer("before-revision-publication", revisionPath);
        const generation = ensurePrivateChild(
          migrations,
          authenticated.generationId,
          this.#expectedUid,
        );
        if (readDirectoryEntriesBounded(generation, 2).some((entry) => (
          entry !== "revisions"
          && (existingHeadTemporary === null || entry !== basename(existingHeadTemporary.path))
        ))) {
          throw new MigrationProtocolError("unexpected-state", "migration generation already exists");
        }
        const revisions = ensurePrivateChild(generation, "revisions", this.#expectedUid);
        if (existingHeadTemporary !== null) {
          const recoveredGenesis = assertHeadTemporaryGenesis(
            revisions,
            authenticated.generationId,
            existingHeadTemporary,
            this.#expectedUid,
          );
          if (recoveredGenesis.checksumSha256 !== authenticated.checksumSha256) {
            return malformedHead("migration manifest head writer temporary does not match the requested genesis");
          }
          consumeAuthenticatedHeadTemporary(
            generation,
            existingHeadTemporary,
            this.#expectedUid,
          );
          existingHeadTemporary = null;
        }
        const revisionDirectory = stageRevision(
          revisions,
          authenticated,
          content,
          this.#expectedUid,
          (directory) => this.#observer("before-revision-content-publication", directory),
        );
        return withAuthenticatedDirectories(
          [root, migrations, generation, revisions, revisionDirectory],
          this.#expectedUid,
          () => {
            this.#observer("after-revision-publication", revisionPath);
            const head = createMigrationManifestHead({
              generationId: authenticated.generationId,
              revision: authenticated.revision,
              manifestSha256: authenticated.checksumSha256,
              updatedAt: authenticated.updatedAt,
            });
            const headPath = migrationManifestHeadPath(authenticated.generationId, this.#homeDir);
            this.#observer("before-head-publication", headPath);
            atomicWritePrivateFileDurable(headPath, migrationManifestHeadContent(head), {
              expectedUid: this.#expectedUid,
              expectedContentSha256: null,
              requireAbsent: true,
              maxExistingBytes: MAX_MANIFEST_BYTES,
            });
            this.#observer("after-head-publication", headPath);
            return authenticated;
          },
        );
      });
    });
  }

  read(generationId: string): MigrationManifest {
    return this.#readState(generationId).manifest;
  }

  #readState(generationId: string): AuthenticatedManifestState {
    const state = this.#readOptionalState(generationId, true);
    if (state === null) {
      throw new MigrationProtocolError("unexpected-state", "migration manifest head is absent");
    }
    return state;
  }

  #readOptionalState(
    generationId: string,
    rejectImmediateSuccessor: boolean,
  ): AuthenticatedManifestState | null {
    const generation = migrationManifestGenerationDirectory(generationId, this.#homeDir);
    const root = lcmRoot(this.#homeDir);
    const migrations = migrationRoot(this.#homeDir);
    const revisions = join(generation, "revisions");
    return withAuthenticatedDirectories(
      [root, migrations, generation, revisions],
      this.#expectedUid,
      () => {
        const headPath = migrationManifestHeadPath(generationId, this.#homeDir);
        const authenticatedHead = readAuthenticatedHeadContent(generation, this.#expectedUid);
        if (authenticatedHead.kind === "absent") return null;
        const {
          content: headContent,
          aliasPath: headAliasPath,
          temporary: headTemporary,
        } = authenticatedHead;
        const head = parseMigrationManifestHeadContent(headContent);
        if (head.generationId !== generationId) {
          return malformedHead("migration manifest head generation does not match");
        }
        const revisionDirectory = join(
          revisions,
          revisionDirectoryName(head.revision),
        );
        return withAuthenticatedDirectories([revisionDirectory], this.#expectedUid, () => {
          const revisionState = assertRecoverableRevisionEntries(
            revisionDirectory,
            head.manifestSha256,
            this.#expectedUid,
          );
          if (revisionState.manifestContent === null) return malformedHead("migration manifest revision directory is invalid");
          const manifest = parseManifestContent(revisionState.manifestContent);
          if (
            manifest.generationId !== generationId
            || manifest.revision !== head.revision
            || manifest.checksumSha256 !== head.manifestSha256
          ) {
            return malformedHead("migration manifest revision does not match its head");
          }
          if (headTemporary !== null) {
            assertHeadTemporarySuccessor(
              revisions,
              manifest,
              headTemporary,
              this.#expectedUid,
            );
          }
          if (rejectImmediateSuccessor) assertNoImmediateSuccessor(revisions, head.revision);
          return {
            head,
            headContent,
            headAliasPath,
            headTemporary,
            manifest,
            generation,
            revisions,
          };
        });
      },
    );
  }

  update(
    generationId: string,
    expectedChecksumSha256: string,
    reduce: (manifest: MigrationManifest) => MigrationManifest,
  ): MigrationManifest {
    if (!isSha256(expectedChecksumSha256) || typeof reduce !== "function") {
      throw new MigrationProtocolError("invalid-input", "migration manifest update input is invalid");
    }
    return withManifestMutationLock(this.#homeDir, this.#expectedUid, () => {
      const current = this.#readOptionalState(generationId, false);
      if (current === null) {
        throw new MigrationProtocolError("unexpected-state", "migration manifest head is absent");
      }
      if (current.manifest.checksumSha256 !== expectedChecksumSha256) {
        throw new MigrationProtocolError("unexpected-state", "migration manifest update is stale");
      }
      const previousRevision = current.manifest.revision;
      if (previousRevision === Number.MAX_SAFE_INTEGER) {
        throw new MigrationProtocolError("unexpected-state", "migration manifest revision is exhausted");
      }
      const candidate = parseMigrationManifest(reduce(current.manifest));
      assertMigrationManifestSuccessor(current.manifest, candidate);
      const content = boundedManifestContent(candidate);
      const revisionPath = migrationManifestRevisionPath({
        generationId,
        revision: candidate.revision,
        checksumSha256: candidate.checksumSha256,
      }, this.#homeDir);
      const headPath = migrationManifestHeadPath(generationId, this.#homeDir);
      if (current.headTemporary !== null) {
        const recoveredSuccessor = assertHeadTemporarySuccessor(
          current.revisions,
          current.manifest,
          current.headTemporary,
          this.#expectedUid,
        );
        if (recoveredSuccessor.checksumSha256 !== candidate.checksumSha256) {
          return malformedHead("migration manifest head writer temporary does not match the requested successor");
        }
        consumeAuthenticatedHeadTemporary(
          current.generation,
          current.headTemporary,
          this.#expectedUid,
        );
      }
      if (current.headAliasPath !== null) {
        consumeAuthenticatedHeadAlias(headPath, current.headAliasPath, this.#expectedUid);
      }
      this.#observer("before-revision-publication", revisionPath);
      const revisionDirectory = stageRevision(
        current.revisions,
        candidate,
        content,
        this.#expectedUid,
        (directory) => this.#observer("before-revision-content-publication", directory),
      );
      return withAuthenticatedDirectories(
        [current.generation, current.revisions, revisionDirectory],
        this.#expectedUid,
        () => {
          this.#observer("after-revision-publication", revisionPath);
          const nextHead = createMigrationManifestHead({
            generationId,
            revision: candidate.revision,
            manifestSha256: candidate.checksumSha256,
            updatedAt: candidate.updatedAt,
          });
          this.#observer("before-head-publication", headPath);
          atomicWritePrivateFileDurable(headPath, migrationManifestHeadContent(nextHead), {
            expectedUid: this.#expectedUid,
            expectedContentSha256: sha256(current.headContent),
            maxExistingBytes: MAX_MANIFEST_BYTES,
          });
          this.#observer("after-head-publication", headPath);
          return candidate;
        },
      );
    });
  }

  recover(generationId: string): MigrationManifest {
    return withManifestMutationLock(this.#homeDir, this.#expectedUid, () => {
      const current = this.#readOptionalState(generationId, false);
      if (current?.manifest.revision === Number.MAX_SAFE_INTEGER) return current.manifest;
      const generation = migrationManifestGenerationDirectory(generationId, this.#homeDir);
      const root = lcmRoot(this.#homeDir);
      const migrations = migrationRoot(this.#homeDir);
      const revisions = join(generation, "revisions");
      return withAuthenticatedDirectories(
        [root, migrations, generation, revisions],
        this.#expectedUid,
        () => {
          const authenticatedHead = readAuthenticatedHeadContent(generation, this.#expectedUid);
          const headTemporary = current === null && authenticatedHead.kind === "absent"
            ? authenticatedHead.temporary
            : current?.headTemporary ?? null;
          if (current === null && headTemporary !== null) {
            assertHeadTemporaryGenesis(
              revisions,
              generationId,
              headTemporary,
              this.#expectedUid,
            );
          }
          const nextRevision = current === null ? 0 : current.manifest.revision + 1;
          const candidate = exactRecoveryCandidate(
            revisions,
            generationId,
            nextRevision,
            current?.manifest.checksumSha256 ?? null,
            this.#expectedUid,
          );
          if (candidate === null) {
            if (current !== null) return current.manifest;
            throw new MigrationProtocolError(
              "unexpected-state",
              "migration manifest has no recoverable genesis revision",
            );
          }
          assertNoRecoverySecondHop(revisions, nextRevision);
          if (candidate.kind === "incomplete") {
            if (current !== null) return current.manifest;
            throw new MigrationProtocolError(
              "unexpected-state",
              "migration manifest has no recoverable genesis revision",
            );
          }
          const recovered = current === null
            ? assertMigrationManifestGenesis(candidate.manifest)
            : assertMigrationManifestSuccessor(current.manifest, candidate.manifest);
          if (headTemporary !== null) {
            assertHeadMatchesManifest(headTemporary.head, recovered);
            consumeAuthenticatedHeadTemporary(generation, headTemporary, this.#expectedUid);
          }
          const headPath = migrationManifestHeadPath(generationId, this.#homeDir);
          if (current?.headAliasPath !== null && current?.headAliasPath !== undefined) {
            consumeAuthenticatedHeadAlias(headPath, current.headAliasPath, this.#expectedUid);
          }
          const head = createMigrationManifestHead({
            generationId,
            revision: recovered.revision,
            manifestSha256: recovered.checksumSha256,
            updatedAt: recovered.updatedAt,
          });
          this.#observer("before-head-publication", headPath);
          atomicWritePrivateFileDurable(headPath, migrationManifestHeadContent(head), {
            expectedUid: this.#expectedUid,
            expectedContentSha256: current === null ? null : sha256(current.headContent),
            requireAbsent: current === null,
            maxExistingBytes: MAX_MANIFEST_BYTES,
          });
          this.#observer("after-head-publication", headPath);
          return recovered;
        },
      );
    });
  }
}
