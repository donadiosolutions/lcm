import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  enableCodexHooksFeature,
  hasCodexHooks,
  inspectCodexPostToolHook,
  installCodexHooks,
  removeCodexHooks,
  resolveCodexHooksPath,
  setCodexHooksFeature,
} from "../../src/connectors/codex-hooks.js";

describe("Codex hook configuration boundaries", () => {
  let dir: string;
  let hooksPath: string;
  let configPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "codex-hooks-"));
    hooksPath = join(dir, "hooks.json");
    configPath = join(dir, "config.toml");
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("sets the feature in empty, absent, existing, and section-delimited configs", () => {
    expect(setCodexHooksFeature("\r\n")).toBe("[features]\nhooks = true\n");
    expect(setCodexHooksFeature("model = 'x'\n")).toContain("\n\n[features]\nhooks = true\n");
    expect(setCodexHooksFeature("[features]\nhooks = false\n[other]\nx = 1\n"))
      .toBe("[features]\nhooks = true\n[other]\nx = 1\n");
    expect(setCodexHooksFeature("[features] # settings\ncodex_hooks = true\nhooks = false\n"))
      .toBe("[features] # settings\nhooks = true\n");
    expect(setCodexHooksFeature("[features]\nvalue = 1\n[other]\nx = 1\n"))
      .toBe("[features]\nvalue = 1\nhooks = true\n[other]\nx = 1\n");
  });

  it("enables the feature idempotently on disk", () => {
    enableCodexHooksFeature(configPath);
    const first = readFileSync(configPath, "utf-8");
    enableCodexHooksFeature(configPath);
    expect(readFileSync(configPath, "utf-8")).toBe(first);
  });

  it("does not treat non-missing config read failures as an absent file", () => {
    mkdirSync(configPath);
    expect(() => enableCodexHooksFeature(configPath)).toThrow();
  });

  it("normalizes malformed hook files while installing", () => {
    writeFileSync(hooksPath, "not json");
    installCodexHooks(hooksPath, configPath);
    expect(hasCodexHooks(hooksPath)).toBe(true);

    writeFileSync(hooksPath, "null");
    installCodexHooks(hooksPath, configPath);
    expect(hasCodexHooks(hooksPath)).toBe(true);

    writeFileSync(hooksPath, JSON.stringify({ hooks: [] }));
    installCodexHooks(hooksPath, configPath);
    expect(hasCodexHooks(hooksPath)).toBe(true);
  });

  it("preserves malformed groups and custom metadata while stripping LCM hooks", () => {
    writeFileSync(hooksPath, JSON.stringify({
      custom: true,
      hooks: {
        Invalid: "not-an-array",
        SessionStart: [
          { matcher: "missing hooks" },
          { matcher: "startup", hooks: [{ command: 42 }] },
          { matcher: "startup", label: "keep", hooks: [{ command: "lcm restore --client codex" }] },
        ],
      },
    }));
    expect(removeCodexHooks(hooksPath)).toBe(true);
    const result = JSON.parse(readFileSync(hooksPath, "utf-8"));
    expect(result.custom).toBe(true);
    expect(result.hooks.SessionStart).toEqual([
      { matcher: "missing hooks" },
      { matcher: "startup", hooks: [{ command: 42 }] },
      { matcher: "startup", label: "keep", hooks: [] },
    ]);
  });

  it("handles absent, invalid, and unmanaged hook files", () => {
    expect(removeCodexHooks(hooksPath)).toBe(false);
    expect(hasCodexHooks(hooksPath)).toBe(false);
    writeFileSync(hooksPath, "invalid");
    expect(removeCodexHooks(hooksPath)).toBe(false);
    expect(hasCodexHooks(hooksPath)).toBe(false);
    writeFileSync(hooksPath, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ command: "echo keep" }] }] } }));
    expect(removeCodexHooks(hooksPath)).toBe(false);
  });

  it("deletes a file containing only LCM hooks", () => {
    mkdirSync(join(dir, "nested"), { recursive: true });
    installCodexHooks(hooksPath, configPath);
    expect(removeCodexHooks(hooksPath)).toBe(true);
    expect(existsSync(hooksPath)).toBe(false);
  });

  it("keeps broad discovery permissive while exact inspection requires the native PostToolUse hook", () => {
    writeFileSync(hooksPath, JSON.stringify({
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: "lcm restore --client codex" }] }],
      },
    }));

    expect(hasCodexHooks(hooksPath)).toBe(true);
    expect(inspectCodexPostToolHook(hooksPath)).toMatchObject({ state: "incomplete" });
  });

  it.each([
    ["absent file", undefined, "absent"],
    ["malformed JSON", "not-json", "incomplete"],
    ["parsed JSON is not an object", "null", "incomplete"],
    ["hooks is not a record", JSON.stringify({ hooks: [] }), "incomplete"],
    ["missing PostToolUse", JSON.stringify({ hooks: { SessionStart: [] } }), "incomplete"],
    ["PostToolUse is not an array", JSON.stringify({ hooks: { PostToolUse: {} } }), "incomplete"],
    ["wrong matcher", JSON.stringify({ hooks: { PostToolUse: [{ matcher: "tool", hooks: [{ type: "command", command: "lcm post-tool --client codex" }] }] } }), "incomplete"],
    ["wrong hook type", JSON.stringify({ hooks: { PostToolUse: [{ matcher: "*", hooks: [{ type: "prompt", command: "lcm post-tool --client codex" }] }] } }), "incomplete"],
    ["wrong client", JSON.stringify({ hooks: { PostToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "lcm post-tool" }] }] } }), "incomplete"],
    ["extra command arguments", JSON.stringify({ hooks: { PostToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "lcm post-tool --client codex --verbose" }] }] } }), "incomplete"],
    ["missing command", JSON.stringify({ hooks: { PostToolUse: [{ matcher: "*", hooks: [{ type: "command" }] }] } }), "incomplete"],
    ["exact native hook", JSON.stringify({ hooks: { PostToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "lcm post-tool --client codex" }] }] } }), "installed"],
  ] as const)("classifies %s with exact PostToolUse structural rules", (_label, content, expected) => {
    if (content !== undefined) writeFileSync(hooksPath, content);
    expect(inspectCodexPostToolHook(hooksPath)).toMatchObject({
      state: expected,
      structural: expected === "installed",
    });
  });

  it("resolves the same canonical global hooks path used by installation", () => {
    expect(resolveCodexHooksPath(dir)).toBe(join(process.env.HOME ?? "", ".codex", "hooks.json"));
  });

  it("does not modify the hook file during structural inspection", () => {
    const content = JSON.stringify({
      hooks: {
        PostToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "lcm post-tool --client codex" }] }],
      },
    });
    writeFileSync(hooksPath, content);

    expect(inspectCodexPostToolHook(hooksPath)).toMatchObject({ state: "installed", structural: true });
    expect(readFileSync(hooksPath, "utf-8")).toBe(content);
  });

  it("treats a readable-path failure other than absence as incomplete", () => {
    mkdirSync(hooksPath);
    expect(inspectCodexPostToolHook(hooksPath)).toMatchObject({ state: "incomplete", structural: false });
  });
});
