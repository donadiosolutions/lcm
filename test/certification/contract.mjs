import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function pathOf(path) {
  return path instanceof URL ? fileURLToPath(path) : path;
}
function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`invalid certification contract ${name}`);
  return value;
}

function scheduledCount(durationSeconds, firstSecond, intervalSeconds) {
  if (firstSecond >= durationSeconds) return 0;
  return Math.floor((durationSeconds - 1 - firstSecond) / intervalSeconds) + 1;
}

function valueAt(root, path) {
  return path.split(".").reduce((value, key) => value?.[key], root);
}

function assertShape(contract) {
  for (const path of [
    "approval", "lanes", "lanes.local", "lanes.managed", "configuration",
    "timeline", "timeline.full", "timeline.smoke", "workload", "workload.schedulePerMachine",
    "workload.fixtures", "workload.emission", "workload.admission",
    "workload.expectedPooledSteadyAttemptsPerLane", "workload.expectedPerMachine",
    "oracle", "oracle.observer", "thresholds", "thresholds.hookCommandMs",
    "thresholds.daemonSearchMs", "thresholds.daemonStoreMs", "thresholds.recovery",
    "thresholds.capacity", "thresholds.clock", "thresholds.cleanup",
    "calculations", "calculations.minimumSamples", "repetitions",
  ]) {
    const value = valueAt(contract, path);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`invalid certification contract shape at ${path}`);
    }
  }
  for (const path of ["lanes.local.faults", "lanes.managed.faults", "workload.primaryTextBytesCycle", "workload.emission.sources"]) {
    if (!Array.isArray(valueAt(contract, path))) throw new Error(`invalid certification contract shape at ${path}`);
  }
  if (contract.lanes.local.machines !== 2 || contract.workload.machines !== 2 || contract.workload.sessionsPerMachine !== 4) {
    throw new Error("invalid certification contract two-machine shape");
  }
  const full = contract.timeline.full;
  const allocated = full.setupMaxSeconds + full.warmupSeconds + full.steadySeconds
    + full.pendingSettleMaxSeconds + full.partitionPhaseMaxSeconds + full.restartPhaseMaxSeconds
    + full.finalDrainSeconds + full.cleanupReserveSeconds;
  if (allocated !== full.localDeadlineSeconds) throw new Error("certification contract full timeline does not equal its deadline");
  if (contract.timeline.smoke.warmupSeconds + contract.timeline.smoke.steadySeconds
    + contract.timeline.smoke.finalDrainSeconds >= contract.timeline.smoke.wholeRunDeadlineSeconds) {
    throw new Error("certification contract smoke timeline leaves no setup and cleanup reserve");
  }
}

export function expectedSteadyAttempts(contract) {
  const duration = positiveInteger(contract?.timeline?.full?.steadySeconds, "steadySeconds");
  const machines = positiveInteger(contract?.workload?.machines, "machines");
  const perMachineHook = scheduledCount(duration, 1, 10);
  const perMachineSearch = scheduledCount(duration, 2, 5);
  const perMachineStore = scheduledCount(duration, 4, 10);
  const userPromptPerMachine = Math.ceil(perMachineHook / 4);
  return {
    hookInvocations: perMachineHook * machines,
    userPrompt: userPromptPerMachine * machines,
    postTool: (perMachineHook - userPromptPerMachine) * machines,
    daemonSearch: perMachineSearch * machines,
    daemonStore: perMachineStore * machines,
  };
}

function assertContract(contract) {
  if (contract?.id !== "lcm-production-certification" || contract?.version !== 1) {
    throw new Error("invalid certification contract identity");
  }
  if (!['draft', 'approved'].includes(contract.status)) throw new Error("invalid certification contract status");
  assertShape(contract);
  const derived = expectedSteadyAttempts(contract);
  const declared = contract.workload?.expectedPooledSteadyAttemptsPerLane;
  for (const [name, count] of Object.entries(derived)) {
    if (declared?.[name] !== count) throw new Error(`certification contract ${name} schedule count is inconsistent`);
  }
  const p99Minimum = positiveInteger(contract?.calculations?.minimumSamples?.p99, "p99 minimum");
  for (const name of ["hookInvocations", "daemonSearch", "daemonStore"]) {
    if (derived[name] < p99Minimum) {
      throw new Error(`certification contract ${name} misses p99 minimum ${p99Minimum}`);
    }
  }
  const subgateMinimum = positiveInteger(contract?.thresholds?.hookCommandMs?.minSuccessesForSubgates, "hook subgate minimum");
  if (derived.userPrompt < subgateMinimum || derived.postTool < subgateMinimum) {
    throw new Error("certification contract hook kind schedule misses subgate minimum");
  }
  return contract;
}

export function loadCertificationContract(path, options = {}) {
  const bytes = readFileSync(pathOf(path));
  const contract = assertContract(JSON.parse(bytes.toString("utf8")));
  if (options.requireApproved !== false && contract.status !== "approved") {
    throw new Error("certification contract must be approved before evidence collection");
  }
  if (contract.status === "approved") {
    for (const field of ["approvedBy", "approvedAt", "approvalRef"]) {
      if (typeof contract.approval?.[field] !== "string" || contract.approval[field].length === 0) {
        throw new Error(`approved certification contract is missing ${field}`);
      }
    }
  }
  return { contract, sha256: createHash("sha256").update(bytes).digest("hex") };
}
