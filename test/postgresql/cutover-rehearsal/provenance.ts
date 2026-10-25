import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The two files commit B may change; they are excluded from the tested-input digest. */
export const GATE_FILES = ["docs/migration-rehearsal-gate.md", "docs/migration-rehearsal-gate.json"] as const;

const sha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
const git = (root: string, ...args: string[]): string => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

export interface Provenance {
  readonly testedCommit: string;
  readonly dirty: boolean;
  readonly testedInputsSha256: string;
  readonly testedInputsCount: number;
  readonly lockfileSha256: string;
  readonly cliSha256: string;
  readonly node: string;
}

/** SHA-256 over the sorted tracked paths (minus the gate files), each fed as path NUL bytes NUL. */
export function testedInputs(root: string): { readonly sha256: string; readonly count: number } {
  const paths = git(root, "ls-files", "-z").split("\0").filter((path) => path !== "" && !(GATE_FILES as readonly string[]).includes(path)).sort();
  const hash = createHash("sha256");
  for (const path of paths) {
    hash.update(path);
    hash.update("\0");
    hash.update(readFileSync(join(root, path)));
    hash.update("\0");
  }
  return { sha256: hash.digest("hex"), count: paths.length };
}

/** The tested commit, whether tracked or untracked content differs from it, the input digest and the built CLI digest. */
export function captureProvenance(root: string): Provenance {
  const inputs = testedInputs(root);
  return {
    testedCommit: git(root, "rev-parse", "HEAD").trim(),
    dirty: git(root, "status", "--porcelain").trim() !== "",
    testedInputsSha256: inputs.sha256, testedInputsCount: inputs.count,
    lockfileSha256: sha256(readFileSync(join(root, "pnpm-lock.yaml"))),
    cliSha256: sha256(readFileSync(join(root, "dist/lcm.mjs"))),
    node: process.version,
  };
}

