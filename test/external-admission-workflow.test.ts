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
  command: "gh" | "node" | "validator-jq" | "eligibility-jq" | "checks-ready-jq" | "ci-ready-jq" | "unknown-policy-command" | "malformed-eligibility" | "valid-ineligible",
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
  printf '%s\\n' '[{"number":123,"state":"open","draft":false,"base":{"ref":"main","repo":{"full_name":"example/repository"}},"head":{"sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}]'
  exit 0
fi
if [[ "$*" == *"/pulls/123"* ]]; then
  if [[ "$FAIL_ADMISSION_COMMAND" == malformed-eligibility ]]; then
    printf '%s\\n' '{malformed'
    exit 0
  fi
  if [[ "$FAIL_ADMISSION_COMMAND" == valid-ineligible ]]; then
    printf '%s\\n' '{"number":123,"state":"closed","draft":false,"base":{"ref":"main","repo":{"full_name":"example/repository"}},"head":{"sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}'
    exit 0
  fi
  printf '%s\\n' '{"number":123,"state":"open","draft":false,"base":{"ref":"main","repo":{"full_name":"example/repository"}},"head":{"sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}'
  exit 0
fi
if [[ "$*" == *"/branches/"* ]]; then
  printf '%s\\n' '{"protected":true}'
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
    if (command === "unknown-policy-command") {
      writeFileSync(nodePath, `#!/usr/bin/env bash
if [[ "$2" == "evaluate-freshness" ]]; then
  printf '%s\\n' '{"ready":true}'
  exit 0
fi
exit 99
`);
      chmodSync(nodePath, 0o755);
      const result = spawnSync(nodePath, ["external-admission-policy.mjs", "unknown-policy-command"], {
        encoding: "utf8",
      });
      return { result, statuses: "" };
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
if [[ "$2" == "evaluate-freshness" ]]; then
  printf '%s\\n' '{"ready":true}'
  exit 0
fi
if [[ "$2" == "evaluate-pr" ]]; then
  if [[ "$5" == false ]]; then
    printf '%s\\n' '{"eligible":false,"reason":"unprotected-base"}'
    exit 0
  fi
  printf '%s\\n' '{"eligible":true}'
  exit 0
fi
exit 99
`);
      chmodSync(nodePath, 0o755);
    }
    if (["validator-jq", "eligibility-jq", "checks-ready-jq", "ci-ready-jq"].includes(command)) {
      writeFileSync(jqPath, `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "-rn" ]]; then
  exec /usr/bin/jq "$@"
fi
call_count=0
if [[ -f "$JQ_CALL_LOG" ]]; then
  read -r call_count < "$JQ_CALL_LOG"
fi
call_count=$((call_count + 1))
printf '%s\\n' "$call_count" > "$JQ_CALL_LOG"
if [[ "$FAIL_ADMISSION_COMMAND" == eligibility-jq && "$call_count" == 5 ]]; then
  exit 73
fi
if [[ "$FAIL_ADMISSION_COMMAND" == validator-jq && "$call_count" == 10 ]]; then
  exit 72
fi
if [[ "$FAIL_ADMISSION_COMMAND" == ci-ready-jq && "$call_count" == 22 ]]; then
  exit 75
fi
if [[ "$FAIL_ADMISSION_COMMAND" == checks-ready-jq && "$1" == "-r" && "$2" == ".ready" ]]; then
  input="$(cat)"
  if [[ "$input" == *'"states"'* ]]; then
    exit 74
  fi
  exec /usr/bin/jq "$@" <<<"$input"
fi
exec /usr/bin/jq "$@"
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

type AdmissionScenario =
  | "stale-workflow-run"
  | "newer-workflow-run"
  | "in-progress-workflow-run"
  | "equal-in-progress-workflow-run"
  | "equal-dco-created"
  | "equal-dco-rerequested"
  | "equal-dco-completed"
  | "no-unique-pr"
  | "protected-main"
  | "protected-maintenance"
  | "unprotected-maintenance"
  | "invalid-or-changed-base"
  | "transient-base"
  | "mixed-deleted-base"
  | "duplicate-base-candidates";

