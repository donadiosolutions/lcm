import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  unlinkSync,
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
const DIRECTORY_OPEN_FLAGS =
  constants.O_RDONLY |
  constants.O_DIRECTORY |
  constants.O_NOFOLLOW |
  constants.O_NONBLOCK;
const CARGO_TARGET_DIRECTORY_FD = 3;
const CARGO_HOME_DIRECTORY_FD = 4;
const OUTPUT_LEAVES = Object.freeze([
  NATIVE_HELPER.filename,
  NATIVE_HELPER.manifestFilename,
]);
const OUTPUT_TEMPORARY_LEAVES = Object.freeze(
  OUTPUT_LEAVES.map((leaf) => "." + leaf + ".new")
);
const OUTPUT_ALLOWED_LEAVES = new Set([
  ...OUTPUT_LEAVES,
  ...OUTPUT_TEMPORARY_LEAVES,
]);

export function cargoExecutablePath(
  targetDirectory,
  target = NATIVE_HELPER.target
) {
  if (
    typeof target !== "string" ||
    !/^[a-z0-9][a-z0-9_-]*$/u.test(target) ||
    target.includes("..")
  ) {
    fail("Cargo target is not a canonical target triple");
  }
  return resolve(targetDirectory, target, "release", NATIVE_HELPER.filename);
}

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
  const result = spawn(command, args, { stdio: "inherit", ...options });
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

function errorCode(error) {
  return error && typeof error === "object" ? error.code : undefined;
}

export function directoryEntryPath(descriptor, component) {
  if (
    !Number.isSafeInteger(descriptor) ||
    descriptor < 0 ||
    typeof component !== "string" ||
    component === "" ||
    component === "." ||
    component === ".." ||
    !/^[A-Za-z0-9._-]+$/u.test(component)
  ) {
    fail("directory entry is not a single safe component");
  }
  return "/proc/self/fd/" + descriptor + "/" + component;
}

function directoryStat(descriptor, label) {
  const stat = fstatSync(descriptor, { bigint: true });
  if (!stat.isDirectory()) fail(label + " is not a directory descriptor");
  return stat;
}

function directoryIdentity(stat) {
  return { dev: stat.dev, ino: stat.ino };
}

function sameDirectoryIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertDirectoryIdentity(actual, expected, label) {
  if (!sameDirectoryIdentity(directoryIdentity(actual), expected)) {
    fail(label + " identity changed");
  }
}

