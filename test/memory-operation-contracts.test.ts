import { describe, expect, it } from "vitest";
import {
  CANONICAL_GREP_SCOPES,
  CANONICAL_GREP_MODES,
  CANONICAL_SEARCH_LAYERS,
  DEFAULT_SEARCH_RESULT_LIMIT,
  MAX_SEARCH_RESULT_LIMIT,
  DEFAULT_GREP_MODE,
  DEFAULT_GREP_SCOPE,
  DEFAULT_SEARCH_LAYERS,
  normalizeGrepScope,
  normalizeGrepMode,
  normalizeSearchLayers,
  normalizeSearchLimit,
} from "../src/retrieval.js";

describe("canonical memory operation contracts", () => {
  it("exposes immutable canonical values and defaults", () => {
    expect(CANONICAL_SEARCH_LAYERS).toEqual(["episodic", "promoted"]);
    expect(CANONICAL_GREP_SCOPES).toEqual(["messages", "summaries", "both"]);
    expect(CANONICAL_GREP_MODES).toEqual(["full_text", "regex"]);
    expect(DEFAULT_SEARCH_LAYERS).toEqual(["episodic", "promoted"]);
    expect(DEFAULT_SEARCH_RESULT_LIMIT).toBe(5);
    expect(MAX_SEARCH_RESULT_LIMIT).toBe(1000);
    expect(DEFAULT_GREP_SCOPE).toBe("both");
    expect(DEFAULT_GREP_MODE).toBe("full_text");
    expect(Object.isFrozen(CANONICAL_SEARCH_LAYERS)).toBe(true);
    expect(Object.isFrozen(CANONICAL_GREP_SCOPES)).toBe(true);
    expect(Object.isFrozen(CANONICAL_GREP_MODES)).toBe(true);
    expect(Object.isFrozen(DEFAULT_SEARCH_LAYERS)).toBe(true);
  });

  it.each([
    [undefined, ["episodic", "promoted"]],
    [[], []],
    [["episodic"], ["episodic"]],
    [["promoted"], ["promoted"]],
    [["promoted", "episodic"], ["promoted", "episodic"]],
    [["episodic", "episodic", "promoted"], ["episodic", "promoted"]],
    [["semantic"], ["promoted"]],
    [["semantic", "promoted"], ["promoted"]],
    [["promoted", "semantic", "episodic"], ["promoted", "episodic"]],
  ])("normalizes valid search layers %j", (input, expected) => {
    expect(normalizeSearchLayers(input)).toEqual(expected);
  });

  it.each([
    null,
    "episodic",
    ["episodic", 1],
    ["unknown"],
    ["semantic", "unknown"],
  ])("rejects invalid search layers %j", (input) => {
    expect(normalizeSearchLayers(input)).toBeNull();
  });

  it.each([
    [undefined, "both"],
    ["messages", "messages"],
    ["summaries", "summaries"],
    ["both", "both"],
    ["all", "both"],
  ])("normalizes valid grep scope %j", (input, expected) => {
    expect(normalizeGrepScope(input)).toBe(expected);
  });

  it.each([null, 1, "unknown", [], {}])("rejects invalid grep scope %j", (input) => {
    expect(normalizeGrepScope(input)).toBeNull();
  });

  it.each([[undefined, "full_text"], ["full_text", "full_text"], ["regex", "regex"]])(
    "normalizes valid grep mode %j",
    (input, expected) => {
      expect(normalizeGrepMode(input)).toBe(expected);
    },
  );

  it.each([null, 1, "unknown", [], {}])("rejects invalid grep mode %j", (input) => {
    expect(normalizeGrepMode(input)).toBeNull();
  });

  it.each([
    [undefined, 5],
    [1, 1],
    [5, 5],
    [1000, 1000],
  ])("normalizes valid search limits %j", (input, expected) => {
    expect(normalizeSearchLimit(input)).toBe(expected);
  });

  it.each([0, -0, -1, 1.5, 1001, NaN, Infinity, -Infinity, "5", null, true, {}, []])(
    "rejects invalid search limit %j",
    (input) => {
      expect(normalizeSearchLimit(input)).toBeNull();
    },
  );
});
