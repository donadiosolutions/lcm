import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withPrivateMutationLockAsync } from "../../src/private-mutation-lock.js";

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;

vi.mock("../../src/daemon/client.js", () => ({
  DaemonClient: class {
    async health() {
      return {
        status: "ok",
        storageBackend: "sqlite",
        entrypoint: "/opt/lcm/lcm.mjs",
        runtimeDigest: "runtime",
      };
    }

    async post(path: string) {
      if (path === "/status") {
        return {
          daemon: { version: "test", uptime: 0, port: 3737 },
          project: {
            messageCount: 0,
            summaryCount: 0,
            promotedCount: 0,
            lastIngest: null,
            lastCompact: null,
            lastPromote: null,
          },
        };
      }
      return { results: [] };
    }

    async get() {
      return { totalConnections: 0, activeConnections: 0, idleConnections: 0, connections: [] };
    }
  },
}));

vi.mock("../../src/runtime-paths.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../../src/runtime-paths.js")>();
  return {
    ...actual,
    migrateLegacyHomeIfNeeded: vi.fn(() => {
      throw new Error("unexpected migration while publication lock is held");
    }),
  };
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
});

describe("runCli healthy-daemon reads during publication", () => {
  it("completes a routed search while the actual publication lock is held", async () => {
    const home = mkdtempSync(join(tmpdir(), "lcm-cli-publication-lock-"));
    const lcmDir = join(home, ".lcm");
    const configPath = join(lcmDir, "config.json");
    const tokenPath = join(lcmDir, "daemon.token");
    const publicationLockPath = join(home, ".lcm.backend-publication.lock");
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    mkdirSync(lcmDir, { mode: 0o700 });
    chmodSync(lcmDir, 0o700);
    writeFileSync(configPath, "{}", { mode: 0o600 });
    writeFileSync(tokenPath, "test-token", { mode: 0o600 });

    let release!: () => void;
    let acquired!: () => void;
    const lockAcquired = new Promise<void>(resolve => { acquired = resolve; });
    const releaseLock = new Promise<void>(resolve => { release = resolve; });

    let holder: Promise<void> | undefined;
    try {
      holder = withPrivateMutationLockAsync(
        publicationLockPath,
        "test backend publication",
        async () => {
          acquired();
          await releaseLock;
        },
      );
      await lockAcquired;

      const { runCli } = await import("../../bin/lcm.js");
      const reads = [
        ["search", "dogfood"],
        ["grep", "dogfood"],
        ["describe", "node"],
        ["expand", "node"],
        ["status"],
        ["stats", "--pool"],
      ];
      await expect(Promise.all(reads.map(args => runCli(["node", "lcm", ...args]))))
        .resolves.toEqual(reads.map(() => undefined));

      release();
      await holder;
    } finally {
      release();
      if (holder !== undefined) await holder;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
