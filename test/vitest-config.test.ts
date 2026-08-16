import { describe, expect, it } from "vitest";
import config from "../vitest.config";

describe("Vitest project configuration", () => {
  it("runs package inventory tests in a serial project", () => {
    const projects = config.test?.projects ?? [];
    const parallelProject = projects.find(
      (project) => project.test?.name === "unit-parallel",
    );
    const packageProject = projects.find(
      (project) => project.test?.include?.includes("test/package-config.test.ts"),
    );

    expect(parallelProject?.test?.exclude).toContain("test/package-config.test.ts");
    expect(packageProject?.test?.fileParallelism).toBe(false);
  });
});
