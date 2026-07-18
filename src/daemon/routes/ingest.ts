import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { getLcmConnection, closeLcmConnection, withLcmConnectionLock } from "../../db/connection.js";
import type { DaemonConfig } from "../config.js";
import { projectPaths, ensureProjectDir, isSafeTranscriptPath } from "../project.js";
import { sendJson } from "../server.js";
import type { RouteHandler } from "../server.js";
import { runLcmMigrations } from "../../db/migration.js";
import { upsertRedactionCounts } from "../../db/redaction-stats.js";
import { ConversationStore } from "../../store/conversation-store.js";
import { SummaryStore } from "../../store/summary-store.js";
import type { ParsedMessage } from "../../transcript.js";
import { normalizeTranscriptClient, parseTranscriptForClient } from "../../transcript-provider.js";
import { ScrubEngine } from "../../scrub.js";
import { validateCwd } from "../validate-cwd.js";

function isParsedMessage(value: unknown): value is ParsedMessage {
  if (!value || typeof value !== "object") return false;

  const message = value as Record<string, unknown>;
  return (
    typeof message.role === "string" &&
    ["user", "assistant", "system", "tool"].includes(message.role) &&
    typeof message.content === "string" &&
    typeof message.tokenCount === "number"
  );
}

function resolveMessages(input: { client?: unknown; messages?: unknown; provider?: unknown; transcript_path?: string }, cwd: string): ParsedMessage[] {
  if (Array.isArray(input.messages)) {
    return input.messages.filter(isParsedMessage);
  }

  if (input.transcript_path) {
    const safePath = isSafeTranscriptPath(input.transcript_path, cwd);
    if (safePath && existsSync(safePath)) {
      return parseTranscriptForClient(safePath, normalizeTranscriptClient(input.client ?? input.provider));
    }
  }

  return [];
}

export function createIngestHandler(config: DaemonConfig): RouteHandler {
  return async (_req, res, body) => {
    const input = JSON.parse(body || "{}");
    const { session_id } = input;

    if (!session_id || !input.cwd) {
      sendJson(res, 400, { error: "session_id and cwd are required" });
      return;
    }

    let cwd: string;
    try {
      cwd = validateCwd(input.cwd);
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : "invalid cwd" });
      return;
    }

    const paths = projectPaths(cwd);
    const dbPath = paths.dbPath;

    const parsed = resolveMessages(input, cwd);
    if (parsed.length === 0) {
      sendJson(res, 200, { ingested: 0, totalTokens: 0 });
      return;
    }

    ensureProjectDir(cwd);

    const scrubber = await ScrubEngine.forProject(
      config.security?.sensitivePatterns ?? [],
      paths.dir,
    );

    await withLcmConnectionLock(dbPath, async () => {
      const db = getLcmConnection(dbPath);
      try {
      runLcmMigrations(db);

      // Check if session is already fully ingested in session_ingest_log — using the same
      // db connection to avoid double-open overhead and lock contention.
      try {
        const row = db.prepare("SELECT message_count FROM session_ingest_log WHERE session_id = ?").get(session_id) as { message_count: number } | undefined;
        if (row && parsed.length <= row.message_count) {
          // Session already fully ingested — skip
          sendJson(res, 200, { ingested: 0, totalTokens: 0 });
          return;
        }
      } catch {
        // Table may not exist yet — proceed with normal flow
      }
      const conversationStore = new ConversationStore(db);
      const summaryStore = new SummaryStore(db);
      const conversation = await conversationStore.getOrCreateConversation(session_id);

      const storedCount = await conversationStore.getMessageCount(conversation.conversationId);
      const newMessages = parsed.slice(storedCount);

      if (newMessages.length === 0) {
        sendJson(res, 200, { ingested: 0, totalTokens: 0 });
        return;
      }

      const pid = paths.id;
      const totalCounts = { gitleaks: 0, builtIn: 0, global: 0, project: 0 };
      const inputs = newMessages.map((m, i) => {
        const { text: scrubbedContent, gitleaks, builtIn, global: globalCount, project } = scrubber.scrubWithCounts(m.content);
        totalCounts.gitleaks += gitleaks;
        totalCounts.builtIn += builtIn;
        totalCounts.global += globalCount;
        totalCounts.project += project;
        return {
          conversationId: conversation.conversationId,
          seq: storedCount + i,
          role: m.role as "user" | "assistant" | "system" | "tool",
          content: scrubbedContent,
          tokenCount: m.tokenCount,
        };
      });
      const records = await conversationStore.withTransaction(async () => {
        const created = await conversationStore.createMessagesBulk(inputs);
        upsertRedactionCounts(db, pid, totalCounts);
        await summaryStore.appendContextMessages(conversation.conversationId, created.map((r) => r.messageId));
        return created;
      });

      // Update meta.json with lastIngest timestamp
      try {
        const metaPath = paths.metaPath;
        let meta: Record<string, unknown> = {};
        if (existsSync(metaPath)) {
          meta = JSON.parse(readFileSync(metaPath, "utf-8"));
        }
        meta.cwd = paths.canonical;
        meta.lastIngest = new Date().toISOString();
        writeFileSync(metaPath, JSON.stringify(meta, null, 2) + "\n");
      } catch {
        // non-fatal: meta.json update failure shouldn't fail the ingest
      }

      const totalTokens = await summaryStore.getContextTokenCount(conversation.conversationId);
      const totalRedacted = totalCounts.gitleaks + totalCounts.builtIn + totalCounts.global + totalCounts.project;
      const redactionCategories: string[] = [];
      if (totalCounts.gitleaks > 0) redactionCategories.push("gitleaks");
      if (totalCounts.builtIn > 0) redactionCategories.push("built_in");
      if (totalCounts.global > 0) redactionCategories.push("global");
      if (totalCounts.project > 0) redactionCategories.push("project");
      sendJson(res, 200, {
        ingested: records.length,
        totalTokens,
        ...(totalRedacted > 0 ? { redacted: totalRedacted, redactedCategories: redactionCategories } : {}),
      });
      } catch (err) {
        sendJson(res, 500, { error: err instanceof Error ? err.message : "ingest failed" });
      } finally {
        closeLcmConnection(dbPath);
      }
    });
  };
}
