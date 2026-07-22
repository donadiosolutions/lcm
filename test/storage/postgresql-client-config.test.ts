import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PeerCertificate } from "node:tls";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildPostgreSqlClientConfig,
  parsePostgreSqlUrl,
} from "../../src/storage/postgresql/client-config.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function caFile(contents = "test-ca"): string {
  const directory = mkdtempSync(join(tmpdir(), "lcm-postgresql-config-"));
  directories.push(directory);
  const path = join(directory, "ca.pem");
  writeFileSync(path, contents, { mode: 0o600 });
  return path;
}

function settings(path = caFile()) {
  return {
    url: "postgresql://encoded%20user:encoded%2Fpassword@db.example:5544/lcm%20database",
    caFile: path,
    poolMax: 7,
    connectionTimeoutMs: 101,
    idleTimeoutMs: 202,
    statementTimeoutMs: 303,
  };
}

describe("PostgreSQL client configuration", () => {
  it("parses explicit URLs and defaults the port", () => {
    expect(parsePostgreSqlUrl("postgresql://user:password@db.example/database")).toEqual({
      host: "db.example",
      port: 5432,
      user: "user",
      password: "password",
      database: "database",
    });
    expect(parsePostgreSqlUrl(settings().url)).toMatchObject({
      port: 5544,
      user: "encoded user",
      password: "encoded/password",
      database: "lcm database",
    });
    expect(parsePostgreSqlUrl("postgresql://user:password@[2001:db8::1]:5544/database"))
      .toMatchObject({ host: "2001:db8::1", port: 5544 });
    expect(parsePostgreSqlUrl("postgresql://user:password@db.example/database%3Fname"))
      .toMatchObject({ database: "database?name" });
  });

  it.each([
    { label: "non-URL", url: "not a url" },
    { label: "wrong scheme", url: "http://user:password@db.example/database" },
    { label: "non-hierarchical", url: "postgresql:user:password@db.example/database" },
    { label: "missing username", url: "postgresql://:password@db.example/database" },
    { label: "missing password", url: "postgresql://user:@db.example/database" },
    { label: "missing database", url: "postgresql://user:password@db.example/" },
    { label: "nested database path", url: "postgresql://user:password@db.example/a/b" },
    { label: "zero port", url: "postgresql://user:password@db.example:0/database" },
    { label: "oversized port", url: "postgresql://user:password@db.example:65536/database" },
    { label: "empty query", url: "postgresql://user:password@db.example/database?" },
    { label: "empty query before fragment", url: "postgresql://user:password@db.example/database?#override" },
    { label: "query override", url: "postgresql://user:password@db.example/database?sslmode=disable" },
    { label: "fragment override", url: "postgresql://user:password@db.example/database#override" },
    { label: "question mark in fragment", url: "postgresql://user:password@db.example/database#override?not-a-query" },
    { label: "missing hostname", url: "postgresql://user:password@/database" },
    { label: "malformed encoding", url: "postgresql://user:password@db.example/%ZZ" },
  ])("rejects unsafe or incomplete URL: $label", ({ url }) => {
    expect(() => parsePostgreSqlUrl(url)).toThrowError(expect.objectContaining({
      code: "STORAGE_INITIALIZATION_FAILED",
      operation: "configure",
    }));
  });

  it("builds a settings-only verified TLS client configuration", () => {
    const config = buildPostgreSqlClientConfig(settings(), {
      applicationName: "lcm-migrator",
      database: "override_database",
    });
    expect(config).toMatchObject({
      host: "db.example",
      port: 5544,
      user: "encoded user",
      password: "encoded/password",
      database: "override_database",
      application_name: "lcm-migrator",
      options: "-c timezone=UTC",
      client_encoding: "UTF8",
      replication: "false",
      sslnegotiation: "postgres",
      binary: false,
      connectionTimeoutMillis: 101,
      statement_timeout: 303,
      idle_in_transaction_session_timeout: 303,
      keepAlive: true,
      ssl: { ca: "test-ca", rejectUnauthorized: true },
    });
    const ssl = config.ssl as Exclude<typeof config.ssl, boolean | undefined>;
    expect(ssl.checkServerIdentity?.("ignored", {} as PeerCertificate)).toBeInstanceOf(Error);
  });

  it("uses default application and database settings", () => {
    expect(buildPostgreSqlClientConfig(settings())).toMatchObject({
      database: "lcm database",
      application_name: "lcm",
    });
  });

  it("passes an unbracketed IPv6 hostname to pg and TLS verification", () => {
    const ipv6Settings = {
      ...settings(),
      url: "postgresql://user:password@[2001:db8::1]:5544/database",
    };
    const config = buildPostgreSqlClientConfig(ipv6Settings);
    expect(config.host).toBe("2001:db8::1");

    const ssl = config.ssl as Exclude<typeof config.ssl, boolean | undefined>;
    const result = ssl.checkServerIdentity?.("[2001:db8::1]", {} as PeerCertificate);
    expect(result).toBeInstanceOf(Error);
    expect(result?.message).toContain("2001:db8::1");
    expect(result?.message).not.toContain("[2001:db8::1]");
  });

  it("rejects missing and empty CA files without leaking their paths", () => {
    const missing = join(mkdtempSync(join(tmpdir(), "lcm-postgresql-missing-")), "secret-ca.pem");
    directories.push(join(missing, ".."));
    for (const path of [missing, caFile("")]) {
      let thrown: unknown;
      try {
        buildPostgreSqlClientConfig(settings(path));
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toMatchObject({ code: "STORAGE_INITIALIZATION_FAILED", operation: "configure" });
      expect(String(thrown)).not.toContain(path);
    }
  });
});
