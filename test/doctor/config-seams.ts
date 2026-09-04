import { createHash } from "node:crypto";
import type { DoctorDeps } from "../../src/doctor/types.js";
import type { DaemonConfigRawSnapshot } from "../../src/daemon/config.js";

/**
 * Build the internal lock-free config seams for doctor tests from in-memory
 * content. The production path stays single: these only replace the raw
 * snapshot reader and the publication read admission inside it.
 */
export function doctorConfigSeams(
  content: string | null,
  assertReadAccess: DoctorDeps["_assertPublicationReadAccess"] = () => Object.freeze({ journalChecksumSha256: null }),
): Pick<DoctorDeps, "_readDaemonConfigRawSnapshot" | "_assertPublicationReadAccess"> {
  const snapshot: DaemonConfigRawSnapshot = content === null
    ? Object.freeze({
      content: "{}",
      witness: Object.freeze({
        presence: "absent" as const,
        rawSha256: null,
        byteLength: 0,
        dev: null,
        ino: null,
        mtimeMs: null,
      }),
    })
    : Object.freeze({
      content,
      witness: Object.freeze({
        presence: "present" as const,
        rawSha256: createHash("sha256").update(content).digest("hex"),
        byteLength: Buffer.byteLength(content),
        dev: "1",
        ino: "2",
        mtimeMs: 1,
      }),
    });
  return {
    _readDaemonConfigRawSnapshot: () => snapshot,
    _assertPublicationReadAccess: assertReadAccess,
  };
}

/** Seams whose raw snapshot reader fails before any bytes are observed. */
export function doctorConfigReadFailureSeams(
  error: unknown,
): Pick<DoctorDeps, "_readDaemonConfigRawSnapshot" | "_assertPublicationReadAccess"> {
  return {
    _readDaemonConfigRawSnapshot: () => { throw error; },
    _assertPublicationReadAccess: () => Object.freeze({ journalChecksumSha256: null }),
  };
}
