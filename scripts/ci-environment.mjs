#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  createReadStream,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { POSTGRES_IMAGE, POSTGRESQL_HARNESS_IMAGES } from "./postgresql-images.mjs";

export const CI_CACHE_FORMAT = "v1";
export const NODE_DEPENDENCY_CACHE_FORMAT = "v2";
export const NODE_VERSION = "22.20.0";
export const POSTGRES_TEMPLATE_DATABASE = "lcm_harness_template";
export const POSTGRES_TEMPLATE_MARKER = "lcm-postgresql-template-v1";
export const MAX_CAPTURED_OUTPUT_BYTES = 64 * 1024;
export const MAX_ARCHIVE_INVENTORY_BYTES = 4 * 1024 * 1024;
export const MAX_NODE_MODULES_STAMP_BYTES = 4 * 1024;
export const MAX_ARCHIVE_CHECKSUM_BYTES = 128;

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const templateInitScript = join(repositoryRoot, "test", "postgresql", "template-init.sh");
const cachedRunInitScript = join(repositoryRoot, "test", "postgresql", "cached-run-init.sh");
const imageManifestPath = join(repositoryRoot, "scripts", "postgresql-images.mjs");
export const POSTGRES_TEMPLATE_INPUT_PATHS = Object.freeze([
  join(repositoryRoot, "scripts", "ci-environment.mjs"),
  imageManifestPath,
  templateInitScript,
  cachedRunInitScript,
]);
export const NODE_DEPENDENCY_INPUT_PATHS = Object.freeze([
  join(repositoryRoot, "package.json"),
  join(repositoryRoot, "pnpm-lock.yaml"),
  join(repositoryRoot, ".npmrc"),
  join(repositoryRoot, "pnpm-workspace.yaml"),
  join(repositoryRoot, "scripts", "bootstrap-pnpm.mjs"),
]);

export function sha256Files(paths) {
  const hash = createHash("sha256");
  for (const path of [...paths].sort()) {
    const relativePath = relative(repositoryRoot, path).split(sep).join("/");
    hash.update(`${relativePath}\0`, "utf8");
    hash.update(readFileSync(path));
    hash.update("\0", "utf8");
  }
  return hash.digest("hex");
}

function normalizedRunnerValue(value, fallback) {
  const normalized = String(value ?? fallback).trim().toLowerCase().replace(/[^a-z0-9_.-]+/gu, "-");
  if (!normalized) throw new Error("CI cache runner identity must not be empty");
  return normalized;
}

export function assertSecureInventoryPlatform(platform = process.platform) {
  if (platform !== "linux") {
    throw new Error("secure dependency inventory requires Linux /proc descriptor traversal");
  }
}

