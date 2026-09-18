import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  PRIVATE_FILE_MODE,
  atomicWritePrivateFileExclusive,
  readBoundedRegularFileWithStat,
  syncPrivateDirectory,
} from "../security-files.js";
import { parseMigrationVerificationReport, type MigrationVerificationReport } from "./verification-report.js";

/**
 * Atomic, private, content-addressed persistence for #624 verification
 * reports, per witness-schema-FROZEN-v3.1.md section 12:
 *
 * - Atomic durable publish: temp, fsync, link onto the exclusive final
 *   name, fsync the directory. A crash mid-write can only ever leave a
 *   temporary, never a partial file under the final name.
 * - The store key is the report identity digest (reportSha256), never the
 *   generation id, so two legitimate reports for the same generation can
 *   coexist.
 * - On EEXIST, the existing bytes are read back and required to be
 *   byte-identical. Identical means reuse, including its identity.
 *   Different means the identity derivation is broken: abort plus a new
 *   generation, never an overwrite and never a silent second record.
 * - Resume completes from the persisted report rather than recomputing
 *   (that trust decision belongs to verify-generation.ts; this module only
 *   provides the durable read-back it relies on).
 */

export type MigrationVerificationStoreReason =
  | "invalid-input"
  | "malformed-record"
  | "absent"
  | "identity-conflict";

export class MigrationVerificationStoreError extends Error {
  constructor(
    readonly reason: MigrationVerificationStoreReason,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "MigrationVerificationStoreError";
  }
}

function storeError(
  reason: MigrationVerificationStoreReason,
  message: string,
  options?: ErrorOptions,
): never {
  throw new MigrationVerificationStoreError(reason, message, options);
}

const GENERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const REPORT_FILENAME_PATTERN = /^([0-9a-f]{64})\.json$/u;
/** Generous but bounded: reports carry a fixed number of fields plus a truncated mismatch list. */
const MAX_REPORT_BYTES = 4 * 1024 * 1024;

function assertGenerationId(generationId: string): void {
  if (typeof generationId !== "string" || !GENERATION_ID_PATTERN.test(generationId)) {
    storeError("invalid-input", "migration verification generation id is invalid");
  }
}

function assertReportSha256(reportSha256: string): void {
  if (typeof reportSha256 !== "string" || !SHA256_PATTERN.test(reportSha256)) {
    storeError("invalid-input", "migration verification report identity is invalid");
  }
}

function verificationRoot(homeDir?: string): string {
  return join(resolve(homeDir ?? homedir()), ".lcm", "migration-verification");
}

function reportsDirectory(generationId: string, homeDir?: string): string {
  assertGenerationId(generationId);
  return join(verificationRoot(homeDir), "generations", generationId, "reports");
}

function reportPath(generationId: string, reportSha256: string, homeDir?: string): string {
  assertReportSha256(reportSha256);
  return join(reportsDirectory(generationId, homeDir), `${reportSha256}.json`);
}

type CanonicalJson = null | boolean | number | string
  | readonly CanonicalJson[]
  | Readonly<{ [key: string]: CanonicalJson }>;

function canonicalJson(value: CanonicalJson): string {
  if (value === null || typeof value === "boolean" || typeof value === "string" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Readonly<Record<string, CanonicalJson>>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key]!)}`).join(",")}}`;
}

function reportContent(report: MigrationVerificationReport): string {
  return `${canonicalJson(report as unknown as CanonicalJson)}\n`;
}

function parsePersistedContent(content: string, path: string): MigrationVerificationReport {
  if (!content.endsWith("\n")) storeError("malformed-record", `migration verification report at ${path} is malformed`);
  let value: unknown;
  try {
    value = JSON.parse(content.slice(0, -1));
  } catch (error) {
    storeError("malformed-record", `migration verification report at ${path} is not valid JSON`, { cause: error });
  }
  let report: MigrationVerificationReport;
  try {
    report = parseMigrationVerificationReport(value);
  } catch (error) {
    storeError("malformed-record", `migration verification report at ${path} does not pass validation`, { cause: error });
  }
  if (content !== reportContent(report)) {
    storeError("malformed-record", `migration verification report at ${path} is not canonical`);
  }
  return report;
}

