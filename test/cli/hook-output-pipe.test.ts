import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeHookOutput } from "../../src/cli/hook-output.js";

// #1636: a real OS pipe whose reader is slower than the writer. Without the
// helper the child's exit() discards the output still queued in the pipe.
const OUTPUT_BYTES = 4 * 1024 * 1024;
const CHILD_DEADLINE_MS = 20_000;
const READER_DELAY_MS = 300;

let directory: string;
let withHelper: string;
let withoutHelper: string;

function bundle(contents: string, outfile: string): void {
  buildSync({
    stdin: { contents, resolveDir: fileURLToPath(new URL("../..", import.meta.url)), loader: "ts" },
    bundle: true,
    platform: "node",
    format: "esm",
    outfile,
    logLevel: "silent",
  });
}

type Run = Readonly<{ code: number | null; received: number; stderr: string }>;

async function run(script: string, reader: "slow" | "closed"): Promise<Run> {
  const child = spawn(process.execPath, [script], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: process.env.PATH ?? "", OUTPUT_BYTES: String(OUTPUT_BYTES), EXIT_CODE: "7" },
  });
  let received = 0;
  let stderr = "";
  const closed = new Promise<number | null>(done => child.once("close", done));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  const deadline = setTimeout(() => child.kill("SIGKILL"), CHILD_DEADLINE_MS);
  try {
    if (reader === "closed") {
      child.stdout.destroy();
    } else {
      await new Promise(done => setTimeout(done, READER_DELAY_MS));
      child.stdout.on("data", (chunk: Buffer) => { received += chunk.length; });
    }
    return { code: await closed, received, stderr };
  } finally {
    clearTimeout(deadline);
    child.kill("SIGKILL");
  }
}

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "lcm-hook-output-"));
  withHelper = join(directory, "with-helper.mjs");
  withoutHelper = join(directory, "without-helper.mjs");
  bundle(`
    import { writeHookOutput } from "./src/cli/hook-output.ts";
    await writeHookOutput(process.stdout, "x".repeat(Number(process.env.OUTPUT_BYTES)));
    process.exit(Number(process.env.EXIT_CODE));
  `, withHelper);
  writeFileSync(withoutHelper, [
    'process.stdout.write("x".repeat(Number(process.env.OUTPUT_BYTES)));',
    "process.exit(Number(process.env.EXIT_CODE));",
  ].join("\n"));
});

afterAll(() => {
  rmSync(directory, { recursive: true });
});

describe("hook output over a real pipe", () => {
  // The child bundles the helper from source; this import is what relates the
  // test to src/cli/hook-output.ts in Vitest's module graph for PR test selection.
  it("exercises the helper the hooks use", () => {
    expect(writeHookOutput).toBeTypeOf("function");
  });

  it("loses output when the process exits right after write(), which is what the helper prevents", async () => {
    const result = await run(withoutHelper, "slow");
    expect(result.code).toBe(7);
    expect(result.received).toBeLessThan(OUTPUT_BYTES);
  }, 30_000);

  it("delivers the complete output to a slow reader before exiting", async () => {
    const result = await run(withHelper, "slow");
    expect(result).toEqual({ code: 7, received: OUTPUT_BYTES, stderr: "" });
  }, 30_000);

  it("neither hangs nor crashes when the reader has gone away, and keeps the exit code", async () => {
    const result = await run(withHelper, "closed");
    expect(result).toEqual({ code: 7, received: 0, stderr: "" });
  }, 30_000);
});
