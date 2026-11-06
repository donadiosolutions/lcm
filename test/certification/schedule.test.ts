import { describe, expect, it } from "vitest";
import { createObservabilityWorkloadSchedule } from "./schedule.mjs";

describe("observability workload schedules", () => {
  it.each(["timeout", "stats-reset", "permission-loss", "extension-loss", "canary"])(
    "creates a finite identity-complete %s workload on each machine",
    (phase) => {
      for (const machine of ["a", "b"]) {
        const schedule = createObservabilityWorkloadSchedule({ machine, runId: "run", phase, durationSeconds: 30 });
        const added = phase === "canary" ? 0 : 1;
        expect(schedule.filter((entry) => entry.op === "search")).toHaveLength(6 + added * 2);
        expect(schedule.filter((entry) => entry.op === "store")).toHaveLength(3 + added);
        expect(new Set(schedule.map((entry) => entry.id)).size).toBe(schedule.length);
        expect(schedule.every((entry) => entry.machine === machine && entry.phase === phase && entry.offsetSeconds < 30)).toBe(true);
      }
    },
  );

  it("sends only searches in the saturation step, with promoted-layer inductions on machine B", () => {
    for (const machine of ["a", "b"]) {
      const schedule = createObservabilityWorkloadSchedule({ machine, runId: "run", phase: "saturation", durationSeconds: 30 });
      const promoted = schedule.filter((entry) => JSON.stringify(entry.layers) === JSON.stringify(["promoted"]));
      expect({
        stores: schedule.filter((entry) => entry.op !== "search").length,
        plain: schedule.filter((entry) => entry.layers === undefined).length,
        promotedOffsets: promoted.map((entry) => entry.offsetSeconds).sort((left, right) => left - right),
        unique: new Set(schedule.map((entry) => entry.id)).size === schedule.length,
      }).toEqual({
        stores: 0, plain: 8, promotedOffsets: machine === "b" ? [0, 0, 0, 0, 5, 5, 10, 10, 15, 15] : [], unique: true,
      });
    }
  });

  it("adds bounded hook witnesses only for phases that request them", () => {
    const without = createObservabilityWorkloadSchedule({ machine: "b", runId: "run", phase: "queue-backlog", durationSeconds: 30 });
    const withHooks = createObservabilityWorkloadSchedule({ machine: "b", runId: "run", phase: "queue-backlog", durationSeconds: 30, includeHooks: true });
    expect(without.some((entry) => entry.op === "hook")).toBe(false);
    expect(withHooks.filter((entry) => entry.op === "hook")).toHaveLength(3);
  });
});
