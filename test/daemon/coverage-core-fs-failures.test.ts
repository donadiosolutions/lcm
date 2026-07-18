import * as realFs from "node:fs";
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
});
