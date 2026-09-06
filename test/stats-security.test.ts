import { DatabaseSync } from "node:sqlite";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runLcmMigrations } from "../src/db/migration.js";

const fixture = vi.hoisted(() => ({
  projectsDir: "",
}));

vi.mock("../src/runtime-paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/runtime-paths.js")>();
  return {
    ...actual,
    configPath: () => join(fixture.projectsDir, "..", "config.json"),
    projectsDir: () => fixture.projectsDir,
  };
});

vi.mock("../src/daemon/config.js", () => ({
  loadDaemonConfig: () => ({
    restoration: { staleAfterDays: 90, staleSurfacingWithoutUseLimit: 5 },
    storage: { backend: "sqlite" },
  }),
}));

vi.mock("../src/storage/backend.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/storage/backend.js")>();
  return {
    ...actual,
    selectStorageBackendForConfig: () => ({ backend: "sqlite" }),
  };
});

vi.mock("../src/db/events-stats.js", () => ({
  collectEventStats: async () => ({ captured: 0, unprocessed: 0, errors: 0 }),
}));

import { collectStats } from "../src/stats.js";

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function privateDirectory(parent: string, name: string): string {
  const directory = join(parent, name);
  mkdirSync(directory, { mode: 0o700 });
  chmodSync(directory, 0o700);
  return directory;
}

function makeFixture(): { scratch: string; stateRoot: string; projectsDir: string } {
  const scratch = mkdtempSync(join(tmpdir(), "lcm-stats-security-"));
  tempDirs.push(scratch);
  chmodSync(scratch, 0o700);
  const stateRoot = privateDirectory(scratch, ".lcm");
  const projectsDir = privateDirectory(stateRoot, "projects");
  fixture.projectsDir = projectsDir;
  return { scratch, stateRoot, projectsDir };
}

