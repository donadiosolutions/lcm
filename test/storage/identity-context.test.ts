import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ResolvedStorageConfig } from "../../src/daemon/config.js";
import { machineIdentityPath } from "../../src/machine-identity.js";
import {
  resolveStorageIdentityContext,
  StorageIdentityConfigurationError,
} from "../../src/storage/identity-context.js";

const local = {
  id: "a".repeat(64),
  canonical: "/work/project",
};
const remoteProjectId = "0190b1d2-8f40-7abc-8def-0123456789ab";
const machineId = "0190b1d2-8f40-7abc-8def-0123456789ac";
const sqlite = { backend: "sqlite" } as ResolvedStorageConfig;
const postgresql = {
  backend: "postgresql",
  postgresql: {},
} as unknown as ResolvedStorageConfig;

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
    expect(() => resolveStorageIdentityContext(postgresql, local))
      .toThrow(StorageIdentityConfigurationError);
    expect(() => resolveStorageIdentityContext(postgresql, local))
      .toThrow("lcm project create");
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
    }, writeMachine());
    expect(context).toEqual({
      id: remoteProjectId,
      localProjectId: local.id,
      canonical: local.canonical,
      remoteProjectId,
      machineId,
    });
  });
});
