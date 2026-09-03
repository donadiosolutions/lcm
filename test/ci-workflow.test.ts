import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { load as loadYaml } from "js-yaml";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

interface WorkflowStep {
  name?: string;
  run?: string;
  uses?: string;
  if?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}

interface IntegrationJob {
  name: string;
  needs: string;
  "runs-on": string;
  "timeout-minutes"?: number;
  if?: string;
  "continue-on-error"?: boolean;
  steps: WorkflowStep[];
}

interface CodecovJob {
  needs: string;
  if: string;
  permissions: Record<string, string>;
  steps: WorkflowStep[];
}

interface CiWorkflow {
  jobs: {
    environment: {
      name: string;
      "runs-on": string;
      steps: WorkflowStep[];
    };
    core: {
      name: string;
      needs: string;
      "runs-on": string;
      env?: Record<string, string>;
      steps: WorkflowStep[];
    };
    postgresql: {
      needs: string;
      "runs-on": string;
      strategy: { matrix: { run: number[] } };
    };
    "linux-systemd": IntegrationJob;
    "macos-launchd": IntegrationJob;
    ci: {
      name: string;
      needs: string[];
      if: string;
      steps: WorkflowStep[];
    };
    codecov: CodecovJob;
    "codecov-fork": CodecovJob;
  };
}

interface CodeqlWorkflow {
  name: string;
  on: {
    push?: { branches: string[] };
    schedule?: Array<{ cron: string }>;
    workflow_dispatch?: null;
    pull_request: { branches: string[] };
    merge_group: { types: string[] };
  };
  permissions: Record<string, string>;
  concurrency: {
    group: string;
    "cancel-in-progress": boolean;
  };
  jobs: {
    analyze: {
      permissions: Record<string, string>;
      steps: WorkflowStep[];
    };
  };
}

const source = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const codeqlSource = readFileSync(new URL("../.github/workflows/codeql.yml", import.meta.url), "utf8");
const codeqlExtendedSource = readFileSync(
  new URL("../.github/workflows/codeql-extended.yml", import.meta.url),
  "utf8",
);
const launchdIntegrationSource = readFileSync(
  new URL("./daemon/lifecycle-launchd.integration.test.ts", import.meta.url),
  "utf8",
);
const workflow = loadYaml(source) as CiWorkflow;
const codeqlWorkflow = loadYaml(codeqlSource) as CodeqlWorkflow;
const codeqlExtendedWorkflow = loadYaml(codeqlExtendedSource) as CodeqlWorkflow;
const launchdEvidenceRun =
  workflow.jobs["macos-launchd"].steps.find((step) => step.name === "Run launchd integration path")?.run ?? "";
const launchdFixtureToken = "11111111-1111-1111-1111-111111111111";
const launchdFixtureLabel = "com.donadiosolutions.lcm.daemon.0123456789abcdef0123";

