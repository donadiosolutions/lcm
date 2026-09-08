import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createGitFixture } from "./git-fixture.mjs";
import { describe, expect, it } from "vitest";
import { capturePreparedInputs, validatePreparedInputs, createAdmissionLedger, preparedCase, runPreparedCase, SCENARIO_ORDER, validatePreparedCatalog, validatePreparedDelta } from "./prepared-projects.mjs";

const owner = 1000;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const paths = { homeDir: "/fixture/home", projectPath: "/fixture/projects/primary" };
const caseSequence: Record<string, string[]> = {
  identity: ["identity-roots", "identity-rebound"], events: ["events-operator", "events-notify"],
  "native-import": ["import-collisions"], sensitive: ["sensitive-files"], promotion: ["promotion-root"],
};

function lifecycle() {
  const trace: string[] = [];
  const before = { witness: "before" };
  const after = { witness: "after" };
  const bundle = { original: true };
  const previous = { pid: 10, generation: 1, port: 32100 };
  const current = { pid: 11, generation: 2, port: 32100 };
  let failure: unknown;
  const operations = {
    assertAdmitted() { if (failure) throw failure; trace.push("admitted"); },
    async settle() { trace.push("effects-complete"); },
    async stop() { trace.push("stop-owned-publishers"); return previous; },
    assertStopped() { trace.push("owned-pids-absent"); },
    async captureBefore() { trace.push("before"); return before; },
    async captureAfter(value: unknown) { expect(value).toBe(bundle); trace.push("after"); return after; },
    async validate(first: unknown, last: unknown, value: unknown) {
      expect(first).toBe(before); expect(last).toBe(after); expect(value).toBe(bundle); trace.push("delta");
    },
    async start(port: number) { expect(port).toBe(previous.port); trace.push("start"); return current; },
    async captureRestart() { trace.push("restart-snapshot"); return after; },
    assertRestartUnchanged(value: unknown, baseline: unknown) {
      expect(value).toBe(after); expect(baseline).toBe(after); trace.push("original-restart-comparator");
    },
    complete() { trace.push("complete"); },
    fail(error: unknown) { if (!failure) { failure = error; trace.push("fail"); } return failure; },
  };
  const setup = async () => { trace.push("existing-cli-once"); return bundle; };
  return { trace, operations, setup, bundle, current };
}

describe("prepared lifetime admission", () => {
  it("captures BEFORE setup, validates before startup, and returns the original result once", async () => {
    const fixture = lifecycle();
    expect(await runPreparedCase(fixture.operations, fixture.setup)).toBe(fixture.bundle);
    expect(fixture.trace).toEqual(["admitted", "effects-complete", "stop-owned-publishers", "owned-pids-absent", "before",
      "existing-cli-once", "owned-pids-absent", "after", "delta", "start", "restart-snapshot", "original-restart-comparator", "complete"]);
  });

  it.each(["settle", "stop", "captureBefore", "captureAfter", "validate", "start", "captureRestart"] as const)(
    "retains the identical %s failure and refuses readmission", async stage => {
      const fixture = lifecycle();
      const primary = new Error(`failed-${stage}`);
      Object.assign(fixture.operations, { [stage]: async () => { throw primary; } });
      await expect(runPreparedCase(fixture.operations, fixture.setup)).rejects.toBe(primary);
      const stoppedTrace = [...fixture.trace];
      await expect(runPreparedCase(fixture.operations, fixture.setup)).rejects.toBe(primary);
      expect(fixture.trace).toEqual(stoppedTrace);
      expect(fixture.trace).not.toContain("complete");
      if (["settle", "stop", "captureBefore", "captureAfter", "validate"].includes(stage)) expect(fixture.trace).not.toContain("start");
    },
  );

  it("retains a nonzero CLI error despite later cleanup failure and never retries setup", async () => {
    const fixture = lifecycle();
    const primary = Object.assign(new Error("handled-cli-failure"), { code: 1 });
    let calls = 0;
    const setup = async () => { calls++; throw primary; };
    await expect(runPreparedCase(fixture.operations, setup)).rejects.toBe(primary);
    expect(fixture.operations.fail(new Error("cleanup"))).toBe(primary);
    await expect(runPreparedCase(fixture.operations, setup)).rejects.toBe(primary);
    expect(calls).toBe(1);
    expect(fixture.trace).not.toContain("start");
  });

  it.each(["pid", "generation", "port"] as const)("rejects an invalid restarted %s before completion", async field => {
    const fixture = lifecycle();
    fixture.current[field] = field === "pid" ? 10 : field === "generation" ? 1 : 32101;
    await expect(runPreparedCase(fixture.operations, fixture.setup)).rejects.toThrow("new-lifetime");
    expect(fixture.trace).not.toContain("restart-snapshot");
    expect(fixture.trace).not.toContain("complete");
  });

  it("cannot run setup when an owned publisher survives stop", async () => {
    const fixture = lifecycle();
    const error = new Error("owned-publisher-survives");
    fixture.operations.assertStopped = () => { throw error; };
    await expect(runPreparedCase(fixture.operations, fixture.setup)).rejects.toBe(error);
    expect(fixture.trace).not.toContain("existing-cli-once");
  });
});

