import { AssertionError } from "node:assert/strict";
import { createHash } from "node:crypto";
import { posix } from "node:path";

// Worker-only JSON observations, never raw subprocess output. Limits also bound
// IPC digest work. Errors carry fixed IDs/digests, not node:assert object diffs.
const MAX_BYTES = 262_144;
const MAX_DEPTH = 64;
const MAX_NODES = 20_000;
const EXPECTATIONS = new Set(["shared-data", "backend-independent-control", "architecture-specific", "grammar"]);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const plain = value => value !== null && typeof value === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const symbol = value => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,79}$/.test(value);

function fail(code) {
  throw new AssertionError({ message: `surface-parity:${code}` });
}

function requireThat(condition, code) {
  if (!condition) fail(code);
}

function keysExactly(value, allowed, required = allowed) {
  return plain(value) && Object.keys(value).every(key => allowed.includes(key)) && required.every(key => own(value, key));
}

function canonical(value, allowMarkers = true) {
  let nodes = 0;
  let bytes = 0;
  const visiting = new Set();
  function visit(item, depth) {
    requireThat(++nodes <= MAX_NODES && depth <= MAX_DEPTH, "observation-limit");
    if (item === null || typeof item === "boolean") return item;
    if (typeof item === "number") {
      requireThat(Number.isFinite(item) && !Object.is(item, -0), "invalid-observation");
      return item;
    }
    if (typeof item === "string") {
      bytes += Buffer.byteLength(item);
      requireThat(bytes <= MAX_BYTES, "observation-limit");
      return item;
    }
    requireThat(typeof item === "object" && !visiting.has(item), "invalid-observation");
    requireThat(Array.isArray(item) || plain(item), "invalid-observation");
    requireThat(Object.getOwnPropertySymbols(item).length === 0, "invalid-observation");
    visiting.add(item);
    const descriptors = Object.getOwnPropertyDescriptors(item);
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (Array.isArray(item) && key === "length") continue;
      requireThat(own(descriptor, "value") && descriptor.enumerable, "invalid-observation");
      requireThat(allowMarkers || key !== "$parity", "reserved-observation-key");
    }
    let result;
    if (Array.isArray(item)) {
      requireThat(Object.keys(item).length === item.length, "invalid-observation");
      result = Array.from({ length: item.length }, (_, i) => {
        requireThat(own(item, i), "invalid-observation");
        return visit(item[i], depth + 1);
      });
    } else {
      result = Object.fromEntries(Object.keys(item).sort().map(key => {
        bytes += Buffer.byteLength(key);
        requireThat(bytes <= MAX_BYTES, "observation-limit");
        return [key, visit(item[key], depth + 1)];
      }));
    }
    visiting.delete(item);
    return result;
  }
  const result = visit(value, 0);
  requireThat(Buffer.byteLength(JSON.stringify(result)) <= MAX_BYTES, "observation-limit");
  return result;
}

