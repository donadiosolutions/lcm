import { createHash, randomBytes } from "node:crypto";
import {
  fchmodSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  opendirSync,
  renameSync,
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
  return typeof revision === "number"
    && Number.isSafeInteger(revision)
    && revision >= 0
    && !Object.is(revision, -0);
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
): T;
function withAuthenticatedDirectories<T>(
  paths: readonly string[],
  expectedUid: number | undefined,
  callback: () => T,
  options: { allowMissingThroughIndex: number },
): T | null;
function withAuthenticatedDirectories<T>(
  paths: readonly string[],
  expectedUid: number | undefined,
  callback: () => T,
  options?: { allowMissingThroughIndex: number },
): T | null {
  const handles: PrivateDirectoryHandle[] = [];
  let result: T | undefined;
  let primaryError: unknown;
  let missing = false;
  try {
    for (let index = 0; index < paths.length; index += 1) {
      try {
        handles.push(openPrivateDirectory(paths[index]!, { expectedUid }));
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code === "ENOENT"
          && options !== undefined
          && index <= options.allowMissingThroughIndex
        ) {
          missing = true;
          break;
        }
        throw error;
      }
    }
    for (let index = 0; index < handles.length; index += 1) {
      assertPrivateDirectory(handles[index]!, paths[index]!, handles[index]!.witness, expectedUid);
    }
    if (!missing) result = callback();
    for (let index = 0; index < handles.length; index += 1) {
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
  return missing ? null : result as T;
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
  publicationGroup: AuthenticatedHeadPublicationGroup | null;
  publicationSuccessor: MigrationManifest | null;
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
  const candidate = readAuthenticatedRevisionCandidate(
    revisions,
    generationId,
    revision,
    expectedUid,
  );
  if (candidate?.kind !== "manifest") return candidate;
  if (candidate.manifest.previousManifestSha256 !== previousManifestSha256) {
    throw new MigrationProtocolError(
      "unexpected-state",
      "migration manifest recovery candidate has the wrong predecessor",
    );
  }
  return candidate;
}

/**
 * Parse and authenticate one immutable revision directory without applying a
 * predecessor relation.  Ordinary recovery never calls this bypass directly;
 * it enters through exactRecoveryCandidate, whose string-or-null predecessor
 * check is unconditional.  Capture-cleaned reconstruction is the sole
 * caller that intentionally needs this narrower immutable-row loader.
 */
function readAuthenticatedRevisionCandidate(
  revisions: string,
  generationId: string,
  revision: number,
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
    return { kind: "manifest", manifest, directory };
  });
}

