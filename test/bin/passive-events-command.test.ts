import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalHookEventRow } from "../../src/storage/local-hook-outbox.js";
import type { PostgreSqlPassiveEventRecord } from "../../src/storage/postgresql/passive-event-repository.js";
import { createPublicationConvergence } from "../../src/storage/publication-convergence.js";

const state = vi.hoisted(() => ({
  exit: vi.fn((code?: string | number | null): never => {
    throw new Error(`exit:${code ?? 0}`);
  }),
  backend: "postgresql" as "sqlite" | "postgresql",
  remoteProjectId: "0195d250-0000-7000-8000-000000000001" as string | undefined,
  machineId: "0195d250-0000-7000-8000-000000000002",
  health: { status: "healthy" } as { status: string; error?: Error },
  loadConfig: vi.fn(),
  reconcileWorktree: vi.fn(),
  resolveProject: vi.fn(),
  requireMachine: vi.fn(),
  runtimeConstructor: vi.fn(),
  runtimeHealth: vi.fn(),
  runtimeClose: vi.fn(),
  outboxOpen: vi.fn(),
  outboxClose: vi.fn(),
  repositoryConstructor: vi.fn(),
  printHelp: vi.fn(),
  getDeliveryDiagnostics: vi.fn(),
  listAwaitingRemote: vi.fn(),
  listLocalQuarantined: vi.fn(),
  replayLocal: vi.fn(),
  getDiagnostics: vi.fn(),
  readEvent: vi.fn(),
  readEvents: vi.fn(),
  listQuarantined: vi.fn(),
  replayRemote: vi.fn(),
  factory: vi.fn(),
}));

vi.mock("node:process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:process")>()),
  exit: state.exit,
}));

vi.mock("../../src/daemon/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/daemon/config.js")>()),
  loadDaemonConfig: state.loadConfig,
}));

vi.mock("../../installer/install.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../installer/install.js")>()),
  createInstallerPublicationConvergence: state.factory,
}));

vi.mock("../../src/runtime-paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/runtime-paths.js")>()),
  configPath: () => "/lcm/config.json",
  migrateLegacyHomeIfNeeded: vi.fn(),
}));

vi.mock("../../src/project-map.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/project-map.js")>()),
  resolveProjectIdentity: state.resolveProject,
}));

vi.mock("../../src/worktree-reconciliation.js", () => ({
  ensureWorktreeProjectReconciled: state.reconcileWorktree,
}));

vi.mock("../../src/machine-identity.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/machine-identity.js")>()),
  requireMachineIdentity: state.requireMachine,
}));

vi.mock("../../src/storage/postgresql/runtime.js", () => ({
  PostgreSqlRuntime: class {
    constructor(settings: unknown) {
      state.runtimeConstructor(settings);
    }
    health = state.runtimeHealth;
    close = state.runtimeClose;
  },
}));

vi.mock("../../src/storage/local-hook-outbox.js", () => ({
  SQLiteLocalHookOutboxFactory: class {
    open = state.outboxOpen;
    close = state.outboxClose;
  },
}));

vi.mock("../../src/storage/postgresql/passive-event-repository.js", () => ({
  PostgreSqlPassiveEventRepository: class {
    readonly machineId = state.machineId;
    getDiagnostics = state.getDiagnostics;
    readEvent = state.readEvent;
    readEvents = state.readEvents;
    listQuarantined = state.listQuarantined;
    replayQuarantined = state.replayRemote;
    constructor(runtime: unknown, projectId: string, machineId: string) {
      state.repositoryConstructor(runtime, projectId, machineId);
    }
  },
}));

vi.mock("../../src/db/events-path.js", () => ({
  eventsDbPath: vi.fn(() => "/lcm/events/project.db"),
}));

vi.mock("../../src/cli-help.js", () => ({
  printHelp: state.printHelp,
}));

const { runCli } = await import("../../bin/lcm.js");

