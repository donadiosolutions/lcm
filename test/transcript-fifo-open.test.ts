import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  extractCodexSessionMeta,
  parseCodexTranscript,
} from "../src/codex-transcript.js";
import { parseTranscript } from "../src/transcript.js";

const roots: string[] = [];
const children: ChildProcess[] = [];

// Probe budget: startup <= PROBE_STARTUP_MS, then the operation watchdog
// PROBE_OPERATION_MS, then SIGKILL reaping. The per-test timeout exceeds the
// sum with headroom so Vitest never abandons a live child.
const PROBE_STARTUP_MS = 15_000;
const PROBE_OPERATION_MS = 1_000;
const PROBE_TEST_TIMEOUT_MS = 30_000;

afterEach(async () => {
  await Promise.all(children.splice(0).map(async (child) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((resolveExit) => {
      child.once("exit", () => resolveExit());
    });
    child.kill("SIGKILL");
    await exited;
  }));
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "lcm-transcript-fifo-"));
  roots.push(root);
  return root;
}

function sourceUrl(path: string): string {
  return pathToFileURL(resolve(path)).href;
}

// Node resolves the TypeScript sources directly, so ".js" specifiers inside
// them are mapped back to their ".ts" files for the probe child.
const RESOLVE_HOOK = [
  "export async function resolve(specifier, context, next) {",
  "  if (specifier.startsWith(\".\") && specifier.endsWith(\".js\")) {",
  "    try { return await next(specifier.slice(0, -3) + \".ts\", context); } catch {}",
  "  }",
  "  return next(specifier, context);",
  "}",
].join("\n");

/**
 * Run a synchronous-API probe in a child process. The child prints "ready"
 * once its modules are loaded; the watchdog only starts then, so a blocked
 * FIFO open is killed after one second instead of hanging the suite.
 */
