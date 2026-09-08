import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDaemonConfig, type DaemonConfig } from "../../../src/daemon/config.js";
import { projectIdentity } from "../../../src/daemon/project.js";
import { admittedProjectIdentity } from "../../../src/daemon/routes/storage-lifecycle.js";
import type { RoutePublicationAdmission } from "../../../src/daemon/server.js";
import { clearProjectMapCache } from "../../../src/project-map.js";
import { PrivateMutationLockContentionError } from "../../../src/private-mutation-lock.js";
import {
  withBackendPublicationConsumerLockAsync,
  type BackendPublicationLockToken,
} from "../../../src/storage/backend-publication.js";

async function withTemporaryProject(
  operation: (project: { home: string; cwd: string; config: DaemonConfig }) => Promise<void>,
): Promise<void> {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  const home = mkdtempSync(join(tmpdir(), "lcm-admitted-identity-"));
  const cwd = join(home, "project");
  mkdirSync(cwd, { mode: 0o700 });
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  clearProjectMapCache();
  try {
    await operation({
      home,
      cwd,
      config: loadDaemonConfig(join(home, "missing-config.json"), {
        storage: { backend: "sqlite" },
        daemon: { port: 0, idleTimeoutMs: 0 },
      }),
    });
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    clearProjectMapCache();
    rmSync(home, { recursive: true, force: true });
  }
}

describe("admittedProjectIdentity", () => {
  it("preserves direct identity resolution when no admission context is supplied", async () => {
    await withTemporaryProject(async ({ cwd, config }) => {
      const expected = projectIdentity(cwd, config.storage);
      await expect(admittedProjectIdentity(cwd, config.storage)).resolves.toEqual(expected);
      await expect(admittedProjectIdentity(cwd, config.storage, {
        signal: new AbortController().signal,
      })).resolves.toEqual(expected);
    });
  });

  it("forwards the admission token through real identity resolution and the signal to admission", async () => {
    await withTemporaryProject(async ({ home, cwd, config }) => {
      const signal = new AbortController().signal;
      const observedSignals: (AbortSignal | undefined)[] = [];
      const withPublicationAdmission: RoutePublicationAdmission = async (operation, admissionSignal) => {
        observedSignals.push(admissionSignal);
        return withBackendPublicationConsumerLockAsync(home, async token => {
          expect(() => projectIdentity(cwd, config.storage)).toThrow(PrivateMutationLockContentionError);
          return operation(token);
        });
      };
      const actual = await admittedProjectIdentity(cwd, config.storage, { signal, withPublicationAdmission });
      expect(actual).toEqual(projectIdentity(cwd, config.storage));
      expect(observedSignals).toEqual([signal]);
    });
  });

  it("uses a retained active token without reacquiring its real publication lock", async () => {
    await withTemporaryProject(async ({ home, cwd, config }) => {
      await withBackendPublicationConsumerLockAsync(home, async token => {
        const expected = projectIdentity(cwd, config.storage, token);
        await expect(admittedProjectIdentity(cwd, config.storage, {
          signal: new AbortController().signal,
          publicationLockToken: token,
        })).resolves.toEqual(expected);
      });
    });
  });

  it("rejects a revoked retained token rather than silently acquiring new authority", async () => {
    await withTemporaryProject(async ({ home, cwd, config }) => {
      let revoked!: BackendPublicationLockToken;
      await withBackendPublicationConsumerLockAsync(home, async token => { revoked = token; });
      await expect(admittedProjectIdentity(cwd, config.storage, {
        signal: new AbortController().signal,
        publicationLockToken: revoked,
      })).rejects.toMatchObject({ name: "BackendPublicationJournalError", reason: "permit-mismatch" });
    });
  });

  it("uses the current admission token even if the context also contains a revoked token", async () => {
    await withTemporaryProject(async ({ home, cwd, config }) => {
      let revoked!: BackendPublicationLockToken;
      await withBackendPublicationConsumerLockAsync(home, async token => { revoked = token; });
      const actual = await admittedProjectIdentity(cwd, config.storage, {
        signal: new AbortController().signal,
        publicationLockToken: revoked,
        withPublicationAdmission: operation => withBackendPublicationConsumerLockAsync(home, operation),
      });
      expect(actual).toEqual(projectIdentity(cwd, config.storage));
    });
  });

  it("propagates admission refusal without resolving identity", async () => {
    await withTemporaryProject(async ({ cwd, config }) => {
      const failure = new Error("admission canceled");
      const withPublicationAdmission = vi.fn(async () => { throw failure; });
      await expect(admittedProjectIdentity(cwd, config.storage, {
        signal: new AbortController().signal,
        withPublicationAdmission,
      })).rejects.toBe(failure);
      expect(withPublicationAdmission).toHaveBeenCalledOnce();
    });
  });
});
