import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  MigrationProtocolError,
  type MigrationManifestHead,
} from "./protocol.js";

const GENERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

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
    input.revision.toString(10).padStart(16, "0"),
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
  const expected = createMigrationManifestHead(head);
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
