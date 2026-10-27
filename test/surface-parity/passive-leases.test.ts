import { describe, expect, it } from "vitest";
import { semanticDigest } from "./assertions.mjs";
import { partitionFencedLeases, settleHeldLeases } from "./passive-leases.mjs";

const machineId = "01a15240-ea21-720e-a5bf-51124fafef10";
const primary = "01a15240-ea23-7d5a-b9e7-40fe885d305b";
const prepared = "01a15240-ea2a-766d-83b0-b2ce4abd71f8";
const foreignProject = "01a15240-ffff-7d5a-b9e7-40fe885d3000";
const foreignMachine = "01a15240-eeee-720e-a5bf-51124fafef10";
const authority = { machineId, projectIds: [primary, prepared] };
const daemon = "lcm-daemon:0198aaaa-bbbb-7ccc-8ddd-eeeeffff0000";

const passive = (overrides: Record<string, unknown> = {}) => ({
  project_id: primary, resource_type: "passive-events", resource_key: machineId, owner_machine_id: machineId,
  owner_process_id: daemon, operation: "replicate", fencing_token: 7, released_at: "2026-10-19T03:00:00.000Z", ...overrides,
});
const other = (overrides: Record<string, unknown> = {}) => ({
  project_id: primary, resource_type: "migration", resource_key: "run", owner_machine_id: machineId,
  owner_process_id: "worker:1", operation: "apply", fencing_token: 3, released_at: null, ...overrides,
});
/** The digest the suite derives from the rows that remain pinned. */
const digest = (rows: unknown[], extra: Record<string, unknown> = {}) =>
  semanticDigest(partitionFencedLeases(rows, { ...authority, ...extra }).pinned);

