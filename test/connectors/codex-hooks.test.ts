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

  it("writes valid neutral JSON for a file containing only LCM hooks", () => {
    mkdirSync(join(dir, "nested"), { recursive: true });
    installCodexHooks(hooksPath, configPath);
    expect(removeCodexHooks(hooksPath)).toBe(true);
    expect(readFileSync(hooksPath, "utf-8")).toBe("{}\n");
    expect(hasCodexHooks(hooksPath)).toBe(false);
    expect(removeCodexHooks(hooksPath)).toBe(false);
  });

  it("refuses to mutate a multiply linked hook file", () => {
    installCodexHooks(hooksPath, configPath);
    const aliasPath = join(dir, "hooks-alias.json");
    const installed = readFileSync(hooksPath);
    linkSync(hooksPath, aliasPath);

    let caught: unknown;
    try { removeCodexHooks(hooksPath); } catch (error) { caught = error; }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain(hooksPath);
    expect((caught as Error).message).not.toContain("/proc/self/fd/");
    expect(readFileSync(hooksPath)).toEqual(installed);
    expect(readFileSync(aliasPath)).toEqual(installed);
  });

  it("rechecks link count after reading and before standalone mutation", async () => {
    installCodexHooks(hooksPath, configPath);
    const aliasPath = join(dir, "late-hooks-alias.json");
    const installed = readFileSync(hooksPath);
    let aliasCreated = false;

    vi.resetModules();
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      const isHooksDescriptor = (descriptor: number): boolean => {
        try { return actual.readlinkSync(`/proc/self/fd/${descriptor}`) === hooksPath; } catch { return false; }
      };
      return {
        ...actual,
        readSync: ((descriptor: number, buffer: NodeJS.ArrayBufferView, offset: number, length: number, position: number | null) => {
          const count = actual.readSync(descriptor, buffer, offset, length, position);
          if (!aliasCreated
            && isHooksDescriptor(descriptor)
            && typeof position === "number"
            && position + count === installed.length) {
            actual.linkSync(hooksPath, aliasPath);
            aliasCreated = true;
          }
          return count;
        }) as typeof actual.readSync,
      };
    });
    try {
      const module = await import("../../src/connectors/codex-hooks.js");
      let caught: unknown;
      try { module.removeCodexHooks(hooksPath); } catch (error) { caught = error; }
      expect(aliasCreated).toBe(true);
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toContain(hooksPath);
      expect((caught as Error).message).not.toContain("/proc/self/fd/");
      expect(readFileSync(hooksPath)).toEqual(installed);
      expect(readFileSync(aliasPath)).toEqual(installed);
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });

  it.each([
    ["non-file descriptor", "non-file"],
    ["changed descriptor device", "device"],
    ["changed descriptor inode", "inode"],
  ] as const)("rejects a %s after reading and restores exact state", async (_label, fault) => {
    installCodexHooks(hooksPath, configPath);
    chmodSync(hooksPath, 0o640);
    const installed = readFileSync(hooksPath);
    let injectNextStat = false;
    let initialReadCompleted = false;

    vi.resetModules();
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      const isHooksDescriptor = (descriptor: number): boolean => {
        try { return actual.readlinkSync(`/proc/self/fd/${descriptor}`) === hooksPath; } catch { return false; }
      };
      return {
        ...actual,
        fstatSync: ((descriptor: number) => {
          const value = actual.fstatSync(descriptor);
          if (!isHooksDescriptor(descriptor) || !injectNextStat) return value;
          injectNextStat = false;
          return new Proxy(value, {
            get(target, property) {
              if (property === "isFile" && fault === "non-file") return () => false;
              if (property === "dev" && fault === "device") return Number(target.dev) + 1;
              if (property === "ino" && fault === "inode") return Number(target.ino) + 1;
              return Reflect.get(target, property, target);
            },
          });
        }) as typeof actual.fstatSync,
        readSync: ((descriptor: number, buffer: NodeJS.ArrayBufferView, offset: number, length: number, position: number | null) => {
          const count = actual.readSync(descriptor, buffer, offset, length, position);
          if (!initialReadCompleted
            && isHooksDescriptor(descriptor)
            && typeof position === "number"
            && position + count === installed.length) {
            initialReadCompleted = true;
            injectNextStat = true;
          }
          return count;
        }) as typeof actual.readSync,
      };
    });
    try {
      const module = await import("../../src/connectors/codex-hooks.js");
      let caught: unknown;
      try { module.removeCodexHooks(hooksPath); } catch (error) { caught = error; }
      expect(initialReadCompleted).toBe(true);
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toBe(`Codex hooks descriptor identity changed at ${hooksPath}`);
      expect((caught as Error).message).not.toContain("/proc/self/fd/");
      expect(readFileSync(hooksPath)).toEqual(installed);
      expect(statSync(hooksPath).mode & 0o777).toBe(0o640);
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });

  it("rejects hooks larger than 4 MiB before allocation or mutation", async () => {
    installCodexHooks(hooksPath, configPath);
    const installed = readFileSync(hooksPath);
    let truncateCalls = 0;

    vi.resetModules();
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      return {
        ...actual,
        fstatSync: ((descriptor: number) => {
          const value = actual.fstatSync(descriptor);
          return new Proxy(value, {
            get(target, property) {
              if (property === "size") return (4 * 1024 * 1024) + 1;
              return Reflect.get(target, property, target);
            },
          });
        }) as typeof actual.fstatSync,
        ftruncateSync: ((...args: Parameters<typeof actual.ftruncateSync>) => {
          truncateCalls += 1;
          return actual.ftruncateSync(...args);
        }) as typeof actual.ftruncateSync,
      };
    });
    const allocation = vi.spyOn(Buffer, "alloc");
    try {
      const module = await import("../../src/connectors/codex-hooks.js");
      expect(() => module.removeCodexHooks(hooksPath)).toThrow(hooksPath);
      expect(allocation).not.toHaveBeenCalled();
      expect(truncateCalls).toBe(0);
      expect(readFileSync(hooksPath)).toEqual(installed);
    } finally {
      allocation.mockRestore();
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });

  it("continues positive short writes until the complete hook document is written", async () => {
    installCodexHooks(hooksPath, configPath);
    let shortWrites = 0;

    vi.resetModules();
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      const isHooksDescriptor = (descriptor: number): boolean => {
        try { return actual.readlinkSync(`/proc/self/fd/${descriptor}`) === hooksPath; } catch { return false; }
      };
      return {
        ...actual,
        writeSync: ((descriptor: number, data: Uint8Array, offset: number, length: number, position: number | null) => {
          if (!isHooksDescriptor(descriptor)) return actual.writeSync(descriptor, data, offset, length, position);
          shortWrites += 1;
          const count = Math.min(length, 1);
          return actual.writeSync(descriptor, data, offset, count, position);
        }) as typeof actual.writeSync,
      };
    });
    try {
      const module = await import("../../src/connectors/codex-hooks.js");
      expect(module.removeCodexHooks(hooksPath)).toBe(true);
      expect(shortWrites).toBeGreaterThan(1);
      expect(readFileSync(hooksPath, "utf-8")).toBe("{}\n");
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });

  it.each([
    ["zero progress", false],
    ["partial progress followed by zero", true],
  ] as const)("restores exact bytes and mode after %s", async (_label, partialFirst) => {
    installCodexHooks(hooksPath, configPath);
    chmodSync(hooksPath, 0o640);
    const installed = readFileSync(hooksPath);
    let writeCalls = 0;

    vi.resetModules();
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      const isHooksDescriptor = (descriptor: number): boolean => {
        try { return actual.readlinkSync(`/proc/self/fd/${descriptor}`) === hooksPath; } catch { return false; }
      };
      return {
        ...actual,
        writeSync: ((descriptor: number, data: Uint8Array, offset: number, length: number, position: number | null) => {
          if (!isHooksDescriptor(descriptor)) return actual.writeSync(descriptor, data, offset, length, position);
          writeCalls += 1;
          if (partialFirst && writeCalls === 1) {
            return actual.writeSync(descriptor, data, offset, Math.min(length, 2), position);
          }
          if (writeCalls === (partialFirst ? 2 : 1)) return 0;
          return actual.writeSync(descriptor, data, offset, length, position);
        }) as typeof actual.writeSync,
      };
    });
    try {
      const module = await import("../../src/connectors/codex-hooks.js");
      expect(() => module.removeCodexHooks(hooksPath)).toThrow(/made no progress/iu);
      expect(readFileSync(hooksPath)).toEqual(installed);
      expect(statSync(hooksPath).mode & 0o777).toBe(0o640);
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });

  it.each([
    ["changed mode", "mode", "made no progress", false],
    ["changed size", "size", "injected primitive write failure", true],
  ] as const)("reports a %s during restoration verification", async (
    _label,
    fault,
    primaryContext,
    primitivePrimary,
  ) => {
    installCodexHooks(hooksPath, configPath);
    chmodSync(hooksPath, 0o640);
    const installed = readFileSync(hooksPath);
    let primaryFailed = false;
    let verifyRestorationMetadata = false;

    vi.resetModules();
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      const isHooksDescriptor = (descriptor: number): boolean => {
        try { return actual.readlinkSync(`/proc/self/fd/${descriptor}`) === hooksPath; } catch { return false; }
      };
      return {
        ...actual,
        fchmodSync: ((descriptor: number, mode: number) => {
          const result = actual.fchmodSync(descriptor, mode);
          if (isHooksDescriptor(descriptor)) verifyRestorationMetadata = true;
          return result;
        }) as typeof actual.fchmodSync,
        fstatSync: ((descriptor: number) => {
          const value = actual.fstatSync(descriptor);
          if (!isHooksDescriptor(descriptor) || !verifyRestorationMetadata) return value;
          verifyRestorationMetadata = false;
          return new Proxy(value, {
            get(target, property) {
              if (property === "mode" && fault === "mode") return Number(target.mode) ^ 0o001;
              if (property === "size" && fault === "size") return Number(target.size) + 1;
              return Reflect.get(target, property, target);
            },
          });
        }) as typeof actual.fstatSync,
        writeSync: ((descriptor: number, data: Uint8Array, offset: number, length: number, position: number | null) => {
          if (isHooksDescriptor(descriptor) && !primaryFailed) {
            primaryFailed = true;
            if (primitivePrimary) throw "injected primitive write failure";
            return 0;
          }
          return actual.writeSync(descriptor, data, offset, length, position);
        }) as typeof actual.writeSync,
      };
    });
    try {
      const module = await import("../../src/connectors/codex-hooks.js");
      let caught: unknown;
      try { module.removeCodexHooks(hooksPath); } catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toContain("Codex hooks restoration failed");
      expect((caught as Error).message).toContain(primaryContext);
      expect((caught as Error).message).toContain(hooksPath);
      expect((caught as Error).message).not.toContain("/proc/self/fd/");
      expect(readFileSync(hooksPath)).toEqual(installed);
      expect(statSync(hooksPath).mode & 0o777).toBe(0o640);
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });

  it.each([
    ["short restored read", "short-read"],
    ["mismatched restored bytes", "mismatched-bytes"],
  ] as const)("reports %s during restoration verification", async (_label, fault) => {
    installCodexHooks(hooksPath, configPath);
    chmodSync(hooksPath, 0o640);
    const installed = readFileSync(hooksPath);
    let primaryFailed = false;
    let restorationWritten = false;

    vi.resetModules();
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      const isHooksDescriptor = (descriptor: number): boolean => {
        try { return actual.readlinkSync(`/proc/self/fd/${descriptor}`) === hooksPath; } catch { return false; }
      };
      return {
        ...actual,
        readSync: ((descriptor: number, buffer: NodeJS.ArrayBufferView, offset: number, length: number, position: number | null) => {
          if (isHooksDescriptor(descriptor) && restorationWritten && fault === "short-read") return 0;
          const count = actual.readSync(descriptor, buffer, offset, length, position);
          if (isHooksDescriptor(descriptor) && restorationWritten && count > 0) {
            (buffer as Uint8Array)[offset] ^= 0xff;
          }
          return count;
        }) as typeof actual.readSync,
        writeSync: ((descriptor: number, data: Uint8Array, offset: number, length: number, position: number | null) => {
          if (!isHooksDescriptor(descriptor)) return actual.writeSync(descriptor, data, offset, length, position);
          if (!primaryFailed) {
            primaryFailed = true;
            return 0;
          }
          const count = actual.writeSync(descriptor, data, offset, length, position);
          if (count === length) restorationWritten = true;
          return count;
        }) as typeof actual.writeSync,
      };
    });
    try {
      const module = await import("../../src/connectors/codex-hooks.js");
      let caught: unknown;
      try { module.removeCodexHooks(hooksPath); } catch (error) { caught = error; }
      expect(restorationWritten).toBe(true);
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toContain("Codex hooks restoration failed");
      expect((caught as Error).message).toContain("made no progress");
      expect((caught as Error).message).toContain(hooksPath);
      expect((caught as Error).message).not.toContain("/proc/self/fd/");
      expect(readFileSync(hooksPath)).toEqual(installed);
      expect(statSync(hooksPath).mode & 0o777).toBe(0o640);
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });

  it("reports restoration failure with the primary write context", async () => {
    installCodexHooks(hooksPath, configPath);
    let targetTruncates = 0;
    let primaryFailed = false;

    vi.resetModules();
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      const isHooksDescriptor = (descriptor: number): boolean => {
        try { return actual.readlinkSync(`/proc/self/fd/${descriptor}`) === hooksPath; } catch { return false; }
      };
      return {
        ...actual,
        ftruncateSync: ((descriptor: number, length?: number) => {
          if (isHooksDescriptor(descriptor)) {
            targetTruncates += 1;
            if (targetTruncates === 2) throw new Error("injected restoration truncate failure");
          }
          return actual.ftruncateSync(descriptor, length);
        }) as typeof actual.ftruncateSync,
        writeSync: ((descriptor: number, data: Uint8Array, offset: number, length: number, position: number | null) => {
          if (isHooksDescriptor(descriptor) && !primaryFailed) {
            primaryFailed = true;
            return 0;
          }
          return actual.writeSync(descriptor, data, offset, length, position);
        }) as typeof actual.writeSync,
      };
    });
    try {
      const module = await import("../../src/connectors/codex-hooks.js");
      let caught: unknown;
      try { module.removeCodexHooks(hooksPath); } catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toMatch(/restor.*fail/iu);
      expect((caught as Error).message).toContain("made no progress");
      expect((caught as Error).message).toContain(hooksPath);
      expect((caught as Error).message).not.toContain("/proc/self/fd/");
      expect((caught as Error & { cause?: unknown }).cause).toBeUndefined();
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });

  it("keeps a public replacement byte-for-byte when removal begins on the authenticated descriptor", async () => {
    installCodexHooks(hooksPath, configPath);
    const replacement = join(dir, "replacement-hooks.json");
    const original = join(dir, "authenticated-hooks.json");
    writeFileSync(replacement, '{"sentinel":"preserve"}\n');
    let swapped = false;
    let unlinkCalls = 0;

    vi.resetModules();
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      return {
        ...actual,
        ftruncateSync: (descriptor: number, length?: number) => {
          if (!swapped && actual.readlinkSync(`/proc/self/fd/${descriptor}`) === hooksPath) {
            actual.renameSync(hooksPath, original);
            actual.renameSync(replacement, hooksPath);
            swapped = true;
          }
          return actual.ftruncateSync(descriptor, length);
        },
        unlinkSync: (...args: Parameters<typeof actual.unlinkSync>) => {
          unlinkCalls += 1;
          return actual.unlinkSync(...args);
        },
      };
    });
    try {
      const module = await import("../../src/connectors/codex-hooks.js");
      expect(module.removeCodexHooks(hooksPath)).toBe(false);
      expect(swapped).toBe(true);
      expect(readFileSync(hooksPath, "utf-8")).toBe('{"sentinel":"preserve"}\n');
      expect(readFileSync(original, "utf-8")).toBe("{}\n");
      expect(unlinkCalls).toBe(0);
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });

  it.each([
    ["non-file descriptor", "non-file", "unchanged"],
    ["negative descriptor size", "negative", "unchanged"],
    ["short descriptor read", "short-read", "unchanged"],
    ["changed descriptor identity", "changed-identity", "neutral"],
    ["unreadable public leaf", "unreadable-leaf", "neutral"],
  ] as const)("fails closed for a %s without unlinking by pathname", async (_label, fault, expected) => {
    installCodexHooks(hooksPath, configPath);
    const installed = readFileSync(hooksPath, "utf-8");
    let fstatCalls = 0;

    vi.resetModules();
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      return {
        ...actual,
        fstatSync: ((descriptor: number) => {
          fstatCalls += 1;
          const value = actual.fstatSync(descriptor);
          if (fstatCalls === 1 && fault === "non-file") {
            return new Proxy(value, {
              get(target, property) {
                if (property === "isFile") return () => false;
                return Reflect.get(target, property, target);
              },
            });
          }
          if (fstatCalls === 1 && fault === "negative") {
            return new Proxy(value, {
              get(target, property) {
                if (property === "size") return -1;
                return Reflect.get(target, property, target);
              },
            });
          }
          if (fstatCalls === 4 && fault === "changed-identity") {
            return new Proxy(value, {
              get(target, property) {
                if (property === "ino") return Number(target.ino) + 1;
                return Reflect.get(target, property, target);
              },
            });
          }
          return value;
        }) as typeof actual.fstatSync,
        readSync: ((...args: Parameters<typeof actual.readSync>) => (
          fault === "short-read" ? 0 : actual.readSync(...args)
        )) as typeof actual.readSync,
        lstatSync: ((path: Parameters<typeof actual.lstatSync>[0], options?: Parameters<typeof actual.lstatSync>[1]) => {
          if (fault === "unreadable-leaf" && String(path) === hooksPath) {
            throw Object.assign(new Error("leaf denied"), { code: "EACCES" });
          }
          return actual.lstatSync(path, options as never);
        }) as typeof actual.lstatSync,
      };
    });
    try {
      const module = await import("../../src/connectors/codex-hooks.js");
      expect(module.removeCodexHooks(hooksPath)).toBe(false);
      expect(readFileSync(hooksPath, "utf-8")).toBe(
        expected === "unchanged" ? installed : expected === "empty" ? "" : "{}\n",
      );
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
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
