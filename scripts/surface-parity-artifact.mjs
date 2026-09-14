#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NODE_IMAGE, POSTGRES_IMAGE } from "./postgresql-images.mjs";

export const MARKER = "LCM_SURFACE_PARITY_V1 ";
export const MAX_EVIDENCE_BYTES = 8192;
const LIMITS = { c: 768, d: 1536, t: 896 };
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIRECTIONS = ["sqlite->sqlite", "sqlite->postgresql", "postgresql->sqlite", "postgresql->postgresql"];
const SYMBOLS = { controls: "c", data: "d", transfer: "t", sqlite: "s", postgresql: "p" };
const BACKENDS = { s: "sqlite", p: "postgresql", ss: DIRECTIONS[0], sp: DIRECTIONS[1], ps: DIRECTIONS[2], pp: DIRECTIONS[3] };
const PRODUCTION = { c: "controls", d: "data", t: "transfer" };
const EXPECTED = ["c:s", "c:p", "d:s", "d:p", "t:ss", "t:sp", "t:ps", "t:pp"];
const EXTENSIONS = ["pg_stat_statements", "pg_trgm", "pgcrypto", "unaccent"];
export const BOOKKEEPING_PHASES = Object.freeze(["compact-preview", "fault-denial", "fault-pool", "fault-cancellation", "fault-unavailable", "health-readiness"]);
export const BOOKKEEPING_KINDS = Object.freeze(["database-bytes-changed", "wal-created", "wal-removed", "wal-updated", "shm-created", "shm-removed", "shm-updated"]);
export const BOOKKEEPING_SCOPES = Object.freeze(["project-db", "hook-outbox"]);
const BOOKKEEPING_CONTRACTS = [
  [["cli:compact", "effects"]],
  [["daemon:POST /search", "backend-denial"]],
  [["daemon:POST /search", "pool-exhaustion"]],
  [["daemon:POST /search", "cancellation"], ["daemon:POST /compact", "cancellation"]],
  [["daemon:GET /health", "startup-unavailable"]],
  [["daemon:GET /health", "effects"]],
];
const BOOKKEEPING_REASON = "Authenticated SQLite engine bookkeeping in the declared phase; native schema, logical rows, journal mode, file authority, metadata and configuration remain unchanged.";
const hex = /^[a-f0-9]{64}$/u;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const json = (value) => JSON.stringify(value, null, 2) + "\n";
const check = (condition, code) => { if (!condition) throw new Error(`surface-evidence:${code}`); };
const owner = (row) => row.scenario === "control" ? "c" : row.scenario === "transfer" ? "t" : "d";
const backendSymbol = (backend) => SYMBOLS[backend]
  ?? (DIRECTIONS.includes(backend) ? backend.split("->").map((part) => SYMBOLS[part]).join("") : undefined);
const sourceDigests = new Map();

export function loadMatrix(root = ROOT) {
  const bytes = readFileSync(join(root, "test/surface-parity/surface-matrix.json"), "utf8");
  const matrix = JSON.parse(bytes);
  check(json(matrix) === bytes, "matrix-encoding");
  validateMatrix(matrix);
  return matrix;
}

function validateMatrix(matrix) {
  check(Array.isArray(matrix) && matrix.length > 0, "matrix");
  const ids = new Set();
  for (const row of matrix) {
    check(typeof row.id === "string" && !ids.has(row.id), "matrix-row");
    ids.add(row.id);
    check(Array.isArray(row.assertions) && row.assertions.length > 0
      && row.assertions.every((id) => typeof id === "string")
      && new Set(row.assertions).size === row.assertions.length, "matrix-assertions");
    if (row.directions !== undefined) check(owner(row) === "t" && Array.isArray(row.directions)
      && row.directions.length > 0 && new Set(row.directions).size === row.directions.length
      && row.directions.every((direction) => DIRECTIONS.includes(direction)), "matrix-directions");
  }
}

