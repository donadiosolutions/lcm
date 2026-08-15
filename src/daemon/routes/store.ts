import { statSync } from "node:fs";
import { projectDir, projectIdentity } from "../project.js";
import { sendJson } from "../server.js";
import type { RouteHandler } from "../server.js";
import type { DaemonConfig } from "../config.js";
import { sanitizeError } from "../safe-error.js";
import { ScrubEngine } from "../../scrub.js";
import { validateCwd } from "../validate-cwd.js";
import {
  type StorageBackendFactory,
} from "../../storage/index.js";
import {
  stagedPostgreSqlFactoryUnavailableResponse,
  storageRouteFailureResponse,
  withProjectStorage,
} from "./storage-lifecycle.js";

/** Cache entry for a per-project ScrubEngine. */
interface ScrubCacheEntry {
  engine: ScrubEngine;
  /** mtime of sensitive-patterns.txt at the time the engine was created (ms). */
  mtime: number;
}

const SCRUB_CACHE_MAX = 100;
const scrubCache = new Map<string, ScrubCacheEntry>();

async function getScrubEngine(config: DaemonConfig, projDir: string): Promise<ScrubEngine> {
  const patternsFile = `${projDir}/sensitive-patterns.txt`;
  let mtime = 0;
  try { mtime = statSync(patternsFile).mtimeMs; } catch { /* file absent — mtime stays 0 */ }

  const cached = scrubCache.get(projDir);
  if (cached && cached.mtime === mtime) return cached.engine;

  const engine = await ScrubEngine.forProject(config.security?.sensitivePatterns ?? [], projDir);
  // Evict oldest entry when at capacity (simple LRU via insertion-order Map)
  if (scrubCache.size >= SCRUB_CACHE_MAX) {
    scrubCache.delete(scrubCache.keys().next().value as string);
  }
  scrubCache.set(projDir, { engine, mtime });
  return engine;
}

export function createStoreHandler(
  config: DaemonConfig,
  storageFactory?: StorageBackendFactory,
): RouteHandler {
  return async (_req, res, body, context) => {
    const input = JSON.parse(body || "{}");
    const { text, tags = [], metadata = {} } = input;

    if (typeof text !== "string" || !text) {
      sendJson(res, 400, { error: "text is required" });
      return;
    }
    if (!Array.isArray(tags) || !tags.every((tag) => typeof tag === "string")) {
      sendJson(res, 400, { error: "tags must be an array of strings" });
      return;
    }

    const rawProjectPath = input.cwd || metadata.projectPath || "";
    if (!rawProjectPath) {
      sendJson(res, 400, { error: "cwd or metadata.projectPath is required" });
      return;
    }

    let projectPath: string;
    try {
      projectPath = validateCwd(rawProjectPath);
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : "invalid cwd" });
      return;
    }

    try {
      // Reject an unbound project before local scrubber discovery. The
      // lifecycle helper repeats this resolution under its live token.
      projectIdentity(projectPath, config.storage, context?.publicationLockToken);
      const stagedFailure = stagedPostgreSqlFactoryUnavailableResponse(storageFactory, "store");
      if (stagedFailure) {
        sendJson(res, 503, stagedFailure);
        return;
      }
      const scrubber = await getScrubEngine(config, projectDir(projectPath, context?.publicationLockToken));
      const scrubbedText = scrubber.scrub(text);
      const scrubbedTags = tags.map((tag: string) => scrubber.scrub(tag));

      const id = await withProjectStorage(
        { config, cwd: projectPath, factory: storageFactory, context, mode: "create" },
        async (project) => project.promotedMemory.insert({
          content: scrubbedText,
          tags: scrubbedTags,
          sourceProjectId: metadata.projectId ?? "manual",
          sessionId: metadata.sessionId ?? "manual",
          depth: metadata.depth ?? 0,
          confidence: 1.0,
        }),
      );

      sendJson(res, 200, { stored: true, id });
    } catch (err) {
      const storageFailure = storageRouteFailureResponse(config.storage.backend, err, "store", storageFactory);
      if (storageFailure) {
        sendJson(res, storageFailure.status, storageFailure.body);
        return;
      }
      sendJson(res, 500, { error: sanitizeError(err instanceof Error ? err.message : "store failed") });
    }
  };
}