describe("positive completion ledger", () => {
  it("admits the fixed complete scenario and case order through faults", () => {
    const ledger = createAdmissionLedger();
    for (const scenario of SCENARIO_ORDER) {
      ledger.begin(scenario);
      for (const caseId of caseSequence[scenario] ?? []) { ledger.beginCase(caseId); ledger.completeCase(caseId); }
      ledger.complete(scenario);
    }
    expect(() => ledger.begin("identity")).toThrow();
  });

  it("rejects unknown, out-of-order, concurrent, repeated and unbegun scenarios", () => {
    for (const scenario of ["unknown", "admin", "fault-denial"]) expect(() => createAdmissionLedger().begin(scenario)).toThrow();
    const ledger = createAdmissionLedger();
    expect(() => ledger.complete("identity")).toThrow();
    ledger.begin("identity");
    expect(() => ledger.begin("identity")).toThrow();
    expect(() => ledger.beginCase("identity-rebound")).toThrow();
    expect(() => ledger.beginCase("unknown")).toThrow();
    ledger.beginCase("identity-roots"); ledger.completeCase("identity-roots");
    expect(() => ledger.beginCase("identity-roots")).toThrow();
  });

  it("rejects concurrent setup and completion without its own begin", () => {
    const ledger = createAdmissionLedger();
    ledger.begin("identity");
    expect(() => ledger.completeCase("identity-roots")).toThrow();
    ledger.beginCase("identity-roots");
    expect(() => ledger.beginCase("identity-roots")).toThrow();
    expect(() => ledger.beginCase("identity-rebound")).toThrow();
    expect(() => ledger.completeCase("identity-rebound")).toThrow();
    ledger.completeCase("identity-roots");
    expect(() => ledger.completeCase("identity-roots")).toThrow();
  });

  it("requires every named setup receipt before diagnostics", () => {
    const ledger = createAdmissionLedger();
    for (const scenario of SCENARIO_ORDER.slice(0, SCENARIO_ORDER.indexOf("diagnostics"))) {
      ledger.begin(scenario); ledger.complete(scenario);
    }
    expect(() => ledger.begin("diagnostics")).toThrow("complete-cases");
  });

  it.each(["live-ingest", "live-alias", "live-hook"])("green setup followed by %s failure closes all dependent admission", liveCase => {
    const ledger = createAdmissionLedger();
    ledger.begin("identity"); ledger.beginCase("identity-roots"); ledger.completeCase("identity-roots");
    const primary = new Error(liveCase);
    expect(ledger.fail(primary)).toBe(primary);
    expect(ledger.fail(new Error("cleanup"))).toBe(primary);
    for (const action of [() => ledger.complete("identity"), () => ledger.beginCase("identity-rebound"),
      () => ledger.completeCase("identity-rebound"), () => ledger.begin("admin"), () => ledger.begin("fault-denial"), () => ledger.assertHealthy()]) {
      try { action(); expect.fail("terminal admission unexpectedly reopened"); } catch (error) { expect(error).toBe(primary); }
    }
  });
});

type Entry = { kind: string; mode: number; uid: number; gid: number; nlink: number; inode: number; dev: number;
  sha256?: string; bytes?: number; children?: string[]; sqliteFile?: boolean;
  database?: { schemaSha256: string; tables: { messages: { rows: number; sha256: string } }; userVersion: number; journalMode: string } };
