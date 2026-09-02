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
    expect(second.receipt.initialHoldOperationPath).toBe(first.receipt.initialHoldOperationPath);
    const unchanged = mutateConnectorLeaf({
      displayPath: hooksPath, operationPath: hooksPath, parentOperationPath: dir,
      expected: second.receipt.current,
      decide: () => ({ state: "unchanged" as const }),
    }, second.receipt);
    expect(unchanged).toEqual({ changed: false, receipt: second.receipt });
    expect(compensateConnectorLeaf(second.receipt)).toEqual([]);
    expect(readFileSync(hooksPath, "utf-8")).toBe("one\n");
    expect(finalizeConnectorLeaf(second.receipt)).toEqual([]);
    expect(compensateConnectorLeaf({
      ...second.receipt, mutationCommitted: false,
    })).toEqual([]);
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
          return stats;
        }) as typeof actual.fstatSync,
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
      expect(() => module.mutateConnectorLeaf(op(module.captureConnectorLeaf(hooksPath, hooksPath)))).toThrow(/changed while being staged/iu);
      faults.candidate = "verify";
      expect(() => module.mutateConnectorLeaf(op(module.captureConnectorLeaf(hooksPath, hooksPath)))).toThrow(/verification failed/iu);
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
      expect(module.compensateConnectorLeaf(rollbackSeed.receipt)[0]).toContain("rollback incomplete");
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
    })).toEqual([]);
    expect(compensateConnectorLeaf({
      displayPath: hooksPath, operationPath: currentPath, parentOperationPath: dir,
      initial: current, current, transactionDisplayPath: tx, transactionOperationPath: tx,
      mutationCommitted: true, recoveryRequired: false,
    })[0]).toContain("rollback incomplete");
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
      initialHoldOperationPath: wrongInitialPath, mutationCommitted: true, recoveryRequired: false,
    })[0]).toContain("rollback incomplete");
    const absentNoHoldPath = join(tx, "absent-no-hold");
    const absentNoHold = {
      displayPath: hooksPath, operationPath: absentNoHoldPath, parentOperationPath: dir,
      initial: current, current: absent, transactionDisplayPath: tx, transactionOperationPath: tx,
      mutationCommitted: true, recoveryRequired: false,
    };
    expect(compensateConnectorLeaf(absentNoHold)[0]).toContain("rollback incomplete");
    expect(compensateConnectorLeaf(noInitialHold)[0]).toContain("rollback incomplete");
    expect(compensateConnectorLeaf({
      ...noInitialHold, initialHoldOperationPath: initialPath,
    })[0]).toContain("rollback incomplete");
    expect(compensateConnectorLeaf({
      displayPath: hooksPath, operationPath: currentPath, parentOperationPath: dir,
      initial: current, current: absent, transactionDisplayPath: tx, transactionOperationPath: tx,
      mutationCommitted: true, recoveryRequired: false,
    })[0]).toContain("rollback incomplete");
    const absentWithHold = {
      displayPath: hooksPath, operationPath: hooksPath, parentOperationPath: dir,
      initial: current, current: absent, transactionDisplayPath: tx, transactionOperationPath: tx,
      initialHoldOperationPath: initialPath, mutationCommitted: true, recoveryRequired: false,
    };
    expect(compensateConnectorLeaf(absentWithHold)[0]).toContain("rollback incomplete");
    rmSync(hooksPath, { force: true });
    expect(compensateConnectorLeaf({ ...absentWithHold, operationPath: hooksPath })[0]).toContain("rollback incomplete");
    const absentInitial = {
      displayPath: hooksPath, operationPath: hooksPath, parentOperationPath: dir,
      initial: absent, current: absent, transactionDisplayPath: tx, transactionOperationPath: tx,
      mutationCommitted: true, recoveryRequired: false,
    };
    writeFileSync(hooksPath, "unexpected\n");
    expect(compensateConnectorLeaf(absentInitial)[0]).toContain("rollback incomplete");
    rmSync(hooksPath);
    expect(compensateConnectorLeaf(absentInitial)).toEqual([]);

    const finalTx = join(dir, "final-tx");
    mkdirSync(finalTx);
    const holdDirectory = join(finalTx, "hold");
    mkdirSync(holdDirectory);
    writeFileSync(join(finalTx, "unknown"), "keep\n");
    const cleanup = finalizeConnectorLeaf({
      displayPath: hooksPath, operationPath: hooksPath, parentOperationPath: dir,
      initial: absent, current: absent, transactionDisplayPath: finalTx, transactionOperationPath: finalTx,
      currentHoldOperationPath: holdDirectory, mutationCommitted: true, recoveryRequired: false,
    });
    expect(cleanup.join(";")).toContain("cleanup failed");
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
      expect(module.finalizeConnectorLeaf(seeded.receipt)).toEqual([]);

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
      primitiveRollback: false,
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
      expect(existsSync(hooksPath)).toBe(false);

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
        decide: () => ({ state: "absent" as const }),
      }, first.receipt);
      expect(second.receipt.initial).toEqual({ state: "absent" });
      expect(module.compensateConnectorLeaf(second.receipt)).toEqual([]);
      expect(module.finalizeConnectorLeaf(second.receipt)).toEqual([]);

      const redundantAbsentPath = join(dir, "redundant-absent.json");
      const redundantAbsent = module.mutateConnectorLeaf({
        displayPath: redundantAbsentPath,
        operationPath: redundantAbsentPath,
        parentOperationPath: dir,
        expected: { state: "absent" as const },
        decide: () => ({ state: "absent" as const }),
      });
      expect(redundantAbsent.receipt.current).toEqual({ state: "absent" });
      expect(module.finalizeConnectorLeaf(redundantAbsent.receipt)).toEqual([]);

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
      expect(module.compensateConnectorLeaf(rollbackSeed.receipt)).toEqual([
        expect.stringMatching(/primitive rollback failure/iu),
      ]);
      faults.primitiveRollback = false;

      writeFileSync(hooksPath, JSON.stringify({ custom: true, hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: "lcm restore --client codex" }] }],
      } }));
      faults.failCandidateCleanup = true;
      expect(() => module.removeCodexHooks(hooksPath)).toThrow(/cleanup failed/iu);
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });
});