function openDirectoryNoFollow(path, label) {
  const descriptor = openSync(path, DIRECTORY_OPEN_FLAGS);
  try {
    return { descriptor, stat: directoryStat(descriptor, label) };
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

function openExistingDirectoryAt(parentDescriptor, component, label) {
  const path = directoryEntryPath(parentDescriptor, component);
  try {
    return openDirectoryNoFollow(path, label);
  } catch {
    fail(label + " is not a no-follow directory");
  }
}

function openOrCreateDirectoryAt(parentDescriptor, component, label, mode) {
  const path = directoryEntryPath(parentDescriptor, component);
  try {
    return openDirectoryNoFollow(path, label);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") {
      fail(label + " is not a no-follow directory");
    }
  }
  try {
    mkdirSync(path, { mode });
  } catch {
    // A concurrent creator may have won. The no-follow open below decides.
  }
  return openExistingDirectoryAt(parentDescriptor, component, label);
}

function directoryAuthorityPaths(root, directory, label) {
  const rootPath = resolve(root);
  const directoryPath = assertInside(
    rootPath,
    resolve(rootPath, directory),
    label
  );
  const relation = relative(rootPath, directoryPath);
  if (relation === "") fail(label + " cannot be the root directory");
  const components = relation.split(sep);
  for (const component of components) directoryEntryPath(0, component);
  return { rootPath, directoryPath, components };
}

function openDirectoryAuthority(
  root,
  directory,
  label,
  { create = false, mode = 0o755 } = {}
) {
  const paths = directoryAuthorityPaths(root, directory, label);
  let rootDirectory;
  try {
    rootDirectory = openDirectoryNoFollow(paths.rootPath, "package root");
  } catch {
    fail("package root is not a no-follow directory");
  }
  const identities = [directoryIdentity(rootDirectory.stat)];
  let currentDescriptor = rootDirectory.descriptor;
  try {
    for (const component of paths.components) {
      const child = create
        ? openOrCreateDirectoryAt(
            currentDescriptor,
            component,
            label + " component " + component,
            mode
          )
        : openExistingDirectoryAt(
            currentDescriptor,
            component,
            label + " component " + component
          );
      if (currentDescriptor !== rootDirectory.descriptor) {
        closeSync(currentDescriptor);
      }
      currentDescriptor = child.descriptor;
      identities.push(directoryIdentity(child.stat));
    }
    return {
      ...paths,
      rootDescriptor: rootDirectory.descriptor,
      directoryDescriptor: currentDescriptor,
      identities,
    };
  } catch (error) {
    if (currentDescriptor !== rootDirectory.descriptor) {
      closeSync(currentDescriptor);
    }
    closeSync(rootDirectory.descriptor);
    throw error;
  }
}

function closeDirectoryAuthority(authority) {
  if (authority.directoryDescriptor !== authority.rootDescriptor) {
    closeSync(authority.directoryDescriptor);
  }
  closeSync(authority.rootDescriptor);
}

function assertDirectoryAuthorityIntact(authority, label) {
  assertDirectoryIdentity(
    directoryStat(authority.rootDescriptor, label + " root"),
    authority.identities[0],
    label + " root"
  );
  let currentDescriptor = authority.rootDescriptor;
  let ownsCurrentDescriptor = false;
  try {
    for (const [index, component] of authority.components.entries()) {
      const child = openExistingDirectoryAt(
        currentDescriptor,
        component,
        label + " component " + component
      );
      if (ownsCurrentDescriptor) closeSync(currentDescriptor);
      currentDescriptor = child.descriptor;
      ownsCurrentDescriptor = true;
      assertDirectoryIdentity(
        child.stat,
        authority.identities[index + 1],
        label + " component " + component
      );
    }
    assertDirectoryIdentity(
      directoryStat(authority.directoryDescriptor, label + " held directory"),
      authority.identities.at(-1),
      label + " held directory"
    );
  } finally {
    if (ownsCurrentDescriptor) closeSync(currentDescriptor);
  }
}

function outputEntryPath(authority, component) {
  return directoryEntryPath(authority.directoryDescriptor, component);
}

function outputTemporaryLeafName(leaf) {
  return "." + leaf + ".new";
}

function outputInventory(authority) {
  const entries = readdirSync(
    "/proc/self/fd/" + authority.directoryDescriptor
  ).sort();
  const unexpected = entries.filter(
    (entry) => !OUTPUT_ALLOWED_LEAVES.has(entry)
  );
  if (unexpected.length !== 0) {
    fail("output directory contains an unexpected entry");
  }
  return entries;
}

function cleanupExpectedOutput(authority) {
  const entries = outputInventory(authority);
  for (const entry of entries) {
    const path = outputEntryPath(authority, entry);
    const stat = lstatSync(path, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) {
      fail("output entry " + entry + " is not an owned regular file");
    }
    unlinkSync(path);
  }
  if (entries.length !== 0) fsyncSync(authority.directoryDescriptor);
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
  {
    label,
    maxBytes,
    expectedMode,
    expectedUid = process.getuid?.(),
    requireExecutable = false,
    requireSingleLink = true,
  } = {}
) {
  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || (requireSingleLink && before.nlink !== 1n)) {
      fail(
        `${label} is not a${
          requireSingleLink ? " single-link" : ""
        } regular file`
      );
    }
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
    if (requireExecutable && Number(before.mode & 0o111n) === 0) {
      fail(`${label} is not executable`);
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

function readBoundedRegularFileAt(authority, component, options) {
  return readBoundedRegularFile(outputEntryPath(authority, component), options);
}

function writeExclusiveOutputFile(authority, leaf, bytes, mode) {
  const temporary = outputTemporaryLeafName(leaf);
  const temporaryPath = outputEntryPath(authority, temporary);
  const destinationPath = outputEntryPath(authority, leaf);
  const descriptor = openSync(
    temporaryPath,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    mode
  );
  try {
    const stat = fstatSync(descriptor, { bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n) {
      fail("output temporary file is not a single-link regular file");
    }
    let offset = 0;
    while (offset < bytes.length) {
      const count = writeSync(descriptor, bytes, offset);
      if (count <= 0)
        fail("output temporary file could not be written completely");
      offset += count;
    }
    fchmodSync(descriptor, mode);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  try {
    linkSync(temporaryPath, destinationPath);
  } catch {
    fail("output leaf " + leaf + " cannot be published exclusively");
  }
  unlinkSync(temporaryPath);
  fsyncSync(authority.directoryDescriptor);
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

function invokeOutputHook(outputHooks, name, authority) {
  if (outputHooks === undefined) return;
  const hook = outputHooks[name];
  if (hook === undefined) return;
  if (typeof hook !== "function") {
    fail("output hook " + name + " must be a function");
  }
  hook({ outputDirectory: authority.directoryPath });
}

function verifyNativeHelperPackageWithAuthority(
  authority,
  { outputHooks } = {}
) {
  invokeOutputHook(outputHooks, "afterVerificationAuthorityHeld", authority);
  assertDirectoryAuthorityIntact(
    authority,
    "output directory before verification"
  );
  const entries = outputInventory(authority);
  const expected = [...OUTPUT_LEAVES].sort();
  if (JSON.stringify(entries) !== JSON.stringify(expected))
    fail("output inventory is not exact");

  const manifestFile = readBoundedRegularFileAt(
    authority,
    NATIVE_HELPER.manifestFilename,
    {
      label: "native helper manifest",
      maxBytes: NATIVE_HELPER.maxManifestBytes,
      expectedMode: NATIVE_HELPER.manifestMode,
    }
  );
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

  const helper = readBoundedRegularFileAt(authority, NATIVE_HELPER.filename, {
    label: "native helper",
    maxBytes: NATIVE_HELPER.maxBinaryBytes,
    expectedMode: NATIVE_HELPER.binaryMode,
  });
  assertStaticLinuxX64Elf(helper.bytes);
  if (Number(helper.stat.size) !== manifest.size)
    fail("native helper size does not match manifest");
  if (sha256(helper.bytes) !== manifest.sha256)
    fail("native helper digest does not match manifest");
  assertDirectoryAuthorityIntact(
    authority,
    "output directory after verification"
  );
  return {
    helperPath: resolve(authority.directoryPath, NATIVE_HELPER.filename),
    manifestPath: resolve(
      authority.directoryPath,
      NATIVE_HELPER.manifestFilename
    ),
    manifestSha256: sha256(manifestFile.bytes),
    manifest,
  };
}

export function verifyNativeHelperPackage({
  root = SCRIPT_ROOT,
  outputHooks,
} = {}) {
  const authority = openDirectoryAuthority(
    root,
    NATIVE_HELPER.outputDirectory,
    "output directory"
  );
  try {
    return verifyNativeHelperPackageWithAuthority(authority, { outputHooks });
  } finally {
    closeDirectoryAuthority(authority);
  }
}

export function buildNativeHelperPackage({
  root = SCRIPT_ROOT,
  spawn = spawnSync,
  platform = process.platform,
  arch = process.arch,
  outputHooks,
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
  if (!process.env.PATH)
    fail("PATH is unavailable for the pinned Rust toolchain");
  const rustupHome =
    process.env.RUSTUP_HOME ??
    (process.env.HOME ? resolve(process.env.HOME, ".rustup") : undefined);
  if (!rustupHome) fail("RUSTUP_HOME cannot be derived without HOME");
  const rustFlags = [
    "--remap-path-prefix=" + resolve(root) + "=/usr/src/lcm",
    "-C",
    "link-arg=-Wl,--build-id=none",
    "-C",
    "strip=symbols",
  ];
  const environment = {
    CARGO_ENCODED_RUSTFLAGS: rustFlags.join("\x1f"),
    CARGO_INCREMENTAL: "0",
    CARGO_NET_OFFLINE: "true",
    LANG: "C",
    LC_ALL: "C",
    PATH: process.env.PATH,
    RUSTUP_HOME: rustupHome,
    SOURCE_DATE_EPOCH: "0",
    ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
    TZ: "UTC",
  };
  const outputAuthority = openDirectoryAuthority(
    root,
    NATIVE_HELPER.outputDirectory,
    "output directory",
    { create: true }
  );
  let targetAuthority;
  let cargoHomeDirectory;
  try {
    invokeOutputHook(outputHooks, "afterOutputAuthorityHeld", outputAuthority);
    cleanupExpectedOutput(outputAuthority);
    assertDirectoryAuthorityIntact(
      outputAuthority,
      "output directory after cleanup"
    );

    targetAuthority = openDirectoryAuthority(
      root,
      "target/daemon-restart-helper",
      "Cargo target directory",
      { create: true }
    );
    cargoHomeDirectory = openOrCreateDirectoryAt(
      targetAuthority.directoryDescriptor,
      "cargo-home",
      "Cargo home",
      0o700
    );
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
    const cargoEnvironment = {
      ...environment,
      CARGO_HOME: "/proc/self/fd/" + CARGO_HOME_DIRECTORY_FD,
      CARGO_TARGET_DIR: "/proc/self/fd/" + CARGO_TARGET_DIRECTORY_FD,
    };
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
      {
        cwd: crate,
        env: cargoEnvironment,
        stdio: [
          "ignore",
          "inherit",
          "inherit",
          targetAuthority.directoryDescriptor,
          cargoHomeDirectory.descriptor,
        ],
      },
      spawn
    );
    closeSync(cargoHomeDirectory.descriptor);
    cargoHomeDirectory = undefined;
    assertDirectoryAuthorityIntact(
      targetAuthority,
      "Cargo target directory after build"
    );

    const cargoTarget = openExistingDirectoryAt(
      targetAuthority.directoryDescriptor,
      NATIVE_HELPER.target,
      "Cargo target output"
    );
    let releaseDirectory;
    let artifact;
    try {
      releaseDirectory = openExistingDirectoryAt(
        cargoTarget.descriptor,
        "release",
        "Cargo release output"
      );
      artifact = readBoundedRegularFile(
        directoryEntryPath(releaseDirectory.descriptor, NATIVE_HELPER.filename),
        {
          label: "Cargo native helper artifact",
          maxBytes: NATIVE_HELPER.maxBinaryBytes,
          requireExecutable: true,
          requireSingleLink: false,
        }
      );
    } finally {
      if (releaseDirectory !== undefined) {
        closeSync(releaseDirectory.descriptor);
      }
      closeSync(cargoTarget.descriptor);
    }

    invokeOutputHook(outputHooks, "beforeOutputPublication", outputAuthority);
    writeExclusiveOutputFile(
      outputAuthority,
      NATIVE_HELPER.filename,
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
    writeExclusiveOutputFile(
      outputAuthority,
      NATIVE_HELPER.manifestFilename,
      canonicalManifest(manifest),
      NATIVE_HELPER.manifestMode
    );
    assertDirectoryAuthorityIntact(
      outputAuthority,
      "output directory after publication"
    );
    return verifyNativeHelperPackageWithAuthority(outputAuthority);
  } finally {
    if (cargoHomeDirectory !== undefined) {
      closeSync(cargoHomeDirectory.descriptor);
    }
    if (targetAuthority !== undefined) {
      closeDirectoryAuthority(targetAuthority);
    }
    closeDirectoryAuthority(outputAuthority);
  }
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
