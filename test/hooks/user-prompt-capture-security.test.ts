import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleUserPromptSubmit } from "../../src/hooks/user-prompt.js";
import { EventsDb } from "../../src/hooks/events-db.js";
import { eventsDbPath } from "../../src/db/events-path.js";
import type { DaemonClient } from "../../src/daemon/client.js";

vi.mock("../../src/daemon/lifecycle.js", () => ({
  ensureDaemon: vi.fn(async () => ({ connected: true, port: 3737, spawned: false })),
}));
vi.mock("../../src/hooks/session-end.js", () => ({
  firePromoteEventsNotifyRequest: vi.fn(),
}));
vi.mock("../../src/db/events-path.js", () => ({
  eventsDbPath: () => join(process.env.TEST_EVENTS_DIR!, "test.db"),
  eventsDir: () => process.env.TEST_EVENTS_DIR!,
}));

describe("UserPromptSubmit retained capture", () => {
  let home: string;
  let cwd: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "prompt-capture-home-"));
    cwd = mkdtempSync(join(tmpdir(), "prompt-capture-cwd-"));
    previousHome = process.env.HOME;
    process.env.HOME = home;
    process.env.TEST_EVENTS_DIR = cwd;
    mkdirSync(join(home, ".lcm"), { mode: 0o700 });
    writeFileSync(join(home, ".lcm", "config.json"), JSON.stringify({
      security: { sensitivePatterns: ["CUSTOMTOKEN_[A-Z]+\\s"] },
    }), { mode: 0o600 });
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    delete process.env.TEST_EVENTS_DIR;
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  const client = { post: vi.fn(async () => ({ hints: [] })) } as unknown as DaemonClient;

  async function capture(prompt: string): Promise<readonly Record<string, unknown>[]> {
    await handleUserPromptSubmit(JSON.stringify({
      client: "codex", session_id: "prompt-session", cwd, prompt,
    }), client, 3737, { backend: "sqlite" });
    const db = new EventsDb(eventsDbPath(cwd));
    try {
      return db.getUnprocessed() as unknown as readonly Record<string, unknown>[];
    } finally {
      db.close();
    }
  }

  it("scrubs channel content with a trailing custom delimiter before persistence", async () => {
    const rows = await capture('<channel source="telegram">always use CUSTOMTOKEN_ALPHA </channel>');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: "user_decision", source_hook: "UserPromptSubmit" });
    expect(JSON.stringify(rows)).not.toContain("CUSTOMTOKEN_");
    expect(JSON.stringify(rows)).toContain("[REDACTED]");
  });

  it("scrubs a PAT whose delimiter crosses the output cut", async () => {
    const token = `dop_v1_${"a".repeat(64)}`;
    const prefix = "always use ";
    const prompt = `${prefix}${"x".repeat(1_999 - prefix.length - token.length)} ${token}; tail`;
    const rows = await capture(prompt);
    expect(rows).toHaveLength(1);
    expect(String(rows[0].data).length).toBeLessThanOrEqual(2_003);
    expect(JSON.stringify(rows)).not.toContain("dop_v1_");
  });

  it("omits over-budget prompts and keeps a short control", async () => {
    expect(await capture(`always use ${"x".repeat(8_193)}`)).toEqual([]);
    const rows = await capture("always use SQLite");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ data: "always use SQLite", source_hook: "UserPromptSubmit" });
  });
});
