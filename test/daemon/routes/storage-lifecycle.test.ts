import { describe, expect, it, vi } from "vitest";
import { closeRouteStorage, openExistingProject } from "../../../src/daemon/routes/storage-lifecycle.js";

describe("route storage cleanup", () => {
  it("ignores absent resources", async () => {
    await expect(closeRouteStorage(undefined, undefined)).resolves.toBeUndefined();
  });

  it("attempts both closes and suppresses both rejections", async () => {
    const projectClose = vi.fn(async () => { throw new Error("project close failed"); });
    const factoryClose = vi.fn(async () => { throw new Error("factory close failed"); });
    await expect(closeRouteStorage(
      { close: projectClose },
      { close: factoryClose },
    )).resolves.toBeUndefined();
    expect(projectClose).toHaveBeenCalledOnce();
    expect(factoryClose).toHaveBeenCalledOnce();
  });

  it("opens only projects reported by the selected backend", async () => {
    const identity = { id: "project", canonical: "/project" } as never;
    const project = { close: vi.fn() } as never;
    const factory = {
      projectExists: vi.fn(async () => false),
      openProject: vi.fn(async () => project),
    } as never;
    await expect(openExistingProject(factory, identity)).resolves.toBeNull();
    expect(factory.openProject).not.toHaveBeenCalled();
    factory.projectExists.mockResolvedValueOnce(true);
    await expect(openExistingProject(factory, identity)).resolves.toBe(project);
    expect(factory.openProject).toHaveBeenCalledWith(identity);
  });
});
