import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import pkg from "../../package.json";
import {
  NATIVE_HELPER,
  assertStaticLinuxX64Elf,
  buildNativeHelperPackage,
  cargoExecutablePath,
  canonicalManifest,
  directoryEntryPath,
  parseCompilerEvidence,
  runNativeHelperPackageCli,
  verifyNativeHelperPackage,
} from "../../scripts/package-daemon-restart-helper.mjs";

const RUSTC = `rustc 1.93.0 (254b59607 2026-01-19)
binary: rustc
commit-hash: 254b59607d4417e9dffbc307138ae5c86280fe4c
commit-date: 2026-01-19
host: x86_64-unknown-linux-gnu
release: 1.93.0
LLVM version: 21.1.8
`;
const CARGO = `cargo 1.93.0 (083ac5135 2025-12-15)
release: 1.93.0
commit-hash: 083ac5135f967fd9dc906ab057a2315861c7a80d
commit-date: 2025-12-15
host: x86_64-unknown-linux-gnu
`;

const cleanup: string[] = [];

afterEach(() => {
  for (const path of cleanup.splice(0))
    rmSync(path, { force: true, recursive: true });
});

function staticElf(): Buffer {
  const bytes = Buffer.alloc(120);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
  bytes.writeUInt16LE(2, 16);
  bytes.writeUInt16LE(0x3e, 18);
  bytes.writeUInt32LE(1, 20);
  bytes.writeBigUInt64LE(64n, 32);
  bytes.writeUInt16LE(64, 52);
  bytes.writeUInt16LE(56, 54);
  bytes.writeUInt16LE(1, 56);
  bytes.writeUInt32LE(1, 64);
  return bytes;
}

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "daemon-helper-package-"));
  cleanup.push(root);
  const crate = resolve(root, NATIVE_HELPER.crateDirectory);
  mkdirSync(crate, { recursive: true });
  writeFileSync(
    resolve(crate, "Cargo.toml"),
    "[package]\nname='daemon-restart-helper'\nversion='0.0.0'\n"
  );
  writeFileSync(resolve(crate, "Cargo.lock"), "version = 4\n");
  return root;
}

function successfulSpawn(binary = staticElf()) {
  return vi.fn(
    (command: string, args: string[], options: Record<string, unknown>) => {
      if (args[0] === "--version") {
        return {
          error: undefined,
          signal: null,
          status: 0,
          stderr: "",
          stdout: command === "rustc" ? RUSTC : CARGO,
        };
      }
      expect(command).toBe("cargo");
      expect(args).toEqual([
        "build",
        "--locked",
        "--offline",
        "--release",
        "--target",
        "x86_64-unknown-linux-musl",
        "--manifest-path",
        expect.stringMatching(/native\/daemon-restart-helper\/Cargo\.toml$/u),
      ]);
      const environment = options.env as Record<string, string>;
      expect(environment.CARGO_INCREMENTAL).toBe("0");
      expect(environment.SOURCE_DATE_EPOCH).toBe("0");
      expect(environment.CARGO_ENCODED_RUSTFLAGS).toContain("--build-id=none");
      expect(environment).not.toHaveProperty("RUSTFLAGS");
      expect(environment.CARGO_TARGET_DIR).toBe("/proc/self/fd/3");
      expect(environment.CARGO_HOME).toBe("/proc/self/fd/4");
      const stdio = options.stdio as unknown[];
      expect(stdio).toEqual([
        "ignore",
        "inherit",
        "inherit",
        expect.any(Number),
        expect.any(Number),
      ]);
      const artifact = resolve(
        directoryEntryPath(stdio[3] as number, NATIVE_HELPER.target),
        "release",
        NATIVE_HELPER.filename
      );
      mkdirSync(dirname(artifact), { recursive: true });
      writeFileSync(artifact, binary, { mode: NATIVE_HELPER.binaryMode });
      return { error: undefined, signal: null, status: 0 };
    }
  );
}

