import { EventEmitter } from "node:events";
import { lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SIGNAL_PROBE_READINESS_TIMEOUT_MS,
  HARNESS_CLEANUP_RETRY_DELAYS_MS,
  HARNESS_ALLOCATION_MARKER,
  MAX_HARNESS_ALLOCATION_MARKER_LINE_LENGTH,
  MAX_CAPTURED_OUTPUT_BYTES,
  MAX_DOCKER_REMOVE_ATTEMPTS,
  MAX_SIGNAL_PROBE_READINESS_TIMEOUT_MS,
  MIN_SIGNAL_PROBE_READINESS_TIMEOUT_MS,
  NODE_IMAGE,
  OWNER_BIRTH_LABEL,
  OWNER_PID_LABEL,
  OWNER_SCOPE_LABEL,
  OWNER_SCHEMA_LABEL,
  OWNER_SCHEMA_VERSION,
  ORPHAN_WORKER_STABILITY_DELAY_MS,
  POSTGRES_IMAGE,
  RESOURCE_KIND_LABEL,
  RUN_LABEL,
  SIGNAL_CLEANUP_FAILURE_MARKER,
  SIGNAL_DIAGNOSTIC_FLUSH_TIMEOUT_MS,
  auditHarnessRunResources,
  classifyOwnerIdentity,
  cleanupHarnessResources,
  completeSignalExit,
  createHarnessAllocationMarkerParser,
  createHarnessCleanupOperations,
  createOwnerIdentity,
  createProcessLifecycle,
  createRunNames,
  createSignalCleanupDiagnosticParser,
  createSingleFlightOperation,
  discoverHarnessRuns,
  harnessErrorDetails,
  harnessDirectoryFromRecord,
  isValidProcessBirthFingerprint,
  isMissingDockerObjectError,
  ownershipLabels,
  processIdentityEvidenceConsistent,
  readProcessBirthFingerprint,
  readOwnerScopeFingerprint,
  recordAmbiguousConsumerIdentity,
  recordConsumerIdentity,
  reclaimProvenOrphans,
  removeLabeled,
  removeOwnedResource,
  resolveSignalProbeReadinessTimeout,
  resolveConfiguredTemplateArchive,
  runProcess,
  runSanitizedProcess,
  sanitizeHarnessText,
  signalCleanupFailed,
  validateRunNames,
  writeHarnessDiagnostic,
} from "../../scripts/postgresql-harness.mjs";
import { createTestTempDirectory } from "../../scripts/test-temp-root.mjs";
import { postgresqlVitestCacheDir } from "../../vitest.postgresql.config.js";

const testBootId = "12345678-1234-1234-1234-123456789abc";
const testOwnerScope = `linux:${"a".repeat(64)}:${testBootId}:pid:[4026531836]`;

function missingContainerError(name: string) {
  return Object.assign(new Error("docker failed"), {
    code: 1,
    stdout: "",
    stderr: `Error response from daemon: No such container: ${name}`,
  });
}