function deltaFixture(backend = "sqlite") {
  const file = { kind: "file", mode: 0o100600, uid: owner, gid: owner, nlink: 1, inode: 10, dev: 1, sha256: "bytes", bytes: 4096 };
  const map = { existing: { canonical: "/fixture/existing", aliases: [] } };
  const mapFile = { ...file, sha256: digest(JSON.stringify(map, null, 2) + "\n") };
  const directory = { kind: "directory", mode: 0o40700, uid: owner, gid: owner, nlink: 2, inode: 2, dev: 1 };
  const entries: Record<string, Entry> = {
    "map.json": mapFile, "config.json": { ...file, inode: 3 },
    projects: { ...directory, children: ["existing"] },
    "projects/existing": { ...directory, inode: 4, children: ["db.sqlite", "db.sqlite-wal"] },
    "projects/existing/db.sqlite": { ...file, sqliteFile: true, database: { schemaSha256: "schema", tables: { messages: { rows: 2, sha256: "original-rows" } }, userVersion: 1, journalMode: "wal" } },
    "projects/existing/db.sqlite-wal": { ...file, inode: 11 },
  };
  const before = { authority: { backend, machine: "machine", root: 1, publication: "original" },
    metadata: { map: map as Record<string, { canonical: string; aliases: string[]; remoteProjectId?: string }>, mapFile,
      backups: { "map-1.json": { ...mapFile } } as Record<string, typeof mapFile>, backupRoot: { ...directory } },
    logical: { entries, nativeCounts: { messages: 2 }, postgresql: { tables: "original" } }, catalogValidated: true };
  return { caseId: "identity-roots", scenario: "identity", paths, backend, owner, bundle: { caseId: "identity-roots", created: [] }, before, after: structuredClone(before) };
}

describe("stopped setup delta proof", () => {
  it("admits a SQLite no-mutation case without manufacturing a created identity", () => {
    expect(() => validatePreparedDelta(deltaFixture())).not.toThrow();
  });

  it.each([
    ["deleted old map", (f: ReturnType<typeof deltaFixture>) => { delete f.after.metadata.map.existing; }],
    ["authority", (f: ReturnType<typeof deltaFixture>) => { f.after.authority.publication = "changed"; }],
    ["old backup", (f: ReturnType<typeof deltaFixture>) => { f.after.metadata.backups["map-1.json"].sha256 = "changed"; }],
    ["backup directory", (f: ReturnType<typeof deltaFixture>) => { f.after.metadata.backupRoot.inode++; }],
    ["map owner", (f: ReturnType<typeof deltaFixture>) => { f.after.metadata.mapFile.uid++; }],
    ["configuration", (f: ReturnType<typeof deltaFixture>) => { f.after.logical.entries["config.json"].sha256 = "changed"; }],
    ["old native row with unchanged count", (f: ReturnType<typeof deltaFixture>) => { f.after.logical.entries["projects/existing/db.sqlite"].database!.tables.messages.sha256 = "changed-row"; }],
    ["WAL inode", (f: ReturnType<typeof deltaFixture>) => { f.after.logical.entries["projects/existing/db.sqlite-wal"].inode++; }],
    ["unexpected leaf", (f: ReturnType<typeof deltaFixture>) => { f.after.logical.entries["unexpected.txt"] = { ...f.after.logical.entries["config.json"] }; }],
    ["new project database", (f: ReturnType<typeof deltaFixture>) => { f.after.logical.entries["projects/new/db.sqlite"] = { ...f.after.logical.entries["projects/existing/db.sqlite"] }; }],
  ] as const)("rejects %s before a restart could preserve and disguise it", (_name, mutate) => {
    const fixture = deltaFixture(); mutate(fixture);
    expect(() => validatePreparedDelta(fixture)).toThrow();
  });

  it("rejects unknown case/scenario pairs", () => {
    expect(() => preparedCase("unknown", "identity", paths)).toThrow("case-scenario");
    expect(() => preparedCase("identity-roots", "events", paths)).toThrow("case-scenario");
  });

  it("requires an independent PostgreSQL catalog witness even for local-only sensitive setup", () => {
    const fixture = deltaFixture("postgresql");
    fixture.caseId = fixture.bundle.caseId = "sensitive-files"; fixture.scenario = "sensitive";
    const path = preparedCase(fixture.caseId, fixture.scenario, paths)[0];
    const id = digest(path);
    fixture.after.metadata.map[id] = { canonical: path, aliases: [] };
    fixture.after.metadata.mapFile.sha256 = digest(JSON.stringify(fixture.after.metadata.map, null, 2) + "\n");
    fixture.after.metadata.backups["map-2.json"] = { ...fixture.before.metadata.mapFile };
    const directory = `projects/${id}`;
    fixture.after.logical.entries.projects.nlink++;
    fixture.after.logical.entries.projects.children!.push(id);
    fixture.after.logical.entries[directory] = { ...fixture.before.logical.entries["projects/existing"], children: ["sensitive-patterns.txt"] };
    fixture.after.logical.entries[`${directory}/sensitive-patterns.txt`] = { ...fixture.before.logical.entries["config.json"], sha256: digest("\n"), bytes: 1 };
    expect(() => validatePreparedDelta({ ...fixture, umask: 0o077 })).not.toThrow();
    fixture.after.logical.entries[`${directory}/sensitive-patterns.txt`].bytes = 0;
    expect(() => validatePreparedDelta({ ...fixture, umask: 0o077 })).toThrow("sensitive-empty-pattern");
    fixture.after.logical.entries[`${directory}/sensitive-patterns.txt`].bytes = 1;
    expect(() => validatePreparedDelta({ ...fixture, umask: 0o022 })).toThrow("sensitive-directory");
    fixture.after.catalogValidated = false;
    expect(() => validatePreparedDelta({ ...fixture, umask: 0o077 })).toThrow("catalog-required");
  });
});


