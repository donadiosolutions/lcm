import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { load as loadYaml } from "js-yaml";
import { describe, expect, it } from "vitest";
import pkg from "../package.json";
import { NODE_IMAGE } from "../scripts/postgresql-images.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const workflowRoot = join(repositoryRoot, ".github", "workflows");
const actionRoot = join(repositoryRoot, ".github", "actions");
const COVERAGE_GATE_COMMAND = "pnpm run test:ci";
const COMPOSITE_ACTION_PREFIX = "./.github/actions/";

type Step = Readonly<{
  name?: string;
  uses?: string;
  run?: string;
  with?: Readonly<Record<string, unknown>>;
}>;

type Job = Readonly<{ steps?: readonly Step[] }>;

type Workflow = Readonly<{ jobs?: Readonly<Record<string, Job>> }>;

type CompositeAction = Readonly<{
  inputs?: Readonly<Record<string, Readonly<{ default?: unknown }>>>;
  runs?: Readonly<{ steps?: readonly Step[] }>;
}>;

// A composite action may pin node-version through one of its inputs; the pin
// it tracks is then that input's default, and a job may override it with an
// explicit `with.node-version`.
function resolvePin(version: unknown, document: CompositeAction): unknown {
  const match = /^\$\{\{\s*inputs\.([\w-]+)\s*\}\}$/u.exec(String(version));
  if (match === null) return version;
  const input = document.inputs?.[match[1]!];
  expect(input, `composite input ${match[1]} must declare a default`).toBeDefined();
  return input!.default;
}

function compositeActionPath(uses: string): string {
  const action = join(repositoryRoot, uses.slice(2));
  const path = [join(action, "action.yml"), join(action, "action.yaml")]
    .find((candidate) => readdirSync(action).includes(candidate.slice(action.length + 1)));
  expect(path, `${uses} must define a composite action`).toBeDefined();
  return path!;
}

// Undefined when the composite installs no Node runtime of its own.
function compositePinDefault(uses: string): unknown {
  const document = loadYaml(readFileSync(compositeActionPath(uses), "utf8")) as CompositeAction;
  const versions = (document.runs?.steps ?? [])
    .filter((step) => step.uses?.startsWith("actions/setup-node@") === true)
    .map((step) => resolvePin(step.with?.["node-version"], document));
  expect(versions.length).toBeLessThanOrEqual(1);
  return versions[0];
}

function parseVersion(value: unknown): readonly number[] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(String(value));
  return match === null ? null : [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersions(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < 3; index += 1) {
    if (left[index]! !== right[index]!) return left[index]! < right[index]! ? -1 : 1;
  }
  return 0;
}

function declaredFloor(): readonly number[] {
  const match = /^>=(\d+\.\d+\.\d+)$/u.exec(pkg.engines.node);
  expect(match, `engines.node must be an exact minimum, found ${pkg.engines.node}`).not.toBeNull();
  const floor = parseVersion(match![1]);
  expect(floor).not.toBeNull();
  return floor!;
}

function yamlFiles(directory: string): readonly string[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return yamlFiles(path);
      return entry.isFile() && /\.ya?ml$/u.test(entry.name) ? [path] : [];
    })
    .sort();
}

function stepsOf(path: string): readonly Step[] {
  const document = loadYaml(readFileSync(path, "utf8")) as Workflow & CompositeAction;
  return [
    ...Object.values(document.jobs ?? {}).flatMap((job) => job.steps ?? []),
    ...(document.runs?.steps ?? []).map((step) => ({
      ...step,
      with: step.with === undefined ? undefined : { ...step.with, "node-version": resolvePin(step.with["node-version"], document) },
    })),
  ];
}

function nodePins(): readonly Readonly<{ source: string; version: unknown }>[] {
  return [...yamlFiles(workflowRoot), ...yamlFiles(actionRoot)].flatMap((path) =>
    stepsOf(path)
      .filter((step) => step.uses?.startsWith("actions/setup-node@") === true)
      .map((step) => ({
        source: path.slice(repositoryRoot.length),
        version: step.with?.["node-version"],
      })));
}

// The linux-systemd and macos-launchd jobs in ci.yml validate OS service
// integration on the latest runtime instead of the declared floor. Every
// other setup-node pin tracks the floor exactly.
const LATEST_RUNTIME_PIN_SOURCES = new Set([
  ".github/workflows/ci.yml#linux-systemd",
  ".github/workflows/ci.yml#macos-launchd",
]);

