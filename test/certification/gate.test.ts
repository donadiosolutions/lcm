import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OBSERVABILITY_GATE_ITEMS, assembleGateFromEvidence, buildEvidenceManifest, createSampleBuilder, forEachNdjsonRow, observabilityGateItems, parseGateArguments, readObserverWitness } from "../../scripts/certification-gate.mjs";
import { captureExecutionHost, captureExecutionProvenance, reconstructObservabilitySummary } from "../../scripts/certification-harness.mjs";
import { CANARY_CORPUS, CONTRACT_CANARIES, createCanaryWorkload } from "./canary-corpus.mjs";
import { createGitCheckoutFixture } from "./git-checkout-fixture.js";
import { runMigrationStep, scanBoundedPrivateOutputs } from "./machine-agent.mjs";
import { buildSecretInventory, createInventoryManifest, scanSurface } from "./observability.mjs";
import { createDeterministicSchedule, createFaultSchedule } from "./schedule.mjs";
import { sampleSha256, writeSampleFile } from "./slo.mjs";
import { observerReadSettings } from "./sqlite-observer-worker.mjs";
import { _resetCircuitBreaker, _setLogPathForTesting, safeLogError } from "../../src/hooks/hook-errors.js";
import { SQLiteLocalHookOutboxFactory } from "../../src/storage/local-hook-outbox.js";
import { RUNTIME_HEALTH_ACTIONS } from "../../src/storage/runtime-health.js";

function writeJson(path: string, value: unknown): void { writeFileSync(path, `${JSON.stringify(value)}\n`); }
function writeNdjson(path: string, values: unknown[]): void { writeFileSync(path, values.map((value) => `${JSON.stringify(value)}\n`).join("")); }
function snapshotFiles(root: string, directory = root, files = new Map<string, Buffer>()): Map<string, Buffer> {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) snapshotFiles(root, path, files);
    else files.set(path.slice(root.length + 1), readFileSync(path));
  }
  return files;
}

type FaultLayout = "faults" | "partition-a" | "none";
type MaintenanceFailure = "compact" | "snapshot" | "mixed";
type Variant = { contractVersion?: 3 | 4; serverPort?: number; providerPort?: number | null; clockRetry?: "recovered" | "exhausted" | "miscounted"; observerRows?: number; withFaults?: boolean; observerGap?: boolean; observerSiblingsPresent?: boolean; extraObserverRow?: Record<string, unknown>; clockBreach?: boolean; clockGap?: boolean; duplicateMapping?: boolean; drainFail?: boolean; capacityPeak?: number; recoveryFail?: boolean; partitionFirstSuccessSeconds?: number; restartBFirstSuccessSeconds?: number; restartBNoSuccess?: boolean; noRecoverySuccess?: boolean; catchUpFail?: boolean; catchUpAtSeconds?: number; missingCatchUpTimestamp?: boolean; readinessInvalid?: boolean; residualOccupied?: boolean; poolConfigMismatch?: boolean; setupSessionOpen?: boolean; phaseEarly?: boolean; profile?: "smoke" | "full"; lane?: "local" | "managed"; faultLayout?: FaultLayout; maintenanceFailure?: MaintenanceFailure; smokeFailure?: boolean; smokeSlow?: boolean; executionHost?: Record<string, unknown>; sharedAddress?: boolean; clientAddress?: string; runtimeConnections?: number; rowCount?: unknown; suppliedTotal?: unknown; closureInconsistent?: boolean; omit?: "closure" | "poolByMachine" | "poolRowB" | "maxConnections" | "reservedConnections" | "clocks" };

type RetainedReceipt = { id: string; secretHits: number; canaryHits: number; categoryHits: Record<string, number> };

// A certification machine's home and its project directory, $HOME/project, created so that
// LCM's hook-error logger sees an existing working directory.
function certificationPaths(): { home: string; project: string } {
  const home = join(mkdtempSync(join(tmpdir(), "lcm-cert-field-scope-")), "home");
  const project = join(home, "project");
  mkdirSync(project, { recursive: true });
  return { home, project };
}

// The bytes that LCM's own hook-error logger, safeLogError, writes to its fallback log when the
// project sidecar fails: each error with a working directory first reaches the sidecar layer, whose
// open is forced to fail, and then the flat-file layer (src/hooks/hook-errors.ts:162-173).
async function productEventsLog(errors: Array<{ hook: string; message: string; cwd?: string }>): Promise<string> {
  const logPath = join(mkdtempSync(join(tmpdir(), "lcm-cert-events-log-")), "events.log");
  const open = vi.spyOn(SQLiteLocalHookOutboxFactory.prototype, "open").mockRejectedValue(new Error("sidecar unavailable"));
  _setLogPathForTesting(logPath);
  try {
    for (const { hook, message, cwd } of errors) {
      _resetCircuitBreaker();
      await safeLogError(hook, new Error(message), { cwd, sessionId: "cert-run" });
    }
    expect(open).toHaveBeenCalledTimes(errors.filter((error) => error.cwd !== undefined).length);
    return readFileSync(logPath, "utf8");
  } finally {
    open.mockRestore();
    _setLogPathForTesting(undefined);
    _resetCircuitBreaker();
  }
}

// A complete v4 privacy evidence set with zero hits on every surface, written by the
// real inventory, scanners and migration receipt writer. `leak` replaces one retained
// CLI output (migration, identity or doctor) with the given text. `coordinator` sets the
// setup bookkeeping and barrier-record bytes, and `fresh` writes the coordinator files so that
// reconstruction scans and persists them instead of reading a persisted scan. `legacyScan`
// persists a scan from before setup-session-closure.json was classified, with that file on disk.
// `logs` writes files into a machine's private LCM log directory before the agent scans it. The
// project and home paths are the certification machines' own, the project under the home;
// `paths` replaces them with existing directories. `witness` rewrites each machine's events.log
// field-scope witness before reconstruction, and returning undefined removes it, as in evidence
// from before the field-scope rule.
async function retainedPrivacyEvidence(
  leak?: { machine: "a" | "b"; id: string; text: string },
  coordinator: {
    bookkeeping?: string; barriers?: string; fresh?: boolean; legacyScan?: boolean; logs?: (machine: "a" | "b") => Record<string, string>;
    paths?: { home: string; project: string }; witness?: (fieldScope: Record<string, any>) => Record<string, any> | undefined;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "lcm-cert-v4-retained-privacy-"));
  const contractBytes = readFileSync(new URL("./contract-v4.json", import.meta.url));
  const contract = JSON.parse(contractBytes.toString("utf8"));
  const contractSha256 = createHash("sha256").update(contractBytes).digest("hex");
  const steadyT0At = "2026-11-05T00:00:00.000Z";
  writeJson(join(root, "run.json"), { profile: "smoke", lane: "local", runId: "run", contractSha256 });
  writeJson(join(root, "phase-control.json"), { steadyT0At, warmupStartAt: steadyT0At });
  const output = (machine: string, id: string) => leak?.machine === machine && leak.id === id ? leak.text : `{"outcome":"ok","id":"${id}"}`;
  const caBodyLines = ["MIIBfixtureCertificateBodyLineOne", "MIIBfixtureCertificateBodyLineTwo"];
  for (const machine of ["a", "b"] as const) {
    const directory = join(root, `machine-${machine}`);
    const home = join(root, `home-${machine}`);
    mkdirSync(directory);
    mkdirSync(home);
    const password = `runtime-password-${machine}-0123`;
    const inventory = buildSecretInventory({
      runtimeUrl: `postgresql://lcm_runtime_${machine}:${password}@database-${machine}.invalid:5432/lcm_cert_${machine}`,
      runtimePassword: password,
      runtimeRole: `lcm_runtime_${machine}`,
      migrationRole: `lcm_migration_${machine}`,
      databaseName: `lcm_cert_${machine}`,
      databaseHost: `database-${machine}.invalid`,
      databaseAddress: machine === "a" ? "10.88.0.11" : "10.88.0.12",
      caPem: `-----BEGIN CERTIFICATE-----\n${caBodyLines.join("\n")}\n-----END CERTIFICATE-----\n`,
      caBodyLines,
      caFile: `/certs/ca-${machine}.pem`,
      daemonToken: `daemon-token-${machine}-0123456789abcdef`,
      projectPath: coordinator.paths?.project ?? "/home/lcm-parent/home/project",
      homePath: coordinator.paths?.home ?? "/home/lcm-parent/home",
      containerHostname: `machine-${machine}-host`,
    });
    const manifest = Buffer.from(`${JSON.stringify(createInventoryManifest(inventory, machine), null, 2)}\n`);
    writeFileSync(join(directory, "secret-inventory-manifest.json"), manifest);
    writeJson(join(directory, "contract-receipt.json"), { version: 4, sha256: contractSha256, inventoryManifestSha256: createHash("sha256").update(manifest).digest("hex") });
    writeFileSync(join(directory, "failure-privacy.ndjson"), "");
    for (const step of ["plan", "apply", "verify", "activate"]) {
      await runMigrationStep({
        args: [step], exec: async () => ({ stdout: output(machine, `migration-${step}`), stderr: "" }),
        setupDeadlineMs: 600_000, now: () => 0, failuresPath: join(directory, "failures.ndjson"), machine, privacyInventory: inventory,
      });
    }
    // The agent records these three receipts inline in this exact shape.
    for (const id of ["identity", "readiness-doctor", "final-doctor"]) {
      const bytes = Buffer.from(output(machine, id));
      appendFileSync(join(directory, "retained-output-privacy.ndjson"), `${JSON.stringify({ id, sha256: createHash("sha256").update(bytes).digest("hex"), ...scanSurface(bytes, inventory, CANARY_CORPUS) })}\n`);
    }
    const daemonOutput = "daemon listening\n";
    for (const [name, content] of Object.entries(coordinator.logs?.(machine) ?? {})) {
      mkdirSync(join(home, ".lcm", "logs"), { recursive: true });
      writeFileSync(join(home, ".lcm", "logs", name), content);
    }
    scanBoundedPrivateOutputs({ home, evidenceDirectory: directory, daemonOutput, inventory });
    if (coordinator.witness !== undefined) {
      const surfacesPath = join(directory, "privacy-surfaces.json");
      const scan = JSON.parse(readFileSync(surfacesPath, "utf8"));
      for (const surface of scan.surfaces.filter((entry: { name: string }) => entry.name === "logs/events.log")) {
        const witness = coordinator.witness(surface.fieldScope);
        if (witness === undefined) delete surface.fieldScope;
        else surface.fieldScope = witness;
      }
      writeFileSync(surfacesPath, `${JSON.stringify(scan)}\n`);
    }
    writeJson(join(directory, "daemon-output-coverage.json"), { totalBytes: daemonOutput.length, scannedBytes: daemonOutput.length, truncated: false, verdict: "pass", secretHits: 0, canaryHits: 0 });
    const workload = createCanaryWorkload("run", machine);
    const counts = { hooks: workload.hooks.length, stores: workload.stores.length, searches: workload.searches.length, utility: 1, cli: workload.cli.length };
    writeJson(join(directory, "canary-witnesses.json"), {
      expected: counts, observed: counts, utilityOutcome: "success",
      cli: workload.cli.map((surface) => ({ id: surface.id, surface: surface.surface, outcome: "success", scan: scanSurface(Buffer.from(`${surface.surface} ok\n`), inventory, CANARY_CORPUS) })),
    });
  }
  const coordinatorInventory = [
    ["admin-url", "postgresql://lcm_admin:admin-password-0123@database.invalid:5432/postgres"],
    ["admin-password", "admin-password-0123"],
    ["admin-role", "lcm_admin"],
    ["transfer-role", "lcm_cert_transfer"],
  ].map(([category, value]) => ({ category, value, sourceClass: "coordinator", scanMode: "all-forms" }));
  writeJson(join(root, "coordinator-inventory-manifest.json"), createInventoryManifest(coordinatorInventory, "coordinator"));
  const coordinatorSurfaces = ["run.json", "faults.json", "calibration-evidence.json", "cleanup.json", "execution-provenance.json",
    "phase-control.json", "setup-evidence.json", "database-readiness.json", "setup-session-closure.json", "observability-barriers.json"];
  const surfaceBytes = (name: string) => Buffer.from(
    coordinator.bookkeeping !== undefined && ["setup-evidence.json", "database-readiness.json", "setup-session-closure.json"].includes(name) ? coordinator.bookkeeping
      : name === "observability-barriers.json" ? coordinator.barriers ?? '[{"step":"canary","verdict":"pass"}]\n'
        : `{"surface":"${name}"}\n`);
  if (coordinator.fresh) {
    writeJson(join(root, "calibration-evidence.json"), { machine: [], database: { verdict: "incomplete" }, statements: { verdict: "incomplete" }, connections: { verdict: "incomplete" } });
    for (const name of coordinatorSurfaces) if (!existsSync(join(root, name))) writeFileSync(join(root, name), surfaceBytes(name));
  } else {
    if (coordinator.legacyScan) writeFileSync(join(root, "setup-session-closure.json"), surfaceBytes("setup-session-closure.json"));
    const persistedSurfaces = coordinatorSurfaces.filter((name) => !(coordinator.legacyScan && name === "setup-session-closure.json"));
    writeJson(join(root, "coordinator-privacy.json"), { surfaces: persistedSurfaces.map((name) => {
      const bytes = surfaceBytes(name);
      return { name, sha256: createHash("sha256").update(bytes).digest("hex"), ...scanSurface(bytes, coordinatorInventory, CANARY_CORPUS) };
    }) });
  }
  const summary = reconstructObservabilitySummary({
    evidenceDirectory: root, contract, contractSha256, runId: "run", faults: [],
    ...(coordinator.fresh ? { persist: true, coordinatorInventory } : { persist: false }),
  });
  const receipt = (machine: "a" | "b", id: string): RetainedReceipt => readFileSync(join(root, `machine-${machine}`, "retained-output-privacy.ndjson"), "utf8")
    .trim().split("\n").map((line) => JSON.parse(line)).find((entry: RetainedReceipt) => entry.id === id);
  const privacy = Object.fromEntries(observabilityGateItems(summary).filter((item) => item.id.startsWith("privacy."))
    .map((item) => [item.id, { verdict: item.verdict, observed: item.observed }]));
  return { privacy, receipt, root, summary };
}

