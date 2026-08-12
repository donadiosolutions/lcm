import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { MigrationProtocolError } from "./protocol.js";

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
