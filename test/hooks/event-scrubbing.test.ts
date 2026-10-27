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
import {
  hashProjectPath,
  normalizeProjectPath,
  renewRetiredProjectIdentity,
  retiredProjectIdentitySuccessor,
} from "../../src/project-map.js";
import { serializeWorktreeReconciliationFence } from "../../src/worktree-reconciliation-fence.js";
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
  it("scrubs complete data before the durable cap, including a delimiter at the cut", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "lcm-event-scrub-cut-"));
    dirs.push(cwd);
    const token = `dop_v1_${"a".repeat(64)}`;
    const data = `${"x".repeat(1_999 - token.length)} ${token}; tail`;
    const [event] = await scrubExtractedEvents([{
      type: "decision", category: "decision", data, priority: 1,
    }], cwd, []);
    expect(event.data).not.toContain(token);
    expect(event.data).not.toContain("dop_v1_");
    expect(event.data).toContain("[REDACTED]");
    expect(event.data.length).toBeLessThanOrEqual(2_003);
  });

  it("drops complete over-budget data or tags before scrubbing", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "lcm-event-scrub-limit-"));
    dirs.push(cwd);
    const events = await scrubExtractedEvents([
      { type: "decision", category: "decision", data: "x".repeat(8_193), priority: 1 },
      { type: "decision", category: "decision", data: "safe", tags: ["x".repeat(8_193)], priority: 1 },
      { type: "decision", category: "decision", data: "safe", tags: ["ok"], priority: 1 },
    ], cwd, []);
    expect(events).toEqual([{ type: "decision", category: "decision", data: "safe", tags: ["ok"], priority: 1 }]);
  });

  it("accepts a complete field at the exact scrub admission limit", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "lcm-event-scrub-exact-limit-"));
    dirs.push(cwd);
    const token = `dop_v1_${"a".repeat(64)}`;
    const prefix = `token ${token};`;
    const data = `${prefix}${"x".repeat(8_192 - prefix.length)}`;
    const events = await scrubExtractedEvents([{
      type: "decision", category: "decision", data, priority: 1,
    }], cwd, []);
    expect(events).toHaveLength(1);
    expect(events[0].data).toContain("[REDACTED]");
    expect(events[0].data).not.toContain("dop_v1_");
    expect(events[0].data.length).toBeLessThanOrEqual(2_003);
  });

  it("caps scrubbed data and tags without retaining secret fragments", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "lcm-event-scrub-output-"));
    dirs.push(cwd);
    const token = `dop_v1_${"b".repeat(64)}`;
    const events = await scrubExtractedEvents([{
      type: "decision", category: "decision", data: `${"x".repeat(2_100)}${token};`,
      tags: [`${"y".repeat(2_100)}${token};`], priority: 1,
    }], cwd, []);
    expect(events).toHaveLength(1);
    expect(events[0].data).toHaveLength(2_003);
    expect(events[0].tags?.[0]).toHaveLength(2_003);
    expect(JSON.stringify(events)).not.toContain("dop_v1_");
  });

  it("does not split a Unicode surrogate at the output boundary", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "lcm-event-scrub-unicode-"));
    dirs.push(cwd);
    const [event] = await scrubExtractedEvents([{
      type: "decision", category: "decision", data: `${"x".repeat(1_999)}🙂tail`, priority: 1,
    }], cwd, []);
    expect(event.data).toBe(`${"x".repeat(1_999)}...`);
    expect(event.data).not.toContain("\ud83d");
  });

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

  it("classifies a mapped retired project before reading child patterns", async () => {
    const home = mkdtempSync(join(tmpdir(), "lcm-event-scrub-retired-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "lcm-event-scrub-retired-cwd-"));
    dirs.push(home, cwd);
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    const root = join(home, ".lcm");
    const projects = join(root, "projects");
    mkdirSync(projects, { recursive: true, mode: 0o700 });
    chmodSync(root, 0o700);
    chmodSync(projects, 0o700);
    const canonical = normalizeProjectPath(cwd);
    const id = hashProjectPath(canonical);
    writeFileSync(join(root, "map.json"), `${JSON.stringify({
      [id]: { canonical, aliases: [] },
    })}\n`, { mode: 0o600 });
    writeFileSync(
      join(projects, id),
      serializeWorktreeReconciliationFence(id, "project"),
      { mode: 0o600 },
    );
    try {
      await expect(scrubExtractedEvents([{
        type: "decision", category: "decision", data: "safe", priority: 1,
      }], cwd, [])).rejects.toMatchObject({
        name: "RetiredProjectIdentityError",
      });
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });

  it("uses an authenticated renewed successor for read-only hook identity", async () => {
    const home = mkdtempSync(join(tmpdir(), "lcm-event-scrub-successor-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "lcm-event-scrub-successor-cwd-"));
    dirs.push(home, cwd);
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    const root = join(home, ".lcm");
    const projects = join(root, "projects");
    mkdirSync(projects, { recursive: true, mode: 0o700 });
    chmodSync(root, 0o700);
    chmodSync(projects, 0o700);
    const canonical = normalizeProjectPath(cwd);
    const oldId = hashProjectPath(canonical);
    const newId = retiredProjectIdentitySuccessor(oldId, canonical);
    writeFileSync(join(root, "map.json"), `${JSON.stringify({
      [oldId]: { canonical, aliases: [] },
    })}\n`, { mode: 0o600 });
    writeFileSync(
      join(projects, oldId),
      serializeWorktreeReconciliationFence(oldId, "project"),
      { mode: 0o600 },
    );
    renewRetiredProjectIdentity(cwd);
    const forProject = vi.spyOn(ScrubEngine, "forProject");
    try {
      await expect(scrubExtractedEvents([{
        type: "decision", category: "decision", data: "safe", priority: 1,
      }], cwd, [])).resolves.toHaveLength(1);
      expect(forProject).toHaveBeenCalledWith([], join(projects, newId));
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
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
