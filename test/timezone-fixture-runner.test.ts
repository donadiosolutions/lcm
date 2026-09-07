import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

function createChildAcceptanceEnvironment(
  parentEnvironment: NodeJS.ProcessEnv,
  fixture: string,
): NodeJS.ProcessEnv {
  const childEnvironment = { ...parentEnvironment };
  delete childEnvironment.LCM_TEST_VITEST_RUNTIME_ROOT_PARENT;
  delete childEnvironment.LCM_TEST_HARNESS_TMPDIR;
  delete childEnvironment.LCM_TEST_HARNESS_ORIGINAL_TEMP_PARENTS;
  delete childEnvironment.LCM_TEST_ARTIFACT_ROOT;
  childEnvironment.TMPDIR = fixture;
  childEnvironment.TMP = fixture;
  childEnvironment.TEMP = fixture;
  return childEnvironment;
}

describe("timezone fixtures", () => {
  for (const zone of ["America/New_York", "America/Sao_Paulo", "Asia/Tokyo", "UTC"]) {
    it(`passes under ${zone}`, { timeout: 60_000 }, () => {
      const fixture = mkdtempSync(join(tmpdir(), "lcm-timezone-child-"));
      try {
        const output = execFileSync(
          process.execPath,
          [join(process.cwd(), "node_modules/vitest/vitest.mjs"), "run", "test/timezone-fixture.test.ts", "--reporter=dot", "--maxWorkers=1"],
          {
            env: { ...createChildAcceptanceEnvironment(process.env, fixture), TZ: zone },
            encoding: "utf8",
            timeout: 30_000,
          },
        );
        expect(output).toContain("Test Files");
        expect(output).toContain("passed");
      } finally {
        rmSync(fixture, { recursive: true, force: true });
      }
    });
  }
});
