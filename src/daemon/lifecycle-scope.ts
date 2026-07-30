import type { spawn, spawnSync } from "node:child_process";
import { isAbsolute, relative, resolve } from "node:path";

const TEST_UNIT_PREFIX = "lcm-test-daemon-";
const OWNER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/u;
const VITEST_WORKER_PATTERN = /(?:^|[/\\])node_modules[/\\]vitest[/\\]dist[/\\]workers[/\\][^/\\]+\.js$/u;
const REQUIRED_DEPENDENCIES = [
  "fetch",
  "spawn",
  "spawnSync",
  "stopUnit",
  "killProcess",
  "isProcessAlive",
  "sleep",
] as const satisfies readonly (keyof DaemonLifecycleTestDependencies)[];

export type DaemonLifecycleTestDependencies = Readonly<{
  fetch: typeof globalThis.fetch;
  spawn: typeof spawn;
  spawnSync: typeof spawnSync;
  stopUnit: (unitName: string) => void | Promise<void>;
  killProcess: (pid: number, signal?: NodeJS.Signals | number) => void;
  isProcessAlive: (pid: number) => boolean;
  sleep: (ms: number) => Promise<void>;
}>;

export type DaemonLifecycleTestIdentity = Readonly<{
  ownerId: string;
  entrypoint: string;
}>;

export type DaemonLifecycleTestScope = Readonly<{
  ownerId: string;
  homeDir: string;
  runtimeDir: string;
  stateDir: string;
  credentialDir: string;
  entrypoint: string;
  unitPrefix: string;
  dependencies: DaemonLifecycleTestDependencies;
}>;

type ScopeInput = Omit<DaemonLifecycleTestScope, "unitPrefix">;

function requireAbsoluteDirectory(label: string, path: string): string {
  if (!isAbsolute(path)) throw new Error(`${label} must be absolute`);
  return resolve(path);
}

function isWithin(candidate: string, parent: string): boolean {
  const child = resolve(candidate);
  const root = resolve(parent);
  const rel = relative(root, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function isSafeOwnerId(ownerId: unknown): ownerId is string {
  return typeof ownerId === "string" && OWNER_ID_PATTERN.test(ownerId);
}

export function isVitestWorkerEntrypoint(entrypoint: string | undefined): boolean {
  return typeof entrypoint === "string" && VITEST_WORKER_PATTERN.test(entrypoint);
}

export function createDaemonLifecycleTestScope(input: ScopeInput): DaemonLifecycleTestScope {
  if (!isSafeOwnerId(input.ownerId)) {
    throw new Error("lifecycle test ownerId must be 1-80 safe identifier characters");
  }
  const homeDir = requireAbsoluteDirectory("lifecycle test homeDir", input.homeDir);
  const runtimeDir = requireAbsoluteDirectory("lifecycle test runtimeDir", input.runtimeDir);
  const stateDir = requireAbsoluteDirectory("lifecycle test stateDir", input.stateDir);
  const credentialDir = requireAbsoluteDirectory("lifecycle test credentialDir", input.credentialDir);
  const entrypoint = requireAbsoluteDirectory("lifecycle test entrypoint", input.entrypoint);
  for (const [label, path] of [
    ["runtimeDir", runtimeDir],
    ["stateDir", stateDir],
    ["credentialDir", credentialDir],
    ["entrypoint", entrypoint],
  ] as const) {
    if (!isWithin(path, homeDir)) throw new Error(`lifecycle test ${label} must be inside homeDir`);
  }
  if (isVitestWorkerEntrypoint(entrypoint)) {
    throw new Error("lifecycle test entrypoint must not be a Vitest worker");
  }
  if (typeof input.dependencies !== "object" || input.dependencies === null) {
    throw new Error("lifecycle test dependencies must be a complete object");
  }
  for (const label of REQUIRED_DEPENDENCIES) {
    const dependency = input.dependencies[label];
    if (typeof dependency !== "function") {
      throw new Error(`lifecycle test dependency ${label} must be a function`);
    }
  }
  return Object.freeze({
    ownerId: input.ownerId,
    homeDir,
    runtimeDir,
    stateDir,
    credentialDir,
    entrypoint,
    unitPrefix: `${TEST_UNIT_PREFIX}${input.ownerId}-`,
    dependencies: Object.freeze({ ...input.dependencies }),
  });
}

export function isDaemonLifecycleTestIdentity(value: unknown): value is DaemonLifecycleTestIdentity {
  if (typeof value !== "object" || value === null) return false;
  const identity = value as DaemonLifecycleTestIdentity;
  return isSafeOwnerId(identity.ownerId)
    && typeof identity.entrypoint === "string"
    && isAbsolute(identity.entrypoint)
    && !isVitestWorkerEntrypoint(identity.entrypoint);
}

export function isDaemonLifecycleTestScope(value: unknown): value is DaemonLifecycleTestScope {
  if (typeof value !== "object" || value === null) return false;
  try {
    const scope = value as DaemonLifecycleTestScope;
    const recreated = createDaemonLifecycleTestScope({
      ownerId: scope.ownerId,
      homeDir: scope.homeDir,
      runtimeDir: scope.runtimeDir,
      stateDir: scope.stateDir,
      credentialDir: scope.credentialDir,
      entrypoint: scope.entrypoint,
      dependencies: scope.dependencies,
    });
    return recreated.unitPrefix === scope.unitPrefix;
  } catch {
    return false;
  }
}

export function lifecycleScopeOwnsPath(scope: DaemonLifecycleTestScope, path: string): boolean {
  return isWithin(path, scope.stateDir)
    || isWithin(path, scope.runtimeDir)
    || isWithin(path, scope.credentialDir);
}

export function lifecycleScopeUnitName(
  scope: DaemonLifecycleTestScope,
  pid: number,
  nonce: number,
): string {
  return `${scope.unitPrefix}${pid}-${nonce}`;
}
