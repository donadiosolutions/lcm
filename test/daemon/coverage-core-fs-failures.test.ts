import * as realFs from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.doUnmock("node:fs");
  vi.resetModules();
  vi.restoreAllMocks();
});

describe("daemon filesystem failure boundaries", () => {
  it("falls back to the unresolved transcript path when no ancestor can be canonicalized", async () => {
    vi.resetModules();
    vi.doMock("node:fs", () => ({
      ...realFs,
      lstatSync: vi.fn(() => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); }),
      realpathSync: vi.fn(() => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); }),
    }));
    const { isSafeTranscriptPath } = await import("../../src/daemon/project.js");
    expect(isSafeTranscriptPath("/totally/missing/transcript.jsonl", "/also/missing")).toBe(false);
  });

  it("returns the resolved cwd when final realpath canonicalization fails", async () => {
    vi.resetModules();
    vi.doMock("node:fs", () => ({
      ...realFs,
      statSync: vi.fn(() => ({ isDirectory: () => true })),
      realpathSync: vi.fn(() => { throw new Error("realpath failed"); }),
    }));
    const { validateCwd } = await import("../../src/daemon/validate-cwd.js");
    expect(validateCwd("/absolute/path")).toBe("/absolute/path");
  });

  it("sanitizes Error and non-Error filesystem failures", async () => {
    for (const [thrown, expected] of [
      [new Error("EACCES /secret/private"), "EACCES <path>"],
      ["denied", "filesystem error"],
    ] as const) {
      vi.resetModules();
      vi.doMock("node:fs", () => ({ ...realFs, statSync: vi.fn(() => { throw thrown; }) }));
      const { validateCwd } = await import("../../src/daemon/validate-cwd.js");
      expect(() => validateCwd("/secret/private")).toThrow(expected);
      try {
        validateCwd("/secret/private");
      } catch (error) {
        expect((error as Error).message).not.toContain("/secret/private");
      }
    }
  });

  it("tries both package candidates and returns undefined when none has a version", async () => {
    vi.resetModules();
    const readFileSync = vi.fn()
      .mockReturnValueOnce("not json")
      .mockReturnValueOnce(JSON.stringify({ version: 42 }));
    vi.doMock("node:fs", () => ({ ...realFs, readFileSync }));
    const { PKG_VERSION } = await import("../../src/daemon/version.js");
    expect(PKG_VERSION).toBeUndefined();
    expect(readFileSync).toHaveBeenCalledTimes(2);
  });

  it("accepts the second package candidate after an empty first version", async () => {
    vi.resetModules();
    const readFileSync = vi.fn()
      .mockReturnValueOnce(JSON.stringify({ version: "" }))
      .mockReturnValueOnce(JSON.stringify({ version: "9.8.7" }));
    vi.doMock("node:fs", () => ({ ...realFs, readFileSync }));
    const { PKG_VERSION } = await import("../../src/daemon/version.js");
    expect(PKG_VERSION).toBe("9.8.7");
  });

  it("captures the executing lcm.mjs entrypoint and only hashes a readable packaged runtime", async () => {
    vi.resetModules();
    const runtimeDir = realFs.mkdtempSync(join(tmpdir(), "lcm-runtime-digest-"));
    const runtimePath = join(runtimeDir, "lcm.mjs");
    const runtime = "packaged runtime bytes";
    realFs.writeFileSync(runtimePath, runtime);
    try {
      const {
        PACKAGED_RUNTIME_ENTRYPOINT,
        RUNTIME_DIGEST,
        packagedRuntimeDigest,
        packagedRuntimeEntrypoint,
      } = await import("../../src/daemon/version.js");
      expect(PACKAGED_RUNTIME_ENTRYPOINT).toBeUndefined();
      expect(RUNTIME_DIGEST).toBeUndefined();
      expect(packagedRuntimeEntrypoint("https://example.test/lcm.mjs")).toBeUndefined();
      expect(packagedRuntimeEntrypoint(pathToFileURL(join(runtimeDir, "version.js")).href)).toBeUndefined();
      expect(packagedRuntimeEntrypoint(pathToFileURL(runtimePath).href)).toBe(runtimePath);
      expect(packagedRuntimeDigest(pathToFileURL(join(runtimeDir, "version.js")).href)).toBeUndefined();
      expect(packagedRuntimeDigest(pathToFileURL(join(runtimeDir, "missing", "lcm.mjs")).href)).toBeUndefined();
      expect(packagedRuntimeDigest(pathToFileURL(runtimePath).href)).toBe(
        createHash("sha256").update(runtime).digest("hex"),
      );
    } finally {
      realFs.rmSync(runtimeDir, { recursive: true, force: true });
    }
  });
});
