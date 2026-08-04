import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, type TestContext } from "vitest";
import {
  CANONICAL_LLM_PROVIDERS,
  AUTO_REASONING_EFFORTS,
  CLAUDE_PROCESS_REASONING_EFFORTS,
  CODEX_PROCESS_REASONING_EFFORTS,
  ConfigValidationError,
  DEFAULT_DAEMON_PORT,
  DEFAULT_LLM_REQUEST_TIMEOUT_MS,
  DEFAULT_LLM_RETRY_POLICY,
  LLM_API_MODES,
  LLM_REASONING_EFFORTS,
  OPENAI_REASONING_EFFORTS,
  loadDaemonConfig,
  parseDaemonConfig,
  parseLlmRequestPolicyConfig,
  parseStoredConfig,
  resolveDaemonConfigEnv,
  resolveLlmRequestPolicy,
  deepMerge,
} from "../../src/daemon/config.js";

describe("known configuration schema validation", () => {
  it.each([
    [{ version: 0 }, "version"],
    [{ daemon: "not-an-object" }, "daemon"],
    [{ daemon: { port: "3737" } }, "daemon.port"],
    [{ daemon: { port: -1 } }, "daemon.port"],
    [{ daemon: { port: 65_536 } }, "daemon.port"],
    [{ daemon: { idleTimeoutMs: 86_400_001 } }, "daemon.idleTimeoutMs"],
    [{ hooks: { snapshotIntervalSec: 0.5 } }, "hooks.snapshotIntervalSec"],
    [{ hooks: { disableAutoCompact: "false" } }, "hooks.disableAutoCompact"],
    [{ summarizer: { mock: 1 } }, "summarizer.mock"],
    [{ security: { sensitivePatterns: ["valid", 1] } }, "security.sensitivePatterns.1"],
    [{ compaction: { leafTokens: 0 } }, "compaction.leafTokens"],
    [{ compaction: { promotionThresholds: { compressionRatio: 1.1 } } }, "compaction.promotionThresholds.compressionRatio"],
    [{ compaction: { promotionThresholds: { keywords: { decision: ["valid", false] } } } }, "compaction.promotionThresholds.keywords.decision.1"],
    [{ restoration: { recencyHalfLifeHours: 0 } }, "restoration.recencyHalfLifeHours"],
    [{ restoration: { crossSessionAffinity: 2 } }, "restoration.crossSessionAffinity"],
    [{ restoration: { allowStaleOnStrongMatch: "true" } }, "restoration.allowStaleOnStrongMatch"],
  ] as const)("rejects invalid known configuration %#", (config, expectedPath) => {
    expect(() => parseStoredConfig(JSON.stringify(config))).toThrow(expectedPath);
    expect(() => parseDaemonConfig("{}", config)).toThrow(expectedPath);
  });

  it.each([
    [Number.NaN, "NaN"],
    [Number.POSITIVE_INFINITY, "Infinity"],
    [Number.NEGATIVE_INFINITY, "-Infinity"],
  ])("renders the non-finite number %s accurately in validation errors", (value, displayed) => {
    expect(() => parseDaemonConfig("{}", { daemon: { idleTimeoutMs: value } })).toThrow(
      `received number ${displayed}`,
    );
  });

  it("preserves existing finite, string, and structured validation displays", () => {
    expect(() => parseDaemonConfig("{}", { daemon: { idleTimeoutMs: 86_400_001 } })).toThrow(
      "received 86400001",
    );
    expect(() => parseDaemonConfig("{}", { daemon: { port: "3737" } })).toThrow(
      'received string "3737"',
    );
    expect(() => parseDaemonConfig("{}", { daemon: [] })).toThrow(
      'received array "[REDACTED]"',
    );
  });

  it.each([
    [{ daemon: { prt: 3737 } }, "daemon.prt"],
    [{ compaction: { leafToken: 1000 } }, "compaction.leafToken"],
    [{ compaction: { promotionThresholds: { compressionRato: 0.3 } } }, "compaction.promotionThresholds.compressionRato"],
    [{ compaction: { promotionThresholds: { eventConfidence: { decison: 0.5 } } } }, "compaction.promotionThresholds.eventConfidence.decison"],
    [{ restoration: { recentSummary: 3 } }, "restoration.recentSummary"],
    [{ summarizer: { mok: false } }, "summarizer.mok"],
    [{ security: { sensitivePattern: [] } }, "security.sensitivePattern"],
    [{ hooks: { snapshotIntervalSeconds: 60 } }, "hooks.snapshotIntervalSeconds"],
  ] as const)("rejects unknown keys inside fixed-schema sections %#", (config, expectedPath) => {
    expect(() => parseStoredConfig(JSON.stringify(config))).toThrow(expectedPath);
    expect(() => parseDaemonConfig("{}", config)).toThrow(expectedPath);
  });

  it("rejects stored port 0 while preserving the internal ephemeral runtime override", () => {
    expect(() => parseStoredConfig(JSON.stringify({ daemon: { port: 0 } }))).toThrow("daemon.port");
    expect(() => parseDaemonConfig(JSON.stringify({ daemon: { port: 0 } }))).toThrow("daemon.port");
    expect(parseDaemonConfig("{}", { daemon: { port: 0 } }).daemon.port).toBe(0);
  });

  it("preserves root extensions and dynamic keyword categories while accepting legacy fields", () => {
    const stored = parseStoredConfig(JSON.stringify({
      extension: { enabled: true },
      compaction: {
        promotionThresholds: {
          mergeMaxEntries: 25,
          confidenceDecayRate: 0.25,
          keywords: { customCategory: ["custom phrase"] },
        },
      },
      restoration: {
        promptHintsByteBudget: 4096,
        promptHintsReservedForLearningInstruction: 1024,
        promptHintsMaxEmitted: 4,
        promptHintsDedupMinPrefix: 80,
      },
    }));

    expect(stored).toMatchObject({
      extension: { enabled: true },
      compaction: {
        promotionThresholds: { keywords: { customCategory: ["custom phrase"] } },
      },
    });
    expect(() => parseDaemonConfig(JSON.stringify(stored))).not.toThrow();
  });

  it("migrates legacy promotion limits per source before applying precedence", () => {
    const storedLegacy = JSON.stringify({
      compaction: { promotionThresholds: { mergeMaxEntries: 17 } },
    });
    const storedCurrent = JSON.stringify({
      compaction: { promotionThresholds: { dedupCandidateLimit: 23 } },
    });

    expect(parseDaemonConfig(storedLegacy).compaction.promotionThresholds.dedupCandidateLimit).toBe(17);
    expect(parseDaemonConfig(storedCurrent, {
      compaction: { promotionThresholds: { mergeMaxEntries: 29 } },
    }).compaction.promotionThresholds.dedupCandidateLimit).toBe(29);
    expect(parseDaemonConfig(storedLegacy, {
      compaction: { promotionThresholds: { dedupCandidateLimit: 31 } },
    }).compaction.promotionThresholds.dedupCandidateLimit).toBe(31);
  });

  it("prefers the current promotion-limit key within each source without mutating inputs", () => {
    const stored = parseStoredConfig(JSON.stringify({
      compaction: {
        promotionThresholds: {
          mergeMaxEntries: 17,
          dedupCandidateLimit: 19,
          confidenceDecayRate: 0.25,
        },
      },
    }));
    expect(stored.compaction).toEqual({ promotionThresholds: { dedupCandidateLimit: 19 } });

    const overrides = {
      compaction: {
        promotionThresholds: {
          mergeMaxEntries: 23,
          dedupCandidateLimit: 29,
          confidenceDecayRate: 0.5,
        },
      },
    };
    expect(parseDaemonConfig("{}", overrides).compaction.promotionThresholds.dedupCandidateLimit).toBe(29);
    expect(overrides).toEqual({
      compaction: {
        promotionThresholds: {
          mergeMaxEntries: 23,
          dedupCandidateLimit: 29,
          confidenceDecayRate: 0.5,
        },
      },
    });
  });
});

