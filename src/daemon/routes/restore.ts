import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { DaemonConfig } from "../config.js";
import { projectDbPath } from "../project.js";
import { buildOrientationPrompt } from "../orientation.js";
import { sendJson } from "../server.js";
import type { RouteHandler } from "../server.js";
import { runLcmMigrations } from "../../db/migration.js";
import { PromotedStore } from "../../db/promoted.js";
import { justCompactedMap, JUST_COMPACTED_TTL_MS } from "./compact.js";
import { fenceContent } from "../content-fence.js";
import { validateCwd } from "../validate-cwd.js";
import { normalizeTranscriptClient, type TranscriptClient } from "../../transcript-provider.js";

type SessionInstructionsRow = {
  content: string;
  content_hash: string;
  updated_at: string;
};

const SESSION_INSTRUCTION_CACHE_TABLE = "session_instruction_cache";

function sessionInstructionsId(client: TranscriptClient): number {
  return client === "codex" ? 2 : 1;
}

function readSessionInstructionsRow(
  db: DatabaseSync,
  instructionsId: number,
  client: TranscriptClient,
): SessionInstructionsRow | undefined {
  const row = db
    .prepare(`SELECT content, content_hash, updated_at FROM ${SESSION_INSTRUCTION_CACHE_TABLE} WHERE id = ?`)
    .get(instructionsId) as SessionInstructionsRow | undefined;
  if (row || client !== "claude") return row;

  return db
    .prepare(`SELECT content, content_hash, updated_at FROM session_instructions WHERE id = 1`)
    .get() as SessionInstructionsRow | undefined;
}

function readSessionInstructionFiles(cwd: string, client: TranscriptClient): string {
  const isCodex = client === "codex";
  const paths = [
    isCodex
      ? { label: "~/.codex/AGENTS.md", path: join(homedir(), ".codex", "AGENTS.md") }
      : { label: "~/.claude/CLAUDE.md", path: join(homedir(), ".claude", "CLAUDE.md") },
    isCodex
      ? { label: `${cwd}/AGENTS.md`, path: join(cwd, "AGENTS.md") }
      : { label: `${cwd}/CLAUDE.md`, path: join(cwd, "CLAUDE.md") },
    isCodex
      ? { label: `${cwd}/.codex/AGENTS.md`, path: join(cwd, ".codex", "AGENTS.md") }
      : { label: `${cwd}/.claude/CLAUDE.md`, path: join(cwd, ".claude", "CLAUDE.md") },
  ];

  const parts: string[] = [];
  for (const { label, path } of paths) {
    try {
      const content = readFileSync(path, "utf8");
      parts.push(`# ${label}\n${content}`);
    } catch {
      // file doesn't exist or can't be read — skip silently
    }
  }

  return parts.join("\n\n");
}