export function compareInventoryNames(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function cacheMetadata(environment = process.env) {
  const runnerOs = normalizedRunnerValue(environment.RUNNER_OS, process.platform);
  const runnerArch = normalizedRunnerValue(environment.RUNNER_ARCH, process.arch);
  const dependencyDigest = sha256Files(NODE_DEPENDENCY_INPUT_PATHS);
  const imageDigest = sha256Files([imageManifestPath]);
  const templateDigest = sha256Files(POSTGRES_TEMPLATE_INPUT_PATHS);
  return {
    dependencyDigest,
    imageDigest,
    templateDigest,
    nodeModulesKey: `lcm-node-modules-${NODE_DEPENDENCY_CACHE_FORMAT}-${runnerOs}-${runnerArch}-node-${NODE_VERSION}-${dependencyDigest}`,
    imagesKey: `lcm-postgresql-images-${CI_CACHE_FORMAT}-${runnerOs}-${runnerArch}-${imageDigest}`,
    templateKey: `lcm-postgresql-template-${CI_CACHE_FORMAT}-${runnerOs}-${runnerArch}-${templateDigest}`,
  };
}

// Metadata is read only through held directory descriptors. Link validation below
// operates on this inventory and never follows links through the filesystem.
function walkPackageMetadata(directoryDescriptor, relativeDirectory = "", entries = new Map()) {
  const directory = `/proc/self/fd/${directoryDescriptor}`;
  for (const directoryEntry of readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => compareInventoryNames(left.name, right.name))) {
    const { name } = directoryEntry;
    if (relativeDirectory === "" && name === ".lcm-ci-cache.json") continue;
    const path = join(directory, name);
    const relativePath = join(relativeDirectory, name).split(sep).join("/");
    if (directoryEntry.isSymbolicLink()) {
      entries.set(relativePath, { type: "link", target: readlinkSync(path) });
      continue;
    }

    let descriptor;
    try {
      descriptor = openSync(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      const stat = fstatSync(descriptor);
      if (stat.isDirectory()) {
        entries.set(relativePath, { type: "directory" });
        walkPackageMetadata(descriptor, relativePath, entries);
      } else {
        if (!stat.isFile()) {
          throw new Error(`dependency inventory entry is not a regular file: ${relativePath}`);
        }
        const metadata = name === "package.json"
          || relativePath === ".modules.yaml"
          || relativePath === ".pnpm/lock.yaml"
          || relativePath === ".pnpm-workspace-state-v1.json";
        const contents = metadata ? readFileSync(descriptor) : undefined;
        entries.set(relativePath, { type: "file", contents });
      }
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }
  return entries;
}

function inventoryTarget(entries, path) {
  const pending = path.split("/");
  const resolved = [];
  let links = 0;
  while (pending.length > 0) {
    const part = pending.shift();
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (resolved.length === 0) throw new Error(`dependency link escapes node_modules: ${path}`);
      resolved.pop();
      continue;
    }
    const prefix = [...resolved, part].join("/");
    const entry = entries.get(prefix);
    if (!entry) throw new Error(`dependency link or required path is missing: ${prefix}`);
    if (entry.type === "link") {
      links += 1;
      if (links > 64) throw new Error(`dependency link cycle or excessive depth: ${prefix}`);
      if (isAbsolute(entry.target)) throw new Error(`dependency link escapes node_modules: ${prefix}`);
      pending.unshift(...entry.target.split("/"));
      continue;
    }
    if (pending.length > 0 && entry.type !== "directory") {
      throw new Error(`dependency link traverses a non-directory: ${prefix}`);
    }
    resolved.push(part);
  }
  return resolved.length === 0 ? { type: "directory" } : entries.get(resolved.join("/"));
}

function requireInventoryMetadata(entries, path) {
  const entry = entries.get(path);
  if (entry?.type !== "file" || !entry.contents) {
    throw new Error(`required pnpm metadata is missing or unsafe: ${path}`);
  }
  return entry.contents;
}

function validatePnpmInventory(entries) {
  const manifest = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8"));
  // This exact pnpm pin writes .modules.yaml using JSON.stringify. Do not import
  // a YAML package: this check must run before dependencies are trusted.
  const modules = JSON.parse(requireInventoryMetadata(entries, ".modules.yaml"));
  if (modules.packageManager !== manifest.packageManager.split("+")[0]
    || modules.nodeLinker !== "isolated" || modules.virtualStoreDir !== ".pnpm") {
    throw new Error("cached pnpm installation has incompatible manager or linker metadata");
  }
  const installedLock = requireInventoryMetadata(entries, ".pnpm/lock.yaml");
  if (!installedLock.equals(readFileSync(join(repositoryRoot, "pnpm-lock.yaml")))) {
    throw new Error("cached pnpm installed lock does not match pnpm-lock.yaml");
  }
  for (const [path, entry] of entries) {
    if (entry.type === "link") inventoryTarget(entries, path);
    // Each package at either a root or virtual node_modules boundary must retain
    // its own manifest, including transitives that are not root dependencies.
    if ((entry.type === "directory" || entry.type === "link")
      && /(?:^|\/node_modules\/)(?:@[^/]+\/)?[^.@/][^/]*$/u.test(path)) {
      const packageManifest = inventoryTarget(entries, `${path}/package.json`);
      if (packageManifest?.type !== "file" || !packageManifest.contents) {
        throw new Error(`required pnpm package manifest is missing: ${path}`);
      }
    }
  }
  for (const name of Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })) {
    const packageManifest = inventoryTarget(entries, `${name}/package.json`);
    if (packageManifest?.type !== "file" || !packageManifest.contents) {
      throw new Error(`required pnpm dependency metadata is missing: ${name}`);
    }
  }
}

