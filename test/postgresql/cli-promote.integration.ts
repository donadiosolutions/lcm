import { existsSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { DaemonClient } from "../../src/daemon/client.js";
import * as lifecycle from "../../src/daemon/lifecycle.js";
import { hashProjectPath } from "../../src/project-map.js";
import { assertHarnessReady } from "./harness.js";
import { withSelectedPostgreSqlProject } from "./operational-fixture.js";

beforeAll(assertHarnessReady);

describe("PostgreSQL 18 CLI promotion enumeration", { timeout: 120_000 }, () => {
  it("dispatches a newly bound project without SQLite metadata through promote --all", async () => {
    await withSelectedPostgreSqlProject("cli-promote-all", async ({ homeDir, projectPath }) => {
      const metadata = join(homeDir, ".lcm", "projects", hashProjectPath(projectPath), "meta.json");
      expect(existsSync(metadata)).toBe(false);
      const ensureDaemon = vi.spyOn(lifecycle, "ensureDaemon").mockResolvedValue({
        connected: true, spawned: false, restartedForParent: false, port: 3737,
      });
      const post = vi.spyOn(DaemonClient.prototype, "post")
        .mockResolvedValue({ processed: 2, promoted: 1, conversations: 1 });
      const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
      const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
      const status = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        const { runCli } = await import("../../bin/lcm.js");
        await expect(runCli(["node", "lcm", "promote", "--all", "--verbose", "--dry-run"]))
          .resolves.toBeUndefined();
        expect(ensureDaemon).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ expectedStorageBackend: "postgresql" }));
        expect(post).toHaveBeenCalledExactlyOnceWith("/promote", { cwd: projectPath, dry_run: true });
        expect(stdout).not.toHaveBeenCalled();
        expect(status.mock.calls.flat().join(" ")).toContain("1 insight promoted");
        expect(existsSync(metadata)).toBe(false);
      } finally {
        status.mockRestore();
        stderr.mockRestore();
        stdout.mockRestore();
        post.mockRestore();
        ensureDaemon.mockRestore();
      }
    });
  });
});
