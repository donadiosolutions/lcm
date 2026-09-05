import { spawn as defaultSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { TextDecoder } from "node:util";
import { DEFAULT_LLM_REQUEST_TIMEOUT_MS } from "../daemon/config.js";
import { createAbortError, throwIfAborted } from "../daemon/cancellation.js";
import {
  createOwnedProcessTeardown,
  normalizeProcessBirthTime,
  type ProviderProcessWitness,
  type ProviderProcessWitnessStore,
} from "./process-utils.js";
import { processStartTime } from "../private-mutation-lock.js";

const RESOLUTION_ERROR = "codex endpoint resolution failed: config/read capability unavailable";
const MAX_PROTOCOL_LINE_CHARS = 4 * 1024 * 1024;
const MAX_PROTOCOL_STDOUT_BYTES = 8 * 1024 * 1024;
const CODEX_APP_SERVER_ARGS = ["app-server", "--listen", "stdio://"] as const;

export type CodexConfigDeps = {
  spawn?: typeof defaultSpawn;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  detachedProcessGroup?: boolean;
  killProcess?: (pid: number, signal?: NodeJS.Signals | number) => void;
  processGroupId?: number;
  daemonProcessGroupId?: number;
  isProcessGroupAlive?: (pgid: number) => boolean;
  processGroupIdProbe?: (pid: number) => number | undefined;
  daemonInstanceId?: string;
  invocationId?: string;
  witnessStore?: ProviderProcessWitnessStore;
  processBirthTime?: (pid: number) => string | null;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
};

function resolutionError(): Error {
  return new Error(RESOLUTION_ERROR);
}

function normalizeConfiguredUrl(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > 2048
    || /\s|[\u0000-\u001f\u007f-\u009f]/u.test(value)
    || value.includes("?") || value.includes("#")) throw resolutionError();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw resolutionError();
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:")
    || url.username.length > 0 || url.password.length > 0
    || url.hostname.length === 0 || url.search.length > 0 || url.hash.length > 0) {
    throw resolutionError();
  }
  url.pathname = url.pathname.replace(/\/+$/u, "");
  if (!url.pathname.endsWith("/responses")) url.pathname = `${url.pathname}/responses`;
  return url.toString();
}

function configValueFromResponse(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw resolutionError();
  const result = (value as { result?: unknown }).result;
  if (result === null || typeof result !== "object" || Array.isArray(result)) throw resolutionError();
  const config = (result as { config?: unknown }).config;
  if (config === null || typeof config !== "object" || Array.isArray(config)) throw resolutionError();
  return (config as { openai_base_url?: unknown }).openai_base_url;
}

function parseProtocolLine(decoder: TextDecoder, chunk: Uint8Array, lineState: { line: string }): unknown[] {
  let text: string;
  try {
    text = decoder.decode(chunk, { stream: true });
  } catch {
    throw resolutionError();
  }
  const messages: unknown[] = [];
  let offset = 0;
  while (offset < text.length) {
    const newline = text.indexOf("\n", offset);
    if (newline < 0) {
      lineState.line += text.slice(offset);
      if (Buffer.byteLength(lineState.line, "utf8") > MAX_PROTOCOL_LINE_CHARS) throw resolutionError();
      break;
    }
    lineState.line += text.slice(offset, newline);
    if (Buffer.byteLength(lineState.line, "utf8") > MAX_PROTOCOL_LINE_CHARS) throw resolutionError();
    const raw = lineState.line.replace(/\r$/u, "");
    lineState.line = "";
    offset = newline + 1;
    if (raw.length === 0) continue;
    try {
      messages.push(JSON.parse(raw) as unknown);
    } catch {
      throw resolutionError();
    }
  }
  return messages;
}

function writeMessage(child: ChildProcessWithoutNullStreams, message: Record<string, unknown>): void {
  try {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  } catch {
    throw resolutionError();
  }
}

function responseId(message: unknown): number | undefined {
  if (message === null || typeof message !== "object" || Array.isArray(message)) return undefined;
  const id = (message as { id?: unknown }).id;
  return typeof id === "number" && Number.isSafeInteger(id) ? id : undefined;
}

function responseHasError(message: unknown): boolean {
  return message !== null && typeof message === "object" && !Array.isArray(message)
    && (message as { error?: unknown }).error !== undefined;
}

