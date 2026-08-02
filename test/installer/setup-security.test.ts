import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setupFakeLcm(root: string): { bin: string; calls: string } {
  const bin = join(root, "bin");
  const calls = join(root, "calls.log");
  const fakeLcm = join(bin, "lcm");
  spawnSync("mkdir", ["-p", bin], { stdio: "ignore" });
  writeFileSync(fakeLcm, `#!/usr/bin/env bash
set -euo pipefail
{
  echo CALL
  for arg in "$@"; do printf 'ARG=%s\\n' "$arg"; done
} >> "$LCM_CALL_LOG"
if [ "\${1:-}" = config ] && [ "\${LCM_CONFIG_REJECTION:-}" != "" ]; then
  echo "$LCM_CONFIG_REJECTION" >&2
  exit 1
fi
exit 0
`);
  chmodSync(fakeLcm, 0o755);
  return { bin, calls };
}

function runSetup(root: string, rejection?: string) {
  const home = join(root, "home");
  const { bin, calls } = setupFakeLcm(root);
  const result = spawnSync("bash", [join(process.cwd(), "installer", "setup.sh")], {
    encoding: "utf-8",
    input: "",
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      LCM_CALL_LOG: calls,
      ...(rejection === undefined ? {} : { LCM_CONFIG_REJECTION: rejection }),
    },
  });
  return { result, calls: readFileSync(calls, "utf8") };
}

describe("setup guarded config delegation", () => {
  it("delegates one complete llm object before install and doctor", () => {
    const root = mkdtempSync(join(tmpdir(), "lcm-setup-delegation-"));
    roots.push(root);

    const { result, calls } = runSetup(root);

    expect(result.status).toBe(0);
    expect(calls).toBe([
      "CALL", "ARG=config", "ARG=set", "ARG=llm", 'ARG={"provider":"auto"}', "ARG=--json",
      "CALL", "ARG=install",
      "CALL", "ARG=doctor",
      "",
    ].join("\n"));
  });

  it.each([
    "refusing to use a symlink config path",
    "file exceeds the configured size limit",
    "PostgreSQL selection has no completed backend publication evidence",
  ])("propagates common config rejection without reaching install or doctor: %s", (rejection) => {
    const root = mkdtempSync(join(tmpdir(), "lcm-setup-rejection-"));
    roots.push(root);
    const victim = join(root, "victim.json");
    writeFileSync(victim, '{"preserve":true}\n');

    const { result, calls } = runSetup(root, rejection);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(rejection);
    expect(calls).toBe([
      "CALL", "ARG=config", "ARG=set", "ARG=llm", 'ARG={"provider":"auto"}', "ARG=--json", "",
    ].join("\n"));
    expect(readFileSync(victim, "utf8")).toBe('{"preserve":true}\n');
  });
});
