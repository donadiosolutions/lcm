import { parseCodexTranscript, parseCodexTranscriptText } from "./codex-transcript.js";
import { parseTranscript, parseTranscriptText, type ParsedMessage } from "./transcript.js";

export type TranscriptClient = "claude" | "codex";

export function normalizeTranscriptClient(value: unknown): TranscriptClient {
  return value === "codex" ? "codex" : "claude";
}

export function parseTranscriptForClient(
  transcriptPath: string,
  client: TranscriptClient,
): ParsedMessage[] {
  return client === "codex"
    ? parseCodexTranscript(transcriptPath)
    : parseTranscript(transcriptPath);
}

export function parseTranscriptTextForClient(raw: string, client: TranscriptClient): ParsedMessage[] {
  return client === "codex" ? parseCodexTranscriptText(raw) : parseTranscriptText(raw);
}
