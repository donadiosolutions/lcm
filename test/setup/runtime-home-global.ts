import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import type { TestProject } from "vitest/node";
import {
  captureOriginalTemporaryParents,
  createTestTempDirectory,
} from "../../scripts/test-temp-root.mjs";

export const RUNTIME_HOME_ROOT_CONTEXT = "lcmRuntimeHomeRoot";

declare module "vitest" {
  export interface ProvidedContext {
    lcmRuntimeHomeRoot: string;
  }
}

export interface RuntimeHomeRunDependencies {
  readonly createDirectory?: (prefix: string) => string;
  readonly secureDirectory?: (path: string, mode: number) => void;
  readonly removeDirectory?: (path: string) => void;
  readonly environment?: NodeJS.ProcessEnv;
  readonly platformName?: NodeJS.Platform;
  readonly temporaryRoot?: () => string;
  readonly realpath?: (path: string) => string;
  readonly markerProbe?: (path: string) => void;
  readonly candidateParents?: string[];
}

export function createRuntimeHomeRun(
  project: Pick<TestProject, "provide">,
  dependencies: RuntimeHomeRunDependencies = {},
): () => void {
  const createDirectory = dependencies.createDirectory ?? mkdtempSync;
  const secureDirectory = dependencies.secureDirectory ?? chmodSync;
  const removeDirectory = dependencies.removeDirectory
    ?? ((path) => rmSync(path, { recursive: true, force: true }));
  const environment = dependencies.environment ?? process.env;
  const platformName = dependencies.platformName ?? process.platform;
  let capturedParents: string[] | undefined;
  if (environment.LCM_TEST_HARNESS_TMPDIR === undefined) {
    capturedParents = captureOriginalTemporaryParents(
      environment,
      platformName,
      dependencies.temporaryRoot,
    );
  }
  const allocation = createTestTempDirectory({
    environment,
    platformName,
    prefix: "lcm-vitest-run-",
    createDirectory,
    secureDirectory,
    removeDirectory,
    realpath: dependencies.realpath,
    markerProbe: dependencies.markerProbe,
    candidateParents: dependencies.candidateParents
      ?? (environment.LCM_TEST_VITEST_RUNTIME_ROOT_PARENT === undefined
        ? capturedParents
        : undefined),
    temporaryRoot: dependencies.temporaryRoot,
  });
  try {
    project.provide(RUNTIME_HOME_ROOT_CONTEXT, allocation.root);
    if (environment.LCM_TEST_HARNESS_TMPDIR === undefined) {
      environment.LCM_TEST_HARNESS_TMPDIR = allocation.parent;
    }
  } catch (error) {
    removeDirectory(allocation.root);
    throw error;
  }
  return () => removeDirectory(allocation.root);
}

export default function setup(project: TestProject): () => void {
  return createRuntimeHomeRun(project);
}
