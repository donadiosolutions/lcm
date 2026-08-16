export const lcmStoreTool = {
  name: "lcm_store",
  description: "Store a memory in Long Context Manager (LCM)'s semantic layer. Stored memories can be retrieved with lcm_search.",
  inputSchema: {
    type: "object" as const,
    properties: {
      text: { type: "string", description: "The content to store" },
      tags: {
        type: "array",
        items: { type: "string" },
        description: "Optional string tags associated with the memory. Each tag uses the <prefix>:<value> format.",
      },
      metadata: {
        type: "object",
        description: "Optional key/value metadata (e.g. projectId, sessionId, source)",
        additionalProperties: true,
      },
    },
    required: ["text"],
  },
};
