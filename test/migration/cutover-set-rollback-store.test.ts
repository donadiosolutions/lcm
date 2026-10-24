import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BACKEND_PUBLICATION_MAX_JOURNAL_BYTES,
  backendCutoverSetJournalCapacity,
  backendCutoverSetManifestSha256,
  backendCutoverSetRollbackSelectionWorstCase,
  backendCutoverSetRollbackSelectionSha256,
  parseBackendCutoverSetRollbackSelection,
  type BackendCutoverSetManifest,
  type BackendCutoverSetRollbackSelection,
} from "../../src/storage/backend-publication.js";
import { canonicalJson } from "../../src/storage/portable-record.js";
import { recordActivationGenerationLink } from "../../src/migration/activation-artifact-store.js";
import { deriveActivationPublicationId } from "../../src/migration/activation-publication-id.js";
import { cutoverSetMaintenanceEntry } from "../../src/migration/cutover-set.js";
import {
  CutoverSetRollbackRecordError,
  MAX_CUTOVER_SET_ROLLBACK_INSTALL_RECORD_BYTES,
  MAX_CUTOVER_SET_ROLLBACK_MEMBER_RECORD_BYTES,
  MAX_CUTOVER_SET_ROLLBACK_RECORD_BYTES,
  assertCutoverSetRollbackSelectionDescendsFromRecords,
  createCutoverSetRollbackCheckpoint,
  createCutoverSetRollbackInstallRecord,
  cutoverSetRollbackCheckpointAggregate,
  cutoverSetRollbackCheckpointMemberRecord,
  cutoverSetRollbackCheckpointMemberRecordSha256,
  cutoverSetRollbackCheckpointSha256,
  cutoverSetRollbackInstallRecordSha256,
  cutoverSetRollbackRecordCapacity,
  deriveCutoverSetRollbackSetId,
  migrationCutoverSetRollbackDirectory,
  parseCutoverSetRollbackCheckpoint,
  parseCutoverSetRollbackInstallRecord,
  readCutoverSetRollbackRecords,
  recordCutoverSetRollbackCheckpoint,
  recordCutoverSetRollbackInstall,
  recordCutoverSetRollbackSelection,
  resolveCutoverSetRollbackCommitment,
  type CreateCutoverSetRollbackCheckpointInput,
  type CreateCutoverSetRollbackInstallRecordInput,
  type CutoverSetRollbackCheckpoint,
  type CutoverSetRollbackInstallRecord,
} from "../../src/migration/cutover-set-rollback-store.js";
import { SET_ID, setManifest, sourceHash } from "../fixtures/cutover-set.js";

const HEX = (value: string) => value.repeat(64);
const REMOTES = ["018f22c4-6d2a-7f10-8a4c-6b8d3e5f9001", "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9002", "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9003"];
const ROLLBACK_SET_ID = deriveCutoverSetRollbackSetId(SET_ID);
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function home(): string {
  const value = mkdtempSync(join(tmpdir(), "lcm-cutover-set-rollback-store-"));
  mkdirSync(join(value, ".lcm"), { mode: 0o700 });
  roots.push(value);
  return value;
}

/** The rollback hold manifest: the original members under the derived rollback set id. */
function rollbackManifest(count = 2, originalSetId = SET_ID): BackendCutoverSetManifest {
  return { ...setManifest(count, originalSetId), setId: deriveCutoverSetRollbackSetId(originalSetId) };
}

function checkpointBody(manifest: BackendCutoverSetManifest, edit: (body: Record<string, any>) => void = () => undefined, originalSetId = SET_ID): CreateCutoverSetRollbackCheckpointInput {
  const body: Record<string, any> = {
    originalSetId,
    setId: manifest.setId,
    manifest,
    publicationId: manifest.setId,
    originalCheckpointSha256: HEX("1"),
    originalSelectionSha256: HEX("2"),
    activationIdentityDigest: HEX("3"),
    activationJournalChecksumSha256: HEX("4"),
    operabilityFactValueSha256: HEX("5"),
    identityDigest: HEX("d"),
    members: manifest.members.map((member, index) => ({
      physicalProjectId: member.physicalProjectId,
      generationId: member.generationId,
      remoteProjectId: REMOTES[index]!,
      heldMemberChecksumSha256: HEX("6"),
      snapshotChecksumSha256: HEX("7"),
      sourceSelectionSha256: member.sourceSelectionSha256,
      queueEvidenceSha256: HEX("8"),
      queueCutoff: index === 0 ? null : "000000000000000000" + String(index),
      sourceByteWitnessSha256: HEX("9"),
      epochId: HEX("e"),
      attemptId: HEX("a"),
      activationWitnessChecksumSha256: HEX("c"),
      manifestRevision: 12,
      manifestChecksumSha256: HEX("b"),
      evidenceSha256: HEX(String(index + 1)),
    })),
  };
  edit(body);
  return body as CreateCutoverSetRollbackCheckpointInput;
}

function installBody(checkpoint: CutoverSetRollbackCheckpoint, index: number, edit: (body: Record<string, any>) => void = () => undefined): CreateCutoverSetRollbackInstallRecordInput {
  const member = checkpoint.members[index]!;
  const body: Record<string, any> = {
    originalSetId: checkpoint.originalSetId,
    setId: checkpoint.setId,
    generationId: member.generationId,
    installedGenerationId: member.generationId + "-rb12-1",
    mode: index === 0 ? "pre-write" : "post-write",
    buildWitnessChecksumSha256: HEX("1"),
    buildManifestSha256: HEX("2"),
    buildContentSha256: HEX("3"),
    exportEvidenceSha256: index === 0 ? null : HEX("4"),
    canonicalPath: "/home/.lcm/projects/" + member.physicalProjectId + "/db.sqlite",
    database: { sha256: HEX("5"), size: "4096" },
    preemption: index === 0 ? null : { path: "/home/.lcm/projects/x/db.sqlite.preempted", beforeSha256: HEX("6"), afterSha256: HEX("6") },
    sidecars: { sessionInstructionsMaterialized: 0, passiveEventsMaterialized: 2, passiveEventsPreservedPending: 1, reconciledUpTo: index === 0 ? null : "17" },
  };
  edit(body);
  return body as CreateCutoverSetRollbackInstallRecordInput;
}

