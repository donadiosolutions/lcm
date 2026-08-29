import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { DaemonConfig } from "../config.js";
import { projectIdentity } from "../project.js";
import { buildOrientationPrompt } from "../orientation.js";
import { sendJson } from "../server.js";
import type { RouteHandler } from "../server.js";
import { justCompactedMap, JUST_COMPACTED_TTL_MS } from "./compact.js";
import { fenceContent } from "../content-fence.js";
import { validateCwd } from "../validate-cwd.js";
import { normalizeTranscriptClient, type TranscriptClient } from "../../transcript-provider.js";
import { readBoundedRegularFile } from "../../security-files.js";
import {
  type SessionInstructionsScope,
  type StorageBackendFactory,
} from "../../storage/index.js";
import { StorageOperationError } from "../../storage/errors.js";
import {
  resolveGitProjectAnchor,
  type GitProjectAnchor,
} from "../../git-project.js";
import {
  storageRouteFailureResponse,
  withProjectStorage,
} from "./storage-lifecycle.js";
import { validateSessionInstructionsScope } from "../../storage/session-instructions.js";
import { isAbortError } from "../cancellation.js";
const MAX_SESSION_INSTRUCTIONS_BYTES = 1024 * 1024;

type InstructionPath = { label: string; path: string; allowedRoot: string };

function codexInstructionPaths(cwd: string): InstructionPath[] {
  const dirs: string[] = [];
  for (let dir = cwd; ; dir = dirname(dir)) {
    dirs.push(dir);
    const parent = dirname(dir);
    if (parent === dir) break;
  }

  return [
    { label: "~/.codex/AGENTS.md", path: join(homedir(), ".codex", "AGENTS.md"), allowedRoot: join(homedir(), ".codex") },
    ...dirs.reverse().map((dir) => ({ label: `${dir}/AGENTS.md`, path: join(dir, "AGENTS.md"), allowedRoot: dir })),
    { label: `${cwd}/.codex/AGENTS.md`, path: join(cwd, ".codex", "AGENTS.md"), allowedRoot: cwd },
  ];
}

function readSessionInstructionFiles(cwd: string, client: TranscriptClient): string {
  const isCodex = client === "codex";
  const paths = isCodex
    ? codexInstructionPaths(cwd)
    : [
      { label: "~/.claude/CLAUDE.md", path: join(homedir(), ".claude", "CLAUDE.md"), allowedRoot: join(homedir(), ".claude") },
      { label: `${cwd}/CLAUDE.md`, path: join(cwd, "CLAUDE.md"), allowedRoot: cwd },
      { label: `${cwd}/.claude/CLAUDE.md`, path: join(cwd, ".claude", "CLAUDE.md"), allowedRoot: cwd },
    ];

  const parts: string[] = [];
  let remainingBytes = MAX_SESSION_INSTRUCTIONS_BYTES;
  for (const { label, path, allowedRoot } of paths) {
    const overheadBytes = 2 + Buffer.byteLength(label, "utf-8") + 1 + (parts.length > 0 ? 2 : 0);
    if (overheadBytes >= remainingBytes) continue;
    try {
      const content = readBoundedRegularFile(path, {
        allowedRoot,
        maxBytes: remainingBytes - overheadBytes,
      });
      const prefix = `# ${label}\n`;
      parts.push(`${prefix}${content}`);
      remainingBytes -= overheadBytes + Buffer.byteLength(content, "utf-8");
    } catch {
      // file doesn't exist or can't be read — skip silently
    }
  }

  return parts.join("\n\n");
}

function anchorsMatch(
  left: GitProjectAnchor | null,
  right: GitProjectAnchor | null,
): boolean {
  return left === null
    ? right === null
    : right !== null
      && left.canonical === right.canonical
      && left.worktreeRoot === right.worktreeRoot
      && left.commonDir === right.commonDir;
}