describe("v4 observability gate items", () => {
  it("makes every missing local item incomplete rather than vacuously passing", () => {
    const items = observabilityGateItems(undefined);
    expect(items.map((item) => item.id)).toEqual(OBSERVABILITY_GATE_ITEMS);
    expect(items.every((item) => item.verdict === "incomplete")).toBe(true);
  });

  it("preserves definite failures and fills dropped records as incomplete", () => {
    const items = observabilityGateItems({ items: [
      { id: "telemetry.cardinality", verdict: "fail", threshold: 0, observed: 1 },
      { id: "privacy.canary-leaks", verdict: "pass", threshold: 0, observed: 0 },
    ] });
    expect(items.find((item) => item.id === "telemetry.cardinality")?.verdict).toBe("fail");
    expect(items.find((item) => item.id === "privacy.canary-leaks")?.verdict).toBe("pass");
    expect(items.find((item) => item.id === "probe-completeness")?.verdict).toBe("incomplete");
  });

  it("reconstructs mixed-phase private records instead of trusting a forged summary verdict", () => {
    const root = mkdtempSync(join(tmpdir(), "lcm-cert-v4-reconstruct-"));
    for (const machine of ["a", "b"]) mkdirSync(join(root, `machine-${machine}`));
    const contract = JSON.parse(readFileSync(new URL("./contract-v4.json", import.meta.url), "utf8"));
    const contractSha256 = createHash("sha256").update(readFileSync(new URL("./contract-v4.json", import.meta.url))).digest("hex");
    const steadyT0At = "2026-11-05T00:00:00.000Z";
    writeJson(join(root, "run.json"), { profile: "smoke", lane: "local", runId: "run", contractSha256 });
    writeJson(join(root, "phase-control.json"), { steadyT0At, warmupStartAt: steadyT0At });
    const healthyTelemetry = {
      statements: { status: "observed", observedAt: 1, scope: "aggregate", omitted: {}, operations: [] },
      pool: { status: "observed", observedAt: 1, health: "healthy", omitted: [], remediation: "No action required.", saturationRatio: 0 },
      migration: { status: "observed", observedAt: 1, health: "healthy", omitted: [], remediation: "No action required.", historyStatus: "current", appliedCount: 1, expectedCount: 1 },
      extensions: { status: "observed", observedAt: 1, health: "healthy", omitted: [], remediation: "No action required.", entries: ["pg_stat_statements", "pg_trgm", "pgcrypto", "unaccent"].map((name) => ({ name, status: "current", installedVersion: "1", defaultVersion: "1" })) },
      queue: { status: "observed", observedAt: 1, health: "healthy", omitted: [], remediation: "No action required.", inboxClaimed: 0 },
    };
    const timeout = {
      id: "timeout-a-probe-0", machine: "a", phase: "timeout", sequence: 0,
      runId: "run", contractSha256,
      startedAtMs: 100, completedAtMs: 101, durationMs: 1,
      cardinality: { verdict: "pass" }, snapshot: {
        classification: "timeout", pool: { status: "ready", origin: "daemon", failed: false },
        telemetry: { ...healthyTelemetry,
          migration: { status: "timeout", observedAt: 100, health: "unavailable", omitted: [], remediation: RUNTIME_HEALTH_ACTIONS.unavailable },
          extensions: { status: "timeout", observedAt: 100, health: "unavailable", omitted: [], remediation: "wrong", entries: [] },
          queue: { status: "timeout", observedAt: 100, health: "unavailable", omitted: [], remediation: RUNTIME_HEALTH_ACTIONS.unavailable },
          statements: { status: "timeout", observedAt: 100, scope: "aggregate", omitted: {} },
        },
      },
    };
    const raw = Buffer.from(JSON.stringify({ backendDiagnostics: timeout.snapshot }));
    Object.assign(timeout, { rawSha256: createHash("sha256").update(raw).digest("hex"), rawBytes: raw.length });
    mkdirSync(join(root, "machine-a", "raw-probes"));
    writeFileSync(join(root, "machine-a", "raw-probes", `${timeout.id}.json`), raw);
    writeNdjson(join(root, "machine-a", "probes.ndjson"), [timeout]);
    writeNdjson(join(root, "machine-b", "probes.ndjson"), []);
    writeNdjson(join(root, "machine-a", "samples.ndjson"), []);
    writeNdjson(join(root, "machine-b", "samples.ndjson"), []);
    const fault = { id: "timeout", kind: "timeout", target: "a,b", requestedAt: "2026-11-05T00:00:00.000Z", appliedAt: new Date(100).toISOString(), clearedAt: new Date(200).toISOString(), recoveredAt: new Date(300).toISOString() };
    const reconstructed = reconstructObservabilitySummary({ evidenceDirectory: root, contract, contractSha256, runId: "run", faults: [fault], persist: false });
    expect(observabilityGateItems(reconstructed).find((item) => item.id === "alert.timeout")?.verdict).toBe("fail");
    expect(observabilityGateItems(reconstructed).find((item) => item.id === "probe-completeness")?.verdict).toBe("incomplete");
    const forged = structuredClone(reconstructed);
    forged.items.find((item: { id: string }) => item.id === "alert.timeout").verdict = "pass";
    expect(JSON.stringify(forged)).not.toBe(JSON.stringify(reconstructed));
    const terminal = { ...timeout, id: "timeout-a-probe-1", sequence: 1, startedAtMs: 201, completedAtMs: 202,
      snapshot: { classification: "healthy", pool: { status: "ready", origin: "daemon", failed: false }, telemetry: healthyTelemetry } };
    const terminalRaw = Buffer.from(JSON.stringify({ backendDiagnostics: terminal.snapshot }));
    Object.assign(terminal, { rawSha256: createHash("sha256").update(terminalRaw).digest("hex"), rawBytes: terminalRaw.length });
    writeFileSync(join(root, "machine-a", "raw-probes", `${terminal.id}.json`), terminalRaw);
    writeJson(join(root, "machine-a", "timeout-clearance.json"), { id: terminal.id, completedAtMs: terminal.completedAtMs });
    const extra = { ...terminal, id: "timeout-a-probe-2", sequence: 2, startedAtMs: 203, completedAtMs: 204 };
    const extraRaw = Buffer.from(JSON.stringify({ backendDiagnostics: extra.snapshot }));
    Object.assign(extra, { rawSha256: createHash("sha256").update(extraRaw).digest("hex"), rawBytes: extraRaw.length });
    writeFileSync(join(root, "machine-a", "raw-probes", `${extra.id}.json`), extraRaw);
    writeNdjson(join(root, "machine-a", "probes.ndjson"), [timeout, terminal, extra]);
    const surplus = reconstructObservabilitySummary({ evidenceDirectory: root, contract, contractSha256, runId: "run", faults: [fault], persist: false });
    expect(observabilityGateItems(surplus).find((item) => item.id === "probe-completeness")?.verdict).toBe("fail");
  });

  it("passes both privacy items for complete evidence with clean retained CLI outputs", async () => {
    const clean = await retainedPrivacyEvidence();
    expect(clean.privacy).toEqual({
      "privacy.canary-leaks": { verdict: "pass", observed: 0 },
      "privacy.secret-leaks": { verdict: "pass", observed: 0 },
    });
  });

  it("fails secret leaks when only a retained migration output carries a credential", async () => {
    const secret = await retainedPrivacyEvidence({ machine: "a", id: "migration-apply", text: '{"outcome":"applied","detail":"runtime-password-a-0123"}' });
    expect(secret.receipt("a", "migration-apply")).toMatchObject({ secretHits: 1, canaryHits: 0, categoryHits: expect.objectContaining({ "runtime-password": 1 }) });
    expect(secret.privacy).toEqual({
      "privacy.canary-leaks": { verdict: "pass", observed: 0 },
      "privacy.secret-leaks": { verdict: "fail", observed: 1 },
    });
  });

  it("fails canary leaks when only a retained doctor output carries a canary", async () => {
    const canary = await retainedPrivacyEvidence({ machine: "b", id: "final-doctor", text: `doctor note: ${CONTRACT_CANARIES.memory}\n` });
    const receipt = canary.receipt("b", "final-doctor");
    expect(receipt).toMatchObject({ secretHits: 0 });
    expect(receipt.canaryHits).toBeGreaterThan(0);
    expect(canary.privacy).toEqual({
      "privacy.canary-leaks": { verdict: "fail", observed: receipt.canaryHits },
      "privacy.secret-leaks": { verdict: "pass", observed: 0 },
    });
  });

  // Smoke 4: setup-evidence.json and database-readiness.json list the transfer role by design
  // (the setup-closure witness) and failed privacy.secret-leaks with 4 hits; setup-session-closure.json
  // holds the same witness. The coordinator hashes the three for provenance and scans only its run
  // records, exactly the lists that the v4 DRAFT binds. Smoke 4's persisted scan predates the
  // third file, so reconstruction hashes it from disk.
  it("hashes the coordinator's setup bookkeeping for provenance and scans only its run records", async () => {
    const bookkeeping = '{"setupRoles":{"transfer":"lcm_cert_transfer"}}\n';
    const scope = JSON.parse(readFileSync(new URL("./contract-v4.json", import.meta.url), "utf8")).observability.privacy;
    const persisted = await retainedPrivacyEvidence(undefined, { bookkeeping });
    const legacy = await retainedPrivacyEvidence(undefined, { bookkeeping, legacyScan: true });
    const fresh = await retainedPrivacyEvidence(undefined, { bookkeeping, fresh: true });
    const written = JSON.parse(readFileSync(join(fresh.root, "coordinator-privacy.json"), "utf8"));
    const bookkeepingSha256 = createHash("sha256").update(bookkeeping).digest("hex");
    expect({
      scope: [scope.coordinatorLeakSurfaces, scope.coordinatorProvenanceOnly],
      persisted: persisted.privacy["privacy.secret-leaks"],
      legacy: legacy.privacy["privacy.secret-leaks"],
      fresh: fresh.privacy["privacy.secret-leaks"],
      surfaces: written.surfaces.map((entry: { name: string }) => entry.name),
      provenance: written.provenance,
    }).toEqual({
      scope: [
        ["run.json", "faults.json", "calibration-evidence.json", "cleanup.json", "execution-provenance.json", "phase-control.json", "observability-barriers.json"],
        ["setup-evidence.json", "database-readiness.json", "setup-session-closure.json"],
      ],
      persisted: { verdict: "pass", observed: 0 },
      legacy: { verdict: "pass", observed: 0 },
      fresh: { verdict: "pass", observed: 0 },
      surfaces: scope.coordinatorLeakSurfaces,
      provenance: scope.coordinatorProvenanceOnly.map((name: string) => ({ name, sha256: bookkeepingSha256 })),
    });
    const leaked = await retainedPrivacyEvidence(undefined, { bookkeeping, barriers: '[{"step":"canary","verdict":"pass","note":"lcm_cert_transfer"}]\n', fresh: true });
    expect(leaked.privacy["privacy.secret-leaks"].verdict).toBe("fail");
  });

  // The summary's only evidence-derived text is the contract digest. Planted as a coordinator
  // credential, it stops reconstruction before the summary is written.
  it("still scans the observability summary against the coordinator inventory", async () => {
    const clean = await retainedPrivacyEvidence();
    const contractBytes = readFileSync(new URL("./contract-v4.json", import.meta.url));
    const contractSha256 = createHash("sha256").update(contractBytes).digest("hex");
    expect(() => reconstructObservabilitySummary({
      evidenceDirectory: clean.root, contract: JSON.parse(contractBytes.toString("utf8")), contractSha256, runId: "run", faults: [], persist: true,
      coordinatorInventory: [{ category: "admin-password", value: contractSha256, sourceClass: "coordinator", scanMode: "all-forms" }],
    })).toThrow("public observability summary contains a coordinator identity or credential");
    expect(existsSync(join(clean.root, "observability-summary.json"))).toBe(false);
  });

  // Smoke 5: each machine's events.log, LCM's hook-error fallback log, recorded the hook's
  // working directory $HOME/project in each line's cwd field. The v4 contract allows the
  // project-path and home-path categories on that surface only, in that field, and counts them
  // separately; credentials and canaries there still leak. Each line is the product's own, and
  // its cwd matches project-path 2 (the path and its 24-character prefix) and home-path 2 (the
  // home path and the same prefix) on each machine.
  it("allows the fallback log's path categories, counts them separately and still fails other hits", async () => {
    const paths = certificationPaths();
    const log = (hook: string, message: string) => productEventsLog([{ hook, message, cwd: paths.project }]);
    const smoke5Log = await log("UserPromptSubmit", "backend publication mutation is already in progress");
    const credentialLogs = { a: await log("PostToolUse", "rejected runtime-password-a-0123"), b: await log("PostToolUse", "rejected daemon-token-b-0123456789abcdef") };
    const canaryLog = await log("PostToolUse", `stored ${CONTRACT_CANARIES.memory}`);
    const smoke5 = await retainedPrivacyEvidence(undefined, { paths, logs: () => ({ "events.log": smoke5Log }) });
    const credentials = await retainedPrivacyEvidence(undefined, { paths, logs: (machine) => ({ "events.log": credentialLogs[machine] }) });
    const canary = await retainedPrivacyEvidence(undefined, { paths, logs: () => ({ "events.log": canaryLog }) });
    const otherLog = await retainedPrivacyEvidence(undefined, { paths, logs: () => ({ "daemon.log": smoke5Log }) });
    const otherSurface = await retainedPrivacyEvidence({ machine: "a", id: "migration-apply", text: JSON.stringify({ outcome: "applied", cwd: paths.project }) }, { paths });
    const shape = (evidence: { privacy: Record<string, { verdict: string; observed: number }>; summary: any }) => [
      evidence.privacy["privacy.secret-leaks"], evidence.privacy["privacy.canary-leaks"].verdict, evidence.summary.privateArtifacts.allowedSurfaceHits,
    ];
    const allowed = { "logs/events.log": { "project-path": 4, "home-path": 4 } };
    expect({
      smoke5: shape(smoke5), credentials: shape(credentials), canary: shape(canary), otherLog: shape(otherLog), otherSurface: shape(otherSurface),
    }).toEqual({
      smoke5: [{ verdict: "pass", observed: 0 }, "pass", allowed],
      // runtime-password 1 on machine A; daemon-token 2 on machine B (the token and its prefix).
      credentials: [{ verdict: "fail", observed: 3 }, "pass", allowed],
      canary: [{ verdict: "pass", observed: 0 }, "fail", allowed],
      otherLog: [{ verdict: "fail", observed: 8 }, "pass", {}],
      otherSurface: [{ verdict: "fail", observed: 4 }, "pass", {}],
    });
  });

  // Round 11: the file-wide allowance subtracted every path hit in the log, so a path in a line's
  // error text passed. The allowance now covers only the top-level cwd field, proven per surface by
  // the agent's field-scope witness. The lines are the product's own: its sanitizer turns a raw
  // path in the error into <path> and redacts URL query values, but the percent-encoded path and
  // its 24-character prefix survive verbatim. The truncated and duplicate-key lines are a product
  // line cut short or given a second cwd key. Per machine, a cwd-only line holds 2 hits of each
  // path category, and an encoded path in the error adds 2 more of each (1 for its prefix alone).
  it("allows the two path categories only in the fallback log's cwd field, from a valid witness", async () => {
    const paths = certificationPaths();
    const encoded = encodeURIComponent(paths.project);
    const log = (message: string) => productEventsLog([{ hook: "PostToolUse", message, cwd: paths.project }]);
    const cwdOnly = await log("backend publication mutation is already in progress");
    const inError = await log(`publication fence rejected ${encoded}`);
    const prefixInError = await log(`publication fence rejected ${encoded.slice(0, 24)}`);
    const withoutCwd = await productEventsLog([{ hook: "UserPromptSubmit", message: "backend publication mutation is already in progress" }]);
    const truncated = `${cwdOnly.trimEnd().slice(0, -2)}\n`;
    const duplicate = cwdOnly.replace("{", `{"cwd":${JSON.stringify(paths.project)},`);
    expect([cwdOnly, inError, prefixInError].map((bytes) => JSON.parse(bytes))).toMatchObject([
      { hook: "PostToolUse", error: "backend publication mutation is already in progress", session_id: "cert-run", cwd: paths.project },
      { error: `publication fence rejected ${encoded}`, cwd: paths.project },
      { error: `publication fence rejected ${encoded.slice(0, 24)}`, cwd: paths.project },
    ]);
    const evidence = (bytes: string, witness?: (fieldScope: Record<string, any>) => Record<string, any> | undefined) =>
      retainedPrivacyEvidence(undefined, { paths, logs: () => ({ "events.log": bytes }), ...(witness === undefined ? {} : { witness }) });
    const cases = {
      cwdOnly: await evidence(cwdOnly),
      inError: await evidence(inError),
      prefixInError: await evidence(prefixInError),
      truncated: await evidence(truncated),
      duplicate: await evidence(duplicate),
      mixed: await evidence(cwdOnly + withoutCwd + truncated + duplicate),
      legacy: await evidence(cwdOnly, () => undefined),
      wrongRule: await evidence(cwdOnly, (scope) => ({ ...scope, rule: "events-log-top-level-cwd-v0" })),
      unaccounted: await evidence(cwdOnly, (scope) => ({ ...scope, lines: { total: 1, parsed: 1, cwdStripped: 1, rawKept: 1 } })),
    };
    const hits = (count: number) => ({ "project-path": count, "home-path": count });
    const valid = { valid: 2, missing: 0, invalid: 0 };
    const invalid = { valid: 0, missing: 0, invalid: 2 };
    expect(Object.fromEntries(Object.entries(cases).map(([name, { privacy, summary }]) => [name, [
      privacy["privacy.secret-leaks"], summary.privateArtifacts.allowedSurfaceHits, summary.privateArtifacts.fieldScopeWitnesses?.["logs/events.log"],
    ]]))).toEqual({
      cwdOnly: [{ verdict: "pass", observed: 0 }, { "logs/events.log": hits(4) }, valid],
      inError: [{ verdict: "fail", observed: 8 }, { "logs/events.log": hits(4) }, valid],
      prefixInError: [{ verdict: "fail", observed: 4 }, { "logs/events.log": hits(4) }, valid],
      truncated: [{ verdict: "fail", observed: 8 }, {}, valid],
      duplicate: [{ verdict: "fail", observed: 8 }, {}, valid],
      mixed: [{ verdict: "fail", observed: 8 }, {}, valid],
      legacy: [{ verdict: "incomplete", observed: 8 }, {}, { valid: 0, missing: 2, invalid: 0 }],
      wrongRule: [{ verdict: "incomplete", observed: 8 }, {}, invalid],
      unaccounted: [{ verdict: "incomplete", observed: 8 }, {}, invalid],
    });
    const witness = (root: string) => JSON.parse(readFileSync(join(root, "machine-a", "privacy-surfaces.json"), "utf8"))
      .surfaces.find((surface: { name: string }) => surface.name === "logs/events.log").fieldScope;
    const scope = { rule: "events-log-top-level-cwd-v1", field: "cwd", categories: ["project-path", "home-path"] };
    expect([witness(cases.cwdOnly.root), witness(cases.mixed.root)]).toEqual([
      { ...scope, rawCategoryHits: hits(2), residualCategoryHits: hits(0), lines: { total: 1, parsed: 1, cwdStripped: 1, rawKept: 0 } },
      { ...scope, rawCategoryHits: hits(2), residualCategoryHits: hits(2), lines: { total: 4, parsed: 3, cwdStripped: 1, rawKept: 3 } },
    ]);
  });
});

