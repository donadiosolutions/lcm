import { existsSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { BackendPublicationJournalError } from "../../storage/backend-publication.js";
import { composeAbortSignals } from "../cancellation.js";
import { isSafeTranscriptPath } from "../project.js";
import { sendJson } from "../server.js";
import type { RouteHandler, RoutePublicationAdmission } from "../server.js";
import { validateCwd } from "../validate-cwd.js";

/** Distinct (cwd, session) pairs that may wait or run at the same time. */
export const TERMINAL_INGEST_MAX_KEYS = 8;
/** Absolute cancellation deadline per accepted request, counted from acceptance. */
export const TERMINAL_INGEST_DEADLINE_MS = 30_000;

export type TerminalIngestOutcome =
  | "captured"
  | "no-new-observations"
  | "cancelled"
  | "blocked"
  | "failed"
  | "expired";

type TerminalIngestBody = Readonly<{
  session_id: string;
  cwd: string;
  transcript_path: string;
  client: "codex";
}>;

type TerminalIngestEntry = Readonly<{
  body: TerminalIngestBody;
  /** Resolved transcript path; a later read of the same source subsumes an earlier one. */
  source: string;
  deadlineAt: number;
}>;

/** A key stays in the map, and so keeps its capacity, while it runs or waits. */
type TerminalIngestSlot = { pending: TerminalIngestEntry | undefined };

export type TerminalIngestQueueOptions = Readonly<{
  /** The ordinary ingest route handler, run exactly as the periodic scan runs it. */
  ingest: RouteHandler;
  publicationAdmission: (signal: AbortSignal) => RoutePublicationAdmission;
  shutdownSignal: AbortSignal;
  /** Called each time the queue drains to empty. */
  onDrained: () => void;
  report?: (outcome: TerminalIngestOutcome) => void;
  now?: () => number;
  deadlineMs?: number;
  maxKeys?: number;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
}>;

export type TerminalIngestQueue = Readonly<{
  /** POST /ingest/terminal: validate, enqueue and answer 202 without waiting for the ingest. */
  handler: RouteHandler;
  /** True while any accepted request is waiting, running or being retired. */
  busy: () => boolean;
  /** Settles once every accepted request has run to completion, cancellation or expiry. */
  drained: () => Promise<void>;
}>;

function classify(response: { statusCode: number; body: string }): TerminalIngestOutcome {
  if (response.statusCode === 200) {
    const { ingested } = JSON.parse(response.body) as { ingested?: unknown };
    return typeof ingested === "number" && ingested > 0 ? "captured" : "no-new-observations";
  }
  if (response.statusCode === 499) return "cancelled";
  if (response.statusCode === 503) return "blocked";
  return "failed";
}

function parseRequest(body: string): (TerminalIngestBody & { source: string }) | undefined {
  let input: unknown;
  try {
    input = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined;
  const { session_id, cwd, transcript_path, client } = input as Record<string, unknown>;
  if (
    typeof session_id !== "string" || session_id === ""
    || typeof cwd !== "string" || typeof transcript_path !== "string"
    || client !== "codex"
  ) return undefined;
  let validCwd: string;
  try {
    validCwd = validateCwd(cwd);
  } catch {
    return undefined;
  }
  const source = isSafeTranscriptPath(transcript_path, validCwd);
  if (source === false || !existsSync(source)) return undefined;
  return { session_id, cwd: validCwd, transcript_path, client, source };
}

/**
 * Accept Codex Interrupt and SessionEnd snapshots and ingest them after the
 * hook has gone. A hook may be killed three seconds after it starts, so the
 * route only validates and enqueues; the daemon owns the work from the moment
 * it answers 202.
 *
 * Each (cwd, session) key holds at most one running ingest and one pending
 * request. A newer request for the same transcript replaces the pending one
 * and re-runs after the current ingest, so a SessionEnd that follows an
 * Interrupt always reads the newest tail. A request for a different transcript
 * while one is already pending, and a ninth key, are refused before the 202.
 * Runs are sequential, use the ordinary ingest handler, and are cancelled by
 * daemon shutdown or by their own absolute deadline.
 */
export function createTerminalIngestQueue(options: TerminalIngestQueueOptions): TerminalIngestQueue {
  const now = options.now ?? Date.now;
  const deadlineMs = options.deadlineMs ?? TERMINAL_INGEST_DEADLINE_MS;
  const maxKeys = options.maxKeys ?? TERMINAL_INGEST_MAX_KEYS;
  const setTimer = options.setTimeout ?? setTimeout;
  const clearTimer = options.clearTimeout ?? clearTimeout;
  const reportOutcome = options.report ?? ((outcome: TerminalIngestOutcome): void => {
    if (outcome !== "captured") console.warn(`[lcm] terminal ingest ${outcome}`);
  });
  // Reporting and drain notification are observers: a throwing one must never
  // end the drain, leave accepted entries behind or reject the owned promise.
  const report = (outcome: TerminalIngestOutcome): void => {
    try {
      reportOutcome(outcome);
    } catch {
      // Ignored on purpose.
    }
  };
  const slots = new Map<string, TerminalIngestSlot>();
  let drain: Promise<void> | undefined;

  const ingestOnce = async (entry: TerminalIngestEntry, signal: AbortSignal): Promise<TerminalIngestOutcome> => {
    const response = { statusCode: 200, body: "" };
    const mockRes = {
      writeHead: (code: number) => { response.statusCode = code; },
      end: (data: string) => { response.body = data; },
    } as unknown as ServerResponse;
    await options.ingest({} as IncomingMessage, mockRes, JSON.stringify(entry.body), {
      withPublicationAdmission: options.publicationAdmission(signal),
      signal,
    });
    return classify(response);
  };

  const runEntry = async (entry: TerminalIngestEntry): Promise<void> => {
    const remainingMs = entry.deadlineAt - now();
    if (remainingMs <= 0) {
      report("expired");
      return;
    }
    const deadline = new AbortController();
    const timer = setTimer(() => deadline.abort(), remainingMs);
    const cancellation = composeAbortSignals([options.shutdownSignal, deadline.signal]);
    let outcome: TerminalIngestOutcome;
    try {
      outcome = await ingestOnce(entry, cancellation.signal);
    } catch (error) {
      outcome = error instanceof BackendPublicationJournalError ? "blocked" : "failed";
    } finally {
      clearTimer(timer);
      cancellation.cleanup();
    }
    report(outcome);
  };

  const runDrain = async (): Promise<void> => {
    try {
      for (;;) {
        const next = [...slots].find(([, slot]) => slot.pending !== undefined);
        if (next === undefined) return;
        const [key, slot] = next;
        const entry = slot.pending!;
        slot.pending = undefined;
        try {
          await runEntry(entry);
        } finally {
          slots.delete(key);
          // A request that arrived during the run re-runs, behind other keys.
          if (slot.pending !== undefined) slots.set(key, slot);
        }
      }
    } finally {
      drain = undefined;
      try {
        options.onDrained();
      } catch {
        // Ignored on purpose.
      }
    }
  };

  const accept = (key: string, entry: TerminalIngestEntry): boolean => {
    const slot = slots.get(key);
    if (slot === undefined) {
      if (slots.size >= maxKeys) return false;
      slots.set(key, { pending: entry });
    } else if (slot.pending !== undefined && slot.pending.source !== entry.source) {
      return false;
    } else {
      slot.pending = entry;
    }
    drain ??= runDrain();
    return true;
  };

  const handler: RouteHandler = async (_req, res, body) => {
    const request = parseRequest(body);
    if (request === undefined) {
      sendJson(res, 400, { error: "invalid terminal ingest request" });
      return;
    }
    // Shutdown and capacity are decided in the same tick as the insertion.
    if (options.shutdownSignal.aborted) {
      sendJson(res, 503, { error: "daemon is shutting down" });
      return;
    }
    const { source, ...ingestBody } = request;
    const accepted = accept(`${ingestBody.cwd}\0${ingestBody.session_id}`, {
      body: ingestBody,
      source,
      deadlineAt: now() + deadlineMs,
    });
    if (!accepted) {
      sendJson(res, 503, { error: "terminal ingest queue is unavailable" });
      return;
    }
    try {
      sendJson(res, 202, { accepted: true });
    } catch {
      // The request is already queued; a failed reply cannot withdraw it.
    }
  };

  return {
    handler,
    busy: () => drain !== undefined,
    drained: () => drain ?? Promise.resolve(),
  };
}

