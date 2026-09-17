import { readFileSync } from "node:fs";

interface ContentBlock {
  type?: string;
  text?: string;
  content?: string | ContentBlock[];
}

interface TranscriptLine {
  type?: string;
  message?: {
    role?: string;
    content?: string | ContentBlock[];
  };
}

export interface ParsedMessage {
  role: string;
  content: string;
  tokenCount: number;
}

function extractText(content: string | ContentBlock[] | unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((member: unknown) => {
        if (
          member === null
          || typeof member !== "object"
          || Array.isArray(member)
        ) return "";
        const block = member as Record<string, unknown>;
        if (block.type === "text" && typeof block.text === "string") return block.text;
        if (block.type === "tool_result") return extractText(block.content);
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export function parseTranscript(transcriptPath: string): ParsedMessage[] {
  let raw: string;
  try {
    raw = readFileSync(transcriptPath, "utf-8");
  } catch {
    return [];
  }

  return parseTranscriptText(raw);
}

/** Parse already-bound transcript bytes without reopening a pathname. */
export function parseTranscriptText(raw: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj: TranscriptLine = JSON.parse(trimmed);
      const role = obj.message?.role;
      if (!role || !["user", "assistant", "system"].includes(role)) continue;
      const content = extractText(obj.message?.content);
      if (!content.trim()) continue;
      messages.push({ role, content, tokenCount: estimateTokens(content) });
    } catch {
      // skip malformed lines
    }
  }
  return messages;
}
