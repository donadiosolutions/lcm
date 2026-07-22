/**
 * E2E Flow Tests: Hooks (Flows 14, 15, 16)
 *
 * Flow 14: SessionEnd hook ingests messages
 * Flow 15: PreCompact hook returns exit 0 with summary
 * Flow 16: Auto-heal validates hooks without throwing
 */

import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { createHarness, type HarnessHandle } from "../harness.js";
import { DaemonClient } from "../../../src/daemon/client.js";
import { MANUAL_COMPACT_FRESH_TAIL_COUNT } from "../../../src/compaction.js";

let handle: HarnessHandle | null = null;

beforeAll(async () => {
  handle = await createHarness("mock");
}, 60_000);

afterAll(async () => {
  if (handle) {
    await handle.cleanup();
    handle = null;
  }
});

describe("Flow 14: SessionEnd hook", { timeout: 60_000 }, () => {
  it("ingests messages and returns exit 0", async () => {
    const h = handle!;
    const client = new DaemonClient(`http://127.0.0.1:${h.daemonPort}`);
    const stdinData = JSON.stringify({
      session_id: "e2e-session-end-test",
      cwd: h.tmpDir,
      transcript_path: h.fixturePath,
    });

    const { handleSessionEnd } = await import("../../../src/hooks/session-end.js");
    const result = await handleSessionEnd(stdinData, client, h.daemonPort);

    expect(result.exitCode).toBe(0);
  });
});

describe("Flow 15: PreCompact hook", { timeout: 60_000 }, () => {
  it("returns exit 0 with a generated mock summary for SQLite", async () => {
    const h = handle!;

    // Keep enough messages outside the protected fresh tail to force a leaf summary.
    const messageCount = MANUAL_COMPACT_FRESH_TAIL_COUNT + 4;
    await h.client.post("/ingest", {
      session_id: "e2e-precompact-test",
      cwd: h.tmpDir,
      messages: Array.from({ length: messageCount }, (_, index) => ({
        role: index % 2 === 0 ? "user" : "assistant",
        content: index === 0
          ? "Known E2E database design source phrase."
          : `Deterministic PreCompact message ${index}.`,
        tokenCount: 10,
      })),
    });

    const client = new DaemonClient(`http://127.0.0.1:${h.daemonPort}`);
    const stdinData = JSON.stringify({
      session_id: "e2e-precompact-test",
      cwd: h.tmpDir,
      client: "claude",
    });

    const lifecycle = await import("../../../src/daemon/lifecycle.js");
    const ensureDaemon = vi.spyOn(lifecycle, "ensureDaemon").mockResolvedValue({
      connected: true,
      port: h.daemonPort,
      spawned: false,
    });
    const { handlePreCompact } = await import("../../../src/hooks/compact.js");
    try {
      const result = await handlePreCompact(
        stdinData,
        client,
        h.daemonPort,
        { backend: "sqlite" },
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("lcm · compaction complete");
      expect(result.stdout).toContain("<compaction-summary>");
      expect(result.stdout).toContain("[Mock Summary");
    } finally {
      ensureDaemon.mockRestore();
    }
  });

  it("returns exit 0 without output when PostgreSQL is unavailable", async () => {
    const h = handle!;
    const client = new DaemonClient(`http://127.0.0.1:${h.daemonPort}`);
    const lifecycle = await import("../../../src/daemon/lifecycle.js");
    const storageBackend = await import("../../../src/storage/backend.js");
    const ensureDaemon = vi.spyOn(lifecycle, "ensureDaemon").mockResolvedValue({
      connected: true,
      port: h.daemonPort,
      spawned: false,
    });
    const selectStorageBackend = vi.spyOn(storageBackend, "selectStorageBackend");
    const { handlePreCompact } = await import("../../../src/hooks/compact.js");

    try {
      await expect(handlePreCompact(
        JSON.stringify({ session_id: "e2e-precompact-postgresql", cwd: h.tmpDir }),
        client,
        h.daemonPort,
        { backend: "postgresql" },
      )).resolves.toEqual({ exitCode: 0, stdout: "" });
      expect(selectStorageBackend).toHaveBeenCalledOnce();
      expect(selectStorageBackend).toHaveBeenCalledWith({ backend: "postgresql" });
      expect(ensureDaemon).not.toHaveBeenCalled();
    } finally {
      selectStorageBackend.mockRestore();
      ensureDaemon.mockRestore();
    }
  });
});

describe("Flow 16: Auto-heal", { timeout: 60_000 }, () => {
  it("validateAndFixHooks with custom deps does not throw", async () => {
    const { validateAndFixHooks } = await import("../../../src/hooks/auto-heal.js");

    // Provide mock deps that simulate no settings file present
    const mockDeps = {
      readFileSync: (_path: string, _enc: string): string => "{}",
      writeFileSync: (_path: string, _data: string): void => {},
      existsSync: (_path: string): boolean => false,
      mkdirSync: (_path: string, _opts?: { recursive: boolean }): void => {},
      appendFileSync: (_path: string, _data: string): void => {},
      settingsPath: "/nonexistent/settings.json",
      logPath: "/nonexistent/auto-heal.log",
    };

    expect(() => validateAndFixHooks(mockDeps)).not.toThrow();
  });
});
