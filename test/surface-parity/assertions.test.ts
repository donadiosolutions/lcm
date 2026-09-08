import { assertSanitizedDiagnostic } from "./assertions.mjs";
import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  assertCompleteReport, assertSemanticEqual, assertSnapshotUnchanged, assertLogicalSnapshotUnchanged, compareBackendReports,
  normalizeObservation, semanticDigest,
} from "./assertions.mjs";

const matrix = [
  { id: "cli:search", scenario: "memory", assertions: ["arguments", "result", "effects"], expectation: "shared-data" },
  { id: "cli:stats", scenario: "diagnostics", assertions: ["result"], expectation: "architecture-specific", architectureReason: "Selected backend pool contracts differ." },
];
const report = (backend = "sqlite", scenario = "memory") => ({
  backend, scenario,
  rows: matrix.filter(row => row.scenario === scenario).map(row => ({
    id: row.id, assertions: [...row.assertions], verdict: "passed", observation: { count: 2, values: ["one", "two"] },
  })),
});

describe("surface parity semantic assertions", () => {
  it("compares JSON objects canonically without changing arrays or input", () => {
    const value = { z: [2, 1], a: { y: null, x: "é\u0000" } };
    const before = structuredClone(value);
    expect(semanticDigest(value)).toBe(semanticDigest({ a: { x: "é\u0000", y: null }, z: [2, 1] }));
    expect(normalizeObservation(value)).toEqual(value);
    expect(value).toEqual(before);
    assertSemanticEqual(value, before, "semantic-result");
  });

  it.each([
    [{ count: 2 }, { count: 3 }], [{ values: [1, 2] }, { values: [2, 1] }],
    [{ value: null }, {}], [{ value: "1" }, { value: 1 }],
    [{ text: "é" }, { text: "e\u0301" }], [{ text: "a\u0000b" }, { text: "ab" }],
    [{ error: "denied" }, { error: "unavailable" }], [{ tags: ["a", "b"] }, { tags: ["a"] }],
    [{ score: 0.2 }, { score: 0.3 }], [{ id: "first", parent: "first" }, { id: "first", parent: "second" }],
  ])("preserves meaningful differences %#", (actual, expected) => {
    expect(() => assertSemanticEqual(actual, expected, "semantic-result")).toThrow(/semantic-result/);
  });

  it("emits bounded digest-only errors without raw output or hostile labels", () => {
    const canary = "postgresql://secret@private/database " + "sensitive".repeat(500);
    let error: Error | undefined;
    try { assertSemanticEqual({ canary }, {}, "semantic-result"); } catch (caught) { error = caught as Error; }
    expect(error?.message.length).toBeLessThan(256);
    expect(error?.message).not.toContain("secret");
    expect(JSON.stringify(error)).not.toContain("sensitive");
    expect(() => assertSemanticEqual(1, 2, canary)).toThrow(/^surface-parity:invalid-assertion-id$/);
  });

  it("normalizes only explicit owned paths, identities and volatile pointers", () => {
    const actual = { file: "/owned/a/nested/file", id: "uuid-a", parent: "uuid-a", clock: "2026-09-07T12:00:00Z", port: 43123, pid: 42, elapsed: 1.2, count: 42 };
    const policy = {
      paths: [{ pointer: "/file", root: "/owned/a", label: "project" }],
      identities: [{ pointers: ["/id", "/parent"], values: [{ value: "uuid-a", label: "project-a" }] }],
      volatile: [
        { pointer: "/clock", kind: "timestamp" }, { pointer: "/port", kind: "port" },
        { pointer: "/pid", kind: "pid" }, { pointer: "/elapsed", kind: "timing" },
      ],
    };
    const expected = { ...actual, file: "/owned/b/nested/file", id: "uuid-b", parent: "uuid-b", clock: "2026-09-08T12:00:00Z", port: 55000, pid: 99, elapsed: 18 };
    const expectedPolicy = { ...policy,
      paths: [{ pointer: "/file", root: "/owned/b", label: "project" }],
      identities: [{ pointers: ["/id", "/parent"], values: [{ value: "uuid-b", label: "project-a" }] }],
    };
    assertSemanticEqual(normalizeObservation(actual, policy), normalizeObservation(expected, expectedPolicy), "normalized-result");
    expect(actual.id).toBe("uuid-a");
    expect(() => assertSemanticEqual(normalizeObservation(actual, policy), normalizeObservation({ ...expected, count: 99 }, expectedPolicy), "count")).toThrow();
    expect(() => assertSemanticEqual(normalizeObservation(actual, policy), normalizeObservation({ ...expected, file: "/owned/b/other/file" }, expectedPolicy), "file")).toThrow();
  });

  it("supports escaped JSON pointers and requires exact existing pointers", () => {
    expect(normalizeObservation({ "a/b": { "~": 42 } }, { volatile: [{ pointer: "/a~1b/~0", kind: "pid" }] })).toEqual({ "a/b": { "~": { $parity: "pid" } } });
    for (const pointer of ["/missing", "/a~2b", "/toString", "", "a"]) {
      expect(() => normalizeObservation({ a: 1 }, { volatile: [{ pointer, kind: "pid" }] })).toThrow();
    }
  });

  it.each([
    { identities: [{ pointers: ["/id"], values: [{ value: "a", label: "one" }, { value: "b", label: "one" }] }] },
    { identities: [{ pointers: ["/id"], values: [{ value: "a", label: "one" }, { value: "a", label: "two" }] }] },
    { identities: [{ pointers: ["/id"], values: [{ value: "b", label: "one" }] }] },
    { identities: [{ pointers: ["/id"], values: [{ value: "a", label: "one" }, { value: "b", label: "two" }] }] },
    { volatile: [{ pointer: "/count", kind: "count" }] },
    { volatile: [{ pointer: "/count", kind: "pid" }, { pointer: "/count", kind: "pid" }] },
    { ignoredKeys: ["count"] },
  ])("rejects ambiguous or broad normalization %#", policy => {
    expect(() => normalizeObservation({ id: "a", count: 42 }, policy)).toThrow();
  });

  it("preserves a mismatched identity relationship", () => {
    const policy = { identities: [{ pointers: ["/a", "/b", "/parent"], values: [{ value: "first", label: "a" }, { value: "second", label: "b" }] }] };
    expect(() => assertSemanticEqual(
      normalizeObservation({ a: "first", b: "second", parent: "first" }, policy),
      normalizeObservation({ a: "first", b: "second", parent: "second" }, policy), "identity-relationship",
    )).toThrow();
  });

  it("rejects conflicting identities across separately declared groups", () => {
    for (const value of ["first", "second"]) {
      expect(() => normalizeObservation({ a: "first", b: value }, { identities: [
        { pointers: ["/a"], values: [{ value: "first", label: "a" }] },
        { pointers: ["/b"], values: [{ value, label: value === "first" ? "b" : "a" }] },
      ] })).toThrow(/nonbijective-identities/);
    }
  });

  it("rejects conflicting path labels, broad roots and overlapping rules", () => {
    expect(() => normalizeObservation({ a: "/one", b: "/two" }, { paths: [
      { pointer: "/a", root: "/one", label: "same" },
      { pointer: "/b", root: "/two", label: "same" },
    ] })).toThrow(/nonbijective-path-labels/);
    for (const root of ["/", "/owned/../one", "relative", "/one/"]) {
      expect(() => normalizeObservation({ a: "/one" }, { paths: [{ pointer: "/a", root, label: "a" }] })).toThrow();
    }
    expect(() => normalizeObservation({ nested: { value: 42 } }, { volatile: [
      { pointer: "/nested/value", kind: "pid" },
      { pointer: "/nested", kind: "pid" },
    ] })).toThrow(/overlapping-normalization/);
  });

  it.each(["/owned/ab/file", "/elsewhere/file", "/owned/a/../elsewhere", "/owned/a//file"])("rejects unowned/noncanonical paths %s", file => {
    expect(() => normalizeObservation({ file }, { paths: [{ pointer: "/file", root: "/owned/a", label: "project" }] })).toThrow();
  });

  it.each([
    ["timestamp", "not-a-date"], ["timestamp", "2026-02-30T00:00:00Z"], ["timestamp", 42],
    ["port", 0], ["port", 65536], ["pid", -1], ["pid", 1.5], ["timing", -1], ["timing", "2ms"],
  ])("rejects invalid %s normalization", (kind, value) => {
    expect(() => normalizeObservation({ value }, { volatile: [{ pointer: "/value", kind }] })).toThrow();
  });

  it.each([undefined, NaN, Infinity, -0, 1n, new Date(), new Map(), { missing: undefined }, { $parity: "pid" }])("refuses lossy or reserved raw values %#", value => {
    expect(() => normalizeObservation(value)).toThrow();
  });

  it("rejects cycles, excessive nesting, oversized values and accessors without executing them", () => {
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    let nested: unknown = null;
    for (let i = 0; i < 70; i++) nested = { nested };
    let called = false;
    const getter = Object.defineProperty({}, "value", { enumerable: true, get() { called = true; return 1; } });
    for (const value of [cycle, nested, "x".repeat(300_000), getter, [,,]]) expect(() => normalizeObservation(value)).toThrow();
    expect(called).toBe(false);
  });
});