type AdmissionEligibilityVariant =
  | "unsupported-base"
  | "wrong-base-repository"
  | "protection-changed"
  | "protection-deleted";

function makeAdmissionPullRequest({
  number = 123,
  baseRef = "main",
  baseRepository = REPOSITORY,
  draft = false,
  state = "open",
  headSha = HEAD_SHA,
} = {}) {
 return {
    number,
   state,
   draft,
    head: { sha: headSha },
    base: { ref: baseRef, repo: { full_name: baseRepository } },
  };
}

function runAdmissionScenario(
  scenario: AdmissionScenario,
  eligibilityVariant: AdmissionEligibilityVariant = "wrong-base-repository",
) {
  const directory = mkdtempSync(join(tmpdir(), "external-admission-scenario-"));
  const ghPath = join(directory, "gh");
  const branchCallsPath = join(directory, "branch-calls.log");
  const branchRequestsPath = join(directory, "branch-requests.log");
  const statusLogPath = join(directory, "statuses.log");
  const headSha = "a".repeat(40);
  const ciRunId = "123";
  const ciCheckRun = {
    id: 10,
    name: "ci",
    head_sha: headSha,
    app: { id: 15368, slug: "github-actions" },
    status: "completed",
    conclusion: "success",
    details_url: `https://example.test/${REPOSITORY}/actions/runs/${ciRunId}/job/456`,
  };
  const dcoCheckRun = {
    id: 11,
    name: "DCO",
    head_sha: headSha,
    app: { id: 1861, slug: "dco" },
    status: "completed",
    conclusion: "success",
  };
  const ciRun = {
    id: Number(ciRunId),
    event: "pull_request",
    path: ".github/workflows/ci.yml",
    head_sha: headSha,
    status: "completed",
    conclusion: "success",
    repository: { full_name: REPOSITORY },
  };
  let associatedPullRequests = [makeAdmissionPullRequest()];
  let pullRequest = makeAdmissionPullRequest();
  let branchProtectionSequence = ["true"];
  let branchDeletedSuffix = "";
  let branchLookupMustNotHappen = false;
  let eventSource = "repository_dispatch";
  let eventWorkflowRunId = "";
  let eventWorkflowRunAction = "";
  let eventCheckRunId = "";
  let eventCheckRunAction = "";

  switch (scenario) {
    case "stale-workflow-run":
      eventSource = "workflow_run";
      eventWorkflowRunId = "99";
      eventWorkflowRunAction = "completed";
      break;
    case "newer-workflow-run":
      eventSource = "workflow_run";
      eventWorkflowRunId = "124";
      eventWorkflowRunAction = "completed";
      break;
    case "in-progress-workflow-run":
      eventSource = "workflow_run";
      eventWorkflowRunId = "99";
      eventWorkflowRunAction = "in_progress";
      break;
    case "equal-in-progress-workflow-run":
      eventSource = "workflow_run";
      eventWorkflowRunId = ciRunId;
      eventWorkflowRunAction = "in_progress";
      break;
    case "equal-dco-created":
      eventSource = "check_run";
      eventCheckRunId = "11";
      eventCheckRunAction = "created";
      break;
    case "equal-dco-rerequested":
      eventSource = "check_run";
      eventCheckRunId = "11";
      eventCheckRunAction = "rerequested";
      break;
    case "equal-dco-completed":
      eventSource = "check_run";
      eventCheckRunId = "11";
      eventCheckRunAction = "completed";
      break;
    case "no-unique-pr":
      associatedPullRequests = [];
      break;
    case "protected-main":
      break;
    case "protected-maintenance":
      pullRequest = makeAdmissionPullRequest({ baseRef: "maintenance/1.4.x" });
      associatedPullRequests = [pullRequest];
      break;
    case "unprotected-maintenance":
      pullRequest = makeAdmissionPullRequest({ baseRef: "maintenance/1.4.x" });
      associatedPullRequests = [pullRequest];
      branchProtectionSequence = ["false"];
      break;
    case "invalid-or-changed-base":
      pullRequest = makeAdmissionPullRequest({ baseRef: "maintenance/1.x" });
      associatedPullRequests = [pullRequest];
      branchProtectionSequence = ["true"];
      break;
  }

  if (scenario === "invalid-or-changed-base") {
    switch (eligibilityVariant) {
      case "unsupported-base":
        associatedPullRequests = [makeAdmissionPullRequest({ baseRef: "maintenance/1.x" })];
        pullRequest = makeAdmissionPullRequest({ baseRef: "maintenance/1.x" });
        branchProtectionSequence = ["true"];
        branchLookupMustNotHappen = true;
        break;
      case "wrong-base-repository":
        associatedPullRequests = [makeAdmissionPullRequest({
          baseRef: "main",
          baseRepository: "other/repository",
        })];
        pullRequest = makeAdmissionPullRequest({
          baseRef: "main",
          baseRepository: "other/repository",
        });
        branchProtectionSequence = ["true"];
        branchLookupMustNotHappen = true;
        break;
      case "protection-changed":
        associatedPullRequests = [makeAdmissionPullRequest({ baseRef: "main" })];
        pullRequest = makeAdmissionPullRequest({ baseRef: "main" });
        branchProtectionSequence = ["true", "true", "true", "true", "true", "false"];
        break;
      case "protection-deleted":
        associatedPullRequests = [makeAdmissionPullRequest({ baseRef: "main" })];
        pullRequest = makeAdmissionPullRequest({ baseRef: "main" });
        branchDeletedSuffix = "main";
        break;
    }
  } else if (scenario === "transient-base") {
    branchProtectionSequence = ["503"];
  } else if (scenario === "mixed-deleted-base") {
    associatedPullRequests = [
      makeAdmissionPullRequest({ number: 122, baseRef: "maintenance/1.4.x" }),
      makeAdmissionPullRequest({ number: 123, baseRef: "main" }),
    ];
    pullRequest = makeAdmissionPullRequest({ number: 123, baseRef: "main" });
    branchProtectionSequence = ["deleted", "true"];
    branchDeletedSuffix = "maintenance%2F1.4.x";
  } else if (scenario === "duplicate-base-candidates") {
    associatedPullRequests = [
      makeAdmissionPullRequest({ number: 122, baseRef: "main" }),
      makeAdmissionPullRequest({ number: 123, baseRef: "main" }),
    ];
    pullRequest = makeAdmissionPullRequest({ number: 123, baseRef: "main" });
    branchProtectionSequence = ["true"];
  }

  try {
    writeFileSync(ghPath, `#!/usr/bin/env bash
set -euo pipefail
endpoint=""
for argument in "$@"; do
  if [[ "$argument" == repos/* ]]; then endpoint="$argument"; fi
done
if [[ "$endpoint" == repos/*/statuses/* ]]; then
  state=""
  description=""
  for argument in "$@"; do
    case "$argument" in
      state=*) state="\${argument#state=}" ;;
      description=*) description="\${argument#description=}" ;;
    esac
  done
  printf '%s\t%s\n' "$state" "$description" >> "$STATUS_LOG"
  exit 0
fi
if [[ "$endpoint" == repos/*/commits/*/pulls?per_page=100 ]]; then
  printf '%s\n' "$ASSOCIATED_PRS_JSON"
  exit 0
fi
if [[ "$endpoint" == repos/*/pulls/123 ]]; then
  printf '%s\n' "$PULL_REQUEST_JSON"
  exit 0
fi
  if [[ "$endpoint" == repos/*/branches/* ]]; then
  call_count=0
  if [[ -f "$BRANCH_CALLS" ]]; then read -r call_count < "$BRANCH_CALLS"; fi
  call_count=$((call_count + 1))
  printf '%s\n' "$call_count" > "$BRANCH_CALLS"
  printf '%s\n' "$endpoint" >> "$BRANCH_REQUESTS"
  if [[ "$BRANCH_LOOKUP_MUST_NOT_HAPPEN" == true ]]; then
    printf 'unexpected branch metadata lookup: %s\n' "$endpoint" >&2
    exit 98
  fi
  if [[ -n "$BRANCH_DELETED_SUFFIX" && "$endpoint" == *"/branches/$BRANCH_DELETED_SUFFIX" ]]; then
    printf 'HTTP/2 404 Not Found\nContent-Type: application/json\n\n{"message":"Not Found"}\n'
    exit 1
  fi
  IFS=',' read -r -a protection <<< "$BRANCH_PROTECTION_SEQUENCE"
  index=$((call_count - 1))
  if (( index >= \${#protection[@]} )); then index=\${#protection[@]}-1; fi
  if [[ "\${protection[index]}" == deleted ]]; then
    printf 'HTTP/2 404 Not Found\nContent-Type: application/json\n\n{"message":"Not Found"}\n'
    exit 1
  fi
  if [[ "\${protection[index]}" == 503 ]]; then
    printf 'HTTP/2 503 Service Unavailable\nContent-Type: application/json\n\n{"message":"Service Unavailable"}\n'
    exit 1
  fi
  printf '{"protected":%s}\n' "\${protection[index]}"
  exit 0
fi
if [[ "$endpoint" == *"check-runs?filter=latest&per_page=100" ]]; then
  printf '%s\n' "$CHECK_RUN_PAGES_JSON"
  exit 0
fi
if [[ "$endpoint" == repos/*/actions/runs/* ]]; then
  printf '%s\n' "$CI_RUN_JSON"
  exit 0
fi
printf 'unexpected fake-gh endpoint: %s\n' "$endpoint" >&2
exit 99
`);
    chmodSync(ghPath, 0o755);
    writeFileSync(branchCallsPath, "0\n");
    writeFileSync(branchRequestsPath, "");
    writeFileSync(statusLogPath, "");

    const result = spawnSync("bash", [evaluatorPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        ASSOCIATED_PRS_JSON: JSON.stringify(associatedPullRequests),
        BRANCH_CALLS: branchCallsPath,
        BRANCH_DELETED_SUFFIX: branchDeletedSuffix,
        BRANCH_LOOKUP_MUST_NOT_HAPPEN: String(branchLookupMustNotHappen),
        BRANCH_REQUESTS: branchRequestsPath,
        BRANCH_PROTECTION_SEQUENCE: branchProtectionSequence.join(","),
        CHECK_RUN_PAGES_JSON: JSON.stringify([{ check_runs: [ciCheckRun, dcoCheckRun] }]),
        CI_RUN_JSON: JSON.stringify(ciRun),
        EVENT_HEAD_SHA: headSha,
        EVENT_SOURCE: eventSource,
        EVENT_CHECK_RUN_ACTION: eventCheckRunAction,
        EVENT_CHECK_RUN_ID: eventCheckRunId,
        EVENT_WORKFLOW_RUN_ACTION: eventWorkflowRunAction,
        EVENT_WORKFLOW_RUN_ID: eventWorkflowRunId,
        PATH: `${directory}:${process.env.PATH ?? ""}`,
        PULL_REQUEST_JSON: JSON.stringify(pullRequest),
        REPOSITORY,
        RUN_URL: "https://example.test/run/1",
        SERVER_URL: "https://example.test",
        STATUS_LOG: statusLogPath,
      },
    });
    return {
      result,
      statuses: readFileSync(statusLogPath, "utf8").trim().split("\n").filter(Boolean),
      branchCalls: Number(readFileSync(branchCallsPath, "utf8").trim()),
      branchRequests: readFileSync(branchRequestsPath, "utf8").trim().split("\n").filter(Boolean),
    };
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

describe("external admission workflow", () => {
  it("uses the latest canonical CI run when a workflow event ID is stale", () => {
    const { result, statuses } = runAdmissionScenario("stale-workflow-run");
    expect(result.status, `${result.stdout}\n${result.stderr}\n${statuses.join("\n")}`).toBe(0);
    expect(statuses.at(-1)?.split("\t", 1)[0]).toBe("success");
    expect(result.stderr).toContain("does not authorize state");
  });

  it("reconciles a non-completed trusted workflow event against current success", () => {
    const { result, statuses } = runAdmissionScenario("in-progress-workflow-run");
    expect(result.status).toBe(0);
    expect(statuses.at(-1)?.split("\t", 1)[0]).toBe("success");
  });

  it("keeps a newer CI event pending until its run is visible", () => {
    const { result, statuses } = runAdmissionScenario("newer-workflow-run");
    expect(result.status).toBe(0);
    expect(statuses.some((status) => status.startsWith("pending\t"))).toBe(true);
    expect(statuses.some((status) => status.startsWith("success\t"))).toBe(false);
  });

  it("keeps an equal in-progress CI event pending", () => {
    const { result, statuses } = runAdmissionScenario("equal-in-progress-workflow-run");
    expect(result.status).toBe(0);
    expect(statuses.some((status) => status.startsWith("pending\t"))).toBe(true);
    expect(statuses.some((status) => status.startsWith("success\t"))).toBe(false);
  });

  it.each([
    ["equal-dco-created", "created"],
    ["equal-dco-rerequested", "rerequested"],
  ] as const)("keeps an equal DCO %s event pending", (scenario) => {
    const { result, statuses } = runAdmissionScenario(scenario);
    expect(result.status).toBe(0);
    expect(statuses.some((status) => status.startsWith("pending\t"))).toBe(true);
    expect(statuses.some((status) => status.startsWith("success\t"))).toBe(false);
  });

  it("reconciles an equal completed DCO event against current evidence", () => {
    const { result, statuses } = runAdmissionScenario("equal-dco-completed");
    expect(result.status).toBe(0);
    expect(statuses.at(-1)?.split("\t", 1)[0]).toBe("success");
  });

  it("terminalizes an exact head with no unique eligible pull request", () => {
    const { result, statuses } = runAdmissionScenario("no-unique-pr");
    expect(result.status).toBe(0);
    expect(statuses).toHaveLength(1);
    expect(statuses[0]?.split("\t", 1)[0]).toBe("failure");
    expect(statuses[0]).toContain("not uniquely eligible");
  });

  it("admits an exact-head pull request on protected main", () => {
    const { result, statuses, branchCalls, branchRequests } =
      runAdmissionScenario("protected-main");
    expect(result.status).toBe(0);
    expect(statuses.at(-1)?.split("\t", 1)[0]).toBe("success");
    expect(branchCalls).toBeGreaterThan(1);
    expect(branchRequests.every((request) => request.endsWith("/branches/main"))).toBe(true);
  });

  it("admits an exact-head pull request on protected maintenance/1.4.x", () => {
    const { result, statuses, branchCalls, branchRequests } =
      runAdmissionScenario("protected-maintenance");
    expect(result.status).toBe(0);
    expect(statuses.at(-1)?.split("\t", 1)[0]).toBe("success");
    expect(branchCalls).toBeGreaterThan(1);
    expect(branchRequests.every((request) => request.endsWith("/branches/maintenance%2F1.4.x")))
      .toBe(true);
  });

  it("terminalizes an unprotected maintenance/1.4.x pull request", () => {
    const { result, statuses } = runAdmissionScenario("unprotected-maintenance");
    expect(result.status).toBe(0);
    expect(statuses.at(-1)?.split("\t", 1)[0]).toBe("failure");
    expect(statuses.at(-1)).toContain("not uniquely eligible");
  });

  it("preflights unsupported and mismatched bases before branch metadata lookup", () => {
    for (const variant of [
      "unsupported-base",
      "wrong-base-repository",
    ] as const) {
      const { result, statuses, branchCalls, branchRequests } =
        runAdmissionScenario("invalid-or-changed-base", variant);
      expect(result.status, variant).toBe(0);
      expect(statuses.at(-1)?.split("\t", 1)[0], variant).toBe("failure");
      expect(statuses.at(-1), variant).toContain("not uniquely eligible");
      expect(statuses.at(-1), variant).not.toMatch(/^pending\t/u);
      expect(branchCalls, variant).toBe(0);
      expect(branchRequests, variant).toEqual([]);
      expect(result.stderr, variant).not.toContain("unexpected branch metadata lookup");
    }
  });

  it("fails closed when supported-base protection changes or disappears", () => {
    const changed = runAdmissionScenario("invalid-or-changed-base", "protection-changed");
    expect(changed.result.status).toBe(0);
    expect(changed.statuses.at(-1)?.split("\t", 1)[0]).toBe("failure");
    expect(changed.statuses.at(-1)).toContain("not uniquely eligible");
    expect(changed.branchCalls).toBeGreaterThan(0);
    expect(changed.branchRequests.every((request) => request.endsWith("/branches/main")))
      .toBe(true);

    const deleted = runAdmissionScenario("invalid-or-changed-base", "protection-deleted");
    expect(deleted.result.status).toBe(0);
    expect(deleted.statuses.at(-1)?.split("\t", 1)[0]).toBe("failure");
    expect(deleted.statuses.at(-1)).toContain("not uniquely eligible");
    expect(deleted.branchCalls).toBeGreaterThan(0);
    expect(deleted.branchRequests.every((request) => request.endsWith("/branches/main")))
      .toBe(true);
  });

  it("keeps transient supported-base API failures pending", () => {
    const { result, statuses } = runAdmissionScenario("transient-base");
    expect(result.status).toBe(0);
    expect(statuses).toHaveLength(1);
    expect(statuses[0]?.split("\t", 1)[0]).toBe("pending");
    expect(statuses.some((status) => status.startsWith("success\t"))).toBe(false);
  });

  it("ignores a deleted historical base when one valid PR remains", () => {
    const { result, statuses, branchRequests } = runAdmissionScenario("mixed-deleted-base");
    const evidence = `${result.stdout}\n${result.stderr}\n${statuses.join("\n")}\n${branchRequests.join("\n")}`;
    expect(result.status, evidence).toBe(0);
    expect(statuses.at(-1)?.split("\t", 1)[0], evidence).toBe("success");
  });

  it("caches duplicate base protection lookups within one PR snapshot", () => {
    const { result, statuses, branchCalls, branchRequests } =
      runAdmissionScenario("duplicate-base-candidates");
    const evidence = `${result.stdout}\n${result.stderr}\n${statuses.join("\n")}\n${branchRequests.join("\n")}`;
    expect(result.status, evidence).toBe(0);
    expect(statuses.at(-1)?.split("\t", 1)[0], evidence).toBe("failure");
    expect(branchCalls, evidence).toBe(1);
  });

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
    expect(evaluator).toContain("EVENT_WORKFLOW_RUN_ACTION");
    expect(evaluator).toContain("EVENT_CHECK_RUN_ACTION");
    expect(evaluator).toContain("EVENT_CHECK_RUN_ID");
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
    expect(evaluator).not.toContain("pull_request_eligibility");
    for (const variable of [
      "pull_request_evaluation",
      "current_pull_request_evaluation",
      "final_pull_request_evaluation",
    ]) {
      expect(evaluator).toContain(`${variable}="$PULL_REQUEST_EVALUATION"`);
    }
    for (const variable of [
      "pull_request_eligible",
      "current_pull_request_eligible",
      "final_pull_request_eligible",
    ]) {
      expect(evaluator).toContain(`${variable}="$(jq -r '.eligible'`);
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
      const evidence = `${command}\n${result.stdout}\n${result.stderr}\n${statuses}`;
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
        expect(result.stdout).toContain("admission failed");
      } else {
        expect(result.stdout, evidence).not.toContain("admission remains pending");
      }
      if (
        command === "node"
        || command === "validator-jq"
        || command === "eligibility-jq"
        || command === "malformed-eligibility"
        || command === "valid-ineligible"
      ) {
        expect(statuses, evidence).not.toContain("state=pending");
      } else {
        expect(statuses, evidence).toContain("state=pending");
      }
      if (command === "checks-ready-jq" || command === "ci-ready-jq") {
        expect(statuses.match(/state=pending/gu), evidence).toHaveLength(1);
      }
      expect(statuses, evidence).toContain("state=failure");
      expect(statuses, evidence).not.toContain("state=success");
    }
  });

  it("keeps unknown fake policy commands fail-closed", () => {
    const { result } = runWithFailingAdmissionCommand("unknown-policy-command");
    expect(result.status).toBe(99);
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

  it("documents immutable configuration and freshness/transient semantics", () => {
    expect(documentation).toMatch(/## Configuration\n/iu);
    expect(documentation).toMatch(/no user-configurable options/iu);
    expect(documentation).toMatch(/freshness lower bound/iu);
    expect(documentation).toMatch(/transient.*branch.*pending/isu);
  });
});
