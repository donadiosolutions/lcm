import { describe, it, expect } from "vitest";
import { Command, Option } from "commander";
import { LLM_REASONING_EFFORTS, parseDaemonConfig } from "../../src/daemon/config.js";
import { compactFailureExitCode, resolveCompactRequestPolicyOverride, withHookOverrides } from "../../bin/lcm.js";

/** Minimal replica of the compact command's option setup. */
function makeCompactCmd() {
  const cmd = new Command("compact");
  cmd.option("--all", "Compact all tracked projects");
  cmd.option("--dry-run");
  cmd.option("--replay");
  cmd.option("-v, --verbose");
  cmd.addOption(new Option("--reasoning-effort <value>").choices([...LLM_REASONING_EFFORTS]));
  cmd.option("--timeout-ms <ms>");
  cmd.option("--retry-max-attempts <n>");
  cmd.option("--retry-initial-delay-ms <ms>");
  cmd.option("--retry-max-delay-ms <ms>");
  cmd.option("--retry-multiplier <n>");
  cmd.addOption(new Option("--hook", "Hook dispatch mode (internal)").hideHelp());
  return cmd;
}

describe("compact command --hook routing", () => {
  it("zero flags: opts.hook is falsy → batch mode", async () => {
    const cmd = makeCompactCmd();
    await cmd.parseAsync([], { from: "user" });
    expect(cmd.opts().hook).toBeFalsy();
  });

  it("--hook flag: opts.hook is true → hook dispatch", async () => {
    const cmd = makeCompactCmd();
    await cmd.parseAsync(["--hook"], { from: "user" });
    expect(cmd.opts().hook).toBe(true);
  });

  it("--hook with TTY: opts.hook is true → hook dispatch (TTY does not override --hook)", async () => {
    // TTY state is irrelevant when --hook is explicit; parsed opts reflect only flags
    const cmd = makeCompactCmd();
    await cmd.parseAsync(["--hook"], { from: "user" });
    expect(cmd.opts().hook).toBe(true);
  });

  it("--hook is hidden from help output", () => {
    const cmd = makeCompactCmd();
    const helpText = cmd.helpInformation();
    expect(helpText).not.toContain("--hook");
  });

  it("parses a one-invocation reasoning effort override", async () => {
    const cmd = makeCompactCmd();
    await cmd.parseAsync(["--reasoning-effort", "high"], { from: "user" });
    expect(cmd.opts().reasoningEffort).toBe("high");
  });

  it("parses and resolves one-invocation timeout and retry overrides", async () => {
    const cmd = makeCompactCmd();
    await cmd.parseAsync([
      "--timeout-ms", "120000",
      "--retry-max-attempts", "4",
      "--retry-initial-delay-ms", "500",
      "--retry-max-delay-ms", "10000",
      "--retry-multiplier", "2.5",
    ], { from: "user" });
    const config = parseDaemonConfig(JSON.stringify({
      llm: { provider: "openai", model: "local", baseUrl: "http://localhost:11435/v1" },
    }));

    expect(resolveCompactRequestPolicyOverride(config, cmd.opts())).toEqual({
      requestTimeoutMs: 120000,
      retry: { maxAttempts: 4, initialDelayMs: 500, maxDelayMs: 10000, multiplier: 2.5 },
    });
  });

  it("rejects timeout and retry overrides for process providers", () => {
    const config = parseDaemonConfig(JSON.stringify({ llm: { provider: "codex-process" } }));
    expect(() => resolveCompactRequestPolicyOverride(config, { timeoutMs: "1000" }))
      .toThrow("require llm.provider=\"openai\"");
  });
});

describe("withHookOverrides", () => {
  it("adds client identity and a one-invocation reasoning override", () => {
    expect(JSON.parse(withHookOverrides(
      JSON.stringify({ session_id: "session-1", cwd: "/tmp/project" }),
      "codex",
      "high",
    ))).toEqual({
      session_id: "session-1",
      cwd: "/tmp/project",
      client: "codex",
      reasoning_effort: "high",
    });
  });

  it("adds one-invocation timeout and retry overrides using daemon wire names", () => {
    expect(JSON.parse(withHookOverrides(
      JSON.stringify({ session_id: "session-1", cwd: "/tmp/project" }),
      "codex",
      undefined,
      {
        requestTimeoutMs: 120000,
        retry: { maxAttempts: 4, initialDelayMs: 500, maxDelayMs: 10000, multiplier: 2 },
      },
    ))).toMatchObject({
      request_timeout_ms: 120000,
      retry: {
        max_attempts: 4,
        initial_delay_ms: 500,
        max_delay_ms: 10000,
        multiplier: 2,
      },
    });
  });

  it("does not add unset or invalid overrides", () => {
    expect(JSON.parse(withHookOverrides("{}", "unknown", undefined))).toEqual({});
  });
});

describe("compactFailureExitCode", () => {
  it("keeps a fully successful manual batch at exit status zero", () => {
    expect(compactFailureExitCode(0)).toBeUndefined();
  });

  it("returns a nonzero exit status when any session failed", () => {
    expect(compactFailureExitCode(1)).toBe(1);
    expect(compactFailureExitCode(3)).toBe(1);
  });
});
