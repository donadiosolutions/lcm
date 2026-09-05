import type { DaemonConfig } from "../config.js";
import { sendJson } from "../server.js";
import type { RouteHandler } from "../server.js";
import { createRetrievalEngine, normalizeGrepMode, normalizeGrepScope } from "../../retrieval.js";
import { validateCwd } from "../validate-cwd.js";
import type { StorageBackendFactory } from "../../storage/index.js";
import {
  storageRouteFailureResponse,
  withProjectStorage,
} from "./storage-lifecycle.js";

const GREP_SINCE_PATTERN = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]{1,3}))?(Z|[+-][0-9]{2}:[0-9]{2})$/u;

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function normalizeGrepSince(value: unknown): Date | null {
  if (typeof value !== "string") {
    return null;
  }

  const match = GREP_SINCE_PATTERN.exec(value);
  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offset = match[8];
  const offsetHour = offset === "Z" ? 0 : Number(offset.slice(1, 3));
  const offsetMinute = offset === "Z" ? 0 : Number(offset.slice(4, 6));
  const daysInMonth = [
    31,
    isLeapYear(year) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ][month - 1];

  if (
    daysInMonth === undefined
    || day < 1
    || day > daysInMonth
    || hour > 23
    || minute > 59
    || second > 59
    || offsetHour > 23
    || offsetMinute > 59
  ) {
    return null;
  }

  const parsed = new Date(value);
  const normalizedYear = parsed.getUTCFullYear();
  if (normalizedYear < 1 || normalizedYear > 9999) {
    return null;
  }
  return parsed;
}

export function createGrepHandler(config: DaemonConfig, storageFactory?: StorageBackendFactory): RouteHandler {
  return async (_req, res, body, context) => {
    const input = JSON.parse(body || "{}");
    const { query, scope, mode, since, sessionId } = input;

    if (!query) {
      sendJson(res, 400, { error: "query is required" });
      return;
    }

    const normalizedMode = normalizeGrepMode(mode);
    if (!normalizedMode) {
      sendJson(res, 400, { error: "invalid mode" });
      return;
    }

    const normalizedScope = normalizeGrepScope(scope);
    if (!normalizedScope) {
      sendJson(res, 400, { error: "invalid scope" });
      return;
    }

    if (sessionId !== undefined
        && (typeof sessionId !== "string" || sessionId.trim().length === 0 || sessionId.includes("\0"))) {
      sendJson(res, 400, { error: "invalid sessionId" });
      return;
    }

    const normalizedSince = since === undefined ? undefined : normalizeGrepSince(since);
    if (since !== undefined && normalizedSince === null) {
      sendJson(res, 400, { error: "invalid since" });
      return;
    }
    const effectiveSince = normalizedSince ?? undefined;

    if (!input.cwd) {
      sendJson(res, 200, { matches: [] });
      return;
    }

    let cwd: string;
    try {
      cwd = validateCwd(input.cwd);
    } catch {
      sendJson(res, 200, { matches: [] });
      return;
    }

    try {
      const result = await withProjectStorage(
        { config, cwd, factory: storageFactory, context, mode: "existing" },
        async (project) => {
          if (sessionId !== undefined) {
            const conversation = await project.conversations.getConversationBySessionId(sessionId);
            if (conversation === null) {
              return { messages: [], summaries: [], totalMatches: 0 };
            }
            return createRetrievalEngine(project).grep({
              query,
              mode: normalizedMode,
              scope: normalizedScope,
              since: effectiveSince,
              conversationId: conversation.conversationId,
            });
          }
          return createRetrievalEngine(project).grep({
            query,
            mode: normalizedMode,
            scope: normalizedScope,
            since: effectiveSince,
          });
        },
      );
      sendJson(res, 200, result ?? { matches: [] });
    } catch (error) {
      const storageFailure = storageRouteFailureResponse(config.storage.backend, error, "grep", storageFactory);
      if (storageFailure) {
        sendJson(res, storageFailure.status, storageFailure.body);
        return;
      }
      sendJson(res, 200, { matches: [] });
    }
  };
}