function seedProject(projectsDir: string, projectId: string): void {
  const projectDir = privateDirectory(projectsDir, projectId);
  const databasePath = join(projectDir, "db.sqlite");
  const database = new DatabaseSync(databasePath);
  try {
    runLcmMigrations(database);
    database.prepare(
      "INSERT INTO conversations (conversation_id, session_id) VALUES (?, ?)",
    ).run(1, "stats-security");
    database.prepare(
      `INSERT INTO messages
         (conversation_id, seq, role, content, token_count)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(1, 1, "user", "external project", 7);
  } finally {
    database.close();
  }
}

function seedLegacyProject(projectsDir: string, projectId: string): string {
  const projectDir = privateDirectory(projectsDir, projectId);
  const databasePath = join(projectDir, "db.sqlite");
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(`
      CREATE TABLE conversations (
        conversation_id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        title TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE messages (
        message_id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id INTEGER NOT NULL,
        seq INTEGER NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        token_count INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (conversation_id, seq)
      );
      INSERT INTO conversations (conversation_id, session_id)
        VALUES (1, 'legacy-stats');
      INSERT INTO messages
        (conversation_id, seq, role, content, token_count)
        VALUES (1, 1, 'user', 'legacy project', 11);
    `);
  } finally {
    database.close();
  }
  return databasePath;
}

async function expectAdmissionFailure(
  operation: Promise<unknown>,
  untrustedPath: string,
): Promise<void> {
  const error = await operation.then(
    () => undefined,
    (failure: unknown) => failure,
  );
  expect(error).toMatchObject({ name: "StatsDatabaseAdmissionError" });
  expect(String(error)).not.toContain(untrustedPath);
}

describe("stats database admission", () => {
  it("rejects a symlinked state root before reading its database", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "lcm-stats-security-"));
    tempDirs.push(scratch);
    chmodSync(scratch, 0o700);

    const redirectedRoot = privateDirectory(scratch, "redirected-state");
    const redirectedProjects = privateDirectory(redirectedRoot, "projects");
    seedProject(redirectedProjects, "external");
    symlinkSync(redirectedRoot, join(scratch, ".lcm"), "dir");
    fixture.projectsDir = join(scratch, ".lcm", "projects");

    await expect(collectStats()).rejects.toMatchObject({
      name: "StatsDatabaseAdmissionError",
    });
  });

  it("rejects a symlinked projects directory before reading its database", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "lcm-stats-security-"));
    tempDirs.push(scratch);
    chmodSync(scratch, 0o700);

    const stateRoot = privateDirectory(scratch, ".lcm");
    const redirectedProjects = privateDirectory(scratch, "redirected-projects");
    seedProject(redirectedProjects, "external");
    fixture.projectsDir = join(stateRoot, "projects");
    symlinkSync(redirectedProjects, fixture.projectsDir, "dir");

    await expect(collectStats()).rejects.toMatchObject({
      name: "StatsDatabaseAdmissionError",
    });
  });

  it("migrates an admitted legacy database and includes its messages", async () => {
    const { projectsDir } = makeFixture();
    const databasePath = seedLegacyProject(projectsDir, "legacy");

    await expect(collectStats()).resolves.toMatchObject({ projects: 1, messages: 1 });

    const inspection = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const columns = inspection.prepare("PRAGMA table_info(conversations)").all() as Array<{
        name: string;
      }>;
      expect(columns.map((column) => column.name)).toContain("bootstrapped_at");
    } finally {
      inspection.close();
    }
  });

  it("returns an empty aggregate without creating a missing state root", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "lcm-stats-security-"));
    tempDirs.push(scratch);
    fixture.projectsDir = join(scratch, ".lcm", "projects");

    await expect(collectStats()).resolves.toMatchObject({ projects: 0, messages: 0 });
    expect(() => new DatabaseSync(join(fixture.projectsDir, "project", "db.sqlite"), {
      readOnly: true,
    })).toThrow();
  });

  it("returns an empty aggregate without creating missing projects or database entries", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "lcm-stats-security-"));
    tempDirs.push(scratch);
    chmodSync(scratch, 0o700);
    const stateRoot = privateDirectory(scratch, ".lcm");
    fixture.projectsDir = join(stateRoot, "projects");

    await expect(collectStats()).resolves.toMatchObject({ projects: 0, messages: 0 });

    const projectsDir = privateDirectory(stateRoot, "projects");
    const projectDir = privateDirectory(projectsDir, "missing-db");
    await expect(collectStats()).resolves.toMatchObject({ projects: 0, messages: 0 });
    expect(() => new DatabaseSync(join(projectDir, "db.sqlite"), { readOnly: true })).toThrow();
  });

  it.each([
    ["state root", (stateRoot: string, _projectsDir: string) => chmodSync(stateRoot, 0o755)],
    ["projects directory", (_stateRoot: string, projectsDir: string) => chmodSync(projectsDir, 0o755)],
  ])("rejects an unsafe %s with a sanitized diagnostic", async (_label, makeUnsafe) => {
    const { stateRoot, projectsDir } = makeFixture();
    makeUnsafe(stateRoot, projectsDir);

    await expectAdmissionFailure(collectStats(), stateRoot);
  });

  it("rejects an unsafe project directory before migrating its legacy database", async () => {
    const { projectsDir } = makeFixture();
    const databasePath = seedLegacyProject(projectsDir, "unsafe-mode");
    chmodSync(join(projectsDir, "unsafe-mode"), 0o755);

    await expectAdmissionFailure(collectStats(), "unsafe-mode");

    const inspection = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const columns = inspection.prepare("PRAGMA table_info(conversations)").all() as Array<{
        name: string;
      }>;
      expect(columns.map((column) => column.name)).not.toContain("bootstrapped_at");
    } finally {
      inspection.close();
    }
  });

  it("excludes a project that was already a symlink when enumerated", async () => {
    const { scratch, projectsDir } = makeFixture();
    const externalProjects = privateDirectory(scratch, "external-projects");
    seedProject(externalProjects, "external");
    symlinkSync(join(externalProjects, "external"), join(projectsDir, "alias"), "dir");

    await expect(collectStats()).resolves.toMatchObject({ projects: 0, messages: 0 });
  });

  it.each(["symlink", "directory"])(
    "rejects an unsafe database %s without changing its target",
    async (kind) => {
      const { scratch, projectsDir } = makeFixture();
      const projectDir = privateDirectory(projectsDir, `unsafe-${kind}`);
      const databasePath = join(projectDir, "db.sqlite");
      let targetPath: string;
      if (kind === "symlink") {
        const externalProjects = privateDirectory(scratch, "database-targets");
        targetPath = seedLegacyProject(externalProjects, "target");
        symlinkSync(targetPath, databasePath);
      } else {
        targetPath = databasePath;
        mkdirSync(databasePath, { mode: 0o700 });
      }

      await expectAdmissionFailure(collectStats(), projectDir);

      if (kind === "symlink") {
        const inspection = new DatabaseSync(targetPath, { readOnly: true });
        try {
          const columns = inspection.prepare("PRAGMA table_info(conversations)").all() as Array<{
            name: string;
          }>;
          expect(columns.map((column) => column.name)).not.toContain("bootstrapped_at");
        } finally {
          inspection.close();
        }
      }
    },
  );
});
