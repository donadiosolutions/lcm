import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chmodSync,
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  writeSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as fs from "node:fs";
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
  matchesCertificate,
} from "../../src/connectors/codex-hooks.js";

function serializedErrorSurface(value: unknown): string {
  const seen = new Set<object>();
  const snapshot = (item: unknown): unknown => {
    if (item === null || typeof item !== "object") return item;
    if (seen.has(item)) return "[circular]";
    seen.add(item);
    const keys = new Set([
      ...Object.keys(item),
      ...(item instanceof Error ? ["name", "message", "cause", "code"] : []),
    ]);
    return Object.fromEntries([...keys].map((key) => [key, snapshot((item as Record<string, unknown>)[key])]));
  };
  return JSON.stringify(snapshot(value));
}

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
    const compensated = compensateConnectorLeaf(second.receipt);
    expect(compensated.failures).toEqual([]);
    expect(readFileSync(hooksPath, "utf-8")).toBe("initial\n");
    expect(finalizeConnectorLeaf(compensated.receipt).failures).toEqual([]);
  });

  it("keeps staged certificate authority when both publication aliases are edited", async () => {
    vi.resetModules();
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      return {
        ...actual,
        linkSync: ((existing: fs.PathLike, target: fs.PathLike) => {
          const result = actual.linkSync(existing, target);
          if (String(existing).includes("candidate-") && String(target).endsWith("/hooks.json")) {
            actual.writeFileSync(target, "peer-edit\n");
            actual.chmodSync(target, 0o600);
          }
          return result;
        }) as typeof actual.linkSync,
      };
    });
    try {
      const module = await import("../../src/connectors/codex-hooks.js");
      writeFileSync(hooksPath, "initial\n", { mode: 0o640 });
      let caught: unknown;
      try {
        module.mutateConnectorLeaf({
          displayPath: hooksPath,
          operationPath: hooksPath,
          parentOperationPath: dir,
          expected: module.captureConnectorLeaf(hooksPath, hooksPath),
          decide: () => ({ state: "regular" as const, content: Buffer.from("candidate\n"), mode: 0o640 }),
        });
      } catch (error) { caught = error; }
      const receipt = (caught as Error & { connectorLeafReceipt?: module.ConnectorLeafReceipt }).connectorLeafReceipt;
      expect(receipt).toBeDefined();
      expect(receipt!.current).toMatchObject({ state: "regular", sha256: expect.not.stringMatching(/^(?:0|f){64}$/) });
      expect(Object.keys(receipt!)).not.toContain("operationPath");
      expect(JSON.stringify(receipt)).not.toContain("/proc/self/fd/");
      expect(module.compensateConnectorLeaf(receipt!).failures).toHaveLength(1);
      expect(readFileSync(hooksPath, "utf-8")).toBe("peer-edit\n");
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });

  it("exercises certificate helpers and certified compensation paths", () => {
    expect(matchesCertificate({ state: "absent", certificate: { state: "absent" } }, { state: "absent" })).toBe(true);
    expect(matchesCertificate({ state: "unknown" } as never, { state: "absent" })).toBe(false);
    expect(matchesCertificate({ state: "absent", certificate: { state: "absent" } }, null as never)).toBe(false);
    expect(matchesCertificate({ state: "absent", certificate: { state: "absent" } }, { state: "unknown" } as never)).toBe(false);
    const regularPath = join(dir, "certificate-regular");
    writeFileSync(regularPath, "initial\n", { mode: 0o6755 });
    const regular = mutateConnectorLeaf({
      displayPath: regularPath,
      operationPath: regularPath,
      parentOperationPath: dir,
      expected: captureConnectorLeaf(regularPath, regularPath),
      decide: () => ({ state: "regular" as const, content: Buffer.from("next\n"), mode: 0o6755 }),
    });
    const compensated = compensateConnectorLeaf(regular.receipt);
    expect(compensated.failures).toEqual([]);
    expect(finalizeConnectorLeaf(compensated.receipt).failures).toEqual([]);
    const absentPath = join(dir, "certificate-absent");
    writeFileSync(absentPath, "initial\n", { mode: 0o600 });
    const absent = mutateConnectorLeaf({
      displayPath: absentPath,
      operationPath: absentPath,
      parentOperationPath: dir,
      expected: captureConnectorLeaf(absentPath, absentPath),
      decide: () => ({ state: "absent" as const }),
    });
    expect(compensateConnectorLeaf(absent.receipt).failures).toEqual([]);
    expect(finalizeConnectorLeaf(absent.receipt).failures).toEqual([]);
    expect(hasCodexHooks(join(dir, "missing-hooks.json"))).toBe(false);
    expect(inspectCodexPostToolHook(join(dir, "missing-hooks.json"))).toMatchObject({ state: "absent" });
  });

  it("enforces the immutable certificate and object-result contracts", () => {
    const absentPath = join(dir, "contract-absent");
    const absent = captureConnectorLeaf(absentPath, absentPath);
    expect(absent).toEqual({ state: "absent", certificate: { state: "absent" } });
    expect(Object.isFrozen(absent)).toBe(true);
    expect(Object.isFrozen(absent.certificate)).toBe(true);
    const path = join(dir, "contract-regular");
    writeFileSync(path, "before\n", { mode: 0o6755 });
    const observed = captureConnectorLeaf(path, path);
    expect(Object.keys(observed)).toEqual(["state", "content", "certificate"]);
    expect(Object.isFrozen(observed.certificate)).toBe(true);
    expect(Object.keys(observed.certificate)).toEqual(["state", "sha256", "size", "mode", "dev", "ino"]);
    expect(() => mutateConnectorLeaf({
      displayPath: path,
      operationPath: path,
      parentOperationPath: dir,
      expected: { state: "regular" } as never,
      decide: () => ({ state: "unchanged" as const }),
    })).toThrow(/invalid connector publication certificate/iu);
    const result = mutateConnectorLeaf({
      displayPath: path,
      operationPath: path,
      parentOperationPath: dir,
      expected: observed.certificate,
      decide: (base) => ({ state: "regular" as const, content: Buffer.from("after\n"), mode: base.certificate.mode }),
    });
    expect(Array.isArray(result)).toBe(false);
    expect(Object.keys(result.receipt)).not.toContain("operationPath");
    expect(result.receipt.evidence.filter((entry) => entry.operationPath.includes("candidate-") && entry.kind === "current-private")).toHaveLength(1);
    const compensated = compensateConnectorLeaf(result.receipt);
    expect(compensated.compensated).toBe(true);
    expect(finalizeConnectorLeaf(compensated.receipt).finalized).toBe(true);
  });

  it("rejects malformed root leaf paths before mutation", () => {
    expect(() => removeCodexHooks("/")).toThrow(/Unable to inspect connector hooks parent/iu);
  });

  it("retains a non-regular initial hold during compensation", () => {
    const path = join(dir, "non-regular-initial");
    writeFileSync(path, "initial\n");
    const result = mutateConnectorLeaf({
      displayPath: path,
      operationPath: path,
      parentOperationPath: dir,
      expected: captureConnectorLeaf(path, path).certificate,
      decide: (base) => ({ state: "regular" as const, content: Buffer.from("next\n"), mode: base.certificate.mode }),
    });
    const initial = result.receipt.evidence.find((entry) => entry.kind === "initial")!.operationPath;
    unlinkSync(initial);
    symlinkSync(path, initial);
    expect(compensateConnectorLeaf(result.receipt).compensated).toBe(false);
  });

  it("compensates a committed standalone failure without exposing operation paths", async () => {
    vi.resetModules();
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      return {
        ...actual,
        linkSync: ((existing: fs.PathLike, target: fs.PathLike) => {
          const result = actual.linkSync(existing, target);
          if (String(existing).includes("candidate-")) actual.writeFileSync(target, "peer-edit\n");
          return result;
        }) as typeof actual.linkSync,
      };
    });
    try {
      const module = await import("../../src/connectors/codex-hooks.js");
      writeFileSync(hooksPath, JSON.stringify({ hooks: { PostToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "lcm post-tool --client codex" }] }] }, custom: true }));
      expect(() => module.removeCodexHooks(hooksPath)).toThrow(/standalone compensation incomplete|rollback incomplete/iu);
      expect(readFileSync(hooksPath, "utf-8")).toBe("peer-edit\n");
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
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

  it.each([
    ["sparse", true],
    ["declared", false],
  ] as const)("rejects a %s 4 MiB+1 leaf before allocation, reads, or mutation", async (_label, sparse) => {
    writeFileSync(hooksPath, "owned\n");
    if (sparse) truncateSync(hooksPath, (4 * 1024 * 1024) + 1);
    const original = sparse ? undefined : readFileSync(hooksPath);
    let leafReads = 0;
    let mutations = 0;
    const leafDescriptors = new Set<number>();

    vi.resetModules();
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      return {
        ...actual,
        openSync: ((path: fs.PathLike, flags: fs.OpenMode, mode?: number) => {
          const descriptor = mode === undefined
            ? actual.openSync(path, flags)
            : actual.openSync(path, flags, mode);
          try {
            if (actual.readlinkSync(`/proc/self/fd/${descriptor}`) === hooksPath) {
              leafDescriptors.add(descriptor);
            }
          } catch { /* not the connector leaf */ }
          return descriptor;
        }) as typeof actual.openSync,
        fstatSync: ((descriptor: number, options?: fs.StatOptions) => {
          const stats = actual.fstatSync(descriptor, options as never);
          if (sparse || !leafDescriptors.has(descriptor)) return stats;
          return new Proxy(stats, {
            get: (target, property) => property === "size"
              ? (4 * 1024 * 1024) + 1
              : Reflect.get(target, property, target),
          });
        }) as typeof actual.fstatSync,
        readSync: ((...args: Parameters<typeof actual.readSync>) => {
          if (leafDescriptors.has(args[0])) leafReads += 1;
          return actual.readSync(...args);
        }) as typeof actual.readSync,
        renameSync: ((...args: Parameters<typeof actual.renameSync>) => {
          mutations += 1;
          return actual.renameSync(...args);
        }) as typeof actual.renameSync,
        linkSync: ((...args: Parameters<typeof actual.linkSync>) => {
          mutations += 1;
          return actual.linkSync(...args);
        }) as typeof actual.linkSync,
        unlinkSync: ((...args: Parameters<typeof actual.unlinkSync>) => {
          mutations += 1;
          return actual.unlinkSync(...args);
        }) as typeof actual.unlinkSync,
        closeSync: ((descriptor: number) => {
          leafDescriptors.delete(descriptor);
          return actual.closeSync(descriptor);
        }) as typeof actual.closeSync,
      };
    });
    const allocation = vi.spyOn(Buffer, "alloc");
    try {
      const module = await import("../../src/connectors/codex-hooks.js");
      expect(() => module.removeCodexHooks(hooksPath)).toThrow(
        `Refusing to read connector leaf larger than 4 MiB at ${hooksPath}`,
      );
      expect(allocation).not.toHaveBeenCalled();
      expect(leafReads).toBe(0);
      expect(mutations).toBe(0);
      if (sparse) expect(statSync(hooksPath).size).toBe((4 * 1024 * 1024) + 1);
      else expect(readFileSync(hooksPath)).toEqual(original);
    } finally {
      allocation.mockRestore();
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });

  it("rejects an oversized connector decision before creating a transaction namespace", () => {
    writeFileSync(hooksPath, "base\n");
    const expected = captureConnectorLeaf(hooksPath, hooksPath);
    const oversized = Buffer.alloc((4 * 1024 * 1024) + 1);

    expect(() => mutateConnectorLeaf({
      displayPath: hooksPath,
      operationPath: hooksPath,
      parentOperationPath: dir,
      expected,
      decide: () => ({ state: "regular" as const, content: oversized, mode: 0o600 }),
    })).toThrow(`Refusing to read connector leaf larger than 4 MiB at ${hooksPath}`);
    expect(readFileSync(hooksPath, "utf-8")).toBe("base\n");
    expect(readdirSync(dir).filter((entry) => entry.startsWith(".lcm-connector-txn-"))).toEqual([]);
  });

  it("sanitizes the initial symlink capture error and its complete error surface", () => {
    const outside = join(dir, "outside.json");
    writeFileSync(outside, "outside\n");
    symlinkSync(outside, hooksPath);
    let caught: unknown;
    try { removeCodexHooks(hooksPath); } catch (error) { caught = error; }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as NodeJS.ErrnoException).code).toBe("ELOOP");
    expect((caught as Error).message).toContain(hooksPath);
    expect((caught as Error & { cause?: unknown }).cause).toBeUndefined();
    const surface = serializedErrorSurface(caught);
    expect(surface).toContain(hooksPath);
    expect(surface).not.toContain("/proc/self/fd/");
    expect(readFileSync(outside, "utf-8")).toBe("outside\n");
  });

  it("sanitizes an injected initial open failure and all nested enumerable paths", async () => {
    writeFileSync(hooksPath, "owned\n");
    vi.resetModules();
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      return {
        ...actual,
        openSync: ((path: fs.PathLike, flags: fs.OpenMode, mode?: number) => {
          const shown = String(path);
          if (shown.startsWith("/proc/self/fd/") && shown.endsWith("/hooks.json")) {
            const nested = Object.assign(new Error(`nested failure at ${shown}`), { detail: shown });
            throw Object.assign(new Error(`open denied at ${shown}`, { cause: nested }), {
              code: "EACCES",
              operationPath: shown,
            });
          }
          return mode === undefined ? actual.openSync(path, flags) : actual.openSync(path, flags, mode);
        }) as typeof actual.openSync,
      };
    });
    try {
      const module = await import("../../src/connectors/codex-hooks.js");
      let caught: unknown;
      try { module.removeCodexHooks(hooksPath); } catch (error) { caught = error; }

      expect(caught).toBeInstanceOf(Error);
      expect((caught as NodeJS.ErrnoException).code).toBe("EACCES");
      expect((caught as Error).message).toContain(hooksPath);
      expect((caught as Error & { cause?: unknown }).cause).toBeUndefined();
      const surface = serializedErrorSurface(caught);
      expect(surface).toContain(hooksPath);
      expect(surface).not.toContain("/proc/self/fd/");
      expect(readFileSync(hooksPath, "utf-8")).toBe("owned\n");
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
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
    expect(finalizeConnectorLeaf(result.receipt).failures).toEqual([]);
  });

  it("honors the process umask when publishing a previously absent leaf", () => {
    const previousUmask = process.umask(0o077);
    try {
      const result = mutateConnectorLeaf({
        displayPath: hooksPath,
        operationPath: hooksPath,
        parentOperationPath: dir,
        expected: { state: "absent" as const },
        decide: () => ({ state: "regular" as const, content: Buffer.from("private\n"), mode: 0o666 }),
      });
      expect(statSync(hooksPath).mode & 0o777).toBe(0o600);
      expect(finalizeConnectorLeaf(result.receipt).failures).toEqual([]);
    } finally {
      process.umask(previousUmask);
    }
  });

  it("retains a drifted initial hold instead of deleting an ordered-after-claim write", () => {
    writeFileSync(hooksPath, "initial!", { mode: 0o600 });
    const writer = openSync(hooksPath, "r+");
    const result = mutateConnectorLeaf({
      displayPath: hooksPath,
      operationPath: hooksPath,
      parentOperationPath: dir,
      expected: captureConnectorLeaf(hooksPath, hooksPath),
      decide: () => ({ state: "regular" as const, content: Buffer.from("current!"), mode: 0o600 }),
    });
    try {
      writeSync(writer, Buffer.from("peeredit"), 0, 8, 0);
    } finally {
      closeSync(writer);
    }
    const failures = finalizeConnectorLeaf(result.receipt);
    expect(failures.failures.join(";")).toMatch(/cleanup incomplete.*recovery/iu);
    expect(readFileSync(result.receipt.evidence.find((entry) => entry.kind === "initial")!.operationPath, "utf-8")).toBe("peeredit");
  });

  it("refuses compensation before publishing a drifted initial hold", () => {
    writeFileSync(hooksPath, "initial!", { mode: 0o600 });
    const writer = openSync(hooksPath, "r+");
    const result = mutateConnectorLeaf({
      displayPath: hooksPath,
      operationPath: hooksPath,
      parentOperationPath: dir,
      expected: captureConnectorLeaf(hooksPath, hooksPath),
      decide: () => ({ state: "regular" as const, content: Buffer.from("current!"), mode: 0o600 }),
    });
    try {
      writeSync(writer, Buffer.from("peeredit"), 0, 8, 0);
    } finally {
      closeSync(writer);
    }
    const failures = compensateConnectorLeaf(result.receipt);
    expect(failures.failures.join(";")).toMatch(/rollback incomplete/iu);
    expect(readFileSync(hooksPath, "utf-8")).toBe("current!");
    expect(readFileSync(result.receipt.evidence.find((entry) => entry.kind === "initial")!.operationPath, "utf-8")).toBe("peeredit");
  });

  it("retains a drifted regular-to-absent generation during finalization", () => {
    writeFileSync(hooksPath, "initial!", { mode: 0o600 });
    const first = mutateConnectorLeaf({
      displayPath: hooksPath,
      operationPath: hooksPath,
      parentOperationPath: dir,
      expected: captureConnectorLeaf(hooksPath, hooksPath),
      decide: () => ({ state: "regular" as const, content: Buffer.from("current!"), mode: 0o600 }),
    });
    const writer = openSync(hooksPath, "r+");
    const second = mutateConnectorLeaf({
      displayPath: hooksPath,
      operationPath: hooksPath,
      parentOperationPath: dir,
      expected: first.receipt.current,
      decide: () => ({ state: "absent" as const }),
    }, first.receipt);
    try {
      writeSync(writer, Buffer.from("peeredit"), 0, 8, 0);
    } finally {
      closeSync(writer);
    }
    const failures = finalizeConnectorLeaf(second.receipt);
    expect(failures.failures.join(";")).toMatch(/cleanup incomplete.*recovery/iu);
    expect(readFileSync(second.receipt.evidence.find((entry) => entry.kind === "superseded")!.operationPath, "utf-8")).toBe("peeredit");
  });

  it("covers sequential receipt cleanup and no-op compensation", () => {
    writeFileSync(hooksPath, "one\n");
    const expected = captureConnectorLeaf(hooksPath, hooksPath);
    const first = mutateConnectorLeaf({
      displayPath: hooksPath, operationPath: hooksPath, parentOperationPath: dir, expected,
      decide: () => ({ state: "regular" as const, content: Buffer.from("two\n"), mode: 0o600 }),
    });
    const second = mutateConnectorLeaf({
      displayPath: hooksPath, operationPath: hooksPath, parentOperationPath: dir,
      expected: first.receipt.current,
      decide: () => ({ state: "regular" as const, content: Buffer.from("three\n"), mode: 0o600 }),
    }, first.receipt);
    expect(second.receipt.evidence.find((entry) => entry.kind === "initial")?.operationPath)
      .toBe(first.receipt.evidence.find((entry) => entry.kind === "initial")?.operationPath);
    const unchanged = mutateConnectorLeaf({
      displayPath: hooksPath, operationPath: hooksPath, parentOperationPath: dir,
      expected: second.receipt.current,
      decide: () => ({ state: "unchanged" as const }),
    }, second.receipt);
    expect(unchanged).toEqual({ changed: false, receipt: second.receipt });
    const compensated = compensateConnectorLeaf(second.receipt);
    expect(compensated.failures).toEqual([]);
    expect(readFileSync(hooksPath, "utf-8")).toBe("one\n");
    expect(finalizeConnectorLeaf(compensated.receipt).failures).toEqual([]);
    expect(compensateConnectorLeaf({
      ...second.receipt, mutationCommitted: false,
    }).failures).toEqual([]);
  });

  it("accepts an empty managed skill input and exercises native MCP refusal paths", async () => {
    writeFileSync(hooksPath, "");
    const installer = await import("../../src/connectors/installer.js");
    // An empty historical skill is owned and can be replaced by reinstall.
    expect(() => installer.installConnector("claude-code", "skill", dir)).not.toThrow();

    const absentRunner = { get: () => [], add: undefined, remove: () => undefined };
    expect(() => installer.installConnector("codex", "mcp", dir, {
      codexMcpRunner: absentRunner as never, persistTransport: false,
    })).toThrow(/does not provide add/iu);
    let malformedGets = 0;
    const malformedRunner = {
      get: () => (malformedGets++ < 3 ? [] : [{ name: "lcm", transport: { type: "sse" } }]),
      add: () => undefined,
      remove: () => undefined,
    };
    expect(() => installer.installConnector("codex", "mcp", dir, {
      codexMcpRunner: malformedRunner, persistTransport: false,
    })).toThrow(/readback verification/iu);
    expect(installer.removeConnector("codex", {
      cwd: dir,
      codexMcpRunner: { get: () => [{ name: "lcm", transport: { type: "stdio" } }], add: () => undefined, remove: () => undefined },
    })).toMatchObject({ success: false });
  });

  it("covers capture, staging, namespace, and cleanup fault boundaries", async () => {
    const faults = {
      capture: "" as string,
      tx: "" as string,
      candidate: "" as string,
      publishArmed: false,
      rollbackDrift: false,
      unlink: false,
      fstatCounts: new Map<number, number>(),
      descriptors: new Map<number, string>(),
    };
    vi.resetModules();
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      const display = (value: fs.PathLike): string => {
        const text = String(value);
        const match = /^\/proc\/self\/fd\/(\d+)(\/.*)$/u.exec(text);
        if (!match) return text;
        try { return join(actual.readlinkSync(`/proc/self/fd/${match[1]}`), match[2]); } catch { return text; }
      };
      return {
        ...actual,
        openSync: ((path: fs.PathLike, flags: fs.OpenMode, mode?: number) => {
          const shown = display(path);
          if (shown === hooksPath && faults.capture === "open") throw Object.assign(new Error("capture open"), { code: "EIO" });
          const fd = mode === undefined ? actual.openSync(path, flags) : actual.openSync(path, flags, mode);
          faults.descriptors.set(fd, shown);
          faults.fstatCounts.set(fd, 0);
          return fd;
        }) as typeof actual.openSync,
        fstatSync: ((fd: number, options?: fs.StatOptions) => {
          const shown = faults.descriptors.get(fd);
          const stats = actual.fstatSync(fd, options as never);
          const count = (faults.fstatCounts.get(fd) ?? 0) + 1;
          faults.fstatCounts.set(fd, count);
          if (shown === hooksPath && faults.capture === "size") {
            return new Proxy(stats, { get: (target, prop) => prop === "size" ? -1 : Reflect.get(target, prop, target) });
          }
          if (shown === hooksPath && faults.capture === "identity" && count > 1) {
            return new Proxy(stats, { get: (target, prop) => prop === "ino" ? Number(target.ino) + 1 : Reflect.get(target, prop, target) });
          }
          if (shown === hooksPath && faults.publishArmed) {
            faults.publishArmed = false;
            return new Proxy(stats, { get: (target, prop) => prop === "mode" ? Number(target.mode) ^ 1 : Reflect.get(target, prop, target) });
          }
          if (shown?.includes("candidate-") && faults.candidate === "verify" && count === 1) {
            return new Proxy(stats, { get: (target, prop) => prop === "size" ? Number(target.size) + 1 : Reflect.get(target, prop, target) });
          }
          if (shown?.includes("candidate-") && faults.candidate === "changed" && count > 1) {
            return new Proxy(stats, { get: (target, prop) => prop === "ino" ? Number(target.ino) + 1 : Reflect.get(target, prop, target) });
          }
          if (shown?.includes("candidate-") && faults.candidate === "staged" && count >= 3) {
            return new Proxy(stats, { get: (target, prop) => prop === "ino" ? Number(target.ino) + 1 : Reflect.get(target, prop, target) });
          }
          return stats;
        }) as typeof actual.fstatSync,
        fchmodSync: ((fd: number, mode: number) => {
          if (faults.restoreModeMismatch && (descriptors.get(fd) ?? "").includes("restore-")) return;
          return actual.fchmodSync(fd, mode);
        }) as typeof actual.fchmodSync,
        readSync: ((fd: number, buffer: Buffer, offset: number, length: number, position: number | null) => {
          if (faults.candidate === "zero-read" && faults.descriptors.get(fd) === hooksPath) return 0;
          const count = actual.readSync(fd, buffer, offset, length, position);
          if (faults.descriptors.get(fd)?.includes("candidate-") && faults.candidate === "mismatch" && count > 0) buffer[offset] ^= 0xff;
          return count;
        }) as typeof actual.readSync,
        writeSync: ((fd: number, data: Uint8Array, offset: number, length: number, position: number | null) => {
          if (faults.candidate === "zero-write" && faults.descriptors.get(fd)?.includes("candidate-")) return 0;
          return actual.writeSync(fd, data, offset, length, position);
        }) as typeof actual.writeSync,
        linkSync: ((existing: fs.PathLike, target: fs.PathLike) => {
          if (faults.candidate === "publish" && String(existing).includes("candidate-")) faults.publishArmed = true;
          return actual.linkSync(existing, target);
        }) as typeof actual.linkSync,
        renameSync: ((oldPath: fs.PathLike, newPath: fs.PathLike) => {
          const result = actual.renameSync(oldPath, newPath);
          if (faults.rollbackDrift && String(newPath).includes("rollback-")) {
            faults.rollbackDrift = false;
            actual.writeFileSync(newPath, "drift\n");
          }
          return result;
        }) as typeof actual.renameSync,
        mkdirSync: ((path: fs.PathLike, options?: fs.MakeDirectoryOptions | number) => {
          const shown = String(path);
          if (shown.includes(".lcm-connector-txn-") && faults.tx === "collision") throw Object.assign(new Error("collision"), { code: "EEXIST" });
          if (shown.includes(".lcm-connector-txn-") && faults.tx === "error") throw Object.assign(new Error("mkdir failed"), { code: "EIO" });
          return actual.mkdirSync(path, options as never);
        }) as typeof actual.mkdirSync,
        lstatSync: ((path: fs.PathLike, options?: fs.StatOptions) => {
          const shown = String(path);
          if (shown.includes(".lcm-connector-txn-") && faults.tx === "invalid") {
            const stats = actual.lstatSync(path, options as never);
            return new Proxy(stats, { get: (target, prop) => prop === "mode" ? 0o755 : Reflect.get(target, prop, target) });
          }
          return actual.lstatSync(path, options as never);
        }) as typeof actual.lstatSync,
        unlinkSync: ((path: fs.PathLike) => {
          if (faults.unlink && String(path).includes("candidate-")) throw Object.assign(new Error("unlink denied"), { code: "EIO" });
          return actual.unlinkSync(path);
        }) as typeof actual.unlinkSync,
        closeSync: ((fd: number) => { faults.descriptors.delete(fd); faults.fstatCounts.delete(fd); return actual.closeSync(fd); }) as typeof actual.closeSync,
      };
    });
    try {
      const module = await import("../../src/connectors/codex-hooks.js");
      const op = (expected: import("../../src/connectors/codex-hooks.js").ConnectorLeafState) => ({
        displayPath: hooksPath, operationPath: hooksPath, parentOperationPath: dir, expected,
        decide: () => ({ state: "regular" as const, content: Buffer.from("next\n"), mode: 0o600 }),
      });
      writeFileSync(hooksPath, "base\n");
      faults.capture = "size";
      expect(() => module.captureConnectorLeaf(hooksPath, hooksPath)).toThrow(/Unable to read connector leaf/iu);
      faults.capture = "identity";
      expect(() => module.captureConnectorLeaf(hooksPath, hooksPath)).toThrow(/changed while being read/iu);
      faults.capture = "";
      faults.candidate = "zero-read";
      expect(() => module.captureConnectorLeaf(hooksPath, hooksPath)).toThrow(/short connector leaf read/iu);
      faults.candidate = "zero-write";
      expect(() => module.mutateConnectorLeaf(op(module.captureConnectorLeaf(hooksPath, hooksPath)))).toThrow(/no progress/iu);
      faults.capture = "";
      faults.tx = "invalid";
      expect(() => module.mutateConnectorLeaf(op(module.captureConnectorLeaf(hooksPath, hooksPath)))).toThrow(/invalid transaction directory/iu);
      faults.tx = "";
      faults.candidate = "mismatch";
      expect(() => module.mutateConnectorLeaf(op(module.captureConnectorLeaf(hooksPath, hooksPath)))).toThrow(/readback mismatch/iu);
      faults.candidate = "changed";
      expect(() => module.mutateConnectorLeaf(op(module.captureConnectorLeaf(hooksPath, hooksPath)))).toThrow(/changed while being (?:read|staged)/iu);
      faults.candidate = "verify";
      expect(() => module.mutateConnectorLeaf(op(module.captureConnectorLeaf(hooksPath, hooksPath)))).toThrow(/verification failed|short connector leaf read/iu);
      faults.candidate = "staged";
      expect(() => module.mutateConnectorLeaf(op(module.captureConnectorLeaf(hooksPath, hooksPath)))).toThrow(/changed while being staged/iu);
      faults.candidate = "";
      expect(() => module.mutateConnectorLeaf({
        ...op(module.captureConnectorLeaf(hooksPath, hooksPath)),
        expected: { state: "absent" as const },
        decide: () => ({ state: "unchanged" as const }),
      })).toThrow(/changed before mutation/iu);
      faults.candidate = "mismatch";
      faults.unlink = true;
      expect(() => module.mutateConnectorLeaf(op(module.captureConnectorLeaf(hooksPath, hooksPath)))).toThrow(/readback mismatch.*cleanup failed/iu);
      faults.unlink = false;
      writeFileSync(hooksPath, JSON.stringify({ custom: true, hooks: { SessionStart: [{ hooks: [{ type: "command", command: "lcm restore --client codex" }] }] } }));
      faults.unlink = true;
      expect(() => module.removeCodexHooks(hooksPath)).toThrow(/cleanup failed/iu);
      faults.unlink = false;
      faults.tx = "error";
      expect(() => module.removeCodexHooks(hooksPath)).toThrow(/mkdir failed|Unable to/iu);
      faults.tx = "";
      faults.candidate = "";
      const rollbackSeed = module.mutateConnectorLeaf(op(module.captureConnectorLeaf(hooksPath, hooksPath)));
      faults.rollbackDrift = true;
      expect(module.compensateConnectorLeaf(rollbackSeed.receipt).failures[0]).toContain("rollback incomplete");
      faults.tx = "collision";
      expect(() => module.mutateConnectorLeaf(op(module.captureConnectorLeaf(hooksPath, hooksPath)))).toThrow(/unable to allocate/iu);
      faults.tx = "error";
      expect(() => module.mutateConnectorLeaf(op(module.captureConnectorLeaf(hooksPath, hooksPath)))).toThrow(/mkdir failed/iu);
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });

  it("covers compensation receipt guards and monotonic cleanup failures", () => {
    writeFileSync(hooksPath, "namespace\n");
    const seeded = mutateConnectorLeaf({
      displayPath: hooksPath, operationPath: hooksPath, parentOperationPath: dir,
      expected: captureConnectorLeaf(hooksPath, hooksPath),
      decide: () => ({ state: "regular" as const, content: Buffer.from("published\n"), mode: 0o600 }),
    });
    chmodSync(seeded.receipt.transactionOperationPath, 0o755);
    expect(() => mutateConnectorLeaf({
      displayPath: hooksPath, operationPath: hooksPath, parentOperationPath: dir,
      expected: seeded.receipt.current,
      decide: () => ({ state: "absent" as const }),
    }, seeded.receipt)).toThrow(/transaction namespace changed/iu);
    finalizeConnectorLeaf(seeded.receipt);

    const tx = join(dir, "tx");
    mkdirSync(tx);
    const currentPath = join(tx, "current");
    const initialPath = join(tx, "initial");
    writeFileSync(currentPath, "current\n");
    writeFileSync(initialPath, "initial\n");
    const current = captureConnectorLeaf(hooksPath, currentPath);
    const absent = { state: "absent" as const };
    expect(compensateConnectorLeaf({
      displayPath: hooksPath, operationPath: currentPath, parentOperationPath: dir,
      initial: current, current, transactionDisplayPath: tx, transactionOperationPath: tx,
      mutationCommitted: false, recoveryRequired: false,
    }).failures).toEqual([]);
    expect(compensateConnectorLeaf({
      displayPath: hooksPath, operationPath: currentPath, parentOperationPath: dir,
      initial: current, current, transactionDisplayPath: tx, transactionOperationPath: tx,
      mutationCommitted: true, recoveryRequired: false,
    }).failures[0]).toContain("rollback incomplete");
    const noInitialHold = {
      displayPath: hooksPath, operationPath: currentPath, parentOperationPath: dir,
      initial: current, current, transactionDisplayPath: tx, transactionOperationPath: tx,
      mutationCommitted: true, recoveryRequired: false,
    };
    const regularMismatchPath = join(tx, "regular-mismatch");
    const wrongInitialPath = join(tx, "wrong-initial");
    writeFileSync(regularMismatchPath, "current\n");
    writeFileSync(wrongInitialPath, "wrong\n");
    const regularMismatch = captureConnectorLeaf(hooksPath, regularMismatchPath);
    expect(compensateConnectorLeaf({
      displayPath: hooksPath, operationPath: regularMismatchPath, parentOperationPath: dir,
      initial: regularMismatch, current: regularMismatch, transactionDisplayPath: tx, transactionOperationPath: tx,
      evidence: [{ kind: "initial", operationPath: wrongInitialPath, displayPath: wrongInitialPath, status: "retained", certificate: regularMismatch.certificate }], mutationCommitted: true, recoveryRequired: false,
    }).failures[0]).toContain("rollback incomplete");
    const absentNoHoldPath = join(tx, "absent-no-hold");
    const absentNoHold = {
      displayPath: hooksPath, operationPath: absentNoHoldPath, parentOperationPath: dir,
      initial: current, current: absent, transactionDisplayPath: tx, transactionOperationPath: tx,
      mutationCommitted: true, recoveryRequired: false,
    };
    expect(compensateConnectorLeaf(absentNoHold).failures[0]).toContain("rollback incomplete");
    expect(compensateConnectorLeaf(noInitialHold).failures[0]).toContain("rollback incomplete");
    expect(compensateConnectorLeaf({
      ...noInitialHold, evidence: [{ kind: "initial", operationPath: initialPath, displayPath: initialPath, status: "retained", certificate: current.certificate }],
    }).failures[0]).toContain("rollback incomplete");
    expect(compensateConnectorLeaf({
      displayPath: hooksPath, operationPath: currentPath, parentOperationPath: dir,
      initial: current, current: absent, transactionDisplayPath: tx, transactionOperationPath: tx,
      mutationCommitted: true, recoveryRequired: false,
    }).failures[0]).toContain("rollback incomplete");
    const absentWithHold = {
      displayPath: hooksPath, operationPath: hooksPath, parentOperationPath: dir,
      initial: current, current: absent, transactionDisplayPath: tx, transactionOperationPath: tx,
      evidence: [{ kind: "initial", operationPath: initialPath, displayPath: initialPath, status: "retained", certificate: current.certificate }], mutationCommitted: true, recoveryRequired: false,
    };
    expect(compensateConnectorLeaf(absentWithHold).failures[0]).toContain("rollback incomplete");
    rmSync(hooksPath, { force: true });
    expect(compensateConnectorLeaf({ ...absentWithHold, operationPath: hooksPath }).failures[0]).toContain("rollback incomplete");
    const absentInitial = {
      displayPath: hooksPath, operationPath: hooksPath, parentOperationPath: dir,
      initial: absent, current: absent, transactionDisplayPath: tx, transactionOperationPath: tx,
      mutationCommitted: true, recoveryRequired: false,
    };
    writeFileSync(hooksPath, "unexpected\n");
    expect(compensateConnectorLeaf(absentInitial).failures[0]).toContain("rollback incomplete");
    rmSync(hooksPath);
    expect(compensateConnectorLeaf(absentInitial).failures).toEqual([]);

    const finalTx = join(dir, "final-tx");
    mkdirSync(finalTx);
    const holdDirectory = join(finalTx, "hold");
    mkdirSync(holdDirectory);
    writeFileSync(join(finalTx, "unknown"), "keep\n");
    const cleanup = finalizeConnectorLeaf({
      displayPath: hooksPath, operationPath: hooksPath, parentOperationPath: dir,
      initial: absent, current: absent, transactionDisplayPath: finalTx, transactionOperationPath: finalTx,
      evidence: [{ kind: "recovery", operationPath: holdDirectory, displayPath: holdDirectory, status: "retain-only" }], mutationCommitted: true, recoveryRequired: false,
    });
    expect(cleanup.failures.join(";")).toContain("cleanup incomplete");
  });

  it("finalizes legacy receipts by deriving missing retained states", () => {
    const tx = join(dir, "legacy-receipt-tx");
    mkdirSync(tx);
    const currentHold = join(tx, "current");
    const initialHold = join(tx, "initial");
    writeFileSync(currentHold, "current\n", { mode: 0o600 });
    writeFileSync(initialHold, "initial\n", { mode: 0o640 });
    const current = captureConnectorLeaf(hooksPath, currentHold);
    const initial = captureConnectorLeaf(hooksPath, initialHold);
    expect(finalizeConnectorLeaf({
      displayPath: hooksPath,
      operationPath: hooksPath,
      parentOperationPath: dir,
      initial,
      current,
      transactionDisplayPath: tx,
      transactionOperationPath: tx,
      mutationCommitted: true,
      recoveryRequired: false,
      evidence: [
        { kind: "initial", operationPath: initialHold, displayPath: initialHold, status: "retained", certificate: initial.certificate },
        { kind: "current-private", operationPath: currentHold, displayPath: currentHold, status: "retained", certificate: current.certificate },
      ],
    }).failures).toEqual([]);
    expect(existsSync(tx)).toBe(false);

    const malformedTx = join(dir, "malformed-receipt-tx");
    mkdirSync(malformedTx);
    const unexpectedInitial = join(malformedTx, "unexpected-initial");
    writeFileSync(unexpectedInitial, "preserve\n");
    expect(finalizeConnectorLeaf({
      displayPath: hooksPath,
      operationPath: hooksPath,
      parentOperationPath: dir,
      initial: { state: "absent" },
      current: { state: "absent" },
      transactionDisplayPath: malformedTx,
      transactionOperationPath: malformedTx,
      evidence: [{ kind: "recovery", operationPath: unexpectedInitial, displayPath: unexpectedInitial, status: "retain-only" }],
      mutationCommitted: true,
      recoveryRequired: false,
    }).failures.join(";")).toMatch(/cleanup incomplete.*recovery artifact/iu);
    expect(readFileSync(unexpectedInitial, "utf-8")).toBe("preserve\n");
  });

  it("fails closed for unsupported platforms and parent inspection faults", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { configurable: true, value: "darwin" });
    try {
      expect(() => removeCodexHooks(hooksPath)).toThrow(/requires Linux/iu);
    } finally {
      Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
    }
    const missingParent = join(dir, "missing", "hooks.json");
    expect(removeCodexHooks(missingParent)).toBe(false);
    const parentFile = join(dir, "parent-file");
    writeFileSync(parentFile, "not a directory");
    expect(() => removeCodexHooks(join(parentFile, "hooks.json"))).toThrow(/Unable to inspect connector hooks parent/iu);
  });

  it("covers primitive leaf failures and already-absent cleanup", async () => {
    const faults = {
      captureWithoutCode: false,
      stagePrimitive: false,
      removeParentWithoutCode: false,
      removeMutationPrimitive: false,
      rmdirAsAlreadyAbsent: false,
      unlinkAsAlreadyAbsent: false,
    };
    vi.resetModules();
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      return {
        ...actual,
        openSync: ((path: fs.PathLike, flags: fs.OpenMode, mode?: number) => {
          if (faults.captureWithoutCode && String(path) === hooksPath) {
            throw new Error("capture without errno");
          }
          if (faults.removeParentWithoutCode && String(path) === dir) {
            throw new Error("parent without errno");
          }
          if (faults.stagePrimitive && String(path).includes("candidate-")) {
            throw "primitive stage failure";
          }
          return mode === undefined ? actual.openSync(path, flags) : actual.openSync(path, flags, mode);
        }) as typeof actual.openSync,
        mkdirSync: ((path: fs.PathLike, options?: fs.MakeDirectoryOptions | number) => {
          if (faults.removeMutationPrimitive && String(path).includes(".lcm-connector-txn-")) {
            throw "primitive transaction failure";
          }
          return actual.mkdirSync(path, options as never);
        }) as typeof actual.mkdirSync,
        unlinkSync: ((path: fs.PathLike) => {
          if (faults.unlinkAsAlreadyAbsent) {
            faults.unlinkAsAlreadyAbsent = false;
            actual.unlinkSync(path);
            throw Object.assign(new Error("already absent"), { code: "ENOENT" });
          }
          return actual.unlinkSync(path);
        }) as typeof actual.unlinkSync,
        rmdirSync: ((path: fs.PathLike) => {
          if (faults.rmdirAsAlreadyAbsent) {
            faults.rmdirAsAlreadyAbsent = false;
            actual.rmdirSync(path);
            throw Object.assign(new Error("already absent"), { code: "ENOENT" });
          }
          return actual.rmdirSync(path);
        }) as typeof actual.rmdirSync,
      };
    });
    try {
      const module = await import("../../src/connectors/codex-hooks.js");
      writeFileSync(hooksPath, "base\n");
      faults.captureWithoutCode = true;
      expect(() => module.captureConnectorLeaf(hooksPath, hooksPath)).toThrow(/capture without errno|Unable to inspect/iu);
      faults.captureWithoutCode = false;

      faults.stagePrimitive = true;
      faults.rmdirAsAlreadyAbsent = true;
      expect(() => module.mutateConnectorLeaf({
        displayPath: hooksPath,
        operationPath: hooksPath,
        parentOperationPath: dir,
        expected: module.captureConnectorLeaf(hooksPath, hooksPath),
        decide: () => ({ state: "regular" as const, content: Buffer.from("next\n"), mode: 0o600 }),
      })).toThrow(/primitive stage failure/iu);
      faults.stagePrimitive = false;

      const absentPath = join(dir, "absent.json");
      const seeded = module.mutateConnectorLeaf({
        displayPath: absentPath,
        operationPath: absentPath,
        parentOperationPath: dir,
        expected: { state: "absent" as const },
        decide: () => ({ state: "regular" as const, content: Buffer.from("published\n"), mode: 0o600 }),
      });
      faults.unlinkAsAlreadyAbsent = true;
      faults.rmdirAsAlreadyAbsent = true;
      expect(module.finalizeConnectorLeaf(seeded.receipt).failures).toEqual([]);

      faults.removeParentWithoutCode = true;
      expect(() => module.removeCodexHooks(hooksPath)).toThrow(/Unable to inspect connector hooks parent/iu);
      faults.removeParentWithoutCode = false;

      writeFileSync(hooksPath, JSON.stringify({ hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: "lcm restore --client codex" }] }],
      } }));
      faults.removeMutationPrimitive = true;
      expect(() => module.removeCodexHooks(hooksPath)).toThrow(/primitive transaction failure/iu);
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });

  it("covers publication cleanup, absent receipt sequencing, and primitive rollback errors", async () => {
    const faults = {
      publicationIdentityCaptures: 0,
      remainingIdentityCaptures: 0,
      primitiveRollback: "" as "" | "string" | "object",
      failCandidateCleanup: false,
    };
    const descriptors = new Map<number, { path: string; fakeIdentity: boolean }>();
    vi.resetModules();
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      const display = (value: fs.PathLike): string => {
        const text = String(value);
        const match = /^\/proc\/self\/fd\/(\d+)(\/.*)$/u.exec(text);
        if (!match) return text;
        try { return join(actual.readlinkSync(`/proc/self/fd/${match[1]}`), match[2]); } catch { return text; }
      };
      return {
        ...actual,
        openSync: ((path: fs.PathLike, flags: fs.OpenMode, mode?: number) => {
          const fd = mode === undefined ? actual.openSync(path, flags) : actual.openSync(path, flags, mode);
          const shown = display(path);
          const fakeIdentity = faults.remainingIdentityCaptures > 0 && shown === hooksPath;
          if (fakeIdentity) faults.remainingIdentityCaptures -= 1;
          descriptors.set(fd, { path: shown, fakeIdentity });
          return fd;
        }) as typeof actual.openSync,
        fstatSync: ((fd: number, options?: fs.StatOptions) => {
          const stats = actual.fstatSync(fd, options as never);
          if (!descriptors.get(fd)?.fakeIdentity) return stats;
          return new Proxy(stats, {
            get: (target, property) => property === "ino" ? Number(target.ino) + 1 : Reflect.get(target, property, target),
          });
        }) as typeof actual.fstatSync,
        linkSync: ((existing: fs.PathLike, target: fs.PathLike) => {
          const result = actual.linkSync(existing, target);
          if (String(existing).includes("candidate-") && display(target) === hooksPath) {
            faults.remainingIdentityCaptures = faults.publicationIdentityCaptures;
          }
          return result;
        }) as typeof actual.linkSync,
        renameSync: ((oldPath: fs.PathLike, newPath: fs.PathLike) => {
          if (faults.primitiveRollback && String(newPath).includes("rollback-")) throw "primitive rollback failure";
          return actual.renameSync(oldPath, newPath);
        }) as typeof actual.renameSync,
        unlinkSync: ((path: fs.PathLike) => {
          if (faults.failCandidateCleanup && String(path).includes("candidate-")) {
            throw Object.assign(new Error("candidate cleanup denied"), { code: "EIO" });
          }
          return actual.unlinkSync(path);
        }) as typeof actual.unlinkSync,
        closeSync: ((fd: number) => { descriptors.delete(fd); return actual.closeSync(fd); }) as typeof actual.closeSync,
      };
    });
    try {
      const module = await import("../../src/connectors/codex-hooks.js");
      writeFileSync(hooksPath, "base\n");
      faults.publicationIdentityCaptures = 1;
      expect(() => module.mutateConnectorLeaf({
        displayPath: hooksPath,
        operationPath: hooksPath,
        parentOperationPath: dir,
        expected: module.captureConnectorLeaf(hooksPath, hooksPath),
        decide: () => ({ state: "regular" as const, content: Buffer.from("next\n"), mode: 0o600 }),
      })).toThrow(/publication verification failed/iu);
      expect(existsSync(hooksPath)).toBe(true);

      writeFileSync(hooksPath, "base\n");
      const persistentExpected = module.captureConnectorLeaf(hooksPath, hooksPath);
      faults.publicationIdentityCaptures = 2;
      expect(() => module.mutateConnectorLeaf({
        displayPath: hooksPath,
        operationPath: hooksPath,
        parentOperationPath: dir,
        expected: persistentExpected,
        decide: () => ({ state: "regular" as const, content: Buffer.from("next\n"), mode: 0o600 }),
      })).toThrow(/publication verification failed/iu);
      faults.publicationIdentityCaptures = 0;
      faults.remainingIdentityCaptures = 0;

      const absentPath = join(dir, "absent-sequence.json");
      const first = module.mutateConnectorLeaf({
        displayPath: absentPath,
        operationPath: absentPath,
        parentOperationPath: dir,
        expected: { state: "absent" as const },
        decide: () => ({ state: "regular" as const, content: Buffer.from("one\n"), mode: 0o600 }),
      });
      const second = module.mutateConnectorLeaf({
        displayPath: absentPath,
        operationPath: absentPath,
        parentOperationPath: dir,
        expected: first.receipt.current,
        decide: () => ({ state: "regular" as const, content: Buffer.from("two\n"), mode: 0o600 }),
      }, first.receipt);
      expect(second.receipt.initial).toEqual({ state: "absent" });
      expect(readFileSync(absentPath, "utf-8")).toBe("two\n");
      const compensated = module.compensateConnectorLeaf(second.receipt);
      expect(compensated.failures).toEqual([]);
      expect(existsSync(absentPath)).toBe(false);
      expect(module.finalizeConnectorLeaf(compensated.receipt).failures).toEqual([]);

      const redundantAbsentPath = join(dir, "redundant-absent.json");
      const redundantAbsent = module.mutateConnectorLeaf({
        displayPath: redundantAbsentPath,
        operationPath: redundantAbsentPath,
        parentOperationPath: dir,
        expected: { state: "absent" as const },
        decide: () => ({ state: "absent" as const }),
      });
      expect(redundantAbsent.changed).toBe(false);
      expect(redundantAbsent.receipt.current).toEqual({ state: "absent" });
      expect(redundantAbsent.receipt.mutationCommitted).toBe(false);
      expect(module.finalizeConnectorLeaf(redundantAbsent.receipt).failures).toEqual([]);

      const rollbackPath = join(dir, "rollback.json");
      writeFileSync(rollbackPath, "initial\n");
      const rollbackSeed = module.mutateConnectorLeaf({
        displayPath: rollbackPath,
        operationPath: rollbackPath,
        parentOperationPath: dir,
        expected: module.captureConnectorLeaf(rollbackPath, rollbackPath),
        decide: () => ({ state: "regular" as const, content: Buffer.from("current\n"), mode: 0o600 }),
      });
      faults.primitiveRollback = true;
      expect(module.compensateConnectorLeaf(rollbackSeed.receipt).failures).toEqual([
        expect.stringMatching(/primitive rollback failure/iu),
      ]);
      faults.primitiveRollback = false;

      writeFileSync(hooksPath, JSON.stringify({ custom: true, hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: "lcm restore --client codex" }] }],
      } }));
      faults.failCandidateCleanup = true;
      expect(() => module.removeCodexHooks(hooksPath)).toThrow(/cleanup incomplete/iu);
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });

  it("preserves a same-inode edit ordered between publication verification captures", async () => {
    let published = false;
    let publicCaptured = false;
    let edited = false;
    vi.resetModules();
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      return {
        ...actual,
        linkSync: ((existing: fs.PathLike, target: fs.PathLike) => {
          const result = actual.linkSync(existing, target);
          if (String(existing).includes("candidate-") && String(target) === hooksPath) published = true;
          return result;
        }) as typeof actual.linkSync,
        openSync: ((path: fs.PathLike, flags: fs.OpenMode, mode?: number) => {
          const shown = String(path);
          if (published && shown === hooksPath) publicCaptured = true;
          if (published && publicCaptured && !edited && shown.includes("candidate-")) {
            edited = true;
            actual.writeFileSync(hooksPath, "peer edit\n");
            actual.chmodSync(hooksPath, 0o640);
          }
          return mode === undefined ? actual.openSync(path, flags) : actual.openSync(path, flags, mode);
        }) as typeof actual.openSync,
      };
    });
    try {
      const module = await import("../../src/connectors/codex-hooks.js");
      writeFileSync(hooksPath, "base\n", { mode: 0o600 });
      expect(() => module.mutateConnectorLeaf({
        displayPath: hooksPath,
        operationPath: hooksPath,
        parentOperationPath: dir,
        expected: module.captureConnectorLeaf(hooksPath, hooksPath),
        decide: () => ({ state: "regular" as const, content: Buffer.from("candidate\n"), mode: 0o600 }),
      })).toThrow(/publication verification failed/iu);
      expect(edited).toBe(true);
      expect(readFileSync(hooksPath, "utf-8")).toBe("peer edit\n");
      expect(statSync(hooksPath).mode & 0o777).toBe(0o640);
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });

  it("republishes or retains every object moved by mutation and compensation claims", async () => {
    type Race = { path: string; phase: "mutation" | "compensation"; kind: "regular" | "symlink" | "directory"; occupied: boolean };
    let race: Race | undefined;
    let failRepublishedHoldUnlink = false;
    let sequence = 0;
    vi.resetModules();
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      return {
        ...actual,
        renameSync: ((oldPath: fs.PathLike, newPath: fs.PathLike) => {
          const oldText = String(oldPath);
          const newText = String(newPath);
          const phase = newText.includes("rollback-") ? "compensation" : "mutation";
          if (race && oldText === race.path && phase === race.phase) {
            const before = `${race.path}.before-race-${sequence++}`;
            actual.renameSync(oldPath, before);
            if (race.kind === "regular") actual.writeFileSync(oldPath, `${phase} replacement\n`);
            else if (race.kind === "symlink") {
              const target = `${race.path}.outside-${sequence++}`;
              actual.writeFileSync(target, "outside\n");
              actual.symlinkSync(target, oldPath);
            } else actual.mkdirSync(oldPath);
            const result = actual.renameSync(oldPath, newPath);
            if (race.occupied) actual.writeFileSync(oldPath, "public peer\n");
            return result;
          }
          return actual.renameSync(oldPath, newPath);
        }) as typeof actual.renameSync,
        unlinkSync: ((path: fs.PathLike) => {
          if (failRepublishedHoldUnlink && /\/(?:initial|rollback-[^/]+)$/u.test(String(path))) {
            failRepublishedHoldUnlink = false;
            throw Object.assign(new Error("republished hold unlink denied"), { code: "EIO" });
          }
          return actual.unlinkSync(path);
        }) as typeof actual.unlinkSync,
      };
    });
    try {
      const module = await import("../../src/connectors/codex-hooks.js");
      for (const phase of ["mutation", "compensation"] as const) {
        for (const kind of ["regular", "symlink", "directory"] as const) {
          for (const occupied of [false, true]) {
            const root = join(dir, `${phase}-${kind}-${occupied ? "occupied" : "open"}`);
            mkdirSync(root);
            const path = join(root, "leaf");
            writeFileSync(path, "base\n", { mode: 0o600 });
            if (phase === "mutation") {
              race = { path, phase, kind, occupied };
              let caught: unknown;
              try {
                module.mutateConnectorLeaf({
                  displayPath: path,
                  operationPath: path,
                  parentOperationPath: root,
                  expected: module.captureConnectorLeaf(path, path),
                  decide: () => ({ state: "regular" as const, content: Buffer.from("candidate\n"), mode: 0o600 }),
                });
              } catch (error) { caught = error; }
              expect(caught).toBeInstanceOf(Error);
              expect((caught as Error).message).toMatch(/claim validation failed.*recovery/iu);
            } else {
              const seeded = module.mutateConnectorLeaf({
                displayPath: path,
                operationPath: path,
                parentOperationPath: root,
                expected: module.captureConnectorLeaf(path, path),
                decide: () => ({ state: "regular" as const, content: Buffer.from("candidate\n"), mode: 0o600 }),
              });
              race = { path, phase, kind, occupied };
              const failures = module.compensateConnectorLeaf(seeded.receipt);
      expect(failures.failures.join(";")).toMatch(/rollback incomplete.*recovery/iu);
            }
            race = undefined;
            if (occupied) expect(readFileSync(path, "utf-8")).toBe("public peer\n");
            else if (kind === "regular") expect(readFileSync(path, "utf-8")).toBe(`${phase} replacement\n`);
            else if (kind === "symlink") expect(fs.lstatSync(path).isSymbolicLink()).toBe(true);
            else {
              expect(existsSync(path)).toBe(false);
              const transactions = readdirSync(root).filter((entry) => entry.startsWith(".lcm-connector-txn-"));
              expect(transactions).toHaveLength(1);
              expect(readdirSync(join(root, transactions[0])).some((entry) => /^(initial|rollback-)/u.test(entry))).toBe(true);
            }
          }
        }
      }

      const unlinkRoot = join(dir, "mutation-regular-republish-unlink");
      mkdirSync(unlinkRoot);
      const unlinkPath = join(unlinkRoot, "leaf");
      writeFileSync(unlinkPath, "base\n", { mode: 0o600 });
      race = { path: unlinkPath, phase: "mutation", kind: "regular", occupied: false };
      failRepublishedHoldUnlink = true;
      expect(() => module.mutateConnectorLeaf({
        displayPath: unlinkPath,
        operationPath: unlinkPath,
        parentOperationPath: unlinkRoot,
        expected: module.captureConnectorLeaf(unlinkPath, unlinkPath),
        decide: () => ({ state: "regular" as const, content: Buffer.from("candidate\n"), mode: 0o600 }),
      })).toThrow(/recovery artifact retained.*republished hold unlink denied/iu);
      race = undefined;
      expect(readFileSync(unlinkPath, "utf-8")).toBe("mutation replacement\n");
      expect(readdirSync(unlinkRoot).filter((entry) => entry.startsWith(".lcm-connector-txn-"))).toHaveLength(1);
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });

  it("republishes validated claims after precommit publication failures", async () => {
    let failCandidatePublication = false;
    let failInitialRestoration = false;
    vi.resetModules();
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      return {
        ...actual,
        linkSync: ((existing: fs.PathLike, target: fs.PathLike) => {
          if (failCandidatePublication && String(existing).includes("candidate-")) {
            failCandidatePublication = false;
            throw Object.assign(new Error("candidate publication denied"), { code: "EIO" });
          }
          if (failInitialRestoration && String(existing).includes("/restore-")) {
            failInitialRestoration = false;
            throw Object.assign(new Error("initial restoration denied"), { code: "EIO" });
          }
          return actual.linkSync(existing, target);
        }) as typeof actual.linkSync,
      };
    });
    try {
      const module = await import("../../src/connectors/codex-hooks.js");
      const mutationPath = join(dir, "mutation-publication-failure");
      writeFileSync(mutationPath, "initial\n", { mode: 0o600 });
      failCandidatePublication = true;
      expect(() => module.mutateConnectorLeaf({
        displayPath: mutationPath,
        operationPath: mutationPath,
        parentOperationPath: dir,
        expected: module.captureConnectorLeaf(mutationPath, mutationPath),
        decide: () => ({ state: "regular" as const, content: Buffer.from("candidate\n"), mode: 0o600 }),
      })).toThrow(/recovery republished.*without replacement/iu);
      expect(readFileSync(mutationPath, "utf-8")).toBe("initial\n");

      const compensationPath = join(dir, "compensation-publication-failure");
      writeFileSync(compensationPath, "initial\n", { mode: 0o600 });
      const seeded = module.mutateConnectorLeaf({
        displayPath: compensationPath,
        operationPath: compensationPath,
        parentOperationPath: dir,
        expected: module.captureConnectorLeaf(compensationPath, compensationPath),
        decide: () => ({ state: "regular" as const, content: Buffer.from("current\n"), mode: 0o600 }),
      });
      failInitialRestoration = true;
      expect(module.compensateConnectorLeaf(seeded.receipt).failures.join(";")).toMatch(/recovery republished.*without replacement/iu);
      expect(readFileSync(compensationPath, "utf-8")).toBe("current\n");
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });

  it("retains a superseded generation changed through a pre-opened descriptor", async () => {
    let driftOnSupersededClaim = false;
    let writer = -1;
    vi.resetModules();
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      return {
        ...actual,
        linkSync: ((existing: fs.PathLike, target: fs.PathLike) => {
          const result = actual.linkSync(existing, target);
          if (driftOnSupersededClaim && String(existing).includes("candidate-") && String(target) === hooksPath) {
            driftOnSupersededClaim = false;
            actual.writeSync(writer, Buffer.from("peeredit"), 0, 8, 0);
          }
          return result;
        }) as typeof actual.linkSync,
      };
    });
    try {
      const module = await import("../../src/connectors/codex-hooks.js");
      writeFileSync(hooksPath, "initial!", { mode: 0o600 });
      const first = module.mutateConnectorLeaf({
        displayPath: hooksPath,
        operationPath: hooksPath,
        parentOperationPath: dir,
        expected: module.captureConnectorLeaf(hooksPath, hooksPath),
        decide: () => ({ state: "regular" as const, content: Buffer.from("current!"), mode: 0o600 }),
      });
      writer = openSync(hooksPath, "r+");
      driftOnSupersededClaim = true;
      expect(() => module.mutateConnectorLeaf({
        displayPath: hooksPath,
        operationPath: hooksPath,
        parentOperationPath: dir,
        expected: first.receipt.current,
        decide: () => ({ state: "regular" as const, content: Buffer.from("newest!!"), mode: 0o600 }),
      }, first.receipt)).toThrow(/cleanup incomplete.*recovery/iu);
      closeSync(writer);
      writer = -1;
      expect(readdirSync(first.receipt.transactionOperationPath).length).toBeGreaterThan(2);
    } finally {
      if (writer >= 0) closeSync(writer);
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });

  it("retains a drifted superseded hold after a committed absence", async () => {
    let driftBeforePrivateCleanup = false;
    let writer = -1;
    vi.resetModules();
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      return {
        ...actual,
        openSync: ((path: fs.PathLike, flags: fs.OpenMode, mode?: number) => {
          if (driftBeforePrivateCleanup && String(path).includes("candidate-")) {
            driftBeforePrivateCleanup = false;
            actual.writeSync(writer, Buffer.from("peeredit"), 0, 8, 0);
          }
          return mode === undefined ? actual.openSync(path, flags) : actual.openSync(path, flags, mode);
        }) as typeof actual.openSync,
      };
    });
    try {
      const module = await import("../../src/connectors/codex-hooks.js");
      writeFileSync(hooksPath, "initial!", { mode: 0o600 });
      const first = module.mutateConnectorLeaf({
        displayPath: hooksPath,
        operationPath: hooksPath,
        parentOperationPath: dir,
        expected: module.captureConnectorLeaf(hooksPath, hooksPath),
        decide: () => ({ state: "regular" as const, content: Buffer.from("current!"), mode: 0o600 }),
      });
      writer = openSync(hooksPath, "r+");
      driftBeforePrivateCleanup = true;
      expect(() => module.mutateConnectorLeaf({
        displayPath: hooksPath,
        operationPath: hooksPath,
        parentOperationPath: dir,
        expected: first.receipt.current,
        decide: () => ({ state: "absent" as const }),
      }, first.receipt)).toThrow(/cleanup incomplete.*recovery/iu);
      closeSync(writer);
      writer = -1;
      expect(existsSync(hooksPath)).toBe(false);
      expect(first.receipt.current).toMatchObject({ state: "regular", sha256: expect.any(String) });
      expect(first.receipt.recoveryRequired).toBe(false);
    } finally {
      if (writer >= 0) closeSync(writer);
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });

  it("preserves current and initial generations across compensation races", async () => {
    let editAfterInitialPublish: (() => void) | undefined;
    vi.resetModules();
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      return {
        ...actual,
        linkSync: ((existing: fs.PathLike, target: fs.PathLike) => {
          const result = actual.linkSync(existing, target);
          editAfterInitialPublish?.();
          editAfterInitialPublish = undefined;
          return result;
        }) as typeof actual.linkSync,
      };
    });
    try {
      const module = await import("../../src/connectors/codex-hooks.js");

      const restorationPath = join(dir, "restoration-race");
      writeFileSync(restorationPath, "initial!", { mode: 0o600 });
      const restoration = module.mutateConnectorLeaf({
        displayPath: restorationPath,
        operationPath: restorationPath,
        parentOperationPath: dir,
        expected: module.captureConnectorLeaf(restorationPath, restorationPath),
        decide: () => ({ state: "regular" as const, content: Buffer.from("current!"), mode: 0o600 }),
      });
      const initialWriter = openSync(restoration.receipt.evidence.find((entry) => entry.kind === "initial")!.operationPath, "r+");
      editAfterInitialPublish = () => actualWrite(initialWriter, "peeredit");
      expect(module.compensateConnectorLeaf(restoration.receipt).failures).toEqual([]);
      closeSync(initialWriter);
      expect(readFileSync(restorationPath, "utf-8")).toBe("initial!");

      const cleanupPath = join(dir, "rollback-cleanup-race");
      writeFileSync(cleanupPath, "initial!", { mode: 0o600 });
      const cleanup = module.mutateConnectorLeaf({
        displayPath: cleanupPath,
        operationPath: cleanupPath,
        parentOperationPath: dir,
        expected: module.captureConnectorLeaf(cleanupPath, cleanupPath),
        decide: () => ({ state: "regular" as const, content: Buffer.from("current!"), mode: 0o600 }),
      });
      const currentWriter = openSync(cleanupPath, "r+");
      editAfterInitialPublish = () => actualWrite(currentWriter, "peeredit");
      expect(module.compensateConnectorLeaf(cleanup.receipt).failures.join(";")).toMatch(/cleanup incomplete/iu);
      closeSync(currentWriter);
      expect(readFileSync(cleanupPath, "utf-8")).toBe("initial!");

      const occupiedPath = join(dir, "absent-occupied-race");
      writeFileSync(occupiedPath, "initial!", { mode: 0o600 });
      const occupied = module.mutateConnectorLeaf({
        displayPath: occupiedPath,
        operationPath: occupiedPath,
        parentOperationPath: dir,
        expected: module.captureConnectorLeaf(occupiedPath, occupiedPath),
        decide: () => ({ state: "absent" as const }),
      });
      writeFileSync(occupiedPath, "peerstate");
      expect(module.compensateConnectorLeaf(occupied.receipt).failures.join(";")).toMatch(/current receipt changed/iu);
      expect(readFileSync(occupiedPath, "utf-8")).toBe("peerstate");

      const absentRestorePath = join(dir, "absent-restoration-race");
      writeFileSync(absentRestorePath, "initial!", { mode: 0o600 });
      const absentRestore = module.mutateConnectorLeaf({
        displayPath: absentRestorePath,
        operationPath: absentRestorePath,
        parentOperationPath: dir,
        expected: module.captureConnectorLeaf(absentRestorePath, absentRestorePath),
        decide: () => ({ state: "absent" as const }),
      });
      const absentInitialWriter = openSync(absentRestore.receipt.evidence.find((entry) => entry.kind === "initial")!.operationPath, "r+");
      editAfterInitialPublish = () => actualWrite(absentInitialWriter, "peeredit");
      expect(module.compensateConnectorLeaf(absentRestore.receipt).failures).toEqual([]);
      closeSync(absentInitialWriter);
      expect(readFileSync(absentRestorePath, "utf-8")).toBe("initial!");
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });

  it("covers immutable-certificate defensive seams and primitive diagnostics", async () => {
    const faults = {
      zeroWrite: false,
      mismatchCleanup: false,
      driftCandidate: false,
      candidateVerify: false,
      dropInitialAfterCapture: false,
      stageOpenError: "" as "" | "string" | "object",
      transactionError: "" as "" | "string" | "object",
      restorePublicMismatch: false,
      restoreCleanupFailure: false,
      aliasCleanupFailure: false,
      primitiveRollback: false,
      standaloneRead: "" as "" | "string" | "object",
      standalonePostLinkRead: false,
      inspectModeMismatch: false,
      inspectReadFailure: false,
      inspectStatFailure: false,
    };
    const descriptors = new Map<number, string>();
    let candidateVerifySeen = 0;
    let standalonePublished = false;
    vi.resetModules();
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      return {
        ...actual,
        openSync: ((path: fs.PathLike, flags: fs.OpenMode, mode?: number) => {
          const shown = String(path);
          if (shown.includes("candidate-") && faults.stageOpenError) {
            const kind = faults.stageOpenError;
            faults.stageOpenError = "";
            if (kind === "string") throw "primitive candidate open";
            throw { message: "object candidate open" };
          }
          const effectiveMode = mode;
          const fd = effectiveMode === undefined ? actual.openSync(path, flags) : actual.openSync(path, flags, effectiveMode);
          let resolved = shown;
          const match = /^\/proc\/self\/fd\/(\d+)(\/.*)$/u.exec(shown);
          if (match) {
            try { resolved = join(actual.readlinkSync(`/proc/self/fd/${match[1]}`), match[2]); } catch { /* retain proc path */ }
          }
          descriptors.set(fd, resolved);
          if (faults.dropInitialAfterCapture && shown.includes("/initial")) {
            faults.dropInitialAfterCapture = false;
            actual.unlinkSync(path);
          }
          return fd;
        }) as typeof actual.openSync,
        closeSync: ((fd: number) => {
          const path = descriptors.get(fd) ?? "";
          descriptors.delete(fd);
          const result = actual.closeSync(fd);
          if (faults.driftCandidate && path.includes("candidate-")) {
            faults.driftCandidate = false;
            actual.writeFileSync(path, "candidate drift\n");
          }
          return result;
        }) as typeof actual.closeSync,
        writeSync: ((fd: number, data: Uint8Array, offset: number, length: number, position: number | null) => {
          const path = descriptors.get(fd) ?? "";
          if (faults.zeroWrite && path.includes("candidate-")) return 0;
          if (faults.standaloneRead && path.endsWith("standalone-primitive.json")) {
            const kind = faults.standaloneRead;
            faults.standaloneRead = "";
            if (kind === "string") throw "primitive standalone write";
            throw { message: "object standalone write" };
          }
          return actual.writeSync(fd, data, offset, length, position);
        }) as typeof actual.writeSync,
        readSync: ((fd: number, buffer: Buffer, offset: number, length: number, position: number | null) => {
          const path = descriptors.get(fd) ?? "";
          if (faults.standaloneRead && path.endsWith("standalone-primitive.json")) {
            const kind = faults.standaloneRead;
            faults.standaloneRead = "";
            if (kind === "string") throw "primitive standalone read";
            throw { message: "object standalone read" };
          }
          if (faults.standalonePostLinkRead && standalonePublished && path.endsWith("standalone-committed.json")) {
            faults.standalonePostLinkRead = false;
            throw Object.assign(new Error("post-link observation failed"), { code: "EIO" });
          }
          if (faults.inspectReadFailure && path === hooksPath) {
            faults.inspectReadFailure = false;
            throw new Error("inspection read failed");
          }
          return actual.readSync(fd, buffer, offset, length, position);
        }) as typeof actual.readSync,
        fstatSync: ((fd: number, options?: fs.StatOptions) => {
          const path = descriptors.get(fd) ?? "";
          const stats = actual.fstatSync(fd, options as never);
          if (faults.candidateVerify && path.includes("candidate-")) {
            candidateVerifySeen += 1;
            if (candidateVerifySeen < 2) return stats;
            faults.candidateVerify = false;
            candidateVerifySeen = 0;
            return new Proxy(stats, { get: (target, prop) => prop === "isFile" ? (() => false) : Reflect.get(target, prop, target) });
          }
          if (faults.inspectModeMismatch && path === hooksPath) {
            faults.inspectModeMismatch = false;
            return new Proxy(stats, { get: (target, prop) => prop === "mode" ? Number(target.mode) ^ 0o1 : Reflect.get(target, prop, target) });
          }
          return stats;
        }) as typeof actual.fstatSync,
        lstatSync: ((path: fs.PathLike, options?: fs.StatOptions) => {
          if (faults.inspectStatFailure && String(path) === hooksPath) {
            faults.inspectStatFailure = false;
            throw Object.assign(new Error("inspection stat failed"), { code: "EIO" });
          }
          if (faults.mismatchCleanup && String(path).includes("candidate-")) {
            const stats = actual.lstatSync(path, options as never);
            faults.mismatchCleanup = false;
            return new Proxy(stats, { get: (target, prop) => prop === "ino" ? BigInt(target.ino) + 1n : Reflect.get(target, prop, target) });
          }
          return actual.lstatSync(path, options as never);
        }) as typeof actual.lstatSync,
        mkdirSync: ((path: fs.PathLike, options?: fs.MakeDirectoryOptions | number) => {
          if (String(path).includes(".lcm-connector-txn-") && faults.transactionError) {
            const kind = faults.transactionError;
            faults.transactionError = "";
            if (kind === "string") throw "primitive transaction failure";
            throw { message: "object transaction failure" };
          }
          return actual.mkdirSync(path, options as never);
        }) as typeof actual.mkdirSync,
        renameSync: ((oldPath: fs.PathLike, newPath: fs.PathLike) => {
          if (faults.primitiveRollback && String(newPath).includes("rollback-")) {
            const kind = faults.primitiveRollback;
            faults.primitiveRollback = "";
            if (kind === "string") throw "primitive rollback failure";
            throw { message: "object rollback failure" };
          }
          return actual.renameSync(oldPath, newPath);
        }) as typeof actual.renameSync,
        linkSync: ((existing: fs.PathLike, target: fs.PathLike) => {
          const result = actual.linkSync(existing, target);
          if (String(existing).includes("candidate-") && String(target).endsWith("standalone-committed.json")) standalonePublished = true;
          if (faults.restorePublicMismatch && String(existing).includes("restore-")) {
            faults.restorePublicMismatch = false;
            actual.writeFileSync(target, "peer restore\n");
          }
          if (faults.standalonePostLinkRead && String(existing).includes("candidate-")) {
            // The next public verification read fails, while compensation can
            // still authenticate and restore the committed receipt.
          }
          return result;
        }) as typeof actual.linkSync,
        unlinkSync: ((path: fs.PathLike) => {
          const shown = String(path);
          if (faults.restoreCleanupFailure && shown.includes("restore-")) {
            faults.restoreCleanupFailure = false;
            throw Object.assign(new Error("restore cleanup denied"), { code: "EIO" });
          }
          if (faults.aliasCleanupFailure && shown.includes("candidate-")) {
            faults.aliasCleanupFailure = false;
            throw Object.assign(new Error("alias cleanup denied"), { code: "EIO" });
          }
          return actual.unlinkSync(path);
        }) as typeof actual.unlinkSync,
      };
    });
    try {
      const module = await import("../../src/connectors/codex-hooks.js");
      const operation = (path: string, expected: import("../../src/connectors/codex-hooks.js").ConnectorLeafCertificate, decision: import("../../src/connectors/codex-hooks.js").ConnectorLeafDecision) => ({
        displayPath: path,
        operationPath: path,
        parentOperationPath: dir,
        expected,
        decide: () => decision,
      });

      writeFileSync(hooksPath, "base\n", { mode: 0o600 });
      const expected = module.captureConnectorLeaf(hooksPath, hooksPath).certificate;
      faults.zeroWrite = true;
      faults.mismatchCleanup = true;
      expect(() => module.mutateConnectorLeaf(operation(hooksPath, expected, { state: "regular", content: Buffer.from("candidate\n"), mode: 0o600 }))).toThrow(/no progress/iu);
      faults.zeroWrite = false;
      faults.driftCandidate = true;
      expect(() => module.mutateConnectorLeaf(operation(hooksPath, expected, { state: "regular", content: Buffer.from("candidate\n"), mode: 0o600 }))).toThrow(/changed before publication/iu);
      faults.transactionError = "string";
      expect(() => module.mutateConnectorLeaf(operation(hooksPath, expected, { state: "regular", content: Buffer.from("candidate\n"), mode: 0o600 }))).toThrow(/primitive transaction failure/iu);
      faults.transactionError = "object";
      expect(() => module.mutateConnectorLeaf(operation(hooksPath, expected, { state: "regular", content: Buffer.from("candidate\n"), mode: 0o600 }))).toThrow(/object transaction failure/iu);
      faults.stageOpenError = "string";
      expect(() => module.mutateConnectorLeaf(operation(hooksPath, expected, { state: "regular", content: Buffer.from("candidate\n"), mode: 0o600 }))).toThrow(/primitive candidate open/iu);
      faults.stageOpenError = "object";
      expect(() => module.mutateConnectorLeaf(operation(hooksPath, expected, { state: "regular", content: Buffer.from("candidate\n"), mode: 0o600 }))).toThrow(/connector mutation failed/iu);
      faults.candidateVerify = true;
      candidateVerifySeen = 0;
      expect(() => module.mutateConnectorLeaf(operation(hooksPath, expected, { state: "regular", content: Buffer.from("candidate\n"), mode: 0o600 }))).toThrow(/verification failed/iu);

      const seed = (name: string, absent: boolean) => {
        const path = join(dir, name);
        writeFileSync(path, "initial\n", { mode: 0o600 });
        const first = module.mutateConnectorLeaf(operation(path, module.captureConnectorLeaf(path, path).certificate, absent ? { state: "absent" } : { state: "regular", content: Buffer.from("current\n"), mode: 0o600 }));
        return first;
      };
      const noEvidenceSeed = seed("absence-no-evidence", false);
      const noEvidenceReceipt = {
        displayPath: noEvidenceSeed.receipt.displayPath,
        operationPath: noEvidenceSeed.receipt.operationPath,
        parentOperationPath: noEvidenceSeed.receipt.parentOperationPath,
        initial: noEvidenceSeed.receipt.initial,
        current: noEvidenceSeed.receipt.current,
        transactionDisplayPath: noEvidenceSeed.receipt.transactionDisplayPath,
        transactionOperationPath: noEvidenceSeed.receipt.transactionOperationPath,
        evidence: undefined,
        mutationCommitted: noEvidenceSeed.receipt.mutationCommitted,
        recoveryRequired: noEvidenceSeed.receipt.recoveryRequired,
      } as never;
      expect(module.mutateConnectorLeaf(
        operation(join(dir, "absence-no-evidence"), noEvidenceSeed.receipt.current, { state: "absent" }),
        noEvidenceReceipt,
      ).changed).toBe(true);
      const missingInitial = seed("missing-initial", false);
      faults.dropInitialAfterCapture = true;
      expect(module.compensateConnectorLeaf(missingInitial.receipt).failures.join(";")).toMatch(/rollback incomplete/iu);

      const publicMismatch = seed("restore-public-mismatch", false);
      faults.restorePublicMismatch = true;
      expect(module.compensateConnectorLeaf(publicMismatch.receipt).failures.join(";")).toMatch(/rollback incomplete/iu);

      const restoreCleanup = seed("restore-cleanup-failure", false);
      faults.restoreCleanupFailure = true;
      expect(module.compensateConnectorLeaf(restoreCleanup.receipt).failures.join(";")).toMatch(/rollback incomplete/iu);

      const aliasCleanup = seed("alias-cleanup-failure", false);
      faults.aliasCleanupFailure = true;
      expect(module.compensateConnectorLeaf(aliasCleanup.receipt).failures.join(";")).toMatch(/rollback incomplete/iu);

      const absentInitial = seed("absent-initial-hold", true);
      faults.dropInitialAfterCapture = true;
      expect(module.compensateConnectorLeaf(absentInitial.receipt).failures.join(";")).toMatch(/rollback incomplete/iu);

      const absentPublicMismatch = seed("absent-public-mismatch", true);
      faults.restorePublicMismatch = true;
      expect(module.compensateConnectorLeaf(absentPublicMismatch.receipt).failures.join(";")).toMatch(/rollback incomplete/iu);

      const absentRestoreCleanup = seed("absent-restore-cleanup", true);
      faults.restoreCleanupFailure = true;
      expect(module.compensateConnectorLeaf(absentRestoreCleanup.receipt).failures.join(";")).toMatch(/rollback incomplete/iu);

      const primitiveRollback = seed("primitive-rollback", false);
      faults.primitiveRollback = "string";
      expect(module.compensateConnectorLeaf(primitiveRollback.receipt).failures.join(";")).toMatch(/rollback incomplete/iu);
      const objectRollback = seed("object-rollback", false);
      faults.primitiveRollback = "object";
      expect(module.compensateConnectorLeaf(objectRollback.receipt).failures.join(";")).toMatch(/connector mutation failed|rollback incomplete/iu);

      const tx = join(dir, "finalize-evidence");
      mkdirSync(tx);
      const retained = join(tx, "retained");
      writeFileSync(retained, "retained\n");
      const noCertificate = {
        displayPath: hooksPath,
        operationPath: hooksPath,
        parentOperationPath: dir,
        initial: { state: "absent" as const },
        current: { state: "absent" as const },
        transactionDisplayPath: tx,
        transactionOperationPath: tx,
        evidence: [{ kind: "staging" as const, operationPath: retained, displayPath: retained, status: "retained" as const }],
        mutationCommitted: true,
        recoveryRequired: false,
      };
      expect(module.finalizeConnectorLeaf(noCertificate).failures).toHaveLength(1);
      unlinkSync(retained);
      expect(module.finalizeConnectorLeaf({ ...noCertificate, evidence: undefined } as never).failures).toEqual([]);

      const standalone = join(dir, "standalone-primitive.json");
      writeFileSync(standalone, JSON.stringify({ hooks: { PostToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "lcm post-tool --client codex" }] }] }, custom: true }));
      faults.standaloneRead = "string";
      expect(() => module.removeCodexHooks(standalone)).toThrow(/primitive standalone read/iu);
      writeFileSync(standalone, JSON.stringify({ hooks: { PostToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "lcm post-tool --client codex" }] }] }, custom: true }));
      faults.standaloneRead = "object";
      expect(() => module.removeCodexHooks(standalone)).toThrow(/connector hooks mutation failed/iu);

      const committed = join(dir, "standalone-committed.json");
      writeFileSync(committed, JSON.stringify({ hooks: { PostToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "lcm post-tool --client codex" }] }] }, custom: true }));
      faults.standalonePostLinkRead = true;
      expect(() => module.removeCodexHooks(committed)).toThrow(/standalone committed mutation compensated/iu);

      writeFileSync(hooksPath, JSON.stringify({ hooks: { PostToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "lcm post-tool --client codex" }] }] } }));
      faults.inspectModeMismatch = true;
      expect(module.hasCodexHooks(hooksPath)).toBe(false);
      faults.inspectReadFailure = true;
      expect(module.hasCodexHooks(hooksPath)).toBe(false);
      unlinkSync(hooksPath);
      faults.inspectStatFailure = true;
      expect(module.inspectCodexPostToolHook(hooksPath)).toMatchObject({ state: "incomplete" });
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });
});

function actualWrite(descriptor: number, content: string): void {
  const bytes = Buffer.from(content);
  writeSync(descriptor, bytes, 0, bytes.length, 0);
}
