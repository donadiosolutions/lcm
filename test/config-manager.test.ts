import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ConfigManagerError,
  formatConfigValue,
  getConfigValue,
  maskConfigSecrets,
  normalizeConfigPath,
  parseConfigPath,
  parseConfigValue,
  setConfigValue,
} from "../src/config-manager.js";
import {
  loadStoredConfigProjection,
  loadStoredLlmRequestPolicyConfig,
} from "../src/config-projection.js";

const tempDirs: string[] = [];

function makeConfig(content: unknown): { directory: string; configPath: string } {
  const directory = mkdtempSync(join(tmpdir(), "lcm-config-manager-"));
  tempDirs.push(directory);
  const configPath = join(directory, "config.json");
  writeFileSync(configPath, `${JSON.stringify(content, null, 2)}\n`, { mode: 0o600 });
  return { directory, configPath };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("config manager paths and values", () => {
  it("canonicalizes legacy paths and rejects unsafe paths", () => {
    expect(parseConfigPath("llm.baseURL")).toEqual(["llm", "baseUrl"]);
    expect(normalizeConfigPath("llm.baseURL")).toBe("llm.baseUrl");
    expect(parseConfigPath("compaction.promotionThresholds.mergeMaxEntries")).toEqual([
      "compaction",
      "promotionThresholds",
      "dedupCandidateLimit",
    ]);
    expect(normalizeConfigPath("compaction.promotionThresholds.mergeMaxEntries"))
      .toBe("compaction.promotionThresholds.dedupCandidateLimit");
    for (const path of [
      "",
      ".llm",
      "llm.",
      "llm..model",
      " llm.provider",
      "llm.provider ",
      "llm. provider",
      "llm.   .provider",
      "__proto__.polluted",
      "llm.constructor.value",
      "prototype.x",
    ]) {
      expect(() => parseConfigPath(path)).toThrow(ConfigManagerError);
    }
  });

  it("parses string and typed JSON values and formats CLI output", () => {
    expect(parseConfigValue("false")).toBe("false");
    expect(parseConfigValue("false", true)).toBe(false);
    expect(parseConfigValue("[1,2]", true)).toEqual([1, 2]);
    expect(() => parseConfigValue("{", true)).toThrow("Invalid JSON configuration value");
    expect(formatConfigValue("value")).toBe("value");
    expect(formatConfigValue({ enabled: true })).toBe('{\n  "enabled": true\n}');
    expect(formatConfigValue(undefined)).toBe("undefined");
  });

  it("reports a non-Error JSON parser failure", () => {
    vi.spyOn(JSON, "parse").mockImplementationOnce(() => { throw "parser failed"; });
    expect(() => parseConfigValue("ignored", true)).toThrow("parser failed");
  });

  it("recursively masks secret-like keys, including scalar reads", () => {
    expect(maskConfigSecrets({
      apiKey: "one",
      nested: { password: "two", safe: "visible" },
      list: [{ access_token: "three", value: 1 }],
    })).toEqual({
      apiKey: "[REDACTED]",
      nested: { password: "[REDACTED]", safe: "visible" },
      list: [{ access_token: "[REDACTED]", value: 1 }],
    });
    expect(maskConfigSecrets("one", ["llm", "apiKey"])).toBe("[REDACTED]");
    expect(maskConfigSecrets("postgresql://user:password@db.example.com/lcm", ["storage", "postgresql", "url"]))
      .toBe("[REDACTED]");
  });

  it("sanitizes credentials and private URL components in direct and nested baseUrl values", () => {
    const unsafeUrl = "https://private-user:private-password@example.com/v1?token=private-query#private-fragment";
    const direct = maskConfigSecrets(unsafeUrl, ["llm", "baseUrl"]);
    const nested = maskConfigSecrets({ llm: { baseURL: unsafeUrl } });
    expect(direct).toBe("https://example.com/v1?[REDACTED]#[REDACTED]");
    expect(String(direct)).toContain("example.com/v1");
    expect(String(direct)).not.toContain("@");
    expect(JSON.stringify(nested)).not.toContain("@");
    for (const output of [String(direct), JSON.stringify(nested)]) {
      expect(output).not.toContain("private-user");
      expect(output).not.toContain("private-password");
      expect(output).not.toContain("private-query");
      expect(output).not.toContain("private-fragment");
      expect(output).toContain("REDACTED");
    }
  });

  it.each([
    "user:super-secret@example.com",
    "not a valid URL containing malformed-secret",
    "ftp://user:ftp-secret@example.com/v1",
  ])("redacts opaque, malformed, or non-HTTP baseUrl values wholesale: %s", (unsafeUrl) => {
    expect(maskConfigSecrets(unsafeUrl, ["llm", "baseUrl"])).toBe("[REDACTED]");
    expect(maskConfigSecrets({ llm: { baseUrl: unsafeUrl } })).toEqual({
      llm: { baseUrl: "[REDACTED]" },
    });
  });

  it("recursively masks authorization, cookie, private-key, and credential variants", () => {
    const secrets = [
      "bearer-secret",
      "proxy-secret",
      "cookie-secret",
      "set-cookie-secret",
      "private-key-secret",
      "private-underscore-key-secret",
      "credential-secret",
    ];
    const masked = maskConfigSecrets({
      extension: {
        headers: {
          Authorization: secrets[0],
          "Proxy-Authorization": secrets[1],
          Cookie: secrets[2],
          "Set-Cookie": secrets[3],
        },
        privateKey: secrets[4],
        private_key: secrets[5],
        credentials: secrets[6],
        safeLabel: "visible",
      },
    });
    const output = JSON.stringify(masked);
    for (const secret of secrets) expect(output).not.toContain(secret);
    expect(masked).toMatchObject({
      extension: {
        headers: {
          Authorization: "[REDACTED]",
          "Proxy-Authorization": "[REDACTED]",
          Cookie: "[REDACTED]",
          "Set-Cookie": "[REDACTED]",
        },
        privateKey: "[REDACTED]",
        private_key: "[REDACTED]",
        credentials: "[REDACTED]",
        safeLabel: "visible",
      },
    });
  });
});

describe("local config projections", () => {
  it("projects persisted local settings and hook-only LLM policy", () => {
    const { configPath } = makeConfig({
      daemon: { port: 4123 },
      llm: { provider: "disabled" },
      storage: { backend: "sqlite" },
      security: { sensitivePatterns: ["PROJECT_SECRET"], notify_on_filter: true },
    });
    expect(loadStoredConfigProjection(configPath)).toEqual({
      daemonPort: 4123,
      storage: { backend: "sqlite" },
      security: { sensitivePatterns: ["PROJECT_SECRET"], notify_on_filter: true },
    });
    expect(loadStoredLlmRequestPolicyConfig(configPath, {})).toMatchObject({
      llm: { provider: "disabled" },
    });
  });

  it("uses bounded empty-file fallbacks only for missing files", () => {
    const directory = mkdtempSync(join(tmpdir(), "lcm-config-projection-missing-"));
    tempDirs.push(directory);
    const missingPath = join(directory, "missing.json");
    expect(loadStoredConfigProjection(missingPath)).toEqual({
      daemonPort: 3737,
      storage: { backend: "sqlite" },
      security: { sensitivePatterns: [] },
    });
    expect(loadStoredLlmRequestPolicyConfig(missingPath, {})).toMatchObject({
      llm: { provider: "auto" },
    });
    expect(() => loadStoredConfigProjection(directory)).toThrow();
  });
});

describe("getConfigValue", () => {
  it("rethrows non-missing filesystem failures and rejects traversal through a scalar", () => {
    const directory = mkdtempSync(join(tmpdir(), "lcm-config-manager-directory-"));
    tempDirs.push(directory);
    expect(() => getConfigValue({ configPath: directory, path: "llm" })).toThrow();

    const { configPath } = makeConfig({ llm: { provider: "disabled" } });
    expect(() => getConfigValue({ configPath, path: "llm.provider.child" })).toThrow("does not exist");
  });

  it("uses the process environment for effective reads when env is omitted", () => {
    vi.stubEnv("LCM_SUMMARY_PROVIDER", "disabled");
    const { configPath } = makeConfig({ version: 1 });
    expect(getConfigValue({ configPath, path: "llm.provider", effective: true })).toBe("disabled");
  });
  it("returns normalized stored values without defaults", () => {
    const { configPath } = makeConfig({ llm: { baseURL: "http://localhost:11434/v1", apiKey: "secret" } });
    expect(getConfigValue({ configPath, path: "llm.baseURL" })).toBe("http://localhost:11434/v1");
    expect(getConfigValue({ configPath, path: "llm.apiKey" })).toBe("[REDACTED]");
    expect(() => getConfigValue({ configPath, path: "daemon.port" })).toThrow("does not exist");
  });

  it.each([" llm.provider", "llm. provider"])(
    "rejects whitespace-padded path %j before reading a value",
    (path) => {
      const { configPath } = makeConfig({ llm: { provider: "disabled" } });
      expect(() => getConfigValue({ configPath, path })).toThrow("whitespace");
    },
  );

  it("sanitizes baseUrl secrets for scalar and whole-object stored reads", () => {
    const secrets = ["stored-user", "stored-password", "stored-query", "stored-fragment"];
    const unsafeUrl = `https://${secrets[0]}:${secrets[1]}@example.com/v1?token=${secrets[2]}#${secrets[3]}`;
    const { configPath } = makeConfig({ llm: { baseURL: unsafeUrl, apiKey: "stored-api-key" } });

    const scalar = getConfigValue({ configPath, path: "llm.baseURL" });
    const object = getConfigValue({ configPath, path: "llm" });
    expect((object as Record<string, unknown>).apiKey).toBe("[REDACTED]");
    expect(object).toHaveProperty("baseUrl", scalar);
    for (const output of [String(scalar), JSON.stringify(object)]) {
      for (const secret of secrets) expect(output).not.toContain(secret);
      expect(output).toContain("REDACTED");
    }
  });

  it("sanitizes baseUrl secrets for whole-object effective reads", () => {
    const secrets = ["effective-user", "effective-password", "effective-query", "effective-fragment"];
    const unsafeUrl = `http://${secrets[0]}:${secrets[1]}@localhost:11435/v1?token=${secrets[2]}#${secrets[3]}`;
    const { configPath } = makeConfig({
      llm: { provider: "openai", model: "local-model", baseUrl: unsafeUrl, apiKey: "effective-api-key" },
    });
    const object = getConfigValue({ configPath, path: "llm", effective: true, env: {} });
    const output = JSON.stringify(object);
    for (const secret of [...secrets, "effective-api-key"]) expect(output).not.toContain(secret);
    expect(output).toContain("REDACTED");
  });

  it("redacts the PostgreSQL URL but preserves non-secret effective storage values", () => {
    const { directory, configPath } = makeConfig({ storage: { backend: "postgresql" } });
    const caPath = join(directory, "postgres-ca.crt");
    writeFileSync(caPath, "trusted-ca");
    const storage = getConfigValue({
      configPath,
      path: "storage",
      effective: true,
      env: {
        LCM_POSTGRES_URL: " \npostgresql://effective-user:effective-password@db.example.com/lcm\t ",
        LCM_POSTGRES_CA_FILE: ` \n${caPath}\t `,
        LCM_POSTGRES_MIGRATION_ROLE: "effective_migrator",
      },
    });
    expect(storage).toMatchObject({
      backend: "postgresql",
      postgresql: { url: "[REDACTED]", caFile: caPath, poolMax: 5, migrationRole: "effective_migrator" },
    });
    expect(getConfigValue({
      configPath,
      path: "storage.postgresql.url",
      effective: true,
      env: {
        LCM_POSTGRES_URL: " \npostgresql://effective-user:effective-password@db.example.com/lcm\t ",
        LCM_POSTGRES_CA_FILE: ` \n${caPath}\t `,
        LCM_POSTGRES_MIGRATION_ROLE: "effective_migrator",
      },
    })).toBe("[REDACTED]");
    expect(JSON.stringify(storage)).not.toContain("effective-password");
  });

  it("exposes the effective PostgreSQL migration role without redaction", () => {
    const { directory, configPath } = makeConfig({ storage: { backend: "postgresql" } });
    const caPath = join(directory, "postgres-ca.crt");
    writeFileSync(caPath, "trusted-ca");
    expect(getConfigValue({
      configPath,
      path: "storage.postgresql.migrationRole",
      effective: true,
      env: {
        LCM_POSTGRES_URL: "postgresql://effective-user:effective-password@db.example.com/lcm",
        LCM_POSTGRES_CA_FILE: caPath,
        LCM_POSTGRES_MIGRATION_ROLE: "effective_migrator",
      },
    })).toBe("effective_migrator");
  });

  it("masks sensitive extension fields in whole-object reads", () => {
    const secrets = ["auth-value", "proxy-auth-value", "cookie-value", "private-key-value"];
    const { configPath } = makeConfig({
      extensions: {
        headers: {
          Authorization: secrets[0],
          "Proxy-Authorization": secrets[1],
          cookie: secrets[2],
        },
        privateKey: secrets[3],
        displayName: "safe-extension",
      },
    });
    const extension = getConfigValue({ configPath, path: "extensions" });
    const output = JSON.stringify(extension);
    for (const secret of secrets) expect(output).not.toContain(secret);
    expect(output).toContain("safe-extension");
    expect(extension).toMatchObject({
      headers: {
        Authorization: "[REDACTED]",
        "Proxy-Authorization": "[REDACTED]",
        cookie: "[REDACTED]",
      },
      privateKey: "[REDACTED]",
    });
  });

  it("recursively sanitizes credential-bearing URL values in extension fields", () => {
    const secrets = [
      "endpoint-user",
      "endpoint-password",
      "endpoint-query",
      "endpoint-fragment",
      "opaque-secret",
      "database-user",
      "database-password",
      "connection-user",
      "connection-password",
      "proxy-user",
      "proxy-password",
      "proxy-token",
    ];
    const unsafeUrl = `https://${secrets[0]}:${secrets[1]}@api.example.com/v1?token=${secrets[2]}#${secrets[3]}`;
    const databaseDsn = `postgres://${secrets[5]}:${secrets[6]}@db.example.com/app`;
    const { configPath } = makeConfig({
      extensions: {
        endpoint: unsafeUrl,
        callbackUrl: unsafeUrl,
        dsn: databaseDsn,
        nested: {
          webhookUri: unsafeUrl,
          arbitraryName: unsafeUrl,
          opaqueEndpoint: `user:${secrets[4]}@example.com`,
          statusMessage: `primary=${databaseDsn}; retrying`,
          protocolMessage: `fallback=//${secrets[9]}:${secrets[10]}@proxy.example.com/v1?token=${secrets[11]}; retrying`,
          connectionDetails: `Server=db;User Id=${secrets[7]};Password=${secrets[8]};Database=app`,
        },
        label: "visible",
      },
    });

    const endpoint = getConfigValue({ configPath, path: "extensions.endpoint" });
    const extensions = getConfigValue({ configPath, path: "extensions" });
    expect(endpoint).toBe("https://api.example.com/v1?[REDACTED]#[REDACTED]");
    expect(extensions).toMatchObject({
      endpoint,
      callbackUrl: endpoint,
      dsn: "[REDACTED]",
      nested: {
        webhookUri: endpoint,
        arbitraryName: endpoint,
        opaqueEndpoint: "[REDACTED]",
        statusMessage: "primary=[REDACTED]; retrying",
        protocolMessage: "fallback=//proxy.example.com/v1?[REDACTED]; retrying",
        connectionDetails: "Server=db;User Id=[REDACTED];Password=[REDACTED];Database=app",
      },
      label: "visible",
    });
    const output = JSON.stringify(extensions);
    for (const secret of secrets) expect(output).not.toContain(secret);
    expect(output).not.toContain("@");
  });

  it("returns defaults and environment overrides for effective reads", () => {
    const { configPath } = makeConfig({});
    expect(getConfigValue({
      configPath,
      path: "daemon.port",
      effective: true,
      env: { LCM_SUMMARY_PROVIDER: "disabled" },
    })).toBe(3737);
  });
});

describe("setConfigValue", () => {
  it("round-trips maxConcurrency and preserves it across provider transitions", () => {
    const { configPath } = makeConfig({
      llm: {
        provider: "openai",
        model: "local-model",
        baseUrl: "http://localhost:11435/v1",
        apiMode: "responses",
        maxConcurrency: 8,
      },
    });

    expect(getConfigValue({ configPath, path: "llm.maxConcurrency" })).toBe(8);
    expect(setConfigValue({
      configPath,
      path: "llm.provider",
      value: "disabled",
      env: {},
    })).toBe("disabled");
    expect(getConfigValue({ configPath, path: "llm.maxConcurrency" })).toBe(8);
    expect(setConfigValue({
      configPath,
      path: "llm.maxConcurrency",
      value: "17",
      json: true,
      env: {},
    })).toBe(17);
    expect(getConfigValue({ configPath, path: "llm.maxConcurrency" })).toBe(17);
  });

  it("preserves an explicitly selected PostgreSQL backend while setting a local value", () => {
    const { directory, configPath } = makeConfig({
      llm: { provider: "disabled" },
      storage: {
        backend: "postgresql",
      },
    });
    const caFile = join(directory, "ca.pem");
    writeFileSync(caFile, "test-ca\n");
    expect(setConfigValue({
      configPath,
      path: "hooks.disableAutoCompact",
      value: "true",
      json: true,
      env: {
        LCM_POSTGRES_URL: "postgresql://user:secret@db.example/lcm",
        LCM_POSTGRES_CA_FILE: caFile,
        LCM_POSTGRES_MIGRATION_ROLE: "lcm_migrator",
      },
    })).toBe(true);
  });

  it("uses the process environment when an explicit environment is omitted", () => {
    vi.stubEnv("LCM_SUMMARY_PROVIDER", "disabled");
    const { configPath } = makeConfig({ version: 1 });
    expect(setConfigValue({
      configPath,
      path: "hooks.disableAutoCompact",
      value: "true",
      json: true,
    })).toBe(true);
  });
  it("creates object parents, preserves unrelated keys, normalizes, and writes mode 0600 atomically", () => {
    const { directory, configPath } = makeConfig({ version: 1, unrelated: { keep: true } });

    expect(setConfigValue({
      configPath,
      path: "hooks.disableAutoCompact",
      value: "true",
      json: true,
      env: { LCM_SUMMARY_PROVIDER: "disabled" },
    })).toBe(true);

    const stored = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
    expect(stored).toMatchObject({
      version: 1,
      unrelated: { keep: true },
      hooks: { disableAutoCompact: true },
    });
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
    expect(readdirSync(directory).filter((name) => name.startsWith(".lcm-config-"))).toEqual([]);
  });

  it.each([" llm.provider", "llm. provider", "llm.provider "])(
    "rejects whitespace-padded path %j without changing the file",
    (path) => {
      const { configPath } = makeConfig({ version: 1, llm: { provider: "disabled" } });
      const before = readFileSync(configPath, "utf-8");

      expect(() => setConfigValue({
        configPath,
        path,
        value: "codex-process",
        env: {},
      })).toThrow("whitespace");
      expect(readFileSync(configPath, "utf-8")).toBe(before);
    },
  );

  it("writes only the canonical baseUrl spelling", () => {
    const { configPath } = makeConfig({ llm: { baseURL: "http://old.example/v1" } });
    setConfigValue({
      configPath,
      path: "llm.baseURL",
      value: "http://new.example/v1",
      env: { LCM_SUMMARY_PROVIDER: "disabled" },
    });
    const stored = JSON.parse(readFileSync(configPath, "utf-8")) as { llm: Record<string, unknown> };
    expect(stored.llm.baseUrl).toBe("http://new.example/v1");
    expect(stored.llm).not.toHaveProperty("baseURL");
  });

  it("sets and returns a typed value through the legacy promotion-limit path", () => {
    const { configPath } = makeConfig({ version: 1 });
    const legacyPath = "compaction.promotionThresholds.mergeMaxEntries";

    expect(setConfigValue({
      configPath,
      path: legacyPath,
      value: "17",
      json: true,
      env: { LCM_SUMMARY_PROVIDER: "disabled" },
    })).toBe(17);

    const stored = JSON.parse(readFileSync(configPath, "utf-8")) as {
      compaction: { promotionThresholds: Record<string, unknown> };
    };
    expect(stored.compaction.promotionThresholds).toMatchObject({ dedupCandidateLimit: 17 });
    expect(stored.compaction.promotionThresholds).not.toHaveProperty("mergeMaxEntries");
    expect(getConfigValue({ configPath, path: legacyPath })).toBe(17);
  });

  it("masks the returned value for secret paths", () => {
    const { configPath } = makeConfig({});
    expect(setConfigValue({
      configPath,
      path: "llm.apiKey",
      value: "very-secret",
      env: { LCM_SUMMARY_PROVIDER: "disabled" },
    })).toBe("[REDACTED]");
  });

  it.each([
    ["anthropic", "anthropic"],
    ["auto", "auto"],
    ["claude", "claude-process"],
    ["codex", "codex-process"],
    ["disabled", "disabled"],
  ])("removes incompatible settings when changing provider to %s", (provider, expectedProvider) => {
    const { configPath } = makeConfig({
      version: 1,
      customSection: { keep: true },
      llm: {
        provider: "openai",
        model: "shared-model",
        apiKey: "shared-api-key",
        baseUrl: "http://localhost:11435/v1",
        apiMode: "responses",
        reasoningEffort: "high",
        requestTimeoutMs: 30_000,
        retry: { maxAttempts: 4, initialDelayMs: 100, maxDelayMs: 1_000, multiplier: 2 },
      },
    });

    expect(setConfigValue({
      configPath,
      path: "llm.provider",
      value: provider,
      env: {},
    })).toBe(expectedProvider);

    const stored = JSON.parse(readFileSync(configPath, "utf-8")) as {
      customSection: unknown;
      llm: Record<string, unknown>;
    };
    expect(stored.customSection).toEqual({ keep: true });
    expect(stored.llm).toMatchObject({
      provider: expectedProvider,
      model: "shared-model",
      apiKey: "shared-api-key",
      baseUrl: "http://localhost:11435/v1",
    });
    for (const key of ["apiMode", "retry"]) {
      expect(stored.llm).not.toHaveProperty(key);
    }
    if (expectedProvider === "auto" || expectedProvider === "claude-process" || expectedProvider === "codex-process") {
      expect(stored.llm.reasoningEffort).toBe("high");
      expect(stored.llm.requestTimeoutMs).toBe(30_000);
    } else {
      expect(stored.llm).not.toHaveProperty("reasoningEffort");
      expect(stored.llm).not.toHaveProperty("requestTimeoutMs");
    }
  });

  it.each(["openai", "custom", "openai-compatible"])(
    "retains OpenAI-only settings when setting the OpenAI provider alias %s",
    (provider) => {
      const { configPath } = makeConfig({
        llm: {
          provider: "openai",
          model: "local-model",
          baseUrl: "http://localhost:11435/v1",
          apiMode: "responses",
          reasoningEffort: "medium",
          requestTimeoutMs: 30_000,
          retry: { maxAttempts: 4 },
        },
      });

      setConfigValue({ configPath, path: "llm.provider", value: provider, env: {} });

      const stored = JSON.parse(readFileSync(configPath, "utf-8")) as {
        llm: Record<string, unknown>;
      };
      expect(stored.llm).toMatchObject({
        provider: "openai",
        apiMode: "responses",
        reasoningEffort: "medium",
        requestTimeoutMs: 30_000,
        retry: { maxAttempts: 4 },
      });
    },
  );

  it("preserves process controls only when the destination provider supports them", () => {
    const { configPath } = makeConfig({
      llm: { provider: "codex-process", reasoningEffort: "minimal", fastMode: true },
    });

    setConfigValue({ configPath, path: "llm.provider", value: "claude-process", env: {} });

    const stored = JSON.parse(readFileSync(configPath, "utf-8")) as { llm: Record<string, unknown> };
    expect(stored.llm.provider).toBe("claude-process");
    expect(stored.llm.fastMode).toBe(true);
    expect(stored.llm).not.toHaveProperty("reasoningEffort");
  });

  it("drops process-only fast mode when changing to an API provider", () => {
    const { configPath } = makeConfig({
      llm: {
        provider: "codex-process",
        model: "local-model",
        baseUrl: "http://localhost:11435/v1",
        reasoningEffort: "high",
        fastMode: true,
      },
    });

    setConfigValue({ configPath, path: "llm.provider", value: "openai", env: {} });

    const stored = JSON.parse(readFileSync(configPath, "utf-8")) as { llm: Record<string, unknown> };
    expect(stored.llm.provider).toBe("openai");
    expect(stored.llm).not.toHaveProperty("fastMode");
    expect(stored.llm).not.toHaveProperty("reasoningEffort");
  });

  it("does not rewrite the file when a provider transition remains invalid", () => {
    const { configPath } = makeConfig({
      llm: {
        provider: "openai",
        model: "local-model",
        baseUrl: "http://localhost:11435/v1",
        apiMode: "responses",
        reasoningEffort: "medium",
      },
    });
    const before = readFileSync(configPath, "utf-8");

    expect(() => setConfigValue({
      configPath,
      path: "llm.provider",
      value: "not-a-provider",
      env: {},
    })).toThrow("llm.provider");
    expect(readFileSync(configPath, "utf-8")).toBe(before);
  });

  it("rejects traversal through scalars and arrays without changing the file", () => {
    for (const initial of [{ parent: "scalar" }, { parent: [] }]) {
      const { configPath } = makeConfig(initial);
      const before = readFileSync(configPath, "utf-8");
      expect(() => setConfigValue({
        configPath,
        path: "parent.child",
        value: "value",
        env: { LCM_SUMMARY_PROVIDER: "disabled" },
      })).toThrow("non-object segment");
      expect(readFileSync(configPath, "utf-8")).toBe(before);
    }
  });

  it.each([
    ["llm.provider", "not-a-provider", false, "llm.provider"],
    ["daemon.port", "not-a-port", false, "daemon.port"],
    ["daemon.port", "0", true, "daemon.port"],
    ["daemon.port", "70000", true, "daemon.port"],
    ["daemon.prt", "3737", true, "daemon.prt"],
    ["compaction.promotionThresholds.eventConfidence.decison", "0.5", true, "compaction.promotionThresholds.eventConfidence.decison"],
    ["hooks.disableAutoCompact", "false", false, "hooks.disableAutoCompact"],
  ] as const)("validates the full result before replacing the file when setting %s", (path, value, json, expectedPath) => {
    const { configPath } = makeConfig({ version: 1 });
    const before = readFileSync(configPath, "utf-8");
    expect(() => setConfigValue({ configPath, path, value, json, env: {} })).toThrow(expectedPath);
    expect(readFileSync(configPath, "utf-8")).toBe(before);
  });

  it("validates persisted provider configuration independently of summary provider and model overrides", () => {
    const { configPath } = makeConfig({
      version: 1,
      llm: { provider: "openai", baseUrl: "http://localhost:11435/v1" },
    });
    const before = readFileSync(configPath, "utf-8");
    expect(() => setConfigValue({
      configPath,
      path: "hooks.disableAutoCompact",
      value: "true",
      json: true,
      env: { LCM_SUMMARY_PROVIDER: "disabled", LCM_SUMMARY_MODEL: "environment-model" },
    })).toThrow("llm.model");
    expect(readFileSync(configPath, "utf-8")).toBe(before);
  });

  it("creates a missing configuration file only after validation succeeds", () => {
    const directory = mkdtempSync(join(tmpdir(), "lcm-config-manager-missing-"));
    tempDirs.push(directory);
    const configPath = join(directory, "nested", "config.json");
    expect(existsSync(configPath)).toBe(false);
    setConfigValue({
      configPath,
      path: "hooks.disableAutoCompact",
      value: "true",
      json: true,
      env: { LCM_SUMMARY_PROVIDER: "disabled" },
    });
    expect(existsSync(configPath)).toBe(true);
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
  });
});
