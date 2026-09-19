import { describe, expect, it } from "vitest";
import { createVitestConfiguration } from "../vitest.config";
import { createPostgresqlVitestConfiguration } from "../vitest.postgresql.config";

describe("local Vitest worker budget", () => {
  it.each([undefined, "", "false", "0", "TRUE", " true "])(
    "bounds local runs when CI is %s",
    (CI) => {
      const environment = CI === undefined ? {} : { CI };
      const configuration = createVitestConfiguration("/tmp/worker-budget-config-only", environment);

      expect(configuration.test?.maxWorkers).toBe(1);
      // Inline projects do not automatically inherit the root configuration.
      expect(configuration.test?.projects).toEqual(expect.arrayContaining([
        expect.objectContaining({
          test: expect.objectContaining({ name: "unit-parallel", maxWorkers: 1 }),
        }),
      ]));
    },
  );

  it.each(["true", "1"])("preserves CI sizing when CI is %s", (CI) => {
    const configuration = createVitestConfiguration("/tmp/worker-budget-config-only", { CI });

    expect(configuration.test?.maxWorkers).toBeUndefined();
    expect(configuration.test?.projects).toEqual(expect.arrayContaining([
      expect.objectContaining({
        test: expect.objectContaining({ name: "unit-parallel", maxWorkers: undefined }),
      }),
    ]));
  });

  it.each([{}, { CI: "true" }])("preserves serial groups and coverage for %j", (environment) => {
    const configuration = createVitestConfiguration("/tmp/worker-budget-config-only", environment);

    for (const name of ["unit-portable-boundaries", "unit-package", "unit-sqlite-routes", "e2e"]) {
      expect(configuration.test?.projects).toEqual(expect.arrayContaining([
        expect.objectContaining({
          test: expect.objectContaining({ name, fileParallelism: false }),
        }),
      ]));
    }
    expect(configuration.test?.coverage?.thresholds).toEqual({
      statements: 100,
      lines: 100,
      branches: 100,
      functions: 100,
      perFile: true,
    });
  });

  it.each([undefined, "", "false", "0", "TRUE", " true "])(
    "bounds PostgreSQL integration runs when CI is %s",
    (CI) => {
      const environment = CI === undefined ? {} : { CI };
      const configuration = createPostgresqlVitestConfiguration(environment);

      expect(configuration.test.maxWorkers).toBe(1);
    },
  );

  it.each(["true", "1"])("preserves PostgreSQL CI sizing when CI is %s", (CI) => {
    const configuration = createPostgresqlVitestConfiguration({ CI }, () => 8);

    expect(configuration.test.maxWorkers).toBe(8);
  });

  it.each(["true", "1"])("keeps PostgreSQL CI sizing at one when CPU discovery is zero and CI is %s", (CI) => {
    const configuration = createPostgresqlVitestConfiguration({ CI }, () => 0);

    expect(configuration.test.maxWorkers).toBe(1);
  });
});
