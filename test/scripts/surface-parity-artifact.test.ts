import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sanitizeHarnessText } from "../../scripts/postgresql-harness.mjs";
import {
  createCertificate, extractCertificates, writeArtifacts, loadMatrix, sourceDigest, MARKER,
  REGRESSION_PROVENANCE,
  capturedVitestSectionBytes,
  workingTreeClean,
  encodeBookkeeping,
  BOOKKEEPING_PHASES, BOOKKEEPING_KINDS, BOOKKEEPING_SCOPES,
} from "../../scripts/surface-parity-artifact.mjs";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const matrix = [
  { id: "cli:help", scenario: "control", assertions: ["grammar", "result", "effects"] },
  { id: "cli:store", scenario: "memory", assertions: ["result", "effects"] },
  { id: "portable-domain:projects", scenario: "transfer", assertions: ["content", "readback"] },
];
const context = { runId: "a-owned-run", sourceDigest: sha("source"), cleanup: true };
const runtime = { node: "22.20.0", postgres: 180004, extensions: [
  ["pg_stat_statements", "1.12"], ["pg_trgm", "1.6"], ["pgcrypto", "1.3"], ["unaccent", "1.1"],
], corpus: { projects: 2, conversations: 3, messages: 5, summaries: 1, promotedCount: 2 } };
const producers = [
  ["controls", "sqlite"], ["controls", "postgresql"],
  ["data", "sqlite"], ["data", "postgresql"],
  ...["sqlite->sqlite", "sqlite->postgresql", "postgresql->sqlite", "postgresql->postgresql"]
    .map((direction) => ["transfer", direction]),
];
function certificate(producer: string, backend: string) {
  const scenario = producer === "controls" ? "control" : producer === "transfer" ? "transfer" : "memory";
  return createCertificate(matrix, {
    ...context, producer, backend,
    ...(producer === "data" && backend === "postgresql" ? { runtime } : {}),
    rows: matrix.filter((row) => row.scenario === scenario).map((row) => ({
      id: row.id, assertions: row.assertions, verdict: "passed", digest: sha(row.id),
    })),
  });
}
const lines = () => producers.map(([producer, backend]) => certificate(producer!, backend!));
function mutate(line: string, fn: (value: any) => void) {
  const value = JSON.parse(line.slice(MARKER.length));
  fn(value);
  return MARKER + JSON.stringify(value);
}
const extract = (value: string[]) => extractCertificates(value.join("\n"), matrix, {
  sourceDigest: context.sourceDigest, runId: context.runId,
});
const bookkeepingMatrix = [...matrix,
  { id: "cli:compact", scenario: "compaction", assertions: ["effects"] },
  { id: "daemon:POST /search", scenario: "memory", assertions: ["backend-denial", "pool-exhaustion", "cancellation"] },
  { id: "daemon:POST /compact", scenario: "compaction", assertions: ["cancellation"] },
  { id: "daemon:GET /health", scenario: "diagnostics", assertions: ["startup-unavailable", "effects"] },
];
function bookkeepingLines(tuples: unknown[] = [["compact-preview", "wal-removed", "project-db", 2]]) {
  return producers.map(([producer, backend]) => createCertificate(bookkeepingMatrix, {
    ...context, producer, backend,
    ...(producer === "data" && backend === "sqlite" ? { bookkeeping: tuples } : {}),
    ...(producer === "data" && backend === "postgresql" ? { runtime } : {}),
    rows: bookkeepingMatrix.filter(row => (row.scenario === "control" ? "controls"
      : row.scenario === "transfer" ? "transfer" : "data") === producer).map(row => ({
      id: row.id, assertions: row.assertions, verdict: "passed", digest: sha(row.id),
    })),
  }));
}
const extractBookkeeping = (value: string[]) => extractCertificates(value.join("\n"), bookkeepingMatrix, context);

