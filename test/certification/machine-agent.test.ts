import { mkdtempSync, readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createAdmissionController,
  createHookFixture,
  captureDoctorEvidence,
  executeDeterministicSchedule,
  isAcknowledgedRow,
  machineStoredConfig,
  observeAcknowledgments,
  runPublicMigrationFlow,
  startForegroundDaemon,
  verifyFinalDrain,
  verifyEmissionBudget,
  verifyTlsNegativeProbe,
  waitForAcknowledgmentCatchUp,
} from "./machine-agent.mjs";
import { extractPostToolEvents, extractUserPromptEvents } from "../../src/hooks/extractors.js";
import { normalizePostToolInput } from "../../src/hooks/post-tool-normalization.js";

describe("certification machine agent", () => {
  it("configures typed values before backend publication", () => {
    expect(machineStoredConfig({ LCM_CERT_MIGRATION_ROLE: "lcm_test_migrator" })).toEqual({
      summarizer: { mock: true },
      hooks: { disableAutoCompact: true, snapshotIntervalSec: 1 },
      storage: {
        backend: "sqlite",
        postgresql: { migrationRole: "lcm_test_migrator", poolMax: 2 },
      },
    });
    expect(() => machineStoredConfig({})).toThrow("migration role");
  });

  it.each([256, 1024, 8192])("creates exact-byte one-event fixtures for %i bytes", (bytes) => {
    const userPrompt = createHookFixture({ kind: "user-prompt", bytes, sessionId: "s0", cwd: "/project" });
    const postTool = createHookFixture({ kind: "post-tool", bytes, sessionId: "s0", cwd: "/project" });
    expect(Buffer.byteLength(userPrompt.prompt)).toBe(bytes);
    expect(Buffer.byteLength(postTool.tool_input.subject)).toBe(bytes);
    expect(postTool.tool_name).toBe("TaskCreate");
  });

  it.each([256, 1024, 1024, 8192])("pins one extracted event for both fixture kinds at %i bytes", (bytes) => {
    const userPrompt = createHookFixture({ kind: "user-prompt", bytes, sessionId: "s0", cwd: "/project" });
    const postTool = createHookFixture({ kind: "post-tool", bytes, sessionId: "s0", cwd: "/project" });
    expect(extractUserPromptEvents(userPrompt.prompt)).toHaveLength(1);
    expect(extractUserPromptEvents(userPrompt.prompt)[0]?.type).toBe("user_decision");
    expect(extractPostToolEvents(normalizePostToolInput(postTool))).toHaveLength(1);
    expect(extractPostToolEvents(normalizePostToolInput(postTool))[0]?.type).toBe("task_create");
  });

  it("recognizes only terminal acknowledged rows", () => {
    expect(isAcknowledgedRow({ delivery_state: "acknowledged", remote_inbox_id: "i", acknowledged_at: "now" })).toBe(true);
    expect(isAcknowledgedRow({ delivery_state: "replicated", remote_inbox_id: "i", acknowledged_at: null })).toBe(false);
  });

  it("requires both the product client rejection and the expected raw TLS class", async () => {
    await expect(verifyTlsNegativeProbe({
      expected: "certificate-authority",
      clientProbe: async () => { throw Object.assign(new Error("LCM command failed"), { stderr: "self signed certificate in certificate chain" }); },
      tlsProbe: async () => new Error("self signed certificate in certificate chain"),
    })).resolves.toBe("certificate-authority");
    await expect(verifyTlsNegativeProbe({
      expected: "certificate-authority",
      clientProbe: async () => { throw Object.assign(new Error("LCM command failed"), { stderr: "connect ECONNREFUSED" }); },
      tlsProbe: async () => new Error("self signed certificate in certificate chain"),
    })).rejects.toThrow("transport-or-other");
    await expect(verifyTlsNegativeProbe({
      expected: "certificate-authority",
      clientProbe: async () => undefined,
      tlsProbe: async () => new Error("self signed certificate in certificate chain"),
    })).rejects.toThrow("unexpectedly succeeded");
  });

  it("owns a foreground daemon child through bounded startup and stop", async () => {
    const child = new EventEmitter() as any;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn(() => {
      queueMicrotask(() => child.emit("exit", 0, null));
      return true;
    });
    const spawnProcess = vi.fn(() => child);
    const daemon = await startForegroundDaemon({
      entrypoint: "/opt/lcm/dist/lcm.mjs",
      environment: {},
      cwd: "/project",
      daemonArguments: ["/opt/lcm/certification/daemon-agent.mjs"],
      spawnProcess,
      healthProbe: async () => undefined,
      delay: async () => undefined,
    });

    await daemon.stop();
    expect(spawnProcess).toHaveBeenCalledWith(process.execPath, [
      "/opt/lcm/certification/daemon-agent.mjs",
    ], expect.objectContaining({ cwd: "/project" }));
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("retains an isolated-home doctor report when connector checks are nonzero", async () => {
    const failure = Object.assign(new Error("doctor failed"), { stdout: "10 passed · 1 failed\n", code: 1 });
    await expect(captureDoctorEvidence(async () => { throw failure; })).resolves.toEqual({
      stdout: "10 passed · 1 failed\n",
      exitCode: 1,
    });
    await expect(captureDoctorEvidence(async () => { throw new Error("no report"); })).rejects.toThrow("no report");
  });

  it("runs the supported public forward migration flow with one confirmed generation", async () => {
    const runStep = vi.fn(async (args: string[]) => ({
      generation: "generation-1",
      outcome: "ok",
      manifestPhase: args[0] === "apply" ? "copied" : args[0] === "verify" ? "verified" : args[0] === "activate" ? "active" : null,
    }));
    const result = await runPublicMigrationFlow(runStep);

    expect(runStep.mock.calls.map(([args]) => args)).toEqual([
      ["plan"],
      ["apply", "--confirm-generation", "generation-1"],
      ["verify", "--generation", "generation-1", "--confirm-generation", "generation-1"],
      ["activate", "--generation", "generation-1", "--confirm-generation", "generation-1", "--confirm-backend", "postgresql"],
    ]);
    expect(result).toHaveLength(4);
  });

  it("records first-seen monotonic time and distinct inbox ids", () => {
    const previous = new Map();
    const observed = observeAcknowledgments(previous, [
      { event_uuid: "e", delivery_state: "acknowledged", remote_inbox_id: "i", acknowledged_at: "now" },
      { event_uuid: "pending", delivery_state: "replicated", remote_inbox_id: "j", acknowledged_at: null },
    ], 123n);
    expect(observed.get("e")).toEqual({ firstSeenMonotonicNs: "123", inboxIds: ["i"] });
    expect(observed.has("pending")).toBe(false);
  });

  it("fails closed when the bounded queue overflows", async () => {
    const admission = createAdmissionController({ maxActive: 1, maxQueued: 1 });
    let release!: () => void;
    const blocked = admission.run(() => new Promise<void>((resolve) => { release = resolve; }));
    const queued = admission.run(async () => "queued");
    await expect(admission.run(async () => "overflow")).rejects.toThrow("overflow");
    release();
    await expect(blocked).resolves.toBeUndefined();
    await expect(queued).resolves.toBe("queued");
  });

  it("requires every captured event to be acknowledged and remotely pruned", () => {
    expect(verifyFinalDrain([
      { event_uuid: "a", delivery_state: "acknowledged", remote_inbox_id: "1", acknowledged_at: "now", remote_pruned_at: "later" },
    ])).toEqual({ acknowledged: 1, remotePruned: 1 });
    expect(() => verifyFinalDrain([
      { event_uuid: "a", delivery_state: "acknowledged", remote_inbox_id: "1", acknowledged_at: "now", remote_pruned_at: null },
    ])).toThrow("awaiting remote prune");
    expect(() => verifyFinalDrain([
      { event_uuid: "a", delivery_state: "retry", remote_inbox_id: null, acknowledged_at: null, remote_pruned_at: null },
    ])).toThrow("nonterminal");
  });

  it("enforces the half-open rolling 300-second emission budget", () => {
    expect(verifyEmissionBudget(Array.from({ length: 30 }, (_, index) => 1 + index * 10), 30)).toBe(30);
    expect(() => verifyEmissionBudget(Array.from({ length: 31 }, (_, index) => index * 9), 30)).toThrow("emission budget");
  });

  it("records an operation whose admission starts after its absolute deadline", async () => {
    const evidenceDirectory = mkdtempSync(join(tmpdir(), "lcm-cert-operation-deadline-"));
    const samples = await executeDeterministicSchedule({
      schedule: [{ id: "late", machine: "a", op: "search", offsetSeconds: 0, phase: "steady" }],
      entrypoint: "/unused/lcm.mjs", cwd: evidenceDirectory, environment: {}, evidenceDirectory,
      scheduleStartWallMs: 0, wallNow: () => 60_001, delay: async () => undefined,
    });
    expect(samples).toEqual([expect.objectContaining({ outcome: "failed", errorClass: "OperationDeadlineExceeded" })]);
    expect(readFileSync(join(evidenceDirectory, "samples.ndjson"), "utf8")).toContain("OperationDeadlineExceeded");
  });

  it("aborts an in-flight daemon request at the absolute operation deadline", async () => {
    const evidenceDirectory = mkdtempSync(join(tmpdir(), "lcm-cert-http-deadline-"));
    const post = vi.fn((_path: string, _body: unknown, options: { signal: AbortSignal; timeoutMs: number }) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
      }));
    const execution = executeDeterministicSchedule({
      schedule: [{ id: "http", machine: "a", op: "search", offsetSeconds: 0, phase: "steady" }],
      entrypoint: "/unused/lcm.mjs", cwd: evidenceDirectory, environment: {}, evidenceDirectory,
      daemonClient: { post }, scheduleStartWallMs: Date.now(), operationTimeoutMs: 25,
    });

    await expect(execution).resolves.toEqual([
      expect.objectContaining({ outcome: "failed", errorClass: "OperationDeadlineExceeded" }),
    ]);
    expect(post).toHaveBeenCalledWith("/search", expect.any(Object), expect.objectContaining({
      timeoutMs: expect.any(Number), signal: expect.objectContaining({ aborted: true }),
    }));
    expect(readFileSync(join(evidenceDirectory, "samples.ndjson"), "utf8")).toContain("OperationDeadlineExceeded");
  });

  it("clears later arrival timers when a schedule aborts", async () => {
    const evidenceDirectory = mkdtempSync(join(tmpdir(), "lcm-cert-arrival-abort-"));
    const post = vi.fn(async () => { throw Object.assign(new Error("request deadline"), { code: "OperationDeadlineExceeded" }); });
    const outstanding = new Set<NodeJS.Timeout>();
    let abortListeners = 0;
    const delay = (milliseconds: number, { signal }: { signal?: AbortSignal } = {}) => new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        outstanding.delete(timer);
        signal?.removeEventListener("abort", onAbort);
        abortListeners -= 1;
        resolve();
      }, milliseconds);
      outstanding.add(timer);
      const onAbort = () => {
        clearTimeout(timer);
        outstanding.delete(timer);
        signal?.removeEventListener("abort", onAbort);
        abortListeners -= 1;
        resolve();
      };
      abortListeners += 1;
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
    const execution = executeDeterministicSchedule({
      schedule: [
        { id: "first", machine: "a", op: "search", offsetSeconds: 0, phase: "steady" },
        { id: "later", machine: "b", op: "search", offsetSeconds: 6000, phase: "steady" },
      ],
      entrypoint: "/unused/lcm.mjs", cwd: evidenceDirectory, environment: {}, evidenceDirectory,
      daemonClient: { post }, scheduleStartWallMs: Date.now(), delay,
    });

    await expect(execution).resolves.toEqual([
      expect.objectContaining({ id: "first", outcome: "failed" }),
      expect.objectContaining({ id: "later", outcome: "cancelled", errorClass: "AdmissionAborted" }),
    ]);
    expect(outstanding.size).toBe(0);
    expect(abortListeners).toBe(0);
  });

  it("bounds daemon health readiness with an absolute cancellable deadline", async () => {
    const child = new EventEmitter() as any;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn(() => {
      queueMicrotask(() => child.emit("exit", 0, null));
      return true;
    });
    const healthProbe = vi.fn(({ signal }: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    const startup = startForegroundDaemon({
      entrypoint: "/opt/lcm/dist/lcm.mjs", environment: {}, cwd: "/project",
      daemonArguments: ["/opt/lcm/certification/daemon-agent.mjs"],
      spawnProcess: vi.fn(() => child), healthProbe, readinessTimeoutMs: 25, delay: async () => undefined,
    });

    await expect(startup).rejects.toThrow("did not become ready");
    expect(healthProbe).toHaveBeenCalledWith(expect.objectContaining({
      timeoutMs: expect.any(Number), signal: expect.objectContaining({ aborted: true }),
    }));
    expect(healthProbe).toHaveBeenCalledTimes(1);
  });

  it("measures catch-up against clearance time and records the observation", async () => {
    const evidenceDirectory = mkdtempSync(join(tmpdir(), "lcm-cert-catch-up-deadline-"));
    const clearedAt = "2026-10-26T10:00:00.000Z";
    const result = await waitForAcknowledgmentCatchUp(
      "/unused/home", evidenceDirectory, "partition", clearedAt, 900,
      {
        now: () => Date.parse(clearedAt) + 950_000,
        readRows: async () => [{ delivery_state: "acknowledged", remote_inbox_id: "inbox-1", acknowledged_at: clearedAt, remote_pruned_at: clearedAt }],
      },
    );

    expect(result).toMatchObject({
      phase: "partition", verdict: "fail", clearedAt,
      observedAt: "2026-10-26T10:15:50.000Z", seconds: 950, remaining: null,
    });
    expect(readFileSync(join(evidenceDirectory, "partition-catch-up.json"), "utf8")).toContain('"seconds":950');
  });

  it("records the qualifying catch-up observation from clearance", async () => {
    const evidenceDirectory = mkdtempSync(join(tmpdir(), "lcm-cert-catch-up-pass-"));
    const clearedAt = "2026-10-26T10:00:00.000Z";
    const result = await waitForAcknowledgmentCatchUp(
      "/unused/home", evidenceDirectory, "restart", clearedAt, 900,
      {
        now: () => Date.parse(clearedAt) + 12_500,
        readRows: async () => [{ delivery_state: "acknowledged", remote_inbox_id: "inbox-1", acknowledged_at: clearedAt, remote_pruned_at: clearedAt }],
      },
    );

    expect(result).toMatchObject({
      phase: "restart", verdict: "pass", clearedAt,
      observedAt: "2026-10-26T10:00:12.500Z", seconds: 12.5, remaining: 0,
    });
  });
});