function runLaunchdEvidenceFixture(output: string): {
  success: boolean;
  injectedFileCreated: boolean;
} {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "lcm-ci-evidence-"));
  const resourceRoot = join(fixtureRoot, "resource");
  const binRoot = join(fixtureRoot, "bin");
  const fixtureOutput = join(fixtureRoot, "fixture.out");
  const injectedFile = `${fixtureRoot}-injected`;
  mkdirSync(binRoot);
  writeFileSync(
    fixtureOutput,
    output.replaceAll("__LCM_LAUNCHD_INJECTED_FILE__", injectedFile),
    { mode: 0o600 },
  );
  writeFileSync(
    join(binRoot, "uuidgen"),
    `#!/bin/sh
printf '%s\\n' '${launchdFixtureToken}'
`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(binRoot, "npx"),
    `#!/bin/sh
set -eu
printf '%s %s\\n' "$LCM_LAUNCHD_EVIDENCE_TOKEN" "$LCM_LAUNCHD_FIXTURE_LABEL" > "$LCM_LAUNCHD_RESOURCE_ROOT/launchd.label"
chmod 0600 "$LCM_LAUNCHD_RESOURCE_ROOT/launchd.label"
cat "$LCM_LAUNCHD_FIXTURE_OUTPUT"
`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(binRoot, "stat"),
    `#!/bin/sh
set -eu
if [ "$1" = "-f" ] && [ "$2" = "%Lp" ]; then
  printf '600\\n'
  exit 0
fi
exit 1
`,
    { mode: 0o755 },
  );
  writeFileSync(join(binRoot, "launchctl"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${binRoot}:${process.env.PATH ?? ""}`,
    LCM_LAUNCHD_FIXTURE_OUTPUT: fixtureOutput,
    LCM_LAUNCHD_FIXTURE_LABEL: launchdFixtureLabel,
    LCM_LAUNCHD_RESOURCE_ROOT: resourceRoot,
    LCM_LAUNCHD_LABEL: "com.donadiosolutions.lcm.ci.1.1",
    LCM_LAUNCHD_SCOPE_ID: "ci-fixture-1-1",
  };
  delete env.NODE;
  delete env.NODE_PATH;

  let success = false;
  let injectedFileCreated = false;
  try {
    execFileSync("bash", ["-c", launchdEvidenceRun], { env, stdio: "ignore" });
    success = true;
  } catch {
    success = false;
  } finally {
    injectedFileCreated = existsSync(injectedFile);
    rmSync(injectedFile, { force: true });
    rmSync(fixtureRoot, { force: true, recursive: true });
  }
  return { success, injectedFileCreated };
}

const expectedCodecovRunSteps = [
  {
    name: "Download Vitest reports",
    run: [
      "set -Eeuo pipefail",
      'gh run download "$GITHUB_RUN_ID" \\',
      '  --repo "$REPOSITORY" \\',
      "  --name vitest-reports \\",
      "  --dir .",
    ].join("\n"),
  },
  {
    name: "Download verified Codecov CLI",
    run: [
      "set -Eeuo pipefail",
      'CODECOV_CLI_PATH="$RUNNER_TEMP/codecov"',
      'gh release download "$CODECOV_CLI_TAG" \\',
      '  --repo "$CODECOV_CLI_REPOSITORY" \\',
      '  --pattern "$CODECOV_CLI_ASSET" \\',
      '  --output "$CODECOV_CLI_PATH"',
      "printf '%s  %s\\n' \"$CODECOV_CLI_SHA256\" \"$CODECOV_CLI_PATH\" \\",
      "  | sha256sum --check --strict",
      'chmod 0755 "$CODECOV_CLI_PATH"',
    ].join("\n"),
  },
];

describe("CI workflow", () => {
  it("runs both CodeQL workflows for protected main and maintenance pull requests", () => {
    expect(codeqlWorkflow.on).toEqual({
      push: { branches: ["main"] },
      pull_request: { branches: ["main", "maintenance/**"] },
      merge_group: { types: ["checks_requested"] },
    });
    expect(codeqlExtendedWorkflow.on).toEqual({
      schedule: [{ cron: "17 5 * * 1" }],
      workflow_dispatch: null,
      pull_request: { branches: ["main", "maintenance/**"] },
      merge_group: { types: ["checks_requested"] },
    });
  });

  it("preserves the CodeQL action pins, permissions, and concurrency contracts", () => {
    for (const workflowUnderTest of [codeqlWorkflow, codeqlExtendedWorkflow]) {
      expect(workflowUnderTest.permissions).toEqual({
        actions: "read",
        contents: "read",
      });
      expect(workflowUnderTest.concurrency).toEqual({
        group: "codeql-${{ github.workflow }}-${{ github.ref }}",
        "cancel-in-progress": true,
      });
      expect(workflowUnderTest.jobs.analyze.permissions).toEqual({
        actions: "read",
        contents: "read",
        "security-events": "write",
      });
      expect(
        workflowUnderTest.jobs.analyze.steps
          .filter((step) => step.uses !== undefined)
          .map((step) => ({ name: step.name, uses: step.uses })),
      ).toEqual([
        {
          name: "Checkout",
          uses: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
        },
        {
          name: "Initialize CodeQL",
          uses: "github/codeql-action/init@f205ea1c3313d32999d8d6a48b4f6530d4437b38",
        },
        {
          name: "Analyze",
          uses: "github/codeql-action/analyze@f205ea1c3313d32999d8d6a48b4f6530d4437b38",
        },
      ]);
    }
  });

  it("seeds the environment and gates the stable check on every required suite", () => {
    expect(workflow.jobs.environment).toMatchObject({
      name: "Initialize CI environment",
      "runs-on": "blacksmith-4vcpu-ubuntu-2404",
    });
    expect(workflow.jobs.core.name).toBe("Core CI");
    expect(workflow.jobs.core.needs).toBe("environment");
    expect(workflow.jobs.core["runs-on"]).toBe("blacksmith-4vcpu-ubuntu-2404");
    expect(workflow.jobs.postgresql.needs).toBe("environment");
    expect(workflow.jobs.postgresql["runs-on"]).toBe("blacksmith-4vcpu-ubuntu-2404");
    expect(workflow.jobs.postgresql.strategy.matrix.run).toEqual([1, 2]);
    expect(workflow.jobs["linux-systemd"]).toMatchObject({
      name: "Linux Ubuntu 24.04 user-systemd integration",
      needs: "environment",
      "runs-on": "ubuntu-24.04",
      "timeout-minutes": 15,
    });
    expect(workflow.jobs["macos-launchd"]).toMatchObject({
      name: "macOS 15 launchd feasibility",
      needs: "environment",
      "runs-on": "macos-15",
      "timeout-minutes": 15,
    });
    expect(workflow.jobs.ci).toMatchObject({
      name: "ci",
      needs: ["environment", "core", "postgresql", "linux-systemd", "macos-launchd"],
      if: "${{ always() }}",
    });
    const gate = workflow.jobs.ci.steps.find((step) => step.name === "Require every CI suite");
    expect(gate?.env).toEqual({
      ENVIRONMENT_RESULT: "${{ needs.environment.result }}",
      CORE_RESULT: "${{ needs.core.result }}",
      POSTGRESQL_RESULT: "${{ needs.postgresql.result }}",
      LINUX_SYSTEMD_RESULT: "${{ needs.linux-systemd.result }}",
      MACOS_LAUNCHD_RESULT: "${{ needs.macos-launchd.result }}",
    });
    expect(gate?.run).toContain(
      '[[ "$ENVIRONMENT_RESULT" != success || "$CORE_RESULT" != success || "$POSTGRESQL_RESULT" != success || "$LINUX_SYSTEMD_RESULT" != success || "$MACOS_LAUNCHD_RESULT" != success ]]',
    );
    expect(gate?.run).toContain("Linux user-systemd result: $LINUX_SYSTEMD_RESULT");
    expect(gate?.run).toContain("macOS launchd result: $MACOS_LAUNCHD_RESULT");
    expect(workflow.jobs.ci.needs).toContain("macos-launchd");
    expect(workflow.jobs.codecov.needs).toBe("ci");
    expect(workflow.jobs["codecov-fork"].needs).toBe("ci");
  });

  it("publishes the single test report artifact after the core test run", () => {
    const steps = workflow.jobs.core.steps;
    const testCiSteps = steps.filter((step) => step.run === "npm run test:ci");
    expect(testCiSteps).toHaveLength(1);
    expect(testCiSteps[0]?.env).toEqual({
      LCM_TEST_ARTIFACT_ROOT:
        "${{ runner.temp }}/lcm-vitest-${{ github.run_id }}-${{ github.run_attempt }}",
    });
    expect(workflow.jobs.core.env ?? {}).not.toHaveProperty("LCM_TEST_ARTIFACT_ROOT");

    const uploadSteps = steps.filter((step) => step.name === "Upload Vitest reports");
    expect(uploadSteps).toHaveLength(1);
    const uploadStep = uploadSteps[0];
    expect(uploadStep).toBeDefined();
    expect(steps.indexOf(uploadStep!)).toBeGreaterThan(steps.indexOf(testCiSteps[0]!));
    expect(uploadStep).toMatchObject({
      name: "Upload Vitest reports",
      if: "${{ !cancelled() }}",
      uses: "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
      with: {
        name: "vitest-reports",
        path:
          "${{ runner.temp }}/lcm-vitest-${{ github.run_id }}-${{ github.run_attempt }}/coverage/\n${{ runner.temp }}/lcm-vitest-${{ github.run_id }}-${{ github.run_attempt }}/test-report.junit.xml\n",
        "if-no-files-found": "warn",
      },
    });
    expect(uploadStep?.with?.path).not.toContain("/cache/");
  });

  it("fails directly on legacy checkout artifacts while preserving the porcelain gate", () => {
    const workspaceCheck = workflow.jobs.core.steps.find(
      (step) => step.name === "Check for workspace artifacts",
    );
    const run = workspaceCheck?.run ?? "";

    expect(run).toContain("git diff --exit-code");
    expect(run).toMatch(
      /if \[ -e coverage \] \|\| \[ -e test-report\.junit\.xml \]; then/u,
    );
    expect(run).toContain('echo "Tests or build left legacy checkout artifacts:"');
    expect(run).toContain(
      'UNTRACKED=$(git status --porcelain | grep "^??" | grep -vE "^\\?\\? (node_modules|dist|coverage)/|^\\?\\? test-report\\.junit\\.xml$" || true)',
    );
    expect(run).toContain("git status --porcelain");
    expect(run).toContain("test-report.junit.xml");
  });

  it("runs the pinned Linux user-systemd integration with exact scoped cleanup", () => {
    const job = workflow.jobs["linux-systemd"];
    const checkout = job.steps.find((step) => step.name === "Checkout");
    const node = job.steps.find((step) => step.name === "Set up Node.js 25.9.0");
    const install = job.steps.find((step) => step.name === "Install dependencies");
    const build = job.steps.find((step) => step.name === "Build package");
    const integration = job.steps.find((step) => step.name === "Run real user-systemd integration");

    expect(checkout).toEqual({
      name: "Checkout",
      uses: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      with: { "persist-credentials": false },
    });
    expect(node).toEqual({
      name: "Set up Node.js 25.9.0",
      uses: "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
      with: { "node-version": "25.9.0", cache: "npm" },
    });
    expect(install?.run).toBe("npm ci");
    expect(build?.run).toBe("npm run build");
    expect(integration?.env).toEqual({
      LCM_SYSTEMD_CREDENTIAL_INTEGRATION: "1",
      LCM_LIFECYCLE_SYSTEMD_INTEGRATION: "1",
      LCM_LIFECYCLE_SCOPE_ID: "ci-${{ github.run_id }}-${{ github.run_attempt }}",
      LCM_LIFECYCLE_SYSTEMD_BARRIER_DIR:
        "${{ runner.temp }}/lcm-systemd-${{ github.run_id }}-${{ github.run_attempt }}",
      LCM_LIFECYCLE_DAEMON_PORT: "48322",
      LCM_LIFECYCLE_EXPECTED_SCOPES: "1",
      LCM_RUNTIME_PATHS_SYSTEMD_INTEGRATION: "1",
      LCM_RUNTIME_PATHS_SYSTEMD_RUN_ROOT:
        "${{ runner.temp }}/lcm-runtime-paths-${{ github.run_id }}-${{ github.run_attempt }}",
    });
    expect(integration?.run).toMatch(
      /systemd_state="\$\(systemctl --user is-system-running \|\| true\)"[\s\S]*case "\$systemd_state" in[\s\S]*running\|degraded\)\s*;;[\s\S]*\*\)[\s\S]*exit 1/u,
    );
    expect(integration?.run).toContain("test/daemon/lifecycle-isolation.test.ts");
    expect(integration?.run).toContain("test/daemon/lifecycle-systemd.integration.test.ts");
    expect(integration?.run).toContain("test/daemon/systemd-credential-loader.test.ts");
    expect(integration?.run).toContain("test/runtime-paths-systemd.integration.test.ts");
    expect(integration?.run).toContain(
      "npx vitest run test/runtime-paths-systemd.integration.test.ts",
    );
    expect(
      integration?.run.match(/npx vitest run test\/runtime-paths-systemd\.integration\.test\.ts\b/gu),
    ).toHaveLength(1);
    expect(
      integration?.run.match(/npx vitest run test\/runtime-paths-systemd\.integration\.test\.ts[^\n]*--testNamePattern/gu),
    ).toBeNull();
    expect(integration?.run).not.toContain("PrivateTmp=no");
    expect(integration?.run).not.toContain("--system");
    expect(integration?.run).not.toContain("PrivatePIDs=yes");
    expect(integration?.run).not.toContain("--scope");
    expect(integration?.run).not.toContain("/tmp:/tmp");
    expect(integration?.run).not.toContain("map.includes");
    expect(integration?.run).not.toContain("65534");
    expect(integration?.run).toContain(
      '--testNamePattern "observes the real user-systemd LoadCredential modes"',
    );
    for (const pattern of [
      "uses and removes one exact run-owned transient unit",
      "starts and admits a healthy managed unit with exact identity and cleanup",
      "restarts a wedged registered unit through systemd without legacy signal fallback",
      "recreates a terminal clean-exit unit after a registered-not-running observation",
      "refuses stale manager identity before mutation and never falls back to legacy signals",
      "refuses clean-environment drift before admitting an existing unit",
      "observes the real user-systemd LoadCredential modes",
    ]) {
      expect(integration?.run).toContain(pattern);
    }
    expect(integration?.run).toContain("|starts and admits a healthy managed unit");
    expect(integration?.run).toContain("systemctl --user stop \"$unit_name\"");
    expect(integration?.run).toContain(
      'if [[ "$unit_name" =~ ^lcm-daemon-[0-9a-f]{20}\\.service$ ]]; then',
    );
    expect(integration?.run).toContain('systemctl --user reset-failed "$unit_name"');
    expect(integration?.run).not.toContain("lcm-test-daemon-${scope_id}");
    const ownedUnit = /^lcm-daemon-[0-9a-f]{20}\.service$/u;
    for (const value of [
      "lcm-daemon-0123456789abcdef0123.service",
    ]) {
      expect(ownedUnit.test(value)).toBe(true);
    }
    for (const value of [
      "lcm-test-daemon-ci-123-1-12-34",
      "lcm-daemon-0123456789ABCDEF0123.service",
      "lcm-daemon-0123456789abcdef0123.service.extra",
      "lcm-daemon-0123456789abcdef0123.service; touch /tmp/pwned",
      "other.service",
    ]) {
      expect(ownedUnit.test(value)).toBe(false);
    }
    expect(integration?.run).toContain('rm -rf -- "$barrier_dir"');
    expect(integration?.run).not.toMatch(/\b(?:pkill|killall)\b/u);
  });

  it("keeps the macOS launchd feasibility job active, validates the private derived product label, and runs its integration path", () => {
    const job = workflow.jobs["macos-launchd"];
    const checkout = job.steps.find((step) => step.name === "Checkout");
    const node = job.steps.find((step) => step.name === "Set up Node.js 25.9.0");
    const install = job.steps.find((step) => step.name === "Install dependencies");
    const descriptorProbe = job.steps.find((step) => step.name === "Probe descriptor-relative runtime migration");
    const integration = job.steps.find((step) => step.name === "Run launchd integration path");

    expect(job.if).toBeUndefined();
    expect(job["continue-on-error"]).toBeUndefined();
    expect(checkout?.uses).toBe(
      "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
    );
    expect(node).toEqual({
      name: "Set up Node.js 25.9.0",
      uses: "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
      with: { "node-version": "25.9.0", cache: "npm" },
    });
    expect(install?.run).toBe("npm ci");
    expect(descriptorProbe?.run).toBe(
      'npx vitest run test/runtime-paths.test.ts --testNamePattern "uses actual platform semantics for nested legacy migration"',
    );
    expect(integration?.env).toEqual({
      LCM_LAUNCHD_INTEGRATION: "1",
      LCM_LAUNCHD_SCOPE_ID: "ci-${{ github.run_id }}-${{ github.run_attempt }}",
      LCM_LAUNCHD_RESOURCE_ROOT:
        "${{ runner.temp }}/lcm-launchd-${{ github.run_id }}-${{ github.run_attempt }}",
      LCM_LAUNCHD_LABEL:
        "com.donadiosolutions.lcm.ci.${{ github.run_id }}.${{ github.run_attempt }}",
    });
    const run = integration?.run ?? "";
    // The run creates one fresh unpredictable current-run evidence token,
    // passes it to the worker only through the environment, and the trap may
    // bootout only exact evidence proven to belong to this run. A stale or
    // planted marker without the fresh token must never be accepted.
    expect(run).toContain('evidence_token="$(uuidgen)"');
    expect(run).toContain('export LCM_LAUNCHD_EVIDENCE_TOKEN="$evidence_token"');
    expect(run).toContain('LCM_LAUNCHD_EVIDENCE_TOKEN');
    // The run root must be cleared before the worker starts so no leaked
    // pre-existing marker or stale captured output can satisfy the gate.
    const vitestIndex = run.indexOf("npx vitest run test/daemon/lifecycle-launchd.integration.test.ts");
    const trapIndex = run.indexOf("trap cleanup EXIT");
    expect(trapIndex).toBeGreaterThanOrEqual(0);
    expect(vitestIndex).toBeGreaterThan(0);
    const preRunResetIndex = run.indexOf('rm -rf -- "$resource_root"', trapIndex);
    expect(preRunResetIndex).toBeGreaterThan(trapIndex);
    expect(preRunResetIndex).toBeLessThan(vitestIndex);
    const chmodIndex = run.indexOf('chmod 0700 "$resource_root"');
    expect(chmodIndex).toBeGreaterThan(preRunResetIndex);
    expect(chmodIndex).toBeLessThan(vitestIndex);
    // The trap must read the pinned marker, require the current-run evidence
    // token, and boot out only the exact validated derived product label.
    expect(run).toContain('ready_file="$resource_root/launchd.label"');
    expect(run).toContain('out_file="$resource_root/launchd.out"');
    expect(run).toContain('evidence_token="$(uuidgen)"');
    expect(run).toContain('export LCM_LAUNCHD_EVIDENCE_TOKEN="$evidence_token"');
    expect(run).toContain('launchctl bootout "gui/$(id -u)/$ready_label"');
    expect(run).toContain('rm -rf -- "$resource_root"');
    expect(run).toContain('mkdir -p -- "$resource_root"');
    expect(run).toContain('chmod 0700 "$resource_root"');
    expect(run).toContain('tee "$out_file"');
    expect(run).toContain('normalized_out_file="$resource_root/launchd.normalized.out"');
    expect(run).toContain('LC_ALL=C sed $\'s/\\033\\\\[[0-9;]*m//g\' "$out_file" > "$normalized_out_file"');
    expect(run).toContain(
      'sentinel_count="$(LC_ALL=C grep -c \'^launchd-user$\' "$normalized_out_file" || true)"',
    );
    expect(run).toContain('[[ "$sentinel_count" != "1" ]]');
    // The trap gates every bootout on exact current-run evidence: the fresh
    // token, the exact validated derived product label, and the exact pinned
    // marker line. There is no broader label sweep and no native/PID fallback.
    expect(run).toContain('if [[ -f "$ready_file" ]]; then');
    expect(run).toContain('ready_token="${ready_line%% *}"');
    expect(run).toContain('ready_label="${ready_line#* }"');
    expect(run).toContain('[[ "$ready_token" == "$evidence_token"');
    expect(run).toContain('"$ready_line" == "$evidence_token $validated_ready_label"');
    expect(run).toContain('"$ready_label" == "$validated_ready_label"');
    expect(run).toContain('"$ready_label" =~ ^com\\.donadiosolutions\\.lcm\\.daemon\\.[0-9a-f]{20}$');
    expect(run).toContain('echo "Refusing cleanup for malformed launchd evidence marker" >&2');
    expect(run).toContain('if [[ -z "$ready_token" || -z "$ready_label" || "$ready_line" != "$ready_token $ready_label" ]]; then');
    expect(run).toContain('validated_ready_label=""');
    expect(run).not.toContain('[[ -f "$ready_file" && -n "$validated_ready_label" ]]');
    expect(run).toContain("Refusing cleanup for unexpected launchd label");
    expect(run).not.toContain('ready_label="$(<"$ready_file")"');
    expect(run).toContain("launchd integration marker must contain exactly one current-run token and one derived product label");
    expect(run).toContain("launchd integration did not derive a validated scoped product label");
    // The protected gate is run-scoped: it fails hard when no fresh marker
    // exists, when the marker carries another run's token, when the derived
    // product label collides with the static CI manifest label, or when every
    // macOS launchd integration test skipped.
    expect(run).toContain("launchd integration produced no fresh current-run marker (missing: $ready_file)");
    expect(run).toContain("launchd integration marker does not carry the current run evidence token");
    expect(run).toContain("launchd integration derived product label must not equal the CI manifest label");
    expect(run).toContain(
      "launchd integration derived product label must match the exact run-owned daemon identity",
    );
    expect(run).toContain(
      "launchd integration produced no current-run passed evidence (skipped=${skipped_count:-0} passed=${passed_count:-0})",
    );
    expect(run).toContain(
      "tests_summary_count=\"$(LC_ALL=C grep -Ec '^[[:space:]]*Tests([[:space:]]|$)' \"$normalized_out_file\" || true)\"",
    );
    expect(run).toContain(
      "launchd integration requires exactly one Tests summary (count=$tests_summary_count)",
    );
    expect(run).toContain("launchd integration produced an ambiguous Tests summary");
    expect(run).toContain("launchd integration produced ambiguous passed/skipped counts");
    expect(run).toContain(
      'if [[ "${skipped_count:-0}" != "0" || "${passed_count:-0}" == "0" || -z "${passed_count:-}" ]]; then',
    );
    expect(run).not.toContain("head -1");
    expect(run).not.toMatch(/grep[^\n]*"\$out_file"/u);
    // The derived product label must match the exact run-owned daemon shape,
    // which is what revives workflow cleanup ownership after the manifest
    // equality gate was removed: the old equality gate compared against the
    // static ci.<run_id>.<run_attempt> manifest and therefore could never
    // authorize bootout of the derived com.donadiosolutions.lcm.daemon.<hex>
    // product label.
    expect(run).toContain('[[ "$ready_label" == "$label" ]]');
    expect(run).toContain('[[ ! "$ready_label" =~ ^com\\.donadiosolutions\\.lcm\\.daemon\\.[0-9a-f]{20}$ ]]');
    expect(launchdIntegrationSource).toContain("LCM_LAUNCHD_RESOURCE_ROOT");
    expect(launchdIntegrationSource).toContain("LCM_LAUNCHD_EVIDENCE_TOKEN");
    expect(launchdIntegrationSource).toContain('const marker = join(resourceRoot, "launchd.label")');
    expect(launchdIntegrationSource).toContain(
      'writeFileSync(marker, `${evidenceToken} ${spec.launchdLabel}\\n`, { mode: 0o600 })',
    );
    expect(launchdIntegrationSource).toContain("if (spec.stateRoot !== getSharedStateRoot())");
    expect(launchdIntegrationSource).toContain(
      "if (!existsSync(workflowStateRoot) || !statSync(workflowStateRoot).isDirectory())",
    );
    expect(run.split("\n").some((line) => /^\s*(?:pkill|killall|kill)\b/u.test(line))).toBe(false);
    // The label regex must reject product labels outside the product prefix.
    const productLabelRegex = /^com\.donadiosolutions\.lcm\.[A-Za-z0-9.-]+$/u;
    expect(productLabelRegex.test("com.donadiosolutions.lcm.ci.123456789.1")).toBe(true);
    expect(productLabelRegex.test("com.donadiosolutions.lcm.daemon.0123456789abcdef0123")).toBe(true);
    expect(productLabelRegex.test("com.donadiosolutions.other.daemon.0123456789abcdef0123")).toBe(false);
    expect(productLabelRegex.test("com.donadiosolutions.lcm.")).toBe(false);
    // The strict run-owned daemon label shape requires 20 lowercase hex
    // characters so cleanup ownership cannot be claimed by an uppercase or
    // differently-sized label.
    const exactRunOwnedLabelRegex = /^com\.donadiosolutions\.lcm\.daemon\.[0-9a-f]{20}$/u;
    expect(exactRunOwnedLabelRegex.test("com.donadiosolutions.lcm.daemon.0123456789abcdef0123")).toBe(true);
    expect(exactRunOwnedLabelRegex.test("com.donadiosolutions.lcm.daemon.0123456789ABCDEF0123")).toBe(false);
    expect(exactRunOwnedLabelRegex.test("com.donadiosolutions.lcm.daemon.0123456789abcdef012")).toBe(false);
    expect(exactRunOwnedLabelRegex.test("com.donadiosolutions.lcm.ci.123456789.1")).toBe(false);

    // The integration may only reference product labels matching the private
    // marker contract and must never use raw pkill/killall on foreign jobs.
    expect(run.split("\n").some((line) => /^\s*(?:pkill|killall)\b/u.test(line))).toBe(false);
    expect(workflow.jobs.ci.needs).toContain("macos-launchd");
  });

  it("binds launchd activity to one shared run root without credential or token disclosure", () => {
    const run = workflow.jobs["macos-launchd"].steps.find(
      (step) => step.name === "Run launchd integration path",
    )?.run ?? "";

    // All sequential real tests must derive one exact label from the workflow
    // state root, while their runtime and home roots remain per-fixture.
    expect(launchdIntegrationSource).toContain("process.env.LCM_LAUNCHD_RESOURCE_ROOT");
    expect(launchdIntegrationSource).toContain("const stateRoot = getSharedStateRoot()");
    expect(launchdIntegrationSource).toContain("if (spec.stateRoot !== getSharedStateRoot())");
    expect(launchdIntegrationSource).toContain('const homeRoot = join(root, "home")');
    expect(launchdIntegrationSource).toContain('const runtimeRoot = join(root, "runtime")');
    expect(launchdIntegrationSource).toContain("createManagedCredentialDirectory(fixture.stateRoot");
    expect(launchdIntegrationSource).toContain("console.log(LAUNCHD_MANAGER_ACTIVITY_SENTINEL)");

    // The current-run token is generated before the worker and is never
    // printed. A marker without that token cannot authorize cleanup.
    const tokenIndex = run.indexOf('evidence_token="$(uuidgen)"');
    const workerIndex = run.indexOf("npx vitest run test/daemon/lifecycle-launchd.integration.test.ts");
    expect(tokenIndex).toBeGreaterThanOrEqual(0);
    expect(tokenIndex).toBeLessThan(workerIndex);
    expect(run).not.toContain('echo "$evidence_token"');
    expect(run).not.toContain('printf \'%s\\n\' "$evidence_token"');

    // A successful manager health response is the only source of the fixed
    // sentinel; missing, duplicate, or skipped evidence fails the job.
    expect(run).toContain(
      'sentinel_count="$(LC_ALL=C grep -c \'^launchd-user$\' "$normalized_out_file" || true)"',
    );
    expect(run).toContain("launchd integration produced no single manager-activity sentinel");
    expect(launchdIntegrationSource).toContain('const LAUNCHD_MANAGER_ACTIVITY_SENTINEL = "launchd-user"');
    expect(launchdIntegrationSource).toContain("if (!managerActivityReported)");

    // Credential assertions are based only on observed file metadata/bytes;
    // no test-only expectation variables or secret value enter the child.
    const expectedCredentialEnvironmentPrefix = ["LCM", "TEST", "EXPECTED", "CREDENTIAL"].join("_");
    const wedgeEnvironmentName = ["LCM", "TEST", "WEDGE", "FILE"].join("_");
    expect(launchdIntegrationSource).not.toContain(expectedCredentialEnvironmentPrefix);
    expect(launchdIntegrationSource).not.toContain(wedgeEnvironmentName);
    expect(launchdIntegrationSource).toContain("credentialLength: value.byteLength");
    expect(launchdIntegrationSource).toContain("credentialClaimed: stats.isFile() && value.byteLength > 0");
    expect(launchdIntegrationSource).toContain("expect(JSON.stringify(health).includes(\"fixture-value\")).toBe(false)");
  });

  it("executes deterministic ANSI and evidence-boundary fixtures", () => {
    const sgrGreen = "\u001b[32m";
    const sgrYellow = "\u001b[33m";
    const sgrReset = "\u001b[39m";
    const fixtures = [
      {
        name: "colored pass summary",
        output: `${sgrGreen}Tests${sgrReset}  ${sgrGreen}4 passed${sgrReset} (4)\nlaunchd-user\n`,
        success: true,
      },
      {
        name: "colored zero-skip summary",
        output: `${sgrYellow}Tests  4 passed | 0 skipped (4)${sgrReset}\nlaunchd-user\n`,
        success: true,
      },
      {
        name: "colored nonzero-skip summary",
        output: `${sgrYellow}Tests  4 passed | 1 skipped (5)${sgrReset}\nlaunchd-user\n`,
        success: false,
      },
      {
        name: "missing summary",
        output: "launchd-user\n",
        success: false,
      },
      {
        name: "duplicate summary",
        output: "Tests  4 passed (4)\nTests  4 passed (4)\nlaunchd-user\n",
        success: false,
      },
      {
        name: "ambiguous passed count",
        output: "Tests  4 passed | 1 passed (5)\nlaunchd-user\n",
        success: false,
      },
      {
        name: "residual controls and injection text",
        output:
          `${sgrGreen}Tests  4 passed (4)${sgrReset}\nlaunchd-user\n\u001b[2J\u0001$(touch __LCM_LAUNCHD_INJECTED_FILE__)\n`,
        success: false,
        noInjection: true,
      },
      {
        name: "zero sentinels",
        output: "Tests  4 passed (4)\n",
        success: false,
      },
      {
        name: "two sentinels",
        output: "Tests  4 passed (4)\nlaunchd-user\nlaunchd-user\n",
        success: false,
      },
    ];

    for (const fixture of fixtures) {
      const result = runLaunchdEvidenceFixture(fixture.output);
      expect(result.success, fixture.name).toBe(fixture.success);
      if (fixture.noInjection) {
        expect(result.injectedFileCreated, fixture.name).toBe(false);
      }
    }
  });

  it("keeps the SGR normalizer executable with BSD/GNU-compatible sed syntax", () => {
    expect(launchdEvidenceRun).toContain(
      'LC_ALL=C sed $\'s/\\033\\\\[[0-9;]*m//g\' "$out_file" > "$normalized_out_file"',
    );
    expect(launchdEvidenceRun).not.toContain("sed -E");
    expect(launchdEvidenceRun).not.toContain("sed -r");
    expect(() => execFileSync("bash", ["-n"], { input: launchdEvidenceRun })).not.toThrow();
    const normalized = execFileSync("bash", ["-c", "LC_ALL=C sed $'s/\\033\\\\[[0-9;]*m//g'"], {
      encoding: "utf8",
      input: "\u001b[32mTests\u001b[39m  \u001b[1;33m4 passed\u001b[0m (4)\n",
    });
    expect(normalized).toBe("Tests  4 passed (4)\n");
  });

  it("separates trusted OIDC uploads from tokenless fork uploads", () => {
    expect(workflow.jobs.codecov.if).toBe(
      "${{ !cancelled() && github.event_name != 'merge_group' && (github.event_name == 'push' || (github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository)) }}",
    );
    expect(workflow.jobs.codecov.permissions).toEqual({
      actions: "read",
      contents: "read",
      "id-token": "write",
    });
    expect(workflow.jobs["codecov-fork"].if).toBe(
      "${{ !cancelled() && github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name != github.repository }}",
    );
    expect(workflow.jobs["codecov-fork"].permissions).toEqual({
      actions: "read",
      contents: "read",
    });
  });

  it("checks out the artifact-producing tree and permits only fixed infrastructure scripts", () => {
    for (const job of [workflow.jobs.codecov, workflow.jobs["codecov-fork"]]) {
      const { steps } = job;
      expect(steps.map((step) => step.name)).toEqual([
        "Checkout source for Codecov",
        "Download Vitest reports",
        "Download verified Codecov CLI",
        "Upload coverage to Codecov",
        "Upload test results to Codecov",
      ]);

      const checkoutIndex = steps.findIndex((step) => step.name === "Checkout source for Codecov");
      const firstUploadIndex = steps.findIndex((step) =>
        step.uses?.startsWith("codecov/codecov-action@"),
      );
      expect(checkoutIndex).toBeGreaterThanOrEqual(0);
      expect(firstUploadIndex).toBeGreaterThan(checkoutIndex);
      expect(steps[checkoutIndex]).toEqual({
        name: "Checkout source for Codecov",
        uses: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
        with: {
          repository: "${{ github.repository }}",
          ref: "${{ github.sha }}",
          "persist-credentials": false,
        },
      });
      expect(
        steps
          .filter((step) => step.run !== undefined)
          .map((step) => ({ name: step.name, run: step.run?.trim() })),
      ).toEqual(expectedCodecovRunSteps);
    }
  });

  it("reuses a digest-verified pinned Codecov CLI for both uploads in each job", () => {
    for (const [jobName, useOidc] of [
      ["codecov", true],
      ["codecov-fork", false],
    ] as const) {
      const steps = workflow.jobs[jobName].steps;
      const overridePr =
        jobName === "codecov"
          ? "${{ github.event_name == 'pull_request' && github.event.pull_request.number || '' }}"
          : "${{ github.event.pull_request.number }}";
      const download = steps.find((step) => step.name === "Download verified Codecov CLI");

      expect(download?.env).toMatchObject({
        CODECOV_CLI_REPOSITORY: "codecov/codecov-cli",
        CODECOV_CLI_TAG: "v11.2.6",
        CODECOV_CLI_ASSET: "codecovcli_linux",
        CODECOV_CLI_SHA256: "fd34214e2b2c738e48e3ac90b2c23ec4e975d0e9aee51f2cebe81b5704af3f6c",
      });
      expect(
        `https://github.com/${download?.env?.CODECOV_CLI_REPOSITORY}/releases/download/${download?.env?.CODECOV_CLI_TAG}/${download?.env?.CODECOV_CLI_ASSET}`,
      ).toBe("https://github.com/codecov/codecov-cli/releases/download/v11.2.6/codecovcli_linux");

      const downloadScript = download?.run ?? "";
      const downloadIndex = downloadScript.indexOf("gh release download");
      const verifyIndex = downloadScript.indexOf("sha256sum --check --strict");
      const chmodIndex = downloadScript.indexOf('chmod 0755 "$CODECOV_CLI_PATH"');
      expect(downloadIndex).toBeGreaterThanOrEqual(0);
      expect(verifyIndex).toBeGreaterThan(downloadIndex);
      expect(chmodIndex).toBeGreaterThan(verifyIndex);
      expect(downloadScript).toContain('CODECOV_CLI_PATH="$RUNNER_TEMP/codecov"');

      const uploads = steps.filter((step) => step.uses?.startsWith("codecov/codecov-action@"));
      expect(uploads).toHaveLength(2);
      for (const upload of uploads) {
        expect(upload.uses).toBe(
          "codecov/codecov-action@fb8b3582c8e4def4969c97caa2f19720cb33a72f",
        );
        expect(upload.with).toMatchObject({
          binary: "${{ runner.temp }}/codecov",
          fail_ci_if_error: true,
          override_pr: overridePr,
          use_oidc: useOidc,
        });
        expect(upload.with).not.toHaveProperty("token");
        expect(upload.with).not.toHaveProperty("version");
      }
      expect(uploads.map((upload) => upload.with?.files)).toEqual([
        "coverage/lcov.info",
        "test-report.junit.xml",
      ]);
      expect(uploads[0]?.with).not.toHaveProperty("report_type");
      expect(uploads[1]?.with).toMatchObject({ report_type: "test_results" });
      expect(steps.some((step) => step.name === "Clean Codecov uploader files")).toBe(false);
    }
    expect(source.match(/gh release download/gu)).toHaveLength(2);
  });
});
