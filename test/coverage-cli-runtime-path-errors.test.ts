import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const renameControl = vi.hoisted(() => ({ error: undefined as NodeJS.ErrnoException | undefined }));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    renameSync: (from: string, to: string): void => {
      if (renameControl.error) throw renameControl.error;
      actual.renameSync(from, to);
    },
  };
});

import { legacyLcmHomeDir, lcmHomeDir, migrateLegacyHomeIfNeeded } from "../src/runtime-paths.js";

const homes: string[] = [];
afterEach(() => {
  renameControl.error = undefined;
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function legacyHome(): { home: string; legacy: string; next: string } {
  const home = mkdtempSync(join(tmpdir(), "lcm-runtime-errors-"));
  homes.push(home);
  const legacy = legacyLcmHomeDir(home);
  mkdirSync(legacy, { recursive: true });
  writeFileSync(join(legacy, "value.txt"), "value");
  return { home, legacy, next: lcmHomeDir(home) };
}

describe("runtime home rename failures", () => {
  it("falls back to copy-and-remove for cross-device renames", () => {
    const paths = legacyHome();
    renameControl.error = Object.assign(new Error("cross-device"), { code: "EXDEV" });
    expect(migrateLegacyHomeIfNeeded(paths.home)).toEqual({
      migrated: true,
      from: paths.legacy,
      to: paths.next,
    });
  });

  it("rethrows non-cross-device rename failures", () => {
    const paths = legacyHome();
    renameControl.error = Object.assign(new Error("denied"), { code: "EACCES" });
    expect(() => migrateLegacyHomeIfNeeded(paths.home)).toThrow("denied");
  });
});
