import { afterEach, describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MissingCwdError, validateCwd } from "../../src/daemon/validate-cwd.js";

describe("validateCwd", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const tempDir of tempDirs.splice(0)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("resolves trailing slashes", () => {
    const result = validateCwd("/tmp/");
    expect(result).toBe("/tmp");
  });

  it("resolves .. components", () => {
    const result = validateCwd("/tmp/foo/../");
    expect(result).toBe("/tmp");
  });

  it("throws on relative path", () => {
    expect(() => validateCwd("relative/path")).toThrow("absolute path");
  });

  it("throws on empty string", () => {
    expect(() => validateCwd("")).toThrow();
  });

  it("throws if path does not exist", () => {
    expect(() => validateCwd("/nonexistent/path/that/does/not/exist")).toThrow();
  });

  it("permits a normalized missing path only for recovery-aware callers", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-validate-cwd-missing-"));
    tempDirs.push(tempDir);
    const missing = join(tempDir, "missing");

    expect(validateCwd(missing, { allowMissing: true })).toBe(missing);
  });

  it("treats an ENOTDIR ancestor as a missing cwd", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-validate-cwd-enotdir-"));
    tempDirs.push(tempDir);
    const ancestor = join(tempDir, "work");
    writeFileSync(ancestor, "not a directory");

    expect(() => validateCwd(join(ancestor, "project"))).toThrow(MissingCwdError);
  });

  it("keeps an existing regular-file leaf invalid", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-validate-cwd-file-"));
    tempDirs.push(tempDir);
    const file = join(tempDir, "project");
    writeFileSync(file, "not a directory");

    expect(() => validateCwd(file)).toThrow("cwd must be a directory");
  });

});
