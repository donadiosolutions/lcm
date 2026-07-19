// test/hooks/extractors.test.ts
import { describe, it, expect } from "vitest";
import {
  extractPostToolEvents,
  extractUserPromptEvents,
  normalizePromptWithChannels,
  type ExtractedEvent,
} from "../../src/hooks/extractors.js";

describe("extractPostToolEvents", () => {
  it("extracts decision from AskUserQuestion", () => {
    const events = extractPostToolEvents({
      tool_name: "AskUserQuestion",
      tool_input: { question: "Use SQLite or Postgres?" },
      tool_response: "SQLite",
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "decision",
      category: "decision",
      priority: 1,
      data: expect.stringContaining("SQLite"),
    });
  });

  it("defaults missing question and answer fields", () => {
    expect(extractPostToolEvents({ tool_name: "AskUserQuestion", tool_input: {} })[0].data)
      .toBe("Q: \nA: ");
  });

  it("extracts error from Bash with isError", () => {
    const events = extractPostToolEvents({
      tool_name: "Bash",
      tool_input: { command: "npm install broken-pkg" },
      tool_output: { isError: true },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "error_tool",
      category: "error",
      priority: 1,
    });
  });

  it("extracts git commit from Bash", () => {
    const events = extractPostToolEvents({
      tool_name: "Bash",
      tool_input: { command: 'git commit -m "fix: thing"' },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "git_commit",
      category: "git",
      priority: 2,
    });
  });

  it("extracts file path from Read", () => {
    const events = extractPostToolEvents({
      tool_name: "Read",
      tool_input: { file_path: "/project/src/main.ts" },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "file_read",
      category: "file",
      priority: 3,
    });
  });

  it("skips sensitive file paths", () => {
    const events = extractPostToolEvents({
      tool_name: "Read",
      tool_input: { file_path: "/project/.env" },
    });
    expect(events).toHaveLength(0);
  });

  it("skips lcm_store calls", () => {
    const events = extractPostToolEvents({
      tool_name: "mcp__plugin_lcm_lcm__lcm_store",
      tool_input: { text: "something" },
    });
    expect(events).toHaveLength(0);
  });

  it("returns empty for unrecognized tools", () => {
    const events = extractPostToolEvents({
      tool_name: "SomeUnknownTool",
      tool_input: {},
    });
    expect(events).toHaveLength(0);
  });

  it("extracts plan approval from ExitPlanMode", () => {
    const events = extractPostToolEvents({
      tool_name: "ExitPlanMode",
      tool_input: {},
      tool_response: "Plan approved",
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "plan_exit",
      category: "plan",
      priority: 1,
      data: expect.stringContaining("approved"),
    });
  });

  it.each([
    ["Plan rejected", "rejected"],
    ["Closed without a decision", "exited"],
  ])("extracts the %s plan outcome", (response, status) => {
    expect(extractPostToolEvents({
      tool_name: "ExitPlanMode",
      tool_input: {},
      tool_response: response,
    })[0].data).toBe(`Plan ${status}`);
  });

  it("defaults a missing plan outcome to exited", () => {
    expect(extractPostToolEvents({ tool_name: "ExitPlanMode", tool_input: {} })[0].data).toBe("Plan exited");
  });

  it("extracts plan entry", () => {
    expect(extractPostToolEvents({ tool_name: "EnterPlanMode", tool_input: {} })[0].type)
      .toBe("plan_enter");
  });

  it("extracts env commands from Bash", () => {
    const events = extractPostToolEvents({
      tool_name: "Bash",
      tool_input: { command: "npm install lodash" },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      category: "env",
      priority: 2,
    });
  });

  it("returns no event for an unrelated or missing Bash command", () => {
    expect(extractPostToolEvents({ tool_name: "Bash", tool_input: {} })).toEqual([]);
    expect(extractPostToolEvents({
      tool_name: "Bash",
      tool_input: { command: "echo okay" },
      tool_output: { isError: false },
    })).toEqual([]);
  });

  it("extracts a git operation without a commit message", () => {
    expect(extractPostToolEvents({
      tool_name: "Bash",
      tool_input: { command: "git push origin main" },
    })[0]).toMatchObject({ type: "git_push", data: "git push" });
  });

  it.each([
    ["Edit", { path: "/project/config.json" }, "file_edit", "config"],
    ["Write", { file_path: "/project/docs/readme.md" }, "file_write", "docs"],
    ["Glob", { pattern: "/project/__tests__/*.ts" }, "file_glob", "test"],
    ["Grep", { path: "/project/src/main.ts" }, "file_grep", "source"],
  ])("classifies %s file operations", (toolName, toolInput, type, classification) => {
    const event = extractPostToolEvents({ tool_name: toolName, tool_input: toolInput })[0];
    expect(event).toMatchObject({ type, category: "file" });
    expect(event.data).toContain(`(${classification})`);
  });

  it("skips file operations without a path", () => {
    expect(extractPostToolEvents({ tool_name: "Read", tool_input: {} })).toEqual([]);
  });

  it.each([
    ["TaskCreate", { subject: "Ship it" }, "task_create", "Ship it → created"],
    ["TaskUpdate", { taskId: "42", status: "done" }, "task_update", "42 → done"],
  ])("extracts %s events", (toolName, toolInput, type, data) => {
    expect(extractPostToolEvents({ tool_name: toolName, tool_input: toolInput })[0])
      .toMatchObject({ type, data });
  });

  it("defaults missing task, agent, and skill fields", () => {
    expect(extractPostToolEvents({ tool_name: "TaskUpdate", tool_input: {} })[0].data).toBe(" → created");
    expect(extractPostToolEvents({ tool_name: "Agent", tool_input: {} })[0].data).toBe("");
    expect(extractPostToolEvents({ tool_name: "Skill", tool_input: {} })[0].data).toBe("");
  });

  it("extracts a non-Bash tool error", () => {
    expect(extractPostToolEvents({
      tool_name: "CustomTool",
      tool_input: {},
      tool_output: { isError: true },
    })[0]).toMatchObject({ type: "error_tool", data: "CustomTool error" });
  });

  it("extracts skill usage", () => {
    const events = extractPostToolEvents({
      tool_name: "Skill",
      tool_input: { skill: "tdd" },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      category: "skill",
      priority: 3,
    });
  });

  it("extracts subagent dispatch", () => {
    const events = extractPostToolEvents({
      tool_name: "Agent",
      tool_input: { description: "Run tests" },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      category: "subagent",
      priority: 3,
    });
  });

  it("extracts mcp tool usage (not lcm_store)", () => {
    const events = extractPostToolEvents({
      tool_name: "mcp__plugin_context-mode__ctx_search",
      tool_input: { queries: ["test"] },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      category: "mcp",
      priority: 3,
      data: "mcp__plugin_context-mode__ctx_search",
    });
  });

  it("truncates data at 2000 char soft cap", () => {
    const events = extractPostToolEvents({
      tool_name: "AskUserQuestion",
      tool_input: { question: "x".repeat(3000) },
      tool_response: "yes",
    });
    expect(events[0].data.length).toBeLessThanOrEqual(2050); // soft cap with some slack
  });
});

