import { spawn as defaultSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { LcmSummarizeFn, SummarizeContext } from "./types.js";
import type { ClaudeProcessReasoningEffort } from "../daemon/config.js";
import { createProcessCompatibilityError } from "./process-utils.js";
import {
  LCM_SUMMARIZER_SYSTEM_PROMPT,
  buildLeafSummaryPrompt,
  buildCondensedSummaryPrompt,
  resolveTargetTokens,
} from "../summarize.js";

const HAIKU_MODEL = "claude-haiku-4-5-20251001";
const TIMEOUT_MS = 120_000;

type ClaudeProcessDeps = {
  model?: string;
  reasoningEffort?: ClaudeProcessReasoningEffort;
  fastMode?: boolean;
  spawn?: typeof defaultSpawn;
  timeoutMs?: number;
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

export function createClaudeProcessSummarizer(opts: ClaudeProcessDeps = {}): LcmSummarizeFn {
  const model = opts.model?.trim() || HAIKU_MODEL;
  const reasoningEffort = opts.reasoningEffort;
  const fastMode = opts.fastMode;
  const spawn = opts.spawn ?? defaultSpawn;
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;

  return async function summarize(text: string, aggressive?: boolean, ctx: SummarizeContext = {}): Promise<string> {
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
        proc = spawn("claude", args, { stdio: ["pipe", "pipe", "pipe"] });
      } catch (error) {
        reject(normalizeSpawnError(error));
        return;
      }

      let stdout = "";
      let finished = false;

      proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
      proc.stderr.resume();

      const timer = setTimeout(() => {
        if (finished) return;
        finished = true;
        try {
          proc.kill();
        } catch {
          // ignore kill failures during timeout cleanup
        }
        reject(new Error(`claude process timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);

      proc.on("close", (code: number | null) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        const out = stdout.trim();
        if (code === 0 && out) {
          resolve(out);
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

      proc.on("error", (err) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        reject(normalizeSpawnError(err));
      });

      proc.stdin.write(prompt);
      proc.stdin.end();
    });
  };
}
