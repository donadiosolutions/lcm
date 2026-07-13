import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, type TestContext } from "vitest";
import {
  CANONICAL_LLM_PROVIDERS,
  ConfigValidationError,
  LLM_API_MODES,
  LLM_REASONING_EFFORTS,
  loadDaemonConfig,
  parseDaemonConfig,
  deepMerge,
} from "../../src/daemon/config.js";

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
    expect(c.daemon.port).toBe(3737);
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
    expect(c.llm.baseURL).toBe("http://localhost:11435/v1");
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
      { LCM_SUMMARY_PROVIDER: "openai" }
    );
    expect(c.llm.provider).toBe("openai");
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

describe("strict LLM configuration validation", () => {
  it("exports the canonical provider, API mode, and reasoning effort contracts", () => {
    expect(CANONICAL_LLM_PROVIDERS).toEqual(["auto", "claude-process", "codex-process", "anthropic", "openai", "disabled"]);
    expect(LLM_API_MODES).toEqual(["chat-completions", "responses"]);
    expect(LLM_REASONING_EFFORTS).toEqual(["none", "minimal", "low", "medium", "high", "xhigh"]);
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

  it("includes safely rendered unknown-key values in diagnostics", () => {
    expect(() => parseDaemonConfig(JSON.stringify({ llm: { timeout: 1000 } })))
      .toThrow('unknown key "timeout" with number value 1000');

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
    expect(message).toContain('"label":"visible"');
    expect(message).toContain('"apiKey":"[REDACTED]"');
    expect(message).not.toContain(secret);
  });

  it("redacts credential-like unknown keys", () => {
    const secret = "private-token-value";
    expect(() => parseDaemonConfig(JSON.stringify({ llm: { accessToken: secret } })))
      .toThrow('unknown key "accessToken" with string value "[REDACTED]"');
    try {
      parseDaemonConfig(JSON.stringify({ llm: { accessToken: secret } }));
    } catch (error) {
      expect(error instanceof Error ? error.message : String(error)).not.toContain(secret);
    }
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
    expect(message).toContain("llm.baseURL");
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

  it("accepts reasoning effort only for OpenAI Responses mode", () => {
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
    expect(() => parseDaemonConfig(JSON.stringify({ llm: { provider: "codex", reasoningEffort: "high" } }))).toThrow("only valid");
    expect(() => parseDaemonConfig(JSON.stringify({
      llm: {
        provider: "openai",
        model: "gpt-test",
        baseURL: "http://localhost:11435/v1",
        reasoningEffort: "high",
      },
    }))).toThrow('apiMode "responses"');
    expect(() => parseDaemonConfig(JSON.stringify({ llm: { provider: "disabled", apiMode: "responses" } }))).toThrow("only valid");
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
