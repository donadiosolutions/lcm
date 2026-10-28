import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import {
  createAdmissionController,
  createHookFixture,
  captureDoctorEvidence,
  collectDiagnosticSecrets,
  executeDeterministicSchedule,
  expectedHookPayload,
  isAcknowledgedRow,
  machineStoredConfig,
  observeAcknowledgments,
  observeUntilStopped,
  probeLcmTlsRejection,
  readAcknowledgmentRows,
  redactDiagnosticText,
  runPublicMigrationFlow,
  startForegroundDaemon,
  verifyFinalDrain,
  verifyEmissionBudget,
  verifyTlsNegativeProbe,
  waitForAcknowledgmentCatchUp,
} from "./machine-agent.mjs";
import { OBSERVER_BUSY_TIMEOUT_MS, observerReadSettings } from "./sqlite-observer-worker.mjs";
import { extractPostToolEvents, extractUserPromptEvents } from "../../src/hooks/extractors.js";
import { normalizePostToolInput } from "../../src/hooks/post-tool-normalization.js";
import { scrubExtractedEvents } from "../../src/hooks/event-scrubbing.js";

// The workload's primary-text cycle, read from the approved contract file itself so
// that any cycle edit is exercised against the product's capture admission below.
const primaryTextBytesCycle: number[] = JSON.parse(readFileSync(new URL("./contract-v3.json", import.meta.url), "utf8"))
  .workload.primaryTextBytesCycle;

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

  it.each([...new Set(primaryTextBytesCycle)])("creates exact-byte one-event fixtures for %i bytes", (bytes) => {
    const userPrompt = createHookFixture({ kind: "user-prompt", bytes, sessionId: "s0", cwd: "/project" });
    const postTool = createHookFixture({ kind: "post-tool", bytes, sessionId: "s0", cwd: "/project" });
    expect(Buffer.byteLength(userPrompt.prompt)).toBe(bytes);
    expect(Buffer.byteLength(postTool.tool_input.subject)).toBe(bytes);
    expect(postTool.tool_name).toBe("TaskCreate");
  });

  // Contract cardinality check for all 8 kind/length combinations: extraction yields one
  // event, and the product's scrub admission (MAX_SCRUB_INPUT) keeps exactly that event
  // with the payload the runtime capture oracle hashes. A fixture over the product limit
  // fails here instead of aborting a full run.
  it.each(primaryTextBytesCycle.flatMap((bytes) => (["user-prompt", "post-tool"] as const).map((kind) => [kind, bytes] as const)))(
    "admits exactly one scrubbed %s event at %i bytes", async (kind, bytes) => {
      const cwd = mkdtempSync(join(tmpdir(), "lcm-cert-fixture-admission-"));
      const fixture = createHookFixture({ kind, bytes, sessionId: "s0", cwd });
      const extracted = kind === "user-prompt"
        ? extractUserPromptEvents(fixture.prompt)
        : extractPostToolEvents(normalizePostToolInput(fixture));
      expect(extracted.map((event) => event.type)).toEqual([kind === "user-prompt" ? "user_decision" : "task_create"]);
      const admitted = await scrubExtractedEvents(extracted, cwd, []);
      expect(admitted).toHaveLength(1);
      expect(admitted[0]?.data).toBe(expectedHookPayload(kind, fixture));
    },
  );

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

  it("uses the packaged LCM PostgreSQL client configuration for TLS probes", async () => {
    const tlsError = new Error("self signed certificate in certificate chain");
    const connect = vi.fn(async () => { throw tlsError; });
    const end = vi.fn(async () => undefined);
    const buildConfig = vi.fn(() => ({ ssl: { rejectUnauthorized: true } }));

    await expect(probeLcmTlsRejection({
      entrypoint: "/opt/lcm/dist/lcm.mjs",
      url: "postgresql://runtime:secret@db:5432/lcm",
      caFile: "/run/lcm-ca/wrong-ca.crt",
      loadClientConfig: async () => buildConfig,
      clientFactory: async (config: unknown) => {
        expect(config).toEqual({ ssl: { rejectUnauthorized: true } });
        return { connect, query: vi.fn(), end };
      },
    })).rejects.toBe(tlsError);
    expect(buildConfig).toHaveBeenCalledWith(expect.objectContaining({
      url: "postgresql://runtime:secret@db:5432/lcm",
      caFile: "/run/lcm-ca/wrong-ca.crt",
    }), { applicationName: "lcm-certification-tls-negative" });
    expect(connect).toHaveBeenCalledOnce();
    expect(end).toHaveBeenCalledOnce();
  });

  it("owns a foreground daemon child started through the packaged entrypoint", async () => {
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
      spawnProcess,
      healthProbe: async () => undefined,
      delay: async () => undefined,
    });

    await daemon.stop();
    // The daemon reports process.argv[1] as its identity; the CLI authenticates it
    // only against the packaged entrypoint, so no wrapper script may sit in front.
    expect(spawnProcess).toHaveBeenCalledWith(process.execPath, [
      "/opt/lcm/dist/lcm.mjs", "daemon", "start", "--foreground",
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

it("redacts secret environment values and URL credentials and bounds diagnostic text", () => {
    const environment = { LCM_POSTGRES_URL: "postgresql://runtime:pw-secret-123@db.internal:5432/lcm", LCM_CERT_TRANSFER_PASSWORD: "transfer-secret-456", HOME: "/home/machine-a", SHORT_KEY: "abc" };
    const text = "failed for postgresql://runtime:pw-secret-123@db.internal:5432/lcm and transfer-secret-456 and other://user:topsecret@host/x and abc";
    const redacted = redactDiagnosticText(text, environment);
    expect(redacted).not.toContain("pw-secret-123");
    expect(redacted).not.toContain("transfer-secret-456");
    expect(redacted).not.toContain("topsecret");
    expect(redacted).toContain("[redacted:LCM_POSTGRES_URL]");
    expect(redacted).toContain("[redacted:LCM_CERT_TRANSFER_PASSWORD]");
    expect(redacted).toContain("other://user:[redacted]@host/x");
    expect(redacted).toContain(" abc");
    expect(redactDiagnosticText(undefined)).toBe("");
    const long = redactDiagnosticText("y".repeat(5000), {}, 100);
    expect(long.startsWith("y".repeat(100))).toBe(true);
    expect(long).toContain("[truncated 4900 characters]");
    expect(long.length).toBeLessThan(200);
  });

  it("redacts derived secret forms: bare and decoded URL passwords, query credentials, daemon token, longest first", () => {
    const directory = mkdtempSync(join(tmpdir(), "lcm-cert-redact-derived-"));
    const daemonTokenPath = join(directory, "daemon.token");
    writeFileSync(daemonTokenPath, "daemon-token-value-0123456789\n");
    const environment = {
      LCM_POSTGRES_URL: "postgresql://runtime:p%40ss-word-9876@db.internal:5432/lcm?sslmode=require&password=query-pass-5555",
      LCM_SHORT_SECRET: "short-secret-xyz",
      LCM_LONG_SECRET: "short-secret-xyz-plus-longer-suffix",
    };
    const secrets = collectDiagnosticSecrets(environment, { daemonTokenPath });
    expect([...secrets.keys()]).toEqual(expect.arrayContaining(["p%40ss-word-9876", "p@ss-word-9876", "query-pass-5555", "daemon-token-value-0123456789", "short-secret-xyz", "short-secret-xyz-plus-longer-suffix"]));
    const text = [
      "bare encoded p%40ss-word-9876 and decoded p@ss-word-9876",
      "query password=query-pass-5555 and token=unknown-token-1234&next",
      "authorization bearer daemon-token-value-0123456789",
      "overlap short-secret-xyz-plus-longer-suffix then short-secret-xyz",
    ].join("\n");
    const redacted = redactDiagnosticText(text, environment, 4096, secrets);
    for (const secret of ["p%40ss-word-9876", "p@ss-word-9876", "query-pass-5555", "unknown-token-1234", "daemon-token-value-0123456789", "short-secret-xyz", "longer-suffix"]) {
      expect(redacted).not.toContain(secret);
    }
    expect(redacted).toContain("[redacted:LCM_POSTGRES_URL.password]");
    expect(redacted).toContain("[redacted:daemon.token]");
    expect(redacted).toContain("token=[redacted]");
    expect(redacted).toContain("overlap [redacted:LCM_LONG_SECRET] then [redacted:LCM_SHORT_SECRET]");
    expect(collectDiagnosticSecrets(environment, { daemonTokenPath: join(directory, "missing.token") }).has("daemon-token-value-0123456789")).toBe(false);
    expect(redactDiagnosticText("plain detail stays", environment, 4096, secrets)).toBe("plain detail stays");
  });

it("masks short derived credentials at any length while keeping the whole-value floor", () => {
    const directory = mkdtempSync(join(tmpdir(), "lcm-cert-redact-short-"));
    const daemonTokenPath = join(directory, "daemon.token");
    writeFileSync(daemonTokenPath, "tok4567\n");
    const environment = {
      LCM_POSTGRES_URL: "postgresql://runtime:abc123@db.internal:5432/lcm?token=q%2F1",
      LCM_TINY_SECRET: "tiny",
      LCM_HOME_DIR_KEY: "short",
    };
    const secrets = collectDiagnosticSecrets(environment, { daemonTokenPath });
    expect(secrets.get("abc123")).toBe("LCM_POSTGRES_URL.password");
    expect(secrets.get("q%2F1")).toBe("LCM_POSTGRES_URL.token");
    expect(secrets.get("q/1")).toBe("LCM_POSTGRES_URL.token");
    expect(secrets.get("tok4567")).toBe("daemon.token");
    expect(secrets.has("tiny")).toBe(false);
    expect(secrets.has("short")).toBe(false);
    expect(secrets.has("")).toBe(false);
    const redacted = redactDiagnosticText("pw abc123; query q%2F1 decoded q/1; bearer tok4567; words tiny short stay", environment, 4096, secrets);
    for (const secret of ["abc123", "q%2F1", "q/1", "tok4567"]) expect(redacted).not.toContain(secret);
    expect(redacted).toContain("[redacted:LCM_POSTGRES_URL.password]");
    expect(redacted).toContain("[redacted:daemon.token]");
    expect(redacted).toContain("words tiny short stay");
  });

  it("distinguishes the two fatal-abort paths: waiting attempts are cancelled without a record, queued attempts fail with one record", async () => {
    const evidenceDirectory = mkdtempSync(join(tmpdir(), "lcm-cert-abort-paths-"));
    const post = vi.fn(async () => { throw Object.assign(new Error("request deadline"), { code: "OperationDeadlineExceeded" }); });
    // Zero-offset attempts enter admission in one tick (four active, four queued);
    // the "waiting" attempt sits in an abortable delay until the fatal abort fires.
    const delay = (milliseconds: number, { signal }: { signal?: AbortSignal } = {}) => new Promise<void>((resolve) => {
      if (milliseconds === 0) { resolve(); return; }
      const timer = setTimeout(resolve, milliseconds);
      const onAbort = () => { clearTimeout(timer); resolve(); };
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
    const samples = await executeDeterministicSchedule({
      schedule: [
        ...Array.from({ length: 8 }, (_, index) => ({ id: `queued-${index}`, machine: "a", op: "search", offsetSeconds: 0, phase: "steady" })),
        { id: "waiting", machine: "b", op: "search", offsetSeconds: 6000, phase: "steady" },
      ],
      entrypoint: "/unused/lcm.mjs", cwd: evidenceDirectory, environment: {}, evidenceDirectory,
      daemonClient: { post }, scheduleStartWallMs: Date.now(), delay,
    });
    const waiting = samples.find((sample) => sample.id === "waiting");
    expect(waiting).toMatchObject({ outcome: "cancelled", errorClass: "AdmissionAborted" });
    const queuedAborted = samples.filter((sample) => sample.id.startsWith("queued-") && sample.errorClass === "AdmissionAborted");
    expect(queuedAborted.length).toBeGreaterThan(0);
    expect(queuedAborted.every((sample) => sample.outcome === "failed")).toBe(true);
    const failures = readFileSync(join(evidenceDirectory, "failures.ndjson"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(failures.some((record) => record.id === "waiting")).toBe(false);
    for (const sample of queuedAborted) {
      const rows = failures.filter((record) => record.id === sample.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ errorClass: "AdmissionAborted", message: "certification schedule aborted", exitCode: null, exitSignal: null, processStartWallMs: null, processExitWallMs: null });
    }
    expect(failures.map((record) => record.id).sort()).toEqual(samples.filter((sample) => sample.outcome === "failed").map((sample) => sample.id).sort());
  });

  it("records private diagnostics for a deadline elapsed before admission without fabricating timing", async () => {
    const evidenceDirectory = mkdtempSync(join(tmpdir(), "lcm-cert-preadmission-record-"));
    const samples = await executeDeterministicSchedule({
      schedule: [{ id: "late", machine: "a", op: "search", offsetSeconds: 0, phase: "steady" }],
      entrypoint: "/unused/lcm.mjs", cwd: evidenceDirectory, environment: {}, evidenceDirectory,
      scheduleStartWallMs: 0, wallNow: () => 60_001, delay: async () => undefined,
    });
    expect(samples).toEqual([expect.objectContaining({ outcome: "failed", errorClass: "OperationDeadlineExceeded" })]);
    const failures = readFileSync(join(evidenceDirectory, "failures.ndjson"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(failures).toEqual([expect.objectContaining({
      id: "late", errorClass: "OperationDeadlineExceeded", exitCode: null, exitSignal: null,
      message: "certification operation deadline elapsed before admission", processStartWallMs: null, processExitWallMs: null,
    })]);
  });

  it("records private diagnostics for admission overflow and for a late return past the deadline, once each", async () => {
    const evidenceDirectory = mkdtempSync(join(tmpdir(), "lcm-cert-overflow-late-record-"));
    let clock = 0;
    const post = vi.fn(async () => { clock = 60_001; });
    const schedule = [
      ...Array.from({ length: 70 }, (_, index) => ({ id: `search-${index}`, machine: "a", op: "search", offsetSeconds: 0, phase: "steady" })),
    ];
    const samples = await executeDeterministicSchedule({
      schedule, entrypoint: "/unused/lcm.mjs", cwd: evidenceDirectory, environment: {}, evidenceDirectory,
      daemonClient: { post }, scheduleStartWallMs: 0, wallNow: () => clock, delay: async () => undefined,
    });
    const byClass = samples.reduce((counts, sample) => ({ ...counts, [sample.errorClass ?? "none"]: (counts[sample.errorClass ?? "none"] ?? 0) + 1 }), {} as Record<string, number>);
    expect(byClass.AdmissionOverflow).toBeGreaterThan(0);
    expect(byClass.OperationDeadlineExceeded).toBeGreaterThan(0);
    expect(samples.every((sample) => sample.outcome !== "success")).toBe(true);
    const failures = readFileSync(join(evidenceDirectory, "failures.ndjson"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const failedIds = samples.filter((sample) => sample.outcome === "failed").map((sample) => sample.id).sort();
    expect(failures.map((record) => record.id).sort()).toEqual(failedIds);
    expect(new Set(failures.map((record) => record.id)).size).toBe(failures.length);
    const overflow = failures.find((record) => record.errorClass === "AdmissionOverflow");
    expect(overflow).toMatchObject({ exitCode: null, exitSignal: null, processStartWallMs: null, processExitWallMs: null });
    expect(overflow.message).toMatch(/overflow/u);
    const late = failures.find((record) => record.message === "certification operation completed after its absolute deadline");
    expect(late).toMatchObject({ errorClass: "OperationDeadlineExceeded", exitCode: null, exitSignal: null });
    expect(typeof late.processStartWallMs).toBe("number");
  });

  it("persists bounded redacted private diagnostics and timing for a failed CLI operation", async () => {
    const evidenceDirectory = mkdtempSync(join(tmpdir(), "lcm-cert-cli-failure-"));
    const entrypoint = join(evidenceDirectory, "failing-lcm.mjs");
    writeFileSync(entrypoint, [
      "process.stdout.write('partial output');",
      "process.stderr.write('compact refused: marker-stderr ' + process.env.LCM_POSTGRES_URL + '\\n');",
      "process.exit(3);",
    ].join("\n"));
    const environment = { PATH: process.env.PATH ?? "", LCM_POSTGRES_URL: "postgresql://runtime:pw-secret-123@db.internal:5432/lcm" };
    const scheduleStartWallMs = Date.now();
    const samples = await executeDeterministicSchedule({
      schedule: [{ id: "compact-0", machine: "a", op: "compact", offsetSeconds: 0, phase: "steady", sessionId: "s0" }],
      entrypoint, cwd: evidenceDirectory, environment, evidenceDirectory, scheduleStartWallMs,
    });
    expect(samples).toEqual([expect.objectContaining({ id: "compact-0", outcome: "failed", errorClass: "CliExit", exitCode: 3 })]);
    const sample = samples[0] as Record<string, unknown>;
    expect(sample.exitSignal).toBeUndefined();
    expect(typeof sample.processStartWallMs).toBe("number");
    expect(typeof sample.processExitWallMs).toBe("number");
    expect(sample.processExitWallMs as number).toBeGreaterThanOrEqual(sample.processStartWallMs as number);
    expect(sample.durationMs as number).toBeGreaterThan(0);
    expect(sample.scheduleDelayMs as number).toBeGreaterThanOrEqual(0);
    expect(sample.scheduleDelayMs as number).toBeLessThan(sample.durationMs as number + 10_000);
    const samplesText = readFileSync(join(evidenceDirectory, "samples.ndjson"), "utf8");
    expect(samplesText).not.toContain("marker-stderr");
    expect(samplesText).not.toContain("pw-secret-123");
    const failures = readFileSync(join(evidenceDirectory, "failures.ndjson"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(failures).toEqual([expect.objectContaining({
      id: "compact-0", machine: "a", op: "compact", phase: "steady", errorClass: "CliExit", exitCode: 3, exitSignal: null,
      message: "LCM command failed with 3", stdout: "partial output",
      processStartWallMs: sample.processStartWallMs, processExitWallMs: sample.processExitWallMs,
    })]);
    expect(failures[0].stderr).toContain("compact refused: marker-stderr [redacted:LCM_POSTGRES_URL]");
    expect(failures[0].stderr).not.toContain("pw-secret-123");
  });

  it("records timing and a redacted message for a failed daemon operation", async () => {
    const evidenceDirectory = mkdtempSync(join(tmpdir(), "lcm-cert-daemon-failure-"));
    const post = vi.fn(async () => { throw new Error("daemon rejected token-secret-789"); });
    const samples = await executeDeterministicSchedule({
      schedule: [{ id: "search-0", machine: "b", op: "search", offsetSeconds: 0, phase: "steady" }],
      entrypoint: "/unused/lcm.mjs", cwd: evidenceDirectory, environment: { LCM_API_TOKEN: "token-secret-789" }, evidenceDirectory,
      daemonClient: { post }, scheduleStartWallMs: Date.now(),
    });
    expect(samples).toEqual([expect.objectContaining({ id: "search-0", outcome: "failed", errorClass: "Error" })]);
    const sample = samples[0] as Record<string, unknown>;
    expect(sample.exitCode).toBeUndefined();
    expect(typeof sample.processStartWallMs).toBe("number");
    expect(typeof sample.processExitWallMs).toBe("number");
    const failures = readFileSync(join(evidenceDirectory, "failures.ndjson"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(failures).toEqual([expect.objectContaining({ id: "search-0", op: "search", errorClass: "Error", exitCode: null, exitSignal: null, message: "daemon rejected [redacted:LCM_API_TOKEN]", stderr: "", stdout: "" })]);
    expect(readFileSync(join(evidenceDirectory, "samples.ndjson"), "utf8")).not.toContain("token-secret-789");
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

  it("keeps a fault-recovery schedule running after an operation times out", async () => {
    // The first search times out; the later store is released only after that failure.
    const runSchedule = (deadlineAbortsSchedule: boolean) => {
      const evidenceDirectory = mkdtempSync(join(tmpdir(), "lcm-cert-fault-deadline-"));
      let releaseLater = () => {};
      const searchFailed = new Promise<void>((resolve) => { releaseLater = resolve; });
      const post = vi.fn(async (path: string) => {
        if (path !== "/search") return {};
        setTimeout(releaseLater, 0);
        throw Object.assign(new Error("request deadline"), { code: "OperationDeadlineExceeded" });
      });
      return executeDeterministicSchedule({
        schedule: [
          { id: "hung", machine: "a", op: "search", offsetSeconds: 0, phase: "partition-recovery" },
          { id: "after", machine: "a", op: "store", offsetSeconds: 2, phase: "partition-recovery" },
        ],
        entrypoint: "/unused/lcm.mjs", cwd: evidenceDirectory, environment: {}, evidenceDirectory,
        daemonClient: { post }, scheduleStartWallMs: Date.now(),
        delay: (milliseconds: number) => milliseconds > 0 ? searchFailed : Promise.resolve(),
        deadlineAbortsSchedule,
      });
    };
    await expect(runSchedule(false)).resolves.toEqual([
      expect.objectContaining({ id: "hung", outcome: "failed", errorClass: "OperationDeadlineExceeded" }),
      expect.objectContaining({ id: "after", outcome: "success" }),
    ]);
    // The steady default still treats the timeout as fatal and cancels the later arrival.
    await expect(runSchedule(true)).resolves.toEqual([
      expect.objectContaining({ id: "hung", outcome: "failed", errorClass: "OperationDeadlineExceeded" }),
      expect.objectContaining({ id: "after", outcome: "cancelled", errorClass: "AdmissionAborted" }),
    ]);
  });

  // The two other deadline paths. The later operation waits one real macrotask, so it is
  // admitted only after the first operation has settled.
  const afterFirstSettles = (milliseconds: number) => milliseconds > 0
    ? new Promise<void>((resolve) => setTimeout(resolve, 20))
    : Promise.resolve();
  const runAfterDeadline = (path: "late return" | "before admission", deadlineAbortsSchedule: boolean) => {
    const evidenceDirectory = mkdtempSync(join(tmpdir(), "lcm-cert-deadline-path-"));
    // Before admission: the first operation's deadline has already passed when it is due.
    // Late return: its request returns only after its deadline.
    let clock = path === "before admission" ? 60_001 : 0;
    const post = vi.fn(async (route: string) => {
      if (route === "/search") clock = 60_001;
      return {};
    });
    return executeDeterministicSchedule({
      schedule: [
        { id: "late", machine: "a", op: "search", offsetSeconds: 0, phase: "restart-recovery" },
        { id: "after", machine: "a", op: "store", offsetSeconds: 61, phase: "restart-recovery" },
      ],
      entrypoint: "/unused/lcm.mjs", cwd: evidenceDirectory, environment: {}, evidenceDirectory,
      daemonClient: { post }, scheduleStartWallMs: 0, wallNow: () => clock, delay: afterFirstSettles, deadlineAbortsSchedule,
    });
  };

  it.each(["late return", "before admission"] as const)("keeps a fault-recovery schedule running after a %s deadline", async (path) => {
    await expect(runAfterDeadline(path, false)).resolves.toEqual([
      expect.objectContaining({ id: "late", outcome: "failed", errorClass: "OperationDeadlineExceeded" }),
      expect.objectContaining({ id: "after", outcome: "success" }),
    ]);
    await expect(runAfterDeadline(path, true)).resolves.toEqual([
      expect.objectContaining({ id: "late", outcome: "failed", errorClass: "OperationDeadlineExceeded" }),
      expect.objectContaining({ id: "after", outcome: "cancelled", errorClass: "AdmissionAborted" }),
    ]);
  });

  it("still aborts a fault-recovery schedule on admission overflow", async () => {
    const evidenceDirectory = mkdtempSync(join(tmpdir(), "lcm-cert-fault-overflow-"));
    const post = vi.fn(async () => ({}));
    const samples = await executeDeterministicSchedule({
      schedule: [
        // 4 active plus 64 queued fit; the last two of the 70 overflow.
        ...Array.from({ length: 70 }, (_, index) => ({ id: `search-${index}`, machine: "a", op: "search", offsetSeconds: 0, phase: "partition-recovery" })),
        { id: "after", machine: "a", op: "store", offsetSeconds: 10, phase: "partition-recovery" },
      ],
      entrypoint: "/unused/lcm.mjs", cwd: evidenceDirectory, environment: {}, evidenceDirectory,
      daemonClient: { post }, scheduleStartWallMs: 0, wallNow: () => 0, delay: afterFirstSettles, deadlineAbortsSchedule: false,
    });
    expect(samples.filter((sample) => sample.errorClass === "AdmissionOverflow").length).toBeGreaterThan(0);
    expect(samples.at(-1)).toMatchObject({ id: "after", outcome: "cancelled", errorClass: "AdmissionAborted" });
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
describe("certification observer poll completeness", () => {
  const acknowledged = { event_uuid: "e1", delivery_state: "acknowledged", remote_inbox_id: "inbox-1", acknowledged_at: "2026-10-28T00:00:00.000Z" };
  const settings = observerReadSettings(JSON.parse(readFileSync(new URL("./contract-v3.json", import.meta.url), "utf8")));

  function observerHome({ siblings }: { siblings: boolean }) {
    const home = mkdtempSync(join(tmpdir(), "lcm-cert-observer-home-"));
    const evidenceDirectory = mkdtempSync(join(tmpdir(), "lcm-cert-observer-evidence-"));
    mkdirSync(join(home, ".lcm", "events"), { recursive: true });
    const database = join(home, ".lcm", "events", "project.db");
    writeFileSync(database, "");
    if (siblings) for (const suffix of ["-wal", "-shm"]) writeFileSync(`${database}${suffix}`, "");
    return { home, evidenceDirectory, database };
  }

  // Runs the real observer loop for a fixed number of polls on a scripted monotonic clock.
  function observe(
    input: { home: string; evidenceDirectory: string },
    options: { clock: number[]; polls: number; readRows?: (path: string, timeoutMs: number) => Promise<unknown[]>; betweenPolls?: () => void; pauses?: number[] },
  ) {
    const controller = new AbortController();
    let clockReads = 0;
    let pauses = 0;
    return observeUntilStopped({
      ...input,
      signal: controller.signal,
      settings,
      now: () => options.clock[Math.min(clockReads++, options.clock.length - 1)],
      readRows: options.readRows ?? (async () => [acknowledged]),
      pause: async (milliseconds: number) => {
        options.pauses?.push(milliseconds);
        pauses += 1;
        if (pauses >= options.polls) controller.abort();
        else options.betweenPolls?.();
      },
    });
  }

  const records = (evidenceDirectory: string) => readFileSync(join(evidenceDirectory, "observer.ndjson"), "utf8")
    .trim().split("\n").map((line) => JSON.parse(line));

  it("keeps a good poll complete after SQLite removed the -wal/-shm siblings on a clean close", async () => {
    const input = observerHome({ siblings: false });
    const database = new DatabaseSync(input.database);
    database.exec("PRAGMA journal_mode = WAL");
    database.exec("CREATE TABLE events (event_id INTEGER PRIMARY KEY, data TEXT)");
    database.prepare("INSERT INTO events (data) VALUES (?)").run("row");
    database.close();
    expect([existsSync(`${input.database}-wal`), existsSync(`${input.database}-shm`)]).toEqual([false, false]);

    const result = await observe(input, { clock: [0, 1000], polls: 1 });
    expect(result.incomplete).toBe(false);
    expect(result.observations.get("e1")?.inboxIds).toEqual(["inbox-1"]);
    expect(records(input.evidenceDirectory)).toEqual([
      expect.objectContaining({ status: "ok", gapMs: 1000, siblingsPresent: false, incomplete: false }),
    ]);
  });

  it("marks a poll gap over two seconds incomplete", async () => {
    const input = observerHome({ siblings: true });
    const result = await observe(input, { clock: [0, 2500], polls: 1 });
    expect(result.incomplete).toBe(true);
    expect(records(input.evidenceDirectory)).toEqual([
      expect.objectContaining({ status: "ok", gapMs: 2500, siblingsPresent: true, incomplete: true }),
    ]);
  });

  it("reads with the recorded per-query deadline and pauses for the recorded poll interval", async () => {
    const input = observerHome({ siblings: true });
    const deadlines: number[] = [];
    const pauses: number[] = [];
    const result = await observe(input, {
      clock: [0, 1000, 2000], polls: 2, pauses,
      readRows: async (_path, timeoutMs) => { deadlines.push(timeoutMs); return [acknowledged]; },
    });
    expect(result.incomplete).toBe(false);
    expect(deadlines).toEqual([250, 250]);
    expect(pauses).toEqual([1000, 1000]);
  });

  it("marks a failed read incomplete", async () => {
    const input = observerHome({ siblings: true });
    const result = await observe(input, { clock: [0, 1000], polls: 1, readRows: async () => { throw new Error("read failed"); } });
    expect(result.incomplete).toBe(true);
    expect(records(input.evidenceDirectory)).toEqual([expect.objectContaining({ status: "error", incomplete: true })]);
  });

  it("marks a replaced database file incomplete and stops observing", async () => {
    const input = observerHome({ siblings: true });
    const result = await observe(input, {
      clock: [0, 1000, 2000], polls: 2,
      betweenPolls: () => {
        const replacement = join(input.home, ".lcm", "events", "replacement.tmp");
        writeFileSync(replacement, "");
        renameSync(replacement, input.database);
      },
    });
    expect(result.incomplete).toBe(true);
    expect(records(input.evidenceDirectory).map((record) => [record.status, record.incomplete])).toEqual([["ok", false], ["replaced", true]]);
  });

  // A real events database with the columns the observer worker selects, closed cleanly so
  // SQLite has removed its -wal/-shm siblings.
  function writeEventsDatabase(path: string) {
    const database = new DatabaseSync(path);
    database.exec("PRAGMA journal_mode = WAL");
    database.exec(`CREATE TABLE events (event_id INTEGER PRIMARY KEY, event_uuid TEXT, machine_sequence TEXT, session_id TEXT, type TEXT,
      source_hook TEXT, data TEXT, delivery_state TEXT, remote_inbox_id TEXT, acknowledged_at TEXT, remote_pruned_at TEXT)`);
    database.prepare(`INSERT INTO events (event_uuid, machine_sequence, session_id, type, source_hook, data, delivery_state, remote_inbox_id, acknowledged_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run("e1", "0000000000000000001", "s0", "task_create", "PostToolUse", "row", "acknowledged", "inbox-1", "2026-10-28T00:00:00.000Z");
    database.close();
  }

  // Another connection holding an exclusive lock: a new reader gets SQLITE_BUSY until it closes.
  function holdExclusiveLock(path: string) {
    const holder = new DatabaseSync(path);
    holder.exec("PRAGMA locking_mode = EXCLUSIVE");
    holder.prepare("SELECT count(*) AS count FROM events").get();
    return holder;
  }

  it("completes a poll whose real read waits out a transient lock", async () => {
    const input = observerHome({ siblings: false });
    writeEventsDatabase(input.database);
    const holder = holdExclusiveLock(input.database);
    let releasedAt = Number.POSITIVE_INFINITY;
    let settledAt = Number.NEGATIVE_INFINITY;
    const result = await observe(input, {
      clock: [0, 1000], polls: 1,
      // The production read (worker thread, 250 ms deadline); the lock is released 75 ms
      // after the read starts.
      readRows: async (path, timeoutMs) => {
        const release = new Promise((resolve) => setTimeout(resolve, 75)).then(() => {
          holder.close();
          releasedAt = performance.now();
        });
        try {
          return await readAcknowledgmentRows(path, timeoutMs);
        } finally {
          settledAt = performance.now();
          await release;
        }
      },
    });
    expect(result.incomplete).toBe(false);
    expect(result.observations.get("e1")?.inboxIds).toEqual(["inbox-1"]);
    expect(settledAt).toBeGreaterThan(releasedAt);
    expect(records(input.evidenceDirectory)).toEqual([expect.objectContaining({ status: "ok", incomplete: false })]);
  });

  it("keeps a poll incomplete when the lock outlasts the bounded read", async () => {
    const input = observerHome({ siblings: false });
    writeEventsDatabase(input.database);
    const holder = holdExclusiveLock(input.database);
    let readMs = Number.NaN;
    try {
      const result = await observe(input, {
        clock: [0, 1000], polls: 1,
        readRows: async (path, timeoutMs) => {
          const started = performance.now();
          try {
            return await readAcknowledgmentRows(path, timeoutMs);
          } finally {
            readMs = performance.now() - started;
          }
        },
      });
      expect(result.incomplete).toBe(true);
      expect(records(input.evidenceDirectory)).toEqual([expect.objectContaining({ status: "error", incomplete: true })]);
      // The read waited its 200 ms busy timeout (or hit the 250 ms deadline) and then gave up.
      expect(readMs).toBeGreaterThanOrEqual(200);
      expect(readMs).toBeLessThan(1000);
    } finally {
      holder.close();
    }
  });
});

describe("certification observer read settings", () => {
  const contract = JSON.parse(readFileSync(new URL("./contract-v3.json", import.meta.url), "utf8"));
  const withObserver = (observer: Record<string, unknown>) => ({ ...contract, oracle: { ...contract.oracle, observer: { ...contract.oracle.observer, ...observer } } });

  it("takes the poll, deadline and gap from the contract and the busy timeout from the observer worker", () => {
    expect(observerReadSettings(contract)).toEqual({ pollSeconds: 1, busyTimeoutMs: 200, perQueryDeadlineMs: 250, maxPollGapSeconds: 2 });
    expect(OBSERVER_BUSY_TIMEOUT_MS).toBe(200);
    expect(observerReadSettings(withObserver({ pollSeconds: 3, perQueryDeadlineMs: 900, maxPollGapSeconds: 7 })))
      .toEqual({ pollSeconds: 3, busyTimeoutMs: OBSERVER_BUSY_TIMEOUT_MS, perQueryDeadlineMs: 900, maxPollGapSeconds: 7 });
  });

  it("refuses a missing or non-positive setting and a busy timeout that is not shorter than the deadline", () => {
    expect(() => observerReadSettings({})).toThrow("invalid certification observer read setting pollSeconds");
    expect(() => observerReadSettings(withObserver({ maxPollGapSeconds: undefined }))).toThrow("invalid certification observer read setting maxPollGapSeconds");
    expect(() => observerReadSettings(withObserver({ pollSeconds: 0 }))).toThrow("invalid certification observer read setting pollSeconds");
    expect(() => observerReadSettings(withObserver({ perQueryDeadlineMs: 2.5 }))).toThrow("invalid certification observer read setting perQueryDeadlineMs");
    for (const perQueryDeadlineMs of [OBSERVER_BUSY_TIMEOUT_MS, OBSERVER_BUSY_TIMEOUT_MS - 1]) {
      expect(() => observerReadSettings(withObserver({ perQueryDeadlineMs }))).toThrow("busy timeout must be shorter than its per-query deadline");
    }
  });
});
