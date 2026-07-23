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

interface CodecovJob {
  needs: string;
  if: string;
  permissions: Record<string, string>;
  steps: WorkflowStep[];
}

interface CiWorkflow {
  jobs: {
    core: {
      name: string;
    };
    postgresql: {
      strategy: { matrix: { run: number[] } };
    };
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
const workflow = loadYaml(source) as CiWorkflow;

describe("CI workflow", () => {
  it("gates the stable required check on core CI and the complete PostgreSQL matrix", () => {
    expect(workflow.jobs.core.name).toBe("Core CI");
    expect(workflow.jobs.postgresql.strategy.matrix.run).toEqual([1, 2]);
    expect(workflow.jobs.ci).toMatchObject({
      name: "ci",
      needs: ["core", "postgresql"],
      if: "${{ always() }}",
    });
    const gate = workflow.jobs.ci.steps.find((step) => step.name === "Require every CI suite");
    expect(gate?.env).toEqual({
      CORE_RESULT: "${{ needs.core.result }}",
      POSTGRESQL_RESULT: "${{ needs.postgresql.result }}",
    });
    expect(gate?.run).toContain('[[ "$CORE_RESULT" != success || "$POSTGRESQL_RESULT" != success ]]');
    expect(workflow.jobs.codecov.needs).toBe("ci");
    expect(workflow.jobs["codecov-fork"].needs).toBe("ci");
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

  it("checks out the exact report source without executing repository code", () => {
    for (const job of [workflow.jobs.codecov, workflow.jobs["codecov-fork"]]) {
      const { steps } = job;

      const checkoutIndex = steps.findIndex((step) => step.name === "Checkout source for Codecov");
      const firstUploadIndex = steps.findIndex((step) =>
        step.uses?.startsWith("codecov/codecov-action@"),
      );
      expect(checkoutIndex).toBeGreaterThanOrEqual(0);
      expect(firstUploadIndex).toBeGreaterThan(checkoutIndex);
      expect(steps[checkoutIndex]).toEqual({
        name: "Checkout source for Codecov",
        uses: "actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0",
        with: {
          repository:
            "${{ github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name || github.repository }}",
          ref: "${{ github.event_name == 'pull_request' && github.event.pull_request.head.sha || github.sha }}",
          "persist-credentials": false,
        },
      });
      expect(
        steps.some((step) => /(?:^|\s)(?:node|npm|npx|pnpm|yarn)(?:\s|$)/u.test(step.run ?? "")),
      ).toBe(false);
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
