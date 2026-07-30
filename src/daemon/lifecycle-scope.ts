import type { spawn, spawnSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { LCM_HOME_DIRNAME } from "../runtime-paths.js";

const TEST_UNIT_PREFIX = "lcm-test-daemon-";
export const DAEMON_TEST_OWNER_OPTION = "--internal-lcm-test-daemon-owner";
export const DAEMON_TEST_ENTRYPOINT_OPTION = "--internal-lcm-test-daemon-entrypoint";
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

export type DaemonLifecycleHermeticTestSeams = Readonly<{
  homeDir: string;
  runtimeDir: string;
  stateDir: string;
  credentialDir: string;
  procRoot: string;
  platform: NodeJS.Platform;
  uid: number;
  environment: NodeJS.ProcessEnv;
  fetch: typeof globalThis.fetch;
  spawn: typeof spawn;
  spawnSync: typeof spawnSync;
  stopUnit: (unitName: string) => void | Promise<void>;
  killProcess: (pid: number, signal?: NodeJS.Signals | number) => void;
  isProcessAlive: (pid: number) => boolean;
  sleep: (ms: number) => Promise<void>;
  realpath: (path: string) => string;
}>;

export type DaemonLifecycleTestScope = Readonly<{
  ownerId: string;
  homeDir: string;
  runtimeDir: string;
  stateDir: string;
  credentialDir: string;
  entrypoint: string;
  unitPrefix: string;
  filesystem: DaemonLifecycleTestFilesystem;
  dependencies: DaemonLifecycleTestDependencies;
}>;

type CanonicalLifecycleTestResource = Readonly<{
  path: string;
  device: number;
  inode: number;
  kind: "directory" | "file";
}>;

type DaemonLifecycleTestFilesystem = Readonly<{
  homeDir: CanonicalLifecycleTestResource;
  runtimeDir: CanonicalLifecycleTestResource;
  stateDir: CanonicalLifecycleTestResource;
  credentialDir: CanonicalLifecycleTestResource;
  entrypoint: CanonicalLifecycleTestResource;
}>;

const HERMETIC_FILESYSTEM_ROOTS = [
  "homeDir",
  "runtimeDir",
  "stateDir",
  "credentialDir",
  "procRoot",
] as const satisfies readonly (keyof DaemonLifecycleHermeticTestSeams)[];
type HermeticFilesystemRoot = typeof HERMETIC_FILESYSTEM_ROOTS[number];
type DaemonLifecycleHermeticTestFilesystem = Readonly<
  Record<HermeticFilesystemRoot, CanonicalLifecycleTestResource>
>;
const hermeticFilesystemSnapshots = new WeakMap<
  object,
  DaemonLifecycleHermeticTestFilesystem
>();

type ScopeInput = Omit<DaemonLifecycleTestScope, "unitPrefix" | "filesystem">;

function requireAbsoluteDirectory(label: string, path: string): string {
  if (!isAbsolute(path)) throw new Error(`${label} must be absolute`);
  return resolve(path);
}

function captureCanonicalResource(
  label: string,
  path: string,
  kind: CanonicalLifecycleTestResource["kind"],
): CanonicalLifecycleTestResource {
  let stats: ReturnType<typeof lstatSync>;
  try {
    stats = lstatSync(path);
  } catch {
    throw new Error(`${label} must be an existing canonical ${kind}`);
  }
  const expectedKind = kind === "directory" ? stats.isDirectory() : stats.isFile();
  if (
    stats.isSymbolicLink()
    || !expectedKind
    || (kind === "file" && stats.nlink !== 1)
    || realpathSync(path) !== path
  ) {
    throw new Error(`${label} must be an existing canonical ${kind}`);
  }
  return Object.freeze({
    path,
    device: stats.dev,
    inode: stats.ino,
    kind,
  });
}

function resourceMatchesSnapshot(resource: CanonicalLifecycleTestResource): boolean {
  try {
    const current = captureCanonicalResource(
      "lifecycle test resource",
      resource.path,
      resource.kind,
    );
    return current.device === resource.device && current.inode === resource.inode;
  } catch {
    return false;
  }
}

export function isCanonicalLifecycleTestDirectory(path: string): boolean {
  if (!isAbsolute(path)) return false;
  try {
    captureCanonicalResource("lifecycle test directory", resolve(path), "directory");
    return true;
  } catch {
    return false;
  }
}

export function isCanonicalLifecycleTestRegularFile(path: string): boolean {
  if (!isAbsolute(path)) return false;
  try {
    captureCanonicalResource("lifecycle test file", resolve(path), "file");
    return true;
  } catch {
    return false;
  }
}

export function isCanonicalOrMissingLifecycleTestStateFile(
  path: string,
  expectedPath: string,
): boolean {
  if (resolve(path) !== resolve(expectedPath) || path !== resolve(path)) return false;
  try {
    captureCanonicalResource("lifecycle test state file", path, "file");
    return true;
  } catch {
    try {
      lstatSync(path);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT";
    }
  }
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

function hasOnlyDataProperties(
  value: unknown,
  required: readonly PropertyKey[],
): value is Record<PropertyKey, unknown> {
  if (typeof value !== "object" || value === null) return false;
  if (Object.getOwnPropertySymbols(value).length > 0) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (!Reflect.ownKeys(descriptors).every(
    key => Object.hasOwn(descriptors[key as keyof typeof descriptors], "value"),
  )) return false;
  return required.every((key) => {
    const descriptor = descriptors[key as keyof typeof descriptors];
    return descriptor !== undefined && Object.hasOwn(descriptor, "value");
  });
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
    ["credentialDir", credentialDir],
    ["entrypoint", entrypoint],
  ] as const) {
    if (!isWithin(path, homeDir)) throw new Error(`lifecycle test ${label} must be inside homeDir`);
  }
  if (stateDir !== resolve(homeDir, LCM_HOME_DIRNAME)) {
    throw new Error(`lifecycle test stateDir must equal homeDir/${LCM_HOME_DIRNAME}`);
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
  const filesystem = Object.freeze({
    homeDir: captureCanonicalResource("lifecycle test homeDir", homeDir, "directory"),
    runtimeDir: captureCanonicalResource("lifecycle test runtimeDir", runtimeDir, "directory"),
    stateDir: captureCanonicalResource("lifecycle test stateDir", stateDir, "directory"),
    credentialDir: captureCanonicalResource(
      "lifecycle test credentialDir",
      credentialDir,
      "directory",
    ),
    entrypoint: captureCanonicalResource("lifecycle test entrypoint", entrypoint, "file"),
  });
  return Object.freeze({
    ownerId: input.ownerId,
    homeDir,
    runtimeDir,
    stateDir,
    credentialDir,
    entrypoint,
    unitPrefix: `${TEST_UNIT_PREFIX}${input.ownerId}-`,
    filesystem,
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

export function daemonLifecycleTestIdentityArgs(
  scope: DaemonLifecycleTestScope,
): [string, string, string, string] {
  return [
    DAEMON_TEST_OWNER_OPTION,
    scope.ownerId,
    DAEMON_TEST_ENTRYPOINT_OPTION,
    scope.entrypoint,
  ];
}

export function isDaemonLifecycleHermeticTestSeams(
  value: unknown,
): value is DaemonLifecycleHermeticTestSeams {
  if (typeof value !== "object" || value === null) return false;
  const seams = value as DaemonLifecycleHermeticTestSeams;
  let filesystem: DaemonLifecycleHermeticTestFilesystem;
  try {
    const homeDir = requireAbsoluteDirectory("hermetic test homeDir", seams.homeDir);
    if (homeDir === resolve("/")) return false;
    filesystem = Object.freeze(Object.fromEntries(
      HERMETIC_FILESYSTEM_ROOTS.map((label) => {
        const absolute = requireAbsoluteDirectory(`hermetic test ${label}`, seams[label]);
        return [
          label,
          captureCanonicalResource(`hermetic test ${label}`, absolute, "directory"),
        ];
      }),
    ) as unknown as DaemonLifecycleHermeticTestFilesystem);
    for (const label of HERMETIC_FILESYSTEM_ROOTS.slice(1)) {
      const absolute = filesystem[label].path;
      if (!isWithin(absolute, homeDir)) return false;
    }
    const expected = hermeticFilesystemSnapshots.get(value);
    if (
      expected
      && !HERMETIC_FILESYSTEM_ROOTS.every(label => (
        expected[label].path === filesystem[label].path
        && resourceMatchesSnapshot(expected[label])
      ))
    ) return false;
  } catch {
    return false;
  }
  if (!Number.isSafeInteger(seams.uid) || seams.uid < 0) return false;
  if (typeof seams.platform !== "string" || seams.platform.length === 0) return false;
  if (typeof seams.environment !== "object" || seams.environment === null) return false;
  const dependenciesAreComplete = [
    seams.fetch,
    seams.spawn,
    seams.spawnSync,
    seams.stopUnit,
    seams.killProcess,
    seams.isProcessAlive,
    seams.sleep,
    seams.realpath,
  ].every(dependency => typeof dependency === "function");
  if (!dependenciesAreComplete) return false;
  if (!hermeticFilesystemSnapshots.has(value)) {
    hermeticFilesystemSnapshots.set(value, filesystem);
  }
  return true;
}

export function lifecycleHermeticSeamsOwnsExactStatePaths(
  seams: DaemonLifecycleHermeticTestSeams,
  pidPath: string,
  tokenPath: string,
): boolean {
  return isDaemonLifecycleHermeticTestSeams(seams)
    && pidPath === resolve(pidPath)
    && tokenPath === resolve(tokenPath)
    && isWithin(pidPath, seams.stateDir)
    && isWithin(tokenPath, seams.stateDir)
    && isCanonicalOrMissingLifecycleTestStateFile(pidPath, pidPath)
    && isCanonicalOrMissingLifecycleTestStateFile(tokenPath, tokenPath);
}

export function isDaemonLifecycleTestScope(value: unknown): value is DaemonLifecycleTestScope {
  if (!hasOnlyDataProperties(value, [
    "ownerId",
    "homeDir",
    "runtimeDir",
    "stateDir",
    "credentialDir",
    "entrypoint",
    "unitPrefix",
    "filesystem",
    "dependencies",
  ])) return false;
  try {
    const scope = value as DaemonLifecycleTestScope;
    if (!hasOnlyDataProperties(scope.dependencies, REQUIRED_DEPENDENCIES)) return false;
    if (!hasOnlyDataProperties(scope.filesystem, [
      "homeDir",
      "runtimeDir",
      "stateDir",
      "credentialDir",
      "entrypoint",
    ])) return false;
    if (!(Object.keys(scope.filesystem) as Array<keyof DaemonLifecycleTestFilesystem>)
      .every(key => hasOnlyDataProperties(scope.filesystem[key], [
        "path",
        "device",
        "inode",
        "kind",
      ]))) return false;
    const recreated = createDaemonLifecycleTestScope({
      ownerId: scope.ownerId,
      homeDir: scope.homeDir,
      runtimeDir: scope.runtimeDir,
      stateDir: scope.stateDir,
      credentialDir: scope.credentialDir,
      entrypoint: scope.entrypoint,
      dependencies: scope.dependencies,
    });
    return recreated.unitPrefix === scope.unitPrefix
      && (Object.keys(recreated.filesystem) as Array<keyof DaemonLifecycleTestFilesystem>)
        .every((key) => (
          recreated.filesystem[key].path === scope.filesystem?.[key]?.path
          && recreated.filesystem[key].device === scope.filesystem?.[key]?.device
          && recreated.filesystem[key].inode === scope.filesystem?.[key]?.inode
          && recreated.filesystem[key].kind === scope.filesystem?.[key]?.kind
        ));
  } catch {
    return false;
  }
}

export function lifecycleScopeOwnsPath(scope: DaemonLifecycleTestScope, path: string): boolean {
  return isWithin(path, scope.stateDir)
    || isWithin(path, scope.runtimeDir)
    || isWithin(path, scope.credentialDir);
}

export function lifecycleScopeFilesystemIsCurrent(
  scope: DaemonLifecycleTestScope,
): boolean {
  return (Object.values(scope.filesystem) as CanonicalLifecycleTestResource[])
    .every(resourceMatchesSnapshot);
}

export function assertLifecycleScopeOwnsCurrentCleanupRoot(
  scope: DaemonLifecycleTestScope,
  path: string,
): void {
  if (path === scope.runtimeDir) {
    if (
      resourceMatchesSnapshot(scope.filesystem.runtimeDir)
      && resourceMatchesSnapshot(scope.filesystem.entrypoint)
    ) return;
  } else if (
    path === scope.credentialDir
    && resourceMatchesSnapshot(scope.filesystem.credentialDir)
  ) {
    return;
  } else if (
    path === scope.stateDir
    && resourceMatchesSnapshot(scope.filesystem.stateDir)
  ) {
    return;
  }
  throw new Error(`lifecycle test cleanup root is not current owned state: ${path}`);
}

export function lifecycleScopeOwnsExactStatePaths(
  scope: DaemonLifecycleTestScope,
  pidPath: string,
  tokenPath: string,
): boolean {
  const expectedPidPath = join(scope.stateDir, "daemon.pid");
  const expectedTokenPath = join(scope.stateDir, "daemon.token");
  return lifecycleScopeFilesystemIsCurrent(scope)
    && isCanonicalOrMissingLifecycleTestStateFile(pidPath, expectedPidPath)
    && isCanonicalOrMissingLifecycleTestStateFile(tokenPath, expectedTokenPath);
}

export function lifecycleScopeUnitName(
  scope: DaemonLifecycleTestScope,
  pid: number,
  nonce: number,
): string {
  return `${scope.unitPrefix}${pid}-${nonce}`;
}
