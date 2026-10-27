import { beforeEach, describe, expect, it, vi } from "vitest";
import { BackendPublicationJournalError } from "../../src/storage/backend-publication.js";
import {
  createLockContentionWaitBudget,
  PrivateMutationLockContentionError,
  retryWhileLiveLockContended,
} from "../../src/private-mutation-lock.js";
import { admitDaemonPeer } from "../../src/daemon/peer-admission.js";

const mocks = vi.hoisted(() => ({
  statSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  chmodSync: vi.fn(),
  readFileSync: vi.fn(),
  loadDaemonConfig: vi.fn(),
  daemonJsonRequest: vi.fn(),
  fireCompactRequest: vi.fn(),
  firePromoteEventsRequest: vi.fn(),
  assertHookPublicationFence: vi.fn(),
  assertHookRootEstablished: vi.fn(),
  isBackendPublicationJournalError: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  statSync: mocks.statSync,
  writeFileSync: mocks.writeFileSync,
  mkdirSync: mocks.mkdirSync,
  chmodSync: mocks.chmodSync,
  readFileSync: mocks.readFileSync,
}));

vi.mock("../../src/daemon/config.js", () => ({
  loadDaemonConfig: mocks.loadDaemonConfig,
}));

vi.mock("../../src/daemon/http-url.js", () => ({
  normalizeDaemonPort: (value: unknown) => typeof value === "number" ? value : 3737,
  daemonJsonRequest: mocks.daemonJsonRequest,
}));

vi.mock("../../src/hooks/session-end.js", () => ({
  fireCompactRequest: mocks.fireCompactRequest,
  firePromoteEventsRequest: mocks.firePromoteEventsRequest,
}));
vi.mock("../../src/daemon/peer-admission.js", () => ({
  admitDaemonPeer: vi.fn(() => ({ pid: 42, birth: "fixture" })),
}));

vi.mock("../../src/hooks/publication-fence.js", () => ({
  assertHookPublicationFence: mocks.assertHookPublicationFence,
  assertHookRootEstablished: mocks.assertHookRootEstablished,
  isBackendPublicationJournalError: mocks.isBackendPublicationJournalError,
  NO_HOOK_ADMISSION_RETRY: async <T>(step: () => T | Promise<T>): Promise<T> => await step(),
}));

import { handleSessionSnapshot } from "../../src/hooks/session-snapshot.js";

const payload = {
  session_id: "unsafe/session",
  cwd: "/project",
  transcript_path: "/transcript.jsonl",
  client: "codex",
};

