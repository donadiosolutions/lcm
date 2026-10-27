import { fsyncSync, lstatSync } from "node:fs";
import { join } from "node:path";
import {
  PRIVATE_FILE_MODE,
  atomicWritePrivateFileDurable,
  assertPrivateDirectory,
  ensurePrivateDirectory,
  isPrivateFileCollisionFailure,
  openPrivateDirectory,
  openPrivateDirectoryIfExists,
  readBoundedRegularFileWithStat,
  type BoundedFileResult,
  type PrivateDirectoryHandle,
} from "../security-files.js";
import { canonicalJson, canonicalSha256, sha256 } from "../storage/portable-record.js";
import { attributeNullableRead } from "./activation-absence.js";
import type { MigrationReportReference } from "./protocol.js";

/**
 * The activation report (plan-v6 G5): the durable record plan-v5 S16 writes
 * immediately before completeMigrationEffect("publish-activation"), and the
 * value whose reference that completion carries into the manifest's reports
 * array. It is the activation-side twin of #624's verification report and
 * reuses that store's discipline by decision D-625-1:
 *
 * - The body is a closed set of fields, every one of which is already
 *   durable elsewhere (epoch, attempt, witness checksum, publicationId,
 *   artifact identity digest, manifest revision and the post-publication
 *   project-map witness). The report adds no new fact; it binds the facts
 *   of one completed activation together under one identity so a later
 *   reader can check them against each other rather than trust any one
 *   alone. The body is therefore a pure function of durable state: a
 *   retried S16 re-derives byte-identical bytes. That is why the S15
 *   restart verdict is deliberately NOT in the body (plan-v7 A7 / S-1): it
 *   is a live observation of a process that may have been restarted
 *   between two retries, so carrying it would make two honest retries
 *   disagree about one activation's identity. The verdict travels only in
 *   the orchestrator's outcome.
 * - reportSha256 is the canonical SHA-256 of the body, and reportId is
 *   derived from it ("publish-activation-" + reportSha256), mirroring
 *   verification-report.ts's "verify-generation-" + reportSha256. Two
 *   reports with identical bodies are one report; a body that differs in
 *   any field is a different report with a different identity.
 * - createdAt is the pending publish-activation effect's startedAt (S10),
 *   never a fresh clock read: a resumed driver that re-derives the body
 *   from durable state must produce byte-identical bytes, and a fresh
 *   timestamp would rotate the identity on every retry.
 * - Persistence is immutable and content-addressed under
 *   <home>/.lcm/migration-activation-reports/<sha256(generationId)>/
 *   <reportSha256>.json: requireAbsent durable write, byte-identical reuse
 *   on an existing key, typed identity-conflict on different bytes, and
 *   directory fsync on creation (ensureSyncedPrivateChild, the same
 *   creation-path durability generation-binding-store.ts applies). The
 *   per-generation directory is named by the generation id's SHA-256, never
 *   the raw id, matching that store.
 * - Reads deliberately do not require a single hard link, for exactly the
 *   reason verification-store.ts documents: the durable writer's best-effort
 *   scratch cleanup can fail after the link already succeeded, leaving an
 *   immutable, content-addressed file with nlink=2 forever; requiring one
 *   link would wedge every later reuse of that identity while adding no
 *   safety, because the read-back already requires byte identity against
 *   the caller's own bytes (writer) or the filename's digest (reader).
 *
 * The reader is three-valued, never null (plan-v5 section 4's nullable-read
 * audit): "resolved", "authoritatively-absent" for an attributed not-found,
 * or "unresolvable" with a reason when the read could not be trusted. An
 * unrecognized I/O error propagates raw rather than being attributed.
 */

