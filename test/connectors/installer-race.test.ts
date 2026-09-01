import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
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

  it("refuses direct removal through a multiply linked retained skill descriptor", () => {
    tempHome = mkdtempSync(join(tmpdir(), "lcm-connector-hard-link-remove-"));
    const configPath = join(tempHome, "config.json");
    const installed = installConnector("claude-code", "skill", tempHome);
    const aliasPath = join(tempHome, "skill-alias.md");
    const installedBytes = readFileSync(installed.path);
    linkSync(installed.path, aliasPath);

    let caught: unknown;
    try { removeConnector("claude-code", "skill", tempHome); } catch (error) { caught = error; }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain(installed.path);
    expect((caught as Error).message).not.toContain("/proc/self/fd/");
    expect(readFileSync(installed.path)).toEqual(installedBytes);
    expect(readFileSync(aliasPath)).toEqual(installedBytes);

    setConnectorTransport(configPath, "claude-code", "cli");
    const result = removeConnector("claude-code", { cwd: tempHome, configPath });
    expect(result).toEqual(expect.objectContaining({
      success: false,
      failures: expect.arrayContaining([expect.stringMatching(/skill:/iu)]),
    }));
    expect(readConnectorTransport(configPath, "claude-code")).toBe("cli");
    expect(readFileSync(installed.path)).toEqual(installedBytes);
    expect(readFileSync(aliasPath)).toEqual(installedBytes);
  });

  it("restores connector and alias when a hard link appears at truncate", () => {
    tempHome = mkdtempSync(join(tmpdir(), "lcm-connector-hard-link-truncate-"));
    const installed = installConnector("claude-code", "skill", tempHome);
    const aliasPath = join(tempHome, "truncate-race-alias.md");
    const prior = readFileSync(installed.path);
    chmodSync(installed.path, 0o640);

    mocks.linkBeforeTruncatePath = installed.path;
    mocks.linkBeforeTruncateAlias = aliasPath;

    expect(() => removeConnector("claude-code", "skill", tempHome))
      .toThrow(/multiply linked/iu);

    expect(mocks.linkBeforeTruncateOccurred).toBe(true);
    expect(mocks.linkedTruncateCalls).toBeGreaterThanOrEqual(2);
    expect(readFileSync(installed.path)).toEqual(prior);
    expect(readFileSync(aliasPath)).toEqual(prior);
    expect(statSync(installed.path).mode & 0o777).toBe(0o640);
    expect(statSync(aliasPath).mode & 0o777).toBe(0o640);
  });

  it("preserves concurrent bytes written before receipt creation", () => {
    tempHome = mkdtempSync(join(tmpdir(), "lcm-connector-receipt-bytes-"));
    const configPath = join(tempHome, "config.json");
    const initial = installConnector("cursor", "mcp", tempHome, { configPath, persistTransport: false });
    const skillPath = initial.paths!.find((path) => path.endsWith("SKILL.md"))!;
    const concurrent = "concurrent user bytes\n";

    mocks.postWritePath = skillPath;
    mocks.postWriteAction = "bytes";
    mocks.postWriteBytes = concurrent;

    expect(() => installConnector("cursor", "cli", tempHome, { configPath, persistTransport: false }))
      .toThrow(/requested.*state|concurrent mutation/iu);

    expect(mocks.postWriteOccurred).toBe(true);
    expect(readFileSync(skillPath, "utf-8")).toBe(concurrent);
  });

  it("preserves concurrent mode drift before receipt creation", () => {
    tempHome = mkdtempSync(join(tmpdir(), "lcm-connector-receipt-mode-"));
    const configPath = join(tempHome, "config.json");
    const initial = installConnector("cursor", "mcp", tempHome, { configPath, persistTransport: false });
    const skillPath = initial.paths!.find((path) => path.endsWith("SKILL.md"))!;
    const prior = readFileSync(skillPath);
    chmodSync(skillPath, 0o640);

    mocks.postWritePath = skillPath;
    mocks.postWriteAction = "mode";
    mocks.postWriteMode = 0o600;

    expect(() => installConnector("cursor", "cli", tempHome, { configPath, persistTransport: false }))
      .toThrow(/requested.*state|concurrent mutation/iu);

    expect(mocks.postWriteOccurred).toBe(true);
    expect(readFileSync(skillPath)).not.toEqual(prior);
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

  it("reports emergency restoration failure after the primary hard-link failure", () => {
    tempHome = mkdtempSync(join(tmpdir(), "lcm-connector-emergency-restore-failure-"));
    const installed = installConnector("claude-code", "skill", tempHome);
    const aliasPath = join(tempHome, "failed-restore-alias.md");

    mocks.linkBeforeTruncatePath = installed.path;
    mocks.linkBeforeTruncateAlias = aliasPath;
    mocks.failEmergencyRestore = true;

    let caught: unknown;
    try { removeConnector("claude-code", "skill", tempHome); } catch (error) { caught = error; }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/multiply linked/iu);
    expect((caught as Error).message).toMatch(/emergency restoration failed.*injected emergency restoration failure/iu);
    expect(mocks.linkBeforeTruncateOccurred).toBe(true);
  });

  it("reports a strict skill replacement and retains the stored transport", () => {
    tempHome = mkdtempSync(join(tmpdir(), "lcm-connector-strict-skill-race-"));
    const configPath = join(tempHome, "config.json");
    const installed = installConnector("claude-code", "skill", tempHome);
    const replacement = join(tempHome, "strict-skill-replacement.md");
    writeFileSync(replacement, `${readFileSync(installed.path, "utf-8")}\nreplacement\n`);
    setConnectorTransport(configPath, "claude-code", "cli");

    mocks.swapOpenPath = installed.path;
    mocks.swapOpenReplacement = replacement;
    const result = removeConnector("claude-code", { cwd: tempHome, configPath });

    expect(result).toEqual(expect.objectContaining({
      success: false,
      failures: expect.arrayContaining([expect.stringMatching(/skill:.*path changed/iu)]),
    }));
    expect(readConnectorTransport(configPath, "claude-code")).toBe("cli");
    expect(readFileSync(installed.path, "utf-8")).toContain("replacement");
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

  it("neutralizes the authenticated skill inode when the public leaf is replaced at the destructive seam", () => {
    tempHome = mkdtempSync(join(tmpdir(), "lcm-connector-skill-truncate-race-"));
    const installed = installConnector("claude-code", "skill", tempHome);
    const replacement = join(tempHome, "replacement-skill.md");
    const original = join(tempHome, "authenticated-skill.md");
    writeFileSync(replacement, "user-owned replacement\n");

    mocks.swapTruncatePath = installed.path;
    mocks.swapTruncateReplacement = replacement;
    mocks.swapTruncateOriginal = original;
    expect(removeConnector("claude-code", "skill", tempHome)).toBe(false);

    expect(mocks.swapTruncateOccurred).toBe(true);
    expect(readFileSync(installed.path, "utf-8")).toBe("user-owned replacement\n");
    expect(readFileSync(original, "utf-8")).toBe("");
    expect(mocks.unlinkCalls).toBe(0);
  });

  it("neutralizes the authenticated whole-file rules inode when its public leaf is replaced", () => {
    tempHome = mkdtempSync(join(tmpdir(), "lcm-connector-rules-truncate-race-"));
    const installed = installConnector("cline", "rules", tempHome);
    const replacement = join(tempHome, "replacement-rules.md");
    const original = join(tempHome, "authenticated-rules.md");
    writeFileSync(replacement, "user-owned replacement\n");

    mocks.swapTruncatePath = installed.path;
    mocks.swapTruncateReplacement = replacement;
    mocks.swapTruncateOriginal = original;
    expect(removeConnector("cline", "rules", tempHome)).toBe(false);

    expect(readFileSync(installed.path, "utf-8")).toBe("user-owned replacement\n");
    expect(readFileSync(original, "utf-8")).toBe("");
    expect(mocks.unlinkCalls).toBe(0);
  });

  it("neutralizes authenticated LCM-only Codex hooks while preserving a public replacement", () => {
    tempHome = mkdtempSync(join(tmpdir(), "lcm-codex-hook-neutral-race-"));
    process.env.HOME = tempHome;
    const installed = installConnector("codex", "hook", tempHome);
    const replacement = join(tempHome, "replacement-hooks.json");
    const original = join(tempHome, "authenticated-hooks.json");
    writeFileSync(replacement, '{"sentinel":"preserve"}\n');

    mocks.swapTruncatePath = installed.path;
    mocks.swapTruncateReplacement = replacement;
    mocks.swapTruncateOriginal = original;
    expect(removeConnector("codex", "hook", tempHome)).toBe(false);

    expect(readFileSync(installed.path, "utf-8")).toBe('{"sentinel":"preserve"}\n');
    expect(readFileSync(original, "utf-8")).toBe("{}\n");
    expect(mocks.unlinkCalls).toBe(0);
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

    mocks.swapTruncatePath = hookPath;
    mocks.swapTruncateReplacement = replacement;
    mocks.swapTruncateOriginal = original;
    const result = removeConnector("codex", { cwd: tempHome, configPath, codexMcpRunner });

    expect(result).toEqual(expect.objectContaining({
      success: false,
      failures: expect.arrayContaining([expect.stringMatching(/hook:.*path changed/iu)]),
    }));
    expect(readConnectorTransport(configPath, "codex")).toBe("cli");
    expect(readFileSync(hookPath, "utf-8")).toBe('{"sentinel":"preserve"}\n');
    expect(readFileSync(original, "utf-8")).toBe("{}\n");
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

    mocks.swapTruncatePath = installed.path;
    mocks.swapTruncateReplacement = replacement;
    mocks.swapTruncateOriginal = original;
    expect(removeConnector("codex", "hook", tempHome)).toBe(false);

    expect(readFileSync(installed.path, "utf-8")).toBe('{"sentinel":"preserve"}\n');
    expect(JSON.parse(readFileSync(original, "utf-8"))).toEqual({ custom: { keep: true }, hooks: {} });
  });

  it("does not clear stored transport when bundle removal sees a post-mutation replacement", () => {
    tempHome = mkdtempSync(join(tmpdir(), "lcm-bundle-remove-race-"));
    const configPath = join(tempHome, "config.json");
    const installed = installConnector("cline", "cli", tempHome, { configPath });
    setConnectorTransport(configPath, "cline", "cli");
    const replacement = join(tempHome, "replacement-bundle-rules.md");
    const original = join(tempHome, "authenticated-bundle-rules.md");
    writeFileSync(replacement, "user-owned replacement\n");

    mocks.swapTruncatePath = installed.paths![0];
    mocks.swapTruncateReplacement = replacement;
    mocks.swapTruncateOriginal = original;
    const result = removeConnector("cline", tempHome, { configPath });

    expect(result).toMatchObject({ success: false });
    expect(readConnectorTransport(configPath, "cline")).toBe("cli");
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
    expect(readFileSync(original)).toEqual(prior);
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
    expect((caught as Error).message).toContain("rollback incomplete");
    expect((caught as Error).message).toContain(skillPath);
    expect((caught as Error).message).not.toContain("/proc/self/fd/");
    expect(staged).not.toEqual(prior);
    expect(readFileSync(skillPath)).toEqual(staged);
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
    expect(readFileSync(created, "utf-8")).toBe("");
    expect(mocks.unlinkCalls).toBe(0);
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
    expect(readFileSync(original)).toEqual(prior);
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
