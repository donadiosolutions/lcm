import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
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
      "after-revision-publication",
      "before-head-publication",
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
      "after-revision-publication",
      "before-head-publication",
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
      expect(existsSync(successorPath)).toBe(crashIndex >= 1);
      if (crashEvent === "before-revision-publication") {
        expect(existsSync(resolve(successorPath, ".."))).toBe(false);
        expect(store.update(initial.generationId, initial.checksumSha256, () => candidate)).toEqual(candidate);
      } else if (crashEvent === "after-head-publication") {
        expect(store.read(initial.generationId)).toEqual(candidate);
      } else {
        expectProtocolReason(() => store.read(initial.generationId), "recovery-required");
      }
    }
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
        if (event === "before-head-publication") {
          writeFileSync(headPath, replacement, { mode: 0o600 });
        }
      },
    });
    expect(() => racing.update(initial.generationId, initial.checksumSha256, () => candidate))
      .toThrow("changed before durable publication");
    expect(readFileSync(headPath, "utf8")).toBe(replacement);
    expect(existsSync(migrationManifestRevisionPath({
      generationId: candidate.generationId,
      revision: candidate.revision,
      checksumSha256: candidate.checksumSha256,
    }, home))).toBe(true);
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
    expect(recoveryEvents).toEqual(["before-head-publication", "after-head-publication"]);
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

    const headProbeHome = makeHome();
    const headProbeInitial = manifest("head-probe-error");
    const headProbeStore = new MigrationManifestStore({ homeDir: headProbeHome });
    headProbeStore.create(headProbeInitial);
    const headPath = migrationManifestHeadPath(headProbeInitial.generationId, headProbeHome);
    const realOpen = createRequire(import.meta.url)("node:fs").openSync as typeof import("node:fs").openSync;
    expect(() => withPatchedFs("openSync", ((path: string, flags: number, mode?: number) => {
      if (path === headPath) throw Object.assign(new Error("head probe denied"), { code: "EACCES" });
      return realOpen(path, flags, mode);
    }) as never, () => headProbeStore.recover(headProbeInitial.generationId))).toThrow("head probe denied");

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
    expect(orphanStore.recover(predecessor.generationId)).toEqual(maximumOrphan);
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
    for (const crashEvent of ["before-head-publication", "after-head-publication"] as const) {
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
      if (crashEvent === "before-head-publication") {
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
    const headPath = migrationManifestHeadPath(raceInitial.generationId, raceHome);
    const replacement = "{}\n";
    const racing = new MigrationManifestStore({
      homeDir: raceHome,
      observer: (event) => {
        if (event === "before-head-publication") writeFileSync(headPath, replacement, { mode: 0o600 });
      },
    });
    expect(() => racing.recover(raceInitial.generationId))
      .toThrow("changed before durable publication");
    expect(readFileSync(headPath, "utf8")).toBe(replacement);
    expect(existsSync(orphanPath)).toBe(true);
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
});
