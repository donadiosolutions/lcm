import { describe, expect, it } from "vitest";
import { resolveHookSessionScope } from "../../src/hooks/subagent-scope.js";

describe("resolveHookSessionScope", () => {
  it("keys a Codex child by agent_id and keeps the tree id separately", () => {
    expect(resolveHookSessionScope({
      client: "codex", session_id: "tree", agent_id: "child", agent_type: "worker",
    })).toEqual({
      sessionId: "child", treeSessionId: "tree", agentId: "child", agentType: "worker", isSubagent: true,
    });
  });

  it("still scopes a child when the tree id or agent type is missing or malformed", () => {
    expect(resolveHookSessionScope({ client: "codex", agent_id: "child" })).toEqual({
      sessionId: "child", treeSessionId: undefined, agentId: "child", agentType: undefined, isSubagent: true,
    });
    expect(resolveHookSessionScope({ client: "codex", session_id: 7, agent_id: "child", agent_type: 3 })).toEqual({
      sessionId: "child", treeSessionId: undefined, agentId: "child", agentType: undefined, isSubagent: true,
    });
    expect(resolveHookSessionScope({ client: "codex", session_id: "", agent_id: "child" }).treeSessionId).toBeUndefined();
  });

  it.each([
    ["an empty agent_id", { client: "codex", session_id: "tree", agent_id: "" }],
    ["a numeric agent_id", { client: "codex", session_id: "tree", agent_id: 4 }],
    ["a null agent_id", { client: "codex", session_id: "tree", agent_id: null }],
    ["a missing agent_id", { client: "codex", session_id: "tree" }],
    ["a Claude client", { client: "claude", session_id: "tree", agent_id: "child" }],
    ["no client", { session_id: "tree", agent_id: "child" }],
  ])("keeps the root session for %s", (_name, input) => {
    expect(resolveHookSessionScope(input)).toEqual({ sessionId: "tree", isSubagent: false });
  });

  it("ignores a non-string session_id for a root payload", () => {
    expect(resolveHookSessionScope({ client: "codex", session_id: 9 })).toEqual({
      sessionId: undefined, isSubagent: false,
    });
  });
});
