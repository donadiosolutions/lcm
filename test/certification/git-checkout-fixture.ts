import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A committed Git checkout in the worker temporary directory with the layout that
// execution provenance hashes: tracked inputs, pnpm-lock.yaml, and a CLI bundle under
// an ignored dist/. Tests use it instead of the repository root, whose dist/ is
// gitignored and absent from unbuilt unit shards.
export function createGitCheckoutFixture(): { root: string; head: string; cli: string; lockfile: string } {
  const root = mkdtempSync(join(tmpdir(), "lcm-cert-checkout-"));
  const git = (...args: string[]): string => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const cli = "#!/usr/bin/env node\n// certification fixture CLI bundle\n";
  const lockfile = "lockfileVersion: '9.0'\n";
  git("init", "-q");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "LCM Test");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(root, ".gitignore"), "dist/\n");
  writeFileSync(join(root, "pnpm-lock.yaml"), lockfile);
  writeFileSync(join(root, "input.mjs"), "export const input = 1;\n");
  mkdirSync(join(root, "dist"));
  writeFileSync(join(root, "dist", "lcm.mjs"), cli);
  git("add", ".");
  git("commit", "-q", "--no-verify", "-m", "certification fixture");
  return { root, head: git("rev-parse", "HEAD").trim(), cli, lockfile };
}
