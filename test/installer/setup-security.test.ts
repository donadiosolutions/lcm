import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("setup config leaf security", () => {
  it.each(["existing", "dangling"])("rejects an %s config symlink without following it", (kind) => {
    const root = mkdtempSync(join(tmpdir(), "lcm-setup-security-"));
    roots.push(root);
    const home = join(root, "home");
    const bin = join(root, "bin");
    const configDir = join(home, ".lcm");
    mkdirSync(configDir, { recursive: true });
    mkdirSync(bin);
    const fakeLcm = join(bin, "lcm");
    writeFileSync(fakeLcm, "#!/usr/bin/env bash\nexit 0\n");
    chmodSync(fakeLcm, 0o755);

    const victim = join(root, "victim.json");
    if (kind === "existing") writeFileSync(victim, '{"preserve":true}\n');
    symlinkSync(victim, join(configDir, "config.json"));

    const result = spawnSync("bash", [join(process.cwd(), "installer", "setup.sh")], {
      encoding: "utf-8",
      input: "",
      env: { ...process.env, HOME: home, USERPROFILE: home, PATH: `${bin}:${process.env.PATH ?? ""}` },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("refusing to use symlink config path");
    if (kind === "existing") expect(readFileSync(victim, "utf-8")).toBe('{"preserve":true}\n');
  });

  it("rejects an oversized existing config before parsing it", () => {
    const root = mkdtempSync(join(tmpdir(), "lcm-setup-security-"));
    roots.push(root);
    const home = join(root, "home");
    const bin = join(root, "bin");
    const configDir = join(home, ".lcm");
    mkdirSync(configDir, { recursive: true });
    mkdirSync(bin);
    const fakeLcm = join(bin, "lcm");
    writeFileSync(fakeLcm, "#!/usr/bin/env bash\nexit 0\n");
    chmodSync(fakeLcm, 0o755);
    writeFileSync(join(configDir, "config.json"), `{"padding":"${"x".repeat(1024 * 1024)}"}\n`);

    const result = spawnSync("bash", [join(process.cwd(), "installer", "setup.sh")], {
      encoding: "utf-8",
      input: "",
      env: { ...process.env, HOME: home, USERPROFILE: home, PATH: `${bin}:${process.env.PATH ?? ""}` },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Failed to parse existing config");
  });
});
