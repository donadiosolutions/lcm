import { spawn as defaultSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync as defaultMkdtempSync, readFileSync as defaultReadFileSync, rmSync as defaultRmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LcmSummarizeFn, SummarizeContext } from "./types.js";
import { DEFAULT_LLM_REQUEST_TIMEOUT_MS, type CodexProcessReasoningEffort } from "../daemon/config.js";
import { createProcessCompatibilityError } from "./process-utils.js";
import {
  createCodexResponsesGateway,
  type CodexResponsesGateway,
  type CodexResponsesGatewayOptions,
} from "./codex-responses-gateway.js";
import {
  LCM_SUMMARIZER_SYSTEM_PROMPT,
  buildLeafSummaryPrompt,
  buildCondensedSummaryPrompt,
  resolveTargetTokens,
} from "../summarize.js";

export type CodexProcessDeps = {
  model?: string;
  reasoningEffort?: CodexProcessReasoningEffort;
  fastMode?: boolean;
  spawn?: typeof defaultSpawn;
  mkdtempSync?: typeof defaultMkdtempSync;
  readFileSync?: typeof defaultReadFileSync;
  rmSync?: typeof defaultRmSync;
  tmpdir?: typeof tmpdir;
  timeoutMs?: number;
  _createGateway?: (options: CodexResponsesGatewayOptions) => Promise<CodexResponsesGateway>;
};

const CODEX_BOOTSTRAP = "LCM compaction bootstrap.\n";

function buildPrompt(text: string, aggressive: boolean | undefined, ctx: SummarizeContext): string {
  const estimatedInputTokens = Math.ceil(text.length / 4);
  const targetTokens = ctx.targetTokens ?? resolveTargetTokens({
    inputTokens: estimatedInputTokens,
    mode: aggressive ? "aggressive" : "normal",
    isCondensed: ctx.isCondensed ?? false,
    condensedTargetTokens: 2000,
  });

  const summaryPrompt = ctx.isCondensed
    ? buildCondensedSummaryPrompt({ text, targetTokens, depth: ctx.depth ?? 1 })
    : buildLeafSummaryPrompt({ text, mode: aggressive ? "aggressive" : "normal", targetTokens });

  return [LCM_SUMMARIZER_SYSTEM_PROMPT, summaryPrompt].filter(Boolean).join("\n\n");
}

function friendlyMissingCodexError(): Error {
  return new Error([
    "Codex CLI is not installed or not on PATH.",
    "Install it first, for example: npm install -g @openai/codex",
    "Then run lcm again.",
  ].join("\n"));
}

function normalizeSpawnError(error: unknown): Error {
  if (error && typeof error === "object" && (error as { code?: unknown }).code === "ENOENT") {
    return friendlyMissingCodexError();
  }
  return error instanceof Error ? error : new Error(String(error));
}

function buildArgs(
  outputPath: string,
  gatewayBaseUrl: string,
  model?: string,
  reasoningEffort?: CodexProcessReasoningEffort,
  fastMode?: boolean,
): string[] {
  const args = ["exec"];

  if (model && model.trim()) {
    args.push("--model", model.trim());
  }

  if (reasoningEffort !== undefined) {
    args.push("-c", `model_reasoning_effort=${JSON.stringify(reasoningEffort)}`);
  }
  if (fastMode === true) {
    args.push("--enable", "fast_mode", "-c", 'service_tier="fast"');
  } else if (fastMode === false) {
    args.push("--disable", "fast_mode", "-c", 'service_tier="default"');
  }

  args.push(
    "--ignore-user-config",
    "--ignore-rules",
    "--ephemeral",
    "--disable",
    "hooks",
    "-c",
    "project_doc_max_bytes=0",
    "-c",
    'model_provider="lcm_compaction"',
    "-c",
    `model_providers.lcm_compaction={name="LCM compaction",base_url=${JSON.stringify(gatewayBaseUrl)},wire_api="responses",requires_openai_auth=true,request_max_retries=0,stream_max_retries=0,supports_websockets=false}`,
    "-",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--output-last-message",
    outputPath,
  );

  return args;
}

function cleanupTempDir(rmSync: typeof defaultRmSync, tempDir: string): void {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // ignore cleanup failures
  }
}

