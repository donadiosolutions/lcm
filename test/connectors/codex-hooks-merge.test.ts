import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CODEX_TRUST_NOTICE,
  codexLcmHookRole,
  codexLcmHooks,
  installCodexHooks,
  mergeCodexHooksContent,
  planCodexHooksInstall,
  planCodexHooksMerge,
  type CodexHookGroup,
} from "../../src/connectors/codex-hooks.js";

const lcm = (command: string, extra: Record<string, unknown> = {}) => ({ type: "command", command, ...extra });
const foreign = (name: string) => ({ type: "command", command: "echo " + name });
const merged = (hooks: unknown, transport: "cli" | "mcp" = "cli") =>
  JSON.parse(mergeCodexHooksContent(JSON.stringify({ hooks }), transport)).hooks as Record<string, any[]>;

describe("in-place Codex hook merge", () => {
  it("identifies hook roles from the LCM subcommand only", () => {
    expect(codexLcmHookRole("lcm restore --client codex")).toBe("restore");
    expect(codexLcmHookRole("/usr/bin/lcm session-snapshot --client codex")).toBe("session-snapshot");
    expect(codexLcmHookRole("lcm user-prompt --client codex --transport mcp")).toBe("user-prompt");
    expect(codexLcmHookRole("echo lcm")).toBeUndefined();
    expect(codexLcmHookRole(7)).toBeUndefined();
  });

  it("keeps each LCM handler in its original slot among foreign neighbours", () => {
    const hooks = merged({
      SessionStart: [
        { matcher: "startup", hooks: [foreign("honcho")] },
        { hooks: [foreign("gk")] },
        { matcher: "old", hooks: [lcm("lcm restore --client codex", { timeout: 5, custom: true })] },
        { hooks: [foreign("reaper")] },
      ],
      Stop: [
        { hooks: [foreign("a"), lcm("lcm session-snapshot --client codex"), foreign("b")] },
        { hooks: [foreign("c")] },
      ],
      UserPromptSubmit: [{ hooks: [lcm("lcm user-prompt --client codex")] }],
    });
    expect(hooks.SessionStart.map((group) => group.hooks[0].command)).toEqual([
      "echo honcho", "echo gk", "lcm restore --client codex", "echo reaper",
    ]);
    expect(hooks.SessionStart[2]).toEqual(codexLcmHooks().SessionStart[0]);
    expect(hooks.Stop[0].hooks.map((hook: any) => hook.command)).toEqual(["echo a", "lcm session-snapshot --client codex", "echo b"]);
    expect(hooks.Stop[0].hooks[1]).toEqual(codexLcmHooks().Stop[0].hooks![0]);
    expect(hooks.Stop[1].hooks[0].command).toBe("echo c");
    expect(hooks.UserPromptSubmit[0].hooks[0].command).toBe("lcm user-prompt --client codex --transport cli");
    expect(hooks.PostToolUse).toEqual(codexLcmHooks().PostToolUse);
    expect(hooks.PreCompact).toEqual(codexLcmHooks().PreCompact);
  });

  it("appends only missing roles and is idempotent", () => {
    const first = mergeCodexHooksContent("");
    expect(JSON.parse(first).hooks).toEqual(codexLcmHooks());
    expect(mergeCodexHooksContent(first)).toBe(first);
    const partial = JSON.stringify({ hooks: { PostToolUse: [{ matcher: "*", hooks: [lcm("lcm post-tool --client codex")] }], Stop: [] } });
    const result = JSON.parse(mergeCodexHooksContent(partial)).hooks;
    expect(Object.keys(result)).toEqual(["PostToolUse", "Stop", "SessionStart", "UserPromptSubmit", "PreCompact", "SubagentStart", "SubagentStop", "Interrupt", "SessionEnd"]);
    expect(result.Stop).toEqual(codexLcmHooks().Stop);
    expect(JSON.parse(mergeCodexHooksContent(first, "mcp")).hooks.UserPromptSubmit[0].hooks[0].command)
      .toBe("lcm user-prompt --client codex --transport mcp");
  });

  it("updates a group matcher in place only for an LCM-only group", () => {
    const only = merged({ SessionStart: [{ matcher: "startup", label: "keep", hooks: [lcm("lcm restore --client codex")] }] });
    expect(only.SessionStart[0]).toMatchObject({ matcher: "startup|resume|clear|compact|fork", label: "keep" });
    const removed = merged({ PostToolUse: [{ matcher: "Bash", hooks: [lcm("lcm post-tool --client codex")] }], UserPromptSubmit: [{ matcher: "x", hooks: [lcm("lcm user-prompt --client codex")] }] });
    expect(removed.UserPromptSubmit[0]).not.toHaveProperty("matcher");
    expect(removed.PostToolUse[0].matcher).toBe("*");
    const equal = merged({ SessionStart: [{ matcher: "startup|resume|clear|compact|fork", hooks: [foreign("x"), lcm("lcm restore --client codex")] }] });
    expect(equal.SessionStart[0].hooks[0].command).toBe("echo x");
  });

  it("refuses duplicate roles and mixed-group matcher changes without producing content", () => {
    const duplicate = JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [lcm("lcm user-prompt --client codex"), lcm("lcm user-prompt --client codex --transport mcp")] }] } });
    const plan = planCodexHooksMerge(duplicate);
    expect(plan.content).toBe(duplicate);
    expect(plan.refusal).toBe(
      "LCM cannot update UserPromptSubmit (multiple LCM handlers share one role) without moving other hooks' Codex state; "
      + "move/remove the LCM handler manually or run lcm connectors remove codex first",
    );
    expect(() => mergeCodexHooksContent(duplicate)).toThrow("multiple LCM handlers share one role");
    const mixed = JSON.stringify({ hooks: { SessionStart: [{ matcher: "startup", hooks: [foreign("x"), lcm("lcm restore --client codex")] }] } });
    expect(planCodexHooksMerge(mixed).refusal).toContain("the group matcher must change");
    const withHole = JSON.stringify({ hooks: { SessionStart: [{ matcher: "startup", hooks: [null, lcm("lcm restore --client codex")] }] } });
    expect(planCodexHooksMerge(withHole).refusal).toContain("the group matcher must change");
    // A group made only of replaced LCM handlers may change matcher in place.
    const both: Record<string, CodexHookGroup[]> = {
      SessionStart: [{ matcher: "startup", hooks: [lcm("lcm restore --client codex"), lcm("lcm post-tool --client codex")] }],
    };
    const group = JSON.stringify({ hooks: { SessionStart: [{ matcher: "old", hooks: [lcm("lcm restore --client codex"), lcm("lcm post-tool --client codex")] }] } });
    expect(JSON.parse(planCodexHooksMerge(group, "cli", both).content).hooks.SessionStart).toEqual(both.SessionStart);
  });

  describe("removing roles that are no longer expected", () => {
    const expected: Record<string, CodexHookGroup[]> = { Stop: [{ hooks: [lcm("lcm session-snapshot --client codex")] }] };
    const plan = (hooks: unknown) => planCodexHooksMerge(JSON.stringify({ hooks }), "cli", expected);
    const obsolete = () => lcm("lcm restore --client codex");

    it("removes only the last handler of the last group, or that whole final group", () => {
      expect(JSON.parse(plan({ SessionStart: [{ hooks: [obsolete()] }] }).content).hooks).toEqual({ Stop: expected.Stop });
      const trailing = JSON.parse(plan({ SessionStart: [{ hooks: [foreign("b")] }, { hooks: [foreign("a"), obsolete()] }] }).content).hooks;
      expect(trailing.SessionStart).toEqual([{ hooks: [foreign("b")] }, { hooks: [foreign("a")] }]);
      const wholeTail = JSON.parse(plan({ SessionStart: [{ hooks: [foreign("a")] }, { hooks: [obsolete()] }] }).content).hooks;
      expect(wholeTail.SessionStart).toEqual([{ hooks: [foreign("a")] }]);
      const leading = JSON.parse(plan({ SessionStart: ["odd", { matcher: "m" }, { hooks: [obsolete()] }] }).content).hooks;
      expect(leading.SessionStart).toEqual(["odd", { matcher: "m" }]);
    });

    it("refuses whenever any later handler or group exists in the original layout", () => {
      const refused = (hooks: unknown) => plan(hooks).refusal;
      const message = "LCM cannot update SessionStart (a later hook would change position)";
      expect(refused({ SessionStart: [{ hooks: [obsolete(), foreign("b")] }] })).toContain(message);
      expect(refused({ SessionStart: [{ hooks: [foreign("a"), obsolete(), foreign("b")] }] })).toContain(message);
      expect(refused({ SessionStart: [{ hooks: [obsolete()] }, { hooks: [foreign("b")] }] })).toContain(message);
      expect(refused({ SessionStart: [{ hooks: [obsolete()] }, { hooks: [] }] })).toContain(message);
      expect(refused({ SessionStart: [{ hooks: [obsolete()] }, { matcher: "x" }] })).toContain(message);
      expect(refused({ SessionStart: [{ hooks: [obsolete()] }, "odd"] })).toContain(message);
      expect(refused({ SessionStart: [{ hooks: [foreign("a"), obsolete()] }, { hooks: [foreign("b")] }] })).toContain(message);
      // Obsolete handlers never make each other removable: pairs and consecutive groups are refused.
      expect(refused({ SessionStart: [{ hooks: [obsolete(), obsolete()] }] })).toContain(message);
      expect(refused({ SessionStart: [{ hooks: [obsolete()] }, { hooks: [obsolete()] }] })).toContain(message);
      expect(plan({ SessionStart: [{ hooks: [obsolete(), obsolete()] }] }).content).toBe(JSON.stringify({ hooks: { SessionStart: [{ hooks: [obsolete(), obsolete()] }] } }));
    });
  });

  it("preserves unrelated, malformed and non-array entries", () => {
    const content = JSON.stringify({
      custom: true,
      hooks: { Weird: "keep", Other: [{ matcher: "m" }, 5, { hooks: [null, 7, { command: 42 }] }], Stop: "garbage" },
    });
    const result = JSON.parse(mergeCodexHooksContent(content));
    expect(result.custom).toBe(true);
    expect(result.hooks.Weird).toBe("keep");
    expect(result.hooks.Other).toEqual([{ matcher: "m" }, 5, { hooks: [null, 7, { command: 42 }] }]);
    expect(result.hooks.Stop).toEqual(codexLcmHooks().Stop);
  });

  it("starts a new group for an absent role that shares a multi-handler expected group", () => {
    const expected: Record<string, CodexHookGroup[]> = {
      SessionStart: [{ matcher: "startup", hooks: [lcm("lcm restore --client codex"), lcm("lcm post-tool --client codex")] }],
    };
    const existing = JSON.stringify({ hooks: { SessionStart: [{ matcher: "startup", hooks: [lcm("lcm restore --client codex", { timeout: 1 })] }] } });
    const result = JSON.parse(planCodexHooksMerge(existing, "cli", expected).content).hooks.SessionStart;
    expect(result).toEqual([
      { matcher: "startup", hooks: [lcm("lcm restore --client codex")] },
      { matcher: "startup", hooks: [lcm("lcm post-tool --client codex")] },
    ]);
    const noMatcher: Record<string, CodexHookGroup[]> = { Stop: [{ hooks: [lcm("lcm restore --client codex")] }] };
    expect(JSON.parse(planCodexHooksMerge("", "cli", noMatcher).content).hooks.Stop).toEqual([{ hooks: [lcm("lcm restore --client codex")] }]);
  });
});

