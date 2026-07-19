import { readFileSync } from "node:fs";
import { load as loadYaml } from "js-yaml";
import { describe, expect, it } from "vitest";

interface WorkflowStep {
  id?: string;
  if?: string;
  name?: string;
  run?: string;
  "continue-on-error"?: boolean;
  "timeout-minutes"?: number;
  uses?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
}

interface WorkflowJob {
  if?: string;
  "runs-on": string;
  environment?: string;
  needs?: string | string[];
  defaults?: { run: { "working-directory": string } };
  outputs?: Record<string, string>;
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
  permissions: Record<string, string>;
  jobs: { version: WorkflowJob };
}

interface PublishWorkflow {
  on: {
    push: { tags: string[] };
    release: { types: string[] };
    workflow_dispatch?: never;
  };
  concurrency: { group: string; "cancel-in-progress": boolean };
  jobs: {
    draft: WorkflowJob;
    preflight: WorkflowJob;
    publish: WorkflowJob;
    "restore-draft": WorkflowJob;
  };
}

const versionSource = readFileSync(new URL("../.github/workflows/version-pr.yml", import.meta.url), "utf8");
const publishSource = readFileSync(new URL("../.github/workflows/publish.yml", import.meta.url), "utf8");
const releaseTagPolicySource = readFileSync(
  new URL("../.github/scripts/release-tag-policy.mjs", import.meta.url),
  "utf8",
);
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
  it("uses an ordered, main-based Changesets workflow with explicit beta transitions", () => {
    expect(versionWorkflow.on.push.branches).toEqual(["main"]);
    expect(versionWorkflow.on.workflow_dispatch.inputs.channel.options).toEqual(["beta", "stable"]);
    expect(versionWorkflow).not.toHaveProperty("concurrency");
    expect(versionWorkflow.permissions.actions).toBe("read");
    expect(versionWorkflow.jobs.version["runs-on"]).toBe("ubuntu-latest");
    const versionQueue = versionWorkflow.jobs.version.steps.find(
      (step) => step.name === "Wait for earlier version runs",
    );
    expect(versionQueue?.uses).toBe(
      "actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3",
    );
    expect(versionQueue?.["timeout-minutes"]).toBe(65);
    expect(versionQueue?.with?.script).toContain('workflow_id: "version-pr.yml"');
    expect(versionQueue?.with?.script).toContain('run.id < currentRunId');
    expect(versionQueue?.with?.script).toContain('["push", "workflow_dispatch"].includes(run.event)');
    expect(versionQueue?.with?.script).toContain(
      ".sort((left, right) => left.id - right.id)",
    );
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
    expect(publishWorkflow.jobs.preflight.if).toContain("github.event_name == 'release'");
    expect(publishWorkflow.jobs.publish.if).toContain("github.event_name == 'release'");
    expect(publishWorkflow.jobs.draft["runs-on"]).toBe("ubuntu-latest");
    expect(publishWorkflow.jobs.preflight["runs-on"]).toBe("ubuntu-latest");
    expect(publishWorkflow.jobs.publish["runs-on"]).toBe("ubuntu-latest");
    expect(publishWorkflow.jobs["restore-draft"]["runs-on"]).toBe("ubuntu-latest");
    expect(publishWorkflow.concurrency).toEqual({
      group: "publish-${{ github.event.release.tag_name || github.ref_name }}",
      "cancel-in-progress": false,
    });
    expect(publishWorkflow.jobs.draft.permissions).toEqual({
      contents: "write",
      "pull-requests": "read",
    });
    expect(publishWorkflow.jobs.preflight.permissions).toEqual({
      actions: "read",
      contents: "read",
    });
    expect(publishWorkflow.jobs.publish.permissions).toEqual({
      actions: "read",
      contents: "read",
      "id-token": "write",
    });
    expect(publishWorkflow.jobs["restore-draft"].permissions).toEqual({ contents: "write" });
    expect(publishWorkflow.jobs.publish.needs).toBe("preflight");
    expect(publishWorkflow.jobs["restore-draft"].needs).toEqual(["preflight", "publish"]);
    expect(publishWorkflow.jobs.publish.environment).toBe("npm-publish");
    expect(publishWorkflow.jobs.publish.concurrency).toBeUndefined();
    const publicationQueue = publishWorkflow.jobs.preflight.steps.find(
      (step: WorkflowStep): boolean => step.name === "Wait for earlier release publications",
    );
    expect(publicationQueue?.uses).toBe(
      "actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3",
    );
    expect(publicationQueue?.["timeout-minutes"]).toBe(65);
    expect(publicationQueue?.with?.script).toContain('workflow_id: "publish.yml"');
    expect(publicationQueue?.with?.script).toContain('event: "release"');
    expect(publicationQueue?.with?.script).toContain(
      "const earlierRuns = runs.filter((run) => run.id < currentRunId)",
    );
    expect(publicationQueue?.with?.script).toContain(
      ".sort((left, right) => left.id - right.id)",
    );
    expect(publicationQueue?.with?.script).toContain(
      "if (earlierActiveRuns.length === 0) break",
    );
    expect(publicationQueue?.with?.script).toContain("run.conclusion !== \"success\"");
    expect(publicationQueue?.with?.script).toContain("if (release.draft)");
    expect(publicationQueue?.with?.script).toContain("must be rerun successfully or withdrawn to draft");
    expect(publicationQueue?.with?.script).toContain("setTimeout(resolve, pollMs)");
    expect(publicationQueue?.with?.script).toContain("const timeoutMs = 60 * 60 * 1000");

    const restore = publishWorkflow.jobs["restore-draft"];
    expect(restore.if).toContain("needs.preflight.result == 'failure'");
    expect(restore.if).toContain("needs.publish.outputs.guard_failed == 'true'");
    expect(restore.steps).toHaveLength(1);
    expect(restore.steps[0]?.with?.script).toContain("draft: true");
    expect(restore.steps.some((step) => step.uses?.startsWith("actions/checkout@"))).toBe(false);
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
    expect(publishSource).toContain('--access public --tag beta');
    expect(publishSource).toContain('--access public --tag latest');
    expect(publishSource).toContain("assertActionCreatedReleaseBody");
    expect(publishSource.match(/npm run test:ci/gu)).toHaveLength(2);
    const draftNpmState = publishWorkflow.jobs.draft.steps.find(
      (step: WorkflowStep): boolean => step.name === "Check npm release ordering",
    );
    const npmState = publishWorkflow.jobs.preflight.steps.find(
      (step: WorkflowStep): boolean => step.name === "Check npm release ordering",
    );
    expect(draftNpmState?.run).toBe(
      'node .github/scripts/check-npm-release-state.mjs "$RELEASE_VERSION"',
    );
    expect(npmState?.run).toBe(
      'node ../trusted/.github/scripts/check-npm-release-state.mjs "$RELEASE_VERSION" >> "$GITHUB_OUTPUT"',
    );
    const npmGuard = publishWorkflow.jobs.publish.steps.find(
      (step) => step.name === "Recheck npm release ordering",
    );
    expect(npmGuard?.["continue-on-error"]).toBe(true);
    expect(npmGuard?.run).toContain("trusted/.github/scripts/check-npm-release-state.mjs");
    const verification = publishWorkflow.jobs.publish.steps.find(
      (step) => step.name === "Verify npm package and dist-tags",
    );
    expect(verification?.run).toBe(
      'node trusted/.github/scripts/verify-npm-release.mjs "$RELEASE_VERSION"',
    );
    const draftNpmStateIndex = publishWorkflow.jobs.draft.steps.findIndex(
      (step: WorkflowStep): boolean => step.name === "Check npm release ordering",
    );
    expect(draftNpmStateIndex).toBeGreaterThanOrEqual(0);
    expect(draftNpmStateIndex).toBeLessThan(
      publishWorkflow.jobs.draft.steps.findIndex(
        (step: WorkflowStep): boolean => step.name === "Create or update draft GitHub release",
      ),
    );
  });

  it("filters drafts, fetches canonical published bases, and verifies tags before code execution", () => {
    expect(releaseTagPolicySource).not.toMatch(/^\s*import\s/mu);
    const collect = publishWorkflow.jobs.draft.steps.find(
      (step: WorkflowStep): boolean => step.name === "Collect release pull requests",
    );
    expect(collect?.with?.script).toContain(
      "if (release.draft || !release.published_at || release.tag_name === targetTag) continue;",
    );
    expect(collect?.with?.script).toContain("parseReleaseTag(release.tag_name)");
    expect(collect?.with?.script).toContain(
      '["fetch", "--no-tags", "origin", `${tagRef}:${tagRef}`]',
    );
    expect(collect?.with?.script).toContain(
      '["merge-base", "--is-ancestor", tagRef, targetRef]',
    );
    const collectScript = String(collect?.with?.script);
    expect(collectScript.indexOf("parseReleaseTag(release.tag_name)")).toBeLessThan(
      collectScript.indexOf('["fetch", "--no-tags"'),
    );
    const tagChecks = [publishWorkflow.jobs.draft, publishWorkflow.jobs.preflight].map((job) =>
      job.steps.find(
      (step: WorkflowStep): boolean => step.name === "Verify signed annotated release tag",
      ),
    );
    expect(tagChecks).toHaveLength(2);
    for (const tagCheck of tagChecks) {
      expect(tagCheck.uses).toBe(
        "actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3",
      );
      expect(tagCheck?.with?.script).toContain("annotatedTag.verification?.verified !== true");
      expect(tagCheck?.with?.script).toContain('ref.object.type !== "tag"');
    }
    for (const job of [publishWorkflow.jobs.draft, publishWorkflow.jobs.preflight]) {
      const checkoutIndex = job.steps.findIndex(
        (step: WorkflowStep): boolean => step.name?.startsWith("Checkout ") === true,
      );
      const tagCheckIndex = job.steps.findIndex(
        (step: WorkflowStep): boolean => step.name === "Verify signed annotated release tag",
      );
      expect(tagCheckIndex).toBeGreaterThanOrEqual(0);
      expect(tagCheckIndex).toBeLessThan(checkoutIndex);
    }
    const trustedCheckout = publishWorkflow.jobs.publish.steps.find(
      (step) => step.name === "Checkout trusted release tools",
    );
    expect(trustedCheckout?.with?.ref).toBe("${{ github.workflow_sha }}");
    expect(publishWorkflow.jobs.publish.steps.some((step) => step.name === "Checkout verified release commit")).toBe(false);
    const tagGuard = publishWorkflow.jobs.publish.steps.find(
      (step) => step.name === "Revalidate signed release tag",
    );
    expect(tagGuard?.["continue-on-error"]).toBe(true);
    expect(tagGuard?.with?.script).toContain("annotatedTag.object.sha !== expectedCommit");
  });

  it("moves the verified package between trust domains without checking out tag code under OIDC", () => {
    const upload = publishWorkflow.jobs.preflight.steps.find(
      (step) => step.name === "Upload verified npm artifact",
    );
    expect(upload?.uses).toBe(
      "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
    );
    expect(upload?.with).toMatchObject({
      path: "release/release-artifact/*.tgz",
      "if-no-files-found": "error",
      "retention-days": 1,
    });
    const download = publishWorkflow.jobs.publish.steps.find(
      (step) => step.name === "Download verified npm artifact",
    );
    expect(download?.run).toContain('gh run download "$GITHUB_RUN_ID"');
    expect(publishSource).not.toContain("actions/download-artifact@");
    const publish = publishWorkflow.jobs.publish.steps.find(
      (step) => step.name === "Publish to npm",
    );
    expect(publish?.run).toContain('packages=(release-artifact/*.tgz)');
    expect(publish?.run).toContain('"${#packages[@]}" -ne 1');
    expect(publish?.run).toContain('npm publish "${packages[0]}"');
  });

  it("binds the draft marker to the exact release tag", () => {
    const draft = publishWorkflow.jobs.draft.steps.find(
      (step) => step.name === "Create or update draft GitHub release",
    );
    expect(draft?.with?.script).toContain("targetTag: tag_name");
    const marker = publishWorkflow.jobs.preflight.steps.find(
      (step) => step.name === "Verify draft workflow marker and Highlights",
    );
    expect(marker?.run).toContain(
      "assertActionCreatedReleaseBody(process.env.RELEASE_BODY, process.env.RELEASE_TAG)",
    );
  });

  it("records prerelease support as a minor package change", () => {
    expect(changesetSource).toMatch(/^---\n"@donadiosolutions\/lcm": minor\n---\n/u);
  });
});
