import { beforeEach, describe, expect, it, vi } from "vitest";

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
    expect(mocks.fireCompactRequest).toHaveBeenCalledWith(4545, expect.objectContaining({ skip_ingest: true }));
    expect(mocks.writeFileSync).toHaveBeenCalledWith(expect.stringContaining("snap-unsafe_session.json"), expect.any(String));
    expect(mocks.chmodSync).toHaveBeenCalledWith(expect.any(String), 0o600);
    expect(mocks.firePromoteEventsRequest).toHaveBeenCalledWith(4545, { cwd: "/project" });
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
    expect(mocks.fireCompactRequest).toHaveBeenCalledWith(3737, expect.any(Object));
  });
});