// Every scheduled compact, every scheduled snapshot, or every other one of each.
function maintenanceFails(mode: MaintenanceFailure | undefined, op: string, index: number): boolean {
  if (mode === undefined || (op !== "compact" && op !== "snapshot")) return false;
  if (mode === "mixed") return op === "compact" ? index % 2 === 0 : index % 2 === 1;
  return op === mode;
}

// Mirrors the real producers: local full writes faults.json with both faults,
// managed full writes only fault-partition-a.json, and smoke writes no fault file.
function rawFixture(options: Variant = {}) {
  const root = mkdtempSync(join(tmpdir(), "lcm-cert-raw-gate-"));
  const output = join(mkdtempSync(join(tmpdir(), "lcm-cert-raw-gate-output-")), "gate");
  const contract = JSON.parse(readFileSync(new URL(options.contractVersion === 4 ? "./contract-v4.json" : "./contract-v3.json", import.meta.url), "utf8"));
  const contractText = `${JSON.stringify(contract)}\n`;
  const contractPath = join(root, "contract.json");
  writeFileSync(contractPath, contractText);
  const contractSha256 = createHash("sha256").update(contractText).digest("hex");
  const approval = {
    contractSha256,
    approvedBy: "maintainer",
    approvedAt: "2026-10-26T10:00:00.000Z",
    note: "recorded",
    approvalRef: "issue-629",
  };
  const approvalText = `${JSON.stringify(approval)}\n`;
  writeFileSync(join(root, "contract.approval.json"), approvalText);
  const approvalSha256 = createHash("sha256").update(approvalText).digest("hex");
  const executionHost = {
    capturedAt: "2026-10-26T10:00:59.000Z", osId: "ubuntu", osVersionId: "24.04", kernelRelease: "6.8.0-45-generic", architecture: "x64",
    cpuModel: "AMD EPYC 9R14", logicalCpus: 8, totalMemoryBytes: 33_000_000_000, containerEngine: "podman", containerEngineVersion: "5.2.3",
    hostnameSha256: "7".repeat(64), runnerName: "blacksmith-8vcpu-ubuntu-2404", runnerOs: "Linux", runnerArch: "X64", runnerSku: "blacksmith-8vcpu-ubuntu-2404",
    ...(options.executionHost ?? {}),
  };
  const provenance = {
    testedCommit: "c".repeat(40), dirty: false, testedInputsSha256: "d".repeat(64), testedInputsCount: 100,
    lockfileSha256: "e".repeat(64), cliSha256: "f".repeat(64), stagedPackageSha256: "1".repeat(64),
    contractSha256, approvalSha256, node: process.version, executionHost, observerSettings: observerReadSettings(contract),
  };
  const profile = options.profile ?? "full";
  const lane = options.lane ?? "local";
  const faultLayout: FaultLayout = options.faultLayout ?? (profile === "full" ? (lane === "managed" ? "partition-a" : "faults") : "none");
  const runtimeRole = lane === "local" ? "lcm_test_runtime" : "lcm_cert_runtime_run12345";
  const t0 = Date.parse("2026-10-26T10:10:00.000Z");
  writeJson(join(root, "run.json"), { lane, profile, ...(options.withFaults ? { withFaults: true } : {}), runId: "run12345", contractSha256, ...(contract.version === 4 ? { contractVersion: 4 } : {}), approval, approvalSha256, startedAt: "2026-10-26T10:01:00.000Z" });
  writeJson(join(root, "phase-control.json"), { warmupStartAt: options.phaseEarly ? "2026-10-26T10:09:00.000Z" : "2026-10-26T10:08:00.000Z", steadyT0At: new Date(t0).toISOString() });
  writeJson(join(root, "execution-provenance.json"), provenance);
  writeJson(join(root, "machine-identities.json"), {
    a: { machineId: "018f0000-0000-7000-8000-000000000001", identityKeySha256: "a".repeat(64) },
    b: { machineId: "018f0000-0000-7000-8000-000000000002", identityKeySha256: "b".repeat(64) },
  });
  const preActivationResidual = {
    observedAt: "2026-10-26T10:00:30.000Z",
    residual: { machines: options.residualOccupied ? 1 : 0, projects: 0, conversations: 0, passive_events: 0 },
    residualEmpty: !options.residualOccupied,
  };
  const setupSessionClosure = {
    observedAt: "2026-10-26T10:10:00.000Z",
    roles: { migrator: options.setupSessionOpen ? 1 : 0, transfer: 0 },
    totalConnections: options.setupSessionOpen ? 1 : 0,
    setupSessionsClosed: !options.setupSessionOpen,
  };
  writeJson(join(root, "pre-activation-residual.json"), preActivationResidual);
  if (options.omit !== "closure") writeJson(join(root, "setup-session-closure.json"), options.closureInconsistent ? { ...setupSessionClosure, observedAt: "2026-10-26T10:10:01.000Z" } : setupSessionClosure);
  writeJson(join(root, "database-readiness.json"), {
    serverVersionNum: options.readinessInvalid ? 170006 : 180004, serverPort: options.serverPort ?? (lane === "local" ? 5432 : 25060),
    ...(lane === "managed" && options.providerPort !== null ? { providerPort: options.providerPort ?? 25060 } : {}),
    databaseName: lane === "local" ? "lcm_harness_run12345" : "lcm_cert_run12345", roleName: runtimeRole,
    role: { superuser: false, createRole: false, createDb: false }, residualEmpty: false,
    ...(options.omit === "maxConnections" ? {} : { maxConnections: 100 }), ...(options.omit === "reservedConnections" ? {} : { reservedConnections: 3 }),
    configuredPoolMax: options.poolConfigMismatch ? undefined : 2,
    ...(options.omit === "poolByMachine" ? {} : { poolByMachine: {
      a: { observedAt: "2026-10-26T10:09:00.000Z", configuredMax: 2 },
      ...(options.omit === "poolRowB" ? {} : { b: { observedAt: "2026-10-26T10:10:00.000Z", configuredMax: options.poolConfigMismatch ? 3 : 2 } }),
    } }),
    setupSessionsClosed: !options.setupSessionOpen, setupSessionClosure,
    extensions: ["pg_stat_statements", "pg_trgm", "pgcrypto", "unaccent"].map((name) => ({ name, schema: "public" })),
    migrations: 9, expectedMigrations: 9, systemIdentifier: "123456789",
  });
  writeJson(join(root, "cleanup.json"), {
    verdict: "pass", residualResources: 0, labeledContainers: 0, labeledNetworks: 0,
    labeledVolumes: 0, familyTaggedProviderClusters: 0, privateRootsAbsent: true,
    ownedProcessesExited: true, providerDestroyConfirmedWithinSeconds: 0,
  });
  writeJson(join(root, "database-growth.json"), { beforeBytes: 1000, afterBytes: 2000, deltaBytes: 1000 });
  const clockDurationMinutes = Math.floor(contract.timeline[profile].steadySeconds / 60);
  const clocks: Array<Record<string, any>> = Array.from({ length: clockDurationMinutes + 1 }, (_, minute) => ["a", "b"].map((machine) => {
    const index = minute * 2 + (machine === "b" ? 1 : 0);
    const wallMs = t0 + minute * 60_000;
    return {
      phase: minute === 0 ? "start" : minute === clockDurationMinutes ? "end" : "interval",
      machine, radiusMs: options.clockBreach && index === 0 ? 300 : 10,
      verdict: options.clockBreach && index === 0 ? "fail" : "pass",
      t0: { wallMs, monotonicNs: String(1_000_000_000n + BigInt(minute) * 60_000_000_000n) },
      serverTime: new Date(wallMs + 10).toISOString(),
      t1: { wallMs: wallMs + (options.clockBreach && index === 0 ? 600 : 20), monotonicNs: String(1_020_000_000n + BigInt(minute) * 60_000_000_000n) },
      databaseConnections: options.suppliedTotal !== undefined ? options.suppliedTotal : options.runtimeConnections ?? (index === 0 ? options.capacityPeak ?? 8 : 8),
      connections: [{
        role_name: runtimeRole,
        client_address: options.clientAddress ?? (options.sharedAddress ? "192.0.2.10" : machine === "a" ? "10.0.0.2" : "10.0.0.3"),
        connections: options.rowCount !== undefined ? options.rowCount : options.runtimeConnections ?? (index === 0 ? options.capacityPeak ?? 8 : 8),
      }],
    };
  })).flat();
  if (options.clockGap) {
    const row = clocks.find((entry) => entry.machine === "a" && entry.phase === "interval");
    if (row) row.t0.monotonicNs = String(1_000_000_000n + 180_000_000_000n);
  }
  // One interval sample of machine A that the monitor retried: it succeeded 1.4 s late on
  // its third attempt, all five attempts failed, or its attempt number disagrees with the
  // failed attempts it records.
  if (options.clockRetry) {
    const index = clocks.findIndex((entry) => entry.machine === "a" && entry.phase === "interval");
    const row = clocks[index];
    const failed = (attempt: number) => ({
      attempt, errorClass: "Error", code: "ECONNREFUSED",
      startedAtMs: row.t0.wallMs + (attempt - 1) * 700, failedAtMs: row.t0.wallMs + (attempt - 1) * 700 + 200,
    });
    clocks[index] = options.clockRetry === "exhausted"
      ? { phase: "interval", machine: "a", verdict: "incomplete", ...failed(5), failedAttempts: [1, 2, 3, 4].map(failed) }
      : {
        ...row,
        t0: { wallMs: row.t0.wallMs + 1_400, monotonicNs: String(BigInt(row.t0.monotonicNs) + 1_400_000_000n) },
        serverTime: new Date(row.t0.wallMs + 1_410).toISOString(),
        t1: { wallMs: row.t1.wallMs + 1_400, monotonicNs: String(BigInt(row.t1.monotonicNs) + 1_400_000_000n) },
        attempt: 3,
        failedAttempts: (options.clockRetry === "miscounted" ? [1] : [1, 2]).map(failed),
      };
  }
  writeJson(join(root, "clock-witness.json"), options.omit === "clocks" ? [] : clocks);
  const partitionApplied = t0 + 6_060_000;
  const partitionCleared = partitionApplied + 60_500;
  const restartApplied = partitionApplied + 400_000;
  const restartCleared = restartApplied + 60_000;
  const partitionFault = { id: "partition-a", kind: "partition-machine", target: "a", requestedAt: new Date(partitionApplied - 10).toISOString(), appliedAt: new Date(partitionApplied).toISOString(), clearedAt: new Date(partitionCleared).toISOString(), recoveredAt: new Date(partitionCleared + 90_000).toISOString() };
  const restartFault = { id: "restart-database", kind: "restart-database", target: "database", requestedAt: new Date(restartApplied - 10).toISOString(), appliedAt: new Date(restartApplied).toISOString(), clearedAt: new Date(restartCleared).toISOString(), recoveredAt: new Date(restartCleared + 90_000).toISOString() };
  if (faultLayout === "faults") writeFileSync(join(root, "faults.json"), `${JSON.stringify([partitionFault, restartFault], null, 2)}\n`);
  if (faultLayout === "partition-a") writeFileSync(join(root, "fault-partition-a.json"), `${JSON.stringify(partitionFault, null, 2)}\n`);
  for (const machine of ["a", "b"] as const) {
    const directory = join(root, `machine-${machine}`);
    mkdirSync(directory);
    writeJson(join(directory, "warmup-complete.json"), { machine, at: new Date(t0 - 1_000).toISOString() });
    const steady = createDeterministicSchedule({ profile, machine, runId: "run12345", contract }).map((entry) => ({
      ...entry, phase: "steady", scheduledWallMs: t0 + entry.offsetSeconds * 1000,
      wallEndedAt: new Date(t0 + entry.offsetSeconds * 1000 + 10).toISOString(), durationMs: options.smokeSlow && entry.op === "search" ? 10_000 : 10,
      outcome: (options.smokeFailure && entry.op === "search" && entry.index === 0) || maintenanceFails(options.maintenanceFailure, entry.op, entry.index) ? "failed" : "success",
      ...(maintenanceFails(options.maintenanceFailure, entry.op, entry.index) ? { errorClass: "CliExit", exitCode: 1 } : {}),
      processExitNs: String(BigInt(1_000_000_000 + entry.index * 10_000_000)),
    }));
    const partition = (faultLayout !== "none" ? createFaultSchedule({ machine, runId: "run12345", phase: "partition-recovery", durationSeconds: 180 }) : []).map((entry) => ({
      ...entry, scheduledWallMs: partitionApplied + entry.offsetSeconds * 1000,
      wallEndedAt: new Date(partitionApplied + entry.offsetSeconds * 1000 + 10).toISOString(), durationMs: 10,
      outcome: options.recoveryFail && machine === "a" || options.partitionFirstSuccessSeconds !== undefined && machine === "a"
        && partitionApplied + entry.offsetSeconds * 1000 + 10 < partitionCleared + options.partitionFirstSuccessSeconds * 1000 ? "failed" : "success",
    }));
    const restart = (faultLayout === "faults" ? createFaultSchedule({ machine, runId: "run12345", phase: "restart-recovery", durationSeconds: 240 }) : []).map((entry) => ({
      ...entry, scheduledWallMs: restartApplied + entry.offsetSeconds * 1000,
      wallEndedAt: new Date(restartApplied + entry.offsetSeconds * 1000 + 10).toISOString(), durationMs: 10, outcome: "success",
    }));
    for (const entry of restart) {
      if (machine === "b" && options.restartBNoSuccess) entry.outcome = "failed";
      if (machine === "b" && options.restartBFirstSuccessSeconds !== undefined
        && Date.parse(entry.wallEndedAt) < restartCleared + options.restartBFirstSuccessSeconds * 1000) entry.outcome = "failed";
      if (machine === "a" && options.noRecoverySuccess) entry.outcome = "failed";
    }
    if (machine === "a" && options.noRecoverySuccess) for (const entry of partition) entry.outcome = "failed";
    const samples = [...steady, ...partition, ...restart];
    writeNdjson(join(directory, "samples.ndjson"), samples);
    const hookSamples = steady.filter((entry) => entry.op === "hook");
    const ledger = hookSamples.flatMap((entry, index) => [
      { invocationId: entry.id, kind: entry.kind, sessionId: entry.sessionId, expectedCount: 1 },
      { invocationId: entry.id, eventUuid: options.duplicateMapping && index === 1 ? `${machine}-event-0` : `${machine}-event-${index}`, machineSequence: String(index).padStart(19, "0") },
    ]);
    writeNdjson(join(directory, "invocations.ndjson"), ledger);
    const acknowledgments = Object.fromEntries(hookSamples.map((entry, index) => [
      `${machine}-event-${index}`,
      { firstSeenMonotonicNs: String(BigInt(entry.processExitNs) + 1_000_000_000n), inboxIds: [`inbox-${machine}-${index}`] },
    ]));
    writeNdjson(join(directory, "acknowledgments.ndjson"), [acknowledgments]);
    // A long observer file carries the cumulative acknowledgment map in every poll, as
    // the real observer does.
    writeNdjson(join(directory, "observer.ndjson"), options.observerRows === undefined ? [
      { status: "ok", gapMs: options.observerGap ? 3000 : 1000, incomplete: false, siblingsPresent: options.observerSiblingsPresent ?? true },
      ...(options.extraObserverRow ? [{ gapMs: 1000, ...options.extraObserverRow }] : []),
    ] : Array.from({ length: options.observerRows }, (_, poll) => ({
      monotonicMs: 1_000 * (poll + 1) + 0.25, gapMs: 1000.5, status: "ok", siblingsPresent: poll % 3 !== 0, incomplete: false,
      acknowledgments: Object.fromEntries(Array.from({ length: Math.floor(poll / 4) }, (_, event) => [
        `${machine}-event-${event}`, { firstSeenMonotonicNs: String(1_000_000_000 + event), inboxIds: [String(event + 1)] },
      ])),
    })));
    writeJson(join(directory, "readiness.json"), { tls: { wrongCa: "certificate-authority", wrongHostname: "certificate-name" } });
    writeJson(join(directory, "partition-catch-up.json"), options.missingCatchUpTimestamp && machine === "a"
      ? { phase: "partition", verdict: "incomplete", seconds: 0, remaining: 0, clearedAt: new Date(partitionCleared).toISOString() }
      : options.catchUpFail && machine === "a"
      ? { phase: "partition", verdict: "fail", seconds: 900, remaining: 1, clearedAt: new Date(partitionCleared).toISOString(), observedAt: new Date(partitionCleared + 900_000).toISOString() }
      : { phase: "partition", verdict: "pass", seconds: options.catchUpAtSeconds ?? 10, remaining: 0, clearedAt: new Date(partitionCleared).toISOString(), observedAt: new Date(partitionCleared + (options.catchUpAtSeconds ?? 10) * 1000).toISOString() });
    writeJson(join(directory, "restart-catch-up.json"), { phase: "restart", verdict: "pass", seconds: 10, remaining: 0, clearedAt: new Date(restartCleared).toISOString(), observedAt: new Date(restartCleared + 10_000).toISOString() });
    writeJson(join(directory, "final-diagnostics.json"), { doctorSha256: "a".repeat(64), doctor: "sweep complete", sweepTimestamps: ["2026-10-26T12:00:00.000Z"] });
    writeJson(join(directory, "drain.json"), options.drainFail
      ? { verdict: "fail", expectedEvents: 600, acknowledged: 599, remotePruned: 599, nonterminal: 1, awaitingRemotePrune: 1 }
      : { verdict: "pass", expectedEvents: 600, acknowledged: 600, remotePruned: 600, nonterminal: 0, awaitingRemotePrune: 0 });
  }
  const current = { ...provenance } as Record<string, unknown>;
  delete current.stagedPackageSha256;
  delete current.contractSha256;
  delete current.observerSettings;
  // The assembling host is a different machine in general: its witness must not be
  // compared against the recorded one.
  current.executionHost = { ...executionHost, hostnameSha256: "8".repeat(64), capturedAt: "2026-10-27T00:00:00.000Z", runnerSku: null };
  return { root, output, contractPath, contractSha256, provenance: current, faults: faultLayout === "faults" ? [partitionFault, restartFault] : faultLayout === "partition-a" ? [partitionFault] : [] };
}

