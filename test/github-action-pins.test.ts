import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertActionPinCoherence,
  assertApprovedActionReferences,
  parseActionReferences,
} from "./github-action-pins.js";
import { describe, expect, it } from "vitest";

const workflowRoot = new URL("../.github/workflows/", import.meta.url);
const actionRoot = new URL("../.github/actions/", import.meta.url);

const approvedRepositories = new Set([
  "actions/cache",
  "actions/checkout",
  "actions/github-script",
  "actions/setup-node",
  "actions/stale",
  "actions/upload-artifact",
  "changesets/action",
  "codecov/codecov-action",
  "github/codeql-action",
  "openai/codex-action",
]);

function actionFiles(root: URL, isActionFile: (name: string) => boolean): URL[] {
  const directory = root.pathname;
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return actionFiles(new URL(`${entry.name}/`, root), isActionFile);
    if (!entry.isFile() || !isActionFile(entry.name)) return [];
    return [new URL(path, "file:")];
  });
}

function referencesFor(file: URL) {
  return parseActionReferences(readFileSync(file, "utf8"), file.pathname);
}

const validSha = "a".repeat(40);
const alternateSha = "b".repeat(40);

describe("GitHub Action pin policy", () => {
  it("allows only approved external actions with immutable pins and version comments", () => {
    const references = [
      ...actionFiles(workflowRoot, (name) => name.endsWith(".yml")),
      ...actionFiles(actionRoot, (name) => name === "action.yml"),
    ].flatMap(referencesFor);

    expect(references).not.toHaveLength(0);
    expect(() => assertApprovedActionReferences(references, approvedRepositories)).not.toThrow();
    expect(() => assertActionPinCoherence(references)).not.toThrow();
  });

  it("rejects tags, floating majors, short or uppercase SHAs, and omitted version comments", () => {
    const cases = [
      `uses: actions/checkout@v4 # v4.2.2`,
      `uses: actions/checkout@4 # v4.2.2`,
      `uses: actions/checkout@${validSha.slice(0, -1)} # v4.2.2`,
      `uses: actions/checkout@${validSha.toUpperCase()} # v4.2.2`,
      `uses: actions/checkout@${validSha}`,
    ];

    for (const source of cases) {
      expect(() => assertApprovedActionReferences(
        parseActionReferences(source, "fixture.yml"),
        approvedRepositories,
      )).toThrow();
    }
  });

  it("rejects unsupported raw uses syntax even beside a valid pinned action", () => {
    const validAction = `- uses: actions/checkout@${validSha} # v4.2.2`;
    const cases = [
      `${validAction}\n- uses: actions/checkout@${alternateSha} #`,
      `${validAction}\n- "uses": actions/checkout@${alternateSha} # v4.2.2`,
      `${validAction}\n- { uses: actions/checkout@${alternateSha} } # v4.2.2`,
    ];

    for (const source of cases) {
      expect(() => assertApprovedActionReferences(
        parseActionReferences(source, "fixture.yml"),
        approvedRepositories,
      )).toThrow();
    }
  });

  it("allows a coherent SHA and version-comment update", () => {
    const references = parseActionReferences(
      [
        "steps:",
        `  - uses: actions/checkout@${alternateSha} # v9.0.0`,
        `  - uses: actions/checkout@${alternateSha} # v9.0.0`,
      ].join("\n"),
      "fixture.yml",
    );

    expect(() => assertApprovedActionReferences(references, approvedRepositories)).not.toThrow();
    expect(() => assertActionPinCoherence(references)).not.toThrow();
  });

  it("rejects divergent CodeQL init and analyze pins", () => {
    const references = parseActionReferences(
      [
        "steps:",
        `  - uses: github/codeql-action/init@${validSha} # v4.0.0`,
        `  - uses: github/codeql-action/analyze@${alternateSha} # v4.0.0`,
      ].join("\n"),
      "codeql.yml",
    );

    expect(() => assertActionPinCoherence(references)).toThrow(/github\/codeql-action/u);
  });

  it("rejects divergent composite cache, restore, and save pins", () => {
    const references = parseActionReferences(
      [
        "steps:",
        `  - uses: actions/cache@${validSha} # v5.0.0`,
        `  - uses: actions/cache/restore@${alternateSha} # v5.0.0`,
        `  - uses: actions/cache/save@${validSha} # v5.0.0`,
      ].join("\n"),
      "action.yml",
    );

    expect(() => assertActionPinCoherence(references)).toThrow(/actions\/cache/u);
  });

  it("rejects divergent Codecov pins between trusted and fork jobs", () => {
    const references = parseActionReferences(
      [
        "steps:",
        `  - uses: codecov/codecov-action@${validSha} # v7.0.0`,
        `  - uses: codecov/codecov-action@${alternateSha} # v7.0.0`,
      ].join("\n"),
      "ci.yml",
    );

    expect(() => assertActionPinCoherence(references)).toThrow(/codecov\/codecov-action/u);
  });

  it("rejects local actions that do not begin with ./", () => {
    const references = parseActionReferences("uses: .github/actions/setup-ci", "fixture.yml");

    expect(() => assertApprovedActionReferences(references, approvedRepositories)).toThrow(/local/u);
  });
});
