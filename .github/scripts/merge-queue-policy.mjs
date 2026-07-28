export function assertMergeQueueUsesMerge(rulesets) {
  if (!Array.isArray(rulesets)) throw new TypeError("Repository rulesets must be an array");

  const queueRules = [];
  for (const ruleset of rulesets) {
    if (
      ruleset === null ||
      typeof ruleset !== "object" ||
      Array.isArray(ruleset) ||
      ruleset.enforcement !== "active" ||
      ruleset.target !== "branch"
    ) {
      continue;
    }
    if (!Array.isArray(ruleset.rules)) {
      throw new Error("An active branch ruleset did not include its rules");
    }
    for (const rule of ruleset.rules) {
      if (rule?.type === "merge_queue") queueRules.push(rule);
    }
  }

  if (queueRules.length === 0) {
    throw new Error("No active branch merge-queue rule protects release ancestry");
  }
  for (const rule of queueRules) {
    if (rule.parameters?.merge_method !== "MERGE") {
      throw new Error("Every active branch merge queue must use the MERGE method");
    }
  }
  return { queueCount: queueRules.length };
}
