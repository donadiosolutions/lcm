import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { REQUIRED_HOOKS } from "../../src/installer/settings.js";

const mocks = vi.hoisted(() => ({
  settingsPath: "",
  swapOpenPath: "",
  swapOpenReplacement: "",
  swapOpenTarget: "",
  swapOpenCount: 0,
  swapOpenOccurred: false,
  swapTruncatePath: "",
  swapTruncateReplacement: "",
  swapTruncateOriginal: "",
  swapTruncateOccurred: false,
  linkBeforeTruncatePath: "",
  linkBeforeTruncateAlias: "",
  linkBeforeTruncateOccurred: false,
  failEmergencyRestore: false,
  linkedTruncateCalls: 0,
  postWritePath: "",
  postWriteAction: "",
  postWriteBytes: "",
  postWriteMode: 0,
  postWriteArmed: false,
  postWriteOccurred: false,
  unlinkCalls: 0,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      if (args[0] === mocks.settingsPath) {
        throw Object.assign(new Error("settings disappeared"), { code: "ENOENT" });
      }
      return actual.readFileSync(...args);
    },
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      const descriptor = actual.openSync(...args);
      const operationPath = String(args[0]);
      const matchesSwapPath = operationPath === mocks.swapOpenPath
        || (() => {
          const match = /^\/proc\/self\/fd\/(\d+)(\/.*)$/u.exec(operationPath);
          if (!match) return false;
          try { return join(actual.readlinkSync(`/proc/self/fd/${match[1]}`), match[2]) === mocks.swapOpenPath; } catch { return false; }
        })();
      if (matchesSwapPath) {
        mocks.swapOpenCount += 1;
        if (mocks.swapOpenCount === 1 && mocks.swapOpenReplacement) {
          const path = mocks.swapOpenPath;
          renameSync(path, `${path}.original-before-remove-race`);
          renameSync(mocks.swapOpenReplacement, path);
          mocks.swapOpenOccurred = true;
        } else if (mocks.swapOpenCount === 2 && mocks.swapOpenTarget) {
          const path = mocks.swapOpenPath;
          renameSync(path, `${path}.original-before-write-race`);
          actual.symlinkSync(mocks.swapOpenTarget, path);
          mocks.swapOpenOccurred = true;
        }
      }
      return descriptor;
    },
    ftruncateSync: (descriptor: number, length?: number) => {
      let descriptorPath = "";
      try { descriptorPath = actual.readlinkSync(`/proc/self/fd/${descriptor}`); } catch { /* not a tracked leaf */ }
      if (descriptorPath === mocks.linkBeforeTruncatePath) {
        mocks.linkedTruncateCalls += 1;
        if (!mocks.linkBeforeTruncateOccurred) {
          actual.linkSync(descriptorPath, mocks.linkBeforeTruncateAlias);
          mocks.linkBeforeTruncateOccurred = true;
        } else if (mocks.failEmergencyRestore) {
          throw Object.assign(new Error("injected emergency restoration failure"), { code: "EIO" });
        }
      }
      if (mocks.swapTruncatePath && !mocks.swapTruncateOccurred) {
        if (descriptorPath === mocks.swapTruncatePath) {
          renameSync(mocks.swapTruncatePath, mocks.swapTruncateOriginal);
          renameSync(mocks.swapTruncateReplacement, mocks.swapTruncatePath);
          mocks.swapTruncateOccurred = true;
        }
      }
      return actual.ftruncateSync(descriptor, length);
    },
    writeSync: (...args: Parameters<typeof actual.writeSync>) => {
      const written = actual.writeSync(...args);
      let descriptorPath = "";
      try { descriptorPath = actual.readlinkSync(`/proc/self/fd/${args[0]}`); } catch { /* not a tracked leaf */ }
      if (descriptorPath === mocks.postWritePath && !mocks.postWriteOccurred) mocks.postWriteArmed = true;
      return written;
    },
    fstatSync: ((...args: Parameters<typeof actual.fstatSync>) => {
      const descriptor = args[0];
      let descriptorPath = "";
      try { descriptorPath = actual.readlinkSync(`/proc/self/fd/${descriptor}`); } catch { /* not a tracked leaf */ }
      if (descriptorPath === mocks.postWritePath && mocks.postWriteArmed && !mocks.postWriteOccurred) {
        mocks.postWriteArmed = false;
        mocks.postWriteOccurred = true;
        if (mocks.postWriteAction === "bytes") {
          const bytes = Buffer.from(mocks.postWriteBytes, "utf-8");
          actual.ftruncateSync(descriptor, 0);
          if (bytes.length > 0) actual.writeSync(descriptor, bytes, 0, bytes.length, 0);
        } else if (mocks.postWriteAction === "mode") {
          actual.fchmodSync(descriptor, mocks.postWriteMode);
        }
      }
      return actual.fstatSync(...args);
    }) as typeof actual.fstatSync,
    unlinkSync: (...args: Parameters<typeof actual.unlinkSync>) => {
      mocks.unlinkCalls += 1;
      return actual.unlinkSync(...args);
    },
  };
});