describe("surface parity passive replication lease exemption", () => {
  it("exempts released fixture-machine leases of bound projects, one per project", () => {
    const pinned = other();
    const rows = [pinned, passive(), passive({ project_id: prepared, fencing_token: 9 })];
    expect(partitionFencedLeases(rows, authority)).toEqual({ pinned: [pinned], exempt: [primary, prepared].sort() });
    expect(digest(rows)).toBe(digest([pinned]));
    // A lease advancing between snapshots, or none yet, does not move the digest.
    expect(digest([pinned, passive({ fencing_token: 99, owner_process_id: "lcm-daemon:0198aaaa-bbbb-7ccc-8ddd-000011112222" })]))
      .toBe(digest([pinned, passive()]));
    expect(partitionFencedLeases([], authority)).toEqual({ pinned: [], exempt: [] });
  });

  it.each([
    ["unbound project", { project_id: foreignProject }],
    ["foreign machine", { resource_key: foreignMachine, owner_machine_id: foreignMachine }],
    ["foreign owner machine only", { owner_machine_id: foreignMachine }],
    ["foreign resource key only", { resource_key: foreignMachine }],
    ["wrong operation", { operation: "drain" }],
    ["non-daemon owner", { owner_process_id: "worker:1" }],
    ["zero token", { fencing_token: 0 }],
    ["non-numeric token", { fencing_token: "7" }],
  ])("fails the guard for a passive-events row with %s", (_name, overrides) => {
    expect(() => partitionFencedLeases([passive(overrides)], authority)).toThrow("surface-parity-parent:passive-replication-lease-shape");
  });

  it("rejects the triage probe that main left digest-neutral", () => {
    const probe = passive({ project_id: foreignProject, resource_key: foreignMachine, owner_machine_id: foreignMachine, released_at: null });
    expect(() => partitionFencedLeases([other(), probe], authority)).toThrow("surface-parity-parent:passive-replication-lease-shape");
  });

  it("reports a held but otherwise valid fixture lease as held", () => {
    expect(() => partitionFencedLeases([passive({ released_at: null })], authority)).toThrow("surface-parity-parent:passive-replication-lease-held");
    // Another violation in the same row set wins over a held lease.
    expect(() => partitionFencedLeases([passive({ released_at: null }), passive({ project_id: prepared, operation: "drain" })], authority))
      .toThrow("surface-parity-parent:passive-replication-lease-shape");
  });

  it("reports a held lease whose project was exempt before as held, not vanished", () => {
    expect(() => partitionFencedLeases([passive({ released_at: null })], { ...authority, previous: [primary] }))
      .toThrow("surface-parity-parent:passive-replication-lease-held");
  });

  it.each([
    ["unbound project", { project_id: foreignProject }],
    ["foreign machine", { resource_key: foreignMachine, owner_machine_id: foreignMachine }],
    ["non-daemon owner", { owner_process_id: "worker:1" }],
  ])("keeps a held lease with %s a shape violation", (_name, overrides) => {
    expect(() => partitionFencedLeases([passive({ ...overrides, released_at: null })], authority)).toThrow("surface-parity-parent:passive-replication-lease-shape");
  });

  describe("settleHeldLeases", () => {
    const held = () => new Error("surface-parity-parent:passive-replication-lease-held");
    /** A fake clock that only advances when the retry loop sleeps. */
    const clock = () => {
      let time = 0;
      const sleeps: number[] = [];
      return { sleeps, now: () => time, sleep: async (ms: number) => { sleeps.push(ms); time += ms; } };
    };

    it("returns the first successful read after transient held failures", async () => {
      const { sleeps, now, sleep } = clock();
      let reads = 0;
      const result = await settleHeldLeases(async () => { if (++reads < 3) throw held(); return "ok"; }, { timeoutMs: 1000, intervalMs: 250, now, sleep });
      expect(result).toBe("ok");
      expect(reads).toBe(3);
      expect(sleeps).toEqual([250, 250]);
    });

    it("rethrows the held error after a finite number of reads when the lease stays held", async () => {
      const { now, sleep } = clock();
      let reads = 0;
      await expect(settleHeldLeases(async () => { reads++; throw held(); }, { timeoutMs: 1000, intervalMs: 250, now, sleep }))
        .rejects.toThrow("surface-parity-parent:passive-replication-lease-held");
      expect(reads).toBe(5);
    });

    it("propagates any other error on the first read without retry", async () => {
      const { sleeps, now, sleep } = clock();
      let reads = 0;
      await expect(settleHeldLeases(async () => { reads++; throw new Error("surface-parity-parent:passive-replication-lease-shape"); }, { now, sleep }))
        .rejects.toThrow("surface-parity-parent:passive-replication-lease-shape");
      expect(reads).toBe(1);
      expect(sleeps).toEqual([]);
    });

    it("waits on real timers with the default bounds when nothing is injected", async () => {
      let reads = 0;
      expect(await settleHeldLeases(async () => { if (++reads < 2) throw held(); return reads; }, { intervalMs: 1 })).toBe(2);
    });
  });

  it("rejects duplicate leases for one project", () => {
    expect(() => partitionFencedLeases([passive(), passive({ fencing_token: 8 })], authority)).toThrow("surface-parity-parent:passive-replication-lease-duplicate");
  });

  it("rejects a lease that vanished since the previous snapshot", () => {
    expect(() => partitionFencedLeases([passive()], { ...authority, previous: [primary, prepared] })).toThrow("surface-parity-parent:passive-replication-lease-vanished");
    expect(partitionFencedLeases([passive(), passive({ project_id: prepared })], { ...authority, previous: [primary] }).exempt).toHaveLength(2);
  });

  it("keeps every non-passive lease row in the digest", () => {
    const base = [other()];
    expect(digest([...base, other({ project_id: prepared })])).not.toBe(digest(base));
    expect(digest([other({ released_at: null })])).not.toBe(digest([other({ released_at: "2026-10-19T03:00:00.000Z" })]));
    expect(partitionFencedLeases([other({ resource_type: "passive-events-x" })], authority).pinned).toHaveLength(1);
  });

  it("rejects a non-array row set", () => {
    expect(() => partitionFencedLeases(undefined as never, authority)).toThrow("surface-parity-parent:passive-replication-lease-rows");
  });
});