function immutableRevisionCandidate(
  revisions: string,
  generationId: string,
  revision: number,
  expectedUid: number | undefined,
): ReturnType<typeof readAuthenticatedRevisionCandidate> {
  return readAuthenticatedRevisionCandidate(revisions, generationId, revision, expectedUid);
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

const HEAD_PUBLICATION_NONCE_PATTERN = /^[0-9a-f]{24}$/u;

type HeadPublicationAttemptPayload = Readonly<{
  version: 1;
  nonce: string;
  generationId: string;
  expectedHeadRawSha256: string;
  candidateHeadRawSha256: string;
  candidateManifestSha256: string;
  candidateRevision: number;
}>;

type HeadPublicationAttempt = HeadPublicationAttemptPayload & Readonly<{
  checksumSha256: string;
}>;

const HEAD_PUBLICATION_ATTEMPT_KEYS = [
  "candidateHeadRawSha256",
  "candidateManifestSha256",
  "candidateRevision",
  "checksumSha256",
  "expectedHeadRawSha256",
  "generationId",
  "nonce",
  "version",
] as const;

function headPublicationAttemptContent(
  attempt: HeadPublicationAttempt,
): string {
  return `${canonicalJson(attempt as unknown as CanonicalJson)}\n`;
}

function createHeadPublicationAttempt(
  payload: HeadPublicationAttemptPayload,
): HeadPublicationAttempt {
  return Object.freeze({
    ...payload,
    checksumSha256: sha256(canonicalJson(payload as unknown as CanonicalJson)),
  });
}

function parseHeadPublicationAttemptContent(content: string): HeadPublicationAttempt {
  if (!/^[\x00-\x7f]*$/u.test(content) || !content.endsWith("\n")) {
    return malformedHead("migration manifest head publication attempt content is invalid");
  }
  let value: unknown;
  try {
    value = JSON.parse(content.slice(0, -1));
  } catch (error) {
    throw new MigrationProtocolError(
      "malformed-manifest",
      "migration manifest head publication attempt JSON is invalid",
      { cause: error },
    );
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return malformedHead("migration manifest head publication attempt is not an object");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== HEAD_PUBLICATION_ATTEMPT_KEYS.length
    || keys.some((key, index) => key !== HEAD_PUBLICATION_ATTEMPT_KEYS[index])
  ) {
    return malformedHead("migration manifest head publication attempt keys are invalid");
  }
  if (
    record.version !== 1
    || typeof record.nonce !== "string"
    || !HEAD_PUBLICATION_NONCE_PATTERN.test(record.nonce)
    || typeof record.generationId !== "string"
    || !GENERATION_ID_PATTERN.test(record.generationId)
    || !isSha256(record.expectedHeadRawSha256)
    || !isSha256(record.candidateHeadRawSha256)
    || !isSha256(record.candidateManifestSha256)
    || !isSafeRevision(record.candidateRevision)
    || !isSha256(record.checksumSha256)
  ) {
    return malformedHead("migration manifest head publication attempt fields are invalid");
  }
  const payload: HeadPublicationAttemptPayload = {
    version: 1,
    nonce: record.nonce,
    generationId: record.generationId,
    expectedHeadRawSha256: record.expectedHeadRawSha256,
    candidateHeadRawSha256: record.candidateHeadRawSha256,
    candidateManifestSha256: record.candidateManifestSha256,
    candidateRevision: record.candidateRevision,
  };
  if (sha256(canonicalJson(payload as unknown as CanonicalJson)) !== record.checksumSha256) {
    return malformedHead("migration manifest head publication attempt checksum does not match");
  }
  const attempt: HeadPublicationAttempt = {
    ...payload,
    checksumSha256: record.checksumSha256,
  };
  if (content !== headPublicationAttemptContent(attempt)) {
    return malformedHead("migration manifest head publication attempt content is not canonical");
  }
  return Object.freeze(attempt);
}

function readAuthenticatedHeadPublicationAttempt(
  path: string,
  generation: string,
  expectedUid: number | undefined,
  expectedRawSha256: string | undefined,
): Readonly<{ attempt: HeadPublicationAttempt; content: string }> {
  try {
    const file = readBoundedRegularFileWithStat(path, {
      allowedRoot: generation,
      maxBytes: MAX_MANIFEST_BYTES,
      expectedUid,
      allowedModes: [0o600],
      requireSingleLink: true,
      expectedRawSha256,
    });
    return {
      attempt: parseHeadPublicationAttemptContent(file.content),
      content: file.content,
    };
  } catch (error) {
    if (error instanceof MigrationProtocolError) throw error;
    throw new MigrationProtocolError(
      "malformed-manifest",
      "migration manifest head publication attempt is invalid",
      { cause: error },
    );
  }
}

function publicationFailure(message: string, error: unknown): never {
  const cause = error instanceof MigrationProtocolError && error.cause !== undefined
    ? error.cause
    : error;
  throw new MigrationProtocolError("recovery-required", message, { cause });
}

function publishNonGenesisHead(
  generation: string,
  headPath: string,
  currentHeadContent: string,
  nextHead: MigrationManifestHead,
  candidate: MigrationManifest,
  expectedUid: number | undefined,
  observer: MigrationManifestStoreObserver,
): void {
  const nonce = randomBytes(12).toString("hex");
  const candidatePath = join(generation, `.head.json.${nonce}.tmp`);
  const capturePath = join(generation, `.head.json.${nonce}.capture`);
  const attemptPath = join(generation, `.head.json.${nonce}.attempt`);
  const nextHeadContent = migrationManifestHeadContent(nextHead);
  const attempt = createHeadPublicationAttempt({
    version: 1,
    nonce,
    generationId: candidate.generationId,
    expectedHeadRawSha256: sha256(currentHeadContent),
    candidateHeadRawSha256: sha256(nextHeadContent),
    candidateManifestSha256: candidate.checksumSha256,
    candidateRevision: candidate.revision,
  });
  const attemptContent = headPublicationAttemptContent(attempt);

  atomicWritePrivateFileDurable(candidatePath, nextHeadContent, {
    expectedUid,
    requireAbsent: true,
    maxExistingBytes: MAX_MANIFEST_BYTES,
  });
  atomicWritePrivateFileDurable(attemptPath, attemptContent, {
    expectedUid,
    requireAbsent: true,
    maxExistingBytes: MAX_MANIFEST_BYTES,
  });
  const authenticatedAttempt = readAuthenticatedHeadPublicationAttempt(
    attemptPath,
    generation,
    expectedUid,
    sha256(attemptContent),
  );
  // `expectedRawSha256` binds this read to the exact canonical bytes authored
  // above, so reparsing cannot produce fields that disagree with `attempt`.

  observer("before-head-capture", headPath);
  try {
    renameSync(headPath, capturePath);
  } catch (error) {
    publicationFailure("migration manifest head capture rename failed", error);
  }
  try {
    syncPrivateDirectory(generation, { expectedUid });
  } catch (error) {
    publicationFailure("migration manifest head capture durability sync failed", error);
  }
  observer("after-head-capture", headPath);

  const capture = readBoundedRegularFileWithStat(capturePath, {
    allowedRoot: generation,
    maxBytes: MAX_MANIFEST_BYTES,
    expectedUid,
    allowedModes: [0o600],
    requireSingleLink: true,
  });
  if (sha256(capture.content) !== authenticatedAttempt.attempt.expectedHeadRawSha256) {
    observer("before-head-restore", headPath);
    try {
      linkSync(capturePath, headPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new MigrationProtocolError(
          "recovery-required",
          "migration manifest head was replaced before capture restoration",
          { cause: error },
        );
      }
      throw new MigrationProtocolError(
        "recovery-required",
        "migration manifest head capture restoration failed",
        { cause: error },
      );
    }
    try {
      syncPrivateDirectory(generation, { expectedUid });
    } catch (error) {
      throw new MigrationProtocolError(
        "recovery-required",
        "migration manifest head capture restoration durability sync failed",
        { cause: error },
      );
    }
    throw new MigrationProtocolError(
      "recovery-required",
      "migration manifest head capture does not match the expected prior head",
    );
  }

  observer("before-head-link", headPath);
  try {
    linkSync(candidatePath, headPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new MigrationProtocolError(
        "recovery-required",
        "migration manifest head was replaced before candidate publication",
        { cause: error },
      );
    }
    throw new MigrationProtocolError(
      "recovery-required",
      "migration manifest head candidate publication failed",
      { cause: error },
    );
  }
  observer("after-head-link", headPath);
  try {
    syncPrivateDirectory(generation, { expectedUid });
  } catch (error) {
    publicationFailure("migration manifest head publication durability sync failed", error);
  }
  try {
    consumeAuthenticatedHeadAlias(headPath, candidatePath, expectedUid);
  } catch (error) {
    publicationFailure("migration manifest head candidate cleanup failed", error);
  }
  try {
    consumeBoundedRegularFile(capturePath, {
      allowedRoot: generation,
      maxBytes: MAX_MANIFEST_BYTES,
      expectedUid,
      allowedModes: [0o600],
      requireSingleLink: true,
      expectedRawSha256: authenticatedAttempt.attempt.expectedHeadRawSha256,
    });
  } catch (error) {
    publicationFailure("migration manifest head capture cleanup failed", error);
  }
  try {
    syncPrivateDirectory(generation, { expectedUid });
  } catch (error) {
    publicationFailure("migration manifest head cleanup durability sync failed", error);
  }
  try {
    consumeBoundedRegularFile(attemptPath, {
      allowedRoot: generation,
      maxBytes: MAX_MANIFEST_BYTES,
      expectedUid,
      allowedModes: [0o600],
      requireSingleLink: true,
      expectedRawSha256: sha256(authenticatedAttempt.content),
    });
  } catch (error) {
    publicationFailure("migration manifest head publication attempt cleanup failed", error);
  }
  try {
    syncPrivateDirectory(generation, { expectedUid });
  } catch (error) {
    publicationFailure("migration manifest head publication cleanup durability sync failed", error);
  }
  observer("after-head-publication", headPath);
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
    publicationGroup?: AuthenticatedHeadPublicationGroup;
  }>
  | Readonly<{
    kind: "present";
    content: string;
    aliasPath: string | null;
    temporary: AuthenticatedHeadTemporary | null;
    publicationGroup?: AuthenticatedHeadPublicationGroup;
  }>;

type AuthenticatedHeadTemporary = Readonly<{
  path: string;
  head: MigrationManifestHead;
  contentSha256: string;
}>;

type AuthenticatedHeadPublicationGroup = Readonly<{
  kind: "pre-capture" | "capture-conflict" | "headless" | "committed" | "candidate-cleaned" | "capture-cleaned";
  nonce: string;
  attempt: HeadPublicationAttempt;
  attemptPath: string;
  attemptContentSha256: string;
  candidatePath: string;
  candidateHead: MigrationManifestHead;
  candidateStat: ReturnType<typeof readBoundedRegularFileWithStat>;
  capturePath: string;
  captureContent: string | null;
}>;

const HEAD_PUBLICATION_GROUP_ENTRY_PATTERN =
  /^\.head\.json\.([0-9a-f]{24})\.(tmp|capture|attempt)$/u;

function headPublicationGroupEntry(
  name: string,
): Readonly<{ nonce: string; role: string }> | null {
  const match = HEAD_PUBLICATION_GROUP_ENTRY_PATTERN.exec(name);
  if (match === null) return null;
  return { nonce: match[1]!, role: match[2]! };
}

/**
 * Classify a five-entry group that still has a `head.json`: the committed
 * post-link layout links `head.json` and the group's own `.tmp` candidate to
 * one inode with exactly two links.  This is classification only; the layout
 * is proven afterwards by the exact writer-link-pair authentication, so a
 * wrong guess fails closed as a preserved capture conflict.
 */
function isCommittedPairLayout(headPath: string, candidatePath: string): boolean {
  try {
    const head = lstatSync(headPath);
    const candidate = lstatSync(candidatePath);
    return head.dev === candidate.dev
      && head.ino === candidate.ino
      && head.nlink === 2
      && candidate.nlink === 2;
  } catch {
    return false;
  }
}

/**
 * Authenticate one exact publication group: the prior `head.json` is
 * still linked, the sealed `.attempt` and its `.tmp` candidate exist under one
 * nonce, and no `.capture` was taken yet.  Every field is bound to the sealed
 * attempt so recovery can finish the frozen publication without inventing a
 * new nonce or replacing an unrelated head.
 *
 * The `headless` kind authenticates the durable mid-publication state where
 * the prior head has already been renamed onto the group's own `.capture`
 * name and no `head.json` link exists yet.  Its capture must be the exact
 * owner-only single-link file whose raw bytes hash to the sealed expected
 * head hash, so the prior head remains provable without any `head.json`.
 *
 * The `committed` kind authenticates the durable state after the exclusive
 * candidate link succeeded: `head.json` and the group's own `.tmp` are the
 * same inode with exactly two links, so the sealed candidate is already the
 * published head and only the group's own cleanup remains.
 *
 * The `candidate-cleaned` and `capture-cleaned` kinds authenticate later
 * cleanup states from the published single-link `head.json`.  In the final
 * state the capture no longer exists, so the immutable predecessor revision
 * is retention-critical evidence used to reconstruct the exact prior head.
 * Head schema version 1 is therefore part of this frozen recovery contract.
 */
function authenticatePublicationGroup(
  generation: string,
  nonce: string,
  expectedUid: number | undefined,
  kind: AuthenticatedHeadPublicationGroup["kind"],
): AuthenticatedHeadPublicationGroup {
  const attemptPath = join(generation, `.head.json.${nonce}.attempt`);
  const candidatePath = kind === "candidate-cleaned" || kind === "capture-cleaned"
    ? join(generation, "head.json")
    : join(generation, `.head.json.${nonce}.tmp`);
  const authenticated = readAuthenticatedHeadPublicationAttempt(
    attemptPath,
    generation,
    expectedUid,
    undefined,
  );
  const attempt = authenticated.attempt;
  if (attempt.nonce !== nonce || attempt.generationId !== basename(generation)) {
    return malformedHead("migration manifest head publication attempt does not match its group");
  }
  if (attempt.candidateRevision < 1) {
    return malformedHead("migration manifest head publication candidate revision is invalid");
  }
  const candidate = readBoundedRegularFileWithStat(candidatePath, {
    allowedRoot: generation,
    maxBytes: MAX_MANIFEST_BYTES,
    expectedUid,
    allowedModes: [0o600],
    requireSingleLink: kind !== "committed",
    expectedRawSha256: attempt.candidateHeadRawSha256,
  });
  if (kind === "committed" && candidate.nlink !== "2") {
    return malformedHead("migration manifest head publication candidate has invalid link topology");
  }
  const candidateHead = parseMigrationManifestHeadContent(candidate.content);
  if (
    candidateHead.generationId !== attempt.generationId
    || candidateHead.revision !== attempt.candidateRevision
    || candidateHead.manifestSha256 !== attempt.candidateManifestSha256
  ) {
    return malformedHead("migration manifest head publication candidate does not match its attempt");
  }
  const capturePath = join(generation, `.head.json.${nonce}.capture`);
  let captureContent: string | null = null;
  if (kind === "capture-conflict") {
    readBoundedRegularFileWithStat(capturePath, {
      allowedRoot: generation,
      maxBytes: MAX_MANIFEST_BYTES,
      expectedUid,
      allowedModes: [0o600],
      requireSingleLink: true,
    });
  }
  if (kind === "headless" || kind === "committed" || kind === "candidate-cleaned") {
    captureContent = readBoundedRegularFileWithStat(capturePath, {
      allowedRoot: generation,
      maxBytes: MAX_MANIFEST_BYTES,
      expectedUid,
      allowedModes: [0o600],
      requireSingleLink: true,
      expectedRawSha256: attempt.expectedHeadRawSha256,
    }).content;
  }
  return {
    kind,
    nonce,
    attempt,
    attemptPath,
    attemptContentSha256: sha256(authenticated.content),
    candidatePath,
    candidateHead,
    candidateStat: candidate,
    capturePath,
    captureContent,
  };
}

function samePublicationRoles(
  actual: readonly string[],
  expected: readonly string[],
): boolean {
  return actual.length === expected.length
    && actual.every((role) => expected.includes(role))
    && expected.every((role) => actual.includes(role));
}

type HeadPublicationGroupClassification = Readonly<{
  kind: AuthenticatedHeadPublicationGroup["kind"];
  nonce: string;
}>;

/** Classify exact group members before authenticating each role's bytes. */
function classifyHeadPublicationGroup(
  generation: string,
  entries: readonly string[],
): HeadPublicationGroupClassification | null {
  const groupEntries = entries
    .map((entry) => {
      const match = headPublicationGroupEntry(entry);
      return match === null ? null : { ...match, name: entry };
    })
    .filter((entry): entry is Readonly<{ nonce: string; role: string; name: string }> => entry !== null);
  if (groupEntries.length === 0) return null;
  if (!entries.includes("revisions")) {
    return malformedHead("migration manifest head publication group is missing revisions");
  }
  // A lone `.tmp` is the pre-existing head-writer recovery protocol.  Only an
  // attempt-bearing set can be a publication group; leave the old parser in
  // charge of the legacy states.
  if (!groupEntries.some((entry) => entry.role === "attempt")) return null;
  const extras = entries.filter((entry) => (
    entry !== "revisions"
    && entry !== "head.json"
    && headPublicationGroupEntry(entry) === null
  ));
  if (extras.length > 0) return malformedHead("migration manifest head publication group has extra entries");
  const nonces = new Set(groupEntries.map((entry) => entry.nonce));
  if (nonces.size !== 1) return malformedHead("migration manifest head publication group has multiple nonces");
  const nonce = groupEntries[0]!.nonce;
  const roles = groupEntries.map((entry) => entry.role);
  const headPresent = entries.includes("head.json");
  if (!headPresent && samePublicationRoles(roles, ["tmp", "capture", "attempt"])) {
    return { kind: "headless", nonce };
  }
  if (headPresent && samePublicationRoles(roles, ["tmp", "attempt"])) {
    return { kind: "pre-capture", nonce };
  }
  if (headPresent && samePublicationRoles(roles, ["tmp", "capture", "attempt"])) {
    return {
      kind: isCommittedPairLayout(
        join(generation, "head.json"),
        join(generation, `.head.json.${nonce}.tmp`),
      ) ? "committed" : "capture-conflict",
      nonce,
    };
  }
  if (headPresent && samePublicationRoles(roles, ["capture", "attempt"])) {
    return { kind: "candidate-cleaned", nonce };
  }
  if (headPresent && samePublicationRoles(roles, ["attempt"])) {
    return { kind: "capture-cleaned", nonce };
  }
  return malformedHead("migration manifest head publication group has an invalid role set");
}

function readAuthenticatedHeadContent(
  generation: string,
  expectedUid: number | undefined,
): AuthenticatedHeadContent {
  try {
    const entries = readDirectoryEntriesBounded(generation, 5);
    if (entries.length > 5) return malformedHead("migration manifest head directory is ambiguous");
    const publicationClassification = classifyHeadPublicationGroup(generation, entries);
    if (publicationClassification !== null) {
      const publicationGroup = authenticatePublicationGroup(
        generation,
        publicationClassification.nonce,
        expectedUid,
        publicationClassification.kind,
      );
      if (publicationClassification.kind === "headless") {
        return { kind: "absent", temporary: null, publicationGroup };
      }
      if (
        publicationClassification.kind === "committed"
        || publicationClassification.kind === "candidate-cleaned"
      ) {
        // The committed pair is proven by exact writer-link-pair identity
        // between `head.json` and the group's own candidate, so the published
        // head is the sealed candidate itself rather than the prior head.
        if (publicationClassification.kind === "committed" && !exactWriterLinkPair(
          readBoundedRegularFileWithStat(join(generation, "head.json"), {
            allowedRoot: generation,
            maxBytes: MAX_MANIFEST_BYTES,
            expectedUid,
            allowedModes: [0o600],
            requireSingleLink: false,
            expectedRawSha256: publicationGroup.attempt.candidateHeadRawSha256,
          }),
          publicationGroup.candidateStat,
        )) {
          return malformedHead("migration manifest head publication group has invalid link topology");
        }
        return {
          kind: "present",
          content: publicationGroup.captureContent!,
          aliasPath: null,
          temporary: null,
          publicationGroup,
        };
      }
      const head = readBoundedRegularFileWithStat(join(generation, "head.json"), {
        allowedRoot: generation,
        maxBytes: MAX_MANIFEST_BYTES,
        expectedUid,
        allowedModes: [0o600],
        requireSingleLink: true,
        expectedRawSha256: publicationClassification.kind === "capture-cleaned"
          ? publicationGroup.attempt.candidateHeadRawSha256
          : publicationGroup.attempt.expectedHeadRawSha256,
      });
      return {
        kind: "present",
        content: head.content,
        aliasPath: null,
        temporary: null,
        publicationGroup,
      };
    }
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

/**
 * Bind an authenticated pre-capture group to the exact immutable revision it
 * intends to publish: the candidate must be the legal immediate successor of
 * the authenticated current manifest and must match the sealed attempt.
 */
function assertHeadPublicationGroupSuccessor(
  revisions: string,
  current: MigrationManifest,
  group: AuthenticatedHeadPublicationGroup,
  expectedUid: number | undefined,
): MigrationManifest {
  if (
    group.attempt.candidateRevision !== current.revision + 1
    || group.attempt.generationId !== current.generationId
  ) {
    return malformedHead("migration manifest head publication group is not an immediate successor");
  }
  const candidate = exactRecoveryCandidate(
    revisions,
    current.generationId,
    current.revision + 1,
    current.checksumSha256,
    expectedUid,
  );
  if (candidate?.kind !== "manifest") {
    return malformedHead("migration manifest head publication group has no immutable successor revision");
  }
  const successor = assertMigrationManifestSuccessor(current, candidate.manifest);
  if (successor.checksumSha256 !== group.attempt.candidateManifestSha256) {
    return malformedHead("migration manifest head publication group does not match its immutable revision");
  }
  assertHeadMatchesManifest(group.candidateHead, successor);
  return successor;
}

function reconstructCaptureCleanedPredecessor(
  revisions: string,
  generationId: string,
  candidateHead: MigrationManifestHead,
  candidate: MigrationManifest,
  group: AuthenticatedHeadPublicationGroup,
  expectedUid: number | undefined,
): Readonly<{ manifest: MigrationManifest; head: MigrationManifestHead; content: string }> {
  // Immutable revisions are append-only protocol evidence.  Recovery of this
  // durable row depends on retaining N-1 so its version-1 canonical head can
  // prove the sealed expected prior-head hash after `.capture` was consumed.
  // The sole caller selects `capture-cleaned`, while publication-group
  // authentication already requires candidate revision >= 1 and binds the
  // candidate head revision to the sealed attempt.
  const predecessor = immutableRevisionCandidate(
    revisions,
    generationId,
    candidateHead.revision - 1,
    expectedUid,
  );
  if (predecessor?.kind !== "manifest") {
    return malformedHead("migration manifest capture-cleaned group has no authenticated predecessor revision");
  }
  if (predecessor.manifest.checksumSha256 !== candidate.previousManifestSha256) {
    return malformedHead("migration manifest capture-cleaned group has the wrong predecessor");
  }
  const successor = assertMigrationManifestSuccessor(predecessor.manifest, candidate);
  const head = createMigrationManifestHead({
    generationId: predecessor.manifest.generationId,
    revision: predecessor.manifest.revision,
    manifestSha256: predecessor.manifest.checksumSha256,
    updatedAt: predecessor.manifest.updatedAt,
  });
  const content = migrationManifestHeadContent(head);
  if (sha256(content) !== group.attempt.expectedHeadRawSha256) {
    return malformedHead("migration manifest capture-cleaned group prior head does not match its attempt");
  }
  // Group authentication binds the candidate head checksum to the attempt;
  // loading through that head and validating the successor binds the same
  // checksum transitively here.
  assertHeadMatchesManifest(group.candidateHead, successor);
  return { manifest: predecessor.manifest, head, content };
}

/**
 * Finish the exact frozen publication: capture the current head under the
 * group's own capture name, exclusively link the sealed candidate into place,
 * then monotonically consume the group with durability syncs.  No new nonce is
 * generated and `head.json` is never unconditionally replaced.
 */
function completeHeadPublicationGroup(
  generation: string,
  headPath: string,
  group: AuthenticatedHeadPublicationGroup,
  expectedUid: number | undefined,
  observer: MigrationManifestStoreObserver,
): void {
  if (group.kind === "capture-cleaned") {
    try {
      consumeBoundedRegularFile(group.attemptPath, {
        allowedRoot: generation,
        maxBytes: MAX_MANIFEST_BYTES,
        expectedUid,
        allowedModes: [0o600],
        requireSingleLink: true,
        expectedRawSha256: group.attemptContentSha256,
      });
    } catch (error) {
      publicationFailure("migration manifest head publication attempt cleanup failed", error);
    }
    try {
      syncPrivateDirectory(generation, { expectedUid });
    } catch (error) {
      publicationFailure("migration manifest head publication cleanup durability sync failed", error);
    }
    observer("after-head-publication", headPath);
    return;
  }
  if (group.kind === "committed") {
    // The candidate link already succeeded durably, so the only remaining
    // work is the group's own monotonic cleanup.  Sync the generation first so
    // the committed link is durable before any alias is consumed.
    try {
      syncPrivateDirectory(generation, { expectedUid });
    } catch (error) {
      publicationFailure("migration manifest head publication durability sync failed", error);
    }
  } else if (group.kind !== "headless" && group.kind !== "candidate-cleaned") {
    observer("before-head-capture", headPath);
    try {
      renameSync(headPath, group.capturePath);
    } catch (error) {
      publicationFailure("migration manifest head capture rename failed", error);
    }
    try {
      syncPrivateDirectory(generation, { expectedUid });
    } catch (error) {
      publicationFailure("migration manifest head capture durability sync failed", error);
    }
    observer("after-head-capture", headPath);
  }

  if (group.kind !== "committed" && group.kind !== "candidate-cleaned") {
    observer("before-head-link", headPath);
    try {
      linkSync(group.candidatePath, headPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new MigrationProtocolError(
          "recovery-required",
          "migration manifest head was replaced before candidate publication",
          { cause: error },
        );
      }
      throw new MigrationProtocolError(
        "recovery-required",
        "migration manifest head candidate publication failed",
        { cause: error },
      );
    }
    observer("after-head-link", headPath);
    try {
      syncPrivateDirectory(generation, { expectedUid });
    } catch (error) {
      publicationFailure("migration manifest head publication durability sync failed", error);
    }
  }
  if (group.kind !== "candidate-cleaned") {
    try {
      consumeAuthenticatedHeadAlias(headPath, group.candidatePath, expectedUid);
    } catch (error) {
      publicationFailure("migration manifest head candidate cleanup failed", error);
    }
  }
  try {
    consumeBoundedRegularFile(group.capturePath, {
      allowedRoot: generation,
      maxBytes: MAX_MANIFEST_BYTES,
      expectedUid,
      allowedModes: [0o600],
      requireSingleLink: true,
      expectedRawSha256: group.attempt.expectedHeadRawSha256,
    });
  } catch (error) {
    publicationFailure("migration manifest head capture cleanup failed", error);
  }
  try {
    syncPrivateDirectory(generation, { expectedUid });
  } catch (error) {
    publicationFailure("migration manifest head cleanup durability sync failed", error);
  }
  try {
    consumeBoundedRegularFile(group.attemptPath, {
      allowedRoot: generation,
      maxBytes: MAX_MANIFEST_BYTES,
      expectedUid,
      allowedModes: [0o600],
      requireSingleLink: true,
      expectedRawSha256: group.attemptContentSha256,
    });
  } catch (error) {
    publicationFailure("migration manifest head publication attempt cleanup failed", error);
  }
  try {
    syncPrivateDirectory(generation, { expectedUid });
  } catch (error) {
    publicationFailure("migration manifest head publication cleanup durability sync failed", error);
  }
  observer("after-head-publication", headPath);
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
      const scratchPath = join(revisionDirectory, scratch);
      try {
        const scratchFile = readBoundedRegularFileWithStat(scratchPath, {
          allowedRoot: revisionDirectory,
          maxBytes: MAX_MANIFEST_BYTES,
          expectedUid,
          allowedModes: [0o600],
          requireSingleLink: true,
        });
        const scratchBytes = Buffer.from(scratchFile.content, "utf8");
        const candidateBytes = Buffer.from(content, "utf8");
        if (
          !/^[\x00-\x7f]*$/u.test(scratchFile.content)
          || !candidateBytes.subarray(0, scratchBytes.length).equals(scratchBytes)
        ) {
          throw new Error("revision scratch is not a prefix of the canonical candidate");
        }
        consumeBoundedRegularFile(scratchPath, {
          allowedRoot: revisionDirectory,
          maxBytes: MAX_MANIFEST_BYTES,
          expectedUid,
          allowedModes: [0o600],
          requireSingleLink: true,
          expectedRawSha256: sha256(scratchFile.content),
        });
      } catch (error) {
        throw new MigrationProtocolError(
          "malformed-manifest",
          "migration manifest revision scratch is invalid",
          { cause: error },
        );
      }
      try {
        syncPrivateDirectory(revisionDirectory, { expectedUid });
      } catch (error) {
        throw new MigrationProtocolError(
          "malformed-manifest",
          "migration manifest revision directory durability sync failed",
          { cause: error },
        );
      }
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
  if (!isSafeRevision(input.revision)) {
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
    const state = this.#readState(generationId);
    // A committed group has already published its authenticated candidate as
    // the exact head, so the ordinary read reports that candidate after full
    // validation; only the group's own cleanup remains.
    if (
      state.publicationGroup?.kind === "committed"
      || state.publicationGroup?.kind === "candidate-cleaned"
      || state.publicationGroup?.kind === "capture-cleaned"
    ) return state.publicationSuccessor!;
    return state.manifest;
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
        const authenticatedHead = readAuthenticatedHeadContent(generation, this.#expectedUid);
        const publicationGroup = authenticatedHead.publicationGroup ?? null;
        let headContent: string;
        let headAliasPath: string | null;
        if (authenticatedHead.kind === "present") {
          headContent = authenticatedHead.content;
          headAliasPath = authenticatedHead.aliasPath;
        } else {
          // A headless group proves the prior head through its authenticated
          // capture, so the sealed publication stays recoverable without any
          // `head.json` link.
          if (publicationGroup?.captureContent === undefined || publicationGroup.captureContent === null) {
            return null;
          }
          headContent = publicationGroup.captureContent;
          headAliasPath = null;
        }
        const headTemporary = authenticatedHead.temporary;
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
          if (publicationGroup?.kind === "capture-cleaned") {
            const reconstructed = reconstructCaptureCleanedPredecessor(
              revisions,
              generationId,
              head,
              manifest,
              publicationGroup,
              this.#expectedUid,
            );
            assertNoRecoverySecondHop(revisions, manifest.revision);
            return {
              head: reconstructed.head,
              headContent: reconstructed.content,
              headAliasPath: null,
              headTemporary: null,
              publicationGroup,
              publicationSuccessor: manifest,
              manifest: reconstructed.manifest,
              generation,
              revisions,
            };
          }
          if (headTemporary !== null) {
            assertHeadTemporarySuccessor(
              revisions,
              manifest,
              headTemporary,
              this.#expectedUid,
            );
          }
          if (publicationGroup !== null) {
            const successor = assertHeadPublicationGroupSuccessor(
              revisions,
              manifest,
              publicationGroup,
              this.#expectedUid,
            );
            assertNoRecoverySecondHop(revisions, successor.revision);
            if (
              rejectImmediateSuccessor
              && publicationGroup.kind !== "committed"
              && publicationGroup.kind !== "candidate-cleaned"
            ) {
              throw new MigrationProtocolError(
                "recovery-required",
                "migration manifest has an unfinished head publication group",
              );
            }
            return {
              head,
              headContent,
              headAliasPath,
              headTemporary,
              publicationGroup,
              publicationSuccessor: successor,
              manifest,
              generation,
              revisions,
            };
          }
          if (rejectImmediateSuccessor) assertNoImmediateSuccessor(revisions, head.revision);
          return {
            head,
            headContent,
            headAliasPath,
            headTemporary,
            publicationGroup,
            publicationSuccessor: null,
            manifest,
            generation,
            revisions,
          };
        });
      },
      { allowMissingThroughIndex: 2 },
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
      if (current.publicationGroup !== null) {
        throw new MigrationProtocolError(
          "recovery-required",
          "migration manifest has an unfinished head publication group",
        );
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
          publishNonGenesisHead(
            current.generation,
            headPath,
            current.headContent,
            nextHead,
            candidate,
            this.#expectedUid,
            this.#observer,
          );
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
      if (current !== null && current.publicationGroup !== null) {
        const group = current.publicationGroup;
        if (group.kind === "capture-conflict") {
          throw new MigrationProtocolError(
            "recovery-required",
            "migration manifest head publication capture conflict requires manual recovery",
          );
        }
        return withAuthenticatedDirectories(
          [root, migrations, generation, revisions],
          this.#expectedUid,
          () => {
            const successor = assertHeadPublicationGroupSuccessor(
              revisions,
              current.manifest,
              group,
              this.#expectedUid,
            );
            assertNoRecoverySecondHop(revisions, successor.revision);
            completeHeadPublicationGroup(
              generation,
              migrationManifestHeadPath(generationId, this.#homeDir),
              group,
              this.#expectedUid,
              this.#observer,
            );
            return successor;
          },
        );
      }
      const recovered = withAuthenticatedDirectories(
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
          if (current === null) {
            this.#observer("before-head-publication", headPath);
            atomicWritePrivateFileDurable(headPath, migrationManifestHeadContent(head), {
              expectedUid: this.#expectedUid,
              expectedContentSha256: null,
              requireAbsent: true,
              maxExistingBytes: MAX_MANIFEST_BYTES,
            });
            this.#observer("after-head-publication", headPath);
          } else {
            publishNonGenesisHead(
              current.generation,
              headPath,
              current.headContent,
              head,
              recovered,
              this.#expectedUid,
              this.#observer,
            );
          }
          return recovered;
        },
        { allowMissingThroughIndex: 2 },
      );
      if (recovered === null) {
        throw new MigrationProtocolError(
          "unexpected-state",
          "migration manifest has no recoverable genesis revision",
        );
      }
      return recovered;
    });
  }
}
