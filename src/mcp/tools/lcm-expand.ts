export const lcmExpandTool = {
  name: "lcm_expand",
  description: "Decompress a summary node into its full source content by traversing the DAG. Use when a summary references something that needs more detail.",
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
