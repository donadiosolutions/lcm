import type { DaemonClient } from "../daemon/client.js";
import { ensureDaemon } from "../daemon/lifecycle.js";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { safeLogError } from "./hook-errors.js";
import { buildMemoryContext } from "./memory-context.js";
import { daemonPidPath, lcmHomeDir } from "../runtime-paths.js";
import { firePromoteEventsNotifyRequest } from "./session-end.js";
import {
  clearDaemonNotice,
  maybeEmitDaemonNotice,
  sanitizeDaemonRefusalReason,
} from "./daemon-notice.js";
import { isDaemonRefusalReason, type DaemonRefusalReason } from "../daemon/remediation.js";
import type { StorageBackendSelection } from "../storage/backend.js";
import { selectStorageBackend } from "../storage/backend.js";

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

const LEARNING_INSTRUCTION = `<learning-instruction>
When you recognize a durable insight, call lcm_store immediately:
- decision: architectural/design choice with trade-offs
- preference: user working style or tool preference
- root-cause: bug cause that took effort to uncover
- pattern: codebase convention not documented elsewhere
- gotcha: non-obvious pitfall or footgun
- solution: non-trivial fix worth remembering
- workflow: multi-step process that works

Tag prefixes: type: | scope: | project: | sprint: | source: | priority: | owner: | signal:
Usage: lcm_store(text: "concise insight with why", tags: ["type:decision", "project:<repo>"])

When you act on a surfaced memory (use it to inform a decision, avoid a known pitfall, or reference it in your work), emit:
lcm_store(text: "Acted on memory <id> — <one-line how>", tags: ["signal:memory_used", "memory_id:<id>"])
</learning-instruction>`;

export async function handleUserPromptSubmit(
  stdin: string,
  client: DaemonClient,
  port?: number,
  storage: StorageBackendSelection = { backend: "sqlite" },
): Promise<{ exitCode: number; stdout: string }> {
  const daemonPort = port ?? 3737;
  try {
    const input = JSON.parse(stdin || "{}");
    if (!input.prompt || typeof input.prompt !== "string" || !input.prompt.trim()) {
      return { exitCode: 0, stdout: LEARNING_INSTRUCTION };
    }
    const cwd = resolveHookCwd(input.cwd);
    let notification: PromoteEventsNotification | undefined;

    // Sidecar event extraction — must happen before prompt-search, must never throw
    try {
      const { extractUserPromptEvents } = await import("./extractors.js");
      const { SQLiteLocalHookOutboxFactory } = await import("../storage/local-hook-outbox.js");
      const { eventsDbPath } = await import("../db/events-path.js");
      const { ensureProjectDir } = await import("../daemon/project.js");

      const prompt = String(input.prompt);
      const { scrubExtractedEvents } = await import("./event-scrubbing.js");
      const events = await scrubExtractedEvents(extractUserPromptEvents(prompt), cwd);

      if (events.length > 0 && input.session_id && typeof input.session_id === "string") {
        ensureProjectDir(cwd);
        const outboxFactory = new SQLiteLocalHookOutboxFactory();
        const db = await outboxFactory.open(eventsDbPath(cwd));
        try {
          for (const event of events) {
            await db.insertEvent(input.session_id, event, "UserPromptSubmit");
          }
          const priority = Math.min(...events.map(event => event.priority));
          const pendingCount = (await db.getHealthStats()).unprocessed;
          notification = {
            cwd,
            priority,
            pendingCount,
            sourceHook: "UserPromptSubmit",
          };
        } finally {
          await outboxFactory.close();
        }
      }
    } catch (e) {
      await safeLogError("UserPromptSubmit", e, {
        cwd: input.cwd ?? process.env.CLAUDE_PROJECT_DIR,
        sessionId: input.session_id,
      });
    }

    try {
      selectStorageBackend(storage);
    } catch {
      emitAdmissionNotice(undefined, "ambiguous");
      return { exitCode: 0, stdout: LEARNING_INSTRUCTION };
    }
    let ensureResult: EnsureResultWithRefusal;
    try {
      ensureResult = await ensureDaemon({
      port: daemonPort,
      pidFilePath: daemonPidPath(),
      spawnTimeoutMs: 5000,
      expectedStorageBackend: storage.backend,
      enforceUserManagerParent: true,
      });
    } catch {
      emitAdmissionNotice(undefined, "ambiguous");
      return { exitCode: 0, stdout: LEARNING_INSTRUCTION };
    }
    if (!ensureResult.connected) {
      emitAdmissionNotice(ensureResult, "not-running");
      return { exitCode: 0, stdout: LEARNING_INSTRUCTION };
    }
    clearAdmissionNotice();

    if (notification) {
      try {
        firePromoteEventsNotifyRequest(daemonPort, notification);
      } catch (e) {
        await safeLogError("UserPromptSubmit", e, {
          cwd,
          sessionId: input.session_id,
        });
      }
    }

    const result = await client.post<PromptSearchResponse>("/prompt-search", {
      query: input.prompt,
      cwd,
      session_id: input.session_id,
      learningInstructionBytes: Buffer.byteLength(LEARNING_INSTRUCTION, "utf8"),
    });

    if (!result.hints || result.hints.length === 0) {
      return { exitCode: 0, stdout: LEARNING_INSTRUCTION };
    }

    const hint = buildMemoryContext(result.hints, result.ids ?? [])!;
    return { exitCode: 0, stdout: `${hint}\n${LEARNING_INSTRUCTION}` };
  } catch {
    return { exitCode: 0, stdout: LEARNING_INSTRUCTION };
  }
}
