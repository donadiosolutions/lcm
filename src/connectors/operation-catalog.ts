export type LcmCliSpelling = `lcm ${string}`;
export type LcmMcpSpelling = `lcm_${string}`;

export interface LcmOperation {
  readonly name: string;
  readonly purpose: string;
  readonly lifecycleTrigger: string;
  readonly cli: LcmCliSpelling;
  readonly mcp: LcmMcpSpelling;
}

export const LCM_OPERATION_CATALOG = [
  {
    name: "search",
    purpose: "Recall relevant durable and episodic memory.",
    lifecycleTrigger:
      "Use automatically injected memory first; run this operation only when injected context is absent or insufficient.",
    cli: 'lcm search "query"',
    mcp: "lcm_search",
  },
  {
    name: "grep",
    purpose: "Find an exact keyword or regular-expression match in prior context.",
    lifecycleTrigger:
      "Run only when injected context and broad recall are insufficient and a precise match is needed.",
    cli: 'lcm grep "pattern" --mode regex',
    mcp: "lcm_grep",
  },
  {
    name: "describe",
    purpose: "Inspect a recalled node before retrieving more detail.",
    lifecycleTrigger: "Run only on demand when node metadata will guide deeper retrieval.",
    cli: "lcm describe <nodeId>",
    mcp: "lcm_describe",
  },
  {
    name: "expand",
    purpose: "Recover source detail from a recalled summary node.",
    lifecycleTrigger: "Run only on demand when the available summary is insufficient.",
    cli: "lcm expand <nodeId> --depth N",
    mcp: "lcm_expand",
  },
  {
    name: "store",
    purpose: "Persist durable knowledge with enough context to reuse later.",
    lifecycleTrigger:
      "Agents MUST immediately store every newly recognized durable decision, preference, root cause, pattern, gotcha, solution, and reusable workflow, including its rationale.",
    cli: 'lcm store "memory with rationale"',
    mcp: "lcm_store",
  },
  {
    name: "doctor",
    purpose: "Inspect LCM installation health.",
    lifecycleTrigger: "Run only on demand when troubleshooting LCM.",
    cli: "lcm doctor",
    mcp: "lcm_doctor",
  },
  {
    name: "stats",
    purpose: "Inspect memory inventory and compression outcomes.",
    lifecycleTrigger: "Run only when explicitly investigating LCM usage outcomes.",
    cli: "lcm stats",
    mcp: "lcm_stats",
  },
] as const satisfies readonly LcmOperation[];

export type LcmOperationName = (typeof LCM_OPERATION_CATALOG)[number]["name"];

const [
  searchOperation,
  grepOperation,
  describeOperation,
  expandOperation,
  storeOperation,
  doctorOperation,
] = LCM_OPERATION_CATALOG;

const PASSIVE_CAPTURE_POLICY =
  "Automatic/passive capture is complementary and never a substitute for explicit durable storage.";

export function renderOperationalGuidance(): string {
  return [
    "## Required Workflow",
    "",
    `- \`${searchOperation.mcp}\` / \`${searchOperation.cli}\` — ${searchOperation.purpose} ${searchOperation.lifecycleTrigger}`,
    `- \`${grepOperation.mcp}\` / \`${grepOperation.cli}\` — ${grepOperation.purpose} ${grepOperation.lifecycleTrigger}`,
    `- \`${storeOperation.mcp}\` / \`${storeOperation.cli}\` — ${storeOperation.purpose} ${storeOperation.lifecycleTrigger}`,
    `- ${PASSIVE_CAPTURE_POLICY}`,
    `- When recalled memory affects the work, record feedback with \`${storeOperation.mcp}\` using both tags \`signal:memory_used\` and \`memory_id:<actual-id>\`. If MCP tools are unavailable, use \`lcm store "memory-used feedback" --tag signal:memory_used --tag memory_id:<actual-id>\`.`,
    "",
    "## Advanced Operations",
    "",
    "Use these advanced operations only on demand:",
    "",
    `- \`${describeOperation.mcp}\` / \`${describeOperation.cli}\` — ${describeOperation.purpose} ${describeOperation.lifecycleTrigger}`,
    `- \`${expandOperation.mcp}\` / \`${expandOperation.cli}\` — ${expandOperation.purpose} ${expandOperation.lifecycleTrigger}`,
    `- \`${doctorOperation.mcp}\` / \`${doctorOperation.cli}\` — ${doctorOperation.purpose} ${doctorOperation.lifecycleTrigger}`,
  ].join("\n");
}

export function renderCanonicalSkill(): string {
  return [
    "---",
    "name: lcm-memory",
    `description: "${storeOperation.lifecycleTrigger} Use automatically injected memory first; automatic/passive capture is complementary and never a substitute for explicit durable storage."`,
    "---",
    "",
    "# Long Context Manager (LCM)",
    "",
    renderOperationalGuidance(),
    "",
  ].join("\n");
}
