import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  backendCutoverSetManifestSha256,
  backendCutoverSetSelectionSha256,
  type BackendCutoverSetManifest,
  type BackendCutoverSetSelection,
} from "../../src/storage/backend-publication.js";
import { canonicalJson } from "../../src/storage/portable-record.js";
import {
  captureActivationRecoveryFile,
  computeActivationArtifactIdentityDigest,
  publishActivationArtifact,
  recordActivationGenerationLink,
  type ActivationArtifactRecoveryMaterial,
} from "../../src/migration/activation-artifact-store.js";
import { deriveActivationPublicationId } from "../../src/migration/activation-publication-id.js";
import {
  CutoverSetActivationRecordError,
  MAX_CUTOVER_SET_ACTIVATION_RECORD_BYTES,
  assertCutoverSetSelectionDescendsFromCheckpoint,
  createCutoverSetActivationCheckpoint,
  cutoverSetActivationCheckpointSha256,
  migrationCutoverSetActivationDirectory,
  parseCutoverSetActivationCheckpoint,
  readCutoverSetActivationRecords,
  recordCutoverSetActivationCheckpoint,
  recordCutoverSetActivationSelection,
  resolveCutoverSetActivationSelection,
  type CreateCutoverSetActivationCheckpointInput,
  type CutoverSetActivationCheckpoint,
} from "../../src/migration/cutover-set-activation-store.js";
import { SET_ID, setManifest } from "../fixtures/cutover-set.js";

const HEX = (value: string) => value.repeat(64);
const REMOTES = ["018f22c4-6d2a-7f10-8a4c-6b8d3e5f9001", "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9002", "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9003"];
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function home(): string {
  const value = mkdtempSync(join(tmpdir(), "lcm-cutover-set-activation-store-"));
  mkdirSync(join(value, ".lcm"), { mode: 0o700 });
  roots.push(value);
  return value;
}

function checkpointBody(manifest: BackendCutoverSetManifest, edit: (body: Record<string, any>) => void = () => undefined): CreateCutoverSetActivationCheckpointInput {
  const body: Record<string, any> = {
    setId: manifest.setId,
    manifest,
    heldJournalChecksumSha256: HEX("1"),
    publicationId: manifest.setId,
    identityDigest: HEX("d"),
    members: manifest.members.map((member, index) => ({
      physicalProjectId: member.physicalProjectId,
      generationId: member.generationId,
      remoteProjectId: REMOTES[index]!,
      heldMemberChecksumSha256: HEX(String(index + 2)),
      copyBindingSha256: HEX(String(index + 5)),
      epochManifestRevision: 8,
      epochManifestChecksumSha256: HEX("b"),
      verificationReportSha256: HEX("9"),
    })),
  };
  edit(body);
  return body as CreateCutoverSetActivationCheckpointInput;
}

function selectionFor(checkpoint: CutoverSetActivationCheckpoint, edit: (body: Record<string, any>) => void = () => undefined): BackendCutoverSetSelection {
  const body: Record<string, any> = {
    version: 1,
    kind: "cutover-set-selection",
    checkpointSha256: checkpoint.checksumSha256,
    setId: checkpoint.setId,
    manifestSha256: backendCutoverSetManifestSha256(checkpoint.manifest),
    publicationId: checkpoint.publicationId,
    identityDigest: checkpoint.identityDigest,
    sourceBackend: "sqlite",
    targetBackend: "postgresql",
    members: checkpoint.members.map((member, index) => ({
      physicalProjectId: member.physicalProjectId,
      generationId: member.generationId,
      remoteProjectId: member.remoteProjectId,
      copyBindingSha256: member.copyBindingSha256,
      epochId: HEX("e"),
      attemptId: HEX("a"),
      epochManifestRevision: member.epochManifestRevision,
      epochManifestChecksumSha256: member.epochManifestChecksumSha256,
      witnessChecksumSha256: HEX(String(index + 3)),
    })),
  };
  edit(body);
  return { ...(body as Omit<BackendCutoverSetSelection, "checksumSha256">), checksumSha256: backendCutoverSetSelectionSha256(body as Omit<BackendCutoverSetSelection, "checksumSha256">) };
}

function recordFiles(homeDir: string): string[] {
  return readdirSync(migrationCutoverSetActivationDirectory(homeDir, SET_ID)).sort();
}

