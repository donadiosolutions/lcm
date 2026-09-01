import { describe, expect, it } from "vitest";
import {
  CANONICAL_GREP_SCOPES,
  CANONICAL_SEARCH_LAYERS,
  DEFAULT_GREP_SCOPE,
  DEFAULT_SEARCH_LAYERS,
  normalizeGrepScope,
  normalizeSearchLayers,
} from "../src/retrieval.js";

describe("canonical memory operation contracts", () => {
  it("exposes immutable canonical values and defaults", () => {
    expect(CANONICAL_SEARCH_LAYERS).toEqual(["episodic", "promoted"]);
    expect(CANONICAL_GREP_SCOPES).toEqual(["messages", "summaries", "both"]);
    expect(DEFAULT_SEARCH_LAYERS).toEqual(["episodic", "promoted"]);
    expect(DEFAULT_GREP_SCOPE).toBe("both");
    expect(Object.isFrozen(CANONICAL_SEARCH_LAYERS)).toBe(true);
    expect(Object.isFrozen(CANONICAL_GREP_SCOPES)).toBe(true);
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
});
