import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveMigrationTargetConfig } from "../../src/migration/target-config.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "lcm-target-config-"));
  tempDirs.push(dir);
  return dir;
}

function caFile(contents = "trusted-ca"): string {
  const directory = scratchDir();
  const path = join(directory, "ca.crt");
  writeFileSync(path, contents);
  return path;
}

function configPathWithContent(content: string): string {
  const directory = scratchDir();
  const path = join(directory, "config.json");
  writeFileSync(path, content);
  return path;
}

describe("resolveMigrationTargetConfig: the load-bearing property this module exists for", () => {
  it("resolves storage.postgresql for real while storage.backend is genuinely \"sqlite\" -- the exact case resolveStorageConfig itself must keep refusing for every other caller", async () => {
    const ca = caFile();
    const configPath = configPathWithContent(JSON.stringify({
      storage: {
        backend: "sqlite",
        postgresql: { url: "postgresql://user:password@db.example.com:25060/lcm", caFile: ca, migrationRole: "lcm_migrator" },
      },
    }));
    const result = resolveMigrationTargetConfig(configPath, {});
    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") throw new Error("unreachable");
    expect(result.config.backend).toBe("postgresql");
    expect(result.config.postgresql.migrationRole).toBe("lcm_migrator");
    expect(result.config.postgresql.url).toBe("postgresql://user:password@db.example.com:25060/lcm");
  });

  it("resolves via the LCM_POSTGRES_* environment fallbacks with no storage.postgresql section configured at all, backend still sqlite", async () => {
    const ca = caFile("env-ca");
    const configPath = configPathWithContent(JSON.stringify({ storage: { backend: "sqlite" } }));
    const result = resolveMigrationTargetConfig(configPath, {
      LCM_POSTGRES_URL: "postgresql://envuser:envpass@env.example.com:5432/lcm",
      LCM_POSTGRES_CA_FILE: ca,
      LCM_POSTGRES_MIGRATION_ROLE: "lcm_env_migrator",
    });
    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") throw new Error("unreachable");
    expect(result.config.postgresql.migrationRole).toBe("lcm_env_migrator");
  });

  it("also resolves when storage.backend is entirely absent from config.json (defaults to sqlite in the raw parse, same as resolveStorageConfig's own default)", async () => {
    const ca = caFile();
    const configPath = configPathWithContent(JSON.stringify({
      storage: { postgresql: { url: "postgresql://user:password@db.example.com:5432/lcm", caFile: ca, migrationRole: "role" } },
    }));
    const result = resolveMigrationTargetConfig(configPath, {});
    expect(result.status).toBe("resolved");
  });
});

