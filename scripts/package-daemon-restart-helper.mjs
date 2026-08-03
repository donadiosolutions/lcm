import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const NATIVE_HELPER = Object.freeze({
  crateDirectory: "native/daemon-restart-helper",
  filename: "daemon-restart-helper",
  manifestFilename: "daemon-restart-helper.manifest.json",
  outputDirectory: "dist/native/linux-x64",
  target: "x86_64-unknown-linux-musl",
  maxBinaryBytes: 32 * 1024 * 1024,
  maxManifestBytes: 4096,
  binaryMode: 0o755,
  manifestMode: 0o644,
});

const EXPECTED_RUSTC = Object.freeze({
  release: "1.93.0",
  commitHash: "254b59607d4417e9dffbc307138ae5c86280fe4c",
  commitDate: "2026-01-19",
  host: "x86_64-unknown-linux-gnu",
  llvmVersion: "21.1.8",
});

const EXPECTED_CARGO = Object.freeze({
  release: "1.93.0",
  commitHash: "083ac5135f967fd9dc906ab057a2315861c7a80d",
  commitDate: "2025-12-15",
  host: "x86_64-unknown-linux-gnu",
});

const MANIFEST_KEYS = [
  "formatVersion",
  "filename",
  "target",
  "compiler",
  "mode",
  "size",
  "sha256",
];
const COMPILER_KEYS = ["rustc", "cargo"];
const RUSTC_KEYS = [
  "release",
  "commitHash",
  "commitDate",
  "host",
  "llvmVersion",
];
const CARGO_KEYS = ["release", "commitHash", "commitDate", "host"];

function fail(message) {
  throw new Error(`daemon-restart-helper package: ${message}`);
}

function assertExactKeys(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  const actual = Object.keys(value);
  if (
    actual.length !== keys.length ||
    actual.some((key, index) => key !== keys[index])
  ) {
    fail(`${label} fields are not canonical`);
  }
}

function parseVersionLines(output, label) {
  if (typeof output !== "string" || Buffer.byteLength(output, "utf8") > 8192) {
    fail(`${label} version output is not bounded text`);
  }
  const fields = new Map();
  for (const line of output.trimEnd().split("\n")) {
    const separator = line.indexOf(":");
    if (separator > 0)
      fields.set(line.slice(0, separator), line.slice(separator + 1).trim());
  }
  return fields;
}

export function parseCompilerEvidence(rustcOutput, cargoOutput) {
  const rustc = parseVersionLines(rustcOutput, "rustc");
  const cargo = parseVersionLines(cargoOutput, "cargo");
  const evidence = {
    rustc: {
      release: rustc.get("release"),
      commitHash: rustc.get("commit-hash"),
      commitDate: rustc.get("commit-date"),
      host: rustc.get("host"),
      llvmVersion: rustc.get("LLVM version"),
    },
    cargo: {
      release: cargo.get("release"),
      commitHash: cargo.get("commit-hash"),
      commitDate: cargo.get("commit-date"),
      host: cargo.get("host"),
    },
  };
  if (JSON.stringify(evidence.rustc) !== JSON.stringify(EXPECTED_RUSTC)) {
    fail("rustc is not the pinned 1.93.0 compiler");
  }
  if (JSON.stringify(evidence.cargo) !== JSON.stringify(EXPECTED_CARGO)) {
    fail("cargo is not the pinned 1.93.0 build tool");
  }
  return evidence;
}

