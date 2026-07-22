import { readFileSync } from "node:fs";
import { load as loadYaml } from "js-yaml";
import { describe, expect, it } from "vitest";

interface WorkflowStep {
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
}

interface ExternalAdmissionWorkflow {
  on: Record<string, { types: string[] }>;
  permissions: Record<string, string>;
  jobs: {
    "external-admission-evaluator": {
      if: string;
      steps: WorkflowStep[];
    };
  };
}

const source = readFileSync(
  new URL("../.github/workflows/external-admission.yml", import.meta.url),
  "utf8",
);
const policySource = readFileSync(
  new URL("../.github/scripts/external-admission-policy.mjs", import.meta.url),
  "utf8",
);
const workflow = loadYaml(source) as ExternalAdmissionWorkflow;
const job = workflow.jobs["external-admission-evaluator"];
const evaluator = job.steps.find((step) => step.name === "Wait for external admission checks")?.run ?? "";

describe("external admission workflow", () => {
  it("has only the check-run trigger and least privileges needed by the trusted policy", () => {
    expect(workflow.on).toEqual({
      check_run: { types: ["created", "rerequested", "completed"] },
    });
    expect(workflow.permissions).toEqual({
      actions: "read",
      checks: "read",
      contents: "read",
      "pull-requests": "read",
      statuses: "write",
    });
  });

  it("revokes admission before checking out the trusted workflow revision", () => {
    expect(job.steps.map((step) => step.name)).toEqual([
      "Revoke stale external admission",
      "Check out trusted admission policy",
      "Set up Node.js",
      "Wait for external admission checks",
    ]);

    const revoke = job.steps[0]?.run ?? "";
    expect(revoke).toContain('if [[ ! "$EVENT_HEAD_SHA" =~ ^[0-9a-fA-F]{40}$ ]]');
    expect(revoke).toContain('-f state="pending"');
    expect(revoke).not.toContain("/pulls");

    const checkout = job.steps[1];
    expect(checkout?.uses).toBe(
      "actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0",
    );
    expect(checkout?.with).toEqual({
      ref: "${{ github.workflow_sha }}",
      "persist-credentials": false,
      "sparse-checkout": ".github/scripts/external-admission-policy.mjs",
      "sparse-checkout-cone-mode": false,
    });

    const setupNode = job.steps[2];
    expect(setupNode?.uses).toBe(
      "actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e",
    );
    expect(setupNode?.with).toEqual({ "node-version": "22.20.0" });
  });

  it("starts only for Codecov or DCO and polls CI without triggering on merge groups", () => {
    for (const identity of [
      ["codecov/patch", "254", "codecov"],
      ["DCO", "1861", "dco"],
    ]) {
      for (const value of identity) expect(job.if).toContain(value);
    }
    expect(job.if).not.toContain("15368");
    expect(job.if).not.toContain("github-actions");
    expect(source).toContain("CI is polled but never starts this evaluator");
    expect(policySource).toContain('name: "ci", appId: 15368, appSlug: "github-actions"');
    expect(source).not.toMatch(/CodeRabbit|Greptile|copilot-pull-request-reviewer/iu);
  });

  it("paginates every collection and repeats exact pull-request eligibility", () => {
    expect(evaluator).toContain("commits/$HEAD_SHA/pulls?per_page=100");
    expect(evaluator).toContain("pulls/$PR_NUMBER/files?per_page=100");
    expect(evaluator).toContain("check-runs?filter=latest&per_page=100");
    expect(evaluator.match(/gh api --paginate --slurp/gu)).toHaveLength(4);
    expect(evaluator.match(/fetch_associated_pull_requests/gu)).toHaveLength(4);
    expect(evaluator.match(/pull_request_is_eligible/gu)).toHaveLength(4);
    expect(evaluator).toContain("external-admission-policy.mjs classify-files");
    expect(evaluator).toContain("external-admission-policy.mjs evaluate-checks");
    expect(evaluator).toContain('changed_file_count="$(jq -r \'.changed_files\'');
    expect(evaluator).toContain('current_changed_file_count="$(jq -r \'.changed_files\'');
    expect(evaluator).toContain(
      'classify_pull_request_files "$changed_file_count" <<<"$file_pages"',
    );
    expect(evaluator).toContain(
      'classify_pull_request_files "$current_changed_file_count" <<<"$current_file_pages"',
    );
    expect(policySource).toContain("pull request file audit count does not match changed_files");
  });

  it("requires authenticated Codecov for coverable or trust-sensitive paths", () => {
    expect(policySource).toContain("file.previous_filename");
    expect(policySource).toMatch(/bin\|installer\|src/u);
    expect(policySource).toContain("[cm]?ts|tsx");
    expect(policySource).toMatch(/actions\|codeql\|workflows\|scripts/u);
    expect(policySource).toMatch(/package\(\?:-lock\)\?/u);
    expect(policySource).toContain("vitest");
    expect(policySource).toContain("tsconfig");
    expect(source).toContain('waiting_description="Waiting for Codecov patch and DCO"');
  });

  it("validates successful neutral CI against exact Actions run metadata", () => {
    expect(evaluator).toContain("repos/$REPOSITORY/actions/runs/$ci_run_id");
    expect(evaluator).toContain("external-admission-policy.mjs validate-ci-run");
    expect(policySource).toContain('run.event === "pull_request"');
    expect(policySource).toContain('run.path === workflowPath');
    expect(policySource).toContain('run.head_sha === headSha');
    expect(source).toContain('success_description="CI and DCO passed for coverage-neutral diff"');
  });

  it("repeats classification, checks, CI provenance, and PR eligibility before success", () => {
    const successIndex = evaluator.lastIndexOf('post_admission_status success "$success_description"');
    expect(successIndex).toBeGreaterThan(0);
    for (const marker of [
      "current_matching_prs=",
      "current_pull_request=",
      "current_file_pages=",
      "current_check_run_pages=",
      "current_evaluation=",
      "current_ci_run=",
      "final_matching_prs=",
      "final_pull_request=",
    ]) {
      const markerIndex = evaluator.lastIndexOf(marker);
      expect(markerIndex, marker).toBeGreaterThan(0);
      expect(markerIndex, marker).toBeLessThan(successIndex);
    }
  });
});