describe("surface parity report completeness", () => {
  it("requires the exact matrix denominator for the declared scenario", () => {
    assertCompleteReport(matrix, report());
    assertCompleteReport(matrix, { ...report(), cleanup: { verdict: "passed" } });
    compareBackendReports(matrix, report(), report("postgresql"));
  });

  it("checks shared control and grammar observations and keys rows by identity", () => {
    const controls = [
      { ...matrix[0], id: "cli:help", scenario: "control", expectation: "grammar" },
      { ...matrix[0], id: "cli:config get", scenario: "control", expectation: "backend-independent-control" },
    ];
    const sqlite = { backend: "sqlite", scenario: "control", rows: controls.map(row => ({
      id: row.id, assertions: row.assertions, verdict: "passed", observation: { id: row.id },
    })) };
    const postgres = { ...structuredClone(sqlite), backend: "postgresql" };
    postgres.rows.reverse();
    compareBackendReports(controls, sqlite, postgres);
    postgres.rows[0].observation.id = "wrong";
    expect(() => compareBackendReports(controls, sqlite, postgres)).toThrow(/shared-backend-result/);
  });

  it("rejects unknown receipt fields rather than discarding undeclared evidence", () => {
    expect(() => assertCompleteReport(matrix, { ...report(), omittedRows: 1 })).toThrow();
    const value = report();
    expect(() => assertCompleteReport(matrix, { ...value, rows: [{ ...value.rows[0], skipped: true }] })).toThrow();
    expect(() => assertCompleteReport(matrix, { ...value, cleanup: { verdict: "passed", failure: true } })).toThrow();
  });

  it.each(["missing-row", "duplicate-row", "unknown-row", "missing-assertion", "duplicate-assertion", "reordered-assertions", "unknown-assertion", "failed", "blocked", "not-run", "missing-observation", "wrong-scenario", "wrong-backend", "cleanup-failure"])("rejects %s", mutation => {
    const value: any = report();
    if (mutation === "missing-row") value.rows = [];
    if (mutation === "duplicate-row") value.rows.push(structuredClone(value.rows[0]));
    if (mutation === "unknown-row") value.rows[0].id = "cli:unknown";
    if (mutation === "missing-assertion") value.rows[0].assertions.pop();
    if (mutation === "duplicate-assertion") value.rows[0].assertions.push("result");
    if (mutation === "reordered-assertions") value.rows[0].assertions.reverse();
    if (mutation === "unknown-assertion") value.rows[0].assertions[0] = "unknown";
    if (["failed", "blocked", "not-run"].includes(mutation)) value.rows[0].verdict = mutation;
    if (mutation === "missing-observation") delete value.rows[0].observation;
    if (mutation === "wrong-scenario") value.scenario = "absent";
    if (mutation === "wrong-backend") value.backend = "pg";
    if (mutation === "cleanup-failure") value.cleanup = { verdict: "failed" };
    expect(() => assertCompleteReport(matrix, value)).toThrow();
  });

  it("rejects malformed matrix denominators", () => {
    for (const bad of [[...matrix, matrix[0]], [{ ...matrix[0], assertions: [] }], [{ ...matrix[0], assertions: ["result", "result"] }], [{ ...matrix[0], expectation: "skip" }]]) {
      expect(() => assertCompleteReport(bad, report())).toThrow();
    }
  });

  it("requires matching backend, scenario, assertion set and shared semantics", () => {
    expect(() => compareBackendReports(matrix, report(), report())).toThrow();
    expect(() => compareBackendReports(matrix, report(), report("postgresql", "diagnostics"))).toThrow();
    const other = report("postgresql"); other.rows[0].observation.count = 3;
    expect(() => compareBackendReports(matrix, report(), other)).toThrow();
  });

  it("demands explicit actual counterpart checks for every architecture difference", () => {
    const sqlite = report("sqlite", "diagnostics");
    const postgres = report("postgresql", "diagnostics");
    postgres.rows[0].observation.count = 3;
    expect(() => compareBackendReports(matrix, sqlite, postgres)).toThrow();
    const expectations = { "cli:stats": { sqlite: sqlite.rows[0].observation, postgresql: postgres.rows[0].observation } };
    compareBackendReports(matrix, sqlite, postgres, { expectations });
    expect(() => compareBackendReports(matrix, sqlite, postgres, { expectations: { "cli:stats": { sqlite: {} } } })).toThrow();
    expect(() => compareBackendReports(matrix, sqlite, postgres, { expectations: { "cli:stats": { sqlite: {}, postgresql: {} } } })).toThrow();
    expect(() => compareBackendReports(matrix, sqlite, postgres, { expectations: { ...expectations, unknown: { sqlite: {}, postgresql: {} } } })).toThrow();
    expect(() => compareBackendReports(matrix.map(row => ({ ...row, architectureReason: undefined })), sqlite, postgres, { expectations })).toThrow();
  });

  it("does not allow declared differences to exempt shared rows", () => {
    expect(() => compareBackendReports(matrix, report(), report("postgresql"), { expectations: { "cli:search": { sqlite: {}, postgresql: {} } } })).toThrow();
  });
});


