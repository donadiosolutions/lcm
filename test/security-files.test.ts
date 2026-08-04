import { execFileSync, spawn } from "node:child_process";
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
  openSync,
  linkSync,
  realpathSync,
  statSync as fsStatSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, parse, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  atomicWritePrivateFile,
  atomicWritePrivateFileExclusive,
  copyRegularFilePrivateExclusive,
  consumeBoundedRegularFile,
  deleteRegularFile,
  ensurePrivateDirectory,
  readBoundedRegularFile,
  readBoundedRegularFileWithStat,
  writePrivateFileExclusive,
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

describe("private filesystem primitives", () => {
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
    expect(() => consumeBoundedRegularFile(path, {
      allowedRoot: root,
      maxBytes: 1024,
      _beforeUnlinkForTesting: () => {
        rmSync(path);
        symlinkSync(replacement, path);
      },
    })).toThrow("changed");
    expect(readFileSync(path)).toEqual(readFileSync(replacement));

    rmSync(path);
    writeFileSync(path, "secret", { mode: 0o600 });
    const hardlink = join(root, "hardlink");
    linkSync(path, hardlink);
    expect(() => consumeBoundedRegularFile(path, { allowedRoot: root, maxBytes: 1024 })).toThrow("changed");
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
      open: vi.fn(() => 23),
      write: vi.fn(() => { throw failure; }),
      sync: vi.fn(),
      close: vi.fn(),
      unlink: vi.fn(),
    };

    expect(() => writePrivateFileExclusive(path, "content", deps as never)).toThrow(failure);
    expect(deps.close).toHaveBeenCalledWith(23);
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
});
