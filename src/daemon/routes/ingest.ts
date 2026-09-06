import { existsSync } from "node:fs";
import type { DaemonConfig } from "../config.js";
import {
  MAX_PROJECT_METADATA_BYTES,
  projectPathsForIdentity,
  ensureProjectDirForIdentity,
  isSafeTranscriptPath,
  projectIdentity,
} from "../project.js";
import {
  atomicWritePrivateFile,
  openPrivateDirectory,
  readBoundedRegularFile,
  type PrivateDirectoryHandle,
} from "../../security-files.js";
import { sendJson } from "../server.js";
import type { RouteHandler } from "../server.js";
import type { ParsedMessage } from "../../transcript.js";
import { normalizeTranscriptClient, parseTranscriptForClient } from "../../transcript-provider.js";
import { ScrubEngine } from "../../scrub.js";
import { validateCwd } from "../validate-cwd.js";
import { safeLogError } from "../../hooks/hook-errors.js";
import type { StorageBackendFactory } from "../../storage/index.js";
import { storageRouteFailureResponse, withProjectStorage } from "./storage-lifecycle.js";
import { BackendPublicationJournalError } from "../../storage/backend-publication.js";

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

function errorCode(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error
    && typeof error.code === "string"
    ? error.code
    : undefined;
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
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      sendJson(res, 400, { error: "invalid request body" });
      return;
    }
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

    try {
      // Preserve the route's early identity/configuration rejection while the
      // lifecycle helper re-resolves the identity with its live admission token.
      const storageIdentity = projectIdentity(
        cwd,
        config.storage,
        context?.publicationLockToken,
      );
      const localIdentity = {
        id: storageIdentity.localProjectId,
        canonical: storageIdentity.canonical,
        ...(storageIdentity.remoteProjectId === undefined
          ? {}
          : { remoteProjectId: storageIdentity.remoteProjectId }),
      };
      const paths = projectPathsForIdentity(localIdentity);
      const resolvedMessages = resolveMessages(input, cwd);
      if (config.storage.backend === "sqlite" && resolvedMessages.length === 0) {
        sendJson(res, 200, { ingested: 0, totalTokens: 0 });
        return;
      }
      const scrubber = resolvedMessages.length > 0
        ? await (async () => {
            ensureProjectDirForIdentity(localIdentity, { writeMetadata: false });
            return ScrubEngine.forProject(
              config.security?.sensitivePatterns ?? [],
              paths.dir,
            );
          })()
        : undefined;

      const ingest = await withProjectStorage(
        {
          config,
          cwd,
          factory: storageFactory,
          context,
          mode: "create",
          expectedIdentity: storageIdentity,
        },
        async (project) => {
          if (resolvedMessages.length === 0) return null;

          const persisted = await project.transaction(async (repositories) => {
            const row = await repositories.coordination.getSessionIngest(session_id);
            if (row && resolvedMessages.length <= row.messageCount) return null;

            const conversation = await repositories.conversations.getOrCreateConversation(session_id);
            const storedCount = await repositories.conversations.getMessageCount(conversation.conversationId);
            const newMessages = resolvedMessages.slice(storedCount);
            if (newMessages.length === 0) return null;

            const totalCounts = { gitleaks: 0, builtIn: 0, global: 0, project: 0 };
            const inputs = newMessages.map((m, i) => {
              const { text: scrubbedContent, gitleaks, builtIn, global: globalCount, project: projectCount } = scrubber!.scrubWithCounts(m.content);
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

          if (!persisted) return null;
          return {
            ...persisted,
            totalTokens: await project.context.getContextTokenCount(persisted.conversationId),
          };
        },
      );

      if (!ingest) {
        sendJson(res, 200, { ingested: 0, totalTokens: 0 });
        return;
      }

      // Update meta.json with lastIngest timestamp
      try {
        const metaPath = paths.metaPath;
        const expectedUid = typeof process.getuid === "function" ? process.getuid() : undefined;
        let meta: Record<string, unknown> = {};
        try {
          const parsed: unknown = JSON.parse(readBoundedRegularFile(metaPath, {
            allowedRoot: paths.dir,
            maxBytes: MAX_PROJECT_METADATA_BYTES,
            expectedUid,
            requireSingleLink: true,
          }));
          if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error("invalid project metadata");
          }
          meta = parsed as Record<string, unknown>;
        } catch (error) {
          if (errorCode(error) !== "ENOENT") throw error;
        }
        meta.cwd = paths.canonical;
        meta.lastIngest = new Date().toISOString();
        const serialized = JSON.stringify(meta, null, 2) + "\n";
        if (Buffer.byteLength(serialized, "utf8") > MAX_PROJECT_METADATA_BYTES) {
          throw new Error("project metadata exceeds size limit");
        }
        const parent: PrivateDirectoryHandle = openPrivateDirectory(paths.dir, { expectedUid });
        let primaryError: unknown;
        let hasPrimaryError = false;
        try {
          atomicWritePrivateFile(metaPath, serialized, {}, parent);
        } catch (error) {
          hasPrimaryError = true;
          primaryError = error;
        } finally {
          try {
            parent.close();
          } catch (error) {
            if (hasPrimaryError) {
              throw new AggregateError(
                [primaryError, error],
                "project metadata publication and directory cleanup failed",
                { cause: primaryError },
              );
            }
            throw error;
          }
        }
        if (hasPrimaryError) throw primaryError;
      } catch {
        // non-fatal: meta.json update failure shouldn't fail the ingest
      }

      const { records, totalCounts, totalTokens } = ingest;
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
      if (err instanceof BackendPublicationJournalError) {
        sendJson(res, 503, {
          status: "blocked",
          error: "backend publication admission blocked",
        });
        return;
      }
      await safeLogError("ingest", err, { cwd, sessionId: session_id });
      const storageFailure = storageRouteFailureResponse(config.storage.backend, err, "ingest", storageFactory);
      if (storageFailure) {
        sendJson(res, storageFailure.status, storageFailure.body);
        return;
      }
      sendJson(res, 500, { error: "ingest failed", code: "INGEST_FAILED" });
    }
  };
}