// These are the exact filesystem/native witness fields supplied by both the
// warm worker and the independent cold diagnostic observer. No dist imports.
const snapshotOwner = 1000;
const snapshotBase = "projects/cold/db.sqlite";
const snapshotParent = "projects/cold";
const snapshotOptions = { owner: snapshotOwner, allowedNewCoordinationBases: [snapshotBase] };
type Snapshot = { entries: Record<string, any>; nativeCounts?: any; postgresql?: any };
function snapshotFixture(): Snapshot {
  const identity = { uid: snapshotOwner, gid: snapshotOwner, dev: 7, nlink: 1 };
  return { entries: {
    [snapshotParent]: { ...identity, inode: 10, mode: 0o40700, kind: "directory", children: ["db.sqlite", "meta.json"] },
    [snapshotBase]: { ...identity, inode: 11, mode: 0o100600, kind: "file", bytes: 4096, sha256: "database-hash", sqliteFile: true,
      database: { userVersion: 3, journalMode: "wal", schemaSha256: "schema-hash", tables: { messages: { rows: 1, sha256: "rows-hash" } } } },
    [`${snapshotParent}/meta.json`]: { ...identity, inode: 12, mode: 0o100600, kind: "file", bytes: 2, sha256: "metadata-hash" },
  }, nativeCounts: { projects: 1, messages: 1 }, postgresql: { schema: "pg-schema", rows: "pg-rows" } };
}
function addCoordination(snapshot: Snapshot, suffix = "-shm", base = snapshotBase) {
  const parent = base.slice(0, base.lastIndexOf("/"));
  const leaf = base.slice(base.lastIndexOf("/") + 1) + suffix;
  snapshot.entries[base + suffix] = { uid: snapshotOwner, gid: snapshotOwner, dev: 7, nlink: 1, inode: suffix === "-wal" ? 13 : 14,
    mode: 0o100600, kind: "file", bytes: suffix === "-wal" ? 0 : 32768, sha256: suffix === "-wal" ? "empty-hash" : "shm-hash" };
  snapshot.entries[parent].children.push(leaf);
  snapshot.entries[parent].children.sort();
}