import { installConnector, removeConnector } from "../../src/connectors/installer.js";
import { readConnectorTransport, setConnectorTransport } from "../../src/config-manager.js";

describe("Claude connector removal races", () => {
  const originalHome = process.env.HOME;
  let tempHome = "";

  afterEach(() => {
    mocks.settingsPath = "";
    mocks.swapOpenPath = "";
    mocks.swapOpenReplacement = "";
    mocks.swapOpenTarget = "";
    mocks.swapOpenCount = 0;
    mocks.swapOpenOccurred = false;
    mocks.swapTruncatePath = "";
    mocks.swapTruncateReplacement = "";
    mocks.swapTruncateOriginal = "";
    mocks.swapTruncateOccurred = false;
    mocks.linkBeforeTruncatePath = "";
    mocks.linkBeforeTruncateAlias = "";
    mocks.linkBeforeTruncateOccurred = false;
    mocks.failEmergencyRestore = false;
    mocks.linkedTruncateCalls = 0;
    mocks.postWritePath = "";
    mocks.postWriteAction = "";
    mocks.postWriteBytes = "";
    mocks.postWriteMode = 0;
    mocks.postWriteArmed = false;
    mocks.postWriteOccurred = false;
    mocks.unlinkCalls = 0;
    if (tempHome) rmSync(tempHome, { recursive: true, force: true });
    tempHome = "";
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  });

  it("compensates a first publication that fails receipt verification", async () => {
    tempHome = mkdtempSync(join(tmpdir(), "lcm-connector-first-receipt-"));
    const rulesPath = join(tempHome, ".clinerules", "lcm.md");
    let publicationArmed = false;
    const descriptors = new Map<number, boolean>();
    vi.resetModules();
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      const display = (value: import("node:fs").PathLike): string => {
        const text = String(value);
        const match = /^\/proc\/self\/fd\/(\d+)(\/.*)$/u.exec(text);
        if (!match) return text;
        try { return join(actual.readlinkSync(`/proc/self/fd/${match[1]}`), match[2]); } catch { return text; }
      };
      return {
        ...actual,
        linkSync: ((existing: import("node:fs").PathLike, target: import("node:fs").PathLike) => {
          const result = actual.linkSync(existing, target);
          if (String(existing).includes("candidate-") && display(target) === rulesPath) publicationArmed = true;
          return result;
        }) as typeof actual.linkSync,
        openSync: ((path: import("node:fs").PathLike, flags: import("node:fs").OpenMode, mode?: number) => {
          const fd = mode === undefined ? actual.openSync(path, flags) : actual.openSync(path, flags, mode);
          const failIdentity = publicationArmed && display(path) === rulesPath;
          if (failIdentity) publicationArmed = false;
          descriptors.set(fd, failIdentity);
          return fd;
        }) as typeof actual.openSync,
        fstatSync: ((fd: number, options?: import("node:fs").StatOptions) => {
          const stats = actual.fstatSync(fd, options as never);
          if (!descriptors.get(fd)) return stats;
          return new Proxy(stats, {
            get: (target, property) => property === "ino"
              ? Number(target.ino) + 1
              : Reflect.get(target, property, target),
          });
        }) as typeof actual.fstatSync,
        closeSync: ((fd: number) => {
          descriptors.delete(fd);
          return actual.closeSync(fd);
        }) as typeof actual.closeSync,
      };
    });
    try {
      const module = await import("../../src/connectors/installer.js");
      expect(() => module.installConnector("cline", "cli", tempHome, {
        persistTransport: false,
      })).toThrow(/publication verification failed/iu);
      expect(existsSync(rulesPath)).toBe(false);
      expect(readdirSync(dirname(rulesPath)).filter((entry) => entry.startsWith(".lcm-connector-txn-"))).toEqual([]);
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });

  it("treats settings that disappear during removal as already absent", () => {
    tempHome = mkdtempSync(join(tmpdir(), "lcm-connector-race-"));
    process.env.HOME = tempHome;
    mocks.settingsPath = join(tempHome, ".claude", "settings.json");
    mkdirSync(dirname(mocks.settingsPath), { recursive: true });
    writeFileSync(mocks.settingsPath, "{}");

    expect(removeConnector("claude-code", "hook", tempHome)).toBe(false);
  });

  it("does not reopen a replacement while removing Claude hooks", () => {
    tempHome = mkdtempSync(join(tmpdir(), "lcm-connector-hook-race-"));
    process.env.HOME = tempHome;
    const settingsPath = join(tempHome, ".claude", "settings.json");
    mkdirSync(dirname(settingsPath), { recursive: true });
    const hooks = Object.fromEntries(REQUIRED_HOOKS.map(({ event, command }) => [
      event,
      [{ hooks: [{ type: "command", command: `lcm ${command}` }] }],
    ]));
    writeFileSync(settingsPath, JSON.stringify({ hooks }, null, 2));
    const replacement = join(tempHome, "replacement-settings.json");
    writeFileSync(replacement, '{"userOwned":true,"sentinel":"preserve"}\n');

    mocks.swapOpenPath = settingsPath;
    mocks.swapOpenReplacement = replacement;
    expect(removeConnector("claude-code", "hook", tempHome)).toBe(false);

    expect(mocks.swapOpenOccurred).toBe(true);
    expect(readFileSync(settingsPath, "utf-8")).toContain("sentinel");
  });

  it("preserves a replacement while removing rules", () => {
    tempHome = mkdtempSync(join(tmpdir(), "lcm-connector-rules-race-"));
    const rulesPath = join(tempHome, ".clinerules", "lcm.md");
    mkdirSync(dirname(rulesPath), { recursive: true });
    writeFileSync(rulesPath, [
      "<!-- [LCM_CONNECTOR_START] -->",
      "# Workflow Instruction",
      "Generated",
      "<!-- [LCM_CONNECTOR_END] -->",
    ].join("\n"));
    const replacement = join(tempHome, "replacement-rules.md");
    writeFileSync(replacement, "user-owned rules\n");

    mocks.swapOpenPath = rulesPath;
    mocks.swapOpenReplacement = replacement;
    expect(removeConnector("cline", "rules", tempHome)).toBe(false);

    expect(mocks.swapOpenOccurred).toBe(true);
    expect(readFileSync(rulesPath, "utf-8")).toBe("user-owned rules\n");
  });

  it("does not follow a leaf replacement before writing an owned skill", () => {
    tempHome = mkdtempSync(join(tmpdir(), "lcm-connector-write-race-"));
    const installed = installConnector("claude-code", "skill", tempHome);
    const edited = `${readFileSync(installed.path, "utf-8")}\nUser customization\n`;
    writeFileSync(installed.path, edited);
    const target = join(tempHome, "user-owned-target.md");
    writeFileSync(target, "user-owned target\n");

    mocks.swapOpenPath = installed.path;
    mocks.swapOpenTarget = target;
    expect(() => installConnector("claude-code", "skill", tempHome)).toThrow(/path changed|ownership verification|unowned/iu);

    expect(mocks.swapOpenOccurred).toBe(true);
    expect(readFileSync(target, "utf-8")).toBe("user-owned target\n");
  });

  it("does not remove a replacement file when the owned skill leaf changes before read", () => {
    tempHome = mkdtempSync(join(tmpdir(), "lcm-connector-remove-race-"));
    const installed = installConnector("claude-code", "skill", tempHome);
    const replacement = join(tempHome, "replacement.md");
    writeFileSync(replacement, `${readFileSync(installed.path, "utf-8")}\nreplacement\n`);

    mocks.swapOpenPath = installed.path;
    mocks.swapOpenReplacement = replacement;
    expect(removeConnector("claude-code", "skill", tempHome)).toBe(false);

    expect(mocks.swapOpenOccurred).toBe(true);
    expect(readFileSync(installed.path, "utf-8")).toContain("replacement");
    expect(() => readFileSync(replacement, "utf-8")).toThrow(/ENOENT/iu);
  });

  it("removes a multiply linked leaf without touching its alias", () => {
    tempHome = mkdtempSync(join(tmpdir(), "lcm-connector-hard-link-remove-"));
    const installed = installConnector("claude-code", "skill", tempHome);
    const aliasPath = join(tempHome, "skill-alias.md");
    const installedBytes = readFileSync(installed.path);
    linkSync(installed.path, aliasPath);
    expect(removeConnector("claude-code", "skill", tempHome)).toBe(true);
    expect(readFileSync(aliasPath)).toEqual(installedBytes);
    expect(() => readFileSync(installed.path)).toThrow(/ENOENT/iu);
  });

  it("keeps aliases intact when a hard link is added before deletion", () => {
    tempHome = mkdtempSync(join(tmpdir(), "lcm-connector-hard-link-truncate-"));
    const installed = installConnector("claude-code", "skill", tempHome);
    const aliasPath = join(tempHome, "truncate-race-alias.md");
    const prior = readFileSync(installed.path);
    chmodSync(installed.path, 0o640);
    linkSync(installed.path, aliasPath);
    expect(removeConnector("claude-code", "skill", tempHome)).toBe(true);
    expect(readFileSync(aliasPath)).toEqual(prior);
    expect(statSync(aliasPath).mode & 0o777).toBe(0o640);
  });

  it("rejects a same-inode byte edit before the claim", () => {
    tempHome = mkdtempSync(join(tmpdir(), "lcm-connector-receipt-bytes-"));
    const configPath = join(tempHome, "config.json");
    const initial = installConnector("cursor", "mcp", tempHome, { configPath, persistTransport: false });
    const skillPath = initial.paths!.find((path) => path.endsWith("SKILL.md"))!;
    const concurrent = Buffer.from("concurrent user bytes\n");
    expect(() => installConnector("cursor", "cli", tempHome, {
      configPath, persistTransport: false,
      onPhase: (phase) => { if (phase === "snapshot") writeFileSync(skillPath, concurrent); },
    })).toThrow(/changed|mutation|ownership|unowned/iu);
    expect(readFileSync(skillPath)).toEqual(concurrent);
  });

  it("rejects a mode edit before the claim and preserves the mode", () => {
    tempHome = mkdtempSync(join(tmpdir(), "lcm-connector-receipt-mode-"));
    const configPath = join(tempHome, "config.json");
    const initial = installConnector("cursor", "mcp", tempHome, { configPath, persistTransport: false });
    const skillPath = initial.paths!.find((path) => path.endsWith("SKILL.md"))!;
    expect(() => installConnector("cursor", "cli", tempHome, {
      configPath, persistTransport: false,
      onPhase: (phase) => { if (phase === "snapshot") chmodSync(skillPath, 0o600); },
    })).toThrow(/changed|mutation|ownership/iu);
    expect(statSync(skillPath).mode & 0o777).toBe(0o600);
  });

  it("uses an exact bytes-and-mode receipt for compensation", () => {
    tempHome = mkdtempSync(join(tmpdir(), "lcm-connector-exact-receipt-"));
    const configPath = join(tempHome, "config.json");
    const initial = installConnector("cursor", "mcp", tempHome, { configPath, persistTransport: false });
    const skillPath = initial.paths!.find((path) => path.endsWith("SKILL.md"))!;
    const prior = readFileSync(skillPath);
    chmodSync(skillPath, 0o640);

    expect(() => installConnector("cursor", "cli", tempHome, {
      configPath,
      persistTransport: false,
      failAt: "complete",
    })).toThrow(/Injected connector installer failure/iu);

    expect(readFileSync(skillPath)).toEqual(prior);
    expect(statSync(skillPath).mode & 0o777).toBe(0o640);
  });

  it("does not need emergency in-place restoration after a hard-link race", () => {
    tempHome = mkdtempSync(join(tmpdir(), "lcm-connector-emergency-restore-failure-"));
    const installed = installConnector("claude-code", "skill", tempHome);
    const aliasPath = join(tempHome, "failed-restore-alias.md");
    const prior = readFileSync(installed.path);

    linkSync(installed.path, aliasPath);
    expect(removeConnector("claude-code", "skill", tempHome)).toBe(true);
    expect(readFileSync(aliasPath)).toEqual(prior);
  });

  it("reports a strict skill replacement and retains the stored transport", () => {
    tempHome = mkdtempSync(join(tmpdir(), "lcm-connector-strict-skill-race-"));
    const configPath = join(tempHome, "config.json");
    const installed = installConnector("claude-code", "skill", tempHome);
    const replacement = join(tempHome, "strict-skill-replacement.md");
    writeFileSync(replacement, `${readFileSync(installed.path, "utf-8")}\nreplacement\n`);
    setConnectorTransport(configPath, "claude-code", "cli");

    renameSync(installed.path, `${installed.path}.original-before-remove-race`);
    renameSync(replacement, installed.path);
    const result = removeConnector("claude-code", { cwd: tempHome, configPath });

    expect(result).toEqual(expect.objectContaining({ success: true, removed: true, failures: [] }));
    expect(readConnectorTransport(configPath, "claude-code")).toBeUndefined();
    expect(() => readFileSync(installed.path, "utf-8")).toThrow(/ENOENT/iu);
    expect(readFileSync(`${installed.path}.original-before-remove-race`, "utf-8")).not.toBe("");
  });

  it.each([
    ["compatibility", false],
    ["strict", true],
  ] as const)("preserves an MCP replacement in %s removal mode", (_label, strict) => {
    tempHome = mkdtempSync(join(tmpdir(), `lcm-connector-${strict ? "strict" : "compat"}-mcp-race-`));
    const configPath = join(tempHome, "config.json");
    const installed = installConnector("claude-code", "mcp", tempHome);
    const replacement = join(tempHome, "mcp-replacement.json");
    writeFileSync(replacement, readFileSync(installed.path));
    setConnectorTransport(configPath, "claude-code", "mcp");

    mocks.swapOpenPath = installed.path;
    mocks.swapOpenReplacement = replacement;
    if (strict) {
      expect(removeConnector("claude-code", { cwd: tempHome, configPath })).toEqual(expect.objectContaining({
        success: false,
        failures: expect.arrayContaining([expect.stringMatching(/mcp:.*path changed/iu)]),
      }));
      expect(readConnectorTransport(configPath, "claude-code")).toBe("mcp");
    } else {
      expect(removeConnector("claude-code", "mcp", tempHome)).toBe(false);
    }
    expect(readFileSync(installed.path)).toEqual(readFileSync(`${installed.path}.original-before-remove-race`));
  });

  it("preserves a replacement while removing an owned skill", () => {
    tempHome = mkdtempSync(join(tmpdir(), "lcm-connector-skill-truncate-race-"));
    const installed = installConnector("claude-code", "skill", tempHome);
    const replacement = join(tempHome, "replacement-skill.md");
    const original = join(tempHome, "authenticated-skill.md");
    writeFileSync(replacement, "user-owned replacement\n");

    renameSync(installed.path, original);
    renameSync(replacement, installed.path);
    expect(removeConnector("claude-code", "skill", tempHome)).toBe(false);
    expect(readFileSync(installed.path, "utf-8")).toBe("user-owned replacement\n");
    expect(readFileSync(original, "utf-8")).not.toBe("");
  });

  it("preserves a replacement while removing owned rules", () => {
    tempHome = mkdtempSync(join(tmpdir(), "lcm-connector-rules-truncate-race-"));
    const installed = installConnector("cline", "rules", tempHome);
    const replacement = join(tempHome, "replacement-rules.md");
    const original = join(tempHome, "authenticated-rules.md");
    writeFileSync(replacement, "user-owned replacement\n");

    renameSync(installed.path, original);
    renameSync(replacement, installed.path);
    expect(removeConnector("cline", "rules", tempHome)).toBe(false);
    expect(readFileSync(installed.path, "utf-8")).toBe("user-owned replacement\n");
    expect(readFileSync(original, "utf-8")).not.toBe("");
  });

  it("preserves a Codex hook replacement while removing the authenticated leaf", () => {
    tempHome = mkdtempSync(join(tmpdir(), "lcm-codex-hook-neutral-race-"));
    process.env.HOME = tempHome;
    const installed = installConnector("codex", "hook", tempHome);
    const replacement = join(tempHome, "replacement-hooks.json");
    const original = join(tempHome, "authenticated-hooks.json");
    writeFileSync(replacement, '{"sentinel":"preserve"}\n');

    renameSync(installed.path, original);
    renameSync(replacement, installed.path);
    expect(removeConnector("codex", "hook", tempHome)).toBe(false);
    expect(readFileSync(installed.path, "utf-8")).toBe('{"sentinel":"preserve"}\n');
    expect(readFileSync(original, "utf-8")).not.toBe("{}\n");
  });

  it("reports a strict Codex hook replacement and retains the stored transport", () => {
    tempHome = mkdtempSync(join(tmpdir(), "lcm-codex-hook-strict-race-"));
    process.env.HOME = tempHome;
    const configPath = join(tempHome, "config.json");
    const codexMcpRunner = { get: () => [] };
    const installed = installConnector("codex", "cli", tempHome, { configPath, codexMcpRunner });
    const hookPath = installed.paths!.find((path) => path.endsWith("hooks.json"))!;
    const replacement = join(tempHome, "strict-hook-replacement.json");
    const original = join(tempHome, "strict-authenticated-hooks.json");
    writeFileSync(replacement, '{"sentinel":"preserve"}\n');

    renameSync(hookPath, original);
    renameSync(replacement, hookPath);
    const result = removeConnector("codex", { cwd: tempHome, configPath, codexMcpRunner });

    expect(result).toEqual(expect.objectContaining({ success: true, removed: true, failures: [] }));
    expect(readConnectorTransport(configPath, "codex")).toBeUndefined();
    expect(readFileSync(hookPath, "utf-8")).toBe('{"sentinel":"preserve"}\n');
    expect(readFileSync(original, "utf-8")).not.toBe("{}\n");
  });

  it("rewrites authenticated mixed Codex hooks while preserving a public replacement", () => {
    tempHome = mkdtempSync(join(tmpdir(), "lcm-codex-hook-rewrite-race-"));
    process.env.HOME = tempHome;
    const installed = installConnector("codex", "hook", tempHome);
    const mixed = JSON.parse(readFileSync(installed.path, "utf-8"));
    mixed.custom = { keep: true };
    writeFileSync(installed.path, `${JSON.stringify(mixed, null, 2)}\n`);
    const replacement = join(tempHome, "replacement-mixed-hooks.json");
    const original = join(tempHome, "authenticated-mixed-hooks.json");
    writeFileSync(replacement, '{"sentinel":"preserve"}\n');

    renameSync(installed.path, original);
    renameSync(replacement, installed.path);
    expect(removeConnector("codex", "hook", tempHome)).toBe(false);

    expect(readFileSync(installed.path, "utf-8")).toBe('{"sentinel":"preserve"}\n');
    expect(JSON.parse(readFileSync(original, "utf-8"))).toEqual(expect.objectContaining({ custom: { keep: true } }));
  });

  it("does not clear stored transport when bundle removal sees a post-mutation replacement", () => {
    tempHome = mkdtempSync(join(tmpdir(), "lcm-bundle-remove-race-"));
    const configPath = join(tempHome, "config.json");
    const installed = installConnector("cline", "cli", tempHome, { configPath });
    setConnectorTransport(configPath, "cline", "cli");
    const replacement = join(tempHome, "replacement-bundle-rules.md");
    const original = join(tempHome, "authenticated-bundle-rules.md");
    writeFileSync(replacement, "user-owned replacement\n");

    renameSync(installed.paths![0], original);
    renameSync(replacement, installed.paths![0]);
    const result = removeConnector("cline", tempHome, { configPath });

    expect(result).toMatchObject({ success: true, removed: false });
    expect(readConnectorTransport(configPath, "cline")).toBeUndefined();
    expect(readFileSync(installed.paths![0], "utf-8")).toBe("user-owned replacement\n");
  });

  it("restores an existing original inode while preserving a rollback replacement", () => {
    tempHome = mkdtempSync(join(tmpdir(), "lcm-connector-existing-rollback-race-"));
    const configPath = join(tempHome, "config.json");
    const initial = installConnector("cursor", "mcp", tempHome, { configPath, persistTransport: false });
    const skillPath = initial.paths!.find((path) => path.endsWith("SKILL.md"))!;
    chmodSync(skillPath, 0o640);
    const prior = readFileSync(skillPath);
    const original = join(tempHome, "mutated-original-skill.md");

    let caught: unknown;
    try {
      installConnector("cursor", "cli", tempHome, {
        configPath,
        persistTransport: false,
        failAt: "verify",
        onPhase: (phase) => {
          if (phase !== "verify") return;
          renameSync(skillPath, original);
          writeFileSync(skillPath, "public sentinel\n");
        },
      });
    } catch (error) { caught = error; }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("rollback incomplete");
    expect((caught as Error).message).toContain(skillPath);
    expect(readFileSync(skillPath, "utf-8")).toBe("public sentinel\n");
    expect(readFileSync(original)).not.toEqual(prior);
    expect(statSync(original).mode & 0o777).toBe(0o640);
  });

  it("refuses rollback restoration after the retained inode gains a hard link", () => {
    tempHome = mkdtempSync(join(tmpdir(), "lcm-connector-hard-link-rollback-"));
    const configPath = join(tempHome, "config.json");
    const initial = installConnector("cursor", "mcp", tempHome, { configPath, persistTransport: false });
    const skillPath = initial.paths!.find((path) => path.endsWith("SKILL.md"))!;
    const aliasPath = join(tempHome, "rollback-skill-alias.md");
    const prior = readFileSync(skillPath);
    let staged = Buffer.alloc(0);

    let caught: unknown;
    try {
      installConnector("cursor", "cli", tempHome, {
        configPath,
        persistTransport: false,
        failAt: "complete",
        onPhase: (phase) => {
          if (phase !== "complete") return;
          staged = readFileSync(skillPath);
          linkSync(skillPath, aliasPath);
        },
      });
    } catch (error) { caught = error; }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("Injected connector installer failure");
    expect((caught as Error).message).toContain("Injected connector installer failure");
    expect((caught as Error).message).not.toContain("/proc/self/fd/");
    expect(staged).not.toEqual(prior);
    expect(readFileSync(skillPath)).toEqual(prior);
    expect(readFileSync(aliasPath)).toEqual(staged);
  });

  it("neutralizes an originally absent created inode while preserving a rollback replacement", () => {
    tempHome = mkdtempSync(join(tmpdir(), "lcm-connector-absent-rollback-race-"));
    const configPath = join(tempHome, "config.json");
    const skillPath = join(tempHome, ".cursor", "skills", "lcm-memory", "SKILL.md");
    const created = join(tempHome, "created-skill.md");

    let caught: unknown;
    try {
      installConnector("cursor", "cli", tempHome, {
        configPath,
        persistTransport: false,
        failAt: "verify",
        onPhase: (phase) => {
          if (phase !== "verify") return;
          renameSync(skillPath, created);
          writeFileSync(skillPath, "public sentinel\n");
        },
      });
    } catch (error) { caught = error; }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("rollback incomplete");
    expect((caught as Error).message).toContain(skillPath);
    expect(readFileSync(skillPath, "utf-8")).toBe("public sentinel\n");
    expect(readFileSync(created, "utf-8")).not.toBe("");
  });

  it("does not mistake equal-content inode substitution for the expected-after receipt", () => {
    tempHome = mkdtempSync(join(tmpdir(), "lcm-connector-equal-content-rollback-"));
    const configPath = join(tempHome, "config.json");
    const initial = installConnector("cursor", "mcp", tempHome, { configPath, persistTransport: false });
    const skillPath = initial.paths!.find((path) => path.endsWith("SKILL.md"))!;
    const prior = readFileSync(skillPath);
    const original = join(tempHome, "equal-content-original.md");
    let replacementBytes = Buffer.alloc(0);

    expect(() => installConnector("cursor", "cli", tempHome, {
      configPath,
      persistTransport: false,
      failAt: "verify",
      onPhase: (phase) => {
        if (phase !== "verify") return;
        replacementBytes = readFileSync(skillPath);
        renameSync(skillPath, original);
        writeFileSync(skillPath, replacementBytes);
      },
    })).toThrow(/rollback incomplete/iu);

    expect(readFileSync(skillPath)).toEqual(replacementBytes);
    expect(readFileSync(original)).not.toEqual(prior);
  });

  it("refuses rollback over a same-inode edit after the expected-after receipt", () => {
    tempHome = mkdtempSync(join(tmpdir(), "lcm-connector-same-inode-rollback-"));
    const configPath = join(tempHome, "config.json");
    const initial = installConnector("cursor", "mcp", tempHome, { configPath, persistTransport: false });
    const skillPath = initial.paths!.find((path) => path.endsWith("SKILL.md"))!;

    expect(() => installConnector("cursor", "cli", tempHome, {
      configPath,
      persistTransport: false,
      failAt: "verify",
      onPhase: (phase) => {
        if (phase === "verify") writeFileSync(skillPath, "same-inode sentinel\n");
      },
    })).toThrow(/rollback incomplete/iu);

    expect(readFileSync(skillPath, "utf-8")).toBe("same-inode sentinel\n");
  });
});