export function createRestoreHandler(
  config: DaemonConfig,
  storageFactory?: StorageBackendFactory,
): RouteHandler {
  return async (_req, res, body, routeContext) => {
    try {
      const input = JSON.parse(body || "{}");
      const { session_id, source } = input;
      const client = normalizeTranscriptClient(input.client);
      let cwd: string | undefined;
      if (input.cwd) {
        try {
          cwd = validateCwd(input.cwd);
        } catch (err) {
          sendJson(res, 400, { error: err instanceof Error ? err.message : "invalid cwd" });
          return;
        }
      }
      if (
        cwd
        && (typeof session_id !== "string" || session_id.length === 0)
      ) {
        sendJson(res, 400, { error: "session_id must be a non-empty string" });
        return;
      }
      const orientation = buildOrientationPrompt();
      let instructionScope: SessionInstructionsScope | undefined;
      if (cwd) {
        try {
          const before = resolveGitProjectAnchor(cwd);
          projectIdentity(cwd, config.storage, routeContext?.publicationLockToken);
          const after = resolveGitProjectAnchor(cwd);
          if (!anchorsMatch(before, after)) {
            throw new Error("Git worktree topology changed during storage admission");
          }
          instructionScope = {
            clientName: client,
            sessionId: session_id,
            worktreePath: after?.worktreeRoot ?? cwd,
            cwdPath: cwd,
          };
          validateSessionInstructionsScope(instructionScope);
        } catch (error) {
          const storageFailure = storageRouteFailureResponse(config.storage.backend, error, "restore", storageFactory);
          if (storageFailure) {
            sendJson(res, storageFailure.status, storageFailure.body);
            return;
          }
          sendJson(res, 200, { context: orientation });
          return;
        }
      }

      // Post-compaction detection
      const isPostCompact =
        source === "compact" ||
        (justCompactedMap.has(session_id) && Date.now() - justCompactedMap.get(session_id)! < JUST_COMPACTED_TTL_MS);

      // File-system instruction discovery is deliberately outside selected
      // storage admission. Only the corresponding repository read/write below
      // is fenced and lifecycle-managed.
      const instructionContent = cwd && !isPostCompact
        ? readSessionInstructionFiles(cwd, client)
        : "";

      let responseBody: { context: string; insights?: Array<{ content: string; confidence: number; tags: string[] }> } | null;
      try {
        responseBody = cwd
          ? await withProjectStorage(
            {
              config,
              cwd,
              factory: storageFactory,
              context: routeContext,
              mode: isPostCompact ? "existing" : "create",
            },
            async (storage) => {
              const rethrowPostgreSqlStorageFailure = (error: unknown): void => {
                if (config.storage.backend === "postgresql" && error instanceof StorageOperationError) {
                  throw error;
                }
              };

              let instructionsContext = "";
              try {
                const row = await storage.coordination.getSessionInstructions(instructionScope!);
                if (row) {
                  instructionsContext = `<project-instructions>\n${row.content}\n</project-instructions>`;
                }
              } catch (error) {
                rethrowPostgreSqlStorageFailure(error);
                // Other restoration read failures remain non-fatal.
              }

              if (isPostCompact) {
                const context = [orientation, instructionsContext].filter(Boolean).join("\n\n");
                return { context };
              }

              let episodicContext = "";
              let promotedContext = "";

              try {
                const rows = await storage.summaries.listRecentSummariesForSession(
                  session_id,
                  config.restoration.recentSummaries,
                );

                if (rows.length > 0) {
                  episodicContext = fenceContent(
                    rows.map((r) => r.content).join("\n\n"),
                    "recent-session-context",
                  );
                }

                try {
                  const maxAgeDays = config.restoration.restoreMaxPromotedAgeDays;
                  const cutoffMs = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
                  const results = (await storage.lexicalSearch.searchPromoted(`project context ${cwd}`, 20))
                    .filter((r) => !r.createdAt || Date.parse(r.createdAt) >= cutoffMs)
                    .slice(0, 5);
                  if (results.length > 0) {
                    promotedContext = fenceContent(
                      results.map((r) => r.content).join("\n\n"),
                      "project-knowledge",
                    );
                  }
                } catch (error) {
                  rethrowPostgreSqlStorageFailure(error);
                  // Non-fatal for SQLite and non-storage compatibility failures.
                }

                try {
                  if (instructionContent) {
                    instructionsContext = `<project-instructions>\n${instructionContent}\n</project-instructions>`;
                    const hash = createHash("sha256").update(instructionContent).digest("hex");
                    const existing = await storage.coordination.getSessionInstructions(instructionScope!);

                    if (!existing || existing.contentHash !== hash) {
                      await storage.coordination.upsertSessionInstructions(
                        instructionScope!,
                        instructionContent,
                        hash,
                      );
                    }
                  } else {
                    instructionsContext = "";
                    await storage.coordination.deleteSessionInstructions(instructionScope!);
                  }
                } catch (error) {
                  rethrowPostgreSqlStorageFailure(error);
                  // Non-fatal for SQLite and non-storage compatibility failures.
                }
              } catch (error) {
                rethrowPostgreSqlStorageFailure(error);
                // Other restoration read failures remain non-fatal.
              }

              let insights: Array<{ content: string; confidence: number; tags: string[] }> = [];
              try {
                const thresholds = config.compaction.promotionThresholds;
                const minConfidence = thresholds.eventConfidence?.pattern ?? 0.3;
                const maxAgeDays = thresholds.insightsMaxAgeDays ?? 90;
                const cutoffMs = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
                insights = (await storage.lexicalSearch.searchPromoted(
                  "source passive capture",
                  10,
                  ["source:passive-capture"],
                ))
                  .filter((r) => r.confidence >= minConfidence && (!r.createdAt || Date.parse(r.createdAt) >= cutoffMs))
                  .slice(0, 5)
                  .map((r) => ({ content: r.content, confidence: r.confidence, tags: r.tags }));
              } catch (error) {
                rethrowPostgreSqlStorageFailure(error);
                // Other passive-insight read failures remain non-fatal.
              }

              const context = [orientation, episodicContext, promotedContext, instructionsContext].filter(Boolean).join("\n\n");
              const result: { context: string; insights?: Array<{ content: string; confidence: number; tags: string[] }> } = { context };
              if (insights.length > 0) result.insights = insights;
              return result;
            },
            )
          : null;
      } catch (error) {
        if (isAbortError(error)) throw error;
        const storageFailure = storageRouteFailureResponse(config.storage.backend, error, "restore", storageFactory);
        if (storageFailure) {
          sendJson(res, storageFailure.status, storageFailure.body);
          return;
        }
        // Restoration is best-effort for non-storage failures, including a
        // selected SQLite project that cannot be opened.
        sendJson(res, 200, { context: orientation });
        return;
      }

      sendJson(res, 200, responseBody ?? { context: orientation });
    } catch (err) {
      if (isAbortError(err)) throw err;
      const storageFailure = storageRouteFailureResponse(config.storage.backend, err, "restore", storageFactory);
      if (storageFailure) {
        sendJson(res, storageFailure.status, storageFailure.body);
        return;
      }
      sendJson(res, 500, { error: err instanceof Error ? err.message : "restore failed" });
    }
  };
}
