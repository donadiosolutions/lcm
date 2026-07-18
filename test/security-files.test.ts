import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  atomicWritePrivateFile,
  deleteRegularFile,
  ensurePrivateDirectory,
  readBoundedRegularFile,
  readBoundedRegularFileWithStat,
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
});
