import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const lifecycle = vi.hoisted(() => ({
  ensureDaemon: vi.fn().mockResolvedValue({ connected: true }),
}));

vi.mock("../src/daemon/lifecycle.js", () => lifecycle);

const homes: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("bootstrap default dependencies", () => {
  it("creates core files and reuses the default bootstrap flag", async () => {
    const home = mkdtempSync(join(tmpdir(), "lcm-bootstrap-defaults-"));
    homes.push(home);
    vi.stubEnv("HOME", home);
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), "{}");
    vi.resetModules();
    const { ensureBootstrapped, ensureCore } = await import("../src/bootstrap.js");
    await ensureCore();
    await ensureBootstrapped("unsafe/session:id");
    await ensureBootstrapped("unsafe/session:id");
    expect(lifecycle.ensureDaemon).toHaveBeenCalled();
  });
});
