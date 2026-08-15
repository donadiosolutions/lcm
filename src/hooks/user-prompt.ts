import type { DaemonClient } from "../daemon/client.js";
import { ensureDaemon } from "../daemon/lifecycle.js";
import { loadHookConfig } from "./config.js";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { safeLogError } from "./hook-errors.js";
import {
  buildMemoryContext,
  buildMemoryFeedbackInstruction,
  MEMORY_FEEDBACK_INSTRUCTION,
} from "./memory-context.js";
import { configPath as defaultConfigPath, daemonPidPath, lcmHomeDir } from "../runtime-paths.js";
import { firePromoteEventsNotifyRequest } from "./session-end.js";
import {
  clearDaemonNotice,
  maybeEmitDaemonNotice,
  sanitizeDaemonRefusalReason,
} from "./daemon-notice.js";
import { isDaemonRefusalReason, type DaemonRefusalReason } from "../daemon/remediation.js";
import type { StorageBackendSelection } from "../storage/backend.js";
import { appendLocalHookEvents } from "./local-enqueue.js";
import {
  assertHookPublicationFence,
  assertHookRootEstablished,
  isBackendPublicationEvidenceMissing,
  isBackendPublicationJournalError,
} from "./publication-fence.js";

type PromptSearchResponse = {
  hints: string[];
  ids?: string[];
};

type PromoteEventsNotification = {
  cwd: string;
  priority: number;
  pendingCount: number;
  sourceHook: "UserPromptSubmit";
};

type EnsureResultWithRefusal = Readonly<{ connected: boolean; refusalReason?: unknown }>;

function canonicalRemediationScope(): Readonly<{ scope: string; stateRoot: string }> {
  const root = lcmHomeDir(homedir());
  try {
    const canonical = realpathSync(root);
    return { scope: canonical, stateRoot: canonical };
  } catch {
    const lexical = resolve(root);
    return { scope: lexical, stateRoot: lexical };
  }
}

function refusalReason(
  result: EnsureResultWithRefusal | undefined,
  fallback: DaemonRefusalReason,
): DaemonRefusalReason {
  return isDaemonRefusalReason(result?.refusalReason)
    ? result.refusalReason
    : sanitizeDaemonRefusalReason(fallback);
}

function emitAdmissionNotice(result: EnsureResultWithRefusal | undefined, fallback: DaemonRefusalReason): void {
  const scope = canonicalRemediationScope();
  maybeEmitDaemonNotice({ ...scope, reason: refusalReason(result, fallback) });
}

function clearAdmissionNotice(): void {
  clearDaemonNotice(canonicalRemediationScope());
}

function resolveHookCwd(inputCwd: unknown): string {
  const cwd = typeof inputCwd === "string" ? inputCwd : "";
  const envCwd = typeof process.env.CLAUDE_PROJECT_DIR === "string"
    ? process.env.CLAUDE_PROJECT_DIR
    : "";
  if (cwd.trim().length > 0) return cwd;
  if (envCwd.trim().length > 0) return envCwd;
  return process.cwd();
}

function emptyHookResponse(): { exitCode: number; stdout: string } {
  return { exitCode: 0, stdout: "" };
}

