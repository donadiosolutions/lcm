import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CI_CACHE_FORMAT,
  MAX_CAPTURED_OUTPUT_BYTES,
  NODE_DEPENDENCY_INPUT_PATHS,
  NODE_VERSION,
  POSTGRES_TEMPLATE_INPUT_PATHS,
  assertSecureInventoryPlatform,
  cacheMetadata,
  compareInventoryNames,
  expectedRepoDigest,
  nodeModulesInventoryDigest,
  runProcess,
  sha256Files,
  validateArchiveChecksum,
  validateImageInspection,
  validateNodeModulesStamp,
  validateTemplateArchiveEntries,
  writeArchiveChecksum,
  writeNodeModulesStamp,
} from "../../scripts/ci-environment.mjs";
import {
  NODE_IMAGE,
  POSTGRES_IMAGE,
  POSTGRESQL_HARNESS_IMAGES,
} from "../../scripts/postgresql-images.mjs";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "lcm-ci-environment-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("CI environment cache metadata", () => {
  it("pins the unified composite action and keeps cache restores exact", () => {
    const action = readFileSync(new URL("../../.github/actions/setup-ci/action.yml", import.meta.url), "utf8");
    const workflow = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");

    expect(action).toContain("actions/cache/restore@cdf6c1fa76f9f475f3d7449005a359c84ca0f306");
    expect(action).toContain("actions/cache/save@cdf6c1fa76f9f475f3d7449005a359c84ca0f306");
    expect(action).not.toContain("restore-keys:");
    expect(action).toContain("path: node_modules");
    expect(workflow).toContain("name: Initialize CI environment");
    expect(workflow.match(/runs-on: blacksmith-4vcpu-ubuntu-2404/gu)).toHaveLength(3);
    expect(workflow.match(/uses: \.\/\.github\/actions\/setup-ci/gu)).toHaveLength(3);
    expect(workflow.match(/runs-on: ubuntu-latest/gu)).toHaveLength(3);
  });

  it("derives exact platform-specific keys without fallback prefixes", () => {
    const metadata = cacheMetadata({ RUNNER_OS: "Linux", RUNNER_ARCH: "X64" });

    expect(metadata.nodeModulesKey).toMatch(
      new RegExp(`^lcm-node-modules-${CI_CACHE_FORMAT}-linux-x64-node-${NODE_VERSION}-[0-9a-f]{64}$`, "u"),
    );
    expect(metadata.imagesKey).toMatch(
      new RegExp(`^lcm-postgresql-images-${CI_CACHE_FORMAT}-linux-x64-[0-9a-f]{64}$`, "u"),
    );
    expect(metadata.templateKey).toMatch(
      new RegExp(`^lcm-postgresql-template-${CI_CACHE_FORMAT}-linux-x64-[0-9a-f]{64}$`, "u"),
    );
    expect(metadata.dependencyDigest).toHaveLength(64);
    expect(NODE_DEPENDENCY_INPUT_PATHS.some((path) => path.endsWith("/.npmrc"))).toBe(true);
    expect(metadata.dependencyDigest).toBe(sha256Files(NODE_DEPENDENCY_INPUT_PATHS));
    expect(metadata.imageDigest).not.toBe(metadata.templateDigest);
    expect(POSTGRES_TEMPLATE_INPUT_PATHS.some((path) => path.endsWith(
      "/test/postgresql/cached-run-init.sh",
    ))).toBe(true);
    expect(metadata.templateDigest).toBe(sha256Files(POSTGRES_TEMPLATE_INPUT_PATHS));
  });

  it.runIf(process.platform === "linux")("writes and validates an installed dependency inventory stamp", () => {
    const root = temporaryDirectory();
    const nodeModules = join(root, "node_modules");
    const packageDirectory = join(nodeModules, "example");
    mkdirSync(packageDirectory, { recursive: true });
    writeFileSync(join(packageDirectory, "package.json"), '{"name":"example","version":"1.0.0"}\n');

    const before = nodeModulesInventoryDigest(nodeModules);
    const stamp = writeNodeModulesStamp(nodeModules, { RUNNER_OS: "Linux", RUNNER_ARCH: "X64" });

    expect(stamp.inventoryDigest).toBe(before);
    expect(JSON.parse(readFileSync(join(nodeModules, ".lcm-ci-cache.json"), "utf8"))).toEqual(stamp);
    expect(validateNodeModulesStamp(nodeModules, { RUNNER_OS: "Linux", RUNNER_ARCH: "X64" })).toEqual(stamp);

    writeFileSync(join(packageDirectory, "package.json"), '{"name":"example","version":"2.0.0"}\n');
    expect(() => validateNodeModulesStamp(nodeModules, {
      RUNNER_OS: "Linux",
      RUNNER_ARCH: "X64",
    })).toThrow("inventoryDigest");
  });

  it.runIf(process.platform === "linux")("does not follow dependency inventory symlinks", () => {
    const root = temporaryDirectory();
    const nodeModules = join(root, "node_modules");
    const outside = join(root, "outside");
    mkdirSync(nodeModules);
    mkdirSync(outside);
    writeFileSync(join(outside, "package.json"), '{"name":"outside","version":"1.0.0"}\n');
    symlinkSync("../outside/package.json", join(nodeModules, "package.json"));

    const before = nodeModulesInventoryDigest(nodeModules);
    writeFileSync(join(outside, "package.json"), '{"name":"outside","version":"2.0.0"}\n');

    expect(nodeModulesInventoryDigest(nodeModules)).toBe(before);
    symlinkSync(nodeModules, join(root, "linked-node-modules"), "dir");
    expect(() => nodeModulesInventoryDigest(join(root, "linked-node-modules"))).toThrow();
  });

  it("makes the secure dependency inventory Linux-only", () => {
    expect(() => assertSecureInventoryPlatform("linux")).not.toThrow();
    expect(() => assertSecureInventoryPlatform("darwin")).toThrow(
      "requires Linux /proc descriptor traversal",
    );
    expect(() => assertSecureInventoryPlatform("win32")).toThrow(
      "requires Linux /proc descriptor traversal",
    );
  });

  it("sorts dependency inventory names without locale-sensitive collation", () => {
    const names = ["z", "ä", "a", "A", "10", "2"];
    expect(names.sort(compareInventoryNames)).toEqual(["10", "2", "A", "a", "z", "ä"]);
  });

  it("captures bounded subprocess diagnostic tails", async () => {
    const tail = "ci-environment-tail";
    const command = `process.stdout.write('discarded-prefix' + 'x'.repeat(${MAX_CAPTURED_OUTPUT_BYTES + 256}) + '${tail}'); process.stderr.write('discarded-error' + 'y'.repeat(${MAX_CAPTURED_OUTPUT_BYTES + 256}) + '${tail}'); process.exit(7)`;
    const error = await runProcess(process.execPath, ["-e", command]).catch((reason: unknown) => reason) as {
      stdout: string;
      stderr: string;
      stdoutTruncated: boolean;
      stderrTruncated: boolean;
    };

    expect(Buffer.byteLength(error.stdout)).toBe(MAX_CAPTURED_OUTPUT_BYTES);
    expect(Buffer.byteLength(error.stderr)).toBe(MAX_CAPTURED_OUTPUT_BYTES);
    expect(error.stdout.endsWith(tail)).toBe(true);
    expect(error.stderr.endsWith(tail)).toBe(true);
    expect(error.stdoutTruncated).toBe(true);
    expect(error.stderrTruncated).toBe(true);
  });

  it("makes the template marker final and waits for the completed entrypoint", () => {
    const environmentInitializer = readFileSync(
      new URL("../../scripts/ci-environment.mjs", import.meta.url),
      "utf8",
    );
    const templateInitializer = readFileSync(
      new URL("../postgresql/template-init.sh", import.meta.url),
      "utf8",
    );
    const cachedInitializer = readFileSync(
      new URL("../postgresql/cached-run-init.sh", import.meta.url),
      "utf8",
    );

    expect(templateInitializer.lastIndexOf("\npsql ")).toBeGreaterThan(
      templateInitializer.lastIndexOf("pg_hba.conf"),
    );
    expect(templateInitializer).not.toContain("exec psql");
    expect(templateInitializer.lastIndexOf("lcm-postgresql-template-v1")).toBeGreaterThan(
      templateInitializer.lastIndexOf("pg_hba.conf"),
    );
    expect(environmentInitializer).toContain('test "$(< /proc/1/comm)" = postgres');
    expect(environmentInitializer).toContain("count(*) = 3 AND bool_and(NOT rolcanlogin)");
    expect(environmentInitializer).toContain("AND datistemplate");
    expect(environmentInitializer).toContain("AND NOT datallowconn");
    expect(environmentInitializer).toContain("pg_get_userbyid(datdba) = 'lcm_harness_admin'");
    expect(cachedInitializer).toContain("installed_extension_count <> 4 OR EXISTS");
    expect(cachedInitializer).toContain("WHERE installed.extname = expected.extname");
    expect(cachedInitializer).not.toContain("array_agg");
    expect(cachedInitializer).not.toContain("ORDER BY extension_name");
  });

  it("validates every pinned image against Docker repo digests", () => {
    expect(POSTGRESQL_HARNESS_IMAGES).toEqual([POSTGRES_IMAGE, NODE_IMAGE]);
    for (const image of POSTGRESQL_HARNESS_IMAGES) {
      const expected = expectedRepoDigest(image);
      expect(expected).toMatch(/^[^:]+@sha256:[0-9a-f]{64}$/u);
      expect(() => validateImageInspection(image, JSON.stringify([{
        RepoDigests: [expected],
      }]))).not.toThrow();
      expect(() => validateImageInspection(image, JSON.stringify([{
        RepoDigests: ["example@sha256:" + "0".repeat(64)],
      }]))).toThrow("pinned digest");
    }
  });

  it("rejects unpinned images and malformed Docker inspection output", () => {
    expect(() => expectedRepoDigest("postgres:18.4-bookworm")).toThrow("not digest pinned");
    expect(() => validateImageInspection(POSTGRES_IMAGE, "[]")).toThrow("pinned digest");
  });

  it("accepts only complete path-safe PostgreSQL template archives", () => {
    const valid = [
      "./",
      "./18/",
      "./18/docker/",
      "./18/docker/PG_VERSION",
      "./18/docker/global/pg_control",
    ].join("\n");
    expect(() => validateTemplateArchiveEntries(valid)).not.toThrow();
    expect(() => validateTemplateArchiveEntries("")).toThrow("empty");
    expect(() => validateTemplateArchiveEntries("../PG_VERSION\nglobal/pg_control")).toThrow("unsafe");
    expect(() => validateTemplateArchiveEntries("/PG_VERSION\nglobal/pg_control")).toThrow("unsafe");
    expect(() => validateTemplateArchiveEntries("global/pg_control")).toThrow("PG_VERSION");
    expect(() => validateTemplateArchiveEntries("PG_VERSION")).toThrow("pg_control");
  });

  it("checksums cached archives and rejects modified contents", async () => {
    const root = temporaryDirectory();
    const archive = join(root, "cache.tar");
    writeFileSync(archive, "verified cache contents");

    const digest = await writeArchiveChecksum(archive);
    expect(digest).toMatch(/^[0-9a-f]{64}$/u);
    await expect(validateArchiveChecksum(archive)).resolves.toBe(digest);

    writeFileSync(archive, "modified cache contents");
    await expect(validateArchiveChecksum(archive)).rejects.toThrow("does not match");
    writeFileSync(`${archive}.sha256`, "not-a-checksum\n");
    await expect(validateArchiveChecksum(archive)).rejects.toThrow("checksum is invalid");
  });
});
