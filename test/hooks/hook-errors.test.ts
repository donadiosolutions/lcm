// test/hooks/hook-errors.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Mock eventsDbPath to use temp dir.
// Paths under /dev/null/... are kept as-is so DB creation fails and triggers the circuit breaker.
let mockEventsDir: string;
vi.mock("../../src/db/events-path.js", async () => {
  const { createHash } = await import("node:crypto");
  return {
    eventsDbPath: (cwd: string) => {
      if (cwd.startsWith("/dev/null/")) return join(cwd, "events.db");
      const hash = createHash("sha256").update(cwd).digest("hex");
      return join(mockEventsDir, `${hash}.db`);
    },
  };
});

// Import after mocks
import { safeLogError, _resetCircuitBreaker, _setLogPathForTesting } from "../../src/hooks/hook-errors.js";
import { EventsDb } from "../../src/hooks/events-db.js";
import { eventsDbPath } from "../../src/db/events-path.js";
import { MAX_HOOK_ERROR_DIAGNOSTIC_LENGTH } from "../../src/hooks/hook-error-diagnostic.js";
import { lcmPath } from "../../src/runtime-paths.js";

describe("safeLogError", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "hook-errors-test-"));
    mockEventsDir = join(tempDir, "events");
    _setLogPathForTesting(join(tempDir, "events.log"));
    _resetCircuitBreaker();
  });

  afterEach(() => {
    _setLogPathForTesting(undefined);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("Layer 1: writes to sidecar DB when cwd is valid", async () => {
    const cwd = join(tempDir, "project");
    mkdirSync(cwd);
    await safeLogError("PostToolUse", new Error("test error"), { cwd, sessionId: "s1" });

    const db = new EventsDb(eventsDbPath(cwd));
    const rows = db.getRecentErrors({ includeMaintenance: true });
    expect(rows).toHaveLength(1);
    expect(rows[0].hook).toBe("PostToolUse");
    expect(rows[0].error).toBe("test error");
    db.close();
  });

  it("Layer 1: skips DB when cwd is undefined, falls to Layer 2", async () => {
    await safeLogError("PostToolUse", new Error("no cwd"), {});
    const logPath = join(tempDir, "events.log");
    expect(existsSync(logPath)).toBe(true);
    const content = readFileSync(logPath, "utf-8");
    expect(content).toContain("no cwd");
  });

  it("does not persist project state for a nonexistent diagnostic cwd", async () => {
    const cwd = join(tempDir, "missing-project");
    await safeLogError("PostToolUse", new Error("invalid cwd"), { cwd });
    expect(existsSync(eventsDbPath(cwd))).toBe(false);
    expect(readFileSync(join(tempDir, "events.log"), "utf-8")).toContain("invalid cwd");
  });

  it("stringifies non-Error failures in the fallback log", async () => {
    await safeLogError("PostToolUse", "plain failure", {});
    expect(readFileSync(join(tempDir, "events.log"), "utf-8")).toContain('"error":"plain failure"');
  });

  it("Layer 2: writes to flat file when DB fails", async () => {
    const cwd = "/dev/null/impossible";
    await safeLogError("PostToolUse", new Error("db fail"), { cwd, sessionId: "s1" });

    const testLogPath = join(tempDir, "events.log");
    expect(existsSync(testLogPath)).toBe(true);
    const content = readFileSync(testLogPath, "utf-8");
    expect(content).toContain("db fail");
    expect(content).toContain("PostToolUse");
    expect(content).toContain("/dev/null/impossible");
  });

  it("sanitizes and bounds errors written by the fallback log", async () => {
    const credentials = [
      "fallback-bearer-secret",
      "sk-0123456789abcdefghijklmnop",
      "ghp_0123456789abcdefghijklmnopqrstuvwxyz",
      "npm_0123456789abcdefghijklmnopqrstuvwxyz",
      "fallback-api-key-secret",
    ];
    const secret = `postgresql://alice:hunter2@db.example.test/lcm?sslmode=disable password=hunter2 Authorization: Bearer ${credentials[0]} ${credentials.slice(1, 4).join(" ")} X-Api-Key: ${credentials[4]} ${"x".repeat(
      MAX_HOOK_ERROR_DIAGNOSTIC_LENGTH + 100,
    )}\u001b[31m`;
    await safeLogError("PostToolUse", new Error(secret), {});

    const record = JSON.parse(readFileSync(join(tempDir, "events.log"), "utf-8")) as { error: string };
    expect(record.error).not.toContain("alice");
    expect(record.error).not.toContain("hunter2");
    expect(record.error).not.toContain("sslmode");
    for (const credential of credentials) expect(record.error).not.toContain(credential);
    expect(record.error).not.toContain("\u001b");
    expect(record.error.length).toBe(MAX_HOOK_ERROR_DIAGNOSTIC_LENGTH);
  });

  it("circuit breaker: skips DB after first failure", async () => {
    const badCwd = "/dev/null/impossible";
    await safeLogError("PostToolUse", new Error("first"), { cwd: badCwd });

    const goodCwd = join(tempDir, "project2");
    await safeLogError("PostToolUse", new Error("second"), { cwd: goodCwd });

    // Good CWD should NOT have a DB entry because circuit is open
    const dbPath = eventsDbPath(goodCwd);
    expect(existsSync(dbPath)).toBe(false);
  });

  it("Layer 3: swallows silently when both DB and file fail", async () => {
    _setLogPathForTesting("/dev/null/impossible/events.log");
    
    try {
      await expect(safeLogError("PostToolUse", new Error("total fail"), {})).resolves.toBeUndefined();
    } finally {
      _setLogPathForTesting(join(tempDir, "events.log"));
    }
  });

  it("rejects log path overrides outside temp or LCM logs", async () => {
    _setLogPathForTesting("/etc/lcm-events.log");
    await expect(safeLogError("PostToolUse", new Error("unsafe path"), {})).resolves.toBeUndefined();
    expect(existsSync("/etc/lcm-events.log")).toBe(false);
  });

  it("writes fallback events.log under the isolated test home by default", async () => {
    _setLogPathForTesting(undefined);
    _resetCircuitBreaker();
    try {
      await safeLogError("PostToolUse", new Error("sandbox fallback"), {});

      const logPath = lcmPath("logs", "events.log");
      expect(existsSync(logPath)).toBe(true);
      expect(readFileSync(logPath, "utf-8")).toContain("sandbox fallback");
      if (process.env.LCM_TEST_REAL_HOME) {
        expect(logPath.startsWith(process.env.LCM_TEST_REAL_HOME)).toBe(false);
      }
    } finally {
      _setLogPathForTesting(join(tempDir, "events.log"));
    }
  });

});
