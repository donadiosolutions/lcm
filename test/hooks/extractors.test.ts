// test/hooks/extractors.test.ts
import { describe, it, expect } from "vitest";
import {
  extractPostToolEvents,
  extractUserPromptEvents,
  normalizePromptWithChannels,
  type ExtractedEvent,
  type PostToolInput,
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

  describe("explicit tool outcome", () => {
    it("lets outcome override a conflicting legacy isError for Bash", () => {
      const base = { tool_name: "Bash", tool_input: { command: "git branch" } };
      expect(extractPostToolEvents({ ...base, tool_output: { outcome: "succeeded", isError: true } })[0])
        .toMatchObject({ type: "git_branch" });
      expect(extractPostToolEvents({ ...base, tool_output: { outcome: "failed", isError: false } })[0])
        .toMatchObject({ type: "error_tool", data: "Bash error: git branch", priority: 1 });
      expect(extractPostToolEvents({ ...base, tool_output: { outcome: "unknown", isError: true } })[0])
        .toMatchObject({ type: "tool_outcome_unknown", data: "Bash outcome unknown: git branch" });
    });

    it("reports unknown outcomes only for selected git and env commands, without commit messages", () => {
      const unknown = (command: string) => extractPostToolEvents({
        tool_name: "Bash",
        tool_input: { command },
        tool_output: { outcome: "unknown" },
      });
      expect(unknown("git commit -m 'secret message'")).toEqual([{
        type: "tool_outcome_unknown",
        category: "tool",
        data: "Bash outcome unknown: git commit",
        priority: 3,
      }]);
      for (const command of [
        "git commit -m\"private note\"",
        "git commit --message=private-note",
      ]) {
        const events = unknown(command);
        expect(events).toHaveLength(1);
        expect(events[0]?.data).toBe("Bash outcome unknown: git commit");
        expect(events[0]?.data).not.toMatch(/private|-m|--message/u);
      }
      expect(unknown("npm install left-pad --token=secret")[0]?.data)
        .toBe("Bash outcome unknown: npm install");
      expect(unknown("npm i left-pad")[0]?.data).toBe("Bash outcome unknown: npm i");
      expect(unknown("ls -la")).toEqual([]);
    });

    it("lets outcome override a conflicting legacy isError for MCP tools", () => {
      const base = { tool_name: "mcp__s__t", tool_input: {} };
      expect(extractPostToolEvents({ ...base, tool_output: { outcome: "succeeded", isError: true } }))
        .toEqual([{ type: "mcp_call", category: "mcp", data: "mcp__s__t", priority: 3 }]);
      expect(extractPostToolEvents({ ...base, tool_output: { outcome: "failed", isError: false } }))
        .toEqual([{ type: "error_tool", category: "error", data: "mcp__s__t error", priority: 1 }]);
      expect(extractPostToolEvents({ ...base, tool_output: { outcome: "unknown", isError: true } }))
        .toEqual([{ type: "tool_outcome_unknown", category: "tool", data: "mcp__s__t outcome unknown", priority: 3 }]);
    });

    it("keeps lcm_store suppression ahead of any MCP outcome", () => {
      expect(extractPostToolEvents({
        tool_name: "mcp__plugin_lcm_lcm__lcm_store",
        tool_input: {},
        tool_output: { outcome: "failed" },
      })).toEqual([]);
    });
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


describe("extractPostToolEvents — native Codex activity", () => {
  const SENTINEL = "native-secret-must-not-be-stored";

  function call(tool_name: string, tool_input: Record<string, unknown>, tool_response?: unknown): PostToolInput {
    return tool_response === undefined ? { tool_name, tool_input } : { tool_name, tool_input, tool_response };
  }

  function patchCall(...lines: string[]): PostToolInput {
    return call("apply_patch", { command: lines.join("\n") }, "Success. Updated the following files:\nA x");
  }

  function summarize(events: ExtractedEvent[]): string[] {
    return events.map((event) => event.type + ": " + event.data);
  }

  describe("apply_patch", () => {
    it("records added, deleted, and updated files as observed file results", () => {
      const events = extractPostToolEvents(patchCall(
        "*** Begin Patch",
        "*** Add File: src/new.ts",
        "+export const value = 1;",
        "*** Delete File: docs/old.md",
        "*** Update File: src/a.test.ts",
        "@@ describe",
        "-old",
        "+new",
        "*** End Patch",
      ));
      expect(summarize(events)).toEqual([
        "file_write: src/new.ts (source)",
        "file_delete: docs/old.md (docs)",
        "file_edit: src/a.test.ts (test)",
      ]);
      for (const event of events) {
        expect(event).toMatchObject({ category: "file", priority: 3 });
      }
    });

    it("ignores header-looking text that is patch body content", () => {
      const events = extractPostToolEvents(patchCall(
        "*** Begin Patch",
        "*** Add File: src/real.ts",
        "+*** Add File: fake-added.ts",
        "+*** Delete File: fake-deleted.ts",
        "*** Update File: src/edited.ts",
        "@@",
        " *** Add File: fake-context.ts",
        "+*** Update File: fake-plus.ts",
        "-*** Delete File: fake-minus.ts",
        "*** End Patch",
      ));
      expect(summarize(events)).toEqual(["file_write: src/real.ts (source)", "file_edit: src/edited.ts (source)"]);
    });

    it("accepts trimmed headers outside update sections and trailing whitespace inside them", () => {
      const events = extractPostToolEvents(patchCall(
        "   *** Add File:   src/lenient.ts  ",
        "+body",
        "\t*** Delete File: src/gone.ts\t",
        "*** Update File: src/kept.ts   ",
        "@@",
        "*** Add File: src/after-update.ts",
      ));
      expect(summarize(events)).toEqual([
        "file_write: src/lenient.ts (source)",
        "file_delete: src/gone.ts (source)",
        "file_edit: src/kept.ts (source)",
        "file_write: src/after-update.ts (source)",
      ]);
    });

    it("records an update with a move as one event naming both paths", () => {
      const events = extractPostToolEvents(patchCall(
        "*** Update File: src/old.ts",
        "*** Move to: src/new.test.ts",
        "@@",
        "-a",
        "+b",
      ));
      expect(summarize(events)).toEqual(["file_edit: src/old.ts -> src/new.test.ts (test)"]);
    });

    it.each([
      { name: "after a hunk marker", lines: ["*** Update File: a.ts", "@@", "*** Move to: b.ts"] },
      { name: "after a body line", lines: ["*** Update File: a.ts", "-x", "*** Move to: b.ts"] },
      { name: "indented", lines: ["*** Update File: a.ts", " *** Move to: b.ts"] },
      { name: "without a trailing value", lines: ["*** Update File: a.ts", "*** Move to:"] },
      { name: "a second time", lines: ["*** Update File: a.ts", "*** Move to: b.ts", "*** Move to: c.ts"], expected: "file_edit: a.ts -> b.ts (source)" },
      { name: "after an added file", lines: ["*** Add File: a.ts", "*** Move to: b.ts"], type: "file_write" },
      { name: "after a deleted file", lines: ["*** Delete File: a.ts", "*** Move to: b.ts"], type: "file_delete" },
      { name: "before any file header", lines: ["*** Move to: b.ts"], none: true },
    ])("accepts a move only directly after an update header: $name", ({ lines, expected, type, none }) => {
      const events = summarize(extractPostToolEvents(patchCall(...lines)));
      if (none) expect(events).toEqual([]);
      else expect(events).toEqual([expected ?? (type ?? "file_edit") + ": a.ts (source)"]);
    });

    it("skips sensitive paths at either endpoint of an operation", () => {
      const events = extractPostToolEvents(patchCall(
        "*** Add File: .env",
        "*** Delete File: home/.ssh/id_rsa",
        "*** Update File: .npmrc",
        "*** Update File: src/ok.ts",
        "*** Move to: config/credentials.json",
        "*** Update File: secrets/old.ts",
        "*** Move to: src/moved.ts",
        "*** Update File: src/fine.ts",
        "*** Move to: src/also-fine.ts",
      ));
      expect(summarize(events)).toEqual(["file_edit: src/fine.ts -> src/also-fine.ts (source)"]);
    });

    it("handles CRLF patches and paths containing spaces", () => {
      const events = extractPostToolEvents({
        tool_name: "apply_patch",
        tool_input: { command: "*** Begin Patch\r\n*** Add File: my docs/read me.md\r\n+x\r\n*** Update File: a b/c d.ts\r\n@@\r\n*** End Patch\r\n" },
      });
      expect(summarize(events)).toEqual(["file_write: my docs/read me.md (docs)", "file_edit: a b/c d.ts (source)"]);
    });

    it("ignores unrelated protocol lines and never stores patch content or the response", () => {
      const events = extractPostToolEvents({
        tool_name: "apply_patch",
        tool_input: {
          command: [
            "*** Begin Patch",
            "*** Environment ID: env-1",
            "*** Add File: src/x.ts",
            "+" + SENTINEL,
            "*** Update File: src/y.ts",
            "@@",
            "+" + SENTINEL,
            "*** End of File",
            "*** End Patch",
          ].join("\n"),
        },
        tool_response: "Success. Updated the following files:\nM " + SENTINEL,
      });
      expect(summarize(events)).toEqual(["file_write: src/x.ts (source)", "file_edit: src/y.ts (source)"]);
      expect(JSON.stringify(events)).not.toContain(SENTINEL);
    });

    it("deduplicates identical observations but keeps distinct operation types", () => {
      const events = extractPostToolEvents(patchCall(
        "*** Add File: a.ts",
        "*** Update File: a.ts",
        "*** Update File: a.ts",
        "*** Delete File: a.ts",
        "*** Add File: a.ts",
      ));
      expect(summarize(events)).toEqual(["file_write: a.ts (source)", "file_edit: a.ts (source)", "file_delete: a.ts (source)"]);
    });

    it("caps observations at 20 after deduplication", () => {
      const adds = (count: number): string[] =>
        Array.from({ length: count }, (_, index) => "*** Add File: f" + index + ".ts");
      const twenty = extractPostToolEvents(patchCall("*** Add File: a.ts", "*** Add File: a.ts", ...adds(19)));
      expect(twenty).toHaveLength(20);
      expect(twenty.at(-1)?.data).toBe("f18.ts (source)");
      const capped = extractPostToolEvents(patchCall("*** Add File: a.ts", "*** Add File: a.ts", ...adds(25)));
      expect(capped).toHaveLength(20);
      expect(capped.at(-1)?.data).toBe("f18.ts (source)");
    });

    it.each([
      { name: "missing command", tool_input: {} },
      { name: "non-string command", tool_input: { command: ["*** Add File: a.ts"] } },
      { name: "no headers", tool_input: { command: "just text" } },
    ])("returns nothing for $name", ({ tool_input }) => {
      expect(extractPostToolEvents(call("apply_patch", tool_input, "Success."))).toEqual([]);
    });
  });

  describe("spawn_agent and collaborationspawn_agent", () => {
    it.each(["spawn_agent", "collaborationspawn_agent"])("labels a %s dispatch with the V2 task name", (name) => {
      const events = extractPostToolEvents(call(
        name,
        { task_name: "worker", message: SENTINEL, items: [{ type: "text", text: SENTINEL }], model: "m" },
        '{"task_name":"/root/worker"}',
      ));
      expect(events).toEqual([{ type: "subagent_dispatch", category: "subagent", data: "/root/worker", priority: 3 }]);
      expect(JSON.stringify(events)).not.toContain(SENTINEL);
    });

    it.each([
      { name: "task name over nickname", input: {}, response: '{"task_name":"/root/x","nickname":"Ada"}', expected: "/root/x" },
      { name: "response nickname", input: { task_name: "ignored" }, response: '{"agent_id":"uuid-1","nickname":"Bo"}', expected: "Bo" },
      { name: "input task name", input: { task_name: " t1 ", agent_type: "explorer" }, response: '{"agent_id":"uuid-1"}', expected: "t1" },
      { name: "input agent type", input: { agent_type: "explorer", message: SENTINEL }, response: '{"agent_id":"uuid-1"}', expected: "explorer" },
      { name: "items-only brief", input: { items: [{ type: "text", text: SENTINEL }] }, response: '{"agent_id":"uuid-1"}', expected: "agent" },
      { name: "object response", input: {}, response: { task_name: "/root/obj" }, expected: "/root/obj" },
      { name: "malformed response", input: { task_name: "t2" }, response: "not json", expected: "t2" },
      { name: "array response", input: {}, response: "[1]", expected: "agent" },
      { name: "primitive response", input: {}, response: 42, expected: "agent" },
      { name: "missing response", input: {}, response: undefined, expected: "agent" },
      { name: "non-string and blank labels", input: { task_name: 5, agent_type: "  " }, response: { task_name: "  ", nickname: null }, expected: "agent" },
    ])("derives the label from $name", ({ input, response, expected }) => {
      const events = extractPostToolEvents(call("spawn_agent", input, response));
      expect(events).toEqual([{ type: "subagent_dispatch", category: "subagent", data: expected, priority: 3 }]);
      expect(JSON.stringify(events)).not.toContain("uuid-1");
      expect(JSON.stringify(events)).not.toContain(SENTINEL);
    });

    it("clips a long label to 200 characters", () => {
      const [event] = extractPostToolEvents(call("spawn_agent", { task_name: "n".repeat(300) }));
      expect(event.data).toBe("n".repeat(200));
    });
  });

  describe("request_user_input", () => {
    const questions = [
      { id: "scope", header: "Scope", question: "Which scope?", options: [{ label: "Narrow", description: "d" }] },
    ];

    function ask(input: Record<string, unknown>, response?: unknown): ExtractedEvent[] {
      return extractPostToolEvents(call("request_user_input", input, response));
    }

    it("records an answered question as a user decision", () => {
      const events = ask(
        { questions },
        '{"answers":{"scope":{"answers":["Narrow","user_note: keep it small"]}}}',
      );
      expect(events).toEqual([
        { type: "decision", category: "decision", data: "Q: Which scope?\nA: Narrow; keep it small", priority: 1 },
      ]);
    });

    it("accepts an object response and drops non-string, empty, and note-only answers", () => {
      const events = ask(
        { questions },
        { answers: { scope: { answers: [42, null, "  ", "user_note:", "user_note:   ", " Wide ", "user_note: why"] } } },
      );
      expect(summarize(events)).toEqual(["decision: Q: Which scope?\nA: Wide; why"]);
    });

    it.each([
      { name: "empty answer list", response: '{"answers":{"scope":{"answers":[]}}}' },
      { name: "empty answers record", response: '{"answers":{}}' },
      { name: "missing answers key", response: "{}" },
      { name: "answers array", response: '{"answers":[]}' },
      { name: "malformed response", response: "not json" },
      { name: "array response", response: "[]" },
      { name: "missing response", response: undefined },
      { name: "unknown response id", response: '{"answers":{"other":{"answers":["x"]}}}' },
      { name: "string entry", response: '{"answers":{"scope":"Narrow"}}' },
      { name: "null entry", response: '{"answers":{"scope":null}}' },
      { name: "entry without answers", response: '{"answers":{"scope":{"note":"x"}}}' },
      { name: "non-array answers", response: '{"answers":{"scope":{"answers":"Narrow"}}}' },
      { name: "inherited key", response: '{"answers":{}}', id: "constructor" },
    ])("skips an unanswered question: $name", ({ response, id }) => {
      expect(ask({ questions: [{ ...questions[0], id: id ?? "scope" }] }, response)).toEqual([]);
    });

    it.each([
      { name: "missing questions", input: {} },
      { name: "non-array questions", input: { questions: "scope" } },
      { name: "non-record entries", input: { questions: [null, "scope", ["scope"]] } },
      { name: "missing id", input: { questions: [{ question: "Which scope?" }] } },
      { name: "non-string id", input: { questions: [{ id: 1, question: "Which scope?" }] } },
      { name: "blank question", input: { questions: [{ id: "scope", question: "   " }] } },
      { name: "non-string question", input: { questions: [{ id: "scope", question: 7 }] } },
      { name: "secret question", input: { questions: [{ id: "scope", question: "Token?", isSecret: true }] } },
    ])("skips invalid or secret questions: $name", ({ input }) => {
      expect(ask(input, '{"answers":{"scope":{"answers":["x"]},"1":{"answers":["x"]}}}')).toEqual([]);
    });

    it("keeps a question whose isSecret marker is not exactly true", () => {
      expect(ask(
        { questions: [{ id: "scope", question: "Which scope?", isSecret: "true" }] },
        '{"answers":{"scope":{"answers":["x"]}}}',
      )).toHaveLength(1);
    });

    it("records at most the first three questions", () => {
      const many = Array.from({ length: 5 }, (_, index) => ({ id: "q" + index, question: "Q" + index + "?" }));
      const answers = Object.fromEntries(many.map((entry) => [entry.id, { answers: ["a-" + entry.id] }]));
      const events = ask({ questions: many }, JSON.stringify({ answers }));
      expect(summarize(events)).toEqual(["decision: Q: Q0?\nA: a-q0", "decision: Q: Q1?\nA: a-q1", "decision: Q: Q2?\nA: a-q2"]);
    });

    it("applies the cap to raw questions before deduplication and filtering", () => {
      const response = JSON.stringify({
        answers: { a: { answers: ["A"] }, b: { answers: ["B"] }, c: { answers: ["C"] }, d: { answers: ["D"] } },
      });
      const duplicated = ask({
        questions: [
          { id: "a", question: "A?" },
          { id: "a", question: "A again?" },
          { id: "b", question: "B?" },
          { id: "c", question: "C?" },
        ],
      }, response);
      expect(summarize(duplicated)).toEqual(["decision: Q: A?\nA: A", "decision: Q: B?\nA: B"]);
      const unansweredHead = ask({
        questions: [
          { id: "x", question: "X?" },
          { id: "y", question: "Y?", isSecret: true },
          { id: "", question: "" },
          { id: "d", question: "D?" },
        ],
      }, response);
      expect(unansweredHead).toEqual([]);
    });

    it("deduplicates ids before the unanswered filter", () => {
      const events = ask(
        { questions: [{ id: "a", question: "First?" }, { id: "a", question: "Second?" }] },
        '{"answers":{"a":{"answers":["x"]}}}',
      );
      expect(summarize(events)).toEqual(["decision: Q: First?\nA: x"]);
      const secretFirst = ask(
        { questions: [{ id: "a", question: "Secret?", isSecret: true }, { id: "a", question: "Second?" }] },
        '{"answers":{"a":{"answers":["x"]}}}',
      );
      expect(secretFirst).toEqual([]);
    });

    it("does not capture the async variant, which only reports acceptance", () => {
      expect(extractPostToolEvents(call("request_user_input_async", { questions }, '{"accepted":true}'))).toEqual([]);
    });
  });

  describe("update_plan", () => {
    function plan(input: Record<string, unknown>): ExtractedEvent[] {
      return extractPostToolEvents(call("update_plan", input, "Plan updated"));
    }

    it("records an explained plan revision as a low-priority proposal", () => {
      const events = plan({
        explanation: "  Switch to a retry strategy  ",
        plan: [{ step: "Add retry", status: "in_progress" }, { step: " Test it ", status: "pending" }],
      });
      expect(events).toEqual([{
        type: "plan_update",
        category: "proposal",
        data: "Plan: Switch to a retry strategy\nSteps: Add retry; Test it",
        priority: 3,
      }]);
    });

    it.each([
      { name: "explanation only", input: { explanation: "Reordered", plan: [] }, expected: "Plan: Reordered" },
      { name: "missing plan", input: { explanation: "Reordered" }, expected: "Plan: Reordered" },
      { name: "non-array plan", input: { explanation: "Reordered", plan: "steps" }, expected: "Plan: Reordered" },
      {
        name: "invalid steps",
        input: { explanation: "Why", plan: [null, "x", { step: 5 }, { step: "  " }, { status: "pending" }, { step: " ok " }] },
        expected: "Plan: Why\nSteps: ok",
      },
      { name: "only invalid steps", input: { explanation: "Why", plan: [null, { step: 1 }] }, expected: "Plan: Why" },
    ])("builds the proposal text from $name", ({ input, expected }) => {
      expect(plan(input).map((event) => event.data)).toEqual([expected]);
    });

    it.each([
      { name: "no explanation", input: { plan: [{ step: "A", status: "pending" }] } },
      { name: "blank explanation", input: { explanation: "  \n", plan: [{ step: "A", status: "pending" }] } },
      { name: "non-string explanation", input: { explanation: 3, plan: [{ step: "A", status: "pending" }] } },
    ])("drops progress ticks: $name", ({ input }) => {
      expect(plan(input)).toEqual([]);
    });

    it("keeps at most ten valid steps and clips the explanation to 500 characters", () => {
      const steps = [{ step: 1 }, null, ...Array.from({ length: 11 }, (_, index) => ({ step: "s" + index }))];
      const [event] = plan({ explanation: "e".repeat(600), plan: steps });
      expect(event.data).toBe("Plan: " + "e".repeat(500) + "\nSteps: " + Array.from({ length: 10 }, (_, index) => "s" + index).join("; "));
    });
  });

  describe("failure handling", () => {
    const fixtures: { name: string; input: PostToolInput; expected: string }[] = [
      { name: "apply_patch", input: patchCall("*** Add File: a.ts"), expected: "file_write: a.ts (source)" },
      { name: "spawn_agent", input: call("spawn_agent", {}, '{"task_name":"/root/w"}'), expected: "subagent_dispatch: /root/w" },
      { name: "collaborationspawn_agent", input: call("collaborationspawn_agent", {}, '{"task_name":"/root/w"}'), expected: "subagent_dispatch: /root/w" },
      {
        name: "request_user_input",
        input: call("request_user_input", { questions: [{ id: "a", question: "Q?" }] }, '{"answers":{"a":{"answers":["x"]}}}'),
        expected: "decision: Q: Q?\nA: x",
      },
      { name: "update_plan", input: call("update_plan", { explanation: "Why", plan: [] }, "Plan updated"), expected: "plan_update: Plan: Why" },
    ];

    function withOutput(input: PostToolInput, output: unknown): PostToolInput {
      return { ...input, tool_output: output as PostToolInput["tool_output"] };
    }

    describe.each(fixtures)("$name", ({ name, input, expected }) => {
      it.each([
        { label: "tool_output absent", output: undefined },
        { label: "empty tool_output", output: {} },
        { label: "isError false", output: { isError: false } },
        { label: "outcome succeeded", output: { outcome: "succeeded" } },
        { label: "outcome unknown", output: { outcome: "unknown" } },
        { label: "outcome succeeded over isError", output: { outcome: "succeeded", isError: true } },
        { label: "outcome unknown over isError", output: { outcome: "unknown", isError: true } },
      ])("captures the native activity when $label", ({ output }) => {
        const prepared = output === undefined ? input : withOutput(input, output);
        expect(summarize(extractPostToolEvents(prepared))).toEqual([expected]);
      });

      it.each([
        { label: "isError true", output: { isError: true } },
        { label: "outcome failed with isError", output: { outcome: "failed", isError: true } },
      ])("emits one generic error when $label", ({ output }) => {
        expect(extractPostToolEvents(withOutput(input, output))).toEqual([
          { type: "error_tool", category: "error", data: name + " error", priority: 1 },
        ]);
      });

      it("emits nothing for outcome failed without isError", () => {
        expect(extractPostToolEvents(withOutput(input, { outcome: "failed" }))).toEqual([]);
      });
    });
  });

  describe("routine coordination and non-exact names", () => {
    const routine = [
      "send_message", "followup_task", "wait_agent", "list_agents", "interrupt_agent", "close_agent",
      "send_input", "resume_agent", "send_user_message_async", "request_user_input_async",
    ];

    it.each(routine.flatMap((name) => ["", "collaboration", "multi_agent_v1"].map((prefix) => prefix + name)))(
      "does not capture %s",
      (name) => {
        expect(extractPostToolEvents(call(name, { message: SENTINEL, target: "/root/w" }, '{"ok":true}'))).toEqual([]);
      },
    );

    it.each([
      "multi_agent_v1spawn_agent",
      "collaboration_spawn_agent",
      "functions.apply_patch",
      "Apply_Patch",
      "collaborationrequest_user_input",
      "functions.update_plan",
    ])("does not capture the non-exact name %s", (name) => {
      expect(extractPostToolEvents(call(name, { command: "*** Add File: a.ts", explanation: "Why" }, "{}"))).toEqual([]);
    });

    it("keeps the generic error for a failed routine call", () => {
      expect(extractPostToolEvents({
        tool_name: "collaborationwait_agent",
        tool_input: {},
        tool_output: { isError: true },
      })).toEqual([{ type: "error_tool", category: "error", data: "collaborationwait_agent error", priority: 1 }]);
    });
  });
});
