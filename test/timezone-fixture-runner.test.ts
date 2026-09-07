import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("timezone fixtures", () => {
  for (const zone of ["America/New_York", "America/Sao_Paulo", "Asia/Tokyo", "UTC"]) {
    it(`passes under ${zone}`, () => {
      const output = execFileSync(
        process.execPath,
        [join(process.cwd(), "node_modules/vitest/vitest.mjs"), "run", "test/timezone-fixture.test.ts", "--reporter=dot", "--maxWorkers=1"],
        {
          env: { ...process.env, TZ: zone, LCM_TIMEZONE_FIXTURE: "1" },
          encoding: "utf8",
          timeout: 30_000,
        },
      );
      expect(output).toContain("Test Files");
      expect(output).toContain("passed");
    });
  }
});