describe("cutover-set activation checkpoint", () => {
  it("records once, reuses identical bytes, refuses different bytes and reads back resolved", () => {
    const homeDir = home();
    const checkpoint = createCutoverSetActivationCheckpoint(checkpointBody(setManifest(2)));
    expect(checkpoint.checksumSha256).toBe(cutoverSetActivationCheckpointSha256(checkpoint));
    recordCutoverSetActivationCheckpoint({ homeDir, checkpoint });
    expect(recordFiles(homeDir)).toEqual(["checkpoint.json"]);
    expect(statSync(join(migrationCutoverSetActivationDirectory(homeDir, SET_ID), "checkpoint.json")).mode & 0o777).toBe(0o600);
    recordCutoverSetActivationCheckpoint({ homeDir, checkpoint });
    expect(readCutoverSetActivationRecords({ homeDir, setId: SET_ID })).toEqual({ state: "resolved", checkpoint, selection: null });
    const other = createCutoverSetActivationCheckpoint(checkpointBody(setManifest(2), (b) => { b.identityDigest = HEX("f"); }));
    expect(() => recordCutoverSetActivationCheckpoint({ homeDir, checkpoint: other })).toThrow(expect.objectContaining({ name: "MigrationBindingConflictError" }));
    expect(readCutoverSetActivationRecords({ homeDir, setId: SET_ID })).toEqual({ state: "resolved", checkpoint, selection: null });
    expect(readCutoverSetActivationRecords({ homeDir, setId: "cutover-set-2" })).toEqual({ state: "authoritatively-absent" });
    expect(readCutoverSetActivationRecords({ homeDir: home(), setId: SET_ID })).toEqual({ state: "authoritatively-absent" });
  });

  it("refuses a record whose checksum was not re-derived before any write", () => {
    const homeDir = home();
    const checkpoint = createCutoverSetActivationCheckpoint(checkpointBody(setManifest(2)));
    expect(() => recordCutoverSetActivationCheckpoint({ homeDir, checkpoint: { ...checkpoint, identityDigest: HEX("f") } }))
      .toThrow(expect.objectContaining({ name: "CutoverSetActivationRecordError", reason: "invalid-input", message: expect.stringContaining("checksum") }));
    expect(readCutoverSetActivationRecords({ homeDir, setId: SET_ID })).toEqual({ state: "authoritatively-absent" });
  });

  it("refuses a record larger than the bounded size before any write", () => {
    const homeDir = home();
    const members = Array.from({ length: 3500 }, (_, index) => ({
      physicalProjectId: (index + 1).toString(16).padStart(64, "0"),
      generationId: "member-generation-" + String(index + 1),
      sourceSelectionSha256: (index + 0x1000).toString(16).padStart(64, "0"),
    }));
    const manifest = { ...setManifest(2), members };
    const checkpoint = createCutoverSetActivationCheckpoint(checkpointBody(manifest, (b) => {
      b.members = manifest.members.map((member, index) => ({
        physicalProjectId: member.physicalProjectId, generationId: member.generationId,
        remoteProjectId: "ffffffff-ffff-7fff-bfff-" + index.toString(16).padStart(12, "0"),
        heldMemberChecksumSha256: HEX("2"), copyBindingSha256: HEX("5"), epochManifestRevision: 8,
        epochManifestChecksumSha256: HEX("b"), verificationReportSha256: HEX("9"),
      }));
    }));
    expect(canonicalJson(checkpoint).length).toBeGreaterThan(MAX_CUTOVER_SET_ACTIVATION_RECORD_BYTES);
    expect(() => recordCutoverSetActivationCheckpoint({ homeDir, checkpoint }))
      .toThrow(expect.objectContaining({ reason: "invalid-input", message: expect.stringContaining("exceeds") }));
    expect(readCutoverSetActivationRecords({ homeDir, setId: SET_ID })).toEqual({ state: "authoritatively-absent" });
  });

  describe("parser", () => {
    const manifest = setManifest(3);
    const sealed = (edit: (body: Record<string, any>) => void) => {
      const body = { version: 1, kind: "cutover-set-activation-checkpoint", ...checkpointBody(manifest) } as Record<string, any>;
      edit(body);
      return { ...body, checksumSha256: cutoverSetActivationCheckpointSha256(body as CutoverSetActivationCheckpoint) };
    };
    const cases: readonly (readonly [string, RegExp, (body: Record<string, any>) => void])[] = [
      ["an extra key", /checkpoint is malformed/, (b) => { b.extra = 1; }],
      ["a wrong kind", /checkpoint is malformed/, (b) => { b.kind = "cutover-set-selection"; }],
      ["a malformed manifest", /manifest is malformed/, (b) => { b.manifest = { ...b.manifest, version: 2 }; }],
      ["a set id that is not the manifest's", /does not restate/, (b) => { b.setId = "cutover-set-2"; }],
      ["a publication id that is not the set id", /does not restate/, (b) => { b.publicationId = "other"; }],
      ["a missing member", /does not restate/, (b) => { b.members.pop(); }],
      ["reordered members", /member\[0\] is malformed/, (b) => { b.members.reverse(); }],
      ["a wrong generation", /member\[1\] is malformed/, (b) => { b.members[1].generationId = "member-generation-9"; }],
      ["a wrong project", /member\[2\] is malformed/, (b) => { b.members[2].physicalProjectId = HEX("0"); }],
      ["a malformed remote id", /member\[0\] is malformed/, (b) => { b.members[0].remoteProjectId = "nope"; }],
      ["a repeated remote id", /remote projects are not unique/, (b) => { b.members[1].remoteProjectId = b.members[0].remoteProjectId; }],
      ["an extra member key", /member\[0\] is malformed/, (b) => { b.members[0].extra = 1; }],
      ["a short digest", /member\[0\] is malformed/, (b) => { b.members[0].copyBindingSha256 = "abc"; }],
      ["a negative revision", /member\[0\] is malformed/, (b) => { b.members[0].epochManifestRevision = -1; }],
      ["a bad held journal checksum", /checkpoint is malformed/, (b) => { b.heldJournalChecksumSha256 = "zz"; }],
    ];
    for (const [label, pattern, edit] of cases) {
      it("refuses " + label, () => {
        expect(() => parseCutoverSetActivationCheckpoint(sealed(edit)))
          .toThrow(expect.objectContaining({ name: "CutoverSetActivationRecordError", reason: "invalid-input", message: expect.stringMatching(pattern) }));
      });
    }
    it("refuses a tampered field whose checksum was not recomputed and accepts a JSON round trip", () => {
      const checkpoint = createCutoverSetActivationCheckpoint(checkpointBody(manifest));
      expect(() => parseCutoverSetActivationCheckpoint({ ...checkpoint, heldJournalChecksumSha256: HEX("0") }))
        .toThrow(expect.objectContaining({ message: expect.stringMatching(/checksum does not match/) }));
      expect(parseCutoverSetActivationCheckpoint(JSON.parse(JSON.stringify(checkpoint)))).toEqual(checkpoint);
      expect(() => parseCutoverSetActivationCheckpoint(null)).toThrow(expect.objectContaining({ reason: "invalid-input" }));
    });
  });
});

