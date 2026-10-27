import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  computeCodexHookHash,
  formatCodexReadiness,
  inspectCodexReadiness,
  readCodexReadinessFile,
  runCodexReadinessCheck,
  type CodexReadinessInput,
  type CodexReadinessRow,
} from "../../src/connectors/codex-readiness.js";
import { codexLcmHooks } from "../../src/connectors/codex-hooks.js";
import type { CodexHookReceipt } from "../../src/hooks/codex-hook-receipts.js";

const HOOKS = "/home/u/.codex/hooks.json";

// Literal Codex 0.163.0 hooks/list currentHash goldens (evidence/codex-hooks-list-golden.md).
const GOLDEN = {
  post: "sha256:7bca176693d94844cb28344ff833bfc7c8a8057419e2952d51d6af9729bd9a12",
  pre: "sha256:0b5fb357ddca9022046ac17ac0fba04f96027bec5d0c1a0813748764dbfbd108",
  session: "sha256:9bea3dc130dcc86cd86060e3dbbb60f5b990611580887b626c18832f560bf12b",
  sessionLegacy: "sha256:a8b15750a2208c3b5267b74a26eadbab24503ab3f31ae48e7dc45c7e75b18da7",
  promptCli: "sha256:c686e888147a6d5ab6d70a6a7f4863c3bcff608d0b3fd9fd320147efd187915e",
  promptMcp: "sha256:c58011b176453632fc6f5a0f30f97d0497892c8061413423644b6f0ec6c51ac9",
  stop: "sha256:6b95211647571f6197d0375b6230fcc37488515b048d24ad1dbc20073900ee31",
  subagentStart: "sha256:1c72208d0824a812e642574d20a7c17ce8e3ebe6f582ece11590959dcfcbcc76",
  subagentStop: "sha256:22c21408f46ecf3fbcadecd5dd9f1b2585a273e30ca46ae85040f199f0f44a12",
  interrupt: "sha256:8b30c34242015a60fead632bfa0f58a9a9e7561afe958f038d2c3f72eb0a4e62",
  sessionEnd: "sha256:ca7a4d92ea4a593150b9734c2018c5fe9d0e76eb77f6d62cfbebf6c41b0656d9",
  foreign: "sha256:9e559ad47195227680137c179e4b2ea8e191d4bc023e76f73f6e74fdb97b85bb",
  preTool: "sha256:ab1f47b7396d2f3349aa0006cb6e7aff8bacc25a9fb447a0bb2edd5fbf9a6fe1",
};

type StateEntry = readonly [snakeEvent: string, group: number, handler: number, hash: string];
const TRUSTED_ALL: readonly StateEntry[] = [
  ["session_start", 0, 0, GOLDEN.session],
  ["user_prompt_submit", 0, 0, GOLDEN.promptCli],
  ["post_tool_use", 0, 0, GOLDEN.post],
  ["pre_compact", 0, 0, GOLDEN.pre],
  ["stop", 0, 0, GOLDEN.stop],
  ["subagent_start", 0, 0, GOLDEN.subagentStart],
  ["subagent_stop", 0, 0, GOLDEN.subagentStop],
  ["interrupt", 0, 0, GOLDEN.interrupt],
  ["session_end", 0, 0, GOLDEN.sessionEnd],
];

function trustToml(entries: readonly StateEntry[], extra = ""): string {
  return entries
    .map(([event, group, handler, hash]) => '[hooks.state."' + HOOKS + ":" + event + ":" + group + ":" + handler + '"]\ntrusted_hash = "' + hash + '"\n')
    .join("\n") + extra;
}

const FULL_HOOKS = JSON.stringify({ hooks: codexLcmHooks("cli") });

function receipt(over: Partial<CodexHookReceipt> = {}): CodexHookReceipt {
  return { version: 1, event: "SessionStart", startedAt: 1_000_000, completedAt: 1_000_100, outcome: "exit-0", exitCode: 0, loggedErrors: false, ...over };
}

function input(over: Partial<CodexReadinessInput> = {}): CodexReadinessInput {
  return {
    hooksPath: HOOKS,
    hooks: { state: "content", content: FULL_HOOKS, mtimeMs: 1000 },
    config: { state: "content", content: trustToml(TRUSTED_ALL) },
    receipts: [],
    version: { state: "found", raw: "codex-cli 0.163.0" },
    storedTransport: { state: "none" },
    now: 2_000_000,
    platform: "linux",
    ...over,
  };
}

function statuses(report: ReturnType<typeof inspectCodexReadiness>): Record<string, string> {
  return Object.fromEntries(report.rows.map((row) => [row.event + "/" + row.role, row.status]));
}

function hooksWith(mutate: (hooks: Record<string, any[]>) => void): CodexReadinessInput["hooks"] {
  const hooks = JSON.parse(FULL_HOOKS).hooks as Record<string, any[]>;
  mutate(hooks);
  return { state: "content", content: JSON.stringify({ hooks }), mtimeMs: 1000 };
}