describe("surface parity read-only snapshot contract", () => {
  it("compares the full unchanged observation and does not mutate its inputs", () => {
    const expected = snapshotFixture();
    const actual = structuredClone(expected);
    expect(assertSnapshotUnchanged(actual, expected, "snapshot", snapshotOptions)).toEqual([]);
    expect(actual).toEqual(expected);
  });

  it("allows only authenticated cold coordination children and returns exact added paths", () => {
    const expected = snapshotFixture();
    const original = structuredClone(expected);
    const actual = structuredClone(expected);
    addCoordination(actual, "-wal");
    addCoordination(actual);
    const after = structuredClone(actual);
    expect(assertSnapshotUnchanged(actual, expected, "cold", snapshotOptions)).toEqual([`${snapshotBase}-wal`, `${snapshotBase}-shm`]);
    expect(actual).toEqual(after);
    expect(expected).toEqual(original);
  });

  it.each([false, true])("allows pre-existing SHM outside cold targets (bytes changed: %s)", changed => {
    const expected = snapshotFixture();
    addCoordination(expected);
    const actual = structuredClone(expected);
    if (changed) Object.assign(actual.entries[`${snapshotBase}-shm`], { bytes: 65536, sha256: "new-read-index" });
    expect(assertSnapshotUnchanged(actual, expected, "cold", { owner: snapshotOwner, allowedNewCoordinationBases: [] })).toEqual([]);
  });

  it.each(["-wal", "-shm"])("rejects new %s outside the exact cold target", suffix => {
    const expected = snapshotFixture();
    const actual = structuredClone(expected);
    addCoordination(actual, suffix);
    expect(() => assertSnapshotUnchanged(actual, expected, "cold", { owner: snapshotOwner, allowedNewCoordinationBases: [`${snapshotBase}.other`] })).toThrow(/coordination-outside-cold-target/);
  });

  const creationMutations: [string, (actual: Snapshot, expected: Snapshot) => void, RegExp][] = [
    ["missing original database", (a, e) => { delete e.entries[snapshotBase]; delete a.entries[snapshotBase]; }, /coordination-base/],
    ["new database", (_a, e) => { delete e.entries[snapshotBase]; }, /unexpected-file/],
    ["non-SQLite base", (a, e) => { delete e.entries[snapshotBase].sqliteFile; delete a.entries[snapshotBase].sqliteFile; }, /coordination-base/],
    ["base owner", (a, e) => { a.entries[snapshotBase].uid++; e.entries[snapshotBase].uid++; }, /coordination-base/],
    ["base mode", (a, e) => { a.entries[snapshotBase].mode = e.entries[snapshotBase].mode = 0o100644; }, /coordination-base/],
    ["base hardlink", (a, e) => { a.entries[snapshotBase].nlink = e.entries[snapshotBase].nlink = 2; }, /coordination-base/],
    ["base symlink", (a, e) => { a.entries[snapshotBase].kind = e.entries[snapshotBase].kind = "symlink"; }, /coordination-base/],
    ["base inode replacement", a => { a.entries[snapshotBase].inode++; }, /coordination-database-unchanged/],
    ["base bytes rewrite", a => { a.entries[snapshotBase].sha256 = "rewritten"; }, /coordination-database-unchanged/],
    ["missing parent", (a, e) => { delete e.entries[snapshotParent]; delete a.entries[snapshotParent]; }, /coordination-parent/],
    ["parent owner", (a, e) => { a.entries[snapshotParent].uid++; e.entries[snapshotParent].uid++; }, /coordination-parent/],
    ["parent mode", (a, e) => { a.entries[snapshotParent].mode = e.entries[snapshotParent].mode = 0o40755; }, /coordination-parent/],
    ["parent symlink", (a, e) => { a.entries[snapshotParent].kind = e.entries[snapshotParent].kind = "symlink"; }, /coordination-parent/],
    ["parent inode replacement", a => { a.entries[snapshotParent].inode++; }, /project-files/],
    ["sidecar owner", a => { a.entries[`${snapshotBase}-shm`].uid++; }, /coordination-file/],
    ["sidecar mode", a => { a.entries[`${snapshotBase}-shm`].mode = 0o100644; }, /coordination-file/],
    ["sidecar hardlink", a => { a.entries[`${snapshotBase}-shm`].nlink = 2; }, /coordination-file/],
    ["sidecar symlink", a => { a.entries[`${snapshotBase}-shm`].kind = "symlink"; }, /coordination-file/],
    ["sidecar device", a => { a.entries[`${snapshotBase}-shm`].dev++; }, /coordination-file/],
    ["unexpected sidecar path", a => { a.entries[`${snapshotBase}-shm.bak`] = a.entries[`${snapshotBase}-shm`]; delete a.entries[`${snapshotBase}-shm`]; }, /unexpected-file/],
    ["directory membership omission", a => { a.entries[snapshotParent].children = ["db.sqlite", "meta.json"]; }, /project-files/],
    ["extra directory member", a => { a.entries[snapshotParent].children.push("unexpected"); }, /project-files/],
  ];
  it.each(creationMutations)("rejects new coordination with %s", (_name, mutate, error) => {
    const expected = snapshotFixture();
    const actual = structuredClone(expected);
    addCoordination(actual);
    mutate(actual, expected);
    expect(() => assertSnapshotUnchanged(actual, expected, "cold", snapshotOptions)).toThrow(error);
  });

  it("rejects committed bytes in a newly created WAL", () => {
    const expected = snapshotFixture();
    const actual = structuredClone(expected);
    addCoordination(actual, "-wal");
    actual.entries[`${snapshotBase}-wal`].bytes = 32;
    expect(() => assertSnapshotUnchanged(actual, expected, "cold", snapshotOptions)).toThrow(/new-wal-durable-content/);
  });

  it.each(["inode", "dev", "gid", "uid", "mode", "nlink", "kind"])("rejects changed existing SHM %s even when byte changes are allowed", field => {
    const expected = snapshotFixture();
    addCoordination(expected);
    const actual = structuredClone(expected);
    const entry = actual.entries[`${snapshotBase}-shm`];
    entry[field] = field === "kind" ? "symlink" : entry[field] + 1;
    entry.sha256 = "updated-index";
    expect(() => assertSnapshotUnchanged(actual, expected, "warm", snapshotOptions)).toThrow(/coordination-file|shm-identity/);
  });

  it("rejects an unauthenticated original SHM even when the new one is owner held", () => {
    const expected = snapshotFixture();
    addCoordination(expected);
    const actual = structuredClone(expected);
    expected.entries[`${snapshotBase}-shm`].mode = 0o100644;
    expect(() => assertSnapshotUnchanged(actual, expected, "warm", snapshotOptions)).toThrow(/prior-shm-file/);
  });

  it.each(["-wal", "-shm"])("rejects deletion and recreation of existing %s", suffix => {
    const expected = snapshotFixture();
    addCoordination(expected, suffix);
    const recreated = structuredClone(expected);
    recreated.entries[snapshotBase + suffix].inode++;
    expect(() => assertSnapshotUnchanged(recreated, expected, "warm", snapshotOptions)).toThrow(/shm-identity|project-wal/);
    const deleted = structuredClone(expected);
    delete deleted.entries[snapshotBase + suffix];
    deleted.entries[snapshotParent].children = deleted.entries[snapshotParent].children.filter((name: string) => !name.endsWith(suffix));
    expect(() => assertSnapshotUnchanged(deleted, expected, "warm", snapshotOptions)).toThrow(/removed-project/);
  });

  it.each(["sha256", "bytes"])("rejects existing WAL %s changes", field => {
    const expected = snapshotFixture();
    addCoordination(expected, "-wal");
    const actual = structuredClone(expected);
    actual.entries[`${snapshotBase}-wal`][field] = field === "sha256" ? "rewritten" : 32;
    expect(() => assertSnapshotUnchanged(actual, expected, "warm", snapshotOptions)).toThrow(/project-wal/);
  });

  it.each([
    ["database bytes", (s: Snapshot) => { s.entries[snapshotBase].sha256 = "rewritten"; }, /project-database/],
    ["database size", (s: Snapshot) => { s.entries[snapshotBase].bytes++; }, /project-database/],
    ["database inode", (s: Snapshot) => { s.entries[snapshotBase].inode++; }, /project-database/],
    ["schema", (s: Snapshot) => { s.entries[snapshotBase].database.schemaSha256 = "migrated"; }, /sqlite-native-state/],
    ["logical rows", (s: Snapshot) => { s.entries[snapshotBase].database.tables.messages.sha256 = "rewritten"; }, /sqlite-native-state/],
    ["native counts", (s: Snapshot) => { s.nativeCounts.messages++; }, /native-counts/],
    ["PostgreSQL state", (s: Snapshot) => { s.postgresql.rows = "changed"; }, /postgresql-state/],
    ["metadata", (s: Snapshot) => { s.entries[`${snapshotParent}/meta.json`].sha256 = "rewritten"; }, /project-metadata/],
    ["new database", (s: Snapshot) => { s.entries[`${snapshotParent}/new.db`] = structuredClone(s.entries[snapshotBase]); }, /unexpected-file/],
    ["new other file", (s: Snapshot) => { s.entries["config.json"] = { kind: "file" }; }, /unexpected-file/],
    ["deleted other file", (s: Snapshot) => { delete s.entries[`${snapshotParent}/meta.json`]; }, /removed-project-metadata/],
  ] as [string, (s: Snapshot) => void, RegExp][])("rejects changed %s without any coordination exception", (_name, mutate, error) => {
    const expected = snapshotFixture();
    const actual = structuredClone(expected);
    mutate(actual);
    expect(() => assertSnapshotUnchanged(actual, expected, "snapshot", snapshotOptions)).toThrow(error);
  });

  it("requires an explicit owner and keeps hostile paths and contents out of errors", () => {
    const expected = snapshotFixture();
    expect(() => assertSnapshotUnchanged(expected, expected)).toThrow(/owner-required/);
    const actual = structuredClone(expected);
    const canary = "postgresql://secret@private/database";
    actual.entries[canary] = { content: "sensitive-native-row" };
    let error: Error | undefined;
    try { assertSnapshotUnchanged(actual, expected, "snapshot", snapshotOptions); } catch (caught) { error = caught as Error; }
    expect(error?.message).toBe("surface-parity:snapshot:unexpected-file");
    expect(JSON.stringify(error)).not.toMatch(/secret|sensitive-native-row/);
    expect(() => assertSnapshotUnchanged(actual, expected, canary, snapshotOptions)).toThrow(/^surface-parity:invalid-assertion-id$/);
  });
});


