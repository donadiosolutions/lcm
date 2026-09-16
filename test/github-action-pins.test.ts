import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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

function isWorkflowFile(name: string): boolean {
  return name.endsWith(".yml") || name.endsWith(".yaml");
}

function isCompositeActionFile(name: string): boolean {
  return name === "action.yml" || name === "action.yaml";
}

function actionFiles(root: URL, isActionFile: (name: string) => boolean): URL[] {
  const directory = fileURLToPath(root);
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return actionFiles(pathToFileURL(path), isActionFile);
    if (!entry.isFile() || !isActionFile(entry.name)) return [];
    return [pathToFileURL(path)];
  });
}

function referencesFor(file: URL) {
  return parseActionReferences(readFileSync(file, "utf8"), fileURLToPath(file));
}

function withActionPolicyRoot<T>(run: (rootPath: string, root: URL) => T): T {
  const rootPath = mkdtempSync(join(tmpdir(), "lcm action policy "));
  try {
    return run(rootPath, pathToFileURL(`${rootPath}${sep}`));
  } finally {
    rmSync(rootPath, { force: true, recursive: true });
  }
}

const validSha = "a".repeat(40);
const alternateSha = "b".repeat(40);
const collisionSha = "0123456789abcdef0123456789abcdef01234567";

describe("GitHub Action pin policy", () => {
  it("traverses action roots whose native paths contain spaces", () => {
    withActionPolicyRoot((rootPath, root) => {
      const nestedPath = join(rootPath, "nested");
      const workflowPath = join(nestedPath, "example.yml");
      mkdirSync(nestedPath, { recursive: true });
      writeFileSync(workflowPath, `uses: actions/checkout@${validSha} # v4.2.2\n`);

      const files = actionFiles(root, isWorkflowFile);

      expect(files.map(fileURLToPath)).toEqual([workflowPath]);
    });
  });

  it("discovers only exact workflow and composite action filenames", () => {
    withActionPolicyRoot((rootPath) => {
      const workflowsPath = join(rootPath, "workflows", "nested");
      const actionsPath = join(rootPath, "actions", "nested");
      mkdirSync(workflowsPath, { recursive: true });
      mkdirSync(actionsPath, { recursive: true });

      const workflowYml = join(workflowsPath, "example.yml");
      const workflowYaml = join(workflowsPath, "example.yaml");
      const actionYml = join(actionsPath, "action.yml");
      const actionYaml = join(actionsPath, "action.yaml");
      const ignoredPaths = [
        join(workflowsPath, "example.YAML"),
        join(actionsPath, "action.YAML"),
        join(actionsPath, "action.yaml.bak"),
        join(actionsPath, "my-action.yaml"),
      ];
      for (const path of [workflowYml, workflowYaml, actionYml, actionYaml, ...ignoredPaths]) {
        writeFileSync(path, `uses: actions/checkout@${validSha} # v4.2.2\n`);
      }

      const files = [
        ...actionFiles(pathToFileURL(join(rootPath, "workflows")), isWorkflowFile),
        ...actionFiles(pathToFileURL(join(rootPath, "actions")), isCompositeActionFile),
      ].map(fileURLToPath).sort();

      expect(files).toEqual([workflowYml, workflowYaml, actionYml, actionYaml].sort());
    });
  });

  it("enforces pins in nested .yaml workflow files", () => {
    withActionPolicyRoot((rootPath) => {
      const workflowsPath = join(rootPath, "workflows");
      const nestedPath = join(workflowsPath, "nested");
      const badPath = join(nestedPath, "bad.yaml");
      const badFileUrl = pathToFileURL(badPath);
      mkdirSync(nestedPath, { recursive: true });
      writeFileSync(join(workflowsPath, "valid.yml"),
        `uses: actions/checkout@${validSha} # v4.2.2\n`);
      writeFileSync(badPath, "uses: actions/checkout@main # v4.2.2\n");

      const references = actionFiles(pathToFileURL(workflowsPath), isWorkflowFile)
        .flatMap(referencesFor);
      const assertApproved = () => assertApprovedActionReferences(
        references,
        approvedRepositories,
      );

      expect(assertApproved).toThrow(/must use a lowercase 40-hex SHA/u);
      expect(assertApproved).toThrow(fileURLToPath(badFileUrl));
    });
  });

  it("enforces pins in nested action.yaml composite files", () => {
    withActionPolicyRoot((rootPath) => {
      const actionsPath = join(rootPath, "actions");
      const validPath = join(actionsPath, "valid");
      const badPath = join(actionsPath, "nested", "action.yaml");
      const badFileUrl = pathToFileURL(badPath);
      mkdirSync(validPath, { recursive: true });
      mkdirSync(join(actionsPath, "nested"), { recursive: true });
      writeFileSync(join(validPath, "action.yml"),
        `uses: actions/checkout@${validSha} # v4.2.2\n`);
      writeFileSync(badPath, "uses: actions/checkout@main # v4.2.2\n");

      const references = actionFiles(pathToFileURL(actionsPath), isCompositeActionFile)
        .flatMap(referencesFor);
      const assertApproved = () => assertApprovedActionReferences(
        references,
        approvedRepositories,
      );

      expect(assertApproved).toThrow(/must use a lowercase 40-hex SHA/u);
      expect(assertApproved).toThrow(fileURLToPath(badFileUrl));
    });
  });

  it("allows only approved external actions with immutable pins and version comments", () => {
    const references = [
      ...actionFiles(workflowRoot, isWorkflowFile),
      ...actionFiles(actionRoot, isCompositeActionFile),
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

  it("rejects quoted and flow uses fields despite same-target block-scalar decoys", () => {
    const action = `actions/checkout@${collisionSha}`;
    const unsupportedForms = [
      `  - "uses": ${action}`,
      `  - { uses: ${action} }`,
    ];
    const scalarIndicators = ["|", "|-", "|+", "|2-", ">", ">-", ">+", ">2+"];

    for (const indicator of scalarIndicators) {
      for (const unsupported of unsupportedForms) {
        const source = [
          `decoy: ${indicator}`,
          `  uses: ${action} # v4.2.2`,
          "steps:",
          `  - uses: ${action} # v4.2.2`,
          unsupported,
        ].join("\n");

        expect(() => assertApprovedActionReferences(
          parseActionReferences(source, "fixture.yml"),
          approvedRepositories,
        )).toThrow();
      }
    }
  });

  it("rejects quoted and flow uses fields despite sequence-scalar decoys", () => {
    const action = `actions/checkout@${collisionSha}`;
    const unsupportedForms = [
      `  - "uses": ${action}`,
      `  - { uses: ${action} }`,
    ];
    const scalarIndicators = ["|", "|-", "|2-", ">", ">+", ">2+"];

    for (const indicator of scalarIndicators) {
      for (const unsupported of unsupportedForms) {
        const source = [
          "decoy:",
          `  - ${indicator}`,
          `    uses: ${action} # v4.2.2`,
          "steps:",
          `  - uses: ${action} # v4.2.2`,
          unsupported,
        ].join("\n");

        expect(() => assertApprovedActionReferences(
          parseActionReferences(source, "fixture.yml"),
          approvedRepositories,
        )).toThrow();
      }
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
