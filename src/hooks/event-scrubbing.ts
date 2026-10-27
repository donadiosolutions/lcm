import type { ExtractedEvent } from "./extractors.js";
import { statSync } from "node:fs";
import { dirname } from "node:path";
import { join } from "node:path";
import { loadHookConfig } from "./config.js";
import { localHookPatternIdentity } from "../daemon/project.js";
import { configPath, lcmHomeDir } from "../runtime-paths.js";
import { ScrubEngine } from "../scrub.js";
import { PrivateMutationLockContentionError } from "../private-mutation-lock.js";
import {
  isBackendPublicationJournalError,
} from "./publication-fence.js";
import { OWNER_ONLY_FILE_MODES, readBoundedRegularFile } from "../security-files.js";
import { assertProjectStorageIdentityActive } from "../worktree-reconciliation-fence.js";

interface ScrubCacheEntry {
  engine: ScrubEngine;
  patternsKey: string;
  projectPatternsMtimes: string;
}

const SCRUB_CACHE_MAX = 100;
const scrubCache = new Map<string, ScrubCacheEntry>();
let scrubCacheMax = SCRUB_CACHE_MAX;

function projectPatternsMtime(projDir: string): number {
  try {
    return statSync(`${projDir}/sensitive-patterns.txt`).mtimeMs;
  } catch {
    return 0;
  }
}

async function getScrubber(patterns: string[], projDirs: readonly string[]): Promise<ScrubEngine> {
  const cacheKey = JSON.stringify(projDirs);
  const patternsKey = JSON.stringify(patterns);
  const mtimes = JSON.stringify(projDirs.map(projectPatternsMtime));
  const cached = scrubCache.get(cacheKey);
  if (
    cached
    && cached.patternsKey === patternsKey
    && cached.projectPatternsMtimes === mtimes
  ) {
    // Refresh insertion order so the bounded map behaves as an LRU cache.
    scrubCache.delete(cacheKey);
    scrubCache.set(cacheKey, cached);
    return cached.engine;
  }

  const engine = projDirs.length === 1
    ? await ScrubEngine.forProject(patterns, projDirs[0]!)
    : new ScrubEngine(patterns, (await Promise.all(projDirs.map((dir) =>
      ScrubEngine.loadProjectPatterns(join(dir, "sensitive-patterns.txt"))
    ))).flat());
  scrubCache.delete(cacheKey);
  if (scrubCache.size >= scrubCacheMax) {
    scrubCache.delete(scrubCache.keys().next().value as string);
  }
  scrubCache.set(cacheKey, {
    engine,
    patternsKey,
    projectPatternsMtimes: mtimes,
  });
  return engine;
}

function persistedSensitivePatterns(): string[] {
  try {
    return loadHookConfig(configPath()).security.sensitivePatterns;
  } catch (error) {
    if (!isBackendPublicationJournalError(error) && !(error instanceof PrivateMutationLockContentionError)) {
      throw error;
    }
    try {
      const content = readBoundedRegularFile(configPath(), {
        allowedRoot: dirname(configPath()),
        maxBytes: 4 * 1024 * 1024,
        allowedModes: OWNER_ONLY_FILE_MODES,
      });
      const parsed = JSON.parse(content) as { security?: { sensitivePatterns?: unknown } };
      return Array.isArray(parsed.security?.sensitivePatterns)
        ? parsed.security.sensitivePatterns.filter((pattern): pattern is string => typeof pattern === "string")
        : [];
    } catch {
      return [];
    }
  }
}

export function clearEventScrubberCacheForTesting(): void {
  scrubCache.clear();
  scrubCacheMax = SCRUB_CACHE_MAX;
}

export function _setEventScrubberCacheMaxForTesting(maxEntries: number): void {
  if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
    throw new RangeError("Event scrubber cache capacity must be a positive safe integer");
  }
  scrubCache.clear();
  scrubCacheMax = maxEntries;
}

export async function scrubExtractedEvents(
  events: readonly ExtractedEvent[],
  cwd: string,
  globalPatterns?: string[],
): Promise<ExtractedEvent[]> {
  const patterns = globalPatterns ?? persistedSensitivePatterns();
  // Hook capture must not enter backend-selected project-map reconciliation.
  // The local sidecar identity remains stable for ordinary projects and uses
  // the compatibility snapshot for already-mapped aliases/worktrees.
  const identity = localHookPatternIdentity(cwd);
  const projDirs = identity.patternIds.map((id) => join(lcmHomeDir(), "projects", id));
  for (const [index, id] of identity.patternIds.entries()) {
    assertProjectStorageIdentityActive(projDirs[index]!, id);
  }
  const scrubber = await getScrubber(patterns, projDirs);
  return events.map((event) => ({
    ...event,
    data: scrubber.scrub(event.data),
    ...(event.tags
      ? { tags: event.tags.map((tag) => scrubber.scrub(tag)) }
      : {}),
  }));
}
