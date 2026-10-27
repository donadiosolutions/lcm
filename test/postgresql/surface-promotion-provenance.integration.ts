import { existsSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { withCliProjectStorage } from "../../src/cli-storage.js";
import { DaemonClient } from "../../src/daemon/client.js";
import { loadDaemonConfig } from "../../src/daemon/config.js";
import { createDaemon } from "../../src/daemon/server.js";
import { appendLocalHookEvents } from "../../src/hooks/local-enqueue.js";
import { hashProjectPath } from "../../src/project-map.js";
import { assertHarnessReady } from "./harness.js";
import { withSelectedPostgreSqlProject } from "./operational-fixture.js";

beforeAll(assertHarnessReady);

describe("public promotion provenance parity", { timeout: 120_000 }, () => {
  it("reinforces an ordinary promotion with one tier-three passive match (#1158)", async () => {
    let observed: unknown;
    let originalMemoryId: string | undefined;
    let passiveRows: unknown;
    let ownedHome: string | undefined;
    let ownedProjectRoot: string | undefined;
    await withSelectedPostgreSqlProject("surface-normal-passive", async fixture => {
      ownedHome = fixture.homeDir;
      ownedProjectRoot = fixture.projectRoot;
      const content = "Orchard pruning architecture decision for perennial fruit trees";
      // Prepare a summary through the admitted repository, then let the public
      // promotion route choose its own provenance. Never seed a promoted row.
      await withCliProjectStorage(fixture.projectPath, {}, async ({ storage }) => {
        const conversation = await storage.conversations.createConversation({
          sessionId: "surface-normal-promotion",
        });
        await storage.summaries.insertSummary({
          conversationId: conversation.conversationId,
          summaryId: "surface-normal-summary",
          kind: "condensed", depth: 2, content, tokenCount: 12,
          sourceMessageTokenCount: 100,
        });
      });
      const configPath = join(fixture.homeDir, ".lcm", "config.json");
      const config = loadDaemonConfig(configPath, {
        daemon: { port: 0, idleTimeoutMs: 0 }, summarizer: { mock: true },
      });
      const daemon = await createDaemon(config, { publicationConfigPath: configPath });
      try {
        const client = new DaemonClient(`http://127.0.0.1:${daemon.address().port}`);
        await expect(client.post("/promote", { cwd: fixture.projectPath }))
          .resolves.toMatchObject({ processed: 1, promoted: 1 });
        const before = await fixture.administrator.query<{
          memory_id: string; source_project_id: string;
        }>({
          text: "SELECT memory_id, source_project_id FROM lcm.promoted_memories WHERE project_id=$1",
          values: [fixture.project.projectId],
        }, { domain: "promoted-memory", operation: "verifyNormalPromotionProvenance" });
        expect(before.rows).toEqual([{
          memory_id: expect.any(String), source_project_id: hashProjectPath(fixture.projectPath),
        }]);
        expect(hashProjectPath(fixture.projectPath)).not.toBe(fixture.project.projectId);
        originalMemoryId = before.rows[0].memory_id;
        // Exactly one event is essential: three across two sessions would take
        // the repeated-evidence bootstrap branch and hide an existing-match bug.
        await expect(appendLocalHookEvents({
          cwd: fixture.projectPath, sessionId: "surface-passive-match",
          events: [{ type: "file", category: "file", data: content, priority: 3 }],
          sourceHook: "PostToolUse",
        })).resolves.toMatchObject({ inserted: 1, pendingCount: 1 });
        observed = await client.post("/promote-events", { cwd: fixture.projectPath });
        const after = await fixture.administrator.query<{
          memory_id: string; tag: string;
        }>({
          text: `SELECT memories.memory_id, tags.tag FROM lcm.promoted_memories memories
            JOIN lcm.promoted_memory_tags tags USING (project_id, memory_id)
            WHERE memories.project_id=$1 AND tags.tag='source:passive-capture'`,
          values: [fixture.project.projectId],
        }, { domain: "promoted-memory", operation: "verifyPassiveReinforcement" });
        passiveRows = after.rows;
      } finally {
        await daemon.stop();
      }
    });
    // Assert parity after awaited daemon/factory/database teardown and after the
    // fixture's no-fallback sentinels, so even a failed comparison proves cleanup.
    expect(ownedHome).toBeDefined();
    expect(ownedProjectRoot).toBeDefined();
    expect(existsSync(ownedHome!)).toBe(false);
    expect(existsSync(ownedProjectRoot!)).toBe(false);
    expect(observed).toMatchObject({ promoted: 1, skipped: 0, errors: 0 });
    expect(passiveRows).toEqual([{
      memory_id: originalMemoryId, tag: "source:passive-capture",
    }]);
  });
});