export function nodeModulesInventoryDigest(nodeModulesPath) {
  assertSecureInventoryPlatform();
  let descriptor;
  try {
    descriptor = openSync(
      nodeModulesPath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY | constants.O_NONBLOCK,
    );
    if (!fstatSync(descriptor).isDirectory()) {
      throw new Error("dependency inventory root is not a directory");
    }
    const entries = walkPackageMetadata(descriptor);
    validatePnpmInventory(entries);
    const hash = createHash("sha256");
    for (const [path, entry] of entries) {
      if (entry.type === "link") hash.update(`link\0${path}\0${entry.target}\0`);
      else if (entry.contents) {
        hash.update(`file\0${path}\0`).update(entry.contents).update("\0");
      }
    }
    return hash.digest("hex");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function nodeModulesStampPath(nodeModulesPath) {
  return join(nodeModulesPath, ".lcm-ci-cache.json");
}

function readSecureMetadataFile(path, maximumBytes, label) {
  assertSecureInventoryPlatform();
  let descriptor;
  try {
    try {
      descriptor = openSync(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch (error) {
      throw new Error(`${label} could not be opened securely`, { cause: error });
    }
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) throw new Error(`${label} is not a regular file`);
    if (stat.size > maximumBytes) {
      throw new Error(`${label} exceeds the ${maximumBytes}-byte limit`);
    }
    const contents = Buffer.alloc(maximumBytes + 1);
    let offset = 0;
    while (offset < contents.length) {
      const bytesRead = readSync(
        descriptor,
        contents,
        offset,
        contents.length - offset,
        null,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > maximumBytes) {
      throw new Error(`${label} exceeds the ${maximumBytes}-byte limit`);
    }
    return contents.subarray(0, offset).toString("utf8");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function writeNodeModulesStamp(nodeModulesPath, environment = process.env) {
  const metadata = cacheMetadata(environment);
  const stamp = {
    format: NODE_DEPENDENCY_CACHE_FORMAT,
    dependencyDigest: metadata.dependencyDigest,
    packageManager: JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8")).packageManager,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    inventoryDigest: nodeModulesInventoryDigest(nodeModulesPath),
  };
  writeFileSync(nodeModulesStampPath(nodeModulesPath), `${JSON.stringify(stamp, null, 2)}\n`, { mode: 0o600 });
  return stamp;
}

export function validateNodeModulesStamp(nodeModulesPath, environment = process.env) {
  const expected = cacheMetadata(environment);
  let stamp;
  try {
    stamp = JSON.parse(readSecureMetadataFile(
      nodeModulesStampPath(nodeModulesPath),
      MAX_NODE_MODULES_STAMP_BYTES,
      "cached node_modules stamp",
    ));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error("cached node_modules stamp is invalid JSON", { cause: error });
    }
    throw error;
  }
  const actual = {
    format: NODE_DEPENDENCY_CACHE_FORMAT,
    dependencyDigest: expected.dependencyDigest,
    packageManager: JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8")).packageManager,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    inventoryDigest: nodeModulesInventoryDigest(nodeModulesPath),
  };
  for (const [key, value] of Object.entries(actual)) {
    if (stamp[key] !== value) throw new Error(`cached node_modules failed ${key} validation`);
  }
  return stamp;
}

export function expectedRepoDigest(image) {
  const separator = image.lastIndexOf("@sha256:");
  if (separator < 1) throw new Error(`container image is not digest pinned: ${image}`);
  const repositoryAndTag = image.slice(0, separator);
  const lastSlash = repositoryAndTag.lastIndexOf("/");
  const tag = repositoryAndTag.lastIndexOf(":");
  const repository = tag > lastSlash ? repositoryAndTag.slice(0, tag) : repositoryAndTag;
  return `${repository}${image.slice(separator)}`;
}

export function validateImageInspection(image, inspection) {
  const records = JSON.parse(inspection);
  const repoDigests = records[0]?.RepoDigests;
  if (!Array.isArray(repoDigests) || !repoDigests.includes(expectedRepoDigest(image))) {
    throw new Error(`loaded container image does not match its pinned digest: ${image}`);
  }
}

export function validateTemplateArchiveEntries(entries, verboseEntries) {
  const paths = entries.split(/\r?\n/u).filter(Boolean);
  if (paths.length === 0) throw new Error("PostgreSQL template archive is empty");
  const metadata = verboseEntries.split(/\r?\n/u).filter(Boolean);
  if (metadata.length !== paths.length) {
    throw new Error("PostgreSQL template archive metadata is inconsistent");
  }
  for (const entry of metadata) {
    const type = entry[0];
    if (type !== "-" && type !== "d") {
      throw new Error("PostgreSQL template archive contains an unsafe entry type");
    }
  }
  for (const path of paths) {
    if (path.startsWith("/") || path.split("/").includes("..")) {
      throw new Error("PostgreSQL template archive contains an unsafe path");
    }
  }
  if (!paths.some((path) => /(?:^|\/)PG_VERSION$/u.test(path))) {
    throw new Error("PostgreSQL template archive is missing PG_VERSION");
  }
  if (!paths.some((path) => /(?:^|\/)global\/pg_control$/u.test(path))) {
    throw new Error("PostgreSQL template archive is missing pg_control");
  }
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function archiveChecksumPath(archivePath) {
  return `${archivePath}.sha256`;
}

export async function writeArchiveChecksum(archivePath) {
  const digest = await sha256File(archivePath);
  writeFileSync(archiveChecksumPath(archivePath), `${digest}\n`, { mode: 0o600 });
  return digest;
}

export async function validateArchiveChecksum(archivePath) {
  const expected = readSecureMetadataFile(
    archiveChecksumPath(archivePath),
    MAX_ARCHIVE_CHECKSUM_BYTES,
    "cached archive checksum sidecar",
  ).trim();
  if (!/^[0-9a-f]{64}$/u.test(expected)) throw new Error("cached archive checksum is invalid");
  const actual = await sha256File(archivePath);
  if (actual !== expected) throw new Error("cached archive checksum does not match");
  return actual;
}

export function runProcess(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const maxCapturedOutputBytes = options.maxCapturedOutputBytes ?? MAX_CAPTURED_OUTPUT_BYTES;
    if (!Number.isSafeInteger(maxCapturedOutputBytes) || maxCapturedOutputBytes < 1) {
      reject(new Error("subprocess output limit must be a positive safe integer"));
      return;
    }
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let settled = false;
    const appendTail = (current, chunk) => {
      const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (next.length >= maxCapturedOutputBytes) {
        return {
          value: next.subarray(-maxCapturedOutputBytes),
          truncated: current.length > 0 || next.length > maxCapturedOutputBytes,
        };
      }
      if (current.length + next.length <= maxCapturedOutputBytes) {
        return { value: Buffer.concat([current, next]), truncated: false };
      }
      return {
        value: Buffer.concat([
          current.subarray(current.length + next.length - maxCapturedOutputBytes),
          next,
        ]),
        truncated: true,
      };
    };
    child.stdout.on("data", (chunk) => {
      const appended = appendTail(stdout, chunk);
      stdout = appended.value;
      stdoutTruncated ||= appended.truncated;
    });
    child.stderr.on("data", (chunk) => {
      const appended = appendTail(stderr, chunk);
      stderr = appended.value;
      stderrTruncated ||= appended.truncated;
    });
    const settle = (operation) => {
      if (settled) return;
      settled = true;
      operation();
    };
    child.once("error", (error) => settle(() => reject(error)));
    child.once("close", (code, signal) => settle(() => {
      const capturedStdout = stdout.toString("utf8");
      const capturedStderr = stderr.toString("utf8");
      if (code === 0) {
        resolvePromise({
          stdout: capturedStdout.trim(),
          stderr: capturedStderr.trim(),
          stdoutTruncated,
          stderrTruncated,
        });
      } else {
        reject(Object.assign(new Error(`${command} exited unsuccessfully`), {
          code,
          signal,
          stdout: capturedStdout,
          stderr: capturedStderr,
          stdoutTruncated,
          stderrTruncated,
        }));
      }
    }));
  });
}

async function docker(args) {
  return runProcess("docker", args);
}

async function verifyLocalImages() {
  for (const image of POSTGRESQL_HARNESS_IMAGES) {
    const inspection = await docker(["image", "inspect", image]);
    validateImageInspection(image, inspection.stdout);
  }
}

export async function stageImages(archivePath) {
  mkdirSync(dirname(archivePath), { recursive: true });
  for (const image of POSTGRESQL_HARNESS_IMAGES) await docker(["pull", image]);
  await verifyLocalImages();
  await docker(["image", "save", "--output", archivePath, ...POSTGRESQL_HARNESS_IMAGES]);
  await writeArchiveChecksum(archivePath);
}

export async function loadImages(archivePath) {
  await validateArchiveChecksum(archivePath);
  await docker(["image", "load", "--input", archivePath]);
  // Docker's archive format does not retain RepoDigests. Re-pulling each exact
  // reference performs a registry digest check while reusing the cached layers.
  for (const image of POSTGRESQL_HARNESS_IMAGES) await docker(["pull", image]);
  await verifyLocalImages();
}

async function removeDockerObject(type, name) {
  await docker([type, "rm", "--force", name]).catch((error) => {
    if (!String(error?.stderr ?? "").toLowerCase().includes("no such")) throw error;
  });
}

const GNU_TAR_INVENTORY_ERROR = "PostgreSQL template archive validation requires GNU tar with --quoting-style=escape; install GNU tar and ensure it is first on PATH";

export function validateTarInventoryCapabilities(helpOutput, outputTruncated = false) {
  if (outputTruncated
    || !String(helpOutput).includes("--quoting-style")
    || !/(?:^|\s)escape(?:\s|$)/mu.test(String(helpOutput))) {
    throw new Error(GNU_TAR_INVENTORY_ERROR);
  }
}

async function requireSafeTarInventorySupport() {
  let help;
  try {
    help = await runProcess("tar", ["--help"]);
  } catch (error) {
    throw new Error(GNU_TAR_INVENTORY_ERROR, { cause: error });
  }
  validateTarInventoryCapabilities(help.stdout, help.stdoutTruncated);
}

async function readTemplateArchiveInventory(archivePath) {
  await requireSafeTarInventorySupport();
  const commonArguments = [
    "--list",
    "--file", archivePath,
    "--quoting-style=escape",
  ];
  const options = { maxCapturedOutputBytes: MAX_ARCHIVE_INVENTORY_BYTES };
  const paths = await runProcess("tar", commonArguments, options);
  const metadata = await runProcess("tar", ["--verbose", ...commonArguments], options);
  if (paths.stdoutTruncated || metadata.stdoutTruncated) {
    throw new Error("PostgreSQL template archive inventory exceeds the validation limit");
  }
  validateTemplateArchiveEntries(paths.stdout, metadata.stdout);
}

export async function buildPostgreSqlTemplate(archivePath) {
  const suffix = randomBytes(8).toString("hex");
  const container = `lcm-pg-template-${suffix}`;
  const volume = `lcm-pg-template-data-${suffix}`;
  mkdirSync(dirname(archivePath), { recursive: true });
  try {
    await docker(["volume", "create", volume]);
    await docker([
      "create", "--name", container,
      "--network", "none",
      "--volume", `${volume}:/var/lib/postgresql`,
      "--volume", `${templateInitScript}:/docker-entrypoint-initdb.d/10-lcm-template.sh:ro`,
      "--env", "POSTGRES_HOST_AUTH_METHOD=trust",
      "--env", "POSTGRES_DB=postgres",
      "--env", `LCM_POSTGRES_TEMPLATE_MARKER=${POSTGRES_TEMPLATE_MARKER}`,
      POSTGRES_IMAGE,
      "-c", "shared_preload_libraries=pg_stat_statements",
      "-c", "password_encryption=scram-sha-256",
      "-c", "timezone=UTC",
    ]);
    await docker(["start", container]);
    let marker;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      marker = await docker([
        "exec", container, "bash", "-ceu",
        'test "$(< /proc/1/comm)" = postgres; exec psql --tuples-only --no-align --username postgres --dbname postgres --command "$1"',
        "lcm-template-readiness",
        `SELECT marker
         FROM public.__lcm_template_marker
         WHERE marker = '${POSTGRES_TEMPLATE_MARKER}'
           AND current_setting('server_version_num')::integer / 10000 = 18
           AND (
             SELECT count(*) = 3 AND bool_and(NOT rolcanlogin)
             FROM pg_roles
             WHERE rolname IN ('lcm_harness_admin', 'lcm_test_migrator', 'lcm_test_runtime')
           )
           AND EXISTS (
             SELECT 1
             FROM pg_database
             WHERE datname = '${POSTGRES_TEMPLATE_DATABASE}'
               AND datistemplate
               AND NOT datallowconn
               AND pg_encoding_to_char(encoding) = 'UTF8'
               AND pg_get_userbyid(datdba) = 'lcm_harness_admin'
           )`,
      ]).then((result) => result.stdout, () => undefined);
      if (marker === POSTGRES_TEMPLATE_MARKER) break;
      if (attempt === 119) throw new Error("cached PostgreSQL template did not become ready");
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    }
    if (marker !== POSTGRES_TEMPLATE_MARKER) {
      throw new Error("cached PostgreSQL template marker validation failed");
    }
    await docker(["stop", "--time", "30", container]);
    await docker(["rm", container]);
    const archiveName = archivePath.split(sep).at(-1);
    if (!archiveName || !/^[a-zA-Z0-9._-]+$/u.test(archiveName)) {
      throw new Error("PostgreSQL template archive name is unsafe");
    }
    await docker([
      "run", "--rm", "--network", "none",
      "--volume", `${volume}:/source:ro`,
      "--volume", `${dirname(resolve(archivePath))}:/archive`,
      "--env", `ARCHIVE_NAME=${archiveName}`,
      "--entrypoint", "/bin/bash",
      POSTGRES_IMAGE,
      "-ceu",
      "data_dir=\"$(dirname \"$(find /source -mindepth 2 -maxdepth 3 -name PG_VERSION -type f -print -quit)\")\"; test -n \"$data_dir\"; pg_controldata \"$data_dir\" | grep -Eq 'Database cluster state:[[:space:]]+shut down'; tar --numeric-owner --create --file \"/archive/$ARCHIVE_NAME\" --directory /source .",
    ]);
    await readTemplateArchiveInventory(archivePath);
    await writeArchiveChecksum(archivePath);
  } finally {
    await removeDockerObject("container", container);
    await removeDockerObject("volume", volume);
  }
}

export async function validatePostgreSqlTemplateArchive(archivePath) {
  await validateArchiveChecksum(archivePath);
  await readTemplateArchiveInventory(archivePath);
}

function writeGithubOutputs(metadata) {
  for (const [name, value] of Object.entries({
    "node-modules-key": metadata.nodeModulesKey,
    "images-key": metadata.imagesKey,
    "template-key": metadata.templateKey,
  })) {
    process.stdout.write(`${name}=${value}\n`);
  }
}

async function main(args) {
  const [command, pathArgument] = args;
  if (command === "cache-metadata") writeGithubOutputs(cacheMetadata());
  else if (command === "write-node-modules-stamp") writeNodeModulesStamp(resolve(pathArgument ?? "node_modules"));
  else if (command === "validate-node-modules") validateNodeModulesStamp(resolve(pathArgument ?? "node_modules"));
  else if (command === "stage-images" && pathArgument) await stageImages(resolve(pathArgument));
  else if (command === "load-images" && pathArgument) await loadImages(resolve(pathArgument));
  else if (command === "build-postgresql-template" && pathArgument) await buildPostgreSqlTemplate(resolve(pathArgument));
  else if (command === "validate-postgresql-template" && pathArgument) await validatePostgreSqlTemplateArchive(resolve(pathArgument));
  else throw new Error("invalid CI environment command");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((error) => {
    const details = String(error?.stderr ?? error?.message ?? error);
    process.stderr.write(`CI environment initialization failed: ${details}\n`);
    process.exitCode = 1;
  });
}
