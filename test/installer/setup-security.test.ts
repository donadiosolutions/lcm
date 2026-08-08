import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];

function fixture(): { root: string; home: string; bin: string } {
  const root = mkdtempSync(join(tmpdir(), "lcm-setup-security-"));
  roots.push(root);
  const home = join(root, "home");
  const bin = join(root, "bin");
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(bin);
  const fakeLcm = join(bin, "lcm");
  writeFileSync(fakeLcm, "#!/usr/bin/env bash\nexit 0\n");
  chmodSync(fakeLcm, 0o755);
  return { root, home, bin };
}

function runSetup(home: string, bin: string, extraEnv: Record<string, string> = {}) {
  return spawnSync("bash", [join(process.cwd(), "installer", "setup.sh")], {
    encoding: "utf-8",
    input: "",
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      ...extraEnv,
    },
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
describe("setup config leaf security", () => {
  it.each(["existing", "dangling"])("rejects an %s config symlink without following it", (kind) => {
    const { root, home, bin } = fixture();
    const configDir = join(home, ".lcm");
    mkdirSync(configDir, { recursive: true });

    const victim = join(root, "victim.json");
    if (kind === "existing") writeFileSync(victim, '{"preserve":true}\n');
    symlinkSync(victim, join(configDir, "config.json"));

    const result = runSetup(home, bin);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("refusing to use symlink config path");
    if (kind === "existing") expect(readFileSync(victim, "utf-8")).toBe('{"preserve":true}\n');
  });

  it("rejects an oversized existing config before parsing it", () => {
    const { home, bin } = fixture();
    const configDir = join(home, ".lcm");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "config.json"), `{"padding":"${"x".repeat(1024 * 1024)}"}\n`);

    const result = runSetup(home, bin);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("exceeds the 1 MiB safety limit");
    expect(result.stderr).not.toContain("invalid JSON");
  });

  it("rejects a group- or world-writable HOME before creating the active root", () => {
    const { home, bin } = fixture();
    chmodSync(home, 0o777);

    const result = runSetup(home, bin);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("HOME must not be group- or world-writable");
    expect(existsSync(join(home, ".lcm"))).toBe(false);
  });

  it("rejects HOME when its owner does not match the current user", () => {
    const { home, bin } = fixture();
    const fakeStat = join(bin, "stat");
    writeFileSync(fakeStat, [
      "#!/usr/bin/env bash",
      "if [ \"$1\" = \"-c\" ] && [ \"$2\" = \"%u\" ]; then echo 99999; else echo 700; fi",
      "",
    ].join("\n"));
    chmodSync(fakeStat, 0o755);

    const result = runSetup(home, bin);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("HOME must be owned by the current user");
    expect(existsSync(join(home, ".lcm"))).toBe(false);
  });

  it("refuses to create an active root while legacy state exists", () => {
    const { home, bin } = fixture();
    mkdirSync(join(home, ".lossless-claude"), { mode: 0o700 });

    const result = runSetup(home, bin);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("legacy LCM state exists");
    expect(result.stderr).toContain("lcm install");
    expect(existsSync(join(home, ".lcm"))).toBe(false);
  });

  it("creates an exact private root and is idempotent on a second run", () => {
    const { home, bin } = fixture();
    const configDir = join(home, ".lcm");

    const first = runSetup(home, bin);
    const second = runSetup(home, bin);

    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    expect(statSync(configDir).mode & 0o777).toBe(0o700);
  });

  it("opens and validates the root and HOME descriptors before config publication", () => {
    const { home, bin } = fixture();
    const logPath = join(home, "node-calls.log");
    writeFileSync(join(bin, "node"), [
      "#!/usr/bin/env bash",
      "if [ \"$1\" = \"-\" ] && [ \"$2\" = \"$HOME/.lcm\" ]; then echo descriptor >> \"$LCM_NODE_LOG\"; fi",
      "exec \"$LCM_REAL_NODE\" \"$@\"",
      "",
    ].join("\n"));
    chmodSync(join(bin, "node"), 0o755);

    const result = runSetup(home, bin, { LCM_NODE_LOG: logPath, LCM_REAL_NODE: process.execPath });

    expect(result.status).toBe(0);
    expect(readFileSync(logPath, "utf-8")).toBe("descriptor\n");
  });

  it("fails closed when durable root validation cannot open or sync its descriptors", () => {
    const { home, bin } = fixture();
    writeFileSync(join(bin, "node"), [
      "#!/usr/bin/env bash",
      "if [ \"$1\" = \"-\" ] && [ \"$2\" = \"$HOME/.lcm\" ]; then echo synthetic-durable-failure >&2; exit 1; fi",
      "exec \"$LCM_REAL_NODE\" \"$@\"",
      "",
    ].join("\n"));
    chmodSync(join(bin, "node"), 0o755);

    const result = runSetup(home, bin, { LCM_REAL_NODE: process.execPath });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("synthetic-durable-failure");
    expect(existsSync(join(home, ".lcm", "config.json"))).toBe(false);
  });
});
