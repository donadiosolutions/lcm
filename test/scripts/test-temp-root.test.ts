import { lstatSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("does not fall back from an explicit contaminated parent", () => {
    expect(() => selectTestTempParent({
      environment: { LCM_TEST_VITEST_RUNTIME_ROOT_PARENT: "/explicit" },
      realpath: (path: string) => path,
      markerProbe: () => ({ present: true }),
    })).toThrow(/LCM_TEST_VITEST_RUNTIME_ROOT_PARENT/iu);
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