export type MigrationVerificationPersistOutcome = Readonly<{
  outcome: "published" | "reused";
  report: MigrationVerificationReport;
}>;

export interface MigrationVerificationStoreOptions {
  readonly homeDir?: string;
  readonly expectedUid?: number;
}

export class MigrationVerificationReportStore {
  readonly #homeDir: string | undefined;
  readonly #expectedUid: number | undefined;

  constructor(options: MigrationVerificationStoreOptions = {}) {
    this.#homeDir = options.homeDir;
    this.#expectedUid = options.expectedUid;
  }

  /**
   * Atomically persist a report keyed by its identity digest. First
   * persisted wins: a caller that loses the race reuses the winner's bytes
   * rather than treating its own attempt as authoritative.
   */
  persist(generationId: string, report: MigrationVerificationReport): MigrationVerificationPersistOutcome {
    assertGenerationId(generationId);
    const validated = parseMigrationVerificationReport(report);
    const content = reportContent(validated);
    const directory = reportsDirectory(generationId, this.#homeDir);
    const path = reportPath(generationId, validated.reportSha256, this.#homeDir);
    const published = atomicWritePrivateFileExclusive(path, content);
    if (published) {
      syncPrivateDirectory(directory, { expectedUid: this.#expectedUid });
      return { outcome: "published", report: validated };
    }
    const existing = readBoundedRegularFileWithStat(path, {
      allowedRoot: directory,
      maxBytes: MAX_REPORT_BYTES,
      expectedUid: this.#expectedUid,
      allowedModes: [PRIVATE_FILE_MODE],
      requireSingleLink: true,
    });
    if (existing.content !== content) {
      storeError(
        "identity-conflict",
        "migration verification report identity collides with different content; abort and start a new generation",
      );
    }
    return { outcome: "reused", report: parsePersistedContent(existing.content, path) };
  }

  /** Read back a previously persisted report by its exact identity, without recomputing anything. */
  read(generationId: string, reportSha256: string): MigrationVerificationReport {
    assertGenerationId(generationId);
    assertReportSha256(reportSha256);
    const directory = reportsDirectory(generationId, this.#homeDir);
    const path = reportPath(generationId, reportSha256, this.#homeDir);
    let existing: ReturnType<typeof readBoundedRegularFileWithStat>;
    try {
      existing = readBoundedRegularFileWithStat(path, {
        allowedRoot: directory,
        maxBytes: MAX_REPORT_BYTES,
        expectedUid: this.#expectedUid,
        allowedModes: [PRIVATE_FILE_MODE],
        requireSingleLink: true,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        storeError("absent", `migration verification report at ${path} is absent`, { cause: error });
      }
      throw error;
    }
    const report = parsePersistedContent(existing.content, path);
    if (report.reportSha256 !== reportSha256) {
      storeError("malformed-record", `migration verification report at ${path} does not match its own filename`);
    }
    return report;
  }

  /** True iff a report with this exact identity is already durably persisted. */
  has(generationId: string, reportSha256: string): boolean {
    assertGenerationId(generationId);
    assertReportSha256(reportSha256);
    const directory = reportsDirectory(generationId, this.#homeDir);
    const path = reportPath(generationId, reportSha256, this.#homeDir);
    try {
      readBoundedRegularFileWithStat(path, {
        allowedRoot: directory,
        maxBytes: MAX_REPORT_BYTES,
        expectedUid: this.#expectedUid,
        allowedModes: [PRIVATE_FILE_MODE],
        requireSingleLink: true,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      storeError("malformed-record", `migration verification report at ${path} cannot be inspected`, { cause: error });
    }
    return true;
  }
}

export function migrationVerificationReportFilename(reportSha256: string): string {
  assertReportSha256(reportSha256);
  return `${reportSha256}.json`;
}

export function parseMigrationVerificationReportFilename(filename: string): string {
  const match = REPORT_FILENAME_PATTERN.exec(filename);
  if (match === null) storeError("invalid-input", "migration verification report filename is invalid");
  return match[1]!;
}
