import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  backend: "unsupported",
}));

vi.mock("../../src/daemon/config.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../../src/daemon/config.js")>();
  return {
    ...actual,
    parseDaemonConfig: vi.fn(() => ({
      daemon: { port: 3737 },
      storage: { backend: state.backend },
      llm: { provider: "disabled", apiMode: "responses" },
    } as never)),
  };
});

import { runDoctor } from "../../src/doctor/doctor.js";
import { doctorConfigSeams } from "./config-seams.js";

describe("doctor publication admission defensive coverage", () => {
  let home: string | undefined;

  afterEach(() => {
    if (home !== undefined) rmSync(home, { recursive: true, force: true });
    home = undefined;
    state.backend = "unsupported";
  });

  it("skips admission when config exposes an unsupported backend value", async () => {
    home = mkdtempSync(join(tmpdir(), "lcm-doctor-publication-coverage-"));
    const results = await runDoctor({
      existsSync: () => true,
      readFileSync: (path: string) => {
        if (path.endsWith("settings.json")) return JSON.stringify({ mcpServers: { lcm: {} } });
        if (path.endsWith("CLAUDE.md")) return "<!-- lcm:start -->\n<!-- Claude Code include: @lcm.md -->\n<!-- lcm:end -->\n";
        if (path.endsWith("lcm.md")) return "";
        return "{}";
      },
      writeFileSync: vi.fn(),
      mkdirSync: vi.fn(),
      spawnSync: vi.fn(() => ({ status: 0, stdout: "", stderr: "" })),
      fetch: vi.fn().mockResolvedValue({ ok: false }),
      homedir: home,
      cwd: home,
      platform: "darwin",
      ...doctorConfigSeams("{}"),
    });

    expect(results.find((result) => result.name === "backend-publication")).toBeUndefined();
  });
});