function filesystemSnapshot(root: string): Snapshot {
  const entries: Snapshot["entries"] = {};
  function visit(relative: string) {
    const path = join(root, relative);
    const stat = lstatSync(path);
    const identity = { inode: stat.ino, dev: stat.dev, mode: stat.mode, uid: stat.uid, gid: stat.gid, nlink: stat.nlink };
    if (stat.isDirectory()) {
      const children = readdirSync(path).sort();
      entries[relative] = { ...identity, kind: "directory", children };
      for (const child of children) visit(relative === "" ? child : `${relative}/${child}`);
    } else {
      expect(stat.isFile()).toBe(true);
      const bytes = readFileSync(path);
      entries[relative] = { ...identity, kind: "file", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"),
        ...(bytes.subarray(0, 16).equals(Buffer.from("SQLite format 3\0")) ? { sqliteFile: true } : {}) };
    }
  }
  visit("");
  return { entries };
}

describe("surface parity snapshots of real SQLite read coordination", () => {
  it.each(["cold", "live-wal"])("accepts an actual %s read while preserving committed rows and durable bytes", phase => {
    const root = mkdtempSync(join(tmpdir(), "surface-parity-snapshot-"));
    chmodSync(root, 0o700);
    const path = join(root, "db.sqlite");
    let writer: DatabaseSync | undefined;
    let reader: DatabaseSync | undefined;
    try {
      // Setup owns a private database leaf before the SQLite engine creates any
      // WAL files, without changing the process-wide umask or runtime home.
      writeFileSync(path, "", { mode: 0o600, flag: "wx" });
      writer = new DatabaseSync(path);
      writer.exec("PRAGMA journal_mode=WAL; CREATE TABLE messages (id INTEGER PRIMARY KEY, text TEXT); INSERT INTO messages VALUES (1, 'café 東京');");
      if (phase === "cold") { writer.close(); writer = undefined; }
      const before = filesystemSnapshot(root);
      if (phase === "cold") expect(before.entries[""].children).toEqual(["db.sqlite"]);
      else expect(before.entries["db.sqlite-wal"].bytes).toBeGreaterThan(0);
      reader = new DatabaseSync(path, { readOnly: true });
      expect(reader.prepare("SELECT * FROM messages").all()).toEqual([{ id: 1, text: "café 東京" }]);
      const after = filesystemSnapshot(root);
      const options = { owner: process.getuid?.(), allowedNewCoordinationBases: phase === "cold" ? ["db.sqlite"] : [] };
      expect(assertSnapshotUnchanged(after, before, "real-read", options).sort()).toEqual(phase === "cold" ? ["db.sqlite-shm", "db.sqlite-wal"] : []);
      expect(after.entries["db.sqlite"]).toEqual(before.entries["db.sqlite"]);
      if (phase === "live-wal") expect(after.entries["db.sqlite-wal"]).toEqual(before.entries["db.sqlite-wal"]);
      // Subsequent cold observations must accept this now-pre-existing SHM even
      // with an empty new-file allowlist, without priming a snapshot DB reader.
      reader.prepare("SELECT count(*) FROM sqlite_schema").get();
      expect(assertSnapshotUnchanged(filesystemSnapshot(root), after, "repeat-read", { owner: process.getuid?.(), allowedNewCoordinationBases: [] })).toEqual([]);
    } finally {
      try { reader?.close(); }
      finally { try { writer?.close(); } finally { rmSync(root, { recursive: true, force: true }); } }
    }
  });
});


