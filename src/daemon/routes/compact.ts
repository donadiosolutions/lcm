import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  ConfigValidationError,
  LLM_REASONING_EFFORTS,
  reasoningEffortsForProvider,
  resolveLlmRequestPolicy,
  supportsRequestTimeout,
  type DaemonConfig,
  type LlmReasoningEffort,
  type LlmRequestPolicy,
} from "../config.js";
import {
  projectIdentity,
  ensureProjectDirForIdentity,
  isSafeTranscriptPath,
} from "../project.js";
import { enqueue } from "../project-queue.js";
import { sendJson } from "../server.js";
import type { RouteHandler, RoutePublicationAdmission } from "../server.js";
import { CompactionEngine, MANUAL_COMPACT_FRESH_TAIL_COUNT } from "../../compaction.js";
import { normalizeTranscriptClient, parseTranscriptForClient } from "../../transcript-provider.js";
import { ScrubEngine } from "../../scrub.js";
import {
  makeSummarizerCache,
  resolveEffectiveProvider,
  type CompactClient,
  type EffectiveProvider,
} from "../summarizer.js";
import { validateCwd } from "../validate-cwd.js";
import {
  BackendPublicationJournalError,
} from "../../storage/backend-publication.js";
import {
  createStorageBackendFactory,
  type ProjectStorage,
  type StorageBackendFactory,
  type StorageIdentityContext,
  type TransactionRepositories,
} from "../../storage/index.js";
import {
  closeRouteStorage,
  stagedPostgreSqlFactoryUnavailableResponse,
  storageRouteFailureResponse,
} from "./storage-lifecycle.js";

interface CompactRequestBody {
  session_id: string;
  cwd: string;
  transcript_path?: string;
  skip_ingest?: boolean;
  client?: CompactClient;
  previous_summary?: string;
  reasoning_effort?: unknown;
  fast_mode?: boolean;
  request_timeout_ms?: unknown;
  retry?: unknown;
}

const COMPACT_CLIENTS: readonly CompactClient[] = ["claude", "codex"];

function validateCompactRequestBody(input: Record<string, unknown>): string | undefined {
  if (typeof input.session_id !== "string" || input.session_id.length === 0) {
    return "session_id must be a non-empty string";
  }
  if (typeof input.cwd !== "string" || input.cwd.length === 0) {
    return "cwd must be a non-empty string";
  }
  if (input.transcript_path !== undefined && typeof input.transcript_path !== "string") {
    return "transcript_path must be a string";
  }
  if (input.skip_ingest !== undefined && typeof input.skip_ingest !== "boolean") {
    return "skip_ingest must be a boolean";
  }
  if (
    input.client !== undefined
    && (typeof input.client !== "string" || !COMPACT_CLIENTS.includes(input.client as CompactClient))
  ) {
    return `client must be one of: ${COMPACT_CLIENTS.join(", ")}`;
  }
  if (input.previous_summary !== undefined && typeof input.previous_summary !== "string") {
    return "previous_summary must be a string";
  }
  if (input.reasoning_effort !== undefined && typeof input.reasoning_effort !== "string") {
    return "reasoning_effort must be a string";
  }
  if (input.fast_mode !== undefined && typeof input.fast_mode !== "boolean") {
    return "fast_mode must be a boolean";
  }
  if (input.request_timeout_ms !== undefined && typeof input.request_timeout_ms !== "number") {
    return "request_timeout_ms must be a number";
  }
  if (input.retry !== undefined && (typeof input.retry !== "object" || input.retry === null || Array.isArray(input.retry))) {
    return "retry must be an object";
  }
  return undefined;
}

