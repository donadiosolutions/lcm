import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
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

interface WorkflowRunFixture {
  event: string;
  head_sha: string;
  name: string;
  path: string;
  repository: { full_name: string };
}

interface CheckRunFixture {
  app: { id: number; slug: string };
  check_suite: { head_branch: string | null };
  head_sha: string;
  name: string;
}

interface EventFixture {
  name: string;
  github: {
    event: {
      action: string;
      check_run: CheckRunFixture;
      client_payload: { head_sha: string };
      workflow_run: WorkflowRunFixture;
    };
    event_name: string;
    repository: string;
  };
  expectedJobRun: boolean;
}

const HEAD_SHA = "a".repeat(40);
const REPOSITORY = "donadiosolutions/lcm";

function makeEventFixture(
  name: string,
  eventName: string,
  expectedJobRun: boolean,
  overrides: {
    action?: string;
    checkRun?: Partial<CheckRunFixture>;
    clientPayloadHeadSha?: string;
    workflowRun?: Partial<WorkflowRunFixture>;
  } = {},
): EventFixture {
  return {
    name,
    expectedJobRun,
    github: {
      event_name: eventName,
      repository: REPOSITORY,
      event: {
        action: overrides.action ?? "",
        client_payload: { head_sha: overrides.clientPayloadHeadSha ?? "" },
        workflow_run: {
          event: "",
          head_sha: "",
          name: "",
          path: "",
          repository: { full_name: "" },
          ...overrides.workflowRun,
        },
        check_run: {
          app: { id: 0, slug: "" },
          check_suite: { head_branch: "" },
          head_sha: "",
          name: "",
          ...overrides.checkRun,
        },
      },
    },
  };
}

function evaluateWorkflowExpression(expression: string, github: EventFixture["github"]): boolean {
  const sourceExpression = expression
    .replace(/^\s*\$\{\{\s*/u, "")
    .replace(/\s*\}\}\s*$/u, "");
  return Boolean(runInNewContext(sourceExpression, {
    github,
    startsWith: (value: string, prefix: string) => value.startsWith(prefix),
  }));
}

function simulateWorkflowFixture(fixture: EventFixture) {
  const jobRuns = evaluateWorkflowExpression(job.if, fixture.github);
  if (!jobRuns) return { evaluatorReached: false, jobRuns: false, statusWrites: 0 };

  const stepsRun = job.steps.map((step) =>
    step.if === undefined ? true : evaluateWorkflowExpression(step.if, fixture.github));
  return {
    evaluatorReached: stepsRun[3] === true,
    jobRuns: true,
    statusWrites: stepsRun[0] === true ? 1 : 0,
  };
}

const acceptedEventFixtures: EventFixture[] = [
  makeEventFixture("workflow_run requested", "workflow_run", true, {
    action: "requested",
    workflowRun: {
      event: "pull_request",
      head_sha: HEAD_SHA,
      name: "CI",
      path: ".github/workflows/ci.yml",
      repository: { full_name: REPOSITORY },
    },
  }),
  makeEventFixture("workflow_run in_progress", "workflow_run", true, {
    action: "in_progress",
    workflowRun: {
      event: "pull_request",
      head_sha: HEAD_SHA,
      name: "CI",
      path: ".github/workflows/ci.yml",
      repository: { full_name: REPOSITORY },
    },
  }),
  makeEventFixture("workflow_run completed", "workflow_run", true, {
    action: "completed",
    workflowRun: {
      event: "pull_request",
      head_sha: HEAD_SHA,
      name: "CI",
      path: ".github/workflows/ci.yml",
      repository: { full_name: REPOSITORY },
    },
  }),
  makeEventFixture("DCO created", "check_run", true, {
    action: "created",
    checkRun: {
      app: { id: 1861, slug: "dco" },
      check_suite: { head_branch: "feature/admission" },
      head_sha: HEAD_SHA,
      name: "DCO",
    },
  }),
  makeEventFixture("DCO rerequested", "check_run", true, {
    action: "rerequested",
    checkRun: {
      app: { id: 1861, slug: "dco" },
      check_suite: { head_branch: "feature/admission" },
      head_sha: HEAD_SHA,
      name: "DCO",
    },
  }),
  makeEventFixture("DCO completed", "check_run", true, {
    action: "completed",
    checkRun: {
      app: { id: 1861, slug: "dco" },
      check_suite: { head_branch: "feature/admission" },
      head_sha: HEAD_SHA,
      name: "DCO",
    },
  }),
  makeEventFixture("repository dispatch", "repository_dispatch", true, {
    action: "external-admission-reconcile",
    clientPayloadHeadSha: HEAD_SHA,
  }),
];

