import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const seam = vi.hoisted(() => ({ afterMutation: undefined as undefined | ((displayPath: string) => void) }));

vi.mock("../../src/connectors/codex-hooks.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/connectors/codex-hooks.js")>();
  return {
    ...actual,
    mutateConnectorLeaf: ((operation, prior) => {
      const result = actual.mutateConnectorLeaf(operation, prior);
      seam.afterMutation?.(operation.displayPath);
      return result;
    }) as typeof actual.mutateConnectorLeaf,
  };
});

const { installConnector } = await import("../../src/connectors/installer.js");

const ORIGINAL_HOOKS = JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo mine" }] }] } }, null, 2) + "\n";
const OTHER_WRITER = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "echo other writer" }] }] } }, null, 2) + "\n";
const ORIGINAL_CONFIG = "model = 'x'\n";

describe("Codex hook install when a peer changes hooks.json after the snapshot", () => {
  let home: string;
  let originalHome: string | undefined;
  let hooksPath: string;
  let configPath: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "lcm-codex-diverge-"));
    originalHome = process.env.HOME;
    process.env.HOME = home;
    mkdirSync(join(home, ".codex"));
    hooksPath = join(home, ".codex", "hooks.json");
    configPath = join(home, ".codex", "config.toml");
    writeFileSync(hooksPath, ORIGINAL_HOOKS);
    writeFileSync(configPath, ORIGINAL_CONFIG);
  });
  afterEach(() => {
    seam.afterMutation = undefined;
    process.env.HOME = originalHome;
    rmSync(home, { recursive: true });
  });

  const routes: Array<[string, () => unknown]> = [
    ["direct hook surface", () => installConnector("codex", "hook", home)],
    ["legacy default", () => installConnector("codex", undefined as never, home)],
    ["transport bundle", () => installConnector("codex", "cli", home, { persistTransport: false, codexMcpRunner: { get: () => [] } })],
  ];

  it.each(routes)("keeps no config-only change and no overwritten peer edit on the %s route", (_name, install) => {
    seam.afterMutation = (path) => {
      if (path === configPath) writeFileSync(hooksPath, OTHER_WRITER);
    };
    expect(install).toThrow();
    expect(readFileSync(configPath, "utf-8")).toBe(ORIGINAL_CONFIG);
    expect(readFileSync(hooksPath, "utf-8")).toBe(OTHER_WRITER);
  });

  it("reports an incomplete rollback and keeps the peer's config edit", () => {
    seam.afterMutation = (path) => {
      if (path === configPath) {
        writeFileSync(hooksPath, OTHER_WRITER);
        writeFileSync(configPath, "model = 'peer'\n");
      }
    };
    expect(() => installConnector("codex", "hook", home)).toThrow(/rollback incomplete \(owned state: /);
    expect(readFileSync(configPath, "utf-8")).toBe("model = 'peer'\n");
    expect(readFileSync(hooksPath, "utf-8")).toBe(OTHER_WRITER);
  });

  it("applies the planned bytes when nothing diverges", () => {
    const result = installConnector("codex", "hook", home);
    expect(readFileSync(configPath, "utf-8")).toBe("model = 'x'\n\n[features]\nhooks = true\n");
    const installed = JSON.parse(readFileSync(hooksPath, "utf-8")).hooks;
    expect(installed.SessionStart[0].hooks[0].command).toBe("echo mine");
    expect(installed.SessionStart[1].hooks[0].command).toBe("lcm restore --client codex");
    expect(result.notices?.length).toBe(1);
  });
});
