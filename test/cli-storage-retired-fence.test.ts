import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withCliProjectStorage } from "../src/cli-storage.js";
import { clearProjectMapCache } from "../src/project-map.js";
import { clearWorktreeReconciliationCache } from "../src/worktree-reconciliation.js";
import { ensureProjectDir, projectPaths } from "../src/daemon/project.js";
import {
  RETIRED_PROJECT_IDENTITY_DIAGNOSTIC,
  RetiredProjectIdentityError,
  serializeWorktreeReconciliationFence,
} from "../src/worktree-reconciliation-fence.js";
import { UNBOUND_POSTGRESQL_PROJECT_MESSAGE } from "../src/storage/identity-context.js";
import * as configModule from "../src/daemon/config.js";
import * as publicationModule from "../src/storage/backend-publication.js";

describe("CLI selected project storage — retired identity fence before backend resolution", () => {
  let home: string;
  let cwd: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "lcm-cli-storage-retired-fence-"));
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    mkdirSync(join(home, ".lcm"), { mode: 0o700 });
    cwd = join(home, "project");
    mkdirSync(cwd);
    clearProjectMapCache();
    clearWorktreeReconciliationCache();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    clearProjectMapCache();
    clearWorktreeReconciliationCache();
    rmSync(home, { recursive: true, force: true });
  });

  function selectPostgresqlBackend(): void {
    const config = configModule.loadDaemonConfig(join(home, ".lcm", "config.json"));
    vi.spyOn(configModule, "loadDaemonConfig").mockReturnValue({
      ...config,
      storage: { ...config.storage, backend: "postgresql" },
    });
    // Bypass real PostgreSQL publication-journal verification; the retired
    // local fence must be classified before any backend access is attempted.
    vi.spyOn(publicationModule, "assertBackendPublicationConsumerAccess").mockReturnValue(undefined);
  }

  function plantRetiredFence(): ReturnType<typeof projectPaths> {
    const paths = projectPaths(cwd);
    ensureProjectDir(cwd);
    rmSync(paths.dir, { recursive: true });
    writeFileSync(paths.dir, serializeWorktreeReconciliationFence(paths.id, "project"), { mode: 0o600 });
    clearWorktreeReconciliationCache();
    return paths;
  }

  it("surfaces the retired-identity renewal diagnostic for a PostgreSQL-selected config instead of the generic unbound-project message", async () => {
    plantRetiredFence();
    selectPostgresqlBackend();

    const attempt = withCliProjectStorage(cwd, { create: false }, async () => true);
    await expect(attempt).rejects.toBeInstanceOf(RetiredProjectIdentityError);
    await expect(attempt).rejects.toThrow(RETIRED_PROJECT_IDENTITY_DIAGNOSTIC);
    // The bug this regresses: PostgreSQL's remote-identity lookup used to
    // throw the generic unbound-project message before the SQLite-only fence
    // check ever ran, hiding the renewal diagnostic entirely.
    await expect(attempt).rejects.not.toThrow(UNBOUND_POSTGRESQL_PROJECT_MESSAGE);
  });

  it("still reports the generic unbound-project message for PostgreSQL when no fence is present", async () => {
    // Control case: an ordinary unbound PostgreSQL project (no retired local
    // fence at all) keeps its existing, unrelated diagnostic.
    selectPostgresqlBackend();

    await expect(withCliProjectStorage(cwd, { create: false }, async () => true))
      .rejects.toThrow(UNBOUND_POSTGRESQL_PROJECT_MESSAGE);
  });

  it("still classifies the same retired fence for the default SQLite backend", async () => {
    plantRetiredFence();

    await expect(withCliProjectStorage(cwd, { create: false }, async () => true))
      .rejects.toThrow(RETIRED_PROJECT_IDENTITY_DIAGNOSTIC);
  });
});
