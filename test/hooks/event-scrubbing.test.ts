import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import * as hookConfig from "../../src/hooks/config.js";
import * as runtimePaths from "../../src/runtime-paths.js";
import { PrivateMutationLockContentionError } from "../../src/private-mutation-lock.js";
import { BackendPublicationJournalError } from "../../src/storage/backend-publication.js";

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

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid test cache capacity %s",
    (capacity) => {
      expect(() => _setEventScrubberCacheMaxForTesting(capacity))
        .toThrow("Event scrubber cache capacity must be a positive safe integer");
    },
  );

  it("loads default configuration when patterns are not injected", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "lcm-event-default-scrub-"));
    dirs.push(cwd);
    const events = await scrubExtractedEvents([{
      type: "decision", category: "decision", data: `token sk-${"a".repeat(24)}`, priority: 1,
    }], cwd);
    expect(events[0].data).toContain("[REDACTED]");
  });

  it("rethrows ordinary persisted-configuration failures", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "lcm-event-config-error-"));
    dirs.push(cwd);
    const load = vi.spyOn(hookConfig, "loadHookConfig").mockImplementation(() => {
      throw new Error("configuration read failed");
    });
    await expect(scrubExtractedEvents([{ type: "decision", category: "decision", data: "safe", priority: 1 }], cwd))
      .rejects.toThrow("configuration read failed");
    expect(load).toHaveBeenCalledOnce();
  });

  it("uses private persisted patterns when publication-aware configuration is unavailable", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "lcm-event-config-fallback-"));
    const configRoot = mkdtempSync(join(tmpdir(), "lcm-event-config-fallback-root-"));
    dirs.push(cwd, configRoot);
    const persistedPath = join(configRoot, "config.json");
    writeFileSync(persistedPath, JSON.stringify({ security: { sensitivePatterns: ["FALLBACK-[0-9]+", 42] } }), { mode: 0o600 });
    chmodSync(persistedPath, 0o600);
    const path = vi.spyOn(runtimePaths, "configPath").mockReturnValue(persistedPath);
    const load = vi.spyOn(hookConfig, "loadHookConfig").mockImplementation(() => {
      throw new BackendPublicationJournalError("unresolved-publication", "publication unresolved");
    });
    const events = await scrubExtractedEvents([{
      type: "decision",
      category: "decision",
      data: "keep FALLBACK-123",
      priority: 1,
      tags: ["FALLBACK-456"],
    }], cwd);
    expect(events[0]).toMatchObject({ data: "keep [REDACTED]", tags: ["[REDACTED]"] });
    expect(path).toHaveBeenCalled();
    expect(load).toHaveBeenCalledWith(persistedPath);
  });

  it("preserves persisted patterns during publication lock contention", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "lcm-event-lock-contention-"));
    const configRoot = mkdtempSync(join(tmpdir(), "lcm-event-lock-contention-root-"));
    dirs.push(cwd, configRoot);
    const persistedPath = join(configRoot, "config.json");
    writeFileSync(persistedPath, JSON.stringify({
      security: { sensitivePatterns: ["CONTENDED-[0-9]+", 42] },
    }), { mode: 0o600 });
    chmodSync(persistedPath, 0o600);
    vi.spyOn(runtimePaths, "configPath").mockReturnValue(persistedPath);
    const load = vi.spyOn(hookConfig, "loadHookConfig").mockImplementation(() => {
      throw new PrivateMutationLockContentionError("publication lock is busy");
    });

    const events = await scrubExtractedEvents([{
      type: "decision",
      category: "decision",
      data: "keep CONTENDED-123",
      priority: 1,
    }], cwd);

    expect(events[0]?.data).toBe("keep [REDACTED]");
    expect(load).toHaveBeenCalledWith(persistedPath);
  });

  it("uses no persisted patterns when the fallback configuration has a non-array pattern value", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "lcm-event-config-non-array-"));
    const configRoot = mkdtempSync(join(tmpdir(), "lcm-event-config-non-array-root-"));
    dirs.push(cwd, configRoot);
    const persistedPath = join(configRoot, "config.json");
    writeFileSync(persistedPath, JSON.stringify({ security: { sensitivePatterns: "not-an-array" } }), { mode: 0o600 });
    chmodSync(persistedPath, 0o600);
    vi.spyOn(runtimePaths, "configPath").mockReturnValue(persistedPath);
    vi.spyOn(hookConfig, "loadHookConfig").mockImplementation(() => {
      throw new BackendPublicationJournalError("unresolved-publication", "publication unresolved");
    });
    const events = await scrubExtractedEvents([{
      type: "decision",
      category: "decision",
      data: "keep FALLBACK-123",
      priority: 1,
    }], cwd);
    expect(events[0].data).toBe("keep FALLBACK-123");
  });

  it("fails closed to no persisted patterns when the fallback configuration cannot be read", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "lcm-event-config-missing-"));
    const configRoot = mkdtempSync(join(tmpdir(), "lcm-event-config-missing-root-"));
    dirs.push(cwd, configRoot);
    const missingPath = join(configRoot, "missing.json");
    vi.spyOn(runtimePaths, "configPath").mockReturnValue(missingPath);
    vi.spyOn(hookConfig, "loadHookConfig").mockImplementation(() => {
      throw new BackendPublicationJournalError("unresolved-publication", "publication unresolved");
    });
    const events = await scrubExtractedEvents([{
      type: "decision",
      category: "decision",
      data: "safe",
      priority: 1,
    }], cwd);
    expect(events[0].data).toBe("safe");
  });
});
