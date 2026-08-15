import { mkdirSync, mkdtempSync, realpathSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  daemonConfigForPersistence,
  loadDaemonConfig,
  parseDaemonConfig,
  parseStoredConfig,
  POSTGRESQL_CA_FILE_MAX_BYTES,
  resolveStorageConfig,
} from "../../src/daemon/config.js";
import { createDaemon } from "../../src/daemon/server.js";
import { parsePostgreSqlUrl } from "../../src/storage/postgresql/client-config.js";
import { makeStagedPostgreSqlStorageFactory } from "./routes/mock-storage-factory.js";

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
    LCM_POSTGRES_MIGRATION_ROLE: "lcm_migrator",
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
          migrationRole: "stored_migrator",
        },
      },
    }), {}, { ...postgresEnv(), LCM_POSTGRES_MIGRATION_ROLE: "environment_migrator" });

    expect(config.storage).toMatchObject({
      backend: "postgresql",
      postgresql: {
        poolMax: 9,
        connectionTimeoutMs: 12_000,
        idleTimeoutMs: 0,
        statementTimeoutMs: 90_000,
        migrationRole: "stored_migrator",
      },
    });
  });

  it("requires a PostgreSQL migration role and uses the environment only as a fallback", () => {
    expect(resolveStorageConfig({ backend: "postgresql" }, postgresEnv())).toMatchObject({
      backend: "postgresql",
      postgresql: { migrationRole: "lcm_migrator" },
    });
    expect(() => resolveStorageConfig({ backend: "postgresql" }, {
      LCM_POSTGRES_URL: postgresEnv().LCM_POSTGRES_URL,
      LCM_POSTGRES_CA_FILE: postgresEnv().LCM_POSTGRES_CA_FILE,
    })).toThrow("LCM_POSTGRES_MIGRATION_ROLE");
    expect(resolveStorageConfig({
      backend: "postgresql",
      postgresql: { migrationRole: " \nstored_migrator\t " },
    }, { ...postgresEnv(), LCM_POSTGRES_MIGRATION_ROLE: "environment_migrator" })).toMatchObject({
      postgresql: { migrationRole: "stored_migrator" },
    });
  });

  it("ignores PostgreSQL migration role values for SQLite", () => {
    expect(resolveStorageConfig({
      backend: "sqlite",
      postgresql: { migrationRole: "\u0000not-used" },
    }, { LCM_POSTGRES_MIGRATION_ROLE: "\u0001also-not-used" })).toEqual({ backend: "sqlite" });
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
        migrationRole: "lcm_migrator",
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
        migrationRole: "lcm_migrator",
        url: "postgresql://runtime:secret@runtime.example.com/lcm",
        caFile: runtimeCa,
      },
    });
  });

  it("trims PostgreSQL environment and credential secrets before validation and use", () => {
    const trustedCa = caFile("trusted-ca");
    const config = parseDaemonConfig("{}", { storage: { backend: "postgresql" } }, {
      LCM_POSTGRES_URL: " \npostgresql://trim-user:trim-secret@db.example.com/lcm\t ",
      LCM_POSTGRES_CA_FILE: ` \n${trustedCa}\t `,
      LCM_POSTGRES_MIGRATION_ROLE: " \ntrim_migrator\t ",
    });

    expect(config.storage).toEqual({
      backend: "postgresql",
      postgresql: {
        poolMax: 5,
        connectionTimeoutMs: 10_000,
        idleTimeoutMs: 30_000,
        statementTimeoutMs: 60_000,
        migrationRole: "trim_migrator",
        url: "postgresql://trim-user:trim-secret@db.example.com/lcm",
        caFile: trustedCa,
      },
    });
    expect(JSON.stringify(daemonConfigForPersistence(config)).toLowerCase()).not.toContain("trim-secret");
  });

  it("accepts encoded PostgreSQL credentials and one decoded database path segment", () => {
    const trustedCa = caFile("trusted-ca");
    const encodedUrl = "postgresql://encoded%20user:encoded%2Fpassword@db.example.com/lcm%20database";
    const config = parseDaemonConfig("{}", { storage: { backend: "postgresql" } }, {
      LCM_POSTGRES_URL: encodedUrl,
      LCM_POSTGRES_CA_FILE: trustedCa,
      LCM_POSTGRES_MIGRATION_ROLE: "lcm_migrator",
    });

    expect(config.storage).toMatchObject({
      backend: "postgresql",
      postgresql: { url: encodedUrl },
    });
  });

  it.each([
    { label: "implicit default", url: "postgresql://user:password@db.example.com/lcm", port: 5432 },
    { label: "minimum explicit", url: "postgresql://user:password@db.example.com:1/lcm", port: 1 },
    { label: "maximum explicit", url: "postgresql://user:password@db.example.com:65535/lcm", port: 65_535 },
  ])("accepts the same PostgreSQL port boundary as the runtime parser: $label", ({ url, port }) => {
    const storage = resolveStorageConfig({ backend: "postgresql" }, {
      LCM_POSTGRES_URL: url,
      LCM_POSTGRES_CA_FILE: caFile(),
      LCM_POSTGRES_MIGRATION_ROLE: "lcm_migrator",
    });

    expect(storage).toMatchObject({ backend: "postgresql", postgresql: { url } });
    expect(parsePostgreSqlUrl(url).port).toBe(port);
  });

  it("returns the canonical CA path established by the validated file preflight", () => {
    const trustedCa = caFile("trusted-ca");
    const nestedDirectory = join(dirname(trustedCa), "nested");
    mkdirSync(nestedDirectory);
    const pathWithParentSegment = `${nestedDirectory}${sep}..${sep}ca.crt`;

    const storage = resolveStorageConfig({ backend: "postgresql" }, postgresEnv(pathWithParentSegment));

    expect(storage).toMatchObject({
      backend: "postgresql",
      postgresql: { caFile: realpathSync(trustedCa) },
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
    [{ backend: "postgresql", postgresql: { migrationRole: 7 } }, "storage.postgresql.migrationRole"],
    [{ backend: "postgresql", postgresql: { migrationRole: "   " } }, "storage.postgresql.migrationRole"],
    [{ backend: "postgresql", postgresql: { migrationRole: "bad\u0000role" } }, "storage.postgresql.migrationRole"],
    [{ backend: "postgresql", postgresql: { migrationRole: "x".repeat(64) } }, "storage.postgresql.migrationRole"],
    [{ backend: "postgresql", postgresql: { migrationRole: "é".repeat(32) } }, "storage.postgresql.migrationRole"],
  ])("rejects malformed or out-of-range stored storage configuration %#", (storage, path) => {
    const error = (() => {
      try {
        parseStoredConfig(JSON.stringify({ storage }));
      } catch (caught) {
        return caught as Error;
      }
      throw new Error("expected configuration error");
    })();
    expect(error.message).toContain(path);
    if (path.endsWith("migrationRole")) {
      expect(error.message).not.toContain("bad");
      expect(error.message).not.toContain("x".repeat(64));
      expect(error.message).not.toContain("é");
    }
  });

  it.each([
    ["missing", undefined],
    ["blank", " \n\t "],
    ["control", "valid\u007frole"],
    ["too long", "a".repeat(64)],
    ["too many UTF-8 bytes", "é".repeat(32)],
  ])("rejects %s PostgreSQL migration role from the environment safely", (_label, migrationRole) => {
    const env = {
      LCM_POSTGRES_URL: postgresEnv().LCM_POSTGRES_URL,
      LCM_POSTGRES_CA_FILE: postgresEnv().LCM_POSTGRES_CA_FILE,
      ...(migrationRole === undefined ? {} : { LCM_POSTGRES_MIGRATION_ROLE: migrationRole }),
    };
    const error = (() => {
      try {
        resolveStorageConfig({ backend: "postgresql" }, env);
      } catch (caught) {
        return caught as Error;
      }
      throw new Error("expected configuration error");
    })();
    expect(error.message).toContain("LCM_POSTGRES_MIGRATION_ROLE");
    if (migrationRole !== undefined) expect(error.message).not.toContain(migrationRole);
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
    { label: "non-URL", url: "not a url", expected: "absolute postgresql" },
    { label: "wrong scheme", url: "https://user:scheme-secret@example.com/lcm", expected: "postgresql: scheme" },
    { label: "non-hierarchical", url: "postgresql:foo", expected: "hierarchical postgresql://" },
    { label: "missing host", url: "postgresql://", expected: "non-empty hostname" },
    { label: "database without host", url: "postgresql:///database", expected: "non-empty hostname" },
    { label: "empty query", url: "postgresql://user:empty-query-secret@example.com/lcm?", expected: "URL query parameters" },
    { label: "empty query before fragment", url: "postgresql://user:empty-query-fragment-secret@example.com/lcm?#unsafe", expected: "URL query parameters" },
    { label: "TLS query override", url: "postgresql://user:tls-secret@example.com/lcm?SSLCert=inline", expected: "TLS parameter" },
    { label: "arbitrary query parameter", url: "postgresql://user:query-secret@example.com/lcm?application_name=unsafe", expected: "URL query parameters" },
    { label: "fragment", url: "postgresql://user:fragment-secret@example.com/lcm#unsafe", expected: "URL fragment" },
    { label: "question mark in fragment", url: "postgresql://user:question-fragment-secret@example.com/lcm#unsafe?not-a-query", expected: "URL fragment" },
  ])("rejects unsafe PostgreSQL URL: $label without echoing credentials", ({ url, expected }) => {
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
    for (const secret of [
      "scheme-secret",
      "empty-query-secret",
      "empty-query-fragment-secret",
      "tls-secret",
      "query-secret",
      "fragment-secret",
      "question-fragment-secret",
    ]) {
      expect(error.message).not.toContain(secret);
    }
  });

  it.each([
    {
      label: "zero",
      url: "postgresql://user:zero-port-secret@db.example.com:0/lcm",
      expected: "PostgreSQL port from 1 through 65535",
    },
    {
      label: "overflow",
      url: "postgresql://user:overflow-port-secret@db.example.com:65536/lcm",
      expected: "absolute postgresql: URL",
    },
    {
      label: "malformed",
      url: "postgresql://user:malformed-port-secret@db.example.com:12x/lcm",
      expected: "absolute postgresql: URL",
    },
  ])("rejects the same invalid PostgreSQL port as the runtime parser: $label", ({ url, expected }) => {
    const daemonError = (() => {
      try {
        resolveStorageConfig({ backend: "postgresql" }, {
          LCM_POSTGRES_URL: url,
          LCM_POSTGRES_CA_FILE: caFile(),
        });
      } catch (caught) {
        return caught as Error;
      }
      throw new Error("expected configuration error");
    })();

    expect(daemonError.message).toContain("LCM_POSTGRES_URL");
    expect(daemonError.message).toContain(expected);
    expect(daemonError.message).not.toContain("port-secret");
    expect(() => parsePostgreSqlUrl(url)).toThrowError(expect.objectContaining({
      code: "STORAGE_INITIALIZATION_FAILED",
      operation: "configure",
    }));
  });

  it.each([
    {
      label: "missing username",
      url: "postgresql://:missing-username-secret@db.example.com/lcm",
      forbidden: "missing-username-secret",
    },
    {
      label: "missing password",
      url: "postgresql://missing-password-user@db.example.com/lcm",
      forbidden: "missing-password-user",
    },
    {
      label: "missing database path",
      url: "postgresql://user:missing-database-secret@db.example.com",
      forbidden: "missing-database-secret",
    },
    {
      label: "empty database path",
      url: "postgresql://user:empty-database-secret@db.example.com/",
      forbidden: "empty-database-secret",
    },
    {
      label: "nested database path",
      url: "postgresql://user:nested-database-secret@db.example.com/lcm/nested",
      forbidden: "nested-database-secret",
    },
    {
      label: "encoded nested database path",
      url: "postgresql://user:encoded-nested-secret@db.example.com/lcm%2Fnested",
      forbidden: "encoded-nested-secret",
    },
    {
      label: "invalid username encoding",
      url: "postgresql://invalid%E0%A4%A:invalid-username-secret@db.example.com/lcm",
      forbidden: "invalid-username-secret",
    },
    {
      label: "invalid password encoding",
      url: "postgresql://user:invalid%E0%A4%A@db.example.com/lcm",
      forbidden: "invalid%E0%A4%A",
    },
    {
      label: "invalid database encoding",
      url: "postgresql://user:invalid-encoding-secret@db.example.com/%E0%A4%A",
      forbidden: "invalid-encoding-secret",
    },
  ])("rejects PostgreSQL URL with $label without echoing credentials", ({ url, forbidden }) => {
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
    expect(error.message).toContain(
      "explicit non-empty username and password and exactly one non-empty decoded database path segment",
    );
    expect(error.message).not.toContain(forbidden);
  });

  it("requires an absolute, readable, non-empty regular CA file within the size limit", () => {
    expect(() => parseDaemonConfig("{}", { storage: { backend: "postgresql" } }, {
      LCM_POSTGRES_URL: "postgresql://user:password@db.example.com/lcm",
      LCM_POSTGRES_CA_FILE: "relative.crt",
    })).toThrow("absolute path");
    expect(() => parseDaemonConfig("{}", { storage: { backend: "postgresql" } }, {
      LCM_POSTGRES_URL: "postgresql://user:password@db.example.com/lcm",
      LCM_POSTGRES_CA_FILE: "/missing/lcm-ca.crt",
    })).toThrow("readable regular file");
    expect(() => parseDaemonConfig("{}", { storage: { backend: "postgresql" } }, postgresEnv(caFile("")))).toThrow("must not be empty");

    const directory = mkdtempSync(join(tmpdir(), "lcm-postgres-ca-type-"));
    tempDirs.push(directory);
    const nestedDirectory = join(directory, "ca.crt");
    mkdirSync(nestedDirectory);
    expect(() => parseDaemonConfig("{}", { storage: { backend: "postgresql" } }, postgresEnv(nestedDirectory)))
      .toThrow("readable regular file");

    const oversizedCa = join(directory, "oversized-ca.crt");
    writeFileSync(oversizedCa, "x");
    truncateSync(oversizedCa, POSTGRESQL_CA_FILE_MAX_BYTES + 1);
    expect(() => parseDaemonConfig("{}", { storage: { backend: "postgresql" } }, postgresEnv(oversizedCa)))
      .toThrow(`${POSTGRESQL_CA_FILE_MAX_BYTES} bytes`);
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
        migrationRole: "lcm_migrator",
      },
    });
    expect(JSON.stringify(persisted.storage)).not.toContain("password");
    expect(daemonConfigForPersistence(parseDaemonConfig("{}")).storage).toEqual({ backend: "sqlite" });
  });

  it("persists an environment-derived migration role for an env-free reload", () => {
    const config = parseDaemonConfig("{}", { storage: { backend: "postgresql" } }, postgresEnv());
    const persisted = daemonConfigForPersistence(config);
    const reloaded = parseDaemonConfig(JSON.stringify(persisted), {}, {
      LCM_POSTGRES_URL: postgresEnv().LCM_POSTGRES_URL,
      LCM_POSTGRES_CA_FILE: postgresEnv().LCM_POSTGRES_CA_FILE,
    });
    expect((persisted.storage as Record<string, unknown>).postgresql).toEqual({
      poolMax: 5,
      connectionTimeoutMs: 10_000,
      idleTimeoutMs: 30_000,
      statementTimeoutMs: 60_000,
      migrationRole: "lcm_migrator",
    });
    expect(reloaded.storage).toMatchObject({ postgresql: { migrationRole: "lcm_migrator" } });
    expect(JSON.stringify(persisted.storage)).not.toContain("postgresql://");
    expect(JSON.stringify(persisted.storage)).not.toContain("caFile");
  });

  it("starts the daemon with explicitly unavailable staged PostgreSQL storage", async () => {
    const config = parseDaemonConfig(
      "{}",
      { storage: { backend: "postgresql" }, daemon: { port: 0, idleTimeoutMs: 0 } },
      postgresEnv(),
    );
    const daemon = await createDaemon(config, {
      _assertBackendPublication: () => undefined,
      _createStorageBackendFactory: async () => makeStagedPostgreSqlStorageFactory(),
    });
    try {
      const response = await fetch(`http://127.0.0.1:${daemon.address().port}/health`);
      await expect(response.json()).resolves.toMatchObject({
        status: "unavailable",
        storageBackend: "postgresql",
        storage: { status: "unavailable" },
      });
      expect(response.status).toBe(503);
    } finally {
      await daemon.stop();
    }
  });
});