async function runProbe(body: string): Promise<{ code: number; stdout: string }> {
  const childSource = [
    "import { register } from \"node:module\";",
    `register("data:text/javascript," + encodeURIComponent(${JSON.stringify(RESOLVE_HOOK)}), import.meta.url);`,
    `const transcript = await import(${JSON.stringify(sourceUrl("src/transcript.ts"))});`,
    `const codex = await import(${JSON.stringify(sourceUrl("src/codex-transcript.ts"))});`,
    `const ingest = await import(${JSON.stringify(sourceUrl("src/storage/native-transcript-ingest.ts"))});`,
    "console.log(\"ready\");",
    body,
  ].join("\n");
  const child = spawn(process.execPath, [
    "--experimental-transform-types",
    "--no-warnings",
    "--input-type=module",
    "--eval",
    childSource,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  let stdout = "";
  let stderr = "";
  let watchdog: NodeJS.Timeout | undefined;
  let startupWatchdog: NodeJS.Timeout | undefined;
  let timedOut = false;
  const kill = (): void => {
    timedOut = true;
    try {
      child.kill("SIGKILL");
    } catch {
      // The close handler still reports the timeout after an exit race.
    }
  };
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
    if (watchdog === undefined && stdout.includes("ready")) {
      clearTimeout(startupWatchdog);
      watchdog = setTimeout(kill, PROBE_OPERATION_MS);
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  startupWatchdog = setTimeout(kill, PROBE_STARTUP_MS);
  return await new Promise((resolveResult, reject) => {
    child.once("error", (error) => {
      clearTimeout(watchdog);
      clearTimeout(startupWatchdog);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(watchdog);
      clearTimeout(startupWatchdog);
      if (timedOut) {
        reject(new Error(`FIFO probe child blocked or timed out: ${stderr}`));
        return;
      }
      if (signal !== null || code === null) {
        reject(new Error(`FIFO probe child ended abnormally (${String(signal)}): ${stderr}`));
        return;
      }
      resolveResult({ code, stdout: stdout.replace("ready\n", "") });
    });
  });
}

function makeFifo(): { root: string; fifo: string } {
  const root = makeRoot();
  const fifo = join(root, "transcript.jsonl");
  execFileSync("mkfifo", [fifo]);
  return { root, fifo };
}

function openDescriptorCount(): number {
  return readdirSync("/proc/self/fd").length;
}

describe("transcript paths that are not regular files", () => {
  it.runIf(process.platform === "linux")(
    "rejects a FIFO native transcript source without blocking",
    async () => {
      const { root, fifo } = makeFifo();
      const result = await runProbe([
        `const source = ingest.createFileNativeTranscriptSource(${JSON.stringify(root)}, ${JSON.stringify(fifo.slice(root.length + 1))});`,
        "try {",
        "  await source.openSnapshot();",
        "  console.log(\"opened\");",
        "} catch (error) {",
        "  console.log(error instanceof ingest.NativeTranscriptConfigurationError ? error.code : \"other\");",
        "}",
      ].join("\n"));

      expect(result).toEqual({ code: 0, stdout: "invalid-input\n" });
    },
    PROBE_TEST_TIMEOUT_MS,
  );

  it.runIf(process.platform === "linux")(
    "parses a FIFO Claude transcript as empty without blocking",
    async () => {
      const { fifo } = makeFifo();
      const result = await runProbe(
        `console.log(JSON.stringify(transcript.parseTranscript(${JSON.stringify(fifo)})));`,
      );

      expect(result).toEqual({ code: 0, stdout: "[]\n" });
    },
    PROBE_TEST_TIMEOUT_MS,
  );

  it.runIf(process.platform === "linux")(
    "parses a FIFO Codex transcript as empty without blocking",
    async () => {
      const { fifo } = makeFifo();
      const result = await runProbe(
        `console.log(JSON.stringify(codex.parseCodexTranscript(${JSON.stringify(fifo)})));`,
      );

      expect(result).toEqual({ code: 0, stdout: "[]\n" });
    },
    PROBE_TEST_TIMEOUT_MS,
  );

  it.runIf(process.platform === "linux")(
    "reads no Codex session metadata from a FIFO without blocking",
    async () => {
      const { fifo } = makeFifo();
      const result = await runProbe(
        `console.log(String(codex.extractCodexSessionMeta(${JSON.stringify(fifo)})));`,
      );

      expect(result).toEqual({ code: 0, stdout: "undefined\n" });
    },
    PROBE_TEST_TIMEOUT_MS,
  );

  it("keeps reading regular files, including through a symlink", () => {
    const root = makeRoot();
    const claude = join(root, "claude.jsonl");
    const codex = join(root, "codex.jsonl");
    const link = join(root, "link.jsonl");
    writeFileSync(claude, '{"message":{"role":"user","content":"hello"}}\n');
    writeFileSync(
      codex,
      '{"type":"session_meta","payload":{"id":"thread-1"}}\n'
        + '{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]}}\n',
    );
    symlinkSync(claude, link);

    expect(parseTranscript(claude)).toHaveLength(1);
    expect(parseTranscript(link)).toHaveLength(1);
    expect(parseCodexTranscript(codex)).toHaveLength(1);
    expect(extractCodexSessionMeta(codex)).toMatchObject({ threadId: "thread-1" });
  });

  it("returns empty for directories and missing paths", () => {
    const root = makeRoot();
    const directory = join(root, "directory");
    mkdirSync(directory);
    const missing = join(root, "missing.jsonl");

    for (const path of [directory, missing]) {
      expect(parseTranscript(path)).toEqual([]);
      expect(parseCodexTranscript(path)).toEqual([]);
      expect(extractCodexSessionMeta(path)).toBeUndefined();
    }
  });

  it.runIf(process.platform === "linux")(
    "closes the descriptor for regular files and directories",
    () => {
      const root = makeRoot();
      const file = join(root, "transcript.jsonl");
      const directory = join(root, "directory");
      writeFileSync(file, "{}\n");
      mkdirSync(directory);
      const before = openDescriptorCount();

      for (let index = 0; index < 5; index += 1) {
        parseTranscript(file);
        parseTranscript(directory);
        parseTranscript(join(root, "missing.jsonl"));
      }

      expect(openDescriptorCount()).toBe(before);
    },
  );
});
