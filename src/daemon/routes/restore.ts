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
  createStorageBackendFactory,
  type ProjectStorage,
  type StorageBackendFactory,
} from "../../storage/index.js";
import { closeRouteStorage, openExistingProject } from "./storage-lifecycle.js";
const MAX_SESSION_INSTRUCTIONS_BYTES = 1024 * 1024;

function sessionInstructionsId(client: TranscriptClient): number {
  return client === "codex" ? 2 : 1;
}

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

export function createRestoreHandler(
  config: DaemonConfig,
  storageFactory?: StorageBackendFactory,
): RouteHandler {
  return async (_req, res, body) => {
    let project: ProjectStorage | undefined;
    let ownedFactory: StorageBackendFactory | undefined;
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
      const openProject = async (createIfMissing: boolean): Promise<ProjectStorage | null> => {
        if (project) return project;
        const factory = storageFactory
          ?? ownedFactory
          ?? (ownedFactory = createStorageBackendFactory(config.storage));
        const identity = projectIdentity(cwd!);
        project = createIfMissing
          ? await factory.openProject(identity)
          : await openExistingProject(factory, identity) ?? undefined;
        return project ?? null;
      };

      // Post-compaction detection
      const isPostCompact =
        source === "compact" ||
        (justCompactedMap.has(session_id) && Date.now() - justCompactedMap.get(session_id)! < JUST_COMPACTED_TTL_MS);

      // Query session_instructions for compact/resume paths
      let instructionsContext = "";
      if (cwd) {
        try {
          const storage = await openProject(!isPostCompact);
          if (storage) {
            const row = await storage.coordination.getSessionInstructions(
              instructionsId,
              client === "claude" ? 1 : undefined,
            );
            if (row) {
              instructionsContext = `<project-instructions>\n${row.content}\n</project-instructions>`;
            }
          }
        } catch { /* non-fatal */ }
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
        try {
          // createIfMissing=true either opens a project or throws; it cannot
          // produce the null used by post-compaction existence checks.
          const storage = await openProject(true) as ProjectStorage;
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

          // Promoted: cross-session knowledge from SQLite
          try {
            const maxAgeDays = config.restoration.restoreMaxPromotedAgeDays;
            const cutoffMs = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
            // Fetch more candidates than needed, then filter by age before capping.
            // This prevents old memories from consuming the top-5 slots and leaving
            // fewer results than available when newer memories exist.
            const results = (await storage.lexicalSearch.searchPromoted(`project context ${cwd}`, 20))
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
              const existing = await storage.coordination.getSessionInstructions(instructionsId);

              if (!existing || existing.contentHash !== hash) {
                await storage.coordination.upsertSessionInstructions(
                  instructionsId,
                  instructionContent,
                  hash,
                );
              }
              instructionsContext = `<project-instructions>\n${instructionContent}\n</project-instructions>`;
            } else {
              await storage.coordination.deleteSessionInstructions(instructionsId);
              instructionsContext = "";
            }
          } catch { /* non-fatal */ }
        } catch { /* non-fatal */ }
      }

      // Query passive-capture insights from promoted store
      let insights: Array<{ content: string; confidence: number; tags: string[] }> = [];
      if (cwd) {
        try {
          const storage = await openProject(true) as ProjectStorage;
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
    } finally {
      await closeRouteStorage(project, ownedFactory);
    }
  };
}