// Content binding works inside the read-only CI mount, where a worktree's .git
// indirection can point outside the container. The host records git identity
// separately. No generated evidence, private fixture, dist or dependency tree
// participates in this digest.
export function sourceDigest(root = ROOT) {
  if (sourceDigests.has(root)) return sourceDigests.get(root);
  const files = [];
  function collect(path) {
    for (const entry of readdirSync(join(root, path), { withFileTypes: true })) {
      const name = join(path, entry.name);
      if (entry.isDirectory()) collect(name);
      else if (entry.isFile()) files.push(name);
      else check(false, "source-file-kind");
    }
  }
  for (const path of ["bin", "installer", "src", "test", "scripts", ".github"]) collect(path);
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isFile() && (/\.(?:[cm]?tsx?|[cm]?jsx?|json|ya?ml)$/u.test(entry.name)
      || [".npmrc", ".nvmrc"].includes(entry.name))) files.push(entry.name);
  }
  const digest = createHash("sha256");
  for (const name of files.sort()) digest.update(name.replaceAll("\\", "/") + "\0")
    .update(hash(readFileSync(join(root, name))) + "\n");
  const result = digest.digest("hex");
  sourceDigests.set(root, result);
  return result;
}

function expectedRows(matrix, producer, backend) {
  return matrix.flatMap((row, index) => owner(row) === producer
    && (producer !== "t" || !row.directions || row.directions.includes(BACKENDS[backend])) ? [index] : []);
}

function validateRuntime(value) {
  check(value && Object.keys(value).sort().join() === "corpus,extensions,node,postgres", "runtime-schema");
  check(value.corpus && Object.keys(value.corpus).sort().join()
    === "conversations,messages,projects,promotedCount,summaries"
    && Object.values(value.corpus).every((count) => Number.isSafeInteger(count) && count >= 0),
  "runtime-corpus");
  check(typeof value.node === "string" && /^\d+\.\d+\.\d+$/u.test(value.node)
    && Number.isSafeInteger(value.postgres) && Math.floor(value.postgres / 10000) === 18
    && Array.isArray(value.extensions), "runtime-values");
  const names = new Set();
  for (const tuple of value.extensions) {
    check(Array.isArray(tuple) && tuple.length === 2 && /^[a-z][a-z0-9_]*$/u.test(tuple[0])
      && /^\d+(?:\.\d+)*$/u.test(tuple[1]) && !names.has(tuple[0]), "runtime-extensions");
    names.add(tuple[0]);
  }
  check([...names].sort().join() === EXTENSIONS.join(), "runtime-extension-set");
}

function validateBookkeepingIndexes(tuples, backend) {
  check(Array.isArray(tuples), "bookkeeping-schema");
  const seen = new Set();
  for (const tuple of tuples) {
    check(Array.isArray(tuple) && tuple.length === 4, "bookkeeping-tuple");
    const [phase, kind, scope, count] = tuple;
    check(Number.isInteger(phase) && phase >= 0 && phase < BOOKKEEPING_PHASES.length
      && Number.isInteger(kind) && kind >= 0 && kind < BOOKKEEPING_KINDS.length
      && Number.isInteger(scope) && scope >= 0 && scope < BOOKKEEPING_SCOPES.length, "bookkeeping-index");
    check(Number.isInteger(count) && count > 0 && count <= 65535, "bookkeeping-count");
    check(backend !== "p" || scope !== 0, "bookkeeping-postgresql-project");
    const key = `${phase}:${kind}:${scope}`;
    check(!seen.has(key), "bookkeeping-duplicate");
    seen.add(key);
  }
}

/** Accept only aggregate symbolic facts; authenticated fixture paths stay internal. */
export function encodeBookkeeping(tuples, backend) {
  check(backend === "sqlite" || backend === "postgresql", "bookkeeping-backend");
  check(Array.isArray(tuples), "bookkeeping-schema");
  const encoded = tuples.map((tuple) => {
    check(Array.isArray(tuple) && tuple.length === 4, "bookkeeping-tuple");
    return [BOOKKEEPING_PHASES.indexOf(tuple[0]), BOOKKEEPING_KINDS.indexOf(tuple[1]),
      BOOKKEEPING_SCOPES.indexOf(tuple[2]), tuple[3]];
  });
  validateBookkeepingIndexes(encoded, SYMBOLS[backend]);
  return encoded.sort((left, right) => left[0] - right[0] || left[1] - right[1] || left[2] - right[2]);
}

