import { describe, expect, it } from "vitest";
import {
  TRANSCRIPT_SLOT_METADATA_KEY,
  encodeTranscriptSlotMarker,
  parseTranscriptSlotMarker,
} from "../../src/storage/contracts.js";

describe("transcript slot marker", () => {
  it("round-trips the consumed flag under the versioned metadata key", () => {
    expect(JSON.parse(encodeTranscriptSlotMarker(true))).toEqual({
      [TRANSCRIPT_SLOT_METADATA_KEY]: { version: 1, consumed: true },
    });
    expect(parseTranscriptSlotMarker(encodeTranscriptSlotMarker(true))).toBe(true);
    expect(parseTranscriptSlotMarker(encodeTranscriptSlotMarker(false))).toBe(false);
  });

  it.each([
    ["null metadata", null],
    ["malformed JSON", "{not json"],
    ["a JSON array", "[1]"],
    ["a JSON scalar", "7"],
    ["a JSON null", "null"],
    ["another key", JSON.stringify({ other: { version: 1, consumed: true } })],
    ["a scalar marker", JSON.stringify({ lcmTranscriptSlot: 1 })],
    ["a null marker", JSON.stringify({ lcmTranscriptSlot: null })],
    ["an array marker", JSON.stringify({ lcmTranscriptSlot: [] })],
    ["another version", JSON.stringify({ lcmTranscriptSlot: { version: 2, consumed: true } })],
    ["a non-boolean flag", JSON.stringify({ lcmTranscriptSlot: { version: 1, consumed: "true" } })],
  ])("treats %s as foreign metadata", (_case, metadata) => {
    expect(parseTranscriptSlotMarker(metadata)).toBeNull();
  });
});