function catalogFixture() {
  const oldId = "00000000-0000-7000-8000-000000000001";
  const newId = "00000000-0000-7000-8000-000000000002";
  const machine = "00000000-0000-7000-8000-000000000003";
  const time = "2026-09-08T12:34:56.123Z";
  const project = { project_id: oldId, identity_key: "a".repeat(64), display_name: "old", created_at: time, updated_at: time };
  const alias = { project_id: oldId, machine_id: machine, path: "/fixture/old", normalized_path: "/fixture/old", linked_at: time };
  const empty = { messageCount: 0, summaryCount: 0, promotedCount: 0 };
  const before = { projects: [project], aliases: [alias], snapshot: {
    counts: { projects: 1, messages: 2 }, projectIds: [oldId],
    projectCounts: { [oldId]: { ...empty, messageCount: 2 } }, conversations: [{ projectId: oldId }],
    tables: { projects: "old-projects", project_aliases: "old-aliases", messages: "original-rows" }, schema: "original-schema",
  } };
  const after = structuredClone(before);
  after.projects.push({ ...project, project_id: newId, identity_key: "b".repeat(64), display_name: "new", created_at: "2026-09-08 12:34:56.123+00", updated_at: "2026-09-08 12:34:56.123+00" });
  after.aliases.push({ ...alias, project_id: newId, path: "/fixture/new", normalized_path: "/fixture/new", linked_at: "2026-09-08 12:34:56.123+00" });
  after.snapshot.counts.projects++;
  after.snapshot.projectIds.push(newId);
  after.snapshot.projectCounts[newId] = { ...empty };
  after.snapshot.tables.projects = "new-projects";
  after.snapshot.tables.project_aliases = "new-aliases";
  const created = [{ remote: { projectId: newId, displayName: "new", createdAt: time, updatedAt: time,
    aliases: [{ machineId: machine, path: "/fixture/new", normalizedPath: "/fixture/new", linkedAt: time }] } }];
  return { before, after, created, newId };
}