export async function handleUserPromptSubmit(
  stdin: string,
  client?: DaemonClient,
  port?: number,
  storage?: StorageBackendSelection,
): Promise<{ exitCode: number; stdout: string }> {
  try {
    const input = JSON.parse(stdin || "{}");
    if (!input.prompt || typeof input.prompt !== "string" || !input.prompt.trim()) {
      return emptyHookResponse();
    }
    const cwd = resolveHookCwd(input.cwd);
    try {
      // Missing topology is an operator/bootstrap failure, not an unresolved
      // publication state. Stop before selection/daemon admission in that
      // case; an established root still permits local enqueue during a
      // publication transition.
      assertHookRootEstablished();
    } catch {
      return emptyHookResponse();
    }
    let notification: PromoteEventsNotification | undefined;
    // Hook repair is allowed when no local enqueue is needed, and only after
    // a required enqueue completes. A failed enqueue must not be followed by
    // settings mutation that was intended to occur after durable admission.
    let hookRepairAllowed = true;

    // Sidecar event extraction — must happen before prompt-search, must never throw
    try {
      const { extractUserPromptEvents } = await import("./extractors.js");
      const { ensureProjectDir } = await import("../daemon/project.js");

      const prompt = String(input.prompt);
      const { scrubExtractedEvents } = await import("./event-scrubbing.js");
      const extractedEvents = extractUserPromptEvents(prompt);
      let events;
      try {
        events = await scrubExtractedEvents(extractedEvents, cwd);
      } catch (error) {
        if (!isBackendPublicationJournalError(error)) throw error;
        events = await scrubExtractedEvents(extractedEvents, cwd, []);
      }

      if (events.length > 0 && input.session_id && typeof input.session_id === "string") {
        hookRepairAllowed = false;
        const enqueueResult = await appendLocalHookEvents({
          cwd,
          sessionId: input.session_id,
          events,
          sourceHook: "UserPromptSubmit",
        });
        hookRepairAllowed = true;
        const priority = Math.min(...events.map(event => event.priority));
        notification = {
          cwd,
          priority,
          pendingCount: enqueueResult.pendingCount,
          sourceHook: "UserPromptSubmit",
        };

        // Project metadata is a selected-state consumer and must follow the
        // durable local enqueue, including when the publication is unresolved.
        assertHookPublicationFence();
        ensureProjectDir(cwd);
      }
    } catch (e) {
      if (isBackendPublicationJournalError(e)) {
        if (isBackendPublicationEvidenceMissing(e)) return emptyHookResponse();
        throw e;
      }
      await safeLogError("UserPromptSubmit", e, {
        cwd: input.cwd ?? process.env.CLAUDE_PROJECT_DIR,
        sessionId: input.session_id,
      });
    }

    // UserPromptSubmit is excluded from dispatcher-level repair so local
    // events can cross their durable boundary first. Repair every non-Codex
    // invocation here, after the optional enqueue/no-enqueue decision and its
    // explicit success state, with a short publication fence immediately
    // before the settings mutation.
    const hookClient = typeof input.client === "string" ? input.client : process.env.LCM_CLIENT;
    if (hookRepairAllowed && hookClient !== "codex") {
      assertHookPublicationFence();
      const { validateAndFixHooks } = await import("./auto-heal.js");
      validateAndFixHooks();
    }

    let effectiveStorage = storage;
    let daemonPort = port;
    let effectiveClient = client;
    if (effectiveStorage === undefined || daemonPort === undefined || effectiveClient === undefined) {
      // loadHookConfig owns its own publication/config lock. Re-admit before
      // invoking it, but do not retain a broader lock over the read.
      assertHookPublicationFence();
      const config = loadHookConfig(defaultConfigPath());
      effectiveStorage ??= config.storage;
      daemonPort ??= config.daemonPort;
    }
    const selectedStorage = effectiveStorage ?? { backend: "sqlite" };
    const selectedPort = daemonPort ?? 3737;
    if (effectiveClient === undefined) {
      effectiveClient = new (await import("../daemon/client.js")).DaemonClient(
        `http://127.0.0.1:${selectedPort}`,
      );
    }

    try {
      assertHookPublicationFence();
    } catch (error) {
      if (isBackendPublicationJournalError(error)) {
        if (isBackendPublicationEvidenceMissing(error)) return emptyHookResponse();
        throw error;
      }
      emitAdmissionNotice(undefined, "ambiguous");
      return emptyHookResponse();
    }
    let ensureResult: EnsureResultWithRefusal;
    try {
      // ensureDaemon performs its own before/after lifecycle admission and
      // must not run while another publication lock is retained.
      assertHookPublicationFence();
      ensureResult = await ensureDaemon({
        port: selectedPort,
        pidFilePath: daemonPidPath(),
        spawnTimeoutMs: 5000,
        expectedStorageBackend: selectedStorage.backend,
        enforceUserManagerParent: true,
      });
    } catch (error) {
      if (isBackendPublicationJournalError(error)) {
        if (isBackendPublicationEvidenceMissing(error)) return emptyHookResponse();
        throw error;
      }
      emitAdmissionNotice(undefined, "ambiguous");
      return emptyHookResponse();
    }
    if (!ensureResult.connected) {
      emitAdmissionNotice(ensureResult, "not-running");
      return emptyHookResponse();
    }
    clearAdmissionNotice();

    if (notification) {
      try {
        firePromoteEventsNotifyRequest(selectedPort, notification);
      } catch (e) {
        if (isBackendPublicationJournalError(e)) throw e;
        await safeLogError("UserPromptSubmit", e, {
          cwd,
          sessionId: input.session_id,
        });
      }
    }

    // Re-admit immediately before the daemon request; never hold the file
    // lock over a network call whose server may independently read config.
    assertHookPublicationFence();
    const result = await effectiveClient.post<PromptSearchResponse>("/prompt-search", {
      query: input.prompt,
      cwd,
      session_id: input.session_id,
      learningInstructionBytes: Buffer.byteLength(MEMORY_FEEDBACK_INSTRUCTION, "utf8"),
    });

    if (!Array.isArray(result.hints) || result.hints.length === 0) {
      return emptyHookResponse();
    }

    const hints = result.hints.filter(
      (hint): hint is string => typeof hint === "string" && hint.trim().length > 0,
    );
    if (hints.length === 0) return emptyHookResponse();

    const ids = result.ids ?? [];
    const context = buildMemoryContext(hints, ids)!;
    const feedback = buildMemoryFeedbackInstruction(ids);
    return { exitCode: 0, stdout: feedback ? `${context}\n${feedback}` : context };
  } catch (error) {
    if (isBackendPublicationJournalError(error)) {
      if (isBackendPublicationEvidenceMissing(error)) return emptyHookResponse();
      throw error;
    }
    return emptyHookResponse();
  }
}