function assemble(fixture: ReturnType<typeof rawFixture>) {
  return assembleGateFromEvidence({
    repositoryRoot: new URL("../..", import.meta.url).pathname,
    evidenceDirectory: fixture.root,
    contractPath: fixture.contractPath,
    outputDirectory: fixture.output,
  }, { captureProvenance: () => fixture.provenance });
}

// Smoke evidence whose recorded code provenance matches a throwaway Git checkout, so
// the gate's real readback (no injected captureProvenance) runs end to end without
// the repository's build output.
function realReadbackInput(executionHost: Record<string, unknown>) {
  const checkout = createGitCheckoutFixture();
  const fixture = rawFixture({ profile: "smoke", executionHost });
  const path = join(fixture.root, "execution-provenance.json");
  const recorded = JSON.parse(readFileSync(path, "utf8"));
  writeJson(path, captureExecutionProvenance(checkout.root, recorded.contractSha256, recorded.stagedPackageSha256, recorded.approvalSha256, {
    executionHost: recorded.executionHost, contract: JSON.parse(readFileSync(fixture.contractPath, "utf8")),
  }));
  return { repositoryRoot: checkout.root, evidenceDirectory: fixture.root, contractPath: fixture.contractPath, outputDirectory: fixture.output };
}

describe("certification raw evidence pipeline", () => {
  it("rebuilds the exact gate from raw evidence and ignores supplied verdicts", () => {
    const fixture = rawFixture();
    writeJson(join(fixture.root, "evidence-manifest.json"), { slos: [{ id: "forged", verdict: "pass" }] });
    const result = assemble(fixture);
    expect(result.gate.verdict).toBe("pass");
    expect(result.gate.contract).toMatchObject({
      sha256: fixture.contractSha256,
      status: "approved",
      approval: { contractSha256: fixture.contractSha256 },
    });
    expect(result.gate.slos.some((slo: any) => slo.id === "forged")).toBe(false);
    expect(JSON.parse(readFileSync(result.paths.json, "utf8"))).toEqual(result.gate);
  });

  it("reproduces the historical v3 gate bytes for the frozen evidence fixture", () => {
    const result = assemble(rawFixture());
    expect({
      json: createHash("sha256").update(readFileSync(result.paths.json)).digest("hex"),
      markdown: createHash("sha256").update(readFileSync(result.paths.markdown)).digest("hex"),
    }).toEqual({
      // #1888 replaced the capacity formula, the only change in these bytes since 6ba9b71a.
      json: "1f97b6bb9cdedd7333faa2c8e6eb8555649b546f6ce7425802e6c6b775f0ed98",
      markdown: "eebc5bbaf2d108532387877190658a022d76ae97437cd42fb7c043e669b7b9e1",
    });
  });

  it("real gate assembly rejects a forged v4 observability summary", () => {
    const fixture = rawFixture({ contractVersion: 4, profile: "smoke", withFaults: true });
    writeJson(join(fixture.root, "observability-summary.json"), {
      schemaVersion: 1,
      contract: { version: 4, sha256: fixture.contractSha256 },
      run: { sha256: "0".repeat(64) }, applicability: { applicable: true, reason: null },
      items: [{ id: "alert.timeout", formula: "forged", threshold: 1, observed: 1, verdict: "pass" }],
      privateArtifacts: { rawProbeBodies: 0, probeRecords: 0, canarySurfaces: 0, secretCategories: 0, retentionDays: 90, directoryMode: "0700", fileMode: "0600" },
    });
    const result = assemble(fixture);
    expect(result.publicationRefused).toBe(true);
    expect(result.gate.slos.find((slo: { id: string }) => slo.id === "observability-summary-binding")?.verdict).toBe("fail");
    expect(result.diagnostic).toContain("private.json");
  });

  // Excluding the setup bookkeeping from the coordinator leak surfaces leaves the public gate
  // outputs scanned against the coordinator inventory: a coordinator role carried into the gate,
  // here through the recorded execution-host witness, refuses publication.
  it("still scans the public gate outputs against the coordinator inventory", () => {
    const publish = (cpuModel: string) => {
      const fixture = rawFixture({ contractVersion: 4, profile: "smoke", withFaults: true, executionHost: { cpuModel } });
      for (const machine of ["a", "b"]) {
        mkdirSync(join(fixture.root, `machine-${machine}`), { recursive: true });
        writeJson(join(fixture.root, `machine-${machine}`, "secret-inventory-manifest.json"), createInventoryManifest(
          [{ category: "runtime-role", value: `lcm_runtime_${machine}`, sourceClass: "machine", scanMode: "all-forms" }], machine));
      }
      writeJson(join(fixture.root, "coordinator-inventory-manifest.json"), createInventoryManifest(
        [{ category: "transfer-role", value: "lcm_cert_transfer", sourceClass: "coordinator", scanMode: "all-forms" }], "coordinator"));
      return () => assemble(fixture);
    };
    expect(publish("AMD EPYC 9R14")().paths?.json).toMatch(/observability-certification-gate\.json$/u);
    expect(publish("lcm_cert_transfer")).toThrow("certification public json contains a private identity, credential, or canary");
  });

  it("uses the separate pre-activation empty witness instead of post-activation residual state", () => {
    const gate = assemble(rawFixture()).gate;
    expect(gate.slos.find((slo: any) => slo.id === "readiness")?.verdict).toBe("pass");
  });

  it("fails readiness when the measured pre-activation residual is nonempty", () => {
    const gate = assemble(rawFixture({ residualOccupied: true })).gate;
    expect(gate.slos.find((slo: any) => slo.id === "readiness")?.verdict).toBe("fail");
  });

  it("accepts a managed server port that differs from the advertised port and publishes both", () => {
    const fixture = rawFixture({ lane: "managed", serverPort: 5432 });
    const gate = assemble(fixture).gate;
    expect(gate.slos.find((slo: any) => slo.id === "readiness")?.verdict).toBe("pass");
    const witness = JSON.parse(readFileSync(join(fixture.output, "readiness-witness.ndjson"), "utf8"));
    expect(witness.databaseReadiness).toMatchObject({ serverPort: 5432, providerPort: 25060 });
  });

  it("still fails readiness without a managed advertised port or with a local server port other than 5432", () => {
    for (const variant of [{ lane: "managed" as const, providerPort: null }, { lane: "local" as const, serverPort: 15432 }]) {
      expect(assemble(rawFixture(variant)).gate.slos.find((slo: any) => slo.id === "readiness")?.verdict).toBe("fail");
    }
  }, 15_000);

  it("fails capacity when measured pool configuration differs from the contract", () => {
    const gate = assemble(rawFixture({ poolConfigMismatch: true })).gate;
    expect(gate.slos.find((slo: any) => slo.id === "capacity")?.verdict).toBe("fail");
  });

  it("fails capacity when setup-role sessions remain after activation", () => {
    const gate = assemble(rawFixture({ setupSessionOpen: true })).gate;
    expect(gate.slos.find((slo: any) => slo.id === "capacity")?.verdict).toBe("fail");
  });

  const capacitySlo = (variant: Variant) => assemble(rawFixture(variant)).gate.slos.find((slo: any) => slo.id === "capacity");

  it("pins the capacity formula", () => {
    expect(capacitySlo({ profile: "smoke" })?.formula).toBe("each machine's measured daemon pool configuration maximum and setup-role closure, plus the database-wide sampled connection peak (recomputed from grouped rows) within configured total and usable budget; role and client-address groups are corroboration only");
  });

  it.each<[string, Variant, "pass" | "fail" | "incomplete", number]>([
    ["default fixture", { profile: "smoke" }, "pass", 8],
    ["shared address, 8, local", { profile: "smoke", sharedAddress: true, runtimeConnections: 8 }, "pass", 8],
    ["shared address, 12, local", { profile: "smoke", sharedAddress: true, runtimeConnections: 12 }, "pass", 12],
    ["shared address, 8, managed full", { lane: "managed", profile: "full", sharedAddress: true, runtimeConnections: 8 }, "pass", 8],
    ["shared address, 12, managed", { lane: "managed", profile: "smoke", sharedAddress: true, runtimeConnections: 12 }, "pass", 12],
    ["distinct addresses, 12", { profile: "smoke", runtimeConnections: 12 }, "pass", 12],
    ["local client address group, 12", { profile: "smoke", clientAddress: "local", runtimeConnections: 12 }, "pass", 12],
    ["shared total 19, local", { profile: "smoke", sharedAddress: true, runtimeConnections: 19 }, "pass", 19],
    ["shared total 19, managed", { lane: "managed", profile: "smoke", sharedAddress: true, runtimeConnections: 19 }, "pass", 19],
    ["shared total 20, local", { profile: "smoke", sharedAddress: true, runtimeConnections: 20 }, "fail", 20],
    ["shared total 20, managed", { lane: "managed", profile: "smoke", sharedAddress: true, runtimeConnections: 20 }, "fail", 20],
    ["single sample peak 20", { profile: "smoke", capacityPeak: 20 }, "fail", 20],
    ["pool configuration mismatch", { profile: "smoke", poolConfigMismatch: true }, "fail", 8],
    ["open setup sessions", { profile: "smoke", setupSessionOpen: true }, "fail", 8],
    ["inconsistent closure witness", { profile: "smoke", closureInconsistent: true }, "fail", 8],
    ["rows sum 30 hidden by supplied total 5", { profile: "smoke", rowCount: 30, suppliedTotal: 5 }, "fail", 30],
    ["mismatch below the limit", { profile: "smoke", rowCount: 6, suppliedTotal: 5 }, "incomplete", 6],
    ["negative row count", { profile: "smoke", rowCount: -1 }, "incomplete", 8],
    ["fractional row count", { profile: "smoke", rowCount: 1.5 }, "incomplete", 8],
    ["non-finite row count", { profile: "smoke", rowCount: null }, "incomplete", 8],
    ["non-finite supplied total", { profile: "smoke", suppliedTotal: null }, "incomplete", 8],
    ["negative supplied total", { profile: "smoke", suppliedTotal: -1 }, "incomplete", 8],
    ["missing closure file", { profile: "smoke", omit: "closure" }, "incomplete", 8],
    ["missing poolByMachine", { profile: "smoke", omit: "poolByMachine" }, "incomplete", 8],
    ["missing machine pool row", { profile: "smoke", omit: "poolRowB" }, "incomplete", 8],
    ["missing maxConnections", { profile: "smoke", omit: "maxConnections" }, "incomplete", 8],
    ["missing reservedConnections", { profile: "smoke", omit: "reservedConnections" }, "incomplete", 8],
    ["empty clocks", { profile: "smoke", omit: "clocks" }, "incomplete", 0],
    ["exhausted clock retry", { profile: "smoke", clockRetry: "exhausted" }, "incomplete", 8],
  ])("scores capacity for %s", (_name, variant, verdict, observed) => {
    expect(capacitySlo(variant)).toMatchObject({ verdict, observed, threshold: 19 });
  }, 30_000);

  it("keeps a definite clock breach above missing observer evidence", () => {
    expect(assemble(rawFixture({ clockBreach: true, observerGap: true })).gate.verdict).toBe("fail");
  });

  it("rejects a byte-identical alternate contract with a different approval receipt", () => {
    const fixture = rawFixture();
    writeJson(join(fixture.root, "contract.approval.json"), {
      contractSha256: fixture.contractSha256,
      approvedBy: "different approver",
      approvedAt: "2026-10-26T10:00:00.000Z",
      note: "substituted",
      approvalRef: "different receipt",
    });
    expect(() => assemble(fixture)).toThrow("approval");
  });

  it("reassembles the same raw evidence without adding or changing evidence files", () => {
    const fixture = rawFixture();
    const before = snapshotFiles(fixture.root);
    const first = assemble(fixture).gate;
    const second = assemble(fixture).gate;
    expect(second).toEqual(first);
    expect(snapshotFiles(fixture.root)).toEqual(before);
  }, 15_000);

  it("can retry after a late provenance rejection without poisoning raw evidence", () => {
    const fixture = rawFixture();
    const before = snapshotFiles(fixture.root);
    expect(() => assembleGateFromEvidence({
      repositoryRoot: new URL("../..", import.meta.url).pathname,
      evidenceDirectory: fixture.root,
      contractPath: fixture.contractPath,
      outputDirectory: fixture.output,
    }, { captureProvenance: () => ({ ...fixture.provenance, testedCommit: "e".repeat(40) }) })).toThrow("provenance");
    expect(snapshotFiles(fixture.root)).toEqual(before);
    expect(assemble(fixture).gate.verdict).toBe("pass");
    expect(snapshotFiles(fixture.root)).toEqual(before);
  }, 15_000);

  it("keeps healthy smoke evidence incomplete and never non-certifying pass", () => {
    const gate = assemble(rawFixture({ profile: "smoke" })).gate;
    expect(gate.verdict).toBe("incomplete");
    expect(gate.slos.find((slo: any) => slo.id === "profile-certifying")?.verdict).toBe("incomplete");
    expect(gate.slos.find((slo: any) => slo.id === "lane-fault-set")?.verdict).toBe("incomplete");
  });

  it("keeps observed smoke failures as fail", () => {
    const gate = assemble(rawFixture({ profile: "smoke", smokeFailure: true })).gate;
    expect(gate.slos.find((slo: any) => slo.id === "non-injected-error-rate")?.verdict).toBe("fail");
    expect(gate.verdict).toBe("fail");
  });

  it("fails an observed smoke percentile breach even below the full sample floor", () => {
    const gate = assemble(rawFixture({ profile: "smoke", smokeSlow: true })).gate;
    expect(gate.slos.find((slo: any) => slo.id === "daemon-search.p50")?.verdict).toBe("fail");
    expect(gate.verdict).toBe("fail");
  });

  it("rejects a clock cadence gap for one machine despite sufficient total samples", () => {
    const gate = assemble(rawFixture({ clockGap: true })).gate;
    expect(gate.slos.find((slo: any) => slo.id === "clock-interval-radius")?.verdict).toBe("incomplete");
    expect(gate.verdict).toBe("incomplete");
  });

  it("scores a clock sample that succeeded on a recorded retry like any other sample", () => {
    const gate = assemble(rawFixture({ clockRetry: "recovered" })).gate;
    expect(gate.slos.find((slo: any) => slo.id === "clock-interval-radius")?.verdict).toBe("pass");
    expect(gate.slos.find((slo: any) => slo.id === "capacity")?.verdict).toBe("pass");
    expect(gate.verdict).toBe("pass");
  });

  it("keeps a clock sample incomplete when every attempt failed or its attempt count disagrees with its failures", () => {
    const exhausted = assemble(rawFixture({ clockRetry: "exhausted" })).gate;
    expect(exhausted.slos.find((slo: any) => slo.id === "clock-interval-radius")?.verdict).toBe("incomplete");
    expect(exhausted.slos.find((slo: any) => slo.id === "capacity")?.verdict).toBe("incomplete");
    expect(exhausted.verdict).toBe("incomplete");
    const miscounted = assemble(rawFixture({ clockRetry: "miscounted" })).gate;
    expect(miscounted.slos.find((slo: any) => slo.id === "clock-interval-radius")?.verdict).toBe("incomplete");
    expect(miscounted.verdict).toBe("incomplete");
  }, 15_000);

  it("accepts partition recovery after the contracted 60-second reconnect plus verification overhead", () => {
    const gate = assemble(rawFixture()).gate;
    expect(gate.slos.find((slo: any) => slo.id === "recovery.partition-a")?.verdict).toBe("pass");
  });

  it("checks restart first-success latency independently for each machine", () => {
    const gate = assemble(rawFixture({ restartBFirstSuccessSeconds: 45 })).gate;
    expect(gate.slos.find((slo: any) => slo.id === "recovery.restart-database")?.verdict).toBe("fail");
  });

  it("fails restart recovery when machine B has no post-clearance success", () => {
    const gate = assemble(rawFixture({ restartBNoSuccess: true })).gate;
    expect(gate.slos.find((slo: any) => slo.id === "recovery.restart-database")?.verdict).toBe("fail");
  });

  it("measures acknowledgment catch-up from fault clearance, not helper start", () => {
    const gate = assemble(rawFixture({ catchUpAtSeconds: 950 })).gate;
    expect(gate.slos.find((slo: any) => slo.id === "recovery.partition-a")?.verdict).toBe("fail");
  });

  it("treats complete recovery evidence with no success as fail over missing measures", () => {
    const gate = assemble(rawFixture({ noRecoverySuccess: true, catchUpFail: true })).gate;
    expect(gate.slos.find((slo: any) => slo.id === "recovery.partition-a")?.verdict).toBe("fail");
  });

  it("keeps a known first-success breach as fail when catch-up evidence is missing", () => {
    const gate = assemble(rawFixture({ partitionFirstSuccessSeconds: 45, missingCatchUpTimestamp: true })).gate;
    expect(gate.slos.find((slo: any) => slo.id === "recovery.partition-a")?.verdict).toBe("fail");
  });

  it("marks an observer gap incomplete when no definite gate fails", () => {
    expect(assemble(rawFixture({ observerGap: true })).gate.verdict).toBe("incomplete");
  });

  it("passes good observer polls whose -wal/-shm siblings were absent", () => {
    const gate = assemble(rawFixture({ observerSiblingsPresent: false })).gate;
    expect(gate.slos.find((slo: any) => slo.id === "observer-completeness")).toMatchObject({ verdict: "pass", observed: 0 });
    expect(gate.verdict).toBe("pass");
  });

  it.each(["error", "replaced", "missing"])("keeps a raw %s poll incomplete even when the row claims completeness", (status) => {
    const gate = assemble(rawFixture({ extraObserverRow: { status, incomplete: false } })).gate;
    expect(gate.slos.find((slo: any) => slo.id === "observer-completeness")?.verdict).toBe("incomplete");
    expect(gate.verdict).toBe("incomplete");
  });

  it.each([
    [{ duplicateMapping: true }, "oracle-capture-bijection"],
    [{ drainFail: true }, "final-drain"],
    [{ capacityPeak: 20 }, "capacity"],
    [{ recoveryFail: true }, "recovery.partition-a"],
    [{ catchUpFail: true }, "recovery.partition-a"],
    [{ readinessInvalid: true }, "readiness"],
    [{ phaseEarly: true }, "phase-barriers"],
  ] as const)("rejects raw acceptance failure %j", (variant, sloId) => {
    const gate = assemble(rawFixture(variant)).gate;
    expect(gate.slos.find((slo: any) => slo.id === sloId)?.verdict).not.toBe("pass");
    expect(gate.verdict).not.toBe("pass");
  });
});

