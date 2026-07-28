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
  permissions: Record<string, never>;
  concurrency: { group: string; queue: "max" };
  jobs: { version: WorkflowJob };
}

interface PublishWorkflow {
  "run-name": string;
  on: {
    push: { tags: string[] };
    release: { types: string[] };
    workflow_dispatch: {
      inputs: { tag: { description: string; required: boolean; type: string } };
    };
  };
  concurrency: { group: string; queue: "max" };
  jobs: {
    draft: WorkflowJob;
    preflight: WorkflowJob;
    publish: WorkflowJob;
    "recover-preflight": WorkflowJob;
    "recover-publish": WorkflowJob;
    "restore-draft": WorkflowJob;
  };
}

const versionSource = readFileSync(new URL("../.github/workflows/version-pr.yml", import.meta.url), "utf8");
const publishSource = readFileSync(new URL("../.github/workflows/publish.yml", import.meta.url), "utf8");
const releasingSource = readFileSync(new URL("../RELEASING.md", import.meta.url), "utf8");
const releaseTagPolicySource = readFileSync(
  new URL("../.github/scripts/release-tag-policy.mjs", import.meta.url),
  "utf8",
);
const publishTarballSource = readFileSync(
  new URL("../.github/scripts/publish-npm-tarball.mjs", import.meta.url),
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
    expect(versionWorkflow.permissions).toEqual({});
    expect(versionWorkflow.concurrency).toEqual({
      group: "version-packages-main",
      queue: "max",
    });
    expect(versionSource).toContain(
      "Current GitHub syntax: preserve up to 100 pending runs FIFO; installed actionlint lags.",
    );
    expect(versionWorkflow.jobs.version["runs-on"]).toBe("ubuntu-latest");
    expect(versionWorkflow.jobs.version.permissions).toEqual({
      actions: "read",
      contents: "write",
      issues: "write",
      "pull-requests": "write",
    });
    const versionQueue = versionWorkflow.jobs.version.steps.find(
      (step) => step.name === "Enforce earlier manual transition success",
    );
    expect(versionQueue?.uses).toBe(
      "actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3",
    );
    expect(versionQueue?.with?.script).toContain('workflow_id: "version-pr.yml"');
    expect(versionQueue?.with?.script).toContain('event: "workflow_dispatch"');
    expect(versionQueue?.with?.script).toContain('status: "completed"');
    expect(versionQueue?.with?.script).toContain('run.id < currentRunId');
    expect(versionQueue?.with?.script).toContain('run.conclusion !== "success"');
    expect(versionQueue?.with?.script).toContain("must be rerun successfully");
    expect(versionQueue?.with?.script).not.toContain("setTimeout");
    const channel = versionWorkflow.jobs.version.steps.find(
      (step) => step.name === "Resolve release channel",
    );
    expect(channel?.id).toBe("channel");
    expect(channel?.uses).toBe(
      "actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3",
    );
    expect(channel?.env).toMatchObject({
      EVENT_NAME: "${{ github.event_name }}",
      REQUESTED_CHANNEL: "${{ inputs.channel }}",
    });
    expect(channel?.with?.script).toContain('eventName === "workflow_dispatch"');
    expect(channel?.with?.script).toContain('eventName === "push"');
    expect(channel?.with?.script).toContain("github.rest.pulls.list");
    expect(channel?.with?.script).toContain('state: "open"');
    expect(channel?.with?.script).toContain('base: "main"');
    expect(channel?.with?.script).toContain('head: `${context.repo.owner}:changeset-release/main`');
    expect(channel?.with?.script).toContain("if (pulls.length > 1)");
    expect(channel?.with?.script).toContain('"release-channel:beta"');
    expect(channel?.with?.script).toContain('"release-channel:stable"');
    expect(channel?.with?.script).toContain("if (persisted.size > 1)");
    expect(channel?.with?.script).toContain(': "auto"');
    expect(channel?.with?.script).toContain('core.setOutput("channel", channel)');
    const changesets = versionWorkflow.jobs.version.steps.find((step) => step.id === "changesets");
    expect(changesets?.with).toMatchObject({
      branch: "main",
      commitMode: "github-api",
      version: "npm run version-packages",
      createGithubReleases: false,
    });
    expect(changesets?.env?.LCM_RELEASE_CHANNEL).toBe("${{ steps.channel.outputs.channel }}");
    expect(versionWorkflow.jobs.version.steps.indexOf(channel!)).toBeLessThan(
      versionWorkflow.jobs.version.steps.indexOf(changesets!),
    );
    const releasePolicyLabels = versionWorkflow.jobs.version.steps.find(
      (step) => step.name === "Apply version PR policy labels",
    );
    expect(releasePolicyLabels?.env).toMatchObject({
      PR_NUMBER: "${{ steps.changesets.outputs.pullRequestNumber }}",
      RELEASE_CHANNEL: "${{ steps.channel.outputs.channel }}",
    });
    expect(releasePolicyLabels?.with?.script).toContain('"no-release-notes"');
    expect(releasePolicyLabels?.with?.script).toContain('"release-channel:beta"');
    expect(releasePolicyLabels?.with?.script).toContain('"release-channel:stable"');
    expect(releasePolicyLabels?.with?.script).toContain("github.rest.issues.getLabel");
    expect(releasePolicyLabels?.with?.script).toContain("github.rest.issues.createLabel");
    expect(releasePolicyLabels?.with?.script).toContain("createError.status !== 422");
    expect(releasePolicyLabels?.with?.script).toContain("labels: desired");
    expect(releasePolicyLabels?.with?.script).toContain("github.rest.issues.removeLabel");
    expect(releasePolicyLabels?.with?.script).toContain('if (error.status !== 404) throw error');
    expect(releasePolicyLabels?.with?.script).not.toContain('"chore"');
    expect(releasePolicyLabels?.with?.script).not.toContain('"release-workflow"');
  });

  it("separates tag-driven drafts from manually published npm releases", () => {
    expect(publishWorkflow.on.push.tags).toEqual(["v*.*.*"]);
    expect(publishWorkflow["run-name"]).toBe(
      "release-tag:${{ github.event_name == 'release' && github.event.release.tag_name || github.event_name == 'workflow_dispatch' && inputs.tag || github.ref_name }}",
    );
    expect(publishWorkflow.on.release.types).toEqual(["published"]);
    expect(publishWorkflow.on.workflow_dispatch.inputs.tag).toEqual({
      description: "Immutable published release tag to recover, for example v1.4.2",
      required: true,
      type: "string",
    });
    expect(publishWorkflow.jobs.draft.if).toContain("github.event_name == 'push'");
    expect(publishWorkflow.jobs.preflight.if).toContain("github.event_name == 'release'");
    expect(publishWorkflow.jobs.publish.if).toContain("github.event_name == 'release'");
    expect(publishWorkflow.jobs["recover-preflight"].if).toContain(
      "github.event_name == 'workflow_dispatch'",
    );
    expect(publishWorkflow.jobs["recover-publish"].if).toContain(
      "github.event_name == 'workflow_dispatch'",
    );
    expect(publishWorkflow.jobs.draft["runs-on"]).toBe("ubuntu-latest");
    expect(publishWorkflow.jobs.preflight["runs-on"]).toBe("ubuntu-latest");
    expect(publishWorkflow.jobs.publish["runs-on"]).toBe("ubuntu-latest");
    expect(publishWorkflow.jobs["restore-draft"]["runs-on"]).toBe("ubuntu-latest");
    expect(publishWorkflow.concurrency).toEqual({
      group: "publish-package",
      queue: "max",
    });
    expect(publishSource).toContain(
      "Current GitHub syntax: preserve up to 100 pending runs FIFO; installed actionlint lags.",
    );
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
    expect(publishWorkflow.jobs["recover-preflight"].environment).toBeUndefined();
    expect(publishWorkflow.jobs["recover-publish"].environment).toBe("npm-publish");
    expect(publishWorkflow.jobs["recover-publish"].needs).toBe("recover-preflight");
    expect(publishWorkflow.jobs.publish.concurrency).toBeUndefined();
    const publicationQueue = publishWorkflow.jobs.preflight.steps.find(
      (step: WorkflowStep): boolean => step.name === "Enforce earlier publication success",
    );
    expect(publicationQueue?.uses).toBe(
      "actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3",
    );
    expect(publicationQueue?.with?.script).toContain('workflow_id: "publish.yml"');
    expect(publicationQueue?.with?.script).toContain('event: "release"');
    expect(publicationQueue?.with?.script).toContain('event: "workflow_dispatch"');
    expect(publicationQueue?.with?.script).toContain('status: "completed"');
    expect(publicationQueue?.with?.script).toContain(
      "const failedRuns = releaseRuns",
    );
    expect(publicationQueue?.with?.script).toContain(
      "const successfulRuns = [...releaseRuns, ...recoveryRuns]",
    );
    expect(publicationQueue?.with?.script).toContain("run.conclusion !== \"success\"");
    expect(publicationQueue?.with?.script).toContain('run.conclusion === "success"');
    expect(publicationQueue?.with?.script).toContain("run.display_title");
    expect(publicationQueue?.with?.script).toContain("^release-tag:");
    expect(publicationQueue?.with?.script).toContain("has no canonical tag in its stored run name");
    expect(publicationQueue?.with?.script).toContain(
      "candidate.releaseTag === run.releaseTag && candidate.id > run.id",
    );
    expect(publicationQueue?.with?.script).toContain("later run ${supersedingRun.id} succeeded");
    expect(publicationQueue?.with?.script).toContain("run.releaseTag === currentTag");
    expect(publicationQueue?.with?.script).toContain("tag: run.releaseTag");
    expect(publicationQueue?.with?.script).not.toContain("head_branch");
    expect(publicationQueue?.with?.script).toContain("for retry tag");
    expect(publicationQueue?.with?.script).toContain("if (release.draft)");
    expect(publicationQueue?.with?.script).toContain("for other tags failed");
    expect(publicationQueue?.with?.script).not.toContain("setTimeout");

    const restore = publishWorkflow.jobs["restore-draft"];
    expect(restore.if).toContain("needs.preflight.result == 'failure'");
    expect(restore.if).toContain("needs.preflight.result == 'cancelled'");
    expect(restore.if).toContain("needs.publish.result == 'failure'");
    expect(restore.if).toContain("needs.publish.result == 'cancelled'");
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
    expect(publishSource).toContain("tag=beta");
    expect(publishSource).toContain("tag=latest");
    expect(publishTarballSource).toContain('"--access"');
    expect(publishTarballSource).toContain('"public"');
    expect(publishTarballSource).toContain('"--tag"');
    expect(publishSource).toContain("assertActionCreatedReleaseBody");
    expect(publishSource.match(/npm run test:ci/gu)).toHaveLength(3);
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
    expect(collect?.with?.script).toContain('const targetRef = "HEAD"');
    expect(collect?.with?.script).not.toContain('const targetRef = `refs/tags/${targetTag}`');
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
    const artifactName = publishWorkflow.jobs.preflight.steps.find(
      (step) => step.name === "Name verified npm artifact",
    );
    expect(artifactName?.id).toBe("artifact");
    expect(artifactName?.run).toContain("$GITHUB_RUN_ID");
    expect(artifactName?.run).toContain("$GITHUB_RUN_ATTEMPT");
    expect(publishWorkflow.jobs.preflight.outputs?.artifact_name).toBe(
      "${{ steps.artifact.outputs.name }}",
    );
    expect(upload?.uses).toBe(
      "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
    );
    expect(upload?.with).toMatchObject({
      name: "${{ steps.artifact.outputs.name }}",
      path: "release/release-artifact/*.tgz",
      "if-no-files-found": "error",
      "retention-days": 1,
    });
    const download = publishWorkflow.jobs.publish.steps.find(
      (step) => step.name === "Download verified npm artifact",
    );
    expect(download?.env?.ARTIFACT_NAME).toBe("${{ needs.preflight.outputs.artifact_name }}");
    expect(download?.env?.ARTIFACT_NAME).not.toContain("github.run_attempt");
    expect(download?.run).toContain('gh run download "$GITHUB_RUN_ID"');
    expect(publishSource).not.toContain("actions/download-artifact@");
    const publish = publishWorkflow.jobs.publish.steps.find(
      (step) => step.name === "Publish to npm",
    );
    expect(publish?.if).toContain("steps.npm_guard.outputs.already_published != 'true'");
    expect(publish?.run).toContain(
      'node trusted/.github/scripts/publish-npm-tarball.mjs release-artifact "$tag"',
    );
    expect(publishTarballSource).toContain("Expected exactly one regular npm tarball");
    expect(publishTarballSource).toContain('resolve(tarballs[0])');
    expect(publishTarballSource).toContain('spawnSync("npm"');
    expect(publishTarballSource).toContain("shell: false");

    const recoveryPreflight = publishWorkflow.jobs["recover-preflight"];
    const recoveryPublish = publishWorkflow.jobs["recover-publish"];
    expect(recoveryPreflight.permissions).toEqual({ actions: "read", contents: "read" });
    expect(recoveryPublish.permissions).toEqual({
      actions: "read",
      contents: "read",
      "id-token": "write",
    });
    expect(
      recoveryPreflight.steps.find((step) => step.name === "Checkout verified release commit")?.with
        ?.ref,
    ).toBe("${{ steps.tag.outputs.commit }}");
    expect(
      recoveryPublish.steps.some((step) => step.name === "Checkout verified release commit"),
    ).toBe(false);
    expect(
      recoveryPublish.steps.find((step) => step.name === "Checkout trusted recovery tools")?.with
        ?.ref,
    ).toBe("${{ github.workflow_sha }}");
    expect(
      recoveryPreflight.steps.find((step) => step.name === "Checkout trusted recovery tools")?.with
        ?.ref,
    ).toBe("${{ github.workflow_sha }}");
    const recoveryHistory = recoveryPreflight.steps.find(
      (step) => step.name === "Enforce earlier publication success",
    );
    expect(recoveryHistory?.with?.script).toContain('event: "release"');
    expect(recoveryHistory?.with?.script).toContain('event: "workflow_dispatch"');
    expect(recoveryHistory?.with?.script).toContain("const failedRuns = releaseRuns");
    expect(recoveryHistory?.with?.script).toContain(
      "const successfulRuns = [...releaseRuns, ...recoveryRuns]",
    );
    expect(recoveryHistory?.with?.script).toContain("run.releaseTag === currentTag");
    expect(recoveryHistory?.with?.script).toContain("for recovery tag");
    expect(recoveryPreflight.outputs?.artifact_name).toBe("${{ steps.artifact.outputs.name }}");
    expect(recoveryPreflight.outputs?.already_published).toBe(
      "${{ steps.npm.outputs.already_published }}",
    );
    const recoveryNpmState = recoveryPreflight.steps.find(
      (step) => step.name === "Check npm release ordering",
    );
    expect(recoveryNpmState?.id).toBe("npm");
    expect(recoveryNpmState?.run).toContain('>> "$GITHUB_OUTPUT"');
    const recoveryBuildSteps = [
      "Install dependencies",
      "Verify trusted publishing prerequisites",
      "Type-check",
      "Run complete coverage suite",
      "Build",
      "Verify build leaves tracked sources unchanged",
      "Pack verified npm artifact",
      "Name verified npm artifact",
      "Upload verified npm artifact",
    ];
    for (const name of recoveryBuildSteps) {
      expect(recoveryPreflight.steps.find((step) => step.name === name)?.if).toBe(
        "${{ steps.npm.outputs.already_published != 'true' }}",
      );
    }
    const existingNpmVerification = recoveryPreflight.steps.find(
      (step) => step.name === "Verify existing npm package and dist-tags",
    );
    expect(existingNpmVerification?.if).toBe(
      "${{ steps.npm.outputs.already_published == 'true' }}",
    );
    expect(existingNpmVerification?.run).toContain("verify-npm-release.mjs");
    const recoveryNpmGuardIndex = recoveryPublish.steps.findIndex(
      (step) => step.name === "Recheck npm release ordering",
    );
    const recoveryDownloadIndex = recoveryPublish.steps.findIndex(
      (step) => step.name === "Download verified npm artifact",
    );
    expect(recoveryNpmGuardIndex).toBeGreaterThanOrEqual(0);
    expect(recoveryNpmGuardIndex).toBeLessThan(recoveryDownloadIndex);
    const recoveryDownload = recoveryPublish.steps[recoveryDownloadIndex];
    expect(recoveryDownload?.if).toContain(
      "needs.recover-preflight.outputs.already_published != 'true'",
    );
    expect(recoveryDownload?.if).toContain("steps.npm.outputs.already_published != 'true'");
    expect(recoveryDownload?.env?.ARTIFACT_NAME).toBe(
      "${{ needs.recover-preflight.outputs.artifact_name }}",
    );
    const recoveryPublishStep = recoveryPublish.steps.find(
      (step) => step.name === "Publish to npm",
    );
    expect(recoveryPublishStep?.if).toContain(
      "needs.recover-preflight.outputs.already_published != 'true'",
    );
    expect(recoveryPublishStep?.if).toContain("steps.npm.outputs.already_published != 'true'");
    expect(recoveryPublishStep?.run).toContain(
      'node trusted/.github/scripts/publish-npm-tarball.mjs release-artifact "$tag"',
    );
  });

  it("documents immutable published-release recovery without weakening the trust boundary", () => {
    expect(releasingSource).toContain("Use the manual immutable-release recovery path only");
    expect(releasingSource).toContain("gh workflow run publish.yml");
    expect(releasingSource).toContain("--ref main");
    expect(releasingSource).toContain("-f tag=v1.4.2");
    expect(releasingSource).toContain("protected commit that defines the workflow");
    expect(releasingSource).toContain("checks out or executes tagged package code");
    expect(releasingSource).toContain("Recovery is idempotent");
    expect(releasingSource).toContain("without rebuilding, repacking, downloading");
    expect(releasingSource).toContain("does not create, edit, withdraw, replace, or delete");
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
