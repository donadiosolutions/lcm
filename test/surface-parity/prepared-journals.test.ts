import { createHash } from "node:crypto";
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveGitProjectAnchor } from "../../src/git-project.js";
import { createGitFixture } from "./git-fixture.mjs";
import { assertJournalInputTransition, captureJournalInputs, discoveryForJournal } from "./journal-inputs.mjs";
import { capturePreparedInputs, capturePreparedJournals, capturePreparedMetadata, createPreparedCallRecorder, preparedCallSequence, preparedCase, validateJournalCall } from "./prepared-projects.mjs";

const homes: string[] = [];
const owner = process.getuid!();
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const time = "2026-09-08T12:34:56.123Z";
const remote = "00000000-0000-7000-8000-000000000001";
const reference = { aliases: ["/fixture/target"], sourceHashes: [], discovery: { mapFingerprint: "a".repeat(64), codexFingerprint: "b".repeat(64), complete: true } };
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "prepared-journals-")); homes.push(home);
  mkdirSync(join(home, ".lcm"), { mode: 0o700 });
  const target = "/fixture/target";
  const name = `${hash(target)}.json`;
  const path = join(home, ".lcm/reconciliations", name);
  const value = { version: 1, targetHash: hash(target), canonical: target, sourceHashes: [] as string[], aliases: [target],
    createdAt: time, updatedAt: time, phase: "completed", backupPaths: [] as string[], pendingSourceHashes: [] as string[], discovery: reference.discovery };
  const write = (journal = value, leaf = path) => {
    mkdirSync(dirname(leaf), { recursive: true, mode: 0o700 });
    writeFileSync(leaf, JSON.stringify(journal, null, 2) + "\n", { mode: 0o600 });
  };
  const operation = { target, reference, start: Date.parse(time), end: Date.parse(time) };
  return { home, path, name, value, write, operation, capture: () => capturePreparedJournals(home) };
}
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