describe("independent prepared catalog readback", () => {
  it("admits only an empty addition matching the actual returned remote timestamps", () => {
    const f = catalogFixture();
    expect(validatePreparedCatalog(f.before, f.after, f.created)).toEqual({ validated: true, added: 1 });
  });

  it.each([
    ["old project row with same count", (f: ReturnType<typeof catalogFixture>) => { f.after.projects[0].display_name = "changed"; }],
    ["old alias row with same count", (f: ReturnType<typeof catalogFixture>) => { f.after.aliases[0].path = "/changed"; }],
    ["wrong new UUID", (f: ReturnType<typeof catalogFixture>) => { f.after.projects[1].project_id = "00000000-0000-7000-8000-000000000099"; }],
    ["invalid returned UUID", (f: ReturnType<typeof catalogFixture>) => { f.created[0].remote.projectId = "invalid"; }],
    ["wrong path", (f: ReturnType<typeof catalogFixture>) => { f.after.aliases[1].path = "/wrong"; }],
    ["wrong machine", (f: ReturnType<typeof catalogFixture>) => { f.after.aliases[1].machine_id = "00000000-0000-7000-8000-000000000099"; }],
    ["invalid identity key", (f: ReturnType<typeof catalogFixture>) => { f.after.projects[1].identity_key = "bad-key"; }],
    ["schema", (f: ReturnType<typeof catalogFixture>) => { f.after.snapshot.schema = "changed"; }],
    ["noncatalog rows", (f: ReturnType<typeof catalogFixture>) => { f.after.snapshot.tables.messages = "changed-same-count"; }],
    ["new project data", (f: ReturnType<typeof catalogFixture>) => { f.after.snapshot.projectCounts[f.newId].messageCount = 1; }],
    ["new conversation", (f: ReturnType<typeof catalogFixture>) => { f.after.snapshot.conversations.push({ projectId: f.newId }); }],
    ["extra project row", (f: ReturnType<typeof catalogFixture>) => { f.after.projects.push({ ...f.after.projects[1], project_id: "00000000-0000-7000-8000-000000000099" }); }],
    ["duplicate alias key", (f: ReturnType<typeof catalogFixture>) => { f.after.aliases.push({ ...f.after.aliases[1] }); }],
    ["missing old row", (f: ReturnType<typeof catalogFixture>) => { f.after.projects.shift(); }],
    ["returned timestamp mismatch", (f: ReturnType<typeof catalogFixture>) => { f.created[0].remote.createdAt = "2026-09-09T12:34:56.123Z"; }],
  ] as const)("rejects %s", (_name, mutate) => {
    const f = catalogFixture(); mutate(f);
    expect(() => validatePreparedCatalog(f.before, f.after, f.created)).toThrow();
  });

  it("requires zero-addition sensitive setup to preserve all existing catalog and native rows", () => {
    const f = catalogFixture();
    const after = structuredClone(f.before);
    expect(validatePreparedCatalog(f.before, after, [])).toEqual({ validated: true, added: 0 });
    after.snapshot.tables.messages = "changed-same-count";
    expect(() => validatePreparedCatalog(f.before, after, [])).toThrow();
    expect(() => validatePreparedCatalog(f.before, f.after, [])).toThrow();
  });
});

type Created = { path: string; identity: { id: string; canonical: string; remoteProjectId?: string };
  parsed: { local: { id: string; canonical: string; remoteProjectId?: string }; remote: { projectId: string; aliases: { path: string; normalizedPath: string; machineId: string }[] } };
  result: { code: number; stdout: string } };
function publishedFixture(caseId: string, backend: string) {
  const base = deltaFixture(backend);
  const scenario = caseId === "import-collisions" ? "native-import" : "identity";
  const targets = preparedCase(caseId, scenario, paths);
  if (caseId === "identity-rebound") {
    base.before.metadata.map[digest(targets[0])] = { canonical: targets[0], aliases: [] };
    base.before.metadata.mapFile.sha256 = digest(JSON.stringify(base.before.metadata.map, null, 2) + "\n");
  }
  const after = structuredClone(base.before);
  const created: Created[] = [];
  const publish = () => {
    after.metadata.backups[`map-${Object.keys(after.metadata.backups).length + 1}.json`] = {
      ...after.metadata.mapFile, sha256: digest(JSON.stringify(after.metadata.map, null, 2) + "\n"),
    };
  };
  for (const [index, path] of targets.entries()) {
    const id = digest(path);
    const remoteProjectId = `00000000-0000-7000-8000-00000000000${index + 1}`;
    const local = { id, canonical: path, ...(backend === "postgresql" ? { remoteProjectId } : {}) };
    const parsed = { local, remote: { projectId: remoteProjectId, aliases: [{ path, normalizedPath: path, machineId: "00000000-0000-7000-8000-000000000009" }] } };
    created.push({ path, identity: local, parsed, result: { code: 0, stdout: JSON.stringify(parsed) } });
    if (caseId !== "identity-rebound") { publish(); after.metadata.map[id] = { canonical: path, aliases: [] }; }
    if (backend === "postgresql") { publish(); after.metadata.map[id].remoteProjectId = remoteProjectId; }
  }
  after.metadata.mapFile.sha256 = digest(JSON.stringify(after.metadata.map, null, 2) + "\n");
  return { ...base, caseId, scenario, after, bundle: { caseId, created } };
}