function selectionFor(
  checkpoint: CutoverSetRollbackCheckpoint,
  installs: readonly CutoverSetRollbackInstallRecord[],
  edit: (body: Record<string, any>) => void = () => undefined,
): BackendCutoverSetRollbackSelection {
  const body: Record<string, any> = {
    version: 1,
    kind: "cutover-set-rollback-selection",
    setId: checkpoint.setId,
    manifestSha256: backendCutoverSetManifestSha256(checkpoint.manifest),
    publicationId: checkpoint.publicationId,
    originalSetId: checkpoint.originalSetId,
    originalSelectionSha256: checkpoint.originalSelectionSha256,
    checkpointSha256: checkpoint.checksumSha256,
    identityDigest: checkpoint.identityDigest,
    sourceBackend: "postgresql",
    targetBackend: "sqlite",
    members: checkpoint.members.map((member, index) => ({
      physicalProjectId: member.physicalProjectId,
      generationId: member.generationId,
      remoteProjectId: member.remoteProjectId,
      mode: installs[index]!.mode,
      epochId: member.epochId,
      attemptId: member.attemptId,
      witnessChecksumSha256: HEX(String(index + 3)),
      installEvidenceSha256: installs[index]!.checksumSha256,
    })),
  };
  edit(body);
  return { ...(body as Omit<BackendCutoverSetRollbackSelection, "checksumSha256">), checksumSha256: backendCutoverSetRollbackSelectionSha256(body as never) };
}

function recordFiles(homeDir: string): string[] {
  return readdirSync(migrationCutoverSetRollbackDirectory(homeDir, SET_ID)).sort();
}

function stored(homeDir: string, count = 2) {
  const checkpoint = createCutoverSetRollbackCheckpoint(checkpointBody(rollbackManifest(count)));
  recordCutoverSetRollbackCheckpoint({ homeDir, checkpoint });
  const installs = checkpoint.members.map((_, index) => createCutoverSetRollbackInstallRecord(installBody(checkpoint, index)));
  for (const record of installs) recordCutoverSetRollbackInstall({ homeDir, record });
  const selection = selectionFor(checkpoint, installs);
  recordCutoverSetRollbackSelection({ homeDir, selection });
  return { checkpoint, installs, selection, directory: migrationCutoverSetRollbackDirectory(homeDir, SET_ID) };
}

const envelope = (originalSetId: string, record: unknown) => canonicalJson({ version: 1, originalSetId, record }) + "\n";
const CHECKPOINT_FILES = ["checkpoint.json", "member-000000.json", "member-000001.json"];

function manyMembers(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    physicalProjectId: (index + 1).toString(16).padStart(64, "0"),
    generationId: "member-generation-" + String(index + 1),
    sourceSelectionSha256: sourceHash(index + 1),
  }));
}

/** The widest checkpoint the parser admits for a manifest: every hash full-width, distinct widest UUIDs, the widest cutoff and revision. */
function widestCheckpoint(manifest: BackendCutoverSetManifest, originalSetId: string): CutoverSetRollbackCheckpoint {
  return createCutoverSetRollbackCheckpoint(checkpointBody(manifest, (b) => {
    b.members = manifest.members.map((member, index) => ({
      ...b.members[0], physicalProjectId: member.physicalProjectId, generationId: member.generationId, sourceSelectionSha256: member.sourceSelectionSha256,
      remoteProjectId: "ffffffff-ffff-7fff-bfff-" + index.toString(16).padStart(12, "0"), queueCutoff: "9223372036854775807", manifestRevision: Number.MAX_SAFE_INTEGER,
    }));
  }, originalSetId));
}

describe("deriveCutoverSetRollbackSetId", () => {
  it("is a 64-hex digest distinct from the original set id and stable", () => {
    expect(ROLLBACK_SET_ID).toMatch(/^[0-9a-f]{64}$/u);
    expect(deriveCutoverSetRollbackSetId(SET_ID)).toBe(ROLLBACK_SET_ID);
    expect(deriveCutoverSetRollbackSetId("cutover-set-2")).not.toBe(ROLLBACK_SET_ID);
  });
});