describe("extractUserPromptEvents", () => {
  it("extracts decision from 'always use' pattern", () => {
    const events = extractUserPromptEvents("always use TypeScript for new files");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      category: "decision",
      priority: 1,
    });
  });

  it("extracts role from 'I'm a' pattern", () => {
    const events = extractUserPromptEvents("I'm a data scientist investigating logs");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      category: "role",
      priority: 2,
    });
  });

  it("extracts intent from 'explain' keyword", () => {
    const events = extractUserPromptEvents("explain how the daemon works");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      category: "intent",
      priority: 3,
    });
  });

  // Negative-match guards
  it("does NOT extract decision from 'don't worry'", () => {
    const events = extractUserPromptEvents("don't worry about tests");
    expect(events.filter(e => e.category === "decision")).toHaveLength(0);
  });

  it("does NOT extract decision from 'never mind'", () => {
    const events = extractUserPromptEvents("never mind, let's move on");
    expect(events.filter(e => e.category === "decision")).toHaveLength(0);
  });

  it("does NOT extract decision from 'not sure'", () => {
    const events = extractUserPromptEvents("I'm not sure about that");
    expect(events.filter(e => e.category === "decision")).toHaveLength(0);
  });

  it("does NOT extract decision from 'doesn't matter'", () => {
    const events = extractUserPromptEvents("it doesn't matter which one");
    expect(events.filter(e => e.category === "decision")).toHaveLength(0);
  });

  it("returns empty for generic prompts", () => {
    const events = extractUserPromptEvents("fix the bug in main.ts");
    // "fix" matches intent, so we expect 1 intent event
    expect(events.filter(e => e.category === "decision")).toHaveLength(0);
  });

  it.each([
    ["build a feature", "intent_implement"],
    ["verify the result", "intent_review"],
    ["refactor this module", "intent_refactor"],
  ])("extracts %s", (prompt, type) => {
    expect(extractUserPromptEvents(prompt)[0].type).toBe(type);
  });

  it("extracts the senior engineer role pattern", () => {
    expect(extractUserPromptEvents("staff engineer")[0].type).toBe("user_role");
  });

  it("adds channel tags to role and intent events", () => {
    const events = extractUserPromptEvents(
      '<channel source="telegram">staff engineer, please verify this</channel>',
    );
    expect(events.map((event) => event.type)).toEqual(["user_role", "intent_review"]);
    expect(events.every((event) => event.tags?.includes("source:telegram"))).toBe(true);
  });
});

