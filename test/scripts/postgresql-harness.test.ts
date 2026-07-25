import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  MAX_CAPTURED_OUTPUT_BYTES,
  MAX_DOCKER_REMOVE_ATTEMPTS,
  NODE_IMAGE,
  OWNER_BIRTH_LABEL,
  OWNER_PID_LABEL,
  OWNER_SCHEMA_LABEL,
  OWNER_SCHEMA_VERSION,
  POSTGRES_IMAGE,
  RESOURCE_KIND_LABEL,
  RUN_LABEL,
  classifyOwnerIdentity,
  cleanupHarnessResources,
  createOwnerIdentity,
  createProcessLifecycle,
  createRunNames,
  discoverHarnessRuns,
  harnessErrorDetails,
  isMissingDockerObjectError,
  ownershipLabels,
  readProcessBirthFingerprint,
  reclaimProvenOrphans,
  removeLabeled,
  removeOwnedResource,
  resolveConfiguredTemplateArchive,
  runProcess,
  runSanitizedProcess,
  sanitizeHarnessText,
  validateRunNames,
} from "../../scripts/postgresql-harness.mjs";
import { postgresqlVitestCacheDir } from "../../vitest.postgresql.config.js";

describe("PostgreSQL harness utilities", () => {
  it("uses exact digest-pinned images and a namespaced label", () => {
    expect(POSTGRES_IMAGE).toMatch(/^postgres:18\.4-bookworm@sha256:[0-9a-f]{64}$/u);
    expect(NODE_IMAGE).toMatch(/^node:22\.20\.0-bookworm-slim@sha256:[0-9a-f]{64}$/u);
    expect(RUN_LABEL).toBe("com.donadiosolutions.lcm.postgresql-test-run");
    expect(OWNER_SCHEMA_VERSION).toBe("1");
    expect(new Set([
      RUN_LABEL,
      OWNER_SCHEMA_LABEL,
      OWNER_PID_LABEL,
      OWNER_BIRTH_LABEL,
      RESOURCE_KIND_LABEL,
    ]).size).toBe(5);
  });

  it("derives an owner birth fingerprint from boot ID and the Linux process start field", () => {
    const bootId = "12345678-1234-1234-1234-123456789abc";
    const statFields = ["S", ...Array.from({ length: 18 }, () => "0"), "98765", "0"];
    const readFile = vi.fn((path: string) => path.endsWith("boot_id")
      ? `${bootId}\n`
      : `42 (worker with ) parenthesis) ${statFields.join(" ")}\n`);

    expect(readProcessBirthFingerprint(42, { readFile })).toBe(`${bootId}:98765`);
    expect(createOwnerIdentity(42, { readFile })).toEqual({ pid: 42, birth: `${bootId}:98765` });
    expect(() => readProcessBirthFingerprint(0, { readFile })).toThrow("owner PID");
    expect(() => readProcessBirthFingerprint(42, { readFile: () => "unsupported" }))
      .toThrow("unsupported");
  });

  it("classifies only matching process identity as live and fails closed on ambiguous evidence", () => {
    const owner = { pid: 42, birth: "boot:100" };
    expect(classifyOwnerIdentity(owner, { readFingerprint: () => "boot:100" })).toBe("live");
    expect(classifyOwnerIdentity(owner, { readFingerprint: () => "boot:200" })).toBe("stale");
    expect(classifyOwnerIdentity(owner, {
      readFingerprint: () => { throw Object.assign(new Error("gone"), { code: "ENOENT" }); },
    })).toBe("stale");
    expect(classifyOwnerIdentity(owner, {
      readFingerprint: () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); },
    })).toBe("ambiguous");
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
      birth: "12345678-1234-1234-1234-123456789abc:100",
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
        { pid: 41, birth: `${bootId}:100` },
      )],
      [`volume:${createRunNames(staleRunId).volume}`, ownershipLabels(
        staleRunId,
        "data",
        { pid: 42, birth: `${bootId}:200` },
      )],
      [`volume:${createRunNames(legacyRunId).volume}`, { [RUN_LABEL]: legacyRunId }],
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
      readFingerprint: (pid: number) => pid === 41 ? `${bootId}:100` : `${bootId}:999`,
    });
    expect(runs.map((run) => [run.runId, run.classification])).toEqual([
      [liveRunId, "live"],
      [staleRunId, "stale"],
      [legacyRunId, "ambiguous"],
    ]);

    records.set(
      `container:${createRunNames(liveRunId).runner}`,
      ownershipLabels(liveRunId, "runner", { pid: 99, birth: `${bootId}:300` }),
    );
    const inconsistent = await discoverHarnessRuns({
      dockerRunner,
      readFingerprint: () => `${bootId}:100`,
    });
    expect(inconsistent.find((run) => run.runId === liveRunId)?.classification).toBe("ambiguous");
  });

  it("reclaims only a definitively stale, consistently labeled run in teardown order", async () => {
    const runId = "d".repeat(32);
    const names = createRunNames(runId);
    const owner = {
      pid: 77,
      birth: "12345678-1234-1234-1234-123456789abc:700",
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
            ? { Config: { Labels: labels }, State: { Running: true } }
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

    const runs = await reclaimProvenOrphans({
      dockerRunner,
      readFingerprint: () => `${owner.birth}-reused`,
      verifySentinel,
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
  });

  it("does not mutate live, legacy, malformed, unsupported, or permission-ambiguous runs", async () => {
    const runId = "e".repeat(32);
    const names = createRunNames(runId);
    const owner = {
      pid: 88,
      birth: "12345678-1234-1234-1234-123456789abc:800",
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
        readFingerprint,
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
      birth: "12345678-1234-1234-1234-123456789abc:900",
    };
    const labels = ownershipLabels(runId, "database", owner);
    let exists = true;
    const dockerRunner = vi.fn(async (args: string[]) => {
      if (args[0] === "container" && args[1] === "ls") {
        return { stdout: exists ? names.container : "", stderr: "" };
      }
      if (args[1] === "ls") return { stdout: "", stderr: "" };
      if (args[1] === "inspect") {
        return {
          stdout: JSON.stringify([{ Config: { Labels: labels }, State: { Running: false } }]),
          stderr: "",
        };
      }
      exists = false;
      return { stdout: "", stderr: "" };
    });
    const verifySentinel = vi.fn(() => { throw new Error("stopped container cannot exec"); });

    await expect(reclaimProvenOrphans({
      dockerRunner,
      readFingerprint: () => `${owner.birth}-reused`,
      verifySentinel,
    })).resolves.toBeDefined();
    expect(verifySentinel).not.toHaveBeenCalled();
    expect(exists).toBe(false);
  });

  it("warns for ambiguous evidence and continues discovering independent stale runs", async () => {
    const staleRunId = "1".repeat(32);
    const names = createRunNames(staleRunId);
    const owner = {
      pid: 92,
      birth: "12345678-1234-1234-1234-123456789abc:920",
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
      if (args[1] === "inspect") {
        return { stdout: JSON.stringify([{ Labels: labels }]), stderr: "" };
      }
      staleExists = false;
      return { stdout: "", stderr: "" };
    });
    const stderr = { write: vi.fn() };

    const runs = await reclaimProvenOrphans({
      dockerRunner,
      readFingerprint: () => `${owner.birth}-reused`,
      stderr,
    });
    expect(runs.map((run) => run.classification).sort()).toEqual(["ambiguous", "stale"]);
    expect(staleExists).toBe(false);
    expect(stderr.write).toHaveBeenCalledWith(
      "PostgreSQL harness preserved 1 ambiguous labeled Docker run; manual reconciliation required.\n",
    );
    expect(stderr.write.mock.calls.flat().join(" ")).not.toContain("permission denied");
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
      `container:${names.restore}`,
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