describe("finite result-backed map publication", () => {
  it.each([
    ["identity-roots", "postgresql", 4], ["identity-rebound", "postgresql", 1], ["import-collisions", "sqlite", 2],
  ] as const)("admits %s on %s with exactly %i prior-map backups", (caseId, backend, count) => {
    const f = publishedFixture(caseId, backend);
    expect(Object.keys(f.after.metadata.backups).length - Object.keys(f.before.metadata.backups).length).toBe(count);
    expect(() => validatePreparedDelta(f)).not.toThrow();
  });

  it.each(["identity-roots", "identity-rebound", "import-collisions"])("rejects missing, extra and altered %s backup publications", caseId => {
    for (const mutation of ["missing", "extra", "changed", "device"]) {
      const f = publishedFixture(caseId, caseId === "import-collisions" ? "sqlite" : "postgresql");
      const key = Object.keys(f.after.metadata.backups).at(-1)!;
      if (mutation === "missing") delete f.after.metadata.backups[key];
      if (mutation === "extra") f.after.metadata.backups["map-999.json"] = { ...f.after.metadata.backups[key] };
      if (mutation === "changed") f.after.metadata.backups[key].sha256 = "wrong-intermediate-map";
      if (mutation === "device") f.after.metadata.backups[key].dev++;
      expect(() => validatePreparedDelta(f)).toThrow();
    }
  });

  it.each(["identity-roots", "identity-rebound", "import-collisions"])("rejects %s result-path, local identity and final-map drift", caseId => {
    for (const mutation of ["path", "local", "map"]) {
      const f = publishedFixture(caseId, caseId === "import-collisions" ? "sqlite" : "postgresql");
      if (mutation === "path") f.bundle.created[0].path = "/wrong";
      if (mutation === "local") { f.bundle.created[0].identity.id = "wrong"; f.bundle.created[0].parsed.local.id = "wrong"; }
      if (mutation === "map") f.after.metadata.map[digest(f.bundle.created[0].path)].aliases.push("/unexpected-alias");
      expect(() => validatePreparedDelta(f)).toThrow();
    }
  });

  it("rejects an unobserved metadata leaf and a mismatched logical map witness", () => {
    const f = publishedFixture("identity-roots", "postgresql");
    Object.assign(f.before.metadata, { otherLeaves: {} });
    Object.assign(f.after.metadata, { otherLeaves: { "unexpected.json": { sha256: "unexpected" } } });
    expect(() => validatePreparedDelta(f)).toThrow();
    Object.assign(f.after.metadata, { otherLeaves: {} });
    f.after.logical.entries["map.json"] = { ...f.after.logical.entries["map.json"], sha256: "detached-map" };
    expect(() => validatePreparedDelta(f)).toThrow("map-capture");
  });

  it("rejects parsed results detached from actual successful CLI output", () => {
    const f = publishedFixture("identity-roots", "postgresql");
    f.bundle.created[0].result.stdout = JSON.stringify({ fake: true });
    expect(() => validatePreparedDelta(f)).toThrow("actual-cli-result");
    f.bundle.created[0].result.code = 1;
    expect(() => validatePreparedDelta(f)).toThrow("cli-result");
  });

  it("rejects a rebound without an existing independent unbound local identity", () => {
    const f = publishedFixture("identity-rebound", "postgresql");
    delete f.before.metadata.map[digest(f.bundle.created[0].path)];
    expect(() => validatePreparedDelta(f)).toThrow("rebound-independent");
  });
});

