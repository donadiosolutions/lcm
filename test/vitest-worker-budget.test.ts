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

  describe("PostgreSQL census-cost measurement", () => {
    const censusCostTest = "test/postgresql/migration-verification-census-cost.integration.ts";

    it.each([{}, { LCM_TEST_POSTGRES_CENSUS_COST: "false" }, { LCM_TEST_POSTGRES_CENSUS_COST: "1" }])(
      "excludes the measurement from the default integration run for %j",
      (environment) => {
        const configuration = createPostgresqlVitestConfiguration(environment);

        expect(configuration.test.include).toEqual(["test/postgresql/**/*.integration.ts"]);
        expect(configuration.test.exclude).toContain(censusCostTest);
      },
    );

    it("includes only the measurement when the opt-in flag is set", () => {
      const configuration = createPostgresqlVitestConfiguration({ LCM_TEST_POSTGRES_CENSUS_COST: "true" });

      expect(configuration.test.include).toEqual([censusCostTest]);
      expect(configuration.test.exclude).toEqual([]);
    });

    it("keeps the fork probe selection when both flags are set", () => {
      const configuration = createPostgresqlVitestConfiguration({
        LCM_TEST_POSTGRES_CENSUS_COST: "true",
        LCM_TEST_POSTGRES_FORK_PROBE: "true",
      });

      expect(configuration.test.include).toEqual(["test/postgresql/fixtures/persistent-worker.integration.ts"]);
      expect(configuration.test.exclude).toEqual([]);
    });
  });

  describe("PostgreSQL cutover rehearsal profile", () => {
    const rehearsalTest = "test/postgresql/cutover-rehearsal.integration.ts";

    it.each([{}, { LCM_TEST_POSTGRES_CUTOVER_REHEARSAL: "false" }, { LCM_TEST_POSTGRES_CUTOVER_REHEARSAL: "1" }])(
      "keeps the rehearsal file in the ordinary integration run for %j",
      (environment) => {
        const configuration = createPostgresqlVitestConfiguration(environment);

        expect(configuration.test.include).toEqual(["test/postgresql/**/*.integration.ts"]);
        expect(configuration.test.exclude).not.toContain(rehearsalTest);
      },
    );

    it("includes only the rehearsal file when the opt-in flag is set", () => {
      const configuration = createPostgresqlVitestConfiguration({ LCM_TEST_POSTGRES_CUTOVER_REHEARSAL: "true" });

      expect(configuration.test.include).toEqual([rehearsalTest]);
      expect(configuration.test.exclude).toEqual([]);
    });

    it("refuses the census-cost and rehearsal flags together", () => {
      expect(() => createPostgresqlVitestConfiguration({
        LCM_TEST_POSTGRES_CENSUS_COST: "true",
        LCM_TEST_POSTGRES_CUTOVER_REHEARSAL: "true",
      })).toThrow("mutually exclusive");
    });

    it("keeps the fork probe selection when the rehearsal flag is also set", () => {
      const configuration = createPostgresqlVitestConfiguration({
        LCM_TEST_POSTGRES_CUTOVER_REHEARSAL: "true",
        LCM_TEST_POSTGRES_FORK_PROBE: "true",
      });

      expect(configuration.test.include).toEqual(["test/postgresql/fixtures/persistent-worker.integration.ts"]);
    });
  });

  it.each(["true", "1"])("keeps PostgreSQL CI sizing at one when CPU discovery is zero and CI is %s", (CI) => {
    const configuration = createPostgresqlVitestConfiguration({ CI }, () => 0);

    expect(configuration.test.maxWorkers).toBe(1);
  });

  it("keeps the passing-test lines out of the capture-capped harness output", () => {
    const configuration = createPostgresqlVitestConfiguration({});

    expect(configuration.test.slowTestThreshold).toBeGreaterThan(configuration.test.testTimeout);
  });
});
