export function assertMergeQueueUsesMerge(appliedRules) {
  if (!Array.isArray(appliedRules)) {
    throw new TypeError("Applied default-branch rules must be an array");
  }
  if (
    appliedRules.some(
      (rule) => rule === null || typeof rule !== "object" || Array.isArray(rule),
    )
  ) {
    throw new Error("The applied default-branch rules response was malformed");
  }

  const queueRules = appliedRules.filter((rule) => rule.type === "merge_queue");
  if (queueRules.length === 0) {
    throw new Error("No merge-queue rule applies to the repository default branch");
  }
  for (const rule of queueRules) {
    if (rule.parameters?.merge_method !== "MERGE") {
      throw new Error("Every merge queue applied to the default branch must use MERGE");
    }
  }
  return { queueCount: queueRules.length };
}