describe("cutover-set rollback checkpoint", () => {
  it("records once, reuses identical bytes, refuses different bytes and reads back resolved", () => {
    const homeDir = home();
    const checkpoint = createCutoverSetRollbackCheckpoint(checkpointBody(rollbackManifest(2)));
    expect(checkpoint.checksumSha256).toBe(cutoverSetRollbackCheckpointSha256(checkpoint));
    recordCutoverSetRollbackCheckpoint({ homeDir, checkpoint });
    expect(recordFiles(homeDir)).toEqual(CHECKPOINT_FILES);
    expect(statSync(join(migrationCutoverSetRollbackDirectory(homeDir, SET_ID), "checkpoint.json")).mode & 0o777).toBe(0o600);
    expect(statSync(join(migrationCutoverSetRollbackDirectory(homeDir, SET_ID), "member-000000.json")).mode & 0o777).toBe(0o600);
    recordCutoverSetRollbackCheckpoint({ homeDir, checkpoint });
    expect(readCutoverSetRollbackRecords({ homeDir, originalSetId: SET_ID })).toEqual({ state: "resolved", checkpoint, installs: new Map(), selection: null });
    // The stored aggregate references each member record by its digest; the member record restates the row under its index.
    const directory = migrationCutoverSetRollbackDirectory(homeDir, SET_ID);
    const aggregate = cutoverSetRollbackCheckpointAggregate(checkpoint);
    expect(readFileSync(join(directory, "checkpoint.json"), "utf8")).toBe(envelope(SET_ID, aggregate));
    expect(aggregate.members).toEqual(checkpoint.members.map((_, index) => cutoverSetRollbackCheckpointMemberRecord(checkpoint, index).checksumSha256));
    const record = cutoverSetRollbackCheckpointMemberRecord(checkpoint, 1);
    expect(readFileSync(join(directory, "member-000001.json"), "utf8")).toBe(envelope(SET_ID, record));
    expect(record).toMatchObject({ version: 1, kind: "cutover-set-rollback-checkpoint-member", originalSetId: SET_ID, setId: ROLLBACK_SET_ID, index: 1, member: checkpoint.members[1] });
    expect(record.checksumSha256).toBe(cutoverSetRollbackCheckpointMemberRecordSha256(record));
    expect(() => cutoverSetRollbackCheckpointMemberRecord(checkpoint, 2)).toThrow(/no member at index 2/u);
    const other = createCutoverSetRollbackCheckpoint(checkpointBody(rollbackManifest(2), (b) => { b.identityDigest = HEX("f"); }));
    expect(() => recordCutoverSetRollbackCheckpoint({ homeDir, checkpoint: other })).toThrow(expect.objectContaining({ name: "MigrationBindingConflictError" }));
    expect(readCutoverSetRollbackRecords({ homeDir, originalSetId: "cutover-set-2" })).toEqual({ state: "authoritatively-absent" });
    expect(readCutoverSetRollbackRecords({ homeDir: home(), originalSetId: SET_ID })).toEqual({ state: "authoritatively-absent" });
  });

  it("refuses a record whose checksum was not re-derived, and an oversized one, before any write", () => {
    const homeDir = home();
    const checkpoint = createCutoverSetRollbackCheckpoint(checkpointBody(rollbackManifest(2)));
    expect(() => recordCutoverSetRollbackCheckpoint({ homeDir, checkpoint: { ...checkpoint, identityDigest: HEX("f") } }))
      .toThrow(expect.objectContaining({ name: "CutoverSetRollbackRecordError", reason: "invalid-input", message: expect.stringContaining("checksum") }));
    const manifest = { ...rollbackManifest(2), members: manyMembers(6000) };
    const large = widestCheckpoint(manifest, SET_ID);
    expect(canonicalJson(cutoverSetRollbackCheckpointAggregate(large)).length).toBeGreaterThan(MAX_CUTOVER_SET_ROLLBACK_RECORD_BYTES);
    expect(cutoverSetRollbackRecordCapacity({ originalSetId: SET_ID, manifest }).checkpointBytes).toBeGreaterThan(MAX_CUTOVER_SET_ROLLBACK_RECORD_BYTES);
    expect(() => recordCutoverSetRollbackCheckpoint({ homeDir, checkpoint: large })).toThrow(expect.objectContaining({ reason: "invalid-input", message: expect.stringContaining("exceeds") }));
    expect(readCutoverSetRollbackRecords({ homeDir, originalSetId: SET_ID })).toEqual({ state: "authoritatively-absent" });
    expect(MAX_CUTOVER_SET_ROLLBACK_RECORD_BYTES).toBe(BACKEND_PUBLICATION_MAX_JOURNAL_BYTES);
  });

  it("represents every membership the activation budget admits, up to and including the largest one (C2)", () => {
    const originalSetId = "s".repeat(128);
    const admitted = (size: number, members: typeof manyMembers) =>
      backendCutoverSetJournalCapacity(cutoverSetMaintenanceEntry({ ...setManifest(2, originalSetId), members: members(size) }).cutoverSet).worstCaseBytes <= BACKEND_PUBLICATION_MAX_JOURNAL_BYTES;
    /** The largest membership the activation budget admits for these member identifiers; the next one is refused. */
    const boundary = (members: typeof manyMembers, high: number) => {
      let low = 2;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (admitted(mid, members)) low = mid; else high = mid - 1;
      }
      expect(admitted(low + 1, members)).toBe(false);
      return low;
    };
    const low = boundary(manyMembers, 3000);
    const manifest = { ...setManifest(2, deriveCutoverSetRollbackSetId(originalSetId)), members: manyMembers(low) };
    const capacity = cutoverSetRollbackRecordCapacity({ originalSetId, manifest });
    expect(capacity.limitBytes).toBe(MAX_CUTOVER_SET_ROLLBACK_RECORD_BYTES);
    expect(capacity.memberLimitBytes).toBe(MAX_CUTOVER_SET_ROLLBACK_MEMBER_RECORD_BYTES);
    expect(capacity.checkpointBytes).toBeLessThanOrEqual(capacity.limitBytes);
    expect(capacity.selectionBytes).toBeLessThanOrEqual(capacity.limitBytes);
    expect(capacity.memberRecordBytes).toBeLessThanOrEqual(capacity.memberLimitBytes);
    // The widest member generation ids the manifest parser admits (128 characters) lower the activation boundary; every record still fits at it.
    const wideMembers = (count: number) => manyMembers(count).map((member) => ({ ...member, generationId: member.generationId.padEnd(128, "g") }));
    const wide = cutoverSetRollbackRecordCapacity({ originalSetId, manifest: { ...manifest, members: wideMembers(boundary(wideMembers, low)) } });
    expect(wide.checkpointBytes).toBeLessThanOrEqual(wide.limitBytes);
    expect(wide.selectionBytes).toBeLessThanOrEqual(wide.limitBytes);
    expect(wide.memberRecordBytes).toBeLessThanOrEqual(wide.memberLimitBytes);
    // The widest checkpoint of that membership round-trips through the store; the widest tuple parses within its limit
    // (the journal proof holds it in the terminal journal, which is larger than its own record).
    const homeDir = home();
    const checkpoint = widestCheckpoint(manifest, originalSetId);
    expect(Buffer.byteLength(envelope(originalSetId, cutoverSetRollbackCheckpointAggregate(checkpoint)))).toBe(capacity.checkpointBytes);
    const widestMember = Math.max(...checkpoint.members.map((_, index) => Buffer.byteLength(envelope(originalSetId, cutoverSetRollbackCheckpointMemberRecord(checkpoint, index)))));
    expect(widestMember).toBe(capacity.memberRecordBytes);
    recordCutoverSetRollbackCheckpoint({ homeDir, checkpoint });
    const stored = readCutoverSetRollbackRecords({ homeDir, originalSetId });
    expect(stored).toMatchObject({ state: "resolved", selection: null });
    if (stored.state !== "resolved") throw new Error("unreachable");
    expect(stored.checkpoint).toEqual(checkpoint);
    expect(readdirSync(migrationCutoverSetRollbackDirectory(homeDir, originalSetId))).toHaveLength(low + 1);
    const worst = backendCutoverSetRollbackSelectionWorstCase(manifest, originalSetId);
    const body = {
      ...worst, manifestSha256: backendCutoverSetManifestSha256(manifest), checkpointSha256: checkpoint.checksumSha256, originalSelectionSha256: checkpoint.originalSelectionSha256,
      identityDigest: checkpoint.identityDigest,
      members: worst.members.map((row, index) => ({ ...row, remoteProjectId: checkpoint.members[index]!.remoteProjectId, epochId: checkpoint.members[index]!.epochId, attemptId: checkpoint.members[index]!.attemptId })),
    };
    const selection = { ...body, checksumSha256: backendCutoverSetRollbackSelectionSha256(body) };
    expect(Buffer.byteLength(envelope(originalSetId, selection))).toBe(capacity.selectionBytes);
    expect(parseBackendCutoverSetRollbackSelection(selection, manifest)).toEqual(selection);
  }, 120_000);

  it("treats member records without their aggregate as no commitment, and an aggregate without one of its members as untrusted", () => {
    const homeDir = home();
    const checkpoint = createCutoverSetRollbackCheckpoint(checkpointBody(rollbackManifest(2)));
    recordCutoverSetRollbackCheckpoint({ homeDir, checkpoint });
    const directory = migrationCutoverSetRollbackDirectory(homeDir, SET_ID);
    const aggregate = readFileSync(join(directory, "checkpoint.json"));
    rmSync(join(directory, "checkpoint.json"));
    expect(readCutoverSetRollbackRecords({ homeDir, originalSetId: SET_ID })).toEqual({ state: "authoritatively-absent" });
    // The retry re-derives the same bytes: the member records are reused and the aggregate completes the checkpoint.
    recordCutoverSetRollbackCheckpoint({ homeDir, checkpoint });
    expect(readFileSync(join(directory, "checkpoint.json"))).toEqual(aggregate);
    expect(readCutoverSetRollbackRecords({ homeDir, originalSetId: SET_ID })).toMatchObject({ state: "resolved", checkpoint });
    const member = readFileSync(join(directory, "member-000001.json"));
    rmSync(join(directory, "member-000001.json"));
    expect(readCutoverSetRollbackRecords({ homeDir, originalSetId: SET_ID })).toMatchObject({ state: "unresolvable", reason: expect.stringContaining("references 2 member records and 1 are stored") });
    writeFileSync(join(directory, "member-000001.json"), member, { mode: 0o600 });
    writeFileSync(join(directory, "member-000002.json"), member, { mode: 0o600 });
    expect(readCutoverSetRollbackRecords({ homeDir, originalSetId: SET_ID })).toMatchObject({ state: "unresolvable", reason: expect.stringContaining("stored under another index") });
    rmSync(join(directory, "member-000002.json"));
    // The right count of member records, one of them sealed under an index the aggregate does not reference.
    const fifth = { ...cutoverSetRollbackCheckpointMemberRecord(checkpoint, 1), index: 5 };
    writeFileSync(join(directory, "member-000005.json"), envelope(SET_ID, { ...fifth, checksumSha256: cutoverSetRollbackCheckpointMemberRecordSha256(fifth) }), { mode: 0o600 });
    rmSync(join(directory, "member-000001.json"));
    expect(readCutoverSetRollbackRecords({ homeDir, originalSetId: SET_ID })).toMatchObject({ state: "unresolvable", reason: expect.stringContaining("member record 1 is missing") });
    rmSync(join(directory, "member-000005.json"));
    writeFileSync(join(directory, "member-000001.json"), member, { mode: 0o600 });
    const cases: readonly (readonly [string, unknown, string])[] = [
      ["not an object", "row", "member record is malformed"],
      ["version", { ...cutoverSetRollbackCheckpointMemberRecord(checkpoint, 1), version: 2 }, "member record is malformed"],
      ["original set", { ...cutoverSetRollbackCheckpointMemberRecord(checkpoint, 1), originalSetId: "cutover-set-2" }, "member record is malformed"],
      ["set id", { ...cutoverSetRollbackCheckpointMemberRecord(checkpoint, 1), setId: SET_ID }, "member record is malformed"],
      ["foreign set", cutoverSetRollbackCheckpointMemberRecord(createCutoverSetRollbackCheckpoint(checkpointBody(rollbackManifest(2, "cutover-set-2"), () => undefined, "cutover-set-2")), 1), "envelope is invalid"],
      ["member keys", { ...cutoverSetRollbackCheckpointMemberRecord(checkpoint, 1), member: { ...checkpoint.members[1], extra: 1 } }, "member record is malformed"],
      ["checksum", { ...cutoverSetRollbackCheckpointMemberRecord(checkpoint, 1), checksumSha256: HEX("0") }, "member record checksum does not match"],
      ["another member's record", { ...cutoverSetRollbackCheckpointMemberRecord(checkpoint, 0), index: 1, checksumSha256: cutoverSetRollbackCheckpointMemberRecordSha256({ ...cutoverSetRollbackCheckpointMemberRecord(checkpoint, 0), index: 1 }) }, "member record 1 is not the aggregate's"],
    ];
    for (const [name, record, reason] of cases) {
      writeFileSync(join(directory, "member-000001.json"), envelope(name === "foreign set" ? "cutover-set-2" : SET_ID, record), { mode: 0o600 });
      expect(readCutoverSetRollbackRecords({ homeDir, originalSetId: SET_ID }), name).toMatchObject({ state: "unresolvable", reason: expect.stringContaining(reason) });
    }
    writeFileSync(join(directory, "member-000001.json"), member, { mode: 0o600 });
    // An aggregate whose member digests are not hashes, or whose assembled checkpoint does not reproduce its checksum.
    const stored = JSON.parse(aggregate.toString("utf8")) as { record: Record<string, unknown> };
    writeFileSync(join(directory, "checkpoint.json"), envelope(SET_ID, { ...stored.record, members: [checkpoint.members[0], HEX("0")] }), { mode: 0o600 });
    expect(readCutoverSetRollbackRecords({ homeDir, originalSetId: SET_ID })).toMatchObject({ state: "unresolvable", reason: expect.stringContaining("aggregate is malformed") });
    writeFileSync(join(directory, "checkpoint.json"), envelope(SET_ID, { ...stored.record, identityDigest: HEX("0") }), { mode: 0o600 });
    expect(readCutoverSetRollbackRecords({ homeDir, originalSetId: SET_ID })).toMatchObject({ state: "unresolvable", reason: expect.stringContaining("checksum does not match") });
    writeFileSync(join(directory, "checkpoint.json"), envelope(SET_ID, { ...stored.record, setId: SET_ID }), { mode: 0o600 });
    expect(readCutoverSetRollbackRecords({ homeDir, originalSetId: SET_ID })).toMatchObject({ state: "unresolvable", reason: expect.stringContaining("aggregate does not restate") });
    writeFileSync(join(directory, "checkpoint.json"), envelope(SET_ID, { ...stored.record, manifest: { ...checkpoint.manifest, version: 2 } }), { mode: 0o600 });
    expect(readCutoverSetRollbackRecords({ homeDir, originalSetId: SET_ID })).toMatchObject({ state: "unresolvable", reason: expect.stringContaining("manifest is malformed") });
    writeFileSync(join(directory, "checkpoint.json"), aggregate, { mode: 0o600 });
    expect(readCutoverSetRollbackRecords({ homeDir, originalSetId: SET_ID })).toMatchObject({ state: "resolved", checkpoint });
  });
  describe("parser", () => {
    const manifest = rollbackManifest(3);
    const sealed = (edit: (body: Record<string, any>) => void) => {
      const body = { version: 1, kind: "cutover-set-rollback-checkpoint", ...checkpointBody(manifest) } as Record<string, any>;
      edit(body);
      return { ...body, checksumSha256: cutoverSetRollbackCheckpointSha256(body as CutoverSetRollbackCheckpoint) };
    };
    const cases: readonly (readonly [string, RegExp, (body: Record<string, any>) => void])[] = [
      ["not an object", /malformed/u, () => undefined],
      ["version", /malformed/u, (b) => { b.version = 2; }],
      ["kind", /malformed/u, (b) => { b.kind = "cutover-set-activation-checkpoint"; }],
      ["unknown key", /malformed/u, (b) => { b.extra = 1; }],
      ["originalSetId shape", /malformed/u, (b) => { b.originalSetId = "bad id!"; }],
      ["originalSetId type", /malformed/u, (b) => { b.originalSetId = 4; }],
      ["originalCheckpointSha256", /malformed/u, (b) => { b.originalCheckpointSha256 = "x"; }],
      ["originalSelectionSha256", /malformed/u, (b) => { b.originalSelectionSha256 = 1; }],
      ["activationIdentityDigest", /malformed/u, (b) => { b.activationIdentityDigest = ""; }],
      ["activationJournalChecksumSha256", /malformed/u, (b) => { b.activationJournalChecksumSha256 = null; }],
      ["operabilityFactValueSha256", /malformed/u, (b) => { b.operabilityFactValueSha256 = HEX("g"); }],
      ["identityDigest", /malformed/u, (b) => { b.identityDigest = HEX("0").slice(1); }],
      ["members not array", /malformed/u, (b) => { b.members = {}; }],
      ["manifest malformed", /manifest is malformed/u, (b) => { b.manifest = { ...manifest, version: 2 }; }],
      ["manifest not the derived rollback id", /does not restate/u, (b) => { b.manifest = { ...manifest, setId: SET_ID }; b.setId = SET_ID; b.publicationId = SET_ID; }],
      ["setId", /does not restate/u, (b) => { b.setId = SET_ID; }],
      ["publicationId", /does not restate/u, (b) => { b.publicationId = SET_ID; }],
      ["member count", /does not restate/u, (b) => { b.members = b.members.slice(0, 2); }],
      ["member not object", /member\[0\]/u, (b) => { b.members[0] = "row"; }],
      ["member keys", /member\[1\]/u, (b) => { b.members[1] = { ...b.members[1], extra: true }; }],
      ["member project", /member\[0\]/u, (b) => { b.members[0].physicalProjectId = manifest.members[1]!.physicalProjectId; }],
      ["member generation", /member\[0\]/u, (b) => { b.members[0].generationId = manifest.members[1]!.generationId; }],
      ["member source selection", /member\[2\]/u, (b) => { b.members[2].sourceSelectionSha256 = HEX("0"); }],
      ["member remote", /member\[0\]/u, (b) => { b.members[0].remoteProjectId = "no"; }],
      ["member remote type", /member\[0\]/u, (b) => { b.members[0].remoteProjectId = 1; }],
      ["member held", /member\[0\]/u, (b) => { b.members[0].heldMemberChecksumSha256 = 1; }],
      ["member snapshot", /member\[0\]/u, (b) => { b.members[0].snapshotChecksumSha256 = "s"; }],
      ["member queue evidence", /member\[0\]/u, (b) => { b.members[0].queueEvidenceSha256 = "q"; }],
      ["member cutoff shape", /member\[1\]/u, (b) => { b.members[1].queueCutoff = "x1"; }],
      ["member cutoff type", /member\[1\]/u, (b) => { b.members[1].queueCutoff = 7; }],
      ["member source bytes", /member\[0\]/u, (b) => { b.members[0].sourceByteWitnessSha256 = ""; }],
      ["member epoch", /member\[0\]/u, (b) => { b.members[0].epochId = 3; }],
      ["member attempt", /member\[0\]/u, (b) => { b.members[0].attemptId = "a"; }],
      ["member witness", /member\[0\]/u, (b) => { b.members[0].activationWitnessChecksumSha256 = null; }],
      ["member revision", /member\[0\]/u, (b) => { b.members[0].manifestRevision = -1; }],
      ["member revision type", /member\[0\]/u, (b) => { b.members[0].manifestRevision = "12"; }],
      ["member manifest checksum", /member\[0\]/u, (b) => { b.members[0].manifestChecksumSha256 = 12; }],
      ["member evidence", /member\[0\]/u, (b) => { b.members[0].evidenceSha256 = "e"; }],
      ["duplicate remotes", /not unique/u, (b) => { b.members[1].remoteProjectId = b.members[0].remoteProjectId; }],
    ];
    for (const [name, expected, edit] of cases) {
      it("refuses " + name, () => {
        const value = name === "not an object" ? "nope" : sealed(edit);
        expect(() => parseCutoverSetRollbackCheckpoint(value)).toThrow(expect.objectContaining({ name: "CutoverSetRollbackRecordError", reason: "invalid-input", message: expect.stringMatching(expected) }));
      });
    }
    it("refuses a checksum that does not reproduce or is malformed", () => {
      expect(() => parseCutoverSetRollbackCheckpoint({ ...sealed(() => undefined), checksumSha256: HEX("0") })).toThrow(/checksum does not match/u);
      expect(() => parseCutoverSetRollbackCheckpoint({ ...sealed(() => undefined), checksumSha256: "nope" })).toThrow(/checkpoint is malformed/u);
    });
  });
});