// The gate's earlier reading of the observer files: each file as one string and the
// merged witness as one joined string. The streamed reading must reproduce its bytes.
function joinedObserverWitness(root: string): Buffer {
  return Buffer.from(["a", "b"].flatMap((machine) => readFileSync(join(root, `machine-${machine}`, "observer.ndjson"), "utf8")
    .split(/\r?\n/u).filter(Boolean).map((line) => ({ machine, ...JSON.parse(line) })))
    .map((row) => `${JSON.stringify(row)}\n`).join(""));
}
const sha256Hex = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

describe("streamed evidence reads and chunked samples", () => {
  function ndjsonFile(text: string): string {
    const path = join(mkdtempSync(join(tmpdir(), "lcm-cert-ndjson-")), "rows.ndjson");
    writeFileSync(path, text);
    return path;
  }
  function streamedRows(path: string, chunkSizes?: { chunkBytes: number }): unknown[] {
    const rows: unknown[] = [];
    forEachNdjsonRow(path, (row: unknown) => { rows.push(row); }, chunkSizes);
    return rows;
  }

  it("splits rows exactly as the whole-text split does at every chunk size", () => {
    const path = ndjsonFile([
      '{"n":1,"text":"ação 🙂"}\r\n', "\n", `{"n":2,"long":"${"x".repeat(150)}"}\n`, "\r\n", '{"n":3,"text":"🙂🙂"}\r\n', '{"n":4}',
    ].join(""));
    const whole = readFileSync(path, "utf8").split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
    expect(whole.map((row) => row.n)).toEqual([1, 2, 3, 4]);
    for (const chunkBytes of [1, 2, 3, 5, 64]) expect(streamedRows(path, { chunkBytes })).toEqual(whole);
    expect(streamedRows(path)).toEqual(whole);
  });

  it("reads the next chunk only after the rows before it are visited", () => {
    const path = ndjsonFile('{"n":1}\n{"n":2}\n');
    const seen: number[] = [];
    // A whole-file read would miss the row appended while the first row is visited.
    forEachNdjsonRow(path, (row: { n: number }) => {
      seen.push(row.n);
      if (row.n === 1) appendFileSync(path, '{"n":3}\n');
    }, { chunkBytes: 8 });
    expect(seen).toEqual([1, 2, 3]);
  });

  it("flushes sample chunks only at row boundaries, so multibyte text and empty samples keep their bytes", () => {
    const rows = Array.from({ length: 50 }, (_, index) => ({ index, text: "ação 🙂".repeat(index % 7) }));
    const builder = createSampleBuilder({ chunkChars: 40 });
    for (const row of rows) builder.append(row);
    const chunks = builder.finish();
    expect(chunks.length).toBeGreaterThan(10);
    for (const chunk of chunks) expect(chunk.toString("utf8").endsWith("\n")).toBe(true);
    expect(Buffer.concat(chunks).equals(Buffer.from(rows.map((row) => `${JSON.stringify(row)}\n`).join("")))).toBe(true);
    const empty = createSampleBuilder().finish();
    expect(empty).toEqual([]);
    expect(sampleSha256(empty)).toBe(sha256Hex(Buffer.alloc(0)));
  });

  it("merges both observer files into a chunked witness byte-identical to the joined witness", () => {
    const fixture = rawFixture({ profile: "smoke", observerRows: 240 });
    const golden = joinedObserverWitness(fixture.root);
    const { polls, witness } = readObserverWitness(fixture.root, { chunkBytes: 64, chunkChars: 512 });
    expect(Buffer.concat(witness).equals(golden)).toBe(true);
    expect(sampleSha256(witness)).toBe(sha256Hex(golden));
    expect(polls).toHaveLength(480);
    expect(polls[0]).toEqual({ machine: "a", status: "ok", incomplete: false, gapMs: 1000.5 });
    expect(polls.at(-1)).toEqual({ machine: "b", status: "ok", incomplete: false, gapMs: 1000.5 });
    const longestRow = Math.max(...golden.toString("utf8").split("\n").map((line) => line.length + 1));
    expect(witness.length).toBeGreaterThan(100);
    for (const chunk of witness) expect(chunk.length).toBeLessThan(512 + longestRow);
    const written = join(mkdtempSync(join(tmpdir(), "lcm-cert-witness-")), "observer-witness.ndjson");
    writeSampleFile(written, witness);
    expect(readFileSync(written).equals(golden)).toBe(true);
  });

  it("builds the same manifest and samples at any chunk size and publishes the witness unchanged", () => {
    const fixture = rawFixture({ profile: "smoke", observerRows: 240 });
    const contract = JSON.parse(readFileSync(fixture.contractPath, "utf8"));
    const tiny = buildEvidenceManifest({ evidenceDirectory: fixture.root, contract, persist: false, chunkSizes: { chunkBytes: 7, chunkChars: 64 } });
    const standard = buildEvidenceManifest({ evidenceDirectory: fixture.root, contract, persist: false });
    expect(tiny.manifest).toEqual(standard.manifest);
    expect(Object.keys(tiny.sampleFiles)).toEqual(Object.keys(standard.sampleFiles));
    for (const [name, sample] of Object.entries(standard.sampleFiles)) {
      expect(Buffer.concat(tiny.sampleFiles[name]).equals(Buffer.concat(sample as Buffer[]))).toBe(true);
    }
    const golden = joinedObserverWitness(fixture.root);
    const result = assemble(fixture);
    expect(result.gate.slos.find((slo: any) => slo.id === "observer-completeness")).toMatchObject({
      verdict: "pass", observed: 0, inputs: { count: 480, sampleSha256: sha256Hex(golden) },
    });
    expect(readFileSync(join(fixture.output, "observer-witness.ndjson")).equals(golden)).toBe(true);
  }, 15_000);
});

