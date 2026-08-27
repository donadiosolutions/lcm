import { spawn as defaultSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { LcmSummarizeFn, SummarizeContext } from "./types.js";
import { DEFAULT_LLM_REQUEST_TIMEOUT_MS, resolveDaemonConfigEnv, type ClaudeProcessReasoningEffort } from "../daemon/config.js";
import {
  createOwnedProcessTeardown,
  createProcessCompatibilityError,
  normalizeProcessBirthTime,
  type ProviderProcessWitnessStore,
} from "./process-utils.js";
import { createAbortError, isAbortError, throwIfAborted } from "../daemon/cancellation.js";
import { processStartTime } from "../private-mutation-lock.js";
import {
  LCM_SUMMARIZER_SYSTEM_PROMPT,
  buildLeafSummaryPrompt,
  buildCondensedSummaryPrompt,
  resolveTargetTokens,
} from "../summarize.js";

const HAIKU_MODEL = "claude-haiku-4-5-20251001";
const CLAUDE_CREDENTIAL_ENV_NAMES = [
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
] as const;
type ClaudeProcessDeps = {
  model?: string;
  reasoningEffort?: ClaudeProcessReasoningEffort;
  fastMode?: boolean;
  spawn?: typeof defaultSpawn;
  environment?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** @internal deterministic process lifecycle seams. */
  platform?: NodeJS.Platform;
  killProcess?: (pid: number, signal?: NodeJS.Signals | number) => void;
  processGroupId?: number;
  daemonProcessGroupId?: number;
  isProcessGroupAlive?: (pgid: number) => boolean;
  processGroupIdProbe?: (pid: number) => number | undefined;
  processBirthTime?: (pid: number) => string | null;
  daemonInstanceId?: string;
  witnessStore?: ProviderProcessWitnessStore;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
};

function friendlyMissingClaudeError(): Error {
  return new Error([
    "Claude CLI is not installed or not on PATH.",
    "Install it first, then run lcm again.",
  ].join("\n"));
}

function normalizeSpawnError(error: unknown): Error {
  if (error && typeof error === "object" && (error as { code?: unknown }).code === "ENOENT") {
    return friendlyMissingClaudeError();
  }
  return error instanceof Error ? error : new Error(String(error));
}

function resolveClaudeProcessEnvironment(
  environment: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const resolved = resolveDaemonConfigEnv(environment);
  const childEnvironment = { ...environment };
  for (const name of CLAUDE_CREDENTIAL_ENV_NAMES) {
    const value = resolved[name];
    if (value === undefined) delete childEnvironment[name];
    else childEnvironment[name] = value;
  }
  return childEnvironment;
}

export function createClaudeProcessSummarizer(opts: ClaudeProcessDeps = {}): LcmSummarizeFn {
  const model = opts.model?.trim() || HAIKU_MODEL;
  const reasoningEffort = opts.reasoningEffort;
  const fastMode = opts.fastMode;
  const spawn = opts.spawn ?? defaultSpawn;
  const environment = opts.environment ?? process.env;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_LLM_REQUEST_TIMEOUT_MS;
  const platform = opts.platform ?? process.platform;
  const processBirthTime = opts.processBirthTime ?? processStartTime;

  return async function summarize(text: string, aggressive?: boolean, ctx: SummarizeContext = {}): Promise<string> {
    throwIfAborted(ctx.signal);
    const estimatedInputTokens = Math.ceil(text.length / 4);
    const targetTokens = ctx.targetTokens ?? resolveTargetTokens({
      inputTokens: estimatedInputTokens,
      mode: aggressive ? "aggressive" : "normal",
      isCondensed: ctx.isCondensed ?? false,
      condensedTargetTokens: 2000,
    });

    const prompt = ctx.isCondensed
      ? buildCondensedSummaryPrompt({ text, targetTokens, depth: ctx.depth ?? 1 })
      : buildLeafSummaryPrompt({ text, mode: aggressive ? "aggressive" : "normal", targetTokens });

    return new Promise((resolve, reject) => {
      const args = [
        "--print",
        "--model", model,
        "--no-session-persistence",
        "--system-prompt", LCM_SUMMARIZER_SYSTEM_PROMPT,
        "--tools", "",
        "--disable-slash-commands",
      ];
      if (reasoningEffort !== undefined) {
        args.push("--effort", reasoningEffort);
      }
      if (fastMode !== undefined) {
        const settings = fastMode
          ? { fastMode: true, fastModePerSessionOptIn: false }
          : { fastMode: false };
        args.push("--settings", JSON.stringify(settings));
      }

      let proc: ChildProcessWithoutNullStreams;
      try {
        proc = spawn("claude", args, {
          stdio: ["pipe", "pipe", "pipe"],
          env: resolveClaudeProcessEnvironment(environment),
          detached: platform !== "win32",
        });
      } catch (error) {
        reject(normalizeSpawnError(error));
        return;
      }

      let stdout = "";
      let finished = false;
      let settlement: Promise<void> | undefined;
      let teardown: ReturnType<typeof createOwnedProcessTeardown>;
      try {
        teardown = createOwnedProcessTeardown({
          child: proc,
          platform,
          processGroupId: opts.processGroupId,
          daemonProcessGroupId: opts.daemonProcessGroupId,
          killProcess: opts.killProcess,
          isProcessGroupAlive: opts.isProcessGroupAlive,
          processBirthTime: opts.processBirthTime,
          processGroupIdProbe: opts.processGroupIdProbe,
          setTimeout: opts.setTimeout,
          clearTimeout: opts.clearTimeout,
        });
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      const witness = opts.daemonInstanceId !== undefined && opts.witnessStore !== undefined && teardown.pid !== undefined
        ? {
            daemonInstanceId: opts.daemonInstanceId,
            providerId: "claude-process",
            pid: teardown.pid,
            pgid: teardown.processGroupId ?? null,
            processStartTime: normalizeProcessBirthTime(processBirthTime(teardown.pid)),
          }
        : undefined;
      proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
      proc.stderr.resume();

      const cleanupStreams = (): void => {
        try { proc.stdin.removeAllListeners("error"); } catch { /* already closed */ }
        // Retain an inert sink after settlement so a late EPIPE cannot become
        // an EventEmitter uncaught exception.
        try { proc.stdin.on("error", () => undefined); } catch { /* already closed */ }
        try { proc.stdin.destroy(); } catch { /* already closed */ }
        try { proc.stdout.removeAllListeners("data"); } catch { /* already closed */ }
        try { proc.stderr.removeAllListeners("data"); } catch { /* already closed */ }
      };

      let timer: ReturnType<typeof setTimeout> | undefined;
      let witnessRemoved = false;
      let cancellationRequested = false;
      let terminalError: unknown;
      const detachAbort = (): void => ctx.signal?.removeEventListener("abort", onAbort);
      const cleanupChildListeners = (): void => {
        proc.removeListener("close", onClose);
        proc.removeListener("error", onError);
        proc.stdin.removeListener("error", onStdinError);
        // Keep an inert error sink so a late child error cannot escape as an
        // EventEmitter uncaught exception after the result has settled.
        proc.on("error", () => undefined);
      };
      const removeWitness = async (settled: boolean): Promise<void> => {
        if (!settled || witness === undefined || witnessRemoved) return;
        opts.witnessStore!.remove(witness);
        witnessRemoved = true;
      };
      const settle = (
        reason: "abort" | "timeout" | "close",
        error?: unknown,
        complete?: () => void,
      ): void => {
        if (error !== undefined && terminalError === undefined) terminalError = error;
        if (settlement !== undefined) return;
        settlement = (async () => {
          try { proc.stdin.destroy(); } catch { /* already closed */ }
          const settled = await teardown.terminate(reason);
          await removeWitness(settled);
          if (!settled && terminalError === undefined) {
            terminalError = new Error("claude process teardown did not settle");
          }
          finished = true;
          if (timer !== undefined) {
            (opts.clearTimeout ?? clearTimeout)(timer);
            timer = undefined;
          }
          detachAbort();
          cleanupChildListeners();
          cleanupStreams();
          if (terminalError !== undefined) {
            reject(terminalError instanceof Error ? terminalError : new Error(String(terminalError)));
          } else {
            complete?.();
          }
        })();
        void settlement.catch((caught: unknown) => {
          finished = true;
          if (timer !== undefined) {
            (opts.clearTimeout ?? clearTimeout)(timer);
            timer = undefined;
          }
          detachAbort();
          cleanupChildListeners();
          cleanupStreams();
          reject(caught instanceof Error ? caught : new Error(String(caught)));
        });
      };
      const settleFailure = (error: unknown, reason: "abort" | "timeout"): void => {
        settle(reason, error);
      };
      const settleAbort = (): void => {
        cancellationRequested = true;
        if (settlement !== undefined) return;
        settle("abort", createAbortError(ctx.signal?.reason));
      };
      const onAbort = (): void => settleAbort();
      ctx.signal?.addEventListener("abort", onAbort, { once: true });

      const onClose = (code: number | null): void => {
        settle("close", undefined, () => {
          if (cancellationRequested || ctx.signal?.aborted) {
            reject(createAbortError(ctx.signal?.reason));
            return;
          }
          const out = stdout.trim();
          if (code === 0) {
            if (out) resolve(out);
            else reject(new Error("claude output was empty"));
          } else {
            reject(createProcessCompatibilityError({
              cliName: "Claude",
              providerId: "claude-process",
              code,
              model,
              reasoningEffort,
              fastMode,
            }));
          }
        });
      };
      const onError = (err: Error): void => {
        settleFailure(normalizeSpawnError(err), "timeout");
      };
      const onStdinError = (): void => {
        settleFailure(new Error("claude process stdin failed"), "timeout");
      };
      proc.on("close", onClose);
      proc.on("error", onError);
      proc.stdin.on("error", onStdinError);
      const setTimer = opts.setTimeout ?? setTimeout;
      timer = setTimer(() => {
        if (finished) return;
        settleFailure(new Error(`claude process timed out after ${Math.round(timeoutMs / 1000)}s`), "timeout");
      }, timeoutMs);
      if (witness !== undefined) {
        try {
          opts.witnessStore!.add(witness);
        } catch (error) {
          settleFailure(error, "timeout");
          return;
        }
      }

      try {
        throwIfAborted(ctx.signal);
        proc.stdin.write(prompt);
        proc.stdin.end();
      } catch (error) {
        if (isAbortError(error)) settleAbort();
        else settleFailure(error, "timeout");
      }
    });
  };
}
