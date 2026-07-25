import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearEventScrubberCacheForTesting,
  _setEventScrubberCacheMaxForTesting,
  scrubExtractedEvents,
} from "../../src/hooks/event-scrubbing.js";
import { projectDir } from "../../src/daemon/project.js";
import { ScrubEngine } from "../../src/scrub.js";

const dirs: string[] = [];
afterEach(() => {
  clearEventScrubberCacheForTesting();
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("passive event scrubbing", () => {
  it("redacts content and tags before sidecar persistence", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "lcm-event-scrub-"));
    dirs.push(cwd);
    const events = await scrubExtractedEvents([{
      type: "decision",
      category: "decision",
      data: "always use GLOBAL-1234",
      priority: 1,
      tags: ["token:GLOBAL-1234"],
    }], cwd, ["GLOBAL-[0-9]{4}"]);
    expect(events[0]).toMatchObject({
      data: "always use [REDACTED]",
      tags: ["[REDACTED]"],
    });
  });

  it("reuses a project scrubber and invalidates it when project patterns change", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "lcm-event-scrub-cache-"));
    dirs.push(cwd);
    const forProject = vi.spyOn(ScrubEngine, "forProject");
    const event = [{
      type: "decision" as const,
      category: "decision",
      data: "safe",
      priority: 1 as const,
    }];

    await scrubExtractedEvents(event, cwd, []);
    await scrubExtractedEvents(event, cwd, []);
    expect(forProject).toHaveBeenCalledTimes(1);

    const patternsPath = join(projectDir(cwd), "sensitive-patterns.txt");
    mkdirSync(projectDir(cwd), { recursive: true });
    writeFileSync(patternsPath, "CHANGED-[0-9]+\n");
    await scrubExtractedEvents(event, cwd, []);
    expect(forProject).toHaveBeenCalledTimes(2);

    await scrubExtractedEvents(event, cwd, ["GLOBAL-[0-9]+"]);
    expect(forProject).toHaveBeenCalledTimes(3);
  });

  it("bounds the project scrubber cache and evicts the least-recently-used entry", async () => {
    const root = mkdtempSync(join(tmpdir(), "lcm-event-scrub-lru-"));
    dirs.push(root);
    _setEventScrubberCacheMaxForTesting(2);
    const engine = { scrub: (text: string) => text } as ScrubEngine;
    const forProject = vi.spyOn(ScrubEngine, "forProject").mockResolvedValue(engine);
    const event = [{
      type: "decision" as const,
      category: "decision",
      data: "safe",
      priority: 1 as const,
    }];

    for (let index = 0; index <= 2; index++) {
      await scrubExtractedEvents(event, join(root, `project-${index}`), []);
    }
    expect(forProject).toHaveBeenCalledTimes(3);

    await scrubExtractedEvents(event, join(root, "project-0"), []);
    expect(forProject).toHaveBeenCalledTimes(4);
  });

  it("loads default configuration when patterns are not injected", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "lcm-event-default-scrub-"));
    dirs.push(cwd);
    const events = await scrubExtractedEvents([{
      type: "decision", category: "decision", data: `token sk-${"a".repeat(24)}`, priority: 1,
    }], cwd);
    expect(events[0].data).toContain("[REDACTED]");
  });
});
