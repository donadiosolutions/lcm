import { beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { findUncompacted } from "../src/batch-compact.js";
import { runLcmMigrations } from "../src/db/migration.js";
import { addProjectAlias, clearProjectMapCache } from "../src/project-map.js";
import { ensureProjectDir, projectPaths } from "../src/daemon/project.js";

function resetLcmHome(): void {
  rmSync(join(homedir(), ".lcm"), { recursive: true, force: true });
  mkdirSync(join(homedir(), ".lcm"), { recursive: true });
  clearProjectMapCache();
}

function makeDir(name: string): string {
  const path = join(homedir(), name);
  mkdirSync(path, { recursive: true });
  return path;
}

function seedConversation(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    runLcmMigrations(db);
    db.prepare("INSERT INTO conversations (conversation_id, session_id) VALUES (?, ?)").run(1, "session-1");
    db.prepare(
      "INSERT INTO messages (conversation_id, seq, role, content, token_count) VALUES (?, ?, ?, ?, ?)",
    ).run(1, 1, "user", "hello", 250);
  } finally {
    db.close();
  }
}

describe("batch compaction discovery", () => {
  beforeEach(() => {
    resetLcmHome();
  });

  it("matches current-project filters through project-map aliases", () => {
    const canonical = makeDir("compact-canonical");
    const alias = makeDir("compact-alias");
    const paths = projectPaths(canonical);
    ensureProjectDir(canonical);
    writeFileSync(paths.metaPath, JSON.stringify({ cwd: paths.canonical }, null, 2) + "\n");
    seedConversation(paths.dbPath);
    addProjectAlias(alias, { canonical });

    const conversations = findUncompacted(100, true, alias);

    expect(conversations).toHaveLength(1);
    expect(conversations[0].cwd).toBe(paths.canonical);
    expect(conversations[0].sessionId).toBe("session-1");
  });
});
