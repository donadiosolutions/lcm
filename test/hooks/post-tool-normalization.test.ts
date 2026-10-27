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
    expect(normalized.tool_output).toEqual({ outcome: "unknown" });
    expect(extract({ client: "codex", ...fixture, tool_response: { exit_code: 0 } })[0]).toMatchObject({
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

    expect(normalized.tool_output).toEqual({ outcome: expected ? "failed" : "succeeded" });
    expect(extractPostToolEvents(normalized)[0]?.type).toBe(expected ? "error_tool" : "git_branch");
  });

  it.each([
    { name: "both sources invalid", output: { isError: "no" }, response: { exitCode: "0" } },
    { name: "nested status fields", output: { result: { isError: true } }, response: { status: { exit_code: 1 } } },
    { name: "non-record sources", output: "isError=true", response: ["exit_code", 1] },
  ])("reports an unknown outcome for $name", ({ output, response }) => {
    const normalized = normalize({
      client: "codex",
      tool_name: "functions.exec_command",
      tool_input: { cmd: "git branch" },
      tool_output: output,
      tool_response: response,
    });

    expect(normalized.tool_output).toEqual({ outcome: "unknown" });
    expect(extractPostToolEvents(normalized)[0]).toMatchObject({
      type: "tool_outcome_unknown",
      data: "Bash outcome unknown: git branch",
    });
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
      tool_response: { exit_code: 0 },
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
      tool_response: { exit_code: 0 },
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
      tool_response: { exit_code: 0 },
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

  describe("current Codex 0.163 shapes", () => {
    it("maps the current Bash name, ignoring the original command id and textual output", () => {
      const raw = {
        client: "codex",
        tool_name: "Bash",
        tool_use_id: "exec-call-45",
        tool_input: { command: "git commit -m 'x'" },
        tool_response: "finished\n",
      };
      const normalized = normalize(raw);

      expect(normalized).toEqual({
        tool_name: "Bash",
        tool_input: { command: "git commit -m 'x'" },
        tool_output: { outcome: "unknown" },
      });
      expect(extractPostToolEvents(normalized)).toEqual([{
        type: "tool_outcome_unknown",
        category: "tool",
        data: "Bash outcome unknown: git commit",
        priority: 3,
      }]);
    });

    it("never parses textual results for an exit status", () => {
      const events = extract({
        client: "codex",
        tool_name: "Bash",
        tool_input: { command: "git push" },
        tool_response: "Process exited with code 1\nPROCESS ERROR",
      });
      expect(events.map(event => event.type)).toEqual(["tool_outcome_unknown"]);
    });

    it("records no event for unselected commands, including a poll completion", () => {
      expect(extract({
        client: "codex",
        tool_name: "Bash",
        tool_use_id: "exec-call-45",
        tool_input: { command: "sleep 1; echo finished" },
        tool_response: "finished\n",
      })).toEqual([]);
    });

    it("keeps structured shell failure and success on the Bash path", () => {
      expect(extract({
        client: "codex",
        tool_name: "Bash",
        tool_input: { command: "git push origin main" },
        tool_response: { exit_code: 1 },
      })[0]).toMatchObject({ type: "error_tool", data: "Bash error: git push origin" });
      expect(extract({
        client: "codex",
        tool_name: "Bash",
        tool_input: { command: "git push origin main" },
        tool_response: { exit_code: 0 },
      })[0]).toMatchObject({ type: "git_push" });
    });

    it("suppresses the current Bash name for lcm store without an outcome", () => {
      expect(normalize({
        client: "codex",
        tool_name: "Bash",
        tool_input: { command: "lcm store x" },
      })).toEqual({ tool_name: "Bash", tool_input: { command: "" } });
    });

    it("treats a non-Codex Bash payload with the legacy status path", () => {
      expect(extract({
        client: "claude",
        tool_name: "Bash",
        tool_input: { command: "git branch" },
        tool_output: { isError: true },
      })[0]).toMatchObject({ type: "error_tool" });
    });

    it.each([
      { name: "content array", response: { content: [{ type: "text", text: SENTINEL }] }, outcome: "succeeded" },
      { name: "empty content array", response: { content: [] }, outcome: "succeeded" },
      { name: "explicit isError false", response: { content: [], isError: false }, outcome: "succeeded" },
      { name: "isError false without content", response: { isError: false }, outcome: "succeeded" },
      { name: "isError true", response: { content: [], isError: true }, outcome: "failed" },
      { name: "is_error true alias", response: { content: [], is_error: true }, outcome: "failed" },
      { name: "is_error false alias", response: { is_error: false }, outcome: "succeeded" },
      { name: "non-boolean isError", response: { content: [], isError: "false" }, outcome: "unknown" },
      { name: "non-boolean is_error", response: { content: [], is_error: 0 }, outcome: "unknown" },
      { name: "isError wins over is_error", response: { content: [], isError: false, is_error: true }, outcome: "succeeded" },
      { name: "structuredContent only", response: { structuredContent: { a: SENTINEL } }, outcome: "unknown" },
      { name: "_meta only", response: { _meta: { a: 1 } }, outcome: "unknown" },
      { name: "non-array content", response: { content: "text" }, outcome: "unknown" },
      { name: "string response", response: SENTINEL, outcome: "unknown" },
      { name: "array response", response: [SENTINEL], outcome: "unknown" },
      { name: "missing response", response: undefined, outcome: "unknown" },
    ])("derives an MCP outcome from $name", ({ response, outcome }) => {
      const normalized = normalize({
        client: "codex",
        tool_name: "mcp__server__tool",
        tool_input: { query: SENTINEL },
        tool_response: response,
      });

      expect(normalized).toEqual({
        tool_name: "mcp__server__tool",
        tool_input: {},
        tool_output: { outcome },
      });
      expect(JSON.stringify(normalized)).not.toContain(SENTINEL);
      expect(extractPostToolEvents(normalized)[0]).toMatchObject(
        outcome === "succeeded"
          ? { type: "mcp_call", data: "mcp__server__tool", priority: 3 }
          : outcome === "failed"
            ? { type: "error_tool", data: "mcp__server__tool error", priority: 1 }
            : { type: "tool_outcome_unknown", data: "mcp__server__tool outcome unknown", priority: 3 },
      );
    });

    it("prefers a status on tool_output over tool_response for MCP", () => {
      expect(normalize({
        client: "codex",
        tool_name: "mcp__server__tool",
        tool_input: {},
        tool_output: { isError: true },
        tool_response: { content: [] },
      }).tool_output).toEqual({ outcome: "failed" });
      expect(normalize({
        client: "codex",
        tool_name: "mcp__server__tool",
        tool_input: {},
        tool_output: { content: [] },
        tool_response: { isError: true },
      }).tool_output).toEqual({ outcome: "failed" });
    });

    it("leaves MCP tools of non-Codex clients unchanged", () => {
      expect(extract({
        client: "claude",
        tool_name: "mcp__server__tool",
        tool_input: { a: 1 },
        tool_output: { isError: true },
      })).toEqual([{ type: "mcp_call", category: "mcp", data: "mcp__server__tool", priority: 3 }]);
    });
  });
});