const MACHINE_ID = "0195d250-0000-7000-8000-000000000002";
const EVENT_ID = "12345678-1234-4abc-8def-123456789abc";

function localEvent(overrides: Partial<LocalHookEventRow> = {}): LocalHookEventRow {
  return {
    event_id: 1,
    event_uuid: EVENT_ID,
    event_version: 1,
    machine_id: MACHINE_ID,
    machine_sequence: "0000000000000000007",
    session_id: "session",
    seq: 1,
    type: "choice",
    category: "decision",
    data: "SQLite",
    priority: 1,
    source_hook: "PostToolUse",
    prev_event_id: null,
    processed_at: null,
    created_at: "2026-07-29 12:00:00",
    delivery_state: "replicated",
    delivery_generation: 2,
    delivery_attempts: 1,
    delivery_owner: null,
    delivery_claimed_at: null,
    delivery_next_attempt_at: "2026-07-29 12:00:00",
    delivery_last_error: null,
    remote_inbox_id: "41",
    quarantine_reason: null,
    acknowledged_at: null,
    remote_pruned_at: null,
    delivery_updated_at: "2026-07-29 12:00:01",
    ...overrides,
  };
}

function remoteEvent(
  overrides: Partial<PostgreSqlPassiveEventRecord> = {},
): PostgreSqlPassiveEventRecord {
  return {
    inboxId: 41n,
    projectId: "0195d250-0000-7000-8000-000000000001",
    machineId: MACHINE_ID,
    eventId: EVENT_ID,
    eventVersion: 1,
    machineSequence: 7n,
    eventType: "choice",
    payload: {
      sessionId: "session",
      sessionSequence: 1,
      category: "decision",
      data: "SQLite",
      priority: 1,
      sourceHook: "PostToolUse",
      previousEventId: null,
      createdAt: "2026-07-29 12:00:00",
    },
    status: "pending",
    attemptCount: 1,
    receivedAt: "2026-07-29T12:00:00.000Z",
    nextAttemptAt: "2026-07-29T12:00:00.000Z",
    claimedAt: null,
    claimedBy: null,
    appliedAt: null,
    quarantinedAt: null,
    quarantineReason: null,
    ...overrides,
  };
}

function stdoutText(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls.map(([value]) => String(value)).join("");
}

async function invoke(...args: string[]): Promise<void> {
  await runCli(["node", "lcm", ...args]);
}