describe("opt-in PreToolUse hook in the in-place merge", () => {
  const enabled = { preToolRecall: true };
  const mergeWith = (hooks: unknown, options: { preToolRecall?: boolean } = enabled) =>
    JSON.parse(mergeCodexHooksContent(JSON.stringify({ hooks }), "cli", options)).hooks as Record<string, any[]>;
  const preTool = () => codexLcmHooks("cli", enabled).PreToolUse[0];

  it("identifies the pre-tool role", () => {
    expect(codexLcmHookRole("lcm pre-tool --client codex")).toBe("pre-tool");
  });

  it("appends the group after a user's own PreToolUse group without moving it, idempotently", () => {
    const userGroup = { matcher: "Bash", hooks: [foreign("guard")] };
    const first = mergeWith({ PreToolUse: [userGroup] });
    expect(first.PreToolUse).toEqual([userGroup, preTool()]);
    const again = mergeCodexHooksContent(JSON.stringify({ hooks: first }), "cli", enabled);
    expect(JSON.parse(again).hooks.PreToolUse).toEqual([userGroup, preTool()]);
    expect(mergeCodexHooksContent(again, "cli", enabled)).toBe(again);
  });

  it("keeps an installed group at its slot and replaces its definition in place", () => {
    const hooks = mergeWith({
      PreToolUse: [
        { hooks: [foreign("first")] },
        { matcher: "old", hooks: [lcm("lcm pre-tool --client codex", { timeout: 99 })] },
        { hooks: [foreign("last")] },
      ],
    });
    expect(hooks.PreToolUse.map((group) => group.hooks[0].command)).toEqual(["echo first", "lcm pre-tool --client codex", "echo last"]);
    expect(hooks.PreToolUse[1]).toEqual(preTool());
  });

  it("removes the group on disable when it is the last one and refuses when a later group would move", () => {
    const withLcm = mergeWith({ PreToolUse: [{ hooks: [foreign("mine")] }] });
    expect(mergeWith(withLcm, {}).PreToolUse).toEqual([{ hooks: [foreign("mine")] }]);
    expect(mergeWith(withLcm, { preToolRecall: false }).PreToolUse).toEqual([{ hooks: [foreign("mine")] }]);
    expect("PreToolUse" in mergeWith(mergeWith({}), {})).toBe(false);

    const later = JSON.stringify({ hooks: { PreToolUse: [preTool(), { hooks: [foreign("after")] }] } });
    expect(() => mergeCodexHooksContent(later, "cli")).toThrow("LCM cannot update PreToolUse (a later hook would change position)");
    expect(planCodexHooksInstall(later, "").refusal).toContain("a later hook would change position");
    expect(JSON.parse(mergeCodexHooksContent(later, "cli", enabled)).hooks.PreToolUse).toHaveLength(2);
  });

  it("threads the option through the install plan and never through the legacy helper", () => {
    expect(JSON.parse(planCodexHooksInstall("", "", "cli").hooksContent).hooks).not.toHaveProperty("PreToolUse");
    expect(JSON.parse(planCodexHooksInstall("", "", "cli", enabled).hooksContent).hooks.PreToolUse).toEqual([preTool()]);
    const custom = { Stop: codexLcmHooks().Stop };
    expect(JSON.parse(planCodexHooksInstall("", "", "cli", { preToolRecall: true, expected: custom }).hooksContent).hooks).toEqual(custom);
  });
});

