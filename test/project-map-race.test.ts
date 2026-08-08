import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("project map file races", () => {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  const tempHomes: string[] = [];

  afterEach(() => {
    vi.doUnmock("node:fs");
    vi.resetModules();
    for (const tempHome of tempHomes.splice(0)) {
      rmSync(tempHome, { recursive: true, force: true });
    }
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
  });

  it("treats a disappearing map.json as absent", async () => {
    const tempHome = mkdtempSync(join(tmpdir(), "lcm-project-map-race-home-"));
    tempHomes.push(tempHome);
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;

    const canonical = join(tempHome, "canonical");
    mkdirSync(canonical, { recursive: true });
    const mapPath = join(tempHome, ".lcm", "map.json");
    mkdirSync(join(tempHome, ".lcm"), { recursive: true });
    writeFileSync(mapPath, "{}\n", "utf-8");

    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    let disappeared = false;
    const lstatSync = vi.fn((path: import("node:fs").PathLike) => {
      const stat = actualFs.lstatSync(path);
      if (!disappeared && typeof path === "string" && path === mapPath) {
        disappeared = true;
        actualFs.rmSync(path);
      }
      return stat;
    });
    const openSync = vi.fn((path: import("node:fs").PathLike, flags: import("node:fs").OpenMode) => {
      if (typeof path === "string" && path.endsWith(join(".lcm", "map.json"))) {
        const err = new Error("map.json disappeared") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      return actualFs.openSync(path, flags);
    });

    vi.doMock("node:fs", () => ({
      ...actualFs,
      lstatSync,
      openSync,
    }));

    const { projectMapPath, resolveProjectIdentity } = await import("../src/project-map.js");

    const identity = resolveProjectIdentity(canonical);

    expect(identity.canonical).toBe(canonical);
    expect(actualFs.existsSync(projectMapPath())).toBe(true);
  });

  it("propagates non-ENOENT map read failures", async () => {
    const tempHome = mkdtempSync(join(tmpdir(), "lcm-project-map-error-home-"));
    tempHomes.push(tempHome);
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    const canonical = join(tempHome, "canonical");
    mkdirSync(canonical, { recursive: true });

    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.doMock("node:fs", () => ({
      ...actualFs,
      openSync: vi.fn(() => {
        const error = new Error("permission denied") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      }),
    }));
    const { resolveProjectIdentity } = await import("../src/project-map.js");
    expect(() => resolveProjectIdentity(canonical)).toThrow("permission denied");
  });

  it.each([
    ["disappearance", "ENOENT", undefined],
    ["permission failure", "EACCES", "permission denied"],
  ] as const)("handles a %s while creating a map backup", async (_label, code, message) => {
    const tempHome = mkdtempSync(join(tmpdir(), "lcm-project-map-backup-race-home-"));
    tempHomes.push(tempHome);
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    const canonical = join(tempHome, "canonical");
    const alias = join(tempHome, "alias");
    mkdirSync(canonical, { recursive: true });
    mkdirSync(alias, { recursive: true });
    const hash = createHash("sha256").update(canonical).digest("hex");
    const mapPath = join(tempHome, ".lcm", "map.json");
    mkdirSync(join(tempHome, ".lcm"), { recursive: true, mode: 0o700 });
    writeFileSync(mapPath, `${JSON.stringify({ [hash]: { canonical, aliases: [] } })}\n`, { mode: 0o600 });

    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    let mapOpens = 0;
    vi.doMock("node:fs", () => ({
      ...actualFs,
      openSync: (path: import("node:fs").PathLike, flags: import("node:fs").OpenMode) => {
        if (typeof path === "string" && path === mapPath) {
          mapOpens += 1;
          if (mapOpens === 4) {
            const error = new Error(message ?? "map disappeared") as NodeJS.ErrnoException;
            error.code = code;
            throw error;
          }
        }
        return actualFs.openSync(path, flags);
      },
    }));
    const { addProjectAlias } = await import("../src/project-map.js");
    if (code === "ENOENT") {
      expect(() => addProjectAlias(alias, { canonical })).not.toThrow();
    } else {
      expect(() => addProjectAlias(alias, { canonical })).toThrow("permission denied");
    }
  });
});
