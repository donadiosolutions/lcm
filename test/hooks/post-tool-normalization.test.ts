import { describe, expect, it } from "vitest";
import {
  extractPostToolEvents,
  type ExtractedEvent,
  type PostToolInput,
} from "../../src/hooks/extractors.js";
import {
  codexPostToolFunctionalCoverage,
  normalizePostToolInput,
  type RawPostToolInput,
} from "../../src/hooks/post-tool-normalization.js";

const SENTINEL = "codex-raw-secret-must-not-cross-the-boundary";

function normalize(input: RawPostToolInput): PostToolInput {
  return normalizePostToolInput(input);
}

function extract(input: RawPostToolInput): ExtractedEvent[] {
  return extractPostToolEvents(normalize(input));
}

describe("normalizePostToolInput", () => {
  it.each([
    {
      name: "functions.exec command",
      tool_name: "functions.exec",
      tool_input: { command: "git commit -m 'bounded message'" },
      expectedType: "git_commit",
      expectedCategory: "git",
      expectedPriority: 2,
    },
    {
      name: "functions.exec_command cmd",
      tool_name: "functions.exec_command",
      tool_input: { cmd: "npm install exact-package" },
      expectedType: "env_install",
      expectedCategory: "env",
      expectedPriority: 2,
    },
  ])("maps the allowlisted native $name shape to canonical Bash semantics", (fixture) => {
    const normalized = normalize({ client: "codex", ...fixture });

    expect(normalized.tool_name).toBe("Bash");
    expect(normalized.tool_input).toEqual({ command: fixture.tool_input.command ?? fixture.tool_input.cmd });
    expect(extract({ client: "codex", ...fixture })[0]).toMatchObject({
      type: fixture.expectedType,
      category: fixture.expectedCategory,
      priority: fixture.expectedPriority,
    });
  });

  it.each([
    {
      name: "a non-Codex client",
      input: { client: "claude", tool_name: "functions.exec", tool_input: { command: "git branch" } },
    },
    {
      name: "an unknown functions tool",
      input: { client: "codex", tool_name: "functions.unknown", tool_input: { command: "git branch" } },
    },
    {
      name: "a client with the wrong casing",
      input: { client: "Codex", tool_name: "functions.exec_command", tool_input: { cmd: "npm install package" } },
    },
    {
      name: "a non-string command and cmd",
      input: { client: "codex", tool_name: "functions.exec", tool_input: { command: 42, cmd: { value: "npm install" } } },
    },
    {
      name: "a missing command",
      input: { client: "codex", tool_name: "functions.exec", tool_input: { operation: "read", path: "secret.txt" } },
    },
    {
      name: "a malformed tool input",
      input: { client: "codex", tool_name: "functions.exec", tool_input: null },
    },
  ])("does not create native events for $name", ({ input }) => {
    expect(extract(input)).toEqual([]);
  });

  it("uses an empty canonical name when a raw tool name is not a string", () => {
    expect(normalize({ client: "claude", tool_name: 42, tool_input: {} })).toEqual({
      tool_name: "",
      tool_input: {},
    });
    expect(normalize({ client: "codex", tool_name: 42, tool_input: {} })).toEqual({
      tool_name: "",
      tool_input: {},
    });
  });

  it("keeps non-Codex canonical tool semantics and only projects bounded status", () => {
    const normalized = normalize({
      client: "claude",
      tool_name: "AskUserQuestion",
      tool_input: { question: "Continue?" },
      tool_response: "yes",
      tool_output: { isError: true, stdout: SENTINEL },
    });

    expect(normalized).toEqual({
      tool_name: "AskUserQuestion",
      tool_input: { question: "Continue?" },
      tool_response: "yes",
      tool_output: { isError: true },
    });
    expect(extract({
      client: "claude",
      tool_name: "AskUserQuestion",
      tool_input: { question: "Continue?" },
      tool_response: "yes",
      tool_output: { isError: true, stdout: SENTINEL },
    })[0]).toMatchObject({ type: "decision" });
  });

  it("does not apply native status fields to non-Codex inputs", () => {
    expect(normalize({
      client: "claude",
      tool_name: "CustomTool",
      tool_input: {},
      tool_response: { exitCode: 1 },
      tool_output: { exit_code: 1 },
    })).toEqual({
      tool_name: "CustomTool",
      tool_input: {},
      tool_response: { exitCode: 1 },
      tool_output: {},
    });
  });

  it.each([
    { name: "isError true", output: { isError: true }, expected: true },
    { name: "isError false", output: { isError: false }, expected: false },
    { name: "snake-case error true", output: { is_error: true }, expected: true },
    { name: "snake-case error false", output: { is_error: false }, expected: false },
    { name: "zero exit_code", output: { exit_code: 0 }, expected: false },
    { name: "nonzero exit_code", output: { exit_code: 7 }, expected: true },
    { name: "zero exitCode", output: { exitCode: 0 }, expected: false },
    { name: "nonzero exitCode", output: { exitCode: -1 }, expected: true },
    {
      name: "field precedence",
      output: { isError: false, is_error: true, exit_code: 4, exitCode: 5 },
      expected: false,
    },
    {
      name: "invalid high-precedence fields",
      output: { isError: "false", is_error: "true", exit_code: 0, exitCode: 9 },
      expected: false,
    },
    {
      name: "invalid output falls back to response",
      output: { isError: "invalid", exit_code: "0" },
      response: { exitCode: 2 },
      expected: true,
    },
    {
      name: "valid output wins over response",
      output: { isError: false },
      response: { isError: true },
      expected: false,
    },
    {
      name: "empty output falls back to response",
      output: {},
      response: { is_error: false },
      expected: false,
    },
    {
      name: "non-finite output falls back to finite response",
      output: { exit_code: Number.NaN, exitCode: Number.POSITIVE_INFINITY },
      response: { exitCode: 0 },
      expected: false,
    },
  ])("projects $name using the documented status policy", ({ output, response, expected }) => {
    const normalized = normalize({
      client: "codex",
      tool_name: "functions.exec",
      tool_input: { command: "git branch" },
      tool_output: output,
      tool_response: response,
    });

    expect(normalized.tool_output).toEqual({ isError: expected });
    expect(extractPostToolEvents(normalized)[0]?.type).toBe(expected ? "error_tool" : "git_branch");
  });

  it.each([
    { name: "both sources invalid", output: { isError: "no" }, response: { exitCode: "0" } },
    { name: "nested status fields", output: { result: { isError: true } }, response: { status: { exit_code: 1 } } },
    { name: "non-record sources", output: "isError=true", response: ["exit_code", 1] },
  ])("omits canonical status for $name", ({ output, response }) => {
    const normalized = normalize({
      client: "codex",
      tool_name: "functions.exec_command",
      tool_input: { cmd: "git branch" },
      tool_output: output,
      tool_response: response,
    });

    expect(normalized.tool_output).toBeUndefined();
    expect(extractPostToolEvents(normalized)[0]?.type).toBe("git_branch");
  });

  it.each([
    "lcm store",
    " lcm  store --tags secret ",
    "lcm store\t--tags secret",
  ])("suppresses native feedback-loop command %j before status projection", (command) => {
    const normalized = normalize({
      client: "codex",
      tool_name: "functions.exec",
      tool_input: { command },
      tool_output: { isError: true, stdout: SENTINEL },
      tool_response: { is_error: true, stderr: SENTINEL },
    });

    expect(normalized).toEqual({ tool_name: "Bash", tool_input: { command: "" } });
    expect(extractPostToolEvents(normalized)).toEqual([]);
    expect(JSON.stringify(normalized)).not.toContain(SENTINEL);
  });

  it.each([
    { tool_name: "lcm_store", output: undefined },
    { tool_name: "lcm_store", output: { isError: true } },
    { tool_name: "mcp__plugin_lcm_lcm__lcm_store", output: undefined },
    { tool_name: "mcp__plugin_lcm_lcm__lcm_store", output: { is_error: true } },
  ])("preserves existing tool-name feedback-loop suppression for %j", ({ tool_name, output }) => {
    expect(extract({
      client: "codex",
      tool_name,
      tool_input: { text: "stored context" },
      tool_output: output,
    })).toEqual([]);
  });

  it("uses the exact feedback-loop boundary", () => {
    expect(extract({
      client: "codex",
      tool_name: "functions.exec",
      tool_input: { command: "lcm storehouse" },
      tool_output: { isError: true },
    })[0]).toMatchObject({ type: "error_tool" });
  });

  it("gives command precedence over cmd, including an explicitly blank command", () => {
    const commandWins = normalize({
      client: "codex",
      tool_name: "functions.exec_command",
      tool_input: { command: "git branch preferred", cmd: "npm install ignored" },
    });
    expect(commandWins.tool_input).toEqual({ command: "git branch preferred" });
    expect(extractPostToolEvents(commandWins)[0]?.type).toBe("git_branch");

    const blankWins = normalize({
      client: "codex",
      tool_name: "functions.exec_command",
      tool_input: { command: "", cmd: "npm install ignored" },
      tool_output: { isError: true },
    });
    expect(blankWins).toEqual({ tool_name: "Bash", tool_input: { command: "" } });
    expect(extractPostToolEvents(blankWins)).toEqual([]);
  });

  it("falls back to cmd only when command is not a string", () => {
    const normalized = normalize({
      client: "codex",
      tool_name: "functions.exec_command",
      tool_input: { command: 42, cmd: "npm install fallback" },
    });

    expect(normalized.tool_input).toEqual({ command: "npm install fallback" });
    expect(extractPostToolEvents(normalized)[0]?.type).toBe("env_install");
  });

  it("turns whitespace-only commands into an inert canonical input without trimming commands for extraction", () => {
    const whitespace = normalize({
      client: "codex",
      tool_name: "functions.exec",
      tool_input: { command: " \t\n" },
      tool_output: { isError: true },
    });
    expect(whitespace).toEqual({ tool_name: "Bash", tool_input: { command: "" } });
    expect(extractPostToolEvents(whitespace)).toEqual([]);

    const leadingSpace = normalize({
      client: "codex",
      tool_name: "functions.exec",
      tool_input: { command: " git branch" },
    });
    expect(leadingSpace.tool_input).toEqual({ command: " git branch" });
    expect(extractPostToolEvents(leadingSpace)).toEqual([]);
  });

  it("bounds the command before it reaches extraction", () => {
    const normalized = normalize({
      client: "codex",
      tool_name: "functions.exec_command",
      tool_input: { cmd: `npm install ${"x".repeat(2500)}` },
    });
    const boundedCommand = normalized.tool_input.command;

    expect(typeof boundedCommand).toBe("string");
    expect(boundedCommand).toHaveLength(2003);
    expect(boundedCommand).toMatch(/x\.\.\.$/u);
    expect(extractPostToolEvents(normalized)[0]).toMatchObject({
      type: "env_install",
      data: boundedCommand,
    });
  });

  it.each([
    "cat /tmp/readme.md",
    "sed -n '1p' /tmp/readme.md",
    "rm /tmp/readme.md",
    "printf 'hello' > /tmp/readme.md",
  ])("does not infer file events from shell text %j or unknown file-like fields", (command) => {
    const normalized = normalize({
      client: "codex",
      tool_name: "functions.exec",
      tool_input: {
        command,
        operation: "read",
        path: "/tmp/secret.txt",
        file_path: "/tmp/secret.txt",
        file: { path: "/tmp/secret.txt" },
      },
    });

    expect(normalized.tool_input).toEqual({ command });
    expect(extractPostToolEvents(normalized)).toEqual([]);
  });

  it("never copies raw Codex response/output or unknown input fields", () => {
    const normalized = normalize({
      client: "codex",
      tool_name: "functions.exec",
      tool_input: {
        command: "git branch",
        stdout: SENTINEL,
        stderr: SENTINEL,
        unknown: SENTINEL,
      },
      tool_output: { isError: true, stdout: SENTINEL, stderr: SENTINEL, secret: SENTINEL },
      tool_response: { stdout: SENTINEL, stderr: SENTINEL, secret: SENTINEL },
    });

    expect(JSON.stringify(normalized)).not.toContain(SENTINEL);
    expect(JSON.stringify(extractPostToolEvents(normalized))).not.toContain(SENTINEL);
    expect(extractPostToolEvents(normalized)[0]).toMatchObject({
      type: "error_tool",
      data: "Bash error: git branch",
    });
  });

  it("proves both fixed benign functional coverage fixtures in memory", () => {
    expect(codexPostToolFunctionalCoverage()).toBe(true);
  });
});
