import { describe, expect, it } from "vitest";
import {
  NODE_IMAGE,
  POSTGRES_IMAGE,
  RUN_LABEL,
  createRunNames,
  runProcess,
  sanitizeHarnessText,
  validateRunNames,
} from "../../scripts/postgresql-harness.mjs";

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
    await expect(runProcess("lcm-command-that-does-not-exist", []))
      .rejects.toBeInstanceOf(Error);
  });
});