describe("lane fault-set sample from real producer layouts", () => {
  const ndjson = (values: unknown[]) => values.map((value) => `${JSON.stringify(value)}\n`).join("");
  const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
  const faultSetOf = (gate: any) => gate.slos.find((slo: any) => slo.id === "lane-fault-set");

  it("assembles managed full evidence that records only fault-partition-a.json", () => {
    const fixture = rawFixture({ lane: "managed" });
    expect(existsSync(join(fixture.root, "faults.json"))).toBe(false);
    expect(existsSync(join(fixture.root, "fault-partition-a.json"))).toBe(true);
    const before = snapshotFiles(fixture.root);
    const first = assemble(fixture).gate;
    expect(first.lane).toBe("managed");
    expect(first.verdict).toBe("pass");
    expect(faultSetOf(first)).toMatchObject({
      verdict: "pass", observed: 1, threshold: 1,
      inputs: { count: 1, sampleFile: "lane-fault-set.ndjson", sampleSha256: sha256(ndjson(fixture.faults)) },
    });
    expect(first.faults).toEqual(fixture.faults);
    expect(first.slos.find((slo: any) => slo.id === "recovery.partition-a")).toMatchObject({ verdict: "pass", inputs: { sampleFile: "fault-partition-a.json" } });
    expect(first.slos.some((slo: any) => slo.id === "recovery.restart-database")).toBe(false);
    expect(readFileSync(join(fixture.output, "lane-fault-set.ndjson"), "utf8")).toBe(ndjson(fixture.faults));
    expect(assemble(fixture).gate).toEqual(first);
    expect(snapshotFiles(fixture.root)).toEqual(before);
  }, 15_000);

  it("assembles smoke evidence that records no fault file at all", () => {
    const fixture = rawFixture({ profile: "smoke" });
    expect(existsSync(join(fixture.root, "faults.json"))).toBe(false);
    expect(existsSync(join(fixture.root, "fault-partition-a.json"))).toBe(false);
    const before = snapshotFiles(fixture.root);
    const first = assemble(fixture).gate;
    expect(first.verdict).toBe("incomplete");
    expect(first.faults).toEqual([]);
    expect(faultSetOf(first)).toMatchObject({
      verdict: "incomplete", observed: 0, threshold: 0,
      inputs: { count: 0, sampleFile: "lane-fault-set.ndjson", sampleSha256: sha256("") },
    });
    expect(readFileSync(join(fixture.output, "lane-fault-set.ndjson"), "utf8")).toBe("");
    expect(assemble(fixture).gate).toEqual(first);
    expect(snapshotFiles(fixture.root)).toEqual(before);
  }, 15_000);

  it("derives the local full fault-set sample from faults.json without rewriting it", () => {
    const fixture = rawFixture();
    expect(existsSync(join(fixture.root, "faults.json"))).toBe(true);
    const rawBytes = readFileSync(join(fixture.root, "faults.json"));
    const first = assemble(fixture).gate;
    expect(first.verdict).toBe("pass");
    expect(faultSetOf(first)).toMatchObject({
      verdict: "pass", observed: 2, threshold: 2,
      inputs: { count: 2, sampleFile: "lane-fault-set.ndjson", sampleSha256: sha256(ndjson(fixture.faults)) },
    });
    expect(first.slos.find((slo: any) => slo.id === "recovery.restart-database")).toMatchObject({ verdict: "pass", inputs: { sampleFile: "faults.json" } });
    expect(readFileSync(join(fixture.output, "lane-fault-set.ndjson"), "utf8")).toBe(ndjson(fixture.faults));
    expect(readFileSync(join(fixture.root, "faults.json"))).toEqual(rawBytes);
    expect(existsSync(join(fixture.root, "lane-fault-set.ndjson"))).toBe(false);
  });

  it("fails rather than throws when a full run records fewer faults than its lane requires", () => {
    const fixture = rawFixture({ lane: "local", faultLayout: "partition-a" });
    const gate = assemble(fixture).gate;
    expect(faultSetOf(gate)).toMatchObject({ verdict: "fail", observed: 1, threshold: 2, inputs: { count: 1, sampleFile: "lane-fault-set.ndjson" } });
    expect(gate.verdict).toBe("fail");
  });

  it("evaluates a fault smoke against the lane's contract faults and keeps it non-certifying", () => {
    const fixture = rawFixture({ profile: "smoke", withFaults: true, faultLayout: "faults" });
    const result = assemble(fixture);
    const gate = result.gate;
    expect(gate.withFaults).toBe(true);
    expect(faultSetOf(gate)).toMatchObject({ verdict: "pass", observed: 2, threshold: 2, formula: "full profile or smoke with faults: exact contract lane fault IDs" });
    for (const id of ["recovery.partition-a", "recovery.restart-database"]) {
      expect(gate.slos.find((slo: any) => slo.id === id)).toMatchObject({ verdict: "pass", inputs: { sampleFile: "faults.json" } });
    }
    expect(gate.slos.find((slo: any) => slo.id === "profile-certifying")).toMatchObject({ verdict: "incomplete", observed: 0 });
    expect(gate.verdict).toBe("incomplete");
    expect(readFileSync(result.paths.markdown, "utf8")).toContain("Lane/profile: `local` / `smoke` with faults (non-certifying)");
  });

  it("fails a fault smoke whose recorded faults differ from the lane's contract faults", () => {
    for (const faultLayout of ["partition-a", "none"] as const) {
      const gate = assemble(rawFixture({ profile: "smoke", withFaults: true, faultLayout })).gate;
      expect(faultSetOf(gate)).toMatchObject({ verdict: "fail", threshold: 2, observed: faultLayout === "none" ? 0 : 1 });
      expect(gate.verdict).toBe("fail");
    }
  });

  it("publishes withFaults false for runs without the option", () => {
    for (const profile of ["smoke", "full"] as const) {
      const result = assemble(rawFixture({ profile }));
      expect(result.gate.withFaults).toBe(false);
      expect(readFileSync(result.paths.markdown, "utf8")).not.toContain("with faults");
    }
  });
});

