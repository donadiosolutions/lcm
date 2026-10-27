import { accessSync, constants, lstatSync } from "node:fs";
import { stdin } from "node:process";
import { daemonJsonResponse } from "../daemon/http-url.js";
import { DaemonPeerRefusalError } from "../daemon/client.js";
import { admitDaemonPeer } from "../daemon/peer-admission.js";
import { createTerminalDeadline, type TerminalDeadline } from "../cli/terminal-deadline.js";
import { readTerminalStdin } from "../cli/terminal-stdin.js";
import { assertHookPublicationFence, hookAdmissionRetry } from "./publication-fence.js";

/**
 * Codex Interrupt and SessionEnd hooks have at most three seconds, so they
 * only hand the transcript to a daemon that is already running and verified.
 * They never start, repair or configure anything, never compact or promote,
 * and never print: the diagnostic below is the only trace of a missed save.
 */
export type TerminalOutcome =
  | "accepted"
  | "transcript-unavailable"
  | "invalid-input"
  | "daemon-unavailable"
  | "publication-refused"
  | "deadline-exhausted"
  | "ingest-failed"
  | "unconfirmed";

export type TerminalHookContext = Readonly<{ deadline: TerminalDeadline }>;

const TERMINAL_EVENTS: readonly string[] = ["Interrupt", "SessionEnd"];
const FALLBACK_EVENT = "TerminalSnapshot";
const UNREACHABLE_CODES: readonly string[] = ["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH"];

export type TerminalSnapshotDeps = Readonly<{
  verify: (opts: { budgetMs: number; signal: AbortSignal }) => Promise<{ port: number; token: string } | null>;
  assertPublicationFence: () => void;
  post: (
    endpoint: { port: number; token: string },
    body: Record<string, unknown>,
    signal: AbortSignal,
    timeoutMs: number,
  ) => Promise<{ statusCode: number }>;
  logError: (event: string, error: unknown, opts: { cwd?: string; sessionId?: string }) => Promise<void>;
}>;

async function defaultVerify(opts: { budgetMs: number; signal: AbortSignal }) {
  const { verifyCoreEndpoint } = await import("../bootstrap.js");
  return verifyCoreEndpoint(opts);
}