describe("PostgreSQL harness utilities", () => {
  it("authenticates owned harness directories under finite fallback parents", () => {
    const record = {
      Mounts: [{
        Destination: "/run/lcm-harness",
        Type: "bind",
        RW: false,
        Source: "/var/tmp/lcm-postgresql-harness-owned",
      }],
    };
    const realpath = (path: string) => path;
    expect(harnessDirectoryFromRecord(record, {
      environment: {},
      candidateParents: ["/var/tmp", "/unrelated"],
      realpath,
    })).toBe("/var/tmp/lcm-postgresql-harness-owned");
    expect(harnessDirectoryFromRecord({
      Mounts: [{ ...record.Mounts[0], Source: "/home/unrelated/lcm-postgresql-harness-owned" }],
    }, {
      environment: { TMPDIR: "/worker-scratch" },
      candidateParents: ["/unrelated"],
      realpath,
    })).toBeUndefined();
  });

  it("uses the explicit nested harness parent and rejects outer worker scratch", () => {
    const realpath = (path: string) => path;
    const mount = (source: string) => ({ Mounts: [{
      Destination: "/run/lcm-harness", Type: "bind", RW: false, Source: source,
    }] });
    const environment = {
      LCM_TEST_HARNESS_TMPDIR: "/original",
      TMPDIR: "/worker-scratch",
    };
    expect(harnessDirectoryFromRecord(mount("/original/lcm-postgresql-harness-owned"), {
      environment,
      realpath,
    })).toBe("/original/lcm-postgresql-harness-owned");
    expect(harnessDirectoryFromRecord(mount("/worker-scratch/lcm-postgresql-harness-owned"), {
      environment,
      realpath,
    })).toBeUndefined();
  });

  it("uses the selected handoff and valid original snapshot only", () => {
    const mount = (source: string) => ({ Mounts: [{
      Destination: "/run/lcm-harness", Type: "bind", RW: false, Source: source,
    }] });
    const environment = {
      LCM_TEST_HARNESS_TMPDIR: "/original",
      LCM_TEST_HARNESS_ORIGINAL_TEMP_PARENTS: JSON.stringify({
        version: 1,
        parents: ["/ambient-original"],
      }),
      TMPDIR: "/worker-scratch",
    };
    const realpath = (path: string) => path;
    expect(harnessDirectoryFromRecord(mount("/ambient-original/lcm-postgresql-harness-snapshot"), {
      environment,
      realpath,
    })).toBe("/ambient-original/lcm-postgresql-harness-snapshot");
    expect(harnessDirectoryFromRecord(mount("/worker-scratch/lcm-postgresql-harness-snapshot"), {
      environment,
      realpath,
    })).toBeUndefined();
    expect(harnessDirectoryFromRecord(mount("/var/tmp/lcm-postgresql-harness-fallback"), {
      environment,
      realpath,
    })).toBeUndefined();
  });

  it("uses platform fallbacks for a missing snapshot and preserves native Windows paths", () => {
    const mount = (source: string) => ({ Mounts: [{
      Destination: "/run/lcm-harness", Type: "bind", RW: false, Source: source,
    }] });
    const realpath = (path: string) => path;
    expect(harnessDirectoryFromRecord(mount("/var/tmp/lcm-postgresql-harness-fallback"), {
      environment: { LCM_TEST_HARNESS_TMPDIR: "/original" },
      realpath,
      platformName: "linux",
    })).toBe("/var/tmp/lcm-postgresql-harness-fallback");
    const windowsEnvironment = {
      LCM_TEST_HARNESS_TMPDIR: "C:\\Harness",
      SystemRoot: "C:\\Windows",
      TEMP: "C:\\WorkerScratch",
      TMP: "C:\\WorkerScratch",
    };
    expect(harnessDirectoryFromRecord(
      mount("C:\\Harness\\lcm-postgresql-harness-native"),
      { environment: windowsEnvironment, realpath, platformName: "win32" },
    )).toBe("C:\\Harness\\lcm-postgresql-harness-native");
    expect(harnessDirectoryFromRecord(
      mount("\\\\server\\share\\lcm-postgresql-harness-unc"),
      {
        environment: {
          LCM_TEST_HARNESS_TMPDIR: "\\\\server\\share",
          LCM_TEST_HARNESS_ORIGINAL_TEMP_PARENTS: JSON.stringify({
            version: 1,
            parents: ["\\\\server\\share"],
          }),
        },
        realpath,
        platformName: "win32",
      },
    )).toBe("\\\\server\\share\\lcm-postgresql-harness-unc");
    expect(harnessDirectoryFromRecord(
      mount("C:\\Windows\\Temp\\lcm-postgresql-harness-fallback"),
      { environment: windowsEnvironment, realpath, platformName: "win32" },
    )).toBe("C:\\Windows\\Temp\\lcm-postgresql-harness-fallback");
    expect(harnessDirectoryFromRecord(
      mount("C:\\Windows\\lcm-postgresql-harness-owned"),
      { environment: windowsEnvironment, realpath, platformName: "win32" },
    )).toBeUndefined();
    expect(harnessDirectoryFromRecord(
      mount("D:\\Other\\lcm-postgresql-harness-unrelated"),
      { environment: windowsEnvironment, realpath, platformName: "win32" },
    )).toBeUndefined();
    expect(harnessDirectoryFromRecord(
      mount("C:\\WorkerScratch\\lcm-postgresql-harness-worker"),
      { environment: windowsEnvironment, realpath, platformName: "win32" },
    )).toBeUndefined();
    expect(harnessDirectoryFromRecord(
      mount("C:\\WorkerScratch\\lcm-postgresql-harness-worker"),
      {
        environment: {
          ...windowsEnvironment,
          LCM_TEST_HARNESS_ORIGINAL_TEMP_PARENTS: "malformed",
        },
        realpath,
        platformName: "win32",
        temporaryRoot: () => {
          throw new Error("nested authentication must not recapture live roots");
        },
      },
    )).toBeUndefined();
    expect(win32.dirname("C:\\Harness\\lcm-postgresql-harness-native"))
      .toBe("C:\\Harness");
  });

  it("rejects an empty handoff and a bare or unrelated directory", () => {
    const mount = (source: string) => ({ Mounts: [{
      Destination: "/run/lcm-harness", Type: "bind", RW: false, Source: source,
    }] });
    const realpath = (path: string) => path;
    expect(harnessDirectoryFromRecord(mount("/cwd/lcm-postgresql-harness-empty"), {
      environment: { LCM_TEST_HARNESS_TMPDIR: "" },
      realpath,
      platformName: "linux",
    })).toBeUndefined();
    expect(harnessDirectoryFromRecord(mount("/var/tmp/lcm-postgresql-harness-unrelated"), {
      environment: { LCM_TEST_HARNESS_TMPDIR: "/var/tmp/lcm-postgresql-harness-unrelated" },
      realpath,
      platformName: "linux",
    })).toBe("/var/tmp/lcm-postgresql-harness-unrelated");
    expect(harnessDirectoryFromRecord(mount("/home/unrelated/lcm-postgresql-harness-unrelated"), {
      environment: { LCM_TEST_HARNESS_TMPDIR: "/var/tmp" },
      realpath,
      platformName: "linux",
    })).toBeUndefined();
  });

  it("keeps harness allocation and orphan authentication on absolute handoffs", () => {
    const mount = (source: string) => ({ Mounts: [{
      Destination: "/run/lcm-harness", Type: "bind", RW: false, Source: source,
    }] });
    const relativeEnvironment = { LCM_TEST_HARNESS_TMPDIR: "relative-parent" };
    const relativeRealpath = vi.fn((path: string) => path);
    const relativeCreate = vi.fn(() => "relative-parent/lcm-postgresql-harness-owned");

    expect(() => createTestTempDirectory({
      environment: relativeEnvironment,
      explicitVariable: "LCM_TEST_HARNESS_TMPDIR",
      realpath: relativeRealpath,
      markerProbe: () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
      createDirectory: relativeCreate,
      secureDirectory: vi.fn(),
    })).toThrow(/LCM_TEST_HARNESS_TMPDIR.*absolute/iu);
    expect(relativeRealpath).not.toHaveBeenCalled();
    expect(relativeCreate).not.toHaveBeenCalled();
    expect(harnessDirectoryFromRecord(
      mount("relative-parent/lcm-postgresql-harness-owned"),
      { environment: relativeEnvironment, realpath: (path: string) => path },
    )).toBeUndefined();

    const parent = "/private/harness-parent";
    const directory = `${parent}/lcm-postgresql-harness-owned`;
    const environment = { LCM_TEST_HARNESS_TMPDIR: parent };
    expect(createTestTempDirectory({
      environment,
      explicitVariable: "LCM_TEST_HARNESS_TMPDIR",
      realpath: (path: string) => path,
      markerProbe: () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
      createDirectory: () => directory,
      secureDirectory: vi.fn(),
    })).toEqual({ root: directory, parent });
    expect(harnessDirectoryFromRecord(
      mount(directory),
      { environment, realpath: (path: string) => path },
    )).toBe(directory);
  });

  it("classifies and reclaims an owned alternate-parent harness directory", async () => {
    const parent = mkdtempSync(join(tmpdir(), "lcm-bug-840-auth-parent-"));
    const directory = mkdtempSync(join(parent, "lcm-postgresql-harness-"));
    const runId = "e".repeat(32);
    const names = createRunNames(runId);
    const owner = {
      pid: 987654,
      birth: "linux:12345678-1234-1234-1234-123456789abc:987654",
      scope: testOwnerScope,
    };
    const records = new Map([
      [`container:${names.container}`, ownershipLabels(runId, "database", owner)],
      [`volume:${names.volume}`, ownershipLabels(runId, "data", owner)],
      [`network:${names.network}`, ownershipLabels(runId, "network", owner)],
    ]);
    const dockerRunner = vi.fn(async (args: string[]) => {
      if (args[1] === "ls") {
        const type = args[0] === "container" ? "container" : args[0];
        return {
          stdout: [...records.keys()]
            .filter((key) => key.startsWith(`${type}:`))
            .map((key) => key.slice(type.length + 1)).join("\n"),
          stderr: "",
        };
      }
      if (args[1] === "inspect") {
        const type = args[0];
        const name = args[2];
        const labels = records.get(`${type}:${name}`);
        if (!labels) throw missingContainerError(name);
        return {
          stdout: JSON.stringify([type === "container"
            ? {
              Config: { Labels: labels },
              State: { Running: false },
              Mounts: [{
                Destination: "/run/lcm-harness",
                Type: "bind",
                RW: false,
                Source: directory,
              }],
            }
            : { Labels: labels }]),
          stderr: "",
        };
      }
      const type = args[0] === "container" ? "container" : args[0];
      records.delete(`${type}:${args.at(-1)}`);
      return { stdout: "", stderr: "" };
    });
    const environment = {
      LCM_TEST_HARNESS_TMPDIR: parent,
      TMPDIR: join(parent, "worker-scratch"),
    };
    try {
      const discovered = await discoverHarnessRuns({
        dockerRunner,
        environment,
        realpath: (path: string) => path,
        processProbe: () => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); },
        readScope: () => testOwnerScope,
        delay: vi.fn(),
      });
      expect(discovered).toMatchObject([{ runId, classification: "stale" }]);
      expect(discovered[0].resources.find((resource) => resource.kind === "database")?.harnessDirectory)
        .toBe(directory);

      const reclaimed = await reclaimProvenOrphans({
        dockerRunner,
        environment,
        realpath: (path: string) => path,
        processProbe: () => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); },
        readScope: () => testOwnerScope,
        delay: vi.fn(),
        removeDirectory: (path: string) => rmSync(path, { recursive: true, force: true }),
      });
      expect(reclaimed).toMatchObject([{ runId, classification: "stale" }]);
      expect(() => lstatSync(directory)).toThrow();

      const unrelated = await discoverHarnessRuns({
        dockerRunner: vi.fn(async (args: string[]) => {
          if (args[1] === "ls") return { stdout: args[0] === "container" ? names.container : "", stderr: "" };
          return {
            stdout: JSON.stringify([{
              Config: { Labels: ownershipLabels(runId, "database", owner) },
              State: { Running: false },
              Mounts: [{ Destination: "/run/lcm-harness", Type: "bind", RW: false, Source: "/unrelated/lcm-postgresql-harness-foreign" }],
            }]),
            stderr: "",
          };
        }),
        environment,
        realpath: (path: string) => path,
        processProbe: () => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); },
        readScope: () => testOwnerScope,
      });
      expect(unrelated[0].resources[0].harnessDirectory).toBeUndefined();
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("resolves a bounded signal-probe readiness timeout", () => {
    expect(resolveSignalProbeReadinessTimeout({})).toBe(
      DEFAULT_SIGNAL_PROBE_READINESS_TIMEOUT_MS,
    );
    expect(resolveSignalProbeReadinessTimeout({
      LCM_TEST_POSTGRES_SIGNAL_READY_TIMEOUT_MS: String(MIN_SIGNAL_PROBE_READINESS_TIMEOUT_MS),
    })).toBe(MIN_SIGNAL_PROBE_READINESS_TIMEOUT_MS);
    expect(resolveSignalProbeReadinessTimeout({
      LCM_TEST_POSTGRES_SIGNAL_READY_TIMEOUT_MS: String(MAX_SIGNAL_PROBE_READINESS_TIMEOUT_MS),
    })).toBe(MAX_SIGNAL_PROBE_READINESS_TIMEOUT_MS);
  });

  it.each([
    "",
    " ",
    "0",
    "0999",
    "999",
    "1000.5",
    "1e3",
    "+1000",
    String(MAX_SIGNAL_PROBE_READINESS_TIMEOUT_MS + 1),
    "9007199254740993",
  ])("rejects invalid signal-probe readiness timeout %j", (value) => {
    expect(() => resolveSignalProbeReadinessTimeout({
      LCM_TEST_POSTGRES_SIGNAL_READY_TIMEOUT_MS: value,
    })).toThrow("invalid PostgreSQL signal probe readiness timeout");
  });

  it("exposes a deterministic cleanup-failure marker without changing signal exit conventions", () => {
    expect(signalCleanupFailed("PostgreSQL harness signal probe ready: abc")).toBe(false);
    expect(signalCleanupFailed(`${SIGNAL_CLEANUP_FAILURE_MARKER} sanitized failure`)).toBe(true);
    expect(signalCleanupFailed(new Error(`${SIGNAL_CLEANUP_FAILURE_MARKER} nested`))).toBe(true);
  });

  it("detects a cleanup-failure marker split across stderr chunks", () => {
    const parser = createSignalCleanupDiagnosticParser();
    const split = SIGNAL_CLEANUP_FAILURE_MARKER.length - 7;

    parser.write(`ignored\n${SIGNAL_CLEANUP_FAILURE_MARKER.slice(0, split)}`);
    expect(parser.diagnostic()).toBeUndefined();
    parser.write(`${SIGNAL_CLEANUP_FAILURE_MARKER.slice(split)} split failure\n`);

    expect(parser.diagnostic()).toBe(
      `${SIGNAL_CLEANUP_FAILURE_MARKER} split failure`,
    );
  });

  it("ignores more than the stderr capture limit before a cleanup-failure marker", () => {
    const parser = createSignalCleanupDiagnosticParser();

    parser.write(Buffer.alloc(MAX_CAPTURED_OUTPUT_BYTES + 256, "x"));
    expect(parser.diagnostic()).toBeUndefined();
    expect(parser.retainedByteCount()).toBeLessThan(SIGNAL_CLEANUP_FAILURE_MARKER.length);
    parser.write(`${SIGNAL_CLEANUP_FAILURE_MARKER} late failure\n`);

    expect(parser.diagnostic()).toBe(
      `${SIGNAL_CLEANUP_FAILURE_MARKER} late failure`,
    );
  });

  it("retains bounded multiline marker-relative cleanup diagnostics", () => {
    const parser = createSignalCleanupDiagnosticParser();
    const multiline = [
      `${SIGNAL_CLEANUP_FAILURE_MARKER} PostgreSQL harness cleanup failed`,
      "runner inspect failed",
      "volume remove failed",
    ].join("\n");

    parser.write(multiline.slice(0, multiline.indexOf("runner")));
    parser.write(`${multiline.slice(multiline.indexOf("runner"))}\n`);
    parser.write("x".repeat(MAX_CAPTURED_OUTPUT_BYTES));
    parser.write("ignored after the diagnostic bound");

    const diagnostic = parser.diagnostic();
    expect(diagnostic).toContain(multiline);
    expect(Buffer.byteLength(diagnostic!)).toBe(MAX_CAPTURED_OUTPUT_BYTES);
    expect(parser.retainedByteCount()).toBe(MAX_CAPTURED_OUTPUT_BYTES);
  });

  it("shares one in-flight operation across concurrent callers", async () => {
    let finish!: () => void;
    const operation = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const singleFlight = createSingleFlightOperation(operation);

    const first = singleFlight();
    const second = singleFlight();

    expect(second).toBe(first);
    expect(operation).toHaveBeenCalledOnce();
    finish();
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
  });

  it.each([
    ["SIGINT", 130],
    ["SIGHUP", 129],
    ["SIGTERM", 143],
  ] as const)("waits for a backpressured diagnostic flush before exiting on %s", async (signal, code) => {
    const stream = new EventEmitter() as EventEmitter & {
      write(message: string, callback: (error?: Error | null) => void): boolean;
    };
    let flush!: () => void;
    stream.write = vi.fn((_message, callback) => {
      flush = callback;
      return false;
    });
    const events: string[] = [];
    const diagnostic = writeHarnessDiagnostic(
      `${SIGNAL_CLEANUP_FAILURE_MARKER} sanitized failure\n`,
      { stream },
    );
    const completion = completeSignalExit(signal, () => diagnostic, {
      removeSignalHandlers: () => events.push("remove"),
      exit: (exitCode: number) => events.push(`exit:${exitCode}`),
    });

    await Promise.resolve();
    expect(events).toEqual([]);
    flush();
    await completion;

    expect(stream.write).toHaveBeenCalledWith(
      `${SIGNAL_CLEANUP_FAILURE_MARKER} sanitized failure\n`,
      expect.any(Function),
    );
    expect(events).toEqual(["remove", `exit:${code}`]);
  });

  it("keeps the error listener until a failed write callback emits its paired stream error", async () => {
    const errored = new EventEmitter() as EventEmitter & {
      write(message: string, callback: (error?: Error | null) => void): boolean;
    };
    let writeCallback!: (error?: Error | null) => void;
    errored.write = vi.fn((_message, callback) => {
      writeCallback = callback;
      return false;
    });
    const exit = vi.fn();
    const diagnostic = writeHarnessDiagnostic("sanitized\n", { stream: errored });
    const completion = completeSignalExit("SIGTERM", () => diagnostic, { exit });

    writeCallback(new Error("private write callback failure"));
    await Promise.resolve();
    expect(errored.listenerCount("error")).toBe(1);
    expect(exit).not.toHaveBeenCalled();

    errored.emit("error", new Error("private paired stream failure"));
    await expect(completion).resolves.toBeUndefined();
    expect(errored.listenerCount("error")).toBe(0);
    expect(exit).toHaveBeenCalledWith(143);
  });

  it("handles a real Writable failed write and synchronous write failure", async () => {
    const writable = new Writable({
      write(_chunk, _encoding, callback) {
        callback(new Error("private real Writable failure"));
      },
    });
    await expect(writeHarnessDiagnostic("sanitized\n", { stream: writable }))
      .resolves.toBeUndefined();
    expect(writable.listenerCount("error")).toBe(0);

    const throwing = new EventEmitter() as EventEmitter & {
      write(message: string, callback: (error?: Error | null) => void): boolean;
    };
    throwing.write = vi.fn(() => {
      throw new Error("private synchronous failure");
    });
    await expect(writeHarnessDiagnostic("sanitized\n", { stream: throwing }))
      .resolves.toBeUndefined();
    expect(throwing.listenerCount("error")).toBe(0);
  });

  it("bounds a stalled diagnostic flush without exposing stream failures", async () => {
    const stream = new EventEmitter() as EventEmitter & {
      write(message: string, callback: (error?: Error | null) => void): boolean;
    };
    stream.write = vi.fn(() => false);
    let expire!: () => void;
    const scheduleTimeout = vi.fn((callback: () => void, timeoutMs: number) => {
      expire = callback;
      expect(timeoutMs).toBe(SIGNAL_DIAGNOSTIC_FLUSH_TIMEOUT_MS);
      return 42;
    });
    const cancelTimeout = vi.fn();
    const completion = writeHarnessDiagnostic("sanitized\n", {
      stream,
      scheduleTimeout,
      cancelTimeout,
    });

    await Promise.resolve();
    expect(cancelTimeout).not.toHaveBeenCalled();
    expire();
    await expect(completion).resolves.toBeUndefined();
    expect(cancelTimeout).toHaveBeenCalledWith(42);
    expect(stream.listenerCount("error")).toBe(0);
  });

  it("incrementally registers exact allocation markers across arbitrary boundaries", () => {
    const first = "a".repeat(32);
    const second = "b".repeat(32);
    const runIds = new Set<string>();
    const parser = createHarnessAllocationMarkerParser(runIds);
    const firstMarker = `${HARNESS_ALLOCATION_MARKER} ${first}\n`;

    for (const character of firstMarker) parser.write(character);
    parser.write(
      "PostgreSQL harness startup failed: injected failure\n"
      + `${HARNESS_ALLOCATION_MARKER} malformed-secret\n`
      + `${HARNESS_ALLOCATION_MARKER} ${first}\n`
      + `${HARNESS_ALLOCATION_MARKER} ${second}`,
    );
    parser.end();

    expect([...runIds]).toEqual([first, second]);
    expect(parser.retainedCharacterCount()).toBe(0);
  });

  it("keeps allocation parsing bounded across large noisy chunk sequences", () => {
    const runId = "c".repeat(32);
    const secret = "private-docker-output";
    const runIds = new Set<string>();
    const parser = createHarnessAllocationMarkerParser(runIds);

    parser.write(`${"x".repeat(MAX_HARNESS_ALLOCATION_MARKER_LINE_LENGTH - 1)}😀`);
    expect(parser.retainedCharacterCount()).toBe(0);
    for (let index = 0; index < 2_000; index += 1) {
      parser.write(`${secret}-😀-${index}`);
      expect(parser.retainedCharacterCount()).toBeLessThanOrEqual(
        MAX_HARNESS_ALLOCATION_MARKER_LINE_LENGTH,
      );
    }
    parser.write("\nnoise\nPostgreSQL harness allo");
    parser.write(`cated run: ${runId}\n`);
    parser.write(`${HARNESS_ALLOCATION_MARKER} ${"d".repeat(31)}z\n`);
    parser.end();

    expect([...runIds]).toEqual([runId]);
    expect(parser.retainedCharacterCount()).toBe(0);
  });

  it("audits every resource class and run after earlier failures without exposing runner output", async () => {
    const first = "a".repeat(32);
    const second = "b".repeat(32);
    const secret = "private-docker-socket";
    const calls: string[][] = [];
    const dockerRunner = vi.fn(async (args: string[]) => {
      calls.push(args);
      const runId = args.at(-1)?.split("=").at(-1);
      const resourceClass = args[0] === "ps" ? "container" : args[0];
      if (runId === first && resourceClass === "container") {
        throw new Error(`cannot access ${secret}`);
      }
      if (runId === second && resourceClass === "network") {
        return { stdout: `leaked-id-${secret}`, stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });

    const failure = await auditHarnessRunResources(
      [first, second],
      dockerRunner,
    ).catch((error: unknown) => error);

    expect(calls).toHaveLength(6);
    expect(calls.map((args) => [
      args.at(-1)?.endsWith(first) ? first : second,
      args[0] === "ps" ? "container" : args[0],
    ])).toEqual([
      [first, "container"],
      [first, "network"],
      [first, "volume"],
      [second, "container"],
      [second, "network"],
      [second, "volume"],
    ]);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toHaveLength(2);
    expect(String(failure)).not.toContain(secret);
    expect((failure as AggregateError).errors.map(String).join("\n")).not.toContain(secret);
  });

  it("uses exact digest-pinned images and a namespaced label", () => {
    expect(POSTGRES_IMAGE).toMatch(/^postgres:18\.4-bookworm@sha256:[0-9a-f]{64}$/u);
    expect(NODE_IMAGE).toMatch(/^node:22\.20\.0-bookworm-slim@sha256:[0-9a-f]{64}$/u);
    expect(RUN_LABEL).toBe("com.donadiosolutions.lcm.postgresql-test-run");
    expect(OWNER_SCHEMA_VERSION).toBe("2");
    expect(new Set([
      RUN_LABEL,
      OWNER_SCHEMA_LABEL,
      OWNER_PID_LABEL,
      OWNER_BIRTH_LABEL,
      OWNER_SCOPE_LABEL,
      RESOURCE_KIND_LABEL,
    ]).size).toBe(6);
  });

  it("derives an owner birth fingerprint from boot ID and the Linux process start field", () => {
    const bootId = "12345678-1234-1234-1234-123456789abc";
    const statFields = ["S", ...Array.from({ length: 18 }, () => "0"), "98765", "0"];
    const readFile = vi.fn((path: string) => {
      if (path.endsWith("machine-id")) return `${"f".repeat(32)}\n`;
      return path.endsWith("boot_id")
        ? `${bootId}\n`
        : `42 (worker with ) parenthesis) ${statFields.join(" ")}\n`;
    });

    expect(readProcessBirthFingerprint(42, { readFile })).toBe(`linux:${bootId}:98765`);
    expect(createOwnerIdentity(42, {
      readFile,
      readLink: () => "pid:[4026531836]",
    })).toEqual({
      pid: 42,
      birth: `linux:${bootId}:98765`,
      scope: expect.stringMatching(
        new RegExp(`^linux:[0-9a-f]{64}:${bootId}:pid:\\[4026531836\\]$`, "u"),
      ),
    });
    expect(() => readProcessBirthFingerprint(0, { readFile })).toThrow("owner PID");
    expect(() => readProcessBirthFingerprint(42, { readFile: () => "unsupported" }))
      .toThrow("unsupported");
    const darwinExec = vi.fn(() => "Fri Jul 24 21:00:00 2026\n");
    expect(readProcessBirthFingerprint(42, {
      platform: () => "darwin",
      execFile: darwinExec,
    })).toBe("darwin:Fri Jul 24 21:00:00 2026");
    expect(darwinExec).toHaveBeenCalledWith(
      "ps",
      ["-o", "lstart=", "-p", "42"],
      expect.objectContaining({
        env: expect.objectContaining({ LANG: "C", LC_ALL: "C", TZ: "UTC" }),
      }),
    );
    expect(readProcessBirthFingerprint(42, {
      platform: () => "win32",
      execFile: vi.fn(() => "2026-07-25T00:00:00.0000000Z\n"),
    })).toBe("win32:2026-07-25T00:00:00.0000000Z");
    expect(() => readProcessBirthFingerprint(42, {
      readFile: (path: string) => {
        throw Object.assign(new Error(path), { code: "ENOENT" });
      },
    })).toThrow("boot identity");
  });

  it("classifies only matching process identity as live and fails closed on ambiguous evidence", () => {
    const owner = { pid: 42, birth: "boot:100", scope: testOwnerScope };
    const processProbe = vi.fn();
    const readScope = () => testOwnerScope;
    expect(classifyOwnerIdentity(owner, { processProbe, readFingerprint: () => "boot:100", readScope })).toBe("live");
    expect(classifyOwnerIdentity(owner, { processProbe, readFingerprint: () => "boot:200", readScope })).toBe("stale");
    expect(classifyOwnerIdentity(owner, {
      processProbe,
      readFingerprint: () => { throw Object.assign(new Error("gone"), { code: "ENOENT" }); },
      readScope,
    })).toBe("ambiguous");
    expect(classifyOwnerIdentity(owner, {
      processProbe,
      readFingerprint: () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); },
      readScope,
    })).toBe("ambiguous");
    expect(classifyOwnerIdentity(owner, {
      processProbe: () => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); },
      readFingerprint: vi.fn(),
      readScope,
    })).toBe("stale");
    expect(classifyOwnerIdentity(owner, {
      processProbe,
      readFingerprint: vi.fn(),
      readScope: () => `linux:${"b".repeat(64)}:${testBootId}:pid:[4026531836]`,
    })).toBe("ambiguous");
    expect(classifyOwnerIdentity(owner, {
      processProbe,
      readFingerprint: vi.fn(),
      readScope: () => `linux:${"a".repeat(64)}:${testBootId}:pid:[4026532000]`,
    })).toBe("ambiguous");
    expect(classifyOwnerIdentity(owner, {
      processProbe,
      readFingerprint: vi.fn(),
      readScope: () => `linux:${"a".repeat(64)}:abcdefab-1234-1234-1234-123456789abc:pid:[4026532000]`,
    })).toBe("stale");
  });

  it("binds Linux ownership to the machine, boot, and PID namespace", () => {
    expect(readOwnerScopeFingerprint({
      platform: () => "linux",
      readFile: (path: string) => path.endsWith("machine-id") ? "f".repeat(32) : testBootId,
      readLink: () => "pid:[4026531836]",
    })).toMatch(new RegExp(
      `^linux:[0-9a-f]{64}:${testBootId}:pid:\\[4026531836\\]$`,
      "u",
    ));
    expect(() => readOwnerScopeFingerprint({
      platform: () => "freebsd",
      execFile: vi.fn(),
    })).toThrow("unsupported PostgreSQL harness process scope platform");
  });

  it("records explicit ambiguous consumer evidence when birth identity is unavailable", () => {
    const writeFile = vi.fn();
    const record = recordConsumerIdentity("/private/consumer-owner.json", 42, {
      createIdentity: () => { throw new Error("unsupported"); },
      writeFile,
    });
    expect(record).toEqual({ version: 1, ambiguous: true });
    expect(writeFile).toHaveBeenCalledWith(
      "/private/consumer-owner.json",
      `${JSON.stringify(record)}\n`,
      { mode: 0o600 },
    );

    expect(recordConsumerIdentity("/private/consumer-owner.json", 42, {
      createIdentity: () => ({
        pid: 42,
        birth: "darwin:Fri Jul 24 21:00:00 2026",
        scope: `darwin:${"a".repeat(64)}`,
      }),
      writeFile: vi.fn(),
    })).toEqual({
      version: 1,
      pid: 42,
      birth: "darwin:Fri Jul 24 21:00:00 2026",
      scope: `darwin:${"a".repeat(64)}`,
    });

    expect(recordAmbiguousConsumerIdentity("/private/consumer-owner.json", {
      writeFile,
    })).toEqual({ version: 1, ambiguous: true });
  });

  it("rejects calendar-impossible process birth fingerprints", () => {
    expect(isValidProcessBirthFingerprint(
      "linux:12345678-1234-1234-1234-123456789abc:1",
    )).toBe(true);
    expect(isValidProcessBirthFingerprint("darwin:Fri Jul 24 21:00:00 2026")).toBe(true);
    expect(isValidProcessBirthFingerprint("win32:2024-02-29T00:00:00.0000000Z")).toBe(true);
    expect(isValidProcessBirthFingerprint("darwin:Thu Jul 24 21:00:00 2026")).toBe(false);
    expect(isValidProcessBirthFingerprint("win32:2026-02-31T00:00:00.0000000Z")).toBe(false);
    expect(isValidProcessBirthFingerprint("win32:2026-02-28T24:00:00.0000000Z")).toBe(false);
    expect(processIdentityEvidenceConsistent(
      `linux:${testBootId}:1`,
      testOwnerScope,
    )).toBe(true);
    expect(processIdentityEvidenceConsistent(
      "linux:abcdefab-1234-1234-1234-123456789abc:1",
      testOwnerScope,
    )).toBe(false);
    expect(processIdentityEvidenceConsistent(
      "darwin:Fri Jul 24 21:00:00 2026",
      testOwnerScope,
    )).toBe(false);
  });

  it("derives and validates every resource name from a random-style run ID", () => {
    const runId = "a".repeat(32);
    const names = createRunNames(runId);
    expect(() => validateRunNames(names, runId)).not.toThrow();
    expect(names).toEqual({
      container: `lcm-pg-${"a".repeat(20)}`,
      network: `lcm-pg-net-${"a".repeat(20)}`,
      volume: `lcm-pg-data-${"a".repeat(20)}`,
      restore: `lcm-pg-restore-${"a".repeat(20)}`,
      runner: `lcm-pg-runner-${"a".repeat(20)}`,
      alias: `lcm-pg-${"a".repeat(20)}.test`,
      wrongAlias: `lcm-pg-wrong-${"a".repeat(20)}.test`,
      controlDatabase: `lcm_harness_${"a".repeat(20)}`,
    });
    expect(() => validateRunNames(names, "not-random")).toThrow("run ID");
    expect(() => validateRunNames({ ...names, volume: "foreign-volume" }, runId)).toThrow("volume");
  });

  it("fails closed with context when a configured template archive cannot be resolved", () => {
    const missing = "/cache/missing-postgresql-template.tar";
    const missingError = Object.assign(new Error("not found"), { code: "ENOENT" });
    expect(resolveConfiguredTemplateArchive("  ")).toBe("");
    expect(() => resolveConfiguredTemplateArchive(missing, {
      realpath: () => { throw missingError; },
    })).toThrow(`configured PostgreSQL template archive could not be resolved: ${missing}`);
    expect(() => resolveConfiguredTemplateArchive("/cache/template.tar", {
      realpath: () => "/resolved/template.tar",
      stat: () => ({ isFile: () => false }),
    })).toThrow("configured PostgreSQL template archive is not a regular file: /resolved/template.tar");
    expect(resolveConfiguredTemplateArchive("/cache/template.tar", {
      realpath: () => "/resolved/template.tar",
      stat: () => ({ isFile: () => true }),
    })).toBe("/resolved/template.tar");
  });

  it("isolates Vitest caches by validated harness run ID", () => {
    const firstRunId = "a".repeat(32);
    const secondRunId = "b".repeat(32);
    const first = postgresqlVitestCacheDir({ LCM_TEST_POSTGRES_RUN_ID: firstRunId }, 11);
    const second = postgresqlVitestCacheDir({ LCM_TEST_POSTGRES_RUN_ID: secondRunId }, 11);
    const fallback = postgresqlVitestCacheDir({ LCM_TEST_POSTGRES_RUN_ID: "../../shared" }, 73);

    expect(first).not.toBe(second);
    expect(first).toMatch(new RegExp(`${firstRunId}$`, "u"));
    expect(second).toMatch(new RegExp(`${secondRunId}$`, "u"));
    expect(fallback).toMatch(/vitest-lcm-postgresql-cache\/process-73$/u);
    expect(fallback).not.toContain("shared");
  });

  it("redacts credentials, URLs, private paths, and PEM material", () => {
    const output = sanitizeHarnessText(
      "password-value /private/harness postgresql://user:pass@example.test/db\n-----BEGIN PRIVATE KEY-----\nprivate-key-material\n-----END PRIVATE KEY-----",
      ["password-value", "/private/harness"],
    );
    expect(output).toContain("[REDACTED]");
    expect(output).toContain("[REDACTED PEM]");
    for (const secret of ["password-value", "/private/harness", "user:pass", "private-key-material"]) {
      expect(output).not.toContain(secret);
    }
    expect(sanitizeHarnessText("plain output", [""])).toBe("plain output");
  });

  it("captures bounded child output and rejects failed or missing commands", async () => {
    await expect(runProcess(process.execPath, ["-e", "process.stdout.write(' ok '); process.stderr.write(' note ')"]))
      .resolves.toEqual({
        stdout: "ok",
        stderr: "note",
        stdoutTruncated: false,
        stderrTruncated: false,
      });
    await expect(runProcess(process.execPath, ["-e", "process.stderr.write('failed'); process.exit(7)"]))
      .rejects.toMatchObject({ code: 7, stderr: "failed" });
    const oversizedTail = "tail-diagnostic";
    const oversized = `process.stdout.write('discarded-stdout-prefix' + 'x'.repeat(${MAX_CAPTURED_OUTPUT_BYTES + 256}) + '${oversizedTail}'); process.stderr.write('discarded-stderr-prefix' + 'y'.repeat(${MAX_CAPTURED_OUTPUT_BYTES + 256}) + '${oversizedTail}'); process.exit(9)`;
    const error = await runProcess(process.execPath, ["-e", oversized]).catch((reason: unknown) => reason) as {
      stdout: string;
      stderr: string;
    };
    expect(Buffer.byteLength(error.stdout)).toBe(MAX_CAPTURED_OUTPUT_BYTES);
    expect(Buffer.byteLength(error.stderr)).toBe(MAX_CAPTURED_OUTPUT_BYTES);
    expect(error.stdout.endsWith(oversizedTail)).toBe(true);
    expect(error.stderr.endsWith(oversizedTail)).toBe(true);
    expect(error.stdout).not.toContain("discarded-stdout-prefix");
    expect(error.stderr).not.toContain("discarded-stderr-prefix");
    await expect(runProcess("lcm-command-that-does-not-exist", []))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("waits for close and captures output delivered after child exit", async () => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    });
    const spawnProcess = vi.fn(() => child);
    let settled = false;
    const operation = runProcess("docker", ["inspect", "owned"], { spawnProcess });
    void operation.finally(() => { settled = true; });

    child.stdout.emit("data", "before-exit ");
    child.emit("exit", 0, null);
    await Promise.resolve();
    expect(settled).toBe(false);

    child.stdout.emit("data", Buffer.from("final-stdout"));
    child.stderr.emit("data", " final-stderr ");
    child.emit("close", 0, null);

    await expect(operation).resolves.toEqual({
      stdout: "before-exit final-stdout",
      stderr: "final-stderr",
      stdoutTruncated: false,
      stderrTruncated: false,
    });
    expect(spawnProcess).toHaveBeenCalledWith("docker", ["inspect", "owned"], {
      cwd: undefined,
      detached: false,
      env: undefined,
      stdio: ["ignore", "pipe", "pipe"],
    });
  });

  it("always captures child output even when inherited stdio is requested", async () => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    });
    const spawnProcess = vi.fn(() => child);
    const operation = runProcess("docker", ["start", "--attach", "owned"], {
      spawnProcess,
      stdio: "inherit",
    });
    child.emit("close", 0, null);

    await expect(operation).resolves.toMatchObject({ stdout: "", stderr: "" });
    expect(spawnProcess).toHaveBeenCalledWith("docker", ["start", "--attach", "owned"], {
      cwd: undefined,
      detached: false,
      env: undefined,
      stdio: ["ignore", "pipe", "pipe"],
    });
  });

  it("preserves an onSpawn failure when best-effort child termination also fails", async () => {
    const onSpawnFailure = new Error("consumer registration failed");
    const child = {
      kill: vi.fn(() => { throw Object.assign(new Error("already exited"), { code: "ESRCH" }); }),
    };

    await expect(runProcess("node", ["vitest"], {
      spawnProcess: () => child,
      onSpawn: () => { throw onSpawnFailure; },
    })).rejects.toBe(onSpawnFailure);
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it("bounds stream tails and settles only once across error, close, and kill paths", async () => {
    const failedChild = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    });
    const spawnFailure = new Error("spawn aborted");
    const failed = runProcess("docker", ["start"], { spawnProcess: () => failedChild });
    failedChild.emit("error", spawnFailure);
    failedChild.emit("close", 0, null);
    await expect(failed).rejects.toBe(spawnFailure);

    const killedChild = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    });
    const killed = runProcess("docker", ["logs"], { spawnProcess: () => killedChild });
    killedChild.stdout.emit("data", Buffer.alloc(MAX_CAPTURED_OUTPUT_BYTES + 8, "x"));
    killedChild.stdout.emit("data", "stdout-tail");
    killedChild.stderr.emit("data", Buffer.alloc(MAX_CAPTURED_OUTPUT_BYTES - 4, "y"));
    killedChild.stderr.emit("data", "stderr-tail");
    killedChild.emit("close", null, "SIGTERM");

    const error = await killed.catch((reason: unknown) => reason) as {
      code: number | null;
      signal: string;
      stdout: string;
      stderr: string;
    };
    expect(error).toMatchObject({ code: null, signal: "SIGTERM" });
    expect(Buffer.byteLength(error.stdout)).toBe(MAX_CAPTURED_OUTPUT_BYTES);
    expect(Buffer.byteLength(error.stderr)).toBe(MAX_CAPTURED_OUTPUT_BYTES);
    expect(error.stdout.endsWith("stdout-tail")).toBe(true);
    expect(error.stderr.endsWith("stderr-tail")).toBe(true);
    expect(error).toMatchObject({ stdoutTruncated: true, stderrTruncated: true });
  });

  it("redacts successful and failed child output before surfacing it", async () => {
    const secret = "run-scoped-password";
    const privatePath = "/private/harness-secret";
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const successRunner = vi.fn().mockResolvedValue({
      stdout: `connected with ${secret}`,
      stderr: `certificate at ${privatePath}`,
      stdoutTruncated: false,
      stderrTruncated: false,
    });

    await expect(runSanitizedProcess("node", ["vitest.mjs"], {
      processRunner: successRunner,
      secrets: [secret, privatePath],
      stdout,
      stderr,
    })).resolves.toEqual({
      stdout: "connected with [REDACTED]",
      stderr: "certificate at [REDACTED]",
    });
    expect(stdout.write).toHaveBeenCalledWith("connected with [REDACTED]\n");
    expect(stderr.write).toHaveBeenCalledWith("certificate at [REDACTED]\n");

    const failure = Object.assign(new Error("docker failed"), {
      stdout: `runner used ${secret}`,
      stderr: `postgresql://user:${secret}@database.test/lcm`,
      stdoutTruncated: false,
      stderrTruncated: false,
    });
    const failureRunner = vi.fn().mockRejectedValue(failure);
    await expect(runSanitizedProcess("docker", ["start", "--attach", "runner"], {
      processRunner: failureRunner,
      secrets: [secret],
      stdout,
      stderr,
    })).rejects.toBe(failure);
    expect(failure).toMatchObject({
      stdout: "runner used [REDACTED]",
      stderr: "postgresql://[REDACTED]",
    });
    expect(stdout.write).toHaveBeenLastCalledWith("runner used [REDACTED]\n");
    expect(stderr.write).toHaveBeenLastCalledWith("postgresql://[REDACTED]\n");
    expect(stdout.write.mock.calls.flat().join(" ")).not.toContain(secret);
    expect(stderr.write.mock.calls.flat().join(" ")).not.toContain(secret);
  });

  it("fails closed without surfacing truncated or expanded sanitized output", async () => {
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const truncatedRunner = vi.fn().mockResolvedValue({
      stdout: "unsafe-tail",
      stderr: "",
      stdoutTruncated: true,
      stderrTruncated: false,
    });

    await expect(runSanitizedProcess("node", ["vitest.mjs"], {
      processRunner: truncatedRunner,
      stdout,
      stderr,
    })).rejects.toThrow("safe capture limit");
    expect(stdout.write).not.toHaveBeenCalled();
    expect(stderr.write).not.toHaveBeenCalled();

    const expandedRunner = vi.fn().mockResolvedValue({
      stdout: "x".repeat(MAX_CAPTURED_OUTPUT_BYTES),
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
    });
    await expect(runSanitizedProcess("docker", ["start", "--attach", "runner"], {
      processRunner: expandedRunner,
      secrets: ["x"],
      stdout,
      stderr,
    })).rejects.toThrow("sanitized output exceeded");
    expect(stdout.write).not.toHaveBeenCalled();
    expect(stderr.write).not.toHaveBeenCalled();
  });

  it("captures attached runner output and propagates output-stream errors", async () => {
    const processRunner = vi.fn().mockResolvedValue({
      stdout: "attached runner passed",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
    });
    const writeFailure = new Error("output stream unavailable");
    const stdout = { write: vi.fn(() => { throw writeFailure; }) };
    const stderr = { write: vi.fn() };

    await expect(runSanitizedProcess("docker", ["start", "--attach", "lcm-pg-runner"], {
      processRunner,
      stdout,
      stderr,
    })).rejects.toBe(writeFailure);
    expect(processRunner).toHaveBeenCalledWith(
      "docker",
      ["start", "--attach", "lcm-pg-runner"],
      {},
    );
    expect(stdout.write).toHaveBeenCalledWith("attached runner passed\n");
    expect(stderr.write).not.toHaveBeenCalled();
  });

  it("quiesces in-flight setup before cleanup and rejects later setup", async () => {
    let finishCreation!: () => void;
    let resourceExists = false;
    const creationBlocked = new Promise<void>((resolve) => {
      finishCreation = () => {
        resourceExists = true;
        resolve();
      };
    });
    const lifecycle = createProcessLifecycle(() => creationBlocked);
    const creation = lifecycle.run("docker", ["network", "create"]);
    let stopped = false;
    const stopping = lifecycle.stop().then(() => { stopped = true; });

    await Promise.resolve();
    expect(stopped).toBe(false);
    finishCreation();
    await expect(creation).resolves.toBeUndefined();
    await stopping;
    expect(resourceExists).toBe(true);
    await expect(lifecycle.run("docker", ["volume", "create"]))
      .rejects.toThrow("setup is stopping");
  });

  it("terminates a tracked test consumer before waiting for setup quiescence", async () => {
    let finish!: () => void;
    const child = {
      kill: vi.fn((signal: string) => {
        expect(signal).toBe("SIGTERM");
        finish();
        return true;
      }),
    };
    const lifecycle = createProcessLifecycle((_command, _args, options) => {
      options.onSpawn(child);
      return new Promise<void>((resolve) => { finish = resolve; });
    });
    const consumer = lifecycle.run("node", ["vitest"], { terminateOnStop: true });

    await expect(lifecycle.stop()).resolves.toBeUndefined();
    await expect(consumer).resolves.toBeUndefined();
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it("terminates the complete detached consumer process group", async () => {
    let finish!: () => void;
    const child = { pid: 321, kill: vi.fn() };
    const signalProcess = vi.fn((pid: number, signal: string) => {
      expect(pid).toBe(-321);
      expect(signal).toBe("SIGTERM");
      finish();
    });
    const lifecycle = createProcessLifecycle((_command, _args, options) => {
      expect(options.detached).toBe(true);
      options.onSpawn(child);
      return new Promise<void>((resolve) => { finish = resolve; });
    }, {
      platform: () => "linux",
      signalProcess,
      processTreeAlive: () => false,
    });
    const consumer = lifecycle.run("node", ["vitest"], {
      terminateOnStop: true,
      terminateProcessTree: true,
    });

    await expect(lifecycle.stop()).resolves.toBeUndefined();
    await expect(consumer).resolves.toBeUndefined();
    expect(signalProcess).toHaveBeenCalledWith(-321, "SIGTERM");
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("retains process-group escalation after the leader settles", async () => {
    const child = { pid: 654, kill: vi.fn() };
    const signals: Array<number | string> = [];
    let alive = true;
    const signalProcess = vi.fn((_pid: number, signal: number | string) => {
      signals.push(signal);
      if (signal === "SIGKILL") alive = false;
    });
    const processTreeAlive = vi.fn(() => alive);
    const lifecycle = createProcessLifecycle((_command, _args, options) => {
      options.onSpawn(child);
      return Promise.resolve();
    }, {
      platform: () => "linux",
      signalProcess,
      processTreeAlive,
      delay: vi.fn().mockResolvedValue(undefined),
      treeGraceAttempts: 1,
      treeKillAttempts: 1,
    });
    const consumer = lifecycle.run("node", ["vitest"], {
      terminateOnStop: true,
      terminateProcessTree: true,
    });

    await expect(consumer).resolves.toBeUndefined();
    await expect(lifecycle.stop()).resolves.toBeUndefined();
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it.each([
    ["container", "Error response from daemon: No such container: owned-resource"],
    ["network", "Error response from daemon: network owned-resource not found"],
    ["volume", "Error response from daemon: get owned-resource: no such volume"],
  ])("ignores only an exact missing %s inspection", async (type, stderr) => {
    const missing = Object.assign(new Error("docker failed"), { code: 1, stdout: "[]\n", stderr: `${stderr}\n` });
    const dockerRunner = vi.fn().mockRejectedValue(missing);

    expect(isMissingDockerObjectError(missing, type, "owned-resource")).toBe(true);
    await expect(removeLabeled(type, "owned-resource", "a".repeat(32), dockerRunner)).resolves.toBeUndefined();
    expect(dockerRunner).toHaveBeenCalledOnce();
  });

  it("recognizes verified absence across non-semantic Docker formatting changes", () => {
    const missing = Object.assign(new Error("docker failed"), {
      code: 125,
      stdout: "",
      stderr: "WARNING: daemon compatibility mode is enabled\r\nError: No such container: owned-resource\r\n",
    });

    expect(isMissingDockerObjectError(missing, "container", "owned-resource")).toBe(true);
  });

  it("propagates inspection failures that do not prove absence", async () => {
    const secret = "cleanup-secret";
    const failure = Object.assign(new Error("docker failed"), {
      code: 1,
      stdout: "",
      stderr: `permission denied for ${secret}`,
    });
    const dockerRunner = vi.fn().mockRejectedValue(failure);

    expect(isMissingDockerObjectError(failure, "container", "owned-resource")).toBe(false);
    expect(isMissingDockerObjectError(failure, "image", "owned-resource")).toBe(false);
    expect(isMissingDockerObjectError({ ...failure, code: 0 }, "container", "owned-resource")).toBe(false);
    expect(isMissingDockerObjectError({ ...failure, code: null }, "container", "owned-resource")).toBe(false);
    expect(isMissingDockerObjectError({
      ...failure,
      stderr: "permission denied\nError response from daemon: No such container: owned-resource",
    }, "container", "owned-resource")).toBe(false);
    expect(isMissingDockerObjectError({
      ...failure,
      stderr: "Error response from daemon: No such container: owned-resource-extra",
    }, "container", "owned-resource")).toBe(false);
    await expect(removeLabeled("container", "owned-resource", "a".repeat(32), dockerRunner)).rejects.toBe(failure);
    expect(sanitizeHarnessText(failure.stderr, [secret])).toBe("permission denied for [REDACTED]");
  });

  it("requires an ownership label before issuing an exact removal", async () => {
    const runId = "a".repeat(32);
    const dockerRunner = vi.fn()
      .mockResolvedValueOnce({ stdout: JSON.stringify([{ Config: { Labels: { [RUN_LABEL]: runId } } }]), stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" });

    await expect(removeLabeled("container", "owned-resource", runId, dockerRunner)).resolves.toBeUndefined();
    expect(dockerRunner).toHaveBeenNthCalledWith(1, ["container", "inspect", "owned-resource"]);
    expect(dockerRunner).toHaveBeenNthCalledWith(2, ["container", "rm", "--force", "owned-resource"]);

    const unlabeledRunner = vi.fn().mockResolvedValue({ stdout: JSON.stringify([{ Config: { Labels: {} } }]), stderr: "" });
    await expect(removeLabeled("container", "owned-resource", runId, unlabeledRunner))
      .rejects.toThrow("refusing to remove unlabeled container");
  });

  it("reinspects exact owner labels before every bounded removal attempt", async () => {
    const runId = "a".repeat(32);
    const owner = {
      pid: 42,
      birth: "linux:12345678-1234-1234-1234-123456789abc:100",
      scope: testOwnerScope,
    };
    const labels = ownershipLabels(runId, "database", owner);
    const removalFailure = Object.assign(new Error("resource busy"), {
      code: 1,
      stdout: "",
      stderr: "Error response from daemon: resource busy",
    });
    const dockerRunner = vi.fn(async (args: string[]) => {
      if (args[1] === "inspect") {
        return { stdout: JSON.stringify([{ Config: { Labels: labels } }]), stderr: "" };
      }
      throw removalFailure;
    });
    const delay = vi.fn();

    await expect(removeOwnedResource(
      "container",
      createRunNames(runId).container,
      labels,
      dockerRunner,
      { delay },
    )).rejects.toBe(removalFailure);
    expect(dockerRunner).toHaveBeenCalledTimes(MAX_DOCKER_REMOVE_ATTEMPTS * 2);
    expect(delay).toHaveBeenCalledTimes(MAX_DOCKER_REMOVE_ATTEMPTS - 1);

    const changed = { ...labels, [OWNER_PID_LABEL]: "43" };
    const changedRunner = vi.fn()
      .mockResolvedValueOnce({ stdout: JSON.stringify([{ Config: { Labels: labels } }]), stderr: "" })
      .mockRejectedValueOnce(removalFailure)
      .mockResolvedValueOnce({ stdout: JSON.stringify([{ Config: { Labels: changed } }]), stderr: "" });
    await expect(removeOwnedResource(
      "container",
      createRunNames(runId).container,
      labels,
      changedRunner,
      { delay: vi.fn() },
    )).rejects.toThrow("changed PostgreSQL harness ownership");
    expect(changedRunner).toHaveBeenCalledTimes(3);
  });

  it("discovers live and stale exact runs while preserving malformed or inconsistent labels", async () => {
    const liveRunId = "a".repeat(32);
    const staleRunId = "b".repeat(32);
    const legacyRunId = "c".repeat(32);
    const bootId = "12345678-1234-1234-1234-123456789abc";
    const records = new Map([
      [`network:${createRunNames(liveRunId).network}`, ownershipLabels(
        liveRunId,
        "network",
        { pid: 41, birth: `linux:${bootId}:100`, scope: testOwnerScope },
      )],
      [`volume:${createRunNames(staleRunId).volume}`, ownershipLabels(
        staleRunId,
        "data",
        { pid: 42, birth: `linux:${bootId}:200`, scope: testOwnerScope },
      )],
      [`volume:${createRunNames(legacyRunId).volume}`, {
        ...ownershipLabels(legacyRunId, "data", {
          pid: 43,
          birth: `linux:${bootId}:400`,
          scope: testOwnerScope,
        }),
        [OWNER_BIRTH_LABEL]: "malformed",
      }],
    ]);
    const dockerRunner = vi.fn(async (args: string[]) => {
      if (args[1] === "ls") {
        const type = args[0] === "container" ? "container" : args[0];
        const names = [...records.keys()]
          .filter((key) => key.startsWith(`${type}:`))
          .map((key) => key.slice(type.length + 1));
        return { stdout: names.join("\n"), stderr: "" };
      }
      const type = args[0];
      const labels = records.get(`${type}:${args[2]}`) ?? {};
      return {
        stdout: JSON.stringify([type === "container" ? { Config: { Labels: labels } } : { Labels: labels }]),
        stderr: "",
      };
    });

    const runs = await discoverHarnessRuns({
      dockerRunner,
      processProbe: vi.fn(),
      readFingerprint: (pid: number) => pid === 41 ? `linux:${bootId}:100` : `linux:${bootId}:999`,
      readScope: () => testOwnerScope,
    });
    expect(runs.map((run) => [run.runId, run.classification])).toEqual([
      [liveRunId, "live"],
      [staleRunId, "stale"],
      [legacyRunId, "ambiguous"],
    ]);

    records.set(
      `container:${createRunNames(liveRunId).runner}`,
      ownershipLabels(liveRunId, "runner", {
        pid: 99,
        birth: `linux:${bootId}:300`,
        scope: testOwnerScope,
      }),
    );
    const inconsistent = await discoverHarnessRuns({
      dockerRunner,
      processProbe: vi.fn(),
      readFingerprint: () => `linux:${bootId}:100`,
      readScope: () => testOwnerScope,
    });
    expect(inconsistent.find((run) => run.runId === liveRunId)?.classification).toBe("ambiguous");

    const conflictingRunA = `${"1".repeat(20)}${"a".repeat(12)}`;
    const conflictingRunB = `${"1".repeat(20)}${"b".repeat(12)}`;
    records.clear();
    records.set(
      `network:${createRunNames(conflictingRunA).network}`,
      ownershipLabels(conflictingRunA, "network", {
        pid: 51,
        birth: `linux:${bootId}:500`,
        scope: testOwnerScope,
      }),
    );
    records.set(
      `volume:${createRunNames(conflictingRunB).volume}`,
      ownershipLabels(conflictingRunB, "data", {
        pid: 52,
        birth: `linux:${bootId}:600`,
        scope: testOwnerScope,
      }),
    );
    const conflicting = await discoverHarnessRuns({
      dockerRunner,
      processProbe: vi.fn(),
      readFingerprint: (pid: number) => `linux:${bootId}:${pid === 51 ? 500 : 999}`,
      readScope: () => testOwnerScope,
    });
    expect(conflicting.map((run) => [run.runId, run.classification])).toEqual([
      [conflictingRunA, "ambiguous"],
      [conflictingRunB, "ambiguous"],
    ]);
  });

  it("reclaims only a definitively stale, consistently labeled run in teardown order", async () => {
    const runId = "d".repeat(32);
    const names = createRunNames(runId);
    const owner = {
      pid: 77,
      birth: "linux:12345678-1234-1234-1234-123456789abc:700",
      scope: testOwnerScope,
    };
    const records = new Map([
      [`container:${names.restore}`, ownershipLabels(runId, "restore", owner)],
      [`container:${names.runner}`, ownershipLabels(runId, "runner", owner)],
      [`container:${names.container}`, ownershipLabels(runId, "database", owner)],
      [`volume:${names.volume}`, ownershipLabels(runId, "data", owner)],
      [`network:${names.network}`, ownershipLabels(runId, "network", owner)],
    ]);
    const removals: string[] = [];
    const dockerRunner = vi.fn(async (args: string[]) => {
      if (args[1] === "ls") {
        const type = args[0] === "container" ? "container" : args[0];
        return {
          stdout: [...records.keys()]
            .filter((key) => key.startsWith(`${type}:`))
            .map((key) => key.slice(type.length + 1))
            .join("\n"),
          stderr: "",
        };
      }
      if (args[1] === "inspect") {
        const type = args[0];
        const labels = records.get(`${type}:${args[2]}`) ?? {};
        return {
          stdout: JSON.stringify([type === "container"
            ? {
              Config: { Labels: labels },
              State: { Running: labels[RESOURCE_KIND_LABEL] === "database" },
              Mounts: [],
            }
            : { Labels: labels }]),
          stderr: "",
        };
      }
      const type = args[0];
      const name = args.at(-1)!;
      removals.push(`${type}:${name}`);
      records.delete(`${type === "container" ? "container" : type}:${name}`);
      return { stdout: "", stderr: "" };
    });
    const verifySentinel = vi.fn();
    const removeDirectory = vi.fn();

    const runs = await reclaimProvenOrphans({
      dockerRunner,
      processProbe: vi.fn(),
      readFingerprint: () => `${owner.birth}-reused`,
      readScope: () => testOwnerScope,
      verifySentinel,
      resolveHarnessDirectory: () => "/private/harness",
      removeDirectory,
      delay: vi.fn(),
    });
    expect(runs).toHaveLength(1);
    expect(verifySentinel).toHaveBeenCalledWith(names, runId, dockerRunner);
    expect(removals).toEqual([
      `container:${names.restore}`,
      `container:${names.runner}`,
      `container:${names.container}`,
      `volume:${names.volume}`,
      `network:${names.network}`,
    ]);
    expect(removeDirectory).toHaveBeenCalledWith("/private/harness");
    expect(dockerRunner.mock.calls).toContainEqual([[
      "container", "rm", names.restore,
    ]]);
    expect(dockerRunner.mock.calls).toContainEqual([[
      "container", "rm", names.runner,
    ]]);
  });

  it("preserves an entire stale run when a worker starts after discovery", async () => {
    const runId = "3".repeat(32);
    const names = createRunNames(runId);
    const owner = {
      pid: 73,
      birth: "linux:12345678-1234-1234-1234-123456789abc:730",
      scope: testOwnerScope,
    };
    const records = new Map([
      [`container:${names.runner}`, ownershipLabels(runId, "runner", owner)],
      [`volume:${names.volume}`, ownershipLabels(runId, "data", owner)],
      [`network:${names.network}`, ownershipLabels(runId, "network", owner)],
    ]);
    let runnerInspections = 0;
    const dockerRunner = vi.fn(async (args: string[]) => {
      if (args[1] === "ls") {
        const type = args[0] === "container" ? "container" : args[0];
        return {
          stdout: [...records.keys()]
            .filter((key) => key.startsWith(`${type}:`))
            .map((key) => key.slice(type.length + 1))
            .join("\n"),
          stderr: "",
        };
      }
      if (args[1] === "inspect") {
        const type = args[0];
        const name = args[2];
        const labels = records.get(`${type}:${name}`);
        if (!labels) throw missingContainerError(name);
        if (name === names.runner) runnerInspections += 1;
        return {
          stdout: JSON.stringify([type === "container"
            ? {
              Config: { Labels: labels },
              State: { Running: runnerInspections > 1 },
            }
            : { Labels: labels }]),
          stderr: "",
        };
      }
      throw new Error("reclamation must not mutate a restarted run");
    });

    const runs = await reclaimProvenOrphans({
      dockerRunner,
      processProbe: vi.fn(),
      readFingerprint: () => `${owner.birth}-reused`,
      readScope: () => testOwnerScope,
    });

    expect(runs).toMatchObject([{ runId, classification: "live" }]);
    expect(dockerRunner.mock.calls.some(([args]) => args[1] === "rm")).toBe(false);
    expect(records.size).toBe(3);
  });

  it("preserves a stale run when an initially unlisted canonical worker is running", async () => {
    const runId = "2".repeat(32);
    const names = createRunNames(runId);
    const owner = {
      pid: 72,
      birth: "linux:12345678-1234-1234-1234-123456789abc:720",
      scope: testOwnerScope,
    };
    const records = new Map([
      [`container:${names.container}`, ownershipLabels(runId, "database", owner)],
      [`container:${names.runner}`, ownershipLabels(runId, "runner", owner)],
      [`volume:${names.volume}`, ownershipLabels(runId, "data", owner)],
      [`network:${names.network}`, ownershipLabels(runId, "network", owner)],
    ]);
    const mutationCalls: string[][] = [];
    const dockerRunner = vi.fn(async (args: string[]) => {
      if (args[0] === "container" && args[1] === "ls") {
        return { stdout: names.container, stderr: "" };
      }
      if (args[0] === "volume" && args[1] === "ls") {
        return { stdout: names.volume, stderr: "" };
      }
      if (args[0] === "network" && args[1] === "ls") {
        return { stdout: names.network, stderr: "" };
      }
      if (args[1] === "inspect") {
        const type = args[0];
        const name = args[2];
        const labels = records.get(`${type}:${name}`);
        if (!labels) throw missingContainerError(name);
        return {
          stdout: JSON.stringify([type === "container"
            ? {
              Config: { Labels: labels },
              State: { Running: name === names.runner || name === names.container },
              Mounts: [],
            }
            : { Labels: labels }]),
          stderr: "",
        };
      }
      mutationCalls.push(args);
      throw new Error("a live canonical worker must preserve the whole run");
    });
    const verifySentinel = vi.fn();
    const removeDirectory = vi.fn();

    const runs = await reclaimProvenOrphans({
      dockerRunner,
      processProbe: vi.fn(),
      readFingerprint: () => `${owner.birth}-reused`,
      readScope: () => testOwnerScope,
      verifySentinel,
      resolveHarnessDirectory: () => "/private/harness",
      removeDirectory,
    });

    expect(runs).toMatchObject([{ runId, classification: "live" }]);
    expect(mutationCalls).toEqual([]);
    expect(verifySentinel).not.toHaveBeenCalled();
    expect(removeDirectory).not.toHaveBeenCalled();
    expect(records).toEqual(new Map([
      [`container:${names.container}`, ownershipLabels(runId, "database", owner)],
      [`container:${names.runner}`, ownershipLabels(runId, "runner", owner)],
      [`volume:${names.volume}`, ownershipLabels(runId, "data", owner)],
      [`network:${names.network}`, ownershipLabels(runId, "network", owner)],
    ]));
  });

  it.each(["restore", "runner"] as const)(
    "preserves an entire stale run when a missing %s worker appears live during the stability barrier",
    async (workerKind) => {
      const runId = workerKind === "restore" ? "a".repeat(32) : "b".repeat(32);
      const names = createRunNames(runId);
      const owner = {
        pid: workerKind === "restore" ? 102 : 103,
        birth: `linux:12345678-1234-1234-1234-123456789abc:${workerKind === "restore" ? 1020 : 1030}`,
        scope: testOwnerScope,
      };
      const workerName = names[workerKind];
      const records = new Map([
        [`container:${names.container}`, ownershipLabels(runId, "database", owner)],
        [`volume:${names.volume}`, ownershipLabels(runId, "data", owner)],
        [`network:${names.network}`, ownershipLabels(runId, "network", owner)],
      ]);
      const workerInspections = new Map<string, number>();
      const mutations: string[][] = [];
      const dockerRunner = vi.fn(async (args: string[]) => {
        if (args[1] === "ls") {
          const type = args[0] === "container" ? "container" : args[0];
          return {
            stdout: [...records.keys()]
              .filter((key) => key.startsWith(`${type}:`))
              .map((key) => key.slice(type.length + 1))
              .join("\n"),
            stderr: "",
          };
        }
        if (args[1] === "inspect") {
          const type = args[0];
          const name = args[2];
          const labels = records.get(`${type}:${name}`);
          if (!labels && type === "container") {
            workerInspections.set(name, (workerInspections.get(name) ?? 0) + 1);
            throw missingContainerError(name);
          }
          return {
            stdout: JSON.stringify([type === "container"
              ? {
                Config: { Labels: labels },
                State: { Running: name === names.container || name === workerName },
                Mounts: [],
              }
              : { Labels: labels }]),
            stderr: "",
          };
        }
        mutations.push(args);
        throw new Error("a newly live canonical worker must preserve the whole run");
      });
      const delay = vi.fn(async () => {
        records.set(
          `container:${workerName}`,
          ownershipLabels(runId, workerKind, owner),
        );
      });
      const verifySentinel = vi.fn();
      const removeDirectory = vi.fn();

      const runs = await reclaimProvenOrphans({
        dockerRunner,
        processProbe: vi.fn(),
        readFingerprint: () => `${owner.birth}-reused`,
        readScope: () => testOwnerScope,
        verifySentinel,
        resolveHarnessDirectory: () => "/private/harness",
        removeDirectory,
        delay,
      });

      expect(runs).toMatchObject([{ runId, classification: "live" }]);
      expect(delay).toHaveBeenCalledOnce();
      expect(delay).toHaveBeenCalledWith(ORPHAN_WORKER_STABILITY_DELAY_MS);
      expect(workerInspections.get(workerName)).toBe(1);
      expect(mutations).toEqual([]);
      expect(verifySentinel).not.toHaveBeenCalled();
      expect(removeDirectory).not.toHaveBeenCalled();
      expect(records.has(`container:${names.container}`)).toBe(true);
      expect(records.has(`volume:${names.volume}`)).toBe(true);
      expect(records.has(`network:${names.network}`)).toBe(true);
    },
  );

  it("requires stable absence of both canonical workers before the first mutation", async () => {
    const runId = "c".repeat(32);
    const names = createRunNames(runId);
    const owner = {
      pid: 104,
      birth: "linux:12345678-1234-1234-1234-123456789abc:1040",
      scope: testOwnerScope,
    };
    const records = new Map([
      [`container:${names.container}`, ownershipLabels(runId, "database", owner)],
      [`volume:${names.volume}`, ownershipLabels(runId, "data", owner)],
      [`network:${names.network}`, ownershipLabels(runId, "network", owner)],
    ]);
    const events: string[] = [];
    const dockerRunner = vi.fn(async (args: string[]) => {
      if (args[1] === "ls") {
        const type = args[0] === "container" ? "container" : args[0];
        return {
          stdout: [...records.keys()]
            .filter((key) => key.startsWith(`${type}:`))
            .map((key) => key.slice(type.length + 1))
            .join("\n"),
          stderr: "",
        };
      }
      if (args[1] === "inspect") {
        const type = args[0];
        const name = args[2];
        const labels = records.get(`${type}:${name}`);
        if (!labels && type === "container") {
          events.push(`missing:${name}`);
          throw missingContainerError(name);
        }
        return {
          stdout: JSON.stringify([type === "container"
            ? {
              Config: { Labels: labels },
              State: { Running: name === names.container },
              Mounts: [],
            }
            : { Labels: labels }]),
          stderr: "",
        };
      }
      const type = args[0];
      const name = args.at(-1)!;
      events.push(`remove:${type}:${name}`);
      records.delete(`${type === "container" ? "container" : type}:${name}`);
      return { stdout: "", stderr: "" };
    });
    const delay = vi.fn(async (milliseconds: number) => {
      events.push(`delay:${milliseconds}`);
    });

    await expect(reclaimProvenOrphans({
      dockerRunner,
      processProbe: vi.fn(),
      readFingerprint: () => `${owner.birth}-reused`,
      readScope: () => testOwnerScope,
      verifySentinel: vi.fn(),
      resolveHarnessDirectory: () => "/private/harness",
      removeDirectory: vi.fn(),
      delay,
    })).resolves.toBeDefined();

    expect(delay).toHaveBeenCalledOnce();
    expect(events.slice(0, 5)).toEqual([
      `missing:${names.restore}`,
      `missing:${names.runner}`,
      `delay:${ORPHAN_WORKER_STABILITY_DELAY_MS}`,
      `missing:${names.restore}`,
      `missing:${names.runner}`,
    ]);
    expect(events[5]).toBe(`remove:container:${names.container}`);
  });

  it("aborts a stale run when worker state becomes uncertain before reclamation", async () => {
    const runId = "4".repeat(32);
    const names = createRunNames(runId);
    const owner = {
      pid: 74,
      birth: "linux:12345678-1234-1234-1234-123456789abc:740",
      scope: testOwnerScope,
    };
    const labels = ownershipLabels(runId, "restore", owner);
    let inspections = 0;
    const dockerRunner = vi.fn(async (args: string[]) => {
      if (args[0] === "container" && args[1] === "ls") {
        return { stdout: names.restore, stderr: "" };
      }
      if (args[1] === "ls") return { stdout: "", stderr: "" };
      if (args[1] === "inspect") {
        inspections += 1;
        return {
          stdout: JSON.stringify([{
            Config: { Labels: labels },
            State: inspections === 1 ? { Running: false } : {},
          }]),
          stderr: "",
        };
      }
      throw new Error("uncertain worker state must not be removed");
    });

    await expect(reclaimProvenOrphans({
      dockerRunner,
      processProbe: vi.fn(),
      readFingerprint: () => `${owner.birth}-reused`,
      readScope: () => testOwnerScope,
    })).rejects.toThrow("restore container with uncertain state");
    expect(dockerRunner.mock.calls.some(([args]) => args[1] === "rm")).toBe(false);
  });

  it("rechecks stopped worker state at removal and never force-removes a restart race", async () => {
    const runId = "5".repeat(32);
    const names = createRunNames(runId);
    const owner = {
      pid: 75,
      birth: "linux:12345678-1234-1234-1234-123456789abc:750",
      scope: testOwnerScope,
    };
    const records = new Map([
      [`container:${names.runner}`, ownershipLabels(runId, "runner", owner)],
      [`container:${names.container}`, ownershipLabels(runId, "database", owner)],
      [`volume:${names.volume}`, ownershipLabels(runId, "data", owner)],
      [`network:${names.network}`, ownershipLabels(runId, "network", owner)],
    ]);
    let runnerInspections = 0;
    const dockerRunner = vi.fn(async (args: string[]) => {
      if (args[1] === "ls") {
        const type = args[0] === "container" ? "container" : args[0];
        return {
          stdout: [...records.keys()]
            .filter((key) => key.startsWith(`${type}:`))
            .map((key) => key.slice(type.length + 1))
            .join("\n"),
          stderr: "",
        };
      }
      if (args[1] === "inspect") {
        const type = args[0];
        const name = args[2];
        const labels = records.get(`${type}:${name}`);
        if (!labels) throw missingContainerError(name);
        if (name === names.runner) runnerInspections += 1;
        return {
          stdout: JSON.stringify([type === "container"
            ? {
              Config: { Labels: labels },
              State: {
                Running: name === names.container || (name === names.runner && runnerInspections >= 4),
              },
              Mounts: [],
            }
            : { Labels: labels }]),
          stderr: "",
        };
      }
      throw new Error("active worker must not be removed");
    });
    const removeDirectory = vi.fn();

    await expect(reclaimProvenOrphans({
      dockerRunner,
      processProbe: vi.fn(),
      readFingerprint: () => `${owner.birth}-reused`,
      readScope: () => testOwnerScope,
      verifySentinel: vi.fn(),
      resolveHarnessDirectory: () => "/private/harness",
      removeDirectory,
    })).rejects.toThrow(`active PostgreSQL harness container ${names.runner}`);
    expect(dockerRunner.mock.calls.some(([args]) => args[1] === "rm")).toBe(false);
    expect(removeDirectory).not.toHaveBeenCalled();
    expect(records.has(`container:${names.container}`)).toBe(true);
    expect(records.has(`volume:${names.volume}`)).toBe(true);
    expect(records.has(`network:${names.network}`)).toBe(true);
  });

  it("preserves all companion resources when stopped worker removal fails", async () => {
    const runId = "1".repeat(32);
    const names = createRunNames(runId);
    const owner = {
      pid: 71,
      birth: "linux:12345678-1234-1234-1234-123456789abc:710",
      scope: testOwnerScope,
    };
    const records = new Map([
      [`container:${names.runner}`, ownershipLabels(runId, "runner", owner)],
      [`container:${names.container}`, ownershipLabels(runId, "database", owner)],
      [`volume:${names.volume}`, ownershipLabels(runId, "data", owner)],
      [`network:${names.network}`, ownershipLabels(runId, "network", owner)],
    ]);
    const removalFailure = new Error("runner removal failed");
    let runnerRemovalAttempts = 0;
    const dockerRunner = vi.fn(async (args: string[]) => {
      if (args[1] === "ls") {
        const type = args[0] === "container" ? "container" : args[0];
        return {
          stdout: [...records.keys()]
            .filter((key) => key.startsWith(`${type}:`))
            .map((key) => key.slice(type.length + 1))
            .join("\n"),
          stderr: "",
        };
      }
      if (args[1] === "inspect") {
        const type = args[0];
        const name = args[2];
        const labels = records.get(`${type}:${name}`);
        if (!labels) throw missingContainerError(name);
        return {
          stdout: JSON.stringify([type === "container"
            ? {
              Config: { Labels: labels },
              State: { Running: name === names.container },
              Mounts: [],
            }
            : { Labels: labels }]),
          stderr: "",
        };
      }
      if (args[0] === "container" && args[1] === "rm" && args[2] === names.runner) {
        runnerRemovalAttempts += 1;
        throw removalFailure;
      }
      throw new Error("worker failure must preserve database and companion resources");
    });
    const verifySentinel = vi.fn();
    const removeDirectory = vi.fn();

    await expect(reclaimProvenOrphans({
      dockerRunner,
      processProbe: vi.fn(),
      readFingerprint: () => `${owner.birth}-reused`,
      readScope: () => testOwnerScope,
      verifySentinel,
      resolveHarnessDirectory: () => "/private/harness",
      removeDirectory,
      delay: vi.fn(),
    })).rejects.toBe(removalFailure);

    expect(runnerRemovalAttempts).toBe(MAX_DOCKER_REMOVE_ATTEMPTS);
    expect(verifySentinel).not.toHaveBeenCalled();
    expect(removeDirectory).not.toHaveBeenCalled();
    expect(records.has(`container:${names.container}`)).toBe(true);
    expect(records.has(`volume:${names.volume}`)).toBe(true);
    expect(records.has(`network:${names.network}`)).toBe(true);
  });

  it("treats an exact container disappearance after discovery as idempotent recovery", async () => {
    const runId = "9".repeat(32);
    const names = createRunNames(runId);
    const owner = {
      pid: 79,
      birth: "linux:12345678-1234-1234-1234-123456789abc:790",
      scope: testOwnerScope,
    };
    const records = new Map([
      [`container:${names.container}`, ownershipLabels(runId, "database", owner)],
      [`volume:${names.volume}`, ownershipLabels(runId, "data", owner)],
      [`network:${names.network}`, ownershipLabels(runId, "network", owner)],
    ]);
    const missingContainer = Object.assign(new Error("docker failed"), {
      code: 1,
      stdout: "",
      stderr: `Error response from daemon: No such container: ${names.container}`,
    });
    const removals: string[] = [];
    const dockerRunner = vi.fn(async (args: string[]) => {
      if (args[1] === "ls") {
        const type = args[0] === "container" ? "container" : args[0];
        return {
          stdout: [...records.keys()]
            .filter((key) => key.startsWith(`${type}:`))
            .map((key) => key.slice(type.length + 1))
            .join("\n"),
          stderr: "",
        };
      }
      if (args[1] === "inspect") {
        const type = args[0];
        const labels = records.get(`${type}:${args[2]}`);
        if (!labels && type === "container") {
          throw args[2] === names.container ? missingContainer : missingContainerError(args[2]);
        }
        return {
          stdout: JSON.stringify([type === "container"
            ? { Config: { Labels: labels }, State: { Running: true }, Mounts: [] }
            : { Labels: labels }]),
          stderr: "",
        };
      }
      const type = args[0];
      const name = args.at(-1)!;
      removals.push(`${type}:${name}`);
      records.delete(`${type === "container" ? "container" : type}:${name}`);
      return { stdout: "", stderr: "" };
    });
    const verifySentinel = vi.fn(async () => {
      records.delete(`container:${names.container}`);
      throw missingContainer;
    });
    const removeDirectory = vi.fn();

    await expect(reclaimProvenOrphans({
      dockerRunner,
      processProbe: vi.fn(),
      readFingerprint: () => `${owner.birth}-reused`,
      readScope: () => testOwnerScope,
      verifySentinel,
      resolveHarnessDirectory: () => "/private/harness",
      removeDirectory,
    })).resolves.toBeDefined();

    expect(verifySentinel).toHaveBeenCalledOnce();
    expect(removals).toEqual([
      `volume:${names.volume}`,
      `network:${names.network}`,
    ]);
    expect(records).toEqual(new Map());
    expect(removeDirectory).toHaveBeenCalledWith("/private/harness");
  });

  it("does not reinterpret a different missing container as the discovered resource disappearing", async () => {
    const runId = "8".repeat(32);
    const names = createRunNames(runId);
    const owner = {
      pid: 78,
      birth: "linux:12345678-1234-1234-1234-123456789abc:780",
      scope: testOwnerScope,
    };
    const labels = ownershipLabels(runId, "database", owner);
    const dockerRunner = vi.fn(async (args: string[]) => {
      if (args[0] === "container" && args[1] === "ls") {
        return { stdout: names.container, stderr: "" };
      }
      if (args[1] === "ls") return { stdout: "", stderr: "" };
      if (args[1] === "inspect" && args[2] !== names.container) {
        throw missingContainerError(args[2]);
      }
      return {
        stdout: JSON.stringify([{
          Config: { Labels: labels },
          State: { Running: true },
          Mounts: [],
        }]),
        stderr: "",
      };
    });
    const sentinelFailure = Object.assign(new Error("docker failed"), {
      code: 1,
      stdout: "",
      stderr: "Error response from daemon: No such container: different-container",
    });
    const removeDirectory = vi.fn();

    await expect(reclaimProvenOrphans({
      dockerRunner,
      processProbe: vi.fn(),
      readFingerprint: () => `${owner.birth}-reused`,
      readScope: () => testOwnerScope,
      verifySentinel: vi.fn(async () => { throw sentinelFailure; }),
      resolveHarnessDirectory: () => "/private/harness",
      removeDirectory,
    })).rejects.toBe(sentinelFailure);

    expect(dockerRunner.mock.calls.some(([args]) => args[1] === "rm")).toBe(false);
    expect(removeDirectory).not.toHaveBeenCalled();
  });

  it("does not mutate live, legacy, malformed, unsupported, or permission-ambiguous runs", async () => {
    const runId = "e".repeat(32);
    const names = createRunNames(runId);
    const owner = {
      pid: 88,
      birth: "linux:12345678-1234-1234-1234-123456789abc:800",
      scope: testOwnerScope,
    };
    const labels = ownershipLabels(runId, "network", owner);
    const dockerRunner = vi.fn(async (args: string[]) => {
      if (args[0] === "network" && args[1] === "ls") {
        return { stdout: names.network, stderr: "" };
      }
      if (args[1] === "ls") return { stdout: "", stderr: "" };
      return { stdout: JSON.stringify([{ Labels: labels }]), stderr: "" };
    });

    for (const readFingerprint of [
      () => owner.birth,
      () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); },
      () => { throw new Error("unsupported"); },
    ]) {
      dockerRunner.mockClear();
      await expect(reclaimProvenOrphans({
        dockerRunner,
        processProbe: vi.fn(),
        readFingerprint,
        readScope: () => testOwnerScope,
        stderr: { write: vi.fn() },
      })).resolves.toBeDefined();
      expect(dockerRunner.mock.calls.some(([args]) => args[1] === "rm")).toBe(false);
    }
  });

  it("reclaims a stopped stale database without bypassing observable running sentinels", async () => {
    const runId = "f".repeat(32);
    const names = createRunNames(runId);
    const owner = {
      pid: 91,
      birth: "linux:12345678-1234-1234-1234-123456789abc:900",
      scope: testOwnerScope,
    };
    const labels = ownershipLabels(runId, "database", owner);
    let exists = true;
    const dockerRunner = vi.fn(async (args: string[]) => {
      if (args[0] === "container" && args[1] === "ls") {
        return { stdout: exists ? names.container : "", stderr: "" };
      }
      if (args[1] === "ls") return { stdout: "", stderr: "" };
      if (args[1] === "inspect") {
        if (args[2] !== names.container) throw missingContainerError(args[2]);
        return {
          stdout: JSON.stringify([{ Config: { Labels: labels }, State: { Running: false } }]),
          stderr: "",
        };
      }
      exists = false;
      return { stdout: "", stderr: "" };
    });
    const verifySentinel = vi.fn(() => { throw new Error("stopped container cannot exec"); });
    const removeDirectory = vi.fn();

    await expect(reclaimProvenOrphans({
      dockerRunner,
      processProbe: vi.fn(),
      readFingerprint: () => `${owner.birth}-reused`,
      readScope: () => testOwnerScope,
      verifySentinel,
      resolveHarnessDirectory: () => "/private/harness",
      removeDirectory,
    })).resolves.toBeDefined();
    expect(verifySentinel).not.toHaveBeenCalled();
    expect(exists).toBe(false);
    expect(removeDirectory).toHaveBeenCalledWith("/private/harness");
  });

  it("retains private recovery evidence when an orphan resource cannot be removed", async () => {
    const runId = "7".repeat(32);
    const names = createRunNames(runId);
    const owner = {
      pid: 97,
      birth: "linux:12345678-1234-1234-1234-123456789abc:970",
      scope: testOwnerScope,
    };
    const labels = ownershipLabels(runId, "database", owner);
    const removalFailure = new Error("database removal failed");
    const dockerRunner = vi.fn(async (args: string[]) => {
      if (args[0] === "container" && args[1] === "ls") {
        return { stdout: names.container, stderr: "" };
      }
      if (args[1] === "ls") return { stdout: "", stderr: "" };
      if (args[1] === "inspect") {
        if (args[2] !== names.container) throw missingContainerError(args[2]);
        return {
          stdout: JSON.stringify([{
            Config: { Labels: labels },
            State: { Running: true },
            Mounts: [],
          }]),
          stderr: "",
        };
      }
      throw removalFailure;
    });
    const removeDirectory = vi.fn();

    await expect(reclaimProvenOrphans({
      dockerRunner,
      processProbe: vi.fn(),
      readFingerprint: () => `${owner.birth}-reused`,
      readScope: () => testOwnerScope,
      verifySentinel: vi.fn(),
      resolveHarnessDirectory: () => "/private/harness",
      removeDirectory,
      delay: vi.fn(),
    })).rejects.toBe(removalFailure);

    expect(removeDirectory).not.toHaveBeenCalled();
  });

  it("erases the captured private directory after database removal despite a terminal companion failure", async () => {
    const runId = "6".repeat(32);
    const names = createRunNames(runId);
    const owner = {
      pid: 96,
      birth: "linux:12345678-1234-1234-1234-123456789abc:960",
      scope: testOwnerScope,
    };
    const records = new Map([
      [`container:${names.container}`, ownershipLabels(runId, "database", owner)],
      [`volume:${names.volume}`, ownershipLabels(runId, "data", owner)],
    ]);
    const removalFailure = new Error("volume removal failed");
    const events: string[] = [];
    const dockerRunner = vi.fn(async (args: string[]) => {
      if (args[1] === "ls") {
        const type = args[0] === "container" ? "container" : args[0];
        return {
          stdout: [...records.keys()]
            .filter((key) => key.startsWith(`${type}:`))
            .map((key) => key.slice(type.length + 1))
            .join("\n"),
          stderr: "",
        };
      }
      if (args[1] === "inspect") {
        const type = args[0];
        const labels = records.get(`${type}:${args[2]}`);
        if (!labels && type === "container") throw missingContainerError(args[2]);
        return {
          stdout: JSON.stringify([type === "container"
            ? { Config: { Labels: labels }, State: { Running: true }, Mounts: [] }
            : { Labels: labels }]),
          stderr: "",
        };
      }
      const type = args[0];
      const name = args.at(-1)!;
      events.push(`remove:${type}:${name}`);
      if (type === "volume") throw removalFailure;
      records.delete(`${type === "container" ? "container" : type}:${name}`);
      return { stdout: "", stderr: "" };
    });
    const removeDirectory = vi.fn((path: string) => {
      events.push(`directory:${path}`);
    });

    await expect(reclaimProvenOrphans({
      dockerRunner,
      processProbe: vi.fn(),
      readFingerprint: () => `${owner.birth}-reused`,
      readScope: () => testOwnerScope,
      verifySentinel: vi.fn(),
      resolveHarnessDirectory: () => "/private/harness",
      removeDirectory,
      delay: vi.fn(),
    })).rejects.toBe(removalFailure);

    expect(records.has(`container:${names.container}`)).toBe(false);
    expect(records.has(`volume:${names.volume}`)).toBe(true);
    expect(removeDirectory).toHaveBeenCalledOnce();
    expect(events.indexOf(`directory:/private/harness`))
      .toBeGreaterThan(events.indexOf(`remove:container:${names.container}`));
  });

  it("reclaims a stopped previous-boot database after its temporary directory is gone", async () => {
    const runId = "0".repeat(32);
    const names = createRunNames(runId);
    const oldBoot = "12345678-1234-1234-1234-123456789abc";
    const currentBoot = "abcdefab-1234-1234-1234-123456789abc";
    const owner = {
      pid: 93,
      birth: `linux:${oldBoot}:900`,
      scope: `linux:${"a".repeat(64)}:${oldBoot}:pid:[4026531836]`,
    };
    const labels = ownershipLabels(runId, "database", owner);
    let exists = true;
    const dockerRunner = vi.fn(async (args: string[]) => {
      if (args[0] === "container" && args[1] === "ls") {
        return { stdout: exists ? names.container : "", stderr: "" };
      }
      if (args[1] === "ls") return { stdout: "", stderr: "" };
      if (args[1] === "inspect") {
        if (args[2] !== names.container) throw missingContainerError(args[2]);
        return {
          stdout: JSON.stringify([{ Config: { Labels: labels }, State: { Running: false }, Mounts: [] }]),
          stderr: "",
        };
      }
      exists = false;
      return { stdout: "", stderr: "" };
    });

    await expect(reclaimProvenOrphans({
      dockerRunner,
      platform: () => "linux",
      processProbe: vi.fn(),
      readFingerprint: () => "linux:reused:1",
      readScope: () => `linux:${"a".repeat(64)}:${currentBoot}:pid:[4026531836]`,
      readFile: () => `${currentBoot}\n`,
    })).resolves.toBeDefined();
    expect(exists).toBe(false);
  });

  it("warns for ambiguous evidence and continues discovering independent stale runs", async () => {
    const staleRunId = "1".repeat(32);
    const names = createRunNames(staleRunId);
    const owner = {
      pid: 92,
      birth: "linux:12345678-1234-1234-1234-123456789abc:920",
      scope: testOwnerScope,
    };
    const labels = ownershipLabels(staleRunId, "network", owner);
    const inspectionFailure = Object.assign(new Error("denied"), {
      code: 1,
      stdout: "",
      stderr: "permission denied",
    });
    let staleExists = true;
    const dockerRunner = vi.fn(async (args: string[]) => {
      if (args[0] === "container" && args[1] === "ls") {
        return { stdout: "foreign-ambiguous-container", stderr: "" };
      }
      if (args[0] === "network" && args[1] === "ls") {
        return { stdout: staleExists ? names.network : "", stderr: "" };
      }
      if (args[1] === "ls") return { stdout: "", stderr: "" };
      if (args[1] === "inspect" && args[2] === "foreign-ambiguous-container") throw inspectionFailure;
      if (args[0] === "container" && args[1] === "inspect") {
        throw missingContainerError(args[2]);
      }
      if (args[1] === "inspect") {
        return { stdout: JSON.stringify([{ Labels: labels }]), stderr: "" };
      }
      staleExists = false;
      return { stdout: "", stderr: "" };
    });
    const stderr = { write: vi.fn() };

    const runs = await reclaimProvenOrphans({
      dockerRunner,
      processProbe: vi.fn(),
      readFingerprint: () => `${owner.birth}-reused`,
      readScope: () => testOwnerScope,
      stderr,
    });
    expect(runs.map((run) => run.classification).sort()).toEqual(["ambiguous", "stale"]);
    expect(staleExists).toBe(false);
    expect(stderr.write).toHaveBeenCalledWith(
      "PostgreSQL harness preserved 1 ambiguous labeled Docker run; manual reconciliation required.\n",
    );
    expect(stderr.write.mock.calls.flat().join(" ")).not.toContain("permission denied");
  });

  it("taints companions from a malformed canonical name and preserves active workers and consumers", async () => {
    const runId = "2".repeat(32);
    const names = createRunNames(runId);
    const owner = {
      pid: 100,
      birth: "linux:12345678-1234-1234-1234-123456789abc:100",
      scope: testOwnerScope,
    };
    const consumer = {
      pid: 101,
      birth: "linux:12345678-1234-1234-1234-123456789abc:101",
      scope: testOwnerScope,
    };
    const records = new Map([
      [`network:${names.network}`, { [RUN_LABEL]: "malformed" }],
      [`volume:${names.volume}`, ownershipLabels(runId, "data", owner)],
    ]);
    const dockerRunner = vi.fn(async (args: string[]) => {
      if (args[1] === "ls") {
        const type = args[0] === "container" ? "container" : args[0];
        return {
          stdout: [...records.keys()]
            .filter((key) => key.startsWith(`${type}:`))
            .map((key) => key.slice(type.length + 1)).join("\n"),
          stderr: "",
        };
      }
      const type = args[0];
      return { stdout: JSON.stringify([{ Labels: records.get(`${type}:${args[2]}`) }]), stderr: "" };
    });
    const malformed = await discoverHarnessRuns({
      dockerRunner,
      processProbe: vi.fn(),
      readFingerprint: () => "reused",
      readScope: () => testOwnerScope,
    });
    expect(malformed.find((run) => run.runId === runId)?.classification).toBe("ambiguous");

    records.clear();
    records.set(`container:${names.runner}`, ownershipLabels(runId, "runner", owner));
    const workerRunner = vi.fn(async (args: string[]) => {
      if (args[1] === "ls") {
        return { stdout: args[0] === "container" ? names.runner : "", stderr: "" };
      }
      return {
        stdout: JSON.stringify([{ Config: { Labels: records.get(`container:${names.runner}`) }, State: { Running: true } }]),
        stderr: "",
      };
    });
    const worker = await discoverHarnessRuns({
      dockerRunner: workerRunner,
      processProbe: vi.fn(),
      readFingerprint: () => "reused",
      readScope: () => testOwnerScope,
    });
    expect(worker[0].classification).toBe("live");

    records.clear();
    records.set(`container:${names.container}`, ownershipLabels(runId, "database", owner));
    const databaseRunner = vi.fn(async (args: string[]) => {
      if (args[1] === "ls") {
        return { stdout: args[0] === "container" ? names.container : "", stderr: "" };
      }
      return {
        stdout: JSON.stringify([{ Config: { Labels: records.get(`container:${names.container}`) }, State: { Running: true } }]),
        stderr: "",
      };
    });
    let consumerRead = false;
    const consumerRun = await discoverHarnessRuns({
      dockerRunner: databaseRunner,
      resolveHarnessDirectory: () => "/private/harness",
      processProbe: vi.fn(),
      readFingerprint: (pid: number) => pid === consumer.pid ? consumer.birth : "reused",
      readScope: () => testOwnerScope,
      open: () => 9,
      fstat: () => ({ isFile: () => true, mode: 0o100600, size: 100 }),
      read: (_descriptor: number, buffer: Buffer) => {
        if (consumerRead) return 0;
        consumerRead = true;
        const content = Buffer.from(JSON.stringify({ version: 1, ...consumer }));
        content.copy(buffer);
        return content.length;
      },
      close: vi.fn(),
    });
    expect(consumerRun[0].classification).toBe("live");

    const symlinkRefusal = await discoverHarnessRuns({
      dockerRunner: databaseRunner,
      resolveHarnessDirectory: () => "/private/harness",
      processProbe: vi.fn(),
      readFingerprint: () => "reused",
      readScope: () => testOwnerScope,
      open: () => { throw Object.assign(new Error("symlink"), { code: "ELOOP" }); },
    });
    expect(symlinkRefusal[0].classification).toBe("ambiguous");

    const close = vi.fn();
    const permissionRefusal = await discoverHarnessRuns({
      dockerRunner: databaseRunner,
      resolveHarnessDirectory: () => "/private/harness",
      processProbe: vi.fn(),
      readFingerprint: () => "reused",
      readScope: () => testOwnerScope,
      open: () => 10,
      fstat: () => ({ isFile: () => true, mode: 0o100644, size: 100 }),
      close,
    });
    expect(permissionRefusal[0].classification).toBe("ambiguous");
    expect(close).toHaveBeenCalledWith(10);

    let windowsRead = false;
    const windowsConsumer = await discoverHarnessRuns({
      dockerRunner: databaseRunner,
      resolveHarnessDirectory: () => "/private/harness",
      platform: () => "win32",
      processProbe: vi.fn(),
      readFingerprint: (pid: number) => pid === consumer.pid ? consumer.birth : "reused",
      readScope: () => testOwnerScope,
      open: () => 11,
      fstat: () => ({ isFile: () => true, mode: 0o100666, size: 100 }),
      read: (_descriptor: number, buffer: Buffer) => {
        if (windowsRead) return 0;
        windowsRead = true;
        const content = Buffer.from(JSON.stringify({ version: 1, ...consumer }));
        content.copy(buffer);
        return content.length;
      },
      close: vi.fn(),
    });
    expect(windowsConsumer[0].classification).toBe("live");
  });

  it("pins container-mounted and checksummed PostgreSQL files to LF", () => {
    const attributes = readFileSync(new URL("../../.gitattributes", import.meta.url), "utf8");
    const rules = attributes.split(/\r?\n/u);
    expect(rules).toContain("src/storage/postgresql/migrations/*.sql text eol=lf");
    expect(rules).toContain("test/postgresql/init.sh text eol=lf");
    expect(rules).toContain("test/postgresql/template-init.sh text eol=lf");
    expect(rules).toContain("test/postgresql/cached-run-init.sh text eol=lf");
  });

  it("cleans every owned resource and the secret directory in order", async () => {
    const names = createRunNames("a".repeat(32));
    const events: string[] = [];

    await expect(cleanupHarnessResources({
      names,
      runId: "a".repeat(32),
      directory: "/private/harness",
      sentinelReady: true,
    }, {
      removeResource: (type: string, name: string) => { events.push(`remove:${type}:${name}`); },
      verifySentinel: () => { events.push("verify:sentinel"); },
      removeDirectory: (path: string) => { events.push(`directory:${path}`); },
    })).resolves.toBeUndefined();

    expect(events).toEqual([
      `remove:container:${names.restore}`,
      `remove:container:${names.runner}`,
      "verify:sentinel",
      `remove:container:${names.container}`,
      `remove:volume:${names.volume}`,
      `remove:network:${names.network}`,
      "directory:/private/harness",
    ]);
  });

  it("skips sentinel verification before initialization completes", async () => {
    const names = createRunNames("a".repeat(32));
    const verifySentinel = vi.fn();
    const removeResource = vi.fn();

    await cleanupHarnessResources({
      names,
      runId: "a".repeat(32),
      directory: "/private/harness",
      sentinelReady: false,
    }, { removeResource, verifySentinel, removeDirectory: vi.fn() });

    expect(verifySentinel).not.toHaveBeenCalled();
    expect(removeResource).toHaveBeenCalledWith("container", names.container);
  });

  it("retries a transient sentinel failure and dependent Docker removals as a complete pass", async () => {
    const names = createRunNames("a".repeat(32));
    const sentinelFailure = new Error("sentinel failed");
    const events: string[] = [];
    let pass = 1;
    const verifySentinel = vi.fn(() => {
      events.push(`verify:${pass}`);
      if (pass === 1) throw sentinelFailure;
    });
    const removeResource = vi.fn((type: string, name: string) => {
      events.push(`remove:${pass}:${type}:${name}`);
      if (pass === 1 && (name === names.volume || name === names.network)) {
        throw new Error(`${type} still in use`);
      }
    });
    const delay = vi.fn(async (milliseconds: number) => {
      events.push(`delay:${milliseconds}`);
      pass += 1;
    });
    const removeDirectory = vi.fn((path: string) => { events.push(`directory:${path}`); });

    await expect(cleanupHarnessResources({
      names,
      runId: "a".repeat(32),
      directory: "/private/harness",
      sentinelReady: true,
    }, {
      removeResource,
      verifySentinel,
      removeDirectory,
      delay,
    })).resolves.toBeUndefined();

    expect(verifySentinel).toHaveBeenCalledTimes(2);
    expect(delay).toHaveBeenCalledWith(HARNESS_CLEANUP_RETRY_DELAYS_MS[0]);
    expect(events).not.toContain(`remove:1:container:${names.container}`);
    expect(events).toContain(`remove:2:container:${names.container}`);
    expect(events.at(-1)).toBe("directory:/private/harness");
    expect(removeDirectory).toHaveBeenCalledWith("/private/harness");
  });

  it("retries a partial cleanup idempotently and discards the transient failure", async () => {
    const names = createRunNames("a".repeat(32));
    const databaseFailure = new Error("database removal is in progress");
    const attempts = new Map<string, number>();
    const removeResource = vi.fn((type: string, name: string) => {
      const key = `${type}:${name}`;
      attempts.set(key, (attempts.get(key) ?? 0) + 1);
      if (name === names.container && attempts.get(key) === 1) throw databaseFailure;
    });
    const delay = vi.fn().mockResolvedValue(undefined);
    const removeDirectory = vi.fn();

    await expect(cleanupHarnessResources({
      names,
      runId: "a".repeat(32),
      directory: "/private/harness",
      sentinelReady: true,
    }, {
      removeResource,
      verifySentinel: vi.fn(),
      removeDirectory,
      delay,
    })).resolves.toBeUndefined();

    expect(attempts.get(`container:${names.container}`)).toBe(2);
    expect(attempts.get(`volume:${names.volume}`)).toBe(2);
    expect(attempts.get(`network:${names.network}`)).toBe(2);
    expect(delay).toHaveBeenCalledOnce();
    expect(removeDirectory).toHaveBeenCalledOnce();
  });

  it("converges when the database disappears after a later resource transiently fails", async () => {
    const names = createRunNames("a".repeat(32));
    const missingDatabase = Object.assign(new Error("docker failed"), {
      code: 1,
      stdout: "",
      stderr: `Error response from daemon: No such container: ${names.container}`,
    });
    let pass = 1;
    const verifySentinel = vi.fn(() => {
      if (pass === 2) throw missingDatabase;
    });
    const removeResource = vi.fn((type: string, name: string) => {
      if (pass === 1 && name === names.volume) throw new Error(`${type} still in use`);
    });
    const delay = vi.fn(async () => {
      pass += 1;
    });
    const removeDirectory = vi.fn();

    await expect(cleanupHarnessResources({
      names,
      runId: "a".repeat(32),
      directory: "/private/harness",
      sentinelReady: true,
    }, {
      removeResource,
      verifySentinel,
      removeDirectory,
      delay,
    })).resolves.toBeUndefined();

    expect(verifySentinel).toHaveBeenCalledTimes(2);
    expect(removeResource.mock.calls.filter(
      ([type, name]) => type === "container" && name === names.container,
    )).toHaveLength(1);
    expect(delay).toHaveBeenCalledWith(HARNESS_CLEANUP_RETRY_DELAYS_MS[0]);
    expect(removeDirectory).toHaveBeenCalledOnce();
  });

  it.each([
    ["sentinel mismatch", new Error("sentinel ownership mismatch")],
    ["ownership change", new Error("refusing to clean an unowned PostgreSQL harness container")],
    ["different container disappearance", Object.assign(new Error("docker failed"), {
      code: 1,
      stdout: "",
      stderr: "Error response from daemon: No such container: different-container",
    })],
  ])("keeps a persistent %s fail-closed through every cleanup pass", async (_scenario, sentinelFailure) => {
    const names = createRunNames("a".repeat(32));
    const verifySentinel = vi.fn(() => { throw sentinelFailure; });
    const removeResource = vi.fn();
    const delay = vi.fn().mockResolvedValue(undefined);
    const removeDirectory = vi.fn();

    await expect(cleanupHarnessResources({
      names,
      runId: "a".repeat(32),
      directory: "/private/harness",
      sentinelReady: true,
    }, {
      removeResource,
      verifySentinel,
      removeDirectory,
      delay,
    })).rejects.toBe(sentinelFailure);

    expect(verifySentinel).toHaveBeenCalledTimes(HARNESS_CLEANUP_RETRY_DELAYS_MS.length + 1);
    expect(removeResource).not.toHaveBeenCalledWith("container", names.container);
    expect(delay.mock.calls.map(([milliseconds]) => milliseconds))
      .toEqual(HARNESS_CLEANUP_RETRY_DELAYS_MS);
    expect(removeDirectory).toHaveBeenCalledOnce();
  });

  it("aggregates independent cleanup failures and always removes the secret directory", async () => {
    const names = createRunNames("a".repeat(32));
    const runnerFailure = new Error("runner inspect failed");
    const volumeFailure = new Error("volume remove failed");
    const directoryFailure = new Error("directory remove failed");
    const attempts: string[] = [];
    const removeResource = vi.fn((type: string, name: string) => {
      attempts.push(`${type}:${name}`);
      if (name === names.runner) throw runnerFailure;
      if (name === names.volume) throw volumeFailure;
    });
    const removeDirectory = vi.fn(() => { throw directoryFailure; });
    const delay = vi.fn().mockResolvedValue(undefined);

    const failure = await cleanupHarnessResources({
      names,
      runId: "a".repeat(32),
      directory: "/private/harness",
      sentinelReady: true,
    }, {
      removeResource,
      verifySentinel: vi.fn(),
      removeDirectory,
      delay,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([runnerFailure, volumeFailure, directoryFailure]);
    expect(harnessErrorDetails(failure)).toBe([
      "PostgreSQL harness cleanup failed",
      "runner inspect failed",
      "volume remove failed",
      "directory remove failed",
    ].join("\n"));
    const expectedPass = [
      `container:${names.restore}`,
      `container:${names.runner}`,
      `container:${names.container}`,
      `volume:${names.volume}`,
      `network:${names.network}`,
    ];
    expect(attempts).toEqual(
      Array.from(
        { length: HARNESS_CLEANUP_RETRY_DELAYS_MS.length + 1 },
        () => expectedPass,
      ).flat(),
    );
    expect(delay).toHaveBeenCalledTimes(HARNESS_CLEANUP_RETRY_DELAYS_MS.length);
    expect(removeDirectory).toHaveBeenCalledWith("/private/harness");
  });

  it("emits one terminal sanitized diagnostic for concurrent cleanup and signal-style callers", async () => {
    const names = createRunNames("a".repeat(32));
    const privatePath = "/private/harness-secret";
    const password = "database-password";
    const writeDiagnostic = vi.fn(async (_message: string) => undefined);
    const delay = vi.fn(async (_milliseconds: number) => {
      expect(writeDiagnostic).not.toHaveBeenCalled();
    });
    const removeResource = vi.fn((type: string, name: string) => {
      expect(writeDiagnostic).not.toHaveBeenCalled();
      throw Object.assign(new Error("docker failed"), {
        stderr: [
          `${type} ${name} removal failed with ${password}`,
          `private evidence remained at ${privatePath}`,
        ].join("\n"),
      });
    });
    const removeDirectory = vi.fn((path: string) => {
      expect(path).toBe(privatePath);
      expect(writeDiagnostic).not.toHaveBeenCalled();
    });
    const cleanupResources = vi.fn(cleanupHarnessResources);
    const stop = vi.fn(async () => undefined);
    const operations = createHarnessCleanupOperations({
      names,
      runId: "a".repeat(32),
      directory: privatePath,
      sentinelReady: true,
    }, {
      cleanupResources,
      cleanupDependencies: {
        removeResource,
        verifySentinel: vi.fn(),
        removeDirectory,
        delay,
      },
      secrets: [privatePath, password],
      stop,
      writeDiagnostic,
    });

    const results = await Promise.allSettled([
      operations.cleanup(),
      operations.teardown(),
      operations.teardown(),
    ]);

    expect(results.every((result) => result.status === "rejected")).toBe(true);
    expect(cleanupResources).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
    expect(delay.mock.calls.map(([milliseconds]) => milliseconds))
      .toEqual(HARNESS_CLEANUP_RETRY_DELAYS_MS);
    expect(removeResource).toHaveBeenCalledTimes(
      (HARNESS_CLEANUP_RETRY_DELAYS_MS.length + 1) * 5,
    );
    expect(removeDirectory).toHaveBeenCalledOnce();
    expect(writeDiagnostic).toHaveBeenCalledOnce();

    const diagnostic = writeDiagnostic.mock.calls[0]![0];
    expect(diagnostic.startsWith(`${SIGNAL_CLEANUP_FAILURE_MARKER} `)).toBe(true);
    expect(diagnostic.split(SIGNAL_CLEANUP_FAILURE_MARKER)).toHaveLength(2);
    expect(diagnostic).toContain("PostgreSQL harness cleanup failed");
    expect(diagnostic).toContain("removal failed");
    expect(diagnostic).toContain("private evidence remained");
    expect(diagnostic).toContain("[REDACTED]");
    expect(diagnostic).not.toContain(privatePath);
    expect(diagnostic).not.toContain(password);

    const parser = createSignalCleanupDiagnosticParser();
    parser.write(diagnostic);
    expect(parser.diagnostic()).toContain("private evidence remained");
    expect(parser.retainedByteCount()).toBeLessThanOrEqual(MAX_CAPTURED_OUTPUT_BYTES);
  });

  it("expands aggregate cleanup diagnostics before redacting signal-safe output", () => {
    const privatePath = "/private/harness-secret";
    const password = "database-password";
    const dockerFailure = Object.assign(new Error("docker failed"), {
      stderr: `permission denied reading ${privatePath} with ${password}`,
    });
    const aggregate = new AggregateError([dockerFailure, new Error(`remove ${privatePath} failed`)], "cleanup failed");

    const sanitized = sanitizeHarnessText(harnessErrorDetails(aggregate), [privatePath, password]);

    expect(sanitized).toContain("cleanup failed");
    expect(sanitized).toContain("permission denied");
    expect(sanitized).toContain("[REDACTED]");
    expect(sanitized).not.toContain(privatePath);
    expect(sanitized).not.toContain(password);
  });
});