const ACTIVATION_REPORT_VERSION = 1 as const;
const ACTIVATION_REPORT_KIND = "activation" as const;
const ACTIVATION_REPORT_SUBDIRECTORY = "migration-activation-reports";
const REPORT_ID_PREFIX = "publish-activation-";
/** Same identifier shape every migration store in this directory requires. */
const TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const HASH_PATTERN = /^[0-9a-f]{64}$/u;
/** A report is a fixed set of bounded tokens: well under 2 KiB at every
 * field's maximum. Bounded generously above that, matching the sibling
 * stores' convention. */
const MAX_ACTIVATION_REPORT_BYTES = 16 * 1024;

const BODY_KEYS = [
  "attemptId",
  "createdAt",
  "epochId",
  "generationId",
  "identityDigest",
  "kind",
  "manifestRevisionAtComplete",
  "postPublicationProjectMapWitnessSha256",
  "publicationId",
  "version",
  "witnessChecksumSha256",
] as const;
const REPORT_KEYS = ["body", "reportId", "reportSha256", "version"] as const;
/** The caller supplies every body field except the two constants. */
const CREATE_INPUT_KEYS = BODY_KEYS.filter((key) => key !== "version" && key !== "kind");

export type MigrationActivationReportBody = Readonly<{
  version: typeof ACTIVATION_REPORT_VERSION;
  kind: typeof ACTIVATION_REPORT_KIND;
  generationId: string;
  epochId: string;
  attemptId: string;
  witnessChecksumSha256: string;
  publicationId: string;
  /** Store key of the recovery-material record (activation-artifact-store.ts). */
  identityDigest: string;
  /** The pending (activating) manifest's revision as read immediately
   * before completeMigrationEffect, never the successor's: the successor
   * revision only exists after the report is already written, so carrying
   * it would make the body non-reproducible (plan-v7.1 amendment 2). */
  manifestRevisionAtComplete: number;
  /** computeMigrationProjectMapWitnessSha256 in mode "post-publication" at
   * S16's authoritative readback (plan-v6 section 2). */
  postPublicationProjectMapWitnessSha256: string;
  /** The pending publish-activation effect's startedAt (S10), never a fresh clock read. */
  createdAt: string;
}>;

export type CreateMigrationActivationReportInput = Readonly<Omit<MigrationActivationReportBody, "version" | "kind">>;

export type MigrationActivationReport = Readonly<{
  version: typeof ACTIVATION_REPORT_VERSION;
  reportId: string;
  body: MigrationActivationReportBody;
  reportSha256: string;
}>;

export type MigrationActivationReportReason =
  /** The caller's input does not satisfy the body or report schema. Thrown before any I/O. */
  | "invalid-input"
  /** A caller-supplied report fails strict parsing (schema, checksum or reportId derivation). */
  | "malformed-record"
  /** The private LCM root, the store directory or the per-generation directory is missing or unsafe. */
  | "unsafe-storage"
  /** A presence read needed before writing could not be completed and trusted. */
  | "unresolvable"
  /** A report already exists at this identity with different bytes. */
  | "identity-conflict";

export class MigrationActivationReportError extends Error {
  constructor(readonly reason: MigrationActivationReportReason, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MigrationActivationReportError";
  }
}

function reportError(reason: MigrationActivationReportReason, message: string, options?: ErrorOptions): never {
  throw new MigrationActivationReportError(reason, message, options);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return canonicalJson(Object.keys(value).sort()) === canonicalJson([...keys].sort());
}

function isToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN_PATTERN.test(value);
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && HASH_PATTERN.test(value);
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !value.endsWith("Z")) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

/** Matches security-files.ts's own internal currentUid helper (and its
 * repeated copies across the sibling stores): a local one-line duplicate
 * rather than a cross-module import, per this codebase's convention. */
function currentUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

// --- The report value --------------------------------------------------------