describe("cutover-set activation selection", () => {
  it("requires the checkpoint, proves descent, then records, reuses and refuses different bytes", () => {
    const homeDir = home();
    const checkpoint = createCutoverSetActivationCheckpoint(checkpointBody(setManifest(3)));
    const selection = selectionFor(checkpoint);
    expect(() => recordCutoverSetActivationSelection({ homeDir, selection }))
      .toThrow(expect.objectContaining({ reason: "checkpoint-missing" }));
    recordCutoverSetActivationCheckpoint({ homeDir, checkpoint });
    const mismatches: readonly (readonly [string, (body: Record<string, any>) => void])[] = [
      ["checkpoint digest", (b) => { b.checkpointSha256 = HEX("0"); }],
      ["artifact identity digest", (b) => { b.identityDigest = HEX("0"); }],
      ["member member-generation-2", (b) => { b.members[1].remoteProjectId = "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9009"; }],
      ["member member-generation-1", (b) => { b.members[0].copyBindingSha256 = HEX("0"); }],
      ["member member-generation-3", (b) => { b.members[2].epochManifestRevision = 9; }],
      ["member member-generation-3", (b) => { b.members[2].epochManifestChecksumSha256 = HEX("0"); }],
    ];
    for (const [detail, edit] of mismatches) {
      expect(() => recordCutoverSetActivationSelection({ homeDir, selection: selectionFor(checkpoint, edit) }))
        .toThrow(expect.objectContaining({ reason: "selection-mismatch", message: expect.stringContaining(detail) }));
    }
    // Storage's parser governs shape: a wrong set id or a missing member is malformed, not a descent mismatch.
    expect(() => recordCutoverSetActivationSelection({ homeDir, selection: selectionFor(checkpoint, (b) => { b.members.pop(); }) }))
      .toThrow(expect.objectContaining({ reason: "invalid-input", message: expect.stringContaining("malformed") }));
    expect(() => recordCutoverSetActivationSelection({ homeDir, selection: { ...selection, checksumSha256: HEX("0") } }))
      .toThrow(expect.objectContaining({ reason: "invalid-input" }));
    // The tuple's own set id keys the lookup: another set has no checkpoint.
    expect(() => recordCutoverSetActivationSelection({ homeDir, selection: { ...selection, setId: "cutover-set-2" } }))
      .toThrow(expect.objectContaining({ reason: "checkpoint-missing" }));
    expect(recordFiles(homeDir)).toEqual(["checkpoint.json"]);
    recordCutoverSetActivationSelection({ homeDir, selection });
    recordCutoverSetActivationSelection({ homeDir, selection });
    expect(recordFiles(homeDir)).toEqual(["checkpoint.json", "selection.json"]);
    expect(readCutoverSetActivationRecords({ homeDir, setId: SET_ID })).toEqual({ state: "resolved", checkpoint, selection });
    const another = selectionFor(checkpoint, (b) => { b.members[0].witnessChecksumSha256 = HEX("0"); });
    expect(() => recordCutoverSetActivationSelection({ homeDir, selection: another })).toThrow(expect.objectContaining({ name: "MigrationBindingConflictError" }));
    expect(readCutoverSetActivationRecords({ homeDir, setId: SET_ID })).toEqual({ state: "resolved", checkpoint, selection });
    // The descent proof also refuses a manifest digest or count disagreement directly.
    expect(() => assertCutoverSetSelectionDescendsFromCheckpoint(checkpoint, { ...selection, manifestSha256: HEX("0") }))
      .toThrow(expect.objectContaining({ reason: "selection-mismatch", message: expect.stringContaining("manifest digest") }));
    expect(() => assertCutoverSetSelectionDescendsFromCheckpoint(checkpoint, { ...selection, members: selection.members.slice(0, 2) }))
      .toThrow(expect.objectContaining({ reason: "selection-mismatch", message: expect.stringContaining("member count") }));
    expect(() => assertCutoverSetSelectionDescendsFromCheckpoint(checkpoint, { ...selection, setId: "x" }))
      .toThrow(expect.objectContaining({ message: expect.stringContaining("set or publication id") }));
  });

  it("records refuse when the stored records cannot be trusted", () => {
    const homeDir = home();
    const checkpoint = createCutoverSetActivationCheckpoint(checkpointBody(setManifest(2)));
    recordCutoverSetActivationCheckpoint({ homeDir, checkpoint });
    const directory = migrationCutoverSetActivationDirectory(homeDir, SET_ID);
    writeFileSync(join(directory, "checkpoint.json"), "{}\n", { mode: 0o600 });
    expect(() => recordCutoverSetActivationSelection({ homeDir, selection: selectionFor(checkpoint) }))
      .toThrow(expect.objectContaining({ reason: "record-unresolvable" }));
  });
});

