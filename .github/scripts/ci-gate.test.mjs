import assert from "node:assert/strict";
import test from "node:test";

import { evaluateGate, main } from "./ci-gate.mjs";

function environment(overrides = {}) {
  return {
    PLAN_UNIT: "true",
    PLAN_POSTGRESQL: "true",
    PLAN_SYSTEMD: "true",
    PLAN_LAUNCHD: "true",
    PLAN_RESULT: "success",
    CHECKS_RESULT: "success",
    UNIT_RESULT: "success",
    REPORT_RESULT: "success",
    POSTGRESQL_RESULT: "success",
    LINUX_SYSTEMD_RESULT: "success",
    MACOS_LAUNCHD_RESULT: "success",
    ...overrides,
  };
}

test("passes when every planned job succeeded", () => {
  const { ok, lines } = evaluateGate(environment());
  assert.equal(ok, true);
  assert.equal(lines.length, 7);
  assert.ok(lines.every((line) => line.startsWith("ok ")));
});

test("passes when unplanned jobs were skipped", () => {
  const { ok } = evaluateGate(environment({
    PLAN_UNIT: "false",
    PLAN_POSTGRESQL: "false",
    PLAN_SYSTEMD: "false",
    PLAN_LAUNCHD: "false",
    UNIT_RESULT: "skipped",
    REPORT_RESULT: "skipped",
    POSTGRESQL_RESULT: "skipped",
    LINUX_SYSTEMD_RESULT: "skipped",
    MACOS_LAUNCHD_RESULT: "skipped",
  }));
  assert.equal(ok, true);
});

test("fails when a required job was skipped or did not succeed", () => {
  for (const [variable, result] of [
    ["UNIT_RESULT", "skipped"],
    ["REPORT_RESULT", "failure"],
    ["POSTGRESQL_RESULT", "cancelled"],
    ["LINUX_SYSTEMD_RESULT", "skipped"],
    ["MACOS_LAUNCHD_RESULT", "failure"],
    ["PLAN_RESULT", "failure"],
    ["CHECKS_RESULT", "skipped"],
  ]) {
    const { ok, lines } = evaluateGate(environment({ [variable]: result }));
    assert.equal(ok, false, variable);
    assert.equal(lines.filter((line) => line.startsWith("FAIL")).length, 1, variable);
  }
});

test("fails when an unplanned job ran anyway, even successfully", () => {
  const { ok } = evaluateGate(environment({ PLAN_POSTGRESQL: "false", POSTGRESQL_RESULT: "success" }));
  assert.equal(ok, false);
  const failed = evaluateGate(environment({ PLAN_LAUNCHD: "false", MACOS_LAUNCHD_RESULT: "failure" }));
  assert.equal(failed.ok, false);
});

test("report follows the unit plan flag", () => {
  const { ok } = evaluateGate(environment({ PLAN_UNIT: "false", UNIT_RESULT: "skipped", REPORT_RESULT: "skipped" }));
  assert.equal(ok, true);
  const mismatch = evaluateGate(environment({ PLAN_UNIT: "false", UNIT_RESULT: "skipped", REPORT_RESULT: "success" }));
  assert.equal(mismatch.ok, false);
});

test("plan and checks are always required", () => {
  assert.equal(evaluateGate(environment({ PLAN_RESULT: "skipped" })).ok, false);
  assert.equal(evaluateGate(environment({ CHECKS_RESULT: "cancelled" })).ok, false);
});

test("rejects malformed flags and results instead of guessing", () => {
  assert.throws(() => evaluateGate(environment({ PLAN_UNIT: "yes" })), /PLAN_UNIT/u);
  assert.throws(() => evaluateGate(environment({ PLAN_UNIT: undefined })), /PLAN_UNIT/u);
  assert.throws(() => evaluateGate(environment({ UNIT_RESULT: "passed" })), /UNIT_RESULT/u);
  assert.throws(() => evaluateGate(environment({ UNIT_RESULT: "" })), /UNIT_RESULT/u);
});

test("main returns the process status and prints one line per job", () => {
  const written = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk) => {
    written.push(String(chunk));
    return true;
  };
  try {
    assert.equal(main(environment()), 0);
    assert.equal(main(environment({ UNIT_RESULT: "failure" })), 1);
  } finally {
    process.stdout.write = originalWrite;
  }
  assert.equal(written.filter((line) => /^(?:ok|FAIL)/u.test(line)).length, 14);
  assert.ok(written.some((line) => line.includes("CI gate failed.")));
});