function parseBody(value: unknown, reason: MigrationActivationReportReason): MigrationActivationReportBody {
  if (!isRecord(value) || !exactKeys(value, BODY_KEYS)) {
    reportError(reason, "migration activation report body has an invalid shape");
  }
  if (
    value.version !== ACTIVATION_REPORT_VERSION
    || value.kind !== ACTIVATION_REPORT_KIND
    || !isToken(value.generationId)
    || !isToken(value.epochId)
    || !isToken(value.attemptId)
    || !isHash(value.witnessChecksumSha256)
    || !isToken(value.publicationId)
    || !isHash(value.identityDigest)
    || !Number.isSafeInteger(value.manifestRevisionAtComplete)
    || (value.manifestRevisionAtComplete as number) < 0
    || !isHash(value.postPublicationProjectMapWitnessSha256)
    || !isIsoTimestamp(value.createdAt)
  ) {
    reportError(reason, "migration activation report body is invalid");
  }
  return deepFreeze({
    version: ACTIVATION_REPORT_VERSION,
    kind: ACTIVATION_REPORT_KIND,
    generationId: value.generationId,
    epochId: value.epochId,
    attemptId: value.attemptId,
    witnessChecksumSha256: value.witnessChecksumSha256,
    publicationId: value.publicationId,
    identityDigest: value.identityDigest,
    manifestRevisionAtComplete: value.manifestRevisionAtComplete as number,
    postPublicationProjectMapWitnessSha256: value.postPublicationProjectMapWitnessSha256,
    createdAt: value.createdAt,
  });
}

function reportIdFor(reportSha256: string): string {
  return REPORT_ID_PREFIX + reportSha256;
}

/**
 * Build the report value for a completed activation. Validates every field
 * strictly (invalid-input), then derives reportSha256 and reportId from the
 * body alone; the result is deeply frozen.
 */
export function createMigrationActivationReport(input: CreateMigrationActivationReportInput): MigrationActivationReport {
  if (!isRecord(input) || !exactKeys(input, CREATE_INPUT_KEYS)) {
    reportError("invalid-input", "migration activation report input is invalid");
  }
  const body = parseBody({ ...input, version: ACTIVATION_REPORT_VERSION, kind: ACTIVATION_REPORT_KIND }, "invalid-input");
  const reportSha256 = canonicalSha256(body);
  return deepFreeze({ version: ACTIVATION_REPORT_VERSION, reportId: reportIdFor(reportSha256), body, reportSha256 });
}

/**
 * Strictly re-parse a report value (from a caller or from storage): exact
 * shape, valid body, reportSha256 equal to the body's recomputed canonical
 * digest, and reportId equal to its derivation from that digest. Anything
 * else is malformed-record; nothing is carried on trust.
 */
export function parseMigrationActivationReport(value: unknown): MigrationActivationReport {
  if (!isRecord(value) || !exactKeys(value, REPORT_KEYS) || value.version !== ACTIVATION_REPORT_VERSION) {
    reportError("malformed-record", "migration activation report has an invalid shape");
  }
  const body = parseBody(value.body, "malformed-record");
  const reportSha256 = canonicalSha256(body);
  if (value.reportSha256 !== reportSha256) {
    reportError("malformed-record", "migration activation report checksum does not match its body");
  }
  if (value.reportId !== reportIdFor(reportSha256)) {
    reportError("malformed-record", "migration activation report id does not derive from its checksum");
  }
  return deepFreeze({ version: ACTIVATION_REPORT_VERSION, reportId: value.reportId, body, reportSha256 });
}

/**
 * The reference completeMigrationEffect("publish-activation") accepts
 * (protocol.ts: kind "activation", exact keys createdAt/kind/reportId/
 * reportSha256, identifier-shaped reportId, 64-hex reportSha256, ISO
 * createdAt). createdAt is the body's, so the manifest's reports array
 * carries the pending effect's startedAt, not a completion clock.
 */
export function migrationActivationReportReference(report: MigrationActivationReport): MigrationReportReference {
  const parsed = parseMigrationActivationReport(report);
  return Object.freeze({
    kind: ACTIVATION_REPORT_KIND,
    reportId: parsed.reportId,
    reportSha256: parsed.reportSha256,
    createdAt: parsed.body.createdAt,
  });
}