function resolveCompactRequestPolicy(config: DaemonConfig, input: CompactRequestBody): LlmRequestPolicy {
  const retryInput = input.retry as Record<string, unknown> | undefined;
  let retry: Record<string, unknown> | undefined;
  if (retryInput !== undefined) {
    const keyMap = new Map<string, string>([
      ["max_attempts", "maxAttempts"],
      ["initial_delay_ms", "initialDelayMs"],
      ["max_delay_ms", "maxDelayMs"],
      ["multiplier", "multiplier"],
    ]);
    retry = Object.create(null) as Record<string, unknown>;
    for (const [key, value] of Object.entries(retryInput)) {
      const canonical = keyMap.get(key);
      if (!canonical) throw new ConfigValidationError(`retry.${key}`, `unknown retry policy key ${JSON.stringify(key)}`);
      retry[canonical] = value;
    }
  }
  return resolveLlmRequestPolicy(
    { requestTimeoutMs: config.llm.requestTimeoutMs, retry: config.llm.retry },
    { requestTimeoutMs: input.request_timeout_ms, retry },
    "compact",
  );
}

function fmtN(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return String(n);
}

export function buildCompactionMessage(p: {
  tokensBefore: number; tokensAfter: number;
  messageCount: number; summaryCount: number;
  maxDepth: number; promotedCount: number;
}): string {
  const saved = p.tokensBefore - p.tokensAfter;
  const ratio = p.tokensAfter > 0 ? (p.tokensBefore / p.tokensAfter).toFixed(1) : "–";
  const pct = p.tokensBefore > 0
    ? ((1 - p.tokensAfter / p.tokensBefore) * 100).toFixed(1)
    : "0.0";
  const barWidth = 30;
  const filled = p.tokensBefore > 0
    ? Math.round((1 - p.tokensAfter / p.tokensBefore) * barWidth) : 0;
  const bar = "█".repeat(filled) + "░".repeat(barWidth - filled);
  const border = "━".repeat(46);
  const numW = Math.max(
    String(p.messageCount).length,
    String(p.summaryCount).length,
    String(p.maxDepth).length,
    String(p.promotedCount).length,
    1,
  );
  const pad = (n: number) => String(n).padStart(numW);
  const rows = [
    `  ${pad(p.messageCount)}  messages  →  ${p.summaryCount} summaries`,
    `  ${pad(p.maxDepth)}  DAG layers deep`,
    ...(p.promotedCount > 0
      ? [`  ${pad(p.promotedCount)}  insight${p.promotedCount > 1 ? "s" : ""} promoted to long-term memory`]
      : []),
  ];
  return [
    border,
    `  🧠  lcm · compaction complete`,
    border,
    ``,
    `  ${fmtN(p.tokensBefore)} ──────────────────────→ ${fmtN(p.tokensAfter)}`,
    `  ${bar}  ${pct}% saved`,
    `  ${ratio}×  compression  ·  ${fmtN(saved)} tokens freed`,
    ``,
    ...rows,
    ``,
    border,
    `  Nothing was lost. Everything is remembered.`,
    border,
  ].join("\n");
}

// In-memory justCompacted map (session_id -> timestamp)
export const justCompactedMap = new Map<string, number>();
export const JUST_COMPACTED_TTL_MS = 30_000;

// Guard against concurrent compactions for the same session
const compactingNow = new Set<string>();

const PROJECT_REPOSITORY_KEYS = [
  "conversations",
  "summaries",
  "context",
  "largeFiles",
  "promotedMemory",
  "recall",
  "redactionAdmin",
  "lexicalSearch",
  "coordination",
] as const satisfies readonly (keyof ProjectStorage)[];

function admittedRepository<T extends object>(
  repository: T,
  withPublicationAdmission: RoutePublicationAdmission,
): T {
  return new Proxy(repository, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => withPublicationAdmission(
        () => Reflect.apply(value, target, args),
      );
    },
  });
}

/**
 * Keep model work outside publication admission while fencing every storage
 * method. Transactions deliberately pass the backend's transaction-scoped
 * repositories through unchanged so their callbacks remain inside one
 * admission instead of trying to reacquire the same lock.
 */
function admittedProjectStorage(
  project: ProjectStorage,
  withPublicationAdmission: RoutePublicationAdmission,
): ProjectStorage {
  const repositories = Object.fromEntries(
    PROJECT_REPOSITORY_KEYS.map((key) => [
      key,
      admittedRepository(project[key] as object, withPublicationAdmission),
    ]),
  ) as Pick<ProjectStorage, typeof PROJECT_REPOSITORY_KEYS[number]>;
  return {
    ...project,
    ...repositories,
    transaction: <T>(callback: (repositories: TransactionRepositories) => Promise<T>): Promise<T> =>
      withPublicationAdmission<T>(() => project.transaction<T>(callback)),
    health: () => withPublicationAdmission(() => project.health()),
    // Cleanup must remain possible after an admission failure.
    close: () => project.close(),
  };
}