describe("handleSessionSnapshot default integrations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(admitDaemonPeer).mockReturnValue({ pid: 42, birth: "fixture" });
    mocks.isBackendPublicationJournalError.mockReturnValue(false);
    mocks.statSync.mockImplementation(() => { throw new Error("missing"); });
    mocks.readFileSync.mockReturnValue("token-value\n");
    mocks.loadDaemonConfig.mockReturnValue({
      daemon: { port: 4545 },
      hooks: { snapshotIntervalSec: 60, disableAutoCompact: false },
      compaction: { autoCompactMinTokens: 100 },
    });
    mocks.daemonJsonRequest.mockResolvedValue({ totalTokens: 100 });
  });

  it("loads config and token, ingests, auto-compacts, writes the cursor, and promotes", async () => {
    const result = await handleSessionSnapshot(JSON.stringify(payload));
    expect(result).toEqual({ exitCode: 0, stdout: "" });
    expect(mocks.daemonJsonRequest).toHaveBeenCalledWith(4545, "/ingest", expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer token-value" }),
      body: expect.objectContaining({ client: "codex" }),
    }));
    expect(mocks.fireCompactRequest).toHaveBeenCalledWith(4545, expect.objectContaining({ skip_ingest: true }), expect.any(Object));
    expect(mocks.writeFileSync).toHaveBeenCalledWith(expect.stringContaining("snap-unsafe_session.json"), expect.any(String));
    expect(mocks.chmodSync).toHaveBeenCalledWith(expect.any(String), 0o600);
    expect(mocks.firePromoteEventsRequest).toHaveBeenCalledWith(4545, { cwd: "/project" }, expect.any(Object));
    expect(mocks.assertHookRootEstablished.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.mkdirSync.mock.invocationCallOrder[0]);
  });

  it("sends no token or transcript when the local listener is unverified", async () => {
    vi.mocked(admitDaemonPeer).mockReturnValueOnce(null);
    expect(await handleSessionSnapshot(JSON.stringify(payload))).toEqual({ exitCode: 0, stdout: "" });
    expect(mocks.readFileSync).not.toHaveBeenCalled();
    expect(mocks.daemonJsonRequest).not.toHaveBeenCalled();
    expect(mocks.fireCompactRequest).not.toHaveBeenCalled();
  });

  it("re-admits after the publication fence before reading a token", async () => {
    const order: string[] = [];
    mocks.assertHookPublicationFence.mockImplementation(() => { order.push("fence"); });
    vi.mocked(admitDaemonPeer)
      .mockImplementationOnce(() => { order.push("admit-1"); return { pid: 42, birth: "first" }; })
      .mockImplementationOnce(() => { order.push("admit-2"); return null; });
    expect(await handleSessionSnapshot(JSON.stringify(payload))).toEqual({ exitCode: 0, stdout: "" });
    expect(order).toEqual(["fence", "admit-1", "fence", "admit-2"]);
    expect(mocks.readFileSync).not.toHaveBeenCalled();
    expect(mocks.daemonJsonRequest).not.toHaveBeenCalled();
  });

  describe("waiting for a live publication-lock owner", () => {
    const liveContention = (): PrivateMutationLockContentionError => new PrivateMutationLockContentionError(
      "publication lock is busy",
      {
        contendedLock: {
          path: "/lcm/publication.lock",
          owner: { version: 1, pid: process.pid + 1, processStartTime: null, nonce: "owner" },
        },
      },
    );
    const admissionRetry = (totalMs: number) => {
      const budget = createLockContentionWaitBudget(totalMs);
      return <T>(step: () => T | Promise<T>): Promise<T> => retryWhileLiveLockContended(step, {
        budget,
        _wait: async () => undefined,
      });
    };
    const config = {
      daemon: { port: 4545 },
      hooks: { snapshotIntervalSec: 60, disableAutoCompact: false },
      compaction: { autoCompactMinTokens: 100 },
    };

    it("ingests after the config loads and the fence stop meeting the owner", async () => {
      mocks.loadDaemonConfig
        .mockImplementationOnce(() => { throw liveContention(); })
        .mockReturnValueOnce(config)
        .mockImplementationOnce(() => { throw liveContention(); })
        .mockImplementationOnce(() => { throw liveContention(); })
        .mockReturnValue(config);
      mocks.assertHookPublicationFence
        .mockImplementationOnce(() => { throw liveContention(); });

      await expect(handleSessionSnapshot(JSON.stringify(payload), { admissionRetry: admissionRetry(1000) }))
        .resolves.toEqual({ exitCode: 0, stdout: "" });

      expect(mocks.daemonJsonRequest).toHaveBeenCalledTimes(1);
      expect(mocks.assertHookPublicationFence).toHaveBeenCalledTimes(4);
      expect(mocks.writeFileSync).toHaveBeenCalledTimes(1);
    });

    it("skips the ingest once the config load outlasts the allowance", async () => {
      mocks.loadDaemonConfig.mockImplementation(() => { throw liveContention(); });

      await expect(handleSessionSnapshot(JSON.stringify(payload), { admissionRetry: admissionRetry(100) }))
        .resolves.toEqual({ exitCode: 0, stdout: "" });

      expect(mocks.loadDaemonConfig).toHaveBeenCalledTimes(3);
      expect(mocks.daemonJsonRequest).not.toHaveBeenCalled();
    });

    it("loads the ingest config with the verified port after the owner releases it", async () => {
      mocks.loadDaemonConfig
        .mockImplementationOnce(() => { throw liveContention(); })
        .mockReturnValue(config);

      await handleSessionSnapshot(
        JSON.stringify(payload),
        { snapshotIntervalSec: 60, verifiedPort: 7777, admissionRetry: admissionRetry(1000) },
      );

      expect(mocks.daemonJsonRequest).toHaveBeenCalledWith(7777, "/ingest", expect.any(Object));
    });

    it("skips the ingest once the fence outlasts the allowance", async () => {
      mocks.assertHookPublicationFence.mockImplementation(() => { throw liveContention(); });

      await expect(handleSessionSnapshot(JSON.stringify(payload), { admissionRetry: admissionRetry(100) }))
        .resolves.toEqual({ exitCode: 0, stdout: "" });

      expect(mocks.assertHookPublicationFence).toHaveBeenCalledTimes(3);
      expect(mocks.daemonJsonRequest).not.toHaveBeenCalled();
      mocks.assertHookPublicationFence.mockReset();
    });
  });

  it("reuses the verified port for ingest, compact, and promotion after config changes", async () => {
    await handleSessionSnapshot(JSON.stringify(payload), { verifiedPort: 7777 });
    expect(mocks.daemonJsonRequest).toHaveBeenCalledWith(7777, "/ingest", expect.any(Object));
    expect(mocks.fireCompactRequest).toHaveBeenCalledWith(7777, expect.any(Object), expect.any(Object));
    expect(mocks.firePromoteEventsRequest).toHaveBeenCalledWith(7777, { cwd: "/project" }, expect.any(Object));
  });

  it("proceeds without auth when the token file is missing or empty", async () => {
    mocks.readFileSync.mockImplementationOnce(() => { throw new Error("missing token"); });
    await handleSessionSnapshot(JSON.stringify({ ...payload, client: "claude" }));
    expect(mocks.daemonJsonRequest.mock.calls[0][2].headers).not.toHaveProperty("Authorization");

    mocks.readFileSync.mockReturnValueOnce("   ");
    await handleSessionSnapshot(JSON.stringify({ ...payload, session_id: "second", client: "claude" }));
    expect(mocks.daemonJsonRequest.mock.calls[1][2].headers).not.toHaveProperty("Authorization");
  });

  it("skips auto-compact for disabled, low-token, and non-numeric outcomes", async () => {
    mocks.loadDaemonConfig.mockReturnValue({
      daemon: {},
      hooks: { disableAutoCompact: true },
      compaction: { autoCompactMinTokens: 100 },
    });
    await handleSessionSnapshot(JSON.stringify(payload));
    expect(mocks.fireCompactRequest).toHaveBeenCalledTimes(0);

    mocks.loadDaemonConfig.mockReturnValue({
      daemon: {},
      hooks: { disableAutoCompact: false },
      compaction: { autoCompactMinTokens: 100 },
    });
    mocks.daemonJsonRequest.mockResolvedValueOnce({ totalTokens: 99 });
    await handleSessionSnapshot(JSON.stringify({ ...payload, session_id: "low" }));
    expect(mocks.fireCompactRequest).toHaveBeenCalledTimes(0);
    mocks.daemonJsonRequest.mockResolvedValueOnce({});
    await handleSessionSnapshot(JSON.stringify({ ...payload, session_id: "missing-total" }));
    expect(mocks.fireCompactRequest).toHaveBeenCalledTimes(0);
  });

  it("fails open for chmod, auto-compact, and promotion errors", async () => {
    mocks.chmodSync.mockImplementationOnce(() => { throw new Error("chmod failed"); });
    mocks.fireCompactRequest.mockImplementationOnce(() => { throw new Error("compact failed"); });
    mocks.firePromoteEventsRequest.mockImplementationOnce(() => { throw new Error("promote failed"); });
    await expect(handleSessionSnapshot(JSON.stringify(payload))).resolves.toEqual({ exitCode: 0, stdout: "" });
  });

  it("rethrows a publication journal error from auto-compact", async () => {
    const publicationError = new BackendPublicationJournalError(
      "malformed-journal",
      "publication journal is malformed",
    );
    mocks.isBackendPublicationJournalError.mockReturnValue(true);
    mocks.fireCompactRequest.mockImplementationOnce(() => { throw publicationError; });
    await expect(handleSessionSnapshot(JSON.stringify(payload))).rejects.toBe(publicationError);
  });

  it("rethrows a publication journal error from promote-events", async () => {
    const publicationError = new BackendPublicationJournalError(
      "unresolved-publication",
      "publication remains unresolved",
    );
    mocks.isBackendPublicationJournalError.mockReturnValue(true);
    mocks.firePromoteEventsRequest.mockImplementationOnce(() => { throw publicationError; });
    await expect(handleSessionSnapshot(JSON.stringify(payload))).rejects.toBe(publicationError);
  });

  it("uses default interval and throttles through the real stat wrapper", async () => {
    mocks.loadDaemonConfig.mockReturnValue({
      daemon: {},
      hooks: {},
      compaction: { autoCompactMinTokens: 100 },
    });
    mocks.statSync.mockReturnValue({ mtimeMs: Date.now() });
    await handleSessionSnapshot(JSON.stringify(payload));
    expect(mocks.daemonJsonRequest).not.toHaveBeenCalled();
  });

  it("uses empty stdin defaults and the default daemon port for auto-compact", async () => {
    expect(await handleSessionSnapshot("")).toEqual({ exitCode: 0, stdout: "" });
    mocks.loadDaemonConfig.mockReturnValue({
      daemon: {}, hooks: {}, compaction: { autoCompactMinTokens: 1 },
    });
    mocks.daemonJsonRequest.mockResolvedValue({ totalTokens: 1 });
    await handleSessionSnapshot(JSON.stringify(payload));
    expect(mocks.fireCompactRequest).toHaveBeenCalledWith(3737, expect.any(Object), expect.any(Object));
  });

  describe("Codex SubagentStop", () => {
    const stop = {
      client: "codex",
      hook_event_name: "SubagentStop",
      session_id: "tree-root",
      agent_id: "child-thread",
      cwd: "/project",
      transcript_path: null,
      agent_transcript_path: "/rollouts/child.jsonl",
    };

    it("ingests the child rollout under the child key and compacts under it", async () => {
      mocks.statSync.mockReturnValue({ mtimeMs: Date.now() });
      const result = await handleSessionSnapshot(JSON.stringify(stop));
      expect(result).toEqual({ exitCode: 0, stdout: "" });
      expect(mocks.daemonJsonRequest).toHaveBeenCalledWith(4545, "/ingest", expect.objectContaining({
        body: {
          session_id: "child-thread",
          cwd: "/project",
          transcript_path: "/rollouts/child.jsonl",
          client: "codex",
        },
      }));
      expect(mocks.fireCompactRequest).toHaveBeenCalledWith(4545, {
        session_id: "child-thread",
        cwd: "/project",
        skip_ingest: true,
        client: "codex",
      }, expect.any(Object));
      expect(mocks.writeFileSync).not.toHaveBeenCalled();
      expect(mocks.firePromoteEventsRequest).toHaveBeenCalledWith(4545, { cwd: "/project" }, expect.any(Object));
    });

    it("never reads the parent rollout and ignores a child event without a valid scope", async () => {
      await handleSessionSnapshot(JSON.stringify({ ...stop, agent_transcript_path: undefined, transcript_path: "/rollouts/parent.jsonl" }));
      await handleSessionSnapshot(JSON.stringify({ ...stop, agent_id: undefined, transcript_path: "/rollouts/parent.jsonl" }));
      await handleSessionSnapshot(JSON.stringify({ ...stop, agent_id: 5 }));
      await handleSessionSnapshot(JSON.stringify({ ...stop, client: "claude" }));
      expect(mocks.daemonJsonRequest).not.toHaveBeenCalled();
    });

    it("rejects a publication journal error without stdout so Codex sees a failed hook", async () => {
      const publicationError = new BackendPublicationJournalError(
        "malformed-journal",
        "publication journal is malformed",
      );
      mocks.isBackendPublicationJournalError.mockReturnValue(true);
      mocks.daemonJsonRequest.mockRejectedValueOnce(publicationError);
      await expect(handleSessionSnapshot(JSON.stringify(stop))).rejects.toBe(publicationError);
    });

    it("answers ordinary failures with exit 0 and no output", async () => {
      mocks.daemonJsonRequest.mockRejectedValueOnce(new Error("ECONNREFUSED"));
      await expect(handleSessionSnapshot(JSON.stringify(stop))).resolves.toEqual({ exitCode: 0, stdout: "" });
    });
  });
});