describe("native Codex activity through normalization", () => {
  const sentinel = "native-activity-raw-secret";

  it.each([
    {
      name: "apply_patch",
      input: {
        tool_name: "apply_patch",
        tool_input: { command: "*** Begin Patch\n*** Add File: src/new.ts\n+" + sentinel + "\n*** End Patch" },
        tool_response: "Success. Updated the following files:\nA src/new.ts",
      },
      expected: { type: "file_write", category: "file", data: "src/new.ts (source)", priority: 3 },
    },
    {
      name: "collaborationspawn_agent",
      input: {
        tool_name: "collaborationspawn_agent",
        tool_input: { message: sentinel },
        tool_response: '{"task_name":"/root/worker"}',
      },
      expected: { type: "subagent_dispatch", category: "subagent", data: "/root/worker", priority: 3 },
    },
    {
      name: "request_user_input",
      input: {
        tool_name: "request_user_input",
        tool_input: { questions: [{ id: "scope", header: "Scope", question: "Which scope?", options: [] }] },
        tool_response: '{"answers":{"scope":{"answers":["Narrow"]}}}',
      },
      expected: { type: "decision", category: "decision", data: "Q: Which scope?\nA: Narrow", priority: 1 },
    },
    {
      name: "update_plan",
      input: {
        tool_name: "update_plan",
        tool_input: { explanation: "Reordered", plan: [{ step: "Do it", status: "pending" }] },
        tool_response: "Plan updated",
      },
      expected: { type: "plan_update", category: "proposal", data: "Plan: Reordered\nSteps: Do it", priority: 3 },
    },
  ])("passes native $name through unchanged and extracts its event", ({ input, expected }) => {
    const normalized = normalize({ client: "codex", ...input });

    expect(normalized).toEqual(input);
    expect(extractPostToolEvents(normalized)).toEqual([expected]);
    expect(JSON.stringify(extractPostToolEvents(normalized))).not.toContain(sentinel);
  });

  it("keeps a legacy isError projection so a failed native call yields the generic error", () => {
    const normalized = normalize({
      client: "codex",
      tool_name: "update_plan",
      tool_input: { explanation: "Reordered", plan: [] },
      tool_output: { isError: true, stdout: sentinel },
    });

    expect(normalized.tool_output).toEqual({ isError: true });
    expect(extractPostToolEvents(normalized)).toEqual([
      { type: "error_tool", category: "error", data: "update_plan error", priority: 1 },
    ]);
  });
});
