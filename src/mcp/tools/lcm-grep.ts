import {
  CANONICAL_GREP_MODES,
  CANONICAL_GREP_SCOPES,
  DEFAULT_GREP_MODE,
  DEFAULT_GREP_SCOPE,
} from "../../retrieval.js";

export const lcmGrepTool = {
  name: "lcm_grep",
  description: "Search conversation history by keyword or regex across raw messages and summaries. Use when recalling what was said, decided, or done in a past session.",
  inputSchema: {
    type: "object" as const,
    properties: {
      query: {
        type: "string",
        description: "Keyword, phrase, or pattern to search; interpretation follows mode (full_text by default, regex when selected)",
      },
      mode: {
        type: "string",
        enum: [...CANONICAL_GREP_MODES],
        default: DEFAULT_GREP_MODE,
        description: "Search mode: full_text performs literal/full-text matching; regex interprets the query as a regular expression",
      },
      scope: { type: "string", enum: [...CANONICAL_GREP_SCOPES], default: DEFAULT_GREP_SCOPE },
      sessionId: { type: "string", description: "Filter to a specific session" },
      since: {
        type: "string",
        description: "inclusive ISO datetime lower bound: YYYY-MM-DDTHH:mm:ss with optional 1-3 fractional digits and Z or +/-HH:mm timezone; after offset normalization, UTC years must be 0001-9999; malformed or out-of-range values return HTTP 400 with invalid since; omitted to include all history",
      },
    },
    required: ["query"],
  },
};
