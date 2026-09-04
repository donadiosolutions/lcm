import {
  cpSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CI_CACHE_FORMAT,
  NODE_DEPENDENCY_CACHE_FORMAT,
  MAX_ARCHIVE_CHECKSUM_BYTES,
  MAX_CAPTURED_OUTPUT_BYTES,
  MAX_NODE_MODULES_STAMP_BYTES,
  NODE_DEPENDENCY_INPUT_PATHS,
  NODE_VERSION,
  POSTGRES_TEMPLATE_INPUT_PATHS,
  POSTGRES_TEMPLATE_MARKER,
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
  validatePostgreSqlTemplateArchive,
  validateTarInventoryCapabilities,
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

const repositoryManifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
const managerPin = repositoryManifest.packageManager;

function pnpmFixture(): string {
  const nodeModules = join(temporaryDirectory(), "node_modules");
  mkdirSync(join(nodeModules, ".pnpm"), { recursive: true });
  writeFileSync(join(nodeModules, ".modules.yaml"), JSON.stringify({
    packageManager: managerPin.split("+")[0],
    nodeLinker: "isolated",
    virtualStoreDir: ".pnpm",
    storeDir: "/a/previous/runner/store",
  }));
  writeFileSync(join(nodeModules, ".pnpm", "lock.yaml"), readFileSync(new URL("../../pnpm-lock.yaml", import.meta.url)));
  for (const name of [...Object.keys(repositoryManifest.dependencies), ...Object.keys(repositoryManifest.devDependencies), "example"]) {
    const packagePath = join(".pnpm", name.replaceAll("/", "+") + "@1.0.0", "node_modules", name);
    mkdirSync(join(nodeModules, packagePath), { recursive: true });
    writeFileSync(join(nodeModules, packagePath, "package.json"), JSON.stringify({ name, version: "1.0.0" }));
    const scope = name.startsWith("@") ? name.split("/")[0] : "";
    mkdirSync(join(nodeModules, scope), { recursive: true });
    symlinkSync((scope ? "../" : "") + packagePath, join(nodeModules, name));
  }
  return nodeModules;
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
    expect(action.match(/node-version:\s*"([^"]+)"/u)?.[1]).toBe(NODE_VERSION);
    expect(workflow).toContain("name: Initialize CI environment");
    expect(workflow.match(/runs-on: blacksmith-4vcpu-ubuntu-2404/gu)).toHaveLength(3);
    expect(workflow.match(/uses: \.\/\.github\/actions\/setup-ci/gu)).toHaveLength(3);
    expect(workflow.match(/runs-on: ubuntu-latest/gu)).toHaveLength(3);
  });

  it("derives exact platform-specific keys without fallback prefixes", () => {
    const metadata = cacheMetadata({ RUNNER_OS: "Linux", RUNNER_ARCH: "X64" });

    expect(metadata.nodeModulesKey).toMatch(
      new RegExp(`^lcm-node-modules-${NODE_DEPENDENCY_CACHE_FORMAT}-linux-x64-node-${NODE_VERSION}-[0-9a-f]{64}$`, "u"),
    );
    expect(metadata.imagesKey).toMatch(
      new RegExp(`^lcm-postgresql-images-${CI_CACHE_FORMAT}-linux-x64-[0-9a-f]{64}$`, "u"),
    );
    expect(metadata.templateKey).toMatch(
      new RegExp(`^lcm-postgresql-template-${CI_CACHE_FORMAT}-linux-x64-[0-9a-f]{64}$`, "u"),
    );
    expect(metadata.dependencyDigest).toHaveLength(64);
    expect(NODE_DEPENDENCY_INPUT_PATHS.map((path) => path.split("/").at(-1))).toEqual([
      "package.json", "pnpm-lock.yaml", ".npmrc", "pnpm-workspace.yaml", "bootstrap-pnpm.mjs",
    ]);
    expect(NODE_DEPENDENCY_CACHE_FORMAT).toBe("v2");
    expect(CI_CACHE_FORMAT).toBe("v1");
    expect(metadata.dependencyDigest).toBe(sha256Files(NODE_DEPENDENCY_INPUT_PATHS));
    expect(metadata.imageDigest).not.toBe(metadata.templateDigest);
    expect(POSTGRES_TEMPLATE_INPUT_PATHS.some((path) => path.endsWith(
      "/test/postgresql/cached-run-init.sh",
    ))).toBe(true);
    expect(metadata.templateDigest).toBe(sha256Files(POSTGRES_TEMPLATE_INPUT_PATHS));
  });

  it("derives keys before installation and invalidates every dependency input", async () => {
    const root = temporaryDirectory();
    const sourceRoot = new URL("../../", import.meta.url).pathname;
    for (const source of new Set([...NODE_DEPENDENCY_INPUT_PATHS, ...POSTGRES_TEMPLATE_INPUT_PATHS])) {
      const target = join(root, relative(sourceRoot, source));
      mkdirSync(dirname(target), { recursive: true });
      cpSync(source, target);
    }
    const script = join(root, "scripts/ci-environment.mjs");
    const before = (await runProcess(process.execPath, [script, "cache-metadata"])).stdout;
    for (const source of NODE_DEPENDENCY_INPUT_PATHS) {
      const target = join(root, relative(sourceRoot, source));
      const original = readFileSync(target);
      writeFileSync(target, Buffer.concat([original, Buffer.from("\n")]));
      const changed = (await runProcess(process.execPath, [script, "cache-metadata"])).stdout;
      expect(changed.split("\n")[0]).not.toBe(before.split("\n")[0]);
      expect(changed.split("\n").slice(1)).toEqual(before.split("\n").slice(1));
      writeFileSync(target, original);
    }
  });

  it.runIf(process.platform === "linux")("writes and validates an installed dependency inventory stamp", () => {
    const nodeModules = pnpmFixture();
    const packageDirectory = join(nodeModules, "example");

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

  it.runIf(process.platform === "linux")("rejects escaping and dangling links without following them", () => {
    for (const target of ["../outside", "/outside", ".pnpm/missing"]) {
      const nodeModules = pnpmFixture();
      symlinkSync(target, join(nodeModules, "bad-link"));
      expect(() => nodeModulesInventoryDigest(nodeModules)).toThrow(/link/u);
    }
    const nodeModules = pnpmFixture();
    symlinkSync(nodeModules, join(temporaryDirectory(), "linked-node-modules"));
    expect(() => nodeModulesInventoryDigest(join(temporaryDirectories.at(-1)!, "linked-node-modules"))).toThrow();
  });

  it.runIf(process.platform === "linux")("validates contained link chains and rejects cycles and non-directory traversal", () => {
    const nodeModules = pnpmFixture();
    mkdirSync(join(nodeModules, ".links"));
    symlinkSync("../example", join(nodeModules, ".links/alias"));
    expect(() => nodeModulesInventoryDigest(nodeModules)).not.toThrow();
    symlinkSync("cycle", join(nodeModules, ".links/cycle"));
    expect(() => nodeModulesInventoryDigest(nodeModules)).toThrow("cycle");
    rmSync(join(nodeModules, ".links/cycle"));
    symlinkSync("../example/package.json/../package.json", join(nodeModules, ".links/broken"));
    expect(() => nodeModulesInventoryDigest(nodeModules)).toThrow(/non-directory/u);
  });

  it.runIf(process.platform === "linux")("restores isolated dependencies in a different directory without the original store", () => {
    const nodeModules = pnpmFixture();
    const stamp = writeNodeModulesStamp(nodeModules);
    const restored = join(temporaryDirectory(), "node_modules");
    cpSync(nodeModules, restored, { recursive: true, verbatimSymlinks: true });
    rmSync(nodeModules, { recursive: true });
    expect(validateNodeModulesStamp(restored)).toEqual(stamp);
  });

  it.runIf(process.platform === "linux")("requires pnpm metadata, the installed lock and every package manifest", () => {
    for (const missing of [".modules.yaml", ".pnpm/lock.yaml", "example/package.json", Object.keys(repositoryManifest.dependencies)[0]]) {
      const nodeModules = pnpmFixture();
      rmSync(join(nodeModules, missing), { recursive: true, force: true });
      expect(() => writeNodeModulesStamp(nodeModules)).toThrow();
    }
  });

  it.runIf(process.platform === "linux")("rejects incompatible pnpm metadata and changed installed lock before stamping", () => {
    for (const change of [{ packageManager: "pnpm@0.0.0" }, { nodeLinker: "hoisted" }, { virtualStoreDir: "../outside" }]) {
      const nodeModules = pnpmFixture();
      const path = join(nodeModules, ".modules.yaml");
      writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), ...change }));
      expect(() => writeNodeModulesStamp(nodeModules)).toThrow(/pnpm/u);
    }
    const nodeModules = pnpmFixture();
    writeFileSync(join(nodeModules, ".pnpm/lock.yaml"), "lockfileVersion: invalid");
    expect(() => writeNodeModulesStamp(nodeModules)).toThrow(/lock/u);
  });

  it.runIf(process.platform === "linux")("detects pnpm metadata and stamp tampering on restore", () => {
    const nodeModules = pnpmFixture();
    writeNodeModulesStamp(nodeModules);
    const path = join(nodeModules, ".modules.yaml");
    writeFileSync(path, readFileSync(path, "utf8") + " ");
    expect(() => validateNodeModulesStamp(nodeModules)).toThrow("inventoryDigest");
    writeNodeModulesStamp(nodeModules);
    const stampPath = join(nodeModules, ".lcm-ci-cache.json");
    const stamp = JSON.parse(readFileSync(stampPath, "utf8"));
    writeFileSync(stampPath, JSON.stringify({ ...stamp, dependencyDigest: "tampered" }));
    expect(() => validateNodeModulesStamp(nodeModules)).toThrow("dependencyDigest");
  });

  it.runIf(process.platform === "linux")("rejects unsafe node_modules stamp metadata", () => {
    const root = temporaryDirectory();
    const nodeModules = join(root, "node_modules");
    mkdirSync(nodeModules);
    const stamp = join(nodeModules, ".lcm-ci-cache.json");
    const outside = join(root, "outside-stamp.json");
    writeFileSync(outside, "{}\n");
    symlinkSync(outside, stamp);
    expect(() => validateNodeModulesStamp(nodeModules)).toThrow(
      "cached node_modules stamp could not be opened securely",
    );

    rmSync(stamp);
    mkdirSync(stamp);
    expect(() => validateNodeModulesStamp(nodeModules)).toThrow(
      "cached node_modules stamp is not a regular file",
    );

    rmSync(stamp, { recursive: true });
    writeFileSync(stamp, "x".repeat(MAX_NODE_MODULES_STAMP_BYTES + 1));
    expect(() => validateNodeModulesStamp(nodeModules)).toThrow(
      `cached node_modules stamp exceeds the ${MAX_NODE_MODULES_STAMP_BYTES}-byte limit`,
    );

    writeFileSync(stamp, "{not-json}\n");
    expect(() => validateNodeModulesStamp(nodeModules)).toThrow(
      "cached node_modules stamp is invalid JSON",
    );
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
    const harness = readFileSync(
      new URL("../../scripts/postgresql-harness.mjs", import.meta.url),
      "utf8",
    );

    expect(templateInitializer.lastIndexOf("\npsql ")).toBeGreaterThan(
      templateInitializer.lastIndexOf("pg_hba.conf"),
    );
    expect(templateInitializer).not.toContain("exec psql");
    expect(templateInitializer.lastIndexOf("LCM_POSTGRES_TEMPLATE_MARKER")).toBeGreaterThan(
      templateInitializer.lastIndexOf("pg_hba.conf"),
    );
    expect(templateInitializer).not.toContain(POSTGRES_TEMPLATE_MARKER);
    expect(cachedInitializer).not.toContain(POSTGRES_TEMPLATE_MARKER);
    expect(templateInitializer).toContain("VALUES (:'template_marker')");
    expect(cachedInitializer).toContain("current_setting('lcm.template_marker')");
    expect(environmentInitializer).toContain(
      `\`LCM_POSTGRES_TEMPLATE_MARKER=\${POSTGRES_TEMPLATE_MARKER}\``,
    );
    expect(harness).toContain(
      `\`LCM_POSTGRES_TEMPLATE_MARKER=\${POSTGRES_TEMPLATE_MARKER}\``,
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
    const validMetadata = [
      "drwx------ 0/0 0 2026-01-01 00:00 ./",
      "drwx------ 0/0 0 2026-01-01 00:00 ./18/",
      "drwx------ 0/0 0 2026-01-01 00:00 ./18/docker/",
      "-rw------- 0/0 3 2026-01-01 00:00 ./18/docker/PG_VERSION",
      "-rw------- 0/0 8 2026-01-01 00:00 ./18/docker/global/pg_control",
    ].join("\n");
    expect(() => validateTemplateArchiveEntries(valid, validMetadata)).not.toThrow();
    expect(() => validateTemplateArchiveEntries("", "")).toThrow("empty");
    expect(() => validateTemplateArchiveEntries(valid, validMetadata.replace(
      "-rw------- 0/0 3",
      "lrwxrwxrwx 0/0 0",
    ))).toThrow("unsafe entry type");
    expect(() => validateTemplateArchiveEntries(valid, validMetadata.replace(
      "-rw------- 0/0 3",
      "hrw------- 0/0 0",
    ))).toThrow("unsafe entry type");
    expect(() => validateTemplateArchiveEntries(valid, validMetadata.split("\n").slice(1).join("\n")))
      .toThrow("metadata is inconsistent");
    expect(() => validateTemplateArchiveEntries(
      "../PG_VERSION\nglobal/pg_control",
      "-rw------- first\n-rw------- second",
    )).toThrow("unsafe");
    expect(() => validateTemplateArchiveEntries(
      "/PG_VERSION\nglobal/pg_control",
      "-rw------- first\n-rw------- second",
    )).toThrow("unsafe");
    expect(() => validateTemplateArchiveEntries("global/pg_control", "-rw------- control"))
      .toThrow("PG_VERSION");
    expect(() => validateTemplateArchiveEntries("PG_VERSION", "-rw------- version"))
      .toThrow("pg_control");
  });

  it("fails closed when GNU tar safe quoting support is unavailable", () => {
    expect(() => validateTarInventoryCapabilities([
      "GNU tar help",
      "  --quoting-style=STYLE",
      "Valid arguments include: escape",
    ].join("\n"))).not.toThrow();
    expect(() => validateTarInventoryCapabilities("bsdtar help")).toThrow(
      "requires GNU tar with --quoting-style=escape",
    );
    expect(() => validateTarInventoryCapabilities(
      "GNU tar --quoting-style=STYLE escape",
      true,
    )).toThrow("install GNU tar and ensure it is first on PATH");
  });

  it.runIf(process.platform === "linux")("rejects link-bearing PostgreSQL template archives before extraction", async () => {
    const root = temporaryDirectory();
    const contents = join(root, "contents");
    mkdirSync(join(contents, "global"), { recursive: true });
    writeFileSync(join(contents, "PG_VERSION"), "18\n");
    writeFileSync(join(contents, "global", "pg_control"), "control\n");

    for (const linkType of ["symbolic", "hard"] as const) {
      const unsafeEntry = join(contents, `unsafe-${linkType}`);
      if (linkType === "symbolic") symlinkSync("../outside", unsafeEntry);
      else linkSync(join(contents, "PG_VERSION"), unsafeEntry);
      const archive = join(root, `${linkType}.tar`);
      await runProcess("tar", [
        "--create", "--file", archive,
        "--directory", contents,
        ".",
      ]);
      await writeArchiveChecksum(archive);
      await expect(validatePostgreSqlTemplateArchive(archive)).rejects.toThrow(
        "unsafe entry type",
      );
      rmSync(unsafeEntry);
    }
  });

  it.runIf(process.platform === "linux")("checksums cached archives and rejects modified contents", async () => {
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

  it.runIf(process.platform === "linux")("rejects unsafe archive checksum metadata", async () => {
    const root = temporaryDirectory();
    const archive = join(root, "cache.tar");
    const sidecar = `${archive}.sha256`;
    const outside = join(root, "outside.sha256");
    writeFileSync(archive, "verified cache contents");
    writeFileSync(outside, `${"0".repeat(64)}\n`);
    symlinkSync(outside, sidecar);
    await expect(validateArchiveChecksum(archive)).rejects.toThrow(
      "cached archive checksum sidecar could not be opened securely",
    );

    rmSync(sidecar);
    mkdirSync(sidecar);
    await expect(validateArchiveChecksum(archive)).rejects.toThrow(
      "cached archive checksum sidecar is not a regular file",
    );

    rmSync(sidecar, { recursive: true });
    writeFileSync(sidecar, "0".repeat(MAX_ARCHIVE_CHECKSUM_BYTES + 1));
    await expect(validateArchiveChecksum(archive)).rejects.toThrow(
      `cached archive checksum sidecar exceeds the ${MAX_ARCHIVE_CHECKSUM_BYTES}-byte limit`,
    );

    writeFileSync(sidecar, "not-a-checksum\n");
    await expect(validateArchiveChecksum(archive)).rejects.toThrow(
      "cached archive checksum is invalid",
    );
  });
});