describe("cutover-set rollback installation record", () => {
  it("requires the checkpoint, names a member, records under its index, reuses and refuses different bytes", () => {
    const homeDir = home();
    const checkpoint = createCutoverSetRollbackCheckpoint(checkpointBody(rollbackManifest(2)));
    const install = createCutoverSetRollbackInstallRecord(installBody(checkpoint, 1));
    expect(install.checksumSha256).toBe(cutoverSetRollbackInstallRecordSha256(install));
    expect(() => recordCutoverSetRollbackInstall({ homeDir, record: install })).toThrow(expect.objectContaining({ reason: "checkpoint-missing" }));
    recordCutoverSetRollbackCheckpoint({ homeDir, checkpoint });
    recordCutoverSetRollbackInstall({ homeDir, record: install });
    recordCutoverSetRollbackInstall({ homeDir, record: install });
    expect(recordFiles(homeDir)).toEqual(["checkpoint.json", "install-000001.json", "member-000000.json", "member-000001.json"]);
    const read = readCutoverSetRollbackRecords({ homeDir, originalSetId: SET_ID });
    expect(read).toMatchObject({ state: "resolved", selection: null });
    if (read.state === "resolved") expect([...read.installs.entries()]).toEqual([[install.generationId, install]]);
    const other = createCutoverSetRollbackInstallRecord(installBody(checkpoint, 1, (b) => { b.installedGenerationId = b.generationId + "-rb12-2"; }));
    expect(() => recordCutoverSetRollbackInstall({ homeDir, record: other })).toThrow(expect.objectContaining({ name: "MigrationBindingConflictError" }));
    const foreign = createCutoverSetRollbackInstallRecord(installBody(checkpoint, 0, (b) => { b.generationId = "member-generation-9"; }));
    expect(() => recordCutoverSetRollbackInstall({ homeDir, record: foreign })).toThrow(expect.objectContaining({ reason: "invalid-input", message: expect.stringContaining("checkpoint does not") }));
    expect(() => recordCutoverSetRollbackInstall({ homeDir, record: { ...install, database: { sha256: HEX("5"), size: "1" } } }))
      .toThrow(expect.objectContaining({ reason: "invalid-input", message: expect.stringContaining("checksum") }));
    expect(MAX_CUTOVER_SET_ROLLBACK_INSTALL_RECORD_BYTES).toBeLessThan(MAX_CUTOVER_SET_ROLLBACK_RECORD_BYTES);
    const oversized = createCutoverSetRollbackInstallRecord(installBody(checkpoint, 0, (b) => { b.canonicalPath = "/" + "p".repeat(MAX_CUTOVER_SET_ROLLBACK_INSTALL_RECORD_BYTES); }));
    expect(() => recordCutoverSetRollbackInstall({ homeDir, record: oversized })).toThrow(expect.objectContaining({ reason: "invalid-input", message: expect.stringContaining("exceeds") }));
  });

  describe("parser", () => {
    const checkpoint = createCutoverSetRollbackCheckpoint(checkpointBody(rollbackManifest(2)));
    const sealed = (index: number, edit: (body: Record<string, any>) => void) => {
      const body = { version: 1, kind: "cutover-set-rollback-install", ...installBody(checkpoint, index) } as Record<string, any>;
      edit(body);
      return { ...body, checksumSha256: cutoverSetRollbackInstallRecordSha256(body as CutoverSetRollbackInstallRecord) };
    };
    const cases: readonly (readonly [string, number, (body: Record<string, any>) => void])[] = [
      ["version", 1, (b) => { b.version = 0; }],
      ["kind", 1, (b) => { b.kind = "install"; }],
      ["extra key", 1, (b) => { b.extra = 1; }],
      ["originalSetId", 1, (b) => { b.originalSetId = "bad id!"; }],
      ["originalSetId type", 1, (b) => { b.originalSetId = 1; }],
      ["setId not derived", 1, (b) => { b.setId = SET_ID; }],
      ["generationId", 1, (b) => { b.generationId = ""; }],
      ["generationId type", 1, (b) => { b.generationId = 2; }],
      ["installedGenerationId", 1, (b) => { b.installedGenerationId = "bad id!"; }],
      ["installedGenerationId type", 1, (b) => { b.installedGenerationId = 2; }],
      ["installed equals original", 1, (b) => { b.installedGenerationId = b.generationId; }],
      ["mode", 1, (b) => { b.mode = "none"; }],
      ["build witness", 1, (b) => { b.buildWitnessChecksumSha256 = "w"; }],
      ["build manifest", 1, (b) => { b.buildManifestSha256 = 1; }],
      ["build content", 1, (b) => { b.buildContentSha256 = null; }],
      ["export evidence shape", 1, (b) => { b.exportEvidenceSha256 = "x"; }],
      ["export evidence for pre-write", 0, (b) => { b.exportEvidenceSha256 = HEX("4"); }],
      ["no export evidence for post-write", 1, (b) => { b.exportEvidenceSha256 = null; }],
      ["canonicalPath type", 1, (b) => { b.canonicalPath = 1; }],
      ["canonicalPath empty", 1, (b) => { b.canonicalPath = ""; }],
      ["database not object", 1, (b) => { b.database = "db"; }],
      ["database keys", 1, (b) => { b.database = { sha256: HEX("5") }; }],
      ["database sha", 1, (b) => { b.database = { sha256: "s", size: "1" }; }],
      ["database size type", 1, (b) => { b.database = { sha256: HEX("5"), size: 1 }; }],
      ["database size shape", 1, (b) => { b.database = { sha256: HEX("5"), size: "-1" }; }],
      ["preemption not object", 1, (b) => { b.preemption = "p"; }],
      ["preemption keys", 1, (b) => { b.preemption = { path: "/p" }; }],
      ["preemption path type", 1, (b) => { b.preemption = { path: 1, beforeSha256: HEX("6"), afterSha256: HEX("6") }; }],
      ["preemption path empty", 1, (b) => { b.preemption = { path: "", beforeSha256: HEX("6"), afterSha256: HEX("6") }; }],
      ["preemption before", 1, (b) => { b.preemption = { path: "/p", beforeSha256: "b", afterSha256: HEX("6") }; }],
      ["preemption after", 1, (b) => { b.preemption = { path: "/p", beforeSha256: HEX("6"), afterSha256: "a" }; }],
      ["sidecars not object", 1, (b) => { b.sidecars = null; }],
      ["sidecars keys", 1, (b) => { b.sidecars = { ...b.sidecars, extra: 1 }; }],
      ["sidecars instructions", 1, (b) => { b.sidecars.sessionInstructionsMaterialized = -1; }],
      ["sidecars events", 1, (b) => { b.sidecars.passiveEventsMaterialized = "2"; }],
      ["sidecars pending", 1, (b) => { b.sidecars.passiveEventsPreservedPending = 1.5; }],
      ["sidecars reconciled type", 1, (b) => { b.sidecars.reconciledUpTo = 17; }],
      ["sidecars reconciled shape", 1, (b) => { b.sidecars.reconciledUpTo = "x"; }],
    ];
    for (const [name, index, edit] of cases) {
      it("refuses " + name, () => {
        expect(() => parseCutoverSetRollbackInstallRecord(sealed(index, edit)))
          .toThrow(expect.objectContaining({ name: "CutoverSetRollbackRecordError", reason: "invalid-input", message: expect.stringContaining("installation record is malformed") }));
      });
    }
    it("refuses a non-object and a checksum that is malformed or does not reproduce, and accepts both modes", () => {
      expect(() => parseCutoverSetRollbackInstallRecord(null)).toThrow(/installation record is malformed/u);
      expect(() => parseCutoverSetRollbackInstallRecord({ ...sealed(1, () => undefined), checksumSha256: HEX("0") })).toThrow(/checksum does not match/u);
      expect(() => parseCutoverSetRollbackInstallRecord({ ...sealed(1, () => undefined), checksumSha256: "c" })).toThrow(/installation record is malformed/u);
      for (const index of [0, 1]) {
        const record = sealed(index, () => undefined);
        expect(parseCutoverSetRollbackInstallRecord(record)).toEqual(record);
      }
    });
  });
});

