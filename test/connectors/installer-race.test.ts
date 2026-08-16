import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
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
      if (args[0] === mocks.swapOpenPath) {
        mocks.swapOpenCount += 1;
        if (mocks.swapOpenCount === 1 && mocks.swapOpenReplacement) {
          const path = String(args[0]);
          renameSync(path, `${path}.original-before-remove-race`);
          renameSync(mocks.swapOpenReplacement, path);
          mocks.swapOpenOccurred = true;
        } else if (mocks.swapOpenCount === 2 && mocks.swapOpenTarget) {
          const path = String(args[0]);
          renameSync(path, `${path}.original-before-write-race`);
          actual.symlinkSync(mocks.swapOpenTarget, path);
          mocks.swapOpenOccurred = true;
        }
      }
      return descriptor;
    },
  };
});

import { installConnector, removeConnector } from "../../src/connectors/installer.js";

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
    expect(removeConnector("claude-code", "hook", tempHome)).toBe(true);

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
    expect(() => installConnector("claude-code", "skill", tempHome)).toThrow(/path changed|ownership verification/iu);

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
});
