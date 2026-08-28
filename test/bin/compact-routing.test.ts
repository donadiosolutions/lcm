import { describe, it, expect } from "vitest";
import { Command, Option } from "commander";
import { LLM_REASONING_EFFORTS, parseDaemonConfig, reasoningEffortsForProvider } from "../../src/daemon/config.js";
import {
  compactFailureExitCode,
  parseCompactConcurrency,
  resolveCompactRequestPolicyOverride,
  resolveCompactConcurrency,
  resolveManualCompactProvider,
  withHookOverrides,
} from "../../bin/lcm.js";

/** Minimal replica of the compact command's option setup. */
function makeCompactCmd() {
  const cmd = new Command("compact");
  cmd.option("--all", "Compact all tracked projects");
  cmd.option("--dry-run");
  cmd.option("--replay");
  cmd.option("-v, --verbose");
  cmd.addOption(new Option("--reasoning-effort <value>").choices([...LLM_REASONING_EFFORTS]));
  cmd.option("--fast-mode");
  cmd.option("--no-fast-mode");
  cmd.option("--timeout-ms <ms>");
  cmd.option("--retry-max-attempts <n>");
  cmd.option("--retry-initial-delay-ms <ms>");
  cmd.option("--retry-max-delay-ms <ms>");
  cmd.option("--retry-multiplier <n>");
  cmd.option("--max-concurrency <n>");
  cmd.addOption(new Option("--hook", "Hook dispatch mode (internal)").hideHelp());
  return cmd;
}

describe("compact command --hook routing", () => {
  it("resolves CLI max concurrency over the config and clamps replay to one", () => {
    const config = parseDaemonConfig(JSON.stringify({ llm: { maxConcurrency: 8 } }));
    expect(resolveCompactConcurrency(config, {})).toBe(8);
    expect(resolveCompactConcurrency(config, { maxConcurrency: "4" })).toBe(4);
    expect(resolveCompactConcurrency(config, { replay: true })).toBe(1);
    expect(resolveCompactConcurrency(config, { replay: true, maxConcurrency: "1" })).toBe(1);
    expect(() => resolveCompactConcurrency(config, { replay: true, maxConcurrency: "2" })).toThrow("replay");
  });

  it.each(["", " 1", "1 ", "+1", "-1", "01", "1.0", "1e1", "0", "33"])(
    "rejects non-canonical max concurrency text %j",
    value => expect(() => parseCompactConcurrency(value)).toThrow("max-concurrency"),
  );

  it("rejects a missing max concurrency value", () => {
    expect(() => parseCompactConcurrency(undefined)).toThrow("max-concurrency");
    expect(() => parseCompactConcurrency("9007199254740992")).toThrow("max-concurrency");
  });

  it("accepts canonical decimal max concurrency text", () => {
    expect(parseCompactConcurrency("1")).toBe(1);
    expect(parseCompactConcurrency("32")).toBe(32);
  });

  it("defaults an absent stored concurrency to one and rejects an invalid one", () => {
    type ResolverConfig = Parameters<typeof resolveCompactConcurrency>[0];
    expect(resolveCompactConcurrency({ llm: { maxConcurrency: undefined } } as ResolverConfig, {})).toBe(1);
    expect(() => resolveCompactConcurrency({ llm: { maxConcurrency: 0 } } as ResolverConfig, {}))
      .toThrow("llm.maxConcurrency");
  });

  it("parses the max-concurrency option as canonical text for pure resolution", async () => {
    const cmd = makeCompactCmd();
    await cmd.parseAsync(["--max-concurrency", "4"], { from: "user" });
    expect(resolveCompactConcurrency(parseDaemonConfig("{}"), cmd.opts())).toBe(4);
  });

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

  it("resolves stored auto to the Claude provider used by manual batches", () => {
    const provider = resolveManualCompactProvider("auto");
    expect(provider).toBe("claude-process");
    expect(reasoningEffortsForProvider(provider)).toContain("max");
    expect(resolveManualCompactProvider("codex-process")).toBe("codex-process");
  });

  it("leaves fast mode undefined unless explicitly overridden", async () => {
    const cmd = makeCompactCmd();
    await cmd.parseAsync([], { from: "user" });
    expect(cmd.opts().fastMode).toBeUndefined();
  });

  it("uses the last fast-mode flag when both are supplied", async () => {
    const enabledLast = makeCompactCmd();
    await enabledLast.parseAsync(["--no-fast-mode", "--fast-mode"], { from: "user" });
    expect(enabledLast.opts().fastMode).toBe(true);

    const disabledLast = makeCompactCmd();
    await disabledLast.parseAsync(["--fast-mode", "--no-fast-mode"], { from: "user" });
    expect(disabledLast.opts().fastMode).toBe(false);
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

  it("accepts timeout overrides and rejects retry overrides for process providers", () => {
    const config = parseDaemonConfig(JSON.stringify({ llm: { provider: "codex-process" } }));
    expect(resolveCompactRequestPolicyOverride(config, { timeoutMs: "1000" }))
      .toMatchObject({ requestTimeoutMs: 1000 });
    expect(() => resolveCompactRequestPolicyOverride(config, { retryMaxAttempts: "2" }))
      .toThrow("retry overrides require llm.provider=\"openai\"");
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

  it("forwards a process-provider timeout without an implicit retry override", () => {
    expect(JSON.parse(withHookOverrides(
      JSON.stringify({ session_id: "session-1", cwd: "/tmp/project" }),
      "codex",
      undefined,
      { requestTimeoutMs: 300000 },
    ))).toEqual({
      session_id: "session-1",
      cwd: "/tmp/project",
      client: "codex",
      request_timeout_ms: 300000,
    });
  });

  it("preserves an explicit false fast-mode override", () => {
    expect(JSON.parse(withHookOverrides("{}", "claude", undefined, undefined, false))).toEqual({
      client: "claude",
      fast_mode: false,
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