function executeCapture(command, args, options = {}, spawn = spawnSync) {
  const result = spawn(command, args, {
    ...options,
    encoding: "utf8",
    maxBuffer: 8192,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.signal)
    fail(`${command} was terminated by signal ${result.signal}`);
  if (result.status !== 0) {
    const detail =
      typeof result.stderr === "string"
        ? result.stderr.trim().slice(0, 1024)
        : "";
    fail(
      `${command} exited with status ${result.status}${
        detail ? `: ${detail}` : ""
      }`
    );
  }
  return result.stdout;
}

function executeBuild(command, args, options = {}, spawn = spawnSync) {
  const result = spawn(command, args, { ...options, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.signal)
    fail(`${command} was terminated by signal ${result.signal}`);
  if (result.status !== 0)
    fail(`${command} exited with status ${result.status}`);
}

function assertInside(root, candidate, label) {
  const path = resolve(candidate);
  const relation = relative(resolve(root), path);
  if (relation === "" || relation === ".." || relation.startsWith(`..${sep}`)) {
    fail(`${label} escapes its fixed root`);
  }
  return path;
}

function assertRegularLeaf(path, label) {
  let stat;
  try {
    stat = lstatSync(path, { bigint: true });
  } catch (error) {
    fail(
      `${label} is unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) {
    fail(`${label} must be a single-link regular file`);
  }
}

function assertRealDirectoryChain(root, candidate, label) {
  const base = resolve(root);
  const relation = relative(base, resolve(candidate));
  const segments = relation === "" ? [] : relation.split(sep);
  let current = base;
  for (const segment of segments) {
    current = resolve(current, segment);
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      fail(`${label} contains a non-directory or symbolic-link component`);
    }
  }
}

function ensureRealDirectoryChain(root, candidate, label, mode) {
  const base = resolve(root);
  const relation = relative(base, resolve(candidate));
  const segments = relation === "" ? [] : relation.split(sep);
  let current = base;
  for (const segment of segments) {
    current = resolve(current, segment);
    try {
      const stat = lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        fail(`${label} contains a non-directory or symbolic-link component`);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      mkdirSync(current, { mode });
    }
  }
}

function recreateOutputDirectory(root, outputDirectory) {
  const output = assertInside(
    root,
    resolve(root, outputDirectory),
    "output directory"
  );
  const segments = relative(root, output).split(sep);
  let current = resolve(root);
  for (const segment of segments.slice(0, -1)) {
    current = resolve(current, segment);
    try {
      const stat = lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        fail(
          `output parent ${relative(root, current)} is not a real directory`
        );
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      mkdirSync(current, { mode: 0o755 });
    }
  }
  try {
    const stat = lstatSync(output);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      fail("output directory is not a real directory");
    }
    rmSync(output, { force: true, recursive: true });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  mkdirSync(output, { mode: 0o755 });
  return output;
}

function sameStat(before, after) {
  return [
    "dev",
    "ino",
    "mode",
    "uid",
    "gid",
    "nlink",
    "size",
    "mtimeNs",
    "ctimeNs",
  ].every((field) => before[field] === after[field]);
}

export function readBoundedRegularFile(
  path,
  { label, maxBytes, expectedMode, expectedUid = process.getuid?.() } = {}
) {
  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n)
      fail(`${label} is not a single-link regular file`);
    if (before.size <= 0n || before.size > BigInt(maxBytes)) {
      fail(`${label} size is outside 1..${maxBytes} bytes`);
    }
    if (
      expectedMode !== undefined &&
      Number(before.mode & 0o777n) !== expectedMode
    ) {
      fail(`${label} mode is not 0${expectedMode.toString(8)}`);
    }
    if (expectedUid !== undefined && before.uid !== BigInt(expectedUid)) {
      fail(`${label} is not owned by the current user`);
    }
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(
        descriptor,
        bytes,
        offset,
        bytes.length - offset,
        offset
      );
      if (count === 0) fail(`${label} ended before its recorded size`);
      offset += count;
    }
    const extra = Buffer.alloc(1);
    if (readSync(descriptor, extra, 0, 1, offset) !== 0)
      fail(`${label} grew while being read`);
    const after = fstatSync(descriptor, { bigint: true });
    if (!sameStat(before, after)) fail(`${label} changed while being read`);
    return { bytes, stat: before };
  } finally {
    closeSync(descriptor);
  }
}

function writeExclusiveFile(path, bytes, mode) {
  const temporary = `${path}.new`;
  const descriptor = openSync(
    temporary,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    mode
  );
  try {
    let offset = 0;
    while (offset < bytes.length) {
      const count = writeSync(descriptor, bytes, offset);
      if (count <= 0) fail(`${path} could not be written completely`);
      offset += count;
    }
    fchmodSync(descriptor, mode);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporary, path);
}

function fsyncDirectory(path) {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function assertStaticLinuxX64Elf(bytes) {
  if (
    bytes.length < 64 ||
    !bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
    bytes[4] !== 2 ||
    bytes[5] !== 1 ||
    bytes[6] !== 1 ||
    (bytes.readUInt16LE(16) !== 2 && bytes.readUInt16LE(16) !== 3) ||
    bytes.readUInt16LE(18) !== 0x3e
  ) {
    fail("native helper is not a 64-bit little-endian x86_64 ELF");
  }
  const programOffset = Number(bytes.readBigUInt64LE(32));
  const entryBytes = bytes.readUInt16LE(54);
  const entryCount = bytes.readUInt16LE(56);
  if (
    entryBytes < 56 ||
    entryCount === 0 ||
    entryCount > 128 ||
    !Number.isSafeInteger(programOffset) ||
    programOffset < 64 ||
    programOffset + entryBytes * entryCount > bytes.length
  ) {
    fail("native helper ELF program headers are malformed");
  }
  for (let index = 0; index < entryCount; index += 1) {
    const header = programOffset + index * entryBytes;
    const type = bytes.readUInt32LE(header);
    if (type === 3) fail("native helper ELF contains a dynamic interpreter");
    if (type !== 2) continue;
    const offset = Number(bytes.readBigUInt64LE(header + 8));
    const size = Number(bytes.readBigUInt64LE(header + 32));
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(size) ||
      size % 16 !== 0 ||
      offset < 0 ||
      offset + size > bytes.length
    ) {
      fail("native helper ELF dynamic segment is malformed");
    }
    for (let cursor = offset; cursor < offset + size; cursor += 16) {
      if (bytes.readBigInt64LE(cursor) === 1n) {
        fail("native helper ELF declares a dynamic dependency");
      }
    }
  }
}

export function canonicalManifest(manifest) {
  assertExactKeys(manifest, MANIFEST_KEYS, "manifest");
  assertExactKeys(manifest.compiler, COMPILER_KEYS, "compiler evidence");
  assertExactKeys(manifest.compiler.rustc, RUSTC_KEYS, "rustc evidence");
  assertExactKeys(manifest.compiler.cargo, CARGO_KEYS, "cargo evidence");
  if (manifest.formatVersion !== 1) fail("manifest formatVersion must be 1");
  if (manifest.filename !== NATIVE_HELPER.filename)
    fail("manifest filename is incorrect");
  if (manifest.target !== NATIVE_HELPER.target)
    fail("manifest target is incorrect");
  if (manifest.mode !== "0755") fail("manifest mode is incorrect");
  if (
    !Number.isSafeInteger(manifest.size) ||
    manifest.size < 1 ||
    manifest.size > NATIVE_HELPER.maxBinaryBytes
  ) {
    fail("manifest size is outside the supported bound");
  }
  if (!/^[0-9a-f]{64}$/u.test(manifest.sha256))
    fail("manifest SHA-256 is not canonical");
  if (
    JSON.stringify(manifest.compiler.rustc) !== JSON.stringify(EXPECTED_RUSTC)
  ) {
    fail("manifest rustc evidence is not pinned");
  }
  if (
    JSON.stringify(manifest.compiler.cargo) !== JSON.stringify(EXPECTED_CARGO)
  ) {
    fail("manifest cargo evidence is not pinned");
  }
  return Buffer.from(`${JSON.stringify(manifest)}\n`, "utf8");
}

export function verifyNativeHelperPackage({ root = SCRIPT_ROOT } = {}) {
  const output = assertInside(
    root,
    resolve(root, NATIVE_HELPER.outputDirectory),
    "output directory"
  );
  const outputStat = lstatSync(output);
  if (!outputStat.isDirectory() || outputStat.isSymbolicLink()) {
    fail("output directory is not a real directory");
  }
  assertRealDirectoryChain(root, output, "output directory");
  const entries = readdirSync(output).sort();
  const expected = [
    NATIVE_HELPER.filename,
    NATIVE_HELPER.manifestFilename,
  ].sort();
  if (JSON.stringify(entries) !== JSON.stringify(expected))
    fail("output inventory is not exact");

  const manifestPath = resolve(output, NATIVE_HELPER.manifestFilename);
  const manifestFile = readBoundedRegularFile(manifestPath, {
    label: "native helper manifest",
    maxBytes: NATIVE_HELPER.maxManifestBytes,
    expectedMode: NATIVE_HELPER.manifestMode,
  });
  let manifest;
  try {
    manifest = JSON.parse(manifestFile.bytes.toString("utf8"));
  } catch (error) {
    fail(
      `manifest is not JSON: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  const canonical = canonicalManifest(manifest);
  if (!manifestFile.bytes.equals(canonical))
    fail("manifest bytes are not canonical");

  const helperPath = resolve(output, NATIVE_HELPER.filename);
  const helper = readBoundedRegularFile(helperPath, {
    label: "native helper",
    maxBytes: NATIVE_HELPER.maxBinaryBytes,
    expectedMode: NATIVE_HELPER.binaryMode,
  });
  assertStaticLinuxX64Elf(helper.bytes);
  if (Number(helper.stat.size) !== manifest.size)
    fail("native helper size does not match manifest");
  if (sha256(helper.bytes) !== manifest.sha256)
    fail("native helper digest does not match manifest");
  return {
    helperPath,
    manifestPath,
    manifestSha256: sha256(manifestFile.bytes),
    manifest,
  };
}

export function buildNativeHelperPackage({
  root = SCRIPT_ROOT,
  spawn = spawnSync,
  platform = process.platform,
  arch = process.arch,
} = {}) {
  if (platform !== "linux" || arch !== "x64") fail("build requires Linux x64");
  const crate = assertInside(
    root,
    resolve(root, NATIVE_HELPER.crateDirectory),
    "crate directory"
  );
  assertRealDirectoryChain(root, crate, "crate directory");
  assertRegularLeaf(resolve(crate, "Cargo.toml"), "Cargo.toml");
  assertRegularLeaf(resolve(crate, "Cargo.lock"), "Cargo.lock");
  const output = recreateOutputDirectory(root, NATIVE_HELPER.outputDirectory);

  const targetDirectory = assertInside(
    root,
    resolve(root, "target", "daemon-restart-helper"),
    "Cargo target directory"
  );
  const cargoHome = assertInside(
    root,
    resolve(targetDirectory, "cargo-home"),
    "Cargo home"
  );
  ensureRealDirectoryChain(root, cargoHome, "Cargo home", 0o700);
  if (!process.env.PATH)
    fail("PATH is unavailable for the pinned Rust toolchain");
  const rustupHome =
    process.env.RUSTUP_HOME ??
    (process.env.HOME ? resolve(process.env.HOME, ".rustup") : undefined);
  if (!rustupHome) fail("RUSTUP_HOME cannot be derived without HOME");
  const environment = {
    CARGO_ENCODED_RUSTFLAGS: "",
    CARGO_HOME: cargoHome,
    CARGO_INCREMENTAL: "0",
    CARGO_NET_OFFLINE: "true",
    CARGO_TARGET_DIR: targetDirectory,
    LANG: "C",
    LC_ALL: "C",
    PATH: process.env.PATH,
    RUSTFLAGS: `--remap-path-prefix=${resolve(
      root
    )}=/usr/src/lcm -C link-arg=-Wl,--build-id=none -C strip=symbols`,
    RUSTUP_HOME: rustupHome,
    SOURCE_DATE_EPOCH: "0",
    ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
    TZ: "UTC",
  };
  const compiler = parseCompilerEvidence(
    executeCapture(
      "rustc",
      ["--version", "--verbose"],
      { cwd: root, env: environment },
      spawn
    ),
    executeCapture(
      "cargo",
      ["--version", "--verbose"],
      { cwd: root, env: environment },
      spawn
    )
  );
  executeBuild(
    "cargo",
    [
      "build",
      "--locked",
      "--offline",
      "--release",
      "--target",
      NATIVE_HELPER.target,
      "--manifest-path",
      resolve(crate, "Cargo.toml"),
    ],
    { cwd: crate, env: environment },
    spawn
  );

  const artifactPath = resolve(
    targetDirectory,
    NATIVE_HELPER.target,
    "release",
    NATIVE_HELPER.filename
  );
  const artifact = readBoundedRegularFile(artifactPath, {
    label: "Cargo native helper artifact",
    maxBytes: NATIVE_HELPER.maxBinaryBytes,
    expectedMode: NATIVE_HELPER.binaryMode,
  });
  writeExclusiveFile(
    resolve(output, NATIVE_HELPER.filename),
    artifact.bytes,
    NATIVE_HELPER.binaryMode
  );
  const manifest = {
    formatVersion: 1,
    filename: NATIVE_HELPER.filename,
    target: NATIVE_HELPER.target,
    compiler,
    mode: "0755",
    size: artifact.bytes.length,
    sha256: sha256(artifact.bytes),
  };
  writeExclusiveFile(
    resolve(output, NATIVE_HELPER.manifestFilename),
    canonicalManifest(manifest),
    NATIVE_HELPER.manifestMode
  );
  fsyncDirectory(output);
  return verifyNativeHelperPackage({ root });
}

export function runNativeHelperPackageCli(argv = process.argv.slice(2)) {
  if (argv.length !== 1 || (argv[0] !== "build" && argv[0] !== "verify")) {
    fail("expected exactly one command: build or verify");
  }
  return argv[0] === "build"
    ? buildNativeHelperPackage()
    : verifyNativeHelperPackage();
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : undefined;
if (invokedPath === import.meta.url) {
  try {
    const result = runNativeHelperPackageCli();
    console.log(
      `daemon-restart-helper: ${result.manifest.filename} ${result.manifest.sha256} (${result.manifest.size} bytes)`
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