describe("surface parity logical read-only snapshot contract", () => {
  const emptyDelta = { databaseBytesChanged: [], coordinationCreated: [], coordinationRemoved: [], coordinationUpdated: [] };
  const compare = (actual: Snapshot, expected: Snapshot) => assertLogicalSnapshotUnchanged(actual, expected, "logical", { owner: snapshotOwner });
  function checkpointFixture() {
    const expected = snapshotFixture();
    addCoordination(expected, "-wal");
    addCoordination(expected);
    expected.entries[`${snapshotBase}-wal`].bytes = 8192;
    const actual = structuredClone(expected);
    actual.entries[snapshotBase].sha256 = "checkpointed-database";
    actual.entries[snapshotBase].bytes += 4096;
    for (const suffix of ["-wal", "-shm"]) delete actual.entries[snapshotBase + suffix];
    actual.entries[snapshotParent].children = ["db.sqlite", "meta.json"];
    return { actual, expected };
  }

  it("admits an authenticated checkpoint and engine cleanup only in the logical contract", () => {
    const { actual, expected } = checkpointFixture();
    const original = structuredClone({ actual, expected });
    expect(compare(actual, expected)).toEqual({ ...emptyDelta, databaseBytesChanged: [snapshotBase], coordinationRemoved: [`${snapshotBase}-shm`, `${snapshotBase}-wal`] });
    expect({ actual, expected }).toEqual(original);
    expect(() => assertSnapshotUnchanged(actual, expected, "diagnostic", snapshotOptions)).toThrow(/removed-project/);
  });

  it("reports no engine changes for an exact snapshot", () => {
    const expected = snapshotFixture();
    expect(compare(structuredClone(expected), expected)).toEqual(emptyDelta);
  });

  it("records observed creation and changes of authenticated engine artifacts", () => {
    const expected = snapshotFixture();
    const created = structuredClone(expected);
    addCoordination(created, "-wal");
    addCoordination(created);
    expect(compare(created, expected)).toEqual({ ...emptyDelta, coordinationCreated: [`${snapshotBase}-shm`, `${snapshotBase}-wal`] });
    const updated = structuredClone(created);
    updated.entries[`${snapshotBase}-wal`].bytes = 4096;
    updated.entries[`${snapshotBase}-wal`].sha256 = "engine-wal";
    updated.entries[`${snapshotBase}-shm`].sha256 = "engine-index";
    expect(compare(updated, created)).toEqual({ ...emptyDelta, coordinationUpdated: [`${snapshotBase}-shm`, `${snapshotBase}-wal`] });
    expect(() => assertSnapshotUnchanged(updated, created, "diagnostic", snapshotOptions)).toThrow(/project-wal/);
  });

  it.each([
    ["logical rows", (a: Snapshot) => { a.entries[snapshotBase].database.tables.messages.sha256 = "changed-rows"; }],
    ["schema", (a: Snapshot) => { a.entries[snapshotBase].database.schemaSha256 = "changed-schema"; }],
    ["user version", (a: Snapshot) => { a.entries[snapshotBase].database.userVersion++; }],
    ["journal mode", (a: Snapshot) => { a.entries[snapshotBase].database.journalMode = "delete"; }],
    ["database owner", (a: Snapshot) => { a.entries[snapshotBase].uid++; }],
    ["database mode", (a: Snapshot) => { a.entries[snapshotBase].mode = 0o100644; }],
    ["database links", (a: Snapshot) => { a.entries[snapshotBase].nlink++; }],
    ["database inode", (a: Snapshot) => { a.entries[snapshotBase].inode++; }],
    ["database deletion", (a: Snapshot) => { delete a.entries[snapshotBase]; }],
    ["new database", (a: Snapshot) => { a.entries[`${snapshotParent}/new.db`] = structuredClone(a.entries[snapshotBase]); }],
    ["config", (a: Snapshot) => { a.entries["config.json"].sha256 = "changed"; }],
    ["map", (a: Snapshot) => { a.entries["map.json"].sha256 = "changed"; }],
    ["metadata", (a: Snapshot) => { a.entries[`${snapshotParent}/meta.json`].sha256 = "changed"; }],
    ["other file", (a: Snapshot) => { a.entries["unexpected.txt"] = { kind: "file" }; }],
    ["native counts", (a: Snapshot) => { a.nativeCounts.messages++; }],
    ["PostgreSQL rows", (a: Snapshot) => { a.postgresql.rows = "changed"; }],
    ["parent identity", (a: Snapshot) => { a.entries[snapshotParent].inode++; }],
    ["undeclared directory child", (a: Snapshot) => { a.entries[snapshotParent].children.push("missing-witness"); }],
  ] as [string, (a: Snapshot) => void][])("rejects %s changes despite permitted checkpoint artifacts", (_name, mutate) => {
    const { actual, expected } = checkpointFixture();
    for (const path of ["config.json", "map.json"]) {
      expected.entries[path] = structuredClone(expected.entries[`${snapshotParent}/meta.json`]);
      actual.entries[path] = structuredClone(expected.entries[path]);
    }
    mutate(actual);
    expect(() => compare(actual, expected)).toThrow(/^surface-parity:logical:/);
  });

  it.each(["schemaSha256", "tables", "userVersion", "journalMode"])("requires explicit %s evidence even when absent on both sides", field => {
    const { actual, expected } = checkpointFixture();
    delete actual.entries[snapshotBase].database[field];
    delete expected.entries[snapshotBase].database[field];
    expect(() => compare(actual, expected)).toThrow(/sqlite-native-evidence/);
  });

  it.each(["uid", "mode", "nlink", "dev", "kind"])("authenticates removed coordination %s", field => {
    const { actual, expected } = checkpointFixture();
    const prior = expected.entries[`${snapshotBase}-wal`];
    prior[field] = field === "kind" ? "symlink" : prior[field] + 1;
    expect(() => compare(actual, expected)).toThrow(/coordination-file/);
  });

  it("records authenticated SHM replacement only under the logical contract", () => {
    const expected = snapshotFixture();
    addCoordination(expected);
    const actual = structuredClone(expected);
    actual.entries[snapshotBase + "-shm"].inode++;
    expect(compare(actual, expected)).toEqual({ ...emptyDelta,
      coordinationCreated: [snapshotBase + "-shm"], coordinationRemoved: [snapshotBase + "-shm"],
    });
    expect(() => assertSnapshotUnchanged(actual, expected, "strict", { owner: snapshotOwner })).toThrow(/shm-identity/);
    actual.entries[snapshotBase + "-shm"].gid++;
    expect(() => compare(actual, expected)).toThrow(/coordination-identity/);
  });

  it("keeps WAL identity replacement outside the SHM logical allowance", () => {
    const expected = snapshotFixture();
    addCoordination(expected, "-wal");
    const actual = structuredClone(expected);
    actual.entries[snapshotBase + "-wal"].inode++;
    expect(() => compare(actual, expected)).toThrow(/coordination-identity/);
  });

  it.each(["uid", "mode", "nlink", "dev", "gid", "kind"])("rejects surviving sidecar %s changes", field => {
    const expected = snapshotFixture();
    addCoordination(expected);
    const actual = structuredClone(expected);
    const entry = actual.entries[`${snapshotBase}-shm`];
    entry[field] = field === "kind" ? "symlink" : entry[field] + 1;
    expect(() => compare(actual, expected)).toThrow(/coordination-file|coordination-identity/);
  });

  it.each(["uid", "mode", "kind"])("authenticates the existing parent %s on both sides", field => {
    const { actual, expected } = checkpointFixture();
    for (const snapshot of [actual, expected]) snapshot.entries[snapshotParent][field] = field === "kind" ? "symlink" : 42;
    expect(() => compare(actual, expected)).toThrow(/sqlite-parent/);
  });

  it("requires owner and bounded assertion IDs", () => {
    const expected = snapshotFixture();
    expect(() => assertLogicalSnapshotUnchanged(expected, expected)).toThrow(/owner-required/);
    expect(() => assertLogicalSnapshotUnchanged(expected, expected, "postgresql://secret", snapshotOptions)).toThrow(/^surface-parity:invalid-assertion-id$/);
  });
});

