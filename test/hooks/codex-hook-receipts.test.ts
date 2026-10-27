import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CODEX_HOOK_EVENT_NAMES,
  codexHookReceiptDir,
  readCodexHookReceipts,
  runObservedCodexHook,
} from "../../src/hooks/codex-hook-receipts.js";
import { safeLogError } from "../../src/hooks/hook-errors.js";

const lcmHome = () => join(homedir(), ".lcm");
const stateDir = () => join(lcmHome(), "state");
const ok = async () => ({ exitCode: 0, stdout: "" });
const observe = (command: string, stdinText = "{}", client: unknown = "codex") => ({ client, command, stdinText });
const recordPath = (event: string) => join(codexHookReceiptDir(), event + ".json");
const readRecord = (event: string) => JSON.parse(readFileSync(recordPath(event), "utf-8"));

describe("Codex hook receipts", () => {
  beforeEach(() => {
    rmSync(stateDir(), { recursive: true, force: true });
  });
  afterEach(() => {
    rmSync(stateDir(), { recursive: true, force: true });
  });

  it("does nothing for non-Codex clients", async () => {
    const result = { exitCode: 0, stdout: "out" };
    expect(await runObservedCodexHook(observe("restore", "{}", "claude"), async () => result)).toBe(result);
    expect(await runObservedCodexHook({ client: undefined, command: "restore", stdinText: "{}" }, async () => result)).toBe(result);
    expect(existsSync(stateDir())).toBe(false);
  });

  it("records a completion-only, payload-free receipt with private permissions", async () => {
    const result = { exitCode: 0, stdout: "secret output" };
    expect(await runObservedCodexHook(observe("restore", JSON.stringify({ hook_event_name: "SessionStart", prompt: "hidden" })), async () => result)).toBe(result);
    const record = readRecord("SessionStart");
    expect(record).toEqual({
      version: 1,
      event: "SessionStart",
      startedAt: expect.any(Number),
      completedAt: expect.any(Number),
      outcome: "exit-0",
      exitCode: 0,
      loggedErrors: false,
    });
    expect(record.completedAt).toBeGreaterThanOrEqual(record.startedAt);
    expect(JSON.stringify(record)).not.toContain("hidden");
    expect(JSON.stringify(record)).not.toContain("secret");
    expect(statSync(recordPath("SessionStart")).mode & 0o777).toBe(0o600);
    expect(statSync(codexHookReceiptDir()).mode & 0o777).toBe(0o700);
    expect(statSync(stateDir()).mode & 0o777).toBe(0o700);
    expect(readdirSync(codexHookReceiptDir())).toEqual(["SessionStart.json"]);
    expect(readCodexHookReceipts()).toEqual([record]);
  });

  it("attributes the event from the validated payload for shared commands and from the command otherwise", async () => {
    const payload = (name: unknown) => JSON.stringify({ hook_event_name: name });
    await runObservedCodexHook(observe("restore", payload("SubagentStart")), ok);
    await runObservedCodexHook(observe("session-snapshot", payload("Stop")), ok);
    await runObservedCodexHook(observe("session-snapshot", payload("PreCompact")), ok);
    await runObservedCodexHook(observe("restore", payload("Bogus")), ok);
    await runObservedCodexHook(observe("user-prompt", payload("Stop")), ok);
    await runObservedCodexHook(observe("post-tool", payload("Stop")), ok);
    await runObservedCodexHook(observe("pre-tool", "not json"), ok);
    expect(readdirSync(codexHookReceiptDir()).sort()).toEqual([
      "PostToolUse.json", "PreCompact.json", "PreToolUse.json", "SessionStart.json", "Stop.json", "SubagentStart.json", "UserPromptSubmit.json",
    ]);
  });

  it("records nothing when no Codex event can be established", async () => {
    for (const stdin of ["", "null", "[]", "{}", payloadWith(5), payloadWith("PostToolUse "), "not json"]) {
      await runObservedCodexHook(observe("session-snapshot", stdin), ok);
    }
    await runObservedCodexHook(observe("compact", payloadWith("Stop")), ok);
    expect(existsSync(stateDir())).toBe(false);
    function payloadWith(name: unknown): string { return JSON.stringify({ hook_event_name: name }); }
  });

  it("records nonzero exits and thrown errors, then returns or rethrows the original outcome", async () => {
    const failed = { exitCode: 3, stdout: "" };
    expect(await runObservedCodexHook(observe("restore"), async () => failed)).toBe(failed);
    expect(readRecord("SessionStart")).toMatchObject({ outcome: "exit-nonzero", exitCode: 3 });
    const boom = new Error("boom");
    await expect(runObservedCodexHook(observe("post-tool"), async () => { throw boom; })).rejects.toBe(boom);
    expect(readRecord("PostToolUse")).toMatchObject({ outcome: "threw", exitCode: null });
  });

  it("notes when the best-effort hook error channel was used, and resets per run", async () => {
    await runObservedCodexHook(observe("restore"), async () => {
      await safeLogError("restore", new Error("logged"), {});
      return { exitCode: 0, stdout: "" };
    });
    expect(readRecord("SessionStart")).toMatchObject({ outcome: "exit-0", loggedErrors: true });
    await runObservedCodexHook(observe("restore"), async () => {
      await new Promise((resolve) => setTimeout(resolve, 2));
      return { exitCode: 0, stdout: "" };
    });
    expect(readRecord("SessionStart")).toMatchObject({ loggedErrors: false });
  });

  it("throttles identical outcomes but records changes and stale records", async () => {
    await runObservedCodexHook(observe("post-tool"), ok);
    const first = readRecord("PostToolUse");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await runObservedCodexHook(observe("post-tool"), ok);
    expect(readRecord("PostToolUse")).toEqual(first);
    await runObservedCodexHook(observe("post-tool"), async () => ({ exitCode: 1, stdout: "" }));
    expect(readRecord("PostToolUse").outcome).toBe("exit-nonzero");
    await runObservedCodexHook(observe("post-tool"), async () => {
      (globalThis as Record<symbol, unknown>)[Symbol.for("lcm.hookErrorReported")] = true;
      return { exitCode: 1, stdout: "" };
    });
    expect(readRecord("PostToolUse").loggedErrors).toBe(true);
    const old = new Date(Date.now() - 120_000);
    utimesSync(recordPath("PostToolUse"), old, old);
    const before = readRecord("PostToolUse");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await runObservedCodexHook(observe("post-tool"), async () => {
      (globalThis as Record<symbol, unknown>)[Symbol.for("lcm.hookErrorReported")] = true;
      return { exitCode: 1, stdout: "" };
    });
    expect(readRecord("PostToolUse").completedAt).toBeGreaterThan(before.completedAt);
  });

  it("never bootstraps the LCM home", async () => {
    rmSync(lcmHome(), { recursive: true });
    try {
      expect(await runObservedCodexHook(observe("restore"), ok)).toEqual({ exitCode: 0, stdout: "" });
      expect(existsSync(lcmHome())).toBe(false);
    } finally {
      mkdirSync(lcmHome(), { mode: 0o700 });
    }
  });

  it("swallows storage failures without altering the hook outcome", async () => {
    writeFileSync(stateDir(), "not a directory");
    const result = { exitCode: 0, stdout: "x" };
    expect(await runObservedCodexHook(observe("restore"), async () => result)).toBe(result);
    expect(lstatSync(stateDir()).isFile()).toBe(true);
  });

  it("does not follow a symlinked receipt directory", async () => {
    const target = join(lcmHome(), "elsewhere");
    mkdirSync(stateDir(), { mode: 0o700 });
    mkdirSync(target, { mode: 0o700 });
    symlinkSync(target, codexHookReceiptDir());
    await runObservedCodexHook(observe("restore"), ok);
    expect(readdirSync(target)).toEqual([]);
    rmSync(target, { recursive: true });
  });

  it("reads receipts with bounds and ignores invalid or unsafe records", () => {
    expect(readCodexHookReceipts(join(lcmHome(), "absent"))).toEqual([]);
    const dir = codexHookReceiptDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const valid = { version: 1, event: "Stop", startedAt: 1, completedAt: 2, outcome: "exit-0", exitCode: 0, loggedErrors: false };
    const write = (event: string, value: string, mode = 0o600) => {
      writeFileSync(join(dir, event + ".json"), value, { mode });
      chmodSync(join(dir, event + ".json"), mode);
    };
    write("Stop", JSON.stringify(valid));
    write("SessionStart", JSON.stringify({ ...valid, event: "Stop" }));
    write("PostToolUse", JSON.stringify({ ...valid, event: "PostToolUse", version: 2 }));
    write("PreCompact", JSON.stringify({ ...valid, event: "PreCompact", outcome: "other" }));
    write("UserPromptSubmit", JSON.stringify({ ...valid, event: "UserPromptSubmit", completedAt: "x" }));
    write("SessionEnd", JSON.stringify({ ...valid, event: "SessionEnd", exitCode: 1.5 }));
    write("Interrupt", JSON.stringify({ ...valid, event: "Interrupt", loggedErrors: "no" }));
    write("PreToolUse", "{not json");
    write("PostCompact", "null");
    write("SubagentStop", JSON.stringify({ ...valid, event: "SubagentStop" }), 0o644);
    write("PermissionRequest", JSON.stringify({ ...valid, event: "PermissionRequest", padding: "x".repeat(5000) }));
    write("SubagentStart", JSON.stringify({ ...valid, event: "SubagentStart", exitCode: null, outcome: "threw" }));
    expect(readCodexHookReceipts().map((receipt) => receipt.event)).toEqual(["SubagentStart", "Stop"]);
    expect(CODEX_HOOK_EVENT_NAMES).toHaveLength(12);
  });
});