describe("scheduled maintenance outcomes gate the non-injected error rate", () => {
  const errorRateOf = (gate: any) => gate.slos.find((slo: any) => slo.id === "non-injected-error-rate");
  const identityOf = (gate: any) => gate.slos.find((slo: any) => slo.id === "scheduled-attempt-identity");
  // Full profile per machine: 600 hooks + 1200 searches + 600 stores + 100 snapshots + 20 compacts = 2520; pooled 5040.
  const fullScheduled = 5040;

  it.each([["local"], ["managed"]] as const)("counts the complete %s steady schedule including snapshot and compact", (lane) => {
    const gate = assemble(rawFixture({ lane })).gate;
    expect(gate.verdict).toBe("pass");
    expect(errorRateOf(gate)).toMatchObject({ verdict: "pass", observed: 0, inputs: { count: fullScheduled } });
    expect(errorRateOf(gate).formula).toMatch(/snapshot, compact/u);
  });

  it.each([
    ["local", "compact", 40],
    ["local", "snapshot", 200],
    ["local", "mixed", 120],
    ["managed", "compact", 40],
    ["managed", "snapshot", 200],
    ["managed", "mixed", 120],
  ] as const)("fails otherwise passing %s evidence when %s maintenance operations fail", (lane, mode, failed) => {
    const gate = assemble(rawFixture({ lane, maintenanceFailure: mode })).gate;
    expect(identityOf(gate).verdict).toBe("pass");
    expect(errorRateOf(gate)).toMatchObject({ verdict: "fail", inputs: { count: fullScheduled } });
    expect(errorRateOf(gate).observed).toBeCloseTo(failed / fullScheduled, 12);
    expect(gate.verdict).toBe("fail");
  });

  it("fails smoke evidence whose only failure is a compact", () => {
    const gate = assemble(rawFixture({ profile: "smoke", maintenanceFailure: "compact" })).gate;
    expect(errorRateOf(gate)).toMatchObject({ verdict: "fail", inputs: { count: 102 } });
    expect(errorRateOf(gate).observed).toBeCloseTo(2 / 102, 12);
    expect(gate.verdict).toBe("fail");
  });
});