function sameStorageIdentity(
  expected: StorageIdentityContext & { readonly localProjectId: string },
  actual: StorageIdentityContext & { readonly localProjectId: string },
): boolean {
  return expected.id === actual.id
    && expected.localProjectId === actual.localProjectId
    && expected.canonical === actual.canonical
    && expected.remoteProjectId === actual.remoteProjectId;
}


export function createCompactHandler(config: DaemonConfig, storageFactory?: StorageBackendFactory): RouteHandler {
  const getSummarizer = makeSummarizerCache(config);

  return async (_req, res, body, context) => {
    let parsed: unknown;
    let ownedFactory: StorageBackendFactory | undefined;
    let activeFactory: StorageBackendFactory | undefined;
    try {
      parsed = JSON.parse(body || "{}");
    } catch {
      sendJson(res, 400, { error: "Invalid JSON body" });
      return;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      sendJson(res, 400, { error: "Invalid JSON body" });
      return;
    }
    const validationError = validateCompactRequestBody(parsed as Record<string, unknown>);
    if (validationError) {
      sendJson(res, 400, { error: validationError });
      return;
    }
    const input = parsed as CompactRequestBody;
    const { session_id, transcript_path, skip_ingest, client, previous_summary } = input;
    const MAX_PREVIOUS_SUMMARY_LENGTH = 50_000;
    const validatedPreviousSummary = typeof previous_summary === "string"
      ? previous_summary.slice(0, MAX_PREVIOUS_SUMMARY_LENGTH)
      : undefined;

    let cwd: string;
    try {
      cwd = validateCwd(input.cwd);
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : "invalid cwd" });
      return;
    }

    const withPublicationAdmission = context?.withPublicationAdmission;
    if (withPublicationAdmission === undefined) {
      sendJson(res, 503, {
        status: "blocked",
        error: "backend publication admission blocked",
      });
      return;
    }

    const effectiveProvider = resolveEffectiveProvider(config, client);
    const apiMode = effectiveProvider === "openai"
      ? config.llm.apiMode ?? "chat-completions"
      : undefined;
    let reasoningEffortOverride: LlmReasoningEffort | undefined;
    const validReasoningEfforts = reasoningEffortsForProvider(effectiveProvider, apiMode);
    if (input.reasoning_effort !== undefined) {
      if (validReasoningEfforts.length === 0) {
        const providerContext = effectiveProvider === "openai"
          ? `${effectiveProvider} with apiMode ${JSON.stringify(apiMode)}`
          : effectiveProvider;
        sendJson(res, 400, {
          error: `reasoning_effort is not supported by ${providerContext}`,
        });
        return;
      }
      if (
        typeof input.reasoning_effort !== "string"
        || !LLM_REASONING_EFFORTS.includes(input.reasoning_effort as LlmReasoningEffort)
        || !validReasoningEfforts.includes(input.reasoning_effort as LlmReasoningEffort)
      ) {
        sendJson(res, 400, {
          error: `Invalid reasoning_effort=${JSON.stringify(input.reasoning_effort)} for ${effectiveProvider}. Valid values: ${validReasoningEfforts.join(", ")}`,
        });
        return;
      }
      reasoningEffortOverride = input.reasoning_effort as LlmReasoningEffort;
    }
    const effectiveReasoningEffort = validReasoningEfforts.length > 0
      ? reasoningEffortOverride ?? config.llm.reasoningEffort
      : undefined;
    const processProvider = effectiveProvider === "claude-process" || effectiveProvider === "codex-process";
    if (input.fast_mode !== undefined && !processProvider) {
      sendJson(res, 400, { error: "fast_mode requires a claude-process or codex-process provider" });
      return;
    }
    const effectiveFastMode = processProvider ? input.fast_mode ?? config.llm.fastMode ?? false : undefined;
    if (input.request_timeout_ms !== undefined && !supportsRequestTimeout(effectiveProvider)) {
      sendJson(res, 400, { error: "request_timeout_ms is not supported by the effective provider" });
      return;
    }
    if (input.retry !== undefined && effectiveProvider !== "openai") {
      sendJson(res, 400, { error: "retry requires llm.provider=\"openai\"" });
      return;
    }
    let effectiveRequestPolicy: LlmRequestPolicy | undefined;
    if (supportsRequestTimeout(effectiveProvider)) {
      try {
        effectiveRequestPolicy = resolveCompactRequestPolicy(config, input);
      } catch (error) {
        sendJson(res, 400, {
          error: error instanceof ConfigValidationError ? error.message : "Invalid request policy",
        });
        return;
      }
    }
    const effectiveRequestTimeoutMs = effectiveRequestPolicy?.requestTimeoutMs ?? null;
    const effectiveRetry = effectiveProvider === "openai" ? effectiveRequestPolicy!.retry : null;

    let admittedIdentity: StorageIdentityContext & { readonly localProjectId: string };
    try {
      const initialAdmission = await withPublicationAdmission(async publicationLockToken => {
        activeFactory = storageFactory ?? (ownedFactory = createStorageBackendFactory(
          config.storage,
          undefined,
          undefined,
          publicationLockToken,
        ));
        const identity = projectIdentity(cwd, config.storage, publicationLockToken);
        return {
          identity,
          stagedFailure: stagedPostgreSqlFactoryUnavailableResponse(activeFactory, "compact"),
        };
      });
      admittedIdentity = initialAdmission.identity;
      if (initialAdmission.stagedFailure) {
        sendJson(res, 503, initialAdmission.stagedFailure);
        await closeRouteStorage(undefined, ownedFactory);
        return;
      }
    } catch (err) {
      if (err instanceof BackendPublicationJournalError) {
        sendJson(res, 503, {
          status: "blocked",
          error: "backend publication admission blocked",
        });
      } else {
        const storageFailure = storageRouteFailureResponse(
          activeFactory,
          err,
          "compact",
        );
        if (storageFailure) {
          sendJson(res, storageFailure.status, storageFailure.body);
        } else {
          sendJson(res, 500, {
            error: err instanceof Error ? err.message : "compact failed",
          });
        }
      }
      await closeRouteStorage(undefined, ownedFactory);
      return;
    }
    const localIdentity = {
      id: admittedIdentity.localProjectId,
      canonical: admittedIdentity.canonical,
      ...(admittedIdentity.remoteProjectId
        ? { remoteProjectId: admittedIdentity.remoteProjectId }
        : {}),
    };
    const withProjectAdmission: RoutePublicationAdmission = async operation =>
      withPublicationAdmission(async publicationLockToken => {
        const currentIdentity = projectIdentity(cwd, config.storage, publicationLockToken);
        if (!sameStorageIdentity(admittedIdentity, currentIdentity)) {
          throw new BackendPublicationJournalError(
            "unexpected-state",
            "compact project identity changed during publication admission",
          );
        }
        return operation(publicationLockToken);
      });
    const openProjectWithAdmission = async (): Promise<ProjectStorage> => {
      let openedProject: ProjectStorage | undefined;
      try {
        return await withProjectAdmission(async publicationLockToken => {
          const project = await activeFactory!.openProject(admittedIdentity, publicationLockToken);
          openedProject = project;
          return project;
        });
      } catch (error) {
        // The admission wrapper can fail after its operation returns while it
        // revalidates publication state. Keep cleanup possible in that case.
        await closeRouteStorage(openedProject, undefined);
        throw error;
      }
    };

    // Guard must be checked and set synchronously (before any await) to prevent
    // concurrent requests from racing through the has() check before add() runs.
    if (compactingNow.has(session_id)) {
      if (config.storage.backend === "postgresql") {
        try {
          const duplicateProject = await openProjectWithAdmission();
          await closeRouteStorage(duplicateProject, undefined);
        } catch (err) {
          if (err instanceof BackendPublicationJournalError) {
            sendJson(res, 503, {
              status: "blocked",
              error: "backend publication admission blocked",
            });
          } else {
            const storageFailure = storageRouteFailureResponse(
              activeFactory,
              err,
              "compact",
            );
            if (storageFailure) {
              sendJson(res, storageFailure.status, storageFailure.body);
            } else {
              sendJson(res, 500, {
                error: err instanceof Error ? err.message : "compact failed",
              });
            }
          }
          return;
        }
      }
      sendJson(res, 200, { skipped: true, actionTaken: false, summary: "Compaction already in progress for this session." });
      return;
    }
    compactingNow.add(session_id);

    const providerLabels: Record<EffectiveProvider, string> = {
      "claude-process": "Claude (process)",
      "codex-process": "Codex (process)",
      "anthropic": "Anthropic API",
      "openai": "OpenAI API",
      "disabled": "Disabled",
    };
    const providerLabel = providerLabels[effectiveProvider] ?? effectiveProvider;

    try {
      const summarize = await getSummarizer(
        effectiveProvider,
        effectiveReasoningEffort,
        effectiveFastMode,
        effectiveRequestPolicy,
      );
      if (!summarize) {
        if (config.storage.backend === "postgresql") {
          const stagedProject = await openProjectWithAdmission();
          await closeRouteStorage(stagedProject, undefined);
        }
        sendJson(res, 200, {
          actionTaken: false,
          summary: "Summarization disabled — no summarizer configured.",
          providerId: effectiveProvider,
          providerLabel,
          apiMode,
          reasoningEffort: effectiveReasoningEffort ?? null,
          fastMode: effectiveFastMode ?? null,
          requestTimeoutMs: effectiveRequestTimeoutMs,
          retry: effectiveRetry,
        });
        return;
      }
      let project: ProjectStorage | undefined;
      project = await openProjectWithAdmission();
      const admittedProject = admittedProjectStorage(project, withProjectAdmission);
      const pid = admittedIdentity.localProjectId;
      const result = await enqueue(pid, async () => {
        try {
          const localProjectDir = await withProjectAdmission(() =>
            ensureProjectDirForIdentity(localIdentity));

          const scrubber = await ScrubEngine.forProject(
            config.security?.sensitivePatterns ?? [],
            localProjectDir,
          );

          const conversation = await admittedProject.conversations.getOrCreateConversation(session_id);

          // Ingest new messages from the transcript into the DB.
          const safeTranscriptPath = transcript_path ? isSafeTranscriptPath(transcript_path, cwd) : false;
          if (!skip_ingest && safeTranscriptPath && existsSync(safeTranscriptPath)) {
            const parsed = parseTranscriptForClient(safeTranscriptPath, normalizeTranscriptClient(client));
            await admittedProject.transaction(async (repositories) => {
              const storedCount = await repositories.conversations.getMessageCount(
                conversation.conversationId,
              );
              const newMessages = parsed.slice(storedCount);
              if (newMessages.length > 0) {
                const ingestCounts = { gitleaks: 0, builtIn: 0, global: 0, project: 0 };
                const inputs = newMessages.map((m, i) => {
                  const { text: scrubbedContent, gitleaks, builtIn, global: globalCount, project } = scrubber.scrubWithCounts(m.content);
                  ingestCounts.gitleaks += gitleaks;
                  ingestCounts.builtIn += builtIn;
                  ingestCounts.global += globalCount;
                  ingestCounts.project += project;
                  return {
                    conversationId: conversation.conversationId,
                    seq: storedCount + i,
                    role: m.role as "user" | "assistant" | "system",
                    content: scrubbedContent,
                    tokenCount: m.tokenCount,
                  };
                });
                const records = await repositories.conversations.createMessagesBulk(inputs);
                await repositories.redactionAdmin.upsertCounts(ingestCounts);
                await repositories.context.appendContextMessages(
                  conversation.conversationId,
                  records.map((record) => record.messageId),
                );
              }
            });
          }

          // Check if there's anything to compact
          const tokenCount = await admittedProject.context.getContextTokenCount(conversation.conversationId);

          if (tokenCount === 0) {
            return {
              actionTaken: false,
              summary: "No messages to compact.",
              providerId: effectiveProvider,
              providerLabel,
              apiMode,
              reasoningEffort: effectiveReasoningEffort ?? null,
              fastMode: effectiveFastMode ?? null,
              requestTimeoutMs: effectiveRequestTimeoutMs,
              retry: effectiveRetry,
            };
          }

          const engine = new CompactionEngine(admittedProject, {
            contextThreshold: 0.75,
            freshTailCount: MANUAL_COMPACT_FRESH_TAIL_COUNT,
            leafMinFanout: 3,
            condensedMinFanout: 2,
            condensedMinFanoutHard: 1,
            incrementalMaxDepth: 0,
            leafTargetTokens: config.compaction.leafTokens,
            condensedTargetTokens: 900,
            maxRounds: 10,
            scrubber,
          });

          const compactResult = await engine.compact({
            conversationId: conversation.conversationId,
            tokenBudget: 200_000,
            summarize,
            force: true,
            previousSummaryContent: validatedPreviousSummary,
          });

          // Gather stats for the compaction message (always, regardless of actionTaken)
          const allSummaries = await admittedProject.summaries.getSummariesByConversation(conversation.conversationId);
          const finalMsgCount = await admittedProject.conversations.getMessageCount(conversation.conversationId);
          const maxDepth = allSummaries.length > 0 ? Math.max(...allSummaries.map((s) => s.depth)) : 0;

          // Promotion is now handled by the standalone /promote route
          const promotedCount = 0;

          // Update meta.json
          try {
            await withProjectAdmission(() => {
              const metaPath = join(localProjectDir, "meta.json");
              let meta: Record<string, unknown> = {};
              try {
                meta = JSON.parse(readFileSync(metaPath, "utf-8"));
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
              }
              meta.cwd = localIdentity.canonical;
              meta.lastCompact = new Date().toISOString();
              writeFileSync(metaPath, JSON.stringify(meta, null, 2) + "\n");
            });
          } catch (error) {
            if (error instanceof BackendPublicationJournalError) throw error;
            // Meta persistence remains best-effort for ordinary filesystem failures.
          }

          // Set justCompacted flag
          justCompactedMap.set(session_id, Date.now());

          const summaryMsg = compactResult.actionTaken
            ? buildCompactionMessage({
                tokensBefore: compactResult.tokensBefore,
                tokensAfter: compactResult.tokensAfter,
                messageCount: finalMsgCount,
                summaryCount: allSummaries.length,
                maxDepth,
                promotedCount,
              })
            : "No compaction needed.";

          let latestSummaryContent: string | undefined;
          if (compactResult.createdSummaryId) {
            const summaryRecord = await admittedProject.summaries.getSummary(compactResult.createdSummaryId);
            latestSummaryContent = summaryRecord?.content;
          } else if (allSummaries.length > 0) {
            // Fall back to the most recent existing summary when no new summary was created
            latestSummaryContent = allSummaries[allSummaries.length - 1]?.content;
          }

          return {
            actionTaken: compactResult.actionTaken,
            summary: summaryMsg,
            latestSummaryContent,
            tokensBefore: compactResult.tokensBefore,
            tokensAfter: compactResult.tokensAfter,
            providerId: effectiveProvider,
            providerLabel,
            apiMode,
            reasoningEffort: effectiveReasoningEffort ?? null,
            fastMode: effectiveFastMode ?? null,
            requestTimeoutMs: effectiveRequestTimeoutMs,
            retry: effectiveRetry,
          };
        } finally {
          await closeRouteStorage(project, undefined);
        }
      });

      sendJson(res, 200, result);
    } catch (err) {
      if (err instanceof BackendPublicationJournalError) {
        sendJson(res, 503, {
          status: "blocked",
          error: "backend publication admission blocked",
        });
        return;
      }
      const storageFailure = storageRouteFailureResponse(activeFactory, err, "compact");
      if (storageFailure) {
        sendJson(res, storageFailure.status, storageFailure.body);
        return;
      }
      sendJson(res, 500, { error: err instanceof Error ? err.message : "compact failed" });
    } finally {
      await closeRouteStorage(undefined, ownedFactory);
      compactingNow.delete(session_id);
    }
  };
}
