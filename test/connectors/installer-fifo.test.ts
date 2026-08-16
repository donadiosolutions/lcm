import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("connector installer FIFO safety", () => {
  it.runIf(process.platform === "linux")("rejects a FIFO without blocking the public installer API", async () => {
    const root = mkdtempSync(join(tmpdir(), "lcm-installer-fifo-"));
    roots.push(root);
    const skillPath = join(root, ".claude", "skills", "lcm-memory", "SKILL.md");
    mkdirSync(dirname(skillPath), { recursive: true });
    execFileSync("mkfifo", [skillPath]);

    const installerUrl = pathToFileURL(resolve("src/connectors/installer.ts")).href;
    const childSource = [
      `import { installConnector } from ${JSON.stringify(installerUrl)};`,
      `const root = ${JSON.stringify(root)};`,
      "try {",
      '  installConnector("claude-code", "skill", root);',
      "  process.exitCode = 1;",
      "} catch (error) {",
      "  process.exitCode = error instanceof Error && error.message.includes(\"Unable to inspect LCM skill\") ? 0 : 1;",
      "}",
    ].join("\n");
    const sourceLoader = `data:text/javascript,${encodeURIComponent([
      "export async function resolve(specifier, context, nextResolve) {",
      "  if (specifier.endsWith('.js')) return nextResolve(specifier.slice(0, -3) + '.ts', context);",
      "  return nextResolve(specifier, context);",
      "}",
    ].join("\n"))}`;
    const child = spawn(process.execPath, [
      "--experimental-transform-types",
      "--loader",
      sourceLoader,
      "--input-type=module",
      "--eval",
      childSource,
    ]);
    const result = await new Promise<number>((resolveResult, reject) => {
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        try {
          child.kill("SIGKILL");
        } catch {
          // The close handler still reports the timeout after an exit race.
        }
      }, 1_000);
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once("close", (code, signal) => {
        clearTimeout(timeout);
        if (timedOut) {
          reject(new Error("FIFO regression child timed out"));
          return;
        }
        if (signal !== null) {
          reject(new Error(`FIFO regression child exited from signal ${signal}`));
          return;
        }
        if (code === null) {
          reject(new Error("FIFO regression child exited without a status"));
          return;
        }
        resolveResult(code);
      });
    });

    expect(result).toBe(0);
  });
});
