import { createHash } from "node:crypto";

export type MigrationPhase =
  | "planned"
  | "dry-run-verified"
  | "copying"
  | "copied"
  | "verified"
  | "activating"
  | "active"
  | "rolling-back"
  | "rolled-back"
  | "aborted";

export type MigrationEffectKind =
  | "verify-dry-run"
  | "copy-batch"
  | "complete-copy"
  | "verify-generation"
  | "prepare-activation"
  | "publish-activation"
  | "prepare-rollback"
  | "publish-rollback"
  | "abort";

export type MigrationStorageWitness = Readonly<{
  version: 1;
  backend: "sqlite" | "postgresql";
  identitySha256: string;
  schemaSha256: string;
  contentSha256: string;
  capturedAt: string;
}>;

export type MigrationCheckpoint = Readonly<{
  domain: string;
  ordinal: number;
  recordCount: number;
  sourceCheckpointSha256: string;
  destinationCommitSha256: string;
}>;

export type MigrationReportReference = Readonly<{
  kind: "dry-run" | "verification" | "activation" | "rollback" | "abort" | "abandonment";
  reportId: string;
  reportSha256: string;
  createdAt: string;
}>;

export type MigrationRollbackLineage = Readonly<{
  parentGenerationId: string | null;
  preservedSourceGenerationId: string;
  mode: "pre-write" | "post-write" | null;
  returnPhase: "verified" | "active" | null;
}>;

export type PendingMigrationEffect = Readonly<{
  effectId: string;
  kind: MigrationEffectKind;
  fromPhase: MigrationPhase;
  targetPhase: MigrationPhase;
  inputSha256: string;
  recovery: "retry-idempotent" | "authoritative-readback-required";
  startedAt: string;
}>;

export type MigrationManifest = Readonly<{
  version: 1;
  generationId: string;
  revision: number;
  phase: MigrationPhase;
  source: MigrationStorageWitness;
  destination: MigrationStorageWitness;
  checkpoints: readonly MigrationCheckpoint[];
  reports: readonly MigrationReportReference[];
  activationEligible: boolean;
  rollbackLineage: MigrationRollbackLineage;
  pendingEffect: PendingMigrationEffect | null;
  previousManifestSha256: string | null;
  createdAt: string;
  updatedAt: string;
  checksumSha256: string;
}>;

export type CreateMigrationManifestInput = Readonly<{
  generationId: string;
  source: MigrationStorageWitness;
  destination: MigrationStorageWitness;
  parentGenerationId: string | null;
  preservedSourceGenerationId: string;
  createdAt: string;
}>;

export type BeginMigrationEffectInput = Readonly<{
  effectId: string;
  kind: MigrationEffectKind;
  inputSha256: string;
  startedAt: string;
}>;

export type CompleteMigrationEffectInput = Readonly<{
  effectId: string;
  completedAt: string;
  checkpoint?: MigrationCheckpoint;
  report?: MigrationReportReference;
  activationEligible?: boolean;
  rollbackMode?: "pre-write" | "post-write";
}>;

export type AbandonMigrationEffectInput = Readonly<{
  effectId: string;
  abandonedAt: string;
  report: MigrationReportReference & Readonly<{ kind: "abandonment" }>;
}>;

export type MigrationManifestHead = Readonly<{
  version: 1;
  generationId: string;
  revision: number;
  revisionFilename: string;
  manifestSha256: string;
  updatedAt: string;
  checksumSha256: string;
}>;

export type MigrationProtocolReason =
  | "invalid-input"
  | "malformed-manifest"
  | "checksum-mismatch"
  | "recovery-required"
  | "unexpected-state";

export class MigrationProtocolError extends Error {
  constructor(
    readonly reason: MigrationProtocolReason,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "MigrationProtocolError";
  }
}

