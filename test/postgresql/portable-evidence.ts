import { expect } from "vitest";
import { canonicalSha256, PORTABLE_RECORD_DOMAIN_ORDER, type PortableManifest } from "../../src/storage/portable.js";
import { createCertificate, loadMatrix, sourceDigest } from "../../scripts/surface-parity-artifact.mjs";

type Direction = "sqlite->sqlite" | "sqlite->postgresql" | "postgresql->sqlite" | "postgresql->postgresql";

// This is the executed assertion set in capture(), native SQL readback, the
// public openers and runPortableTransfer. It is deliberately not copied from
// the inventory: adding a new public entry point cannot grant itself a receipt.
const COMMON_APIS = [
  "PORTABLE_LIMITS", "PORTABLE_RECORD_DOMAIN_ORDER", "PORTABLE_RECORD_SCHEMA_SHA256",
  "PortableStreamError", "PortableTransferError", "canonicalJson", "canonicalSha256",
  "createPortableRecord", "createPortableRecordStream", "parsePortableCheckpoint",
  "parsePortableManifest", "parsePortableRecord", "serializePortableCheckpoint",
  "serializePortableManifest", "serializePortableRecord", "verifyPortableCheckpoint",
  "runPortableTransfer",
] as const;

/** Call only after the complete assertion scope and all owned cleanup succeed. */
export function emitCanonicalEvidence(direction: Direction, manifest: PortableManifest): void {
  expect(manifest.domains.map(row => row.domain)).toEqual(PORTABLE_RECORD_DOMAIN_ORDER);
  expect(manifest.domains.every(row => row.recordCount > 0)).toBe(true);
  const [source, destination] = direction.split("->");
  const apis = [
    ...COMMON_APIS,
    ...(source === "sqlite" ? ["openSqlitePortableSource", "sqlitePortableFileSha256"] : ["createPostgreSqlPortableSource"]),
    ...(destination === "sqlite" ? ["openSqlitePortableDestination"] : ["createPostgreSqlPortableDestination"]),
  ];
  const rows = [
    ...apis.map(api => ({
      id: `portable-api:${api}`,
      assertions: api === "runPortableTransfer" ? ["contract", "resume", "replay"]
        : ["openSqlitePortableDestination", "createPostgreSqlPortableDestination"].includes(api) ? ["contract", "mismatch-refusal"] : ["contract"],
      verdict: "passed",
      digest: canonicalSha256({ api, contentSha256: manifest.contentSha256 }),
    })),
    ...manifest.domains.map(({ domain, recordCount, prefixSha256 }) => ({
      id: `portable-domain:${domain}`, assertions: ["populated", "roundtrip", "native-readback"], verdict: "passed",
      digest: canonicalSha256({ domain, recordCount, prefixSha256 }),
    })),
  ];
  console.log(createCertificate(loadMatrix(), {
    producer: "transfer", backend: direction, rows, cleanup: true,
    runId: process.env.LCM_TEST_POSTGRES_RUN_ID, sourceDigest: sourceDigest(),
  }));
}
