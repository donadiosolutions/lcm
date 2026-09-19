import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ResolvedStorageConfig } from "../../src/daemon/config.js";
import { machineIdentityPath } from "../../src/machine-identity.js";
import {
  resolveBoundStorageIdentityContext,
  resolveStorageIdentityContext,
  StorageIdentityConfigurationError,
  UNBOUND_POSTGRESQL_PROJECT_MESSAGE,
} from "../../src/storage/identity-context.js";
import type { BoundProjectIdentity } from "../../src/project-map.js";

const local = {
  id: "a".repeat(64),
  canonical: "/work/project",
};
const remoteProjectId = "0190b1d2-8f40-7abc-8def-0123456789ab";
const machineId = "0190b1d2-8f40-7abc-8def-0123456789ac";
const sqlite = { backend: "sqlite" } as Extract<ResolvedStorageConfig, { backend: "sqlite" }>;
const postgresql = {
  backend: "postgresql",
  postgresql: {},
} as unknown as Extract<ResolvedStorageConfig, { backend: "postgresql" }>;

let homeDir: string | undefined;

afterEach(() => {
  if (homeDir) rmSync(homeDir, { recursive: true, force: true });
  homeDir = undefined;
});

function writeMachine(): string {
  homeDir = mkdtempSync(join(tmpdir(), "lcm-storage-identity-"));
  const path = machineIdentityPath(homeDir);
  mkdirSync(join(homeDir, ".lcm"), { recursive: true });
  writeFileSync(path, JSON.stringify({
    version: 1,
    identityKey: `machine:${"b".repeat(64)}`,
    machineId,
    displayName: "workstation",
  }));
  chmodSync(path, 0o600);
  return homeDir;
}

describe("resolveStorageIdentityContext", () => {
  it("keeps SQLite on the local path-derived hash", () => {
    expect(resolveStorageIdentityContext(sqlite, {
      ...local,
      remoteProjectId,
    })).toEqual({
      ...local,
      id: local.id,
      localProjectId: local.id,
      remoteProjectId,
    });
  });

  it("fails closed when PostgreSQL has no explicit project binding", () => {
    let error: unknown;
    try {
      // Deliberately violate the BoundProjectIdentity parameter type to pin
      // the runtime refusal for untyped (JavaScript) callers. TypeScript
      // callers cannot pass an unbound identity: see resolveBoundStorageIdentityContext.
      resolveStorageIdentityContext(postgresql, local as BoundProjectIdentity);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(StorageIdentityConfigurationError);
    expect(error).toMatchObject({
      message: UNBOUND_POSTGRESQL_PROJECT_MESSAGE,
    });
    expect(UNBOUND_POSTGRESQL_PROJECT_MESSAGE).not.toContain(local.id);
    expect(UNBOUND_POSTGRESQL_PROJECT_MESSAGE).not.toContain(local.canonical);
  });

  it("fails closed when PostgreSQL has no finalized machine registration", () => {
    homeDir = mkdtempSync(join(tmpdir(), "lcm-storage-identity-missing-"));
    expect(() => resolveStorageIdentityContext(postgresql, {
      ...local,
      remoteProjectId,
    }, homeDir)).toThrow("lcm machine register");
  });

  it("uses the explicit remote UUID together with local and machine identities", () => {
    const context = resolveStorageIdentityContext(postgresql, {
      ...local,
      remoteProjectId,
    }, writeMachine(), "/selected/project");
    expect(context).toEqual({
      id: remoteProjectId,
      localProjectId: local.id,
      canonical: local.canonical,
      remoteProjectId,
      machineId,
      selectedPath: "/selected/project",
    });
  });

  it("keeps direct legacy resolver callers free of a selected path", () => {
    const context = resolveStorageIdentityContext(postgresql, {
      ...local,
      remoteProjectId,
    }, writeMachine());

    expect(context).not.toHaveProperty("selectedPath");
  });
  it("refuses an unbound identity loudly through the bound resolver", () => {
    // Bug #1430: pairing a hook-durability (unbound) identity with storage
    // resolution that requires a remote binding must fail loudly instead of
    // degrading into a permanent unbound refusal.
    let error: unknown;
    try {
      resolveBoundStorageIdentityContext(postgresql, local);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(StorageIdentityConfigurationError);
    expect(error).toMatchObject({ message: UNBOUND_POSTGRESQL_PROJECT_MESSAGE });
  });
  it("resolves a bound identity through the bound resolver", () => {
    const context = resolveBoundStorageIdentityContext(postgresql, {
      ...local,
      remoteProjectId,
    }, writeMachine(), "/selected/project");
    expect(context).toMatchObject({
      id: remoteProjectId,
      localProjectId: local.id,
      remoteProjectId,
      selectedPath: "/selected/project",
    });
  });
});
