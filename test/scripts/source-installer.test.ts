import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import pkg from "../../package.json";

const installer = resolve("install.sh");
const packagedEntrypoint = "dist/lcm.mjs";
let root: string;
let home: string;
let checkout: string;
let bin: string;
let log: string;

function executable(name: string, body: string): void {
  writeFileSync(join(bin, name), `#!/bin/sh\nset -eu\n${body}\n`, { mode: 0o755 });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lcm-source-installer-"));
  home = join(root, "home");
  checkout = join(root, "source checkout");
  bin = join(root, "bin");
  log = join(root, "commands");
  for (const path of [home, bin, join(root, "tmp")]) mkdirSync(path);
  writeFileSync(log, "");
  executable("git", `
    printf 'git:%s\\n' "$*" >> "$FIXTURE_LOG"
    if [ "$1" = clone ]; then mkdir -p "$3/.git"; fi
  `);
  executable("node", `
    if [ "$1" = scripts/bootstrap-pnpm.mjs ]; then
      [ "$#" -eq 3 ] && [ "$2" = --destination ]
      [ -d "$(dirname "$3")" ] && [ ! -e "$3" ]
      case "$3" in /*/verified) ;; *) exit 92;; esac
      printf 'bootstrap\\n' >> "$FIXTURE_LOG"
      if [ "$FIXTURE_FAILURE" = bootstrap ]; then exit 31; fi
      mkdir -p "$3/bin"
      cp "$FIXTURE_PNPM" "$3/bin/pnpm"
      printf '%s/bin\\n' "$3"
    else
      [ "$1" = "$LCM_DIR/dist/lcm.mjs" ]
      shift
      printf 'runtime-argc:%s\\n' "$#" >> "$FIXTURE_LOG"
      for argument in "$@"; do printf 'runtime-arg:%s\\n' "$argument" >> "$FIXTURE_LOG"; done
    fi
  `);
  executable("verified-pnpm", `
    printf 'pnpm:%s\\n' "$*" >> "$FIXTURE_LOG"
    case "$*" in
      'install --frozen-lockfile')
        if [ "$FIXTURE_FAILURE" = install ]; then exit 32; fi;;
      'run build')
        if [ "$FIXTURE_FAILURE" = build ]; then exit 33; fi
        case "$FIXTURE_FAILURE" in
          missing-output) ;;
          legacy-only)
            mkdir -p dist/bin
            printf '// legacy fixture output\\n' > dist/bin/lcm.js;;
          *)
            mkdir -p dist
            printf '// bundled fixture output\\n' > dist/lcm.mjs;;
        esac;;
      *) exit 93;;
    esac
  `);
  for (const name of ["npm", "pnpm", "npx", "lcm"]) {
    executable(name, `printf 'unexpected:${name}\\n' >> "$FIXTURE_LOG"; exit 94`);
  }
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function run(failure = "") {
  return spawnSync("/bin/bash", [installer], {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000,
    // Deliberately omit the host environment and its credentials/configuration.
    env: {
      HOME: home,
      SHELL: "/bin/bash",
      PATH: `${bin}:/usr/bin:/bin`,
      TMPDIR: join(root, "tmp"),
      LCM_DIR: checkout,
      FIXTURE_LOG: log,
      FIXTURE_PNPM: join(bin, "verified-pnpm"),
      FIXTURE_FAILURE: failure,
    },
  });
}

function commands(): string[] {
  return readFileSync(log, "utf8").trim().split("\n");
}

describe("source-clone installer", () => {
  it("bootstraps private pnpm, builds the packaged runtime, and retains the Node launcher", () => {
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    expect(commands()).toEqual([
      `git:clone https://github.com/donadiosolutions/lcm.git ${checkout}`,
      "bootstrap",
      "pnpm:install --frozen-lockfile",
      "pnpm:run build",
      "runtime-argc:1",
      "runtime-arg:install",
    ]);
    expect(pkg.bin).toHaveProperty("lcm", packagedEntrypoint);
    expect(readFileSync(join(home, ".npm-global/bin/lcm"), "utf8"))
      .toBe(`#!/bin/sh\nexec node "${join(checkout, pkg.bin.lcm)}" "$@"\n`);
    expect(readdirSync(join(root, "tmp"))).toEqual([]);
  });

  it("preserves wrapper argument boundaries through the packaged runtime", () => {
    expect(run().status).toBe(0);
    const wrapper = join(home, ".npm-global/bin/lcm");
    const result = spawnSync(wrapper, ["arg with spaces", "", "final"], {
      cwd: root,
      encoding: "utf8",
      env: {
        HOME: home,
        PATH: `${bin}:/usr/bin:/bin`,
        LCM_DIR: checkout,
        FIXTURE_LOG: log,
      },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(commands().slice(-4)).toEqual([
      "runtime-argc:3",
      "runtime-arg:arg with spaces",
      "runtime-arg:",
      "runtime-arg:final",
    ]);
  });

  it("updates existing clones and keeps shell configuration idempotent", () => {
    mkdirSync(join(checkout, ".git"), { recursive: true });
    expect(run().status).toBe(0);
    expect(run().status).toBe(0);
    expect(commands()[0]).toBe(`git:-C ${checkout} pull --ff-only`);
    expect(readFileSync(join(home, ".bash_profile"), "utf8").match(/# lcm/g)).toHaveLength(1);
    expect(readdirSync(join(root, "tmp"))).toEqual([]);
  });

  it.each([
    ["bootstrap", 31, ["bootstrap"]],
    ["install", 32, ["bootstrap", "pnpm:install --frozen-lockfile"]],
    ["build", 33, ["bootstrap", "pnpm:install --frozen-lockfile", "pnpm:run build"]],
    ["missing-output", 1, ["bootstrap", "pnpm:install --frozen-lockfile", "pnpm:run build"]],
    ["legacy-only", 1, ["bootstrap", "pnpm:install --frozen-lockfile", "pnpm:run build"]],
  ])("stops after %s failure without installing a launcher", (failure, status, expected) => {
    const result = run(failure as string);
    expect(result.status, result.stderr).toBe(status);
    expect(commands().slice(1)).toEqual(expected);
    if (failure === "missing-output" || failure === "legacy-only") {
      expect(result.stderr).toContain("dist/lcm.mjs not found");
    }
    expect(existsSync(join(home, ".npm-global/bin/lcm"))).toBe(false);
    expect(readdirSync(join(root, "tmp"))).toEqual([]);
  });
});
