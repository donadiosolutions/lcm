import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { lcmHomeDir } from "../../src/runtime-paths.js";

describe("hook probes", () => {
  let homeDir: string;
  let originalHome: string | undefined;
  let listeners: Map<string, (...args: unknown[]) => void>;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), "lcm-probe-home-"));
    originalHome = process.env.HOME;
    process.env.HOME = homeDir;
    listeners = new Map();
    vi.spyOn(process.stdin, "on").mockImplementation(((event: string, listener: (...args: unknown[]) => void) => {
      listeners.set(event, listener);
      return process.stdin;
    }) as typeof process.stdin.on);
    vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.resetModules();
    rmSync(homeDir, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  });

  it("writes the complete PreCompact payload", async () => {
    await import("../../src/hooks/probe-precompact.js");
    listeners.get("data")?.(Buffer.from('{"phase":'));
    listeners.get("data")?.(Buffer.from('"manual"}'));
    listeners.get("end")?.();

    const path = join(lcmHomeDir(), "precompact-probe.json");
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf-8")).toBe('{"phase":"manual"}');
    expect(process.exit).toHaveBeenCalledWith(0);
  });

  it("appends the complete SessionStart payload", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-18T00:00:00.000Z"));
    await import("../../src/hooks/probe-sessionstart.js");
    listeners.get("data")?.(Buffer.from('{"source":'));
    listeners.get("data")?.(Buffer.from('"compact"}'));
    listeners.get("end")?.();

    const path = join(lcmHomeDir(), "sessionstart-probe.jsonl");
    expect(readFileSync(path, "utf-8")).toBe(
      '2026-07-18T00:00:00.000Z {"source":"compact"}\n',
    );
    expect(process.exit).toHaveBeenCalledWith(0);
  });
});