describe("finite journal transitions", () => {
  it.each([false, true])("admits new exact journal with existing directory=%s", exists => {
    const f = fixture();
    if (exists) mkdirSync(dirname(f.path), { mode: 0o700 });
    const before = f.capture(); f.write();
    expect(validateJournalCall(before, f.capture(), f.operation, owner)).toContain(`reconciliations/${f.name}`);
  });
  it("preserves an exact completed fast path and forbids public show refresh", () => {
    const f = fixture(); f.write(); const before = f.capture();
    expect(validateJournalCall(before, f.capture(), f.operation, owner)).toEqual([]);
    f.write({ ...f.value, updatedAt: "2026-09-08T12:34:56.124Z" });
    expect(() => validateJournalCall(before, f.capture(), f.operation, owner)).toThrow();
    expect(() => validateJournalCall(before, f.capture(), undefined, owner)).toThrow();
  });
  it("refreshes old insertion order, retains history/remote/createdAt, deletes reason", () => {
    const f = fixture();
    const old = { ...f.value, remoteProjectId: remote, sourceHashes: ["c".repeat(64)], backupPaths: ["/fixture/archive"],
      reason: "old", discovery: { ...reference.discovery, mapFingerprint: "d".repeat(64) } };
    f.write(old); const before = f.capture();
    const next = { ...old, updatedAt: time, aliases: [...old.aliases, "/fixture/alias"], discovery: reference.discovery };
    delete (next as Partial<typeof old>).reason;
    f.write(next);
    expect(() => validateJournalCall(before, f.capture(), { ...f.operation, reference: { ...reference, aliases: next.aliases, remoteProjectId: "00000000-0000-7000-8000-000000000002" } }, owner)).not.toThrow();
    f.write({ ...next, remoteProjectId: "00000000-0000-7000-8000-000000000002" });
    expect(() => validateJournalCall(before, f.capture(), f.operation, owner)).toThrow();
  });
  it("does not fast-skip incomplete discovery even when both fingerprints match", () => {
    const f = fixture(); f.write({ ...f.value, discovery: { ...reference.discovery, complete: false } }); const before = f.capture();
    f.write({ ...f.value, updatedAt: "2026-09-08T12:34:56.124Z", discovery: { ...reference.discovery, complete: false } });
    expect(() => validateJournalCall(before, f.capture(), { ...f.operation, end: Date.parse(time) + 1,
      reference: { ...reference, discovery: { ...reference.discovery, complete: false } } }, owner)).not.toThrow();
  });
  it.each(["targetHash", "canonical", "remoteProjectId", "sourceHashes", "aliases", "backupPaths", "createdAt", "updatedAt", "discovery", "reason", "archiveAt", "fence", "sourceComponents"])("rejects new journal wrong %s", field => {
    const f = fixture(); const before = f.capture();
    const bad: Record<string, unknown> = { ...f.value };
    const values: Record<string, unknown> = { targetHash: "f".repeat(64), canonical: "/wrong", remoteProjectId: remote,
      sourceHashes: ["e".repeat(64)], aliases: ["/wrong"], backupPaths: ["/wrong"], createdAt: "2026-09-08T12:34:56.122Z",
      updatedAt: "2026-09-08T12:34:56.124Z", discovery: { ...reference.discovery, mapFingerprint: "e".repeat(64) }, reason: "extra", archiveAt: time, fence: {}, sourceComponents: {} };
    bad[field] = values[field]; f.write(bad as typeof f.value);
    expect(() => validateJournalCall(before, f.capture(), f.operation, owner)).toThrow();
  });
  it.each(["mode", "hardlink", "unknown-child", "serialization", "directory-mode", "device", "directory-inode", "directory-nlink", "owner", "new-device", "new-gid"])("rejects %s authority or bytes", kind => {
    const f = fixture(); if (!["new-device", "new-gid"].includes(kind)) mkdirSync(dirname(f.path), { mode: 0o700 }); const before = f.capture(); f.write();
    if (kind === "mode") chmodSync(f.path, 0o644);
    if (kind === "hardlink") linkSync(f.path, join(f.home, "alias"));
    if (kind === "unknown-child") writeFileSync(join(dirname(f.path), `${hash("lock")}.lock`), "lock", { mode: 0o600 });
    if (kind === "serialization") writeFileSync(f.path, JSON.stringify(f.value), { mode: 0o600 });
    if (kind === "directory-mode") chmodSync(dirname(f.path), 0o755);
    expect(() => {
      const after = f.capture();
      if (kind === "device") after.leaves[f.name].witness.dev++;
      if (kind === "new-device") { after.directory.dev++; after.leaves[f.name].witness.dev++; }
      if (kind === "new-gid") { after.directory.gid++; after.leaves[f.name].witness.gid++; }
      if (kind === "directory-inode") after.directory.inode++;
      if (kind === "directory-nlink") after.directory.nlink++;
      if (kind === "owner") after.leaves[f.name].witness.uid++;
      validateJournalCall(before, after, f.operation, owner);
    }).toThrow();
  });
  it("rejects unrelated rewrite and disappearing old leaf", () => {
    const f = fixture(); f.write(); const before = f.capture();
    f.write({ ...f.value, updatedAt: "2026-09-08T12:34:56.124Z" });
    expect(() => validateJournalCall(before, f.capture(), undefined, owner)).toThrow();
    rmSync(f.path); expect(() => validateJournalCall(before, f.capture(), undefined, owner)).toThrow();
  });
});

