import type { DaemonConfig } from "../config.js";
import {
  MAX_PROJECT_METADATA_BYTES,
  ensureProjectDirForIdentity,
  projectIdentity,
  projectPathsForIdentity,
} from "../project.js";
import {
  assertPrivateDirectoryEntry,
  atomicWritePrivateFile,
  openPrivateDirectory,
  PrivateDirectoryTopologyError,
  readBoundedRegularFileWithStat,
  type PrivateDirectoryHandle,
} from "../../security-files.js";
import { sendJson } from "../server.js";
import type { RouteHandler } from "../server.js";
import { shouldPromote } from "../../promotion/detector.js";
import { deduplicateAndInsert } from "../../promotion/dedup.js";
import { validateCwd } from "../validate-cwd.js";
import { ScrubEngine } from "../../scrub.js";
import {
  composeAbortSignals,
  isAbortError,
  throwIfAborted,
} from "../cancellation.js";
import {
  isCanonicalInvocationId,
  InvocationCoordinatorError,
  type InvocationAdmission,
  type InvocationCoordinator,
  type InvocationTarget,
} from "../invocation-coordinator.js";
import {
  type StorageBackendFactory,
} from "../../storage/index.js";
import { BackendPublicationJournalError } from "../../storage/backend-publication.js";
import { StorageOperationError } from "../../storage/errors.js";
import {
  createCommitCloseBarrier,
  storageRouteFailureResponse,
  withProjectStorage,
} from "./storage-lifecycle.js";

interface PromoteRequestBody {
  cwd?: unknown;
  dry_run?: unknown;
  invocation_id?: unknown;
}

function routeInvocationTarget(
  invocationId: string,
  coordinator: InvocationCoordinator,
): InvocationTarget {
  return {
    invocationId,
    command: "compact",
    daemonInstanceId: coordinator.daemonInstanceId,
  };
}

function sendCancellationIfWritable(
  res: {
    headersSent?: boolean;
    writableEnded?: boolean;
    destroyed?: boolean;
    writable?: boolean;
  },
): void {
  if (res.headersSent || res.writableEnded || res.destroyed || res.writable === false) return;
  sendJson(res as never, 499, { status: "cancelled", error: "promote cancelled" });
}

function isInvocationCancellation(error: unknown): boolean {
  return error instanceof InvocationCoordinatorError && error.code === "cancelled";
}

function isCriticalMetadataError(error: unknown): boolean {
  return error instanceof PrivateDirectoryTopologyError
    || (
      error !== null
      && typeof error === "object"
      && "name" in error
      && error.name === "PrivateDirectoryTopologyError"
    )
    || isAbortError(error)
    || isInvocationCancellation(error)
    || error instanceof BackendPublicationJournalError;
}

function errorCode(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error
    && typeof error.code === "string"
    ? error.code
    : undefined;
}