describe("cutover-set rollback selection", () => {
  it("requires the checkpoint and every installation record, proves descent, then records, reuses and refuses different bytes", () => {
    const homeDir = home();
    const checkpoint = createCutoverSetRollbackCheckpoint(checkpointBody(rollbackManifest(2)));
    const installs = checkpoint.members.map((_, index) => createCutoverSetRollbackInstallRecord(installBody(checkpoint, index)));
    const selection = selectionFor(checkpoint, installs);
    expect(() => recordCutoverSetRollbackSelection({ homeDir, selection })).toThrow(expect.objectContaining({ reason: "checkpoint-missing" }));
    recordCutoverSetRollbackCheckpoint({ homeDir, checkpoint });
    recordCutoverSetRollbackInstall({ homeDir, record: installs[0]! });
    expect(() => recordCutoverSetRollbackSelection({ homeDir, selection })).toThrow(expect.objectContaining({ reason: "install-missing", message: expect.stringContaining(installs[1]!.generationId) }));
    recordCutoverSetRollbackInstall({ homeDir, record: installs[1]! });
    recordCutoverSetRollbackSelection({ homeDir, selection });
    recordCutoverSetRollbackSelection({ homeDir, selection });
    expect(recordFiles(homeDir)).toEqual(["checkpoint.json", "install-000000.json", "install-000001.json", "member-000000.json", "member-000001.json", "selection.json"]);
    const read = readCutoverSetRollbackRecords({ homeDir, originalSetId: SET_ID });
    expect(read).toMatchObject({ state: "resolved", checkpoint, selection });
    const other = selectionFor(checkpoint, installs, (b) => { b.members[0].witnessChecksumSha256 = HEX("f"); });
    expect(() => recordCutoverSetRollbackSelection({ homeDir, selection: other })).toThrow(expect.objectContaining({ name: "MigrationBindingConflictError" }));
    // Malformed, mismatched and non-descending tuples refuse before any write.
    expect(() => recordCutoverSetRollbackSelection({ homeDir: home(), selection: { ...selection, checksumSha256: HEX("0") } })).toThrow(expect.objectContaining({ reason: "checkpoint-missing" }));
    const fresh = home();
    recordCutoverSetRollbackCheckpoint({ homeDir: fresh, checkpoint });
    for (const record of installs) recordCutoverSetRollbackInstall({ homeDir: fresh, record });
    expect(() => recordCutoverSetRollbackSelection({ homeDir: fresh, selection: { ...selection, checksumSha256: HEX("0") } }))
      .toThrow(expect.objectContaining({ reason: "invalid-input", message: expect.stringContaining("malformed") }));
    const descentCases: readonly (readonly [string, (b: Record<string, any>) => void])[] = [
      ["checkpoint digest", (b) => { b.checkpointSha256 = HEX("0"); }],
      ["original selection digest", (b) => { b.originalSelectionSha256 = HEX("0"); }],
      ["reverse artifact identity digest", (b) => { b.identityDigest = HEX("0"); }],
      ["member " + checkpoint.members[0]!.generationId, (b) => { b.members[0].epochId = HEX("0"); }],
      ["member " + checkpoint.members[1]!.generationId, (b) => { b.members[1].attemptId = HEX("0"); }],
      ["member " + checkpoint.members[1]!.generationId + " installation", (b) => { b.members[1].installEvidenceSha256 = HEX("0"); }],
      ["member " + checkpoint.members[0]!.generationId + " installation", (b) => { b.members[0].mode = "post-write"; }],
    ];
    for (const [expected, edit] of descentCases) {
      expect(() => recordCutoverSetRollbackSelection({ homeDir: fresh, selection: selectionFor(checkpoint, installs, edit) }), expected)
        .toThrow(expect.objectContaining({ reason: "selection-mismatch", message: expect.stringContaining(expected) }));
    }
    // Pure descent checks the parser cannot reach through the manifest-bound tuple.
    const installsByMember = new Map(installs.map((record) => [record.generationId, record]));
    const otherManifest = rollbackManifest(2, "cutover-set-2");
    const otherCheckpoint = createCutoverSetRollbackCheckpoint(checkpointBody(otherManifest, () => undefined, "cutover-set-2"));
    for (const [expected, tuple] of [
      ["set or publication id", { ...selection, setId: otherCheckpoint.setId }],
      ["set or publication id", { ...selection, publicationId: otherCheckpoint.setId }],
      ["original set id", { ...selection, originalSetId: "cutover-set-2" }],
      ["manifest digest", { ...selection, manifestSha256: HEX("0") }],
      ["member count", { ...selection, members: selection.members.slice(0, 1) }],
      ["member " + checkpoint.members[0]!.generationId, { ...selection, members: [{ ...selection.members[0]!, remoteProjectId: REMOTES[2] }, selection.members[1]!] }],
    ] as const) {
      expect(() => assertCutoverSetRollbackSelectionDescendsFromRecords(checkpoint, installsByMember, tuple as BackendCutoverSetRollbackSelection), expected)
        .toThrow(expect.objectContaining({ reason: "selection-mismatch", message: expect.stringContaining(expected) }));
    }
    expect(() => recordCutoverSetRollbackSelection({ homeDir: fresh, selection: undefined as never })).toThrow();
  });

  it("refuses to record when the stored records cannot be trusted", () => {
    const homeDir = home();
    const { checkpoint, installs, selection, directory } = stored(homeDir);
    writeFileSync(join(directory, "checkpoint.json"), "{}\n", { mode: 0o600 });
    expect(() => recordCutoverSetRollbackSelection({ homeDir, selection })).toThrow(expect.objectContaining({ reason: "record-unresolvable" }));
    expect(() => recordCutoverSetRollbackInstall({ homeDir, record: installs[0]! })).toThrow(expect.objectContaining({ reason: "record-unresolvable" }));
    expect(checkpoint.members).toHaveLength(2);
  });
});

