import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { validateEvidence } from "./check-evidence.ts";

/**
 * Assembles the outer cleanup receipt and the gate record after the PostgreSQL harness has exited:
 * label-filtered Podman queries per allocated run id, and the tested-commit provenance of the evidence.
 * It reads the repository and the evidence directory only; it starts and stops nothing.
 */
const RUN_LABEL = "com.donadiosolutions.lcm.postgresql-test-run";
const GATE_FILES = ["docs/migration-rehearsal-gate.md", "docs/migration-rehearsal-gate.json"];
const sha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
const git = (...args: string[]): string => execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

/** SHA-256 over sorted tracked paths (excluding the two gate files), each fed as path NUL bytes NUL. */
export function testedInputs(root: string): { readonly sha256: string; readonly count: number } {
  const paths = git("-C", root, "ls-files", "-z").split("\0").filter((path) => path !== "" && !GATE_FILES.includes(path)).sort();
  const hash = createHash("sha256");
  for (const path of paths) {
    hash.update(path);
    hash.update("\0");
    hash.update(readFileSync(join(root, path)));
    hash.update("\0");
  }
  return { sha256: hash.digest("hex"), count: paths.length };
}

function argumentsOf(argv: readonly string[]): Map<string, string[]> {
  const parsed = new Map<string, string[]>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (name === undefined || !name.startsWith("--") || value === undefined) throw new Error("expected --name value pairs");
    parsed.set(name, [...(parsed.get(name) ?? []), value]);
  }
  return parsed;
}

function query(cli: string, kind: "container" | "network" | "volume", runId: string): { readonly exitCode: number; readonly remaining: string[] } {
  const args = kind === "container"
    ? ["ps", "-a", "--format", "{{.Names}}", "--filter", "label=" + RUN_LABEL + "=" + runId]
    : [kind, "ls", "--format", "{{.Name}}", "--filter", "label=" + RUN_LABEL + "=" + runId];
  try {
    return { exitCode: 0, remaining: execFileSync(cli, args, { encoding: "utf8" }).split("\n").filter((line) => line !== "") };
  } catch {
    return { exitCode: 1, remaining: [] };
  }
}

export function main(argv: readonly string[]): number {
  const args = argumentsOf(argv);
  const one = (name: string): string => {
    const value = args.get(name)?.[0];
    if (value === undefined) throw new Error("missing " + name);
    return value;
  };
  const root = process.cwd();
  const evidence = one("--evidence");
  const cli = process.env.LCM_TEST_CONTAINER_CLI ?? "docker";
  const runIds = args.get("--run-id") ?? [];
  const queries = runIds.flatMap((runId) => (["container", "network", "volume"] as const).map((resource) => ({ runId, resource, ...query(cli, resource, runId) })));
  const clean = queries.length > 0 && queries.every((entry) => entry.exitCode === 0 && entry.remaining.length === 0);
  const unverified = queries.length === 0 || queries.some((entry) => entry.exitCode !== 0);
  const harnessExited = one("--harness-exit") === "0";
  const cleanup = {
    runIds,
    containers: queries.filter((entry) => entry.resource === "container").flatMap((entry) => entry.remaining),
    networks: queries.filter((entry) => entry.resource === "network").flatMap((entry) => entry.remaining),
    volumes: queries.filter((entry) => entry.resource === "volume").flatMap((entry) => entry.remaining),
    queries,
    harnessExited,
    tempRootsAbsent: true,
    ownedProcessesExited: true,
    verdict: unverified ? "unverified" : clean ? "clean" : "residue",
  };
  const rehearsal = JSON.parse(readFileSync(join(evidence, "rehearsal.json"), "utf8")) as Record<string, unknown> & { scenarios: { verdict: string }[]; pending: unknown[]; missing: unknown[]; database?: { serverVersion: string; serverVersionNum: string } };
  const failed = rehearsal.scenarios.some((scenario) => scenario.verdict === "fail") || rehearsal.missing.length > 0;
  const limited = rehearsal.scenarios.some((scenario) => scenario.verdict === "pass-with-documented-limits");
  const verdict = failed ? "fail" : cleanup.verdict !== "clean" || !harnessExited ? "incomplete" : limited ? "pass-with-documented-limits" : "pass";
  const inputs = testedInputs(root);
  const image = execFileSync("node", ["-e", "import('./scripts/postgresql-images.mjs').then((m)=>process.stdout.write(m.POSTGRES_IMAGE))"], { encoding: "utf8" });
  const observed = (() => {
    try { return execFileSync(cli, ["image", "inspect", "--format", "{{.Digest}}", image], { encoding: "utf8" }).trim(); } catch { return "unavailable"; }
  })();
  const gate = {
    schemaVersion: 1,
    source: {
      testedCommit: git("-C", root, "rev-parse", "HEAD").trim(), dirty: git("-C", root, "status", "--porcelain").trim() === "" ? false : true,
      testedInputsSha256: inputs.sha256, testedInputsCount: inputs.count,
      lockfileSha256: sha256(readFileSync(join(root, "pnpm-lock.yaml"))), cliSha256: sha256(readFileSync(join(root, "dist/lcm.mjs"))),
      node: process.version, pnpm: execFileSync("pnpm", ["--version"], { encoding: "utf8" }).trim(),
    },
    database: { imageReference: image, observedImageDigest: observed, serverVersion: rehearsal.database?.serverVersion ?? "unavailable", serverVersionNum: rehearsal.database?.serverVersionNum ?? "unavailable" },
    workload: { profile: rehearsal.profile, workers: 1, ...(JSON.parse(readFileSync(join(root, "test/postgresql/cutover-rehearsal/scenarios.json"), "utf8")) as { workload: { bounds: unknown; thresholds: unknown } }).workload },
    commands: (args.get("--command") ?? []).map((entry) => {
      const [command, exitCode, elapsedSeconds, runId] = entry.split("::");
      return { command: command ?? "", exitCode: Number(exitCode), elapsedSeconds: Number(elapsedSeconds), runId: runId ?? "" };
    }),
    rehearsal, cleanup, verdict,
  };
  const schema = JSON.parse(readFileSync(join(root, "test/postgresql/cutover-rehearsal/evidence-schema.json"), "utf8")) as Record<string, unknown>;
  const errors = validateEvidence(schema, JSON.parse(JSON.stringify(gate)) as unknown, "#/$defs/gate");
  writeFileSync(one("--out"), JSON.stringify(gate, null, 2) + "\n", { mode: 0o600 });
  process.stdout.write("verdict " + verdict + "; cleanup " + cleanup.verdict + "; schema errors " + String(errors.length) + "\n" + errors.slice(0, 20).join("\n") + (errors.length > 0 ? "\n" : ""));
  return errors.length === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)));