describe("resolveMigrationTargetConfig: refusal paths", () => {
  it("refuses migration-target-missing when neither storage.postgresql nor any LCM_POSTGRES_* env var configures a URL", async () => {
    const configPath = configPathWithContent(JSON.stringify({ storage: { backend: "sqlite" } }));
    const result = resolveMigrationTargetConfig(configPath, {});
    expect(result).toEqual({ status: "refuse", reason: "migration-target-missing", evidence: "config-validation-error" });
  });

  it("refuses migration-target-missing for a malformed postgresql: URL (a real ConfigValidationError from the reused validator, never a message string leaked into evidence)", async () => {
    const ca = caFile();
    const configPath = configPathWithContent(JSON.stringify({
      storage: { postgresql: { url: "not-a-postgresql-url", caFile: ca, migrationRole: "role" } },
    }));
    const result = resolveMigrationTargetConfig(configPath, {});
    expect(result).toEqual({ status: "refuse", reason: "migration-target-missing", evidence: "config-validation-error" });
  });

  it("refuses migration-target-missing for an unresolvable CA file path (the same validator's TLS preflight, real filesystem, no CA file at the given path)", async () => {
    const configPath = configPathWithContent(JSON.stringify({
      storage: { postgresql: { url: "postgresql://user:password@db.example.com:5432/lcm", caFile: "/definitely/not/a/real/ca/path.crt", migrationRole: "role" } },
    }));
    const result = resolveMigrationTargetConfig(configPath, {});
    expect(result).toEqual({ status: "refuse", reason: "migration-target-missing", evidence: "config-validation-error" });
  });

  it("refuses migration-target-missing for an invalid migrationRole (empty string)", async () => {
    const ca = caFile();
    const configPath = configPathWithContent(JSON.stringify({
      storage: { postgresql: { url: "postgresql://user:password@db.example.com:5432/lcm", caFile: ca, migrationRole: "" } },
    }));
    const result = resolveMigrationTargetConfig(configPath, {});
    expect(result).toEqual({ status: "refuse", reason: "migration-target-missing", evidence: "config-validation-error" });
  });

  it("refuses migration-target-unresolvable for real malformed JSON in the config file", async () => {
    const configPath = configPathWithContent("{ this is not valid json");
    const result = resolveMigrationTargetConfig(configPath, {});
    expect(result).toEqual({ status: "refuse", reason: "migration-target-unresolvable", evidence: "config-malformed-json" });
  });

  it("treats a config file whose parsed content is not an object (e.g. a JSON array) as an empty storage section rather than throwing", async () => {
    const configPath = configPathWithContent("[1, 2, 3]");
    const result = resolveMigrationTargetConfig(configPath, {});
    expect(result).toEqual({ status: "refuse", reason: "migration-target-missing", evidence: "config-validation-error" });
  });

  it("resolves to an empty-storage default (missing target) for a genuinely absent config file, exactly like ordinary config loading's own missing-file default", async () => {
    const configPath = join(scratchDir(), "does-not-exist.json");
    const result = resolveMigrationTargetConfig(configPath, {});
    expect(result).toEqual({ status: "refuse", reason: "migration-target-missing", evidence: "config-validation-error" });
  });

  it("refuses migration-target-unresolvable when the raw snapshot read itself throws for an unexpected reason (injected at the reader boundary)", async () => {
    const configPath = configPathWithContent("{}");
    const result = resolveMigrationTargetConfig(configPath, {}, {
      readRawSnapshot: () => { throw new Error("simulated unexpected read failure"); },
    });
    expect(result).toEqual({ status: "refuse", reason: "migration-target-unresolvable", evidence: "Error" });
  });

  it("refuses migration-target-unresolvable when the raw snapshot read throws a non-Error value", async () => {
    const configPath = configPathWithContent("{}");
    const result = resolveMigrationTargetConfig(configPath, {}, {
      readRawSnapshot: () => { throw "not-an-error-object"; },
    });
    expect(result).toEqual({ status: "refuse", reason: "migration-target-unresolvable", evidence: "unknown-config-read-failure" });
  });

  it("refuses migration-target-unresolvable when the reused validator throws something other than ConfigValidationError (injected at that exact boundary, since neither real validator ever does -- proving the fallback path itself rather than assuming it is unreachable)", async () => {
    const configPath = configPathWithContent("{}");
    const result = resolveMigrationTargetConfig(configPath, {}, {
      validateStorageSection: () => { throw new TypeError("simulated unexpected validator failure"); },
    });
    expect(result).toEqual({ status: "refuse", reason: "migration-target-unresolvable", evidence: "TypeError" });
  });

  it("rejects a null storage value before reaching the postgresql branch (real validateStorageSection, real shape rejection)", async () => {
    const configPath = configPathWithContent(JSON.stringify({ storage: null }));
    const result = resolveMigrationTargetConfig(configPath, {});
    expect(result.status).toBe("refuse");
    expect((result as { reason: string }).reason).toBe("migration-target-missing");
  });

  it("refuses migration-target-unresolvable with unknown-validation-failure evidence when the reused validator throws a non-Error value", async () => {
    const configPath = configPathWithContent("{}");
    const result = resolveMigrationTargetConfig(configPath, {}, {
      validateStorageSection: () => { throw "not-an-error-object"; },
    });
    expect(result).toEqual({ status: "refuse", reason: "migration-target-unresolvable", evidence: "unknown-validation-failure" });
  });
});