function expandBookkeeping(tuples, matrix, producer, backend, rows) {
  check(producer === "d", "bookkeeping-producer");
  validateBookkeepingIndexes(tuples, backend);
  return tuples.map(([phase, kind, scope, count]) => {
    for (const [id, assertion] of BOOKKEEPING_CONTRACTS[phase]) {
      const index = matrix.findIndex((row) => row.id === id);
      const declaration = matrix[index];
      const bit = declaration?.assertions.indexOf(assertion) ?? -1;
      const result = rows.find((row) => row[0] === index);
      check(declaration && owner(declaration) === "d" && bit >= 0 && result
        && (BigInt(`0x${result[1]}`) & (1n << BigInt(bit))) !== 0n, "bookkeeping-phase-receipt");
    }
    return { phase: BOOKKEEPING_PHASES[phase], kind: BOOKKEEPING_KINDS[kind],
      scope: BOOKKEEPING_SCOPES[scope], count, reason: BOOKKEEPING_REASON };
  });
}

/** Only executed assertion IDs enter the bitset. A failed row may be partial. */
export function createCertificate(matrix, options) {
  validateMatrix(matrix);
  const p = SYMBOLS[options.producer];
  const b = backendSymbol(options.backend);
  check(EXPECTED.includes(`${p}:${b}`), "producer");
  check(hex.test(options.sourceDigest) && typeof options.runId === "string" && options.runId.length > 0,
    "identity");
  check(typeof options.cleanup === "boolean" && Array.isArray(options.rows), "results");
  const allowed = new Set(expectedRows(matrix, p, b));
  const seen = new Set();
  const results = options.rows.map((row) => {
    const index = matrix.findIndex((entry) => entry.id === row.id);
    check(allowed.has(index) && !seen.has(index), "row-owner");
    seen.add(index);
    check(row.verdict === "passed" || row.verdict === "failed", "verdict");
    check(hex.test(row.digest) && Array.isArray(row.assertions), "row-result");
    const assertions = new Set();
    let bits = 0n;
    for (const id of row.assertions) {
      const bit = matrix[index].assertions.indexOf(id);
      check(bit >= 0 && !assertions.has(id), "assertion-id");
      assertions.add(id);
      bits |= 1n << BigInt(bit);
    }
    check(row.verdict !== "passed" || assertions.size === matrix[index].assertions.length, "incomplete-row");
    return { index, bits: bits.toString(16), verdict: row.verdict, digest: row.digest };
  }).sort((left, right) => left.index - right.index);
  const certificate = {
    v: 1, m: hash(json(matrix)), s: options.sourceDigest, n: hash(options.runId), p, b,
    r: results.map((row) => row.verdict === "passed" ? [row.index, row.bits] : [row.index, row.bits, 0]),
    d: hash(JSON.stringify(results)), c: options.cleanup ? 1 : 0,
  };
  if (options.bookkeeping !== undefined) {
    check(p === "d", "bookkeeping-producer");
    const tuples = encodeBookkeeping(options.bookkeeping, options.backend);
    expandBookkeeping(tuples, matrix, p, b, certificate.r);
    if (tuples.length > 0) certificate.a = tuples;
  }
  if (p === "d") certificate.d = hash(JSON.stringify({ results, bookkeeping: certificate.a ?? [] }));
  if (options.runtime !== undefined) {
    check(p === "d" && b === "p", "runtime-owner");
    validateRuntime(options.runtime);
    certificate.e = options.runtime;
  }
  const line = MARKER + JSON.stringify(certificate);
  check(Buffer.byteLength(line + "\n") <= LIMITS[p], "producer-budget");
  // A closed alphabet prevents URL, PEM, query, home and error-text canaries.
  check(!/postgres(?:ql)?:\/\/|-----BEGIN|[\\\r\n]|\[REDACTED/u.test(line), "unsafe-envelope");
  return line;
}

export function extractCertificates(log, matrix, options) {
  validateMatrix(matrix);
  check(hex.test(options.sourceDigest), "source-digest");
  check(!/exceeded.{0,30}capture limit/iu.test(log), "capture-limit");
  const errors = [];
  const producers = [];
  let evidenceBytes = 0;
  let runDigest = options.runId === undefined ? undefined : hash(options.runId);
  const seen = new Set();
  for (const rawLine of log.split(/\r?\n/u)) {
    const start = rawLine.indexOf(MARKER);
    if (start < 0) continue;
    const line = rawLine.slice(start).replace(/\x1b\[[0-9;]*m/gu, "");
    evidenceBytes += Buffer.byteLength(rawLine.slice(start) + "\n");
    check(evidenceBytes <= MAX_EVIDENCE_BYTES, "total-budget");
    const payload = line.slice(MARKER.length);
    let cert;
    try { cert = JSON.parse(payload); } catch { check(false, "invalid-json"); }
    check(JSON.stringify(cert) === payload, "noncanonical-json");
    check(cert && Object.keys(cert).sort().join() === ["b", "c", "d", "m", "n", "p", "r", "s", "v",
      ...(cert.e === undefined ? [] : ["e"]), ...(cert.a === undefined ? [] : ["a"])].sort().join(), "schema");
    const key = `${cert.p}:${cert.b}`;
    check(cert.v === 1 && EXPECTED.includes(key), "producer");
    check(Buffer.byteLength(line + "\n") <= LIMITS[cert.p], "producer-budget");
    check(!seen.has(key), "duplicate-producer");
    seen.add(key);
    check(cert.m === hash(json(matrix)), "manifest-drift");
    check(cert.s === options.sourceDigest, "source-drift");
    check(hex.test(cert.n) && hex.test(cert.d), "digest");
    runDigest ??= cert.n;
    check(cert.n === runDigest, "mixed-run");
    check(cert.c === 0 || cert.c === 1, "cleanup-schema");
    if (cert.c !== 1) errors.push(`${key}:cleanup`);
    if (cert.e !== undefined) {
      check(key === "d:p", "runtime-owner");
      validateRuntime(cert.e);
    }
    if (key === "d:p" && cert.e === undefined) errors.push(`${key}:missing-runtime`);
    const expected = expectedRows(matrix, cert.p, cert.b);
    const found = new Set();
    check(Array.isArray(cert.r), "rows-schema");
    let previous = -1;
    const rows = cert.r.map((tuple) => {
      check(Array.isArray(tuple) && (tuple.length === 2 || tuple.length === 3 && tuple[2] === 0), "row-schema");
      const [index, value] = tuple;
      check(Number.isSafeInteger(index) && expected.includes(index) && index > previous && !found.has(index), "row-index");
      previous = index;
      found.add(index);
      check(typeof value === "string" && /^(?:0|[1-9a-f][0-9a-f]*)$/u.test(value), "assertion-bits");
      const bits = BigInt(`0x${value}`);
      const row = matrix[index];
      const all = (1n << BigInt(row.assertions.length)) - 1n;
      check((bits & ~all) === 0n, "unknown-assertion");
      const passed = tuple.length === 2;
      if (!passed || bits !== all) errors.push(`${key}:${index}:incomplete`);
      return { id: row.id, assertions: row.assertions.filter((_id, bit) => (bits & (1n << BigInt(bit))) !== 0n),
        verdict: passed && bits === all ? "passed" : "failed", expectation: row.expectation,
        ...(row.architectureReason ? { architectureReason: row.architectureReason } : {}) };
    });
    if (found.size !== expected.length) errors.push(`${key}:missing-rows`);
    const bookkeeping = cert.a === undefined ? [] : expandBookkeeping(cert.a, matrix, cert.p, cert.b, cert.r);
    producers.push({ producer: PRODUCTION[cert.p], backend: BACKENDS[cert.b], rows,
      digest: cert.d, cleanup: cert.c === 1, ...(cert.e ? { runtime: cert.e } : {}),
      ...(bookkeeping.length > 0 ? { bookkeeping } : {}) });
  }
  for (const key of EXPECTED) if (!seen.has(key)) errors.push(`${key}:missing-producer`);
  const complete = errors.length === 0;
  check(options.allowIncomplete || complete, "incomplete");
  producers.sort((left, right) => EXPECTED.indexOf(`${SYMBOLS[left.producer]}:${backendSymbol(left.backend)}`)
    - EXPECTED.indexOf(`${SYMBOLS[right.producer]}:${backendSymbol(right.backend)}`));
  return { version: 1, manifestDigest: hash(json(matrix)), sourceDigest: options.sourceDigest,
    runDigest, complete, errors, evidenceBytes, producers };
}

// Reviewed upstream provenance. Historical tests and fixes never become fresh
// regression receipts merely because this run passes its surface denominator.
export const REGRESSION_PROVENANCE = [
  {
    "issue": 888,
    "pr": 1011,
    "merge_sha": "b15cb23ae3f60e34cc03901218db968e13b5f5d8",
    "production": [
      "src/daemon/routes/compact.ts",
      "src/daemon/routes/ingest.ts"
    ],
    "tests": [
      "test/codecov-config.test.ts",
      "test/daemon/routes/compact.test.ts",
      "test/daemon/routes/coverage-compact.test.ts",
      "test/daemon/routes/ingest-boundaries.test.ts",
      "test/daemon/routes/ingest.test.ts"
    ],
    "documentation": [
      "docs/privacy.md"
    ]
  },
  {
    "issue": 889,
    "pr": 1056,
    "merge_sha": "04f1f68894432693acd3357564e304e026e46fae",
    "production": [
      "src/portable-knowledge.ts"
    ],
    "tests": [
      "test/codecov-config.test.ts",
      "test/portable-knowledge.test.ts"
    ],
    "documentation": [
      "docs/privacy.md"
    ]
  },
  {
    "issue": 935,
    "pr": 984,
    "merge_sha": "cfb8242ec5e508c224edd3786b14c7aeebd76027",
    "production": [
      "src/db/connection.ts",
      "src/db/database-parent.ts",
      "src/hooks/events-db.ts",
      "src/storage/local-hook-event-sequence.ts"
    ],
    "tests": [
      "test/codecov-config.test.ts",
      "test/db/connection-extended.test.ts",
      "test/db/database-parent.test.ts",
      "test/hooks/events-db-failures.test.ts",
      "test/hooks/events-db.test.ts",
      "test/storage/local-hook-event-sequence.test.ts"
    ],
    "documentation": [
      "docs/configuration.md"
    ]
  },
  {
    "issue": 964,
    "pr": 1078,
    "merge_sha": "7741d6917f5f77234ac734c727b40afc8cc3ac21",
    "production": [
      "src/daemon/routes/promote.ts"
    ],
    "tests": [
      "test/codecov-config.test.ts",
      "test/daemon/routes/promote-boundaries.test.ts",
      "test/daemon/routes/promote-metadata-files.test.ts"
    ],
    "documentation": [
      "docs/privacy.md"
    ]
  },
  {
    "issue": 972,
    "pr": 1001,
    "merge_sha": "ff7e34cf7234d5723bb72ebcdcacf60cbd5b96a4",
    "production": [
      "src/memory/index.ts"
    ],
    "tests": [
      "test/codecov-config.test.ts",
      "test/memory/search-route-contract.test.ts",
      "test/memory/search-type-contract.test.ts"
    ],
    "documentation": [
      "docs/agent-tools.md"
    ]
  },
  {
    "issue": 973,
    "pr": 1006,
    "merge_sha": "6407ae4375a17b1d5a4cf0ef03bce20252ff1ae1",
    "production": [
      "src/stats.ts"
    ],
    "tests": [
      "test/bin/lcm-run-cli.test.ts",
      "test/codecov-config.test.ts",
      "test/coverage-services-stats.test.ts",
      "test/stats-security.test.ts"
    ],
    "documentation": [
      "docs/cli.md"
    ]
  },
  {
    "issue": 978,
    "pr": 1037,
    "merge_sha": "b636b390c1799d04ab15452d6db49f2102d83d48",
    "production": [
      "bin/lcm.ts"
    ],
    "tests": [
      "test/bin/compact-lifecycle.test.ts",
      "test/codecov-config.test.ts"
    ],
    "documentation": [
      "docs/cli.md"
    ]
  },
  {
    "issue": 982,
    "pr": 1035,
    "merge_sha": "fe78ed1392e784cc122fca71a3c9ad115831bce7",
    "production": [
      "src/doctor/doctor.ts"
    ],
    "tests": [
      "test/doctor/doctor.test.ts"
    ],
    "documentation": [
      "docs/cli.md"
    ]
  },
  {
    "issue": 989,
    "pr": 1058,
    "merge_sha": "602adb805fd3a7b88a197589ef9723b5ec99db20",
    "production": [
      "src/db/event-sidecars.ts"
    ],
    "tests": [
      "test/codecov-config.test.ts",
      "test/db/event-sidecars-discovery.test.ts",
      "test/db/event-sidecars-parent-security.test.ts"
    ],
    "documentation": [
      "docs/passive-learning.md"
    ]
  },
  {
    "issue": 992,
    "pr": 1057,
    "merge_sha": "e48bc92f374a2bdf52ebf861131d61c1a22881b3",
    "production": [
      "src/db/connection.ts"
    ],
    "tests": [
      "test/codecov-config.test.ts",
      "test/db/connection-extended.test.ts",
      "test/db/connection-leaf-initialization.test.ts"
    ],
    "documentation": [
      "docs/architecture.md"
    ]
  },
  {
    "issue": 948,
    "pr": 1061,
    "merge_sha": "b0df28e7307e3eb225ba60fea2c9f55fe5f4c933",
    "relationship": "precursor-preserved-by-964",
    "production": [
      "src/daemon/routes/promote.ts"
    ]
  },
  {
    "issue": 1122,
    "pr": 1145,
    "merge_sha": "6a18f634534ecc27c52424d5ec1bdd1709e36127",
    "scope": "source-worker compatibility, observed pool counts, selected-backend failure metadata"
  },
  {
    "issue": 1123,
    "pr": 1145,
    "merge_sha": "6a18f634534ecc27c52424d5ec1bdd1709e36127",
    "scope": "source-worker compatibility, observed pool counts, selected-backend failure metadata"
  },
  {
    "issue": 1124,
    "pr": 1145,
    "merge_sha": "6a18f634534ecc27c52424d5ec1bdd1709e36127",
    "scope": "source-worker compatibility, observed pool counts, selected-backend failure metadata"
  },
  {
    "issue": 1146,
    "pr": 1159,
    "merge_sha": "48d3167b9511542e26fa63f19fc5a0efcb335353",
    "scope": "metadata-only aggregate directories and selected missing-project refusal"
  },
  {
    "issue": 1082,
    "pr": 1164,
    "merge_sha": "35ce9cc6cbeeb521b0b96c62ac0f9125f6ff80a5",
    "scope": "promoted knowledge NUL refusal"
  },
  {
    "issue": 1158,
    "disposition": "separately-owned; public promotion and passive provenance must be probed"
  },
  {
    "issue": 1176,
    "disposition": "separately-owned declaration portability limitation; runtime test is not declaration certification"
  },
  {
    "issue": 1140,
    "disposition": "fixed upstream by PR1212; historical fixed-scalar materialization bound provenance, not a fresh malformed-input receipt"
  },
  {
    "issue": 1194,
    "disposition": "separately owned native session-end completion-delivery defect; outside parity inventory; no fresh regression receipt"
  },
  {
    "issue": 1195,
    "disposition": "separately owned canonical PostgreSQL migration-asset startup defect; outside parity inventory; no fresh regression receipt"
  },
  {
    "issue": 1201,
    "disposition": "separately owned CLI status SHM inode change and doctor WAL/SHM removal observation; outside parity inventory; no unlink, fix or fresh regression receipt claim"
  },
  {
    "issue": 1203,
    "disposition": "separately owned default PostgreSQL prompt recall score mismatch; historical failure provenance, no fresh issue-specific regression receipt"
  },
  {
    "issue": 1205,
    "disposition": "test-adapter typing outside the production typecheck; runtime surface assertions do not certify every test adapter annotation"
  },
  {
    "issue": 1206,
    "disposition": "exact deduplication recall can miss a row beyond a saturated candidate page; ordinary unsaturated promotion fixtures do not certify arbitrary candidate-page saturation"
  }
];

export function writeArtifacts(directory, matrix, report, provenance, regressions) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const contents = {
    "surface-matrix.json": matrix, "results.json": report,
    "provenance.json": provenance, "regressions.json": regressions,
  };
  for (const [name, value] of Object.entries(contents)) writeFileSync(join(directory, name), json(value), { mode: 0o600 });
  const sums = Object.keys(contents).sort().map((name) => `${hash(readFileSync(join(directory, name)))}  ${name}\n`).join("");
  writeFileSync(join(directory, "SHA256SUMS"), sums, { mode: 0o600 });
}

export function capturedVitestSectionBytes(log) {
  // The CI path first runs a host signal probe, then the full /workspace
  // container suite. Match headers on normalized text, but count original bytes.
  const lines = log.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
  const plain = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/gu, ""));
  const starts = plain.flatMap((line, index) =>
    /^\s*RUN\s+v\S+\s+\/workspace\s*$/u.test(line) ? [index] : []);
  if (starts.length !== 1) return null;
  const start = starts[0];
  for (let index = start + 1; index < lines.length; index++) {
    if (/^\s*RUN\s/u.test(plain[index])) return null;
    if (/^\s*Duration\s+\S/u.test(plain[index])) {
      return Buffer.byteLength(lines.slice(start, index + 1).join(""));
    }
  }
  return null;
}

