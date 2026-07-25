import { readFileSync } from "node:fs";
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

const source = readFileSync(
  new URL("../.github/workflows/external-admission.yml", import.meta.url),
  "utf8",
);
const policySource = readFileSync(
  new URL("../.github/scripts/external-admission-policy.mjs", import.meta.url),
  "utf8",
);
const greptileConfig = JSON.parse(readFileSync(
  new URL("../greptile.json", import.meta.url),
  "utf8",
)) as { excludeAuthors: string[] };
const evaluator = readFileSync(
  new URL("../.github/scripts/external-admission.sh", import.meta.url),
  "utf8",
);
const documentation = readFileSync(
  new URL("../docs/external-admission.md", import.meta.url),
  "utf8",
);
const workflow = loadYaml(source) as ExternalAdmissionWorkflow;
const job = workflow.jobs["external-admission-evaluator"];
const evaluatorInvocation =
  job.steps.find((step) => step.name === "Evaluate external admission snapshot")?.run ?? "";
const completedOrReconcile =
  "${{ (github.event_name == 'repository_dispatch' && github.event.action == 'external-admission-reconcile' && github.event.client_payload.head_sha != '') || github.event.action == 'completed' }}";

describe("external admission workflow", () => {
  it("uses provider, trusted CI, and default-branch reconciliation events with least privilege", () => {
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

  it("revokes admission before checking out the trusted workflow revision", () => {
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
        ".github/scripts/external-admission.sh\n.github/scripts/external-admission-policy.mjs\ngreptile.json\n",
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
    expect(evaluator).toContain('HEAD_SHA="${EVENT_HEAD_SHA,,}"');
    expect(evaluator).toContain('if [[ ! "$HEAD_SHA" =~ ^[0-9a-f]{40}$ ]]');
    expect(source).not.toContain("[0-9a-fA-F]");
  });

  it("keeps inline workflow scripts below actionlint's blocking threshold", () => {
    for (const step of job.steps) {
      if (step.run) expect(Buffer.byteLength(step.run, "utf8")).toBeLessThan(4_000);
    }
  });

  it("starts only for Greptile, DCO, exact pull-request CI, or trusted reconciliation", () => {
    for (const identity of [
      ["Greptile Review", "867647", "greptile-apps"],
      ["DCO", "1861", "dco"],
    ]) {
      for (const value of identity) expect(job.if).toContain(value);
    }
    expect(job.if).toContain("github.event_name == 'repository_dispatch'");
    expect(job.if).toContain("github.event.action == 'external-admission-reconcile'");
    expect(job.if).toContain("github.event.client_payload.head_sha != ''");
    expect(job.if).toContain("github.event.workflow_run.name == 'CI'");
    expect(job.if).toContain("github.event.workflow_run.event == 'pull_request'");
    expect(job.if).toContain("github.event.workflow_run.path == '.github/workflows/ci.yml'");
    expect(job.if).toContain("github.event.workflow_run.repository.full_name == github.repository");
    expect(source).toContain("GitHub suppresses check_run workflow recursion");
    expect(policySource).toContain('name: "ci", appId: 15368, appSlug: "github-actions"');
    expect(source).not.toMatch(/CodeRabbit|copilot-pull-request-reviewer/iu);
    expect(source).not.toMatch(/^\s+pull_request(?:_target)?:/gmu);
    expect(workflow.on).not.toHaveProperty("workflow_dispatch");
    expect(source).not.toMatch(/^\s+workflow_dispatch:/gmu);
    expect(source).not.toContain("inputs.head_sha");
    expect(source.match(/github\.event\.client_payload\.head_sha/gu)).toHaveLength(7);
  });

  it("isolates rejected CI workflow runs from exact-SHA evaluator concurrency", () => {
    const group = workflow.concurrency.group;
    const canonicalCiConditions = [
      "github.event.workflow_run.name == 'CI'",
      "github.event.workflow_run.event == 'pull_request'",
      "github.event.workflow_run.path == '.github/workflows/ci.yml'",
      "github.event.workflow_run.repository.full_name == github.repository",
    ];

    expect(workflow.concurrency["cancel-in-progress"]).toBe(true);
    for (const condition of canonicalCiConditions) {
      expect(group).toContain(condition);
      expect(job.if).toContain(condition);
    }
    expect(group).toMatch(
      /github\.event\.workflow_run\.repository\.full_name == github\.repository\s+&&\s+github\.event\.workflow_run\.head_sha/u,
    );
    expect(group).toMatch(
      /github\.event_name == 'workflow_run'\s+&&\s+format\('workflow-run-\{0\}', github\.run_id\)/u,
    );
    expect(group).toMatch(
      /github\.event_name == 'repository_dispatch'\s+&&\s+github\.event\.action == 'external-admission-reconcile'\s+&&\s+github\.event\.client_payload\.head_sha/u,
    );
    expect(group).not.toContain(
      "github.event_name == 'workflow_run' && github.event.workflow_run.head_sha",
    );
  });

  it("paginates every collection and repeats exact pull-request eligibility", () => {
    expect(evaluator).toContain("commits/$HEAD_SHA/pulls?per_page=100");
    expect(evaluator).toContain("pulls/$pull_request_number/files?per_page=100");
    expect(evaluator).toContain("check-runs?filter=latest&per_page=100");
    expect(evaluator.match(/gh api --paginate --slurp/gu)).toHaveLength(4);
    expect(evaluator.match(/fetch_associated_pull_requests/gu)).toHaveLength(4);
    expect(evaluator.match(/pull_request_is_eligible/gu)).toHaveLength(4);
    expect(evaluator).toContain("external-admission-policy.mjs classify-files");
    expect(evaluator).toContain("external-admission-policy.mjs select-admission");
    expect(evaluator).toContain("external-admission-policy.mjs admission-decision");
    expect(evaluator).toContain("external-admission-policy.mjs evaluate-checks");
    expect(evaluator).toContain('changed_file_count="$(jq -r \'.changed_files\'');
    expect(evaluator).toContain('current_changed_file_count="$(jq -r \'.changed_files\'');
    expect(evaluator).toContain('final_changed_file_count="$(jq -r \'.changed_files\'');
    expect(evaluator).toContain(
      'classify_pull_request_files "$changed_file_count" <<<"$file_pages"',
    );
    expect(evaluator).toContain(
      'classify_pull_request_files "$current_changed_file_count" <<<"$current_file_pages"',
    );
    expect(evaluator).toContain(
      'classify_pull_request_files "$final_changed_file_count" <<<"$final_file_pages"',
    );
    expect(evaluator).toContain('fetch_pull_request_files "$PR_NUMBER"');
    expect(evaluator).toContain('fetch_pull_request_files "$current_pr_number"');
    expect(evaluator).toContain('fetch_pull_request_files "$final_pr_number"');
    expect(evaluator).toContain(
      '"$final_sensitive_diff" "$final_changes_greptile_exclusion_policy"',
    );
    expect(evaluator).not.toContain(
      'select_admission_requirement "$sensitive_diff" <<<"$final_pull_request"',
    );
    expect(policySource).toContain("pull request file audit count does not match changed_files");
  });

  it("requires Greptile for sensitive human PRs and trusted CI for exact automation identities", () => {
    expect(policySource).toContain("file.previous_filename");
    expect(policySource).toMatch(/bin\|installer\|src/u);
    expect(policySource).toContain("[cm]?ts|tsx");
    expect(policySource).toMatch(/actions\|codeql\|workflows\|scripts/u);
    expect(policySource).toMatch(/package\(\?:-lock\)\?/u);
    expect(policySource).toContain("vitest");
    expect(policySource).toContain("tsconfig");
    expect(evaluator).toContain('waiting_description="Waiting for Greptile review and DCO"');
    expect(greptileConfig.excludeAuthors).toEqual([
      "dependabot[bot]",
      "github-actions[bot]",
    ]);
    expect(policySource).toContain('type === "Bot"');
    expect(policySource).toContain("excludedGreptileAuthorPattern");
    expect(policySource).toContain("greptile exclusion-policy change");
    expect(evaluator.match(/select_admission_requirement/gu)).toHaveLength(4);
    expect(evaluator).toContain(
      'echo "Admission classification=$classification_name sensitive_diff=$sensitive_diff trusted_automation=$trusted_automation greptile_required=$greptile_required"',
    );
    expect(evaluator).toContain(
      'waiting_description="Waiting for trusted CI and DCO for automated PR"',
    );
    expect(evaluator).toContain(
      'success_description="CI and DCO passed for trusted automated PR"',
    );
    expect(evaluator).toContain(
      'admission_decision_fingerprint="$(admission_decision <<<"$admission_requirement")"',
    );
    expect(evaluator).toContain(
      'current_admission_decision_fingerprint" != "$admission_decision_fingerprint"',
    );
    expect(evaluator).toContain(
      'final_admission_decision_fingerprint" != "$admission_decision_fingerprint"',
    );
  });

  it("validates every CI-backed admission against exact Actions run metadata", () => {
    expect(evaluator).toContain("repos/$REPOSITORY/actions/runs/$ci_run_id");
    expect(evaluator).toContain("external-admission-policy.mjs evaluate-ci-run");
    expect(policySource).toContain('run.event === "pull_request"');
    expect(policySource).toContain('run.path === workflowPath');
    expect(policySource).toContain('run.head_sha === headSha');
    expect(evaluator).toContain('success_description="CI and DCO passed for coverage-neutral diff"');
  });

  it("leaves transient snapshots pending and never polls on a runner", () => {
    expect(evaluator.match(/Backing CI workflow run/gu)).toHaveLength(2);
    expect(evaluator.match(/ci_run_evaluation=/gu)).toHaveLength(2);
    expect(evaluator.match(/ci_run_terminal_failure=/gu)).toHaveLength(2);
    expect(evaluator).toContain(
      'run $ci_run_id evaluated as $(jq -r \'.state\' <<<"$ci_run_evaluation"): $ci_run_terminal_failure',
    );
    expect(evaluator).toContain(
      'CI run $current_ci_run_id evaluated as $(jq -r \'.state\' <<<"$current_ci_run_evaluation")',
    );
    expect(
      evaluator.match(
        /if \[\[ "\$EVENT_SOURCE" == workflow_run && "\$EVENT_WORKFLOW_RUN_ID" != "\$(?:current_)?ci_run_id" \]\]; then/gu,
      ),
    ).toHaveLength(2);
    expect(evaluator).not.toMatch(/\b(?:deadline|sleep|while)\b/u);
    expect(source).not.toContain("continuing to wait");
    expect(policySource).toContain('"pending"');
    expect(policySource).toContain('"queued"');
    expect(policySource).toContain('"in_progress"');
    expect(policySource).toContain('"requested"');
    expect(policySource).toContain('"waiting"');
  });

  it("repeats classification, checks, CI provenance, and PR eligibility before success", () => {
    const successIndex = evaluator.lastIndexOf('post_admission_status success "$success_description"');
    expect(successIndex).toBeGreaterThan(0);
    for (const marker of [
      "current_matching_prs=",
      "current_pull_request=",
      "current_file_pages=",
      "current_admission_requirement=",
      "current_check_run_pages=",
      "current_evaluation=",
      "current_ci_run=",
      "final_matching_prs=",
      "final_pull_request=",
      "final_file_pages=",
      "final_classification=",
      "final_admission_requirement=",
    ]) {
      const markerIndex = evaluator.lastIndexOf(marker);
      expect(markerIndex, marker).toBeGreaterThan(0);
      expect(markerIndex, marker).toBeLessThan(successIndex);
    }
  });

  it("documents exact-SHA repository-dispatch recovery and its trust boundary", () => {
    expect(documentation).toContain("Contents: write");
    expect(documentation).toContain("--json headRefOid");
    expect(documentation).toContain("repos/donadiosolutions/lcm/dispatches");
    expect(documentation).toContain("-f event_type=external-admission-reconcile");
    expect(documentation).toContain('-F "client_payload[head_sha]=$HEAD_SHA"');
    expect(documentation).toContain("default branch");
    expect(documentation).toMatch(/\bpending\b/u);
    expect(documentation).toMatch(/\bsuccess\b/u);
    expect(documentation).toMatch(/\bfailure\b/iu);
  });
});