it("accepts a real SQLite final-close checkpoint only under the logical contract", () => {
  const root = mkdtempSync(join(tmpdir(), "surface-parity-logical-"));
  chmodSync(root, 0o700);
  const path = join(root, "db.sqlite");
  let writer: DatabaseSync | undefined;
  let reader: DatabaseSync | undefined;
  function native(db: DatabaseSync) {
    const schema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name").all();
    const rows = db.prepare("SELECT * FROM messages ORDER BY id").all();
    return {
      schemaSha256: semanticDigest(schema), tables: { messages: { rows: rows.length, sha256: semanticDigest(rows) } },
      userVersion: db.prepare("PRAGMA user_version").get()!.user_version,
      journalMode: db.prepare("PRAGMA journal_mode").get()!.journal_mode,
    };
  }
  try {
    writeFileSync(path, "", { mode: 0o600, flag: "wx" });
    writer = new DatabaseSync(path);
    writer.exec("PRAGMA journal_mode=WAL; PRAGMA user_version=3; CREATE TABLE messages (id INTEGER PRIMARY KEY, text TEXT); INSERT INTO messages VALUES (1, 'café 東京');");
    const before = filesystemSnapshot(root);
    before.entries["db.sqlite"].database = native(writer);
    expect(before.entries["db.sqlite-wal"].bytes).toBeGreaterThan(0);
    writer.close(); writer = undefined;
    // Capture final-close effects before the independent native read can create
    // fresh read-coordination leaves. No manual sidecar deletion/checkpoint.
    const after = filesystemSnapshot(root);
    expect(after.entries[""].children).toEqual(["db.sqlite"]);
    reader = new DatabaseSync(path, { readOnly: true });
    after.entries["db.sqlite"].database = native(reader);
    expect(after.entries["db.sqlite"].database).toEqual(before.entries["db.sqlite"].database);
    const options = { owner: process.getuid?.() };
    expect(assertLogicalSnapshotUnchanged(after, before, "real-checkpoint", options)).toEqual({
      databaseBytesChanged: ["db.sqlite"], coordinationCreated: [], coordinationRemoved: ["db.sqlite-shm", "db.sqlite-wal"], coordinationUpdated: [],
    });
    expect(() => assertSnapshotUnchanged(after, before, "diagnostic", options)).toThrow(/removed-protected/);
  } finally {
    try { reader?.close(); }
    finally { try { writer?.close(); } finally { rmSync(root, { recursive: true, force: true }); } }
  }
});