function recorderFixture(caseId = "identity-roots", backend = "postgresql") {
  const f = fixture();
  const paths = { homeDir: f.home, projectPath: join(f.home, "projects/primary") };
  createGitFixture(paths.projectPath);
  const scenario = ({ "identity-roots": "identity", "identity-rebound": "identity", "events-operator": "events", "events-notify": "events", "import-collisions": "native-import", "promotion-root": "promotion", "sensitive-files": "sensitive" } as Record<string, string>)[caseId];
  const targets = preparedCase(caseId, scenario, paths);
  const mapPath = join(f.home, ".lcm/map.json");
  let map: Record<string, { canonical: string; aliases: string[]; remoteProjectId?: string }> = {};
  if (caseId === "identity-rebound") {
    createGitFixture(targets[0]); map[hash(targets[0])] = { canonical: targets[0], aliases: [] };
  }
  const publishMap = () => writeFileSync(mapPath, JSON.stringify(map, null, 2) + "\n", { mode: 0o600 });
  publishMap();
  const before = { metadata: capturePreparedMetadata(f.home), inputs: capturePreparedInputs(paths) };
  const capturedPaths = [...targets, ...(caseId === "identity-roots" ? [join(dirname(paths.projectPath), "surface-identity-alias")] : [])];
  let enrichedOverride: typeof map | undefined;
  const capture = (value: typeof map) => captureJournalInputs(f.home, value, { resolveGitProjectAnchor, paths: capturedPaths });
  const recorder = createPreparedCallRecorder({ caseId, scenario, paths, backend, before,
    readEnrichedMap: () => enrichedOverride ?? JSON.parse(readFileSync(mapPath, "utf8")), captureInputs: () => capturePreparedInputs(paths),
    captureDiscoveryInputs: capture, assertDiscoveryTransition: assertJournalInputTransition, discoveryForJournal, owner });
  const sequence = preparedCallSequence(caseId, scenario, paths, backend);
  const createRoots = (count = capturedPaths.length) => { for (const path of capturedPaths.slice(0, count)) if (!before.inputs[path]) createGitFixture(path,
    caseId === "import-collisions" ? { remote: "https://example.invalid/parity-import.git" } : {}); };
  const perform = (index: number) => {
    const spec = sequence[index];
    const launch = recorder.beforeCall(spec.args, { cwd: spec.cwd }); launch();
    if (spec.target) {
      const path = join(f.home, ".lcm/reconciliations", `${hash(spec.target)}.json`);
      const prior = capturePreparedJournals(f.home).leaves[`${hash(spec.target)}.json`]?.value;
      const ref = discoveryForJournal(capture(map), map, spec.target);
      if (!prior || JSON.stringify(prior.discovery) !== JSON.stringify(ref.discovery) || !ref.discovery.complete) {
        const now = new Date().toISOString();
        const value = prior ?? { version: 1, targetHash: hash(spec.target), canonical: spec.target, sourceHashes: [], aliases: ref.aliases,
          ...(ref.remoteProjectId ? { remoteProjectId: ref.remoteProjectId } : {}), createdAt: now, updatedAt: now, phase: "completed", backupPaths: [] };
        value.aliases = [...new Set([...value.aliases, ...ref.aliases])]; value.pendingSourceHashes = []; value.discovery = ref.discovery;
        value.phase = "completed"; delete value.reason; value.updatedAt = now;
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
      }
    }
    if (spec.transition) {
      const id = hash(spec.transition); map[id] ??= { canonical: spec.transition, aliases: [] };
      if (backend === "postgresql" && caseId !== "sensitive-files") map[id].remoteProjectId = remote;
      publishMap();
    }
    const result = { code: 0, stdout: spec.transition ? JSON.stringify({ local: { id: hash(spec.transition), ...map[hash(spec.transition)] }, remote: { projectId: remote } }) : "", stderr: "" };
    recorder.afterCall(result, Date.now());
  };
  return { ...f, recorder, sequence, targets, createRoots, perform, mapPath, paths,
    override: (value: typeof map) => { enrichedOverride = value; }, publish: (value: typeof map) => { map = value; publishMap(); } };
}

describe("exact original stopped call recorder", () => {
  it.each(["identity-roots", "identity-rebound", "events-operator", "events-notify", "promotion-root", "sensitive-files"])("admits exact %s sequence and timestamps", caseId => {
    const f = recorderFixture(caseId); f.createRoots();
    for (let i = 0; i < f.sequence.length; i++) f.perform(i);
    expect(f.recorder.finish().calls).toHaveLength(f.sequence.length);
    expect(() => f.recorder.finish()).toThrow("call-complete");
  });
  it("admits collision A/owner-A/B/owner-B without loading B early", () => {
    const f = recorderFixture("import-collisions");
    for (let index = 0; index < 2; index++) {
      f.createRoots(index + 1); f.perform(index);
      const ownerPath = join(f.targets[index], ".git/worktrees/parity-owner/codex-thread.json");
      mkdirSync(dirname(ownerPath), { recursive: true, mode: 0o700 });
      writeFileSync(ownerPath, '{"version":1,"ownerThreadId":"parity-ambiguous"}\n', { mode: 0o600 });
    }
    expect(f.recorder.finish().calls).toHaveLength(2);
  });
  it("sensitive first add and duplicate refresh then exact later skips", () => {
    const f = recorderFixture("sensitive-files", "sqlite"); f.createRoots();
    for (let i = 0; i < f.sequence.length; i++) f.perform(i);
    expect(f.recorder.finish().calls.filter((call: { target?: string }) => call.target)).toHaveLength(7);
  });
  it.each(["wrong", "missing", "repeated", "enriched", "prefix", "future-target"])("rejects %s call/input", kind => {
    const f = recorderFixture(kind === "future-target" ? "import-collisions" : "identity-roots"); f.createRoots();
    if (kind === "enriched") f.override({ wrong: { canonical: "/wrong", aliases: [] } });
    if (kind === "prefix") f.publish({ wrong: { canonical: "/wrong", aliases: [] } });
    expect(() => {
      if (kind === "missing") f.recorder.finish();
      else if (kind === "wrong") f.recorder.beforeCall(["project", "show", f.targets[0], "--json"]);
      else if (kind === "repeated") { f.perform(0); f.recorder.beforeCall(f.sequence[0].args); }
      else f.perform(0);
    }).toThrow();
  });
});
