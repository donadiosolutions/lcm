import type { ExtractedEvent } from "./extractors.js";
import { loadDaemonConfig } from "../daemon/config.js";
import { projectDir } from "../daemon/project.js";
import { configPath } from "../runtime-paths.js";
import { ScrubEngine } from "../scrub.js";

export async function scrubExtractedEvents(
  events: readonly ExtractedEvent[],
  cwd: string,
  globalPatterns?: string[],
): Promise<ExtractedEvent[]> {
  const patterns = globalPatterns
    ?? loadDaemonConfig(configPath()).security.sensitivePatterns;
  const scrubber = await ScrubEngine.forProject(patterns, projectDir(cwd));
  return events.map((event) => ({
    ...event,
    data: scrubber.scrub(event.data),
    ...(event.tags
      ? { tags: event.tags.map((tag) => scrubber.scrub(tag)) }
      : {}),
  }));
}