const rejectedEventFixtures: EventFixture[] = [
  makeEventFixture("CI wrong workflow path", "workflow_run", false, {
    workflowRun: {
      event: "pull_request",
      head_sha: HEAD_SHA,
      name: "CI",
      path: ".github/workflows/other.yml",
      repository: { full_name: REPOSITORY },
    },
  }),
  makeEventFixture("CI wrong repository", "workflow_run", false, {
    workflowRun: {
      event: "pull_request",
      head_sha: HEAD_SHA,
      name: "CI",
      path: ".github/workflows/ci.yml",
      repository: { full_name: "other/repository" },
    },
  }),
  makeEventFixture("CI wrong event", "workflow_run", false, {
    workflowRun: {
      event: "push",
      head_sha: HEAD_SHA,
      name: "CI",
      path: ".github/workflows/ci.yml",
      repository: { full_name: REPOSITORY },
    },
  }),
  makeEventFixture("DCO wrong identity", "check_run", false, {
    action: "completed",
    checkRun: {
      app: { id: 9999, slug: "dco" },
      check_suite: { head_branch: "feature/admission" },
      head_sha: HEAD_SHA,
      name: "DCO",
    },
  }),
  makeEventFixture("DCO queue ref", "check_run", false, {
    action: "completed",
    checkRun: {
      app: { id: 1861, slug: "dco" },
      check_suite: { head_branch: "gh-readonly-queue/main/pr-123-abc" },
      head_sha: HEAD_SHA,
      name: "DCO",
    },
  }),
  makeEventFixture("repository dispatch wrong action", "repository_dispatch", false, {
    action: "other-reconcile",
    clientPayloadHeadSha: HEAD_SHA,
  }),
];

