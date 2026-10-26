import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createAdmissionController,
  createHookFixture,
  executeDeterministicSchedule,
  isAcknowledgedRow,
  observeAcknowledgments,
  verifyFinalDrain,
  verifyEmissionBudget,
} from "./machine-agent.mjs";
import { extractPostToolEvents, extractUserPromptEvents } from "../../src/hooks/extractors.js";
import { normalizePostToolInput } from "../../src/hooks/post-tool-normalization.js";

describe("certification machine agent", () => {
  it.each([256, 1024, 8192])("creates exact-byte one-event fixtures for %i bytes", (bytes) => {
    const userPrompt = createHookFixture({ kind: "user-prompt", bytes, sessionId: "s0", cwd: "/project" });
    const postTool = createHookFixture({ kind: "post-tool", bytes, sessionId: "s0", cwd: "/project" });
    expect(Buffer.byteLength(userPrompt.prompt)).toBe(bytes);
    expect(Buffer.byteLength(postTool.tool_input.subject)).toBe(bytes);
    expect(postTool.tool_name).toBe("TaskCreate");
  });

  it.each([256, 1024, 1024, 8192])("pins one extracted event for both fixture kinds at %i bytes", (bytes) => {
    const userPrompt = createHookFixture({ kind: "user-prompt", bytes, sessionId: "s0", cwd: "/project" });
    const postTool = createHookFixture({ kind: "post-tool", bytes, sessionId: "s0", cwd: "/project" });
    expect(extractUserPromptEvents(userPrompt.prompt)).toHaveLength(1);
    expect(extractUserPromptEvents(userPrompt.prompt)[0]?.type).toBe("user_decision");
    expect(extractPostToolEvents(normalizePostToolInput(postTool))).toHaveLength(1);
    expect(extractPostToolEvents(normalizePostToolInput(postTool))[0]?.type).toBe("task_create");
  });

  it("recognizes only terminal acknowledged rows", () => {
    expect(isAcknowledgedRow({ delivery_state: "acknowledged", remote_inbox_id: "i", acknowledged_at: "now" })).toBe(true);
    expect(isAcknowledgedRow({ delivery_state: "replicated", remote_inbox_id: "i", acknowledged_at: null })).toBe(false);
  });

  it("records first-seen monotonic time and distinct inbox ids", () => {
    const previous = new Map();
    const observed = observeAcknowledgments(previous, [
      { event_uuid: "e", delivery_state: "acknowledged", remote_inbox_id: "i", acknowledged_at: "now" },
      { event_uuid: "pending", delivery_state: "replicated", remote_inbox_id: "j", acknowledged_at: null },
    ], 123n);
    expect(observed.get("e")).toEqual({ firstSeenMonotonicNs: "123", inboxIds: ["i"] });
    expect(observed.has("pending")).toBe(false);
  });

  it("fails closed when the bounded queue overflows", async () => {
    const admission = createAdmissionController({ maxActive: 1, maxQueued: 1 });
    let release!: () => void;
    const blocked = admission.run(() => new Promise<void>((resolve) => { release = resolve; }));
    const queued = admission.run(async () => "queued");
    await expect(admission.run(async () => "overflow")).rejects.toThrow("overflow");
    release();
    await expect(blocked).resolves.toBeUndefined();
    await expect(queued).resolves.toBe("queued");
  });

  it("requires every captured event to be acknowledged and remotely pruned", () => {
    expect(verifyFinalDrain([
      { event_uuid: "a", delivery_state: "acknowledged", remote_inbox_id: "1", acknowledged_at: "now", remote_pruned_at: "later" },
    ])).toEqual({ acknowledged: 1, remotePruned: 1 });
    expect(() => verifyFinalDrain([
      { event_uuid: "a", delivery_state: "acknowledged", remote_inbox_id: "1", acknowledged_at: "now", remote_pruned_at: null },
    ])).toThrow("awaiting remote prune");
    expect(() => verifyFinalDrain([
      { event_uuid: "a", delivery_state: "retry", remote_inbox_id: null, acknowledged_at: null, remote_pruned_at: null },
    ])).toThrow("nonterminal");
  });

  it("enforces the half-open rolling 300-second emission budget", () => {
    expect(verifyEmissionBudget(Array.from({ length: 30 }, (_, index) => 1 + index * 10), 30)).toBe(30);
    expect(() => verifyEmissionBudget(Array.from({ length: 31 }, (_, index) => index * 9), 30)).toThrow("emission budget");
  });

  it("records an operation whose admission starts after its absolute deadline", async () => {
    const evidenceDirectory = mkdtempSync(join(tmpdir(), "lcm-cert-operation-deadline-"));
    const samples = await executeDeterministicSchedule({
      schedule: [{ id: "late", machine: "a", op: "search", offsetSeconds: 0, phase: "steady" }],
      entrypoint: "/unused/lcm.mjs", cwd: evidenceDirectory, environment: {}, evidenceDirectory,
      scheduleStartWallMs: 0, wallNow: () => 60_001, delay: async () => undefined,
    });
    expect(samples).toEqual([expect.objectContaining({ outcome: "failed", errorClass: "OperationDeadlineExceeded" })]);
    expect(readFileSync(join(evidenceDirectory, "samples.ndjson"), "utf8")).toContain("OperationDeadlineExceeded");
  });
});
