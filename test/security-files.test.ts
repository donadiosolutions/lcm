import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  renameSync,
  statSync,
  symlinkSync,
  appendFileSync,
  closeSync,
  fchmodSync,
  fsyncSync,
  fstatSync,
  openSync,
  linkSync,
  lstatSync,
  realpathSync,
  statSync as fsStatSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { join, parse, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  atomicWritePrivateFile,
  atomicWritePrivateFileDurable,
  atomicWritePrivateFileExclusive,
  assertPrivateDirectory,
  assertPrivateDirectoryEntry,
  copyRegularFilePrivateExclusive,
  consumeAuthenticatedWriterAlias,
  consumeBoundedRegularFile,
  deleteRegularFile,
  ensurePrivateDirectory,
  openPrivateDirectory,
  openPrivateDirectoryForCreation,
  openPrivateDirectoryIfExists,
  readBoundedRegularFile,
  readBoundedRegularFileWithStat,
  syncPrivateDirectory,
  writePrivateFileExclusive,
  OWNER_ONLY_FILE_MODES,
} from "../src/security-files.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "lcm-security-files-"));
  roots.push(root);
  return root;
}

function writerAliasFixture(content = "head\n"): Readonly<{
  aliasPath: string;
  finalPath: string;
  generation: string;
}> {
  const root = makeRoot();
  const generation = join(root, "generation");
  mkdirSync(generation, { mode: 0o700 });
  const finalPath = join(generation, "head.json");
  const aliasPath = join(generation, ".head.json.0123456789abcdef01234567.tmp");
  writeFileSync(finalPath, content, { mode: 0o600 });
  linkSync(finalPath, aliasPath);
  return { aliasPath, finalPath, generation };
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

describe("private filesystem primitives", () => {
  it("publishes through a borrowed parent without repairing or closing it", () => {
    const root = makeRoot();
    chmodSync(root, 0o700);
    const parent = openPrivateDirectory(root);
    let closed = false;
    const borrowed = { ...parent, close: () => { closed = true; } };
    try {
      const target = join(root, "metadata.json");
      atomicWritePrivateFile(target, "content", {}, borrowed);
      expect(readFileSync(target, "utf8")).toBe("content");
      expect(statSync(root).mode & 0o777).toBe(0o700);
      expect(closed).toBe(false);
      expect(assertPrivateDirectoryEntry(parent, root, parent.witness.uid).dev).toBe(parent.witness.dev);
    } finally {
      parent.close();
    }
  });

  it("rejects borrowed publication when the parent entry is replaced by a symlink", () => {
    const root = makeRoot();
    const replacement = makeRoot();
    const parent = openPrivateDirectory(root);
    const target = join(root, "metadata.json");
    rmSync(root, { recursive: true, force: true });
    symlinkSync(replacement, root);
    try {
      expect(() => atomicWritePrivateFile(target, "content", {}, parent)).toThrow();
      expect(existsSync(target)).toBe(false);
    } finally {
      parent.close();
    }
  });

  it("classifies borrowed temp-open and rename topology failures", () => {
    const root = makeRoot();
    const replacement = makeRoot();
    const parent = openPrivateDirectory(root);
    const target = join(root, "metadata.json");
    const replaceParent = (): void => {
      rmSync(root, { recursive: true, force: true });
      symlinkSync(replacement, root);
    };
    try {
      expect(() => atomicWritePrivateFile(target, "content", {
        open: () => {
          replaceParent();
          throw new Error("open failed");
        },
      }, parent)).toThrow(/topology/i);
      replaceParent();
      parent.close();
      const secondParent = openPrivateDirectory(replacement);
      const secondTarget = join(replacement, "metadata.json");
      expect(() => atomicWritePrivateFile(secondTarget, "content", {
        rename: (from, to) => {
          renameSync(from, to);
          rmSync(replacement, { recursive: true, force: true });
          symlinkSync(root, replacement);
          throw new Error("rename failed");
        },
      }, secondParent)).toThrow(/topology/i);
      secondParent.close();
    } finally {
      try { parent.close(); } catch { /* already closed */ }
    }
  });

  it("preserves ordinary borrowed rename failures when the parent is still valid", () => {
    const root = makeRoot();
    const parent = openPrivateDirectory(root);
    try {
      expect(() => atomicWritePrivateFile(join(root, "metadata.json"), "content", {
        rename: () => { throw new Error("ordinary rename failure"); },
      }, parent)).toThrow("ordinary rename failure");
    } finally {
      parent.close();
    }
  });

  it("rejects borrowed entries whose mode, owner, or inode no longer matches", () => {
    const root = makeRoot();
    const other = makeRoot();
    const parent = openPrivateDirectory(root);
    const modeAlias = join(root, "mode-alias");
    const ownerAlias = join(root, "owner-alias");
    mkdirSync(modeAlias, { mode: 0o755 });
    mkdirSync(ownerAlias, { mode: 0o700 });
    const originalLstat = lstatSync;
    try {
      let modeError: unknown;
      try {
        withPatchedFs(
        "lstatSync",
        ((path: string, options?: unknown) => {
          if (path === modeAlias) {
            return {
              isDirectory: () => true,
              mode: 0o40755n,
              uid: BigInt(parent.witness.uid),
              dev: BigInt(parent.witness.dev),
              ino: BigInt(parent.witness.ino),
            };
          }
          return originalLstat(path, options as never);
        }) as typeof lstatSync,
        () => assertPrivateDirectoryEntry(parent, modeAlias),
        );
      } catch (error) {
        modeError = error;
      }
      expect(modeError).toMatchObject({
        name: "PrivateDirectoryTopologyError",
        cause: { message: "private directory entry mode is not trusted" },
      });
      let ownerError: unknown;
      try {
        withPatchedFs(
        "lstatSync",
        ((path: string, options?: unknown) => {
          if (path === ownerAlias) {
            return {
              isDirectory: () => true,
              mode: 0o40700n,
              uid: BigInt(parent.witness.uid + 1),
              dev: BigInt(parent.witness.dev),
              ino: BigInt(parent.witness.ino),
            };
          }
          return originalLstat(path, options as never);
        }) as typeof lstatSync,
        () => assertPrivateDirectoryEntry(parent, ownerAlias),
        );
      } catch (error) {
        ownerError = error;
      }
      expect(ownerError).toMatchObject({
        name: "PrivateDirectoryTopologyError",
        cause: { message: "private directory entry owner is not trusted" },
      });
      expect(() => assertPrivateDirectoryEntry(parent, other)).toThrow(/topology/i);
    } finally {
      parent.close();
    }
  });

  it("rejects same-inode symlink evidence at the borrowed parent seam", () => {
    const root = makeRoot();
    const alias = join(root, "alias");
    const parent = openPrivateDirectory(root);
    symlinkSync(root, alias);
    try {
      expect(() => assertPrivateDirectoryEntry(parent, alias)).toThrow(/topology/i);
    } finally {
      parent.close();
    }
  });

  it("rejects parent drift observed after a successful rename", () => {
    const root = makeRoot();
    const parent = openPrivateDirectory(root);
    const target = join(root, "metadata.json");
    const originalLstat = lstatSync;
    let drifted = false;
    let renameCalled = false;
    try {
      expect(() => withPatchedFs(
        "lstatSync",
        ((path: string, options?: unknown) => {
          if (path === root && drifted) return { isDirectory: () => false };
          return originalLstat(path, options as never);
        }) as typeof lstatSync,
        () => atomicWritePrivateFile(target, "content", {
          rename: (from, to) => {
            renameCalled = true;
            renameSync(from, to);
            drifted = true;
          },
        }, parent),
      )).toThrow(/topology/i);
      expect(renameCalled).toBe(true);
    } finally {
      parent.close();
    }
  });

  it("fails creation admission on an invalid type or owner", () => {
    const root = makeRoot();
    const originalFstat = fstatSync;
    try {
      expect(() => withPatchedFs(
        "fstatSync",
        ((fd: number, options?: unknown) => {
          if ((options as { bigint?: boolean } | undefined)?.bigint === true) {
            return { isDirectory: () => false };
          }
          return originalFstat(fd, options as never);
        }) as typeof fstatSync,
        () => openPrivateDirectoryForCreation(root),
      )).toThrow("path is not a directory");
      expect(() => withPatchedFs(
        "fstatSync",
        ((fd: number, options?: unknown) => {
          if ((options as { bigint?: boolean } | undefined)?.bigint === true) {
            return { isDirectory: () => true, uid: 999999n, mode: 0o40700n };
          }
          return originalFstat(fd, options as never);
        }) as typeof fstatSync,
        () => openPrivateDirectoryForCreation(root),
      )).toThrow("private directory owner is not trusted");
    } finally {
      chmodSync(root, 0o700);
    }
  });

  it("consumes an authenticated writer alias while retaining the final inode", () => {
    const { aliasPath, finalPath } = writerAliasFixture();

    expect(() => consumeAuthenticatedWriterAlias(finalPath, aliasPath, {
      maxBytes: 1024,
    })).not.toThrow();
    expect(existsSync(aliasPath)).toBe(false);
    expect(readFileSync(finalPath, "utf8")).toBe("head\n");
    expect(lstatSync(finalPath).nlink).toBe(1);
  });

  it("rejects invalid writer-alias inputs and initial topology without mutation", () => {
    const expectedUid = typeof process.getuid === "function" ? process.getuid() : undefined;
    const invalidOptions = [
      { maxBytes: Number.NaN },
      { maxBytes: -1 },
      { maxBytes: 1024, allowedModes: [] },
      { maxBytes: 1024, allowedModes: [0o755] },
    ] as const;
    for (const options of invalidOptions) {
      const { aliasPath, finalPath } = writerAliasFixture();
      expect(() => consumeAuthenticatedWriterAlias(finalPath, aliasPath, {
        ...options,
        expectedUid,
      })).toThrow();
      expect(existsSync(aliasPath)).toBe(true);
    }

    const same = writerAliasFixture();
    expect(() => consumeAuthenticatedWriterAlias(same.finalPath, same.finalPath, {
      maxBytes: 1024,
      expectedUid,
    })).toThrow("distinct");

    const differentParents = writerAliasFixture();
    const otherParent = join(resolve(differentParents.generation, ".."), "other-parent");
    mkdirSync(otherParent, { mode: 0o700 });
    const movedAlias = join(otherParent, "alias.tmp");
    renameSync(differentParents.aliasPath, movedAlias);
    expect(() => consumeAuthenticatedWriterAlias(
      differentParents.finalPath,
      movedAlias,
      { maxBytes: 1024, expectedUid },
    )).toThrow("parent");
    expect(existsSync(movedAlias)).toBe(true);

    for (const scenario of ["separate", "third-link", "mode", "symlink", "oversized"] as const) {
      const fixture = writerAliasFixture(scenario === "oversized" ? "oversized" : "head\n");
      if (scenario === "separate") {
        unlinkSync(fixture.aliasPath);
        writeFileSync(fixture.aliasPath, "head\n", { mode: 0o600 });
      } else if (scenario === "third-link") {
        linkSync(fixture.finalPath, join(resolve(fixture.generation, ".."), "third-link"));
      } else if (scenario === "mode") {
        chmodSync(fixture.finalPath, 0o644);
      } else if (scenario === "symlink") {
        unlinkSync(fixture.aliasPath);
        symlinkSync(fixture.finalPath, fixture.aliasPath);
      }
      expect(() => consumeAuthenticatedWriterAlias(fixture.finalPath, fixture.aliasPath, {
        maxBytes: scenario === "oversized" ? 1 : 1024,
        expectedUid,
      })).toThrow();
      expect(existsSync(fixture.aliasPath)).toBe(true);
    }
  });

  it("preserves writer-alias replacements and rejects post-authentication drift", () => {
    const expectedUid = typeof process.getuid === "function" ? process.getuid() : undefined;
    for (const scenario of ["regular", "symlink", "directory"] as const) {
      const fixture = writerAliasFixture();
      expect(() => consumeAuthenticatedWriterAlias(fixture.finalPath, fixture.aliasPath, {
        maxBytes: 1024,
        expectedUid,
        _beforeUnlinkForTesting: () => {
          unlinkSync(fixture.aliasPath);
          if (scenario === "regular") writeFileSync(fixture.aliasPath, "replacement", { mode: 0o600 });
          else if (scenario === "symlink") symlinkSync(fixture.finalPath, fixture.aliasPath);
          else mkdirSync(fixture.aliasPath, { mode: 0o700 });
        },
      })).toThrow("changed");
      expect(existsSync(fixture.aliasPath)).toBe(true);
      expect(readFileSync(fixture.finalPath, "utf8")).toBe("head\n");
    }

    const postUnlink = writerAliasFixture();
    expect(() => consumeAuthenticatedWriterAlias(postUnlink.finalPath, postUnlink.aliasPath, {
      maxBytes: 1024,
      expectedUid,
      _afterUnlinkForTesting: () => writeFileSync(postUnlink.aliasPath, "replacement", { mode: 0o600 }),
    })).toThrow("replaced");
    expect(readFileSync(postUnlink.aliasPath, "utf8")).toBe("replacement");

    const finalReplacement = writerAliasFixture();
    const retained = join(resolve(finalReplacement.generation, ".."), "retained-final");
    expect(() => consumeAuthenticatedWriterAlias(finalReplacement.finalPath, finalReplacement.aliasPath, {
      maxBytes: 1024,
      expectedUid,
      _afterUnlinkForTesting: () => {
        renameSync(finalReplacement.finalPath, retained);
        writeFileSync(finalReplacement.finalPath, "replacement", { mode: 0o600 });
      },
    })).toThrow("single-link");
    expect(readFileSync(retained, "utf8")).toBe("head\n");
    expect(readFileSync(finalReplacement.finalPath, "utf8")).toBe("replacement");

    const finalBeforeUnlink = writerAliasFixture();
    const retainedBeforeUnlink = join(resolve(finalBeforeUnlink.generation, ".."), "retained-before-unlink");
    expect(() => consumeAuthenticatedWriterAlias(finalBeforeUnlink.finalPath, finalBeforeUnlink.aliasPath, {
      maxBytes: 1024,
      expectedUid,
      _beforeUnlinkForTesting: () => {
        renameSync(finalBeforeUnlink.finalPath, retainedBeforeUnlink);
        writeFileSync(finalBeforeUnlink.finalPath, "replacement", { mode: 0o600 });
      },
    })).toThrow("changed during consume");
    expect(existsSync(finalBeforeUnlink.aliasPath)).toBe(true);
    expect(readFileSync(finalBeforeUnlink.aliasPath, "utf8")).toBe("head\n");
    expect(readFileSync(finalBeforeUnlink.finalPath, "utf8")).toBe("replacement");
  });

  it("rejects inconsistent writer-alias metadata and content observations", () => {
    const expectedUid = typeof process.getuid === "function" ? process.getuid() : undefined;
    const initialMetadata = writerAliasFixture();
    const initialStat = fsStatSync(initialMetadata.finalPath, { bigint: true });
    const nodeFs = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;
    const originalFstat = nodeFs.fstatSync as typeof fstatSync;
    let matchingFstats = 0;
    expect(() => withPatchedFs("fstatSync", ((fd: number, options?: unknown) => {
      const stat = originalFstat(fd, options as never);
      if ((options as { bigint?: boolean } | undefined)?.bigint === true
        && stat.dev === initialStat.dev && stat.ino === initialStat.ino) {
        matchingFstats += 1;
        if (matchingFstats === 1) {
          return Object.assign(stat, { mtimeNs: stat.mtimeNs + 1n });
        }
      }
      return stat;
    }) as never, () => consumeAuthenticatedWriterAlias(
      initialMetadata.finalPath,
      initialMetadata.aliasPath,
      { maxBytes: 1024, expectedUid },
    ))).toThrow("writer alias metadata does not match the final file");
    expect(existsSync(initialMetadata.aliasPath)).toBe(true);

    const metadata = writerAliasFixture();
    expect(() => consumeAuthenticatedWriterAlias(metadata.finalPath, metadata.aliasPath, {
      maxBytes: 1024,
      expectedUid,
      _beforeUnlinkForTesting: () => {
        utimesSync(metadata.finalPath, new Date(1), new Date(1));
      },
    })).toThrow("writer alias changed during consume");
    expect(existsSync(metadata.aliasPath)).toBe(true);

    const originalRead = nodeFs.readSync as typeof import("node:fs").readSync;
    const initialContent = writerAliasFixture();
    let initialReadCalls = 0;
    expect(() => withPatchedFs("readSync", ((
      fd: number,
      buffer: NodeJS.ArrayBufferView,
      offset: number,
      length: number,
      position: number | null,
    ) => {
      initialReadCalls += 1;
      const bytesRead = originalRead(fd, buffer, offset, length, position);
      if (initialReadCalls === 3 && bytesRead > 0) (buffer as Buffer)[offset] ^= 1;
      return bytesRead;
    }) as never, () => consumeAuthenticatedWriterAlias(
      initialContent.finalPath,
      initialContent.aliasPath,
      { maxBytes: 1024, expectedUid },
    ))).toThrow("content does not match");
    expect(existsSync(initialContent.aliasPath)).toBe(true);

    const content = writerAliasFixture();
    let readCalls = 0;
    expect(() => withPatchedFs("readSync", ((
      fd: number,
      buffer: NodeJS.ArrayBufferView,
      offset: number,
      length: number,
      position: number | null,
    ) => {
      readCalls += 1;
      const bytesRead = originalRead(fd, buffer, offset, length, position);
      if (readCalls === 5 && bytesRead > 0) (buffer as Buffer)[offset] ^= 1;
      return bytesRead;
    }) as never, () => consumeAuthenticatedWriterAlias(content.finalPath, content.aliasPath, {
      maxBytes: 1024,
      expectedUid,
    }))).toThrow("content changed");
    expect(existsSync(content.aliasPath)).toBe(true);
  });

  it("rejects writer-alias pathname loss and absence-probe failures", () => {
    const expectedUid = typeof process.getuid === "function" ? process.getuid() : undefined;
    const nodeFs = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;
    const originalLstat = nodeFs.lstatSync as typeof lstatSync;
    const pathnameLoss = writerAliasFixture();
    expect(() => withPatchedFs("lstatSync", ((path: string, options?: unknown) => {
      if (path === pathnameLoss.aliasPath) return Object.assign(originalLstat(path, options as never), { ino: 0n });
      return originalLstat(path, options as never);
    }) as never, () => consumeAuthenticatedWriterAlias(pathnameLoss.finalPath, pathnameLoss.aliasPath, {
      maxBytes: 1024,
      expectedUid,
    }))).toThrow("changed");
    expect(existsSync(pathnameLoss.aliasPath)).toBe(true);

    const probeFailure = writerAliasFixture();
    let aliasProbes = 0;
    expect(() => withPatchedFs("lstatSync", ((path: string, options?: unknown) => {
      if (path === probeFailure.aliasPath) {
        aliasProbes += 1;
        if (aliasProbes === 2) throw Object.assign(new Error("alias probe denied"), { code: "EACCES" });
      }
      return originalLstat(path, options as never);
    }) as never, () => consumeAuthenticatedWriterAlias(probeFailure.finalPath, probeFailure.aliasPath, {
      maxBytes: 1024,
      expectedUid,
    }))).toThrow("alias probe denied");
    expect(existsSync(probeFailure.aliasPath)).toBe(false);
  });

  it("reports writer-alias durability and descriptor cleanup failures", () => {
    const expectedUid = typeof process.getuid === "function" ? process.getuid() : undefined;
    const nodeFs = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;
    const originalFsync = nodeFs.fsyncSync as (fd: number) => void;
    const fsyncFailure = writerAliasFixture();
    expect(() => withPatchedFs("fsyncSync", ((fd: number) => {
      originalFsync(fd);
      throw new Error("alias fsync failed");
    }) as never, () => consumeAuthenticatedWriterAlias(
      fsyncFailure.finalPath,
      fsyncFailure.aliasPath,
      { maxBytes: 1024, expectedUid },
    ))).toThrow("alias fsync failed");
    expect(existsSync(fsyncFailure.aliasPath)).toBe(false);
    expect(lstatSync(fsyncFailure.finalPath).nlink).toBe(1);

    const originalClose = nodeFs.closeSync as (fd: number) => void;
    for (const scenario of ["one", "many", "primary-and-cleanup"] as const) {
      const fixture = writerAliasFixture();
      let closeCalls = 0;
      const invoke = () => withPatchedFs("closeSync", ((fd: number) => {
        closeCalls += 1;
        originalClose(fd);
        if (scenario === "one" ? closeCalls === 1 : true) {
          throw new Error(`alias close ${closeCalls}`);
        }
      }) as never, () => {
        if (scenario === "primary-and-cleanup") {
          linkSync(fixture.finalPath, join(resolve(fixture.generation, ".."), "ambiguous-link"));
        }
        consumeAuthenticatedWriterAlias(fixture.finalPath, fixture.aliasPath, {
          maxBytes: 1024,
          expectedUid,
        });
      });
      expect(invoke).toThrow();
      if (scenario === "one") expect(closeCalls).toBeGreaterThanOrEqual(3);
      else expect(closeCalls).toBe(3);
    }
  });

  it("consumes a bounded regular file only after descriptor and inode revalidation", () => {
    const root = makeRoot();
    const path = join(root, "credential");
    writeFileSync(path, "secret\n", { mode: 0o600 });
    expect(consumeBoundedRegularFile(path, { allowedRoot: root, maxBytes: 1024 })).toBe("secret\n");
    expect(existsSync(path)).toBe(false);

    const idempotent = join(root, "idempotent");
    writeFileSync(idempotent, "value", { mode: 0o600 });
    expect(consumeBoundedRegularFile(idempotent, {
      allowedRoot: root,
      maxBytes: 1024,
      _beforeUnlinkForTesting: () => unlinkSync(idempotent),
    })).toBe("value");
    expect(existsSync(idempotent)).toBe(false);
  });

  it("preserves a replaced or linked leaf instead of consuming an ambiguous path", () => {
    const root = makeRoot();
    const path = join(root, "credential");
    const replacement = join(root, "replacement");
    writeFileSync(path, "secret", { mode: 0o600 });
    writeFileSync(replacement, "replacement", { mode: 0o600 });
    let consumeError: unknown;
    try {
      consumeBoundedRegularFile(path, {
        allowedRoot: root,
        maxBytes: 1024,
        _beforeUnlinkForTesting: () => {
          rmSync(path);
          symlinkSync(replacement, path);
        },
      });
    } catch (error) {
      consumeError = error;
    }
    expect(consumeError).toBeInstanceOf(Error);
    expect([
      "file changed during consume",
      "path is not a regular file",
    ]).toContain((consumeError as Error).message);
    expect(readFileSync(path)).toEqual(readFileSync(replacement));

    rmSync(path);
    writeFileSync(path, "secret", { mode: 0o600 });
    const hardlink = join(root, "hardlink");
    linkSync(path, hardlink);
    expect(() => consumeBoundedRegularFile(path, { allowedRoot: root, maxBytes: 1024 })).toThrow("multiple hard links");
    expect(existsSync(path)).toBe(true);
    expect(existsSync(hardlink)).toBe(true);
  });

  it("revalidates expected ownership and exact mode across the consume unlink race", () => {
    const root = makeRoot();
    const path = join(root, "credential-metadata-race");
    writeFileSync(path, "secret", { mode: 0o600 });
    const expectedUid = typeof process.getuid === "function" ? process.getuid() : undefined;
    expect(() => consumeBoundedRegularFile(path, {
      allowedRoot: root,
      maxBytes: 1024,
      expectedUid,
      allowedModes: [0o600],
      requireSingleLink: true,
      _beforeUnlinkForTesting: () => chmodSync(path, 0o644),
    })).toThrow("mode");
    expect(existsSync(path)).toBe(true);
    chmodSync(path, 0o600);
    expect(consumeBoundedRegularFile(path, {
      allowedRoot: root,
      maxBytes: 1024,
      expectedUid,
      allowedModes: [0o600],
      requireSingleLink: true,
    })).toBe("secret");
  });

  it("creates and tightens private directories", () => {
    const path = join(makeRoot(), "private");
    mkdirSync(path, { mode: 0o755 });

    ensurePrivateDirectory(path);

    expect(statSync(path).mode & 0o777).toBe(0o700);
  });

  it("retains and revalidates a strict private directory descriptor", () => {
    const root = makeRoot();
    const path = join(root, "retained");
    mkdirSync(path, { mode: 0o700 });

    const handle = openPrivateDirectory(path);
    expect(handle.witness.mode).toBe(0o700);
    expect(handle.witness.dev).toMatch(/^\d+$/u);
    expect(assertPrivateDirectory(handle, path, handle.witness)).toEqual(handle.witness);
    syncPrivateDirectory(path);
    handle.close();
    handle.close();

    chmodSync(path, 0o755);
    expect(() => openPrivateDirectory(path)).toThrow("mode");
  });

  it("threads an explicit expected uid through retained assertions and directory sync", () => {
    const path = join(makeRoot(), "uid-policy");
    mkdirSync(path, { mode: 0o700 });
    const expectedUid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (expectedUid === undefined) return;

    const handle = openPrivateDirectory(path, { expectedUid });
    expect(assertPrivateDirectory(handle, path, handle.witness, expectedUid)).toEqual(handle.witness);
    expect(() => assertPrivateDirectory(handle, path, undefined, expectedUid + 1)).toThrow("owner");
    handle.close();

    expect(() => syncPrivateDirectory(path, { expectedUid: expectedUid + 1 })).toThrow("owner");
    expect(() => syncPrivateDirectory(path, { expectedUid })).not.toThrow();
  });

  it.each([
    ["strict", openPrivateDirectory, new Error("strict authentication failed")],
    ["creation", openPrivateDirectoryForCreation, { code: 123 }],
    ["optional", openPrivateDirectoryIfExists, undefined],
  ] as const)("preserves the exact %s directory authentication failure after cleanup", (
    _label,
    openDirectory,
    authenticationFailure,
  ) => {
    const root = makeRoot();
    chmodSync(root, 0o700);
    const originalClose = closeSync;
    let closeCalls = 0;
    let caught: unknown = Symbol("did not throw");

    withPatchedFs(
      "fstatSync",
      (() => { throw authenticationFailure; }) as typeof fstatSync,
      () => withPatchedFs(
        "closeSync",
        ((fd: number) => {
          closeCalls += 1;
          originalClose(fd);
        }) as typeof closeSync,
        () => {
          try {
            openDirectory(root);
          } catch (error) {
            caught = error;
          }
        },
      ),
    );

    expect(caught).toBe(authenticationFailure);
    expect(closeCalls).toBe(1);
  });

  it.each([
    ["strict", openPrivateDirectory, new Error("strict authentication failed")],
    ["creation", openPrivateDirectoryForCreation, { code: 123 }],
    ["optional", openPrivateDirectoryIfExists, undefined],
  ] as const)("reports both %s directory authentication and cleanup failures", (
    _label,
    openDirectory,
    authenticationFailure,
  ) => {
    const root = makeRoot();
    chmodSync(root, 0o700);
    const originalClose = closeSync;
    const cleanupFailure = new Error("descriptor cleanup failed");
    let closeCalls = 0;
    let caught: unknown = Symbol("did not throw");

    withPatchedFs(
      "fstatSync",
      (() => { throw authenticationFailure; }) as typeof fstatSync,
      () => withPatchedFs(
        "closeSync",
        ((fd: number) => {
          closeCalls += 1;
          originalClose(fd);
          throw cleanupFailure;
        }) as typeof closeSync,
        () => {
          try {
            openDirectory(root);
          } catch (error) {
            caught = error;
          }
        },
      ),
    );

    expect(caught).toBeInstanceOf(AggregateError);
    const aggregate = caught as AggregateError;
    expect(aggregate.message).toBe("private directory authentication and cleanup failed");
    expect(aggregate.errors).toHaveLength(2);
    expect(aggregate.errors[0]).toBe(authenticationFailure);
    expect(aggregate.errors[1]).toBe(cleanupFailure);
    expect(Object.hasOwn(aggregate, "cause")).toBe(true);
    expect(aggregate.cause).toBe(authenticationFailure);
    expect(closeCalls).toBe(1);
  });

  it("returns undefined only when an optional directory is absent before acquisition", () => {
    const root = makeRoot();
    const initialAbsence = Object.assign(new Error("initial absence"), { code: "ENOENT" });

    expect(withPatchedFs(
      "openSync",
      (() => { throw initialAbsence; }) as typeof openSync,
      () => openPrivateDirectoryIfExists(root),
    )).toBeUndefined();
  });

  it.each([false, true])("throws post-acquisition optional-directory ENOENT (cleanup failure: %s)", (
    cleanupFails,
  ) => {
    const root = makeRoot();
    chmodSync(root, 0o700);
    const authenticationFailure = Object.assign(new Error("post-acquisition absence"), { code: "ENOENT" });
    const cleanupFailure = new Error("descriptor cleanup failed");
    const originalClose = closeSync;
    let closeCalls = 0;
    let caught: unknown = Symbol("did not throw");

    withPatchedFs(
      "realpathSync",
      (() => { throw authenticationFailure; }) as typeof realpathSync,
      () => withPatchedFs(
        "closeSync",
        ((fd: number) => {
          closeCalls += 1;
          originalClose(fd);
          if (cleanupFails) throw cleanupFailure;
        }) as typeof closeSync,
        () => {
          try {
            openPrivateDirectoryIfExists(root);
          } catch (error) {
            caught = error;
          }
        },
      ),
    );

    if (cleanupFails) {
      expect(caught).toBeInstanceOf(AggregateError);
      const aggregate = caught as AggregateError;
      expect(aggregate.errors).toHaveLength(2);
      expect(aggregate.errors[0]).toBe(authenticationFailure);
      expect(aggregate.errors[1]).toBe(cleanupFailure);
      expect(aggregate.cause).toBe(authenticationFailure);
    } else {
      expect(caught).toBe(authenticationFailure);
    }
    expect(closeCalls).toBe(1);
  });

  it.each([undefined, { code: 123 }])("preserves optional directory-open failures without a string code: %j", (failure) => {
    const root = makeRoot();
    let caught: unknown = Symbol("did not throw");
    withPatchedFs("openSync", () => { throw failure; }, () => {
      try {
        openPrivateDirectoryIfExists(root);
      } catch (error) {
        caught = error;
      }
    });
    expect(caught).toBe(failure);
  });

  it("rejects a non-directory descriptor, an unexpected owner, and a changed witness", () => {
    const root = makeRoot();
    const file = join(root, "file");
    const directory = join(root, "directory");
    writeFileSync(file, "file", { mode: 0o600 });
    mkdirSync(directory, { mode: 0o700 });

    const fileFd = openSync(file, "r");
    try {
      expect(() => assertPrivateDirectory({
        fd: fileFd,
        witness: {} as never,
        close: () => undefined,
      }, file)).toThrow("not a directory");
    } finally {
      closeSync(fileFd);
    }

    const uid = typeof process.getuid === "function" ? process.getuid() : 0;
    expect(() => openPrivateDirectory(directory, { expectedUid: uid + 1 })).toThrow("owner");
    const handle = openPrivateDirectory(directory);
    try {
      expect(() => assertPrivateDirectory(handle, directory, {
        ...handle.witness,
        ino: `${handle.witness.ino}0`,
      })).toThrow("witness changed");
    } finally {
      handle.close();
    }
  });

  it("uses caller-provided directory operations", () => {
    const path = join(makeRoot(), "custom");
    const calls: string[] = [];
    ensurePrivateDirectory(path, {
      mkdir: (directory, options) => {
        calls.push(`mkdir:${directory}:${options.mode.toString(8)}:${options.recursive}`);
        mkdirSync(directory, options);
      },
      chmod: (directory, mode) => {
        calls.push(`chmod:${directory}:${mode.toString(8)}`);
        chmodSync(directory, mode);
      },
    });
    expect(calls).toEqual([
      `mkdir:${path}:700:true`,
      `chmod:${path}:700`,
    ]);

    const noUidPath = join(makeRoot(), "no-uid");
    mkdirSync(noUidPath, { mode: 0o700 });
    const descriptor = Object.getOwnPropertyDescriptor(process, "getuid");
    try {
      Object.defineProperty(process, "getuid", { value: undefined, configurable: true });
      const handle = openPrivateDirectory(noUidPath);
      handle.close();
    } finally {
      if (descriptor === undefined) delete (process as { getuid?: unknown }).getuid;
      else Object.defineProperty(process, "getuid", descriptor);
    }
  });

  it("detects a directory identity change during open validation", () => {
    const root = makeRoot();
    const path = join(root, "retained");
    const replacement = join(root, "replacement");
    mkdirSync(path, { mode: 0o700 });
    mkdirSync(replacement, { mode: 0o700 });
    const originalRealpath = realpathSync;
    let realpathCalls = 0;
    expect(() => withPatchedFs(
      "realpathSync",
      ((candidate: string) => {
        realpathCalls += 1;
        return realpathCalls === 1 ? originalRealpath(replacement) : originalRealpath(candidate);
      }) as typeof realpathSync,
      () => openPrivateDirectory(path),
    )).toThrow("changed during validation");
  });

  it("rejects a retained directory after pathname replacement and rejects symlinked roots", () => {
    const root = makeRoot();
    const path = join(root, "retained");
    const replacement = join(root, "replacement");
    mkdirSync(path, { mode: 0o700 });
    mkdirSync(replacement, { mode: 0o700 });
    const handle = openPrivateDirectory(path);
    renameSync(path, join(root, "retained-original"));
    mkdirSync(path, { mode: 0o700 });
    expect(() => assertPrivateDirectory(handle, path)).toThrow("changed");
    handle.close();

    rmSync(path, { recursive: true });
    symlinkSync(replacement, path, "dir");
    expect(() => openPrivateDirectory(path)).toThrow();
  });

  it("rejects legacy conditional publication before a pathname replacement can be overwritten", () => {
    const root = makeRoot();
    const path = join(root, "durable.json");
    const initial = "initial\n";
    const candidate = "candidate\n";
    writeFileSync(path, initial, { mode: 0o600 });
    const initialStat = lstatSync(path);
    const expectedContentSha256 = createHash("sha256").update(initial).digest("hex");
    const temporaryPath = join(root, `.durable.json.${"11".repeat(12)}.tmp`);
    let renameCalls = 0;
    const originalRename = renameSync;

    expect(() => withPatchedFs(
      "renameSync",
      ((from: string, to: string) => {
        renameCalls += 1;
        expect(to).toBe(path);
        unlinkSync(path);
        writeFileSync(path, "same-uid replacement\n", { mode: 0o600 });
        return originalRename(from, to);
      }) as typeof renameSync,
      () => atomicWritePrivateFileDurable(path, candidate, {
        expectedContentSha256,
        random: () => Buffer.alloc(12, 0x11),
      } as never),
    )).toThrow("conditional durable replacement is unsupported; use a protocol-specific operation");

    expect(renameCalls).toBe(0);
    expect(readFileSync(path, "utf8")).toBe(initial);
    const finalStat = lstatSync(path);
    expect(finalStat.dev).toBe(initialStat.dev);
    expect(finalStat.ino).toBe(initialStat.ino);
    expect(existsSync(temporaryPath)).toBe(false);
  });

  it("durably publishes an exclusive file and rejects legacy conditional options", () => {
    const root = makeRoot();
    const path = join(root, "durable.json");
    atomicWritePrivateFileDurable(path, "first", { requireAbsent: true });
    expect(readFileSync(path, "utf8")).toBe("first");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(() => atomicWritePrivateFileDurable(path, "second", { requireAbsent: true }))
      .toThrow("already exists");
    const digest = createHash("sha256").update("first").digest("hex");
    for (const expectedContentSha256 of [digest, "0".repeat(64), null, undefined]) {
      expect(() => atomicWritePrivateFileDurable(path, "second", {
        expectedContentSha256,
      } as never)).toThrow("conditional durable replacement is unsupported; use a protocol-specific operation");
      expect(readFileSync(path, "utf8")).toBe("first");
    }
    atomicWritePrivateFileDurable(path, "second");
    expect(readFileSync(path, "utf8")).toBe("second");
    expect(() => atomicWritePrivateFileDurable(path, "third", {
      maxExistingBytes: 1,
    })).toThrow();
  });

  it("threads an explicit owner policy through durable publication", () => {
    const root = makeRoot();
    const path = join(root, "durable-owner.json");
    const expectedUid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (expectedUid === undefined) throw new Error("durable owner-policy tests require process.getuid");

    expect(() => atomicWritePrivateFileDurable(path, "private", {
      expectedUid: expectedUid + 1,
      requireAbsent: true,
    })).toThrow("owner");
    expect(existsSync(path)).toBe(false);

    atomicWritePrivateFileDurable(path, "private", { expectedUid, requireAbsent: true });
    expect(readFileSync(path, "utf8")).toBe("private");
  });

  it("fsyncs an authenticated owner-only final mode before durable publication", () => {
    const root = makeRoot();
    const path = join(root, "owner-readonly.json");

    atomicWritePrivateFileDurable(path, "readonly", {
      requireAbsent: true,
      finalMode: 0o400,
    });

    expect(readFileSync(path, "utf8")).toBe("readonly");
    expect(statSync(path).mode & 0o777).toBe(0o400);
    expect(() => atomicWritePrivateFileDurable(path, "invalid", { finalMode: 0o644 }))
      .toThrow("owner-only");
  });

  it("defines exactly the owner-readable private regular-file mode domain", () => {
    expect(OWNER_ONLY_FILE_MODES).toEqual([0o400, 0o500, 0o600, 0o700]);
  });

  it.each([
    0o000,
    0o100,
    0o200,
    0o300,
    0o640,
    0o604,
    0o644,
    0o1000,
    0o2000,
    0o4000,
    0o7000,
  ])("rejects non-owner-readable durable final mode %o", (mode) => {
    const root = makeRoot();
    expect(() => atomicWritePrivateFileDurable(join(root, `invalid-${mode}`), "content", {
      finalMode: mode,
    })).toThrow("owner-only");
  });

  it("covers durable exclusive publication races and injected I/O failures", () => {
    const root = makeRoot();
    const race = join(root, "race");
    expect(() => atomicWritePrivateFileDurable(race, "content", {
      requireAbsent: true,
      random: () => {
        writeFileSync(race, "winner", { mode: 0o600 });
        return Buffer.alloc(12, 0x11);
      },
    })).toThrow("created concurrently");

    const linkFailure = join(root, "link-failure");
    const linkError = Object.assign(new Error("link denied"), { code: "EACCES" });
    expect(() => withPatchedFs(
      "linkSync",
      (() => { throw linkError; }) as typeof linkSync,
      () => atomicWritePrivateFileDurable(linkFailure, "content", { requireAbsent: true }),
    )).toThrow(linkError);

    const zeroProgress = join(root, "zero-progress");
    expect(() => withPatchedFs(
      "writeSync",
      (() => 0) as typeof writeSync,
      () => atomicWritePrivateFileDurable(zeroProgress, "content"),
    )).toThrow("no progress");

    const closeFailure = join(root, "close-failure");
    const originalClose = closeSync;
    let closeCalls = 0;
    expect(() => withPatchedFs(
      "closeSync",
      ((fd: number) => {
        closeCalls += 1;
        if (closeCalls === 1) throw new Error("temporary close failed");
        return originalClose(fd);
      }) as typeof closeSync,
      () => atomicWritePrivateFileDurable(closeFailure, "content"),
    )).toThrow("temporary close failed");

    const cleanupFailure = join(root, "cleanup-failure");
    const writeFailure = new Error("durable write failed");
    const originalUnlink = unlinkSync;
    expect(() => withPatchedFs(
      "writeSync",
      (() => { throw writeFailure; }) as typeof writeSync,
      () => withPatchedFs(
        "unlinkSync",
        ((path: string) => {
          if (path.includes("cleanup-failure")) {
            throw Object.assign(new Error("cleanup denied"), { code: "EACCES" });
          }
          return originalUnlink(path);
        }) as typeof unlinkSync,
        () => atomicWritePrivateFileDurable(cleanupFailure, "content"),
      ),
    )).toThrow("cleanup denied");

    const publishedCleanup = join(root, "published-cleanup");
    expect(() => withPatchedFs(
      "unlinkSync",
      ((path: string) => {
        if (path.includes("published-cleanup")) {
          throw Object.assign(new Error("published cleanup denied"), { code: "EACCES" });
        }
        return originalUnlink(path);
      }) as typeof unlinkSync,
      () => atomicWritePrivateFileDurable(publishedCleanup, "content"),
    )).not.toThrow();
    expect(readFileSync(publishedCleanup, "utf8")).toBe("content");

    const cleanupEnoent = join(root, "cleanup-enoent");
    const cleanupWriteFailure = new Error("write failed before cleanup");
    const originalFstat = fstatSync;
    expect(() => withPatchedFs(
      "writeSync",
      (() => { throw cleanupWriteFailure; }) as typeof writeSync,
      () => withPatchedFs(
        "unlinkSync",
        (() => { throw Object.assign(new Error("already gone"), { code: "ENOENT" }); }) as typeof unlinkSync,
        () => atomicWritePrivateFileDurable(cleanupEnoent, "content"),
      ),
    )).toThrow(cleanupWriteFailure);

    const identityUnavailable = join(root, "identity-unavailable");
    let bigintFstatCalls = 0;
    const identityFailure = new Error("temporary identity unavailable");
    expect(() => withPatchedFs(
      "fstatSync",
      ((fd: number, options?: unknown) => {
        if ((options as { bigint?: boolean } | undefined)?.bigint === true) {
          bigintFstatCalls += 1;
          if (bigintFstatCalls === 2) throw identityFailure;
        }
        return originalFstat(fd, options as never);
      }) as typeof fstatSync,
      () => atomicWritePrivateFileDurable(identityUnavailable, "content"),
    )).toThrow(identityFailure);

    const binary = join(root, "binary");
    atomicWritePrivateFileDurable(binary, new Uint8Array([0x62, 0x69, 0x6e, 0x61, 0x72, 0x79]));
    expect(readFileSync(binary, "utf8")).toBe("binary");
  });

  it("atomically replaces files and symlinks with private regular files", () => {
    const root = makeRoot();
    const victim = join(root, "victim");
    const target = join(root, "metadata.json");
    writeFileSync(victim, "victim");
    symlinkSync(victim, target);

    atomicWritePrivateFile(target, "private metadata");

    expect(readFileSync(target, "utf-8")).toBe("private metadata");
    expect(readFileSync(victim, "utf-8")).toBe("victim");
    expect(statSync(target).mode & 0o777).toBe(0o600);
  });

  it("does not remove a pre-existing temporary path when exclusive creation loses", () => {
    const root = makeRoot();
    const target = join(root, "metadata.json");
    const random = () => Buffer.alloc(12, 0xab);
    const tempPath = join(root, `.metadata.json.${"ab".repeat(12)}.tmp`);
    writeFileSync(tempPath, "concurrent owner", { mode: 0o600 });

    expect(() => atomicWritePrivateFile(target, "private metadata", { random })).toThrow();
    expect(readFileSync(tempPath, "utf-8")).toBe("concurrent owner");
    expect(existsSync(target)).toBe(false);
  });

  it("removes only a temporary path it created when initialization fails", () => {
    const root = makeRoot();
    const target = join(root, "metadata.json");
    const tempPath = join(root, `.metadata.json.${"cd".repeat(12)}.tmp`);
    const failure = new Error("write failed");

    expect(() => atomicWritePrivateFile(target, "private metadata", {
      random: () => Buffer.alloc(12, 0xcd),
      write: () => {
        throw failure;
      },
    })).toThrow(failure);
    expect(existsSync(tempPath)).toBe(false);
    expect(existsSync(target)).toBe(false);
  });

  it("does not publish a replacement when private-mode setup fails", () => {
    const root = makeRoot();
    const target = join(root, "metadata.json");
    const tempPath = join(root, `.metadata.json.${"ef".repeat(12)}.tmp`);
    const failure = new Error("chmod failed");
    writeFileSync(target, "original", { mode: 0o600 });

    expect(() => atomicWritePrivateFile(target, "private metadata", {
      random: () => Buffer.alloc(12, 0xef),
      fchmod: () => {
        throw failure;
      },
    })).toThrow(failure);
    expect(readFileSync(target, "utf-8")).toBe("original");
    expect(existsSync(tempPath)).toBe(false);
  });

  it("preserves an unborrowed rename failure and removes only its owned temporary file", () => {
    const root = makeRoot();
    const target = join(root, "metadata.json");
    const tempPath = join(root, `.metadata.json.${"ab".repeat(12)}.tmp`);
    const failure = new Error("rename failed");
    writeFileSync(target, "original", { mode: 0o600 });
    let caught: unknown;

    try {
      atomicWritePrivateFile(target, "replacement", {
        random: () => Buffer.alloc(12, 0xab),
        rename: () => { throw failure; },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(failure);
    expect(readFileSync(target, "utf8")).toBe("original");
    expect(existsSync(tempPath)).toBe(false);
  });

  it("streams a validated regular file into an exclusive private destination", () => {
    const root = makeRoot();
    const source = join(root, "machine.json");
    const destination = join(root, "oldmachines", "machine.json");
    const content = "0123456789".repeat(10_000);
    writeFileSync(source, content, { mode: 0o600 });

    expect(copyRegularFilePrivateExclusive(source, destination, {
      allowedRoot: root,
      _chunkBytesForTesting: 17,
    })).toBe(true);
    expect(copyRegularFilePrivateExclusive(source, destination, {
      allowedRoot: root,
      _chunkBytesForTesting: 17,
    })).toBe(false);
    expect(readFileSync(destination, "utf8")).toBe(content);
    expect(statSync(destination).mode & 0o777).toBe(0o600);
  });

  it("rejects invalid chunks, escaped sources, directories, and changed source identities", () => {
    const root = makeRoot();
    const outside = makeRoot();
    const source = join(root, "machine.json");
    const sourceDirectory = join(root, "directory");
    const destination = join(root, "oldmachines", "machine.json");
    writeFileSync(source, "identity", { mode: 0o600 });
    mkdirSync(sourceDirectory);

    expect(() => copyRegularFilePrivateExclusive(source, destination, {
      allowedRoot: root,
      _chunkBytesForTesting: 0,
    })).toThrow(RangeError);
    expect(() => copyRegularFilePrivateExclusive(source, destination, {
      allowedRoot: outside,
    })).toThrow("outside the permitted root");
    expect(() => copyRegularFilePrivateExclusive(sourceDirectory, destination, {
      allowedRoot: root,
    })).toThrow("not a regular file");

    let realpathCalls = 0;
    expect(() => copyRegularFilePrivateExclusive(source, destination, {
      allowedRoot: root,
      _operationsForTesting: {
        realpath: ((path: string) => {
          realpathCalls += 1;
          return realpathCalls === 3 ? outside : realpathSync(path);
        }) as typeof realpathSync,
      },
    })).toThrow("outside the permitted root");

    expect(() => copyRegularFilePrivateExclusive(source, destination, {
      allowedRoot: root,
      _operationsForTesting: {
        stat: ((path: string) => {
          const current = fsStatSync(path);
          return { ...current, ino: current.ino + 1 };
        }) as typeof fsStatSync,
      },
    })).toThrow("file changed during validation");
  });

  it("preserves destination-open and zero-progress write failures", () => {
    const root = makeRoot();
    const source = join(root, "machine.json");
    const destination = join(root, "oldmachines", "machine.json");
    const openFailure = Object.assign(new Error("destination open failed"), {
      code: "EACCES",
    });
    writeFileSync(source, "identity", { mode: 0o600 });

    expect(() => copyRegularFilePrivateExclusive(source, destination, {
      allowedRoot: root,
      _operationsForTesting: {
        open: ((path: string, flags: string | number, mode?: number) => {
          if (flags === "wx") throw openFailure;
          return openSync(path, flags, mode);
        }) as typeof openSync,
      },
    })).toThrow(openFailure);
    expect(existsSync(destination)).toBe(false);

    expect(() => copyRegularFilePrivateExclusive(source, destination, {
      allowedRoot: root,
      _operationsForTesting: {
        write: (() => 0) as typeof writeSync,
      },
    })).toThrow("private backup write made no progress");
    expect(existsSync(destination)).toBe(false);
  });

  it("preserves copy failures when destination cleanup also fails", () => {
    const root = makeRoot();
    const source = join(root, "machine.json");
    const destination = join(root, "oldmachines", "machine.json");
    const copyFailure = new Error("private mode failed");
    let destinationFd: number | undefined;
    writeFileSync(source, "identity", { mode: 0o600 });

    expect(() => copyRegularFilePrivateExclusive(source, destination, {
      allowedRoot: root,
      _operationsForTesting: {
        open: ((path: string, flags: string | number, mode?: number) => {
          const fd = openSync(path, flags, mode);
          if (flags === "wx") destinationFd = fd;
          return fd;
        }) as typeof openSync,
        fchmod: (() => {
          throw copyFailure;
        }) as typeof fchmodSync,
        close: ((fd: number) => {
          closeSync(fd);
          if (fd === destinationFd) throw new Error("cleanup close failed");
        }) as typeof closeSync,
        unlink: ((path: string) => {
          unlinkSync(path);
          throw new Error("cleanup unlink failed");
        }) as typeof unlinkSync,
      },
    })).toThrow(copyFailure);
    expect(existsSync(destination)).toBe(false);
  });

  it("leaves an attacker replacement untouched during failed exclusive cleanup", () => {
    const root = makeRoot();
    const source = join(root, "machine.json");
    const destination = join(root, "oldmachines", "machine.json");
    const replacement = join(root, "replacement.json");
    writeFileSync(source, "identity", { mode: 0o600 });

    expect(() => copyRegularFilePrivateExclusive(source, destination, {
      allowedRoot: root,
      _operationsForTesting: {
        fchmod: (() => {
          writeFileSync(replacement, "attacker", { mode: 0o600 });
          renameSync(replacement, destination);
          throw new Error("copy failed after replacement");
        }) as typeof fchmodSync,
      },
    })).toThrow("copy failed after replacement");
    expect(readFileSync(destination, "utf8")).toBe("attacker");

    const writeDestination = join(root, "write-exclusive");
    const writeReplacement = join(root, "write-replacement");
    const unlink = vi.fn();
    expect(() => writePrivateFileExclusive(writeDestination, "content", {
      open: openSync,
      write: (() => {
        writeFileSync(writeReplacement, "attacker", { mode: 0o600 });
        renameSync(writeReplacement, writeDestination);
        throw new Error("write failed after replacement");
      }) as typeof writeFileSync,
      sync: vi.fn(),
      close: closeSync,
      unlink,
    })).toThrow("write failed after replacement");
    expect(readFileSync(writeDestination, "utf8")).toBe("attacker");
    expect(unlink).not.toHaveBeenCalled();
  });

  it("covers identity-gated cleanup races and unobservable cleanup errors", () => {
    const root = makeRoot();
    const source = join(root, "source");
    const destination = join(root, "destination");
    writeFileSync(source, "source", { mode: 0o600 });
    const cleanupError = Object.assign(new Error("cleanup stat denied"), { code: "EACCES" });
    expect(() => copyRegularFilePrivateExclusive(source, destination, {
      allowedRoot: root,
      _operationsForTesting: {
        fchmod: (() => { throw new Error("copy failed"); }) as typeof fchmodSync,
        lstat: (() => { throw cleanupError; }) as never,
      },
    })).toThrow("copy failed");

    const directoryDestination = join(root, "directory-destination");
    expect(() => copyRegularFilePrivateExclusive(source, directoryDestination, {
      allowedRoot: root,
      _operationsForTesting: {
        fchmod: (() => {
          rmSync(directoryDestination);
          mkdirSync(directoryDestination, { mode: 0o700 });
          throw new Error("copy failed with directory replacement");
        }) as typeof fchmodSync,
      },
    })).toThrow("copy failed with directory replacement");
    expect(statSync(directoryDestination).isDirectory()).toBe(true);

    const missingTemp = join(root, "missing-temp");
    expect(() => atomicWritePrivateFileExclusive(missingTemp, "content", {
      random: () => Buffer.alloc(12, 0x31),
      link: (from: string) => {
        unlinkSync(from);
        throw new Error("link failed after temp disappearance");
      },
    })).toThrow("link failed after temp disappearance");

    const missingParentDestination = join(root, "missing-parent", "destination");
    expect(() => copyRegularFilePrivateExclusive(source, missingParentDestination, {
      allowedRoot: root,
      _operationsForTesting: {
        fchmod: (() => {
          rmSync(join(root, "missing-parent"), { recursive: true });
          throw new Error("copy failed after parent disappearance");
        }) as typeof fchmodSync,
      },
    })).toThrow("copy failed after parent disappearance");

    const swappedParentDestination = join(root, "swapped-parent", "destination");
    expect(() => copyRegularFilePrivateExclusive(source, swappedParentDestination, {
      allowedRoot: root,
      _operationsForTesting: {
        fchmod: (() => {
          renameSync(join(root, "swapped-parent"), join(root, "swapped-parent-original"));
          mkdirSync(join(root, "swapped-parent"), { mode: 0o700 });
          throw new Error("copy failed after parent replacement");
        }) as typeof fchmodSync,
      },
    })).toThrow("copy failed after parent replacement");
    expect(existsSync(swappedParentDestination)).toBe(false);

    const deniedParentDestination = join(root, "denied-parent", "destination");
    const parentStatFailure = Object.assign(new Error("parent stat denied"), { code: "EACCES" });
    const originalLstat = lstatSync;
    let deniedParentStatCalls = 0;
    expect(() => withPatchedFs(
      "lstatSync",
      ((candidate: string, options?: unknown) => {
        if (candidate === join(root, "denied-parent")) {
          deniedParentStatCalls += 1;
          if (deniedParentStatCalls === 2) throw parentStatFailure;
        }
        return originalLstat(candidate, options as never);
      }) as typeof lstatSync,
      () => copyRegularFilePrivateExclusive(source, deniedParentDestination, {
        allowedRoot: root,
        _operationsForTesting: {
          fchmod: (() => { throw new Error("copy failed after parent stat error"); }) as typeof fchmodSync,
        },
      }),
    )).toThrow("copy failed after parent stat error");

    const destinationStatFailure = join(root, "destination-stat-failure");
    let destinationFstatCalls = 0;
    expect(() => copyRegularFilePrivateExclusive(source, destinationStatFailure, {
      allowedRoot: root,
      _operationsForTesting: {
        fstat: ((fd: number, options?: unknown) => {
          destinationFstatCalls += 1;
          if (destinationFstatCalls === 2) throw new Error("destination identity unavailable");
          return fstatSync(fd, options as never);
        }) as typeof fstatSync,
      },
    })).toThrow("destination identity unavailable");
    expect(existsSync(destinationStatFailure)).toBe(true);

    const writeStatFailure = join(root, "write-stat-failure");
    const writeIdentityFailure = new Error("write identity unavailable");
    const writeUnlink = vi.fn();
    expect(() => writePrivateFileExclusive(writeStatFailure, "content", {
      open: openSync,
      fstat: (() => { throw writeIdentityFailure; }) as typeof fstatSync,
      write: writeFileSync,
      sync: vi.fn(),
      close: closeSync,
      unlink: writeUnlink,
    })).toThrow(writeIdentityFailure);
    expect(writeUnlink).not.toHaveBeenCalled();
  });

  it("suppresses source-close errors after success or while preserving a copy failure", () => {
    const root = makeRoot();
    const source = join(root, "machine.json");
    const firstDestination = join(root, "oldmachines", "first.json");
    const secondDestination = join(root, "oldmachines", "second.json");
    writeFileSync(source, "identity", { mode: 0o600 });

    let closeCalls = 0;
    expect(copyRegularFilePrivateExclusive(source, firstDestination, {
      allowedRoot: root,
      _operationsForTesting: {
        close: ((fd: number) => {
          closeCalls += 1;
          closeSync(fd);
          if (closeCalls === 2) throw new Error("source close failed");
        }) as typeof closeSync,
      },
    })).toBe(true);

    const copyFailure = new Error("copy failed");
    expect(() => copyRegularFilePrivateExclusive(source, secondDestination, {
      allowedRoot: root,
      _operationsForTesting: {
        fstat: (() => {
          throw copyFailure;
        }) as never,
        close: ((fd: number) => {
          closeSync(fd);
          throw new Error("source close failed");
        }) as typeof closeSync,
      },
    })).toThrow(copyFailure);
  });

  it("reads a bounded regular file and returns descriptor metadata", () => {
    const root = makeRoot();
    const path = join(root, "data");
    writeFileSync(path, "content");

    expect(readBoundedRegularFile(path, { allowedRoot: root, maxBytes: 7 })).toBe("content");
    expect(readBoundedRegularFile(path, { allowedRoot: parse(root).root, maxBytes: 7 })).toBe("content");
    expect(readBoundedRegularFileWithStat(path, { allowedRoot: root, maxBytes: 7 })).toEqual({
      content: "content",
      mtimeMs: statSync(path).mtimeMs,
    });
  });

  it("enforces the byte limit when a file grows after descriptor metadata is read", () => {
    const root = makeRoot();
    const path = join(root, "growing");
    writeFileSync(path, "123");

    expect(() => readBoundedRegularFile(path, {
      allowedRoot: root,
      maxBytes: 3,
      _afterStatForTesting: () => appendFileSync(path, "4"),
    })).toThrow("size limit");
  });

  it("enforces optional ownership, mode, link-count, and post-read identity checks", () => {
    const root = makeRoot();
    const path = join(root, "metadata");
    const hardlink = join(root, "metadata-link");
    writeFileSync(path, "original", { mode: 0o400 });

    expect(() => readBoundedRegularFile(path, {
      allowedRoot: root,
      maxBytes: 100,
      allowedModes: [0o600],
    })).toThrow("mode");
    expect(() => readBoundedRegularFile(path, {
      allowedRoot: root,
      maxBytes: 100,
      expectedUid: (typeof process.getuid === "function" ? process.getuid() : 0) + 1,
    })).toThrow("owner");

    linkSync(path, hardlink);
    expect(() => readBoundedRegularFile(path, {
      allowedRoot: root,
      maxBytes: 100,
      requireSingleLink: true,
    })).toThrow("hard links");
    unlinkSync(hardlink);

    expect(() => readBoundedRegularFile(path, {
      allowedRoot: root,
      maxBytes: 100,
      expectedRawSha256: "0".repeat(64),
    })).toThrow("content hash");
    expect(readBoundedRegularFile(path, {
      allowedRoot: root,
      maxBytes: 100,
      expectedRawSha256: createHash("sha256").update("original").digest("hex"),
    })).toBe("original");

    expect(() => readBoundedRegularFile(path, {
      allowedRoot: root,
      maxBytes: 100,
      allowedModes: [0o400],
      _beforeReadForTesting: () => {
        chmodSync(path, 0o600);
        writeFileSync(path, "changed");
        chmodSync(path, 0o400);
      },
    })).toThrow("changed during validation");

    const postStat = join(root, "post-stat");
    writeFileSync(postStat, "original", { mode: 0o400 });
    expect(() => readBoundedRegularFile(postStat, {
      allowedRoot: root,
      maxBytes: 100,
      allowedModes: [0o400],
      _beforePostStatForTesting: () => {
        chmodSync(postStat, 0o600);
        writeFileSync(postStat, "post-stat");
        chmodSync(postStat, 0o400);
      },
    })).toThrow("changed during validation");
  });

  it("rejects an intermediate-directory swap between containment validation and open", () => {
    const root = makeRoot();
    const outside = makeRoot();
    const parent = join(root, "instructions");
    const movedParent = join(root, "instructions-original");
    mkdirSync(parent);
    writeFileSync(join(parent, "file"), "trusted");
    writeFileSync(join(outside, "file"), "untrusted");

    expect(() => readBoundedRegularFile(join(parent, "file"), {
      allowedRoot: root,
      maxBytes: 100,
      _beforeOpenForTesting: () => {
        renameSync(parent, movedParent);
        symlinkSync(outside, parent, "dir");
      },
    })).toThrow("outside");
  });

  it("rejects a leaf replacement after opening the descriptor", () => {
    const root = makeRoot();
    const path = join(root, "replaceable");
    writeFileSync(path, "original");

    expect(() => readBoundedRegularFile(path, {
      allowedRoot: root,
      maxBytes: 100,
      _afterStatForTesting: () => {
        renameSync(path, join(root, "original"));
        writeFileSync(path, "replacement");
      },
    })).toThrow("changed during validation");
  });

  it("rejects a leaf replacement before open and path changes after the read", () => {
    const root = makeRoot();
    const outside = makeRoot();
    const beforeOpen = join(root, "before-open");
    writeFileSync(beforeOpen, "original", { mode: 0o600 });
    expect(() => readBoundedRegularFile(beforeOpen, {
      allowedRoot: root,
      maxBytes: 100,
      _beforeOpenForTesting: () => {
        renameSync(beforeOpen, join(root, "before-open-original"));
        writeFileSync(beforeOpen, "replacement", { mode: 0o600 });
      },
    })).toThrow("changed during validation");

    const escaped = join(root, "escaped");
    const outsideFile = join(outside, "outside");
    writeFileSync(escaped, "trusted", { mode: 0o600 });
    writeFileSync(outsideFile, "outside", { mode: 0o600 });
    expect(() => readBoundedRegularFile(escaped, {
      allowedRoot: root,
      maxBytes: 100,
      _beforeReadForTesting: () => {
        renameSync(escaped, join(root, "escaped-original"));
        symlinkSync(outsideFile, escaped);
      },
    })).toThrow("outside");

    const changed = join(root, "changed-after-read");
    writeFileSync(changed, "trusted", { mode: 0o600 });
    expect(() => readBoundedRegularFile(changed, {
      allowedRoot: root,
      maxBytes: 100,
      _beforeReadForTesting: () => {
        renameSync(changed, join(root, "changed-after-read-original"));
        writeFileSync(changed, "replacement", { mode: 0o600 });
      },
    })).toThrow("changed during validation");
  });

  it("rejects a credential consume when its parent is replaced", () => {
    const root = makeRoot();
    const outside = makeRoot();
    const parent = join(root, "credentials");
    const path = join(parent, "OPENAI_API_KEY");
    mkdirSync(parent);
    writeFileSync(path, "secret", { mode: 0o600 });
    expect(() => consumeBoundedRegularFile(path, {
      allowedRoot: root,
      maxBytes: 100,
      _beforeUnlinkForTesting: () => {
        renameSync(parent, join(root, "credentials-original"));
        symlinkSync(outside, parent, "dir");
      },
    })).toThrow("parent changed");
  });

  it("rejects symlinks, directories, escaped parents, oversized files, and invalid limits", () => {
    const root = makeRoot();
    const outside = makeRoot();
    const file = join(root, "file");
    const directory = join(root, "directory");
    const leafLink = join(root, "leaf-link");
    const parentLink = join(root, "parent-link");
    writeFileSync(file, "1234");
    mkdirSync(directory);
    symlinkSync(file, leafLink);
    symlinkSync(outside, parentLink, "dir");
    writeFileSync(join(outside, "secret"), "secret");

    expect(() => readBoundedRegularFile(leafLink, { allowedRoot: root, maxBytes: 100 })).toThrow();
    expect(() => readBoundedRegularFile(directory, { allowedRoot: root, maxBytes: 100 })).toThrow("regular file");
    expect(() => readBoundedRegularFile(join(parentLink, "secret"), { allowedRoot: root, maxBytes: 100 })).toThrow("outside");
    expect(() => readBoundedRegularFile(file, { allowedRoot: root, maxBytes: 3 })).toThrow("size limit");
    expect(() => readBoundedRegularFile(file, { allowedRoot: root, maxBytes: -1 })).toThrow(RangeError);
    expect(() => readBoundedRegularFile(file, { allowedRoot: root, maxBytes: 1.5 })).toThrow(RangeError);
  });

  it.runIf(process.platform === "linux")("rejects a FIFO without blocking the caller", async () => {
    const root = makeRoot();
    const fifo = join(root, "instructions");
    execFileSync("mkfifo", [fifo]);
    const helperUrl = pathToFileURL(resolve("src/security-files.ts")).href;
    const childSource = [
      `import { readBoundedRegularFileWithStat } from ${JSON.stringify(helperUrl)};`,
      `const fifo = ${JSON.stringify(fifo)};`,
      `const root = ${JSON.stringify(root)};`,
      "try {",
      "  readBoundedRegularFileWithStat(fifo, { allowedRoot: root, maxBytes: 1 });",
      "  process.exitCode = 1;",
      "} catch (error) {",
      "  process.exitCode = error instanceof Error && error.message === \"path is not a regular file\" ? 0 : 1;",
      "}",
    ].join("\n");
    const child = spawn(process.execPath, [
      "--experimental-strip-types",
      "--input-type=module",
      "--eval",
      childSource,
    ]);
    const result = await new Promise<number>((resolveResult, reject) => {
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        try {
          child.kill("SIGKILL");
        } catch {
          // The close handler still reports the timeout after an exit race.
        }
      }, 1_000);
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once("close", (code, signal) => {
        clearTimeout(timeout);
        if (timedOut) {
          reject(new Error("FIFO regression child timed out"));
          return;
        }
        if (signal !== null) {
          reject(new Error(`FIFO regression child exited from signal ${signal}`));
          return;
        }
        if (code === null) {
          reject(new Error("FIFO regression child exited without a status"));
          return;
        }
        resolveResult(code);
      });
    });

    expect(result).toBe(0);
  });

  it("deletes only regular files", () => {
    const root = makeRoot();
    const file = join(root, "file");
    const victim = join(root, "victim");
    const link = join(root, "link");
    writeFileSync(file, "remove");
    writeFileSync(victim, "preserve");
    symlinkSync(victim, link);

    expect(deleteRegularFile(file)).toBe(true);
    expect(deleteRegularFile(file)).toBe(false);
    expect(() => deleteRegularFile(join(victim, "child"))).toThrow();
    expect(() => deleteRegularFile(link)).toThrow("non-regular");
    expect(() => deleteRegularFile(root)).toThrow("non-regular");
    expect(readFileSync(victim, "utf-8")).toBe("preserve");
  });

  it("tightens an existing broad file after atomic replacement", () => {
    const root = makeRoot();
    const file = join(root, "file");
    writeFileSync(file, "old", { mode: 0o644 });
    chmodSync(root, 0o755);

    atomicWritePrivateFile(file, "new");

    expect(statSync(root).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("creates final destinations exclusively without replacing the first writer", () => {
    const root = makeRoot();
    const path = join(root, "exclusive");

    expect(writePrivateFileExclusive(path, "first")).toBe(true);
    expect(writePrivateFileExclusive(path, "second")).toBe(false);
    expect(readFileSync(path, "utf-8")).toBe("first");
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("atomically publishes an exclusive private file without replacing the winner", () => {
    const root = makeRoot();
    const path = join(root, "atomic-exclusive");

    expect(atomicWritePrivateFileExclusive(path, "first")).toBe(true);
    expect(atomicWritePrivateFileExclusive(path, "second")).toBe(false);
    expect(readFileSync(path, "utf-8")).toBe("first");
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("does not remove an existing exclusive-publication temp path when creation loses", () => {
    const root = makeRoot();
    const path = join(root, "atomic-exclusive");
    const tempPath = join(root, `.atomic-exclusive.${"12".repeat(12)}.tmp`);
    writeFileSync(tempPath, "concurrent owner", { mode: 0o600 });

    expect(() => atomicWritePrivateFileExclusive(path, "content", {
      random: () => Buffer.alloc(12, 0x12),
    })).toThrow();
    expect(readFileSync(tempPath, "utf-8")).toBe("concurrent owner");
    expect(existsSync(path)).toBe(false);
  });

  it("propagates atomic publication failures other than an existing destination", () => {
    const root = makeRoot();
    const path = join(root, "atomic-denied");
    const denied = Object.assign(new Error("denied"), { code: "EACCES" });

    expect(() => atomicWritePrivateFileExclusive(path, "content", {
      link: () => {
        throw denied;
      },
    })).toThrow(denied);
    expect(existsSync(path)).toBe(false);
  });

  it("completes fallible setup before atomically publishing the destination", () => {
    const root = makeRoot();
    const path = join(root, "atomic-setup-denied");
    const denied = Object.assign(new Error("denied"), { code: "EACCES" });
    const link = vi.fn();

    expect(() => atomicWritePrivateFileExclusive(path, "content", {
      chmod: () => {
        throw denied;
      },
      link,
    })).toThrow(denied);
    expect(link).not.toHaveBeenCalled();
    expect(existsSync(path)).toBe(false);
  });

  it("keeps a completed destination usable when temporary-link cleanup fails", () => {
    const root = makeRoot();
    const path = join(root, "atomic-cleanup-denied");
    const denied = Object.assign(new Error("denied"), { code: "EACCES" });

    expect(atomicWritePrivateFileExclusive(path, "content", {
      remove: () => {
        throw denied;
      },
    })).toBe(true);
    expect(readFileSync(path, "utf-8")).toBe("content");
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("reports temporary-link cleanup failures before publication", () => {
    const root = makeRoot();
    const path = join(root, "atomic-unpublished-cleanup-denied");
    const denied = Object.assign(new Error("denied"), { code: "EACCES" });

    expect(() => atomicWritePrivateFileExclusive(path, "content", {
      chmod: () => {
        throw new Error("setup failed");
      },
      remove: () => {
        throw denied;
      },
    })).toThrow(denied);
    expect(existsSync(path)).toBe(false);
  });

  it("removes an exclusively created destination when initialization fails", () => {
    const root = makeRoot();
    const path = join(root, "partial-exclusive");
    const failure = new Error("write failed");
    const deps = {
      open: vi.fn((filePath: string, flags: string | number, mode?: number) => openSync(filePath, flags, mode)),
      write: vi.fn(() => { throw failure; }),
      sync: vi.fn(),
      close: vi.fn((fd: number) => closeSync(fd)),
      unlink: vi.fn(),
    };

    expect(() => writePrivateFileExclusive(path, "content", deps as never)).toThrow(failure);
    expect(deps.close).toHaveBeenCalledOnce();
    expect(deps.unlink).toHaveBeenCalledWith(path);
  });

  it("propagates exclusive-open failures other than an existing destination", () => {
    const root = makeRoot();
    const path = join(root, "denied-exclusive");
    const denied = Object.assign(new Error("denied"), { code: "EACCES" });
    const deps = {
      open: vi.fn(() => { throw denied; }),
      write: vi.fn(),
      sync: vi.fn(),
      close: vi.fn(),
      unlink: vi.fn(),
    };

    expect(() => writePrivateFileExclusive(path, "content", deps as never)).toThrow(denied);
    expect(deps.unlink).not.toHaveBeenCalled();
  });

  it("unlinks the exclusive durable temp before the final parent sync and rejects ambiguous cleanup", () => {
    const root = makeRoot();
    const path = join(root, "durable-order");
    const events: string[] = [];
    const nodeFs = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;
    const originalUnlink = nodeFs.unlinkSync as (candidate: string) => void;
    const originalFsync = nodeFs.fsyncSync as (fd: number) => void;

    withPatchedFs("fsyncSync", ((fd: number) => {
      events.push("fsync");
      return originalFsync(fd);
    }) as never, () => withPatchedFs("unlinkSync", ((candidate: string) => {
      if (candidate.endsWith(".tmp")) events.push("unlink");
      return originalUnlink(candidate);
    }) as never, () => atomicWritePrivateFileDurable(path, "content", { requireAbsent: true })));
    expect(events.slice(-2)).toEqual(["unlink", "fsync"]);
    expect(fsStatSync(path).nlink).toBe(1);

    const failurePath = join(root, "durable-cleanup-failure");
    const failure = Object.assign(new Error("durable temp cleanup denied"), { code: "EACCES" });
    expect(() => withPatchedFs("unlinkSync", ((candidate: string) => {
      if (candidate.endsWith(".tmp")) throw failure;
      return originalUnlink(candidate);
    }) as never, () => atomicWritePrivateFileDurable(failurePath, "content", { requireAbsent: true })))
      .toThrow(failure);
    expect(fsStatSync(failurePath).nlink).toBe(2);
  });

  it("rejects lossy numeric identity during descriptor-bound consume", () => {
    const root = makeRoot();
    const path = join(root, "lossy-identity");
    writeFileSync(path, "content", { mode: 0o600 });
    const originalFstat = fstatSync;
    const originalStat = statSync;
    const originalLstat = lstatSync;
    const exactDev = 9007199254740993n;
    const exactIno = 9007199254740995n;
    const replacementDev = 9007199254740992n;
    const replacementIno = 9007199254740994n;
    const lossyDev = Number(exactDev);
    const lossyIno = Number(exactIno);

    expect(() => withPatchedFs("fstatSync", ((fd: number, options?: unknown) => {
      const stat = originalFstat(fd, options as never);
      const bigint = (options as { bigint?: boolean } | undefined)?.bigint === true;
      return Object.assign(stat, {
        dev: bigint ? exactDev : lossyDev,
        ino: bigint ? exactIno : lossyIno,
      });
    }) as never, () => withPatchedFs("statSync", ((candidate: string, options?: unknown) => {
      const stat = originalStat(candidate, options as never);
      if (candidate === path && !((options as { bigint?: boolean } | undefined)?.bigint === true)) {
        return Object.assign(stat, { dev: lossyDev, ino: lossyIno });
      }
      return stat;
    }) as never, () => withPatchedFs("lstatSync", ((candidate: string, options?: unknown) => {
      const stat = originalLstat(candidate, options as never);
      if (candidate === path) {
        const bigint = (options as { bigint?: boolean } | undefined)?.bigint === true;
        return Object.assign(stat, {
          dev: bigint ? replacementDev : lossyDev,
          ino: bigint ? replacementIno : lossyIno,
        });
      }
      return stat;
    }) as never, () => consumeBoundedRegularFile(path, {
      allowedRoot: root,
      maxBytes: 1024,
    }))))).toThrow("file changed during consume");
    expect(existsSync(path)).toBe(true);
  });


  it("fails closed on exact BigInt consume metadata mismatches", () => {
    const root = makeRoot();
    const path = join(root, "metadata-mismatch");
    writeFileSync(path, "content", { mode: 0o600 });
    const originalLstat = lstatSync;
    const run = (
      changes: Record<string, unknown>,
      options: Partial<Parameters<typeof consumeBoundedRegularFile>[1]> = {},
    ): string => withPatchedFs("lstatSync", ((candidate: string, rawOptions?: unknown) => {
      const stat = originalLstat(candidate, rawOptions as never);
      if (
        candidate === path
        && (rawOptions as { bigint?: boolean } | undefined)?.bigint === true
      ) {
        return Object.assign(stat, changes);
      }
      return stat;
    }) as never, () => consumeBoundedRegularFile(path, {
      allowedRoot: root,
      maxBytes: 1024,
      ...options,
    }));
    expect(() => run({ nlink: 2n })).toThrow("multiple hard links");
    expect(() => run({
      mode: BigInt(0o040755),
    })).toThrow("regular file");
    const uid = typeof process.getuid === "function" ? process.getuid() : 0;
    expect(() => run({ uid: BigInt(uid + 1) }, { expectedUid: uid })).toThrow("owner");
    expect(() => run({
      mode: (BigInt(fsStatSync(path).mode) & ~0o7777n) | 0o644n,
    }, { allowedModes: [0o600] })).toThrow("mode");
  });

  it("fails closed when durable destination identity is not single-link", () => {
    const root = makeRoot();
    const path = join(root, "durable-identity-mismatch");
    const originalLstat = lstatSync;
    expect(() => withPatchedFs("lstatSync", ((candidate: string, rawOptions?: unknown) => {
      const stat = originalLstat(candidate, rawOptions as never);
      if (
        candidate === path
        && (rawOptions as { bigint?: boolean } | undefined)?.bigint === true
      ) {
        return Object.assign(stat, { nlink: 2n });
      }
      return stat;
    }) as never, () => atomicWritePrivateFileDurable(path, "content", { requireAbsent: true }))).toThrow("single-link");
  });

});
