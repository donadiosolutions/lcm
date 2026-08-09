import type { ExtractedEvent } from "./extractors.js";
import { statSync } from "node:fs";
import { dirname } from "node:path";
import { loadHookConfig } from "./config.js";
import { localProjectDir } from "../daemon/project.js";
import { configPath } from "../runtime-paths.js";
import { ScrubEngine } from "../scrub.js";
import {
  isBackendPublicationJournalError,
} from "./publication-fence.js";
import { OWNER_ONLY_FILE_MODES, readBoundedRegularFile } from "../security-files.js";

interface ScrubCacheEntry {
  engine: ScrubEngine;
  patternsKey: string;
  projectPatternsMtime: number;
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

async function getScrubber(patterns: string[], projDir: string): Promise<ScrubEngine> {
  const patternsKey = JSON.stringify(patterns);
  const mtime = projectPatternsMtime(projDir);
  const cached = scrubCache.get(projDir);
  if (
    cached
    && cached.patternsKey === patternsKey
    && cached.projectPatternsMtime === mtime
  ) {
    // Refresh insertion order so the bounded map behaves as an LRU cache.
    scrubCache.delete(projDir);
    scrubCache.set(projDir, cached);
    return cached.engine;
  }

  const engine = await ScrubEngine.forProject(patterns, projDir);
  scrubCache.delete(projDir);
  if (scrubCache.size >= scrubCacheMax) {
    scrubCache.delete(scrubCache.keys().next().value as string);
  }
  scrubCache.set(projDir, {
    engine,
    patternsKey,
    projectPatternsMtime: mtime,
  });
  return engine;
}

function persistedSensitivePatterns(): string[] {
  try {
    return loadHookConfig(configPath()).security.sensitivePatterns;
  } catch (error) {
    if (!isBackendPublicationJournalError(error)) throw error;
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
  const scrubber = await getScrubber(patterns, localProjectDir(cwd));
  return events.map((event) => ({
    ...event,
    data: scrubber.scrub(event.data),
    ...(event.tags
      ? { tags: event.tags.map((tag) => scrubber.scrub(tag)) }
      : {}),
  }));
}
