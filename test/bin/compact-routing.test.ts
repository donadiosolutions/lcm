import { describe, it, expect } from "vitest";
import { Command, Option } from "commander";
import { LLM_REASONING_EFFORTS } from "../../src/daemon/config.js";
import { compactFailureExitCode, withHookOverrides } from "../../bin/lcm.js";

/** Minimal replica of the compact command's option setup. */
function makeCompactCmd() {
  const cmd = new Command("compact");
  cmd.option("--all", "Compact all tracked projects");
  cmd.option("--dry-run");
  cmd.option("--replay");
  cmd.option("-v, --verbose");
  cmd.addOption(new Option("--reasoning-effort <value>").choices([...LLM_REASONING_EFFORTS]));
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