function inputsFixture(caseId = "identity-roots") {
  const homeDir = mkdtempSync(join(tmpdir(), "surface-prepared-inputs-"));
  const ownedPaths = { homeDir, projectPath: join(homeDir, "projects", "primary") };
  const scenario = caseId === "import-collisions" ? "native-import" : "identity";
  mkdirSync(ownedPaths.projectPath, { recursive: true, mode: 0o700 });
  createGitFixture(ownedPaths.projectPath);
  mkdirSync(join(homeDir, ".codex"), { mode: 0o700 });
  const transcript = join(homeDir, ".codex", "prior.jsonl");
  writeFileSync(transcript, '{"message":"existing transcript"}\n', { mode: 0o600 });
  const before = capturePreparedInputs(ownedPaths);
  const targets = preparedCase(caseId, scenario, ownedPaths);
  if (caseId === "identity-roots") targets.push(join(dirname(ownedPaths.projectPath), "surface-identity-alias"));
  for (const target of targets) {
    createGitFixture(target, caseId === "import-collisions" ? { remote: "https://example.invalid/parity-import.git" } : {});
    if (caseId === "import-collisions") {
      const admin = join(target, ".git/worktrees/parity-owner");
      mkdirSync(admin, { recursive: true, mode: 0o700 });
      writeFileSync(join(admin, "codex-thread.json"), '{"version":1,"ownerThreadId":"parity-ambiguous"}\n', { mode: 0o600 });
    }
  }
  const validate = () => validatePreparedInputs(caseId, scenario, ownedPaths, before, capturePreparedInputs(ownedPaths), process.getuid!());
  return { homeDir, ownedPaths, targets, transcript, validate, cleanup: () => rmSync(homeDir, { recursive: true, force: true }) };
}

describe("owned preparation input preservation", () => {
  it.each(["identity-roots", "import-collisions"])("admits exact source-derived %s Git roots and owner-thread files", caseId => {
    const f = inputsFixture(caseId);
    try { expect(f.validate).not.toThrow(); } finally { f.cleanup(); }
  });

  it.each(["transcript", "old-git", "new-leaf", "wrong-new-bytes", "unsafe-mode", "missing-required", "symlink"])("rejects %s mutation", mutation => {
    const f = inputsFixture();
    try {
      if (mutation === "transcript") writeFileSync(f.transcript, '{"message":"changed transcript"}\n');
      if (mutation === "old-git") writeFileSync(join(f.ownedPaths.projectPath, ".git/HEAD"), "ref: refs/heads/changed\n");
      if (mutation === "new-leaf") writeFileSync(join(f.targets[0], "unexpected.txt"), "unexpected", { mode: 0o600 });
      if (mutation === "wrong-new-bytes") writeFileSync(join(f.targets[0], ".git/config"), "wrong\n");
      if (mutation === "unsafe-mode") chmodSync(join(f.targets[0], ".git/HEAD"), 0o644);
      if (mutation === "missing-required") rmSync(join(f.targets[0], ".git/HEAD"));
      if (mutation === "symlink") symlinkSync(f.transcript, join(f.targets[0], "linked-transcript"));
      expect(f.validate).toThrow();
    } finally { f.cleanup(); }
  });

  it("rejects altered collision owner-thread payload even with exact Git metadata", () => {
    const f = inputsFixture("import-collisions");
    try {
      writeFileSync(join(f.targets[0], ".git/worktrees/parity-owner/codex-thread.json"), '{"version":1,"ownerThreadId":"changed"}\n');
      expect(f.validate).toThrow();
    } finally { f.cleanup(); }
  });
});


it("preserves an absent map only for the original SQLite roots refusal", () => {
  const fixture = deltaFixture();
  for (const side of [fixture.before, fixture.after]) {
    side.metadata.map = {};
    Object.assign(side.metadata, { mapFile: { missing: true }, backups: {}, backupRoot: null });
    Object.assign(side.logical.entries, { "map.json": { missing: true } });
  }
  expect(() => validatePreparedDelta(fixture)).not.toThrow();
  fixture.caseId = fixture.bundle.caseId = "events-operator"; fixture.scenario = "events";
  expect(() => validatePreparedDelta(fixture)).toThrow("missing-map-case");
});
