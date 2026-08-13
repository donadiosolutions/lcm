import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createMigrationManifestHead,
  MigrationManifestStore,
  migrationManifestGenerationDirectory,
  migrationManifestHeadContent,
  migrationManifestHeadPath,
  migrationManifestLockPath,
  migrationManifestRevisionPath,
  parseMigrationManifestHeadContent,
} from "../../src/migration/manifest-store.js";
import {
  beginMigrationEffect,
  createMigrationManifest,
  migrationManifestCanonicalSha256,
  MigrationProtocolError,
  type MigrationManifest,
} from "../../src/migration/protocol.js";

const HASH = "a".repeat(64);
const UPDATED_AT = "2026-08-12T12:00:00.000Z";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeHome(mode = 0o700): string {
  const home = mkdtempSync(join("/tmp", "lcm-manifest-store-"));
  roots.push(home);
  chmodSync(home, mode);
  mkdirSync(join(home, ".lcm"), { mode: 0o700 });
  return home;
}

function manifest(generationId = "generation-1"): MigrationManifest {
  return createMigrationManifest({
    generationId,
    source: {
      version: 1,
      backend: "sqlite",
      identitySha256: "1".repeat(64),
      schemaSha256: "2".repeat(64),
      contentSha256: "3".repeat(64),
      capturedAt: UPDATED_AT,
    },
    destination: {
      version: 1,
      backend: "postgresql",
      identitySha256: "4".repeat(64),
      schemaSha256: "5".repeat(64),
      contentSha256: "6".repeat(64),
      capturedAt: UPDATED_AT,
    },
    parentGenerationId: null,
    preservedSourceGenerationId: generationId,
    createdAt: UPDATED_AT,
  });
}

function resealManifest(value: MigrationManifest, changes: Partial<MigrationManifest>): MigrationManifest {
  const { checksumSha256: _checksum, ...payload } = { ...value, ...changes };
  return {
    ...payload,
    checksumSha256: migrationManifestCanonicalSha256(payload),
  };
}

function canonicalFixture(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalFixture).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalFixture(record[key])}`).join(",")}}`;
}

function replaceWithRevision(
  home: string,
  initial: MigrationManifest,
  revision: number,
): MigrationManifest {
  const replacement = resealManifest(initial, {
    revision,
    previousManifestSha256: "b".repeat(64),
  });
  const initialPath = migrationManifestRevisionPath({
    generationId: initial.generationId,
    revision: 0,
    checksumSha256: initial.checksumSha256,
  }, home);
  const initialDirectory = resolve(initialPath, "..");
  const replacementDirectory = join(
    resolve(initialDirectory, ".."),
    revision.toString(10).padStart(16, "0"),
  );
  const replacementFile = join(initialDirectory, `${replacement.checksumSha256}.json`);
  const replacementContent = readFileSync(initialPath, "utf8")
    .replace(initial.checksumSha256, replacement.checksumSha256)
    .replace('"previousManifestSha256":null', `"previousManifestSha256":"${replacement.previousManifestSha256}"`)
    .replace('"revision":0', `"revision":${revision}`);
  renameSync(initialPath, replacementFile);
  writeFileSync(replacementFile, replacementContent, { mode: 0o600 });
  renameSync(initialDirectory, replacementDirectory);
  writeFileSync(
    migrationManifestHeadPath(initial.generationId, home),
    migrationManifestHeadContent(createMigrationManifestHead({
      generationId: replacement.generationId,
      revision: replacement.revision,
      manifestSha256: replacement.checksumSha256,
      updatedAt: replacement.updatedAt,
    })),
    { mode: 0o600 },
  );
  return replacement;
}

function replaceWithMaximumRevision(home: string, initial: MigrationManifest): MigrationManifest {
  return replaceWithRevision(home, initial, Number.MAX_SAFE_INTEGER);
}

function publishSuccessorOrphan(
  home: string,
  initial: MigrationManifest,
  candidate: MigrationManifest,
): string {
  const crashing = new MigrationManifestStore({
    homeDir: home,
    observer: (event) => {
      if (event === "after-revision-publication") throw new Error("crash:orphan-successor");
    },
  });
  expect(() => crashing.update(initial.generationId, initial.checksumSha256, () => candidate))
    .toThrow("crash:orphan-successor");
  return migrationManifestRevisionPath({
    generationId: candidate.generationId,
    revision: candidate.revision,
    checksumSha256: candidate.checksumSha256,
  }, home);
}

function rewriteManifestFixture(
  path: string,
  changes: Partial<MigrationManifest>,
): MigrationManifest {
  const record = JSON.parse(readFileSync(path, "utf8")) as MigrationManifest;
  const { checksumSha256: _checksum, ...payload } = { ...record, ...changes };
  const rewritten = {
    ...record,
    ...changes,
    checksumSha256: migrationManifestCanonicalSha256(payload),
  };
  writeFileSync(path, `${JSON.stringify(rewritten)}\n`, { mode: 0o600 });
  return rewritten;
}

function expectProtocolReason(callback: () => unknown, reason: MigrationProtocolError["reason"]): void {
  try {
    callback();
    throw new Error("expected MigrationProtocolError");
  } catch (error) {
    expect(error).toBeInstanceOf(MigrationProtocolError);
    expect((error as MigrationProtocolError).reason).toBe(reason);
  }
}

function withPatchedFs<T>(name: string, replacement: unknown, callback: () => T): T {
  const nodeFs = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;
  const original = nodeFs[name];
  nodeFs[name] = replacement;
  syncBuiltinESMExports();
  try {
    return callback();
  } finally {
    nodeFs[name] = original;
    syncBuiltinESMExports();
  }
}

