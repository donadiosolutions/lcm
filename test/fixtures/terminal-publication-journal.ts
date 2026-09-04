import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { backendPublicationCanonicalSha256 } from "../../src/storage/backend-publication.js";

function presentWitness(content: string): Record<string, unknown> {
  return {
    presence: "present",
    rawSha256: createHash("sha256").update(content).digest("hex"),
    semanticSha256: backendPublicationCanonicalSha256(JSON.parse(content)),
    byteLength: Buffer.byteLength(content),
    mode: 0o600,
    uid: typeof process.getuid === "function" ? process.getuid() : 0,
    gid: typeof process.getgid === "function" ? process.getgid() : 0,
    nlink: "1",
    dev: "1",
    ino: "1",
    parentDev: "1",
    parentIno: "1",
  };
}

const ABSENT_WITNESS = {
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

/**
 * Write a fully valid aborted terminal publication journal. Aborted
 * publications legitimately remove their recovery material, so the journal
 * checksum and retained witnesses are the complete authenticated evidence and
 * lock-free readers admit the source backend through it. Distinct
 * `publicationId` values yield distinct journal checksums, which lets tests
 * reach the checksum-inequality guards of double-snapshot readers.
 */
export function writeAbortedTerminalPublicationJournal(
  home: string,
  publicationId = "terminal-publication-a",
  sourceConfig = "{}",
): string {
  const publicationDir = join(home, ".lcm", "backend-publication");
  mkdirSync(publicationDir, { recursive: true, mode: 0o700 });
  const targetConfig = JSON.stringify({ storage: { backend: "postgresql" } });
  const payload = {
    version: 2,
    publicationId,
    sourceBackend: "sqlite",
    targetBackend: "postgresql",
    phase: "aborted",
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T00:00:01.000Z",
    expectedConfigSha256: createHash("sha256").update(sourceConfig).digest("hex"),
    expectedProjectMapSha256: backendPublicationCanonicalSha256({}),
    intendedConfigSha256: createHash("sha256").update(targetConfig).digest("hex"),
    intendedProjectMapSha256: backendPublicationCanonicalSha256({}),
    publishedConfigSha256: null,
    publishedProjectMapSha256: null,
    recoveryReference: {
      relativePath: `${publicationId}.material`,
      sealSha256: "a".repeat(64),
      byteLength: 1,
    },
    sourceState: { config: presentWitness(sourceConfig), projectMap: ABSENT_WITNESS },
    targetState: { config: presentWitness(targetConfig), projectMap: ABSENT_WITNESS },
    projects: [],
  };
  const checksumSha256 = backendPublicationCanonicalSha256(payload);
  writeFileSync(
    join(publicationDir, "journal.json"),
    `${JSON.stringify({ ...payload, checksumSha256 })}\n`,
    { mode: 0o600 },
  );
  return checksumSha256;
}
