import { describe, expect, it } from "vitest";
import {
  errorRate,
  evaluatePercentiles,
  nearestRank,
  recoveryWindow,
} from "./slo.mjs";

describe("certification SLO calculators", () => {
  it("uses the nearest-rank definition", () => {
    expect(nearestRank([40, 10, 20, 30], 0.5)).toBe(20);
    expect(nearestRank([1, 2, 3], 0.99)).toBe(3);
  });

  it("marks an under-sized percentile population incomplete", () => {
    expect(evaluatePercentiles([1, 2, 3], { p50: 10 }, { p50: 20 })).toEqual({
      verdict: "incomplete",
      reasons: ["p50 has 3 samples; minimum is 20"],
      observed: {},
    });
  });

  it("retains definite failures when other percentile evidence is incomplete", () => {
    expect(evaluatePercentiles(Array.from({ length: 20 }, () => 11), { p50: 10, p99: 20 }, { p50: 20, p99: 1000 })).toMatchObject({
      verdict: "fail",
      reasons: expect.arrayContaining([expect.stringContaining("p50"), expect.stringContaining("p99")]),
    });
  });

  it("computes non-injected failures over scheduled attempts", () => {
    expect(errorRate({ scheduled: 1000, failed: 1 })).toBe(0.001);
    expect(() => errorRate({ scheduled: 0, failed: 0 })).toThrow("scheduled");
  });

  it("requires search and store to recover separately in a sliding window", () => {
    const attempts = [
      ...Array.from({ length: 12 }, (_, index) => ({ kind: "search", scheduledAtMs: 1000 + index, terminalAtMs: 2000, outcome: index === 0 ? "failed" : "success" })),
      ...Array.from({ length: 6 }, (_, index) => ({ kind: "store", scheduledAtMs: 1000 + index, terminalAtMs: 2000, outcome: index === 0 ? "failed" : "success" })),
    ];

    expect(recoveryWindow(attempts, { startMs: 1000, endMs: 61_000 })).toEqual({
      verdict: "fail",
      search: { scheduled: 12, succeeded: 11, required: 11, pass: true },
      store: { scheduled: 6, succeeded: 5, required: 6, pass: false },
    });
  });
});
