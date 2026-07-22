import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  MAX_CAPTURED_OUTPUT_BYTES,
  NODE_IMAGE,
  POSTGRES_IMAGE,
  RUN_LABEL,
  cleanupHarnessResources,
  createProcessLifecycle,
  createRunNames,
  harnessErrorDetails,
  isMissingDockerObjectError,
  removeLabeled,
  runProcess,
  sanitizeHarnessText,
  validateRunNames,
} from "../../scripts/postgresql-harness.mjs";
import { postgresqlVitestCacheDir } from "../../vitest.postgresql.config.js";

describe("PostgreSQL harness utilities", () => {
  it("uses exact digest-pinned images and a namespaced label", () => {
    expect(POSTGRES_IMAGE).toMatch(/^postgres:18\.4-bookworm@sha256:[0-9a-f]{64}$/u);
    expect(NODE_IMAGE).toMatch(/^node:22\.20\.0-bookworm-slim@sha256:[0-9a-f]{64}$/u);
    expect(RUN_LABEL).toBe("com.donadiosolutions.lcm.postgresql-test-run");
  });

  it("derives and validates every resource name from a random-style run ID", () => {
    const runId = "a".repeat(32);
    const names = createRunNames(runId);
    expect(() => validateRunNames(names, runId)).not.toThrow();
    expect(names).toEqual({
      container: `lcm-pg-${"a".repeat(20)}`,
      network: `lcm-pg-net-${"a".repeat(20)}`,
      volume: `lcm-pg-data-${"a".repeat(20)}`,
      runner: `lcm-pg-runner-${"a".repeat(20)}`,
      alias: `lcm-pg-${"a".repeat(20)}.test`,
      wrongAlias: `lcm-pg-wrong-${"a".repeat(20)}.test`,
      controlDatabase: `lcm_harness_${"a".repeat(20)}`,
    });
    expect(() => validateRunNames(names, "not-random")).toThrow("run ID");
    expect(() => validateRunNames({ ...names, volume: "foreign-volume" }, runId)).toThrow("volume");
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
      .resolves.toEqual({ stdout: "ok", stderr: "note" });
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
    });
    expect(spawnProcess).toHaveBeenCalledWith("docker", ["inspect", "owned"], {
      cwd: undefined,
      env: undefined,
      stdio: ["ignore", "pipe", "pipe"],
    });
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

  it("pins migration SQL to LF for stable checksums across Git configurations", () => {
    const attributes = readFileSync(new URL("../../.gitattributes", import.meta.url), "utf8");
    expect(attributes.split(/\r?\n/u)).toContain("src/storage/postgresql/migrations/*.sql text eol=lf");
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

  it("preserves a single sentinel failure while continuing independent cleanup", async () => {
    const names = createRunNames("a".repeat(32));
    const sentinelFailure = new Error("sentinel failed");
    const removeResource = vi.fn();
    const removeDirectory = vi.fn();

    await expect(cleanupHarnessResources({
      names,
      runId: "a".repeat(32),
      directory: "/private/harness",
      sentinelReady: true,
    }, {
      removeResource,
      verifySentinel: () => { throw sentinelFailure; },
      removeDirectory,
    })).rejects.toBe(sentinelFailure);

    expect(removeResource).not.toHaveBeenCalledWith("container", names.container);
    expect(removeResource).toHaveBeenCalledWith("volume", names.volume);
    expect(removeResource).toHaveBeenCalledWith("network", names.network);
    expect(removeDirectory).toHaveBeenCalledWith("/private/harness");
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

    const failure = await cleanupHarnessResources({
      names,
      runId: "a".repeat(32),
      directory: "/private/harness",
      sentinelReady: true,
    }, { removeResource, verifySentinel: vi.fn(), removeDirectory }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([runnerFailure, volumeFailure, directoryFailure]);
    expect(harnessErrorDetails(failure)).toBe([
      "PostgreSQL harness cleanup failed",
      "runner inspect failed",
      "volume remove failed",
      "directory remove failed",
    ].join("\n"));
    expect(attempts).toEqual([
      `container:${names.runner}`,
      `container:${names.container}`,
      `volume:${names.volume}`,
      `network:${names.network}`,
    ]);
    expect(removeDirectory).toHaveBeenCalledWith("/private/harness");
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
