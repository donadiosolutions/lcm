function scheduleCount(duration, first, every) {
  return first >= duration ? 0 : Math.floor((duration - 1 - first) / every) + 1;
}
export function createDeterministicSchedule({ profile, machine, runId, idNamespace = runId, contract }) {
  const duration = profile === "full" ? (contract?.timeline?.full?.steadySeconds ?? 6000) : (contract?.timeline?.smoke?.steadySeconds ?? 120);
  const bytesCycle = contract?.workload?.primaryTextBytesCycle ?? [256, 1024, 1024, 6144];
  const schedule = [];
  const add = (op, first, every, extra = () => ({})) => {
    for (let index = 0; index < scheduleCount(duration, first, every); index += 1) {
      schedule.push({ id: `${idNamespace}-${machine}-${op}-${index}`, machine, op, index, offsetSeconds: first + every * index, ...extra(index) });
    }
  };
  add("hook", 1, 10, (index) => ({
    kind: index % 4 === 0 ? "user-prompt" : "post-tool",
    sessionId: `cert-${runId}-${machine}-s${index % 4}`,
    primaryTextBytes: bytesCycle[Math.floor(index / 4) % bytesCycle.length],
  }));
  add("search", 2, 5);
  add("store", 4, 10);
  add("snapshot", 30, 60, () => ({ sessionId: `cert-${runId}-${machine}-s0` }));
  add("compact", 55, 300, () => ({ sessionId: `cert-${runId}-${machine}-s0` }));
  return schedule.sort((left, right) => left.offsetSeconds - right.offsetSeconds || left.id.localeCompare(right.id));
}

export function createFaultSchedule({ machine, runId, phase, durationSeconds }) {
  const schedule = [];
  for (let offsetSeconds = 2, index = 0; offsetSeconds < durationSeconds; offsetSeconds += 5, index += 1) {
    schedule.push({ id: `${runId}-${phase}-${machine}-search-${index}`, machine, op: "search", phase, offsetSeconds });
  }
  for (let offsetSeconds = 4, index = 0; offsetSeconds < durationSeconds; offsetSeconds += 10, index += 1) {
    schedule.push({ id: `${runId}-${phase}-${machine}-store-${index}`, machine, op: "store", phase, offsetSeconds });
  }
  return schedule.sort((left, right) => left.offsetSeconds - right.offsetSeconds || left.id.localeCompare(right.id));
}

export function createObservabilityWorkloadSchedule({
  machine,
  runId,
  phase,
  durationSeconds,
  includeHooks = false,
}) {
  if (!['a', 'b'].includes(machine) || typeof phase !== "string" || phase.length === 0
    || !Number.isSafeInteger(durationSeconds) || durationSeconds <= 0) {
    throw new Error("invalid observability workload schedule");
  }
  // The saturation step sends no store: a store takes the daemon's publication queue, and
  // under the relation lock every later request then queues behind it.
  const searchesOnly = phase === "saturation";
  const schedule = createFaultSchedule({ machine, runId, phase, durationSeconds })
    .filter((entry) => !searchesOnly || entry.op === "search");
  if (["saturation", "timeout", "stats-reset", "permission-loss", "extension-loss"].includes(phase)) {
    schedule.push(
      { id: `${runId}-${phase}-${machine}-overlap-search-0`, machine, op: "search", phase, offsetSeconds: 0 },
      { id: `${runId}-${phase}-${machine}-overlap-search-1`, machine, op: "search", phase, offsetSeconds: 0 },
      ...(searchesOnly ? [] : [{ id: `${runId}-${phase}-${machine}-overlap-store-0`, machine, op: "store", phase, offsetSeconds: 0 }]),
    );
  }
  // Saturation induction on machine B: promoted-layer searches read the locked relation, so
  // two hold the daemon's two pool connections until their 5-second search statement cap
  // and the rest wait for a connection. Four start at once (the agent's admission cap) and
  // two more follow every 5 seconds through the 20-second witness bound.
  if (phase === "saturation" && machine === "b") {
    [0, 0, 0, 0, 5, 5, 10, 10, 15, 15].forEach((offsetSeconds, index) => schedule.push({
      id: `${runId}-saturation-b-induction-search-${index}`, machine, op: "search", phase, offsetSeconds, layers: ["promoted"],
    }));
  }
  if (includeHooks) {
    for (let offsetSeconds = 1, index = 0; offsetSeconds < durationSeconds; offsetSeconds += 10, index += 1) {
      schedule.push({
        id: `${runId}-${phase}-${machine}-hook-${index}`,
        machine,
        op: "hook",
        kind: index % 2 === 0 ? "user-prompt" : "post-tool",
        sessionId: `cert-${runId}-${machine}-observability`,
        primaryTextBytes: 256,
        phase,
        offsetSeconds,
      });
    }
  }
  return schedule.sort((left, right) => left.offsetSeconds - right.offsetSeconds || left.id.localeCompare(right.id));
}

export function observabilityPhaseWorkloadSeconds(contract, phase) {
  const holdKey = phase === "saturation" ? "saturationWitness"
    : phase === "permission-loss" ? "permissionLoss"
      : phase === "extension-loss" ? "extensionLoss"
        : phase === "stats-reset" ? "statsReset" : phase;
  const hold = phase === "queue-backlog" ? contract.timeline.full.backlogHoldMaxSeconds
    : phase === "canary" ? contract.timeline.full.canaryPhaseMaxSeconds
      : contract.observability.faultHoldMaximumSeconds[holdKey];
  if (!Number.isSafeInteger(hold) || hold <= 0) throw new Error(`invalid observability phase duration ${phase}`);
  return Math.max(30, hold);
}