function floorTrackedPins(): readonly Readonly<{ source: string; version: unknown }>[] {
  const pins: { source: string; version: unknown }[] = [];
  for (const path of [...yamlFiles(workflowRoot), ...yamlFiles(actionRoot)]) {
    const document = loadYaml(readFileSync(path, "utf8")) as Workflow & CompositeAction;
    for (const [jobName, job] of Object.entries(document.jobs ?? {})) {
      for (const step of job.steps ?? []) {
        if (step.uses?.startsWith("actions/setup-node@") === true) {
          pins.push({
            source: `${path.slice(repositoryRoot.length)}#${jobName}`,
            version: step.with?.["node-version"],
          });
        } else if (step.uses?.startsWith(COMPOSITE_ACTION_PREFIX) === true) {
          const version = step.with?.["node-version"] ?? compositePinDefault(step.uses);
          if (version !== undefined) {
            pins.push({ source: `${path.slice(repositoryRoot.length)}#${jobName}`, version });
          }
        }
      }
    }
    for (const step of document.runs?.steps ?? []) {
      if (step.uses?.startsWith("actions/setup-node@") === true) {
        pins.push({
          source: `${path.slice(repositoryRoot.length)}#composite`,
          version: resolvePin(step.with?.["node-version"], document),
        });
      }
    }
  }
  return pins.filter((pin) => !LATEST_RUNTIME_PIN_SOURCES.has(pin.source));
}

function coverageGateRuntimes(): readonly unknown[] {
  const runtimes: unknown[] = [];
  for (const path of yamlFiles(workflowRoot)) {
    const document = loadYaml(readFileSync(path, "utf8")) as Workflow;
    for (const job of Object.values(document.jobs ?? {})) {
      const steps = job.steps ?? [];
      if (!steps.some((step) => step.run?.includes(COVERAGE_GATE_COMMAND) === true)) continue;
      for (const step of steps) {
        if (step.uses?.startsWith("actions/setup-node@") === true) {
          runtimes.push(step.with?.["node-version"]);
        } else if (step.uses?.startsWith(COMPOSITE_ACTION_PREFIX) === true) {
          const version = step.with?.["node-version"] ?? compositePinDefault(step.uses);
          if (version !== undefined) runtimes.push(version);
        }
      }
    }
  }
  return runtimes;
}

describe("declared Node engine floor", () => {
  it("declares an exact supported minimum runtime", () => {
    expect(declaredFloor()).toEqual([25, 4, 0]);
  });

  it("pins every workflow runtime to an exact version the package supports", () => {
    const floor = declaredFloor();
    const pins = nodePins();
    expect(pins.length).toBeGreaterThan(0);
    for (const pin of pins) {
      const version = parseVersion(pin.version);
      expect(version, `${pin.source} pins node-version ${String(pin.version)}`).not.toBeNull();
      expect(
        compareVersions(version!, floor) >= 0,
        `${pin.source} pins node-version ${String(pin.version)} below the declared floor`,
      ).toBe(true);
    }
  });

  it("pins every floor-tracked workflow runtime to exactly the declared floor", () => {
    const floor = declaredFloor();
    const floorString = floor.join(".");
    const pins = floorTrackedPins();
    expect(pins.length).toBeGreaterThan(0);
    for (const pin of pins) {
      expect(String(pin.version), `${pin.source} pins node-version ${String(pin.version)}`).toBe(
        floorString,
      );
    }
  });

  it("runs the coverage gate on the declared floor rather than a newer runtime", () => {
    const floor = declaredFloor();
    const runtimes = coverageGateRuntimes();
    expect(runtimes.length).toBeGreaterThan(0);
    for (const runtime of runtimes) {
      const version = parseVersion(runtime);
      expect(version, `coverage gate runs on node-version ${String(runtime)}`).not.toBeNull();
      expect(compareVersions(version!, floor)).toBe(0);
    }
  });

  // Match vitest.config.ts exactly: only CI=true and CI=1 mean CI. A local run
  // that exports CI=false or CI="" must not be held to the floor runtime.
  const runningInCi = process.env.CI === "true" || process.env.CI === "1";

  it.runIf(runningInCi)("runs CI on exactly the declared floor runtime", () => {
    const floor = declaredFloor();
    expect(process.version).toBe(`v${floor.join(".")}`);
  });

  it("runs the PostgreSQL conformance runner on a supported runtime", () => {
    const floor = declaredFloor();
    const tag = /^node:(\d+\.\d+\.\d+)-/u.exec(NODE_IMAGE);
    expect(tag, `${NODE_IMAGE} must pin an exact Node tag`).not.toBeNull();
    expect(compareVersions(parseVersion(tag![1])!, floor) >= 0).toBe(true);
  });
});
