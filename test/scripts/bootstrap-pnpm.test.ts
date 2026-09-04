import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootstrapPnpm, downloadArchive } from "../../scripts/bootstrap-pnpm.mjs";

const execute = promisify(execFile);
const version = "10.34.5";
let root: string;
let destination: string;
let manifestPath: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "bootstrap-pnpm-test-"));
  destination = join(root, "installation");
  manifestPath = join(root, "package.json");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function fixture(options: { metadataVersion?: string; executableVersion?: string; missingLauncher?: boolean } = {}) {
  const packageRoot = join(root, "fixture", "package");
  await mkdir(join(packageRoot, "bin"), { recursive: true });
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "pnpm", version: options.metadataVersion ?? version }));
  if (!options.missingLauncher) {
    const launcher = join(packageRoot, "bin", "pnpm.cjs");
    await writeFile(launcher, `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(require('node:path').join(__dirname, 'executed'), 'yes');
if (process.argv[2] === '--nested') {
  process.stdout.write(require('node:child_process').execFileSync('pnpm', ['--version']));
} else {
  console.log('${options.executableVersion ?? version}');
}
`);
    await chmod(launcher, 0o755);
  }
  const archivePath = join(root, "fixture.tgz");
  await execute("tar", ["-czf", archivePath, "-C", join(root, "fixture"), "package"]);
  const archive = await readFile(archivePath);
  const hash = createHash("sha512").update(archive).digest("hex");
  await writeFile(manifestPath, JSON.stringify({ packageManager: `pnpm@${version}+sha512.${hash}` }));
  return { archive, download: async () => archive };
}

async function absent(path: string) {
  await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
}