describe("readCutoverSetRollbackRecords fails closed", () => {
  it("reports any record without its checkpoint as unresolvable, never as absence", () => {
    const homeDir = home();
    const { directory } = stored(homeDir);
    rmSync(join(directory, "checkpoint.json"));
    expect(readCutoverSetRollbackRecords({ homeDir, originalSetId: SET_ID })).toMatchObject({ state: "unresolvable", reason: expect.stringContaining("without its checkpoint") });
    rmSync(join(directory, "selection.json"));
    expect(readCutoverSetRollbackRecords({ homeDir, originalSetId: SET_ID })).toMatchObject({ state: "unresolvable", reason: expect.stringContaining("install-000000.json") });
  });

  it("reports a corrupt, non-canonical, foreign-set, misplaced or unknown entry as unresolvable", () => {
    const homeDir = home();
    const { checkpoint, installs, selection, directory } = stored(homeDir);
    const cases: readonly (readonly [string, () => void, string])[] = [
      ["checkpoint.json", () => writeFileSync(join(directory, "checkpoint.json"), "not json\n", { mode: 0o600 }), "checkpoint.json cannot be trusted"],
      ["checkpoint.json", () => writeFileSync(join(directory, "checkpoint.json"), envelope("cutover-set-2", cutoverSetRollbackCheckpointAggregate(checkpoint)), { mode: 0o600 }), "envelope is invalid"],
      ["checkpoint.json", () => writeFileSync(join(directory, "checkpoint.json"), JSON.stringify({ version: 1, originalSetId: SET_ID, record: cutoverSetRollbackCheckpointAggregate(checkpoint) }, null, 2) + "\n", { mode: 0o600 }), "not canonical"],
      ["checkpoint.json", () => writeFileSync(join(directory, "checkpoint.json"), envelope(SET_ID, { ...cutoverSetRollbackCheckpointAggregate(checkpoint), identityDigest: HEX("0") }), { mode: 0o600 }), "checksum does not match"],
      ["checkpoint.json", () => writeFileSync(join(directory, "checkpoint.json"), envelope(SET_ID, cutoverSetRollbackCheckpointAggregate(createCutoverSetRollbackCheckpoint(checkpointBody(rollbackManifest(2, "cutover-set-2"), () => undefined, "cutover-set-2")))), { mode: 0o600 }), "names another set"],
      ["checkpoint.json", () => writeFileSync(join(directory, "checkpoint.json"), envelope(SET_ID, checkpoint), { mode: 0o600 }), "aggregate is malformed"],
      ["install-000000.json", () => writeFileSync(join(directory, "install-000000.json"), envelope(SET_ID, { ...installs[0], checksumSha256: HEX("0") }), { mode: 0o600 }), "install-000000.json cannot be trusted"],
      ["install-000000.json", () => writeFileSync(join(directory, "install-000000.json"), envelope(SET_ID, installs[1]), { mode: 0o600 }), "not the checkpoint's member at its index"],
      ["install-000002.json", () => writeFileSync(join(directory, "install-000002.json"), envelope(SET_ID, installs[1]), { mode: 0o600 }), "not the checkpoint's member at its index"],
      ["selection.json", () => writeFileSync(join(directory, "selection.json"), envelope(SET_ID, { ...selection, checksumSha256: HEX("0") }), { mode: 0o600 }), "selection.json cannot be trusted"],
      ["selection.json", () => writeFileSync(join(directory, "selection.json"), envelope(SET_ID, selectionFor(checkpoint, installs, (b) => { b.identityDigest = HEX("0"); })), { mode: 0o600 }), "does not descend"],
      ["extra.json", () => writeFileSync(join(directory, "extra.json"), "{}\n", { mode: 0o600 }), "unknown entry"],
    ];
    const names = ["checkpoint.json", "install-000000.json", "install-000001.json", "member-000000.json", "member-000001.json", "selection.json"];
    for (const [name, corrupt, expected] of cases) {
      const before = new Map(names.map((entry) => [entry, readFileSync(join(directory, entry))]));
      corrupt();
      expect(readCutoverSetRollbackRecords({ homeDir, originalSetId: SET_ID }), name + ":" + expected).toMatchObject({ state: "unresolvable", reason: expect.stringContaining(expected) });
      if (!names.includes(name)) rmSync(join(directory, name));
      for (const [entry, content] of before) writeFileSync(join(directory, entry), content, { mode: 0o600 });
    }
    expect(readCutoverSetRollbackRecords({ homeDir, originalSetId: SET_ID })).toMatchObject({ state: "resolved", checkpoint, selection });
  });

  it("ignores a byte-identical lone writer scratch twin and refuses any other lone scratch", () => {
    const homeDir = home();
    const { checkpoint, selection, directory } = stored(homeDir);
    writeFileSync(join(directory, ".checkpoint.json.0a1b.tmp"), readFileSync(join(directory, "checkpoint.json")), { mode: 0o600 });
    expect(readCutoverSetRollbackRecords({ homeDir, originalSetId: SET_ID })).toMatchObject({ state: "resolved", checkpoint, selection });
    writeFileSync(join(directory, ".selection.json.0a1b.tmp"), "other\n", { mode: 0o600 });
    expect(readCutoverSetRollbackRecords({ homeDir, originalSetId: SET_ID })).toMatchObject({ state: "unresolvable", reason: expect.stringContaining("scratch entry") });
  });

  it("reports an unauthenticated store directory as unresolvable and refuses malformed input", () => {
    const homeDir = home();
    const { directory } = stored(homeDir);
    chmodSync(directory, 0o755);
    expect(readCutoverSetRollbackRecords({ homeDir, originalSetId: SET_ID })).toMatchObject({ state: "unresolvable" });
    chmodSync(directory, 0o700);
    expect(() => readCutoverSetRollbackRecords({ homeDir, originalSetId: "../escape" })).toThrow();
    expect(() => readCutoverSetRollbackRecords({ homeDir: "", originalSetId: SET_ID })).toThrow();
    expect(() => recordCutoverSetRollbackCheckpoint({ homeDir, checkpoint: "nope" as never })).toThrow(CutoverSetRollbackRecordError);
  });
});