describe("compact surface parity evidence", () => {
  it("binds engine facts into the data digest without replacing row or shared semantic evidence", () => {
    const value = bookkeepingLines();
    const report = extractBookkeeping(value);
    expect(report.complete).toBe(true);
    expect(report.producers[2].bookkeeping).toEqual([{
      phase: "compact-preview", kind: "wal-removed", scope: "project-db", count: 2,
      reason: expect.stringContaining("native schema, logical rows, journal mode"),
    }]);
    const prior = extractBookkeeping(bookkeepingLines([]));
    expect(prior.producers[2].rows).toEqual(report.producers[2].rows);
    expect(prior.producers[2].digest).not.toBe(report.producers[2].digest);
    const tuple = JSON.parse(value[2]!.slice(MARKER.length));
    expect(tuple.a).toEqual([[0, 2, 0, 2]]);
    expect(sanitizeHarnessText(value.join("\n"), ["/owned/db.sqlite", "fixture-query-canary"])).toBe(value.join("\n"));
  });

  it.each([
    ["phase", [["diagnostics", "wal-created", "project-db", 1]]],
    ["kind", [["compact-preview", "file-created", "project-db", 1]]],
    ["scope", [["compact-preview", "wal-created", "/owned/project", 1]]],
    ["zero count", [["compact-preview", "wal-created", "project-db", 0]]],
    ["negative count", [["compact-preview", "wal-created", "project-db", -1]]],
    ["fractional count", [["compact-preview", "wal-created", "project-db", 0.5]]],
    ["large count", [["compact-preview", "wal-created", "project-db", 65536]]],
    ["duplicate", [["compact-preview", "wal-created", "project-db", 1], ["compact-preview", "wal-created", "project-db", 2]]],
  ])("rejects supplemental %s before emission", (_name, tuples) => {
    expect(() => bookkeepingLines(tuples)).toThrow();
  });

  it.each([
    ["unknown phase", (c: any) => { c.a[0][0] = 6; }],
    ["unknown kind", (c: any) => { c.a[0][1] = 7; }],
    ["unknown scope", (c: any) => { c.a[0][2] = 2; }],
    ["invalid count", (c: any) => { c.a[0][3] = 0; }],
    ["out of range count", (c: any) => { c.a[0][3] = 65536; }],
    ["duplicate tuple", (c: any) => { c.a.push(c.a[0]); }],
    ["missing counterpart assertion", (c: any) => { c.r.find((row: any) => row[0] === 3)[1] = "0"; }],
    ["foreign run", (c: any) => { c.n = sha("foreign"); }],
    ["foreign manifest", (c: any) => { c.m = sha("foreign"); }],
  ])("rejects supplemental %s during extraction", (_name, change) => {
    const value = bookkeepingLines();
    value[2] = mutate(value[2]!, change);
    expect(() => extractBookkeeping(value)).toThrow();
  });

  it("refuses supplemental facts without a manifest contract or on a different producer or forbidden PG scope", () => {
    expect(() => createCertificate(matrix, {
      ...context, producer: "data", backend: "sqlite", rows: [{
        id: "cli:store", assertions: ["result", "effects"], verdict: "passed", digest: sha("store"),
      }], bookkeeping: [["compact-preview", "wal-created", "project-db", 1]],
    })).toThrow("bookkeeping-phase-receipt");
    const value = bookkeepingLines();
    value[0] = mutate(value[0]!, c => { c.a = [[0, 2, 0, 2]]; });
    expect(() => extractBookkeeping(value)).toThrow("bookkeeping-producer");
    const pg = bookkeepingLines();
    pg[3] = mutate(pg[3]!, c => { c.a = [[0, 2, 0, 2]]; });
    expect(() => extractBookkeeping(pg)).toThrow("bookkeeping-postgresql-project");
    expect(() => encodeBookkeeping([["compact-preview", "wal-created", "project-db", 1]], "postgresql")).toThrow();
    expect(encodeBookkeeping([["fault-cancellation", "shm-updated", "hook-outbox", 1]], "postgresql")).toEqual([[3, 6, 1, 1]]);
  });

  it("treats absent and empty supplementary facts identically and retains the producer capacity gate", () => {
    const options = { ...context, producer: "data", backend: "sqlite", rows: [{
      id: "cli:store", assertions: ["result", "effects"], verdict: "passed", digest: sha("store"),
    }] };
    expect(createCertificate(matrix, options)).toBe(createCertificate(matrix, { ...options, bookkeeping: [] }));
    const full = loadMatrix();
    const tuples = BOOKKEEPING_PHASES.flatMap((phase: string) => BOOKKEEPING_KINDS.flatMap((kind: string) =>
      BOOKKEEPING_SCOPES.map((scope: string) => [phase, kind, scope, 65535])));
    expect(() => createCertificate(full, { ...options,
      rows: full.filter((row: any) => !["control", "transfer"].includes(row.scenario)).map((row: any) => ({
        id: row.id, assertions: row.assertions, verdict: "passed", digest: sha(row.id),
      })), bookkeeping: tuples,
    })).toThrow("producer-budget");
  });

  it("appends readiness without changing earlier indexes and requires its direct health effects receipt", () => {
    expect(BOOKKEEPING_PHASES).toEqual([
      "compact-preview", "fault-denial", "fault-pool", "fault-cancellation", "fault-unavailable", "health-readiness",
    ]);
    const value = bookkeepingLines([["health-readiness", "shm-updated", "project-db", 1]]);
    expect(JSON.parse(value[2]!.slice(MARKER.length)).a).toEqual([[5, 6, 0, 1]]);
    expect(extractBookkeeping(value).producers[2].bookkeeping[0]).toMatchObject({ phase: "health-readiness" });
    value[2] = mutate(value[2]!, c => { c.r.find((row: any) => row[0] === 6)[1] = "1"; });
    expect(() => extractBookkeeping(value)).toThrow("bookkeeping-phase-receipt");
  });

  it.each(["cli:stats", "cli:status", "cli:doctor", "mcp:lcm_stats", "daemon:GET /health/observe"])(
    "never substitutes %s or a shared observation for direct readiness", substitute => {
      const altered = bookkeepingMatrix.map(row => row.id === "daemon:GET /health" ? { ...row, id: substitute } : row);
      expect(() => createCertificate(altered, {
        ...context, producer: "data", backend: "sqlite",
        rows: altered.filter(row => !["control", "transfer"].includes(row.scenario)).map(row => ({
          id: row.id, assertions: row.assertions, verdict: "passed", digest: sha(row.id),
        })), bookkeeping: [["health-readiness", "shm-updated", "project-db", 1]],
      })).toThrow("bookkeeping-phase-receipt");
    },
  );

  it("refuses readiness when the health declaration lacks its effects assertion", () => {
    const altered = bookkeepingMatrix.map(row => row.id === "daemon:GET /health"
      ? { ...row, assertions: ["startup-unavailable"] } : row);
    expect(() => createCertificate(altered, {
      ...context, producer: "data", backend: "sqlite",
      rows: altered.filter(row => !["control", "transfer"].includes(row.scenario)).map(row => ({
        id: row.id, assertions: row.assertions, verdict: "passed", digest: sha(row.id),
      })), bookkeeping: [["health-readiness", "shm-updated", "project-db", 1]],
    })).toThrow("bookkeeping-phase-receipt");
  });
  it("measures complete raw reporter output including ANSI rather than the outer build log", () => {
    const section = "\x1b[1m\x1b[46m RUN \x1b[49m v4.1.10 /workspace\n" + "x".repeat(60000)
      + "\n Duration 90s\n";
    expect(capturedVitestSectionBytes("build\n" + section + "outer cleanup\n")).toBe(Buffer.byteLength(section));
    expect(capturedVitestSectionBytes(" RUN /workspace\ntruncated")).toBeNull();
  });
  it("selects the full container section after a smaller completed host signal probe", () => {
    const host = "RUN  v4.1.10 /mnt/worktrees/example/lcm\n11 tests\n Duration 64s\n";
    const inner = "\x1b[1m\x1b[46m RUN \x1b[49m v4.1.10 \x1b[90m/workspace\x1b[39m\n"
      + "x".repeat(54000) + "\n\x1b[2m Duration \x1b[22m 98s\n";
    expect(capturedVitestSectionBytes(host + inner)).toBe(Buffer.byteLength(inner));
    expect(capturedVitestSectionBytes(host)).toBeNull();
    expect(capturedVitestSectionBytes(host + inner + inner)).toBeNull();
    expect(capturedVitestSectionBytes(host + inner.replace(/Duration[^\n]*/u, "incomplete"))).toBeNull();
    expect(capturedVitestSectionBytes(host + inner.replace("/workspace", "/workspace-other"))).toBeNull();
    expect(capturedVitestSectionBytes(" RUN v4.1.10 /workspace\n" + host)).toBeNull();
  });
  it("expands every producer, row and assertion and is inert under the existing sanitizer", () => {
    const emitted = lines();
    const log = emitted.join("\n");
    expect(sanitizeHarnessText(log, ["fixture-query-canary", "fixture-password", "/owned/home"])).toBe(log);
    const report = extract(emitted);
    expect(report.complete).toBe(true);
    expect(report.producers).toHaveLength(8);
    expect(report.producers[0].rows[0]).toMatchObject({
      id: "cli:help", assertions: ["grammar", "result", "effects"], verdict: "passed",
    });
    expect(report.evidenceBytes).toBeLessThanOrEqual(8192);
  });

  it.each([
    ["missing producer", (v: string[]) => v.pop()],
    ["duplicate producer", (v: string[]) => v.push(v[0]!)],
    ["missing row", (v: string[]) => { v[0] = mutate(v[0]!, (c) => { c.r = []; }); }],
    ["duplicate row", (v: string[]) => { v[0] = mutate(v[0]!, (c) => { c.r.push(c.r[0]); }); }],
    ["missing assertion bit", (v: string[]) => { v[0] = mutate(v[0]!, (c) => { c.r[0][1] = "3"; }); }],
    ["unknown assertion bit", (v: string[]) => { v[0] = mutate(v[0]!, (c) => { c.r[0][1] = "f"; }); }],
    ["manifest drift", (v: string[]) => { v[0] = mutate(v[0]!, (c) => { c.m = sha("other"); }); }],
    ["source drift", (v: string[]) => { v[0] = mutate(v[0]!, (c) => { c.s = sha("other"); }); }],
    ["mixed run", (v: string[]) => { v[0] = mutate(v[0]!, (c) => { c.n = sha("other"); }); }],
    ["failed cleanup", (v: string[]) => { v[0] = mutate(v[0]!, (c) => { c.c = 0; }); }],
    ["failed row", (v: string[]) => { v[0] = mutate(v[0]!, (c) => { c.r[0].push(0); }); }],
    ["raw canary", (v: string[]) => { v[0] = mutate(v[0]!, (c) => { c.error = "postgresql://secret/query-canary"; }); }],
    ["truncated JSON", (v: string[]) => { v[0] = v[0]!.slice(0, -1); }],
    ["duplicate JSON key", (v: string[]) => { v[0] = v[0]!.replace('"v":1', '"v":1,"v":1'); }],
    ["sanitizer mangling", (v: string[]) => { v[0] = v[0]!.replace('"d":"', '"d":"[REDACTED]'); }],
    ["capture limit", (v: string[]) => { v.push("command output exceeded capture limit"); }],
    ["oversized evidence", (v: string[]) => { v.push(MARKER + " ".repeat(8193)); }],
    ["missing runtime", (v: string[]) => { v[3] = mutate(v[3]!, (c) => { delete c.e; }); }],
    ["missing extension", (v: string[]) => { v[3] = mutate(v[3]!, (c) => { c.e.extensions.pop(); }); }],
    ["missing corpus", (v: string[]) => { v[3] = mutate(v[3]!, (c) => { delete c.e.corpus; }); }],
    ["missing corpus count", (v: string[]) => { v[3] = mutate(v[3]!, (c) => { delete c.e.corpus.projects; }); }],
    ["extra corpus field", (v: string[]) => { v[3] = mutate(v[3]!, (c) => { c.e.corpus.payload = "canary"; }); }],
    ["negative corpus count", (v: string[]) => { v[3] = mutate(v[3]!, (c) => { c.e.corpus.messages = -1; }); }],
    ["fractional corpus count", (v: string[]) => { v[3] = mutate(v[3]!, (c) => { c.e.corpus.summaries = 1.5; }); }],
    ["unsafe corpus count", (v: string[]) => { v[3] = mutate(v[3]!, (c) => { c.e.corpus.promotedCount = Number.MAX_SAFE_INTEGER + 1; }); }],
  ])("rejects %s", (_name, change) => {
    const value = lines();
    change(value);
    expect(() => extract(value)).toThrow();
  });

  it("rejects duplicate executed assertion IDs before a bitset can erase them", () => {
    expect(() => createCertificate(matrix, {
      ...context, producer: "controls", backend: "sqlite", rows: [{
        id: "cli:help", assertions: ["grammar", "grammar"], verdict: "passed", digest: sha("result"),
      }],
    })).toThrow();
  });

  it("emits explicit incomplete failure evidence without inventing remaining assertions", () => {
    const failed = createCertificate(matrix, {
      ...context, producer: "controls", backend: "sqlite", cleanup: false, rows: [{
        id: "cli:help", assertions: ["grammar"], verdict: "failed", digest: sha("failure"),
      }],
    });
    const value = lines();
    value[0] = failed;
    expect(() => extract(value)).toThrow();
    const report = extractCertificates(value.join("\n"), matrix, {
      sourceDigest: context.sourceDigest, runId: context.runId, allowIncomplete: true,
    });
    expect(report.complete).toBe(false);
    expect(report.producers[0].rows[0].assertions).toEqual(["grammar"]);
  });

  it("writes stable evidence files and correct independent SHA256 checksums", () => {
    const directory = mkdtempSync(join(tmpdir(), "lcm-parity-artifact-"));
    try {
      writeArtifacts(directory, matrix, extract(lines()), { sourceSha: "a".repeat(40) }, []);
      expect(readdirSync(directory).sort()).toEqual([
        "SHA256SUMS", "provenance.json", "regressions.json", "results.json", "surface-matrix.json",
      ]);
      const hashes = readFileSync(join(directory, "SHA256SUMS"), "utf8").trim().split("\n");
      for (const line of hashes) {
        const [digest, name] = line.split("  ");
        expect(digest).toBe(sha(readFileSync(join(directory, name!), "utf8")));
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("fits the entire current matrix, including observed runtime, in the aggregate budget", () => {
    const full = loadMatrix();
    const log = producers.map(([producer, backend]) => createCertificate(full, {
      ...context, producer, backend,
      rows: full.filter((row: any) => (row.scenario === "control" ? "controls"
        : row.scenario === "transfer" ? "transfer" : "data") === producer
        && (!row.directions || row.directions.includes(backend))).map((row: any) => ({
        id: row.id, assertions: row.assertions, verdict: "passed", digest: sha(row.id),
      })),
      ...(producer === "data" && backend === "postgresql" ? { runtime } : {}),
      ...(producer === "data" ? { bookkeeping: BOOKKEEPING_PHASES.map((phase: string) =>
        [phase, "shm-updated", backend === "postgresql" ? "hook-outbox" : "project-db", 2]) } : {}),
    }));
    const report = extractCertificates(log.join("\n"), full, context);
    expect(report.complete).toBe(true);
    expect(report.evidenceBytes).toBeLessThanOrEqual(8192);
  });

  it("materializes a complete CLI artifact and rejects replay under a different harness run", () => {
    const directory = mkdtempSync(join(tmpdir(), "lcm-parity-replay-"));
    try {
      const full = loadMatrix();
      const digest = sourceDigest();
      const certificates = producers.map(([producer, backend]) => createCertificate(full, {
        ...context, runId: "f".repeat(32), sourceDigest: digest, producer, backend,
        ...(producer === "data" && backend === "postgresql" ? { runtime } : {}),
        rows: full.filter((row: any) => (row.scenario === "control" ? "controls"
          : row.scenario === "transfer" ? "transfer" : "data") === producer
          && (!row.directions || row.directions.includes(backend))).map((row: any) => ({
          id: row.id, assertions: row.assertions, verdict: "passed", digest: sha(row.id),
        })),
      }));
      const log = join(directory, "harness.log");
      const originalLog = `PostgreSQL harness allocated run: ${"f".repeat(32)}\n RUN v4.1.10 /workspace\n${certificates.join("\n")}\n Duration 1s\n`;
      writeFileSync(log, originalLog);
      const env = { ...process.env };
      delete env.GITHUB_SHA;
      execFileSync(process.execPath, ["scripts/surface-parity-artifact.mjs", log, join(directory, "evidence")], {
        env, stdio: "pipe",
      });
      expect(JSON.parse(readFileSync(join(directory, "evidence/results.json"), "utf8")).complete).toBe(true);
      const host = " RUN v4.1.10 /host/checkout\n Duration 1s\n";
      writeFileSync(log, host + originalLog.replace(" Duration 1s", "x".repeat(65536) + "\n Duration 1s"));
      expect(() => execFileSync(process.execPath, ["scripts/surface-parity-artifact.mjs", log, join(directory, "evidence")], {
        env, stdio: "pipe",
      })).toThrow();
      expect(JSON.parse(readFileSync(join(directory, "evidence/results.json"), "utf8"))).toMatchObject({
        complete: false, errors: ["surface-evidence:capture-measurement"],
      });
      writeFileSync(log, originalLog.replace(`run: ${"f".repeat(32)}`, `run: ${"0".repeat(32)}`));
      expect(() => execFileSync(process.execPath, ["scripts/surface-parity-artifact.mjs", log, join(directory, "evidence")], {
        env, stdio: "pipe",
      })).toThrow();
      const report = JSON.parse(readFileSync(join(directory, "evidence/results.json"), "utf8"));
      expect(report.complete).toBe(false);
      expect(report.errors).toEqual(["surface-evidence:mixed-run"]);
      const regressions = JSON.parse(readFileSync(join(directory, "evidence/regressions.json"), "utf8"));
      expect(regressions.upstream.every((entry: any) => entry.freshExecution === false)).toBe(true);
      expect(REGRESSION_PROVENANCE.find((entry: any) => entry.issue === 948)).toMatchObject({ pr: 1061 });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("records dirty local checkout metadata without exposing filenames or rejecting valid evidence", () => {
    const directory = mkdtempSync(join(tmpdir(), "lcm-parity-git-"));
    const root = join(directory, "checkout");
    try {
      for (const name of ["bin", "installer", "src", "test/surface-parity", "scripts", ".github"])
        mkdirSync(join(root, name), { recursive: true });
      for (const name of ["surface-parity-artifact.mjs", "postgresql-images.mjs"])
        copyFileSync(new URL(`../../scripts/${name}`, import.meta.url), join(root, "scripts", name));
      writeFileSync(join(root, "test/surface-parity/surface-matrix.json"), JSON.stringify(matrix, null, 2) + "\n");
      writeFileSync(join(root, "fixture-note.txt"), "baseline\n");
      writeFileSync(join(root, ".gitignore"), "ignored-note.txt\n");
      const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe", encoding: "utf8" });
      git("init");
      git("add", ".");
      git("-c", "user.name=Parity Fixture", "-c", "user.email=parity@example.invalid", "-c", "commit.gpgsign=false",
        "-c", `core.hooksPath=${join(root, ".git/hooks")}`, "commit", "--signoff", "-m", "Create parity fixture",
        "-m", "Provide an isolated baseline for checkout provenance assertions.");
      expect(workingTreeClean(root)).toBe(true);
      const runId = "f".repeat(32);
      const digest = sourceDigest(root);
      const certificates = producers.map(([producer, backend]) => createCertificate(matrix, {
        ...context, sourceDigest: digest, runId, producer, backend,
        ...(producer === "data" && backend === "postgresql" ? { runtime } : {}),
        rows: matrix.filter(row => (row.scenario === "control" ? "controls"
          : row.scenario === "transfer" ? "transfer" : "data") === producer).map(row => ({
          id: row.id, assertions: row.assertions, verdict: "passed", digest: sha(row.id),
        })),
      }));
      const log = join(directory, "harness.log");
      const output = join(directory, "evidence");
      writeFileSync(log, `PostgreSQL harness allocated run: ${runId}\n RUN v4.1.10 /workspace\n${certificates.join("\n")}\n Duration 1s\n`);
      const env = { ...process.env };
      delete env.GITHUB_SHA;
      const extractFixture = () => {
        execFileSync(process.execPath, [join(root, "scripts/surface-parity-artifact.mjs"), log, output], { env, stdio: "pipe" });
        return JSON.parse(readFileSync(join(output, "provenance.json"), "utf8"));
      };
      const clean = extractFixture();
      expect(clean).toMatchObject({ workingTreeClean: true, testedShaMeaning: "checkout-revision" });
      writeFileSync(join(root, "fixture-note.txt"), "changed\n");
      const dirty = extractFixture();
      expect(dirty).toMatchObject({ workingTreeClean: false, testedShaMeaning: "base-checkout-metadata",
        testedSha: clean.testedSha, sourceContentDigest: digest });
      expect(JSON.stringify(dirty)).not.toContain("fixture-note.txt");
      writeFileSync(join(root, "fixture-note.txt"), "baseline\n");
      expect(workingTreeClean(root)).toBe(true);
      writeFileSync(join(root, "untracked-note.txt"), "untracked\n");
      expect(workingTreeClean(root)).toBe(false);
      rmSync(join(root, "untracked-note.txt"));
      writeFileSync(join(root, "ignored-note.txt"), "ignored\n");
      expect(workingTreeClean(root)).toBe(true);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
