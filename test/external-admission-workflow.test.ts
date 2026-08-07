import { existsSync, readFileSync } from "node:fs";
import { load as loadYaml } from "js-yaml";
import { describe, expect, it } from "vitest";

interface WorkflowStep {
  if?: string;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
}

interface ExternalAdmissionWorkflow {
  concurrency: {
    "cancel-in-progress": boolean;
    group: string;
  };
  on: {
    check_run: { types: string[] };
    repository_dispatch: { types: string[] };
    workflow_run: { workflows: string[]; types: string[] };
  };
  permissions: Record<string, string>;
  jobs: {
    "external-admission-evaluator": {
      if: string;
      steps: WorkflowStep[];
      "timeout-minutes": number;
    };
  };
}

const root = new URL("../", import.meta.url);
const source = readFileSync(new URL(".github/workflows/external-admission.yml", root), "utf8");
const policySource = readFileSync(
  new URL(".github/scripts/external-admission-policy.mjs", root),
  "utf8",
);
const evaluator = readFileSync(new URL(".github/scripts/external-admission.sh", root), "utf8");
const documentation = readFileSync(new URL("docs/external-admission.md", root), "utf8");
const workflowDocumentation = readFileSync(new URL("WORKFLOW.md", root), "utf8");
const copilotInstructions = readFileSync(
  new URL(".github/copilot-instructions.md", root),
  "utf8",
);
const workflow = loadYaml(source) as ExternalAdmissionWorkflow;
const job = workflow.jobs["external-admission-evaluator"];
const evaluatorInvocation =
  job.steps.find((step) => step.name === "Evaluate external admission snapshot")?.run ?? "";
const completedOrReconcile =
  "${{ (github.event_name == 'repository_dispatch' && github.event.action == 'external-admission-reconcile' && github.event.client_payload.head_sha != '') || github.event.action == 'completed' }}";

