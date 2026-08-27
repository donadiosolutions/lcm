import { spawn as defaultSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync as defaultMkdtempSync, readFileSync as defaultReadFileSync, rmSync as defaultRmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LcmSummarizeFn, SummarizeContext } from "./types.js";
import { DEFAULT_LLM_REQUEST_TIMEOUT_MS, type CodexProcessReasoningEffort } from "../daemon/config.js";
import {
  createOwnedProcessTeardown,
  normalizeProcessBirthTime,
  createProcessCompatibilityError,
  type ProviderProcessWitness,
  type ProviderProcessWitnessStore,
} from "./process-utils.js";
import {
  createAbortError,
  isAbortError,
  throwIfAborted,
  waitForAbortable,
} from "../daemon/cancellation.js";
import { processStartTime } from "../private-mutation-lock.js";
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
  /** @internal deterministic process lifecycle seams. */
  platform?: NodeJS.Platform;
  killProcess?: (pid: number, signal?: NodeJS.Signals | number) => void;
  processGroupId?: number;
  daemonProcessGroupId?: number;
  isProcessGroupAlive?: (pgid: number) => boolean;
  processGroupIdProbe?: (pid: number) => number | undefined;
  daemonInstanceId?: string;
  witnessStore?: ProviderProcessWitnessStore;
  processBirthTime?: (pid: number) => string | null;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
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
    platform?: NodeJS.Platform;
    killProcess?: (pid: number, signal?: NodeJS.Signals | number) => void;
    processGroupId?: number;
    daemonProcessGroupId?: number;
    isProcessGroupAlive?: (pgid: number) => boolean;
    processGroupIdProbe?: (pid: number) => number | undefined;
    daemonInstanceId?: string;
    witnessStore?: ProviderProcessWitnessStore;
    processBirthTime: (pid: number) => string | null;
    setTimeout?: typeof setTimeout;
    clearTimeout?: typeof clearTimeout;
  },
  signal?: AbortSignal,
  invocationId?: string,
): Promise<string> {
  throwIfAborted(signal);
  const tempDir = deps.mkdtempSync(join(deps.tmpdir(), "lcm-codex-"));
  const outputPath = join(tempDir, "last-message.txt");
  let gateway: CodexResponsesGateway | undefined;
  let gatewayPromise: Promise<CodexResponsesGateway> | undefined;

  try {
    gatewayPromise = Promise.resolve(deps.createGateway({ prompt }));
    gateway = await waitForAbortable(gatewayPromise, signal);
    throwIfAborted(signal);
  } catch (error) {
    if (gateway !== undefined) {
      await gateway.close().catch(() => undefined);
    } else if (signal?.aborted && gatewayPromise !== undefined) {
      // waitForAbortable rejects immediately, but the gateway promise remains
      // owned by this call. Await it before cleanup so a late gateway cannot
      // outlive the temp directory or leak its listener/socket handles.
      try {
        const lateGateway = await gatewayPromise;
        try { await lateGateway.close(); } catch { /* preserve cancellation */ }
      } catch {
        // A failed late gateway has no owned close handle.
      }
    }
    cleanupTempDir(deps.rmSync, tempDir);
    if (signal?.aborted) throw createAbortError(signal.reason);
    throw error instanceof Error ? error : new Error(String(error));
  }

  const activeGateway = gateway;

  return new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    let finishPromise: Promise<void> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abortCompletionWait: ((error: Error) => void) | undefined;
    let teardown: ReturnType<typeof createOwnedProcessTeardown> | undefined;
    let detachAbort: (() => void) | undefined;
    let childListenersAttached = false;
    let cancellationRequested = false;
    let terminalReason: "abort" | "timeout" | undefined;
    let witness: ProviderProcessWitness | undefined;
    let witnessRemoved = false;

    const cleanupStreams = (): void => {
      if (child === undefined) return;
      try { child.stdin.removeAllListeners("error"); } catch { /* already closed */ }
      try { child.stdin.on("error", () => undefined); } catch { /* already closed */ }
      try { child.stdin.destroy(); } catch { /* already closed */ }
      try { child.stdout.removeAllListeners("data"); } catch { /* already closed */ }
      try { child.stderr.removeAllListeners("data"); } catch { /* already closed */ }
    };

    const cleanupChildListeners = (): void => {
      if (!childListenersAttached || child === undefined) return;
      // Keep a terminal error sink on EventEmitter-compatible test/process
      // handles: emitting a late child error with zero listeners would itself
      // throw and mask the already-settled provider result. The sink does not
      // retain any OS handle; close/error work remains guarded by finishPromise.
      child.removeListener("close", onChildClose);
      child.removeListener("error", onChildError);
      child.on("error", () => undefined);
      childListenersAttached = false;
    };

    const finishRun = (
      primaryError?: unknown,
      completionWork?: () => Promise<string>,
      teardownReason?: "abort" | "timeout" | "close",
    ): Promise<void> => {
      if (finishPromise !== undefined) return finishPromise;
      finishPromise = (async () => {
        let finalError = primaryError === undefined
          ? cancellationRequested ? createAbortError(signal?.reason) : undefined
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
          if (teardown !== undefined && child !== undefined) {
            const settled = await teardown.terminate(teardownReason!);
            if (!settled && finalError === undefined) {
              finalError = new Error("codex process teardown did not settle");
            }
            if (settled && witness !== undefined && !witnessRemoved) {
              try {
                deps.witnessStore!.remove(witness);
                witnessRemoved = true;
              } catch (error) {
                if (finalError === undefined) {
                  finalError = error instanceof Error ? error : new Error(String(error));
                }
              }
            }
          }
          await activeGateway.close();
        } catch (error) {
          if (finalError === undefined) {
            finalError = error instanceof Error ? error : new Error(String(error));
          }
        }
        if (timer !== undefined) {
          const clearTimer = deps.clearTimeout ?? clearTimeout;
          clearTimer(timer);
          timer = undefined;
        }
        detachAbort?.();
        detachAbort = undefined;
        cleanupChildListeners();
        cleanupStreams();
        cleanupTempDir(deps.rmSync, tempDir);
        if (finalError !== undefined) reject(finalError);
        else resolve(summary as string);
      })();
      return finishPromise;
    };

    try {
      child = deps.spawn("codex", buildArgs(outputPath, activeGateway.baseUrl, deps.model, deps.reasoningEffort, deps.fastMode), {
        cwd: tempDir,
        stdio: ["pipe", "pipe", "pipe"],
        detached: (deps.platform ?? process.platform) !== "win32",
      });
    } catch (error) {
      void finishRun(normalizeSpawnError(error));
      return;
    }

    teardown = createOwnedProcessTeardown({
      child,
      platform: deps.platform,
      processGroupId: deps.processGroupId,
      daemonProcessGroupId: deps.daemonProcessGroupId,
      killProcess: deps.killProcess,
      isProcessGroupAlive: deps.isProcessGroupAlive,
      processBirthTime: deps.processBirthTime,
      processGroupIdProbe: deps.processGroupIdProbe,
      setTimeout: deps.setTimeout,
      clearTimeout: deps.clearTimeout,
    });
    if (deps.daemonInstanceId !== undefined && deps.witnessStore !== undefined && teardown.pid !== undefined) {
      witness = {
        daemonInstanceId: deps.daemonInstanceId,
        ...(invocationId === undefined ? {} : { invocationId }),
        providerId: "codex-process",
        pid: teardown.pid,
        pgid: teardown.processGroupId ?? null,
        processStartTime: normalizeProcessBirthTime(deps.processBirthTime(teardown.pid)),
      };
    }

    const onAbort = (): void => {
      // finishRun is single-flight and detaches this listener during timeout
      // teardown, so a later abort cannot enter this handler.
      cancellationRequested = true;
      if (finishPromise !== undefined) {
        abortCompletionWait?.(createAbortError(signal?.reason));
        return;
      }
      terminalReason = "abort";
      void finishRun(createAbortError(signal?.reason), undefined, "abort");
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    detachAbort = () => signal?.removeEventListener("abort", onAbort);
    if (signal?.aborted) {
      onAbort();
      return;
    }

    const setTimer = deps.setTimeout ?? setTimeout;
    timer = setTimer(() => {
      const timeoutError = new Error(`codex process timed out after ${Math.round(deps.timeoutMs / 1000)}s`);
      if (finishPromise !== undefined) {
        terminalReason = "timeout";
        abortCompletionWait?.(timeoutError);
        return;
      }
      terminalReason = "timeout";
      void finishRun(timeoutError, undefined, "timeout");
    }, deps.timeoutMs);

    try {
      child.stdout.resume();
      child.stderr.resume();
    } catch (error) {
      void finishRun(error, undefined, "timeout");
      return;
    }

    const onStdinError = (): void => {
      if (finishPromise !== undefined) return;
      void finishRun(new Error("codex process stdin failed"), undefined, "timeout");
    };
    child.stdin.on("error", onStdinError);

    const onChildError = (error: Error): void => {
      void finishRun(normalizeSpawnError(error), undefined, "timeout");
    };
    const onChildClose = (code: number | null): void => {
      void finishRun(undefined, async () => {
        // Abort is handled by onAbort before this single-flight close callback.
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
        if (!activeGateway.requestAccepted) {
          throw new Error("codex responses gateway did not receive an authenticated request");
        }
        await activeGateway.waitForCompletion();
        if (!activeGateway.requestCompleted) {
          throw new Error("codex responses gateway did not complete");
        }
        const summary = deps.readFileSync(outputPath, "utf-8").trim();
        if (!summary) {
          throw new Error("codex output was empty");
        }
        return summary;
      }, "close");
    };

    child.on("error", onChildError);
    child.on("close", onChildClose);
    childListenersAttached = true;
    if (witness !== undefined) {
      try {
        deps.witnessStore!.add(witness);
      } catch (error) {
        void finishRun(error, undefined, "timeout");
        return;
      }
    }

    try {
      throwIfAborted(signal);
      child.stdin.write(CODEX_BOOTSTRAP);
      child.stdin.end();
    } catch (error) {
      if (isAbortError(error)) onAbort();
      else void finishRun(error, undefined, "timeout");
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
    platform: opts.platform,
    killProcess: opts.killProcess,
    processGroupId: opts.processGroupId,
    daemonProcessGroupId: opts.daemonProcessGroupId,
    isProcessGroupAlive: opts.isProcessGroupAlive,
    processGroupIdProbe: opts.processGroupIdProbe,
    daemonInstanceId: opts.daemonInstanceId,
    witnessStore: opts.witnessStore,
    processBirthTime: opts.processBirthTime ?? processStartTime,
    setTimeout: opts.setTimeout,
    clearTimeout: opts.clearTimeout,
  };

  return async function summarize(text, aggressive, ctx = {}): Promise<string> {
    throwIfAborted(ctx.signal);
    const prompt = buildPrompt(text, aggressive, ctx);
    return runCodexSummarizer(prompt, deps, ctx.signal, ctx.invocationId);
  };
}