describe("computeCodexHookHash", () => {
  const lcm = codexLcmHooks("cli");
  const hashOf = (event: string, transport: "cli" | "mcp" = "cli") => {
    const group = codexLcmHooks(transport)[event][0];
    return computeCodexHookHash(event, group, group.hooks![0], "linux");
  };

  it("reproduces every Codex 0.163.0 hooks/list golden", () => {
    expect(hashOf("PostToolUse")).toBe(GOLDEN.post);
    expect(hashOf("PreCompact")).toBe(GOLDEN.pre);
    expect(hashOf("SessionStart")).toBe(GOLDEN.session);
    expect(hashOf("UserPromptSubmit")).toBe(GOLDEN.promptCli);
    expect(hashOf("UserPromptSubmit", "mcp")).toBe(GOLDEN.promptMcp);
    expect(hashOf("Stop")).toBe(GOLDEN.stop);
    expect(hashOf("SubagentStart")).toBe(GOLDEN.subagentStart);
    expect(hashOf("SubagentStop")).toBe(GOLDEN.subagentStop);
    const preTool = codexLcmHooks("cli", { preToolRecall: true }).PreToolUse[0];
    expect(computeCodexHookHash("PreToolUse", preTool, preTool.hooks![0], "linux")).toBe(GOLDEN.preTool);
    expect(hashOf("Interrupt")).toBe(GOLDEN.interrupt);
    expect(hashOf("SessionEnd")).toBe(GOLDEN.sessionEnd);
    expect(computeCodexHookHash(
      "SessionStart",
      { matcher: "startup|resume|clear" },
      { type: "command", command: "lcm restore --client codex", timeout: 30, statusMessage: "Loading LCM memory" },
      "linux",
    )).toBe(GOLDEN.sessionLegacy);
    expect(computeCodexHookHash("SessionStart", { matcher: "startup" }, { type: "command", command: "echo other" }, "linux"))
      .toBe(GOLDEN.foreign);
    expect(lcm.Stop).toHaveLength(1);
  });

  it("normalizes timeouts, limits, matchers and platform commands like Codex", () => {
    const base = { type: "command", command: "x" };
    const hash = (event: string, handler: Record<string, unknown>, group: { matcher?: unknown } = {}, platform: NodeJS.Platform = "linux") =>
      computeCodexHookHash(event, group, handler, platform);
    expect(hash("SessionEnd", base)).toBe(hash("SessionEnd", { ...base, timeout: 1 }));
    expect(hash("SessionEnd", { ...base, timeout: 99 })).toBe(hash("SessionEnd", { ...base, timeout: 3 }));
    expect(hash("Interrupt", { ...base, timeout: 0 })).toBe(hash("Interrupt", { ...base, timeout: 1 }));
    expect(hash("SessionStart", base)).toBe(hash("SessionStart", { ...base, timeout: 600 }));
    expect(hash("SessionStart", { ...base, timeout: 0 })).toBe(hash("SessionStart", { ...base, timeout: 1 }));
    expect(hash("SessionStart", base)).not.toBe(hash("SessionStart", { ...base, timeout: 601 }));
    expect(hash("SessionStart", { ...base, additionalContextLimit: 2500 })).toBe(hash("SessionStart", base));
    expect(hash("SessionStart", { ...base, additionalContextLimit: 10 })).not.toBe(hash("SessionStart", base));
    expect(hash("Stop", { ...base, additionalContextLimit: 10 })).toBe(hash("Stop", base));
    expect(hash("Stop", base, { matcher: "ignored" })).toBe(hash("Stop", base));
    expect(hash("PostToolUse", base, { matcher: 5 })).toBe(hash("PostToolUse", base));
    expect(hash("PostToolUse", base, { matcher: "*" })).not.toBe(hash("PostToolUse", base));
    expect(hash("SessionStart", { ...base, async: true })).not.toBe(hash("SessionStart", base));
    expect(hash("SessionStart", { ...base, commandWindows: "y" }, {}, "win32")).toBe(hash("SessionStart", { ...base, command: "y" }));
    expect(hash("SessionStart", { ...base, command_windows: "y" }, {}, "win32")).toBe(hash("SessionStart", { ...base, command: "y" }));
    expect(hash("SessionStart", { ...base, command_windows: "y" }, {}, "linux")).toBe(hash("SessionStart", base));
    expect(hash("SessionStart", { ...base, commandWindows: "y" }, {}, "linux")).toBe(hash("SessionStart", base));
    expect(hash("SessionStart", base, {}, "win32")).toBe(hash("SessionStart", base));
    expect(hash("SessionStart", { ...base, timeout: "5" })).toBe(hash("SessionStart", base));
    expect(computeCodexHookHash("SessionStart", {}, { ...base, statusMessage: "m" })).not.toBe(hash("SessionStart", base));
    expect(computeCodexHookHash("SessionStart", {}, { type: "prompt" })).toBeUndefined();
    expect(computeCodexHookHash("Bogus", {}, base)).toBeUndefined();
    expect(computeCodexHookHash("SessionStart", {}, { type: "command", command: 1 })).toBeUndefined();
    expect(computeCodexHookHash("SessionStart", {}, base)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe("inspectCodexReadiness statuses", () => {
  it("reports every default role ready when enabled and trusted", () => {
    const report = inspectCodexReadiness(input());
    expect(report.rows).toHaveLength(9);
    expect(report.rows.every((row) => row.status === "ready" && !row.drift)).toBe(true);
    expect(report.rows.find((row) => row.event === "SessionStart")?.key).toBe(HOOKS + ":session_start:0:0");
    expect(report.client).toEqual({ state: "compatible", raw: "codex-cli 0.163.0" });
  });

  it("reports absent, foreign-only and partial registrations as missing per role", () => {
    const absent = inspectCodexReadiness(input({ hooks: { state: "absent" } }));
    expect(new Set(absent.rows.map((row) => row.status))).toEqual(new Set(["missing"]));
    expect(absent.rows).toHaveLength(9);

    const foreignOnly = inspectCodexReadiness(input({
      hooks: { state: "content", content: JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo other" }] }] } }), mtimeMs: 1 },
    }));
    expect(foreignOnly.rows).toHaveLength(9);
    expect(new Set(foreignOnly.rows.map((row) => row.status))).toEqual(new Set(["missing"]));

    const partial = inspectCodexReadiness(input({ hooks: hooksWith((hooks) => { delete hooks.SessionStart; }) }));
    expect(statuses(partial)).toMatchObject({ "SessionStart/restore": "missing", "Stop/session-snapshot": "ready" });
    // A different LCM role in the same event never satisfies a missing role.
    const swapped = inspectCodexReadiness(input({ hooks: hooksWith((hooks) => { hooks.Stop[0].hooks[0].command = "lcm post-tool --client codex"; }) }));
    expect(statuses(swapped)["Stop/session-snapshot"]).toBe("missing");
    expect(statuses(swapped)["Stop/post-tool"]).toBeDefined();
  });

  it("reports an unreadable or schema-invalid hooks.json for every role", () => {
    const rows = (hooks: CodexReadinessInput["hooks"]) => inspectCodexReadiness(input({ hooks })).rows;
    expect(new Set(rows({ state: "unreadable" }).map((row) => row.status))).toEqual(new Set(["hooks-file-unreadable"]));
    const content = (value: unknown) => ({ state: "content" as const, content: typeof value === "string" ? value : JSON.stringify(value), mtimeMs: 1 });
    const handler = (extra: Record<string, unknown>) => content({ hooks: { Stop: [{ hooks: [{ type: "command", command: "echo", ...extra }] }] } });
    const invalid: CodexReadinessInput["hooks"][] = [
      content("not json"),
      content([]),
      content({ hooks: {}, unknown: 1 }),
      content({ description: 5, hooks: {} }),
      content({ hooks: [] }),
      content({ hooks: { Stop: {} } }),
      content({ hooks: { Stop: [5] } }),
      content({ hooks: { Stop: [{ matcher: 5 }] } }),
      content({ hooks: { Stop: [{ hooks: {} }] } }),
      content({ hooks: { Stop: [{ hooks: [5] }] } }),
      content({ hooks: { Stop: [{ hooks: [{ type: "weird" }] }] } }),
      content({ hooks: { Stop: [{ hooks: [{ type: "command" }] }] } }),
      handler({ timeout: -1 }),
      handler({ timeout: 1.5 }),
      handler({ statusMessage: 3 }),
      handler({ async: "yes" }),
      handler({ commandWindows: 3 }),
      handler({ additionalContextLimit: "x" }),
      content({ hooks: { Stop: [{ hooks: [{ type: "mcp_tool", server: "s" }] }] } }),
      handler({ commandWindows: "a", command_windows: "b" }),
      handler({ commandWindows: null, command_windows: null }),
      handler({ command_windows: 3 }),
      ...[null, [], "bad", 5, { nested: null }, { list: [1, null] }, { deep: { deeper: [{ x: null }] } }].map((input) =>
        content({ hooks: { Stop: [{ hooks: [{ type: "mcp_tool", server: "s", tool: "t", input }] }] } })),
    ];
    for (const hooks of invalid) {
      expect(new Set(rows(hooks).map((row) => row.status)), JSON.stringify(hooks)).toEqual(new Set(["hooks-file-unreadable"]));
    }
    const valid: CodexReadinessInput["hooks"][] = [
      content({ description: "d", hooks: { Unknown: 5 } }),
      content({ description: null }),
      content({}),
      content({ hooks: { Stop: [{ matcher: null, hooks: [{ type: "prompt" }, { type: "agent" }, { type: "mcp_tool", server: "s", tool: "t" }] }, {}] } }),
      handler({ timeout: null, statusMessage: null, commandWindows: "c", async: false, additionalContextLimit: 3 }),
      handler({ command_windows: "c" }),
      handler({ commandWindows: "c", command_windows: undefined }),
      content({ hooks: { Stop: [{ hooks: [{ type: "mcp_tool", server: "s", tool: "t" }, { type: "mcp_tool", server: "s", tool: "t", input: {} }] }] } }),
      content({ hooks: { Stop: [{ hooks: [{ type: "mcp_tool", server: "s", tool: "t", input: { a: "x", b: 1, c: true, d: [1, "x", [false], { e: 2 }], f: { g: { h: 3 } } } }] }] } }),
    ];
    for (const hooks of valid) {
      expect(new Set(rows(hooks).map((row) => row.status)), JSON.stringify(hooks)).toEqual(new Set(["missing"]));
    }
  });

  it("rejects the whole hooks file for a malformed foreign mcp_tool input even beside valid trusted LCM hooks", () => {
    for (const bad of [null, [], "bad", { nested: null }]) {
      const report = inspectCodexReadiness(input({
        hooks: hooksWith((hooks) => { hooks.PostToolUse.push({ hooks: [{ type: "mcp_tool", server: "s", tool: "t", input: bad }] }); }),
      }));
      expect(new Set(report.rows.map((row) => row.status))).toEqual(new Set(["hooks-file-unreadable"]));
    }
  });

  it("rejects the whole hooks file for numeric values outside the domains Codex deserializes, beside trusted LCM hooks", () => {
    const withForeign = (handler: Record<string, unknown>, rawReplace?: [string, string]) => {
      const hooks = JSON.parse(FULL_HOOKS).hooks as Record<string, any[]>;
      hooks.PostToolUse.push({ hooks: [handler] });
      let content = JSON.stringify({ hooks });
      if (rawReplace !== undefined) content = content.replace(rawReplace[0], rawReplace[1]);
      return inspectCodexReadiness(input({ hooks: { state: "content", content, mtimeMs: 1000 } }));
    };
    const rejected = (report: ReturnType<typeof inspectCodexReadiness>) =>
      expect(new Set(report.rows.map((row) => row.status))).toEqual(new Set(["hooks-file-unreadable"]));
    const accepted = (report: ReturnType<typeof inspectCodexReadiness>) =>
      expect(report.rows.find((row) => row.event === "SessionStart")?.status).toBe("ready");
    const command = (extra: Record<string, unknown>) => ({ type: "command", command: "echo foreign", ...extra });
    const mcp = (input: unknown) => ({ type: "mcp_tool", server: "s", tool: "t", input });

    rejected(withForeign(command({ timeout: 1e100 })));
    rejected(withForeign(command({ timeout: 2 ** 53 })));
    rejected(withForeign(command({ timeout: 1.5 })));
    rejected(withForeign(command({ additionalContextLimit: 1e100 })));
    rejected(withForeign(command({ additionalContextLimit: 2 ** 53 })));
    rejected(withForeign(command({ timeout: "__INF__" }), ['"__INF__"', "1e999"]));
    rejected(withForeign({ type: "mcp_tool", server: "s", tool: "t", timeout: 1e100 }));
    for (const value of [2 ** 63, -(2 ** 63), 9223372036854776000, 1e100, -1e100, 2 ** 70]) {
      rejected(withForeign(mcp({ n: value })));
      rejected(withForeign(mcp({ list: [1, { deep: [value] }] })));
    }
    rejected(withForeign(mcp({ n: "__INF__" }), ['"__INF__"', "1e999"]));
    rejected(withForeign(mcp({ n: "__INF__" }), ['"__INF__"', "-1e999"]));

    accepted(withForeign(command({ timeout: Number.MAX_SAFE_INTEGER, additionalContextLimit: 0 })));
    accepted(withForeign(command({ timeout: 0 })));
    accepted(withForeign(mcp({ a: 2 ** 62, b: -(2 ** 62), c: 1.5, d: 1e-7, e: [0, -1, 4611686018427387904], f: { g: 123456789 } })));
  });

  // Codex's HooksFile denies unknown fields, but the hooks object, matcher groups and handler variants ignore
  // unknown members without a duplicate check. Only a repeat of a member the struct knows is a duplicate_field error.
  describe("repeated member names in hooks.json", () => {
    const rawRows = (content: string) => inspectCodexReadiness(input({ hooks: { state: "content", content, mtimeMs: 1000 } }));
    const sessionStart = (report: ReturnType<typeof inspectCodexReadiness>) => report.rows.find((row) => row.event === "SessionStart")?.status;
    // Places raw JSON text beside the trusted LCM hooks: as a foreign group, a foreign handler or a hooks-object member.
    const withRaw = (kind: "group" | "handler" | "event", raw: string) => {
      const hooks = JSON.parse(FULL_HOOKS).hooks as Record<string, any>;
      if (kind === "group") hooks.PostToolUse.push("__RAW__");
      else if (kind === "handler") hooks.PostToolUse.push({ hooks: ["__RAW__"] });
      else hooks.__RAW__ = 0;
      const marker = kind === "event" ? '"__RAW__":0' : '"__RAW__"';
      return JSON.stringify({ hooks }).replace(marker, raw);
    };
    const handler = (raw: string) => withRaw("handler", raw);
    const command = (members: string) => handler('{"type":"command","command":"echo f",' + members + "}");
    const mcp = (members: string) => handler('{"type":"mcp_tool","server":"s","tool":"t",' + members + "}");
    const unreadable = (content: string) =>
      expect(new Set(rawRows(content).rows.map((row) => row.status)), content).toEqual(new Set(["hooks-file-unreadable"]));
    const readable = (content: string) => expect(sessionStart(rawRows(content)), content).toBe("ready");

    it("starts from a readable file", () => {
      readable(FULL_HOOKS);
    });

    it("rejects every repeated root member, because Codex denies unknown root fields", () => {
      for (const content of [
        FULL_HOOKS.slice(0, -1) + ',"hooks":{}}',
        '{"description":"a","description":"b","hooks":{}}',
        '{"extra":{"a":1,"a":2}}',
        '{"extra":1,"extra":2}',
        '{"hooks":{},"extra":1,"extra":2}',
      ]) unreadable(content);
    });

    it("rejects a repeated event name in the hooks object and ignores a repeated unknown one", () => {
      unreadable('{"hooks":{"Stop":[],"Stop":[]}}');
      unreadable('{"hooks":{"\\u0053top":[],"Stop":[]}}');
      unreadable(withRaw("event", '"Interrupt":[],"Interrupt":[]'));
      readable(withRaw("event", '"Bogus":1,"Bogus":2'));
      // The whole subtree of an unknown event is discarded, including repeats of names that are known under a real event.
      readable(withRaw("event", '"Bogus":[{"matcher":"a","matcher":"b","hooks":[{"type":"command","type":"command","command":"a","command":"b"}]}]'));
      readable(withRaw("event", '"Bogus":[{"hooks":[]}],"Bogus":[{"hooks":[]}]'));
    });

    it("rejects a repeated matcher or hooks member in a group and ignores a repeated unknown one", () => {
      unreadable('{"hooks":{"Stop":[{"matcher":"a","matcher":"b","hooks":[]}]}}');
      unreadable('{"hooks":{"Stop":[{"hooks":[],"hooks":[]}]}}');
      unreadable(withRaw("group", '{"matcher":"a","hooks":[],"matcher":"b"}'));
      readable(withRaw("group", '{"hooks":[],"note":1,"note":2}'));
      readable(withRaw("group", '{"hooks":[],"note":{"a":1,"a":2},"\\u006eote":3}'));
      readable(withRaw("group", '{"hooks":[],"note":[{"a":1,"a":2}]}'));
    });

    it("rejects a repeated command handler member Codex knows, including both spellings of commandWindows", () => {
      for (const members of [
        '"command":"echo b"',
        '"\\u0063ommand":"echo b"',
        '"timeout":1,"timeout":2',
        '"async":true,"async":false',
        '"statusMessage":"a","statusMessage":"b"',
        '"additionalContextLimit":1,"additionalContextLimit":2',
        '"type":"command"',
        '"commandWindows":"a","commandWindows":"b"',
        '"command_windows":"a","command_windows":"b"',
      ]) unreadable(command(members));
      // The alias spellings name one field, so having both is a duplicate even without a repeated spelling.
      unreadable(command('"commandWindows":"a","command_windows":"b"'));
    });

    it("ignores a repeated command handler member Codex does not know, including names the other variants use", () => {
      for (const members of [
        '"extra":1,"extra":2',
        '"extra":{"a":1},"extra":[1,2]',
        '"\\u0065xtra":1,"extra":2',
        '"server":"a","server":"b","tool":"a","tool":"b"',
        '"input":{},"input":{}',
        '"commandwindows":"a","commandwindows":"b"',
        '"Type":"a","Type":"b"',
      ]) readable(command(members));
    });

    it("rejects a repeated mcp_tool handler member Codex knows and ignores the command-only ones", () => {
      for (const members of [
        '"server":"b"',
        '"tool":"b"',
        '"input":{},"input":{}',
        '"timeout":1,"timeout":2',
        '"statusMessage":"a","statusMessage":"b"',
        '"type":"mcp_tool"',
      ]) unreadable(mcp(members));
      for (const members of [
        '"extra":1,"extra":2',
        '"command":"a","command":"b"',
        '"commandWindows":"a","commandWindows":"b"',
        '"command_windows":"a","command_windows":"b"',
        '"async":true,"async":false',
        '"additionalContextLimit":1,"additionalContextLimit":2',
      ]) readable(mcp(members));
    });

    it("rejects only a repeated type on the empty prompt and agent variants", () => {
      for (const variant of ["prompt", "agent"]) {
        unreadable(handler('{"type":"' + variant + '","type":"' + variant + '"}'));
        readable(handler('{"type":"' + variant + '","extra":1,"extra":2,"command":"a","command":"b","server":"a","server":"b","timeout":1,"timeout":2,"statusMessage":"a","statusMessage":"b"}'));
      }
    });

    it("rejects a repeated type, however the repeated values compare", () => {
      unreadable(handler('{"type":"command","command":"echo f","type":"command"}'));
      unreadable(handler('{"type":"command","command":"echo f","type":"prompt"}'));
      unreadable(handler('{"type":"prompt","type":"command","command":"echo f"}'));
    });

    it("still rejects an invalid handler, whatever its repeated members", () => {
      unreadable(handler('{"type":"bogus","extra":1,"extra":2}'));
      unreadable(handler('{"type":5,"extra":1,"extra":2}'));
      unreadable(handler('{"extra":1,"extra":2}'));
      unreadable(handler('{"type":"command","extra":1,"extra":2}'));
    });

    it("rejects a repeated known ancestor even when a repeat below it replaces the ancestor's value", () => {
      unreadable('{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"a","e":1,"e":2}]}],"Stop":5}}');
    });

    it("leaves a repeat inside a hooks member that is not an object to the shape validation", () => {
      unreadable('{"hooks":[{"a":1,"a":2}]}');
    });
  });

  it("keeps a repeated member name below the typed hooks.json objects readable", () => {
    const withForeign = (handler: string) => {
      const hooks = JSON.parse(FULL_HOOKS).hooks as Record<string, any[]>;
      hooks.PostToolUse.push({ hooks: ["__HANDLER__"] });
      const content = JSON.stringify({ hooks }).replace('"__HANDLER__"', handler);
      return inspectCodexReadiness(input({ hooks: { state: "content", content, mtimeMs: 1000 } }));
    };
    const ready = (report: ReturnType<typeof inspectCodexReadiness>) =>
      expect(report.rows.find((row) => row.event === "SessionStart")?.status).toBe("ready");
    ready(withForeign('{"type":"mcp_tool","server":"s","tool":"t","input":{"a":1,"a":2,"b":{"c":1,"c":2}}}'));
    ready(withForeign('{"type":"command","command":"echo f","extra":{"k":1,"k":2}}'));
  });

  it("rejects a timeout or additionalContextLimit that is not an unsigned integer token, beside trusted LCM hooks", () => {
    const withForeign = (handler: string) => {
      const hooks = JSON.parse(FULL_HOOKS).hooks as Record<string, any[]>;
      hooks.PostToolUse.push({ hooks: ["__HANDLER__"] });
      const content = JSON.stringify({ hooks }).replace('"__HANDLER__"', handler);
      return inspectCodexReadiness(input({ hooks: { state: "content", content, mtimeMs: 1000 } }));
    };
    const rejected = (handler: string) =>
      expect(new Set(withForeign(handler).rows.map((row) => row.status)), handler).toEqual(new Set(["hooks-file-unreadable"]));
    const accepted = (handler: string) =>
      expect(withForeign(handler).rows.find((row) => row.event === "SessionStart")?.status, handler).toBe("ready");
    const command = (members: string) => '{"type":"command","command":"echo f",' + members + "}";
    for (const spelling of ["30.0", "3e1", "1E1", "0.0", "-0", "-0.0", "1e+1", "5E-0"]) {
      rejected(command('"timeout":' + spelling));
      rejected(command('"additionalContextLimit":' + spelling));
    }
    rejected(command('"timeout":2500.0'));
    rejected(command('"additionalContextLimit":2500.0'));
    rejected('{"type":"mcp_tool","server":"s","tool":"t","timeout":30.0}');
    rejected('{"type":"mcp_tool","server":"s","tool":"t","timeout":3e1}');
    // Codex ignores every member but the tag on prompt and agent handlers, so no timeout or statusMessage there is rejected.
    accepted('{"type":"prompt","timeout":-1}');
    accepted('{"type":"agent","timeout":1.5}');
    accepted('{"type":"prompt","statusMessage":7}');
    accepted('{"type":"agent","timeout":"x","statusMessage":null}');
    accepted('{"type":"agent","timeout":{"a":1}}');
    accepted('{"type":"prompt","timeout":true,"statusMessage":{"a":1}}');
    // The same members stay validated on command and mcp_tool handlers (null stays absent).
    for (const statusMessage of ["7", "true", '{"a":1}']) {
      rejected(command('"statusMessage":' + statusMessage));
      rejected('{"type":"mcp_tool","server":"s","tool":"t","statusMessage":' + statusMessage + "}");
    }
    accepted('{"type":"mcp_tool","server":"s","tool":"t","statusMessage":null}');
    accepted('{"type":"prompt","timeout":3e1}');
    accepted('{"type":"agent","timeout":-0}');
    accepted('{"type":"agent","timeout":30.0}');
    for (const spelling of ["30", "0", "2500", "9007199254740991"]) {
      accepted(command('"timeout":' + spelling + ',"additionalContextLimit":' + spelling));
    }
    accepted(command('"timeout":null,"additionalContextLimit":null'));
    accepted(command('"statusMessage":"1.0"'));
    accepted('{"type":"mcp_tool","server":"s","tool":"t","timeout":30,"input":{"n":1.0,"m":1e2}}');
  });

  it("reports state-unknown, never ready, for TOML values outside their domains beside a trusted hook", () => {
    const trusted = trustToml(TRUSTED_ALL);
    const C0 = (code: number) => String.fromCharCode(code);
    for (const invalid of [
      "x = 2026-13-01\n", "x = 2026-02-30\n", "x = 25:61:61\n", "x = 2026-01-01T12:00:00+24:00\n",
      "x = 9223372036854775808\n", "x = 0x8000000000000000\n",
      "x = \"a" + C0(1) + "b\"\n", "x = 'a" + C0(0x7f) + "b'\n", 'x = """a \\q b"""\n', 'x = """a \\uD800 b"""\n',
      "# comment " + C0(1) + "\n", "# comment \r bare\n",
      "x = 1e309\n", "x = 1_0e309\n", "x = [ -1e999 ]\n",
    ]) {
      const report = inspectCodexReadiness(input({ config: { state: "content", content: invalid + trusted } }));
      expect(new Set(report.rows.map((row) => row.status)), JSON.stringify(invalid)).toEqual(new Set(["state-unknown"]));
    }
    for (const valid of ["x = 2024-02-29\n", "x = 23:59:60\n", "x = 9223372036854775807\n", "x = { b = 1,\n c = 2, }\n", "x = 1.7976931348623157e308\n", "x = 1e-400\n"]) {
      const report = inspectCodexReadiness(input({ config: { state: "content", content: valid + trusted } }));
      expect(new Set(report.rows.map((row) => row.status)), valid).toEqual(new Set(["ready"]));
    }
  });

  it("reports a disabled hooks feature, preserving the explicit choice", () => {
    for (const config of ["[features]\nhooks = false\n", "[features]\ncodex_hooks = false\n", "[features]\nhooks = false\ncodex_hooks = true\n"]) {
      const report = inspectCodexReadiness(input({ config: { state: "content", content: config + trustToml(TRUSTED_ALL) } }));
      expect(new Set(report.rows.map((row) => row.status))).toEqual(new Set(["feature-disabled"]));
    }
    const missing = inspectCodexReadiness(input({ hooks: { state: "absent" }, config: { state: "content", content: "[features]\nhooks = false\n" } }));
    expect(new Set(missing.rows.map((row) => row.status))).toEqual(new Set(["feature-disabled"]));
    const canonicalWins = inspectCodexReadiness(input({ config: { state: "content", content: "[features]\ncodex_hooks = false\nhooks = true\n" + trustToml(TRUSTED_ALL) } }));
    expect(canonicalWins.rows.every((row) => row.status === "ready")).toBe(true);
  });

  it("reports unknown hook state whenever config.toml cannot be classified", () => {
    const unknownConfigs = [
      { state: "unreadable" as const },
      { state: "content" as const, content: "this is = = not toml" },
      { state: "content" as const, content: "features = { hooks = true }\n" },
      { state: "content" as const, content: "[features]\nhooks = 1\n" },
      { state: "content" as const, content: "hooks = { state = {} }\n" },
      { state: "content" as const, content: "hooks.state = {}\n" },
    ];
    for (const config of unknownConfigs) {
      const report = inspectCodexReadiness(input({ config }));
      expect(new Set(report.rows.map((row) => row.status)), JSON.stringify(config)).toEqual(new Set(["state-unknown"]));
    }
    // Missing rows keep their status even when state cannot be read.
    const missingFirst = inspectCodexReadiness(input({ hooks: { state: "absent" }, config: { state: "unreadable" } }));
    expect(new Set(missingFirst.rows.map((row) => row.status))).toEqual(new Set(["missing"]));
    const inline = inspectCodexReadiness(input({
      config: { state: "content", content: trustToml(TRUSTED_ALL.slice(1)) + '[hooks.state]\n"' + HOOKS + ':session_start:0:0" = { enabled = false }\n' },
    }));
    expect(statuses(inline)["SessionStart/restore"]).toBe("state-unknown");
    // A malformed state entry for one LCM key only affects that row.
    const oneKey = inspectCodexReadiness(input({
      config: { state: "content", content: trustToml(TRUSTED_ALL.slice(1)) + '[hooks.state."' + HOOKS + ':session_start:0:0"]\nenabled = "no"\n' },
    }));
    expect(statuses(oneKey)).toMatchObject({ "SessionStart/restore": "state-unknown", "Stop/session-snapshot": "ready" });
    // LCM-looking non-command handlers cannot be matched to a trust hash.
    const nonCommand = inspectCodexReadiness(input({
      hooks: hooksWith((hooks) => { hooks.Stop[0].hooks.push({ type: "prompt", command: "lcm session-snapshot --client codex" }); }),
    }));
    expect(nonCommand.rows.filter((row) => row.event === "Stop").map((row) => row.status)).toEqual(["ready", "state-unknown"]);
  });

  it("reports disabled, untrusted and modified hooks with disabled taking precedence", () => {
    const config = trustToml([TRUSTED_ALL[0], [TRUSTED_ALL[1][0], 0, 0, "sha256:deadbeef"]]) +
      '[hooks.state."' + HOOKS + ':post_tool_use:0:0"]\nenabled = false\n' +
      '[hooks.state."' + HOOKS + ':pre_compact:0:0"]\nenabled = false\ntrusted_hash = "sha256:old"\n';
    const report = inspectCodexReadiness(input({ config: { state: "content", content: config } }));
    expect(statuses(report)).toEqual({
      "SessionStart/restore": "ready",
      "UserPromptSubmit/user-prompt": "modified",
      "PostToolUse/post-tool": "disabled",
      "PreCompact/session-snapshot": "disabled",
      "Stop/session-snapshot": "untrusted",
      "SubagentStart/restore": "untrusted",
      "SubagentStop/session-snapshot": "untrusted",
      "Interrupt/session-snapshot": "untrusted",
      "SessionEnd/session-snapshot": "untrusted",
    });
    const absentConfig = inspectCodexReadiness(input({ config: { state: "absent" } }));
    expect(new Set(absentConfig.rows.map((row) => row.status))).toEqual(new Set(["untrusted"]));
    const accepted = inspectCodexReadiness(input({ config: { state: "content", content: trustToml(TRUSTED_ALL.slice(0, 4).concat(TRUSTED_ALL.slice(5))) + "[hooks.state.\"" + HOOKS + ":stop:0:0\"]\nenabled = true\ntrusted_hash = \"" + GOLDEN.stop + "\"\n" } }));
    expect(accepted.rows.every((row) => row.status === "ready")).toBe(true);
  });

  it("detects a position shift caused by a foreign hook inserted before an LCM hook", () => {
    const shifted = inspectCodexReadiness(input({
      hooks: hooksWith((hooks) => { hooks.SessionStart.unshift({ matcher: "startup", hooks: [{ type: "command", command: "echo other" }] }); }),
    }));
    expect(shifted.rows.find((row) => row.role === "restore")).toMatchObject({ key: HOOKS + ":session_start:1:0", status: "untrusted" });
  });

  it("flags drift from the current LCM definition without changing the status", () => {
    const drifted = inspectCodexReadiness(input({
      hooks: hooksWith((hooks) => { hooks.Stop[0].hooks[0].statusMessage = "Old message"; }),
    }));
    const row = drifted.rows.find((entry) => entry.event === "Stop")!;
    expect(row.drift).toBe(true);
    expect(row.status).toBe("modified");
    const text = formatCodexReadiness(drifted).lines.join("\n");
    expect(text).toContain("Stop hook differs from current LCM definition; reinstall");
  });

  it("reports sibling-event handlers without ever requiring them", () => {
    const extra = inspectCodexReadiness(input({
      hooks: hooksWith((hooks) => { hooks.PostCompact = [{ hooks: [{ type: "command", command: "lcm session-snapshot --client codex", timeout: 2 }] }]; }),
    }));
    expect(extra.rows).toHaveLength(10);
    expect(extra.rows.find((row) => row.event === "PostCompact")).toMatchObject({ status: "untrusted", drift: false });
    expect(inspectCodexReadiness(input()).rows.some((row) => row.event === "PostCompact")).toBe(false);
  });

  it("uses a test-supplied expectation, including enabled opt-in roles", () => {
    const expected = { ...codexLcmHooks("cli"), PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "lcm post-tool --client codex", timeout: 5 }] }] };
    const absent = inspectCodexReadiness(input({ expected }));
    expect(statuses(absent)["PreToolUse/post-tool"]).toBe("missing");
    const installed = inspectCodexReadiness(input({
      expected,
      hooks: hooksWith((hooks) => { hooks.PreToolUse = [{ matcher: "*", hooks: [{ type: "command", command: "lcm post-tool --client codex", timeout: 9 }] }]; }),
    }));
    expect(installed.rows.find((row) => row.event === "PreToolUse")).toMatchObject({ drift: true, status: "untrusted" });
  });
});

describe("inspectCodexReadiness opt-in PreToolUse role", () => {
  const preGroup = codexLcmHooks("cli", { preToolRecall: true }).PreToolUse[0];
  const preHash = GOLDEN.preTool;
  const withPre = hooksWith((hooks) => { hooks.PreToolUse = [preGroup]; });
  const trustedWithPre = { state: "content" as const, content: trustToml([...TRUSTED_ALL, ["pre_tool_use", 0, 0, preHash]]) };

  it("expects the role only while enabled", () => {
    const disabled = inspectCodexReadiness(input());
    expect(disabled.rows.some((row) => row.event === "PreToolUse")).toBe(false);
    expect(formatCodexReadiness(disabled).failures).toBe(0);

    const missing = inspectCodexReadiness(input({ preToolRecall: true }));
    expect(statuses(missing)["PreToolUse/pre-tool"]).toBe("missing");
    const text = formatCodexReadiness(missing);
    expect(text.failures).toBe(1);
    expect(text.lines.join("\n")).toContain("unavailable LCM capabilities: recall LCM memory before tool use");
  });

  it("reports an installed role by trust whether or not it is expected", () => {
    const ready = inspectCodexReadiness(input({ preToolRecall: true, hooks: withPre, config: trustedWithPre }));
    expect(ready.rows.find((row) => row.event === "PreToolUse")).toMatchObject({ role: "pre-tool", status: "ready", drift: false });
    expect(formatCodexReadiness(ready).failures).toBe(0);

    const untrusted = inspectCodexReadiness(input({ preToolRecall: true, hooks: withPre }));
    expect(statuses(untrusted)["PreToolUse/pre-tool"]).toBe("untrusted");

    const stale = hooksWith((hooks) => { hooks.PreToolUse = [{ ...preGroup, matcher: "Bash" }]; });
    const modified = inspectCodexReadiness(input({ preToolRecall: true, hooks: stale, config: trustedWithPre }));
    expect(modified.rows.find((row) => row.event === "PreToolUse")).toMatchObject({ status: "modified", drift: true });

    const leftover = inspectCodexReadiness(input({ hooks: withPre, config: trustedWithPre }));
    expect(leftover.rows.find((row) => row.event === "PreToolUse")).toMatchObject({ status: "ready", drift: false });
    expect(leftover.rows).toHaveLength(10);
  });

  it("honors a deliberate disable of the installed role", () => {
    const toml = trustToml(TRUSTED_ALL)
      + '[hooks.state."' + HOOKS + ':pre_tool_use:0:0"]\nenabled = false\ntrusted_hash = "' + preHash + '"\n';
    const report = inspectCodexReadiness(input({ preToolRecall: true, hooks: withPre, config: { state: "content", content: toml } }));
    expect(statuses(report)["PreToolUse/pre-tool"]).toBe("disabled");
  });
});

describe("inspectCodexReadiness observations and transport", () => {
  const hooks = { state: "content" as const, content: FULL_HOOKS, mtimeMs: 1000 };

  it("annotates ready rows with a fresh exit-0 observation without promoting anything", () => {
    const report = inspectCodexReadiness(input({ receipts: [receipt({ event: "SessionStart" })] }));
    const row = report.rows.find((entry) => entry.event === "SessionStart")!;
    expect(row.status).toBe("ready");
    expect(row.observation?.outcome).toBe("exit-0");
    const text = formatCodexReadiness(report).lines.join("\n");
    expect(text).toContain("handler exited 0; last persisted LCM-local observation at 1970-01-01T00:16:40.100Z (unauthenticated)");
    // An observation never rescues an untrusted hook.
    const untrusted = inspectCodexReadiness(input({ config: { state: "absent" }, receipts: [receipt()] }));
    expect(untrusted.rows.find((entry) => entry.event === "SessionStart")?.status).toBe("untrusted");
  });

  it("reports failing and degraded handlers from fresh observations", () => {
    const failing = inspectCodexReadiness(input({ receipts: [receipt({ event: "Stop", outcome: "exit-nonzero", exitCode: 2 }), receipt({ event: "PostToolUse", outcome: "threw", exitCode: null })] }));
    expect(statuses(failing)).toMatchObject({ "Stop/session-snapshot": "failing", "PostToolUse/post-tool": "failing" });
    const degraded = inspectCodexReadiness(input({ receipts: [receipt({ event: "PreCompact", loggedErrors: true })] }));
    expect(statuses(degraded)["PreCompact/session-snapshot"]).toBe("degraded");
    const text = [...formatCodexReadiness(failing).lines, ...formatCodexReadiness(degraded).lines].join("\n");
    expect(text).toContain("handler exited with exit code 2");
    expect(text).toContain("handler exited with an error");
    expect(text).toContain("reported errors through the best-effort hook error channel");
  });

  it("ignores stale, pre-install and future-dated observations", () => {
    const cases = [
      receipt({ completedAt: 500, outcome: "exit-nonzero", exitCode: 1 }),
      receipt({ completedAt: 2_000_000 - 31 * 24 * 60 * 60 * 1000, outcome: "exit-nonzero", exitCode: 1 }),
      receipt({ completedAt: 2_000_000 + 6 * 60 * 1000, outcome: "exit-nonzero", exitCode: 1 }),
      receipt({ event: "Stop", completedAt: 2_000_000 + 4 * 60 * 1000 }),
    ];
    const report = inspectCodexReadiness(input({ receipts: cases }));
    expect(report.rows.find((row) => row.event === "SessionStart")).toMatchObject({ status: "ready" });
    expect(report.rows.find((row) => row.event === "SessionStart")?.observation).toBeUndefined();
    expect(report.rows.find((row) => row.event === "Stop")?.observation).toBeDefined();
  });

  it("derives the expected user-prompt transport from stored config, the installed hook, or the default", () => {
    const mcpHooks = { ...hooks, content: JSON.stringify({ hooks: codexLcmHooks("mcp") }) };
    const mcpConfig = { state: "content" as const, content: trustToml([TRUSTED_ALL[0], ["user_prompt_submit", 0, 0, GOLDEN.promptMcp]]) };
    const drift = (report: ReturnType<typeof inspectCodexReadiness>) => report.rows.find((row) => row.event === "UserPromptSubmit")!.drift;
    expect(drift(inspectCodexReadiness(input({ hooks: mcpHooks, config: mcpConfig, storedTransport: { state: "stored", transport: "mcp" } })))).toBe(false);
    expect(drift(inspectCodexReadiness(input({ hooks: mcpHooks, storedTransport: { state: "stored", transport: "cli" } })))).toBe(true);
    expect(drift(inspectCodexReadiness(input({ hooks: mcpHooks, storedTransport: { state: "none" } })))).toBe(false);
    expect(drift(inspectCodexReadiness(input({ hooks, storedTransport: { state: "none" } })))).toBe(false);
    expect(drift(inspectCodexReadiness(input({ hooks: { state: "absent" }, storedTransport: { state: "none" } })))).toBe(false);
    const legacy = hooksWith((all) => { all.UserPromptSubmit[0].hooks[0].command = "lcm user-prompt --client codex"; });
    expect(drift(inspectCodexReadiness(input({ hooks: legacy })))).toBe(true);
    const errored = inspectCodexReadiness(input({ hooks: mcpHooks, config: mcpConfig, storedTransport: { state: "error", reason: "could not be read" } }));
    expect(drift(errored)).toBe(false);
    expect(errored.transportNote).toContain("stored connector transport unreadable (could not be read)");
    expect(formatCodexReadiness(errored).lines.join("\n")).toContain("inferred from the installed hook");
  });

  it("judges the codex CLI version against 0.163.0 with prereleases below releases", () => {
    const client = (version: CodexReadinessInput["version"]) => inspectCodexReadiness(input({ version })).client;
    const found = (raw: string) => client({ state: "found", raw });
    expect(found("codex-cli 0.163.0").state).toBe("compatible");
    expect(found("codex-cli 0.163.1").state).toBe("compatible");
    expect(found("1.0.0").state).toBe("compatible");
    expect(found("codex-cli 0.164.0-alpha.1").state).toBe("compatible");
    expect(found("codex-cli 0.163.0-alpha.1").state).toBe("incompatible");
    expect(found("codex-cli 0.162.9").state).toBe("incompatible");
    expect(found("codex-cli 0.9.0").state).toBe("incompatible");
    expect(found("codex-cli dev").state).toBe("unknown");
    expect(found("codex 0.163.0").state).toBe("compatible");
    expect(found("codex-cli v0.163.0\n").state).toBe("compatible");
    expect(found("built 2026.1.2 codex 0.140.0").state).toBe("incompatible");
    expect(found("wrapper 0.163.0 extra").state).toBe("unknown");
    expect(found("codex").state).toBe("unknown");
    expect(found("something codex-cli").state).toBe("unknown");
    expect(found("").state).toBe("unknown");
    expect(client({ state: "unavailable", reason: "codex not found on PATH" })).toEqual({ state: "unknown", reason: "codex not found on PATH" });
  });
});

describe("formatCodexReadiness", () => {
  const row = (over: Partial<CodexReadinessRow>): CodexReadinessRow => ({ event: "SessionStart", role: "restore", status: "ready", drift: false, ...over });
  const format = (rows: CodexReadinessRow[], client: ReturnType<typeof inspectCodexReadiness>["client"] = { state: "compatible", raw: "codex-cli 0.163.0" }) =>
    formatCodexReadiness({ hooksPath: HOOKS, rows, client });

  it("states every status with its capability and action", () => {
    const out = format([
      row({ status: "missing", event: "UserPromptSubmit" }),
      row({ status: "disabled", event: "PostToolUse" }),
      row({ status: "untrusted", event: "PreCompact" }),
      row({ status: "modified", event: "Stop" }),
      row({ status: "state-unknown", event: "SessionEnd" }),
      row({ status: "ready", event: "Interrupt" }),
      row({ status: "ready", event: "Unmapped" }),
    ]);
    const text = out.lines.join("\n");
    expect(text).toContain('✗ Codex: UserPromptSubmit hook (search LCM memory on each prompt): not installed; run "lcm connectors install codex --global"');
    expect(text).toContain("disabled in Codex (your choice is preserved; LCM never changes it); re-enable in Codex /hooks to regain this capability: record tool context");
    expect(text).not.toContain("restore restore");
    expect(text).toContain("awaiting trust; review and trust in Codex /hooks; it will not run unless trusted (or Codex is launched with hook-trust bypass)");
    expect(text).toContain("definition changed since you trusted it; Codex requires renewed review in /hooks");
    expect(text).toContain("could not read Codex hook state in config.toml (unsupported form); check /hooks");
    expect(text).toContain("✓ Codex: Interrupt hook (LCM interrupt handling): enabled and trusted in base user config (static check only)");
    expect(text).toContain("Unmapped hook (LCM lifecycle capability)");
    expect(text).toContain("unavailable LCM capabilities: search LCM memory on each prompt, record tool context, save memory before compaction, save a session snapshot when a turn ends, save memory when a session ends");
    expect(out.failures).toBe(5);
    expect(text).toContain("checked base user config; profile layers, session flags and managed requirements are not visible");
    expect(text).toContain("operational verification is not established by doctor");
  });

  it("prints global statuses once and counts them as one failure each", () => {
    const unreadable = format([row({ status: "hooks-file-unreadable" }), row({ status: "hooks-file-unreadable", event: "Stop" })]);
    expect(unreadable.failures).toBe(1);
    expect(unreadable.lines.join("\n")).toContain(HOOKS + " is unreadable or malformed; fix the file (or move it aside), then reinstall");
    const disabled = format([row({ status: "feature-disabled" }), row({ status: "feature-disabled", event: "Stop" })]);
    expect(disabled.failures).toBe(1);
    expect(disabled.lines.join("\n")).toContain("[features] hooks is disabled; all LCM lifecycle capabilities unavailable; LCM left it unchanged");
    expect(disabled.lines.join("\n")).toContain("unavailable LCM capabilities: restore LCM memory at session start, save a session snapshot when a turn ends");
  });

  it("treats degraded rows and an unknown client as warnings and an incompatible client as a failure", () => {
    const degraded = format(
      [row({ status: "degraded", observation: receipt({ loggedErrors: true }) })],
      { state: "unknown", reason: "codex not found on PATH" },
    );
    expect(degraded.failures).toBe(0);
    expect(degraded.lines[0]).toBe("  ⚠ Codex: could not determine the codex CLI version (codex not found on PATH); LCM requires Codex 0.163.0 or later");
    expect(degraded.lines[1]).toContain("⚠ Codex: SessionStart hook");
    const incompatible = format([row({})], { state: "incompatible", raw: "codex-cli 0.150.0" });
    expect(incompatible.failures).toBe(1);
    expect(incompatible.lines[0]).toBe("  ✗ Codex: codex CLI on PATH is codex-cli 0.150.0; LCM requires Codex 0.163.0 or later; desktop/IDE builds may differ");
    expect(format([row({})]).lines[0]).toBe("  ✓ Codex: codex CLI on PATH is codex-cli 0.163.0");
  });
});

describe("Codex readiness on disk", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "codex-readiness-")); });
  afterEach(() => rmSync(dir, { recursive: true }));

  it("distinguishes absent, unreadable and readable files", () => {
    expect(readCodexReadinessFile(join(dir, "missing", "hooks.json"))).toEqual({ state: "absent" });
    expect(readCodexReadinessFile(join(dir, "hooks.json"))).toEqual({ state: "absent" });
    mkdirSync(join(dir, "folder"));
    expect(readCodexReadinessFile(join(dir, "folder"))).toEqual({ state: "unreadable" });
    writeFileSync(join(dir, "config.toml"), "x = 1\n");
    expect(readCodexReadinessFile(join(dir, "config.toml"))).toMatchObject({ state: "content", content: "x = 1\n" });
  });

  it("gathers inputs from a fixture Codex home and tolerates failing seams", () => {
    mkdirSync(join(dir, ".codex"));
    const hooksPath = join(dir, ".codex", "hooks.json");
    writeFileSync(hooksPath, FULL_HOOKS);
    const state = trustToml(TRUSTED_ALL).replaceAll(HOOKS, hooksPath);
    writeFileSync(join(dir, ".codex", "config.toml"), state);
    const base = {
      homeDir: dir,
      probeVersion: () => ({ state: "found" as const, raw: "codex-cli 0.163.0" }),
      readStoredTransport: () => undefined,
      now: () => Date.now(),
    };
    const ready = runCodexReadinessCheck({ ...base, readReceipts: () => [] });
    expect(ready.failures).toBe(0);
    expect(ready.lines.join("\n")).toContain("SessionStart hook (restore LCM memory at session start): enabled and trusted");

    const failing = runCodexReadinessCheck({
      ...base,
      readStoredTransport: () => { throw new Error("secret path /x"); },
      readReceipts: () => { throw new Error("boom"); },
    });
    expect(failing.failures).toBe(0);
    expect(failing.lines.join("\n")).toContain("stored connector transport unreadable (could not be read)");
    expect(failing.lines.join("\n")).not.toContain("secret path");

    const wanted = runCodexReadinessCheck({ ...base, readPreToolRecall: () => true });
    expect(wanted.failures).toBe(1);
    expect(wanted.lines.join("\n")).toContain("PreToolUse hook (recall LCM memory before tool use): not installed");
    const unreadable = runCodexReadinessCheck({ ...base, readPreToolRecall: () => { throw new Error("secret path /y"); } });
    expect(unreadable.failures).toBe(0);
    expect(unreadable.lines.join("\n")).not.toContain("PreToolUse");
    expect(runCodexReadinessCheck({ ...base, readPreToolRecall: () => false }).failures).toBe(0);

    const stored = runCodexReadinessCheck({ ...base, readStoredTransport: () => "cli" as const });
    expect(stored.failures).toBe(0);
    delete (base as { now?: unknown }).now;
    expect(runCodexReadinessCheck(base).failures).toBe(0);
  });
});
