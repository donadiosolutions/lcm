import { execFileSync, spawnSync } from "node:child_process";
import { lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  NATIVE_HELPER,
  cargoExecutablePath,
} from "../../scripts/package-daemon-restart-helper.mjs";

const repoRoot = resolve(import.meta.dirname, "../..");
const crateManifest = resolve(
  repoRoot,
  NATIVE_HELPER.crateDirectory,
  "Cargo.toml"
);
const hostTarget = "x86_64-unknown-linux-gnu";
const cleanup: string[] = [];

afterEach(() => {
  for (const path of cleanup.splice(0))
    rmSync(path, { force: true, recursive: true });
});

describe("daemon restart helper real Cargo contract", () => {
  const canBuildHostHelper =
    process.platform === "linux" && process.arch === "x64";
  const cargoTest = canBuildHostHelper ? it : it.skip;

  cargoTest(
    "emits the canonical executable name without tracking generated helper output",
    () => {
      const targetDirectory = mkdtempSync(
        join(tmpdir(), "daemon-restart-helper-cargo-")
      );
      cleanup.push(targetDirectory);

      execFileSync(
        "cargo",
        [
          "build",
          "--locked",
          "--offline",
          "--release",
          "--target",
          hostTarget,
          "--target-dir",
          targetDirectory,
          "--manifest-path",
          crateManifest,
        ],
        {
          cwd: repoRoot,
          env: {
            ...process.env,
            RUSTUP_TOOLCHAIN: "1.93.0-x86_64-unknown-linux-gnu",
          },
          stdio: "pipe",
          timeout: 60_000,
        }
      );

      const executable = cargoExecutablePath(targetDirectory, hostTarget);
      const stat = lstatSync(executable);
      expect(stat.isFile()).toBe(true);
      expect(stat.isSymbolicLink()).toBe(false);
      expect(stat.mode & 0o111).not.toBe(0);
      expect(readFileSync(executable).subarray(0, 4)).toEqual(
        Buffer.from([0x7f, 0x45, 0x4c, 0x46])
      );

      const tracked = execFileSync("git", ["ls-files", "-z"], {
        cwd: repoRoot,
        encoding: "buffer",
      })
        .toString("utf8")
        .split("\0")
        .filter(Boolean);
      const compiledHelper = tracked.filter(
        (path) =>
          /^native\/daemon-restart-helper\/(?:target\/|.*\.(?:a|dll|dylib|o|rlib|rmeta|so))$/u.test(
            path
          ) ||
          /^target\/daemon-restart-helper\//u.test(path) ||
          /^dist\/native\/linux-x64\/(?:daemon-restart-helper|daemon-restart-helper\.manifest\.json)$/u.test(
            path
          )
      );
      expect(compiledHelper).toEqual([]);

      const ignored = spawnSync(
        "git",
        [
          "check-ignore",
          "-q",
          "target/daemon-restart-helper/cargo-home/config.toml",
        ],
        { cwd: repoRoot }
      );
      expect(ignored.status).toBe(0);
    },
    60_000
  );
});