describe("readCutoverSetActivationRecords fails closed", () => {
  function stored(homeDir: string) {
    const checkpoint = createCutoverSetActivationCheckpoint(checkpointBody(setManifest(2)));
    recordCutoverSetActivationCheckpoint({ homeDir, checkpoint });
    const selection = selectionFor(checkpoint);
    recordCutoverSetActivationSelection({ homeDir, selection });
    return { checkpoint, selection, directory: migrationCutoverSetActivationDirectory(homeDir, SET_ID) };
  }
  const envelope = (setId: string, record: unknown) => canonicalJson({ version: 1, setId, record }) + "\n";

  it("reports a selection without its checkpoint as unresolvable, never as absence", () => {
    const homeDir = home();
    const { directory } = stored(homeDir);
    rmSync(join(directory, "checkpoint.json"));
    expect(readCutoverSetActivationRecords({ homeDir, setId: SET_ID })).toMatchObject({ state: "unresolvable", reason: expect.stringContaining("without its checkpoint") });
  });

  it("reports a corrupt, non-canonical, foreign-set or unknown entry as unresolvable", () => {
    const homeDir = home();
    const { checkpoint, selection, directory } = stored(homeDir);
    const cases: readonly (readonly [string, () => void, string])[] = [
      ["checkpoint.json", () => writeFileSync(join(directory, "checkpoint.json"), "not json\n", { mode: 0o600 }), "checkpoint.json cannot be trusted"],
      ["checkpoint.json", () => writeFileSync(join(directory, "checkpoint.json"), envelope("cutover-set-2", checkpoint), { mode: 0o600 }), "envelope is invalid"],
      ["checkpoint.json", () => writeFileSync(join(directory, "checkpoint.json"), JSON.stringify({ version: 1, setId: SET_ID, record: checkpoint }, null, 2) + "\n", { mode: 0o600 }), "not canonical"],
      ["checkpoint.json", () => writeFileSync(join(directory, "checkpoint.json"), envelope(SET_ID, { ...checkpoint, identityDigest: HEX("0") }), { mode: 0o600 }), "checksum does not match"],
      ["checkpoint.json", () => writeFileSync(join(directory, "checkpoint.json"), envelope(SET_ID, createCutoverSetActivationCheckpoint(checkpointBody(setManifest(2, "cutover-set-2")))), { mode: 0o600 }), "names another set"],
      ["selection.json", () => writeFileSync(join(directory, "selection.json"), envelope(SET_ID, { ...selection, checksumSha256: HEX("0") }), { mode: 0o600 }), "selection.json cannot be trusted"],
      ["selection.json", () => writeFileSync(join(directory, "selection.json"), envelope(SET_ID, selectionFor(checkpoint, (b) => { b.identityDigest = HEX("0"); })), { mode: 0o600 }), "does not descend"],
      ["extra", () => writeFileSync(join(directory, "extra.json"), "{}\n", { mode: 0o600 }), "unknown entry"],
    ];
    for (const [name, corrupt, expected] of cases) {
      const before = { checkpoint: readFileSync(join(directory, "checkpoint.json")), selection: readFileSync(join(directory, "selection.json")) };
      corrupt();
      expect(readCutoverSetActivationRecords({ homeDir, setId: SET_ID })).toMatchObject({ state: "unresolvable", reason: expect.stringContaining(expected) });
      if (name === "extra") rmSync(join(directory, "extra.json"));
      writeFileSync(join(directory, "checkpoint.json"), before.checkpoint, { mode: 0o600 });
      writeFileSync(join(directory, "selection.json"), before.selection, { mode: 0o600 });
    }
    expect(readCutoverSetActivationRecords({ homeDir, setId: SET_ID })).toEqual({ state: "resolved", checkpoint, selection });
  });

  it("ignores a byte-identical lone writer scratch twin and refuses any other lone scratch", () => {
    const homeDir = home();
    const { checkpoint, selection, directory } = stored(homeDir);
    writeFileSync(join(directory, ".checkpoint.json.0a1b.tmp"), readFileSync(join(directory, "checkpoint.json")), { mode: 0o600 });
    expect(readCutoverSetActivationRecords({ homeDir, setId: SET_ID })).toEqual({ state: "resolved", checkpoint, selection });
    writeFileSync(join(directory, ".selection.json.0a1b.tmp"), "other\n", { mode: 0o600 });
    expect(readCutoverSetActivationRecords({ homeDir, setId: SET_ID })).toMatchObject({ state: "unresolvable", reason: expect.stringContaining("scratch entry") });
  });

  it("reports an unauthenticated store directory as unresolvable and refuses malformed input", () => {
    const homeDir = home();
    const { directory } = stored(homeDir);
    chmodSync(directory, 0o755);
    expect(readCutoverSetActivationRecords({ homeDir, setId: SET_ID })).toMatchObject({ state: "unresolvable" });
    chmodSync(directory, 0o700);
    expect(() => readCutoverSetActivationRecords({ homeDir, setId: "../escape" })).toThrow();
    expect(() => readCutoverSetActivationRecords({ homeDir: "", setId: SET_ID })).toThrow();
    expect(() => recordCutoverSetActivationSelection({ homeDir, selection: undefined as unknown as BackendCutoverSetSelection })).toThrow();
  });
});

