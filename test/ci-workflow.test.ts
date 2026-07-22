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

interface CiWorkflow {
  jobs: {
    codecov: {
      steps: WorkflowStep[];
    };
  };
}

const source = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const workflow = loadYaml(source) as CiWorkflow;

describe("CI workflow", () => {
  it("reuses one digest-verified pinned Codecov CLI for both uploads", () => {
    const steps = workflow.jobs.codecov.steps;
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
    expect(source.match(/gh release download/gu)).toHaveLength(1);

    const uploads = steps.filter((step) => step.uses?.startsWith("codecov/codecov-action@"));
    expect(uploads).toHaveLength(2);
    for (const upload of uploads) {
      expect(upload.uses).toBe(
        "codecov/codecov-action@fb8b3582c8e4def4969c97caa2f19720cb33a72f",
      );
      expect(upload.with).toMatchObject({
        binary: "${{ runner.temp }}/codecov",
        fail_ci_if_error: true,
        override_pr:
          "${{ github.event_name == 'pull_request' && github.event.pull_request.number || '' }}",
        use_oidc:
          "${{ github.event_name == 'push' || (github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository) }}",
      });
      expect(upload.with).not.toHaveProperty("version");
    }
    expect(steps.some((step) => step.name === "Clean Codecov uploader files")).toBe(false);
  });
});