describe("Codex hooks install planning", () => {
  it("adds the trust step and writes config only when the feature is absent", () => {
    const fresh = planCodexHooksInstall("", "");
    expect(fresh.notices).toEqual([CODEX_TRUST_NOTICE]);
    expect(fresh.configContent).toBe("[features]\nhooks = true\n");
    expect(JSON.parse(fresh.hooksContent).hooks).toEqual(codexLcmHooks());
    const enabled = planCodexHooksInstall("", "features.hooks = true\n");
    expect(enabled.configContent).toBeUndefined();
    expect(enabled.notices).toEqual([CODEX_TRUST_NOTICE]);
  });

  it("leaves a disabled or unrecognised feature alone and says so", () => {
    const disabled = planCodexHooksInstall("", "[features]\nhooks = false\n");
    expect(disabled.configContent).toBeUndefined();
    expect(disabled).toMatchObject({
      notices: [
        "Codex hooks feature is disabled in config.toml; left unchanged; LCM hooks will not run until you enable it",
        CODEX_TRUST_NOTICE,
      ],
    });
    expect(planCodexHooksInstall("", "features = { hooks = true }\n").notices[0]).toContain("Could not interpret the Codex hooks feature");
    const unsafe = planCodexHooksInstall("", "features.other = 1\n");
    expect(unsafe.configContent).toBeUndefined();
    expect(unsafe.notices[0]).toContain("Could not safely add the Codex hooks feature");
  });

  it("plans no config write for a config.toml with an overflowing float", () => {
    for (const config of ["x = 1e309\n", "x = 1_0e309\n", "x = [ -1e999 ]\n"]) {
      const plan = planCodexHooksInstall("", config);
      expect(plan.configContent, config).toBeUndefined();
      expect(plan.notices[0], config).toContain("Could not interpret the Codex hooks feature");
    }
  });

  it("returns the refusal without any planned content", () => {
    const duplicate = JSON.stringify({ hooks: { Stop: [{ hooks: [lcm("lcm session-snapshot --client codex"), lcm("lcm session-snapshot --client codex")] }] } });
    expect(planCodexHooksInstall(duplicate, "")).toEqual({ hooksContent: duplicate, notices: [], refusal: expect.stringContaining("multiple LCM handlers") });
  });
});

