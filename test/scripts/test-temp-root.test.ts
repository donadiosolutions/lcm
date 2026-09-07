import { lstatSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  LCM_TEST_HARNESS_ORIGINAL_TEMP_PARENTS,
  candidateTemporaryParents,
  canonicalCandidateParents,
  captureOriginalTemporaryParents,
  createTestTempDirectory,
  inspectGitFreeParent,
  nonLivePlatformFallbackParents,
  parseOriginalTemporaryParents,
  serializeOriginalTemporaryParents,
  selectTestTempParent,
} from "../../scripts/test-temp-root.mjs";

const absent = () => {
  throw Object.assign(new Error("missing"), { code: "ENOENT" });
};

describe("test temporary parent selector", () => {
  it("rejects every successful marker probe", () => {
    for (const kind of ["directory", "file", "symlink", "dangling"]) {
      const result = inspectGitFreeParent(`/fixture/${kind}/leaf`, {
        realpath: (path: string) => path,
        markerProbe: () => ({ kind }),
      });
      expect(result.usable).toBe(false);
      expect(result.reason).toBe("marker");
    }
  });

  it("rejects a real dangling .git symlink in a private fixture", () => {
    const fixture = mkdtempSync(join(tmpdir(), "lcm-bug-840-dangling-"));
    const marker = join(fixture, ".git");
    symlinkSync(join(fixture, "missing-target"), marker);
    try {
      const result = inspectGitFreeParent(fixture, {});
      expect(result.usable).toBe(false);
      expect(result.reason).toBe("marker");
      expect(lstatSync(marker).isSymbolicLink()).toBe(true);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("walks canonical ancestors and treats non-ENOENT probes as unverifiable", () => {
    const probes: string[] = [];
    const result = inspectGitFreeParent("/lexical/leaf", {
      realpath: () => "/real/leaf",
      markerProbe: (path: string) => {
        probes.push(path);
        if (path === "/real/.git") throw Object.assign(new Error("denied"), { code: "EACCES" });
        return absent();
      },
    });
    expect(result.usable).toBe(false);
    expect(result.reason).toBe("unverifiable");
    expect(probes).toContain("/real/.git");
  });

  it("deduplicates canonical aliases and advances after creation failure", () => {
    const createDirectory = vi.fn()
      .mockImplementationOnce(() => { throw new Error("full"); })
      .mockReturnValueOnce("/clean/lcm-test-root");
    const result = createTestTempDirectory({
      environment: {},
      candidateParents: ["/first", "/second"],
      realpath: (path: string) => path,
      markerProbe: absent,
      createDirectory,
      secureDirectory: vi.fn(),
    });
    expect(result).toEqual({ root: "/clean/lcm-test-root", parent: "/second" });
    expect(createDirectory).toHaveBeenCalledTimes(2);
  });

  it("cleans a failed secure root and advances automatically", () => {
    const removeDirectory = vi.fn();
    const secureFailure = new Error("chmod denied");
    const createDirectory = vi.fn()
      .mockReturnValueOnce("/first/lcm-test-root")
      .mockReturnValueOnce("/second/lcm-test-root");
    const secureDirectory = vi.fn()
      .mockImplementationOnce(() => { throw secureFailure; })
      .mockImplementation(() => {});
    const result = createTestTempDirectory({
      environment: {},
      candidateParents: ["/first", "/second"],
      realpath: (path: string) => path,
      markerProbe: absent,
      createDirectory,
      secureDirectory,
      removeDirectory,
    });
    expect(result.parent).toBe("/second");
    expect(removeDirectory).toHaveBeenCalledWith("/first/lcm-test-root");
    expect(secureDirectory).toHaveBeenCalledTimes(2);
  });

  it("cleans an explicit failed secure root and preserves its cause", () => {
    const removeDirectory = vi.fn();
    const secureFailure = new Error("chmod denied");
    let thrown: unknown;
    try {
      createTestTempDirectory({
        environment: { LCM_TEST_VITEST_RUNTIME_ROOT_PARENT: "/explicit" },
        realpath: (path: string) => path,
        markerProbe: absent,
        createDirectory: vi.fn(() => "/explicit/lcm-test-root"),
        secureDirectory: vi.fn(() => { throw secureFailure; }),
        removeDirectory,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ cause: secureFailure });
    expect((thrown as Error).message).toMatch(/LCM_TEST_VITEST_RUNTIME_ROOT_PARENT/iu);
    expect(removeDirectory).toHaveBeenCalledWith("/explicit/lcm-test-root");
  });

  it("does not fall back from an explicit contaminated parent", () => {
    expect(() => selectTestTempParent({
      environment: { LCM_TEST_VITEST_RUNTIME_ROOT_PARENT: "/explicit" },
      realpath: (path: string) => path,
      markerProbe: () => ({ present: true }),
    })).toThrow(/LCM_TEST_VITEST_RUNTIME_ROOT_PARENT/iu);
  });

  it.each([
    ["LCM_TEST_VITEST_RUNTIME_ROOT_PARENT", "relative", "linux"],
    ["LCM_TEST_HARNESS_TMPDIR", "relative", "linux"],
    ["LCM_TEST_VITEST_RUNTIME_ROOT_PARENT", "C:relative", "win32"],
    ["LCM_TEST_HARNESS_TMPDIR", "C:relative", "win32"],
    ["LCM_TEST_VITEST_RUNTIME_ROOT_PARENT", "\\tmp", "win32"],
    ["LCM_TEST_HARNESS_TMPDIR", "\\tmp", "win32"],
    ["LCM_TEST_VITEST_RUNTIME_ROOT_PARENT", "/tmp", "win32"],
    ["LCM_TEST_HARNESS_TMPDIR", "/tmp", "win32"],
    ["LCM_TEST_VITEST_RUNTIME_ROOT_PARENT", "", "linux"],
    ["LCM_TEST_HARNESS_TMPDIR", "/bad\0path", "linux"],
  ])("rejects invalid explicit %s value %j before probing", (variable, value, platformName) => {
    for (const operation of [selectTestTempParent, createTestTempDirectory]) {
      const temporaryRoot = vi.fn(() => "/automatic");
      const realpath = vi.fn((path: string) => path);
      const markerProbe = vi.fn(absent);
      const createDirectory = vi.fn(() => "/fallback/lcm-test-root");

      expect(() => operation({
        environment: { [variable]: value },
        platformName,
        candidateParents: ["/fallback"],
        temporaryRoot,
        realpath,
        markerProbe,
        createDirectory,
        secureDirectory: vi.fn(),
      })).toThrow(new RegExp(`${variable}.*absolute`, "iu"));
      expect(temporaryRoot).not.toHaveBeenCalled();
      expect(realpath).not.toHaveBeenCalled();
      expect(markerProbe).not.toHaveBeenCalled();
      expect(createDirectory).not.toHaveBeenCalled();
    }
  });

  it("keeps the selected explicit variable authoritative", () => {
    expect(() => selectTestTempParent({
      environment: {
        LCM_TEST_VITEST_RUNTIME_ROOT_PARENT: "relative",
        LCM_TEST_HARNESS_TMPDIR: "/valid-harness-parent",
      },
      candidateParents: ["/valid-harness-parent"],
      realpath: vi.fn((path: string) => path),
      markerProbe: vi.fn(absent),
    })).toThrow(/LCM_TEST_VITEST_RUNTIME_ROOT_PARENT.*absolute/iu);
  });

  it("skips relative automatic and seam candidates without probing them", () => {
    for (const operation of [selectTestTempParent, createTestTempDirectory]) {
      const realpath = vi.fn((path: string) => path);
      const createDirectory = vi.fn(() => "/absolute/lcm-test-root");
      const result = operation({
        environment: {},
        candidateParents: ["relative", "/absolute"],
        realpath,
        markerProbe: absent,
        createDirectory,
        secureDirectory: vi.fn(),
      });

      if (operation === selectTestTempParent) {
        expect(result).toBe("/absolute");
      } else {
        expect(result).toEqual({ root: "/absolute/lcm-test-root", parent: "/absolute" });
      }
      expect(realpath).toHaveBeenCalledTimes(1);
      expect(realpath).toHaveBeenCalledWith("/absolute");
    }

    const realpath = vi.fn((path: string) => path);
    expect(selectTestTempParent({
      environment: {},
      temporaryRoot: () => "relative",
      realpath,
      markerProbe: absent,
    })).toBe("/var/tmp");
    expect(realpath).not.toHaveBeenCalledWith("relative");
  });

  it("skips Windows root-relative candidates and uses a fully qualified successor", () => {
    for (const operation of [selectTestTempParent, createTestTempDirectory]) {
      const realpath = vi.fn((path: string) => path);
      const markerProbe = vi.fn(absent);
      const createDirectory = vi.fn(() => "C:\\absolute\\lcm-test-root");
      const result = operation({
        environment: {},
        platformName: "win32",
        candidateParents: ["\\tmp", "/tmp", "C:\\absolute"],
        realpath,
        markerProbe,
        createDirectory,
        secureDirectory: vi.fn(),
      });

      if (operation === selectTestTempParent) {
        expect(result).toBe("C:\\absolute");
      } else {
        expect(result).toEqual({
          root: "C:\\absolute\\lcm-test-root",
          parent: "C:\\absolute",
        });
      }
      expect(realpath).toHaveBeenCalledTimes(1);
      expect(realpath).toHaveBeenCalledWith("C:\\absolute");
      expect(markerProbe).not.toHaveBeenCalledWith("\\tmp\\.git");
      expect(markerProbe).not.toHaveBeenCalledWith("\\.git");
    }
  });

  it.each([
    ["C:\\Harness", "win32"],
    ["C:/Harness", "win32"],
    ["\\\\server\\share", "win32"],
    ["/tmp", "linux"],
  ])("accepts fully qualified %s parent on %s", (parent, platformName) => {
    const root = platformName === "win32"
      ? `${parent}\\lcm-test-root`
      : `${parent}/lcm-test-root`;
    expect(selectTestTempParent({
      environment: { LCM_TEST_HARNESS_TMPDIR: parent },
      platformName,
      realpath: (path: string) => path,
      markerProbe: absent,
    })).toBe(parent);
    expect(createTestTempDirectory({
      environment: { LCM_TEST_HARNESS_TMPDIR: parent },
      platformName,
      realpath: (path: string) => path,
      markerProbe: absent,
      createDirectory: () => root,
      secureDirectory: vi.fn(),
    })).toEqual({ root, parent });
  });

  it("reports all invalid candidates without probing them", () => {
    for (const operation of [selectTestTempParent, createTestTempDirectory]) {
      const realpath = vi.fn((path: string) => path);
      const markerProbe = vi.fn(absent);
      const createDirectory = vi.fn(() => "/unused/lcm-test-root");

      expect(() => operation({
        environment: {},
        candidateParents: ["relative", ""],
        realpath,
        markerProbe,
        createDirectory,
        secureDirectory: vi.fn(),
      })).toThrow(/relative \(invalid\).* \(invalid\)/u);
      expect(realpath).not.toHaveBeenCalled();
      expect(markerProbe).not.toHaveBeenCalled();
      expect(createDirectory).not.toHaveBeenCalled();
    }
  });

  it("keeps nested allocations on the stable handoff parent", () => {
    const createDirectory = vi.fn(() => "/stable/lcm-postgresql-harness-child");
    const result = createTestTempDirectory({
      environment: {
        TMPDIR: "/worker-scratch",
        LCM_TEST_HARNESS_TMPDIR: "/stable",
      },
      prefix: "lcm-postgresql-harness-",
      realpath: (path: string) => path,
      markerProbe: absent,
      createDirectory,
      secureDirectory: vi.fn(),
    });
    expect(result.parent).toBe("/stable");
    expect(createDirectory).toHaveBeenCalledWith("/stable/lcm-postgresql-harness-");
  });

  it("walks real ancestors instead of lexical symlink paths", () => {
    const realChain = inspectGitFreeParent("/lexical/link", {
      realpath: () => "/real/leaf",
      markerProbe: (path: string) => path === "/real/.git" ? {} : absent(),
    });
    expect(realChain.reason).toBe("marker");

    const lexicalOnly = inspectGitFreeParent("/lexical/link", {
      realpath: () => "/real/leaf",
      markerProbe: (path: string) => path === "/lexical/.git" ? {} : absent(),
    });
    expect(lexicalOnly.usable).toBe(true);
    expect(lexicalOnly.parent).toBe("/real/leaf");
  });

  it("advances after a non-ENOENT probe error and reports exhausted reasons", () => {
    const createDirectory = vi.fn(() => "/second/lcm-test-root");
    const markerProbe = (path: string) => {
      if (path === "/first/.git") throw Object.assign(new Error("denied"), { code: "EACCES" });
      if (path === "/marker/.git") return {};
      return absent();
    };
    const result = createTestTempDirectory({
      environment: {},
      candidateParents: ["/first", "/second"],
      realpath: (path: string) => path,
      markerProbe,
      createDirectory,
      secureDirectory: vi.fn(),
    });
    expect(result.parent).toBe("/second");
    expect(createDirectory).toHaveBeenCalledTimes(1);
    expect(() => selectTestTempParent({
      environment: {},
      candidateParents: ["/marker", "/denied"],
      realpath: (path: string) => path,
      markerProbe: (path: string) => {
        if (path === "/marker/.git") return {};
        if (path === "/denied/.git") throw Object.assign(new Error("denied"), { code: "EACCES" });
        return absent();
      },
    })).toThrow(/\/marker \(marker\).*\/denied \(unverifiable\)/u);
  });

  it("deduplicates canonical aliases in the selection loop", () => {
    const createDirectory = vi.fn(() => "/canonical/lcm-test-root");
    const result = createTestTempDirectory({
      environment: {},
      candidateParents: ["/alias", "/canonical"],
      realpath: (path: string) => path === "/alias" ? "/canonical" : path,
      markerProbe: absent,
      createDirectory,
      secureDirectory: vi.fn(),
    });
    expect(result.parent).toBe("/canonical");
    expect(createDirectory).toHaveBeenCalledTimes(1);
  });

  it("derives and deduplicates Windows candidates through injected environment", () => {
    expect(candidateTemporaryParents({
      TEMP: "C:\\Temp",
      TMP: "C:\\Temp",
      SystemRoot: "C:\\Windows",
    }, "win32", undefined, () => "C:\\Temp")).toEqual([
      "C:\\Temp",
      "C:\\Windows\\Temp",
    ]);
  });

  it("uses only the first configured Windows system root for non-live fallbacks", () => {
    expect(nonLivePlatformFallbackParents({
      SystemRoot: "C:\\Windows",
      WINDIR: "D:\\Windows",
    }, "win32")).toEqual(["C:\\Windows\\Temp"]);
    expect(nonLivePlatformFallbackParents({
      WINDIR: "D:\\Windows",
    }, "win32")).toEqual(["D:\\Windows\\Temp"]);
  });

  it("captures a bounded original parent snapshot and preserves existing bytes", () => {
    const environment: NodeJS.ProcessEnv = {
      TEMP: "/original-temp",
      TMP: "/original-tmp",
    };
    captureOriginalTemporaryParents(environment, "linux", () => "/original-root");
    expect(environment[LCM_TEST_HARNESS_ORIGINAL_TEMP_PARENTS]).toBe(
      JSON.stringify({
        version: 1,
        parents: ["/original-root", "/var/tmp", "/tmp"],
      }),
    );
    const snapshot = environment[LCM_TEST_HARNESS_ORIGINAL_TEMP_PARENTS];
    captureOriginalTemporaryParents(environment, "linux", () => {
      throw new Error("an existing snapshot must not be recaptured");
    });
    expect(environment[LCM_TEST_HARNESS_ORIGINAL_TEMP_PARENTS]).toBe(snapshot);
  });

  it("captures native Windows TEMP and TMP parents before live rewrites", () => {
    const environment: NodeJS.ProcessEnv = {
      TEMP: "C:\\OriginalTemp",
      TMP: "D:\\OriginalTmp",
    };
    const temporaryRoot = vi.fn(() => "E:\\InjectedRoot");
    const captured = captureOriginalTemporaryParents(environment, "win32", temporaryRoot);
    const snapshot = environment[LCM_TEST_HARNESS_ORIGINAL_TEMP_PARENTS];

    expect(captured).toEqual(["E:\\InjectedRoot", "C:\\OriginalTemp", "D:\\OriginalTmp"]);
    expect(snapshot).toBe(JSON.stringify({
      version: 1,
      parents: ["E:\\InjectedRoot", "C:\\OriginalTemp", "D:\\OriginalTmp"],
    }));

    environment.TEMP = "C:\\WorkerScratch";
    environment.TMP = "C:\\WorkerScratch";
    const recapture = captureOriginalTemporaryParents(environment, "win32", () => {
      throw new Error("an existing snapshot must not recapture live Windows roots");
    });

    expect(recapture).toBeUndefined();
    expect(environment[LCM_TEST_HARNESS_ORIGINAL_TEMP_PARENTS]).toBe(snapshot);
    expect(parseOriginalTemporaryParents(snapshot, "win32")).toEqual([
      "E:\\InjectedRoot",
      "C:\\OriginalTemp",
      "D:\\OriginalTmp",
    ]);
    expect(parseOriginalTemporaryParents(snapshot, "win32")).not.toContain("C:\\WorkerScratch");
  });

  it("filters unqualified Windows parents while capturing the snapshot", () => {
    const environment: NodeJS.ProcessEnv = {
      TEMP: "/root-relative",
      TMP: "C:drive-relative",
    };

    expect(captureOriginalTemporaryParents(
      environment,
      "win32",
      () => "\\root-relative",
    )).toEqual([]);
    expect(environment[LCM_TEST_HARNESS_ORIGINAL_TEMP_PARENTS]).toBe(
      JSON.stringify({ version: 1, parents: [] }),
    );
  });

  it.each([
    "\\root-relative",
    "/root-relative",
    "C:drive-relative",
  ])("rejects unqualified Windows snapshot parent %j", (parent) => {
    expect(serializeOriginalTemporaryParents([parent], "win32")).toBeUndefined();
    expect(parseOriginalTemporaryParents(JSON.stringify({
      version: 1,
      parents: ["C:\\Qualified", parent],
    }), "win32")).toBeUndefined();
  });

  it.each([
    "C:\\Qualified",
    "C:/Qualified",
    "\\\\server\\share\\Qualified",
    "//server/share/Qualified",
  ])("retains fully qualified Windows snapshot parent %j", (parent) => {
    const serialized = JSON.stringify({ version: 1, parents: [parent] });
    expect(serializeOriginalTemporaryParents([parent], "win32")).toBe(serialized);
    expect(parseOriginalTemporaryParents(serialized, "win32")).toEqual([parent]);
  });

  it.each(["/tmp", "//tmp"])("retains POSIX snapshot parent %j", (parent) => {
    const serialized = JSON.stringify({ version: 1, parents: [parent] });
    expect(serializeOriginalTemporaryParents([parent], "linux")).toBe(serialized);
    expect(parseOriginalTemporaryParents(serialized, "linux")).toEqual([parent]);
  });

  it.each([
    "",
    "not-json",
    JSON.stringify({ version: 2, parents: ["/tmp"] }),
    JSON.stringify({ version: 1, parents: ["relative"] }),
    JSON.stringify({ version: 1, parents: ["/tmp", "\0bad"] }),
    JSON.stringify({ version: 1, parents: ["/tmp"], extra: true }),
    JSON.stringify({ version: 1, parents: Array.from({ length: 9 }, (_, i) => `/p${i}`) }),
    `{"version":1,"parents":["/${"x".repeat(8_200)}"]}`,
  ])("treats malformed original parent snapshot %j as missing", (value) => {
    expect(parseOriginalTemporaryParents(value, "linux")).toBeUndefined();
  });

  it("allows a valid empty snapshot and rejects unsafe serialization entries", () => {
    const empty = JSON.stringify({ version: 1, parents: [] });
    expect(parseOriginalTemporaryParents(empty, "linux")).toEqual([]);
    expect(serializeOriginalTemporaryParents([], "linux")).toBe(empty);
    expect(serializeOriginalTemporaryParents(["relative"], "linux")).toBeUndefined();
    expect(serializeOriginalTemporaryParents(["C:\\Temp"], "linux")).toBeUndefined();
    expect(parseOriginalTemporaryParents(JSON.stringify({ version: 1, parents: ["C:\\Temp"] }), "win32"))
      .toEqual(["C:\\Temp"]);
  });

  it("reports exhausted Windows candidates with marker reasons", () => {
    const environment = {
      TEMP: "C:\\Temp",
      TMP: "D:\\Scratch",
      SystemRoot: "C:\\Windows",
    };
    const temporaryRoot = () => "E:\\Temp";
    const candidates = candidateTemporaryParents(environment, "win32", undefined, temporaryRoot);
    expect(() => selectTestTempParent({
      environment,
      platformName: "win32",
      temporaryRoot,
      realpath: (path: string) => path,
      markerProbe: () => ({ present: true }),
    })).toThrow(new RegExp(candidates
      .map((candidate) => `${candidate.replaceAll("\\", "\\\\")} \\(marker\\)`)
      .join(".*"), "u"));
  });

  it("authenticates canonical candidate parents without requiring them to be clean now", () => {
    expect(canonicalCandidateParents({
      candidateParents: ["/tmp", "/alias", "/missing"],
      realpath: (path: string) => {
        if (path === "/missing") throw new Error("gone");
        return path === "/alias" ? "/tmp" : path;
      },
    })).toEqual(["/tmp"]);
  });

  it("skips empty, relative, and NUL candidate parents before realpath", () => {
    const resolved: string[] = [];
    expect(canonicalCandidateParents({
      platformName: "linux",
      candidateParents: ["", "relative", "/valid", "/bad\0path"],
      realpath: (path: string) => {
        resolved.push(path);
        return path;
      },
    })).toEqual(["/valid"]);
    expect(resolved).toEqual(["/valid"]);
  });

  it("does not resolve unqualified Windows candidate parents", () => {
    const realpath = vi.fn((path: string) => path);
    expect(canonicalCandidateParents({
      platformName: "win32",
      candidateParents: [
        "\\root-relative",
        "/root-relative",
        "C:drive-relative",
        "C:\\Qualified",
        "\\\\server\\share\\Qualified",
      ],
      realpath,
    })).toEqual(["C:\\Qualified", "\\\\server\\share\\Qualified"]);
    expect(realpath.mock.calls.map(([path]) => path)).toEqual([
      "C:\\Qualified",
      "\\\\server\\share\\Qualified",
    ]);
  });
});