describe("normalizePromptWithChannels", () => {
  it("strips channel XML and returns clean text", () => {
    const raw = '<channel source="telegram" chat_id="123" message_id="456" user="pedro" ts="1234">always use TypeScript</channel>';
    const { text, fromChannel } = normalizePromptWithChannels(raw);
    expect(text).toBe("always use TypeScript");
    expect(fromChannel).toBe(true);
  });

  it("returns original text unchanged when no channel tag present", () => {
    const raw = "always use TypeScript";
    const { text, fromChannel } = normalizePromptWithChannels(raw);
    expect(text).toBe("always use TypeScript");
    expect(fromChannel).toBe(false);
  });

  it("handles multi-line channel content", () => {
    const raw = '<channel source="telegram" chat_id="1">\nalways use TypeScript\nfor new files\n</channel>';
    const { text, fromChannel } = normalizePromptWithChannels(raw);
    expect(text).toBe("always use TypeScript\nfor new files");
    expect(fromChannel).toBe(true);
  });

  it("handles large unterminated channel text in one pass", () => {
    const raw = `<channel source="telegram">${" ".repeat(100_000)}`;
    expect(normalizePromptWithChannels(raw)).toEqual({ text: raw, fromChannel: false });
  });

  it("preserves a channel opener without a closing angle bracket", () => {
    expect(normalizePromptWithChannels("prefix <channel source=telegram")).toEqual({
      text: "prefix <channel source=telegram",
      fromChannel: false,
    });
  });

  it.each(["channeling", "channel-extra"])('preserves malformed tag name "%s"', (tagName) => {
    const raw = `<${tagName}>always use TypeScript</channel>`;
    expect(normalizePromptWithChannels(raw)).toEqual({ text: raw, fromChannel: false });
    expect(extractUserPromptEvents(raw).every((event) => !event.tags?.includes("source:telegram"))).toBe(true);
  });
});

describe("extractUserPromptEvents — Telegram channel wrapping", () => {
  it("extracts decision from channel-wrapped prompt", () => {
    const raw = '<channel source="telegram" chat_id="123" message_id="456" user="pedro" ts="1234">always use TypeScript for new files</channel>';
    const events = extractUserPromptEvents(raw);
    const decisions = events.filter(e => e.category === "decision");
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      type: "user_decision",
      category: "decision",
      priority: 1,
    });
  });

  it("strips XML from stored data in decision events from Telegram", () => {
    const raw = '<channel source="telegram" chat_id="123" message_id="1" user="pedro" ts="1234">always use TypeScript for new files</channel>';
    const events = extractUserPromptEvents(raw);
    const decision = events.find(e => e.category === "decision");
    expect(decision).toBeDefined();
    expect(decision!.data).not.toContain("<channel");
    expect(decision!.data).toContain("always use TypeScript");
  });

  it("adds source:telegram tag to events extracted from channel messages", () => {
    const raw = '<channel source="telegram" chat_id="123" message_id="1" user="pedro" ts="1234">always use TypeScript</channel>';
    const events = extractUserPromptEvents(raw);
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(event.tags).toContain("source:telegram");
    }
  });

  it("does NOT add source:telegram tag for non-channel prompts", () => {
    const events = extractUserPromptEvents("always use TypeScript");
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(event.tags).toBeUndefined();
    }
  });
});
