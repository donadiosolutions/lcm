import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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
  captureConnectorLeaf,
  mutateConnectorLeaf,
  compensateConnectorLeaf,
  finalizeConnectorLeaf,
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
    expect(setCodexHooksFeature("[features]\nhooks = false\ncodex_hooks = true\n"))
      .toBe("[features]\nhooks = true\n");
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

  it("stamps only UserPromptSubmit and converges legacy or stamped prompt hooks", () => {
    writeFileSync(hooksPath, JSON.stringify({
      hooks: {
        UserPromptSubmit: [{ hooks: [
          { type: "command", command: "lcm user-prompt --client codex" },
          { type: "command", command: "lcm user-prompt --client codex --transport mcp" },
          { type: "command", command: "lcm user-prompt --client codex --transport invalid" },
        ] }],
      },
    }));
    installCodexHooks(hooksPath, configPath);
    const result = JSON.parse(readFileSync(hooksPath, "utf-8"));
    const commands = result.hooks.UserPromptSubmit.flatMap((group: any) => group.hooks.map((hook: any) => hook.command));
    expect(commands).toEqual(["lcm user-prompt --client codex --transport invalid", "lcm user-prompt --client codex --transport cli"]);
    expect(result.hooks.PostToolUse[0].hooks[0].command).toBe("lcm post-tool --client codex");
  });

  it("rejects an unsupported transport before writing Codex hooks", () => {
    expect(() => installCodexHooks(hooksPath, configPath, "invalid" as never)).toThrow(
      "Unsupported hook transport: invalid",
    );
    expect(existsSync(hooksPath)).toBe(false);
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

  it("physically removes a file containing only LCM hooks", () => {
    installCodexHooks(hooksPath, configPath);
    expect(removeCodexHooks(hooksPath)).toBe(true);
    expect(existsSync(hooksPath)).toBe(false);
    expect(removeCodexHooks(hooksPath)).toBe(false);
  });
  it("removes a multiply linked hook name without touching aliases", () => {
    installCodexHooks(hooksPath, configPath);
    const aliasPath = join(dir, "hooks-alias.json");
    const installed = readFileSync(hooksPath);
    linkSync(hooksPath, aliasPath);
    expect(removeCodexHooks(hooksPath)).toBe(true);
    expect(existsSync(hooksPath)).toBe(false);
    expect(readFileSync(aliasPath)).toEqual(installed);
  });
  it("rechecks alias races without mutating the alias inode", () => {
    installCodexHooks(hooksPath, configPath);
    const aliasPath = join(dir, "late-hooks-alias.json");
    const installed = readFileSync(hooksPath);
    linkSync(hooksPath, aliasPath);
    expect(removeCodexHooks(hooksPath)).toBe(true);
    expect(existsSync(hooksPath)).toBe(false);
    expect(readFileSync(aliasPath)).toEqual(installed);
  });
  it("rejects unstable capture without touching the public leaf", () => {
    installCodexHooks(hooksPath, configPath);
    const before = readFileSync(hooksPath);
    expect(removeCodexHooks(hooksPath)).toBe(true);
    expect(existsSync(hooksPath)).toBe(false);
    expect(before.length).toBeGreaterThan(0);
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

  it("advances sequential receipts and compensates the permanent initial state", () => {
    writeFileSync(hooksPath, "initial\n");
    chmodSync(hooksPath, 0o640);
    const operation = {
      displayPath: hooksPath,
      operationPath: hooksPath,
      parentOperationPath: dir,
      expected: captureConnectorLeaf(hooksPath, hooksPath),
      decide: (base: import("../../src/connectors/codex-hooks.js").ConnectorLeafState) =>
        base.state === "regular"
          ? { state: "regular" as const, content: Buffer.from("next\n"), mode: base.mode }
          : { state: "unchanged" as const },
    };
    const first = mutateConnectorLeaf(operation);
    expect(first.changed).toBe(true);
    expect(readFileSync(hooksPath, "utf-8")).toBe("next\n");
    const second = mutateConnectorLeaf({
      ...operation,
      expected: first.receipt.current,
      decide: () => ({ state: "absent" as const }),
    }, first.receipt);
    expect(second.changed).toBe(true);
    expect(existsSync(hooksPath)).toBe(false);
    expect(compensateConnectorLeaf(second.receipt)).toEqual([]);
    expect(readFileSync(hooksPath, "utf-8")).toBe("initial\n");
    expect(finalizeConnectorLeaf(second.receipt)).toEqual([]);
  });

  it("fails no-replace publication when a peer creates an absent leaf", () => {
    const peerContent = Buffer.from("peer\n");
    const operation = {
      displayPath: hooksPath,
      operationPath: hooksPath,
      parentOperationPath: dir,
      expected: { state: "absent" as const },
      decide: () => {
        writeFileSync(hooksPath, peerContent);
        return { state: "regular" as const, content: Buffer.from("candidate\n"), mode: 0o640 };
      },
    };
    expect(() => mutateConnectorLeaf(operation)).toThrow(/EEXIST/iu);
    expect(readFileSync(hooksPath)).toEqual(peerContent);
  });

  it("rejects symlink, directory, and malformed leaf states without following them", () => {
    const outside = join(dir, "outside.json");
    writeFileSync(outside, "outside\n");
    symlinkSync(outside, hooksPath);
    expect(() => captureConnectorLeaf(hooksPath, hooksPath)).toThrow(/inspect connector leaf|ELOOP/iu);
    expect(readFileSync(outside, "utf-8")).toBe("outside\n");
    rmSync(hooksPath);
    mkdirSync(hooksPath);
    expect(() => captureConnectorLeaf(hooksPath, hooksPath)).toThrow(/not a regular file/iu);
  });

  it("rejects same-inode byte and mode edits before claiming the public name", () => {
    writeFileSync(hooksPath, "initial\n");
    chmodSync(hooksPath, 0o640);
    const expected = captureConnectorLeaf(hooksPath, hooksPath);
    expect(() => mutateConnectorLeaf({
      displayPath: hooksPath,
      operationPath: hooksPath,
      parentOperationPath: dir,
      expected,
      decide: () => {
        writeFileSync(hooksPath, "concurrent\n");
        chmodSync(hooksPath, 0o600);
        return { state: "regular" as const, content: Buffer.from("candidate\n"), mode: 0o640 };
      },
    })).toThrow(/claim validation failed|changed/iu);
    expect(readFileSync(hooksPath, "utf-8")).toBe("concurrent\n");
    expect(statSync(hooksPath).mode & 0o777).toBe(0o600);
  });

  it("allows candidate zero-byte staging while keeping publication complete", () => {
    writeFileSync(hooksPath, "initial\n");
    const expected = captureConnectorLeaf(hooksPath, hooksPath);
    const result = mutateConnectorLeaf({
      displayPath: hooksPath,
      operationPath: hooksPath,
      parentOperationPath: dir,
      expected,
      decide: () => ({ state: "regular" as const, content: Buffer.alloc(0), mode: 0o600 }),
    });
    expect(result.changed).toBe(true);
    expect(readFileSync(hooksPath)).toEqual(Buffer.alloc(0));
    expect(finalizeConnectorLeaf(result.receipt)).toEqual([]);
  });
});
