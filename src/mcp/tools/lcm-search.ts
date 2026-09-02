import { CANONICAL_SEARCH_LAYERS, DEFAULT_SEARCH_LAYERS } from "../../retrieval.js";

export const lcmSearchTool = {
  name: "lcm_search",
  description: "Hybrid search across episodic and promoted memory. Returns two separate ranked lists — episodic and promoted. Use when looking for project knowledge spanning multiple sessions.",
  inputSchema: {
    type: "object" as const,
    properties: {
      query: { type: "string", description: "Natural language search query" },
      limit: { type: "number", description: "Max results per layer (default: 5)" },
      layers: { type: "array", items: { type: "string", enum: [...CANONICAL_SEARCH_LAYERS] }, default: [...DEFAULT_SEARCH_LAYERS], description: "Which memory layers to search (default: both)" },
      tags: { type: "array", items: { type: "string" }, description: "Filter results to entries that include all specified tags (e.g. ['reasoning'], ['decision', 'architecture'])" },
    },
    required: ["query"],
  },
};
