import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadStoredLlmRequestPolicyConfig,
  loadStoredPreToolRecallSettings,
} from "../../src/config-projection.js";
import {
  DEFAULT_LLM_REQUEST_TIMEOUT_MS,
  DEFAULT_LLM_RETRY_POLICY,
} from "../../src/daemon/config.js";
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
    }), { mode: 0o600 });

    expect(loadHookConfig(path)).toEqual({
      daemonPort: 4545,
      storage: { backend: "postgresql" },
      security: {
        sensitivePatterns: ["PRIVATE-[0-9]+"],
        notify_on_filter: false,
      },
    });
    expect(loadStoredLlmRequestPolicyConfig(path, {})).toEqual({
      llm: {
        provider: "auto",
        requestTimeoutMs: DEFAULT_LLM_REQUEST_TIMEOUT_MS,
        retry: DEFAULT_LLM_RETRY_POLICY,
      },
    });
  });

  it("loads effective hook request policy without resolving storage secrets", () => {
    const root = mkdtempSync(join(tmpdir(), "lcm-hook-policy-postgresql-"));
    dirs.push(root);
    const path = join(root, "config.json");
    writeFileSync(path, JSON.stringify({
      storage: { backend: "postgresql" },
      llm: {
        provider: "openai",
        requestTimeoutMs: 120_000,
        retry: { maxAttempts: 4, initialDelayMs: 500 },
      },
    }), { mode: 0o600 });

    expect(loadStoredLlmRequestPolicyConfig(path, { LCM_SUMMARY_PROVIDER: "codex" })).toEqual({
      llm: {
        provider: "codex-process",
        requestTimeoutMs: 120_000,
        retry: {
          maxAttempts: 4,
          initialDelayMs: 500,
          maxDelayMs: 30_000,
          multiplier: 2,
        },
      },
    });
  });

  it("rejects an invalid hook policy provider override", () => {
    const root = mkdtempSync(join(tmpdir(), "lcm-hook-policy-invalid-"));
    dirs.push(root);
    expect(() => loadStoredLlmRequestPolicyConfig(
      join(root, "missing.json"),
      { LCM_SUMMARY_PROVIDER: "invalid" },
    )).toThrow("LCM_SUMMARY_PROVIDER");
  });

  it("preserves non-missing file read failures", () => {
    const root = mkdtempSync(join(tmpdir(), "lcm-hook-config-read-error-"));
    dirs.push(root);
    const directory = join(root, "config.json");
    mkdirSync(directory);
    expect(() => loadHookConfig(directory)).toThrow();
  });

  it("loads the PreToolUse opt-in as disabled with the default port when the file is absent", () => {
    const root = mkdtempSync(join(tmpdir(), "lcm-pretool-config-missing-"));
    dirs.push(root);
    expect(loadStoredPreToolRecallSettings(join(root, "missing.json"))).toEqual({
      enabled: false,
      daemonPort: 3737,
    });
  });

  it.each([
    [{ hooks: { preToolRecall: true } }, true, 3737],
    [{ hooks: { preToolRecall: false }, daemon: { port: 4545 } }, false, 4545],
    [{ hooks: { snapshotIntervalSec: 30 } }, false, 3737],
    [{ daemon: { port: 4646 } }, false, 4646],
  ] as const)("projects hooks.preToolRecall from %j", (config, enabled, daemonPort) => {
    const root = mkdtempSync(join(tmpdir(), "lcm-pretool-config-"));
    dirs.push(root);
    const path = join(root, "config.json");
    writeFileSync(path, JSON.stringify(config), { mode: 0o600 });
    expect(loadStoredPreToolRecallSettings(path)).toEqual({ enabled, daemonPort });
  });

  it("rejects a non-boolean PreToolUse opt-in instead of enabling it", () => {
    const root = mkdtempSync(join(tmpdir(), "lcm-pretool-config-invalid-"));
    dirs.push(root);
    const path = join(root, "config.json");
    writeFileSync(path, JSON.stringify({ hooks: { preToolRecall: "true" } }), { mode: 0o600 });
    expect(() => loadStoredPreToolRecallSettings(path)).toThrow("hooks.preToolRecall");
  });
});