const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const PHASES: readonly MigrationPhase[] = [
  "planned", "dry-run-verified", "copying", "copied", "verified",
  "activating", "active", "rolling-back", "rolled-back", "aborted",
];
const EFFECTS: readonly MigrationEffectKind[] = [
  "verify-dry-run", "copy-batch", "complete-copy", "verify-generation",
  "prepare-activation", "publish-activation", "prepare-rollback",
  "publish-rollback", "abort",
];
const REPORT_KINDS: readonly MigrationReportReference["kind"][] = [
  "dry-run", "verification", "activation", "rollback", "abort", "abandonment",
];
const BACKENDS = ["sqlite", "postgresql"] as const;

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function protocolError(
  reason: MigrationProtocolReason,
  message: string,
  options?: ErrorOptions,
): never {
  throw new MigrationProtocolError(reason, message, options);
}

function exactKeys(value: RecordValue, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER_PATTERN.test(value);
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && HASH_PATTERN.test(value);
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !value.endsWith("Z")) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    if (Array.isArray(value)) {
      for (const item of value) deepFreeze(item);
    } else {
      for (const item of Object.values(value)) deepFreeze(item);
    }
  }
  return value;
}

function canonicalJson(value: unknown, seen: Set<object>): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("value is not canonical JSON");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError("value is not canonical JSON");
    seen.add(value);
    try {
      return `[${value.map((item) => canonicalJson(item, seen)).join(",")}]`;
    } finally {
      seen.delete(value);
    }
  }
  if (isRecord(value)) {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      throw new TypeError("value is not canonical JSON");
    }
    if (seen.has(value)) throw new TypeError("value is not canonical JSON");
    seen.add(value);
    try {
      return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key], seen)}`).join(",")}}`;
    } finally {
      seen.delete(value);
    }
  }
  throw new TypeError("value is not canonical JSON");
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function compareNumber(left: number, right: number): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function compareCheckpoints(left: MigrationCheckpoint, right: MigrationCheckpoint): number {
  return compareText(left.domain, right.domain) || compareNumber(left.ordinal, right.ordinal);
}

function compareReports(left: MigrationReportReference, right: MigrationReportReference): number {
  return compareText(left.kind, right.kind)
    || compareText(left.reportId, right.reportId)
    || compareText(left.createdAt, right.createdAt);
}

function sortCheckpoints(value: readonly MigrationCheckpoint[]): MigrationCheckpoint[] {
  return [...value].sort(compareCheckpoints);
}

function sortReports(value: readonly MigrationReportReference[]): MigrationReportReference[] {
  return [...value].sort(compareReports);
}

function normalizeManifestCollections(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const normalized = { ...value };
  if (Array.isArray(value.checkpoints) && value.checkpoints.every((item): item is MigrationCheckpoint => (
    isRecord(item) && typeof item.domain === "string" && typeof item.ordinal === "number"
  ))) {
    normalized.checkpoints = sortCheckpoints(value.checkpoints);
  }
  if (Array.isArray(value.reports) && value.reports.every((item): item is MigrationReportReference => (
    isRecord(item) && typeof item.kind === "string" && typeof item.reportId === "string" && typeof item.createdAt === "string"
  ))) {
    normalized.reports = sortReports(value.reports);
  }
  return normalized;
}

export function migrationManifestCanonicalSha256(value: unknown): string {
  return sha256(canonicalJson(normalizeManifestCollections(value), new Set()));
}

function assertExactObject(
  value: unknown,
  keys: readonly string[],
  label: string,
  reason: MigrationProtocolReason = "malformed-manifest",
): RecordValue {
  if (!isRecord(value) || !exactKeys(value, keys)) protocolError(reason, `${label} has an invalid shape`);
  return value;
}

function parseWitness(
  value: unknown,
  label: string,
  reason: MigrationProtocolReason = "malformed-manifest",
): MigrationStorageWitness {
  const witness = assertExactObject(value, ["backend", "capturedAt", "contentSha256", "identitySha256", "schemaSha256", "version"], label, reason);
  if (witness.version !== 1 || !BACKENDS.includes(witness.backend as MigrationStorageWitness["backend"])
    || !isHash(witness.identitySha256) || !isHash(witness.schemaSha256) || !isHash(witness.contentSha256)
    || !isIsoTimestamp(witness.capturedAt)) {
    protocolError(reason, `${label} is invalid`);
  }
  return {
    version: 1,
    backend: witness.backend as MigrationStorageWitness["backend"],
    identitySha256: witness.identitySha256 as string,
    schemaSha256: witness.schemaSha256 as string,
    contentSha256: witness.contentSha256 as string,
    capturedAt: witness.capturedAt as string,
  };
}

