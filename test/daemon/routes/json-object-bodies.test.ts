import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { loadDaemonConfig } from "../../../src/daemon/config.js";
import { createDescribeHandler } from "../../../src/daemon/routes/describe.js";
import { createExpandHandler } from "../../../src/daemon/routes/expand.js";
import { createGrepHandler } from "../../../src/daemon/routes/grep.js";
import { createIngestHandler } from "../../../src/daemon/routes/ingest.js";
import { createPromoteEventsHandler } from "../../../src/daemon/routes/promote-events.js";
import { createPromoteHandler } from "../../../src/daemon/routes/promote.js";
import { createRecentHandler } from "../../../src/daemon/routes/recent.js";
import { createRestoreHandler } from "../../../src/daemon/routes/restore.js";
import { createReviewStaleHandler } from "../../../src/daemon/routes/review-stale.js";
import { createSearchHandler } from "../../../src/daemon/routes/search.js";
import { createSessionCompleteHandler } from "../../../src/daemon/routes/session-complete.js";
import { createStatusHandler } from "../../../src/daemon/routes/status.js";
import { createStoreHandler } from "../../../src/daemon/routes/store.js";
import type { RouteExecutionContext, RouteHandler } from "../../../src/daemon/server.js";
import type { StorageBackendFactory } from "../../../src/storage/index.js";

const config = loadDaemonConfig("/nonexistent", { llm: { provider: "disabled" } });
const request = {} as IncomingMessage;

function response(): {
  body: () => unknown;
  res: ServerResponse;
  status: () => number | undefined;
} {
  let body = "";
  let status: number | undefined;
  const res = {
    writeHead: vi.fn((nextStatus: number) => {
      status = nextStatus;
      return res;
    }),
    end: vi.fn((data?: string) => { body = data ?? ""; }),
  } as unknown as ServerResponse;
  return {
    body: () => JSON.parse(body || "{}") as unknown,
    res,
    status: () => status,
  };
}

function rejectionSentinels(): {
  context: RouteExecutionContext;
  factory: StorageBackendFactory;
  sentinels: Array<ReturnType<typeof vi.fn>>;
} {
  const openProject = vi.fn(() => {
    throw new Error("storage admission must not run");
  });
  const openExistingProject = vi.fn(() => {
    throw new Error("storage admission must not run");
  });
  const projectExists = vi.fn(() => {
    throw new Error("storage admission must not run");
  });
  const withPublicationAdmission = vi.fn(() => {
    throw new Error("publication admission must not run");
  });
  return {
    context: { withPublicationAdmission },
    factory: {
      openProject,
      openExistingProject,
      projectExists,
    } as unknown as StorageBackendFactory,
    sentinels: [openProject, openExistingProject, projectExists, withPublicationAdmission],
  };
}

type SyntaxBehavior =
  | { error?: string; status: number }
  | "rejects";

type RouteCase = {
  create: (factory: StorageBackendFactory) => RouteHandler;
  name: string;
  syntax: SyntaxBehavior;
};

const routeCases: RouteCase[] = [
  { name: "describe", create: factory => createDescribeHandler(config, factory), syntax: "rejects" },
  { name: "expand", create: factory => createExpandHandler(config, factory), syntax: "rejects" },
  { name: "grep", create: factory => createGrepHandler(config, factory), syntax: "rejects" },
  { name: "recent", create: factory => createRecentHandler(config, factory), syntax: "rejects" },
  { name: "search", create: factory => createSearchHandler(config, factory), syntax: "rejects" },
  { name: "store", create: factory => createStoreHandler(config, factory), syntax: "rejects" },
  { name: "ingest", create: factory => createIngestHandler(config, factory), syntax: "rejects" },
  { name: "restore", create: factory => createRestoreHandler(config, factory), syntax: { status: 500 } },
  { name: "promote", create: factory => createPromoteHandler(config, factory), syntax: { status: 500 } },
  { name: "status", create: () => createStatusHandler(config, Date.now()), syntax: { status: 500 } },
  { name: "session-complete", create: factory => createSessionCompleteHandler(config, factory), syntax: "rejects" },
  { name: "promote-events", create: factory => createPromoteEventsHandler(config, factory), syntax: "rejects" },
  { name: "review-stale", create: factory => createReviewStaleHandler(config, factory), syntax: { status: 400, error: "Invalid JSON body" } },
];

const invalidBodies = ["null", "[]", "[1]", '"text"', "0", "42", "true", "false"];

describe("daemon route JSON object bodies", () => {
  for (const route of routeCases) {
    it.each(invalidBodies)(`${route.name} rejects the non-object body %s before effects`, async (body) => {
      const { context, factory, sentinels } = rejectionSentinels();
      const output = response();

      await expect(route.create(factory)(request, output.res, body, context)).resolves.toBeUndefined();

      expect(output.status()).toBe(400);
      expect(output.body()).toEqual({ error: "invalid request body" });
      for (const sentinel of sentinels) expect(sentinel).not.toHaveBeenCalled();
    });

    it(`${route.name} preserves empty-body fallback and JSON syntax behavior`, async () => {
      const emptySentinels = rejectionSentinels();
      const empty = response();
      await route.create(emptySentinels.factory)(request, empty.res, "", emptySentinels.context);

      const objectSentinels = rejectionSentinels();
      const object = response();
      await route.create(objectSentinels.factory)(request, object.res, "{}", objectSentinels.context);
      expect({ status: empty.status(), body: empty.body() })
        .toEqual({ status: object.status(), body: object.body() });

      const malformedSentinels = rejectionSentinels();
      const malformed = response();
      const call = route.create(malformedSentinels.factory)(
        request,
        malformed.res,
        "{",
        malformedSentinels.context,
      );
      if (route.syntax === "rejects") {
        await expect(call).rejects.toBeInstanceOf(SyntaxError);
      } else {
        await expect(call).resolves.toBeUndefined();
        expect(malformed.status()).toBe(route.syntax.status);
        expect(malformed.body()).toEqual({ error: route.syntax.error ?? expect.any(String) });
      }
      for (const sentinel of malformedSentinels.sentinels) expect(sentinel).not.toHaveBeenCalled();
    });
  }
});