async function runCodexSummarizer(
  prompt: string,
  deps: Required<Pick<CodexProcessDeps, "spawn" | "mkdtempSync" | "readFileSync" | "rmSync" | "tmpdir" | "timeoutMs">> & {
    model?: string;
    reasoningEffort?: CodexProcessReasoningEffort;
    fastMode?: boolean;
    createGateway: (options: CodexResponsesGatewayOptions) => Promise<CodexResponsesGateway>;
  },
): Promise<string> {
  const tempDir = deps.mkdtempSync(join(deps.tmpdir(), "lcm-codex-"));
  const outputPath = join(tempDir, "last-message.txt");
  let gateway: CodexResponsesGateway;

  try {
    gateway = await deps.createGateway({ prompt });
  } catch (error) {
    cleanupTempDir(deps.rmSync, tempDir);
    throw error instanceof Error ? error : new Error(String(error));
  }

  return new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    let finishPromise: Promise<void> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abortCompletionWait: ((error: Error) => void) | undefined;

    const finishRun = (
      primaryError?: unknown,
      completionWork?: () => Promise<string>,
    ): Promise<void> => {
      if (finishPromise !== undefined) return finishPromise;
      finishPromise = (async () => {
        let finalError = primaryError === undefined
          ? undefined
          : primaryError instanceof Error ? primaryError : new Error(String(primaryError));
        let summary: string | undefined;
        if (finalError === undefined && completionWork !== undefined) {
          let rejectDeadline!: (error: Error) => void;
          const deadline = new Promise<never>((_resolve, reject) => {
            rejectDeadline = reject;
          });
          abortCompletionWait = (error) => rejectDeadline(error);
          try {
            summary = await Promise.race([completionWork(), deadline]);
          } catch (error) {
            finalError = error instanceof Error ? error : new Error(String(error));
          } finally {
            abortCompletionWait = undefined;
          }
        }
        try {
          await gateway.close();
        } catch (error) {
          if (finalError === undefined) {
            finalError = error instanceof Error ? error : new Error(String(error));
          }
        }
        if (timer !== undefined) clearTimeout(timer);
        cleanupTempDir(deps.rmSync, tempDir);
        if (finalError !== undefined) reject(finalError);
        else resolve(summary as string);
      })();
      return finishPromise;
    };

    try {
      child = deps.spawn("codex", buildArgs(outputPath, gateway.baseUrl, deps.model, deps.reasoningEffort, deps.fastMode), {
        cwd: tempDir,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      void finishRun(normalizeSpawnError(error));
      return;
    }

    timer = setTimeout(() => {
      const timeoutError = new Error(`codex process timed out after ${Math.round(deps.timeoutMs / 1000)}s`);
      if (finishPromise !== undefined) {
        abortCompletionWait?.(timeoutError);
        return;
      }
      try {
        child.kill();
      } catch {
        // ignore kill failures during timeout cleanup
      }
      void finishRun(timeoutError);
    }, deps.timeoutMs);

    try {
      child.stdout.resume();
      child.stderr.resume();
    } catch (error) {
      void finishRun(error);
      return;
    }

    const onStdinError = (): void => {
      if (finishPromise !== undefined) return;
      try {
        child.kill();
      } catch {
        // ignore kill failures after stdin has closed
      }
      void finishRun(new Error("codex process stdin failed"));
    };
    child.stdin.on("error", onStdinError);

    child.on("error", (error) => {
      void finishRun(normalizeSpawnError(error));
    });

    child.on("close", (code: number | null) => {
      void finishRun(undefined, async () => {
        if (code !== 0) {
          throw createProcessCompatibilityError({
            cliName: "Codex",
            providerId: "codex-process",
            code,
            model: deps.model,
            reasoningEffort: deps.reasoningEffort,
            fastMode: deps.fastMode,
          });
        }
        if (!gateway.requestAccepted) {
          throw new Error("codex responses gateway did not receive an authenticated request");
        }
        await gateway.waitForCompletion();
        if (!gateway.requestCompleted) {
          throw new Error("codex responses gateway did not complete");
        }
        const summary = deps.readFileSync(outputPath, "utf-8").trim();
        if (!summary) {
          throw new Error("codex output was empty");
        }
        return summary;
      });
    });

    try {
      child.stdin.write(CODEX_BOOTSTRAP);
      child.stdin.end();
    } catch (error) {
      void finishRun(error);
    }
  });
}

export function createCodexProcessSummarizer(opts: CodexProcessDeps = {}): LcmSummarizeFn {
  const deps = {
    model: opts.model,
    reasoningEffort: opts.reasoningEffort,
    fastMode: opts.fastMode,
    spawn: opts.spawn ?? defaultSpawn,
    mkdtempSync: opts.mkdtempSync ?? defaultMkdtempSync,
    readFileSync: opts.readFileSync ?? defaultReadFileSync,
    rmSync: opts.rmSync ?? defaultRmSync,
    tmpdir: opts.tmpdir ?? tmpdir,
    timeoutMs: opts.timeoutMs ?? DEFAULT_LLM_REQUEST_TIMEOUT_MS,
    createGateway: opts._createGateway ?? createCodexResponsesGateway,
  };

  return async function summarize(text, aggressive, ctx = {}): Promise<string> {
    const prompt = buildPrompt(text, aggressive, ctx);
    return runCodexSummarizer(prompt, deps);
  };
}
