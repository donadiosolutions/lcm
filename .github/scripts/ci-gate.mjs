// Evaluates the aggregate `ci` status check from the plan and every job result.
//
// A job that the plan required must have succeeded. A job that the plan did
// not require must have been skipped: any other result means the workflow
// graph and the plan disagree, which is a defect rather than a pass.
import { fileURLToPath } from "node:url";

export const ALWAYS_REQUIRED_JOBS = Object.freeze(["plan", "checks"]);
export const PLANNED_JOBS = Object.freeze({
  unit: "unit",
  report: "unit",
  postgresql: "postgresql",
  "linux-systemd": "systemd",
  "macos-launchd": "launchd",
});
export const JOB_RESULT_VARIABLES = Object.freeze({
  plan: "PLAN_RESULT",
  checks: "CHECKS_RESULT",
  unit: "UNIT_RESULT",
  report: "REPORT_RESULT",
  postgresql: "POSTGRESQL_RESULT",
  "linux-systemd": "LINUX_SYSTEMD_RESULT",
  "macos-launchd": "MACOS_LAUNCHD_RESULT",
});
export const PLAN_FLAG_VARIABLES = Object.freeze({
  unit: "PLAN_UNIT",
  postgresql: "PLAN_POSTGRESQL",
  systemd: "PLAN_SYSTEMD",
  launchd: "PLAN_LAUNCHD",
});
const RESULTS = new Set(["success", "failure", "cancelled", "skipped"]);

function readFlag(environment, name) {
  const value = environment[name];
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be "true" or "false", got ${JSON.stringify(value)}`);
}

function readResult(environment, name) {
  const value = environment[name];
  if (!RESULTS.has(value)) throw new Error(`${name} must be a job result, got ${JSON.stringify(value)}`);
  return value;
}

// Returns { ok, lines } where lines explain every job verdict.
export function evaluateGate(environment) {
  const flags = Object.fromEntries(Object.entries(PLAN_FLAG_VARIABLES)
    .map(([flag, variable]) => [flag, readFlag(environment, variable)]));
  const lines = [];
  let ok = true;
  for (const [job, variable] of Object.entries(JOB_RESULT_VARIABLES)) {
    const result = readResult(environment, variable);
    const required = ALWAYS_REQUIRED_JOBS.includes(job) || flags[PLANNED_JOBS[job]];
    const expected = required ? "success" : "skipped";
    const verdict = result === expected ? "ok" : "FAIL";
    if (verdict === "FAIL") ok = false;
    lines.push(`${verdict.padEnd(4)} ${job.padEnd(14)} ${required ? "required" : "not required"}: ${result}`);
  }
  return { ok, lines };
}

export function main(environment = process.env) {
  const { ok, lines } = evaluateGate(environment);
  for (const line of lines) process.stdout.write(`${line}\n`);
  process.stdout.write(ok ? "Every planned CI job succeeded and every unplanned job was skipped.\n" : "CI gate failed.\n");
  return ok ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`ci-gate: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
