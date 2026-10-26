function scheduleCount(duration, first, every) {
  return first >= duration ? 0 : Math.floor((duration - 1 - first) / every) + 1;
}
export function createDeterministicSchedule({ profile, machine, runId }) {
  const duration = profile === "full" ? 6000 : 120;
  const schedule = [];
  const add = (op, first, every, extra = () => ({})) => {
    for (let index = 0; index < scheduleCount(duration, first, every); index += 1) {
      schedule.push({ id: `${runId}-${machine}-${op}-${index}`, machine, op, index, offsetSeconds: first + every * index, ...extra(index) });
    }
  };
  add("hook", 1, 10, (index) => ({
    kind: index % 4 === 0 ? "user-prompt" : "post-tool",
    sessionId: `cert-${runId}-${machine}-s${index % 4}`,
    primaryTextBytes: [256, 1024, 1024, 8192][Math.floor(index / 4) % 4],
  }));
  add("search", 2, 5);
  add("store", 4, 10);
  add("snapshot", 30, 60, () => ({ sessionId: `cert-${runId}-${machine}-s0` }));
  add("compact", 55, 300, () => ({ sessionId: `cert-${runId}-${machine}-s0` }));
  return schedule.sort((left, right) => left.offsetSeconds - right.offsetSeconds || left.id.localeCompare(right.id));
}
