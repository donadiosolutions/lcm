import { createHash } from "node:crypto";
import {
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  opendirSync,
  readdirSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { withPrivateMutationLock } from "../private-mutation-lock.js";
import {
  atomicWritePrivateFileDurable,
  assertPrivateDirectory,
  openPrivateDirectory,
  readBoundedRegularFileWithStat,
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
  parseMigrationManifest,
  type MigrationManifest,
  type MigrationManifestHead,
} from "./protocol.js";

const GENERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
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

function assertPrivateChildAbsent(
  parentPath: string,
  name: string,
  expectedUid: number | undefined,
): void {
  withAuthenticatedDirectories([parentPath], expectedUid, () => {
    try {
      lstatSync(join(parentPath, name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    throw new MigrationProtocolError("unexpected-state", "migration generation already exists");
  });
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

function ensurePrivateChild(
  parentPath: string,
  name: string,
  expectedUid: number | undefined,
  requireAbsent = false,
): string {
  const childPath = join(parentPath, name);
  return withAuthenticatedDirectories([parentPath], expectedUid, () => {
    let created = false;
    try {
      mkdirSync(childPath, { mode: 0o700 });
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (requireAbsent) {
        throw new MigrationProtocolError("unexpected-state", "migration generation already exists");
      }
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
    if (authenticated.revision !== 0 || authenticated.previousManifestSha256 !== null) {
      throw new MigrationProtocolError("invalid-input", "migration manifest genesis is invalid");
    }
    return withManifestMutationLock(this.#homeDir, this.#expectedUid, () => {
      const root = lcmRoot(this.#homeDir);
      return withAuthenticatedDirectories([root], this.#expectedUid, () => {
        const migrations = ensurePrivateChild(root, "migrations", this.#expectedUid);
        const revisionPath = migrationManifestRevisionPath({
          generationId: authenticated.generationId,
          revision: authenticated.revision,
          checksumSha256: authenticated.checksumSha256,
        }, this.#homeDir);
        assertPrivateChildAbsent(
          migrations,
          authenticated.generationId,
          this.#expectedUid,
        );
        this.#observer("before-revision-publication", revisionPath);
        const generation = ensurePrivateChild(
          migrations,
          authenticated.generationId,
          this.#expectedUid,
          true,
        );
        const revisions = ensurePrivateChild(generation, "revisions", this.#expectedUid);
        const revisionDirectory = ensurePrivateChild(
          revisions,
          revisionDirectoryName(authenticated.revision),
          this.#expectedUid,
          true,
        );
        return withAuthenticatedDirectories(
          [root, migrations, generation, revisions, revisionDirectory],
          this.#expectedUid,
          () => {
            atomicWritePrivateFileDurable(revisionPath, manifestContent(authenticated), {
              expectedUid: this.#expectedUid,
              expectedContentSha256: null,
              requireAbsent: true,
              maxExistingBytes: MAX_MANIFEST_BYTES,
            });
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
    const generation = migrationManifestGenerationDirectory(generationId, this.#homeDir);
    const root = lcmRoot(this.#homeDir);
    const migrations = migrationRoot(this.#homeDir);
    const revisions = join(generation, "revisions");
    return withAuthenticatedDirectories(
      [root, migrations, generation, revisions],
      this.#expectedUid,
      () => {
        const headPath = migrationManifestHeadPath(generationId, this.#homeDir);
        const headContent = readBoundedRegularFileWithStat(headPath, {
          allowedRoot: generation,
          maxBytes: MAX_MANIFEST_BYTES,
          expectedUid: this.#expectedUid,
          allowedModes: [0o600],
          requireSingleLink: true,
        }).content;
        const head = parseMigrationManifestHeadContent(headContent);
        if (head.generationId !== generationId) {
          return malformedHead("migration manifest head generation does not match");
        }
        const revisionDirectory = join(
          revisions,
          revisionDirectoryName(head.revision),
        );
        return withAuthenticatedDirectories([revisionDirectory], this.#expectedUid, () => {
          const entries = readDirectoryEntriesBounded(revisionDirectory, 2);
          if (entries.length !== 1 || entries[0] !== head.revisionFilename) {
            return malformedHead("migration manifest revision directory is invalid");
          }
          const revisionPath = migrationManifestRevisionPath({
            generationId,
            revision: head.revision,
            checksumSha256: head.manifestSha256,
          }, this.#homeDir);
          const content = readBoundedRegularFileWithStat(revisionPath, {
            allowedRoot: revisionDirectory,
            maxBytes: MAX_MANIFEST_BYTES,
            expectedUid: this.#expectedUid,
            allowedModes: [0o600],
            requireSingleLink: true,
          }).content;
          const manifest = parseManifestContent(content);
          if (
            manifest.generationId !== generationId
            || manifest.revision !== head.revision
            || manifest.checksumSha256 !== head.manifestSha256
          ) {
            return malformedHead("migration manifest revision does not match its head");
          }
          return manifest;
        });
      },
    );
  }
}
