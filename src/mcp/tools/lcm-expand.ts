export const lcmExpandTool = {
  name: "lcm_expand",
  description: "Traverse a summary node's DAG links and return its child summaries as short snippets. Use when a condensed summary references detail recorded in its children; this tool does not return raw source messages.",
  inputSchema: {
    type: "object" as const,
    properties: {
      nodeId: { type: "string", description: "Summary node ID to expand" },
      depth: {
        type: "integer",
        minimum: 1,
        default: 1,
        description: "How many levels of the DAG to traverse (positive integer; default: 1; no maximum)",
      },
    },
    required: ["nodeId"],
  },
};
