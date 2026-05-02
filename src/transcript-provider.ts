import { parseCodexTranscript } from "./codex-transcript.js";
import { parseTranscript, type ParsedMessage } from "./transcript.js";

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
