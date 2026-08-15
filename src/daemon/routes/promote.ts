import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DaemonConfig } from "../config.js";
import { projectIdentity, projectPaths } from "../project.js";
import { sendJson } from "../server.js";
import type { RouteHandler } from "../server.js";
import { shouldPromote } from "../../promotion/detector.js";
import { deduplicateAndInsert } from "../../promotion/dedup.js";
import { validateCwd } from "../validate-cwd.js";
import { ScrubEngine } from "../../scrub.js";
import {
  type StorageBackendFactory,
} from "../../storage/index.js";
import { StorageOperationError } from "../../storage/errors.js";
import {
  storageRouteFailureResponse,
  withProjectStorage,
} from "./storage-lifecycle.js";

export function createPromoteHandler(
  config: DaemonConfig,
  storageFactory?: StorageBackendFactory,
): RouteHandler {
  return async (_req, res, body, context) => {
    const input = JSON.parse(body || "{}");
    const { dry_run = false } = input;

    if (!input.cwd) {
      sendJson(res, 400, { error: "cwd is required" });
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
    try {
      projectIdentity(cwd, config.storage, context?.publicationLockToken);
      mkdirSync(dirname(paths.metaPath), { recursive: true });
      const scrubber = await ScrubEngine.forProject(
        config.security.sensitivePatterns,
        dirname(paths.metaPath),
      );

      const result = await withProjectStorage(
        { config, cwd, factory: storageFactory, context, mode: "existing" },
        async (project) => {
          let processed = 0;
          let promoted = 0;

          // Get summary IDs that have already been promoted (to avoid re-promoting)
          const alreadyPromotedContent = new Set(
            (await project.promotedMemory.listContentPrefixes(10000)).map((c) => c.slice(0, 100)),
          );

          const conversations = await project.conversations.listConversations();

          for (const conversation of conversations) {
            const summaries = await project.summaries.getSummariesByConversation(conversation.conversationId);

            for (const summary of summaries) {
              const scrubbedContent = scrubber.scrub(summary.content);
              // Skip summaries whose content prefix is already in the promoted store
              // This prevents re-promoting on repeated runs (which would decay confidence)
              if (alreadyPromotedContent.has(scrubbedContent.slice(0, 100))) continue;

              processed++;

              const promotionResult = shouldPromote(
                {
                  content: summary.content,
                  depth: summary.depth,
                  tokenCount: summary.tokenCount,
                  sourceMessageTokenCount: summary.sourceMessageTokenCount,
                },
                config.compaction.promotionThresholds,
              );

              if (!promotionResult.promote) continue;

              if (dry_run) {
                promoted++;
              } else {
                try {
                  await deduplicateAndInsert({
                    transaction: project.transaction.bind(project),
                    content: scrubbedContent,
                    tags: promotionResult.tags.map((tag) => scrubber.scrub(tag)),
                    sourceProjectId: paths.id,
                    sessionId: conversation.sessionId,
                    depth: summary.depth,
                    confidence: promotionResult.confidence,
                    thresholds: {
                      dedupBm25Threshold: config.compaction.promotionThresholds.dedupBm25Threshold,
                      dedupCandidateLimit: config.compaction.promotionThresholds.dedupCandidateLimit,
                    },
                  });
                  alreadyPromotedContent.add(scrubbedContent.slice(0, 100));
                  promoted++;
                } catch (error) {
                  if (config.storage.backend === "postgresql" && error instanceof StorageOperationError) throw error;
                  // non-fatal for SQLite and other promotion failures
                }
              }
            }
          }

          return { processed, promoted, conversations: conversations.length };
        },
      );

      if (result === null) {
        sendJson(res, 200, { processed: 0, promoted: 0 });
        return;
      }

      // Update meta.json unless dry_run
      if (!dry_run) {
        try {
          const metaPath = paths.metaPath;
          let meta: Record<string, unknown> = {};
          try {
            meta = JSON.parse(readFileSync(metaPath, "utf-8"));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          meta.cwd = paths.canonical;
          meta.lastPromote = new Date().toISOString();
          writeFileSync(metaPath, JSON.stringify(meta, null, 2) + "\n");
        } catch { /* non-fatal */ }
      }

      sendJson(res, 200, result);
    } catch (err) {
      const storageFailure = storageRouteFailureResponse(config.storage.backend, err, "promote", storageFactory);
      if (storageFailure) {
        sendJson(res, storageFailure.status, storageFailure.body);
        return;
      }
      sendJson(res, 500, { error: err instanceof Error ? err.message : "promote failed" });
    }
  };
}