function parseCheckpoint(
  value: unknown,
  reason: MigrationProtocolReason = "malformed-manifest",
): MigrationCheckpoint {
  const checkpoint = assertExactObject(value, ["destinationCommitSha256", "domain", "ordinal", "recordCount", "sourceCheckpointSha256"], "checkpoint", reason);
  if (!isIdentifier(checkpoint.domain) || !isSafeNonNegativeInteger(checkpoint.ordinal)
    || !isSafeNonNegativeInteger(checkpoint.recordCount) || !isHash(checkpoint.sourceCheckpointSha256)
    || !isHash(checkpoint.destinationCommitSha256)) protocolError(reason, "checkpoint is invalid");
  return {
    domain: checkpoint.domain,
    ordinal: checkpoint.ordinal,
    recordCount: checkpoint.recordCount,
    sourceCheckpointSha256: checkpoint.sourceCheckpointSha256,
    destinationCommitSha256: checkpoint.destinationCommitSha256,
  };
}

function parseReport(
  value: unknown,
  reason: MigrationProtocolReason = "malformed-manifest",
): MigrationReportReference {
  const report = assertExactObject(value, ["createdAt", "kind", "reportId", "reportSha256"], "report", reason);
  if (!REPORT_KINDS.includes(report.kind as MigrationReportReference["kind"])
    || !isIdentifier(report.reportId) || !isHash(report.reportSha256) || !isIsoTimestamp(report.createdAt)) {
    protocolError(reason, "report is invalid");
  }
  return {
    kind: report.kind as MigrationReportReference["kind"],
    reportId: report.reportId,
    reportSha256: report.reportSha256,
    createdAt: report.createdAt,
  };
}

function parseRollbackLineage(value: unknown): MigrationRollbackLineage {
  const lineage = assertExactObject(value, ["mode", "parentGenerationId", "preservedSourceGenerationId", "returnPhase"], "rollbackLineage");
  if ((lineage.parentGenerationId !== null && !isIdentifier(lineage.parentGenerationId))
    || !isIdentifier(lineage.preservedSourceGenerationId)
    || (lineage.mode !== null && lineage.mode !== "pre-write" && lineage.mode !== "post-write")
    || (lineage.returnPhase !== null && lineage.returnPhase !== "verified" && lineage.returnPhase !== "active")) {
    protocolError("malformed-manifest", "rollbackLineage is invalid");
  }
  return {
    parentGenerationId: lineage.parentGenerationId as string | null,
    preservedSourceGenerationId: lineage.preservedSourceGenerationId,
    mode: lineage.mode as MigrationRollbackLineage["mode"],
    returnPhase: lineage.returnPhase as MigrationRollbackLineage["returnPhase"],
  };
}

function parsePendingEffect(value: unknown): PendingMigrationEffect | null {
  if (value === null) return null;
  const effect = assertExactObject(value, ["effectId", "fromPhase", "inputSha256", "kind", "recovery", "startedAt", "targetPhase"], "pendingEffect");
  if (!isIdentifier(effect.effectId) || !EFFECTS.includes(effect.kind as MigrationEffectKind)
    || !PHASES.includes(effect.fromPhase as MigrationPhase) || !PHASES.includes(effect.targetPhase as MigrationPhase)
    || !isHash(effect.inputSha256) || (effect.recovery !== "retry-idempotent" && effect.recovery !== "authoritative-readback-required")
    || !isIsoTimestamp(effect.startedAt)) protocolError("malformed-manifest", "pendingEffect is invalid");
  return {
    effectId: effect.effectId,
    kind: effect.kind as MigrationEffectKind,
    fromPhase: effect.fromPhase as MigrationPhase,
    targetPhase: effect.targetPhase as MigrationPhase,
    inputSha256: effect.inputSha256,
    recovery: effect.recovery as PendingMigrationEffect["recovery"],
    startedAt: effect.startedAt,
  };
}

