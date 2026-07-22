import { describe, expect, it } from "vitest";
import {
  MAX_CAPTURED_OUTPUT_BYTES,
  NODE_IMAGE,
  POSTGRES_IMAGE,
  RUN_LABEL,
  createRunNames,
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
      .rejects.toBeInstanceOf(Error);
  });
});