// --- Persistence -------------------------------------------------------------

function rootPath(homeDir: string): string {
  return join(homeDir, ".lcm");
}

export function migrationActivationReportStoreDirectory(homeDir: string): string {
  return join(rootPath(homeDir), ACTIVATION_REPORT_SUBDIRECTORY);
}

/** Per-generation directory, named by the generation id's SHA-256. */
export function migrationActivationReportDirectory(homeDir: string, generationId: string): string {
  return join(migrationActivationReportStoreDirectory(homeDir), sha256(generationId));
}

export function migrationActivationReportPath(homeDir: string, generationId: string, reportSha256: string): string {
  return join(migrationActivationReportDirectory(homeDir, generationId), reportSha256 + ".json");
}

function reportContent(report: MigrationActivationReport): string {
  return canonicalJson({
    version: report.version,
    reportId: report.reportId,
    body: report.body,
    reportSha256: report.reportSha256,
  }) + "\n";
}

function validateHomeDir(homeDir: unknown): string {
  if (typeof homeDir !== "string" || homeDir.length === 0) {
    reportError("invalid-input", "migration activation report homeDir is invalid");
  }
  return homeDir;
}

function validateGenerationId(generationId: unknown): string {
  if (!isToken(generationId)) reportError("invalid-input", "migration activation report generation id is invalid");
  return generationId;
}