function expectRecoveryFailure(
  callback: () => unknown,
  message: string,
  cause: unknown,
): MigrationProtocolError {
  let failure: unknown;
  try {
    callback();
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(MigrationProtocolError);
  expect((failure as MigrationProtocolError).reason).toBe("recovery-required");
  expect((failure as MigrationProtocolError).message).toBe(message);
  expect((failure as MigrationProtocolError).cause).toBe(cause);
  return failure as MigrationProtocolError;
}

type HeadPublicationArtifact = "tmp" | "capture" | "attempt";

function headPublicationArtifactPaths(home: string, generationId: string): Readonly<{
  generation: string;
  tmp: string;
  capture: string;
  attempt: string;
}> {
  const generation = migrationManifestGenerationDirectory(generationId, home);
  const entries = readdirSync(generation).filter((entry) => (
    /^\.head\.json\.[0-9a-f]{24}\.(?:tmp|capture|attempt)$/u.test(entry)
  ));
  const nonces = new Set(entries
    .map((entry) => /^\.head\.json\.([0-9a-f]{24})\./u.exec(entry)?.[1])
    .filter((nonce): nonce is string => nonce !== undefined));
  expect(nonces.size).toBeLessThanOrEqual(1);
  const nonce = [...nonces][0];
  if (nonce === undefined) throw new Error("head publication nonce is absent");
  const pathFor = (kind: HeadPublicationArtifact): string => join(
    generation,
    `.head.json.${nonce}.${kind}`,
  );
  return {
    generation,
    tmp: pathFor("tmp"),
    capture: pathFor("capture"),
    attempt: pathFor("attempt"),
  };
}

function syncGenerationDirectory(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function createRow1PublicationState(label: string): Readonly<{
  home: string;
  initial: MigrationManifest;
  candidate: MigrationManifest;
  generation: string;
  headPath: string;
  artifacts: ReturnType<typeof headPublicationArtifactPaths>;
}> {
  const home = makeHome();
  const initial = manifest(label);
  const store = new MigrationManifestStore({ homeDir: home });
  store.create(initial);
  const candidate = beginMigrationEffect(initial, {
    effectId: `${label}-candidate`,
    kind: "verify-dry-run",
    inputSha256: HASH,
    startedAt: "2026-08-12T12:00:01.000Z",
  });
  const crashing = new MigrationManifestStore({
    homeDir: home,
    observer: (event) => {
      if (event === "before-head-capture") throw new Error("crash:before-head-capture");
    },
  });
  expect(() => crashing.update(initial.generationId, initial.checksumSha256, () => candidate))
    .toThrow("crash:before-head-capture");
  const generation = migrationManifestGenerationDirectory(initial.generationId, home);
  return {
    home,
    initial,
    candidate,
    generation,
    headPath: migrationManifestHeadPath(initial.generationId, home),
    artifacts: headPublicationArtifactPaths(home, initial.generationId),
  };
}

function createCaptureCleanedPublicationState(label: string): Readonly<{
  home: string;
  initial: MigrationManifest;
  candidate: MigrationManifest;
  generation: string;
  headPath: string;
  artifacts: ReturnType<typeof headPublicationArtifactPaths>;
}> {
  const state = createRow1PublicationState(label);
  renameSync(state.headPath, state.artifacts.capture);
  syncGenerationDirectory(state.generation);
  linkSync(state.artifacts.tmp, state.headPath);
  syncGenerationDirectory(state.generation);
  unlinkSync(state.artifacts.tmp);
  syncGenerationDirectory(state.generation);
  unlinkSync(state.artifacts.capture);
  syncGenerationDirectory(state.generation);
  return state;
}

function capturePublicationEvidence(state: ReturnType<typeof createCaptureCleanedPublicationState>): Readonly<{
  head: string;
  attempt: string;
  generationEntries: string[];
  revisionEntries: string[];
  revisionContents: Readonly<Record<string, string>>;
  headNlink: number;
  attemptNlink: number;
}> {
  const revisions = join(state.generation, "revisions");
  const revisionContents: Record<string, string> = {};
  for (const revision of readdirSync(revisions).sort()) {
    const directory = join(revisions, revision);
    for (const entry of readdirSync(directory).sort()) {
      revisionContents[`${revision}/${entry}`] = readFileSync(join(directory, entry), "utf8");
    }
  }
  return {
    head: readFileSync(state.headPath, "utf8"),
    attempt: readFileSync(state.artifacts.attempt, "utf8"),
    generationEntries: readdirSync(state.generation).sort(),
    revisionEntries: readdirSync(revisions).sort(),
    revisionContents,
    headNlink: lstatSync(state.headPath).nlink,
    attemptNlink: lstatSync(state.artifacts.attempt).nlink,
  };
}

function expectPublicationEvidence(
  state: ReturnType<typeof createCaptureCleanedPublicationState>,
  evidence: Readonly<{
    head: string;
    attempt: string;
    generationEntries: string[];
    revisionEntries: string[];
    revisionContents: Readonly<Record<string, string>>;
    headNlink: number;
    attemptNlink: number;
  }>,
): void {
  expect(readFileSync(state.headPath, "utf8")).toBe(evidence.head);
  expect(readFileSync(state.artifacts.attempt, "utf8")).toBe(evidence.attempt);
  expect(readdirSync(state.generation).sort()).toEqual(evidence.generationEntries);
  expect(readdirSync(join(state.generation, "revisions")).sort()).toEqual(evidence.revisionEntries);
  const revisionContents: Record<string, string> = {};
  const revisions = join(state.generation, "revisions");
  for (const revision of readdirSync(revisions).sort()) {
    const directory = join(revisions, revision);
    for (const entry of readdirSync(directory).sort()) {
      revisionContents[`${revision}/${entry}`] = readFileSync(join(directory, entry), "utf8");
    }
  }
  expect(revisionContents).toEqual(evidence.revisionContents);
  expect(lstatSync(state.headPath).nlink).toBe(evidence.headNlink);
  expect(lstatSync(state.artifacts.attempt).nlink).toBe(evidence.attemptNlink);
}

function rewritePublicationAttempt(
  path: string,
  changes: Readonly<Record<string, unknown>>,
): void {
  const record = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const { checksumSha256: _checksum, ...payload } = { ...record, ...changes };
  const rewritten = {
    ...payload,
    checksumSha256: createHash("sha256").update(canonicalFixture(payload), "utf8").digest("hex"),
  };
  writeFileSync(path, `${canonicalFixture(rewritten)}\n`, { mode: 0o600 });
}

function publishImmutableRevision(home: string, manifestValue: MigrationManifest): void {
  const path = migrationManifestRevisionPath({
    generationId: manifestValue.generationId,
    revision: manifestValue.revision,
    checksumSha256: manifestValue.checksumSha256,
  }, home);
  mkdirSync(resolve(path, ".."), { mode: 0o700 });
  writeFileSync(path, `${canonicalFixture(manifestValue)}\n`, { mode: 0o600 });
}

function replaceImmutableRevisionFixture(
  home: string,
  value: MigrationManifest,
  changes: Partial<MigrationManifest>,
): MigrationManifest {
  const replacement = resealManifest(value, changes);
  const originalPath = migrationManifestRevisionPath({
    generationId: value.generationId,
    revision: value.revision,
    checksumSha256: value.checksumSha256,
  }, home);
  const replacementPath = migrationManifestRevisionPath({
    generationId: replacement.generationId,
    revision: replacement.revision,
    checksumSha256: replacement.checksumSha256,
  }, home);
  renameSync(originalPath, replacementPath);
  writeFileSync(replacementPath, `${canonicalFixture(replacement)}\n`, { mode: 0o600 });
  return replacement;
}

function expectCanonicalHeadPublicationAttempt(
  path: string,
  expected: Readonly<{
    generationId: string;
    expectedHeadRawSha256: string;
    candidateHeadRawSha256: string;
    candidateManifestSha256: string;
    candidateRevision: number;
  }>,
): void {
  const content = readFileSync(path, "utf8");
  const record = JSON.parse(content) as Record<string, unknown>;
  expect(Object.keys(record).sort()).toEqual([
    "candidateHeadRawSha256",
    "candidateManifestSha256",
    "candidateRevision",
    "checksumSha256",
    "expectedHeadRawSha256",
    "generationId",
    "nonce",
    "version",
  ]);
  expect(record).toMatchObject({
    version: 1,
    generationId: expected.generationId,
    expectedHeadRawSha256: expected.expectedHeadRawSha256,
    candidateHeadRawSha256: expected.candidateHeadRawSha256,
    candidateManifestSha256: expected.candidateManifestSha256,
    candidateRevision: expected.candidateRevision,
  });
  expect(record.nonce).toMatch(/^[0-9a-f]{24}$/u);
  const { checksumSha256, ...payload } = record;
  expect(checksumSha256).toBe(createHash("sha256").update(canonicalFixture(payload), "utf8").digest("hex"));
  expect(content).toBe(`${canonicalFixture(record)}\n`);
  expect(lstatSync(path).mode & 0o7777).toBe(0o600);
  expect(lstatSync(path).nlink).toBe(1);
}

describe("migration manifest head publication attempt codec", () => {
  function expectMalformedAttempt(
    label: string,
    rewrite: (path: string, canonicalContent: string) => string,
  ): void {
    const state = createRow1PublicationState(label);
    const canonicalContent = readFileSync(state.artifacts.attempt, "utf8");
    const rewritten = rewrite(state.artifacts.attempt, canonicalContent);
    const store = new MigrationManifestStore({ homeDir: state.home });

    expectProtocolReason(() => store.read(state.initial.generationId), "malformed-manifest");
    expect(readFileSync(state.artifacts.attempt, "utf8")).toBe(rewritten);
  }

  it("rejects invalid authenticated attempt bytes and preserves each artifact", () => {
    for (const [label, content] of [
      ["non-ascii", "é\n"],
      ["missing-newline", null],
    ] as const) {
      expectMalformedAttempt(`attempt-${label}`, (path, canonicalContent) => {
        const rewritten = content ?? canonicalContent.slice(0, -1);
        writeFileSync(path, rewritten, { mode: 0o600 });
        return rewritten;
      });
    }

    for (const [label, content] of [
      ["null", "null\n"],
      ["array", "[]\n"],
      ["string", '"attempt"\n'],
      ["invalid-json", "{\n"],
    ] as const) {
      expectMalformedAttempt(`attempt-${label}`, (path) => {
        writeFileSync(path, content, { mode: 0o600 });
        return content;
      });
    }

    expectMalformedAttempt("attempt-wrong-keys", (path, canonicalContent) => {
      const record = JSON.parse(canonicalContent) as Record<string, unknown>;
      const rewritten = `${canonicalFixture({ ...record, unexpected: true })}\n`;
      writeFileSync(path, rewritten, { mode: 0o600 });
      return rewritten;
    });

    expectMalformedAttempt("attempt-invalid-fields", (path, canonicalContent) => {
      const record = JSON.parse(canonicalContent) as Record<string, unknown>;
      const rewritten = `${canonicalFixture({ ...record, candidateRevision: -1 })}\n`;
      writeFileSync(path, rewritten, { mode: 0o600 });
      return rewritten;
    });

    expectMalformedAttempt("attempt-checksum-mismatch", (path, canonicalContent) => {
      const record = JSON.parse(canonicalContent) as Record<string, unknown>;
      const rewritten = `${canonicalFixture({ ...record, checksumSha256: "0".repeat(64) })}\n`;
      writeFileSync(path, rewritten, { mode: 0o600 });
      return rewritten;
    });

    expectMalformedAttempt("attempt-noncanonical", (path, canonicalContent) => {
      const record = JSON.parse(canonicalContent) as Record<string, unknown>;
      const { checksumSha256, ...payload } = record;
      const rewritten = `${JSON.stringify({ checksumSha256, ...payload })}\n`;
      writeFileSync(path, rewritten, { mode: 0o600 });
      return rewritten;
    });
  });

  it("rejects an attempt whose sealed nonce differs from its artifact group", () => {
    const state = createRow1PublicationState("attempt-group-nonce-mismatch");
    const record = JSON.parse(readFileSync(state.artifacts.attempt, "utf8")) as Record<string, unknown>;
    const nonce = record.nonce as string;
    rewritePublicationAttempt(state.artifacts.attempt, {
      nonce: nonce === "0".repeat(24) ? "1".repeat(24) : "0".repeat(24),
    });
    const evidence = capturePublicationEvidence(state);

    expectProtocolReason(
      () => new MigrationManifestStore({ homeDir: state.home }).read(state.initial.generationId),
      "malformed-manifest",
    );
    expectPublicationEvidence(state, evidence);
  });

  it("sanitizes a raw attempt read failure while preserving its cause and evidence", () => {
    const state = createRow1PublicationState("attempt-raw-read-failure");
    const evidence = capturePublicationEvidence(state);
    const failure = Object.assign(new Error("attempt read denied"), { code: "EIO" });
    const nodeFs = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;
    const originalOpen = nodeFs.openSync as typeof openSync;
    let observed: unknown;

    try {
      withPatchedFs("openSync", ((path: string, flags: string | number, mode?: number) => {
        if (path === state.artifacts.attempt) throw failure;
        return mode === undefined ? originalOpen(path, flags) : originalOpen(path, flags, mode);
      }) as never, () => new MigrationManifestStore({ homeDir: state.home }).read(
        state.initial.generationId,
      ));
    } catch (error) {
      observed = error;
    }

    expect(observed).toBeInstanceOf(MigrationProtocolError);
    expect((observed as MigrationProtocolError).reason).toBe("malformed-manifest");
    expect((observed as MigrationProtocolError).message)
      .toBe("migration manifest head publication attempt is invalid");
    expect((observed as MigrationProtocolError).cause).toBe(failure);
    expectPublicationEvidence(state, evidence);
  });
});

describe("migration manifest head publication group refusals", () => {
  it("rejects publication artifacts from multiple nonces", () => {
    const state = createRow1PublicationState("publication-multiple-nonces");
    const record = JSON.parse(readFileSync(state.artifacts.attempt, "utf8")) as Record<string, unknown>;
    const nonce = record.nonce as string;
    const otherNonce = nonce === "0".repeat(24) ? "1".repeat(24) : "0".repeat(24);
    const otherAttempt = join(state.generation, `.head.json.${otherNonce}.attempt`);
    renameSync(state.artifacts.attempt, otherAttempt);
    const head = readFileSync(state.headPath, "utf8");
    const candidate = readFileSync(state.artifacts.tmp, "utf8");
    const attempt = readFileSync(otherAttempt, "utf8");
    const entries = readdirSync(state.generation).sort();

    expectProtocolReason(
      () => new MigrationManifestStore({ homeDir: state.home }).read(state.initial.generationId),
      "malformed-manifest",
    );
    expect(readFileSync(state.headPath, "utf8")).toBe(head);
    expect(readFileSync(state.artifacts.tmp, "utf8")).toBe(candidate);
    expect(readFileSync(otherAttempt, "utf8")).toBe(attempt);
    expect(readdirSync(state.generation).sort()).toEqual(entries);
  });

  it("rejects a generation directory that exceeds the authenticated entry bound", () => {
    const home = makeHome();
    const initial = manifest("publication-directory-ambiguous");
    const store = new MigrationManifestStore({ homeDir: home });
    store.create(initial);
    const generation = migrationManifestGenerationDirectory(initial.generationId, home);
    const headPath = migrationManifestHeadPath(initial.generationId, home);
    const head = readFileSync(headPath, "utf8");
    for (const entry of ["extra-a", "extra-b", "extra-c", "extra-d"]) {
      writeFileSync(join(generation, entry), `${entry}\n`, { mode: 0o600 });
    }
    const entries = readdirSync(generation).sort();

    expectProtocolReason(() => store.read(initial.generationId), "malformed-manifest");
    expect(readFileSync(headPath, "utf8")).toBe(head);
    expect(readdirSync(generation).sort()).toEqual(entries);
  });

  it("falls back from a racy committed-pair classification without consuming evidence", () => {
    const state = createRow1PublicationState("publication-classification-race");
    renameSync(state.headPath, state.artifacts.capture);
    linkSync(state.artifacts.tmp, state.headPath);
    const candidateContent = readFileSync(state.artifacts.tmp, "utf8");
    const nodeFs = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;
    const originalLstat = nodeFs.lstatSync as typeof lstatSync;
    let raced = false;

    expectProtocolReason(() => withPatchedFs("lstatSync", ((path: string, options?: unknown) => {
      if (!raced && path === state.artifacts.tmp) {
        raced = true;
        throw Object.assign(new Error("classification race"), { code: "ENOENT" });
      }
      return originalLstat(path, options as never);
    }) as never, () => new MigrationManifestStore({ homeDir: state.home }).read(
      state.initial.generationId,
    )), "malformed-manifest");

    expect(raced).toBe(true);
    expect(readFileSync(state.headPath, "utf8")).toBe(candidateContent);
    expect(readFileSync(state.artifacts.tmp, "utf8")).toBe(candidateContent);
    expect(existsSync(state.artifacts.capture)).toBe(true);
    expect(existsSync(state.artifacts.attempt)).toBe(true);
  });

  it("rejects committed candidate topology that changes after classification", () => {
    const state = createRow1PublicationState("publication-committed-link-race");
    renameSync(state.headPath, state.artifacts.capture);
    linkSync(state.artifacts.tmp, state.headPath);
    const extra = join(state.home, "candidate-extra-link");
    const nodeFs = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;
    const originalLstat = nodeFs.lstatSync as typeof lstatSync;
    let raced = false;

    expectProtocolReason(() => withPatchedFs("lstatSync", ((path: string, options?: unknown) => {
      const result = originalLstat(path, options as never);
      if (!raced && path === state.artifacts.tmp) {
        raced = true;
        linkSync(state.artifacts.tmp, extra);
      }
      return result;
    }) as never, () => new MigrationManifestStore({ homeDir: state.home }).read(
      state.initial.generationId,
    )), "malformed-manifest");

    expect(raced).toBe(true);
    expect(lstatSync(state.headPath).nlink).toBe(3);
    expect(lstatSync(state.artifacts.tmp).nlink).toBe(3);
    expect(lstatSync(extra).nlink).toBe(3);
    expect(existsSync(state.artifacts.capture)).toBe(true);
    expect(existsSync(state.artifacts.attempt)).toBe(true);
  });

  it("rejects a committed writer pair whose inode identity changes after classification", () => {
    const state = createRow1PublicationState("publication-committed-identity-race");
    renameSync(state.headPath, state.artifacts.capture);
    linkSync(state.artifacts.tmp, state.headPath);
    const candidateContent = readFileSync(state.artifacts.tmp, "utf8");
    const retained = join(state.home, "retained-candidate-link");
    const nodeFs = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;
    const originalLstat = nodeFs.lstatSync as typeof lstatSync;
    let raced = false;

    expectProtocolReason(() => withPatchedFs("lstatSync", ((path: string, options?: unknown) => {
      const result = originalLstat(path, options as never);
      if (!raced && path === state.artifacts.tmp) {
        raced = true;
        linkSync(state.artifacts.tmp, retained);
        unlinkSync(state.headPath);
        writeFileSync(state.headPath, candidateContent, { mode: 0o600 });
      }
      return result;
    }) as never, () => new MigrationManifestStore({ homeDir: state.home }).read(
      state.initial.generationId,
    )), "malformed-manifest");

    expect(raced).toBe(true);
    expect(readFileSync(state.headPath, "utf8")).toBe(candidateContent);
    expect(lstatSync(state.headPath).ino).not.toBe(lstatSync(state.artifacts.tmp).ino);
    expect(lstatSync(state.artifacts.tmp).ino).toBe(lstatSync(retained).ino);
    expect(existsSync(state.artifacts.capture)).toBe(true);
    expect(existsSync(state.artifacts.attempt)).toBe(true);
  });

  it("rejects a candidate head that disagrees with its sealed attempt", () => {
    const state = createRow1PublicationState("publication-candidate-attempt-mismatch");
    rewritePublicationAttempt(state.artifacts.attempt, {
      candidateManifestSha256: "b".repeat(64),
    });
    const evidence = capturePublicationEvidence(state);

    expectProtocolReason(
      () => new MigrationManifestStore({ homeDir: state.home }).read(state.initial.generationId),
      "malformed-manifest",
    );
    expectPublicationEvidence(state, evidence);
  });

  it("rejects an attempt-bearing publication group with an invalid role set", () => {
    const state = createRow1PublicationState("publication-invalid-role-set");
    renameSync(state.headPath, state.artifacts.capture);
    unlinkSync(state.artifacts.tmp);
    const capture = readFileSync(state.artifacts.capture, "utf8");
    const attempt = readFileSync(state.artifacts.attempt, "utf8");
    const entries = readdirSync(state.generation).sort();

    expectProtocolReason(
      () => new MigrationManifestStore({ homeDir: state.home }).read(state.initial.generationId),
      "malformed-manifest",
    );
    expect(readFileSync(state.artifacts.capture, "utf8")).toBe(capture);
    expect(readFileSync(state.artifacts.attempt, "utf8")).toBe(attempt);
    expect(readdirSync(state.generation).sort()).toEqual(entries);
  });

  it("rejects a publication group that is not the immediate successor", () => {
    const state = createRow1PublicationState("publication-non-immediate-successor");
    const candidateHead = migrationManifestHeadContent(createMigrationManifestHead({
      generationId: state.candidate.generationId,
      revision: 2,
      manifestSha256: state.candidate.checksumSha256,
      updatedAt: state.candidate.updatedAt,
    }));
    writeFileSync(state.artifacts.tmp, candidateHead, { mode: 0o600 });
    rewritePublicationAttempt(state.artifacts.attempt, {
      candidateRevision: 2,
      candidateHeadRawSha256: createHash("sha256").update(candidateHead, "utf8").digest("hex"),
    });
    const evidence = capturePublicationEvidence(state);

    expectProtocolReason(
      () => new MigrationManifestStore({ homeDir: state.home }).read(state.initial.generationId),
      "malformed-manifest",
    );
    expectPublicationEvidence(state, evidence);
  });

  it("rejects a publication group whose immutable successor is absent", () => {
    const state = createRow1PublicationState("publication-missing-successor");
    rmSync(resolve(migrationManifestRevisionPath({
      generationId: state.candidate.generationId,
      revision: state.candidate.revision,
      checksumSha256: state.candidate.checksumSha256,
    }, state.home), ".."), { recursive: true });
    const head = readFileSync(state.headPath, "utf8");
    const candidate = readFileSync(state.artifacts.tmp, "utf8");
    const attempt = readFileSync(state.artifacts.attempt, "utf8");

    expectProtocolReason(
      () => new MigrationManifestStore({ homeDir: state.home }).read(state.initial.generationId),
      "malformed-manifest",
    );
    expect(readFileSync(state.headPath, "utf8")).toBe(head);
    expect(readFileSync(state.artifacts.tmp, "utf8")).toBe(candidate);
    expect(readFileSync(state.artifacts.attempt, "utf8")).toBe(attempt);
  });

  it("rejects a publication group whose attempt names another immutable successor", () => {
    const state = createRow1PublicationState("publication-successor-attempt-mismatch");
    const forgedChecksum = "b".repeat(64);
    const candidateHead = migrationManifestHeadContent(createMigrationManifestHead({
      generationId: state.candidate.generationId,
      revision: state.candidate.revision,
      manifestSha256: forgedChecksum,
      updatedAt: state.candidate.updatedAt,
    }));
    writeFileSync(state.artifacts.tmp, candidateHead, { mode: 0o600 });
    rewritePublicationAttempt(state.artifacts.attempt, {
      candidateHeadRawSha256: createHash("sha256").update(candidateHead, "utf8").digest("hex"),
      candidateManifestSha256: forgedChecksum,
    });
    const head = readFileSync(state.headPath, "utf8");
    const candidate = readFileSync(state.artifacts.tmp, "utf8");
    const attempt = readFileSync(state.artifacts.attempt, "utf8");

    expectProtocolReason(
      () => new MigrationManifestStore({ homeDir: state.home }).read(state.initial.generationId),
      "malformed-manifest",
    );
    expect(readFileSync(state.headPath, "utf8")).toBe(head);
    expect(readFileSync(state.artifacts.tmp, "utf8")).toBe(candidate);
    expect(readFileSync(state.artifacts.attempt, "utf8")).toBe(attempt);
  });

  it("rejects capture-cleaned evidence without a predecessor revision", () => {
    const state = createCaptureCleanedPublicationState("publication-capture-cleaned-genesis");
    const genesisHead = migrationManifestHeadContent(createMigrationManifestHead({
      generationId: state.initial.generationId,
      revision: state.initial.revision,
      manifestSha256: state.initial.checksumSha256,
      updatedAt: state.initial.updatedAt,
    }));
    writeFileSync(state.headPath, genesisHead, { mode: 0o600 });
    rewritePublicationAttempt(state.artifacts.attempt, {
      candidateRevision: state.initial.revision,
      candidateManifestSha256: state.initial.checksumSha256,
      candidateHeadRawSha256: createHash("sha256").update(genesisHead, "utf8").digest("hex"),
    });
    const evidence = capturePublicationEvidence(state);

    expectProtocolReason(
      () => new MigrationManifestStore({ homeDir: state.home }).read(state.initial.generationId),
      "malformed-manifest",
    );
    expectPublicationEvidence(state, evidence);
  });

  it("rejects capture-cleaned evidence whose prior-head digest is not sealed", () => {
    const state = createCaptureCleanedPublicationState("publication-capture-cleaned-prior-hash");
    rewritePublicationAttempt(state.artifacts.attempt, {
      expectedHeadRawSha256: "b".repeat(64),
    });
    const evidence = capturePublicationEvidence(state);

    expectProtocolReason(
      () => new MigrationManifestStore({ homeDir: state.home }).read(state.initial.generationId),
      "malformed-manifest",
    );
    expectPublicationEvidence(state, evidence);
  });
});

describe("migration manifest store layout", () => {
  it("derives the home lock, generation, head, and immutable revision paths", () => {
    const home = "/tmp/lcm-migration-home";
    const generation = join(home, ".lcm", "migrations", "generation-1");

    expect(migrationManifestLockPath(home)).toBe(join(home, ".lcm.migration-manifest.lock"));
    expect(migrationManifestGenerationDirectory("generation-1", home)).toBe(generation);
    expect(migrationManifestHeadPath("generation-1", home)).toBe(join(generation, "head.json"));
    expect(migrationManifestRevisionPath({
      generationId: "generation-1",
      revision: 42,
      checksumSha256: HASH,
    }, home)).toBe(join(generation, "revisions", "0000000000000042", `${HASH}.json`));
    expect(migrationManifestLockPath()).toBe(join(resolve(homedir()), ".lcm.migration-manifest.lock"));
    expect(migrationManifestGenerationDirectory("generation-1"))
      .toBe(join(resolve(homedir()), ".lcm", "migrations", "generation-1"));
  });

  it("rejects unsafe path identities before deriving storage paths", () => {
    for (const generationId of ["", "../escape", "x".repeat(129), 1 as never]) {
      expect(() => migrationManifestGenerationDirectory(generationId, "/tmp/home"))
        .toThrow("generation");
    }
    for (const revision of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => migrationManifestRevisionPath({
        generationId: "generation-1",
        revision,
        checksumSha256: HASH,
      }, "/tmp/home")).toThrow("revision");
    }
    expect(() => migrationManifestRevisionPath({
      generationId: "generation-1",
      revision: 0,
      checksumSha256: "A".repeat(64),
    }, "/tmp/home")).toThrow("checksum");
  });
});

describe("migration manifest head codec", () => {
  it("seals and parses an exact canonical ASCII head", () => {
    const payload = `{"generationId":"generation-1","manifestSha256":"${HASH}","revision":42,"revisionFilename":"${HASH}.json","updatedAt":"${UPDATED_AT}","version":1}`;
    const checksumSha256 = createHash("sha256").update(payload, "utf8").digest("hex");
    const expectedContent = `{"checksumSha256":"${checksumSha256}","generationId":"generation-1","manifestSha256":"${HASH}","revision":42,"revisionFilename":"${HASH}.json","updatedAt":"${UPDATED_AT}","version":1}\n`;

    const head = createMigrationManifestHead({
      generationId: "generation-1",
      revision: 42,
      manifestSha256: HASH,
      updatedAt: UPDATED_AT,
    });
    expect(head).toEqual({
      version: 1,
      generationId: "generation-1",
      revision: 42,
      revisionFilename: `${HASH}.json`,
      manifestSha256: HASH,
      updatedAt: UPDATED_AT,
      checksumSha256,
    });
    expect(Object.isFrozen(head)).toBe(true);
    expect(migrationManifestHeadContent(head)).toBe(expectedContent);
    expect(parseMigrationManifestHeadContent(expectedContent)).toEqual(head);
    expect(Object.isFrozen(parseMigrationManifestHeadContent(expectedContent))).toBe(true);
  });

  it("rejects non-ASCII, noncanonical, malformed, and checksum-drifted heads", () => {
    const head = createMigrationManifestHead({
      generationId: "generation-1",
      revision: 0,
      manifestSha256: HASH,
      updatedAt: UPDATED_AT,
    });
    const content = migrationManifestHeadContent(head);
    expectProtocolReason(() => parseMigrationManifestHeadContent(`é${content}`), "malformed-manifest");
    expectProtocolReason(() => parseMigrationManifestHeadContent(content.slice(0, -1)), "malformed-manifest");
    expectProtocolReason(() => parseMigrationManifestHeadContent(`${content}\n`), "malformed-manifest");
    expectProtocolReason(() => parseMigrationManifestHeadContent("not-json\n"), "malformed-manifest");
    expectProtocolReason(() => parseMigrationManifestHeadContent(content.replace('"version":1', '"extra":true,"version":1')), "malformed-manifest");
    expectProtocolReason(() => parseMigrationManifestHeadContent(content.replace(head.checksumSha256, "0".repeat(64))), "checksum-mismatch");
    expectProtocolReason(() => parseMigrationManifestHeadContent(content.replace(`${HASH}.json`, `${"b".repeat(64)}.json`)), "malformed-manifest");
    expectProtocolReason(() => parseMigrationManifestHeadContent("null\n"), "malformed-manifest");
    expectProtocolReason(() => parseMigrationManifestHeadContent("[]\n"), "malformed-manifest");

    const parsed = JSON.parse(content) as Record<string, unknown>;
    for (const [field, value] of [
      ["version", 2],
      ["generationId", 1],
      ["revision", -1],
      ["manifestSha256", "A".repeat(64)],
      ["revisionFilename", 1],
      ["updatedAt", "yesterday"],
      ["checksumSha256", "A".repeat(64)],
    ] as const) {
      expectProtocolReason(
        () => parseMigrationManifestHeadContent(`${JSON.stringify({ ...parsed, [field]: value })}\n`),
        "malformed-manifest",
      );
    }
    expectProtocolReason(
      () => parseMigrationManifestHeadContent(`${JSON.stringify({ ...parsed, generationId: "../escape" })}\n`),
      "malformed-manifest",
    );
    expectProtocolReason(
      () => parseMigrationManifestHeadContent(` ${content}`),
      "malformed-manifest",
    );

    for (const input of [
      null,
      { generationId: "generation-1", revision: -1, manifestSha256: HASH, updatedAt: UPDATED_AT },
      { generationId: "generation-1", revision: 0, manifestSha256: "A".repeat(64), updatedAt: UPDATED_AT },
      { generationId: "generation-1", revision: 0, manifestSha256: HASH, updatedAt: "yesterday" },
    ]) {
      expectProtocolReason(() => createMigrationManifestHead(input as never), "invalid-input");
    }
    expectProtocolReason(
      () => migrationManifestHeadContent({ ...head, version: 2 as never }),
      "malformed-manifest",
    );
    for (const candidate of [
      { ...head, revisionFilename: `${"b".repeat(64)}.json` },
      { ...head, checksumSha256: "0".repeat(64) },
      { ...head, updatedAt: "yesterday" },
      { ...head, manifestSha256: "A".repeat(64) },
    ]) {
      expectProtocolReason(
        () => migrationManifestHeadContent(candidate as never),
        "malformed-manifest",
      );
    }
    expectProtocolReason(
      () => parseMigrationManifestHeadContent(1 as never),
      "malformed-manifest",
    );
    expectProtocolReason(
      () => parseMigrationManifestHeadContent(content.replace('"revision":0', '"revision":0e0')),
      "malformed-manifest",
    );
  });
});

describe("migration manifest durable create and read", () => {
  it("publishes revision zero before the head and reads authenticated canonical state", () => {
    const home = makeHome();
    const store = new MigrationManifestStore({ homeDir: home });
    const initial = manifest();

    expect(store.create(initial)).toEqual(initial);
    expect(store.read(initial.generationId)).toEqual(initial);

    const generation = migrationManifestGenerationDirectory(initial.generationId, home);
    const revision = migrationManifestRevisionPath({
      generationId: initial.generationId,
      revision: initial.revision,
      checksumSha256: initial.checksumSha256,
    }, home);
    const head = migrationManifestHeadPath(initial.generationId, home);
    for (const directory of [
      join(home, ".lcm", "migrations"),
      generation,
      join(generation, "revisions"),
      join(generation, "revisions", "0000000000000000"),
    ]) {
      expect(statSync(directory).mode & 0o7777).toBe(0o700);
    }
    for (const file of [revision, head]) {
      const metadata = lstatSync(file);
      expect(metadata.isFile()).toBe(true);
      expect(metadata.mode & 0o7777).toBe(0o600);
      expect(metadata.nlink).toBe(1);
      expect(readFileSync(file, "utf8").endsWith("\n")).toBe(true);
    }

    const maxRevisionPath = migrationManifestRevisionPath({
      generationId: "a.b:c-d",
      revision: Number.MAX_SAFE_INTEGER,
      checksumSha256: HASH,
    }, home);
    expect(maxRevisionPath).toContain("/9007199254740991/");
  });

  it("refuses invalid genesis, duplicate generations, owner mismatches, and unsafe roots", () => {
    const home = makeHome();
    const initial = manifest();
    const store = new MigrationManifestStore({ homeDir: home });
    const advanced = beginMigrationEffect(initial, {
      effectId: "effect-1",
      kind: "verify-dry-run",
      inputSha256: HASH,
      startedAt: "2026-08-12T12:00:01.000Z",
    });
    expectProtocolReason(() => store.create(advanced), "unexpected-state");
    expect(store.create(initial)).toEqual(initial);
    const duplicateEvents: string[] = [];
    expectProtocolReason(() => new MigrationManifestStore({
      homeDir: home,
      observer: (event) => duplicateEvents.push(event),
    }).create(initial), "unexpected-state");
    expect(duplicateEvents).toEqual([]);

    const expectedUid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (expectedUid === undefined) throw new Error("manifest owner-policy tests require process.getuid");
    const ownerHome = makeHome();
    expect(() => new MigrationManifestStore({
      homeDir: ownerHome,
      expectedUid: expectedUid + 1,
    }).create(manifest("owner-generation"))).toThrow("trusted");
    expect(existsSync(migrationManifestLockPath(ownerHome))).toBe(false);

    const unsafeHome = makeHome();
    chmodSync(join(unsafeHome, ".lcm"), 0o755);
    expect(() => new MigrationManifestStore({ homeDir: unsafeHome }).create(manifest("unsafe-generation")))
      .toThrow("mode");
    expect(existsSync(join(unsafeHome, ".lcm", "migrations"))).toBe(false);
    expect(() => new MigrationManifestStore()).not.toThrow();

    const getuid = Object.getOwnPropertyDescriptor(process, "getuid");
    try {
      Object.defineProperty(process, "getuid", { value: undefined, configurable: true });
      expect(() => new MigrationManifestStore({ homeDir: makeHome() })).not.toThrow();
    } finally {
      if (getuid === undefined) delete (process as { getuid?: unknown }).getuid;
      else Object.defineProperty(process, "getuid", getuid);
    }

    const failureHome = makeHome();
    const mkdir = createRequire(import.meta.url)("node:fs").mkdirSync as typeof mkdirSync;
    expect(() => withPatchedFs("mkdirSync", ((path: string, options: unknown) => {
      if (path.endsWith("/migrations")) {
        const error = new Error("mkdir denied") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      }
      return mkdir(path, options as never);
    }) as never, () => new MigrationManifestStore({ homeDir: failureHome })
      .create(manifest("mkdir-failure")))).toThrow("mkdir denied");
  });

  it("rejects oversized canonical genesis content before creating durable paths", () => {
    const home = makeHome();
    const initial = manifest("oversized-genesis");
    const reports = Array.from({ length: 6_500 }, (_, index) => ({
      kind: "dry-run" as const,
      reportId: `report-${index.toString(10).padStart(8, "0")}`,
      reportSha256: HASH,
      createdAt: UPDATED_AT,
    }));
    const oversized = resealManifest(initial, { reports });
    expect(Buffer.byteLength(`${canonicalFixture(oversized)}\n`, "utf8")).toBeGreaterThan(1 * 1024 * 1024);

    expectProtocolReason(
      () => new MigrationManifestStore({ homeDir: home }).create(oversized),
      "unexpected-state",
    );
    expect(existsSync(join(home, ".lcm", "migrations"))).toBe(false);
  });

  it("rejects oversized legal successors before staging a revision", () => {
    const home = makeHome();
    const initial = resealManifest(manifest("oversized-update"), {
      revision: 1,
      previousManifestSha256: HASH,
      reports: Array.from({ length: 6_197 }, (_, index) => ({
        kind: "dry-run" as const,
        reportId: `report-${index.toString(10).padStart(8, "0")}`,
        reportSha256: HASH,
        createdAt: UPDATED_AT,
      })),
    });
    const oversized = beginMigrationEffect(initial, {
      effectId: "oversized-next",
      kind: "verify-dry-run",
      inputSha256: HASH,
      startedAt: "2026-08-12T12:00:01.000Z",
    });
    const store = new MigrationManifestStore({ homeDir: home });
    const revisionPath = migrationManifestRevisionPath({
      generationId: initial.generationId,
      revision: initial.revision,
      checksumSha256: initial.checksumSha256,
    }, home);
    mkdirSync(resolve(revisionPath, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(revisionPath, `${canonicalFixture(initial)}\n`, { mode: 0o600 });
    writeFileSync(
      migrationManifestHeadPath(initial.generationId, home),
      migrationManifestHeadContent(createMigrationManifestHead({
        generationId: initial.generationId,
        revision: initial.revision,
        manifestSha256: initial.checksumSha256,
        updatedAt: initial.updatedAt,
      })),
      { mode: 0o600 },
    );
    expect(Buffer.byteLength(`${canonicalFixture(initial)}\n`, "utf8")).toBeLessThanOrEqual(1 * 1024 * 1024);
    expect(Buffer.byteLength(`${canonicalFixture(oversized)}\n`, "utf8")).toBeGreaterThan(1 * 1024 * 1024);
    expectProtocolReason(
      () => store.update(initial.generationId, initial.checksumSha256, () => oversized),
      "invalid-input",
    );
    expect(store.read(initial.generationId)).toEqual(initial);
  });

  it("publishes revision before head at exact observer crash boundaries", () => {
    const events = [
      "before-revision-publication",
      "before-revision-content-publication",
      "after-revision-publication",
      "before-head-publication",
      "after-head-publication",
    ] as const;
    for (const crashEvent of events) {
      const home = makeHome(0o755);
      const initial = manifest(`generation-${events.indexOf(crashEvent)}`);
      const observed: string[] = [];
      const store = new MigrationManifestStore({
        homeDir: home,
        observer: (event, path) => {
          observed.push(`${event}:${path}`);
          if (event === crashEvent) throw new Error(`crash:${event}`);
        },
      });
      expect(() => store.create(initial)).toThrow(`crash:${crashEvent}`);
      expect(statSync(home).mode & 0o7777).toBe(0o755);

      const revision = migrationManifestRevisionPath({
        generationId: initial.generationId,
        revision: 0,
        checksumSha256: initial.checksumSha256,
      }, home);
      const head = migrationManifestHeadPath(initial.generationId, home);
      const crashIndex = events.indexOf(crashEvent);
      expect(existsSync(revision)).toBe(crashIndex >= 2);
      expect(existsSync(head)).toBe(crashIndex >= 4);
      expect(observed.map((entry) => entry.slice(0, entry.indexOf(":"))))
        .toEqual(events.slice(0, crashIndex + 1));
      if (crashEvent === "after-head-publication") {
        expect(store.read(initial.generationId)).toEqual(initial);
      }
      if (crashEvent === "before-revision-publication" || crashEvent === "before-revision-content-publication") {
        expect(existsSync(resolve(revision, ".."))).toBe(
          crashEvent === "before-revision-content-publication",
        );
        expect(new MigrationManifestStore({ homeDir: home }).create(initial)).toEqual(initial);
      }
    }
  });

  it("refuses an unexpected entry in a resumable headless generation", () => {
    const home = makeHome();
    const initial = manifest("unexpected-headless-entry");
    const store = new MigrationManifestStore({
      homeDir: home,
      observer: (event, path) => {
        if (event !== "before-revision-publication") return;
        const generation = resolve(path, "../../..");
        mkdirSync(generation, { mode: 0o700 });
        writeFileSync(join(generation, "unexpected"), "evidence", { mode: 0o600 });
      },
    });

    expectProtocolReason(() => store.create(initial), "unexpected-state");
    expect(readFileSync(join(
      migrationManifestGenerationDirectory(initial.generationId, home),
      "unexpected",
    ), "utf8")).toBe("evidence");
  });

  it("refuses authenticated head, revision-directory, and revision-content disagreement", () => {
    const makeStored = (generationId: string) => {
      const home = makeHome();
      const store = new MigrationManifestStore({ homeDir: home });
      const initial = manifest(generationId);
      store.create(initial);
      const revision = migrationManifestRevisionPath({
        generationId,
        revision: 0,
        checksumSha256: initial.checksumSha256,
      }, home);
      return { home, store, initial, revision };
    };

    const wrongHead = makeStored("head-generation");
    const replacementHead = createMigrationManifestHead({
      generationId: "other-generation",
      revision: 0,
      manifestSha256: wrongHead.initial.checksumSha256,
      updatedAt: wrongHead.initial.updatedAt,
    });
    writeFileSync(
      migrationManifestHeadPath(wrongHead.initial.generationId, wrongHead.home),
      migrationManifestHeadContent(replacementHead),
      { mode: 0o600 },
    );
    expectProtocolReason(() => wrongHead.store.read(wrongHead.initial.generationId), "malformed-manifest");

    const ambiguous = makeStored("ambiguous-generation");
    writeFileSync(join(resolve(ambiguous.revision, ".."), "extra"), "evidence", { mode: 0o600 });
    expectProtocolReason(() => ambiguous.store.read(ambiguous.initial.generationId), "malformed-manifest");

    const crowded = makeStored("crowded-generation");
    for (const suffix of ["d", "e"]) {
      writeFileSync(
        join(
          resolve(crowded.revision, ".."),
          `.${crowded.initial.checksumSha256}.json.${suffix.repeat(24)}.tmp`,
        ),
        "scratch",
        { mode: 0o600 },
      );
    }
    expectProtocolReason(() => crowded.store.read(crowded.initial.generationId), "malformed-manifest");

    const scratchOnly = makeStored("scratch-only-generation");
    renameSync(
      scratchOnly.revision,
      join(
        resolve(scratchOnly.revision, ".."),
        `.${scratchOnly.initial.checksumSha256}.json.${"f".repeat(24)}.tmp`,
      ),
    );
    expectProtocolReason(
      () => scratchOnly.store.read(scratchOnly.initial.generationId),
      "malformed-manifest",
    );

    const other = makeStored("other-content-generation");
    writeFileSync(ambiguous.revision, readFileSync(other.revision), { mode: 0o600 });
    rmSync(join(resolve(ambiguous.revision, ".."), "extra"));
    expectProtocolReason(() => ambiguous.store.read(ambiguous.initial.generationId), "malformed-manifest");
  });

  it("rejects malformed and noncanonical immutable revision bytes", () => {
    for (const replacement of [
      "é\n",
      "not-json\n",
      undefined,
    ]) {
      const home = makeHome();
      const store = new MigrationManifestStore({ homeDir: home });
      const initial = manifest(`bytes-${replacement === undefined ? "canonical" : replacement.length}`);
      store.create(initial);
      const revision = migrationManifestRevisionPath({
        generationId: initial.generationId,
        revision: 0,
        checksumSha256: initial.checksumSha256,
      }, home);
      const current = readFileSync(revision, "utf8");
      const bytes = replacement ?? current.replace('"revision":0', '"revision":0e0');
      writeFileSync(revision, bytes, { mode: 0o600 });
      expectProtocolReason(() => store.read(initial.generationId), "malformed-manifest");
      expect(readFileSync(revision, "utf8")).toBe(bytes);
    }

    const negativeZeroHead = manifest("negative-zero");
    expectProtocolReason(
      () => createMigrationManifestHead({
        generationId: negativeZeroHead.generationId,
        revision: -0,
        manifestSha256: negativeZeroHead.checksumSha256,
        updatedAt: negativeZeroHead.updatedAt,
      }),
      "invalid-input",
    );
    expectProtocolReason(
      () => migrationManifestRevisionPath({
        generationId: negativeZeroHead.generationId,
        revision: -0,
        checksumSha256: negativeZeroHead.checksumSha256,
      }),
      "invalid-input",
    );
    const canonicalHead = migrationManifestHeadContent(createMigrationManifestHead({
      generationId: negativeZeroHead.generationId,
      revision: 0,
      manifestSha256: negativeZeroHead.checksumSha256,
      updatedAt: negativeZeroHead.updatedAt,
    }));
    expectProtocolReason(
      () => parseMigrationManifestHeadContent(canonicalHead.replace('"revision":0', '"revision":-0')),
      "malformed-manifest",
    );
  });

  it("preserves a concurrently created revision and aggregates descriptor cleanup failures", () => {
    const collisionHome = makeHome();
    const collision = manifest("revision-collision");
    const collisionPath = migrationManifestRevisionPath({
      generationId: collision.generationId,
      revision: 0,
      checksumSha256: collision.checksumSha256,
    }, collisionHome);
    const realLink = createRequire(import.meta.url)("node:fs").linkSync as typeof linkSync;
    expect(() => withPatchedFs("linkSync", ((source: string, destination: string) => {
      if (destination.endsWith(`/${collision.checksumSha256}.json`)) {
        writeFileSync(destination, "attacker", { mode: 0o600 });
      }
      return realLink(source, destination);
    }) as never, () => new MigrationManifestStore({ homeDir: collisionHome }).create(collision)))
      .toThrow("created concurrently");
    expect(readFileSync(collisionPath, "utf8")).toBe("attacker");

    const absenceHome = makeHome();
    const absenceGeneration = manifest("absence-probe");
    const realLstat = createRequire(import.meta.url)("node:fs").lstatSync as typeof lstatSync;
    expect(() => withPatchedFs("lstatSync", ((path: string, options?: unknown) => {
      if (path.endsWith("/absence-probe")) {
        const error = new Error("probe denied") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      }
      return realLstat(path, options as never);
    }) as never, () => new MigrationManifestStore({ homeDir: absenceHome }).create(absenceGeneration)))
      .toThrow("probe denied");

    const generationRaceHome = makeHome();
    const generationRace = manifest("generation-race");
    const realMkdir = createRequire(import.meta.url)("node:fs").mkdirSync as typeof mkdirSync;
    expect(() => withPatchedFs("mkdirSync", ((path: string, options?: unknown) => {
      if (path.endsWith("/generation-race")) {
        const error = new Error("generation appeared") as NodeJS.ErrnoException;
        error.code = "EEXIST";
        throw error;
      }
      return realMkdir(path, options as never);
    }) as never, () => new MigrationManifestStore({ homeDir: generationRaceHome }).create(generationRace)))
      .toThrow();

    const cleanupHome = makeHome();
    const cleanupStore = new MigrationManifestStore({ homeDir: cleanupHome });
    const cleanup = manifest("cleanup-generation");
    cleanupStore.create(cleanup);
    const realClose = createRequire(import.meta.url)("node:fs").closeSync as (fd: number) => void;
    let closeCalls = 0;
    let failure: unknown;
    try {
      withPatchedFs("closeSync", ((fd: number) => {
        closeCalls += 1;
        realClose(fd);
        if (closeCalls >= 3) throw new Error(`close-${closeCalls}`);
      }) as never, () => cleanupStore.read(cleanup.generationId));
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AggregateError);
    expect(closeCalls).toBeGreaterThanOrEqual(7);

    let baselineCloseCalls = 0;
    withPatchedFs("closeSync", ((fd: number) => {
      baselineCloseCalls += 1;
      realClose(fd);
    }) as never, () => cleanupStore.read(cleanup.generationId));
    closeCalls = 0;
    failure = undefined;
    try {
      withPatchedFs("closeSync", ((fd: number) => {
        closeCalls += 1;
        realClose(fd);
        if (closeCalls >= baselineCloseCalls - 1) throw new Error(`final-close-${closeCalls}`);
      }) as never, () => cleanupStore.read(cleanup.generationId));
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toHaveLength(2);
    expect(closeCalls).toBe(baselineCloseCalls);
  });
});

describe("migration manifest compare-and-swap update", () => {
  it("publishes one linked successor and rejects a stale expected checksum before reducer effects", () => {
    const home = makeHome();
    const events: string[] = [];
    const store = new MigrationManifestStore({
      homeDir: home,
      observer: (event) => events.push(event),
    });
    const initial = manifest("update-generation");
    store.create(initial);
    events.length = 0;
    let reducerCalls = 0;

    const updated = store.update(initial.generationId, initial.checksumSha256, (current) => {
      reducerCalls += 1;
      return beginMigrationEffect(current, {
        effectId: "effect-1",
        kind: "verify-dry-run",
        inputSha256: HASH,
        startedAt: "2026-08-12T12:00:01.000Z",
      });
    });

    expect(reducerCalls).toBe(1);
    expect(updated).toMatchObject({
      generationId: initial.generationId,
      revision: 1,
      previousManifestSha256: initial.checksumSha256,
    });
    expect(store.read(initial.generationId)).toEqual(updated);
    expect(events).toEqual([
      "before-revision-publication",
      "before-revision-content-publication",
      "after-revision-publication",
      "before-head-capture",
      "after-head-capture",
      "before-head-link",
      "after-head-link",
      "after-head-publication",
    ]);
    expect(existsSync(migrationManifestRevisionPath({
      generationId: updated.generationId,
      revision: updated.revision,
      checksumSha256: updated.checksumSha256,
    }, home))).toBe(true);

    events.length = 0;
    expectProtocolReason(() => store.update(
      initial.generationId,
      initial.checksumSha256,
      () => {
        reducerCalls += 1;
        return updated;
      },
    ), "unexpected-state");
    expect(reducerCalls).toBe(1);
    expect(events).toEqual([]);
  });

  it("publishes an exact non-genesis successor without generation-root publication artifacts", () => {
    const home = makeHome();
    const initial = manifest("publication-success");
    const events: string[] = [];
    const store = new MigrationManifestStore({
      homeDir: home,
      observer: (event) => events.push(event),
    });
    store.create(initial);
    events.length = 0;
    const candidate = beginMigrationEffect(initial, {
      effectId: "effect-publication-success",
      kind: "verify-dry-run",
      inputSha256: HASH,
      startedAt: "2026-08-12T12:00:01.000Z",
    });

    expect(store.update(initial.generationId, initial.checksumSha256, () => candidate))
      .toEqual(candidate);

    const generation = migrationManifestGenerationDirectory(initial.generationId, home);
    const headPath = migrationManifestHeadPath(initial.generationId, home);
    const expectedHead = createMigrationManifestHead({
      generationId: candidate.generationId,
      revision: candidate.revision,
      manifestSha256: candidate.checksumSha256,
      updatedAt: candidate.updatedAt,
    });
    expect(readFileSync(headPath, "utf8")).toBe(migrationManifestHeadContent(expectedHead));
    expect(store.read(initial.generationId)).toEqual(candidate);
    expect(readdirSync(generation).filter((entry) => (
      /^\.head\.json\.[0-9a-f]{24}\.(?:tmp|capture|attempt)$/u.test(entry)
    ))).toEqual([]);
    expect(events).toEqual([
      "before-revision-publication",
      "before-revision-content-publication",
      "after-revision-publication",
      "before-head-capture",
      "after-head-capture",
      "before-head-link",
      "after-head-link",
      "after-head-publication",
    ]);
  });

  it("preserves a final-link owner replacement and the exact nonce-matched publication group", () => {
    const home = makeHome();
    const initial = manifest("publication-final-link-conflict");
    const store = new MigrationManifestStore({ homeDir: home });
    store.create(initial);
    const headPath = migrationManifestHeadPath(initial.generationId, home);
    const headBefore = readFileSync(headPath, "utf8");
    const candidate = beginMigrationEffect(initial, {
      effectId: "effect-publication-final-link-conflict",
      kind: "verify-dry-run",
      inputSha256: HASH,
      startedAt: "2026-08-12T12:00:01.000Z",
    });
    const replacementHead = migrationManifestHeadContent(createMigrationManifestHead({
      generationId: initial.generationId,
      revision: initial.revision,
      manifestSha256: "b".repeat(64),
      updatedAt: initial.updatedAt,
    }));
    const racing = new MigrationManifestStore({
      homeDir: home,
      observer: (event) => {
        if (event === "before-head-link") writeFileSync(headPath, replacementHead, { mode: 0o600 });
      },
    });

    expectProtocolReason(
      () => racing.update(initial.generationId, initial.checksumSha256, () => candidate),
      "recovery-required",
    );
    expect(readFileSync(headPath, "utf8")).toBe(replacementHead);
    expect(lstatSync(headPath).mode & 0o7777).toBe(0o600);

    const artifacts = headPublicationArtifactPaths(home, initial.generationId);
    expect(readdirSync(artifacts.generation).filter((entry) => (
      /^\.head\.json\.[0-9a-f]{24}\.(?:tmp|capture|attempt)$/u.test(entry)
    ))).toHaveLength(3);
    expect(readFileSync(artifacts.tmp, "utf8")).toBe(migrationManifestHeadContent(createMigrationManifestHead({
      generationId: candidate.generationId,
      revision: candidate.revision,
      manifestSha256: candidate.checksumSha256,
      updatedAt: candidate.updatedAt,
    })));
    expect(readFileSync(artifacts.capture, "utf8")).toBe(headBefore);
    expectCanonicalHeadPublicationAttempt(artifacts.attempt, {
      generationId: candidate.generationId,
      expectedHeadRawSha256: createHash("sha256").update(headBefore, "utf8").digest("hex"),
      candidateHeadRawSha256: createHash("sha256")
        .update(readFileSync(artifacts.tmp, "utf8"), "utf8")
        .digest("hex"),
      candidateManifestSha256: candidate.checksumSha256,
      candidateRevision: candidate.revision,
    });
    expect(existsSync(migrationManifestRevisionPath({
      generationId: candidate.generationId,
      revision: candidate.revision,
      checksumSha256: candidate.checksumSha256,
    }, home))).toBe(true);
  });

  it("restores a pre-capture replacement from capture and preserves unpublished candidate evidence", () => {
    const home = makeHome();
    const initial = manifest("publication-capture-conflict");
    const store = new MigrationManifestStore({ homeDir: home });
    store.create(initial);
    const headPath = migrationManifestHeadPath(initial.generationId, home);
    const headBefore = readFileSync(headPath, "utf8");
    const candidate = beginMigrationEffect(initial, {
      effectId: "effect-publication-capture-conflict",
      kind: "verify-dry-run",
      inputSha256: HASH,
      startedAt: "2026-08-12T12:00:01.000Z",
    });
    const replacementHead = "same-uid replacement before capture\n";
    const events: string[] = [];
    const racing = new MigrationManifestStore({
      homeDir: home,
      observer: (event) => {
        events.push(event);
        if (event === "before-head-capture") writeFileSync(headPath, replacementHead, { mode: 0o600 });
      },
    });

    let failure: unknown;
    try {
      racing.update(initial.generationId, initial.checksumSha256, () => candidate);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(MigrationProtocolError);
    expect((failure as MigrationProtocolError).reason).toBe("recovery-required");
    expect((failure as MigrationProtocolError).message)
      .toBe("migration manifest head capture does not match the expected prior head");
    expect((failure as MigrationProtocolError).cause).toBeUndefined();
    expect(events).toEqual([
      "before-revision-publication",
      "before-revision-content-publication",
      "after-revision-publication",
      "before-head-capture",
      "after-head-capture",
      "before-head-restore",
    ]);

    const artifacts = headPublicationArtifactPaths(home, initial.generationId);
    expect(readFileSync(headPath, "utf8")).toBe(replacementHead);
    expect(readFileSync(artifacts.capture, "utf8")).toBe(replacementHead);
    expect(lstatSync(headPath).nlink).toBe(2);
    expect(lstatSync(artifacts.capture).nlink).toBe(2);
    expect(lstatSync(headPath).ino).toBe(lstatSync(artifacts.capture).ino);
    expect(readFileSync(artifacts.tmp, "utf8")).toBe(migrationManifestHeadContent(createMigrationManifestHead({
      generationId: candidate.generationId,
      revision: candidate.revision,
      manifestSha256: candidate.checksumSha256,
      updatedAt: candidate.updatedAt,
    })));
    expect(lstatSync(artifacts.tmp).nlink).toBe(1);
    expectCanonicalHeadPublicationAttempt(artifacts.attempt, {
      generationId: candidate.generationId,
      expectedHeadRawSha256: createHash("sha256").update(headBefore, "utf8").digest("hex"),
      candidateHeadRawSha256: createHash("sha256")
        .update(readFileSync(artifacts.tmp, "utf8"), "utf8")
        .digest("hex"),
      candidateManifestSha256: candidate.checksumSha256,
      candidateRevision: candidate.revision,
    });
    expect(lstatSync(artifacts.tmp).ino).not.toBe(lstatSync(headPath).ino);
    expect(existsSync(migrationManifestRevisionPath({
      generationId: candidate.generationId,
      revision: candidate.revision,
      checksumSha256: candidate.checksumSha256,
    }, home))).toBe(true);
  });

  it("preserves a restore-race competitor and the exact EEXIST cause without a head stat follow-up", () => {
    const home = makeHome();
    const initial = manifest("publication-restore-eexist");
    new MigrationManifestStore({ homeDir: home }).create(initial);
    const headPath = migrationManifestHeadPath(initial.generationId, home);
    const candidate = beginMigrationEffect(initial, {
      effectId: "effect-publication-restore-eexist",
      kind: "verify-dry-run",
      inputSha256: HASH,
      startedAt: "2026-08-12T12:00:01.000Z",
    });
    const capturedReplacement = "capture mismatch before restore race\n";
    const competitor = "restore-race competitor\n";
    let competitorWritten = false;
    const racing = new MigrationManifestStore({
      homeDir: home,
      observer: (event) => {
        if (event === "before-head-capture") {
          writeFileSync(headPath, capturedReplacement, { mode: 0o600 });
        }
        if (event === "before-head-restore") {
          writeFileSync(headPath, competitor, { mode: 0o600 });
          competitorWritten = true;
        }
      },
    });
    const nodeFs = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;
    const originalLstat = nodeFs.lstatSync as typeof lstatSync;
    const unexpectedStat = new Error("unexpected post-restore head lstat");

    let failure: unknown;
    try {
      withPatchedFs("lstatSync", ((path: string, options?: unknown) => {
        if (competitorWritten && path === headPath) throw unexpectedStat;
        return originalLstat(path, options as never);
      }) as never, () => racing.update(
        initial.generationId,
        initial.checksumSha256,
        () => candidate,
      ));
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(MigrationProtocolError);
    expect((failure as MigrationProtocolError).reason).toBe("recovery-required");
    expect((failure as MigrationProtocolError).message)
      .toBe("migration manifest head was replaced before capture restoration");
    expect((failure as MigrationProtocolError).cause).toMatchObject({ code: "EEXIST" });
    expect(failure).not.toBe(unexpectedStat);
    expect(readFileSync(headPath, "utf8")).toBe(competitor);

    const artifacts = headPublicationArtifactPaths(home, initial.generationId);
    expect(readFileSync(artifacts.capture, "utf8")).toBe(capturedReplacement);
    expect(lstatSync(headPath).ino).not.toBe(lstatSync(artifacts.capture).ino);
    expect(existsSync(artifacts.tmp)).toBe(true);
    expect(existsSync(artifacts.attempt)).toBe(true);
  });

  it("types a non-EEXIST capture restore failure and preserves its exact cause", () => {
    const home = makeHome();
    const initial = manifest("publication-restore-error");
    new MigrationManifestStore({ homeDir: home }).create(initial);
    const headPath = migrationManifestHeadPath(initial.generationId, home);
    const candidate = beginMigrationEffect(initial, {
      effectId: "effect-publication-restore-error",
      kind: "verify-dry-run",
      inputSha256: HASH,
      startedAt: "2026-08-12T12:00:01.000Z",
    });
    const capturedReplacement = "capture mismatch before restore error\n";
    const racing = new MigrationManifestStore({
      homeDir: home,
      observer: (event) => {
        if (event === "before-head-capture") {
          writeFileSync(headPath, capturedReplacement, { mode: 0o600 });
        }
      },
    });
    const nodeFs = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;
    const originalLink = nodeFs.linkSync as typeof linkSync;
    const restoreError = Object.assign(new Error("capture restore denied"), { code: "EACCES" });

    let failure: unknown;
    try {
      withPatchedFs("linkSync", ((source: string, destination: string) => {
        if (source.endsWith(".capture") && destination === headPath) throw restoreError;
        originalLink(source, destination);
      }) as never, () => racing.update(
        initial.generationId,
        initial.checksumSha256,
        () => candidate,
      ));
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(MigrationProtocolError);
    expect((failure as MigrationProtocolError).reason).toBe("recovery-required");
    expect((failure as MigrationProtocolError).message)
      .toBe("migration manifest head capture restoration failed");
    expect((failure as MigrationProtocolError).cause).toBe(restoreError);
    expect(existsSync(headPath)).toBe(false);
    const artifacts = headPublicationArtifactPaths(home, initial.generationId);
    expect(readFileSync(artifacts.capture, "utf8")).toBe(capturedReplacement);
    expect(existsSync(artifacts.tmp)).toBe(true);
    expect(existsSync(artifacts.attempt)).toBe(true);
  });

  it("types a restored capture durability failure and preserves its exact cause", () => {
    const home = makeHome();
    const initial = manifest("publication-restore-sync-error");
    new MigrationManifestStore({ homeDir: home }).create(initial);
    const generation = migrationManifestGenerationDirectory(initial.generationId, home);
    const headPath = migrationManifestHeadPath(initial.generationId, home);
    const candidate = beginMigrationEffect(initial, {
      effectId: "effect-publication-restore-sync-error",
      kind: "verify-dry-run",
      inputSha256: HASH,
      startedAt: "2026-08-12T12:00:01.000Z",
    });
    const capturedReplacement = "capture mismatch before restore sync error\n";
    let restoreStarted = false;
    const racing = new MigrationManifestStore({
      homeDir: home,
      observer: (event) => {
        if (event === "before-head-capture") {
          writeFileSync(headPath, capturedReplacement, { mode: 0o600 });
        }
        if (event === "before-head-restore") restoreStarted = true;
      },
    });
    const nodeFs = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;
    const originalOpen = nodeFs.openSync as typeof import("node:fs").openSync;
    const originalFsync = nodeFs.fsyncSync as (fd: number) => void;
    const generationDescriptors = new Set<number>();
    const syncFailure = Object.assign(new Error("capture restore sync denied"), { code: "EIO" });

    let failure: unknown;
    try {
      withPatchedFs("openSync", ((path: string, flags: string | number, mode?: number) => {
        const fd = mode === undefined
          ? originalOpen(path, flags)
          : originalOpen(path, flags, mode);
        if (path === generation) generationDescriptors.add(fd);
        return fd;
      }) as never, () => withPatchedFs("fsyncSync", ((fd: number) => {
        if (restoreStarted && generationDescriptors.has(fd)) throw syncFailure;
        originalFsync(fd);
      }) as never, () => racing.update(
        initial.generationId,
        initial.checksumSha256,
        () => candidate,
      )));
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(MigrationProtocolError);
    expect((failure as MigrationProtocolError).reason).toBe("recovery-required");
    expect((failure as MigrationProtocolError).message)
      .toBe("migration manifest head capture restoration durability sync failed");
    expect((failure as MigrationProtocolError).cause).toBe(syncFailure);
    const artifacts = headPublicationArtifactPaths(home, initial.generationId);
    expect(readFileSync(headPath, "utf8")).toBe(capturedReplacement);
    expect(readFileSync(artifacts.capture, "utf8")).toBe(capturedReplacement);
    expect(lstatSync(headPath).nlink).toBe(2);
    expect(lstatSync(artifacts.capture).nlink).toBe(2);
    expect(lstatSync(headPath).ino).toBe(lstatSync(artifacts.capture).ino);
    expect(existsSync(artifacts.tmp)).toBe(true);
    expect(existsSync(artifacts.attempt)).toBe(true);
  });

  it("types a non-EEXIST final candidate link failure and preserves its exact cause", () => {
    const home = makeHome();
    const initial = manifest("publication-candidate-link-error");
    new MigrationManifestStore({ homeDir: home }).create(initial);
    const headPath = migrationManifestHeadPath(initial.generationId, home);
    const headBefore = readFileSync(headPath, "utf8");
    const candidate = beginMigrationEffect(initial, {
      effectId: "effect-publication-candidate-link-error",
      kind: "verify-dry-run",
      inputSha256: HASH,
      startedAt: "2026-08-12T12:00:01.000Z",
    });
    let finalLinkStarted = false;
    const racing = new MigrationManifestStore({
      homeDir: home,
      observer: (event) => {
        if (event === "before-head-link") finalLinkStarted = true;
      },
    });
    const nodeFs = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;
    const originalLink = nodeFs.linkSync as typeof linkSync;
    const linkFailure = Object.assign(new Error("candidate link denied"), { code: "EACCES" });

    let failure: unknown;
    try {
      withPatchedFs("linkSync", ((source: string, destination: string) => {
        if (finalLinkStarted && destination === headPath) throw linkFailure;
        originalLink(source, destination);
      }) as never, () => racing.update(
        initial.generationId,
        initial.checksumSha256,
        () => candidate,
      ));
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(MigrationProtocolError);
    expect((failure as MigrationProtocolError).reason).toBe("recovery-required");
    expect((failure as MigrationProtocolError).message)
      .toBe("migration manifest head candidate publication failed");
    expect((failure as MigrationProtocolError).cause).toBe(linkFailure);
    expect(existsSync(headPath)).toBe(false);
    const artifacts = headPublicationArtifactPaths(home, initial.generationId);
    expect(readFileSync(artifacts.capture, "utf8")).toBe(headBefore);
    expect(existsSync(artifacts.tmp)).toBe(true);
    expect(existsSync(artifacts.attempt)).toBe(true);
  });

  it("retains the committed head-candidate inode pair when after-head-link crashes", () => {
    const home = makeHome();
    const initial = manifest("publication-after-head-link-crash");
    new MigrationManifestStore({ homeDir: home }).create(initial);
    const headPath = migrationManifestHeadPath(initial.generationId, home);
    const headBefore = readFileSync(headPath, "utf8");
    const candidate = beginMigrationEffect(initial, {
      effectId: "effect-publication-after-head-link-crash",
      kind: "verify-dry-run",
      inputSha256: HASH,
      startedAt: "2026-08-12T12:00:01.000Z",
    });
    const crashing = new MigrationManifestStore({
      homeDir: home,
      observer: (event) => {
        if (event === "after-head-link") throw new Error("crash:after-head-link");
      },
    });

    expect(() => crashing.update(initial.generationId, initial.checksumSha256, () => candidate))
      .toThrow("crash:after-head-link");

    const artifacts = headPublicationArtifactPaths(home, initial.generationId);
    const headStat = lstatSync(headPath);
    const candidateStat = lstatSync(artifacts.tmp);
    expect(readFileSync(headPath, "utf8")).toBe(readFileSync(artifacts.tmp, "utf8"));
    expect(headStat.nlink).toBe(2);
    expect(candidateStat.nlink).toBe(2);
    expect(headStat.dev).toBe(candidateStat.dev);
    expect(headStat.ino).toBe(candidateStat.ino);
    expect(readFileSync(artifacts.capture, "utf8")).toBe(headBefore);
    expect(lstatSync(artifacts.capture).nlink).toBe(1);
    expect(lstatSync(artifacts.attempt).nlink).toBe(1);
    expect(existsSync(migrationManifestRevisionPath({
      generationId: candidate.generationId,
      revision: candidate.revision,
      checksumSha256: candidate.checksumSha256,
    }, home))).toBe(true);
  });

  it("types a capture rename failure before namespace mutation and retains all publication evidence", () => {
    const home = makeHome();
    const initial = manifest("publication-capture-rename-error");
    new MigrationManifestStore({ homeDir: home }).create(initial);
    const generation = migrationManifestGenerationDirectory(initial.generationId, home);
    const headPath = migrationManifestHeadPath(initial.generationId, home);
    const headBefore = readFileSync(headPath, "utf8");
    const candidate = beginMigrationEffect(initial, {
      effectId: "effect-publication-capture-rename-error",
      kind: "verify-dry-run",
      inputSha256: HASH,
      startedAt: "2026-08-12T12:00:01.000Z",
    });
    const renameFailure = Object.assign(new Error("capture rename denied"), { code: "EACCES" });
    const nodeFs = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;
    const originalRename = nodeFs.renameSync as typeof renameSync;

    let failure: unknown;
    try {
      withPatchedFs("renameSync", ((source: string, destination: string) => {
        if (source === headPath && destination.startsWith(`${generation}/.head.json.`)) {
          throw renameFailure;
        }
        return originalRename(source, destination);
      }) as never, () => new MigrationManifestStore({ homeDir: home }).update(
        initial.generationId,
        initial.checksumSha256,
        () => candidate,
      ));
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(MigrationProtocolError);
    expect((failure as MigrationProtocolError).reason).toBe("recovery-required");
    expect((failure as MigrationProtocolError).message)
      .toBe("migration manifest head capture rename failed");
    expect((failure as MigrationProtocolError).cause).toBe(renameFailure);
    expect(readFileSync(headPath, "utf8")).toBe(headBefore);
    const artifacts = headPublicationArtifactPaths(home, initial.generationId);
    expect(existsSync(artifacts.capture)).toBe(false);
    expect(existsSync(artifacts.tmp)).toBe(true);
    expect(existsSync(artifacts.attempt)).toBe(true);
  });

  it("types a generation sync failure after capture rename and retains the headless publication evidence", () => {
    const home = makeHome();
    const initial = manifest("publication-capture-sync-error");
    new MigrationManifestStore({ homeDir: home }).create(initial);
    const generation = migrationManifestGenerationDirectory(initial.generationId, home);
    const headPath = migrationManifestHeadPath(initial.generationId, home);
    const headBefore = readFileSync(headPath, "utf8");
    const candidate = beginMigrationEffect(initial, {
      effectId: "effect-publication-capture-sync-error",
      kind: "verify-dry-run",
      inputSha256: HASH,
      startedAt: "2026-08-12T12:00:01.000Z",
    });
    const syncFailure = Object.assign(new Error("capture sync denied"), { code: "EIO" });
    const nodeFs = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;
    const originalRename = nodeFs.renameSync as typeof renameSync;
    const originalOpen = nodeFs.openSync as typeof import("node:fs").openSync;
    const originalFsync = nodeFs.fsyncSync as (fd: number) => void;
    const generationDescriptors = new Set<number>();
    let captureRenamed = false;

    let failure: unknown;
    try {
      withPatchedFs("renameSync", ((source: string, destination: string) => {
        const result = originalRename(source, destination);
        if (source === headPath && destination.endsWith(".capture")) captureRenamed = true;
        return result;
      }) as never, () => withPatchedFs("openSync", ((path: string, flags: string | number, mode?: number) => {
        const fd = mode === undefined
          ? originalOpen(path, flags)
          : originalOpen(path, flags, mode);
        if (path === generation) generationDescriptors.add(fd);
        return fd;
      }) as never, () => withPatchedFs("fsyncSync", ((fd: number) => {
        if (captureRenamed && generationDescriptors.has(fd)) throw syncFailure;
        originalFsync(fd);
      }) as never, () => new MigrationManifestStore({ homeDir: home }).update(
        initial.generationId,
        initial.checksumSha256,
        () => candidate,
      ))));
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(MigrationProtocolError);
    expect((failure as MigrationProtocolError).reason).toBe("recovery-required");
    expect((failure as MigrationProtocolError).message)
      .toBe("migration manifest head capture durability sync failed");
    expect((failure as MigrationProtocolError).cause).toBe(syncFailure);
    expect(existsSync(headPath)).toBe(false);
    const artifacts = headPublicationArtifactPaths(home, initial.generationId);
    expect(readFileSync(artifacts.capture, "utf8")).toBe(headBefore);
    expect(existsSync(artifacts.tmp)).toBe(true);
    expect(existsSync(artifacts.attempt)).toBe(true);
  });

  it("types a generation sync failure after final head link and retains the committed head pair", () => {
    const home = makeHome();
    const initial = manifest("publication-final-sync-error");
    new MigrationManifestStore({ homeDir: home }).create(initial);
    const generation = migrationManifestGenerationDirectory(initial.generationId, home);
    const headPath = migrationManifestHeadPath(initial.generationId, home);
    const candidate = beginMigrationEffect(initial, {
      effectId: "effect-publication-final-sync-error",
      kind: "verify-dry-run",
      inputSha256: HASH,
      startedAt: "2026-08-12T12:00:01.000Z",
    });
    const syncFailure = Object.assign(new Error("final head sync denied"), { code: "EIO" });
    const nodeFs = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;
    const originalOpen = nodeFs.openSync as typeof import("node:fs").openSync;
    const originalFsync = nodeFs.fsyncSync as (fd: number) => void;
    const generationDescriptors = new Set<number>();
    let finalLinkObserved = false;

    let failure: unknown;
    try {
      withPatchedFs("openSync", ((path: string, flags: string | number, mode?: number) => {
        const fd = mode === undefined
          ? originalOpen(path, flags)
          : originalOpen(path, flags, mode);
        if (path === generation) generationDescriptors.add(fd);
        return fd;
      }) as never, () => withPatchedFs("fsyncSync", ((fd: number) => {
        if (finalLinkObserved && generationDescriptors.has(fd)) throw syncFailure;
        originalFsync(fd);
      }) as never, () => new MigrationManifestStore({
        homeDir: home,
        observer: (event) => {
          if (event === "after-head-link") finalLinkObserved = true;
        },
      }).update(
        initial.generationId,
        initial.checksumSha256,
        () => candidate,
      )));
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(MigrationProtocolError);
    expect((failure as MigrationProtocolError).reason).toBe("recovery-required");
    expect((failure as MigrationProtocolError).message)
      .toBe("migration manifest head publication durability sync failed");
    expect((failure as MigrationProtocolError).cause).toBe(syncFailure);
    const artifacts = headPublicationArtifactPaths(home, initial.generationId);
    const headStat = lstatSync(headPath);
    const candidateStat = lstatSync(artifacts.tmp);
    expect(headStat.ino).toBe(candidateStat.ino);
    expect(headStat.nlink).toBe(2);
    expect(candidateStat.nlink).toBe(2);
    expect(existsSync(artifacts.capture)).toBe(true);
    expect(existsSync(artifacts.attempt)).toBe(true);
  });

  it("types candidate cleanup failure after final link and retains the committed head pair", () => {
    const home = makeHome();
    const initial = manifest("publication-candidate-cleanup-error");
    new MigrationManifestStore({ homeDir: home }).create(initial);
    const headPath = migrationManifestHeadPath(initial.generationId, home);
    const candidate = beginMigrationEffect(initial, {
      effectId: "effect-publication-candidate-cleanup-error",
      kind: "verify-dry-run",
      inputSha256: HASH,
      startedAt: "2026-08-12T12:00:01.000Z",
    });
    const cleanupFailure = Object.assign(new Error("candidate cleanup denied"), { code: "EACCES" });
    const nodeFs = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;
    const originalUnlink = nodeFs.unlinkSync as (path: string) => void;
    let finalLinkObserved = false;

    let failure: unknown;
    try {
      withPatchedFs("unlinkSync", ((path: string) => {
        if (finalLinkObserved && path.endsWith(".tmp")) throw cleanupFailure;
        originalUnlink(path);
      }) as never, () => new MigrationManifestStore({
        homeDir: home,
        observer: (event) => {
          if (event === "after-head-link") finalLinkObserved = true;
        },
      }).update(
        initial.generationId,
        initial.checksumSha256,
        () => candidate,
      ));
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(MigrationProtocolError);
    expect((failure as MigrationProtocolError).reason).toBe("recovery-required");
    expect((failure as MigrationProtocolError).message)
      .toBe("migration manifest head candidate cleanup failed");
    expect((failure as MigrationProtocolError).cause).toBe(cleanupFailure);
    const artifacts = headPublicationArtifactPaths(home, initial.generationId);
    expect(lstatSync(headPath).ino).toBe(lstatSync(artifacts.tmp).ino);
    expect(lstatSync(headPath).nlink).toBe(2);
    expect(existsSync(artifacts.capture)).toBe(true);
    expect(existsSync(artifacts.attempt)).toBe(true);
  });

  it("types capture cleanup failure after final link and retains the remaining evidence", () => {
    const home = makeHome();
    const initial = manifest("publication-capture-cleanup-error");
    new MigrationManifestStore({ homeDir: home }).create(initial);
    const headPath = migrationManifestHeadPath(initial.generationId, home);
    const headBefore = readFileSync(headPath, "utf8");
    const candidate = beginMigrationEffect(initial, {
      effectId: "effect-publication-capture-cleanup-error",
      kind: "verify-dry-run",
      inputSha256: HASH,
      startedAt: "2026-08-12T12:00:01.000Z",
    });
    const cleanupFailure = Object.assign(new Error("capture cleanup denied"), { code: "EACCES" });
    const nodeFs = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;
    const originalUnlink = nodeFs.unlinkSync as (path: string) => void;
    let finalLinkObserved = false;

    let failure: unknown;
    try {
      withPatchedFs("unlinkSync", ((path: string) => {
        if (finalLinkObserved && path.endsWith(".capture")) throw cleanupFailure;
        originalUnlink(path);
      }) as never, () => new MigrationManifestStore({
        homeDir: home,
        observer: (event) => {
          if (event === "after-head-link") finalLinkObserved = true;
        },
      }).update(
        initial.generationId,
        initial.checksumSha256,
        () => candidate,
      ));
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(MigrationProtocolError);
    expect((failure as MigrationProtocolError).reason).toBe("recovery-required");
    expect((failure as MigrationProtocolError).message)
      .toBe("migration manifest head capture cleanup failed");
    expect((failure as MigrationProtocolError).cause).toBe(cleanupFailure);
    const artifacts = headPublicationArtifactPaths(home, initial.generationId);
    expect(readFileSync(artifacts.capture, "utf8")).toBe(headBefore);
    expect(existsSync(artifacts.tmp)).toBe(false);
    expect(lstatSync(headPath).nlink).toBe(1);
    expect(existsSync(artifacts.attempt)).toBe(true);
  });

  it("types attempt cleanup failure after final link and retains the final cleanup evidence", () => {
    const home = makeHome();
    const initial = manifest("publication-attempt-cleanup-error");
    new MigrationManifestStore({ homeDir: home }).create(initial);
    const headPath = migrationManifestHeadPath(initial.generationId, home);
    const candidate = beginMigrationEffect(initial, {
      effectId: "effect-publication-attempt-cleanup-error",
      kind: "verify-dry-run",
      inputSha256: HASH,
      startedAt: "2026-08-12T12:00:01.000Z",
    });
    const cleanupFailure = Object.assign(new Error("attempt cleanup denied"), { code: "EACCES" });
    const nodeFs = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;
    const originalUnlink = nodeFs.unlinkSync as (path: string) => void;
    let finalLinkObserved = false;

    let failure: unknown;
    try {
      withPatchedFs("unlinkSync", ((path: string) => {
        if (finalLinkObserved && path.endsWith(".attempt")) throw cleanupFailure;
        originalUnlink(path);
      }) as never, () => new MigrationManifestStore({
        homeDir: home,
        observer: (event) => {
          if (event === "after-head-link") finalLinkObserved = true;
        },
      }).update(
        initial.generationId,
        initial.checksumSha256,
        () => candidate,
      ));
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(MigrationProtocolError);
    expect((failure as MigrationProtocolError).reason).toBe("recovery-required");
    expect((failure as MigrationProtocolError).message)
      .toBe("migration manifest head publication attempt cleanup failed");
    expect((failure as MigrationProtocolError).cause).toBe(cleanupFailure);
    const artifacts = headPublicationArtifactPaths(home, initial.generationId);
    expect(existsSync(artifacts.tmp)).toBe(false);
    expect(existsSync(artifacts.capture)).toBe(false);
    expect(lstatSync(headPath).nlink).toBe(1);
    expect(existsSync(artifacts.attempt)).toBe(true);
  });

  it("types the directory sync failure between capture and attempt cleanup stages", () => {
    const home = makeHome();
    const initial = manifest("publication-cleanup-sync-error");
    new MigrationManifestStore({ homeDir: home }).create(initial);
    const generation = migrationManifestGenerationDirectory(initial.generationId, home);
    const headPath = migrationManifestHeadPath(initial.generationId, home);
    const candidate = beginMigrationEffect(initial, {
      effectId: "effect-publication-cleanup-sync-error",
      kind: "verify-dry-run",
      inputSha256: HASH,
      startedAt: "2026-08-12T12:00:01.000Z",
    });
    const syncFailure = Object.assign(new Error("cleanup sync denied"), { code: "EIO" });
    const nodeFs = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;
    const originalOpen = nodeFs.openSync as typeof import("node:fs").openSync;
    const originalFsync = nodeFs.fsyncSync as (fd: number) => void;
    const originalUnlink = nodeFs.unlinkSync as (path: string) => void;
    const generationDescriptors = new Set<number>();
    let captureConsumed = false;
    let finalLinkObserved = false;

    let failure: unknown;
    try {
      withPatchedFs("openSync", ((path: string, flags: string | number, mode?: number) => {
        const fd = mode === undefined
          ? originalOpen(path, flags)
          : originalOpen(path, flags, mode);
        if (path === generation) generationDescriptors.add(fd);
        return fd;
      }) as never, () => withPatchedFs("unlinkSync", ((path: string) => {
        originalUnlink(path);
        if (finalLinkObserved && path.endsWith(".capture")) captureConsumed = true;
      }) as never, () => withPatchedFs("fsyncSync", ((fd: number) => {
        if (captureConsumed && generationDescriptors.has(fd)) throw syncFailure;
        originalFsync(fd);
      }) as never, () => new MigrationManifestStore({
        homeDir: home,
        observer: (event) => {
          if (event === "after-head-link") finalLinkObserved = true;
        },
      }).update(
        initial.generationId,
        initial.checksumSha256,
        () => candidate,
      ))));
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(MigrationProtocolError);
    expect((failure as MigrationProtocolError).reason).toBe("recovery-required");
    expect((failure as MigrationProtocolError).message)
      .toBe("migration manifest head cleanup durability sync failed");
    expect((failure as MigrationProtocolError).cause).toBe(syncFailure);
    const artifacts = headPublicationArtifactPaths(home, initial.generationId);
    expect(existsSync(artifacts.tmp)).toBe(false);
    expect(existsSync(artifacts.capture)).toBe(false);
    expect(lstatSync(headPath).nlink).toBe(1);
    expect(existsSync(artifacts.attempt)).toBe(true);
  });

  it("types the final directory sync failure after attempt cleanup and retains the committed head", () => {
    const home = makeHome();
    const initial = manifest("publication-final-cleanup-sync-error");
    new MigrationManifestStore({ homeDir: home }).create(initial);
    const generation = migrationManifestGenerationDirectory(initial.generationId, home);
    const headPath = migrationManifestHeadPath(initial.generationId, home);
    const candidate = beginMigrationEffect(initial, {
      effectId: "effect-publication-final-cleanup-sync-error",
      kind: "verify-dry-run",
      inputSha256: HASH,
      startedAt: "2026-08-12T12:00:01.000Z",
    });
    const syncFailure = Object.assign(new Error("final cleanup sync denied"), { code: "EIO" });
    const nodeFs = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;
    const originalOpen = nodeFs.openSync as typeof import("node:fs").openSync;
    const originalFsync = nodeFs.fsyncSync as (fd: number) => void;
    const originalUnlink = nodeFs.unlinkSync as (path: string) => void;
    const generationDescriptors = new Set<number>();
    let attemptConsumed = false;

    let failure: unknown;
    try {
      withPatchedFs("openSync", ((path: string, flags: string | number, mode?: number) => {
        const fd = mode === undefined
          ? originalOpen(path, flags)
          : originalOpen(path, flags, mode);
        if (path === generation) generationDescriptors.add(fd);
        return fd;
      }) as never, () => withPatchedFs("unlinkSync", ((path: string) => {
        originalUnlink(path);
        if (path.endsWith(".attempt")) attemptConsumed = true;
      }) as never, () => withPatchedFs("fsyncSync", ((fd: number) => {
        if (attemptConsumed && generationDescriptors.has(fd)) throw syncFailure;
        originalFsync(fd);
      }) as never, () => new MigrationManifestStore({ homeDir: home }).update(
        initial.generationId,
        initial.checksumSha256,
        () => candidate,
      ))));
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(MigrationProtocolError);
    expect((failure as MigrationProtocolError).reason).toBe("recovery-required");
    expect((failure as MigrationProtocolError).message)
      .toBe("migration manifest head publication cleanup durability sync failed");
    expect((failure as MigrationProtocolError).cause).toBe(syncFailure);
    expect(attemptConsumed).toBe(true);
    expect(lstatSync(headPath).nlink).toBe(1);
    expect(readdirSync(generation).filter((entry) => (
      /^\.head\.json\.[0-9a-f]{24}\.(?:tmp|capture|attempt)$/u.test(entry)
    ))).toEqual([]);
  });

  it("rejects invalid update inputs and every malformed reducer successor before publication", () => {
    const home = makeHome();
    const events: string[] = [];
    const store = new MigrationManifestStore({ homeDir: home, observer: (event) => events.push(event) });
    const initial = manifest("invalid-update");
    store.create(initial);
    events.length = 0;

    expectProtocolReason(() => store.update(initial.generationId, "A".repeat(64), (value) => value), "invalid-input");
    expectProtocolReason(() => store.update(initial.generationId, initial.checksumSha256, null as never), "invalid-input");
    expect(() => store.update(initial.generationId, initial.checksumSha256, () => {
      throw new Error("reducer failed");
    })).toThrow("reducer failed");

    const valid = beginMigrationEffect(initial, {
      effectId: "effect-1",
      kind: "verify-dry-run",
      inputSha256: HASH,
      startedAt: "2026-08-12T12:00:01.000Z",
    });
    for (const candidate of [
      resealManifest(valid, { generationId: "other-generation" }),
      resealManifest(valid, { revision: 2 }),
      resealManifest(valid, { previousManifestSha256: "b".repeat(64) }),
      { ...valid, checksumSha256: "0".repeat(64) },
    ]) {
      expectProtocolReason(
        () => store.update(initial.generationId, initial.checksumSha256, () => candidate),
        candidate.checksumSha256 === "0".repeat(64) ? "checksum-mismatch" : "unexpected-state",
      );
    }
    const directPhase = resealManifest(valid, {
      phase: "dry-run-verified",
      pendingEffect: null,
    });
    const changedWitness = resealManifest(valid, {
      source: { ...valid.source, contentSha256: "b".repeat(64) },
    });
    for (const candidate of [directPhase, changedWitness]) {
      expectProtocolReason(
        () => store.update(initial.generationId, initial.checksumSha256, () => candidate),
        "unexpected-state",
      );
    }
    expect(store.read(initial.generationId)).toEqual(initial);
    expect(events).toEqual([]);
  });

  it("passes a frozen predecessor to the reducer and refuses exhausted revisions before reducer effects", () => {
    const frozenHome = makeHome();
    const frozenInitial = manifest("frozen-update");
    const frozenStore = new MigrationManifestStore({ homeDir: frozenHome });
    frozenStore.create(frozenInitial);
    const updated = frozenStore.update(
      frozenInitial.generationId,
      frozenInitial.checksumSha256,
      (current) => {
        expect(Object.isFrozen(current)).toBe(true);
        expect(Object.isFrozen(current.source)).toBe(true);
        return beginMigrationEffect(current, {
          effectId: "effect-frozen",
          kind: "verify-dry-run",
          inputSha256: HASH,
          startedAt: "2026-08-12T12:00:01.000Z",
        });
      },
    );
    expect(updated.revision).toBe(1);

    const exhaustedHome = makeHome();
    const exhaustedInitial = manifest("exhausted-update");
    const exhaustedStore = new MigrationManifestStore({ homeDir: exhaustedHome });
    exhaustedStore.create(exhaustedInitial);
    const maximum = replaceWithMaximumRevision(exhaustedHome, exhaustedInitial);
    let reducerCalls = 0;
    expectProtocolReason(() => exhaustedStore.update(
      maximum.generationId,
      maximum.checksumSha256,
      (current) => {
        reducerCalls += 1;
        return current;
      },
    ), "unexpected-state");
    expect(reducerCalls).toBe(0);
    expect(exhaustedStore.read(maximum.generationId)).toEqual(maximum);
  });

  it("preserves exact update crash states and retries only the pre-revision boundary", () => {
    const crashEvents = [
      "before-revision-publication",
      "before-revision-content-publication",
      "after-revision-publication",
      "before-head-capture",
      "after-head-publication",
    ] as const;
    for (const crashEvent of crashEvents) {
      const home = makeHome();
      const initial = manifest(`update-crash-${crashEvents.indexOf(crashEvent)}`);
      const store = new MigrationManifestStore({ homeDir: home });
      store.create(initial);
      const candidate = beginMigrationEffect(initial, {
        effectId: "effect-1",
        kind: "verify-dry-run",
        inputSha256: HASH,
        startedAt: "2026-08-12T12:00:01.000Z",
      });
      const headPath = migrationManifestHeadPath(initial.generationId, home);
      const headBefore = readFileSync(headPath, "utf8");
      const crashing = new MigrationManifestStore({
        homeDir: home,
        observer: (event) => {
          if (event === crashEvent) throw new Error(`crash:${event}`);
        },
      });
      expect(() => crashing.update(initial.generationId, initial.checksumSha256, () => candidate))
        .toThrow(`crash:${crashEvent}`);

      const successorPath = migrationManifestRevisionPath({
        generationId: candidate.generationId,
        revision: candidate.revision,
        checksumSha256: candidate.checksumSha256,
      }, home);
      const crashIndex = crashEvents.indexOf(crashEvent);
      expect(existsSync(successorPath)).toBe(crashIndex >= 2);
      if (crashEvent === "before-head-capture") {
        expect(readFileSync(headPath, "utf8")).toBe(headBefore);
        expectProtocolReason(
          () => store.update(initial.generationId, initial.checksumSha256, () => candidate),
          "recovery-required",
        );
      }
      if (crashEvent === "before-revision-publication" || crashEvent === "before-revision-content-publication") {
        expect(existsSync(resolve(successorPath, ".."))).toBe(
          crashEvent === "before-revision-content-publication",
        );
        if (crashEvent === "before-revision-content-publication") {
          expect(readdirSync(resolve(successorPath, ".."))).toEqual([]);
        }
        expect(store.update(initial.generationId, initial.checksumSha256, () => candidate)).toEqual(candidate);
      } else if (crashEvent === "before-head-capture") {
        expect(readFileSync(headPath, "utf8")).toBe(headBefore);
      } else if (crashEvent === "after-head-publication") {
        expect(store.read(initial.generationId)).toEqual(candidate);
      } else {
        expectProtocolReason(
          () => store.update(initial.generationId, initial.checksumSha256, () => candidate),
          "recovery-required",
        );
        expectProtocolReason(() => store.read(initial.generationId), "recovery-required");
      }
    }
  });

  it("consumes an empty revision scratch before publishing a retry", () => {
    const home = makeHome();
    const initial = manifest("staging-empty-scratch");
    const store = new MigrationManifestStore({ homeDir: home });
    store.create(initial);
    const candidate = beginMigrationEffect(initial, {
      effectId: "effect-staging-empty-scratch",
      kind: "verify-dry-run",
      inputSha256: HASH,
      startedAt: "2026-08-12T12:00:01.000Z",
    });
    const candidateContent = `${canonicalFixture(candidate)}\n`;
    const successorDirectory = resolve(migrationManifestRevisionPath({
      generationId: candidate.generationId,
      revision: candidate.revision,
      checksumSha256: candidate.checksumSha256,
    }, home), "..");
    mkdirSync(successorDirectory, { mode: 0o700 });
    const scratch = `.${candidate.checksumSha256}.json.${"d".repeat(24)}.tmp`;
    writeFileSync(join(successorDirectory, scratch), "", { mode: 0o600 });

    expect(store.update(initial.generationId, initial.checksumSha256, () => candidate)).toEqual(candidate);
    expect(store.read(initial.generationId)).toEqual(candidate);
    expect(readdirSync(successorDirectory)).toEqual([`${candidate.checksumSha256}.json`]);
    expect(readFileSync(join(successorDirectory, `${candidate.checksumSha256}.json`), "utf8"))
      .toBe(candidateContent);
  });

  it("consumes a non-empty proper canonical prefix scratch before publishing a retry", () => {
    const home = makeHome();
    const initial = manifest("staging-prefix-scratch");
    const store = new MigrationManifestStore({ homeDir: home });
    store.create(initial);
    const candidate = beginMigrationEffect(initial, {
      effectId: "effect-staging-prefix-scratch",
      kind: "verify-dry-run",
      inputSha256: HASH,
      startedAt: "2026-08-12T12:00:01.000Z",
    });
    const candidateContent = `${canonicalFixture(candidate)}\n`;
    const scratchContent = candidateContent.slice(0, -1);
    expect(scratchContent.length).toBeGreaterThan(0);
    expect(scratchContent).not.toBe(candidateContent);
    const successorDirectory = resolve(migrationManifestRevisionPath({
      generationId: candidate.generationId,
      revision: candidate.revision,
      checksumSha256: candidate.checksumSha256,
    }, home), "..");
    mkdirSync(successorDirectory, { mode: 0o700 });
    const scratch = `.${candidate.checksumSha256}.json.${"e".repeat(24)}.tmp`;
    writeFileSync(join(successorDirectory, scratch), scratchContent, { mode: 0o600 });

    expect(store.update(initial.generationId, initial.checksumSha256, () => candidate)).toEqual(candidate);
    expect(store.read(initial.generationId)).toEqual(candidate);
    expect(readdirSync(successorDirectory)).toEqual([`${candidate.checksumSha256}.json`]);
    expect(readFileSync(join(successorDirectory, `${candidate.checksumSha256}.json`), "utf8"))
      .toBe(candidateContent);
  });

  it("preserves an invalid UTF-8 revision scratch instead of accepting a decoded prefix", () => {
    const home = makeHome();
    const initial = manifest("staging-invalid-utf8-scratch");
    const store = new MigrationManifestStore({ homeDir: home });
    store.create(initial);
    const candidate = beginMigrationEffect(initial, {
      effectId: "effect-staging-invalid-utf8-scratch",
      kind: "verify-dry-run",
      inputSha256: HASH,
      startedAt: "2026-08-12T12:00:01.000Z",
    });
    const candidatePath = migrationManifestRevisionPath({
      generationId: candidate.generationId,
      revision: candidate.revision,
      checksumSha256: candidate.checksumSha256,
    }, home);
    const successorDirectory = resolve(candidatePath, "..");
    mkdirSync(successorDirectory, { mode: 0o700 });
    const scratch = `.${candidate.checksumSha256}.json.${"c".repeat(24)}.tmp`;
    const scratchPath = join(successorDirectory, scratch);
    const scratchBytes = Buffer.from([0xff, 0x7b]);
    writeFileSync(scratchPath, scratchBytes, { mode: 0o600 });
    const headPath = migrationManifestHeadPath(initial.generationId, home);
    const headBefore = readFileSync(headPath);

    expectProtocolReason(
      () => store.update(initial.generationId, initial.checksumSha256, () => candidate),
      "malformed-manifest",
    );
    expect(readFileSync(scratchPath)).toEqual(scratchBytes);
    expect(readFileSync(headPath)).toEqual(headBefore);
    expect(existsSync(candidatePath)).toBe(false);
  });

  it("preserves a legal revision scratch whose bytes do not match the candidate", () => {
    for (const [index, scratchFixture] of [
      "unrelated\n",
      "not-json\n",
      "non-prefix",
      null,
    ].entries()) {
      const home = makeHome();
      const initial = manifest(`revision-scratch-mismatch-${index}`);
      const events: string[] = [];
      const store = new MigrationManifestStore({
        homeDir: home,
        observer: (event) => events.push(event),
      });
      store.create(initial);
      events.length = 0;
      const candidate = beginMigrationEffect(initial, {
        effectId: `effect-revision-scratch-mismatch-${index}`,
        kind: "verify-dry-run",
        inputSha256: HASH,
        startedAt: "2026-08-12T12:00:01.000Z",
      });
      const candidateContent = `${canonicalFixture(candidate)}\n`;
      const scratchContent = scratchFixture === "non-prefix"
        ? `${candidateContent.slice(0, -1)}x`
        : scratchFixture ?? `${canonicalFixture(beginMigrationEffect(initial, {
        effectId: "effect-well-formed-wrong-content",
        kind: "verify-dry-run",
        inputSha256: HASH,
        startedAt: "2026-08-12T12:00:02.000Z",
      }))}\n`;
      if (scratchFixture === "non-prefix") {
        expect(candidateContent.startsWith(scratchContent)).toBe(false);
      }
      const candidatePath = migrationManifestRevisionPath({
        generationId: candidate.generationId,
        revision: candidate.revision,
        checksumSha256: candidate.checksumSha256,
      }, home);
      const revisionDirectory = resolve(candidatePath, "..");
      mkdirSync(revisionDirectory, { mode: 0o700 });
      const scratch = `.${candidate.checksumSha256}.json.${"a".repeat(24)}.tmp`;
      const scratchPath = join(revisionDirectory, scratch);
      writeFileSync(scratchPath, scratchContent, { mode: 0o600 });
      const headPath = migrationManifestHeadPath(initial.generationId, home);
      const headBefore = readFileSync(headPath, "utf8");

      expectProtocolReason(
        () => store.update(initial.generationId, initial.checksumSha256, () => candidate),
        "malformed-manifest",
      );
      expect(events).toEqual(["before-revision-publication"]);
      expect(readFileSync(headPath, "utf8")).toBe(headBefore);
      expect(existsSync(candidatePath)).toBe(false);
      expect(readdirSync(revisionDirectory)).toEqual([scratch]);
      expect(readFileSync(scratchPath, "utf8")).toBe(scratchContent);
    }
  });

  it("consumes an exact canonical revision scratch before publishing a retry", () => {
    const home = makeHome();
    const initial = manifest("canonical-revision-scratch");
    const events: string[] = [];
    const store = new MigrationManifestStore({
      homeDir: home,
      observer: (event) => events.push(event),
    });
    store.create(initial);
    events.length = 0;
    const candidate = beginMigrationEffect(initial, {
      effectId: "effect-canonical-revision-scratch",
      kind: "verify-dry-run",
      inputSha256: HASH,
      startedAt: "2026-08-12T12:00:01.000Z",
    });
    const candidateContent = `${canonicalFixture(candidate)}\n`;
    const candidatePath = migrationManifestRevisionPath({
      generationId: candidate.generationId,
      revision: candidate.revision,
      checksumSha256: candidate.checksumSha256,
    }, home);
    const revisionDirectory = resolve(candidatePath, "..");
    mkdirSync(revisionDirectory, { mode: 0o700 });
    const scratch = `.${candidate.checksumSha256}.json.${"b".repeat(24)}.tmp`;
    writeFileSync(join(revisionDirectory, scratch), candidateContent, { mode: 0o600 });

    expect(store.update(initial.generationId, initial.checksumSha256, () => candidate)).toEqual(candidate);
    expect(store.read(initial.generationId)).toEqual(candidate);
    expect(events).toEqual([
      "before-revision-publication",
      "before-revision-content-publication",
      "after-revision-publication",
      "before-head-capture",
      "after-head-capture",
      "before-head-link",
      "after-head-link",
      "after-head-publication",
    ]);
    expect(readdirSync(revisionDirectory)).toEqual([`${candidate.checksumSha256}.json`]);
    expect(readFileSync(candidatePath, "utf8")).toBe(candidateContent);
  });

  it("syncs a consumed revision directory before content publication", () => {
    const home = makeHome();
    const initial = manifest("revision-directory-sync");
    const events: string[] = [];
    const store = new MigrationManifestStore({
      homeDir: home,
      observer: (event) => events.push(event),
    });
    store.create(initial);
    events.length = 0;
    const candidate = beginMigrationEffect(initial, {
      effectId: "effect-revision-directory-sync",
      kind: "verify-dry-run",
      inputSha256: HASH,
      startedAt: "2026-08-12T12:00:01.000Z",
    });
    const candidatePath = migrationManifestRevisionPath({
      generationId: candidate.generationId,
      revision: candidate.revision,
      checksumSha256: candidate.checksumSha256,
    }, home);
    const revisionDirectory = resolve(candidatePath, "..");
    mkdirSync(revisionDirectory, { mode: 0o700 });
    const scratch = `.${candidate.checksumSha256}.json.${"c".repeat(24)}.tmp`;
    writeFileSync(join(revisionDirectory, scratch), `${canonicalFixture(candidate)}\n`, { mode: 0o600 });
    const headPath = migrationManifestHeadPath(initial.generationId, home);
    const headBefore = readFileSync(headPath, "utf8");
    const nodeFs = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;
    const originalOpen = nodeFs.openSync as typeof import("node:fs").openSync;
    const originalFsync = nodeFs.fsyncSync as (fd: number) => void;
    const revisionDirectoryDescriptors = new Set<number>();
    const syncFailure = Object.assign(new Error("revision directory sync denied"), { code: "EIO" });

    let failure: unknown;
    try {
      withPatchedFs("openSync", ((path: string, flags: string | number, mode?: number) => {
        const fd = mode === undefined
          ? originalOpen(path, flags)
          : originalOpen(path, flags, mode);
        if (path === revisionDirectory) revisionDirectoryDescriptors.add(fd);
        return fd;
      }) as never, () => withPatchedFs("fsyncSync", ((fd: number) => {
        if (revisionDirectoryDescriptors.has(fd)) throw syncFailure;
        return originalFsync(fd);
      }) as never, () => store.update(
        initial.generationId,
        initial.checksumSha256,
        () => candidate,
      )));
      throw new Error("expected MigrationProtocolError");
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(MigrationProtocolError);
    expect((failure as MigrationProtocolError).reason).toBe("malformed-manifest");
    expect((failure as MigrationProtocolError).message)
      .toBe("migration manifest revision directory durability sync failed");
    expect((failure as MigrationProtocolError).cause).toBe(syncFailure);
    expect(events).toEqual(["before-revision-publication"]);
    expect(readFileSync(headPath, "utf8")).toBe(headBefore);
    expect(existsSync(candidatePath)).toBe(false);
    expect(readdirSync(revisionDirectory)).toEqual([]);
  });

  it("preserves multiple pre-content revision scratches and fails closed", () => {
    const home = makeHome();
    const initial = manifest("multiple-pre-content-revision-scratches");
    const store = new MigrationManifestStore({ homeDir: home });
    store.create(initial);
    const candidate = beginMigrationEffect(initial, {
      effectId: "effect-multiple-pre-content-revision-scratches",
      kind: "verify-dry-run",
      inputSha256: HASH,
      startedAt: "2026-08-12T12:00:01.000Z",
    });
    const successorDirectory = resolve(migrationManifestRevisionPath({
      generationId: candidate.generationId,
      revision: candidate.revision,
      checksumSha256: candidate.checksumSha256,
    }, home), "..");
    mkdirSync(successorDirectory, { mode: 0o700 });
    const scratches = ["a", "b"].map((suffix) => (
      `.${candidate.checksumSha256}.json.${suffix.repeat(24)}.tmp`
    ));
    for (const scratch of scratches) {
      writeFileSync(join(successorDirectory, scratch), `scratch-${scratch}\n`, { mode: 0o600 });
    }

    expectProtocolReason(
      () => store.update(initial.generationId, initial.checksumSha256, () => candidate),
      "malformed-manifest",
    );
    expect(readdirSync(successorDirectory).sort()).toEqual(scratches.sort());
    expect(existsSync(migrationManifestRevisionPath({
      generationId: candidate.generationId,
      revision: candidate.revision,
      checksumSha256: candidate.checksumSha256,
    }, home))).toBe(false);
    expectProtocolReason(() => store.read(initial.generationId), "recovery-required");
  });

  it("accepts the exact post-link writer crash pair without deleting evidence", () => {
    const home = makeHome();
    const initial = manifest("post-link-scratch");
    const store = new MigrationManifestStore({ homeDir: home });
    store.create(initial);
    const candidate = beginMigrationEffect(initial, {
      effectId: "effect-post-link-scratch",
      kind: "verify-dry-run",
      inputSha256: HASH,
      startedAt: "2026-08-12T12:00:01.000Z",
    });
    const successorDirectory = resolve(migrationManifestRevisionPath({
      generationId: candidate.generationId,
      revision: candidate.revision,
      checksumSha256: candidate.checksumSha256,
    }, home), "..");
    const nodeFs = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;
    const originalUnlink = nodeFs.unlinkSync as (path: string) => void;
    expect(() => withPatchedFs("unlinkSync", ((path: string) => {
      if (path.startsWith(`${successorDirectory}/.`) && path.endsWith(".tmp")) {
        throw Object.assign(new Error("crash:after-manifest-link"), { code: "EACCES" });
      }
      originalUnlink(path);
    }) as never, () => store.update(
      initial.generationId,
      initial.checksumSha256,
      () => candidate,
    ))).toThrow("crash:after-manifest-link");
    expect(readdirSync(successorDirectory)).toHaveLength(2);
    expectProtocolReason(() => store.read(initial.generationId), "recovery-required");
    expect(store.recover(initial.generationId)).toEqual(candidate);
    expect(store.read(initial.generationId)).toEqual(candidate);
    expect(readdirSync(successorDirectory)).toHaveLength(2);
  });

  it("rejects a separate single-link revision manifest and scratch pair", () => {
    const home = makeHome();
    const initial = manifest("separate-single-link-revision-pair");
    const store = new MigrationManifestStore({ homeDir: home });
    store.create(initial);
    const candidate = beginMigrationEffect(initial, {
      effectId: "effect-separate-single-link-revision-pair",
      kind: "verify-dry-run",
      inputSha256: HASH,
      startedAt: "2026-08-12T12:00:01.000Z",
    });
    const manifestPath = publishSuccessorOrphan(home, initial, candidate);
    const revisionDirectory = resolve(manifestPath, "..");
    const scratchPath = join(
      revisionDirectory,
      `.${candidate.checksumSha256}.json.${"e".repeat(24)}.tmp`,
    );
    writeFileSync(scratchPath, readFileSync(manifestPath), { mode: 0o600 });

    expectProtocolReason(() => store.recover(initial.generationId), "malformed-manifest");
    expect(readFileSync(migrationManifestHeadPath(initial.generationId, home), "utf8"))
      .toContain(initial.checksumSha256);
    expect(lstatSync(manifestPath).nlink).toBe(1);
    expect(lstatSync(scratchPath).nlink).toBe(1);
  });

  it("rejects a manifest and scratch pair that is not an exact writer state", () => {
    const home = makeHome();
    const initial = manifest("invalid-writer-pair");
    const store = new MigrationManifestStore({ homeDir: home });
    store.create(initial);
    const candidate = beginMigrationEffect(initial, {
      effectId: "effect-invalid-writer-pair",
      kind: "verify-dry-run",
      inputSha256: HASH,
      startedAt: "2026-08-12T12:00:01.000Z",
    });
    const successorDirectory = resolve(migrationManifestRevisionPath({
      generationId: candidate.generationId,
      revision: candidate.revision,
      checksumSha256: candidate.checksumSha256,
    }, home), "..");
    const nodeFs = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;
    const originalUnlink = nodeFs.unlinkSync as (path: string) => void;
    expect(() => withPatchedFs("unlinkSync", ((path: string) => {
      if (path.startsWith(`${successorDirectory}/.`) && path.endsWith(".tmp")) {
        throw Object.assign(new Error("crash:retain-writer-pair"), { code: "EACCES" });
      }
      originalUnlink(path);
    }) as never, () => store.update(
      initial.generationId,
      initial.checksumSha256,
      () => candidate,
    ))).toThrow("crash:retain-writer-pair");
    const scratch = readdirSync(successorDirectory).find((entry) => entry.startsWith("."))!;
    unlinkSync(join(successorDirectory, scratch));
    writeFileSync(join(successorDirectory, scratch), "different", { mode: 0o600 });
    linkSync(
      join(successorDirectory, scratch),
      join(home, "unexpected-scratch-hard-link"),
    );

    expectProtocolReason(() => store.recover(initial.generationId), "malformed-manifest");
    expect(readFileSync(migrationManifestHeadPath(initial.generationId, home), "utf8"))
      .toContain(initial.checksumSha256);
  });

  it("loses exact-string head compare-and-swap races without overwriting shorter evidence", () => {
    const home = makeHome();
    const initial = manifest("head-cas-race");
    const headPath = migrationManifestHeadPath(initial.generationId, home);
    new MigrationManifestStore({ homeDir: home }).create(initial);
    const candidate = beginMigrationEffect(initial, {
      effectId: "effect-1",
      kind: "verify-dry-run",
      inputSha256: HASH,
      startedAt: "2026-08-12T12:00:01.000Z",
    });
    const replacement = "{}\n";
    const racing = new MigrationManifestStore({
      homeDir: home,
      observer: (event) => {
        if (event === "before-head-link") {
          writeFileSync(headPath, replacement, { mode: 0o600 });
        }
      },
    });
    expectProtocolReason(
      () => racing.update(initial.generationId, initial.checksumSha256, () => candidate),
      "recovery-required",
    );
    expect(readFileSync(headPath, "utf8")).toBe(replacement);
    const successorPath = migrationManifestRevisionPath({
      generationId: candidate.generationId,
      revision: candidate.revision,
      checksumSha256: candidate.checksumSha256,
    }, home);
    expect(existsSync(successorPath)).toBe(true);
    const artifacts = headPublicationArtifactPaths(home, initial.generationId);
    expect(existsSync(artifacts.tmp)).toBe(true);
    expect(existsSync(artifacts.capture)).toBe(true);
    expect(existsSync(artifacts.attempt)).toBe(true);
  });

  it("preserves immediate-successor probe failures instead of guessing", () => {
    const home = makeHome();
    const initial = manifest("successor-probe-failure");
    const store = new MigrationManifestStore({ homeDir: home });
    store.create(initial);
    const successor = join(
      migrationManifestGenerationDirectory(initial.generationId, home),
      "revisions",
      "0000000000000001",
    );
    const realLstat = createRequire(import.meta.url)("node:fs").lstatSync as typeof lstatSync;
    expect(() => withPatchedFs("lstatSync", ((path: string, options?: unknown) => {
      if (path === successor) {
        const error = new Error("successor probe denied") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      }
      return realLstat(path, options as never);
    }) as never, () => store.read(initial.generationId))).toThrow("successor probe denied");
  });

  it("reads a valid maximum-safe revision without probing an impossible successor", () => {
    const home = makeHome();
    const initial = manifest("maximum-revision");
    const store = new MigrationManifestStore({ homeDir: home });
    store.create(initial);
    const maximum = replaceWithMaximumRevision(home, initial);
    expect(store.read(initial.generationId)).toEqual(maximum);
  });
});

describe("migration manifest exact recovery", () => {
  it("recovers a pre-capture nonce group without replacing the prior head", () => {
    const home = makeHome();
    const initial = manifest("recover-pre-capture-nonce-group");
    const store = new MigrationManifestStore({ homeDir: home });
    store.create(initial);
    const candidate = beginMigrationEffect(initial, {
      effectId: "effect-recover-pre-capture-nonce-group",
      kind: "verify-dry-run",
      inputSha256: HASH,
      startedAt: "2026-08-12T12:00:01.000Z",
    });
    const headPath = migrationManifestHeadPath(initial.generationId, home);
    const headBefore = readFileSync(headPath, "utf8");
    const nextHead = createMigrationManifestHead({
      generationId: candidate.generationId,
      revision: candidate.revision,
      manifestSha256: candidate.checksumSha256,
      updatedAt: candidate.updatedAt,
    });
    const crashing = new MigrationManifestStore({
      homeDir: home,
      observer: (event) => {
        if (event === "before-head-capture") throw new Error("crash:before-head-capture");
      },
    });

    expect(() => crashing.update(
      initial.generationId,
      initial.checksumSha256,
      () => candidate,
    )).toThrow("crash:before-head-capture");

    const artifacts = headPublicationArtifactPaths(home, initial.generationId);
    expect(readFileSync(headPath, "utf8")).toBe(headBefore);
    expect(readFileSync(artifacts.tmp, "utf8")).toBe(migrationManifestHeadContent(nextHead));
    expectCanonicalHeadPublicationAttempt(artifacts.attempt, {
      generationId: candidate.generationId,
      expectedHeadRawSha256: createHash("sha256").update(headBefore, "utf8").digest("hex"),
      candidateHeadRawSha256: createHash("sha256")
        .update(migrationManifestHeadContent(nextHead), "utf8")
        .digest("hex"),
      candidateManifestSha256: candidate.checksumSha256,
      candidateRevision: candidate.revision,
    });
    expect(existsSync(artifacts.capture)).toBe(false);
    expectProtocolReason(() => store.read(initial.generationId), "recovery-required");

    expect(store.recover(initial.generationId)).toEqual(candidate);
    expect(readdirSync(artifacts.generation).filter((entry) => (
      /^\.head\.json\.[0-9a-f]{24}\.(?:tmp|capture|attempt)$/u.test(entry)
    ))).toEqual([]);
    expect(store.recover(initial.generationId)).toEqual(candidate);
    expect(store.read(initial.generationId)).toEqual(candidate);
  });

  it("preserves an existing capture conflict without replacing the publication group", () => {
    const home = makeHome();
    const initial = manifest("recover-capture-conflict");
    const store = new MigrationManifestStore({ homeDir: home });
    store.create(initial);
    const candidate = beginMigrationEffect(initial, {
      effectId: "effect-recover-capture-conflict",
      kind: "verify-dry-run",
      inputSha256: HASH,
      startedAt: "2026-08-12T12:00:01.000Z",
    });
    const crashing = new MigrationManifestStore({
      homeDir: home,
      observer: (event) => {
        if (event === "before-head-capture") throw new Error("crash:before-head-capture");
      },
    });

    expect(() => crashing.update(
      initial.generationId,
      initial.checksumSha256,
      () => candidate,
    )).toThrow("crash:before-head-capture");

    const artifacts = headPublicationArtifactPaths(home, initial.generationId);
    const sentinel = "authenticated capture conflict sentinel\n";
    writeFileSync(artifacts.capture, sentinel, { mode: 0o600 });
    const evidence = {
      head: readFileSync(migrationManifestHeadPath(initial.generationId, home), "utf8"),
      tmp: readFileSync(artifacts.tmp, "utf8"),
      attempt: readFileSync(artifacts.attempt, "utf8"),
      capture: readFileSync(artifacts.capture, "utf8"),
    };
    let failure: unknown;
    try {
      store.recover(initial.generationId);
    } catch (error) {
      failure = error;
    }

    expect(readFileSync(migrationManifestHeadPath(initial.generationId, home), "utf8"))
      .toBe(evidence.head);
    expect(readFileSync(artifacts.tmp, "utf8")).toBe(evidence.tmp);
    expect(readFileSync(artifacts.attempt, "utf8")).toBe(evidence.attempt);
    expect(readFileSync(artifacts.capture, "utf8")).toBe(evidence.capture);
    expect(failure).toBeInstanceOf(MigrationProtocolError);
    expect((failure as MigrationProtocolError).reason).toBe("recovery-required");
  });

  it("recovers a headless nonce group and cleans it idempotently", () => {
    const state = createRow1PublicationState("recover-headless-group");
    renameSync(state.headPath, state.artifacts.capture);
    syncGenerationDirectory(state.generation);

    expect(existsSync(state.headPath)).toBe(false);
    expect(existsSync(state.artifacts.tmp)).toBe(true);
    expect(existsSync(state.artifacts.capture)).toBe(true);
    expect(existsSync(state.artifacts.attempt)).toBe(true);

    const store = new MigrationManifestStore({ homeDir: state.home });
    expectProtocolReason(
      () => store.read(state.initial.generationId),
      "recovery-required",
    );
    expect(store.recover(state.initial.generationId)).toEqual(state.candidate);
    expect(existsSync(state.artifacts.tmp)).toBe(false);
    expect(existsSync(state.artifacts.capture)).toBe(false);
    expect(existsSync(state.artifacts.attempt)).toBe(false);
    expect(store.recover(state.initial.generationId)).toEqual(state.candidate);
    expect(store.read(state.initial.generationId)).toEqual(state.candidate);
  });

  it("recovers a committed post-link nonce group and preserves exact evidence", () => {
    const state = createRow1PublicationState("recover-post-link-group");
    renameSync(state.headPath, state.artifacts.capture);
    syncGenerationDirectory(state.generation);
    linkSync(state.artifacts.tmp, state.headPath);
    syncGenerationDirectory(state.generation);

    const headStat = lstatSync(state.headPath);
    const tmpStat = lstatSync(state.artifacts.tmp);
    expect(headStat.dev).toBe(tmpStat.dev);
    expect(headStat.ino).toBe(tmpStat.ino);
    expect(headStat.nlink).toBe(2);
    expect(tmpStat.nlink).toBe(2);
    expect(readFileSync(state.headPath, "utf8")).toBe(readFileSync(state.artifacts.tmp, "utf8"));
    expect(lstatSync(state.artifacts.capture).nlink).toBe(1);
    expect(lstatSync(state.artifacts.attempt).nlink).toBe(1);

    const evidence = {
      head: readFileSync(state.headPath, "utf8"),
      capture: readFileSync(state.artifacts.capture, "utf8"),
      attempt: readFileSync(state.artifacts.attempt, "utf8"),
    };
    const store = new MigrationManifestStore({ homeDir: state.home });
    expect(store.read(state.initial.generationId)).toEqual(state.candidate);
    expect(readFileSync(state.headPath, "utf8")).toBe(evidence.head);
    expect(readFileSync(state.artifacts.capture, "utf8")).toBe(evidence.capture);
    expect(readFileSync(state.artifacts.attempt, "utf8")).toBe(evidence.attempt);

    expectProtocolReason(
      () => store.update(state.initial.generationId, "f".repeat(64), () => state.candidate),
      "recovery-required",
    );

    expect(store.recover(state.initial.generationId)).toEqual(state.candidate);
    expect(existsSync(state.artifacts.tmp)).toBe(false);
    expect(existsSync(state.artifacts.capture)).toBe(false);
    expect(existsSync(state.artifacts.attempt)).toBe(false);
    expect(readFileSync(state.headPath, "utf8")).toBe(evidence.head);
    expect(store.recover(state.initial.generationId)).toEqual(state.candidate);
    expect(store.read(state.initial.generationId)).toEqual(state.candidate);
  });

  it("recovers a committed nonce group after candidate-alias cleanup and preserves the exact head", () => {
    const state = createRow1PublicationState("recover-post-link-alias-cleanup");
    renameSync(state.headPath, state.artifacts.capture);
    syncGenerationDirectory(state.generation);
    linkSync(state.artifacts.tmp, state.headPath);
    syncGenerationDirectory(state.generation);

    const candidateHead = readFileSync(state.headPath, "utf8");
    unlinkSync(state.artifacts.tmp);
    syncGenerationDirectory(state.generation);

    expect(lstatSync(state.headPath).nlink).toBe(1);
    expect(readFileSync(state.headPath, "utf8")).toBe(candidateHead);
    expect(existsSync(state.artifacts.tmp)).toBe(false);
    expect(existsSync(state.artifacts.capture)).toBe(true);
    expect(lstatSync(state.artifacts.capture).nlink).toBe(1);
    expect(existsSync(state.artifacts.attempt)).toBe(true);
    expect(lstatSync(state.artifacts.attempt).nlink).toBe(1);

    const store = new MigrationManifestStore({ homeDir: state.home });
    expect(store.read(state.initial.generationId)).toEqual(state.candidate);
    expect(readFileSync(state.headPath, "utf8")).toBe(candidateHead);

    expect(store.recover(state.initial.generationId)).toEqual(state.candidate);
    expect(existsSync(state.artifacts.capture)).toBe(false);
    expect(existsSync(state.artifacts.attempt)).toBe(false);
    expect(existsSync(state.artifacts.tmp)).toBe(false);
    expect(readFileSync(state.headPath, "utf8")).toBe(candidateHead);
    expect(lstatSync(state.headPath).nlink).toBe(1);

    expect(store.recover(state.initial.generationId)).toEqual(state.candidate);
    expect(store.read(state.initial.generationId)).toEqual(state.candidate);
    expect(readFileSync(state.headPath, "utf8")).toBe(candidateHead);
  });

  it("types every capture-cleaned recovery cleanup boundary", () => {
    for (const scenario of ["attempt-unlink", "directory-sync"] as const) {
      const state = createCaptureCleanedPublicationState(`recover-capture-cleaned-${scenario}`);
      const evidence = capturePublicationEvidence(state);
      const failure = Object.assign(new Error(`injected ${scenario}`), { code: "EIO" });
      const nodeFs = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;
      const originalUnlink = nodeFs.unlinkSync as (path: string) => void;
      const originalOpen = nodeFs.openSync as typeof openSync;
      const originalFsync = nodeFs.fsyncSync as typeof fsyncSync;
      const generationDescriptors = new Set<number>();
      let attemptConsumed = false;

      const recover = () => withPatchedFs("openSync", ((path: string, flags: string | number, mode?: number) => {
        const fd = mode === undefined ? originalOpen(path, flags) : originalOpen(path, flags, mode);
        if (path === state.generation) generationDescriptors.add(fd);
        return fd;
      }) as never, () => withPatchedFs("unlinkSync", ((path: string) => {
        if (scenario === "attempt-unlink" && path === state.artifacts.attempt) throw failure;
        originalUnlink(path);
        if (path === state.artifacts.attempt) attemptConsumed = true;
      }) as never, () => withPatchedFs("fsyncSync", ((fd: number) => {
        if (scenario === "directory-sync" && attemptConsumed && generationDescriptors.has(fd)) throw failure;
        originalFsync(fd);
      }) as never, () => new MigrationManifestStore({ homeDir: state.home }).recover(
        state.initial.generationId,
      ))));

      expectRecoveryFailure(
        recover,
        scenario === "attempt-unlink"
          ? "migration manifest head publication attempt cleanup failed"
          : "migration manifest head publication cleanup durability sync failed",
        failure,
      );
      if (scenario === "attempt-unlink") {
        expectPublicationEvidence(state, evidence);
      } else {
        expect(existsSync(state.artifacts.attempt)).toBe(false);
        expect(readFileSync(state.headPath, "utf8")).toBe(evidence.head);
      }
    }
  });

  it("types committed recovery durability sync failure before cleanup", () => {
    const state = createRow1PublicationState("recover-committed-sync-failure");
    renameSync(state.headPath, state.artifacts.capture);
    linkSync(state.artifacts.tmp, state.headPath);
    const evidence = capturePublicationEvidence(state);
    const failure = Object.assign(new Error("committed sync denied"), { code: "EIO" });
    const nodeFs = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;
    const originalOpen = nodeFs.openSync as typeof openSync;
    const originalFsync = nodeFs.fsyncSync as typeof fsyncSync;
    const generationDescriptors = new Set<number>();

    expectRecoveryFailure(
      () => withPatchedFs("openSync", ((path: string, flags: string | number, mode?: number) => {
        const fd = mode === undefined ? originalOpen(path, flags) : originalOpen(path, flags, mode);
        if (path === state.generation) generationDescriptors.add(fd);
        return fd;
      }) as never, () => withPatchedFs("fsyncSync", ((fd: number) => {
        if (generationDescriptors.has(fd)) throw failure;
        originalFsync(fd);
      }) as never, () => new MigrationManifestStore({ homeDir: state.home }).recover(
        state.initial.generationId,
      ))),
      "migration manifest head publication durability sync failed",
      failure,
    );
    expectPublicationEvidence(state, evidence);
  });

  it("types pre-capture recovery capture failures", () => {
    for (const scenario of ["rename", "sync"] as const) {
      const state = createRow1PublicationState(`recover-pre-capture-${scenario}`);
      const evidence = capturePublicationEvidence(state);
      const failure = Object.assign(new Error(`capture ${scenario} denied`), { code: "EIO" });
      const nodeFs = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;
      const originalRename = nodeFs.renameSync as typeof renameSync;
      const originalOpen = nodeFs.openSync as typeof openSync;
      const originalFsync = nodeFs.fsyncSync as typeof fsyncSync;
      const generationDescriptors = new Set<number>();
      let captured = false;

      const recover = () => withPatchedFs("renameSync", ((source: string, destination: string) => {
        if (scenario === "rename" && source === state.headPath && destination === state.artifacts.capture) {
          throw failure;
        }
        const result = originalRename(source, destination);
        if (source === state.headPath && destination === state.artifacts.capture) captured = true;
        return result;
      }) as never, () => withPatchedFs("openSync", ((path: string, flags: string | number, mode?: number) => {
        const fd = mode === undefined ? originalOpen(path, flags) : originalOpen(path, flags, mode);
        if (path === state.generation) generationDescriptors.add(fd);
        return fd;
      }) as never, () => withPatchedFs("fsyncSync", ((fd: number) => {
        if (scenario === "sync" && captured && generationDescriptors.has(fd)) throw failure;
        originalFsync(fd);
      }) as never, () => new MigrationManifestStore({ homeDir: state.home }).recover(
        state.initial.generationId,
      ))));

      expectRecoveryFailure(
        recover,
        scenario === "rename"
          ? "migration manifest head capture rename failed"
          : "migration manifest head capture durability sync failed",
        failure,
      );
      if (scenario === "rename") {
        expectPublicationEvidence(state, evidence);
      } else {
        expect(existsSync(state.headPath)).toBe(false);
        expect(readFileSync(state.artifacts.capture, "utf8")).toBe(evidence.head);
      }
    }
  });

  it("types both candidate-link recovery failures", () => {
    for (const code of ["EEXIST", "EIO"] as const) {
      const state = createRow1PublicationState(`recover-link-${code.toLowerCase()}`);
      renameSync(state.headPath, state.artifacts.capture);
      const capture = readFileSync(state.artifacts.capture, "utf8");
      const candidate = readFileSync(state.artifacts.tmp, "utf8");
      const attempt = readFileSync(state.artifacts.attempt, "utf8");
      const failure = Object.assign(new Error(`link ${code}`), { code });
      const nodeFs = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;
      const originalLink = nodeFs.linkSync as typeof linkSync;
      let observed: unknown;
      try {
        withPatchedFs("linkSync", ((source: string, destination: string) => {
          if (source === state.artifacts.tmp && destination === state.headPath) throw failure;
          return originalLink(source, destination);
        }) as never, () => new MigrationManifestStore({ homeDir: state.home }).recover(
          state.initial.generationId,
        ));
      } catch (error) {
        observed = error;
      }
      expect(observed).toBeInstanceOf(MigrationProtocolError);
      expect((observed as MigrationProtocolError).reason).toBe("recovery-required");
      expect((observed as MigrationProtocolError).message).toBe(code === "EEXIST"
        ? "migration manifest head was replaced before candidate publication"
        : "migration manifest head candidate publication failed");
      expect((observed as MigrationProtocolError).cause).toBe(failure);
      expect(existsSync(state.headPath)).toBe(false);
      expect(readFileSync(state.artifacts.capture, "utf8")).toBe(capture);
      expect(readFileSync(state.artifacts.tmp, "utf8")).toBe(candidate);
      expect(readFileSync(state.artifacts.attempt, "utf8")).toBe(attempt);
    }
  });

  it("types post-link recovery cleanup and durability failures", () => {
    for (const scenario of [
      "link-sync",
      "candidate-unlink",
      "capture-unlink",
      "capture-sync",
      "attempt-unlink",
      "attempt-sync",
    ] as const) {
      const state = createRow1PublicationState(`recover-cleanup-${scenario}`);
      renameSync(state.headPath, state.artifacts.capture);
      const failure = Object.assign(new Error(`injected ${scenario}`), { code: "EIO" });
      const nodeFs = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;
      const originalLink = nodeFs.linkSync as typeof linkSync;
      const originalUnlink = nodeFs.unlinkSync as (path: string) => void;
      const originalOpen = nodeFs.openSync as typeof openSync;
      const originalFsync = nodeFs.fsyncSync as typeof fsyncSync;
      const generationDescriptors = new Set<number>();
      let linked = false;
      let captureConsumed = false;
      let attemptConsumed = false;

      const recover = () => withPatchedFs("linkSync", ((source: string, destination: string) => {
        const result = originalLink(source, destination);
        if (source === state.artifacts.tmp && destination === state.headPath) linked = true;
        return result;
      }) as never, () => withPatchedFs("openSync", ((path: string, flags: string | number, mode?: number) => {
        const fd = mode === undefined ? originalOpen(path, flags) : originalOpen(path, flags, mode);
        if (path === state.generation) generationDescriptors.add(fd);
        return fd;
      }) as never, () => withPatchedFs("unlinkSync", ((path: string) => {
        if (scenario === "candidate-unlink" && path === state.artifacts.tmp) throw failure;
        if (scenario === "capture-unlink" && path === state.artifacts.capture) throw failure;
        if (scenario === "attempt-unlink" && path === state.artifacts.attempt) throw failure;
        originalUnlink(path);
        if (path === state.artifacts.capture) captureConsumed = true;
        if (path === state.artifacts.attempt) attemptConsumed = true;
      }) as never, () => withPatchedFs("fsyncSync", ((fd: number) => {
        if (!generationDescriptors.has(fd)) return originalFsync(fd);
        if (scenario === "link-sync" && linked && !captureConsumed) throw failure;
        if (scenario === "capture-sync" && captureConsumed && !attemptConsumed) throw failure;
        if (scenario === "attempt-sync" && attemptConsumed) throw failure;
        return originalFsync(fd);
      }) as never, () => new MigrationManifestStore({ homeDir: state.home }).recover(
        state.initial.generationId,
      )))));

      const messages = {
        "link-sync": "migration manifest head publication durability sync failed",
        "candidate-unlink": "migration manifest head candidate cleanup failed",
        "capture-unlink": "migration manifest head capture cleanup failed",
        "capture-sync": "migration manifest head cleanup durability sync failed",
        "attempt-unlink": "migration manifest head publication attempt cleanup failed",
        "attempt-sync": "migration manifest head publication cleanup durability sync failed",
      } as const;
      expectRecoveryFailure(recover, messages[scenario], failure);
      expect(readFileSync(state.headPath, "utf8")).toBe(readFileSync(
        existsSync(state.artifacts.tmp) ? state.artifacts.tmp : state.headPath,
        "utf8",
      ));
    }
  });

  it("consumes a post-link head alias before update stages its successor", () => {
    const home = makeHome();
    const initial = manifest("head-alias-update-order");
    const store = new MigrationManifestStore({ homeDir: home });
    store.create(initial);

    const generation = migrationManifestGenerationDirectory(initial.generationId, home);
    const headPath = migrationManifestHeadPath(initial.generationId, home);
    const aliasPath = join(generation, ".head.json.0123456789abcdef01234567.tmp");
    linkSync(headPath, aliasPath);
    const candidate = beginMigrationEffect(initial, {
      effectId: "effect-head-alias-update",
      kind: "verify-dry-run",
      inputSha256: HASH,
      startedAt: "2026-08-12T12:00:01.000Z",
    });
    const events: string[] = [];
    const updating = new MigrationManifestStore({
      homeDir: home,
      observer: (event) => {
        events.push(event);
        if (event === "before-revision-publication") {
          expect(existsSync(aliasPath)).toBe(false);
          expect(lstatSync(headPath).nlink).toBe(1);
        }
      },
    });

    expect(updating.update(initial.generationId, initial.checksumSha256, () => candidate)).toEqual(candidate);
    expect(existsSync(aliasPath)).toBe(false);
    expect(updating.read(initial.generationId)).toEqual(candidate);
    expect(existsSync(migrationManifestRevisionPath({
      generationId: candidate.generationId,
      revision: candidate.revision,
      checksumSha256: candidate.checksumSha256,
    }, home))).toBe(true);
    expect(events[0]).toBe("before-revision-publication");
  });

  it("classifies head-alias cleanup failure before staging a successor", () => {
    const home = makeHome();
    const initial = manifest("head-alias-cleanup-failure");
    const store = new MigrationManifestStore({ homeDir: home });
    store.create(initial);
    const generation = migrationManifestGenerationDirectory(initial.generationId, home);
    const headPath = migrationManifestHeadPath(initial.generationId, home);
    const aliasPath = join(generation, ".head.json.0123456789abcdef01234567.tmp");
    linkSync(headPath, aliasPath);
    const candidate = beginMigrationEffect(initial, {
      effectId: "effect-head-alias-cleanup-failure",
      kind: "verify-dry-run",
      inputSha256: HASH,
      startedAt: "2026-08-12T12:00:01.000Z",
    });
    const successorDirectory = join(generation, "revisions", "0000000000000001");
    const nodeFs = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;
    const originalUnlink = nodeFs.unlinkSync as (path: string) => void;

    expectProtocolReason(() => withPatchedFs("unlinkSync", ((path: string) => {
      if (path === aliasPath) throw Object.assign(new Error("cleanup denied"), { code: "EACCES" });
      originalUnlink(path);
    }) as never, () => store.update(
      initial.generationId,
      initial.checksumSha256,
      () => candidate,
    )), "malformed-manifest");
    expect(existsSync(successorDirectory)).toBe(false);
    expect(lstatSync(headPath).nlink).toBe(2);
    expect(lstatSync(aliasPath).nlink).toBe(2);
  });

  it("consumes a post-link head alias before recovering a legal successor", () => {
    const home = makeHome();
    const initial = manifest("head-alias-successor-recovery");
    const store = new MigrationManifestStore({ homeDir: home });
    store.create(initial);
    const candidate = beginMigrationEffect(initial, {
      effectId: "effect-head-alias-successor-recovery",
      kind: "verify-dry-run",
      inputSha256: HASH,
      startedAt: "2026-08-12T12:00:01.000Z",
    });
    publishSuccessorOrphan(home, initial, candidate);
    const generation = migrationManifestGenerationDirectory(initial.generationId, home);
    const headPath = migrationManifestHeadPath(initial.generationId, home);
    const aliasPath = join(generation, ".head.json.0123456789abcdef01234567.tmp");
    linkSync(headPath, aliasPath);

    expect(store.recover(initial.generationId)).toEqual(candidate);
    expect(existsSync(aliasPath)).toBe(false);
    expect(store.read(initial.generationId)).toEqual(candidate);
  });

  it("returns an intact head unchanged and advances exactly one authenticated orphan", () => {
    const home = makeHome();
    const initial = manifest("recover-successor");
    const store = new MigrationManifestStore({ homeDir: home });
    store.create(initial);
    expect(store.recover(initial.generationId)).toEqual(initial);

    const candidate = beginMigrationEffect(initial, {
      effectId: "effect-recover",
      kind: "verify-dry-run",
      inputSha256: HASH,
      startedAt: "2026-08-12T12:00:01.000Z",
    });
    const orphanPath = publishSuccessorOrphan(home, initial, candidate);
    expectProtocolReason(() => store.read(initial.generationId), "recovery-required");

    const recoveryEvents: string[] = [];
    const recovering = new MigrationManifestStore({
      homeDir: home,
      observer: (event) => recoveryEvents.push(event),
    });
    expect(recovering.recover(initial.generationId)).toEqual(candidate);
    expect(recovering.read(initial.generationId)).toEqual(candidate);
    expect(readFileSync(orphanPath, "utf8")).toContain(candidate.checksumSha256);
    expect(recoveryEvents).toEqual([
      "before-head-capture",
      "after-head-capture",
      "before-head-link",
      "after-head-link",
      "after-head-publication",
    ]);
  });

  it("fails closed when a same-UID head replacement wins the durable rename window", () => {
    const home = makeHome();
    const initial = manifest("recover-same-uid-rename-race");
    const store = new MigrationManifestStore({ homeDir: home });
    store.create(initial);
    const candidate = beginMigrationEffect(initial, {
      effectId: "effect-recover-same-uid-rename-race",
      kind: "verify-dry-run",
      inputSha256: HASH,
      startedAt: "2026-08-12T12:00:01.000Z",
    });
    const orphanPath = publishSuccessorOrphan(home, initial, candidate);
    const orphanContent = readFileSync(orphanPath, "utf8");
    const headPath = migrationManifestHeadPath(initial.generationId, home);
    const generation = migrationManifestGenerationDirectory(initial.generationId, home);
    const headBefore = readFileSync(headPath, "utf8");
    const replacementHead = migrationManifestHeadContent(createMigrationManifestHead({
      generationId: initial.generationId,
      revision: initial.revision,
      manifestSha256: "b".repeat(64),
      updatedAt: initial.updatedAt,
    }));
    let renameWindowReached = false;
    let failure: unknown;
    const nodeFs = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;
    const originalRename = nodeFs.renameSync as typeof renameSync;
    try {
      withPatchedFs("renameSync", ((source: string, destination: string) => {
        const isLegacyReplacement = destination === headPath;
        const isSealedCapture = source === headPath
          && destination.startsWith(`${generation}/.head.json.`)
          && destination.endsWith(".capture");
        if (!renameWindowReached && (isLegacyReplacement || isSealedCapture)) {
          renameWindowReached = true;
          writeFileSync(headPath, replacementHead, { mode: 0o600 });
        }
        originalRename(source, destination);
      }) as never, () => new MigrationManifestStore({ homeDir: home }).recover(
        initial.generationId,
      ));
    } catch (error) {
      failure = error;
    }

    expect(renameWindowReached).toBe(true);
    expect(failure).toBeInstanceOf(MigrationProtocolError);
    expect((failure as MigrationProtocolError).reason).toBe("recovery-required");
    expect(readFileSync(headPath, "utf8")).toBe(replacementHead);
    expect(readFileSync(orphanPath, "utf8")).toBe(orphanContent);
    expect(readdirSync(join(generation, "revisions")).sort()).toEqual([
      "0000000000000000",
      "0000000000000001",
    ]);

    const artifacts = headPublicationArtifactPaths(home, initial.generationId);
    const candidateHead = migrationManifestHeadContent(createMigrationManifestHead({
      generationId: candidate.generationId,
      revision: candidate.revision,
      manifestSha256: candidate.checksumSha256,
      updatedAt: candidate.updatedAt,
    }));
    expect(readdirSync(generation).filter((entry) => (
      /^\.head\.json\.[0-9a-f]{24}\.(?:tmp|capture|attempt)$/u.test(entry)
    )).sort()).toHaveLength(3);
    expect(readFileSync(artifacts.tmp, "utf8")).toBe(candidateHead);
    expect(readFileSync(artifacts.capture, "utf8")).toBe(replacementHead);
    expectCanonicalHeadPublicationAttempt(artifacts.attempt, {
      generationId: candidate.generationId,
      expectedHeadRawSha256: createHash("sha256").update(headBefore, "utf8").digest("hex"),
      candidateHeadRawSha256: createHash("sha256").update(candidateHead, "utf8").digest("hex"),
      candidateManifestSha256: candidate.checksumSha256,
      candidateRevision: candidate.revision,
    });
  });

  it("rejects a checksum-valid forged successor before publishing the head", () => {
    const home = makeHome();
    const initial = manifest("recover-forged-successor");
    const store = new MigrationManifestStore({ homeDir: home });
    store.create(initial);
    const legalCandidate = beginMigrationEffect(initial, {
      effectId: "effect-forged-successor",
      kind: "verify-dry-run",
      inputSha256: HASH,
      startedAt: "2026-08-12T12:00:01.000Z",
    });
    const orphanPath = publishSuccessorOrphan(home, initial, legalCandidate);
    const forged = rewriteManifestFixture(orphanPath, {
      phase: "active",
      pendingEffect: null,
      reports: [{
        createdAt: "2026-08-12T12:00:01.000Z",
        kind: "verification",
        reportId: "forged-verification",
        reportSha256: HASH,
      }],
      activationEligible: true,
      updatedAt: "2026-08-12T12:00:01.000Z",
    });
    const forgedPath = migrationManifestRevisionPath({
      generationId: forged.generationId,
      revision: forged.revision,
      checksumSha256: forged.checksumSha256,
    }, home);
    renameSync(orphanPath, forgedPath);
    const headPath = migrationManifestHeadPath(initial.generationId, home);
    const headBefore = readFileSync(headPath, "utf8");

    expectProtocolReason(() => store.recover(initial.generationId), "unexpected-state");
    expect(readFileSync(headPath, "utf8")).toBe(headBefore);
    expect(existsSync(forgedPath)).toBe(true);
    expectProtocolReason(() => store.read(initial.generationId), "recovery-required");
  });

  it("returns the current head for empty and scratch-only successors and lets update retry", () => {
    for (const state of ["empty", "scratch-only"] as const) {
      const home = makeHome();
      const initial = manifest(`recover-incomplete-${state}`);
      const store = new MigrationManifestStore({ homeDir: home });
      store.create(initial);
      const candidate = beginMigrationEffect(initial, {
        effectId: `effect-incomplete-${state}`,
        kind: "verify-dry-run",
        inputSha256: HASH,
        startedAt: "2026-08-12T12:00:01.000Z",
      });
      const successorDirectory = join(
        migrationManifestGenerationDirectory(initial.generationId, home),
        "revisions",
        "0000000000000001",
      );
      mkdirSync(successorDirectory, { mode: 0o700 });
      const scratch = `.${candidate.checksumSha256}.json.${"a".repeat(24)}.tmp`;
      if (state === "scratch-only") {
        writeFileSync(join(successorDirectory, scratch), `${canonicalFixture(candidate)}\n`, { mode: 0o600 });
      }
      const headPath = migrationManifestHeadPath(initial.generationId, home);
      const headBefore = readFileSync(headPath, "utf8");

      expectProtocolReason(() => store.read(initial.generationId), "recovery-required");
      expect(store.recover(initial.generationId)).toEqual(initial);
      expect(readFileSync(headPath, "utf8")).toBe(headBefore);
      expect(readdirSync(successorDirectory)).toEqual(state === "empty" ? [] : [scratch]);
      expect(store.update(initial.generationId, initial.checksumSha256, () => candidate)).toEqual(candidate);
      expect(store.read(initial.generationId)).toEqual(candidate);
    }
  });

  it("does not consume an incomplete revision scratch during recover", () => {
    const home = makeHome();
    const initial = manifest("recover-incomplete-scratch-no-consume");
    const store = new MigrationManifestStore({ homeDir: home });
    store.create(initial);
    const candidate = beginMigrationEffect(initial, {
      effectId: "effect-incomplete-scratch-no-consume",
      kind: "verify-dry-run",
      inputSha256: HASH,
      startedAt: "2026-08-12T12:00:01.000Z",
    });
    const successorDirectory = resolve(migrationManifestRevisionPath({
      generationId: candidate.generationId,
      revision: candidate.revision,
      checksumSha256: candidate.checksumSha256,
    }, home), "..");
    mkdirSync(successorDirectory, { mode: 0o700 });
    const scratch = `.${candidate.checksumSha256}.json.${"f".repeat(24)}.tmp`;
    const scratchContent = `${canonicalFixture(candidate)}\n`.slice(0, -1);
    writeFileSync(join(successorDirectory, scratch), scratchContent, { mode: 0o600 });
    const headPath = migrationManifestHeadPath(initial.generationId, home);
    const headBefore = readFileSync(headPath, "utf8");

    expect(store.recover(initial.generationId)).toEqual(initial);
    expect(readFileSync(headPath, "utf8")).toBe(headBefore);
    expect(readdirSync(successorDirectory)).toEqual([scratch]);
    expect(readFileSync(join(successorDirectory, scratch), "utf8")).toBe(scratchContent);
  });

  it("refuses an unknown scratch-only recovery entry without changing the head", () => {
    const home = makeHome();
    const initial = manifest("recover-unknown-scratch");
    const store = new MigrationManifestStore({ homeDir: home });
    store.create(initial);
    const successorDirectory = join(
      migrationManifestGenerationDirectory(initial.generationId, home),
      "revisions",
      "0000000000000001",
    );
    mkdirSync(successorDirectory, { mode: 0o700 });
    writeFileSync(join(successorDirectory, "unknown.tmp"), "scratch", { mode: 0o600 });
    const headPath = migrationManifestHeadPath(initial.generationId, home);
    const headBefore = readFileSync(headPath, "utf8");

    expectProtocolReason(() => store.recover(initial.generationId), "malformed-manifest");
    expect(readFileSync(headPath, "utf8")).toBe(headBefore);
  });

  it("recovers a create head left in the post-link pre-unlink window", () => {
    const home = makeHome();
    const initial = manifest("create-head-post-link");
    const generation = migrationManifestGenerationDirectory(initial.generationId, home);
    const headPath = migrationManifestHeadPath(initial.generationId, home);
    const nodeFs = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;
    const originalUnlink = nodeFs.unlinkSync as (path: string) => void;
    expect(() => withPatchedFs("unlinkSync", ((path: string) => {
      if (path.startsWith(`${generation}/.head.json.`) && path.endsWith(".tmp")) {
        throw Object.assign(new Error("crash:after-head-link-create"), { code: "EACCES" });
      }
      originalUnlink(path);
    }) as never, () => new MigrationManifestStore({ homeDir: home }).create(initial)))
      .toThrow("crash:after-head-link-create");

    const entries = readdirSync(generation);
    const scratch = entries.find((entry) => /^\.head\.json\.[0-9a-f]{24}\.tmp$/u.test(entry));
    expect(scratch).toBeDefined();
    const scratchPath = join(generation, scratch!);
    const headStat = lstatSync(headPath);
    const scratchStat = lstatSync(scratchPath);
    expect(headStat.isFile()).toBe(true);
    expect(scratchStat.isFile()).toBe(true);
    expect(headStat.nlink).toBe(2);
    expect(scratchStat.nlink).toBe(2);
    expect(scratchStat.dev).toBe(headStat.dev);
    expect(scratchStat.ino).toBe(headStat.ino);
    const evidenceBefore = readdirSync(generation).sort();

    const store = new MigrationManifestStore({ homeDir: home });
    expect(store.read(initial.generationId)).toEqual(initial);
    expect(store.recover(initial.generationId)).toEqual(initial);
    expectProtocolReason(() => store.create(initial), "unexpected-state");
    expect(readdirSync(generation).sort()).toEqual(evidenceBefore);
    expect(readFileSync(headPath, "utf8")).toBe(readFileSync(scratchPath, "utf8"));
  });

  it("recovers a headless recovery head left in the post-link pre-unlink window", () => {
    const home = makeHome();
    const initial = manifest("headless-recover-head-post-link");
    const crashing = new MigrationManifestStore({
      homeDir: home,
      observer: (event) => {
        if (event === "after-revision-publication") throw new Error("crash:headless-before-head");
      },
    });
    expect(() => crashing.create(initial)).toThrow("crash:headless-before-head");

    const generation = migrationManifestGenerationDirectory(initial.generationId, home);
    const headPath = migrationManifestHeadPath(initial.generationId, home);
    const nodeFs = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;
    const originalUnlink = nodeFs.unlinkSync as (path: string) => void;
    expect(() => withPatchedFs("unlinkSync", ((path: string) => {
      if (path.startsWith(`${generation}/.head.json.`) && path.endsWith(".tmp")) {
        throw Object.assign(new Error("crash:after-head-link-recover"), { code: "EACCES" });
      }
      originalUnlink(path);
    }) as never, () => new MigrationManifestStore({ homeDir: home }).recover(initial.generationId)))
      .toThrow("crash:after-head-link-recover");

    const scratch = readdirSync(generation)
      .find((entry) => /^\.head\.json\.[0-9a-f]{24}\.tmp$/u.test(entry));
    expect(scratch).toBeDefined();
    const scratchPath = join(generation, scratch!);
    expect(lstatSync(headPath).nlink).toBe(2);
    expect(lstatSync(scratchPath).nlink).toBe(2);
    const evidenceBefore = readdirSync(generation).sort();

    const store = new MigrationManifestStore({ homeDir: home });
    expect(store.read(initial.generationId)).toEqual(initial);
    expect(store.recover(initial.generationId)).toEqual(initial);
    expectProtocolReason(() => store.create(initial), "unexpected-state");
    expect(readdirSync(generation).sort()).toEqual(evidenceBefore);
    expect(readFileSync(headPath, "utf8")).toBe(readFileSync(scratchPath, "utf8"));
  });

  it("consumes a durable pre-rename head temp before update reports recovery-required", () => {
    const home = makeHome();
    const initial = manifest("head-pre-rename-update");
    const store = new MigrationManifestStore({ homeDir: home });
    store.create(initial);
    const candidate = beginMigrationEffect(initial, {
      effectId: "effect-head-pre-rename-update",
      kind: "verify-dry-run",
      inputSha256: HASH,
      startedAt: "2026-08-12T12:00:01.000Z",
    });
    publishSuccessorOrphan(home, initial, candidate);
    const generation = migrationManifestGenerationDirectory(initial.generationId, home);
    const scratchPath = join(generation, `.head.json.${"a".repeat(24)}.tmp`);
    writeFileSync(scratchPath, migrationManifestHeadContent(createMigrationManifestHead({
      generationId: candidate.generationId,
      revision: candidate.revision,
      manifestSha256: candidate.checksumSha256,
      updatedAt: candidate.updatedAt,
    })), { mode: 0o600 });

    expectProtocolReason(() => store.read(initial.generationId), "recovery-required");
    expect(existsSync(scratchPath)).toBe(true);

    const updating = new MigrationManifestStore({
      homeDir: home,
      observer: (event) => {
        if (event === "before-revision-publication") {
          expect(existsSync(scratchPath)).toBe(false);
        }
      },
    });
    expectProtocolReason(
      () => updating.update(initial.generationId, initial.checksumSha256, () => candidate),
      "recovery-required",
    );
    expect(updating.recover(initial.generationId)).toEqual(candidate);
    expect(updating.read(initial.generationId)).toEqual(candidate);
    expect(existsSync(scratchPath)).toBe(false);
  });

  it("recovers a headless genesis through a durable pre-link head temp", () => {
    const home = makeHome();
    const initial = manifest("head-pre-link-genesis-recovery");
    const crashing = new MigrationManifestStore({
      homeDir: home,
      observer: (event) => {
        if (event === "after-revision-publication") throw new Error("crash:head-pre-link-genesis");
      },
    });
    expect(() => crashing.create(initial)).toThrow("crash:head-pre-link-genesis");
    const generation = migrationManifestGenerationDirectory(initial.generationId, home);
    const scratchPath = join(generation, `.head.json.${"b".repeat(24)}.tmp`);
    writeFileSync(scratchPath, migrationManifestHeadContent(createMigrationManifestHead({
      generationId: initial.generationId,
      revision: initial.revision,
      manifestSha256: initial.checksumSha256,
      updatedAt: initial.updatedAt,
    })), { mode: 0o600 });

    const store = new MigrationManifestStore({ homeDir: home });
    expect(store.recover(initial.generationId)).toEqual(initial);
    expect(store.read(initial.generationId)).toEqual(initial);
    expect(existsSync(scratchPath)).toBe(false);
  });

  it("consumes a durable pre-link head temp before an exact create retry", () => {
    const home = makeHome();
    const initial = manifest("head-pre-link-create-retry");
    const crashing = new MigrationManifestStore({
      homeDir: home,
      observer: (event) => {
        if (event === "after-revision-publication") throw new Error("crash:head-pre-link-create-retry");
      },
    });
    expect(() => crashing.create(initial)).toThrow("crash:head-pre-link-create-retry");
    const generation = migrationManifestGenerationDirectory(initial.generationId, home);
    const scratchPath = join(generation, `.head.json.${"d".repeat(24)}.tmp`);
    writeFileSync(scratchPath, migrationManifestHeadContent(createMigrationManifestHead({
      generationId: initial.generationId,
      revision: initial.revision,
      manifestSha256: initial.checksumSha256,
      updatedAt: initial.updatedAt,
    })), { mode: 0o600 });

    expectProtocolReason(
      () => new MigrationManifestStore({ homeDir: home }).create(initial),
      "recovery-required",
    );
    expect(existsSync(scratchPath)).toBe(false);
    const store = new MigrationManifestStore({ homeDir: home });
    expect(store.recover(initial.generationId)).toEqual(initial);
    expect(store.read(initial.generationId)).toEqual(initial);
  });

  it("consumes a pre-rename head temp before reporting and recovering a published successor", () => {
    const home = makeHome();
    const initial = manifest("head-pre-rename-successor-recovery");
    const store = new MigrationManifestStore({ homeDir: home });
    store.create(initial);
    const candidate = beginMigrationEffect(initial, {
      effectId: "effect-head-pre-rename-successor-recovery",
      kind: "verify-dry-run",
      inputSha256: HASH,
      startedAt: "2026-08-12T12:00:01.000Z",
    });
    publishSuccessorOrphan(home, initial, candidate);
    const generation = migrationManifestGenerationDirectory(initial.generationId, home);
    const scratchPath = join(generation, `.head.json.${"c".repeat(24)}.tmp`);
    writeFileSync(scratchPath, migrationManifestHeadContent(createMigrationManifestHead({
      generationId: candidate.generationId,
      revision: candidate.revision,
      manifestSha256: candidate.checksumSha256,
      updatedAt: candidate.updatedAt,
    })), { mode: 0o600 });

    expectProtocolReason(
      () => store.update(initial.generationId, initial.checksumSha256, () => candidate),
      "recovery-required",
    );
    expect(existsSync(scratchPath)).toBe(false);
    expect(store.recover(initial.generationId)).toEqual(candidate);
    expect(store.read(initial.generationId)).toEqual(candidate);
  });

  it("rejects unauthenticated single-link head writer temps without consuming them", () => {
    for (const state of ["malformed", "wrong-generation", "missing-successor"] as const) {
      const home = makeHome();
      const initial = manifest(`head-temp-${state}`);
      const store = new MigrationManifestStore({ homeDir: home });
      store.create(initial);
      const generation = migrationManifestGenerationDirectory(initial.generationId, home);
      const scratchPath = join(generation, `.head.json.${"e".repeat(24)}.tmp`);
      const scratchContent = state === "malformed"
        ? "not-a-head\n"
        : migrationManifestHeadContent(createMigrationManifestHead({
          generationId: state === "wrong-generation"
            ? "different-generation"
            : initial.generationId,
          revision: 1,
          manifestSha256: HASH,
          updatedAt: "2026-08-12T12:00:01.000Z",
        }));
      writeFileSync(scratchPath, scratchContent, { mode: 0o600 });

      expectProtocolReason(() => store.read(initial.generationId), "malformed-manifest");
      expect(readFileSync(scratchPath, "utf8")).toBe(scratchContent);
    }
  });

  it("preserves a valid head temp that does not match the published successor", () => {
    const home = makeHome();
    const initial = manifest("head-temp-wrong-candidate");
    const store = new MigrationManifestStore({ homeDir: home });
    store.create(initial);
    const retainedCandidate = beginMigrationEffect(initial, {
      effectId: "effect-retained-head-temp",
      kind: "verify-dry-run",
      inputSha256: HASH,
      startedAt: "2026-08-12T12:00:01.000Z",
    });
    const requestedCandidate = beginMigrationEffect(initial, {
      effectId: "effect-requested-head-temp",
      kind: "verify-dry-run",
      inputSha256: HASH,
      startedAt: "2026-08-12T12:00:02.000Z",
    });
    publishSuccessorOrphan(home, initial, requestedCandidate);
    const generation = migrationManifestGenerationDirectory(initial.generationId, home);
    const scratchPath = join(generation, `.head.json.${"f".repeat(24)}.tmp`);
    const scratchContent = migrationManifestHeadContent(createMigrationManifestHead({
      generationId: retainedCandidate.generationId,
      revision: retainedCandidate.revision,
      manifestSha256: retainedCandidate.checksumSha256,
      updatedAt: retainedCandidate.updatedAt,
    }));
    writeFileSync(scratchPath, scratchContent, { mode: 0o600 });

    expectProtocolReason(
      () => store.update(initial.generationId, initial.checksumSha256, () => requestedCandidate),
      "malformed-manifest",
    );
    expect(readFileSync(scratchPath, "utf8")).toBe(scratchContent);
    expect(existsSync(migrationManifestRevisionPath({
      generationId: requestedCandidate.generationId,
      revision: requestedCandidate.revision,
      checksumSha256: requestedCandidate.checksumSha256,
    }, home))).toBe(true);
  });

  it("preserves a head temp when a retry requests a different successor", () => {
    const home = makeHome();
    const initial = manifest("head-temp-different-retry");
    const store = new MigrationManifestStore({ homeDir: home });
    store.create(initial);
    const publishedCandidate = beginMigrationEffect(initial, {
      effectId: "effect-published-head-temp",
      kind: "verify-dry-run",
      inputSha256: HASH,
      startedAt: "2026-08-12T12:00:01.000Z",
    });
    publishSuccessorOrphan(home, initial, publishedCandidate);
    const requestedCandidate = beginMigrationEffect(initial, {
      effectId: "effect-different-retry",
      kind: "verify-dry-run",
      inputSha256: HASH,
      startedAt: "2026-08-12T12:00:02.000Z",
    });
    const generation = migrationManifestGenerationDirectory(initial.generationId, home);
    const scratchPath = join(generation, `.head.json.${"0".repeat(24)}.tmp`);
    const scratchContent = migrationManifestHeadContent(createMigrationManifestHead({
      generationId: publishedCandidate.generationId,
      revision: publishedCandidate.revision,
      manifestSha256: publishedCandidate.checksumSha256,
      updatedAt: publishedCandidate.updatedAt,
    }));
    writeFileSync(scratchPath, scratchContent, { mode: 0o600 });

    expectProtocolReason(
      () => store.update(initial.generationId, initial.checksumSha256, () => requestedCandidate),
      "malformed-manifest",
    );
    expect(readFileSync(scratchPath, "utf8")).toBe(scratchContent);
    expect(store.recover(initial.generationId)).toEqual(publishedCandidate);
  });

  it("preserves an exact head temp when identity consumption fails", () => {
    const home = makeHome();
    const initial = manifest("head-temp-consume-failure");
    const store = new MigrationManifestStore({ homeDir: home });
    store.create(initial);
    const candidate = beginMigrationEffect(initial, {
      effectId: "effect-head-temp-consume-failure",
      kind: "verify-dry-run",
      inputSha256: HASH,
      startedAt: "2026-08-12T12:00:01.000Z",
    });
    publishSuccessorOrphan(home, initial, candidate);
    const generation = migrationManifestGenerationDirectory(initial.generationId, home);
    const scratchPath = join(generation, `.head.json.${"1".repeat(24)}.tmp`);
    writeFileSync(scratchPath, migrationManifestHeadContent(createMigrationManifestHead({
      generationId: candidate.generationId,
      revision: candidate.revision,
      manifestSha256: candidate.checksumSha256,
      updatedAt: candidate.updatedAt,
    })), { mode: 0o600 });
    const nodeFs = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;
    const originalUnlink = nodeFs.unlinkSync as (path: string) => void;

    expectProtocolReason(() => withPatchedFs("unlinkSync", ((path: string) => {
      if (path === scratchPath) throw Object.assign(new Error("head temp cleanup denied"), { code: "EACCES" });
      originalUnlink(path);
    }) as never, () => store.recover(initial.generationId)), "malformed-manifest");
    expect(existsSync(scratchPath)).toBe(true);
    expect(readFileSync(migrationManifestHeadPath(initial.generationId, home), "utf8"))
      .toContain(initial.checksumSha256);
  });

  it("rejects a headless temp without a complete immutable genesis revision", () => {
    const home = makeHome();
    const initial = manifest("head-temp-missing-genesis");
    const generation = migrationManifestGenerationDirectory(initial.generationId, home);
    mkdirSync(join(generation, "revisions"), { recursive: true, mode: 0o700 });
    const scratchPath = join(generation, `.head.json.${"2".repeat(24)}.tmp`);
    const scratchContent = migrationManifestHeadContent(createMigrationManifestHead({
      generationId: initial.generationId,
      revision: initial.revision,
      manifestSha256: initial.checksumSha256,
      updatedAt: initial.updatedAt,
    }));
    writeFileSync(scratchPath, scratchContent, { mode: 0o600 });

    expectProtocolReason(
      () => new MigrationManifestStore({ homeDir: home }).recover(initial.generationId),
      "malformed-manifest",
    );
    expect(readFileSync(scratchPath, "utf8")).toBe(scratchContent);
  });

  it("preserves an exact headless temp when create retries a different genesis", () => {
    const home = makeHome();
    const initial = manifest("head-temp-different-genesis");
    const crashing = new MigrationManifestStore({
      homeDir: home,
      observer: (event) => {
        if (event === "after-revision-publication") throw new Error("crash:head-temp-different-genesis");
      },
    });
    expect(() => crashing.create(initial)).toThrow("crash:head-temp-different-genesis");
    const generation = migrationManifestGenerationDirectory(initial.generationId, home);
    const scratchPath = join(generation, `.head.json.${"3".repeat(24)}.tmp`);
    const scratchContent = migrationManifestHeadContent(createMigrationManifestHead({
      generationId: initial.generationId,
      revision: initial.revision,
      manifestSha256: initial.checksumSha256,
      updatedAt: initial.updatedAt,
    }));
    writeFileSync(scratchPath, scratchContent, { mode: 0o600 });
    const different = resealManifest(initial, {
      destination: {
        ...initial.destination,
        contentSha256: "7".repeat(64),
      },
    });

    expectProtocolReason(
      () => new MigrationManifestStore({ homeDir: home }).create(different),
      "malformed-manifest",
    );
    expect(readFileSync(scratchPath, "utf8")).toBe(scratchContent);
  });

  it("rejects invalid head topology for reads, recovery, and duplicate create", () => {
    const scenarios = [
      "unknown-entry",
      "extra-scratch",
      "mixed-link-pair",
      "nlink-three",
      "symlink",
    ] as const;
    for (const scenario of scenarios) {
      const home = makeHome();
      const initial = manifest(`invalid-head-${scenario}`);
      const store = new MigrationManifestStore({ homeDir: home });
      store.create(initial);
      const generation = migrationManifestGenerationDirectory(initial.generationId, home);
      const headPath = migrationManifestHeadPath(initial.generationId, home);
      const headContent = readFileSync(headPath, "utf8");
      const scratchPath = join(generation, `.head.json.${"f".repeat(24)}.tmp`);
      if (scenario === "unknown-entry") {
        writeFileSync(join(generation, "unknown.tmp"), headContent, { mode: 0o600 });
      } else if (scenario === "extra-scratch") {
        writeFileSync(scratchPath, headContent, { mode: 0o600 });
        writeFileSync(join(generation, `.head.json.${"e".repeat(24)}.tmp`), headContent, { mode: 0o600 });
      } else if (scenario === "mixed-link-pair") {
        linkSync(headPath, join(home, "head-hard-link-one"));
        writeFileSync(scratchPath, headContent, { mode: 0o600 });
      } else if (scenario === "nlink-three") {
        linkSync(headPath, join(home, "head-hard-link-one"));
        linkSync(headPath, join(home, "head-hard-link-two"));
      } else {
        const target = join(home, "head-symlink-target");
        renameSync(headPath, target);
        symlinkSync(target, headPath);
      }

      expectProtocolReason(() => store.read(initial.generationId), "malformed-manifest");
      expectProtocolReason(() => store.recover(initial.generationId), "malformed-manifest");
      expectProtocolReason(() => new MigrationManifestStore({ homeDir: home }).create(initial), "malformed-manifest");
    }
  });

  it("rejects multiple head scratch names during duplicate-create preflight", () => {
    const home = makeHome();
    const initial = manifest("multiple-head-scratch-preflight");
    const store = new MigrationManifestStore({ homeDir: home });
    store.create(initial);
    const generation = migrationManifestGenerationDirectory(initial.generationId, home);
    renameSync(join(generation, "revisions"), join(home, "retained-revisions"));
    const headContent = readFileSync(migrationManifestHeadPath(initial.generationId, home), "utf8");
    for (const suffix of ["d", "e"]) {
      writeFileSync(
        join(generation, `.head.json.${suffix.repeat(24)}.tmp`),
        headContent,
        { mode: 0o600 },
      );
    }

    expectProtocolReason(() => store.create(initial), "malformed-manifest");
  });

  it("rejects a checksum-valid non-genesis revision zero before creating a head", () => {
    const home = makeHome();
    const initial = manifest("recover-forged-genesis");
    const crashing = new MigrationManifestStore({
      homeDir: home,
      observer: (event) => {
        if (event === "after-revision-publication") throw new Error("crash:forged-genesis");
      },
    });
    expect(() => crashing.create(initial)).toThrow("crash:forged-genesis");
    const initialPath = migrationManifestRevisionPath({
      generationId: initial.generationId,
      revision: initial.revision,
      checksumSha256: initial.checksumSha256,
    }, home);
    const forged = rewriteManifestFixture(initialPath, {
      phase: "active",
      reports: [{
        createdAt: "2026-08-12T12:00:01.000Z",
        kind: "verification",
        reportId: "forged-genesis-verification",
        reportSha256: HASH,
      }],
      activationEligible: true,
      updatedAt: "2026-08-12T12:00:01.000Z",
    });
    const forgedPath = migrationManifestRevisionPath({
      generationId: forged.generationId,
      revision: forged.revision,
      checksumSha256: forged.checksumSha256,
    }, home);
    renameSync(initialPath, forgedPath);

    expectProtocolReason(() => new MigrationManifestStore({ homeDir: home }).recover(
      initial.generationId,
    ), "unexpected-state");
    expect(existsSync(migrationManifestHeadPath(initial.generationId, home))).toBe(false);
    expect(existsSync(forgedPath)).toBe(true);
  });

  it("rejects headless empty and scratch-only revision zero recovery while create retry converges", () => {
    for (const state of ["empty", "scratch-only"] as const) {
      const home = makeHome();
      const initial = manifest(`recover-headless-incomplete-${state}`);
      const crashing = new MigrationManifestStore({
        homeDir: home,
        observer: (event) => {
          if (event === "before-revision-content-publication") throw new Error(`crash:${state}`);
        },
      });
      expect(() => crashing.create(initial)).toThrow(`crash:${state}`);
      const revisionDirectory = join(
        migrationManifestGenerationDirectory(initial.generationId, home),
        "revisions",
        "0000000000000000",
      );
      const scratch = `.${initial.checksumSha256}.json.${"b".repeat(24)}.tmp`;
      if (state === "scratch-only") {
        writeFileSync(join(revisionDirectory, scratch), `${canonicalFixture(initial)}\n`, { mode: 0o600 });
      }

      expectProtocolReason(() => new MigrationManifestStore({ homeDir: home }).recover(
        initial.generationId,
      ), "unexpected-state");
      expect(existsSync(migrationManifestHeadPath(initial.generationId, home))).toBe(false);
      expect(new MigrationManifestStore({ homeDir: home }).create(initial)).toEqual(initial);
      expect(new MigrationManifestStore({ homeDir: home }).read(initial.generationId)).toEqual(initial);
    }
  });

  it("rejects forged revision-zero genesis states before observer or path mutation", () => {
    const candidates = [
      ["active", (value: MigrationManifest) => resealManifest(value, {
        phase: "active",
        reports: [{
          createdAt: UPDATED_AT,
          kind: "verification",
          reportId: "forged-create-active-verification",
          reportSha256: HASH,
        }],
        activationEligible: true,
      })],
      ["aborted", (value: MigrationManifest) => resealManifest(value, { phase: "aborted" })],
      ["pending", (value: MigrationManifest) => resealManifest(value, {
        pendingEffect: {
          effectId: "forged-genesis-effect",
          kind: "verify-dry-run",
          fromPhase: "planned",
          targetPhase: "dry-run-verified",
          inputSha256: HASH,
          recovery: "retry-idempotent",
          startedAt: UPDATED_AT,
        },
      })],
      ["timestamp-skew", (value: MigrationManifest) => resealManifest(value, {
        updatedAt: "2026-08-12T12:00:01.000Z",
      })],
    ] as const;
    for (const [label, makeCandidate] of candidates) {
      const home = makeHome();
      const initial = manifest(`forged-create-genesis-${label}`);
      const candidate = makeCandidate(initial);
      const observed: string[] = [];
      expectProtocolReason(() => new MigrationManifestStore({
        homeDir: home,
        observer: (event) => observed.push(event),
      }).create(candidate), "unexpected-state");
      expect(observed).toEqual([]);
      expect(existsSync(join(home, ".lcm", "migrations"))).toBe(false);
    }
  });

  it("recovers one headless genesis revision but refuses ambiguous genesis evidence", () => {
    const home = makeHome();
    const initial = manifest("recover-genesis");
    const crashing = new MigrationManifestStore({
      homeDir: home,
      observer: (event) => {
        if (event === "after-revision-publication") throw new Error("crash:genesis");
      },
    });
    expect(() => crashing.create(initial)).toThrow("crash:genesis");
    expect(existsSync(migrationManifestHeadPath(initial.generationId, home))).toBe(false);
    const store = new MigrationManifestStore({ homeDir: home });
    expect(store.recover(initial.generationId)).toEqual(initial);
    expect(store.read(initial.generationId)).toEqual(initial);

    const ambiguousHome = makeHome();
    const ambiguous = manifest("ambiguous-genesis");
    const ambiguousCrash = new MigrationManifestStore({
      homeDir: ambiguousHome,
      observer: (event) => {
        if (event === "after-revision-publication") throw new Error("crash:ambiguous-genesis");
      },
    });
    expect(() => ambiguousCrash.create(ambiguous)).toThrow("crash:ambiguous-genesis");
    const firstPath = migrationManifestRevisionPath({
      generationId: ambiguous.generationId,
      revision: 0,
      checksumSha256: ambiguous.checksumSha256,
    }, ambiguousHome);
    const secondPath = join(resolve(firstPath, ".."), `${"b".repeat(64)}.json`);
    writeFileSync(secondPath, readFileSync(firstPath), { mode: 0o600 });
    expectProtocolReason(
      () => new MigrationManifestStore({ homeDir: ambiguousHome }).recover(ambiguous.generationId),
      "malformed-manifest",
    );
    expect(existsSync(firstPath)).toBe(true);
    expect(existsSync(secondPath)).toBe(true);
    expect(existsSync(migrationManifestHeadPath(ambiguous.generationId, ambiguousHome))).toBe(false);
  });

  it("refuses absent genesis evidence and preserves non-ENOENT probe failures", () => {
    const missingHome = makeHome();
    const missing = manifest("missing-genesis");
    const missingCrash = new MigrationManifestStore({
      homeDir: missingHome,
      observer: (event, path) => {
        if (event === "before-revision-publication") {
          const generation = resolve(path, "../../..");
          mkdirSync(generation, { mode: 0o700 });
          mkdirSync(join(generation, "revisions"), { mode: 0o700 });
          throw new Error("crash:before-genesis");
        }
      },
    });
    expect(() => missingCrash.create(missing)).toThrow("crash:before-genesis");
    expectProtocolReason(() => new MigrationManifestStore({ homeDir: missingHome }).recover(
      missing.generationId,
    ), "unexpected-state");
    expectProtocolReason(() => new MigrationManifestStore({ homeDir: missingHome }).read(
      missing.generationId,
    ), "unexpected-state");
    expectProtocolReason(() => new MigrationManifestStore({ homeDir: missingHome }).update(
      missing.generationId,
      missing.checksumSha256,
      () => missing,
    ), "unexpected-state");

    const headProbeHome = makeHome();
    const headProbeInitial = manifest("head-probe-error");
    const headProbeStore = new MigrationManifestStore({ homeDir: headProbeHome });
    headProbeStore.create(headProbeInitial);
    const headPath = migrationManifestHeadPath(headProbeInitial.generationId, headProbeHome);
    const realOpen = createRequire(import.meta.url)("node:fs").openSync as typeof import("node:fs").openSync;
    expectProtocolReason(() => withPatchedFs("openSync", ((path: string, flags: number, mode?: number) => {
      if (path === headPath) throw Object.assign(new Error("head probe denied"), { code: "EACCES" });
      return realOpen(path, flags, mode);
    }) as never, () => headProbeStore.recover(headProbeInitial.generationId)), "malformed-manifest");

    const probeHome = makeHome();
    const initial = manifest("recovery-probe-error");
    const store = new MigrationManifestStore({ homeDir: probeHome });
    store.create(initial);
    const successor = join(
      migrationManifestGenerationDirectory(initial.generationId, probeHome),
      "revisions",
      "0000000000000001",
    );
    const realLstat = createRequire(import.meta.url)("node:fs").lstatSync as typeof lstatSync;
    expect(() => withPatchedFs("lstatSync", ((path: string, options?: unknown) => {
      if (path === successor) throw Object.assign(new Error("recovery probe denied"), { code: "EACCES" });
      return realLstat(path, options as never);
    }) as never, () => store.recover(initial.generationId))).toThrow("recovery probe denied");
  });

  it("refuses recovery candidate identity drift and second-hop probe failures", () => {
    const driftHome = makeHome();
    const driftInitial = manifest("recovery-identity-drift");
    const driftStore = new MigrationManifestStore({ homeDir: driftHome });
    driftStore.create(driftInitial);
    const driftCandidate = beginMigrationEffect(driftInitial, {
      effectId: "effect-drift",
      kind: "verify-dry-run",
      inputSha256: HASH,
      startedAt: "2026-08-12T12:00:01.000Z",
    });
    const driftPath = publishSuccessorOrphan(driftHome, driftInitial, driftCandidate);
    const wrongName = join(resolve(driftPath, ".."), `${"b".repeat(64)}.json`);
    renameSync(driftPath, wrongName);
    expectProtocolReason(() => driftStore.recover(driftInitial.generationId), "malformed-manifest");

    const probeHome = makeHome();
    const probeInitial = manifest("second-hop-probe-error");
    const probeStore = new MigrationManifestStore({ homeDir: probeHome });
    probeStore.create(probeInitial);
    const probeCandidate = beginMigrationEffect(probeInitial, {
      effectId: "effect-probe",
      kind: "verify-dry-run",
      inputSha256: HASH,
      startedAt: "2026-08-12T12:00:01.000Z",
    });
    publishSuccessorOrphan(probeHome, probeInitial, probeCandidate);
    const secondHop = join(
      migrationManifestGenerationDirectory(probeInitial.generationId, probeHome),
      "revisions",
      "0000000000000002",
    );
    const realLstat = createRequire(import.meta.url)("node:fs").lstatSync as typeof lstatSync;
    expect(() => withPatchedFs("lstatSync", ((path: string, options?: unknown) => {
      if (path === secondHop) throw Object.assign(new Error("second hop probe denied"), { code: "EACCES" });
      return realLstat(path, options as never);
    }) as never, () => probeStore.recover(probeInitial.generationId))).toThrow("second hop probe denied");
  });

  it("keeps a maximum-safe head unchanged and rejects max-safe orphan second hops", () => {
    const completeHome = makeHome();
    const completeInitial = manifest("recover-maximum-head");
    const completeStore = new MigrationManifestStore({ homeDir: completeHome });
    completeStore.create(completeInitial);
    const maximum = replaceWithMaximumRevision(completeHome, completeInitial);
    expect(completeStore.recover(maximum.generationId)).toEqual(maximum);

    const orphanHome = makeHome();
    const orphanInitial = manifest("recover-maximum-orphan");
    const orphanStore = new MigrationManifestStore({ homeDir: orphanHome });
    orphanStore.create(orphanInitial);
    const predecessor = replaceWithRevision(orphanHome, orphanInitial, Number.MAX_SAFE_INTEGER - 1);
    const maximumOrphan = resealManifest(predecessor, {
      revision: Number.MAX_SAFE_INTEGER,
      previousManifestSha256: predecessor.checksumSha256,
    });
    const predecessorPath = migrationManifestRevisionPath({
      generationId: predecessor.generationId,
      revision: predecessor.revision,
      checksumSha256: predecessor.checksumSha256,
    }, orphanHome);
    const maximumDirectory = join(
      migrationManifestGenerationDirectory(predecessor.generationId, orphanHome),
      "revisions",
      "9007199254740991",
    );
    mkdirSync(maximumDirectory, { mode: 0o700 });
    const maximumContent = readFileSync(predecessorPath, "utf8")
      .replace(predecessor.checksumSha256, maximumOrphan.checksumSha256)
      .replace(`"previousManifestSha256":"${predecessor.previousManifestSha256}"`, `"previousManifestSha256":"${predecessor.checksumSha256}"`)
      .replace(`"revision":${predecessor.revision}`, `"revision":${Number.MAX_SAFE_INTEGER}`);
    writeFileSync(
      join(maximumDirectory, `${maximumOrphan.checksumSha256}.json`),
      maximumContent,
      { mode: 0o600 },
    );
    expectProtocolReason(() => orphanStore.recover(predecessor.generationId), "unexpected-state");
    expect(readFileSync(migrationManifestHeadPath(predecessor.generationId, orphanHome), "utf8"))
      .toContain(predecessor.checksumSha256);
  });

  it("refuses unsafe orphan files and directories without replacing the trusted head", () => {
    for (const scenario of ["directory-mode", "file-mode", "hard-link", "symlink"] as const) {
      const home = makeHome();
      const initial = manifest(`recover-unsafe-${scenario}`);
      const store = new MigrationManifestStore({ homeDir: home });
      store.create(initial);
      const candidate = beginMigrationEffect(initial, {
        effectId: `effect-unsafe-${scenario}`,
        kind: "verify-dry-run",
        inputSha256: HASH,
        startedAt: "2026-08-12T12:00:01.000Z",
      });
      const orphanPath = publishSuccessorOrphan(home, initial, candidate);
      if (scenario === "directory-mode") {
        chmodSync(resolve(orphanPath, ".."), 0o755);
      } else if (scenario === "file-mode") {
        chmodSync(orphanPath, 0o644);
      } else if (scenario === "hard-link") {
        linkSync(orphanPath, join(home, `orphan-hard-link-${scenario}`));
      } else {
        const target = join(home, "orphan-symlink-target");
        renameSync(orphanPath, target);
        symlinkSync(target, orphanPath);
      }
      expect(() => store.recover(initial.generationId)).toThrow();
      expect(readFileSync(migrationManifestHeadPath(initial.generationId, home), "utf8"))
        .toContain(initial.checksumSha256);
    }
  });

  it("converges at both recovery head boundaries and loses exact head races without erasing evidence", () => {
    for (const crashEvent of ["before-head-capture", "after-head-publication"] as const) {
      const home = makeHome();
      const initial = manifest(`recover-crash-${crashEvent}`);
      const store = new MigrationManifestStore({ homeDir: home });
      store.create(initial);
      const candidate = beginMigrationEffect(initial, {
        effectId: `effect-${crashEvent}`,
        kind: "verify-dry-run",
        inputSha256: HASH,
        startedAt: "2026-08-12T12:00:01.000Z",
      });
      const orphanPath = publishSuccessorOrphan(home, initial, candidate);
      const crashing = new MigrationManifestStore({
        homeDir: home,
        observer: (event) => {
          if (event === crashEvent) throw new Error(`crash:${crashEvent}`);
        },
      });
      expect(() => crashing.recover(initial.generationId)).toThrow(`crash:${crashEvent}`);
      expect(existsSync(orphanPath)).toBe(true);
      if (crashEvent === "before-head-capture") {
        expectProtocolReason(() => store.read(initial.generationId), "recovery-required");
        expect(store.recover(initial.generationId)).toEqual(candidate);
      } else {
        expect(store.read(initial.generationId)).toEqual(candidate);
        expect(store.recover(initial.generationId)).toEqual(candidate);
      }
    }

    const raceHome = makeHome();
    const raceInitial = manifest("recover-head-race");
    const raceStore = new MigrationManifestStore({ homeDir: raceHome });
    raceStore.create(raceInitial);
    const raceCandidate = beginMigrationEffect(raceInitial, {
      effectId: "effect-recovery-race",
      kind: "verify-dry-run",
      inputSha256: HASH,
      startedAt: "2026-08-12T12:00:01.000Z",
    });
    const orphanPath = publishSuccessorOrphan(raceHome, raceInitial, raceCandidate);
    const orphanContent = readFileSync(orphanPath, "utf8");
    const headPath = migrationManifestHeadPath(raceInitial.generationId, raceHome);
    const generation = migrationManifestGenerationDirectory(raceInitial.generationId, raceHome);
    const replacement = "same-uid recovery replacement\n";
    const racing = new MigrationManifestStore({
      homeDir: raceHome,
      observer: (event) => {
        if (event === "before-head-capture") writeFileSync(headPath, replacement, { mode: 0o600 });
      },
    });
    expectProtocolReason(() => racing.recover(raceInitial.generationId), "recovery-required");
    expect(readFileSync(headPath, "utf8")).toBe(replacement);
    expect(readFileSync(orphanPath, "utf8")).toBe(orphanContent);
    const artifacts = headPublicationArtifactPaths(raceHome, raceInitial.generationId);
    expect(readFileSync(artifacts.capture, "utf8")).toBe(replacement);
    expect(readFileSync(artifacts.tmp, "utf8")).toContain(raceCandidate.checksumSha256);
    expect(existsSync(artifacts.attempt)).toBe(true);
    expect(readdirSync(join(generation, "revisions")).sort()).toEqual([
      "0000000000000000",
      "0000000000000001",
    ]);
  });

  it("refuses a wrong predecessor, ambiguous successor, and forbidden second hop without mutation", () => {
    for (const scenario of ["wrong-predecessor", "ambiguous-successor", "second-hop"] as const) {
      const home = makeHome();
      const initial = manifest(`recover-${scenario}`);
      const store = new MigrationManifestStore({ homeDir: home });
      store.create(initial);
      const candidate = beginMigrationEffect(initial, {
        effectId: `effect-${scenario}`,
        kind: "verify-dry-run",
        inputSha256: HASH,
        startedAt: "2026-08-12T12:00:01.000Z",
      });
      const orphanPath = publishSuccessorOrphan(home, initial, candidate);
      let expectedReason: MigrationProtocolError["reason"] = "unexpected-state";
      if (scenario === "wrong-predecessor") {
        const wrong = rewriteManifestFixture(orphanPath, {
          previousManifestSha256: "b".repeat(64),
        });
        const wrongPath = migrationManifestRevisionPath({
          generationId: wrong.generationId,
          revision: wrong.revision,
          checksumSha256: wrong.checksumSha256,
        }, home);
        renameSync(orphanPath, wrongPath);
      } else if (scenario === "ambiguous-successor") {
        const secondPath = join(resolve(orphanPath, ".."), `${"b".repeat(64)}.json`);
        writeFileSync(secondPath, readFileSync(orphanPath), { mode: 0o600 });
        expectedReason = "malformed-manifest";
      } else {
        mkdirSync(join(resolve(orphanPath, "../.."), "0000000000000002"), { mode: 0o700 });
      }
      expectProtocolReason(() => store.recover(initial.generationId), expectedReason);
      expect(readFileSync(migrationManifestHeadPath(initial.generationId, home), "utf8"))
        .toContain(initial.checksumSha256);
    }
  });

  it("reads the candidate from the final cleanup state and consumes only its attempt durably", () => {
    const state = createCaptureCleanedPublicationState("publication-capture-cleaned");
    const store = new MigrationManifestStore({ homeDir: state.home });
    expect(store.read(state.initial.generationId)).toEqual(state.candidate);

    let reducerCalls = 0;
    expectProtocolReason(() => store.update(
      state.initial.generationId,
      state.initial.checksumSha256,
      () => {
        reducerCalls += 1;
        return state.candidate;
      },
    ), "recovery-required");
    expect(reducerCalls).toBe(0);

    const evidence = capturePublicationEvidence(state);
    const nodeFs = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;
    const originalOpen = nodeFs.openSync as typeof import("node:fs").openSync;
    const originalFsync = nodeFs.fsyncSync as (fd: number) => void;
    const originalUnlink = nodeFs.unlinkSync as (path: string) => void;
    const generationDescriptors = new Set<number>();
    const unlinked: string[] = [];
    let attemptConsumed = false;
    let fsyncedAfterAttempt = false;

    const recovered = withPatchedFs("openSync", ((path: string, flags: string | number, mode?: number) => {
      const fd = mode === undefined
        ? originalOpen(path, flags)
        : originalOpen(path, flags, mode);
      if (path === state.generation) generationDescriptors.add(fd);
      return fd;
    }) as never, () => withPatchedFs("unlinkSync", ((path: string) => {
      unlinked.push(path);
      originalUnlink(path);
      if (path === state.artifacts.attempt) attemptConsumed = true;
    }) as never, () => withPatchedFs("fsyncSync", ((fd: number) => {
      if (attemptConsumed && generationDescriptors.has(fd)) fsyncedAfterAttempt = true;
      originalFsync(fd);
    }) as never, () => new MigrationManifestStore({ homeDir: state.home }).recover(
      state.initial.generationId,
    ))));

    expect(recovered).toEqual(state.candidate);
    expect(unlinked.filter((path) => path.startsWith(`${state.generation}/`)))
      .toEqual([state.artifacts.attempt]);
    expect(fsyncedAfterAttempt).toBe(true);
    expect(readFileSync(state.headPath, "utf8")).toBe(evidence.head);
    expect(readdirSync(state.generation).sort()).toEqual(
      evidence.generationEntries.filter((entry) => entry !== resolve(state.artifacts.attempt, ".."))
        .filter((entry) => entry !== state.artifacts.attempt.split("/").pop())
        .sort(),
    );
    expect(readdirSync(join(state.generation, "revisions")).sort()).toEqual(evidence.revisionEntries);
    expect(lstatSync(state.headPath).nlink).toBe(evidence.headNlink);
    expect(existsSync(state.artifacts.attempt)).toBe(false);
    expect(existsSync(state.artifacts.tmp)).toBe(false);
    expect(existsSync(state.artifacts.capture)).toBe(false);

    expect(store.recover(state.initial.generationId)).toEqual(state.candidate);
    expect(store.read(state.initial.generationId)).toEqual(state.candidate);
    expect(readdirSync(state.generation).sort()).toEqual(["head.json", "revisions"]);
  });

  it("refuses final cleanup evidence without mutating any authenticated artifact", () => {
    const scenarios: ReadonlyArray<Readonly<{
      name: string;
      mutate: (state: ReturnType<typeof createCaptureCleanedPublicationState>) => void;
    }>> = [
      {
        name: "missing predecessor revision",
        mutate: (state) => {
          const predecessorPath = migrationManifestRevisionPath({
            generationId: state.initial.generationId,
            revision: 0,
            checksumSha256: state.initial.checksumSha256,
          }, state.home);
          rmSync(resolve(predecessorPath, ".."), { recursive: true, force: true });
        },
      },
      {
        name: "internally canonical but wrong predecessor",
        mutate: (state) => {
          const wrong = replaceImmutableRevisionFixture(state.home, state.candidate, {
            previousManifestSha256: "b".repeat(64),
          });
          const wrongHead = createMigrationManifestHead({
            generationId: wrong.generationId,
            revision: wrong.revision,
            manifestSha256: wrong.checksumSha256,
            updatedAt: wrong.updatedAt,
          });
          const wrongHeadContent = migrationManifestHeadContent(wrongHead);
          writeFileSync(state.headPath, wrongHeadContent, { mode: 0o600 });
          rewritePublicationAttempt(state.artifacts.attempt, {
            candidateHeadRawSha256: createHash("sha256")
              .update(wrongHeadContent, "utf8")
              .digest("hex"),
            candidateManifestSha256: wrong.checksumSha256,
          });
        },
      },
      {
        name: "head replaced with predecessor bytes",
        mutate: (state) => {
          const predecessorPath = migrationManifestRevisionPath({
            generationId: state.initial.generationId,
            revision: 0,
            checksumSha256: state.initial.checksumSha256,
          }, state.home);
          writeFileSync(
            state.headPath,
            migrationManifestHeadContent(createMigrationManifestHead({
              generationId: state.initial.generationId,
              revision: state.initial.revision,
              manifestSha256: state.initial.checksumSha256,
              updatedAt: state.initial.updatedAt,
            })),
            { mode: 0o600 },
          );
          expect(existsSync(predecessorPath)).toBe(true);
        },
      },
      {
        name: "second hop",
        mutate: (state) => {
          mkdirSync(join(state.generation, "revisions", "0000000000000002"), { mode: 0o700 });
        },
      },
      {
        name: "unrelated extra entry",
        mutate: (state) => {
          writeFileSync(join(state.generation, "unrelated"), "unrelated\n", { mode: 0o600 });
        },
      },
      {
        name: "head second hard link",
        mutate: (state) => {
          linkSync(state.headPath, join(state.home, "head-outside-generation"));
        },
      },
      {
        name: "canonical sealed attempt changed to candidate revision 0",
        mutate: (state) => {
          rewritePublicationAttempt(state.artifacts.attempt, { candidateRevision: 0 });
        },
      },
    ];

    for (const scenario of scenarios) {
      const state = createCaptureCleanedPublicationState(`publication-refusal-${scenario.name.replaceAll(" ", "-")}`);
      scenario.mutate(state);
      const evidence = capturePublicationEvidence(state);
      const store = new MigrationManifestStore({ homeDir: state.home });

      expect(() => store.read(state.initial.generationId), scenario.name)
        .toThrow(MigrationProtocolError);
      expectPublicationEvidence(state, evidence);
      expect(() => store.recover(state.initial.generationId), scenario.name)
        .toThrow(MigrationProtocolError);
      expectPublicationEvidence(state, evidence);
    }
  });

  it("sanitizes an absent generation without masking unsafe migration metadata", () => {
    const home = makeHome();
    const generationId = "unknown-generation";
    const store = new MigrationManifestStore({ homeDir: home });
    const calls = [
      ["migration manifest head is absent", () => store.read(generationId)],
      ["migration manifest head is absent", () => store.update(generationId, HASH, (current) => current)],
      ["migration manifest has no recoverable genesis revision", () => store.recover(generationId)],
    ] as const;

    for (const [expectedMessage, call] of calls) {
      let failure: unknown;
      try {
        call();
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(MigrationProtocolError);
      expect((failure as MigrationProtocolError).reason).toBe("unexpected-state");
      expect((failure as MigrationProtocolError).message).toBe(expectedMessage);
    }
    expect(existsSync(migrationManifestGenerationDirectory(generationId, home))).toBe(false);

    const unsafeHome = makeHome();
    const migrations = join(unsafeHome, ".lcm", "migrations");
    mkdirSync(migrations, { mode: 0o700 });
    chmodSync(migrations, 0o755);
    let unsafeFailure: unknown;
    try {
      new MigrationManifestStore({ homeDir: unsafeHome }).read(generationId);
    } catch (error) {
      unsafeFailure = error;
    } finally {
      chmodSync(migrations, 0o700);
    }
    expect(unsafeFailure).toBeInstanceOf(Error);
    expect((unsafeFailure as Error).message).toContain("mode");
    expect(unsafeFailure).not.toMatchObject({
      message: "migration manifest head is absent",
    });
    expect(existsSync(migrationManifestGenerationDirectory(generationId, unsafeHome))).toBe(false);
  });
});
