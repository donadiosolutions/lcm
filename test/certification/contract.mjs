import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";

function pathOf(path) {
  return path instanceof URL ? fileURLToPath(path) : path;
}

function approvalPathFor(contractPath) {
  const extension = extname(contractPath);
  return `${contractPath.slice(0, -extension.length)}.approval${extension}`;
}

function loadApproval(path, contractSha256) {
  const bytes = readFileSync(path);
  const approval = JSON.parse(bytes.toString("utf8"));
  for (const field of ["contractSha256", "approvedBy", "approvedAt", "note", "approvalRef"]) {
    if (typeof approval?.[field] !== "string" || approval[field].length === 0) {
      throw new Error(`certification approval record is missing ${field}`);
    }
  }
  if (!/^[0-9a-f]{64}$/u.test(approval.contractSha256)
    || approval.contractSha256 !== contractSha256) {
    throw new Error("certification approval hash does not match the contract bytes");
  }
  if (!Number.isFinite(Date.parse(approval.approvedAt))) {
    throw new Error("certification approval record has an invalid approvedAt");
  }
  return { approval, sha256: createHash("sha256").update(bytes).digest("hex") };
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
  if (contract?.id !== "lcm-production-certification" || contract?.version !== 2) {
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
  if (contract.calculations.minimumSamples.p50 !== 20
    || contract.calculations.minimumSamples.p95 !== 200
    || p99Minimum !== 1000
    || contract.thresholds.hookCommandMs.minSuccessesForSubgates !== 200) {
    throw new Error("certification contract v2 sample floors changed");
  }
  // Approved v2 hook limits (the only change from v1): pooled p50/p95/p99 600/1500/2500,
  // per-kind and per-machine p95 1500.
  const hook = contract.thresholds.hookCommandMs;
  if (hook.pooled?.p50 !== 600 || hook.pooled?.p95 !== 1500 || hook.pooled?.p99 !== 2500
    || hook.perKindPooledP95 !== 1500 || hook.perMachineP95 !== 1500) {
    throw new Error("certification contract v2 hook limits changed");
  }
  for (const name of ["hookInvocations", "daemonSearch", "daemonStore"]) {
    if (derived[name] < p99Minimum) {
      throw new Error(`certification contract ${name} misses p99 minimum ${p99Minimum}`);
    }
  }
  const subgateMinimum = positiveInteger(contract?.thresholds?.hookCommandMs?.minSuccessesForSubgates, "hook subgate minimum");
  if (derived.userPrompt < subgateMinimum || derived.postTool < subgateMinimum) {
    throw new Error("certification contract hook kind schedule misses subgate minimum");
  }
  const perMachine = contract.workload.expectedPerMachine;
  if (perMachine.hookInvocations * contract.workload.machines !== derived.hookInvocations
    || perMachine.daemonSearch * contract.workload.machines !== derived.daemonSearch
    || perMachine.daemonStore * contract.workload.machines !== derived.daemonStore) {
    throw new Error("certification contract per-machine counts are inconsistent");
  }
  const full = contract.timeline.full;
  if (scheduledCount(full.steadySeconds, 30, 60) !== 100 || scheduledCount(full.steadySeconds, 55, 300) !== 20) {
    throw new Error("certification contract snapshot or compact count changed");
  }
  const managed = contract.lanes.managed;
  if (managed.stopNewWorkAtSeconds + managed.cleanupReserveSeconds !== managed.absoluteDeadlineSeconds
    || contract.thresholds.capacity.totalMax !== 19
    || contract.thresholds.capacity.managedUsableBudget !== 23) {
    throw new Error("certification contract managed or capacity arithmetic changed");
  }
  if (contract.status === "draft" && Object.values(contract.approval).slice(0, 3).some((value) => value !== null)) {
    throw new Error("draft certification contract contains approval evidence");
  }
  return contract;
}

export function loadCertificationContract(path, options = {}) {
  const contractPath = pathOf(path);
  const bytes = readFileSync(contractPath);
  const contract = assertContract(JSON.parse(bytes.toString("utf8")));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const approvalPath = options.approvalPath === undefined
    ? approvalPathFor(contractPath)
    : pathOf(options.approvalPath);
  const loadedApproval = existsSync(approvalPath) ? loadApproval(approvalPath, sha256) : undefined;
  if (options.requireApproved !== false && loadedApproval === undefined) {
    throw new Error("certification contract requires a matching approval record before evidence collection");
  }
  return {
    contract,
    sha256,
    approval: loadedApproval?.approval,
    approvalSha256: loadedApproval?.sha256,
    status: loadedApproval === undefined ? "draft" : "approved",
  };
}
