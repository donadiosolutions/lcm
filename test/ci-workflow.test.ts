import { readFileSync } from "node:fs";
import { load as loadYaml } from "js-yaml";
import { describe, expect, it } from "vitest";

interface WorkflowStep {
  name?: string;
  run?: string;
  uses?: string;
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

const source = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const launchdIntegrationSource = readFileSync(
  new URL("./daemon/lifecycle-launchd.integration.test.ts", import.meta.url),
  "utf8",
);
const workflow = loadYaml(source) as CiWorkflow;
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
      uses: "actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e",
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
    });
    expect(integration?.run).toMatch(
      /systemd_state="\$\(systemctl --user is-system-running \|\| true\)"[\s\S]*case "\$systemd_state" in[\s\S]*running\|degraded\)\s*;;[\s\S]*\*\)[\s\S]*exit 1/u,
    );
    expect(integration?.run).toContain("test/daemon/lifecycle-isolation.test.ts");
    expect(integration?.run).toContain("test/daemon/lifecycle-systemd.integration.test.ts");
    expect(integration?.run).toContain("test/daemon/systemd-credential-loader.test.ts");
    for (const pattern of [
      "uses and removes one exact run-owned transient unit",
      "starts and admits a healthy managed unit with exact identity and cleanup",
      "restarts a wedged registered unit through systemd without legacy signal fallback",
      "recreates a terminal clean-exit unit after a registered-not-running observation",
      "refuses stale manager identity before mutation and never falls back to legacy signals",
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

  it("keeps the macOS launchd feasibility job active and runs its integration path", () => {
    const job = workflow.jobs["macos-launchd"];
    const checkout = job.steps.find((step) => step.name === "Checkout");
    const node = job.steps.find((step) => step.name === "Set up Node.js 25.9.0");
    const install = job.steps.find((step) => step.name === "Install dependencies");
    const integration = job.steps.find((step) => step.name === "Run launchd integration path");

    expect(job.if).toBeUndefined();
    expect(job["continue-on-error"]).toBeUndefined();
    expect(checkout?.uses).toBe(
      "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
    );
    expect(node).toEqual({
      name: "Set up Node.js 25.9.0",
      uses: "actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e",
      with: { "node-version": "25.9.0", cache: "npm" },
    });
    expect(install?.run).toBe("npm ci");
    expect(integration?.env).toEqual({
      LCM_LAUNCHD_INTEGRATION: "1",
      LCM_LAUNCHD_SCOPE_ID: "ci-${{ github.run_id }}-${{ github.run_attempt }}",
      LCM_LAUNCHD_RESOURCE_ROOT:
        "${{ runner.temp }}/lcm-launchd-${{ github.run_id }}-${{ github.run_attempt }}",
    });
    const run = integration?.run ?? "";
    expect(run).toContain('evidence_token="$(uuidgen)"');
    expect(run).toContain('export LCM_LAUNCHD_EVIDENCE_TOKEN="$evidence_token"');
    expect(run).toContain('launchctl bootout "gui/$(id -u)/$ready_label"');
    expect(run).toContain('[[ "$ready_token" == "$evidence_token" ]]');
    expect(run).toContain(
      '[[ "$ready_label" =~ ^com\\.donadiosolutions\\.lcm\\.daemon\\.[0-9a-f]{20}$ ]]',
    );
    expect(run).toContain('rm -rf -- "$resource_root"');
    expect(run).toContain('chmod 0700 "$resource_root"');
    expect(run).toContain("validate_marker() {");
    expect(run).toContain("Refusing cleanup for malformed or foreign launchd evidence");
    expect(run).not.toMatch(/\b(?:pkill|killall|kill)\b/u);
    const trap = run.indexOf("trap cleanup EXIT");
    const reset = run.indexOf('rm -rf -- "$resource_root"', trap);
    const testRun = run.indexOf("npx vitest run test/daemon/lifecycle-launchd.integration.test.ts");
    expect(trap).toBeGreaterThanOrEqual(0);
    expect(reset).toBeGreaterThan(trap);
    expect(reset).toBeLessThan(testRun);
    expect(run.indexOf('chmod 0700 "$resource_root"')).toBeLessThan(testRun);
    expect(run.indexOf("if validate_marker; then")).toBeGreaterThanOrEqual(0);
    expect(run.indexOf('launchctl bootout "gui/$(id -u)/$ready_label"')).toBeGreaterThan(
      run.indexOf("if validate_marker; then"),
    );
    expect(launchdIntegrationSource).toContain("LCM_LAUNCHD_RESOURCE_ROOT");
    expect(launchdIntegrationSource).toContain("LCM_LAUNCHD_EVIDENCE_TOKEN");
    expect(launchdIntegrationSource).toContain(
      'writeFileSync(join(resourceRoot, "launchd.label"), `${evidenceToken} ${spec.launchdLabel}\\n`',
    );
    const start = launchdIntegrationSource.indexOf("const started = await supervisor.start(spec);");
    const publish = launchdIntegrationSource.indexOf("publishLaunchdEvidence(spec);", start);
    const health = launchdIntegrationSource.indexOf("waitForExactHealth(spec, managerPid)", publish);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(publish).toBeGreaterThan(start);
    expect(health).toBeGreaterThan(publish);
    expect(launchdIntegrationSource).toContain("spec.stateRoot !== realpathSync(resourceRoot)");
    expect(launchdIntegrationSource).toContain("expect(statSync(stateRoot).mode & 0o777).toBe(0o700)");
    expect(workflow.jobs.ci.needs).toContain("macos-launchd");
  });

  it("separates trusted OIDC uploads from tokenless fork uploads", () => {
    expect(workflow.jobs.codecov.if).toBe(
      "${{ github.event_name != 'merge_group' && (github.event_name == 'push' || (github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository)) }}",
    );
    expect(workflow.jobs.codecov.permissions).toEqual({
      actions: "read",
      contents: "read",
      "id-token": "write",
    });
    expect(workflow.jobs["codecov-fork"].if).toBe(
      "${{ github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name != github.repository }}",
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