describe("safe public PostgreSQL diagnostics", () => {
  it.each(["42501", "08006", "XX000", null])("accepts only the documented SQLSTATE scalar %s", sqlState => {
    expect(() => assertSanitizedDiagnostic({ backend: "postgresql", sqlState })).not.toThrow();
  });
  it("validates structured SQLSTATE through CLI and MCP text envelopes", () => {
    const body = JSON.stringify({ error: { sqlState: "42501" } });
    expect(() => assertSanitizedDiagnostic(body, { expectedSqlState: "42501" })).not.toThrow();
    expect(() => assertSanitizedDiagnostic({ content: [{ type: "text", text: body }] }, { expectedSqlState: "42501" })).not.toThrow();
  });
  it.each([
    "SQLSTATE: arbitrary raw error",
    '{"sqlState": "42501"',
    { message: "SQLSTATE: arbitrary raw error" },
    { content: [{ type: "text", text: "SQLSTATE: arbitrary raw error" }] },
  ])("rejects raw SQLSTATE prose outside validated fields %#", value => {
    expect(() => assertSanitizedDiagnostic(value)).toThrow(/diagnostic-raw-sqlstate/);
  });
  it.each(["42501 secret", "1234", "123456", "42p01", false, undefined, { code: "42501" }])("rejects an unsafe structured SQLSTATE %#", sqlState => {
    expect(() => assertSanitizedDiagnostic({ sqlState })).toThrow(/diagnostic-sqlstate/);
  });
  it("requires actual expected permission-denial evidence", () => {
    expect(() => assertSanitizedDiagnostic({ sqlState: null }, { expectedSqlState: "42501" })).toThrow(/sqlstate-evidence/);
    expect(() => assertSanitizedDiagnostic({ sqlState: "42501" }, { expectedSqlState: "42501 private" })).toThrow(/expected-sqlstate/);
  });
  it.each([
    "postgresql://role:secret@host/database", "-----BEGIN PRIVATE KEY-----",
    "at query (/fixture/private.mjs:1:2)", "permission denied for relation private_table", "SELECT secret FROM private_table",
  ])("continues rejecting protected diagnostic boundary %#", value => {
    expect(() => assertSanitizedDiagnostic(value)).toThrow(/diagnostic-(url|pem|stack|driver|query)/);
  });
  it("rejects exact role, home, password and SQLSTATE canaries without banning the safe key", () => {
    for (const canary of ["private_role", "/private/home", "private-password", "SQLSTATE_PRIVATE_42501"]) {
      expect(() => assertSanitizedDiagnostic({ sqlState: "42501", message: canary }, { canaries: [canary] })).toThrow(/private-canary/);
    }
    expect(() => assertSanitizedDiagnostic({ sqlState: "42501" }, { canaries: ["SQLSTATE_PRIVATE_42501"] })).not.toThrow();
  });
});
