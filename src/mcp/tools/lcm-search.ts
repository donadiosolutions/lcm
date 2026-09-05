import {
  CANONICAL_SEARCH_LAYERS,
  DEFAULT_SEARCH_LAYERS,
  DEFAULT_SEARCH_RESULT_LIMIT,
  MAX_SEARCH_RESULT_LIMIT,
} from "../../retrieval.js";

export const lcmSearchTool = {
  name: "lcm_search",
  description: "Hybrid search across episodic and promoted memory. Returns two separate ranked lists — episodic and promoted. Use when looking for project knowledge spanning multiple sessions.",
  inputSchema: {
    type: "object" as const,
    properties: {
      query: { type: "string", description: "Natural language search query" },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: MAX_SEARCH_RESULT_LIMIT,
        default: DEFAULT_SEARCH_RESULT_LIMIT,
        description: `Maximum results per layer (positive integer from 1 to ${MAX_SEARCH_RESULT_LIMIT}; default: ${DEFAULT_SEARCH_RESULT_LIMIT})`,
      },
      layers: { type: "array", items: { type: "string", enum: [...CANONICAL_SEARCH_LAYERS] }, default: [...DEFAULT_SEARCH_LAYERS], description: "Which memory layers to search (default: both)" },
      tags: {
        type: "array",
        items: { type: "string" },
        description: "Filter promoted results to entries that include all specified tags; episodic results remain unfiltered. Use layers: ['promoted'] for tag-only recall (e.g. ['reasoning'], ['decision', 'architecture'])",
      },
    },
    required: ["query"],
  },
};
