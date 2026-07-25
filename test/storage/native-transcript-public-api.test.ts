import { describe, expect, it } from "vitest";
import {
  CLAUDE_NATIVE_TRANSCRIPT_FORMAT,
  createNativeTranscriptScrubber,
  NativeTranscriptConfigurationError,
  openLocalTranscriptQuarantine,
  PostgreSqlNativeTranscriptRepository,
  runNativeTranscriptBackfill,
} from "../../src/storage/native-transcripts.js";

describe("native transcript package subpath", () => {
  it("exposes the staged embedded API without backend activation", () => {
    expect(CLAUDE_NATIVE_TRANSCRIPT_FORMAT.clientName).toBe("claude-code");
    expect(createNativeTranscriptScrubber).toBeTypeOf("function");
    expect(runNativeTranscriptBackfill).toBeTypeOf("function");
    expect(openLocalTranscriptQuarantine).toBeTypeOf("function");
    expect(PostgreSqlNativeTranscriptRepository).toBeTypeOf("function");
    expect(NativeTranscriptConfigurationError).toBeTypeOf("function");
  });
});