describe("execution-host witness in the public gate", () => {
  it("carries the recorded witness into gate provenance and markdown as recorded, not the assembling host", () => {
    const fixture = rawFixture();
    const result = assemble(fixture);
    expect(result.gate.provenance.executionHost).toMatchObject({
      osId: "ubuntu", osVersionId: "24.04", kernelRelease: "6.8.0-45-generic", architecture: "x64", cpuModel: "AMD EPYC 9R14", logicalCpus: 8,
      totalMemoryBytes: 33_000_000_000, containerEngine: "podman", containerEngineVersion: "5.2.3", hostnameSha256: "7".repeat(64),
      runnerName: "blacksmith-8vcpu-ubuntu-2404", runnerOs: "Linux", runnerArch: "X64", runnerSku: "blacksmith-8vcpu-ubuntu-2404",
    });
    const markdown = readFileSync(result.paths.markdown, "utf8");
    expect(markdown).toContain("## Execution host");
    expect(markdown).toContain("OS: ubuntu 24.04; kernel 6.8.0-45-generic; x64");
    expect(markdown).toContain("CPU: AMD EPYC 9R14 (8 logical); memory 30.7 GiB");
    expect(markdown).toContain("Container engine: podman 5.2.3");
    expect(markdown).toContain(`Hostname SHA-256: \`${"7".repeat(64)}\``);
    expect(markdown).toContain("SKU blacksmith-8vcpu-ubuntu-2404");
    expect(markdown).not.toContain("8".repeat(64));
  });

  it("accepts null runner metadata and SKU without failing and renders them as n/a", () => {
    const fixture = rawFixture({ executionHost: { runnerName: null, runnerOs: null, runnerArch: null, runnerSku: null, containerEngineVersion: null } });
    const result = assemble(fixture);
    expect(result.gate.verdict).toBe("pass");
    expect(result.gate.provenance.executionHost).toMatchObject({ runnerName: null, runnerOs: null, runnerArch: null, runnerSku: null });
    expect(readFileSync(result.paths.markdown, "utf8")).toContain("Runner: name n/a; os n/a; arch n/a; SKU n/a");
  });

  it("refuses evidence without a host witness, with a malformed hostname digest, or with an unknown witness key", () => {
    const missing = rawFixture();
    const recorded = JSON.parse(readFileSync(join(missing.root, "execution-provenance.json"), "utf8"));
    delete recorded.executionHost;
    writeJson(join(missing.root, "execution-provenance.json"), recorded);
    expect(() => assemble(missing)).toThrow("execution-host witness");
    expect(() => assemble(rawFixture({ executionHost: { hostnameSha256: "lcm-testbox" } }))).toThrow("hostname digest");
    expect(() => assemble(rawFixture({ executionHost: { rawHostname: "leak" } }))).toThrow("unexpected key");
  });
});

describe("observer read settings in the public gate", () => {
  // Rewrites the recorded settings; undefined removes them.
  function withObserverSettings(observerSettings: unknown) {
    const fixture = rawFixture({ profile: "smoke" });
    const path = join(fixture.root, "execution-provenance.json");
    const recorded = JSON.parse(readFileSync(path, "utf8"));
    if (observerSettings === undefined) delete recorded.observerSettings;
    else recorded.observerSettings = observerSettings;
    writeJson(path, recorded);
    return fixture;
  }
  const recorded = { pollSeconds: 1, busyTimeoutMs: 200, perQueryDeadlineMs: 250, maxPollGapSeconds: 2 };

  it("carries the recorded settings into the gate JSON and markdown", () => {
    const result = assemble(rawFixture({ profile: "smoke" }));
    expect(result.gate.provenance.observerSettings).toEqual(recorded);
    expect(JSON.parse(readFileSync(result.paths.json, "utf8")).provenance.observerSettings).toEqual(recorded);
    const markdown = readFileSync(result.paths.markdown, "utf8");
    expect(markdown).toContain("## Observer reads");
    expect(markdown).toContain("Poll every 1 s; SQLite busy timeout 200 ms; per-query deadline 250 ms; maximum poll gap 2 s");
  });

  it("refuses evidence without settings or whose busy timeout is not shorter than the per-query deadline", () => {
    const missing = withObserverSettings(undefined);
    const captureProvenance = vi.fn(() => missing.provenance);
    expect(() => assembleGateFromEvidence({
      repositoryRoot: missing.root, evidenceDirectory: missing.root, contractPath: missing.contractPath, outputDirectory: missing.output,
    }, { captureProvenance })).toThrow("missing its observer read settings");
    expect(captureProvenance).not.toHaveBeenCalled();
    expect(existsSync(missing.output)).toBe(false);
    for (const busyTimeoutMs of [250, 300]) {
      expect(() => assemble(withObserverSettings({ ...recorded, busyTimeoutMs }))).toThrow("busy timeout is not shorter than its per-query deadline");
    }
  });

  it("validates the settings against the closed schema and the values the contract and observer code produce", () => {
    expect(() => assemble(withObserverSettings({ ...recorded, databasePath: "/home/user/.lcm/events/project.db" }))).toThrow("unexpected key databasePath");
    expect(() => assemble(withObserverSettings({ pollSeconds: 1, busyTimeoutMs: 200, perQueryDeadlineMs: 250 }))).toThrow("missing maxPollGapSeconds");
    expect(() => assemble(withObserverSettings({ ...recorded, pollSeconds: 1.5 }))).toThrow("observer read settings are invalid");
    expect(() => assemble(withObserverSettings({ ...recorded, pollSeconds: 2 }))).toThrow("do not match the contract and observer code at pollSeconds");
    expect(() => assemble(withObserverSettings({ ...recorded, busyTimeoutMs: 100 }))).toThrow("do not match the contract and observer code at busyTimeoutMs");
  });
});

describe("gate readback never captures the assembling host", () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it("does not execute a container engine named by the recorded witness", () => {
    const bin = mkdtempSync(join(tmpdir(), "lcm-cert-engine-"));
    const marker = join(bin, "executed");
    writeFileSync(join(bin, "lcm-cert-sentinel-engine"), `#!/bin/sh\n: > '${marker}'\necho 9.9.9\n`, { mode: 0o755 });
    vi.stubEnv("PATH", `${bin}${delimiter}${process.env.PATH ?? ""}`);
    const result = assembleGateFromEvidence(realReadbackInput({ containerEngine: "lcm-cert-sentinel-engine" }));
    expect(result.gate.provenance.executionHost.containerEngine).toBe("lcm-cert-sentinel-engine");
    expect(existsSync(marker)).toBe(false);
  });

  it("assembles despite an invalid assembler runner SKU and publishes the recorded witness without the raw hostname", () => {
    vi.stubEnv("LCM_CERT_RUNNER_SKU", "not a valid sku");
    const witness = captureExecutionHost({
      environment: { RUNNER_NAME: "lcm-testbox-07", RUNNER_OS: "Linux", RUNNER_ARCH: "X64", LCM_CERT_RUNNER_SKU: "blacksmith-8vcpu-ubuntu-2404" },
      containerCli: "podman", readFile: () => "ID=ubuntu\nVERSION_ID=24.04\n", engineVersion: () => "5.8.4",
      os: { arch: () => "x64", cpus: () => Array.from({ length: 8 }, () => ({ model: "AMD EPYC 9R14" })), hostname: () => "lcm-testbox-07", release: () => "6.8.0-45-generic", totalmem: () => 33_000_000_000 },
    });
    const result = assembleGateFromEvidence(realReadbackInput(witness));
    expect(result.gate.provenance.executionHost).toEqual(witness);
    expect(result.gate.provenance.executionHost).toMatchObject({ runnerName: null, runnerSku: "blacksmith-8vcpu-ubuntu-2404" });
    for (const path of [result.paths.json, result.paths.markdown]) expect(readFileSync(path, "utf8")).not.toContain("lcm-testbox-07");
  });

  it("validates the recorded witness against the closed schema before any provenance readback", () => {
    for (const executionHost of [{ logicalCpus: 0 }, { containerEngine: "x".repeat(129) }, { runnerSku: "not a valid sku" }, { rawHostname: "lcm-testbox-07" }]) {
      const fixture = rawFixture({ profile: "smoke", executionHost });
      const captureProvenance = vi.fn(() => fixture.provenance);
      expect(() => assembleGateFromEvidence({
        repositoryRoot: fixture.root, evidenceDirectory: fixture.root, contractPath: fixture.contractPath, outputDirectory: fixture.output,
      }, { captureProvenance })).toThrow("execution-host witness is invalid");
      expect(captureProvenance).not.toHaveBeenCalled();
    }
  });
});

describe("gate contract version", () => {
  it("refuses to assemble a gate against the superseded v2 contract", () => {
    const fixture = rawFixture({ profile: "smoke" });
    const before = snapshotFiles(fixture.root);
    expect(() => assembleGateFromEvidence({
      repositoryRoot: fixture.root, evidenceDirectory: fixture.root,
      contractPath: new URL("./contract-v2.json", import.meta.url).pathname, outputDirectory: fixture.output,
    }, { captureProvenance: () => fixture.provenance })).toThrow("version 3 or 4 is required");
    expect(existsSync(fixture.output)).toBe(false);
    expect(snapshotFiles(fixture.root)).toEqual(before);
  });
});

describe("gate command-line parsing", () => {
  const pairs = ["--repository-root", "/repo", "--evidence-dir", "/evidence", "--contract", "/repo/contract.json", "--output-dir", "/out"];

  it("accepts the documented pnpm-forwarded leading separator and the direct form equally", () => {
    const direct = parseGateArguments(pairs);
    expect(direct).toEqual({ repositoryRoot: "/repo", evidenceDirectory: "/evidence", contractPath: "/repo/contract.json", outputDirectory: "/out" });
    expect(parseGateArguments(["--", ...pairs])).toEqual(direct);
  });

  it("still rejects missing required options", () => {
    expect(() => parseGateArguments(["--", "--repository-root", "/repo"])).toThrow("missing --evidence-dir");
    expect(() => parseGateArguments([])).toThrow("missing --repository-root");
  });
});