function validateReportSha256(reportSha256: unknown): string {
  if (!isHash(reportSha256)) reportError("invalid-input", "migration activation report identity is invalid");
  return reportSha256;
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Local duplicate of generation-binding-store.ts's ensureSyncedPrivateChild:
 * create (if absent) and authenticate a private child beneath an open,
 * authenticated parent, fsyncing both the fresh child and the parent when
 * this call created it so the new entry survives a crash right after. */
function ensureSyncedPrivateChild(
  parentHandle: PrivateDirectoryHandle,
  childPath: string,
  expectedUid: number | undefined,
): PrivateDirectoryHandle {
  const alreadyExisted = pathExists(childPath);
  ensurePrivateDirectory(childPath);
  const childHandle = openPrivateDirectory(childPath, { expectedUid });
  if (!alreadyExisted) {
    fsyncSync(childHandle.fd);
    fsyncSync(parentHandle.fd);
  }
  return childHandle;
}

function ensureReportDirectories(homeDir: string, generationId: string, expectedUid: number | undefined): string {
  const root = rootPath(homeDir);
  let rootHandle: PrivateDirectoryHandle;
  try {
    rootHandle = openPrivateDirectory(root, { expectedUid });
  } catch (error) {
    reportError("unsafe-storage", "private LCM root cannot be opened: " + (error as Error).message, { cause: error });
  }
  try {
    let storeHandle: PrivateDirectoryHandle;
    try {
      storeHandle = ensureSyncedPrivateChild(rootHandle, migrationActivationReportStoreDirectory(homeDir), expectedUid);
    } catch (error) {
      reportError("unsafe-storage", "activation report store directory is unsafe: " + (error as Error).message, { cause: error });
    }
    try {
      const generationDirectory = migrationActivationReportDirectory(homeDir, generationId);
      let generationHandle: PrivateDirectoryHandle;
      try {
        generationHandle = ensureSyncedPrivateChild(storeHandle, generationDirectory, expectedUid);
      } catch (error) {
        reportError("unsafe-storage", "per-generation activation report directory is unsafe: " + (error as Error).message, { cause: error });
      }
      generationHandle.close();
      return generationDirectory;
    } finally {
      storeHandle.close();
    }
  } finally {
    rootHandle.close();
  }
}

export type MigrationActivationReportStoreDependencies = Readonly<{
  /** Defaults to atomicWritePrivateFileDurable; exists to exercise this
   * module's handling of an unrecognized durable-write failure. */
  writeDurable?: typeof atomicWritePrivateFileDurable;
  /** Defaults to readBoundedRegularFileWithStat. */
  readWithStat?: typeof readBoundedRegularFileWithStat;
  expectedUid?: number;
}>;

export type MigrationActivationReportPersistResult = Readonly<{
  outcome: "published" | "reused";
  report: MigrationActivationReport;
  path: string;
}>;

function readExisting(
  path: string,
  directory: string,
  expectedUid: number | undefined,
  readWithStat: typeof readBoundedRegularFileWithStat,
) {
  return attributeNullableRead<BoundedFileResult>(
    () => readWithStat(path, {
      allowedRoot: directory,
      maxBytes: MAX_ACTIVATION_REPORT_BYTES,
      expectedUid,
      allowedModes: [PRIVATE_FILE_MODE],
      // Not requireSingleLink: see the module doc comment.
    }),
  );
}

function reconcileExisting(
  path: string,
  directory: string,
  content: string,
  expectedUid: number | undefined,
  readWithStat: typeof readBoundedRegularFileWithStat,
): "absent" | "reused" {
  const outcome = readExisting(path, directory, expectedUid, readWithStat);
  if (outcome.kind === "unresolvable") {
    reportError("unresolvable", "cannot determine whether a migration activation report exists at " + path + ": " + outcome.detail);
  }
  if (outcome.kind === "absent") return "absent";
  if (outcome.value.content === content) return "reused";
  reportError(
    "identity-conflict",
    "a migration activation report already exists at " + path + " with different content; refusing to overwrite it",
  );
}

/**
 * Durably persist a report under its own identity, or reuse an existing
 * byte-identical one. An S16 retry that finds a stored report for this
 * publication already authenticating reuses those bytes (plan-v7.1
 * amendment 2): the body is reproducible, so the recomputed report is the
 * same identity and persist reports "reused" without rewriting. The report
 * is strictly re-parsed first and its body
 * must name generationId (the path is derived from the caller's generation
 * id, and a report filed under another generation's directory would be
 * read back as evidence about the wrong generation).
 */
export function persistMigrationActivationReport(
  input: Readonly<{ homeDir: string; generationId: string; report: MigrationActivationReport }>,
  dependencies: MigrationActivationReportStoreDependencies = {},
): MigrationActivationReportPersistResult {
  if (!isRecord(input)) reportError("invalid-input", "migration activation report persist input is invalid");
  const homeDir = validateHomeDir(input.homeDir);
  const generationId = validateGenerationId(input.generationId);
  const report = parseMigrationActivationReport(input.report);
  if (report.body.generationId !== generationId) {
    reportError(
      "invalid-input",
      "migration activation report body names generation " + report.body.generationId + ", not " + generationId,
    );
  }
  const expectedUid = dependencies.expectedUid ?? currentUid();
  const readWithStat = dependencies.readWithStat ?? readBoundedRegularFileWithStat;
  const writeDurable = dependencies.writeDurable ?? atomicWritePrivateFileDurable;
  const content = reportContent(report);
  const directory = ensureReportDirectories(homeDir, generationId, expectedUid);
  const path = migrationActivationReportPath(homeDir, generationId, report.reportSha256);

  const attempt = (): "absent" | "reused" => reconcileExisting(path, directory, content, expectedUid, readWithStat);
  if (attempt() === "reused") return { outcome: "reused", report, path };
  try {
    writeDurable(path, content, { requireAbsent: true, maxExistingBytes: MAX_ACTIVATION_REPORT_BYTES, expectedUid });
  } catch (error) {
    if (!isPrivateFileCollisionFailure(error)) throw error;
    // A concurrent writer published between the presence check and this
    // write. Re-reconcile rather than fail: byte-identical is a reuse, and
    // different bytes is the typed identity-conflict reconcileExisting
    // raises. A collision that vanished again surfaces the original error
    // rather than looping against a changing filesystem.
    if (attempt() === "absent") throw error;
    return { outcome: "reused", report, path };
  }
  return { outcome: "published", report, path };
}

export type MigrationActivationReportUnresolvableReason =
  | "root-unauthenticated"
  | "directory-unauthenticated"
  | "read-unresolvable"
  /** The stored bytes are not a canonical, strictly valid report. */
  | "malformed-record"
  /** The stored report is valid but does not match the identity or
   * generation its path claims. */
  | "identity-mismatch"
  | "directory-changed";

export type MigrationActivationReportReadResult = Readonly<
  | { state: "resolved"; report: MigrationActivationReport; path: string }
  | { state: "authoritatively-absent"; detail: string }
  | { state: "unresolvable"; reason: MigrationActivationReportUnresolvableReason; detail: string }
>;

/**
 * Read back a report by its exact identity, three-valued. The private LCM
 * root, the store directory and the per-generation directory are each
 * authenticated before the read and re-asserted after it; only a genuinely
 * absent level (ENOENT) or file is "authoritatively-absent". Malformed
 * input throws invalid-input before any I/O; an unrecognized I/O error
 * propagates raw.
 */
export function readMigrationActivationReport(
  input: Readonly<{ homeDir: string; generationId: string; reportSha256: string }>,
  dependencies: Readonly<{ readWithStat?: typeof readBoundedRegularFileWithStat; expectedUid?: number }> = {},
): MigrationActivationReportReadResult {
  if (!isRecord(input)) reportError("invalid-input", "migration activation report read input is invalid");
  const homeDir = validateHomeDir(input.homeDir);
  const generationId = validateGenerationId(input.generationId);
  const reportSha256 = validateReportSha256(input.reportSha256);
  const expectedUid = dependencies.expectedUid ?? currentUid();
  const readWithStat = dependencies.readWithStat ?? readBoundedRegularFileWithStat;
  const unresolvable = (reason: MigrationActivationReportUnresolvableReason, detail: string): MigrationActivationReportReadResult =>
    ({ state: "unresolvable", reason, detail });
  const absent = (detail: string): MigrationActivationReportReadResult => ({ state: "authoritatively-absent", detail });

  const levels: readonly [string, string][] = [
    [rootPath(homeDir), "private LCM root"],
    [migrationActivationReportStoreDirectory(homeDir), "activation report store directory"],
    [migrationActivationReportDirectory(homeDir, generationId), "per-generation activation report directory"],
  ];
  const handles: Array<readonly [PrivateDirectoryHandle, string]> = [];
  try {
    for (const [path, describe] of levels) {
      let handle: PrivateDirectoryHandle | undefined;
      try {
        handle = openPrivateDirectoryIfExists(path, { expectedUid });
      } catch (error) {
        return unresolvable(
          handles.length === 0 ? "root-unauthenticated" : "directory-unauthenticated",
          "cannot authenticate the " + describe + " " + path + ": " + (error as Error).message,
        );
      }
      if (handle === undefined) return absent("the " + describe + " " + path + " does not exist");
      handles.push([handle, path]);
    }
    const directory = handles[handles.length - 1]![1];
    const path = migrationActivationReportPath(homeDir, generationId, reportSha256);
    const outcome = readExisting(path, directory, expectedUid, readWithStat);
    if (outcome.kind === "unresolvable") {
      return unresolvable("read-unresolvable", "cannot determine whether a migration activation report exists at " + path + ": " + outcome.detail);
    }
    let resolved: MigrationActivationReportReadResult;
    if (outcome.kind === "absent") {
      resolved = absent("no migration activation report exists at " + path + ": " + outcome.detail);
    } else {
      let report: MigrationActivationReport;
      try {
        report = parseMigrationActivationReport(JSON.parse(outcome.value.content) as unknown);
      } catch (error) {
        return unresolvable(
          "malformed-record",
          "migration activation report at " + path + " is not a valid report: " + (error as Error).message,
        );
      }
      if (reportContent(report) !== outcome.value.content) {
        return unresolvable("malformed-record", "migration activation report at " + path + " is not canonical");
      }
      if (report.reportSha256 !== reportSha256) {
        return unresolvable("identity-mismatch", "migration activation report at " + path + " does not match its own filename");
      }
      if (report.body.generationId !== generationId) {
        return unresolvable(
          "identity-mismatch",
          "migration activation report at " + path + " names generation " + report.body.generationId + ", not " + generationId,
        );
      }
      resolved = { state: "resolved", report, path };
    }
    try {
      for (const [handle, levelPath] of handles) {
        assertPrivateDirectory(handle, levelPath, handle.witness, expectedUid);
      }
    } catch (error) {
      return unresolvable(
        "directory-changed",
        "an activation report directory changed during the read: " + (error as Error).message,
      );
    }
    return resolved;
  } finally {
    for (const [handle] of handles) handle.close();
  }
}

export type MigrationActivationReportPresenceResult = Readonly<
  | { state: "present"; detail: string }
  | { state: "authoritatively-absent"; detail: string }
  | { state: "unresolvable"; reason: Extract<MigrationActivationReportUnresolvableReason, "root-unauthenticated" | "directory-unauthenticated" | "directory-changed">; detail: string }
>;

/**
 * Whether any activation report may exist for a generation, three-valued
 * (#1549 F1). The private LCM root, the store directory and the
 * per-generation directory are authenticated in turn and every handle is
 * retained until the answer is known, then re-asserted against its
 * pathname and witness (#1660): only a genuinely absent level (ENOENT)
 * under still-authenticated ancestors is "authoritatively-absent", an
 * existing per-generation directory under still-authenticated ancestors
 * is "present" whatever it holds, and a level that cannot be
 * authenticated or that changed meanwhile is "unresolvable". No report is
 * read and no report identity is guessed: a caller that needs positive
 * absence of every report must treat "present" and "unresolvable" alike.
 */
export function probeMigrationActivationReportPresence(
  input: Readonly<{ homeDir: string; generationId: string }>,
  dependencies: Readonly<{ expectedUid?: number }> = {},
): MigrationActivationReportPresenceResult {
  if (!isRecord(input)) reportError("invalid-input", "migration activation report presence input is invalid");
  const homeDir = validateHomeDir(input.homeDir);
  const generationId = validateGenerationId(input.generationId);
  const expectedUid = dependencies.expectedUid ?? currentUid();
  const levels: readonly [string, string][] = [
    [rootPath(homeDir), "private LCM root"],
    [migrationActivationReportStoreDirectory(homeDir), "activation report store directory"],
    [migrationActivationReportDirectory(homeDir, generationId), "per-generation activation report directory"],
  ];
  const handles: Array<readonly [PrivateDirectoryHandle, string]> = [];
  const settled = (result: MigrationActivationReportPresenceResult): MigrationActivationReportPresenceResult => {
    try {
      for (const [handle, levelPath] of handles) assertPrivateDirectory(handle, levelPath, handle.witness, expectedUid);
    } catch (error) {
      return { state: "unresolvable", reason: "directory-changed", detail: "an activation report directory changed during the probe: " + (error as Error).message };
    }
    return result;
  };
  try {
    for (const [path, describe] of levels) {
      let handle: PrivateDirectoryHandle | undefined;
      try {
        handle = openPrivateDirectoryIfExists(path, { expectedUid });
      } catch (error) {
        return {
          state: "unresolvable",
          reason: handles.length === 0 ? "root-unauthenticated" : "directory-unauthenticated",
          detail: "cannot authenticate the " + describe + " " + path + ": " + (error as Error).message,
        };
      }
      if (handle === undefined) return settled({ state: "authoritatively-absent", detail: "the " + describe + " " + path + " does not exist" });
      handles.push([handle, path]);
    }
    return settled({ state: "present", detail: "the per-generation activation report directory " + levels[2]![0] + " exists" });
  } finally {
    for (const [handle] of handles) handle.close();
  }
}