describe("bootstrap-pnpm", () => {
  it("returns a private absolute bin directory with a pnpm command usable by nested scripts", async () => {
    const { download } = await fixture();
    const bin = await bootstrapPnpm({ destination, manifestPath }, { download });
    expect(bin).toBe(resolve(destination, "bin"));
    expect((await lstat(destination)).mode & 0o777).toBe(0o700);
    expect((await lstat(join(bin, "pnpm"))).isSymbolicLink()).toBe(true);
    expect(await readFile(join(destination, "package", "bin", "executed"), "utf8")).toBe("yes");
    const nested = await execute(join(bin, "pnpm"), ["--nested"], {
      env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` },
    });
    expect(nested.stdout.trim()).toBe(version);
    await absent(join(destination, "pnpm.tgz"));
  });

  it("downloads only the versioned registry archive read from the manifest pin", async () => {
    const { archive } = await fixture();
    let requestedUrl: string | undefined;
    await bootstrapPnpm({ destination, manifestPath }, {
      download: async (url: string) => { requestedUrl = url; return archive; },
    });
    expect(requestedUrl).toBe(`https://registry.npmjs.org/pnpm/-/pnpm-${version}.tgz`);
  });

  it.each(["pnpm@10.34.5", "npm@10.34.5", `pnpm@latest+sha512.${"a".repeat(128)}`])(
    "rejects a non-exact or missing integrity pin: %s", async (packageManager) => {
      await writeFile(manifestPath, JSON.stringify({ packageManager }));
      await expect(bootstrapPnpm({ destination, manifestPath })).rejects.toThrow("packageManager");
      await absent(destination);
    },
  );

  it("rejects an existing destination without touching its contents", async () => {
    const { download } = await fixture();
    await mkdir(destination);
    await writeFile(join(destination, "keep"), "untouched");
    await expect(bootstrapPnpm({ destination, manifestPath }, { download })).rejects.toThrow("exist");
    expect(await readFile(join(destination, "keep"), "utf8")).toBe("untouched");
  });

  it("rejects a symlink destination without touching its target", async () => {
    const { download } = await fixture();
    await symlink(join(root, "fixture"), destination);
    await expect(bootstrapPnpm({ destination, manifestPath }, { download })).rejects.toThrow("exist");
    expect((await lstat(destination)).isSymbolicLink()).toBe(true);
    expect((await lstat(join(root, "fixture", "package"))).isDirectory()).toBe(true);
  });

  it("rejects the wrong hash before extracting or executing any downloaded code", async () => {
    const { archive } = await fixture();
    let subprocessStarted = false;
    await expect(bootstrapPnpm({ destination, manifestPath }, {
      download: async () => Buffer.concat([archive, Buffer.from("corruption")]),
      run: async () => { subprocessStarted = true; throw new Error("unexpected execution"); },
    })).rejects.toThrow("SHA-512");
    expect(subprocessStarted).toBe(false);
    await absent(destination);
  });

  it("cleans up an incomplete download before extraction or execution", async () => {
    await fixture();
    let subprocessStarted = false;
    await expect(bootstrapPnpm({ destination, manifestPath }, {
      download: async () => { throw new Error("incomplete download"); },
      run: async () => { subprocessStarted = true; },
    })).rejects.toThrow("incomplete download");
    expect(subprocessStarted).toBe(false);
    await absent(destination);
  });

  it("cleans up extraction failures without invoking the manager", async () => {
    const { download } = await fixture();
    const commands: string[] = [];
    await expect(bootstrapPnpm({ destination, manifestPath }, {
      download,
      run: async (command: string) => { commands.push(command); throw new Error("tar failed"); },
    })).rejects.toThrow("tar failed");
    expect(commands).toEqual(["tar"]);
    await absent(destination);
  });

  it("rejects a package metadata version mismatch before executing its launcher", async () => {
    const { download } = await fixture({ metadataVersion: "10.34.4" });
    const commands: string[] = [];
    await expect(bootstrapPnpm({ destination, manifestPath }, {
      download,
      run: async (command: string, args: string[], options: object) => {
        commands.push(command);
        return execute(command, args, options);
      },
    })).rejects.toThrow("version");
    expect(commands).toEqual(["tar"]);
    await absent(destination);
  });

  it("rejects a missing launcher and removes the failed destination", async () => {
    const { download } = await fixture({ missingLauncher: true });
    await expect(bootstrapPnpm({ destination, manifestPath }, { download })).rejects.toThrow();
    await absent(destination);
  });

  it("checks the executable's actual version before publishing a bin directory", async () => {
    const { download } = await fixture({ executableVersion: "10.34.4" });
    await expect(bootstrapPnpm({ destination, manifestPath }, { download })).rejects.toThrow("version");
    await absent(destination);
  });

  it("prints diagnostics only to stderr on invalid CLI arguments", async () => {
    try {
      await execute(process.execPath, [resolve("scripts/bootstrap-pnpm.mjs"), "--destination"]);
      expect.fail("invalid arguments must fail");
    } catch (error) {
      expect(error).toMatchObject({ code: 1, stdout: "" });
      expect((error as { stderr: string }).stderr).toContain("--destination");
    }
  });
});

describe("bounded pnpm download", () => {
  it("reads a complete response with a bounded deadline and no redirects", async () => {
    let options: RequestInit | undefined;
    const archive = await downloadArchive("https://registry.npmjs.org/example", {
      fetch: async (_url: string, init: RequestInit) => {
        options = init;
        return new Response("archive", { headers: { "content-length": "7" } });
      },
    });
    expect(archive.toString()).toBe("archive");
    expect(options?.redirect).toBe("error");
    expect(options?.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([404, 500])("rejects HTTP %i", async (status) => {
    await expect(downloadArchive("https://registry.npmjs.org/example", {
      fetch: async () => new Response("failure", { status }),
    })).rejects.toThrow(`HTTP ${status}`);
  });

  it("rejects a truncated response", async () => {
    await expect(downloadArchive("https://registry.npmjs.org/example", {
      fetch: async () => new Response("partial", { headers: { "content-length": "100" } }),
    })).rejects.toThrow("incomplete");
  });

  it("rejects oversized responses before reading their body", async () => {
    await expect(downloadArchive("https://registry.npmjs.org/example", {
      fetch: async () => new Response("oversized", { headers: { "content-length": "100" } }),
      maxBytes: 4,
    })).rejects.toThrow("size limit");
  });

  it("bounds streamed bytes even when content-length is absent", async () => {
    await expect(downloadArchive("https://registry.npmjs.org/example", {
      fetch: async () => new Response("oversized"), maxBytes: 4,
    })).rejects.toThrow("size limit");
  });

  it("rejects an empty archive", async () => {
    await expect(downloadArchive("https://registry.npmjs.org/example", {
      fetch: async () => new Response(""),
    })).rejects.toThrow("empty");
  });

  it("aborts a stalled request at the deadline", async () => {
    await expect(downloadArchive("https://registry.npmjs.org/example", {
      timeoutMs: 5,
      fetch: async (_url: string, { signal }: RequestInit) => new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
    })).rejects.toThrow();
  });
});