describe("external admission workflow", () => {
  it("uses DCO, trusted CI, and default-branch reconciliation with least privilege", () => {
    expect(workflow.on).toEqual({
      check_run: { types: ["created", "rerequested", "completed"] },
      repository_dispatch: { types: ["external-admission-reconcile"] },
      workflow_run: {
        workflows: ["CI"],
        types: ["requested", "in_progress", "completed"],
      },
    });
    expect(workflow.permissions).toEqual({
      actions: "read",
      checks: "read",
      contents: "read",
      "pull-requests": "read",
      statuses: "write",
    });
    expect(job["timeout-minutes"]).toBe(5);
  });

  it("revokes admission before checking out only the trusted evaluator", () => {
    expect(job.steps.map((step) => step.name)).toEqual([
      "Revoke stale external admission",
      "Check out trusted admission evaluator",
      "Set up Node.js",
      "Evaluate external admission snapshot",
    ]);

    const revoke = job.steps[0]?.run ?? "";
    expect(revoke).toContain('EVENT_HEAD_SHA="${EVENT_HEAD_SHA,,}"');
    expect(revoke).toContain('if [[ ! "$EVENT_HEAD_SHA" =~ ^[0-9a-f]{40}$ ]]');
    expect(revoke).toContain('-f state="pending"');
    expect(revoke).not.toContain("/pulls");

    const checkout = job.steps[1];
    expect(checkout?.if).toBe(completedOrReconcile);
    expect(checkout?.uses).toBe(
      "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
    );
    expect(checkout?.with).toEqual({
      ref: "${{ github.workflow_sha }}",
      "persist-credentials": false,
      "sparse-checkout":
        ".github/scripts/external-admission.sh\n.github/scripts/external-admission-policy.mjs\n",
      "sparse-checkout-cone-mode": false,
    });

    const setupNode = job.steps[2];
    expect(setupNode?.if).toBe(completedOrReconcile);
    expect(setupNode?.uses).toBe(
      "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
    );
    expect(setupNode?.with).toEqual({ "node-version": "22.20.0" });
    expect(job.steps[3]?.if).toBe(completedOrReconcile);
    expect(evaluatorInvocation).toBe("bash .github/scripts/external-admission.sh");
  });

  it("starts only for authenticated DCO, canonical pull-request CI, or reconciliation", () => {
    for (const value of ["DCO", "1861", "dco"]) expect(job.if).toContain(value);
    expect(job.if).toContain("github.event_name == 'repository_dispatch'");
    expect(job.if).toContain("github.event.action == 'external-admission-reconcile'");
    expect(job.if).toContain("github.event.client_payload.head_sha != ''");
    expect(job.if).toContain("github.event.workflow_run.name == 'CI'");
    expect(job.if).toContain("github.event.workflow_run.event == 'pull_request'");
    expect(job.if).toContain("github.event.workflow_run.path == '.github/workflows/ci.yml'");
    expect(job.if).toContain(
      "github.event.workflow_run.repository.full_name == github.repository",
    );
    expect(policySource).toContain('name: "ci", appId: 15368, appSlug: "github-actions"');
    expect(policySource).toContain('name: "DCO", appId: 1861, appSlug: "dco"');
    expect(source).not.toMatch(/^\s+pull_request(?:_target)?:/gmu);
    expect(workflow.on).not.toHaveProperty("workflow_dispatch");
    expect(source).not.toContain("inputs.head_sha");
  });

  it("groups the complete DCO identity predicate explicitly", () => {
    const dcoIdentity = /\(github\.event\.check_run\.name == 'DCO' &&\s+github\.event\.check_run\.app\.id == 1861 &&\s+github\.event\.check_run\.app\.slug == 'dco'\)/u;
    expect(workflow.concurrency.group).toMatch(dcoIdentity);
    expect(job.if).toMatch(dcoIdentity);
  });

  it("accepts DCO only from a non-empty non-queue pull-request suite branch", () => {
    for (const guard of [
      "github.event.check_run.check_suite.head_branch != null",
      "github.event.check_run.check_suite.head_branch != ''",
      "!startsWith(github.event.check_run.check_suite.head_branch, 'gh-readonly-queue/')",
    ]) {
      expect(job.if).toContain(guard);
      expect(workflow.concurrency.group).toContain(guard);
    }
    expect(source.match(/check_suite\.head_branch != null/gu)).toHaveLength(2);
    expect(source.match(/check_suite\.head_branch != ''/gu)).toHaveLength(2);
    expect(source.match(/!startsWith\(github\.event\.check_run\.check_suite\.head_branch/gu))
      .toHaveLength(2);
  });

  it("isolates rejected CI workflow runs from exact-SHA concurrency", () => {
    const group = workflow.concurrency.group;
    expect(workflow.concurrency["cancel-in-progress"]).toBe(true);
    for (const condition of [
      "github.event.workflow_run.name == 'CI'",
      "github.event.workflow_run.event == 'pull_request'",
      "github.event.workflow_run.path == '.github/workflows/ci.yml'",
      "github.event.workflow_run.repository.full_name == github.repository",
    ]) {
      expect(group).toContain(condition);
      expect(job.if).toContain(condition);
    }
    expect(group).toMatch(
      /github\.event\.workflow_run\.repository\.full_name == github\.repository\s+&&\s+github\.event\.workflow_run\.head_sha/u,
    );
    expect(group).toMatch(
      /github\.event_name == 'workflow_run'\s+&&\s+format\('workflow-run-\{0\}', github\.run_id\)/u,
    );
  });

  it("repeats exact-head PR, CI, and DCO validation before success", () => {
    expect(evaluator).toContain("commits/$HEAD_SHA/pulls?per_page=100");
    expect(evaluator).toContain("check-runs?filter=latest&per_page=100");
    expect(evaluator).not.toContain("/files?per_page=100");
    const initial = evaluator.indexOf('validate_or_exit "Initial"');
    const current = evaluator.indexOf('validate_or_exit "Current"');
    const final = evaluator.indexOf('validate_or_exit "Final"');
    const success = evaluator.indexOf('post_admission_status success "CI and DCO passed"');
    expect(initial).toBeGreaterThan(evaluator.indexOf('matching_prs="$(fetch_associated_pull_requests)"'));
    expect(current).toBeGreaterThan(evaluator.indexOf('current_matching_prs="$(fetch_associated_pull_requests)"'));
    expect(final).toBeGreaterThan(current);
    expect(success).toBeGreaterThan(evaluator.indexOf('final_matching_prs="$(fetch_associated_pull_requests)"'));
    expect(success).toBeGreaterThan(final);
    expect(evaluator).toContain("external-admission-policy.mjs evaluate-checks");
    expect(evaluator).toContain('"$HEAD_SHA" "$REPOSITORY" "$SERVER_URL"');
    expect(evaluator).toContain("external-admission-policy.mjs evaluate-ci-run");
    expect(evaluator).toContain('if [[ "$EVENT_SOURCE" == workflow_run');
    expect(evaluator).toContain('VALIDATED_ADMISSION_FINGERPRINT="$ci_check_run_id:$dco_check_run_id:$ci_run_id"');
    expect(evaluator).toContain('initial_admission_fingerprint="$VALIDATED_ADMISSION_FINGERPRINT"');
    expect(evaluator.match(/VALIDATED_ADMISSION_FINGERPRINT" != "\$initial_admission_fingerprint/gu)).toHaveLength(2);
    expect(evaluator).not.toContain("classify-files");
    expect(evaluator).not.toContain("select-admission");
    expect(evaluator).not.toContain("admission-decision");
  });

  it("preserves fail-closed cancellation, failure, and stale-success handling", () => {
    expect(evaluator).toContain("trap admission_failed EXIT");
    expect(evaluator).toContain("trap 'admission_cancelled INT 130' INT");
    expect(evaluator).toContain("trap 'admission_cancelled TERM 143' TERM");
    expect(evaluator).toContain("post_admission_status failure");
    expect(evaluator).toContain("External admission failed; inspect the workflow run");
    expect(evaluator).toContain('post_admission_status pending "Waiting for trusted CI and DCO"');
    const pendingWrite = evaluator.indexOf('if ! post_admission_status pending "$1"; then');
    const pendingFailure = evaluator.indexOf("return 2", pendingWrite);
    const pendingMessage = evaluator.indexOf('echo "$2"', pendingWrite);
    const pendingExit = evaluator.indexOf("return 1", pendingMessage);
    expect(pendingWrite).toBeGreaterThan(-1);
    expect(pendingFailure).toBeGreaterThan(pendingWrite);
    expect(pendingMessage).toBeGreaterThan(pendingFailure);
    expect(pendingExit).toBeGreaterThan(pendingMessage);
    expect(evaluator).toContain('snapshot_incomplete "$@" || result=$?');
    expect(evaluator).not.toMatch(/snapshot_incomplete[\s\S]{0,240}\|\| true/gu);
    expect(evaluator).not.toContain("artifacts");
    expect(evaluator).not.toContain("caches");
  });

  it("keeps inline workflow scripts below actionlint's blocking threshold", () => {
    for (const step of job.steps) {
      if (step.run) expect(Buffer.byteLength(step.run, "utf8")).toBeLessThan(4_000);
    }
  });

  it("documents recovery and contains no disabled provider dependency", () => {
    expect(documentation).toContain("CI and DCO");
    expect(documentation).toContain("-f event_type=external-admission-reconcile");
    expect(documentation).toContain("client_payload[head_sha]");
    expect(workflowDocumentation).toContain("CI and DCO");
    for (const content of [
      source,
      policySource,
      evaluator,
      documentation,
      workflowDocumentation,
      copilotInstructions,
    ]) {
      expect(content).not.toMatch(new RegExp(`grep${"tile"}`, "iu"));
    }
    expect(existsSync(new URL(`grep${"tile"}.json`, root))).toBe(false);
  });
});
