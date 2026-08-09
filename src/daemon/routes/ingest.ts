import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { DaemonConfig } from "../config.js";
import {
  projectPaths,
  ensureProjectDir,
  isSafeTranscriptPath,
  projectIdentity,
} from "../project.js";
import { sendJson } from "../server.js";
import type { RouteHandler } from "../server.js";
import type { ParsedMessage } from "../../transcript.js";
import { normalizeTranscriptClient, parseTranscriptForClient } from "../../transcript-provider.js";
import { ScrubEngine } from "../../scrub.js";
import { validateCwd } from "../validate-cwd.js";
import { safeLogError } from "../../hooks/hook-errors.js";
import { createStorageBackendFactory, type ProjectStorage, type StorageBackendFactory } from "../../storage/index.js";
import { closeRouteStorage, storageRouteFailureResponse } from "./storage-lifecycle.js";

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

export function createIngestHandler(config: DaemonConfig, storageFactory?: StorageBackendFactory): RouteHandler {
  return async (_req, res, body, context) => {
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

    const paths = projectPaths(cwd, context?.publicationLockToken);
    let sqliteMessages: ParsedMessage[] | undefined;
    if (config.storage.backend === "sqlite") {
      sqliteMessages = resolveMessages(input, cwd);
      if (sqliteMessages.length === 0) {
        sendJson(res, 200, { ingested: 0, totalTokens: 0 });
        return;
      }
    }

    let project: ProjectStorage | undefined;
    let ownedFactory: StorageBackendFactory | undefined;
    let activeFactory: StorageBackendFactory | undefined;
    try {
      const identity = projectIdentity(cwd, config.storage, context?.publicationLockToken);
      let resolvedMessages: ParsedMessage[];
      if (config.storage.backend === "postgresql") {
        activeFactory = storageFactory
          ?? (ownedFactory = createStorageBackendFactory(
            config.storage,
            undefined,
            undefined,
            context?.publicationLockToken,
          ));
        project = await activeFactory.openProject(identity, context?.publicationLockToken);
        resolvedMessages = resolveMessages(input, cwd);
      } else {
        resolvedMessages = sqliteMessages as ParsedMessage[];
      }
      if (resolvedMessages.length === 0) {
        sendJson(res, 200, { ingested: 0, totalTokens: 0 });
        return;
      }
      ensureProjectDir(cwd, context?.publicationLockToken);
      const scrubber = await ScrubEngine.forProject(
        config.security?.sensitivePatterns ?? [],
        paths.dir,
      );
      if (!project) {
        activeFactory = storageFactory ?? (ownedFactory = createStorageBackendFactory(
          config.storage,
          undefined,
          undefined,
          context?.publicationLockToken,
        ));
        project = await activeFactory.openProject(identity, context?.publicationLockToken);
      }
      const ingest = await project.transaction(async (repositories) => {
        const row = await repositories.coordination.getSessionIngest(session_id);
        if (row && resolvedMessages.length <= row.messageCount) return null;

        const conversation = await repositories.conversations.getOrCreateConversation(session_id);
        const storedCount = await repositories.conversations.getMessageCount(conversation.conversationId);
        const newMessages = resolvedMessages.slice(storedCount);
        if (newMessages.length === 0) return null;

        const totalCounts = { gitleaks: 0, builtIn: 0, global: 0, project: 0 };
        const inputs = newMessages.map((m, i) => {
          const { text: scrubbedContent, gitleaks, builtIn, global: globalCount, project: projectCount } = scrubber.scrubWithCounts(m.content);
          totalCounts.gitleaks += gitleaks;
          totalCounts.builtIn += builtIn;
          totalCounts.global += globalCount;
          totalCounts.project += projectCount;
          return {
            conversationId: conversation.conversationId,
            seq: storedCount + i,
            role: m.role as "user" | "assistant" | "system" | "tool",
            content: scrubbedContent,
            tokenCount: m.tokenCount,
          };
        });
        const records = await repositories.conversations.createMessagesBulk(inputs);
        await repositories.redactionAdmin.upsertCounts(totalCounts);
        await repositories.context.appendContextMessages(
          conversation.conversationId,
          records.map((record) => record.messageId),
        );
        return { conversationId: conversation.conversationId, records, totalCounts };
      });

      if (!ingest) {
        sendJson(res, 200, { ingested: 0, totalTokens: 0 });
        return;
      }

      // Update meta.json with lastIngest timestamp
      try {
        const metaPath = paths.metaPath;
        let meta: Record<string, unknown> = {};
        try {
          meta = JSON.parse(readFileSync(metaPath, "utf-8"));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        meta.cwd = paths.canonical;
        meta.lastIngest = new Date().toISOString();
        writeFileSync(metaPath, JSON.stringify(meta, null, 2) + "\n");
      } catch {
        // non-fatal: meta.json update failure shouldn't fail the ingest
      }

      const totalTokens = await project.context.getContextTokenCount(ingest.conversationId);
      const { records, totalCounts } = ingest;
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
      await safeLogError("ingest", err, { cwd, sessionId: session_id });
      const storageFailure = storageRouteFailureResponse(activeFactory, err, "ingest");
      if (storageFailure) {
        sendJson(res, storageFailure.status, storageFailure.body);
        return;
      }
      sendJson(res, 500, { error: "ingest failed", code: "INGEST_FAILED" });
    } finally {
      await closeRouteStorage(project, ownedFactory);
    }
  };
}
