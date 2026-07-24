import { describe, expect, it, vi } from "vitest";
import {
  closeRouteStorage,
  openExistingProject,
  stagedPostgreSqlUnavailableResponse,
  storageIdentityRequiredResponse,
} from "../../../src/daemon/routes/storage-lifecycle.js";
import { MachineIdentityFileError } from "../../../src/machine-identity.js";
import { UnavailablePostgreSqlStorageBackendFactory } from "../../../src/storage/factory.js";
import { StorageIdentityConfigurationError } from "../../../src/storage/identity-context.js";

describe("route storage cleanup", () => {
  it("ignores absent resources", async () => {
    await expect(closeRouteStorage(undefined, undefined)).resolves.toBeUndefined();
  });

  it("attempts every synchronous or asynchronous close and suppresses failures", async () => {
    const projectClose = vi.fn(async () => { throw new Error("project close failed"); });
    const outboxClose = vi.fn(() => { throw new Error("outbox close failed"); });
    const factoryClose = vi.fn(async () => { throw new Error("factory close failed"); });
    await expect(closeRouteStorage(
      { close: projectClose },
      { close: outboxClose },
      { close: factoryClose },
    )).resolves.toBeUndefined();
    expect(projectClose).toHaveBeenCalledOnce();
    expect(outboxClose).toHaveBeenCalledOnce();
    expect(factoryClose).toHaveBeenCalledOnce();
  });

  it("delegates atomic existing-project opens to the selected backend", async () => {
    const identity = { id: "project", canonical: "/project" } as never;
    const project = { close: vi.fn() } as never;
    const factory = {
      openExistingProject: vi.fn(async () => null as typeof project | null),
    } as never;
    await expect(openExistingProject(factory, identity)).resolves.toBeNull();
    factory.openExistingProject.mockResolvedValueOnce(project);
    await expect(openExistingProject(factory, identity)).resolves.toBe(project);
    expect(factory.openExistingProject).toHaveBeenCalledWith(identity);
  });

  it("recognizes only typed failures from the staged PostgreSQL factory", async () => {
    const staged = new UnavailablePostgreSqlStorageBackendFactory();
    const identity = { id: "project", canonical: "/project" } as never;
    const stagedError = await staged.openExistingProject(identity)
      .catch((error: unknown) => error);

    expect(stagedPostgreSqlUnavailableResponse(undefined, stagedError, "grep"))
      .toBeNull();
    expect(stagedPostgreSqlUnavailableResponse(staged, new Error("other"), "grep"))
      .toBeNull();
    expect(stagedPostgreSqlUnavailableResponse(staged, stagedError, "grep"))
      .toEqual({
        code: "STORAGE_BACKEND_STAGED",
        error: "grep is unavailable while PostgreSQL storage repositories are staged",
        storageBackend: "postgresql",
      });
  });

  it("recognizes only typed PostgreSQL identity admission failures", () => {
    expect(storageIdentityRequiredResponse(new Error("other"))).toBeNull();
    expect(storageIdentityRequiredResponse(
      new StorageIdentityConfigurationError("binding required"),
    )).toEqual({
      code: "STORAGE_IDENTITY_REQUIRED",
      error: "binding required",
      storageBackend: "postgresql",
    });
    expect(storageIdentityRequiredResponse(
      new MachineIdentityFileError("machine missing", "Register it."),
    )).toEqual({
      code: "STORAGE_IDENTITY_REQUIRED",
      error: "machine missing. Register it.",
      storageBackend: "postgresql",
    });
  });
});