const root = new URL("../", import.meta.url);
const source = readFileSync(new URL(".github/workflows/external-admission.yml", root), "utf8");
const policySource = readFileSync(
  new URL(".github/scripts/external-admission-policy.mjs", root),
  "utf8",
);
const evaluator = readFileSync(new URL(".github/scripts/external-admission.sh", root), "utf8");
const evaluatorPath = new URL(".github/scripts/external-admission.sh", root).pathname;
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
function runWithFailingAdmissionCommand(
  command: "gh" | "node" | "validator-jq" | "eligibility-jq" | "checks-ready-jq" | "ci-ready-jq" | "malformed-eligibility" | "valid-ineligible",
) {
  const directory = mkdtempSync(join(tmpdir(), "external-admission-"));
  const ghPath = join(directory, "gh");
  const jqPath = join(directory, "jq");
  const nodePath = join(directory, "node");
  const jqCallLogPath = join(directory, "jq-calls.log");
  const statusLogPath = join(directory, "statuses.log");
  const headSha = "a".repeat(40);

  try {
    writeFileSync(ghPath, `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *"/statuses/"* ]]; then
  printf '%s\\n' "$*" >> "$STATUS_LOG"
  exit 0
fi
if [[ "$*" == *"/commits/"*"/pulls?per_page=100"* ]]; then
  printf '%s\\n' '[{"number":123,"state":"open","draft":false,"base":{"ref":"main"},"head":{"sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}]'
  exit 0
fi
if [[ "$*" == *"/pulls/123"* ]]; then
  if [[ "$FAIL_ADMISSION_COMMAND" == malformed-eligibility ]]; then
    printf '%s\\n' '{malformed'
    exit 0
  fi
  if [[ "$FAIL_ADMISSION_COMMAND" == valid-ineligible ]]; then
    printf '%s\\n' '{"state":"closed","draft":false,"base":{"ref":"main"},"head":{"sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}'
    exit 0
  fi
  printf '%s\\n' '{"state":"open","draft":false,"base":{"ref":"main"},"head":{"sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}'
  exit 0
fi
if [[ "$*" == *"check-runs?filter=latest&per_page=100"* ]]; then
  if [[ "$FAIL_ADMISSION_COMMAND" == gh ]]; then
    exit 70
  fi
  printf '%s\\n' '[]'
  exit 0
fi
if [[ "$*" == *"/actions/runs/3"* ]]; then
  printf '%s\\n' '{}'
  exit 0
fi
exit 99
`);
    chmodSync(ghPath, 0o755);
    if (command === "node") {
      writeFileSync(nodePath, "#!/usr/bin/env bash\nexit 71\n");
      chmodSync(nodePath, 0o755);
    }
    if (["validator-jq", "checks-ready-jq", "ci-ready-jq"].includes(command)) {
      writeFileSync(nodePath, `#!/usr/bin/env bash
if [[ "$2" == "evaluate-checks" ]]; then
  printf '%s\\n' '{"states":[],"ready":true,"ciCheckRunId":"1","dcoCheckRunId":"2","ciRunId":"3"}'
  exit 0
fi
if [[ "$2" == "evaluate-ci-run" ]]; then
  printf '%s\\n' '{"state":"completed","ready":true}'
  exit 0
fi
exit 99
`);
      chmodSync(nodePath, 0o755);
    }
    if (["validator-jq", "eligibility-jq", "checks-ready-jq", "ci-ready-jq"].includes(command)) {
      writeFileSync(jqPath, `#!/usr/bin/env bash
set -euo pipefail
call_count=0
if [[ -f "$JQ_CALL_LOG" ]]; then
  read -r call_count < "$JQ_CALL_LOG"
fi
call_count=$((call_count + 1))
printf '%s\\n' "$call_count" > "$JQ_CALL_LOG"
if [[ "$FAIL_ADMISSION_COMMAND" == eligibility-jq && "$call_count" == 3 ]]; then
  exit 73
fi
if [[ "$FAIL_ADMISSION_COMMAND" == validator-jq && "$call_count" -ge 4 ]]; then
  exit 72
fi
if [[ "$FAIL_ADMISSION_COMMAND" == checks-ready-jq && "$call_count" == 6 ]]; then
  exit 74
fi
if [[ "$FAIL_ADMISSION_COMMAND" == ci-ready-jq && "$call_count" == 11 ]]; then
  exit 75
fi
case "$call_count" in
  1) cat ;;
  2) printf '%s\\n' 123 ;;
  3|6|11) printf '%s\\n' true ;;
  4) printf '%s\\n' '[]' ;;
  5|10) printf '%s\\n' '' ;;
  7) printf '%s\\n' 1 ;;
  8) printf '%s\\n' 2 ;;
  9) printf '%s\\n' 3 ;;
  *) exit 99 ;;
esac
`);
      chmodSync(jqPath, 0o755);
    }
    writeFileSync(statusLogPath, "");

    const result = spawnSync("bash", [evaluatorPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        EVENT_HEAD_SHA: headSha,
        EVENT_SOURCE: "repository_dispatch",
        EVENT_WORKFLOW_RUN_ID: "",
        FAIL_ADMISSION_COMMAND: command,
        JQ_CALL_LOG: jqCallLogPath,
        PATH: `${directory}:${process.env.PATH ?? ""}`,
        REPOSITORY: "example/repository",
        RUN_URL: "https://example.test/run/1",
        SERVER_URL: "https://example.test",
        STATUS_LOG: statusLogPath,
      },
    });
    return { result, statuses: readFileSync(statusLogPath, "utf8") };
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

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

    expect(job.steps[0]?.if).toBeUndefined();
    const revoke = job.steps[0]?.run ?? "";
    expect(revoke).toContain('EVENT_HEAD_SHA="${EVENT_HEAD_SHA,,}"');
    expect(revoke).toContain('if [[ ! "$EVENT_HEAD_SHA" =~ ^[0-9a-f]{40}$ ]]');
    expect(revoke).toContain('-f state="pending"');
    expect(revoke).not.toContain("/pulls");

    const checkout = job.steps[1];
    expect(checkout?.if).toBeUndefined();
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
    expect(setupNode?.if).toBeUndefined();
    expect(setupNode?.uses).toBe(
      "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
    );
    expect(setupNode?.with).toEqual({ "node-version": "22.20.0" });
    expect(job.steps[3]?.if).toBeUndefined();
    expect(evaluatorInvocation).toBe("bash .github/scripts/external-admission.sh");
  });

  it("runs the reducer for every accepted event and skips rejected identities before writes", () => {
    for (const fixture of acceptedEventFixtures) {
      expect(fixture.expectedJobRun).toBe(true);
      expect(simulateWorkflowFixture(fixture), fixture.name).toEqual({
        evaluatorReached: true,
        jobRuns: true,
        statusWrites: 1,
      });
    }

    for (const fixture of rejectedEventFixtures) {
      expect(fixture.expectedJobRun).toBe(false);
      expect(simulateWorkflowFixture(fixture), fixture.name).toEqual({
        evaluatorReached: false,
        jobRuns: false,
        statusWrites: 0,
      });
    }
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
    const initial = evaluator.indexOf('validate_required_snapshot "Initial"');
    const current = evaluator.indexOf('validate_required_snapshot "Current"');
    const final = evaluator.indexOf('validate_required_snapshot "Final"');
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
    expect(evaluator).toContain('printf -v "$fingerprint_variable" \'%s\' "$ci_check_run_id:$dco_check_run_id:$ci_run_id"');
    expect(evaluator).toContain('validate_required_snapshot "Initial" initial_admission_fingerprint');
    expect(evaluator).toContain('validate_required_snapshot "Current" current_admission_fingerprint');
    expect(evaluator).toContain('validate_required_snapshot "Final" final_admission_fingerprint');
    expect(evaluator.match(/admission_fingerprint" != "\$initial_admission_fingerprint/gu)).toHaveLength(2);
    expect(evaluator).not.toContain('VALIDATED_ADMISSION_FINGERPRINT');
    expect(evaluator).not.toContain("classify-files");
    expect(evaluator).not.toContain("select-admission");
    expect(evaluator).not.toContain("admission-decision");
  });

  it("runs each validator as a simple command and fails closed on evaluator and eligibility errors", () => {
    expect(evaluator).not.toContain("validate_or_exit");
    for (const phase of ["Initial", "Current", "Final"]) {
      expect(evaluator).toMatch(new RegExp(
        `^validate_required_snapshot "${phase}" [a-z_]+$`,
        "mu",
      ));
      expect(evaluator).not.toMatch(new RegExp(
        `(?:if|!|&&|\\|\\|)[^\\n]*validate_required_snapshot "${phase}"`,
        "u",
      ));
    }
    expect(evaluator).toContain('check_states="$(jq -c \'.states\' <<<"$evaluation")"');
    expect(evaluator).toContain('checks_ready="$(jq -r \'.ready\' <<<"$evaluation")"');
    expect(evaluator).toContain('ci_state="$(jq -r \'.state\' <<<"$ci_evaluation")"');
    expect(evaluator).toContain('ci_ready="$(jq -r \'.ready\' <<<"$ci_evaluation")"');
    expect(evaluator).not.toContain('if [[ "$(jq -r \'.ready\'');

    expect(evaluator).not.toContain("pull_request_is_eligible");
    for (const variable of [
      "pull_request_eligible",
      "current_pull_request_eligible",
      "final_pull_request_eligible",
    ]) {
      expect(evaluator).toContain(`${variable}="$(pull_request_eligibility <<<"$`);
      expect(evaluator).toContain(`if [[ "$${variable}" != true ]]; then`);
    }

    for (const command of [
      "gh",
      "node",
      "validator-jq",
      "eligibility-jq",
      "checks-ready-jq",
      "ci-ready-jq",
      "malformed-eligibility",
      "valid-ineligible",
    ] as const) {
      const { result, statuses } = runWithFailingAdmissionCommand(command);
      if (command === "valid-ineligible") expect(result.status).toBe(0);
      else if (command === "malformed-eligibility") expect(result.status).not.toBe(0);
      else expect(result.status).toBe({
        gh: 70,
        node: 71,
        "validator-jq": 72,
        "eligibility-jq": 73,
        "checks-ready-jq": 74,
        "ci-ready-jq": 75,
      }[command]);
      if (command === "valid-ineligible") {
        expect(result.stdout).toContain("admission remains pending");
      } else {
        expect(result.stdout).not.toContain("admission remains pending");
      }
      if (command === "eligibility-jq" || command === "malformed-eligibility") {
        expect(statuses).not.toContain("state=pending");
      } else {
        expect(statuses).toContain("state=pending");
      }
      if (command === "checks-ready-jq" || command === "ci-ready-jq") {
        expect(statuses.match(/state=pending/gu)).toHaveLength(1);
      }
      if (command === "valid-ineligible") expect(statuses).not.toContain("state=failure");
      else expect(statuses).toContain("state=failure");
      expect(statuses).not.toContain("state=success");
    }
  });

  it("preserves fail-closed cancellation, failure, and stale-success handling", () => {
    expect(evaluator).toContain("trap admission_failed EXIT");
    expect(evaluator).toContain("trap 'admission_cancelled INT 130' INT");
    expect(evaluator).toContain("trap 'admission_cancelled TERM 143' TERM");
    expect(evaluator).toContain("post_admission_status failure");
    expect(evaluator).toContain("External admission failed; inspect the workflow run");
    expect(evaluator).toContain('post_admission_status pending "Waiting for trusted CI and DCO"');
    const pendingWrite = evaluator.indexOf('if ! post_admission_status pending "$1"; then');
    const pendingFailure = evaluator.indexOf("exit 1", pendingWrite);
    const pendingMessage = evaluator.indexOf('echo "$2"', pendingWrite);
    const pendingExit = evaluator.indexOf("exit 0", pendingMessage);
    expect(pendingWrite).toBeGreaterThan(-1);
    expect(pendingFailure).toBeGreaterThan(pendingWrite);
    expect(pendingMessage).toBeGreaterThan(pendingFailure);
    expect(pendingExit).toBeGreaterThan(pendingMessage);
    expect(evaluator).toContain("exit_pending() {");
    expect(evaluator).toContain('if ! post_admission_status pending "$1"; then');
    expect(evaluator).not.toContain("snapshot_incomplete");
    expect(evaluator).not.toMatch(/exit_pending[\s\S]{0,240}\|\| true/gu);
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
