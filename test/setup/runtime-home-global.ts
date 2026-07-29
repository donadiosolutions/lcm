import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestProject } from "vitest/node";

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
  readonly temporaryRoot?: () => string;
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
  const temporaryRoot = dependencies.temporaryRoot ?? tmpdir;
  const parent = environment.LCM_TEST_VITEST_RUNTIME_ROOT_PARENT ?? temporaryRoot();
  const root = createDirectory(join(parent, "lcm-vitest-run-"));
  secureDirectory(root, 0o700);
  project.provide(RUNTIME_HOME_ROOT_CONTEXT, root);
  return () => removeDirectory(root);
}

export default function setup(project: TestProject): () => void {
  return createRuntimeHomeRun(project);
}