describe("resolveCutoverSetRollbackCommitment", () => {
  function linked(homeDir: string, publicationId: string) {
    const { checkpoint, selection } = stored(homeDir);
    for (const member of checkpoint.members) {
      recordActivationGenerationLink({
        homeDir, generationId: member.generationId, publicationId, identityDigest: HEX("3"),
        epochManifestRevision: 8, epochManifestChecksumSha256: HEX("b"),
      });
    }
    return { checkpoint, selection };
  }

  it("resolves a member through its link to the rollback records and its own checkpoint row", () => {
    const homeDir = home();
    const { checkpoint, selection } = linked(homeDir, SET_ID);
    const resolved = resolveCutoverSetRollbackCommitment({ homeDir, generationId: checkpoint.members[1]!.generationId });
    expect(resolved).toMatchObject({ state: "resolved", originalSetId: SET_ID, member: checkpoint.members[1], records: { state: "resolved", checkpoint, selection } });
  });

  it("is absent for an unlinked generation, a single-generation link and a set without rollback records", () => {
    const homeDir = home();
    expect(resolveCutoverSetRollbackCommitment({ homeDir, generationId: "member-generation-1" })).toMatchObject({ state: "absent", cause: "unlinked" });
    recordActivationGenerationLink({
      homeDir, generationId: "member-generation-1", publicationId: deriveActivationPublicationId("member-generation-1"), identityDigest: HEX("3"),
      epochManifestRevision: 8, epochManifestChecksumSha256: HEX("b"),
    });
    expect(resolveCutoverSetRollbackCommitment({ homeDir, generationId: "member-generation-1" })).toMatchObject({ state: "absent", cause: "single-generation" });
    recordActivationGenerationLink({
      homeDir, generationId: "member-generation-2", publicationId: "cutover-set-9", identityDigest: HEX("3"),
      epochManifestRevision: 8, epochManifestChecksumSha256: HEX("b"),
    });
    expect(resolveCutoverSetRollbackCommitment({ homeDir, generationId: "member-generation-2" })).toMatchObject({ state: "absent", cause: "no-rollback", detail: expect.stringContaining("cutover-set-9") });
  });

  it("is unresolvable when the link, the records or the member row cannot be authenticated", () => {
    const homeDir = home();
    const { checkpoint } = linked(homeDir, SET_ID);
    const directory = migrationCutoverSetRollbackDirectory(homeDir, SET_ID);
    const member = checkpoint.members[0]!.generationId;
    expect(resolveCutoverSetRollbackCommitment({ homeDir, generationId: member }, { readLink: () => ({ state: "unresolvable", reason: "root-unauthenticated", detail: "nope" }) as never }))
      .toMatchObject({ state: "unresolvable", reason: expect.stringContaining("link is unresolvable") });
    // A generation linked to the set but absent from the checkpoint's manifest.
    recordActivationGenerationLink({ homeDir, generationId: "member-generation-7", publicationId: SET_ID, identityDigest: HEX("3"), epochManifestRevision: 8, epochManifestChecksumSha256: HEX("b") });
    expect(resolveCutoverSetRollbackCommitment({ homeDir, generationId: "member-generation-7" })).toMatchObject({ state: "unresolvable", reason: expect.stringContaining("no row for generation") });
    writeFileSync(join(directory, "checkpoint.json"), "{}\n", { mode: 0o600 });
    expect(resolveCutoverSetRollbackCommitment({ homeDir, generationId: member })).toMatchObject({ state: "unresolvable", reason: expect.stringContaining("rollback records are unresolvable") });
    expect(() => resolveCutoverSetRollbackCommitment({ homeDir, generationId: "../x" })).toThrow();
  });
});