describe("lcm events staged PostgreSQL operator commands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
    state.backend = "postgresql";
    state.remoteProjectId = "0195d250-0000-7000-8000-000000000001";
    state.health = { status: "healthy" };
    state.loadConfig.mockImplementation(() => ({
      storage: {
        backend: state.backend,
        postgresql: {
          url: "postgresql://runtime@db/lcm",
          caFile: "/ca.pem",
          poolMax: 2,
          connectionTimeoutMs: 1_000,
          idleTimeoutMs: 1_000,
          statementTimeoutMs: 1_000,
        },
      },
    }));
    state.reconcileWorktree.mockReturnValue(undefined);
    state.resolveProject.mockImplementation(() => ({
      projectId: "local-project",
      remoteProjectId: state.remoteProjectId,
    }));
    state.requireMachine.mockImplementation(() => ({ machineId: state.machineId }));
    state.runtimeHealth.mockImplementation(async () => state.health);
    state.runtimeClose.mockResolvedValue(undefined);
    state.outboxClose.mockResolvedValue(undefined);
    state.getDeliveryDiagnostics.mockResolvedValue({
      pending: 2,
      claimed: 1,
      retry: 3,
      replicated: 4,
      acknowledged: 5,
      awaitingRemotePrune: 7,
      quarantined: 6,
      oldestReadyAt: "2026-07-29 12:00:00",
      oldestClaimedAt: "2026-07-29 12:00:01",
    });
    state.listAwaitingRemote.mockResolvedValue([]);
    state.listLocalQuarantined.mockResolvedValue([]);
    state.replayLocal.mockResolvedValue(true);
    state.outboxOpen.mockResolvedValue({
      getDeliveryDiagnostics: state.getDeliveryDiagnostics,
      listAwaitingRemote: state.listAwaitingRemote,
      listQuarantined: state.listLocalQuarantined,
      replayQuarantined: state.replayLocal,
    });
    state.getDiagnostics.mockResolvedValue({
      leases: {
        active: 1n,
        expired: 2n,
        released: 3n,
        oldestActiveExpiryAt: "2026-07-29T12:01:00.000Z",
      },
      queue: {
        pending: 4n,
        claimed: 5n,
        retry: 6n,
        applied: 7n,
        quarantined: 8n,
        oldestReadyAt: "2026-07-29T12:00:00.000Z",
        oldestClaimedAt: "2026-07-29T12:00:01.000Z",
      },
    });
    state.readEvent.mockResolvedValue(null);
    state.readEvents.mockResolvedValue([]);
    state.listQuarantined.mockResolvedValue([]);
    state.replayRemote.mockResolvedValue(null);
    state.factory.mockResolvedValue(undefined);
  });

  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it("prints exact-bigint status as JSON and closes both resources", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await invoke("events", "status", "--json");
    const output = JSON.parse(stdoutText(stdout)) as Record<string, any>;
    expect(output.local.pending).toBe(2);
    expect(output.remote.leases).toMatchObject({
      active: "1",
      expired: "2",
      released: "3",
    });
    expect(output.remote.queue).toMatchObject({
      pending: "4",
      applied: "7",
      quarantined: "8",
    });
    expect(state.outboxOpen).toHaveBeenCalledWith("/lcm/events/project.db");
    expect(state.outboxClose).toHaveBeenCalledOnce();
    expect(state.runtimeClose).toHaveBeenCalledOnce();
  });

  it("retries event read preparation under the authenticated publication owner", async () => {
    let now = 0;
    state.factory.mockResolvedValue(createPublicationConvergence({
      port: 3737,
      identity: { pid: 42, version: "test", storageBackend: "sqlite", entrypoint: "/daemon", runtimeDigest: "runtime" },
      deps: {
        now: () => now,
        sleep: async (delayMs: number) => { now += delayMs; },
        readToken: () => "token",
        readOwner: () => ({ version: 1, pid: 42, processStartTime: "birth", nonce: "a".repeat(32) }),
        processBirth: () => "birth",
        lockPath: "/tmp/publication.lock",
        fetch: vi.fn(async () => ({ ok: true, json: async () => ({
          status: "ok", pid: 42, version: "test", storageBackend: "sqlite",
          entrypoint: "/daemon", runtimeDigest: "runtime",
        }) })) as unknown as typeof globalThis.fetch,
      },
    }));
    const contention = new (await import("../../src/private-mutation-lock.js")).PrivateMutationLockContentionError("busy");
    state.reconcileWorktree.mockImplementationOnce(() => { throw contention; });
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await invoke("events", "status", "--json");

    expect(state.factory).toHaveBeenCalledOnce();
    expect(state.reconcileWorktree).toHaveBeenCalledTimes(2);
    expect(JSON.parse(stdoutText(stdout)).local.pending).toBe(2);
  });

  it("carries a reconciled worktree binding through ordered operator admission", async () => {
    const remoteProjectId = "0195d250-0000-7000-8000-000000000001";
    state.remoteProjectId = undefined;
    state.reconcileWorktree.mockImplementation(() => {
      state.remoteProjectId = remoteProjectId;
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await invoke("events", "status", "--json");

    const orderedSpies = [
      state.loadConfig,
      state.reconcileWorktree,
      state.resolveProject,
      state.requireMachine,
      state.runtimeConstructor,
      state.runtimeHealth,
      state.outboxOpen,
      state.repositoryConstructor,
    ];
    for (const spy of orderedSpies) expect(spy).toHaveBeenCalledOnce();
    const invocationOrder = orderedSpies.map((spy) => spy.mock.invocationCallOrder[0]);
    expect(invocationOrder).toEqual([...invocationOrder].sort((left, right) => left - right));
    expect(new Set(invocationOrder).size).toBe(invocationOrder.length);
    expect(state.repositoryConstructor).toHaveBeenCalledWith(
      expect.anything(),
      remoteProjectId,
      state.machineId,
    );
    expect(error).not.toHaveBeenCalledWith(expect.stringContaining("project link"));
  });

  it("prints compact human status", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await invoke("events", "status");
    expect(log).toHaveBeenCalledWith(
      "Local: 2 pending, 1 claimed, 3 retry, 4 replicated, 5 acknowledged, 7 awaiting remote prune, 6 quarantined.",
    );
    expect(log).toHaveBeenCalledWith(
      "PostgreSQL: 4 pending, 5 claimed, 6 retry, 7 applied, 8 quarantined.",
    );
  });

  it("fails before network access when PostgreSQL is not staged", async () => {
    state.backend = "sqlite";
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await expect(invoke("events", "status", "--json")).rejects.toThrow("exit:1");
    expect(JSON.parse(stdoutText(stdout))).toEqual({
      error: "remote passive-event commands require storage.backend \"postgresql\"",
    });
    expect(state.reconcileWorktree).not.toHaveBeenCalled();
    expect(state.resolveProject).not.toHaveBeenCalled();
    expect(state.requireMachine).not.toHaveBeenCalled();
    expect(state.runtimeConstructor).not.toHaveBeenCalled();
    expect(state.runtimeHealth).not.toHaveBeenCalled();
    expect(state.outboxOpen).not.toHaveBeenCalled();
    expect(state.repositoryConstructor).not.toHaveBeenCalled();
  });

  it("surfaces reconciliation conflicts before any downstream admission", async () => {
    state.reconcileWorktree.mockImplementation(() => {
      throw new Error("conflicting PostgreSQL project bindings");
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(invoke("events", "status")).rejects.toThrow("exit:1");

    expect(error).toHaveBeenCalledWith("Error: conflicting PostgreSQL project bindings");
    expect(state.reconcileWorktree).toHaveBeenCalledOnce();
    expect(state.resolveProject).not.toHaveBeenCalled();
    expect(state.requireMachine).not.toHaveBeenCalled();
    expect(state.runtimeConstructor).not.toHaveBeenCalled();
    expect(state.runtimeHealth).not.toHaveBeenCalled();
    expect(state.outboxOpen).not.toHaveBeenCalled();
    expect(state.repositoryConstructor).not.toHaveBeenCalled();
  });

  it("reports the exact genuinely-unbound diagnostic before opening resources", async () => {
    state.remoteProjectId = undefined;
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(invoke("events", "status")).rejects.toThrow("exit:1");

    expect(error).toHaveBeenCalledWith(
      "Error: local project has no PostgreSQL binding; run `lcm project create` or `lcm project link <project-id>`",
    );
    expect(state.reconcileWorktree).toHaveBeenCalledOnce();
    expect(state.resolveProject).toHaveBeenCalledOnce();
    expect(state.reconcileWorktree.mock.invocationCallOrder[0])
      .toBeLessThan(state.resolveProject.mock.invocationCallOrder[0]);
    expect(state.requireMachine).not.toHaveBeenCalled();
    expect(state.runtimeConstructor).not.toHaveBeenCalled();
    expect(state.runtimeHealth).not.toHaveBeenCalled();
    expect(state.outboxOpen).not.toHaveBeenCalled();
    expect(state.repositoryConstructor).not.toHaveBeenCalled();
  });

  it("closes an unhealthy runtime", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    state.health = { status: "unhealthy", error: new Error("database unavailable") };

    await expect(invoke("events", "status")).rejects.toThrow("exit:1");

    expect(error).toHaveBeenCalledWith("Error: database unavailable");
    expect(state.outboxClose).toHaveBeenCalledOnce();
    expect(state.runtimeClose).toHaveBeenCalledOnce();
  });

  it("uses the bounded health fallback when PostgreSQL omits an error", async () => {
    state.health = { status: "unhealthy" };
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(invoke("events", "status")).rejects.toThrow("exit:1");

    expect(error).toHaveBeenCalledWith(
      "Error: PostgreSQL passive-event storage is unavailable",
    );
    expect(state.outboxClose).toHaveBeenCalledOnce();
    expect(state.runtimeClose).toHaveBeenCalledOnce();
  });

  it("renders non-Error operator failures without leaking raw values", async () => {
    state.runtimeHealth.mockRejectedValue("database unavailable");
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(invoke("events", "status")).rejects.toThrow("exit:1");

    expect(error).toHaveBeenCalledWith("Error: database unavailable");
  });

  it("attempts runtime cleanup when local outbox cleanup fails", async () => {
    state.outboxClose.mockRejectedValue(new Error("outbox close failed"));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(invoke("events", "status")).rejects.toThrow("exit:1");

    expect(error).toHaveBeenCalledWith("Error: outbox close failed");
    expect(state.outboxClose).toHaveBeenCalledOnce();
    expect(state.runtimeClose).toHaveBeenCalledOnce();
  });

  it("validates exact envelopes and reports missing and mismatched rows", async () => {
    const first = localEvent();
    const second = localEvent({
      event_id: 2,
      event_uuid: "87654321-4321-5abc-8def-123456789abc",
      machine_sequence: "0000000000000000008",
    });
    const third = localEvent({
      event_id: 3,
      event_uuid: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      machine_sequence: "0000000000000000009",
    });
    state.listAwaitingRemote.mockResolvedValue([first, second, third]);
    state.readEvents.mockResolvedValue([
      remoteEvent(),
      remoteEvent({
        inboxId: 42n,
        eventId: second.event_uuid,
        machineSequence: 8n,
        eventType: "different",
      }),
    ]);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await invoke("events", "validate", "--limit", "3", "--json");
    expect(JSON.parse(stdoutText(stdout))).toEqual({
      checked: 3,
      matched: 1,
      missing: [third.event_uuid],
      mismatched: [second.event_uuid],
    });
    expect(process.exitCode).toBe(1);
    expect(state.readEvents).toHaveBeenCalledWith([
      { machineId: MACHINE_ID, eventId: first.event_uuid },
      { machineId: MACHINE_ID, eventId: second.event_uuid },
      { machineId: MACHINE_ID, eventId: third.event_uuid },
    ]);
    expect(state.listAwaitingRemote).toHaveBeenCalledWith(3, true);
  });

  it("validates an empty queue without issuing PostgreSQL readback", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await invoke("events", "validate");
    expect(log).toHaveBeenCalledWith(
      "Validated 0 events: 0 matched, 0 missing, 0 mismatched.",
    );
    expect(state.readEvents).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it("uses singular validation output for one matching envelope", async () => {
    state.listAwaitingRemote.mockResolvedValue([localEvent()]);
    state.readEvents.mockResolvedValue([remoteEvent()]);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await invoke("events", "validate");

    expect(log).toHaveBeenCalledWith(
      "Validated 1 event: 1 matched, 0 missing, 0 mismatched.",
    );
    expect(process.exitCode).toBeUndefined();
  });

  it.each(["0", "501"])("rejects an unsafe validation limit (%s)", async (limit) => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(invoke("events", "validate", "--limit", limit))
      .rejects.toThrow("exit:1");
    expect(error).toHaveBeenCalledWith(expect.stringContaining("--limit"));
    expect(state.runtimeHealth).not.toHaveBeenCalled();
  });

  it("lists no quarantine in human mode", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await invoke("events", "quarantine");
    expect(log).toHaveBeenCalledWith(
      "No quarantined local or PostgreSQL passive events.",
    );
    expect(state.listLocalQuarantined).toHaveBeenCalledWith(100);
    expect(state.listQuarantined).toHaveBeenCalledWith(100);
  });

  it("serializes local and remote quarantine and sanitizes human reasons", async () => {
    state.listLocalQuarantined.mockResolvedValue([localEvent({
      delivery_state: "quarantined",
      quarantine_reason: "\u001b[31mlocal poison",
    })]);
    state.listQuarantined.mockResolvedValue([remoteEvent({
      status: "quarantined",
      quarantinedAt: "2026-07-29T12:00:02.000Z",
      quarantineReason: "\u001b[31mpoison",
    })]);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await invoke("events", "quarantine", "--json");
    expect(JSON.parse(stdoutText(stdout))).toMatchObject({
      local: [{
        event_uuid: EVENT_ID,
        machine_sequence: "0000000000000000007",
      }],
      remote: [{
        inboxId: "41",
        machineSequence: "7",
        quarantineReason: "\u001b[31mpoison",
      }],
    });

    stdout.mockClear();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await invoke("events", "quarantine");
    expect(log).toHaveBeenCalledTimes(2);
    for (const [line] of log.mock.calls) {
      expect(String(line)).toContain("sequence=7");
      expect(String(line)).not.toContain("\u001b");
    }
  });

  it("prints bounded quarantine fallbacks for legacy nullable metadata", async () => {
    state.listLocalQuarantined.mockResolvedValue([localEvent({
      machine_id: null,
      delivery_state: "quarantined",
      quarantine_reason: null,
    })]);
    state.listQuarantined.mockResolvedValue([remoteEvent({
      status: "quarantined",
      quarantinedAt: "2026-07-29T12:00:02.000Z",
      quarantineReason: null,
    })]);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await invoke("events", "quarantine");

    expect(log).toHaveBeenCalledWith(expect.stringContaining(
      "source=local  machine=unassigned  sequence=7  reason=unknown",
    ));
    expect(log).toHaveBeenCalledWith(expect.stringContaining(
      "source=postgresql  machine="
      + `${MACHINE_ID}  sequence=7  reason=unknown`,
    ));
  });

  it.each(["0", "501"])("rejects an unsafe quarantine limit (%s)", async (limit) => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(invoke("events", "quarantine", "--limit", limit))
      .rejects.toThrow("exit:1");

    expect(error).toHaveBeenCalledWith(expect.stringContaining("--limit"));
    expect(state.runtimeHealth).not.toHaveBeenCalled();
  });

  it("replays one exact remote and local quarantine", async () => {
    state.readEvent.mockResolvedValue(remoteEvent({
      status: "quarantined",
      quarantinedAt: "2026-07-29T12:00:02.000Z",
      quarantineReason: "poison",
    }));
    state.replayRemote.mockResolvedValue(remoteEvent({ status: "pending" }));
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await invoke(
      "events",
      "replay",
      EVENT_ID,
      "--machine",
      "0195d250-0000-7000-8000-000000000099",
      "--json",
    );
    expect(state.replayRemote).toHaveBeenCalledWith({
      machineId: "0195d250-0000-7000-8000-000000000099",
      eventId: EVENT_ID,
    });
    expect(state.replayLocal).toHaveBeenCalledWith(EVENT_ID);
    expect(state.replayLocal.mock.invocationCallOrder[0])
      .toBeLessThan(state.replayRemote.mock.invocationCallOrder[0]);
    expect(JSON.parse(stdoutText(stdout))).toMatchObject({
      replayed: true,
      localReplayed: true,
      event: { inboxId: "41", machineSequence: "7" },
    });
  });

  it("uses the current machine by default and marks a missing replay unsuccessful", async () => {
    state.replayLocal.mockResolvedValue(false);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await invoke("events", "replay", EVENT_ID);
    expect(state.readEvent).toHaveBeenCalledWith({
      machineId: MACHINE_ID,
      eventId: EVENT_ID,
    });
    expect(state.replayRemote).not.toHaveBeenCalled();
    expect(state.replayLocal).toHaveBeenCalledWith(EVENT_ID);
    expect(log).toHaveBeenCalledWith(`Passive event ${EVENT_ID} is not quarantined.`);
    expect(process.exitCode).toBe(1);
  });

  it("replays an exact local-only quarantine without inventing a remote row", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await invoke("events", "replay", EVENT_ID, "--json");

    expect(state.replayRemote).not.toHaveBeenCalled();
    expect(state.replayLocal).toHaveBeenCalledWith(EVENT_ID);
    expect(JSON.parse(stdoutText(stdout))).toEqual({
      replayed: true,
      localReplayed: true,
      event: null,
    });
  });

  it("reports an existing non-quarantined remote row with a local replay", async () => {
    state.readEvent.mockResolvedValue(remoteEvent({ status: "pending" }));
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await invoke("events", "replay", EVENT_ID, "--json");

    expect(state.replayRemote).not.toHaveBeenCalled();
    expect(JSON.parse(stdoutText(stdout))).toMatchObject({
      replayed: true,
      localReplayed: true,
      event: { eventId: EVENT_ID, status: "pending" },
    });
  });

  it("prints a human success for an exact local replay", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await invoke("events", "replay", EVENT_ID);

    expect(log).toHaveBeenCalledWith(`Replayed passive event ${EVENT_ID}.`);
    expect(process.exitCode).toBeUndefined();
  });

  it("accepts pending readback after an uncertain exact replay", async () => {
    state.readEvent
      .mockResolvedValueOnce(remoteEvent({
        status: "quarantined",
        quarantinedAt: "2026-07-29T12:00:02.000Z",
        quarantineReason: "poison",
      }))
      .mockResolvedValueOnce(remoteEvent({ status: "pending" }));
    state.replayRemote.mockResolvedValue(null);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await invoke("events", "replay", EVENT_ID, "--json");

    expect(state.replayLocal).toHaveBeenCalledWith(EVENT_ID);
    expect(state.readEvent).toHaveBeenCalledTimes(2);
    expect(JSON.parse(stdoutText(stdout))).toMatchObject({
      replayed: true,
      localReplayed: true,
      event: { status: "pending" },
    });
  });

  it("fails closed when the authoritative replay state is not pending", async () => {
    state.readEvent.mockResolvedValue(remoteEvent({
      status: "quarantined",
      quarantinedAt: "2026-07-29T12:00:02.000Z",
      quarantineReason: "poison",
    }));
    state.replayRemote.mockResolvedValue(remoteEvent({ status: "retry" }));
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await invoke("events", "replay", EVENT_ID, "--json");

    expect(JSON.parse(stdoutText(stdout))).toEqual({
      replayed: false,
      localReplayed: true,
      event: null,
    });
    expect(process.exitCode).toBe(1);
  });

  it("reports exact replay readback failures through the operator boundary", async () => {
    state.readEvent.mockRejectedValue(new Error("replay readback failed"));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(invoke("events", "replay", EVENT_ID)).rejects.toThrow("exit:1");

    expect(error).toHaveBeenCalledWith("Error: replay readback failed");
  });

  it("prints the shared events help from every operator subcommand", async () => {
    for (const command of ["status", "validate", "quarantine"]) {
      state.exit.mockClear();
      state.printHelp.mockClear();
      await expect(invoke("events", command, "--help")).rejects.toThrow("exit:0");
      expect(state.printHelp).toHaveBeenCalledWith("events");
    }
    await expect(invoke("events", "replay", EVENT_ID, "--help"))
      .rejects.toThrow("exit:0");
    expect(state.printHelp).toHaveBeenCalledWith("events");
  });

  it("rejects a missing events subcommand with bounded usage", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(invoke("events")).rejects.toThrow("exit:1");
    expect(error).toHaveBeenCalledWith(
      "Usage: lcm events <promote|status|validate|quarantine|replay> [options]",
    );
  });
});