describe("resolveCutoverSetActivationSelection", () => {
  function sourcesDir(homeDir: string): string {
    const dir = join(homeDir, "sources");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }
  function material(homeDir: string, publicationId: string, projects: ActivationArtifactRecoveryMaterial["projects"]): ActivationArtifactRecoveryMaterial {
    const dir = sourcesDir(homeDir);
    const file = (name: string, content: string) => { const path = join(dir, name); writeFileSync(path, content, { mode: 0o600 }); return captureActivationRecoveryFile(path, dir); };
    return {
      version: 1, publicationId,
      source: { config: file("sc.json", '{"backend":"sqlite"}'), projectMap: file("sm.json", '{"map":{}}') },
      target: { config: file("tc.json", '{"backend":"postgresql"}'), projectMap: file("tm.json", '{"map":{}}') },
      projects,
    };
  }
  function setUp(homeDir: string, options: { selection?: boolean; artifact?: boolean; linkPublication?: string } = {}) {
    const manifest = setManifest(2);
    const rows = manifest.members.map((member, index) => ({ localProjectId: member.physicalProjectId, remoteProjectId: REMOTES[index]!, evidenceSha256: HEX(String(index + 5)) }));
    const identityDigest = computeActivationArtifactIdentityDigest(material(homeDir, SET_ID, rows));
    const checkpoint = createCutoverSetActivationCheckpoint(checkpointBody(manifest, (b) => { b.identityDigest = identityDigest; }));
    recordCutoverSetActivationCheckpoint({ homeDir, checkpoint });
    const selection = selectionFor(checkpoint);
    if (options.selection !== false) recordCutoverSetActivationSelection({ homeDir, selection });
    if (options.artifact !== false) publishActivationArtifact({ homeDir, material: material(homeDir, SET_ID, rows) });
    for (const member of checkpoint.members) {
      recordActivationGenerationLink({
        homeDir, generationId: member.generationId, publicationId: options.linkPublication ?? SET_ID, identityDigest,
        epochManifestRevision: member.epochManifestRevision, epochManifestChecksumSha256: member.epochManifestChecksumSha256,
      });
    }
    return { manifest, checkpoint, selection, identityDigest, rows };
  }

  it("resolves a member through its link to the checkpoint, selection, its own row and the covering artifact", () => {
    const homeDir = home();
    const { checkpoint, selection } = setUp(homeDir);
    const resolved = resolveCutoverSetActivationSelection({ homeDir, generationId: "member-generation-2", publicationId: SET_ID });
    expect(resolved).toMatchObject({ state: "resolved", setId: SET_ID, checkpoint, selection, member: selection.members[1] });
    if (resolved.state === "resolved") expect(resolved.artifact.projects).toHaveLength(2);
    expect(resolveCutoverSetActivationSelection({ homeDir, generationId: "member-generation-1" })).toMatchObject({ state: "resolved", member: selection.members[0] });
  });

  it("is absent for an unlinked generation and for a single-generation link, never a fallback", () => {
    const homeDir = home();
    setUp(homeDir);
    expect(resolveCutoverSetActivationSelection({ homeDir, generationId: "generation-9" })).toMatchObject({ state: "absent", detail: expect.stringContaining("no activation link") });
    recordActivationGenerationLink({ homeDir, generationId: "single-1", publicationId: deriveActivationPublicationId("single-1"), identityDigest: HEX("d"), epochManifestRevision: 1, epochManifestChecksumSha256: HEX("b") });
    expect(resolveCutoverSetActivationSelection({ homeDir, generationId: "single-1" })).toMatchObject({ state: "absent", detail: expect.stringContaining("single-generation") });
    expect(resolveCutoverSetActivationSelection({ homeDir, generationId: "member-generation-1", publicationId: "other-set" })).toMatchObject({ state: "unresolvable", reason: expect.stringContaining("not other-set") });
  });

  it("is unresolvable when the aggregate, the row, the link pair, the digest or the artifact does not authenticate", () => {
    const homeDir = home();
    const { checkpoint } = setUp(homeDir, { selection: false });
    expect(resolveCutoverSetActivationSelection({ homeDir, generationId: "member-generation-1" })).toMatchObject({ state: "unresolvable", reason: expect.stringContaining("no frozen selection") });
    const foreign = home();
    recordActivationGenerationLink({ homeDir: foreign, generationId: "member-generation-1", publicationId: SET_ID, identityDigest: HEX("d"), epochManifestRevision: 8, epochManifestChecksumSha256: HEX("b") });
    expect(resolveCutoverSetActivationSelection({ homeDir: foreign, generationId: "member-generation-1" })).toMatchObject({ state: "unresolvable", reason: expect.stringContaining("no set activation checkpoint") });
    const selection = selectionFor(checkpoint);
    recordCutoverSetActivationSelection({ homeDir, selection });
    // A link for a generation that is no row of the set, and a link whose frozen pair disagrees with the row.
    recordActivationGenerationLink({ homeDir, generationId: "member-generation-9", publicationId: SET_ID, identityDigest: checkpoint.identityDigest, epochManifestRevision: 8, epochManifestChecksumSha256: HEX("b") });
    expect(resolveCutoverSetActivationSelection({ homeDir, generationId: "member-generation-9" })).toMatchObject({ state: "unresolvable", reason: expect.stringContaining("no row") });
    expect(resolveCutoverSetActivationSelection({ homeDir, generationId: "member-generation-1" }, {
      readLink: () => ({ state: "resolved", path: "", link: { version: 1, generationId: "member-generation-1", publicationId: SET_ID, identityDigest: checkpoint.identityDigest, epochManifestRevision: 9, epochManifestChecksumSha256: HEX("b") } }),
    })).toMatchObject({ state: "unresolvable", reason: expect.stringContaining("does not agree") });
    expect(resolveCutoverSetActivationSelection({ homeDir, generationId: "member-generation-1" }, {
      readLink: () => ({ state: "unresolvable", reason: "malformed-record", detail: "injected" }),
    })).toMatchObject({ state: "unresolvable", reason: expect.stringContaining("injected") });
    expect(resolveCutoverSetActivationSelection({ homeDir, generationId: "member-generation-1" }, {
      readRecords: () => ({ state: "unresolvable", reason: "injected" }),
    })).toMatchObject({ state: "unresolvable", reason: expect.stringContaining("records are unresolvable") });
    // The artifact: absent, unreadable, sealed under another publication, or not covering exactly the members.
    expect(resolveCutoverSetActivationSelection({ homeDir, generationId: "member-generation-1" }, { readArtifact: () => null })).toMatchObject({ state: "unresolvable", reason: expect.stringContaining("is absent") });
    expect(resolveCutoverSetActivationSelection({ homeDir, generationId: "member-generation-1" }, { readArtifact: () => { throw new Error("injected read"); } })).toMatchObject({ state: "unresolvable", reason: expect.stringContaining("injected read") });
    const sealed = publishActivationArtifact({ homeDir, material: material(homeDir, "other", [{ localProjectId: HEX("0"), remoteProjectId: REMOTES[0]!, evidenceSha256: HEX("5") }]) }).material;
    expect(resolveCutoverSetActivationSelection({ homeDir, generationId: "member-generation-1" }, { readArtifact: () => sealed })).toMatchObject({ state: "unresolvable", reason: expect.stringContaining("another publication") });
    expect(resolveCutoverSetActivationSelection({ homeDir, generationId: "member-generation-1" }, { readArtifact: () => ({ ...sealed, publicationId: SET_ID }) })).toMatchObject({ state: "unresolvable", reason: expect.stringContaining("exactly the selection") });
    const resolved = resolveCutoverSetActivationSelection({ homeDir, generationId: "member-generation-1" });
    expect(resolved.state).toBe("resolved");
    if (resolved.state !== "resolved") return;
    expect(resolveCutoverSetActivationSelection({ homeDir, generationId: "member-generation-1" }, {
      readArtifact: () => ({ ...resolved.artifact, projects: resolved.artifact.projects.map((row, index) => index === 0 ? { ...row, evidenceSha256: HEX("0") } : row) }),
    })).toMatchObject({ state: "unresolvable", reason: expect.stringContaining("exactly the selection") });
  });

  it("throws on malformed input before any read", () => {
    expect(() => resolveCutoverSetActivationSelection({ homeDir: home(), generationId: "../x" })).toThrow();
    expect(() => createCutoverSetActivationCheckpoint({} as CreateCutoverSetActivationCheckpointInput)).toThrow(CutoverSetActivationRecordError);
  });
});