function assertUniqueCollections(
  checkpoints: readonly MigrationCheckpoint[],
  reports: readonly MigrationReportReference[],
): void {
  const domains = new Set<string>();
  for (const checkpoint of checkpoints) {
    if (domains.has(checkpoint.domain)) protocolError("malformed-manifest", "checkpoints must be unique");
    domains.add(checkpoint.domain);
  }
  const reportIds = new Set<string>();
  for (const report of reports) {
    if (reportIds.has(report.reportId)) protocolError("malformed-manifest", "reports must be unique");
    reportIds.add(report.reportId);
  }
}

function assertCrossFieldInvariants(manifest: Omit<MigrationManifest, "checksumSha256">): void {
  if ((manifest.revision === 0) !== (manifest.previousManifestSha256 === null)) protocolError("malformed-manifest", "revision predecessor is invalid");
  if (manifest.phase === "rolled-back" || manifest.phase === "aborted") {
    if (manifest.pendingEffect !== null) protocolError("malformed-manifest", "terminal phase cannot have a pending effect");
  }
  if (manifest.pendingEffect !== null) {
    if (manifest.pendingEffect.fromPhase !== manifest.phase) protocolError("malformed-manifest", "pending effect phase is invalid");
    const legal = legalEffect(manifest.phase, manifest.pendingEffect.kind);
    if (legal === null || legal.targetPhase !== manifest.pendingEffect.targetPhase
      || legal.recovery !== manifest.pendingEffect.recovery) protocolError("malformed-manifest", "pending effect transition is invalid");
  }
  const verificationReport = manifest.reports.some((report) => report.kind === "verification");
  const eligiblePhase = manifest.phase === "verified" || manifest.phase === "activating" || manifest.phase === "active"
    || manifest.phase === "rolling-back" || manifest.phase === "rolled-back";
  if (manifest.activationEligible !== (eligiblePhase && verificationReport)) protocolError("malformed-manifest", "activation eligibility is invalid");
  const rollbackPhase = manifest.phase === "rolling-back" || manifest.phase === "rolled-back";
  if (manifest.rollbackLineage.returnPhase !== null && !rollbackPhase) protocolError("malformed-manifest", "rollback return phase is invalid");
  if (manifest.rollbackLineage.mode !== null && manifest.phase !== "rolled-back") protocolError("malformed-manifest", "rollback mode is invalid");
  if (manifest.phase === "rolled-back") {
    if (manifest.rollbackLineage.mode === null) protocolError("malformed-manifest", "rolled-back phase requires rollback mode");
    if (manifest.rollbackLineage.returnPhase === null) protocolError("malformed-manifest", "rolled-back phase requires a sealed return phase");
  }
}

type LegalEffect = Readonly<{
  targetPhase: MigrationPhase;
  recovery: PendingMigrationEffect["recovery"];
}>;

function legalEffect(phase: MigrationPhase, effect: MigrationEffectKind): LegalEffect | null {
  if (phase === "planned" && effect === "verify-dry-run") return { targetPhase: "dry-run-verified", recovery: "retry-idempotent" };
  if ((phase === "dry-run-verified" || phase === "copying") && effect === "copy-batch") return { targetPhase: "copying", recovery: "authoritative-readback-required" };
  if (phase === "copying" && effect === "complete-copy") return { targetPhase: "copied", recovery: "authoritative-readback-required" };
  if (phase === "copied" && effect === "verify-generation") return { targetPhase: "verified", recovery: "retry-idempotent" };
  if (phase === "verified" && effect === "prepare-activation") return { targetPhase: "activating", recovery: "retry-idempotent" };
  if (phase === "activating" && effect === "publish-activation") return { targetPhase: "active", recovery: "authoritative-readback-required" };
  if ((phase === "verified" || phase === "active") && effect === "prepare-rollback") return { targetPhase: "rolling-back", recovery: "retry-idempotent" };
  if (phase === "rolling-back" && effect === "publish-rollback") return { targetPhase: "rolled-back", recovery: "authoritative-readback-required" };
  if ((phase === "planned" || phase === "dry-run-verified" || phase === "copying" || phase === "copied" || phase === "verified") && effect === "abort") return { targetPhase: "aborted", recovery: "retry-idempotent" };
  return null;
}

