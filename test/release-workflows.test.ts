import { readFileSync } from "node:fs";
import { load as loadYaml } from "js-yaml";
import { describe, expect, it } from "vitest";

interface WorkflowStep {
  id?: string;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
}

interface WorkflowJob {
  if?: string;
  "runs-on": string;
  environment?: string;
  permissions?: Record<string, string>;
  concurrency?: {
    group: string;
    "cancel-in-progress": boolean;
  };
  steps: WorkflowStep[];
}

interface VersionWorkflow {
  on: {
    push: { branches: string[] };
    workflow_dispatch: { inputs: { channel: { options: string[] } } };
  };
  concurrency: { group: string; "cancel-in-progress": boolean };
  jobs: { version: WorkflowJob };
}

interface PublishWorkflow {
  on: {
    push: { tags: string[] };
    release: { types: string[] };
    workflow_dispatch?: never;
  };
  concurrency: { group: string; "cancel-in-progress": boolean };
  jobs: { draft: WorkflowJob; publish: WorkflowJob };
}

const versionSource = readFileSync(new URL("../.github/workflows/version-pr.yml", import.meta.url), "utf8");
const publishSource = readFileSync(new URL("../.github/workflows/publish.yml", import.meta.url), "utf8");
const changesetSource = readFileSync(
  new URL("../.changeset/calm-betas-draft.md", import.meta.url),
  "utf8",
);
const versionWorkflow = loadYaml(versionSource) as VersionWorkflow;
const publishWorkflow = loadYaml(publishSource) as PublishWorkflow;
const highlightsSchema = JSON.parse(
  readFileSync(new URL("../.github/codex/release-highlights.schema.json", import.meta.url), "utf8"),
);

describe("release workflows", () => {
  it("uses a serialized, main-based Changesets workflow with explicit beta transitions", () => {
    expect(versionWorkflow.on.push.branches).toEqual(["main"]);
    expect(versionWorkflow.on.workflow_dispatch.inputs.channel.options).toEqual(["beta", "stable"]);
    expect(versionWorkflow.concurrency).toEqual({
      group: "version-packages-main",
      "cancel-in-progress": false,
    });
    expect(versionWorkflow.jobs.version["runs-on"]).toBe("ubuntu-latest");
    const changesets = versionWorkflow.jobs.version.steps.find((step) => step.id === "changesets");
    expect(changesets?.with).toMatchObject({
      branch: "main",
      commitMode: "github-api",
      version: "npm run version-packages",
      createGithubReleases: false,
    });
    expect(changesets?.env?.LCM_RELEASE_CHANNEL).toContain("inputs.channel");
    const releaseNoteExclusion = versionWorkflow.jobs.version.steps.find(
      (step) => step.name === "Exclude version PR from release notes",
    );
    expect(releaseNoteExclusion?.with?.script).toContain('const name = "no-release-notes"');
    expect(releaseNoteExclusion?.with?.script).toContain("labels: [name]");
    expect(releaseNoteExclusion?.with?.script).not.toContain('"chore"');
    expect(releaseNoteExclusion?.with?.script).not.toContain('"release-workflow"');
  });

  it("separates tag-driven drafts from manually published npm releases", () => {
    expect(publishWorkflow.on.push.tags).toEqual(["v*.*.*"]);
    expect(publishWorkflow.on.release.types).toEqual(["published"]);
    expect(publishWorkflow.on).not.toHaveProperty("workflow_dispatch");
    expect(publishWorkflow.jobs.draft.if).toContain("github.event_name == 'push'");
    expect(publishWorkflow.jobs.publish.if).toContain("github.event_name == 'release'");
    expect(publishWorkflow.jobs.draft["runs-on"]).toBe("ubuntu-latest");
    expect(publishWorkflow.jobs.publish["runs-on"]).toBe("ubuntu-latest");
    expect(publishWorkflow.concurrency).toEqual({
      group: "publish-${{ github.event.release.tag_name || github.ref_name }}",
      "cancel-in-progress": false,
    });
    expect(publishWorkflow.jobs.draft.permissions).toEqual({
      contents: "write",
      "pull-requests": "read",
    });
    expect(publishWorkflow.jobs.publish.permissions).toEqual({
      contents: "read",
      "id-token": "write",
    });
    expect(publishWorkflow.jobs.publish.environment).toBe("npm-publish");
    expect(publishWorkflow.jobs.publish.concurrency).toEqual({
      group: "npm-publish-dist-tags",
      "cancel-in-progress": false,
    });
  });

  it("uses pinned Codex with the requested model, effort, and strict structured output", () => {
    const codex = publishWorkflow.jobs.draft.steps.find(
      (step) => step.name === "Generate Highlights with Codex",
    );
    expect(codex?.uses).toBe(
      "openai/codex-action@52fe01ec70a42f454c9d2ebd47598f9fd6893d56",
    );
    expect(codex?.with).toMatchObject({
      "openai-api-key": "${{ secrets.OPENAI_API_KEY }}",
      "codex-version": "0.144.6",
      model: "gpt-5.6-terra",
      effort: "high",
      "permission-profile": ":read-only",
      "safety-strategy": "drop-sudo",
    });
    expect(highlightsSchema).toMatchObject({
      type: "object",
      required: ["highlights"],
      additionalProperties: false,
    });
    expect(highlightsSchema.properties.highlights).toMatchObject({
      type: "array",
      minItems: 1,
      maxItems: 5,
    });
  });

  it("pins every third-party action used by the release workflows", () => {
    for (const workflow of [versionWorkflow, publishWorkflow]) {
      for (const job of Object.values(workflow.jobs)) {
        for (const step of job.steps) {
          if (step.uses) expect(step.uses).toMatch(/^[^@]+@[0-9a-f]{40}$/u);
        }
      }
    }
  });

  it("publishes beta and stable versions to explicit npm dist-tags", () => {
    expect(publishSource).toContain("npm publish --access public --tag beta");
    expect(publishSource).toContain("npm publish --access public --tag latest");
    expect(publishSource).toContain("assertReleaseCanAdvanceDistTag");
    expect(publishSource).toContain("assertNpmDistTags");
    expect(publishSource).toContain("assertActionCreatedReleaseBody");
    expect(publishSource.match(/npm run test:ci/gu)).toHaveLength(2);
    const npmState = publishWorkflow.jobs.publish.steps.find(
      (step) => step.name === "Check npm publication state",
    );
    const npmStateRun = npmState?.run;
    expect(npmStateRun).toContain("dist_tags_status=0");
    expect(npmStateRun).toContain(
      'dist_tags="$(npm view "$name" dist-tags --json 2>&1)" || dist_tags_status=$?',
    );
    expect(npmStateRun).toContain("grep -qiE 'E404|404 Not Found'");
    expect(npmStateRun).toContain("dist_tags='{}'");
    expect(npmStateRun).toContain("::error::Unable to query npm dist-tags for $name");
  });

  it("records prerelease support as a minor package change", () => {
    expect(changesetSource).toMatch(/^---\n"@donadiosolutions\/lcm": minor\n---\n/u);
  });
});