function defaultPost(
  endpoint: { port: number; token: string },
  body: Record<string, unknown>,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<{ statusCode: number }> {
  const deadline = performance.now() + timeoutMs;
  if (signal.aborted || timeoutMs <= 0
    || admitDaemonPeer({ port: endpoint.port, deadline }) === null) {
    throw new DaemonPeerRefusalError();
  }
  const remainingMs = Math.floor(deadline - performance.now());
  if (signal.aborted || remainingMs <= 0) throw new DaemonPeerRefusalError();
  return daemonJsonResponse(endpoint.port, "/ingest/terminal", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${endpoint.token}` },
    body,
    signal,
    timeoutMs: remainingMs,
  });
}

async function defaultLogError(event: string, error: unknown, opts: { cwd?: string; sessionId?: string }) {
  const { safeLogError } = await import("./hook-errors.js");
  return safeLogError(event, error, opts);
}

function withinMs(work: Promise<unknown>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    const done = (): void => {
      clearTimeout(timer);
      resolve();
    };
    work.then(done, done);
  });
}

/**
 * Record why a terminal save did not happen, without the working directory
 * (which would select the per-project database), inside the outcome reserve.
 * A failing or slow diagnostic never affects the hook.
 */
export async function reportTerminalOutcome(
  outcome: TerminalOutcome,
  event: string,
  deadline: TerminalDeadline,
  logError: TerminalSnapshotDeps["logError"] = defaultLogError,
): Promise<void> {
  if (outcome === "accepted") return;
  try {
    await withinMs(logError(event, new Error(outcome), {}), deadline.outcomeBudgetMs());
  } catch {
    // Diagnostics are best effort.
  }
}

function isTranscriptReadable(path: string): boolean {
  try {
    if (!lstatSync(path).isFile()) return false;
    accessSync(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function postFailureOutcome(error: unknown): TerminalOutcome {
  if (error instanceof DaemonPeerRefusalError) return "daemon-unavailable";
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && UNREACHABLE_CODES.includes(code)
    ? "daemon-unavailable"
    : "unconfirmed";
}

async function submit(
  input: Record<string, unknown>,
  event: string,
  deadline: TerminalDeadline,
  deps: TerminalSnapshotDeps,
  state: { accepted: boolean },
): Promise<TerminalOutcome> {
  const { session_id, cwd, transcript_path } = input;
  if (typeof session_id !== "string" || session_id === "" || typeof cwd !== "string" || cwd === "") {
    return "invalid-input";
  }
  if (typeof transcript_path !== "string" || !isTranscriptReadable(transcript_path)) {
    return "transcript-unavailable";
  }

  const verifyScope = deadline.openPhase("verify");
  let endpoint: Awaited<ReturnType<TerminalSnapshotDeps["verify"]>>;
  try {
    if (verifyScope.budgetMs <= 0) return "deadline-exhausted";
    endpoint = await deps.verify({ budgetMs: verifyScope.budgetMs, signal: verifyScope.signal });
  } finally {
    verifyScope.dispose();
  }
  if (endpoint === null) return "daemon-unavailable";

  // The fence retry runs inside the post phase, so its AbortSignal and budget
  // bound the wait and the outcome reserve stays untouched. Half of the budget
  // may go to waiting, which leaves the rest for the request itself.
  const postScope = deadline.openPhase("post");
  const postStarted = performance.now();
  try {
    try {
      await hookAdmissionRetry({
        totalMs: Math.floor(Math.max(0, postScope.budgetMs) / 2),
        signal: postScope.signal,
      })(() => deps.assertPublicationFence());
    } catch {
      return "publication-refused";
    }
    const remainingMs = Math.floor(postScope.budgetMs - (performance.now() - postStarted));
    if (postScope.signal.aborted || remainingMs <= 0) return "deadline-exhausted";
    const response = await deps.post(
      endpoint,
      { session_id, cwd, transcript_path, client: "codex", event },
      postScope.signal,
      remainingMs,
    );
    if (response.statusCode !== 202) return "ingest-failed";
    state.accepted = true;
    return "accepted";
  } catch (error) {
    return postFailureOutcome(error);
  } finally {
    postScope.dispose();
  }
}

/**
 * Hand one Interrupt or SessionEnd snapshot to the running daemon. Always
 * resolves to a successful, silent hook result; the outcome only decides
 * whether a diagnostic is logged. Once the daemon has acknowledged the
 * request, nothing later in this process can change that outcome.
 */
export async function handleTerminalSnapshot(
  stdinText: string,
  terminal: TerminalHookContext,
  overrides: Partial<TerminalSnapshotDeps> = {},
): Promise<{ exitCode: number; stdout: string }> {
  const deps: TerminalSnapshotDeps = {
    verify: defaultVerify,
    assertPublicationFence: assertHookPublicationFence,
    post: defaultPost,
    logError: defaultLogError,
    ...overrides,
  };
  const state = { accepted: false };
  let event = FALLBACK_EVENT;
  let outcome: TerminalOutcome;
  try {
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdinText);
    } catch {
      parsed = undefined;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      outcome = "invalid-input";
    } else {
      const name = (parsed as { hook_event_name?: unknown }).hook_event_name;
      if (typeof name === "string" && TERMINAL_EVENTS.includes(name)) event = name;
      outcome = await submit(parsed as Record<string, unknown>, event, terminal.deadline, deps, state);
    }
  } catch {
    outcome = state.accepted ? "accepted" : "ingest-failed";
  }
  await reportTerminalOutcome(outcome, event, terminal.deadline, deps.logError);
  return { exitCode: 0, stdout: "" };
}

export type TerminalSnapshotCommandDeps = Readonly<{
  env: NodeJS.ProcessEnv;
  deadline: TerminalDeadline;
  input: Parameters<typeof readTerminalStdin>[0];
  dispatch: (
    stdinText: string,
    terminal: TerminalHookContext,
  ) => Promise<unknown>;
  logError: TerminalSnapshotDeps["logError"];
}>;

async function defaultDispatch(stdinText: string, terminal: TerminalHookContext): Promise<unknown> {
  const { dispatchHook } = await import("./dispatch.js");
  return dispatchHook("session-snapshot", stdinText, { terminal });
}

/**
 * Entry point of `lcm session-snapshot --terminal`. It never rejects: every
 * failure, including one from the diagnostic itself, ends in a silent
 * successful exit so a hook can never disturb the session it is saving.
 */
export async function runTerminalSnapshotCommand(
  overrides: Partial<TerminalSnapshotCommandDeps> = {},
): Promise<void> {
  let deps: TerminalSnapshotCommandDeps | undefined;
  try {
    deps = {
      env: process.env,
      deadline: createTerminalDeadline(),
      input: stdin,
      dispatch: defaultDispatch,
      logError: defaultLogError,
      ...overrides,
    };
    // A disabled LCM neither reads the payload nor leaves a diagnostic.
    if (deps.env.LCM_ENABLED === "false") return;
    const scope = deps.deadline.openPhase("stdin");
    let read: Awaited<ReturnType<typeof readTerminalStdin>>;
    try {
      read = await readTerminalStdin(deps.input, scope.signal);
    } finally {
      scope.dispose();
    }
    if (read.kind !== "ok") {
      await reportTerminalOutcome(read.kind, FALLBACK_EVENT, deps.deadline, deps.logError);
      return;
    }
    await deps.dispatch(read.text, { deadline: deps.deadline });
  } catch {
    // Without constructed dependencies there is no budget or logger to use.
    if (deps !== undefined) {
      await reportTerminalOutcome("ingest-failed", FALLBACK_EVENT, deps.deadline, deps.logError);
    }
  }
}