export function parseMigrationManifest(value: unknown): MigrationManifest {
  let parsed: unknown = value;
  if (typeof value === "string") {
    if (/[^\x00-\x7F]/u.test(value)) protocolError("malformed-manifest", "manifest must be ASCII");
    try {
      parsed = JSON.parse(value) as unknown;
    } catch (error) {
      protocolError("malformed-manifest", "manifest is not valid JSON", { cause: error });
    }
  }
  if (!isRecord(parsed)) protocolError("malformed-manifest", "manifest must be an object");
  const valueRecord = parsed;
  const manifest = assertExactObject(valueRecord, [
    "activationEligible", "checkpoints", "checksumSha256", "createdAt", "destination", "generationId",
    "pendingEffect", "phase", "previousManifestSha256", "reports", "revision", "rollbackLineage", "source",
    "updatedAt", "version",
  ], "manifest");
  if (manifest.version !== 1 || !isIdentifier(manifest.generationId) || !isSafeNonNegativeInteger(manifest.revision)
    || !PHASES.includes(manifest.phase as MigrationPhase) || !Array.isArray(manifest.checkpoints)
    || !Array.isArray(manifest.reports) || typeof manifest.activationEligible !== "boolean"
    || (manifest.previousManifestSha256 !== null && !isHash(manifest.previousManifestSha256))
    || !isIsoTimestamp(manifest.createdAt) || !isIsoTimestamp(manifest.updatedAt) || !isHash(manifest.checksumSha256)) {
    protocolError("malformed-manifest", "manifest is invalid");
  }
  const source = parseWitness(manifest.source, "source");
  const destination = parseWitness(manifest.destination, "destination");
  const checkpoints = sortCheckpoints(manifest.checkpoints.map((checkpoint) => parseCheckpoint(checkpoint)));
  const reports = sortReports(manifest.reports.map((report) => parseReport(report)));
  const rollbackLineage = parseRollbackLineage(manifest.rollbackLineage);
  const pendingEffect = parsePendingEffect(manifest.pendingEffect);
  assertUniqueCollections(checkpoints, reports);
  const payload = {
    version: 1 as const,
    generationId: manifest.generationId,
    revision: manifest.revision,
    phase: manifest.phase as MigrationPhase,
    source,
    destination,
    checkpoints,
    reports,
    activationEligible: manifest.activationEligible,
    rollbackLineage,
    pendingEffect,
    previousManifestSha256: manifest.previousManifestSha256 as string | null,
    createdAt: manifest.createdAt,
    updatedAt: manifest.updatedAt,
  };
  assertCrossFieldInvariants(payload);
  if (migrationManifestCanonicalSha256(payload) !== manifest.checksumSha256) protocolError("checksum-mismatch", "manifest checksum does not match");
  return deepFreeze({ ...payload, checksumSha256: manifest.checksumSha256 });
}

export function createMigrationManifest(input: CreateMigrationManifestInput): MigrationManifest {
  if (!isRecord(input) || !exactKeys(input, ["createdAt", "destination", "generationId", "parentGenerationId", "preservedSourceGenerationId", "source"])) {
    protocolError("invalid-input", "manifest creation input has an invalid shape");
  }
  if (!isIdentifier(input.generationId) || (input.parentGenerationId !== null && !isIdentifier(input.parentGenerationId))
    || !isIdentifier(input.preservedSourceGenerationId) || !isIsoTimestamp(input.createdAt)) {
    protocolError("invalid-input", "manifest creation input is invalid");
  }
  const source = parseWitness(input.source, "source", "invalid-input");
  const destination = parseWitness(input.destination, "destination", "invalid-input");
  const payload = {
    version: 1 as const,
    generationId: input.generationId,
    revision: 0,
    phase: "planned" as const,
    source,
    destination,
    checkpoints: [] as MigrationCheckpoint[],
    reports: [] as MigrationReportReference[],
    activationEligible: false,
    rollbackLineage: {
      parentGenerationId: input.parentGenerationId,
      preservedSourceGenerationId: input.preservedSourceGenerationId,
      mode: null,
      returnPhase: null,
    } satisfies MigrationRollbackLineage,
    pendingEffect: null,
    previousManifestSha256: null,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  } satisfies Omit<MigrationManifest, "checksumSha256">;
  assertCrossFieldInvariants(payload);
  return deepFreeze({ ...payload, checksumSha256: migrationManifestCanonicalSha256(payload) });
}

