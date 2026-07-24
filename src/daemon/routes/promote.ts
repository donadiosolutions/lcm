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
  createStorageBackendFactory,
  type ProjectStorage,
  type StorageBackendFactory,
} from "../../storage/index.js";
import {
  closeRouteStorage,
  openExistingProject,
  storageRouteFailureResponse,
} from "./storage-lifecycle.js";

export function createPromoteHandler(
  config: DaemonConfig,
  storageFactory?: StorageBackendFactory,
): RouteHandler {
  return async (_req, res, body) => {
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

    const paths = projectPaths(cwd);
    const dbPath = paths.dbPath;

    let processed = 0;
    let promoted = 0;
    let totalConversations = 0;

    let project: ProjectStorage | undefined;
    let ownedFactory: StorageBackendFactory | undefined;
    let activeFactory: StorageBackendFactory | undefined;
    try {
        const identity = projectIdentity(cwd, config.storage);
        activeFactory = storageFactory ?? (ownedFactory = createStorageBackendFactory(config.storage));
        project = await openExistingProject(activeFactory, identity) ?? undefined;
        if (!project) {
          sendJson(res, 200, { processed: 0, promoted: 0 });
          return;
        }
        mkdirSync(dirname(dbPath), { recursive: true });

        const scrubber = await ScrubEngine.forProject(
          config.security.sensitivePatterns,
          dirname(dbPath),
        );

        // Get summary IDs that have already been promoted (to avoid re-promoting)
        const alreadyPromotedContent = new Set(
          (await project.promotedMemory.listContentPrefixes(10000)).map((c) => c.slice(0, 100)),
        );

        const conversations = await project.conversations.listConversations();
        totalConversations = conversations.length;

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
              } catch { /* non-fatal — don't count failed promotions */ }
            }
          }
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
    } catch (err) {
      const storageFailure = storageRouteFailureResponse(activeFactory, err, "promote");
      if (storageFailure) {
        sendJson(res, storageFailure.status, storageFailure.body);
        return;
      }
      sendJson(res, 500, { error: err instanceof Error ? err.message : "promote failed" });
      return;
    } finally {
      await closeRouteStorage(project, ownedFactory);
    }

    sendJson(res, 200, { processed, promoted, conversations: totalConversations });
  };
}
