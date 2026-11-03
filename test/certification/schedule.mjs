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