export function beginMigrationEffect(
  manifest: MigrationManifest,
  input: BeginMigrationEffectInput,
): MigrationManifest {
  const current = parseMigrationManifest(manifest);
  if (!isRecord(input) || !exactKeys(input, ["effectId", "inputSha256", "kind", "startedAt"])) {
    protocolError("invalid-input", "migration effect input has an invalid shape");
  }
  if (!isIdentifier(input.effectId) || !EFFECTS.includes(input.kind)
    || !isHash(input.inputSha256) || !isIsoTimestamp(input.startedAt)) {
    protocolError("invalid-input", "migration effect input is invalid");
  }
  if (current.pendingEffect !== null) {
    protocolError("unexpected-state", "migration already has a pending effect");
  }
  const legal = legalEffect(current.phase, input.kind);
  if (legal === null) {
    protocolError("unexpected-state", "migration effect is not legal in the current phase");
  }
  if (current.revision === Number.MAX_SAFE_INTEGER) {
    protocolError("unexpected-state", "migration manifest revision is exhausted");
  }
  if (Date.parse(input.startedAt) < Date.parse(current.updatedAt)) {
    protocolError("unexpected-state", "migration effect timestamp regressed");
  }
  return sealMigrationSuccessor(current, input.startedAt, {
    pendingEffect: {
      effectId: input.effectId,
      kind: input.kind,
      fromPhase: current.phase,
      targetPhase: legal.targetPhase,
      inputSha256: input.inputSha256,
      recovery: legal.recovery,
      startedAt: input.startedAt,
    },
  });
}

type MigrationSuccessorOverrides = Partial<Pick<
  Omit<MigrationManifest, "checksumSha256">,
  "activationEligible" | "checkpoints" | "pendingEffect" | "phase" | "reports" | "rollbackLineage"
>>;

function sealMigrationSuccessor(
  current: MigrationManifest,
  updatedAt: string,
  overrides: MigrationSuccessorOverrides,
): MigrationManifest {
  const payload = {
    ...unsignedMigrationManifest(current),
    revision: current.revision + 1,
    ...overrides,
    previousManifestSha256: current.checksumSha256,
    updatedAt,
  } satisfies Omit<MigrationManifest, "checksumSha256">;
  assertCrossFieldInvariants(payload);
  return deepFreeze({ ...payload, checksumSha256: migrationManifestCanonicalSha256(payload) });
}

function unsignedMigrationManifest(
  manifest: MigrationManifest,
): Omit<MigrationManifest, "checksumSha256"> {
  const { checksumSha256: _checksumSha256, ...payload } = manifest;
  return payload;
}