function trustedCredentialBaseDir(): string | undefined {
  if (typeof process.getuid !== "function") return undefined;
  const baseDir = `/run/user/${process.getuid()}/credentials`;
  try {
    if (!existsSync(baseDir)) return undefined;
    const probeDir = mkdtempSync(join(baseDir, "lcm-config-probe-"));
    rmSync(probeDir, { recursive: true, force: true });
    return baseDir;
  } catch {
    return undefined;
  }
}

function makeTrustedCredentialDir(context: TestContext): string | undefined {
  const baseDir = trustedCredentialBaseDir();
  if (baseDir === undefined) {
    context.skip();
    return undefined;
  }
  return mkdtempSync(join(baseDir, "lcm-config-credentials-"));
}

describe("loadDaemonConfig", () => {
  it("returns defaults when no config file exists", () => {
    const c = loadDaemonConfig("/nonexistent/config.json");
    expect(DEFAULT_DAEMON_PORT).toBe(3737);
    expect(c.daemon.port).toBe(DEFAULT_DAEMON_PORT);
    expect(c.daemon.socketPath).toContain("daemon.sock");
    expect(c.llm.provider).toBe("auto");
    expect(c.llm.model).toBe("");
    expect(c.compaction.leafTokens).toBe(1000);
    expect(c.restoration.recentSummaries).toBe(3);
    expect(c.restoration.recallUsageBoost).toBe(0.75);
    expect(c.restoration.surfacingCooldownWindow).toBe(2);
    expect(c.restoration.maxInjectedMemoryBytes).toBe(2048);
    expect(c.restoration.reservedForLearningInstruction).toBe(1024);
    expect(c.restoration.maxInjectedMemoryItems).toBe(3);
    expect(c.restoration.dedupMinPrefix).toBe(64);
    expect(c.version).toBe(1);
  });

  it("merges partial config over defaults", () => {
    const c = loadDaemonConfig("/nonexistent/config.json", { daemon: { port: 4000 } });
    expect(c.daemon.port).toBe(4000);
    expect(c.daemon.socketPath).toContain("daemon.sock");
  });

  it("interpolates ${ANTHROPIC_API_KEY} from env", () => {
    const c = loadDaemonConfig("/nonexistent", { llm: { apiKey: "${ANTHROPIC_API_KEY}" } }, { ANTHROPIC_API_KEY: "sk-test" });
    expect(c.llm.apiKey).toBe("sk-test");
  });

  it("falls back to env var when apiKey not set and provider is anthropic", () => {
    const c = loadDaemonConfig("/nonexistent", { llm: { provider: "anthropic", model: "claude-sonnet" } }, { ANTHROPIC_API_KEY: "sk-env" });
    expect(c.llm.apiKey).toBe("sk-env");
  });

  it("falls back to systemd credentials when provider API key env vars are not set", (context: TestContext): void => {
    const credentialsDir = makeTrustedCredentialDir(context);
    if (credentialsDir === undefined) return;
    try {
      writeFileSync(join(credentialsDir, "ANTHROPIC_API_KEY"), "sk-credential", { mode: 0o600 });
      const c = loadDaemonConfig(
        "/nonexistent",
        { llm: { provider: "anthropic", model: "claude-sonnet" } },
        {
          CREDENTIALS_DIRECTORY: credentialsDir,
          LCM_SYSTEMD_CRED_IDS: "ANTHROPIC_API_KEY",
        },
      );
      expect(c.llm.apiKey).toBe("sk-credential");
    } finally {
      rmSync(credentialsDir, { recursive: true, force: true });
    }
  });

  it("interpolates API keys from systemd credentials", (context: TestContext): void => {
    const credentialsDir = makeTrustedCredentialDir(context);
    if (credentialsDir === undefined) return;
    try {
      writeFileSync(join(credentialsDir, "OPENAI_API_KEY"), "sk-openai-credential", { mode: 0o600 });
      const c = loadDaemonConfig(
        "/nonexistent",
        { llm: { provider: "openai", model: "test-model", baseURL: "http://localhost:11435/v1", apiKey: "${OPENAI_API_KEY}" } },
        {
          CREDENTIALS_DIRECTORY: credentialsDir,
          LCM_SYSTEMD_CRED_IDS: "OPENAI_API_KEY",
        },
      );
      expect(c.llm.apiKey).toBe("sk-openai-credential");
    } finally {
      rmSync(credentialsDir, { recursive: true, force: true });
    }
  });

  it("does not automatically inject a systemd OpenAI credential into a custom endpoint", (context: TestContext): void => {
    const credentialsDir = makeTrustedCredentialDir(context);
    if (credentialsDir === undefined) return;
    try {
      writeFileSync(join(credentialsDir, "OPENAI_API_KEY"), "sk-openai-credential", { mode: 0o600 });
      const c = loadDaemonConfig(
        "/nonexistent",
        { llm: { provider: "openai", model: "test-model", baseURL: "https://compatible.example/v1" } },
        {
          CREDENTIALS_DIRECTORY: credentialsDir,
          LCM_SYSTEMD_CRED_IDS: "OPENAI_API_KEY",
        },
      );
      expect(c.llm.apiKey).toBe("");
    } finally {
      rmSync(credentialsDir, { recursive: true, force: true });
    }
  });

  it("does not follow systemd credential symlinks outside the trusted directory", (context: TestContext): void => {
    const credentialsDir = makeTrustedCredentialDir(context);
    if (credentialsDir === undefined) return;
    const outsideDir = mkdtempSync(join(tmpdir(), "lcm-config-credential-outside-"));
    try {
      const outsideCredential = join(outsideDir, "OPENAI_API_KEY");
      writeFileSync(outsideCredential, "sk-outside", { mode: 0o600 });
      symlinkSync(outsideCredential, join(credentialsDir, "OPENAI_API_KEY"));
      const c = loadDaemonConfig(
        "/nonexistent",
        { llm: { provider: "openai", model: "test-model", baseURL: "http://localhost:11435/v1", apiKey: "${OPENAI_API_KEY}" } },
        {
          CREDENTIALS_DIRECTORY: credentialsDir,
          LCM_SYSTEMD_CRED_IDS: "OPENAI_API_KEY",
        },
      );
      expect(c.llm.apiKey).toBe("");
    } finally {
      rmSync(credentialsDir, { recursive: true, force: true });
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("merges provider and baseURL from file config", () => {
    const c = loadDaemonConfig("/nonexistent/config.json", {
      llm: { provider: "openai", baseURL: "http://localhost:11435/v1", model: "qwen2.5:14b" }
    });
    expect(c.llm.provider).toBe("openai");
    expect(c.llm.baseUrl).toBe("http://localhost:11435/v1");
    expect(c.llm.model).toBe("qwen2.5:14b");
  });

  it("accepts codex-process as a provider from file config", () => {
    const c = loadDaemonConfig("/nonexistent/config.json", {
      llm: { provider: "codex-process" }
    });
    expect(c.llm.provider).toBe("codex-process");
  });

  it("does NOT inject ANTHROPIC_API_KEY when provider is openai", () => {
    const c = loadDaemonConfig("/nonexistent", { llm: { provider: "openai", model: "test-model", baseURL: "http://localhost:11435/v1" } }, { ANTHROPIC_API_KEY: "sk-leaked" });
    expect(c.llm.apiKey).toBe("");
  });

  it.each(["OPENAI_API_KEY", "LCM_SUMMARY_API_KEY"] as const)(
    "does not automatically inject %s into a custom OpenAI-compatible endpoint",
    (envName) => {
      const c = loadDaemonConfig(
        "/nonexistent",
        { llm: { provider: "openai", model: "test-model", baseURL: "https://compatible.example/v1" } },
        { [envName]: "sk-public-secret" },
      );
      expect(c.llm.apiKey).toBe("");
    },
  );

  it.each([
    "https://api.openai.com/v1",
    "https://API.OPENAI.COM/alternate/path",
    "https://api.openai.com./v1",
  ])("automatically injects the OpenAI env credential for the normalized public endpoint: %s", (baseURL) => {
    const c = loadDaemonConfig(
      "/nonexistent",
      { llm: { provider: "openai", model: "test-model", baseURL } },
      { OPENAI_API_KEY: "sk-openai-env" },
    );
    expect(c.llm.apiKey).toBe("sk-openai-env");
  });

  it("prefers an explicit custom-endpoint API key over public-provider env credentials", () => {
    const c = loadDaemonConfig(
      "/nonexistent",
      {
        llm: {
          provider: "openai",
          model: "test-model",
          baseURL: "https://compatible.example/v1",
          apiKey: "custom-endpoint-key",
        },
      },
      { LCM_SUMMARY_API_KEY: "sk-summary-env", OPENAI_API_KEY: "sk-openai-env" },
    );
    expect(c.llm.apiKey).toBe("custom-endpoint-key");
  });

  it("still injects ANTHROPIC_API_KEY when provider is anthropic", () => {
    const c = loadDaemonConfig("/nonexistent", { llm: { provider: "anthropic", model: "claude-sonnet" } }, { ANTHROPIC_API_KEY: "sk-env" });
    expect(c.llm.apiKey).toBe("sk-env");
  });

  it("throws when provider resolves to 'anthropic' and apiKey is missing", () => {
    expect(() =>
      loadDaemonConfig("/nonexistent", { llm: { provider: "anthropic", model: "claude-sonnet", apiKey: "" } }, {})
    ).toThrow("llm.apiKey");
  });

  it("does not throw for 'anthropic' when apiKey is provided", () => {
    expect(() =>
      loadDaemonConfig("/nonexistent", { llm: { provider: "anthropic", model: "claude-sonnet", apiKey: "sk-test" } }, {})
    ).not.toThrow();
  });

  it("does not throw for 'anthropic' when ANTHROPIC_API_KEY env var is set", () => {
    expect(() =>
      loadDaemonConfig("/nonexistent", { llm: { provider: "anthropic", model: "claude-sonnet" } }, { ANTHROPIC_API_KEY: "sk-env" })
    ).not.toThrow();
  });

  it("LCM_SUMMARY_PROVIDER env var overrides config provider", () => {
    const c = loadDaemonConfig(
      "/nonexistent",
      { llm: { provider: "claude-process", model: "gpt-test", baseURL: "http://localhost:11435/v1" } },
      { LCM_SUMMARY_PROVIDER: "openai", LCM_SUMMARY_MODEL: "gpt-test" }
    );
    expect(c.llm.provider).toBe("openai");
  });

  it.each(["auto", "claude-process", "codex-process", "disabled"] as const)(
    "clears a persisted provider-specific model when LCM_SUMMARY_PROVIDER switches to %s",
    (provider) => {
      const c = parseDaemonConfig(
        JSON.stringify({
          llm: {
            provider: "openai",
            model: "remote-openai-model",
            baseUrl: "http://localhost:11435/v1",
          },
        }),
        {},
        { LCM_SUMMARY_PROVIDER: provider },
      );

      expect(c.llm.provider).toBe(provider);
      expect(c.llm.model).toBe("");
    },
  );

  it("preserves an explicit environment model when the provider changes", () => {
    const c = parseDaemonConfig(
      JSON.stringify({
        llm: {
          provider: "openai",
          model: "remote-openai-model",
          baseUrl: "http://localhost:11435/v1",
        },
      }),
      {},
      { LCM_SUMMARY_PROVIDER: "claude-process", LCM_SUMMARY_MODEL: "claude-sonnet-4-20250514" },
    );

    expect(c.llm.model).toBe("claude-sonnet-4-20250514");
  });

  it("preserves a configured model when the environment selects the same provider alias", () => {
    const c = parseDaemonConfig(
      JSON.stringify({ llm: { provider: "claude-process", model: "claude-sonnet-4-20250514" } }),
      {},
      { LCM_SUMMARY_PROVIDER: "claude" },
    );

    expect(c.llm.provider).toBe("claude-process");
    expect(c.llm.model).toBe("claude-sonnet-4-20250514");
  });

  it("clears a file model based on its file provider when a runtime provider matches the environment", () => {
    const c = parseDaemonConfig(
      JSON.stringify({
        llm: {
          provider: "openai",
          model: "remote-openai-model",
          baseUrl: "http://localhost:11435/v1",
        },
      }),
      { llm: { provider: "claude-process" } },
      { LCM_SUMMARY_PROVIDER: "claude" },
    );

    expect(c.llm.provider).toBe("claude-process");
    expect(c.llm.model).toBe("");
  });

  it.each(["claude-process", "claude"])(
    "clears a file model when the runtime-only provider switches to %s",
    (provider) => {
      const c = parseDaemonConfig(
        JSON.stringify({
          llm: {
            provider: "openai",
            model: "remote-openai-model",
            baseUrl: "http://localhost:11435/v1",
          },
        }),
        { llm: { provider } },
      );

      expect(c.llm.provider).toBe("claude-process");
      expect(c.llm.model).toBe("");
    },
  );

  it("does not let a runtime-only remote provider inherit another provider's file model", () => {
    expect(() => parseDaemonConfig(
      JSON.stringify({
        llm: {
          provider: "openai",
          model: "remote-openai-model",
          baseUrl: "http://localhost:11435/v1",
        },
      }),
      { llm: { provider: "anthropic", apiKey: "sk-anthropic" } },
    )).toThrow("llm.model");
  });

  it("preserves an explicit runtime model during a runtime-only provider switch", () => {
    const c = parseDaemonConfig(
      JSON.stringify({
        llm: {
          provider: "openai",
          model: "remote-openai-model",
          baseUrl: "http://localhost:11435/v1",
        },
      }),
      { llm: { provider: "claude-process", model: "claude-sonnet-4-20250514" } },
    );

    expect(c.llm.model).toBe("claude-sonnet-4-20250514");
  });

  it("preserves a provider-less file model during a runtime-only provider switch", () => {
    const c = parseDaemonConfig(
      JSON.stringify({ llm: { model: "claude-sonnet-4-20250514" } }),
      { llm: { provider: "claude-process" } },
    );

    expect(c.llm.model).toBe("claude-sonnet-4-20250514");
  });

  it("preserves an explicit runtime model for the environment-selected provider", () => {
    const c = parseDaemonConfig(
      JSON.stringify({
        llm: {
          provider: "openai",
          model: "remote-openai-model",
          baseUrl: "http://localhost:11435/v1",
        },
      }),
      { llm: { model: "claude-sonnet-4-20250514" } },
      { LCM_SUMMARY_PROVIDER: "claude" },
    );

    expect(c.llm.provider).toBe("claude-process");
    expect(c.llm.model).toBe("claude-sonnet-4-20250514");
  });

  it("normalizes the file provider before comparing it with the environment provider", () => {
    const c = parseDaemonConfig(
      JSON.stringify({
        llm: {
          provider: "custom",
          model: "remote-openai-model",
          baseUrl: "http://localhost:11435/v1",
        },
      }),
      {},
      { LCM_SUMMARY_PROVIDER: "openai-compatible" },
    );

    expect(c.llm.provider).toBe("openai");
    expect(c.llm.model).toBe("remote-openai-model");
  });

  it("preserves a file model that has no explicit file provider", () => {
    const c = parseDaemonConfig(
      JSON.stringify({ llm: { model: "claude-sonnet-4-20250514" } }),
      {},
      { LCM_SUMMARY_PROVIDER: "claude-process" },
    );

    expect(c.llm.provider).toBe("claude-process");
    expect(c.llm.model).toBe("claude-sonnet-4-20250514");
  });

  it("LCM_SUMMARY_PROVIDER recovers from a stale file provider", () => {
    const c = parseDaemonConfig(
      JSON.stringify({ llm: { provider: "ollama" } }),
      {},
      { LCM_SUMMARY_PROVIDER: "disabled" },
    );
    expect(c.llm.provider).toBe("disabled");
  });

  it("LCM_SUMMARY_PROVIDER recovers from a stale runtime provider", () => {
    const c = parseDaemonConfig(
      "{}",
      { llm: { provider: "ollama" } },
      { LCM_SUMMARY_PROVIDER: "claude" },
    );
    expect(c.llm.provider).toBe("claude-process");
  });

  it("accepts LCM_SUMMARY_PROVIDER=auto", () => {
    const c = loadDaemonConfig("/nonexistent", {}, { LCM_SUMMARY_PROVIDER: "auto" });
    expect(c.llm.provider).toBe("auto");
  });

  it("accepts LCM_SUMMARY_PROVIDER=codex-process", () => {
    const c = loadDaemonConfig("/nonexistent", {}, { LCM_SUMMARY_PROVIDER: "codex-process" });
    expect(c.llm.provider).toBe("codex-process");
  });

  it("LCM_SUMMARY_PROVIDER=anthropic overrides provider with apiKey", () => {
    const c = loadDaemonConfig(
      "/nonexistent",
      { llm: { model: "claude-sonnet", apiKey: "sk-test" } },
      { LCM_SUMMARY_PROVIDER: "anthropic" }
    );
    expect(c.llm.provider).toBe("anthropic");
  });

  it("preserves compatible reasoning while clearing OpenAI-only settings on an env provider transition", () => {
    const c = parseDaemonConfig(
      JSON.stringify({
        llm: {
          provider: "openai",
          model: "gpt-test",
          baseURL: "http://localhost:11435/v1",
          apiMode: "responses",
          reasoningEffort: "high",
        },
      }),
      {},
      { LCM_SUMMARY_PROVIDER: "auto" },
    );

    expect(c.llm.provider).toBe("auto");
    expect(c.llm.apiMode).toBeUndefined();
    expect(c.llm.reasoningEffort).toBe("high");
  });

  it("clears OpenAI-only runtime overrides when LCM_SUMMARY_PROVIDER selects another provider", () => {
    const c = parseDaemonConfig(
      "{}",
      { llm: { apiMode: "responses", reasoningEffort: "medium" } },
      { LCM_SUMMARY_PROVIDER: "disabled" },
    );

    expect(c.llm.provider).toBe("disabled");
    expect(c.llm.apiMode).toBeUndefined();
    expect(c.llm.reasoningEffort).toBeUndefined();
  });

  it("still rejects invalid OpenAI settings when the effective provider is OpenAI", () => {
    expect(() => parseDaemonConfig(
      JSON.stringify({
        llm: {
          model: "gpt-test",
          baseURL: "http://localhost:11435/v1",
          reasoningEffort: "high",
        },
      }),
      {},
      { LCM_SUMMARY_PROVIDER: "openai" },
    )).toThrow('llm.provider "openai" with llm.apiMode "chat-completions"');
  });

  it("throws when LCM_SUMMARY_PROVIDER is set to an invalid value", () => {
    expect(() =>
      loadDaemonConfig("/nonexistent", {}, { LCM_SUMMARY_PROVIDER: "ollama" })
    ).toThrow("Invalid configuration at LCM_SUMMARY_PROVIDER");
  });

  it("includes autoCompactMinTokens default of 10000", () => {
    const c = loadDaemonConfig("/nonexistent/config.json");
    expect(c.compaction.autoCompactMinTokens).toBe(10000);
  });

  it("allows overriding autoCompactMinTokens", () => {
    const c = loadDaemonConfig("/nonexistent/config.json", {
      compaction: { autoCompactMinTokens: 5000 },
    });
    expect(c.compaction.autoCompactMinTokens).toBe(5000);
  });

  it("allows disabling auto-compact with autoCompactMinTokens: 0", () => {
    const c = loadDaemonConfig("/nonexistent/config.json", {
      compaction: { autoCompactMinTokens: 0 },
    });
    expect(c.compaction.autoCompactMinTokens).toBe(0);
  });

  it("defaults security.sensitivePatterns to empty array", () => {
    const config = loadDaemonConfig("/nonexistent/config.json");
    expect(config.security).toEqual({ sensitivePatterns: [] });
  });

  it("merges user-defined sensitivePatterns from config file", () => {
    const c = loadDaemonConfig("/nonexistent/config.json", {
      security: { sensitivePatterns: ["MY_TOKEN_.*"] },
    });
    expect(c.security.sensitivePatterns).toEqual(["MY_TOKEN_.*"]);
  });

  it("loads hooks config with defaults", () => {
    const config = loadDaemonConfig("/nonexistent");
    expect(config.hooks).toEqual({
      snapshotIntervalSec: 60,
      disableAutoCompact: false,
    });
  });

  it("merges user-provided hooks config", () => {
    const config = loadDaemonConfig("/nonexistent", {
      hooks: { snapshotIntervalSec: 30 },
    });
    expect(config.hooks.snapshotIntervalSec).toBe(30);
    expect(config.hooks.disableAutoCompact).toBe(false);
  });

  it("allows overriding prompt hint budget settings", () => {
    const config = loadDaemonConfig("/nonexistent", {
      restoration: {
        promptHintsByteBudget: 3072,
        promptHintsReservedForLearningInstruction: 1400,
        promptHintsMaxEmitted: 5,
        promptHintsDedupMinPrefix: 80,
      },
    });
    expect(config.restoration.maxInjectedMemoryBytes).toBe(3072);
    expect(config.restoration.reservedForLearningInstruction).toBe(1400);
    expect(config.restoration.maxInjectedMemoryItems).toBe(5);
    expect(config.restoration.dedupMinPrefix).toBe(80);
  });

  it("prefers new config name over old name when both are present", () => {
    const config = loadDaemonConfig("/nonexistent", {
      restoration: {
        maxInjectedMemoryBytes: 4096,
        promptHintsByteBudget: 2048,
      },
    });
    expect(config.restoration.maxInjectedMemoryBytes).toBe(4096);
  });
});

describe("launchd one-launch credential projection", () => {
  it("reads only private allow-listed files through a bounded descriptor", () => {
    const root = mkdtempSync(join(tmpdir(), "lcm-launchd-credentials-"));
    const directory = join(root, "credentials");
    mkdirSync(directory, { mode: 0o700 });
    chmodSync(directory, 0o700);
    const file = join(directory, "OPENAI_API_KEY");
    writeFileSync(file, "launchd-secret\n", { mode: 0o600 });
    chmodSync(file, 0o600);
    const env = {
      LCM_CREDENTIAL_DIRECTORY: directory,
      LCM_CREDENTIAL_OPENAI_API_KEY_FILE: file,
      LCM_CREDENTIAL_UNKNOWN_FILE: file,
      OPENAI_API_KEY: "direct-value",
    };
    expect(resolveDaemonConfigEnv(env)).toMatchObject({
      OPENAI_API_KEY: "direct-value",
      LCM_CREDENTIAL_DIRECTORY: directory,
    });
    const envWithoutDirect = { ...env };
    delete envWithoutDirect.OPENAI_API_KEY;
    expect(resolveDaemonConfigEnv(envWithoutDirect).OPENAI_API_KEY).toBe("launchd-secret");
    rmSync(root, { recursive: true, force: true });
  });

  it("fails closed for missing, outside, symlinked, wrong-mode, and oversized leaves", () => {
    const root = mkdtempSync(join(tmpdir(), "lcm-launchd-credentials-"));
    const directory = join(root, "credentials");
    mkdirSync(directory, { mode: 0o700 });
    chmodSync(directory, 0o700);
    const file = join(directory, "OPENAI_API_KEY");
    const outside = join(root, "outside");
    writeFileSync(outside, "outside", { mode: 0o600 });
    symlinkSync(outside, file);
    expect(resolveDaemonConfigEnv({ LCM_CREDENTIAL_DIRECTORY: directory, LCM_CREDENTIAL_OPENAI_API_KEY_FILE: file }).OPENAI_API_KEY).toBeUndefined();
    rmSync(file);
    writeFileSync(file, "wrong-mode", { mode: 0o644 });
    chmodSync(file, 0o644);
    expect(resolveDaemonConfigEnv({ LCM_CREDENTIAL_DIRECTORY: directory, LCM_CREDENTIAL_OPENAI_API_KEY_FILE: file }).OPENAI_API_KEY).toBeUndefined();
    chmodSync(file, 0o600);
    writeFileSync(file, "x".repeat(1024 * 1024 + 1), { mode: 0o600 });
    chmodSync(file, 0o600);
    expect(resolveDaemonConfigEnv({ LCM_CREDENTIAL_DIRECTORY: directory, LCM_CREDENTIAL_OPENAI_API_KEY_FILE: file }).OPENAI_API_KEY).toBeUndefined();
    expect(resolveDaemonConfigEnv({ LCM_CREDENTIAL_DIRECTORY: directory, LCM_CREDENTIAL_OPENAI_API_KEY_FILE: outside }).OPENAI_API_KEY).toBeUndefined();
    expect(resolveDaemonConfigEnv({ LCM_CREDENTIAL_DIRECTORY: join(root, "missing"), LCM_CREDENTIAL_OPENAI_API_KEY_FILE: file }).OPENAI_API_KEY).toBeUndefined();
    rmSync(root, { recursive: true, force: true });
  });
});

describe("strict LLM configuration validation", () => {
  it("exports the canonical provider, API mode, and reasoning effort contracts", () => {
    expect(CANONICAL_LLM_PROVIDERS).toEqual(["auto", "claude-process", "codex-process", "anthropic", "openai", "disabled"]);
    expect(LLM_API_MODES).toEqual(["chat-completions", "responses"]);
    expect(LLM_REASONING_EFFORTS).toEqual(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
    expect(OPENAI_REASONING_EFFORTS).toEqual(["none", "minimal", "low", "medium", "high", "xhigh"]);
    expect(CLAUDE_PROCESS_REASONING_EFFORTS).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(CODEX_PROCESS_REASONING_EFFORTS).toEqual(["minimal", "low", "medium", "high", "xhigh"]);
    expect(AUTO_REASONING_EFFORTS).toEqual(["low", "medium", "high", "xhigh"]);
  });

  it.each([
    ["claude", "claude-process"],
    ["claude-cli", "claude-process"],
    ["codex", "codex-process"],
  ])("normalizes file provider alias %s", (alias, expected) => {
    expect(parseDaemonConfig(JSON.stringify({ llm: { provider: alias } })).llm.provider).toBe(expected);
  });

  it.each([
    ["claude", "claude-process"],
    ["claude-cli", "claude-process"],
    ["codex", "codex-process"],
  ])("normalizes LCM_SUMMARY_PROVIDER alias %s", (alias, expected) => {
    expect(parseDaemonConfig("{}", {}, { LCM_SUMMARY_PROVIDER: alias }).llm.provider).toBe(expected);
  });

  it("rejects malformed JSON instead of silently using defaults", () => {
    const dir = mkdtempSync(join(tmpdir(), "lcm-invalid-config-"));
    const path = join(dir, "config.json");
    try {
      writeFileSync(path, '{"llm":');
      expect(() => loadDaemonConfig(path)).toThrowError(ConfigValidationError);
      expect(() => loadDaemonConfig(path)).toThrow("malformed JSON");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    ["null", "$"],
    [JSON.stringify({ llm: [] }), "llm"],
    [JSON.stringify({ llm: { model: 42 } }), "llm.model"],
    [JSON.stringify({ llm: { provider: "ollama" } }), "llm.provider"],
    [JSON.stringify({ llm: { apiMode: "legacy" } }), "llm.apiMode"],
    [JSON.stringify({ llm: { reasoningEffort: "extreme" } }), "llm.reasoningEffort"],
    [JSON.stringify({ llm: { timeout: 1000 } }), "llm.timeout"],
  ])("rejects invalid configuration %s at %s", (content, path) => {
    expect(() => parseDaemonConfig(content)).toThrow(`Invalid configuration at ${path}`);
  });

  it("redacts an invalid apiKey value from errors", () => {
    const secret = "sk-super-secret";
    let message = "";
    try {
      parseDaemonConfig(JSON.stringify({ llm: { apiKey: { secret } } }));
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("llm.apiKey");
    expect(message).toContain("[REDACTED]");
    expect(message).not.toContain(secret);
  });

  it("does not expose structured authorization credentials in startup errors", () => {
    const dir = mkdtempSync(join(tmpdir(), "lcm-invalid-llm-credentials-"));
    const path = join(dir, "config.json");
    const secrets = [
      "Bearer startup-authorization-secret",
      "Basic startup-proxy-secret",
      "startup-cookie-secret",
      "startup-custom-auth-secret",
    ];
    try {
      writeFileSync(path, JSON.stringify({
        llm: {
          baseURL: {
            headers: {
              Authorization: secrets[0],
              "Proxy-Authorization": secrets[1],
              Cookie: secrets[2],
              "X-Custom-Auth": secrets[3],
            },
          },
        },
      }));

      let message = "";
      try {
        loadDaemonConfig(path);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toContain("llm.baseURL");
      expect(message).toContain("[REDACTED]");
      for (const secret of secrets) expect(message).not.toContain(secret);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports unknown-key types without reflecting their values", () => {
    expect(() => parseDaemonConfig(JSON.stringify({ llm: { timeout: 1000 } })))
      .toThrow('unknown key "timeout" with number value; valid keys:');

    const secret = "sk-unknown-key-secret";
    let message = "";
    try {
      parseDaemonConfig(JSON.stringify({
        llm: {
          options: { apiKey: secret, label: "visible" },
        },
      }));
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('unknown key "options" with object value');
    expect(message).not.toContain("visible");
    expect(message).not.toContain(secret);
  });

  it("redacts credential-like unknown keys", () => {
    const secret = "private-token-value";
    expect(() => parseDaemonConfig(JSON.stringify({ llm: { accessToken: secret } })))
      .toThrow('unknown key "accessToken" with string value; valid keys:');
    try {
      parseDaemonConfig(JSON.stringify({ llm: { accessToken: secret } }));
    } catch (error) {
      expect(error instanceof Error ? error.message : String(error)).not.toContain(secret);
    }
  });

  it.each([
    ["direct Authorization value", { Authorization: "Bearer direct-secret" }, ["Bearer direct-secret"]],
    [
      "nested header values",
      { headers: { Authorization: "Bearer nested-secret", "X-Api-Key": "header-secret" } },
      ["Bearer nested-secret", "header-secret"],
    ],
  ])("does not reflect %s from unknown llm keys", (_name, llm, secrets) => {
    let message = "";
    try {
      parseDaemonConfig(JSON.stringify({ llm }));
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain("unknown key");
    for (const secret of secrets) expect(message).not.toContain(secret);
  });

  it("requires an Anthropic model and a resolved API key", () => {
    expect(() => parseDaemonConfig(JSON.stringify({ llm: { provider: "anthropic", apiKey: "sk-test" } }))).toThrow("llm.model");
    expect(() => parseDaemonConfig(JSON.stringify({ llm: { provider: "anthropic", model: "claude-sonnet" } }))).toThrow("llm.apiKey");
    expect(parseDaemonConfig(
      JSON.stringify({ llm: { provider: "anthropic", model: "claude-sonnet" } }),
      {},
      { LCM_SUMMARY_API_KEY: "sk-env" },
    ).llm.apiKey).toBe("sk-env");
  });

  it("validates OpenAI model, URL, and public endpoint credentials", () => {
    expect(() => parseDaemonConfig(JSON.stringify({ llm: { provider: "openai", baseURL: "http://localhost/v1" } }))).toThrow("llm.model");
    expect(() => parseDaemonConfig(JSON.stringify({ llm: { provider: "openai", model: "gpt-test", baseURL: "localhost/v1" } }))).toThrow("absolute HTTP(S) URL");
    expect(() => parseDaemonConfig(JSON.stringify({ llm: { provider: "openai", model: "gpt-test", baseURL: "ftp://localhost/v1" } }))).toThrow("absolute HTTP(S) URL");
    expect(() => parseDaemonConfig(JSON.stringify({ llm: { provider: "openai", model: "gpt-test", baseURL: "https://api.openai.com/v1" } }))).toThrow("llm.apiKey");
  });

  it.each([
    "https://api.openai.com",
    "https://API.OPENAI.COM/alternate/path",
    "https://api.openai.com./alternate/path",
    "https://api.openai.com/not-v1?feature=preview",
  ])("requires credentials for the public OpenAI hostname regardless of path: %s", (baseURL) => {
    expect(() => parseDaemonConfig(JSON.stringify({
      llm: { provider: "openai", model: "gpt-test", baseURL },
    }))).toThrow("llm.apiKey");
  });

  it("redacts URL credentials and query data from baseURL errors", () => {
    const username = "private-user";
    const password = "private-password";
    const querySecret = "private-query-secret";
    let message = "";
    try {
      parseDaemonConfig(JSON.stringify({
        llm: {
          provider: "openai",
          model: "gpt-test",
          baseURL: `ftp://${username}:${password}@localhost/v1?token=${querySecret}#fragment-secret`,
        },
      }));
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("llm.baseUrl");
    expect(message).toContain("[REDACTED]");
    expect(message).not.toContain(username);
    expect(message).not.toContain(password);
    expect(message).not.toContain(querySecret);
    expect(message).not.toContain("fragment-secret");
  });

  it("defaults OpenAI-compatible endpoints to Chat Completions without requiring local credentials", () => {
    const config = parseDaemonConfig(JSON.stringify({
      llm: { provider: "openai", model: "local-model", baseURL: "http://localhost:11435/v1" },
    }));
    expect(config.llm.apiMode).toBe("chat-completions");
    expect(config.llm.apiKey).toBe("");
  });

  it("accepts provider-native reasoning efforts and rejects incompatible values", () => {
    const content = JSON.stringify({
      llm: {
        provider: "openai",
        model: "gpt-test",
        baseURL: "http://localhost:11435/v1",
        apiMode: "responses",
        reasoningEffort: "high",
      },
    });
    expect(parseDaemonConfig(content).llm.reasoningEffort).toBe("high");
    expect(parseDaemonConfig(JSON.stringify({ llm: { provider: "codex", reasoningEffort: "minimal" } })).llm.reasoningEffort).toBe("minimal");
    expect(() => parseDaemonConfig(JSON.stringify({ llm: { provider: "codex", reasoningEffort: "max" } }))).toThrow(
      "valid choices for llm.provider \"codex-process\": minimal, low, medium, high, xhigh",
    );
    expect(parseDaemonConfig(JSON.stringify({ llm: { provider: "claude", reasoningEffort: "max" } })).llm.reasoningEffort).toBe("max");
    expect(parseDaemonConfig(JSON.stringify({ llm: { provider: "auto", reasoningEffort: "xhigh" } })).llm.reasoningEffort).toBe("xhigh");
    expect(() => parseDaemonConfig(JSON.stringify({ llm: { provider: "auto", reasoningEffort: "max" } }))).toThrow(
      "valid choices for llm.provider \"auto\": low, medium, high, xhigh",
    );
    expect(() => parseDaemonConfig(JSON.stringify({
      llm: {
        provider: "openai",
        model: "gpt-test",
        baseURL: "http://localhost:11435/v1",
        reasoningEffort: "high",
      },
    }))).toThrow('llm.provider "openai" with llm.apiMode "chat-completions"');
    expect(parseDaemonConfig(JSON.stringify({
      llm: {
        provider: "openai",
        model: "gpt-test",
        baseURL: "http://localhost:11435/v1",
        apiMode: "chat-completions",
      },
    })).llm.apiMode).toBe("chat-completions");
    expect(() => parseDaemonConfig(JSON.stringify({ llm: { provider: "disabled", apiMode: "chat-completions" } }))).toThrow(
      'Invalid configuration at llm.apiMode: is only valid when llm.provider is "openai"',
    );
  });

  it("defaults fast mode to false and accepts it only for auto and process providers", () => {
    expect(parseDaemonConfig("{}").llm.fastMode).toBe(false);
    for (const provider of ["auto", "claude-process", "codex-process"] as const) {
      expect(parseDaemonConfig(JSON.stringify({ llm: { provider, fastMode: true } })).llm.fastMode).toBe(true);
    }
    for (const provider of ["anthropic", "openai", "disabled"] as const) {
      const llm = provider === "anthropic"
        ? { provider, model: "claude-test", apiKey: "test", fastMode: true }
        : provider === "openai"
          ? { provider, model: "gpt-test", baseUrl: "http://localhost/v1", fastMode: true }
          : { provider, fastMode: true };
      expect(() => parseDaemonConfig(JSON.stringify({ llm }))).toThrow("llm.fastMode");
    }
  });

  it.each(["custom", "openai-compatible"])("normalizes the OpenAI-compatible alias %s", (provider) => {
    const config = parseDaemonConfig(JSON.stringify({
      llm: { provider, model: "local-model", baseUrl: "http://localhost:11435/v1" },
    }));
    expect(config.llm.provider).toBe("openai");
  });

  it("normalizes legacy baseURL in stored config and rejects conflicting dual values", () => {
    expect(parseStoredConfig(JSON.stringify({ llm: { baseURL: "http://localhost/v1" } }))).toEqual({
      llm: { baseUrl: "http://localhost/v1" },
    });
    expect(parseStoredConfig(JSON.stringify({
      llm: { baseUrl: "http://localhost/v1", baseURL: "http://localhost/v1" },
    }))).toEqual({ llm: { baseUrl: "http://localhost/v1" } });
    expect(() => parseStoredConfig(JSON.stringify({
      llm: { baseUrl: "http://one/v1", baseURL: "http://two/v1" },
    }))).toThrow("conflicts with legacy llm.baseURL");
  });

  it("applies LCM_SUMMARY_MODEL after file and runtime merging, including an empty override", () => {
    const base = JSON.stringify({
      llm: { provider: "openai", model: "file-model", baseUrl: "http://localhost/v1" },
    });
    expect(parseDaemonConfig(base, { llm: { model: "runtime-model" } }, {
      LCM_SUMMARY_MODEL: "env-model",
    }).llm.model).toBe("env-model");
    expect(() => parseDaemonConfig(base, {}, { LCM_SUMMARY_MODEL: "" })).toThrow("llm.model");
  });

  it("uses validated OpenAI request policy defaults and accepts partial overrides", () => {
    const config = parseDaemonConfig(JSON.stringify({
      llm: {
        provider: "openai",
        model: "local-model",
        baseUrl: "http://localhost/v1",
        requestTimeoutMs: 30_000,
        retry: { maxAttempts: 5, initialDelayMs: 250, maxDelayMs: 2_000, multiplier: 1.5 },
      },
    }));
    expect(config.llm.requestTimeoutMs).toBe(30_000);
    expect(config.llm.retry).toEqual({ maxAttempts: 5, initialDelayMs: 250, maxDelayMs: 2_000, multiplier: 1.5 });

    const defaults = parseDaemonConfig("{}");
    expect(defaults.llm.requestTimeoutMs).toBe(DEFAULT_LLM_REQUEST_TIMEOUT_MS);
    expect(defaults.llm.retry).toEqual(DEFAULT_LLM_RETRY_POLICY);
  });

  it.each([
    [{ requestTimeoutMs: 0 }, "requestTimeoutMs"],
    [{ requestTimeoutMs: 1.5 }, "requestTimeoutMs"],
    [{ retry: { maxAttempts: 0 } }, "maxAttempts"],
    [{ retry: { maxAttempts: 11 } }, "maxAttempts"],
    [{ retry: { initialDelayMs: -1 } }, "initialDelayMs"],
    [{ retry: { maxDelayMs: Number.POSITIVE_INFINITY } }, "maxDelayMs"],
    [{ retry: { multiplier: 0.5 } }, "multiplier"],
    [{ retry: { initialDelayMs: 31_000 } }, "must be less than or equal"],
    [{ retry: { unexpected: 1 } }, "unexpected"],
  ])("rejects invalid request policy %j", (policy, expected) => {
    expect(() => parseDaemonConfig(JSON.stringify({
      llm: {
        provider: "openai", model: "local-model", baseUrl: "http://localhost/v1", ...policy,
      },
    }))).toThrow(expected as string);
  });

  it("accepts process timeouts while rejecting unsupported request policies", () => {
    expect(parseDaemonConfig(JSON.stringify({
      llm: { provider: "claude-process", requestTimeoutMs: 10_000 },
    })).llm.requestTimeoutMs).toBe(10_000);
    expect(() => parseDaemonConfig(JSON.stringify({
      llm: { provider: "codex-process", retry: { maxAttempts: 2 } },
    }))).toThrow('only valid when llm.provider is "openai"');
    expect(() => parseDaemonConfig(JSON.stringify({
      llm: { provider: "anthropic", model: "m", apiKey: "key", requestTimeoutMs: 10_000 },
    }))).toThrow('only valid when llm.provider is "auto", "openai", "claude-process", or "codex-process"');
  });

  it.each([
    [{ provider: "auto", requestTimeoutMs: 10_000 }, {}],
    [{ provider: "claude-process", requestTimeoutMs: 20_000 }, {}],
    [{ provider: "codex-process", requestTimeoutMs: 30_000 }, {}],
    [{
      provider: "openai",
      model: "local-model",
      baseUrl: "http://localhost/v1",
      requestTimeoutMs: 40_000,
      retry: { maxAttempts: 4, initialDelayMs: 0 },
    }, {}],
    [{
      provider: "openai",
      model: "local-model",
      baseUrl: "http://localhost/v1",
      retry: { maxAttempts: 5 },
    }, { LCM_SUMMARY_PROVIDER: "codex" }],
    [{
      provider: "codex-process",
      model: "local-model",
      baseUrl: "http://localhost/v1",
      retry: { maxAttempts: 6 },
    }, { LCM_SUMMARY_PROVIDER: "openai-compatible", LCM_SUMMARY_MODEL: "env-model" }],
    [{
      provider: "anthropic",
      model: "model",
      apiKey: "key",
      requestTimeoutMs: 50_000,
    }, { LCM_SUMMARY_PROVIDER: "disabled" }],
  ] as const)("keeps secret-free request-policy projection parity for valid combination %#", (llm, env) => {
    const content = JSON.stringify({ storage: { backend: "postgresql" }, llm });
    const daemon = parseDaemonConfig(content, {}, {
      ...env,
      LCM_POSTGRES_URL: "postgresql://user:password@localhost/database",
      LCM_POSTGRES_CA_FILE: import.meta.filename,
    });

    expect(parseLlmRequestPolicyConfig(content, env).llm).toEqual({
      provider: daemon.llm.provider,
      requestTimeoutMs: daemon.llm.requestTimeoutMs,
      retry: daemon.llm.retry,
    });
  });

  it.each([
    [{ provider: "auto", retry: { maxAttempts: 2 } }, {}, "llm.retry"],
    [{ provider: "claude-process", retry: { maxAttempts: 2 } }, {}, "llm.retry"],
    [{ provider: "codex-process", retry: { maxAttempts: 2 } }, {}, "llm.retry"],
    [{ provider: "anthropic", model: "model", apiKey: "key", requestTimeoutMs: 10_000 }, {}, "llm.requestTimeoutMs"],
    [{ provider: "disabled", requestTimeoutMs: 10_000 }, {}, "llm.requestTimeoutMs"],
  ] as const)("keeps secret-free request-policy projection parity for invalid combination %#", (llm, env, path) => {
    const content = JSON.stringify({ llm });
    expect(() => parseDaemonConfig(content, {}, env)).toThrow(path);
    expect(() => parseLlmRequestPolicyConfig(content, env)).toThrow(path);
  });

  it("exports a pure partial request policy resolver for CLI and route callers", () => {
    const base = {
      requestTimeoutMs: DEFAULT_LLM_REQUEST_TIMEOUT_MS,
      retry: { ...DEFAULT_LLM_RETRY_POLICY },
    };
    const resolved = resolveLlmRequestPolicy(base, {
      requestTimeoutMs: 45_000,
      retry: { maxAttempts: 4, initialDelayMs: 0 },
    }, "compact");
    expect(resolved).toEqual({
      requestTimeoutMs: 45_000,
      retry: { maxAttempts: 4, initialDelayMs: 0, maxDelayMs: 30_000, multiplier: 2 },
    });
    expect(base).toEqual({
      requestTimeoutMs: DEFAULT_LLM_REQUEST_TIMEOUT_MS,
      retry: DEFAULT_LLM_RETRY_POLICY,
    });
  });
});

describe("deepMerge", () => {
  it("rejects prototype pollution keys", () => {
    const source = JSON.parse('{"__proto__": {"polluted": true}, "constructor": {"name": "pwned"}}');
    const result = deepMerge({ a: 1 } as Record<string, unknown>, source);
    expect((({}) as any).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(result, "__proto__")).toBe(false);
  });

  it("merges normal keys correctly", () => {
    const result = deepMerge({ a: 1, b: { c: 2 } } as Record<string, unknown>, { b: { d: 3 } } as Record<string, unknown>);
    expect(result.a).toBe(1);
    expect((result.b as any).c).toBe(2);
    expect((result.b as any).d).toBe(3);
  });
});
