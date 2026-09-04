import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

const mergeClaudeSettingsMock = vi.hoisted(() => vi.fn(() => ({})));

vi.mock("../installer/install.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../installer/install.js")>()),
  mergeClaudeSettings: mergeClaudeSettingsMock,
}));
vi.mock("../src/daemon/lifecycle.js", () => ({
  ensureDaemon: vi.fn().mockResolvedValue({ connected: false }),
}));
vi.mock("../src/db/events-stats.js", () => ({
  collectEventStats: () => ({ captured: 0, unprocessed: 0, errors: 0, lastCapture: null }),
  collectDetailedEventStats: () => ({ captured: 0, unprocessed: 0, errors: 0, lastCapture: null, projects: [], recentErrors: [] }),
}));

import { runDoctor } from "../src/doctor/doctor.js";
import { doctorConfigSeams } from "./doctor/config-seams.js";
import { LCM_MD_CONTENT } from "../src/daemon/orientation.js";
import type { DoctorDeps } from "../src/doctor/types.js";

function isolatedPath(name: string): string {
  const runtimeHome = process.env.HOME;
  if (!runtimeHome) throw new Error("Vitest runtime HOME is not configured");
  const fixtureRoot = join(runtimeHome, "lcm-doctor-normalization-fixtures");
  mkdirSync(fixtureRoot, { recursive: true, mode: 0o700 });
  return join(fixtureRoot, name);
}

const NORMALIZATION_HOME = isolatedPath("coverage-services-doctor-normalization-home");
const NORMALIZATION_CWD = isolatedPath("coverage-services-doctor-normalization-project");
const NORMALIZATION_FIXTURE_ROOT = dirname(NORMALIZATION_HOME);

beforeEach(() => {
  rmSync(NORMALIZATION_HOME, { recursive: true, force: true });
  mkdirSync(NORMALIZATION_HOME, { recursive: true, mode: 0o700 });
  mkdirSync(join(NORMALIZATION_HOME, ".lcm"), { recursive: true, mode: 0o700 });
});

afterEach(() => {
  rmSync(NORMALIZATION_HOME, { recursive: true, force: true });
});

afterAll(() => {
  rmSync(NORMALIZATION_FIXTURE_ROOT, { recursive: true, force: true });
});

it("normalizes a merge result without an MCP servers object", async () => {
  const written: string[] = [];
  const deps: DoctorDeps = {
    existsSync: () => true,
    readFileSync: (path: string) => {
      if (path.endsWith("config.json")) return "{}";
      if (path.endsWith("settings.json")) return JSON.stringify({ mcpServers: { lcm: {} } });
      if (path.endsWith("package.json")) return JSON.stringify({ version: "1.2.3" });
      if (path.endsWith("CLAUDE.md")) return "<!-- lcm:start -->\n@lcm.md\n<!-- lcm:end -->";
      if (path.endsWith("lcm.md")) return LCM_MD_CONTENT;
      return "{}";
    },
    writeFileSync: (_path, content) => written.push(content),
    mkdirSync: vi.fn(),
    spawnSync: vi.fn().mockReturnValue({ status: 0, stdout: "", stderr: "" }),
    fetch: vi.fn().mockResolvedValue({ ok: false }) as typeof fetch,
    homedir: NORMALIZATION_HOME,
    platform: "linux",
    cwd: NORMALIZATION_CWD,
    ...doctorConfigSeams("{}"),
  };

  mergeClaudeSettingsMock.mockReturnValueOnce({});
  const results = await runDoctor(deps);
  mergeClaudeSettingsMock.mockReturnValueOnce({ mcpServers: null } as never);
  await runDoctor(deps);
  mergeClaudeSettingsMock.mockReturnValueOnce({ mcpServers: {} });
  await runDoctor(deps);

  expect(results.find((result) => result.name === "mcp-lcm")?.status).toBe("warn");
  expect(mergeClaudeSettingsMock).toHaveBeenCalled();
  expect(written.some((content) => content.includes('"mcpServers"'))).toBe(true);
});
