#!/usr/bin/env node
// Bootstrap before dependencies exist: only Node built-ins and the system tar.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const runProcess = promisify(execFile);
const defaultManifest = resolve(dirname(fileURLToPath(import.meta.url)), "../package.json");
const maxArchiveBytes = 32 * 1024 * 1024;
const timeoutMs = 60_000;

/** Download one fixed registry artifact with a deadline and a bounded body. */
export async function downloadArchive(url, dependencies = {}) {
  const fetchArchive = dependencies.fetch ?? globalThis.fetch;
  const limit = dependencies.maxBytes ?? maxArchiveBytes;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("pnpm download timed out")), dependencies.timeoutMs ?? timeoutMs);
  let response;
  try {
    response = await fetchArchive(url, { redirect: "error", signal: controller.signal });
    if (!response.ok) throw new Error(`pnpm download failed: HTTP ${response.status}`);
    const lengthHeader = response.headers.get("content-length");
    const expectedLength = lengthHeader === null ? undefined : Number(lengthHeader);
    if (expectedLength !== undefined && (!Number.isSafeInteger(expectedLength) || expectedLength < 0)) {
      throw new Error("pnpm download has an invalid content-length");
    }
    if (expectedLength > limit) throw new Error("pnpm archive exceeds the size limit");
    if (!response.body) throw new Error("pnpm download is empty");
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > limit) throw new Error("pnpm archive exceeds the size limit");
      chunks.push(Buffer.from(chunk));
    }
    if (expectedLength !== undefined && size !== expectedLength) {
      throw new Error("pnpm download is incomplete (content-length mismatch)");
    }
    if (size === 0) throw new Error("pnpm download is empty");
    return Buffer.concat(chunks, size);
  } finally {
    clearTimeout(timer);
    // Abort also cancels unconsumed response bodies on HTTP/size failures.
    controller.abort();
  }
}

/**
 * Create a fresh private installation and return its absolute PATH directory.
 * The destination's parent must exist. Existing destinations are never reused
 * or removed; only an installation created by this invocation is cleaned up.
 * Download/process seams let tests inject deterministic failures without a
 * network connection or any global package-manager installation.
 */
export async function bootstrapPnpm({ destination, manifestPath = defaultManifest }, dependencies = {}) {
  if (typeof destination !== "string" || destination.trim() === "") {
    throw new Error("usage: node scripts/bootstrap-pnpm.mjs --destination <new-directory>");
  }
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const pin = /^pnpm@(\d+\.\d+\.\d+)\+sha512\.([a-f0-9]{128})$/.exec(manifest.packageManager);
  if (!pin) throw new Error("packageManager must pin pnpm@<version>+sha512.<128 lowercase hex digits>");
  const [, version, expectedHash] = pin;
  const directory = resolve(destination);
  // Non-recursive mkdir is the ownership boundary: EEXIST must not clean up a
  // caller-owned directory (including a dangling or existing symbolic link).
  await mkdir(directory, { mode: 0o700 });
  const download = dependencies.download ?? downloadArchive;
  const run = dependencies.run ?? runProcess;
  try {
    const archive = await download(`https://registry.npmjs.org/pnpm/-/pnpm-${version}.tgz`);
    if (archive.byteLength > maxArchiveBytes) throw new Error("pnpm archive exceeds the size limit");
    const actualHash = createHash("sha512").update(archive).digest("hex");
    if (actualHash !== expectedHash) throw new Error("pnpm archive SHA-512 integrity mismatch");
    const archivePath = join(directory, "pnpm.tgz");
    await writeFile(archivePath, archive, { flag: "wx", mode: 0o600 });
    // Retain the package/ prefix so tar cannot replace the private destination's
    // permissions with the archive's public package-directory permissions.
    await run("tar", ["-xzf", archivePath, "-C", directory], {
      timeout: timeoutMs, maxBuffer: 1024 * 1024,
    });
    await rm(archivePath);
    const packageRoot = join(directory, "package");
    const metadata = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
    if (metadata.name !== "pnpm" || metadata.version !== version) {
      throw new Error(`pnpm package name/version mismatch; expected pnpm ${version}`);
    }
    const launcher = join(packageRoot, "bin", "pnpm.cjs");
    if (!(await lstat(launcher)).isFile()) throw new Error("pnpm launcher must be a regular file");
    const bin = join(directory, "bin");
    await mkdir(bin, { mode: 0o700 });
    await symlink("../package/bin/pnpm.cjs", join(bin, "pnpm"));
    const result = await run(join(bin, "pnpm"), ["--version"], {
      cwd: packageRoot,
      env: { ...process.env, npm_config_manage_package_manager_versions: "false" },
      timeout: timeoutMs, maxBuffer: 1024 * 1024,
    });
    if (result.stdout.trim() !== version) throw new Error(`pnpm executable version mismatch; expected ${version}`);
    return bin;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 2 || args[0] !== "--destination") {
      throw new Error("usage: node scripts/bootstrap-pnpm.mjs --destination <new-directory>");
    }
    const bin = await bootstrapPnpm({ destination: args[1] });
    process.stdout.write(`${bin}\n`);
  } catch (error) {
    process.stderr.write(`bootstrap-pnpm: ${error.message}\n`);
    process.exitCode = 1;
  }
}
