import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
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

    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const readFileSync = vi.fn((path: import("node:fs").PathOrFileDescriptor, options?: unknown) => {
      if (typeof path === "string" && path.endsWith(join(".lcm", "map.json"))) {
        const err = new Error("map.json disappeared") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      return actualFs.readFileSync(path, options as BufferEncoding);
    });

    vi.doMock("node:fs", () => ({
      ...actualFs,
      readFileSync,
    }));

    const { projectMapPath, resolveProjectIdentity } = await import("../src/project-map.js");

    const identity = resolveProjectIdentity(canonical);

    expect(identity.canonical).toBe(canonical);
    expect(readFileSync).toHaveBeenCalledWith(projectMapPath(), "utf-8");
    expect(actualFs.existsSync(projectMapPath())).toBe(true);
  });
});
