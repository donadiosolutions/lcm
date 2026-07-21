import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadHookConfig } from "../../src/hooks/config.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("loadHookConfig", () => {
  it("uses zero-configuration hook defaults when the file is absent", () => {
    const root = mkdtempSync(join(tmpdir(), "lcm-hook-config-missing-"));
    dirs.push(root);
    expect(loadHookConfig(join(root, "missing.json"))).toEqual({
      daemonPort: 3737,
      storage: { backend: "sqlite" },
      security: { sensitivePatterns: [] },
    });
  });

  it("loads hook settings for staged PostgreSQL without runtime secrets", () => {
    const root = mkdtempSync(join(tmpdir(), "lcm-hook-config-postgresql-"));
    dirs.push(root);
    const path = join(root, "config.json");
    writeFileSync(path, JSON.stringify({
      daemon: { port: 4545 },
      storage: { backend: "postgresql" },
      security: {
        sensitivePatterns: ["PRIVATE-[0-9]+"],
        notify_on_filter: false,
      },
    }));

    expect(loadHookConfig(path)).toEqual({
      daemonPort: 4545,
      storage: { backend: "postgresql" },
      security: {
        sensitivePatterns: ["PRIVATE-[0-9]+"],
        notify_on_filter: false,
      },
    });
  });

  it("preserves non-missing file read failures", () => {
    const root = mkdtempSync(join(tmpdir(), "lcm-hook-config-read-error-"));
    dirs.push(root);
    const directory = join(root, "config.json");
    mkdirSync(directory);
    expect(() => loadHookConfig(directory)).toThrow();
  });
});