export function createPromoteHandler(
  config: DaemonConfig,
  storageFactory?: StorageBackendFactory,
): RouteHandler {
  return async (_req, res, body, context) => {
    let signal = context?.signal;
    let invocationAdmission: InvocationAdmission | undefined;
    let invocationTarget: InvocationTarget | undefined;
    let invocationSignalCleanup: (() => void) | undefined;
    let detachInvocationCancellation: (() => void) | undefined;
    let invocationCancellation: Promise<unknown> | undefined;
    const releaseInvocation = (): void => {
      detachInvocationCancellation?.();
      invocationSignalCleanup?.();
      invocationAdmission?.release();
    };

    try {
      const input = JSON.parse(body || "{}") as PromoteRequestBody;
      if (input === null || typeof input !== "object" || Array.isArray(input)) {
        sendJson(res, 400, { error: "invalid request body" });
        return;
      }
      const { dry_run = false } = input;

      if (!input.cwd) {
        sendJson(res, 400, { error: "cwd is required" });
        return;
      }

      if (input.invocation_id !== undefined && !isCanonicalInvocationId(input.invocation_id)) {
        sendJson(res, 400, { error: "invocation_id must be a canonical UUID" });
        return;
      }

      let cwd: string;
      try {
        cwd = validateCwd(input.cwd as string);
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : "invalid cwd" });
        return;
      }

      const invocationId = typeof input.invocation_id === "string" ? input.invocation_id : undefined;
      let coordinator: InvocationCoordinator | undefined;
      if (invocationId !== undefined) {
        coordinator = context?.invocationCoordinator;
        if (coordinator === undefined) {
          sendJson(res, 503, { error: "invocation control unavailable" });
          return;
        }
        invocationTarget = routeInvocationTarget(invocationId, coordinator);
        try {
          coordinator.heartbeat(invocationTarget);
          invocationAdmission = coordinator.admitWork(invocationTarget);
        } catch (error) {
          if (isAbortError(error)) {
            sendCancellationIfWritable(res);
          } else {
            const status = typeof (error as { statusCode?: unknown })?.statusCode === "number"
              ? (error as { statusCode: number }).statusCode
              : 409;
            sendJson(res, status, {
              error: error instanceof Error ? error.message : "invocation admission failed",
            });
          }
          return;
        }

        const invocationComposition = composeAbortSignals([signal, invocationAdmission.signal]);
        signal = invocationComposition.signal;
        invocationSignalCleanup = invocationComposition.cleanup;

        // A request disconnect cancels only its supplied invocation. The
        // coordinator signal also cancels the route for control/lease shutdown.
        if (context?.signal !== undefined) {
          const onRequestCancellation = (): void => {
            invocationCancellation ??= coordinator!.cancel(invocationTarget!).catch(() => undefined);
          };
          context.signal.addEventListener("abort", onRequestCancellation, { once: true });
          detachInvocationCancellation = () => context.signal?.removeEventListener("abort", onRequestCancellation);
          if (context.signal.aborted) onRequestCancellation();
        }
      }

      throwIfAborted(signal);
      const storageIdentity = projectIdentity(
        cwd,
        config.storage,
        context?.publicationLockToken,
      );
      const localIdentity = {
        id: storageIdentity.localProjectId,
        canonical: storageIdentity.canonical,
        ...(storageIdentity.remoteProjectId === undefined
          ? {}
          : { remoteProjectId: storageIdentity.remoteProjectId }),
      };
      const paths = projectPathsForIdentity(localIdentity);
      const projectDir = ensureProjectDirForIdentity(localIdentity, { writeMetadata: false });
      throwIfAborted(signal);
      const scrubber = await ScrubEngine.forProject(
        config.security.sensitivePatterns,
        projectDir,
      );
      throwIfAborted(signal);

      const storageContext = context === undefined && signal === undefined
        ? undefined
        : { ...context, signal };

      const underlyingAcquireCommit = invocationTarget !== undefined && coordinator !== undefined
        ? (): InvocationAdmission => coordinator!.acquireCommit(invocationTarget!)
        : (): InvocationAdmission => ({ signal: signal ?? new AbortController().signal, release: () => undefined });
      const commitCloseBarrier = createCommitCloseBarrier();
      const acquireCommit = (): Readonly<{ release: () => void }> =>
        commitCloseBarrier.acquire(underlyingAcquireCommit);
      const withCommitAdmission = async <T>(operation: () => Promise<T> | T): Promise<T> => {
        throwIfAborted(signal);
        const permit = await acquireCommit();
        try {
          return await operation();
        } finally {
          permit.release();
        }
      };

      const result = await withProjectStorage(
        {
          config,
          cwd,
          factory: storageFactory,
          context: storageContext,
          mode: "existing",
          expectedIdentity: storageIdentity,
          beforeClose: commitCloseBarrier.waitForZero,
        },
        async (project) => {
          let processed = 0;
          let promoted = 0;

          // Get summary IDs that have already been promoted (to avoid re-promoting)
          throwIfAborted(signal);
          const alreadyPromotedContent = new Set(
            (await project.promotedMemory.listContentPrefixes(10000)).map((c) => c.slice(0, 100)),
          );
          throwIfAborted(signal);

          throwIfAborted(signal);
          const conversations = await project.conversations.listConversations();
          throwIfAborted(signal);

          for (const conversation of conversations) {
            throwIfAborted(signal);
            const summaries = await project.summaries.getSummariesByConversation(conversation.conversationId);
            throwIfAborted(signal);

            for (const summary of summaries) {
              throwIfAborted(signal);
              const scrubbedContent = scrubber.scrub(summary.content);
              throwIfAborted(signal);
              // Skip summaries whose content prefix is already in the promoted store
              // This prevents re-promoting on repeated runs (which would decay confidence)
              if (alreadyPromotedContent.has(scrubbedContent.slice(0, 100))) continue;

              processed++;
              throwIfAborted(signal);

              const promotionResult = shouldPromote(
                {
                  content: summary.content,
                  depth: summary.depth,
                  tokenCount: summary.tokenCount,
                  sourceMessageTokenCount: summary.sourceMessageTokenCount,
                },
                config.compaction.promotionThresholds,
              );
              throwIfAborted(signal);

              if (!promotionResult.promote) continue;

              if (dry_run) {
                promoted++;
              } else {
                try {
                  await withCommitAdmission(() => deduplicateAndInsert({
                      transaction: project.transaction.bind(project),
                      content: scrubbedContent,
                      tags: promotionResult.tags.map((tag) => scrubber.scrub(tag)),
                      sourceProjectId: paths.id,
                      sessionId: conversation.sessionId,
                      depth: summary.depth,
                      confidence: promotionResult.confidence,
                      thresholds: {
                        dedupBm25Threshold: config.compaction.promotionThresholds.dedupBm25Threshold,
                        dedupCandidateLimit: config.compaction.promotionThresholds.dedupCandidateLimit,
                      },
                    }));
                  throwIfAborted(signal);
                  alreadyPromotedContent.add(scrubbedContent.slice(0, 100));
                  promoted++;
                } catch (error) {
                  if (
                    isAbortError(error)
                    || isInvocationCancellation(error)
                    || (config.storage.backend === "postgresql" && error instanceof StorageOperationError)
                  ) throw error;
                  // non-fatal for SQLite and other promotion failures
                }
              }
            }
          }

          return { processed, promoted, conversations: conversations.length };
        },
      );

      throwIfAborted(signal);
      if (result === null) {
        sendJson(res, 200, { processed: 0, promoted: 0 });
        return;
      }

      // Update meta.json unless dry_run
      if (!dry_run) {
        try {
          await withCommitAdmission(async () => {
            const writeMetadata = (): void => {
              const expectedUid = typeof process.getuid === "function" ? process.getuid() : undefined;
              let parent: PrivateDirectoryHandle;
              try {
                parent = openPrivateDirectory(paths.dir, { expectedUid });
              } catch (error) {
                const code = errorCode(error);
                if (
                  !isCriticalMetadataError(error)
                  && (code === "EMFILE" || code === "ENFILE" || code === "ENOSPC")
                ) throw error;
                throw new PrivateDirectoryTopologyError(
                  "project directory topology changed before metadata publication",
                  { cause: error },
                );
              }
              let primaryError: unknown;
              let hasPrimaryError = false;
              try {
                try {
                  let meta: Record<string, unknown> = {};
                  try {
                    const observed = readBoundedRegularFileWithStat(paths.metaPath, {
                      allowedRoot: paths.dir,
                      maxBytes: MAX_PROJECT_METADATA_BYTES,
                      expectedUid,
                      requireSingleLink: true,
                    });
                    if (
                      observed.parentDev !== parent.witness.dev
                      || observed.parentIno !== parent.witness.ino
                    ) {
                      throw new PrivateDirectoryTopologyError(
                        "project directory topology changed before metadata publication",
                      );
                    }
                    const parsed: unknown = JSON.parse(observed.content);
                    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
                      throw new Error("invalid project metadata");
                    }
                    meta = parsed as Record<string, unknown>;
                  } catch (error) {
                    if (errorCode(error) !== "ENOENT") throw error;
                  }
                  meta.cwd = paths.canonical;
                  meta.lastPromote = new Date().toISOString();
                  const serialized = JSON.stringify(meta, null, 2) + "\n";
                  if (Buffer.byteLength(serialized, "utf8") > MAX_PROJECT_METADATA_BYTES) {
                    throw new Error("project metadata exceeds size limit");
                  }
                  atomicWritePrivateFile(paths.metaPath, serialized, {}, parent);
                } catch (error) {
                  if (isCriticalMetadataError(error)) throw error;
                  try {
                    assertPrivateDirectoryEntry(parent, paths.dir, parent.witness.uid);
                  } catch (topologyError) {
                    throw new PrivateDirectoryTopologyError(
                      "project directory topology changed before metadata publication",
                      { cause: topologyError },
                    );
                  }
                  throw error;
                }
              } catch (error) {
                hasPrimaryError = true;
                primaryError = error;
              } finally {
                try {
                  parent.close();
                } catch (error) {
                  if (hasPrimaryError) {
                    if (!isCriticalMetadataError(primaryError)) {
                      throw new AggregateError(
                        [primaryError, error],
                        "project metadata publication and directory cleanup failed",
                        { cause: primaryError },
                      );
                    }
                  } else {
                    throw error;
                  }
                }
              }
              if (hasPrimaryError) throw primaryError;
            };
            if (context?.withPublicationAdmission !== undefined) {
              await context.withPublicationAdmission(() => writeMetadata());
            } else {
              writeMetadata();
            }
          });
        } catch (error) {
          if (isCriticalMetadataError(error)) throw error;
          // Meta persistence remains best-effort for ordinary filesystem failures.
        }
        throwIfAborted(signal);
      }

      sendJson(res, 200, result);
    } catch (err) {
      if (isAbortError(err)) {
        sendCancellationIfWritable(res);
      } else if (isInvocationCancellation(err)) {
        sendJson(res, (err as InvocationCoordinatorError).statusCode, {
          error: "invocation admission failed",
        });
      } else if (err instanceof BackendPublicationJournalError) {
        sendJson(res, 503, {
          status: "blocked",
          error: "backend publication admission blocked",
        });
      } else {
        const storageFailure = storageRouteFailureResponse(config.storage.backend, err, "promote", storageFactory);
        if (storageFailure) {
          sendJson(res, storageFailure.status, storageFailure.body);
          return;
        }
        sendJson(res, 500, { error: err instanceof Error ? err.message : "promote failed" });
      }
    } finally {
      releaseInvocation();
      if (invocationCancellation !== undefined) await invocationCancellation;
    }
  };
}
