import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { DaemonClient } from "../../src/daemon/client.js";
import { cwdToProjectHash, importSessions } from "../../src/import.js";
import { assertHarnessReady } from "./harness.js";
import { withSelectedPostgreSqlProject } from "./operational-fixture.js";

beforeAll(assertHarnessReady);

describe("Claude import all with selected PostgreSQL", () => {
  it("dispatches fresh map-only bindings for Claude and both providers without SQLite", async () => {
    await withSelectedPostgreSqlProject("cli-import-all", async ({ homeDir, projectPath }) => {
      const projectsDir = join(homeDir, ".claude", "projects");
      const transcriptDir = join(projectsDir, cwdToProjectHash(projectPath));
      mkdirSync(transcriptDir, { recursive: true });
      writeFileSync(join(transcriptDir, "claude-session.jsonl"), "");
      const codexDir = join(homeDir, ".codex");
      const archived = join(codexDir, "archived_sessions");
      mkdirSync(archived, { recursive: true });
      writeFileSync(join(archived, "codex-session.jsonl"), JSON.stringify({
        type: "session_meta", payload: { id: "codex-session", cwd: projectPath },
      }) + "\n");
      const calls: unknown[] = [];
      const client = {
        post: async (path: string, body: unknown) => {
          expect(path).toBe("/ingest");
          calls.push(body);
          return { ingested: 1, totalTokens: 2 };
        },
      } as unknown as DaemonClient;
      expect(existsSync(join(homeDir, ".lcm", "projects"))).toBe(false);
      await expect(importSessions(client, {
        all: true, provider: "claude", _claudeProjectsDir: projectsDir,
      })).resolves.toMatchObject({ imported: 1, failed: 0, unresolved: 0, ambiguous: 0 });
      expect(calls).toEqual([expect.objectContaining({
        client: "claude", cwd: projectPath, session_id: "claude-session",
      })]);
      expect(existsSync(join(homeDir, ".lcm", "projects"))).toBe(false);
      calls.length = 0;
      await expect(importSessions(client, {
        all: true, provider: "all", cwd: projectPath,
        _claudeProjectsDir: projectsDir, _codexDir: codexDir,
      })).resolves.toMatchObject({ imported: 2, failed: 0, unresolved: 0, ambiguous: 0 });
      expect(calls).toEqual([
        expect.objectContaining({ client: "claude", cwd: projectPath, session_id: "claude-session" }),
        expect.objectContaining({ client: "codex", cwd: projectPath, session_id: "codex-session" }),
      ]);
    });
  });
});