function hasOnlyKeys(value: RecordValue, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function assertCompletionEvidence(
  pending: PendingMigrationEffect,
  input: CompleteMigrationEffectInput,
): Readonly<{
  checkpoint?: MigrationCheckpoint;
  report?: MigrationReportReference;
}> {
  const checkpointValue = input.checkpoint === undefined
    ? undefined
    : parseCheckpoint(input.checkpoint, "invalid-input");
  const reportValue = input.report === undefined
    ? undefined
    : parseReport(input.report, "invalid-input");
  const noCheckpoint = checkpointValue === undefined;
  const noReport = reportValue === undefined;
  const noEligibility = input.activationEligible === undefined;
  const noRollbackMode = input.rollbackMode === undefined;
  const exactReport = (kind: MigrationReportReference["kind"]): boolean => (
    noCheckpoint && reportValue?.kind === kind && noEligibility && noRollbackMode
  );
  let valid = false;
  switch (pending.kind) {
    case "verify-dry-run":
      valid = exactReport("dry-run");
      break;
    case "copy-batch":
      valid = checkpointValue !== undefined && noReport && noEligibility && noRollbackMode;
      break;
    case "complete-copy":
    case "prepare-activation":
    case "prepare-rollback":
      valid = noCheckpoint && noReport && noEligibility && noRollbackMode;
      break;
    case "verify-generation":
      valid = noCheckpoint && reportValue?.kind === "verification"
        && input.activationEligible === true && noRollbackMode;
      break;
    case "publish-activation":
      valid = exactReport("activation");
      break;
    case "publish-rollback":
      valid = noCheckpoint && reportValue?.kind === "rollback" && noEligibility
        && (input.rollbackMode === "pre-write" || input.rollbackMode === "post-write");
      break;
    case "abort":
      valid = exactReport("abort");
      break;
  }
  if (!valid) protocolError("invalid-input", "migration completion evidence is invalid");
  return { checkpoint: checkpointValue, report: reportValue };
}

function nextCheckpoints(
  current: readonly MigrationCheckpoint[],
  checkpointValue: MigrationCheckpoint | undefined,
): readonly MigrationCheckpoint[] {
  if (checkpointValue === undefined) return current;
  const existing = current.find((checkpoint) => checkpoint.domain === checkpointValue.domain);
  if (existing !== undefined
    && (checkpointValue.ordinal <= existing.ordinal || checkpointValue.recordCount < existing.recordCount)) {
    protocolError("unexpected-state", "migration checkpoint regressed");
  }
  return sortCheckpoints([
    ...current.filter((checkpoint) => checkpoint.domain !== checkpointValue.domain),
    checkpointValue,
  ]);
}

function nextReports(
  current: readonly MigrationReportReference[],
  reportValue: MigrationReportReference | undefined,
): readonly MigrationReportReference[] {
  if (reportValue === undefined) return current;
  if (current.some((report) => report.reportId === reportValue.reportId)) {
    protocolError("unexpected-state", "migration report identity already exists");
  }
  return sortReports([...current, reportValue]);
}

export function completeMigrationEffect(
  manifest: MigrationManifest,
  input: CompleteMigrationEffectInput,
): MigrationManifest {
  const current = parseMigrationManifest(manifest);
  if (!isRecord(input)
    || !hasOnlyKeys(input, ["activationEligible", "checkpoint", "completedAt", "effectId", "report", "rollbackMode"])
    || !Object.hasOwn(input, "effectId") || !Object.hasOwn(input, "completedAt")) {
    protocolError("invalid-input", "migration completion input has an invalid shape");
  }
  if (!isIdentifier(input.effectId) || !isIsoTimestamp(input.completedAt)
    || (input.activationEligible !== undefined && typeof input.activationEligible !== "boolean")
    || (input.rollbackMode !== undefined && input.rollbackMode !== "pre-write" && input.rollbackMode !== "post-write")) {
    protocolError("invalid-input", "migration completion input is invalid");
  }
  const pending = current.pendingEffect;
  if (pending === null || pending.effectId !== input.effectId) {
    protocolError("unexpected-state", "migration completion does not match the pending effect");
  }
  if (current.revision === Number.MAX_SAFE_INTEGER) {
    protocolError("unexpected-state", "migration manifest revision is exhausted");
  }
  if (Date.parse(input.completedAt) < Date.parse(current.updatedAt)) {
    protocolError("unexpected-state", "migration completion timestamp regressed");
  }
  const evidence = assertCompletionEvidence(pending, input);
  if (evidence.report !== undefined
    && (Date.parse(evidence.report.createdAt) < Date.parse(pending.startedAt)
      || Date.parse(evidence.report.createdAt) > Date.parse(input.completedAt))) {
    protocolError("invalid-input", "migration report timestamp is outside the effect boundary");
  }
  const rollbackLineage = pending.kind === "prepare-rollback"
    ? { ...current.rollbackLineage, returnPhase: pending.fromPhase as "verified" | "active" }
    : pending.kind === "publish-rollback"
      ? { ...current.rollbackLineage, mode: input.rollbackMode! }
      : current.rollbackLineage;
  return sealMigrationSuccessor(current, input.completedAt, {
    phase: pending.targetPhase,
    checkpoints: nextCheckpoints(current.checkpoints, evidence.checkpoint),
    reports: nextReports(current.reports, evidence.report),
    activationEligible: pending.kind === "verify-generation"
      ? true
      : pending.kind === "abort"
        ? false
        : current.activationEligible,
    rollbackLineage,
    pendingEffect: null,
  });
}
