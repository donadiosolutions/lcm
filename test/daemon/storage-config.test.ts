import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  daemonConfigForPersistence,
  loadDaemonConfig,
  parseDaemonConfig,
  parseStoredConfig,
  resolveStorageConfig,
} from "../../src/daemon/config.js";
import { createDaemon } from "../../src/daemon/server.js";
import { StorageBackendUnavailableError } from "../../src/storage/backend.js";

const tempDirs: string[] = [];

function caFile(contents = "trusted-ca"): string {
  const directory = mkdtempSync(join(tmpdir(), "lcm-postgres-ca-"));
  tempDirs.push(directory);
  const path = join(directory, "ca.crt");
  writeFileSync(path, contents);
  return path;
}

function postgresEnv(caPath = caFile()): Record<string, string> {
  return {
    LCM_POSTGRES_URL: "postgresql://user:password@db.example.com:25060/lcm",
    LCM_POSTGRES_CA_FILE: caPath,
  };
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("storage configuration", () => {
  it("keeps SQLite as the zero-configuration default and ignores PostgreSQL environment values", () => {
    expect(parseDaemonConfig("{}", {}, {
      LCM_POSTGRES_URL: "not-a-url",
      LCM_POSTGRES_CA_FILE: "relative",
    }).storage).toEqual({ backend: "sqlite" });
    expect(resolveStorageConfig({})).toEqual({ backend: "sqlite" });
  });

  it("resolves PostgreSQL defaults and stored non-secret settings", () => {
    const config = parseDaemonConfig(JSON.stringify({
      storage: {
        backend: "postgresql",
        postgresql: {
          poolMax: 9,
          connectionTimeoutMs: 12_000,
          idleTimeoutMs: 0,
          statementTimeoutMs: 90_000,
        },
      },
    }), {}, postgresEnv());

    expect(config.storage).toMatchObject({
      backend: "postgresql",
      postgresql: {
        poolMax: 9,
        connectionTimeoutMs: 12_000,
        idleTimeoutMs: 0,
        statementTimeoutMs: 90_000,
      },
    });
  });

  it("applies PostgreSQL defaults when the shared resolver is called directly", () => {
    const env = postgresEnv();
    expect(resolveStorageConfig({ backend: "postgresql" }, env)).toMatchObject({
      backend: "postgresql",
      postgresql: {
        poolMax: 5,
        connectionTimeoutMs: 10_000,
        idleTimeoutMs: 30_000,
        statementTimeoutMs: 60_000,
      },
    });
  });

  it("uses identical resolution for parsed, loaded, and effective PostgreSQL configuration", () => {
    const directory = mkdtempSync(join(tmpdir(), "lcm-postgres-config-"));
    tempDirs.push(directory);
    const configPath = join(directory, "config.json");
    const content = JSON.stringify({
      storage: { backend: "postgresql", postgresql: { poolMax: 11 } },
    });
    writeFileSync(configPath, content);
    const env = postgresEnv();
    expect(loadDaemonConfig(configPath, {}, env).storage)
      .toEqual(parseDaemonConfig(content, {}, env).storage);
  });

  it("accepts every PostgreSQL tuning boundary", () => {
    const config = parseDaemonConfig(JSON.stringify({
      storage: {
        backend: "postgresql",
        postgresql: {
          poolMax: 100,
          connectionTimeoutMs: 600_000,
          idleTimeoutMs: 3_600_000,
          statementTimeoutMs: 3_600_000,
        },
      },
    }), {}, postgresEnv());
    expect(config.storage).toMatchObject({
      postgresql: {
        poolMax: 100,
        connectionTimeoutMs: 600_000,
        idleTimeoutMs: 3_600_000,
        statementTimeoutMs: 3_600_000,
      },
    });
  });

  it("applies runtime overrides above environment secrets and JSON", () => {
    const runtimeCa = caFile("runtime-ca");
    const config = parseDaemonConfig(
      JSON.stringify({ storage: { backend: "postgresql", postgresql: { poolMax: 6 } } }),
      {
        storage: {
          postgresql: {
            poolMax: 8,
            url: "postgresql://runtime:secret@runtime.example.com/lcm",
            caFile: runtimeCa,
          },
        },
      },
      postgresEnv(caFile("environment-ca")),
    );
    expect(config.storage).toEqual({
      backend: "postgresql",
      postgresql: {
        poolMax: 8,
        connectionTimeoutMs: 10_000,
        idleTimeoutMs: 30_000,
        statementTimeoutMs: 60_000,
        url: "postgresql://runtime:secret@runtime.example.com/lcm",
        caFile: runtimeCa,
      },
    });
  });

  it.each([
    [{ backend: 3 }, "storage.backend"],
    [{ backend: "mysql" }, "storage.backend"],
    [{ backend: "sqlite", unexpected: true }, "storage.unexpected"],
    [{ backend: "sqlite", postgresql: [] }, "storage.postgresql"],
    [{ backend: "sqlite", postgresql: { unexpected: true } }, "storage.postgresql.unexpected"],
    [{ backend: "sqlite", postgresql: { poolMax: 0 } }, "storage.postgresql.poolMax"],
    [{ backend: "sqlite", postgresql: { connectionTimeoutMs: 600_001 } }, "storage.postgresql.connectionTimeoutMs"],
    [{ backend: "sqlite", postgresql: { idleTimeoutMs: -1 } }, "storage.postgresql.idleTimeoutMs"],
    [{ backend: "sqlite", postgresql: { statementTimeoutMs: 0 } }, "storage.postgresql.statementTimeoutMs"],
  ])("rejects malformed or out-of-range stored storage configuration %#", (storage, path) => {
    expect(() => parseStoredConfig(JSON.stringify({ storage }))).toThrow(path);
  });

  it.each(["url", "caFile"])("rejects persisted PostgreSQL secret key %s", (key) => {
    expect(() => parseStoredConfig(JSON.stringify({
      storage: { backend: "postgresql", postgresql: { [key]: "secret" } },
    }))).toThrow(key === "url" ? "LCM_POSTGRES_URL" : "LCM_POSTGRES_CA_FILE");
  });

  it("validates runtime secret types without exposing their values", () => {
    expect(() => parseDaemonConfig("{}", {
      storage: { backend: "postgresql", postgresql: { url: 1, caFile: 2 } },
    })).toThrow("storage.postgresql.url");
  });

  it("requires both PostgreSQL environment secrets", () => {
    expect(() => parseDaemonConfig("{}", { storage: { backend: "postgresql" } })).toThrow("LCM_POSTGRES_URL");
    expect(() => parseDaemonConfig("{}", {
      storage: { backend: "postgresql" },
    }, { LCM_POSTGRES_URL: "postgresql://db.example.com/lcm", LCM_POSTGRES_CA_FILE: " " })).toThrow("LCM_POSTGRES_CA_FILE");
  });

  it.each([
    ["not a url", "absolute postgresql"],
    ["https://user:scheme-secret@example.com/lcm", "postgresql: scheme"],
    ["postgresql://user:tls-secret@example.com/lcm?SSLCert=inline", "TLS parameter"],
  ])("rejects unsafe PostgreSQL URL %s without echoing credentials", (url, expected) => {
    const error = (() => {
      try {
        parseDaemonConfig("{}", { storage: { backend: "postgresql" } }, {
          LCM_POSTGRES_URL: url,
          LCM_POSTGRES_CA_FILE: caFile(),
        });
      } catch (caught) {
        return caught as Error;
      }
      throw new Error("expected configuration error");
    })();
    expect(error.message).toContain(expected);
    expect(error.message).not.toContain(url);
    expect(error.message).not.toContain("scheme-secret");
    expect(error.message).not.toContain("tls-secret");
  });

  it("requires an absolute, readable, non-empty CA file", () => {
    expect(() => parseDaemonConfig("{}", { storage: { backend: "postgresql" } }, {
      LCM_POSTGRES_URL: "postgresql://db.example.com/lcm",
      LCM_POSTGRES_CA_FILE: "relative.crt",
    })).toThrow("absolute path");
    expect(() => parseDaemonConfig("{}", { storage: { backend: "postgresql" } }, {
      LCM_POSTGRES_URL: "postgresql://db.example.com/lcm",
      LCM_POSTGRES_CA_FILE: "/missing/lcm-ca.crt",
    })).toThrow("cannot read");
    expect(() => parseDaemonConfig("{}", { storage: { backend: "postgresql" } }, postgresEnv(caFile("")))).toThrow("must not be empty");
  });

  it("persists PostgreSQL selection and tuning without secrets", () => {
    const config = parseDaemonConfig("{}", { storage: { backend: "postgresql" } }, postgresEnv());
    const persisted = daemonConfigForPersistence(config) as { storage: Record<string, unknown> };
    expect(persisted.storage).toEqual({
      backend: "postgresql",
      postgresql: {
        poolMax: 5,
        connectionTimeoutMs: 10_000,
        idleTimeoutMs: 30_000,
        statementTimeoutMs: 60_000,
      },
    });
    expect(JSON.stringify(persisted.storage)).not.toContain("password");
    expect(daemonConfigForPersistence(parseDaemonConfig("{}")).storage).toEqual({ backend: "sqlite" });
  });

  it("fails before the daemon listens when the selected PostgreSQL implementation is unavailable", async () => {
    const config = parseDaemonConfig("{}", { storage: { backend: "postgresql" } }, postgresEnv());
    await expect(createDaemon(config)).rejects.toBeInstanceOf(StorageBackendUnavailableError);
  });
});