/** Resolve Codex's effective openai_base_url through its app-server protocol. */
export async function resolveCodexOpenAIBaseUrl(
  options: CodexConfigDeps = {},
  signal?: AbortSignal,
): Promise<string | undefined> {
  throwIfAborted(signal);
  const spawn = options.spawn ?? defaultSpawn;
  const timeoutMs = options.timeoutMs ?? DEFAULT_LLM_REQUEST_TIMEOUT_MS;
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn("codex", [...CODEX_APP_SERVER_ARGS], {
      stdio: ["pipe", "pipe", "pipe"],
      env: options.env ?? process.env,
      detached: (options.platform ?? process.platform) !== "win32",
    });
  } catch {
    throw resolutionError();
  }

  let teardown: ReturnType<typeof createOwnedProcessTeardown>;
  try {
    teardown = createOwnedProcessTeardown({
      child,
      platform: options.platform,
      detachedProcessGroup: options.detachedProcessGroup
        ?? ((options.platform ?? process.platform) !== "win32" && options.processGroupId === undefined),
      processGroupId: options.processGroupId,
      daemonProcessGroupId: options.daemonProcessGroupId,
      killProcess: options.killProcess,
      isProcessGroupAlive: options.isProcessGroupAlive,
      processGroupIdProbe: options.processGroupIdProbe,
      processBirthTime: options.processBirthTime ?? processStartTime,
      setTimeout: options.setTimeout,
      clearTimeout: options.clearTimeout,
    });
  } catch {
    try { child.kill("SIGTERM"); } catch { /* already exited */ }
    try { child.kill("SIGKILL"); } catch { /* already exited */ }
    throw resolutionError();
  }

  let witness: ProviderProcessWitness | undefined;
  if (options.daemonInstanceId !== undefined && options.witnessStore !== undefined && teardown.pid !== undefined) {
    let processBirth: string | null = null;
    try {
      processBirth = normalizeProcessBirthTime((options.processBirthTime ?? processStartTime)(teardown.pid));
    } catch {
      processBirth = null;
    }
    witness = {
      daemonInstanceId: options.daemonInstanceId,
      ...(options.invocationId === undefined ? {} : { invocationId: options.invocationId }),
      providerId: "codex-config",
      pid: teardown.pid,
      pgid: teardown.processGroupId ?? null,
      processStartTime: processBirth,
    };
  }

  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let aborted = false;
  let detachAbort: (() => void) | undefined;
  let witnessAdded = false;
  let teardownSettled = false;
  try {
    child.stderr.resume();
    if (witness !== undefined) {
      options.witnessStore!.add(witness);
      witnessAdded = true;
    }
    const result = await new Promise<string | undefined>((resolve, reject) => {
      const decoder = new TextDecoder("utf-8", { fatal: true });
      const lineState = { line: "" };
      let phase: "initialize" | "config" = "initialize";
      let resolvedValue: string | undefined;
      let configResolved = false;
      let stdoutBytes = 0;
      const settle = (error?: Error, value?: string): void => {
        if (error) reject(error); else resolve(value);
      };
      const onAbort = (): void => {
        aborted = true;
        settle(createAbortError(signal?.reason));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      detachAbort = () => signal?.removeEventListener("abort", onAbort);
      timeoutTimer = (options.setTimeout ?? setTimeout)(() => {
        timedOut = true;
        settle(resolutionError());
      }, timeoutMs);
      child.once("error", () => settle(resolutionError()));
      child.stdin.on("error", () => settle(resolutionError()));
      void (async () => {
        try {
          writeMessage(child, {
            id: 1,
            method: "initialize",
            params: { clientInfo: { name: "lcm", version: "1" } },
          });
          for await (const chunk of child.stdout) {
            if (!(chunk instanceof Uint8Array)) throw resolutionError();
            stdoutBytes += chunk.byteLength;
            if (stdoutBytes > MAX_PROTOCOL_STDOUT_BYTES) throw resolutionError();
            for (const message of parseProtocolLine(decoder, chunk, lineState)) {
              const id = responseId(message);
              if (id === 1 && phase === "initialize") {
                if (responseHasError(message)) throw resolutionError();
                writeMessage(child, { method: "initialized" });
                writeMessage(child, {
                  id: 2,
                  method: "config/read",
                  params: { includeLayers: false, cwd: process.cwd() },
                });
                phase = "config";
              } else if (id === 2 && phase === "config") {
                if (responseHasError(message)) throw resolutionError();
                resolvedValue = normalizeConfiguredUrl(configValueFromResponse(message));
                configResolved = true;
              }
            }
            if (configResolved) {
              try {
                decoder.decode();
              } catch {
                throw resolutionError();
              }
              if (lineState.line.length > 0) throw resolutionError();
              settle(undefined, resolvedValue);
              try { child.stdin.end(); } catch { /* teardown still owns termination */ }
              return;
            }
          }
          decoder.decode();
          if (lineState.line.length > 0) throw resolutionError();
          throw resolutionError();
        } catch (error) {
          settle(resolutionError());
        }
      })();
    });
    const terminated = await teardown.terminate("close");
    teardownSettled = terminated;
    if (!terminated) throw resolutionError();
    return result;
  } catch (error) {
    const reason = aborted ? "abort" : timedOut ? "timeout" : "close";
    await teardown.terminate(reason);
    if (aborted) throw createAbortError(signal?.reason);
    throw resolutionError();
  } finally {
    if (timeoutTimer !== undefined) (options.clearTimeout ?? clearTimeout)(timeoutTimer);
    detachAbort?.();
    if (teardownSettled && witnessAdded && witness !== undefined && options.witnessStore !== undefined) {
      try { options.witnessStore.remove(witness); } catch { /* preserve resolver result */ }
    }
  }
}

/** Internal compatibility alias used by resolver seams. */
export const resolveCodexConfig = resolveCodexOpenAIBaseUrl;

export const __codexConfigTestUtils = {
  normalizeConfiguredUrl,
  configValueFromResponse,
  parseProtocolLine,
  responseId,
  responseHasError,
};