describe("legacy installCodexHooks preflight", () => {
  let dir: string;
  let hooksPath: string;
  let configPath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "codex-hooks-merge-"));
    hooksPath = join(dir, "codex", "hooks.json");
    configPath = join(dir, "codex", "config.toml");
  });
  afterEach(() => rmSync(dir, { recursive: true }));

  it("refuses before writing either file", () => {
    mkdirSync(join(dir, "codex"));
    const hooks = JSON.stringify({ hooks: { Stop: [{ hooks: [lcm("lcm session-snapshot --client codex")] }, { hooks: [lcm("lcm session-snapshot --client codex")] }] } });
    writeFileSync(hooksPath, hooks);
    writeFileSync(configPath, "model = 'x'\n");
    expect(() => installCodexHooks(hooksPath, configPath)).toThrow("multiple LCM handlers share one role");
    expect(readFileSync(hooksPath, "utf-8")).toBe(hooks);
    expect(readFileSync(configPath, "utf-8")).toBe("model = 'x'\n");
  });

  it("preserves a deliberate disable and all hook state bytes", () => {
    mkdirSync(join(dir, "codex"));
    const config = '[features]\nhooks = false\n\n[hooks.state."' + hooksPath + ':stop:0:0"]\nenabled = false\ntrusted_hash = "sha256:x"\n';
    writeFileSync(configPath, config);
    installCodexHooks(hooksPath, configPath);
    expect(readFileSync(configPath, "utf-8")).toBe(config);
    expect(JSON.parse(readFileSync(hooksPath, "utf-8")).hooks.Stop).toEqual(codexLcmHooks().Stop);
  });

  it("creates the config only when it must add the feature", () => {
    mkdirSync(configPath, { recursive: true });
    expect(() => installCodexHooks(hooksPath, configPath)).toThrow();
    rmSync(configPath, { recursive: true });
    installCodexHooks(hooksPath, configPath);
    expect(readFileSync(configPath, "utf-8")).toBe("[features]\nhooks = true\n");
    rmSync(configPath);
    writeFileSync(configPath, "[features]\ncodex_hooks = true\n");
    installCodexHooks(hooksPath, configPath);
    expect(readFileSync(configPath, "utf-8")).toBe("[features]\ncodex_hooks = true\n");
  });
});
