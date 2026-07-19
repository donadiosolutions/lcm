import type { ExtractedEvent } from "./extractors.js";
import { statSync } from "node:fs";
import { loadDaemonConfig } from "../daemon/config.js";
import { projectDir } from "../daemon/project.js";
import { configPath } from "../runtime-paths.js";
import { ScrubEngine } from "../scrub.js";

interface ScrubCacheEntry {
  engine: ScrubEngine;
  patternsKey: string;
  projectPatternsMtime: number;
}

const SCRUB_CACHE_MAX = 100;
const scrubCache = new Map<string, ScrubCacheEntry>();

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
  if (scrubCache.size >= SCRUB_CACHE_MAX) {
    scrubCache.delete(scrubCache.keys().next().value as string);
  }
  scrubCache.set(projDir, {
    engine,
    patternsKey,
    projectPatternsMtime: mtime,
  });
  return engine;
}

export function clearEventScrubberCacheForTesting(): void {
  scrubCache.clear();
}

export async function scrubExtractedEvents(
  events: readonly ExtractedEvent[],
  cwd: string,
  globalPatterns?: string[],
): Promise<ExtractedEvent[]> {
  const patterns = globalPatterns
    ?? loadDaemonConfig(configPath()).security.sensitivePatterns;
  const scrubber = await getScrubber(patterns, projectDir(cwd));
  return events.map((event) => ({
    ...event,
    data: scrubber.scrub(event.data),
    ...(event.tags
      ? { tags: event.tags.map((tag) => scrubber.scrub(tag)) }
      : {}),
  }));
}