export function createRestoreHandler(config: DaemonConfig): RouteHandler {
  return async (_req, res, body) => {
    try {
      const input = JSON.parse(body || "{}");
      const { session_id, source } = input;
      const client = normalizeTranscriptClient(input.client);
      const instructionsId = sessionInstructionsId(client);
      let cwd: string | undefined;
      if (input.cwd) {
        try {
          cwd = validateCwd(input.cwd);
        } catch (err) {
          sendJson(res, 400, { error: err instanceof Error ? err.message : "invalid cwd" });
          return;
        }
      }
      const orientation = buildOrientationPrompt();

      // Post-compaction detection
      const isPostCompact =
        source === "compact" ||
        (justCompactedMap.has(session_id) && Date.now() - justCompactedMap.get(session_id)! < JUST_COMPACTED_TTL_MS);

      // Query session_instructions for compact/resume paths
      let instructionsContext = "";
      if (cwd) {
        const dbPath = projectDbPath(cwd);
        if (existsSync(dbPath)) {
          try {
            const db = new DatabaseSync(dbPath);
            try {
              runLcmMigrations(db);
              const row = readSessionInstructionsRow(db, instructionsId, client);
              if (row) {
                instructionsContext = `<project-instructions>\n${row.content}\n</project-instructions>`;
              }
            } finally {
              db.close();
            }
          } catch { /* non-fatal */ }
        }
      }

      if (isPostCompact) {
        const context = [orientation, instructionsContext].filter(Boolean).join("\n\n");
        sendJson(res, 200, { context });
        return;
      }

      let episodicContext = "";
      let promotedContext = "";

      // Episodic: query recent summaries from project SQLite DB.
      // Also capture client-specific instruction files on startup.
      if (cwd) {
        const dbPath = projectDbPath(cwd);
        mkdirSync(dirname(dbPath), { recursive: true });
        const db = new DatabaseSync(dbPath);
        try {
          runLcmMigrations(db);

          const rows = db.prepare(
            `SELECT s.content FROM summaries s
             JOIN conversations c ON s.conversation_id = c.conversation_id
             WHERE c.session_id = ?
             ORDER BY s.depth DESC, s.created_at DESC
             LIMIT ?`,
          ).all(session_id, config.restoration.recentSummaries) as Array<{ content: string }>;

          if (rows.length > 0) {
            episodicContext = fenceContent(
              rows.map((r) => r.content).join("\n\n"),
              "recent-session-context",
            );
          }

          // Promoted: cross-session knowledge from SQLite
          try {
            const promotedStore = new PromotedStore(db);
            const maxAgeDays = config.restoration.restoreMaxPromotedAgeDays;
            const cutoffMs = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
            // Fetch more candidates than needed, then filter by age before capping.
            // This prevents old memories from consuming the top-5 slots and leaving
            // fewer results than available when newer memories exist.
            const results = promotedStore
              .search(`project context ${cwd}`, 20)
              .filter((r) => !r.createdAt || Date.parse(r.createdAt) >= cutoffMs)
              .slice(0, 5);
            if (results.length > 0) {
              promotedContext = fenceContent(
                results.map((r) => r.content).join("\n\n"),
                "project-knowledge",
              );
            }
          } catch { /* non-fatal */ }

          // Capture instruction files and upsert into the client-specific row if changed.
          try {
            const instructionContent = readSessionInstructionFiles(cwd, client);
            if (instructionContent) {
              const hash = createHash("sha256").update(instructionContent).digest("hex");
              const existing = db
                .prepare(`SELECT content_hash FROM ${SESSION_INSTRUCTION_CACHE_TABLE} WHERE id = ?`)
                .get(instructionsId) as { content_hash: string } | undefined;

              if (!existing || existing.content_hash !== hash) {
                db.prepare(
                  `INSERT INTO ${SESSION_INSTRUCTION_CACHE_TABLE} (id, content, content_hash, updated_at)
                   VALUES (?, ?, ?, datetime('now'))
                   ON CONFLICT(id) DO UPDATE SET
                     content = excluded.content,
                     content_hash = excluded.content_hash,
                     updated_at = excluded.updated_at`,
                ).run(instructionsId, instructionContent, hash);
              }
              if (client === "codex") {
                instructionsContext = `<project-instructions>\n${instructionContent}\n</project-instructions>`;
              }
            }
          } catch { /* non-fatal */ }

          db.close();
        } catch { /* non-fatal */ }
      }

      // Query passive-capture insights from promoted store
      let insights: Array<{ content: string; confidence: number; tags: string[] }> = [];
      if (cwd) {
        try {
          const dbPath = projectDbPath(cwd);
          if (existsSync(dbPath)) {
            const insightsDb = new DatabaseSync(dbPath);
            try {
              runLcmMigrations(insightsDb);
              const insightsStore = new PromotedStore(insightsDb);
              const thresholds = config.compaction.promotionThresholds;
              const minConfidence = thresholds.eventConfidence?.pattern ?? 0.3;
              const maxAgeDays = thresholds.insightsMaxAgeDays ?? 90;
              const cutoffMs = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
              insights = insightsStore
                .search("source passive capture", 10, ["source:passive-capture"])
                .filter((r) => r.confidence >= minConfidence && (!r.createdAt || Date.parse(r.createdAt) >= cutoffMs))
                .slice(0, 5)
                .map((r) => ({ content: r.content, confidence: r.confidence, tags: r.tags }));
            } finally {
              insightsDb.close();
            }
          }
        } catch { /* non-fatal */ }
      }

      const context = [orientation, episodicContext, promotedContext, instructionsContext].filter(Boolean).join("\n\n");
      const responseBody: { context: string; insights?: Array<{ content: string; confidence: number; tags: string[] }> } = { context };
      if (insights.length > 0) {
        responseBody.insights = insights;
      }
      sendJson(res, 200, responseBody);
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : "restore failed" });
    }
  };
}
