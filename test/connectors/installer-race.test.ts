import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const mocks = vi.hoisted(() => ({
  settingsPath: "",
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
  };
});

import { removeConnector } from "../../src/connectors/installer.js";

describe("Claude connector removal races", () => {
  const originalHome = process.env.HOME;
  let tempHome = "";

  afterEach(() => {
    mocks.settingsPath = "";
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
});
