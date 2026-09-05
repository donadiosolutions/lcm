import { describe, expect, it, vi } from "vitest";
import {
  candidateTemporaryParents,
  canonicalCandidateParents,
  createTestTempDirectory,
  inspectGitFreeParent,
  selectTestTempParent,
} from "../../scripts/test-temp-root.mjs";

const absent = () => {
  throw Object.assign(new Error("missing"), { code: "ENOENT" });
};

describe("test temporary parent selector", () => {
  it("rejects every marker type, including a dangling symlink", () => {
    for (const kind of ["directory", "file", "symlink", "dangling"]) {
      const result = inspectGitFreeParent(`/fixture/${kind}/leaf`, {
        realpath: (path: string) => path,
        markerProbe: () => ({ kind }),
      });
      expect(result.usable).toBe(false);
      expect(result.reason).toBe("marker");
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

  it("does not fall back from an explicit contaminated parent", () => {
    expect(() => selectTestTempParent({
      environment: { LCM_TEST_VITEST_RUNTIME_ROOT_PARENT: "/explicit" },
      realpath: (path: string) => path,
      markerProbe: () => ({ present: true }),
    })).toThrow(/LCM_TEST_VITEST_RUNTIME_ROOT_PARENT/iu);
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

  it("authenticates canonical candidate parents without requiring them to be clean now", () => {
    expect(canonicalCandidateParents({
      candidateParents: ["/tmp", "/alias", "/missing"],
      realpath: (path: string) => {
        if (path === "/missing") throw new Error("gone");
        return path === "/alias" ? "/tmp" : path;
      },
    })).toEqual(["/tmp"]);
  });
});