describe("daemon restart helper package", () => {
  it("wires deterministic build and verification into the npm build lifecycle", () => {
    expect(pkg.scripts).toHaveProperty(
      "build:native-helper",
      "node scripts/package-daemon-restart-helper.mjs build"
    );
    expect(pkg.scripts).toHaveProperty(
      "verify:native-helper",
      "node scripts/package-daemon-restart-helper.mjs verify"
    );
    expect(pkg.scripts.postbuild).toContain("npm run build:native-helper");
    expect(pkg.scripts.postbuild).toContain("npm run verify:native-helper");
    expect(pkg.scripts["release:verify"]).toContain(
      "npm run verify:native-helper && npm pack --dry-run"
    );
    expect(pkg.files).toContain("dist/");
    expect(pkg.scripts).not.toHaveProperty("prepack");
  });

  it("builds twice to identical bounded canonical package bytes", () => {
    const root = fixtureRoot();
    const spawn = successfulSpawn();
    const first = buildNativeHelperPackage({ root, spawn });
    const firstManifest = readFileSync(first.manifestPath);
    const firstHelper = readFileSync(first.helperPath);

    const second = buildNativeHelperPackage({ root, spawn });
    expect(readFileSync(second.manifestPath)).toEqual(firstManifest);
    expect(readFileSync(second.helperPath)).toEqual(firstHelper);
    expect(second.manifest).toMatchObject({
      filename: NATIVE_HELPER.filename,
      formatVersion: 1,
      mode: "0755",
      size: firstHelper.length,
      target: NATIVE_HELPER.target,
    });
    expect(second.manifest.sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(second.manifestSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(spawn).toHaveBeenCalledTimes(6);
  });

  it("uses expected-only cleanup instead of recursively deleting output", () => {
    const root = fixtureRoot();
    const output = resolve(root, NATIVE_HELPER.outputDirectory);
    mkdirSync(output, { recursive: true });
    const unexpected = resolve(output, "unrelated-output");
    writeFileSync(unexpected, "must-survive");
    const spawn = successfulSpawn();

    expect(() => buildNativeHelperPackage({ root, spawn })).toThrow(
      "output directory contains an unexpected entry"
    );
    expect(readFileSync(unexpected, "utf8")).toBe("must-survive");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("fails closed when an intermediate output parent is replaced by a symlink", () => {
    const root = fixtureRoot();
    const replacement = mkdtempSync(join(tmpdir(), "daemon-helper-target-"));
    cleanup.push(replacement);
    const sentinel = resolve(replacement, "sentinel");
    writeFileSync(sentinel, "must-survive");
    const spawn = successfulSpawn();

    expect(() =>
      buildNativeHelperPackage({
        root,
        spawn,
        outputHooks: {
          afterOutputAuthorityHeld: ({ outputDirectory }) => {
            const replacedParent = dirname(outputDirectory);
            renameSync(replacedParent, resolve(root, "held-native"));
            symlinkSync(replacement, replacedParent);
          },
        },
      })
    ).toThrow("output directory after cleanup component native");
    expect(spawn).not.toHaveBeenCalled();
    expect(readdirSync(replacement)).toEqual(["sentinel"]);
    expect(readFileSync(sentinel, "utf8")).toBe("must-survive");
  });

  it("fails closed during verification when an output parent is replaced", () => {
    const root = fixtureRoot();
    buildNativeHelperPackage({ root, spawn: successfulSpawn() });
    const replacement = mkdtempSync(join(tmpdir(), "daemon-helper-target-"));
    cleanup.push(replacement);
    const sentinel = resolve(replacement, "sentinel");
    writeFileSync(sentinel, "must-survive");

    expect(() =>
      verifyNativeHelperPackage({
        root,
        outputHooks: {
          afterVerificationAuthorityHeld: ({ outputDirectory }) => {
            const replacedParent = dirname(outputDirectory);
            renameSync(replacedParent, resolve(root, "held-native"));
            symlinkSync(replacement, replacedParent);
          },
        },
      })
    ).toThrow("output directory before verification component native");
    expect(readdirSync(replacement)).toEqual(["sentinel"]);
    expect(readFileSync(sentinel, "utf8")).toBe("must-survive");
  });

  it("does not overwrite a leaf created after cleanup", () => {
    const root = fixtureRoot();
    const contested = resolve(
      root,
      NATIVE_HELPER.outputDirectory,
      NATIVE_HELPER.filename
    );

    expect(() =>
      buildNativeHelperPackage({
        root,
        spawn: successfulSpawn(),
        outputHooks: {
          beforeOutputPublication: () => {
            writeFileSync(contested, "attacker-owned");
          },
        },
      })
    ).toThrow("cannot be published exclusively");
    expect(readFileSync(contested, "utf8")).toBe("attacker-owned");
  });

  it("rechecks the held output identity after publication", () => {
    const root = fixtureRoot();
    const replacement = resolve(root, "replacement-native");
    mkdirSync(replacement);
    const sentinel = resolve(replacement, "sentinel");
    writeFileSync(sentinel, "must-survive");
    const replacedParent = resolve(root, "dist", "native");

    expect(() =>
      buildNativeHelperPackage({
        root,
        spawn: successfulSpawn(),
        outputHooks: {
          beforeOutputPublication: () => {
            renameSync(replacedParent, resolve(root, "held-native"));
            renameSync(replacement, replacedParent);
          },
        },
      })
    ).toThrow(
      "output directory after publication component native identity changed"
    );
    expect(readdirSync(replacedParent)).toEqual(["sentinel"]);
    expect(readFileSync(resolve(replacedParent, "sentinel"), "utf8")).toBe(
      "must-survive"
    );
  });

  it("fails closed for toolchain drift, Cargo failure, and unsupported hosts", () => {
    const root = fixtureRoot();
    const wrongRustc = successfulSpawn();
    wrongRustc.mockImplementationOnce(() => ({
      error: undefined,
      signal: null,
      status: 0,
      stderr: "",
      stdout: RUSTC.replace("release: 1.93.0", "release: 1.92.0"),
    }));
    expect(() => buildNativeHelperPackage({ root, spawn: wrongRustc })).toThrow(
      "rustc is not the pinned 1.93.0 compiler"
    );

    const failedCargo = successfulSpawn();
    failedCargo.mockImplementationOnce(failedCargo.getMockImplementation()!);
    failedCargo.mockImplementationOnce(failedCargo.getMockImplementation()!);
    failedCargo.mockImplementationOnce(() => ({
      error: undefined,
      signal: "SIGKILL",
      status: null,
    }));
    expect(() =>
      buildNativeHelperPackage({ root, spawn: failedCargo })
    ).toThrow("cargo was terminated by signal SIGKILL");
    expect(() =>
      buildNativeHelperPackage({
        root,
        spawn: successfulSpawn(),
        platform: "darwin",
      })
    ).toThrow("build requires Linux x64");
  });

  it("rejects tampering, symlinks, surplus output, and non-static ELF files", () => {
    const root = fixtureRoot();
    const result = buildNativeHelperPackage({ root, spawn: successfulSpawn() });
    const output = dirname(result.helperPath);

    const tampered = readFileSync(result.helperPath);
    tampered[tampered.length - 1] ^= 1;
    writeFileSync(result.helperPath, tampered, {
      mode: NATIVE_HELPER.binaryMode,
    });
    expect(() => verifyNativeHelperPackage({ root })).toThrow(
      "digest does not match manifest"
    );

    writeFileSync(result.helperPath, staticElf(), {
      mode: NATIVE_HELPER.binaryMode,
    });
    writeFileSync(resolve(output, "unexpected"), "x");
    expect(() => verifyNativeHelperPackage({ root })).toThrow(
      "output directory contains an unexpected entry"
    );
    unlinkSync(resolve(output, "unexpected"));

    const manifestBytes = readFileSync(result.manifestPath);
    unlinkSync(result.manifestPath);
    const manifestTarget = resolve(root, "manifest-target");
    writeFileSync(manifestTarget, manifestBytes, {
      mode: NATIVE_HELPER.manifestMode,
    });
    symlinkSync(relative(output, manifestTarget), result.manifestPath);
    expect(() => verifyNativeHelperPackage({ root })).toThrow();

    const dynamic = staticElf();
    dynamic.writeUInt32LE(3, 64);
    expect(() => assertStaticLinuxX64Elf(dynamic)).toThrow(
      "dynamic interpreter"
    );
    expect(() => assertStaticLinuxX64Elf(Buffer.from("not-elf"))).toThrow(
      "not a 64-bit"
    );
  });

  it("requires canonical manifest fields and exact CLI commands", () => {
    const compiler = parseCompilerEvidence(RUSTC, CARGO);
    const manifest = {
      formatVersion: 1,
      filename: NATIVE_HELPER.filename,
      target: NATIVE_HELPER.target,
      compiler,
      mode: "0755",
      size: 120,
      sha256: "a".repeat(64),
    };
    expect(canonicalManifest(manifest).toString("utf8")).toBe(
      `${JSON.stringify(manifest)}\n`
    );
    expect(() => canonicalManifest({ ...manifest, extra: true })).toThrow(
      "manifest fields are not canonical"
    );
    expect(() => runNativeHelperPackageCli([])).toThrow(
      "expected exactly one command"
    );
    expect(() => runNativeHelperPackageCli(["other"])).toThrow(
      "expected exactly one command"
    );
    expect(cargoExecutablePath("/tmp/target", "x86_64-unknown-linux-gnu")).toBe(
      "/tmp/target/x86_64-unknown-linux-gnu/release/daemon-restart-helper"
    );
    expect(() => cargoExecutablePath("/tmp/target", "../host")).toThrow(
      "Cargo target is not a canonical target triple"
    );
    expect(directoryEntryPath(0, "component")).toBe(
      "/proc/self/fd/0/component"
    );
    expect(() => directoryEntryPath(0, "../escape")).toThrow(
      "single safe component"
    );
  });
});