/** Deterministic digest preserves Unicode, nulls, types, order and all fields. */
export function semanticDigest(value) {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

/** Uses bounded errors without retaining the actual/expected sensitive values. */
export function assertSemanticEqual(actual, expected, assertionId) {
  requireThat(symbol(assertionId), "invalid-assertion-id");
  const actualDigest = semanticDigest(actual);
  const expectedDigest = semanticDigest(expected);
  if (actualDigest !== expectedDigest) fail(`${assertionId}:actual=${actualDigest}:expected=${expectedDigest}`);
}

/**
 * Explicit normalization policy, with no recursive key stripping or regexes:
 * paths: [{pointer, root, label}] maps one owned absolute path, preserving suffix;
 * identities: [{pointers, values:[{value,label}]}] supplies a complete bijection;
 * volatile: [{pointer,kind}] validates timestamp/port/pid/timing before masking.
 * Every pointer must exist, every binding must be observed, and rules must not
 * overlap. JSON pointer wildcards are unsupported. Raw $parity keys are rejected
 * so source values cannot impersonate the tagged normalized representations.
 */
export function normalizeObservation(value, policy = {}) {
  requireThat(keysExactly(policy, ["paths", "identities", "volatile"], []), "invalid-normalization-policy");
  const result = canonical(value, false);
  const claimed = [];
  function location(pointer) {
    requireThat(typeof pointer === "string" && pointer.startsWith("/") && !/~(?:[^01]|$)/.test(pointer), "invalid-normalization-pointer");
    const parts = pointer.slice(1).split("/").map(part => part.replace(/~1/g, "/").replace(/~0/g, "~"));
    requireThat(!claimed.some(previous => {
      const length = Math.min(parts.length, previous.length);
      return parts.slice(0, length).every((part, i) => part === previous[i]);
    }), "overlapping-normalization");
    let parent = result;
    for (const part of parts.slice(0, -1)) {
      requireThat(parent !== null && typeof parent === "object" && own(parent, part), "missing-normalization-pointer");
      parent = parent[part];
    }
    const key = parts.at(-1);
    requireThat(parent !== null && typeof parent === "object" && own(parent, key), "missing-normalization-pointer");
    requireThat(!Array.isArray(parent) || /^(0|[1-9][0-9]*)$/.test(key), "invalid-normalization-pointer");
    claimed.push(parts);
    return { parent, key, value: parent[key] };
  }
  for (const key of Object.keys(policy)) requireThat(Array.isArray(policy[key]), "invalid-normalization-policy");
  const pathLabels = new Map();
  const pathRoots = new Map();
  for (const rule of policy.paths ?? []) {
    requireThat(keysExactly(rule, ["pointer", "root", "label"]) && symbol(rule.label), "invalid-path-rule");
    const { root, label } = rule;
    requireThat(typeof root === "string" && root !== "/" && posix.isAbsolute(root) && posix.normalize(root) === root && !root.endsWith("/") && !root.includes("\0"), "invalid-owned-root");
    requireThat((!pathLabels.has(label) || pathLabels.get(label) === root) && (!pathRoots.has(root) || pathRoots.get(root) === label), "nonbijective-path-labels");
    pathLabels.set(label, root);
    pathRoots.set(root, label);
    const target = location(rule.pointer);
    requireThat(typeof target.value === "string" && posix.normalize(target.value) === target.value && !target.value.includes("\0") && (target.value === root || target.value.startsWith(`${root}/`)), "unowned-path");
    target.parent[target.key] = { $parity: "path", label, suffix: target.value.slice(root.length) };
  }
  // One global bijection across groups prevents two declarations from silently
  // assigning the same generated identity conflicting meanings.
  const identities = new Map();
  const labels = new Map();
  for (const rule of policy.identities ?? []) {
    requireThat(keysExactly(rule, ["pointers", "values"]) && Array.isArray(rule.pointers) && rule.pointers.length > 0 && Array.isArray(rule.values) && rule.values.length > 0, "invalid-identity-rule");
    const bindings = new Map();
    const localLabels = new Set();
    for (const binding of rule.values) {
      requireThat(keysExactly(binding, ["value", "label"]) && typeof binding.value === "string" && binding.value.length > 0 && symbol(binding.label), "invalid-identity-binding");
      requireThat(!bindings.has(binding.value) && !localLabels.has(binding.label), "nonbijective-identities");
      requireThat((!identities.has(binding.value) || identities.get(binding.value) === binding.label) && (!labels.has(binding.label) || labels.get(binding.label) === binding.value), "nonbijective-identities");
      bindings.set(binding.value, binding.label);
      localLabels.add(binding.label);
      identities.set(binding.value, binding.label);
      labels.set(binding.label, binding.value);
    }
    const observed = new Set();
    for (const pointer of rule.pointers) {
      const target = location(pointer);
      requireThat(bindings.has(target.value), "undeclared-identity");
      observed.add(target.value);
      target.parent[target.key] = { $parity: "identity", label: bindings.get(target.value) };
    }
    requireThat(observed.size === bindings.size, "unobserved-identity-binding");
  }
  for (const rule of policy.volatile ?? []) {
    requireThat(keysExactly(rule, ["pointer", "kind"]), "invalid-volatile-rule");
    const target = location(rule.pointer);
    const item = target.value;
    let valid = false;
    if (rule.kind === "timestamp" && typeof item === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(item)) {
      const time = Date.parse(item);
      const normalizedIso = item.length === 20 ? `${item.slice(0, -1)}.000Z` : item;
      valid = Number.isFinite(time) && new Date(time).toISOString() === normalizedIso;
    }
    if (rule.kind === "port") valid = Number.isInteger(item) && item > 0 && item <= 65535;
    if (rule.kind === "pid") valid = Number.isSafeInteger(item) && item > 0;
    if (rule.kind === "timing") valid = typeof item === "number" && Number.isFinite(item) && item >= 0;
    requireThat(valid, "invalid-volatile-value");
    target.parent[target.key] = { $parity: rule.kind };
  }
  return canonical(result);
}

function validateMatrix(matrix) {
  requireThat(Array.isArray(matrix) && matrix.length > 0, "invalid-matrix");
  const ids = new Set();
  for (const row of matrix) {
    requireThat(plain(row) && typeof row.id === "string" && row.id.length > 0 && !ids.has(row.id) && symbol(row.scenario) && EXPECTATIONS.has(row.expectation), "invalid-matrix-row");
    requireThat(Array.isArray(row.assertions) && row.assertions.length > 0 && row.assertions.every(symbol) && new Set(row.assertions).size === row.assertions.length, "invalid-matrix-assertions");
    if (row.expectation === "architecture-specific") requireThat(typeof row.architectureReason === "string" && row.architectureReason.trim().length > 0, "missing-architecture-reason");
    ids.add(row.id);
  }
}

/**
 * report = {backend:'sqlite'|'postgresql', scenario, rows:[
 *   {id, assertions:[ordered matrix assertion IDs], verdict:'passed', observation}
 * ], cleanup?:{verdict:'passed'}}. The scenario scopes the denominator, never
 * the submitted rows. Receipts are emitted only after each real assertion ran.
 * Cleanup is optional for a mid-worker scenario, required by its final envelope.
 */
export function assertCompleteReport(matrix, report) {
  validateMatrix(matrix);
  requireThat(keysExactly(report, ["backend", "scenario", "rows", "cleanup"], ["backend", "scenario", "rows"]) && ["sqlite", "postgresql"].includes(report.backend) && symbol(report.scenario) && Array.isArray(report.rows), "invalid-report");
  const required = matrix.filter(row => row.scenario === report.scenario);
  requireThat(required.length > 0 && report.rows.length === required.length, "incomplete-report");
  const byId = new Map(required.map(row => [row.id, row]));
  const seen = new Set();
  for (const row of report.rows) {
    requireThat(keysExactly(row, ["id", "assertions", "verdict", "observation"]) && byId.has(row.id) && !seen.has(row.id), "invalid-report-row");
    requireThat(row.verdict === "passed", "nonpassing-report-row");
    assertSemanticEqual(row.assertions, byId.get(row.id).assertions, "assertion-denominator");
    semanticDigest(row.observation);
    seen.add(row.id);
  }
  if (own(report, "cleanup")) requireThat(keysExactly(report.cleanup, ["verdict"]) && report.cleanup.verdict === "passed", "cleanup-failure");
}

/**
 * Architecture rows require independently authored explicit expected semantics
 * for BOTH backends: {expectations:{[rowId]:{sqlite,postgresql}}}. Unknown,
 * missing and shared-row expectation overrides all fail. No skip/xfail path.
 */
export function compareBackendReports(matrix, sqlite, postgresql, options = {}) {
  assertCompleteReport(matrix, sqlite);
  assertCompleteReport(matrix, postgresql);
  requireThat(sqlite.backend === "sqlite" && postgresql.backend === "postgresql" && sqlite.scenario === postgresql.scenario, "backend-report-mismatch");
  requireThat(keysExactly(options, ["expectations"], []), "invalid-comparison-options");
  const expectations = options.expectations ?? {};
  requireThat(plain(expectations), "invalid-architecture-expectations");
  const required = matrix.filter(row => row.scenario === sqlite.scenario);
  const architecture = required.filter(row => row.expectation === "architecture-specific");
  assertSemanticEqual(Object.keys(expectations).sort(), architecture.map(row => row.id).sort(), "architecture-denominator");
  const actualSqlite = new Map(sqlite.rows.map(row => [row.id, row]));
  const actualPostgresql = new Map(postgresql.rows.map(row => [row.id, row]));
  for (const row of required) {
    const left = actualSqlite.get(row.id).observation;
    const right = actualPostgresql.get(row.id).observation;
    if (row.expectation === "architecture-specific") {
      const expected = expectations[row.id];
      requireThat(keysExactly(expected, ["sqlite", "postgresql"]), "missing-backend-expectation");
      assertSemanticEqual(left, expected.sqlite, "sqlite-architecture-result");
      assertSemanticEqual(right, expected.postgresql, "postgresql-architecture-result");
    } else {
      assertSemanticEqual(left, right, "shared-backend-result");
    }
  }
}

function filesystemClass(path) {
  const scope = path.startsWith("projects/") ? "project" : path.startsWith("events/") ? "event" : "protected";
  if (path.endsWith("-wal")) return `${scope}-wal`;
  if (path.endsWith("-shm")) return `${scope}-shm`;
  if (path.endsWith("/db.sqlite") || path.endsWith(".db")) return `${scope}-database`;
  if (path.endsWith("/meta.json")) return "project-metadata";
  return path === "map.json" ? "project-map" : path === "config.json" ? "config" : `${scope}-files`;
}

/**
 * Pure comparison of worker-owned filesystem/native witnesses. The caller
 * supplies its authenticated numeric owner; this helper performs no IO.
 * Existing SHM may change bytes only at the same identity. Cold target options
 * restrict new coordination files only; every other witness stays exact.
 */
export function assertSnapshotUnchanged(actual, expected, id = "snapshot", options = {}) {
  requireThat(symbol(id), "invalid-assertion-id");
  // Compare independently hashed native content first. A bounded category makes
  // a failure reviewable without placing private paths or rows in the report.
  if (Object.hasOwn(actual, "nativeCounts") || Object.hasOwn(expected, "nativeCounts")) {
    assertSemanticEqual(actual.nativeCounts, expected.nativeCounts, `${id}:native-counts`);
  }
  if (actual.postgresql !== undefined || expected.postgresql !== undefined) {
    assertSemanticEqual(actual.postgresql, expected.postgresql, `${id}:postgresql-state`);
  }
  const owner = options.owner;
  requireThat(Number.isInteger(owner), `${id}:owner-required`);
  const isOwnedFile = entry => entry?.kind === "file" && entry.mode === 0o100600 && entry.uid === owner && entry.nlink === 1;
  const isOwnedDirectory = entry => entry?.kind === "directory" && entry.mode === 0o40700 && entry.uid === owner;
  const directoryFor = path => path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  function authenticateCoordination(path) {
    const suffix = path.endsWith("-wal") ? "-wal" : path.endsWith("-shm") ? "-shm" : null;
    requireThat(suffix !== null, `${id}:unexpected-file`);
    const base = path.slice(0, -suffix.length);
    const priorDatabase = expected.entries[base];
    const currentDatabase = actual.entries[base];
    requireThat(priorDatabase?.sqliteFile === true && isOwnedFile(priorDatabase) && isOwnedFile(currentDatabase), `${id}:coordination-base`);
    assertSemanticEqual(currentDatabase, priorDatabase, `${id}:coordination-database-unchanged`);
    const directory = directoryFor(base);
    requireThat(isOwnedDirectory(expected.entries[directory]) && isOwnedDirectory(actual.entries[directory]), `${id}:coordination-parent`);
    requireThat(isOwnedFile(actual.entries[path]) && actual.entries[path].dev === currentDatabase.dev, `${id}:coordination-file`);
    return suffix;
  }
  const added = Object.keys(actual.entries).filter(path => !Object.hasOwn(expected.entries, path));
  for (const path of added) {
    const suffix = authenticateCoordination(path);
    if (options.allowedNewCoordinationBases !== undefined) {
      requireThat(options.allowedNewCoordinationBases.includes(path.slice(0, -suffix.length)), `${id}:coordination-outside-cold-target`);
    }
    // A newly created read-only WAL has no committed frames. Do not allow a
    // write hidden in a new WAL before the later native semantic observation.
    if (suffix === "-wal") requireThat(actual.entries[path].bytes === 0, `${id}:new-wal-durable-content`);
  }
  const removed = Object.keys(expected.entries).find(path => !Object.hasOwn(actual.entries, path));
  requireThat(removed === undefined, `${id}:removed-${removed === undefined ? "none" : filesystemClass(removed)}`);
  for (const path of Object.keys(expected.entries)) {
    const prior = expected.entries[path];
    const current = actual.entries[path];
    if (prior.database !== undefined && current.database !== undefined) {
      assertSemanticEqual(current.database, prior.database, `${id}:sqlite-native-state`);
    }
    const category = filesystemClass(path);
    if (path.endsWith("-shm")) {
      authenticateCoordination(path);
      requireThat(isOwnedFile(prior), `${id}:prior-shm-file`);
      const { sha256: _priorHash, bytes: _priorBytes, ...priorIdentity } = prior;
      const { sha256: _currentHash, bytes: _currentBytes, ...currentIdentity } = current;
      assertSemanticEqual(currentIdentity, priorIdentity, `${id}:shm-identity`);
    } else if (prior.kind === "directory") {
      const allowedChildren = added.filter(entry => directoryFor(entry) === path).map(entry => entry.slice(path === "" ? 0 : path.length + 1));
      assertSemanticEqual(current, { ...prior, children: [...prior.children, ...allowedChildren].sort() }, `${id}:${category}`);
    } else assertSemanticEqual(current, prior, `${id}:${category}`);
  }
  return added;
}

/**
 * Logical no-effect contract for compaction previews and fault probes. This is
 * deliberately separate from diagnostic physical immutability. Only existing,
 * authenticated SQLite databases with complete native witnesses may change
 * physical bytes; their exact WAL/SHM leaves may undergo engine bookkeeping.
 * The returned relative paths are internal evidence, never public error text.
 */
export function assertLogicalSnapshotUnchanged(actual, expected, id = "snapshot", options = {}) {
  requireThat(symbol(id), "invalid-assertion-id");
  const owner = options.owner;
  requireThat(Number.isInteger(owner), `${id}:owner-required`);
  if (own(actual, "nativeCounts") || own(expected, "nativeCounts")) {
    assertSemanticEqual(actual.nativeCounts, expected.nativeCounts, `${id}:native-counts`);
  }
  if (actual.postgresql !== undefined || expected.postgresql !== undefined) {
    assertSemanticEqual(actual.postgresql, expected.postgresql, `${id}:postgresql-state`);
  }
  const isOwnedFile = entry => entry?.kind === "file" && entry.mode === 0o100600 && entry.uid === owner && entry.nlink === 1;
  const isOwnedDirectory = entry => entry?.kind === "directory" && entry.mode === 0o40700 && entry.uid === owner;
  const directoryFor = path => path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  const physicalIdentity = ({ sha256: _hash, bytes: _bytes, ...identity }) => identity;
  const bytesChanged = (current, prior) => current.sha256 !== prior.sha256 || current.bytes !== prior.bytes;
  const nativeEvidence = entry => plain(entry?.database) && typeof entry.database.schemaSha256 === "string"
    && plain(entry.database.tables) && Number.isInteger(entry.database.userVersion)
    && ["delete", "truncate", "persist", "memory", "wal", "off"].includes(entry.database.journalMode);
  const delta = { databaseBytesChanged: [], coordinationCreated: [], coordinationRemoved: [], coordinationUpdated: [] };
  const authenticated = new Set();
  function authenticateDatabase(base) {
    if (authenticated.has(base)) return;
    const prior = expected.entries[base];
    const current = actual.entries[base];
    requireThat(prior?.sqliteFile === true && current?.sqliteFile === true && isOwnedFile(prior) && isOwnedFile(current), `${id}:sqlite-base`);
    const directory = directoryFor(base);
    requireThat(isOwnedDirectory(expected.entries[directory]) && isOwnedDirectory(actual.entries[directory]), `${id}:sqlite-parent`);
    requireThat(nativeEvidence(prior) && nativeEvidence(current), `${id}:sqlite-native-evidence`);
    assertSemanticEqual(current.database, prior.database, `${id}:sqlite-native-state`);
    assertSemanticEqual(physicalIdentity(current), physicalIdentity(prior), `${id}:sqlite-identity`);
    if (bytesChanged(current, prior)) delta.databaseBytesChanged.push(base);
    authenticated.add(base);
  }
  function authenticateCoordination(path) {
    const suffix = path.endsWith("-wal") ? "-wal" : path.endsWith("-shm") ? "-shm" : null;
    requireThat(suffix !== null, `${id}:unexpected-file`);
    const base = path.slice(0, -suffix.length);
    authenticateDatabase(base);
    for (const snapshot of [expected, actual]) {
      if (!own(snapshot.entries, path)) continue;
      const entry = snapshot.entries[path];
      requireThat(isOwnedFile(entry) && entry.dev === snapshot.entries[base].dev, `${id}:coordination-file`);
    }
  }
  const added = Object.keys(actual.entries).filter(path => !own(expected.entries, path));
  const removed = Object.keys(expected.entries).filter(path => !own(actual.entries, path));
  for (const path of added) {
    authenticateCoordination(path);
    delta.coordinationCreated.push(path);
  }
  for (const path of removed) {
    authenticateCoordination(path);
    delta.coordinationRemoved.push(path);
  }
  for (const path of Object.keys(expected.entries)) {
    if (!own(actual.entries, path)) continue; // Authenticated exact removed sidecar above.
    const prior = expected.entries[path];
    const current = actual.entries[path];
    if (path.endsWith("-wal") || path.endsWith("-shm")) {
      authenticateCoordination(path);
      if (path.endsWith("-shm") && current.inode !== prior.inode) {
        // A logical read may close and recreate its own authenticated SHM
        // object. This is two endpoint-observed artifact deltas, not a claim
        // about which filesystem syscall performed the replacement.
        const { inode: _priorInode, ...priorIdentity } = physicalIdentity(prior);
        const { inode: _currentInode, ...currentIdentity } = physicalIdentity(current);
        assertSemanticEqual(currentIdentity, priorIdentity, `${id}:coordination-identity`);
        delta.coordinationRemoved.push(path);
        delta.coordinationCreated.push(path);
      } else {
        assertSemanticEqual(physicalIdentity(current), physicalIdentity(prior), `${id}:coordination-identity`);
        if (bytesChanged(current, prior)) delta.coordinationUpdated.push(path);
      }
    } else if (prior.sqliteFile === true || current.sqliteFile === true) {
      authenticateDatabase(path);
    } else if (prior.kind === "directory") {
      const leafFor = entry => entry.slice(path === "" ? 0 : path.length + 1);
      const removedChildren = new Set(removed.filter(entry => directoryFor(entry) === path).map(leafFor));
      const addedChildren = added.filter(entry => directoryFor(entry) === path).map(leafFor);
      const children = [...prior.children.filter(child => !removedChildren.has(child)), ...addedChildren].sort();
      assertSemanticEqual(current, { ...prior, children }, `${id}:${filesystemClass(path)}`);
    } else {
      assertSemanticEqual(current, prior, `${id}:${filesystemClass(path)}`);
    }
  }
  return Object.fromEntries(Object.entries(delta).map(([kind, paths]) => [kind, paths.sort()]));
}

/** Validate public diagnostics, including the deliberately exposed safe SQLSTATE. */
export function assertSanitizedDiagnostic(value, { canaries = [], expectedSqlState } = {}) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  requireThat(typeof text === "string" && Buffer.byteLength(text) <= MAX_BYTES, "diagnostic-bound");
  const prohibited = [
    ["url", /postgres(?:ql)?:\/\//iu], ["pem", /-----BEGIN/u],
    ["stack", /\bat (?:async )?\S+ \(/u], ["driver", /permission denied for/iu],
    ["query", /SELECT\s+.+FROM\s+/iu],
  ];
  for (const [kind, pattern] of prohibited) requireThat(!pattern.test(text), `diagnostic-${kind}`);
  requireThat(Array.isArray(canaries), "diagnostic-canary-contract");
  for (const canary of canaries) {
    requireThat(typeof canary === "string", "diagnostic-canary-contract");
    if (canary.length > 0) requireThat(!text.includes(canary), "diagnostic-private-canary");
  }
  const states = [];
  let nodes = 0;
  function inspect(item, depth = 0) {
    requireThat(++nodes <= 10000 && depth <= 32, "diagnostic-structure-bound");
    if (typeof item === "string") {
      // CLI JSON and MCP text envelopes can contain the structured diagnostic.
      if (/^\s*[\[{]/u.test(item)) {
        let parsed;
        let parsedSuccessfully = false;
        try { parsed = JSON.parse(item); parsedSuccessfully = true; } catch { /* Inspect malformed text below. */ }
        if (parsedSuccessfully) {
          inspect(parsed, depth + 1);
          return;
        }
      }
      // Only a validated structured field carries the documented safe code.
      // Raw diagnostic prose, including malformed JSON, has no such contract.
      requireThat(!/sqlstate/iu.test(item), "diagnostic-raw-sqlstate");
    } else if (item !== null && typeof item === "object") {
      for (const [key, child] of Object.entries(item)) {
        if (key.toLowerCase() === "sqlstate") {
          requireThat(child === null || (typeof child === "string" && /^[A-Z0-9]{5}$/u.test(child)), "diagnostic-sqlstate");
          states.push(child);
        }
        inspect(child, depth + 1);
      }
    }
  }
  inspect(value);
  if (expectedSqlState !== undefined) {
    requireThat(typeof expectedSqlState === "string" && /^[A-Z0-9]{5}$/u.test(expectedSqlState), "diagnostic-expected-sqlstate");
    requireThat(states.includes(expectedSqlState), "diagnostic-sqlstate-evidence");
  }
}
