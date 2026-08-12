import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
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
    expectProtocolReason(() => store.create(advanced), "invalid-input");
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

  it("publishes revision before head at exact observer crash boundaries", () => {
    const events = [
      "before-revision-publication",
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
      expect(existsSync(revision)).toBe(crashIndex >= 1);
      expect(existsSync(head)).toBe(crashIndex >= 3);
      expect(observed.map((entry) => entry.slice(0, entry.indexOf(":"))))
        .toEqual(events.slice(0, crashIndex + 1));
      if (crashEvent === "after-head-publication") {
        expect(store.read(initial.generationId)).toEqual(initial);
      }
      if (crashEvent === "before-revision-publication") {
        expect(existsSync(migrationManifestGenerationDirectory(initial.generationId, home))).toBe(false);
        expect(new MigrationManifestStore({ homeDir: home }).create(initial)).toEqual(initial);
      }
    }
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

    const negativeZeroHome = makeHome();
    const negativeZeroStore = new MigrationManifestStore({ homeDir: negativeZeroHome });
    const negativeZero = { ...manifest("negative-zero"), revision: -0 };
    expect(negativeZeroStore.create(negativeZero)).toEqual(expect.objectContaining({ revision: -0 }));
    expect(readFileSync(migrationManifestRevisionPath({
      generationId: negativeZero.generationId,
      revision: 0,
      checksumSha256: negativeZero.checksumSha256,
    }, negativeZeroHome), "utf8")).toContain('"revision":0');
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
      if (destination === collisionPath) writeFileSync(destination, "attacker", { mode: 0o600 });
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
    expectProtocolReason(() => withPatchedFs("mkdirSync", ((path: string, options?: unknown) => {
      if (path.endsWith("/generation-race")) {
        const error = new Error("generation appeared") as NodeJS.ErrnoException;
        error.code = "EEXIST";
        throw error;
      }
      return realMkdir(path, options as never);
    }) as never, () => new MigrationManifestStore({ homeDir: generationRaceHome }).create(generationRace)), "unexpected-state");

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