export function workingTreeClean(root = ROOT) {
  return execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=normal", "--ignore-submodules=none", "-z"], {
    cwd: root, encoding: "utf8",
  }).length === 0;
}

export function main(argv = process.argv.slice(2)) {
  check(argv.length === 2, "usage-log-output");
  const [logPath, directory] = argv;
  const log = readFileSync(logPath, "utf8");
  const matrix = loadMatrix();
  const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  check(/^[a-f0-9]{40}$/u.test(sourceSha), "source-sha");
  if (process.env.GITHUB_SHA) check(process.env.GITHUB_SHA === sourceSha, "tested-sha");
  const clean = workingTreeClean();
  let report;
  try {
    const allocations = [...log.matchAll(/^PostgreSQL harness allocated run: ([a-f0-9]{32})\r?$/gmu)];
    check(allocations.length === 1, "harness-run");
    report = extractCertificates(log, matrix, {
      sourceDigest: sourceDigest(), runId: allocations[0][1], allowIncomplete: true,
    });
    if (report.complete) {
      const sectionBytes = capturedVitestSectionBytes(log);
      check(sectionBytes !== null && sectionBytes < 65536, "capture-measurement");
    }
  } catch (error) {
    report = { version: 1, complete: false, errors: [error instanceof Error && /^surface-evidence:[a-z-]+$/u.test(error.message)
      ? error.message : "surface-evidence:invalid"], producers: [] };
  }
  const url = process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : null;
  const provenance = {
    sourceSha, testedSha: sourceSha, candidateSha: process.env.LCM_PARITY_CANDIDATE_SHA ?? null,
    workingTreeClean: clean, testedShaMeaning: clean ? "checkout-revision" : "base-checkout-metadata",
    command: "GITHUB_ACTIONS=true pnpm run test:postgresql", extractorRuntime: process.versions.node,
    images: { node: NODE_IMAGE, postgresql: POSTGRES_IMAGE }, runUrl: url,
    job: process.env.GITHUB_JOB ?? null, attempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    leg: process.env.LCM_PARITY_LEG ?? null, normalizationVersion: 1,
    evidenceBudgetBytes: MAX_EVIDENCE_BYTES, harnessStreamCapBytes: 65536,
    capturedLogBytes: Buffer.byteLength(log), evidenceBytes: report.evidenceBytes ?? 0,
    capturedVitestSectionBytes: capturedVitestSectionBytes(log),
    observedRuntime: report.producers.find((producer) => producer.runtime)?.runtime ?? null,
    cleanup: report.complete, sourceContentDigest: report.sourceDigest ?? null,
  };
  const regressions = {
    upstream: REGRESSION_PROVENANCE.map((entry) => ({ ...entry,
      classification: "historical-provenance", freshExecution: false })),
    inventoryReferences: matrix.filter((row) => row.regressionIssues?.length).map((row) => ({
      row: row.id, issues: row.regressionIssues, source: row.source,
      classification: "inventory-provenance", freshExecution: false,
    })),
    receiptPolicy: "Only an explicit issue-specific assertion receipt can certify a fresh regression; see results.json for surface assertions.",
  };
  writeArtifacts(directory, matrix, report, provenance, regressions);
  check(report.complete, "incomplete");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) {
    console.error(error instanceof Error && /^surface-evidence:[a-z-]+$/u.test(error.message)
      ? error.message : "surface-evidence:extraction-failed");
    process.exitCode = 1;
  }
}
